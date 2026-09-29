import type { FileDelivery, FileDeliveryReservation } from '@/contexts/onq/domain/FileDelivery.js';
import { FileDeliveryError } from '@/contexts/onq/domain/FileDelivery.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ContentRepository } from '@/contexts/content/domain/ContentRepository.js';
import type { AssignmentRepository } from '@/contexts/assignments/domain/AssignmentRepository.js';
import type { CommunicationsRepository } from '@/contexts/communications/domain/CommunicationsRepository.js';
import { AssignmentId } from '@/contexts/assignments/domain/AssignmentId.js';
import { getCourseFile } from '@/contexts/content/application/getCourseFile.js';
import { readTopic } from '@/contexts/content/application/readTopic.js';
import { detectFileFormat, fileExtension } from '@/shared-kernel/extract/detectFileFormat.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import { parseOnqFileRef, topicFilename } from '../onq-file-ref.js';
import { MAX_DOWNLOAD_BYTES } from '@/contexts/http-api/D2lApiClient.js';
import { D2lApiError, DownloadRejectedError } from '@/contexts/http-api/errors.js';

/** Extensions whose bytes are never an HTML page; an HTML body for one of these is a login or error page. */
const NON_HTML_EXTS = new Set(['pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'zip', 'png', 'jpg', 'jpeg', 'gif', 'webp',
  'mp3', 'mp4', 'mov', 'm4a', 'wav']);
export const retrieveOnqFileSchema = z.object({
  file_ref: z.string().min(1).max(4096).describe('File reference returned by find_onq_files or a metadata tool.'),
}).strict();

export const retrieveOnqFileOutputSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  delivery: z.literal('download_url').optional(),
  file_ref: z.string().optional(),
  course_id: z.number().int().positive().optional(),
  filename: z.string().optional(),
  save_as: z.string().optional(),
  mime_type: z.string().optional(),
  byte_length: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  download_url: z.url().optional(),
  expires_at: z.string().optional(),
  retrieved_at: z.string().optional(),
  resource_uri: z.string().optional(),
  base64_length: z.number().int().nonnegative().optional(),
  error_code: z.string().optional(),
  message: z.string().optional(),
});

export interface RetrieveOnqFileDeps {
  fileDelivery?: FileDelivery;
  contentRepo: ContentRepository;
  assignmentRepo: AssignmentRepository;
  communicationsRepo: CommunicationsRepository;
  baseUrl: string;
}

const error = (code: string, message: string) => ({ isError: true,
  content: [{ type: 'text' as const, text: message }], structuredContent: { status: 'unavailable', error_code: code, message } });

/** Chunk size for writing the blob; a size that survives being written in one code call. */
const BLOB_CHUNK_CHARS = 20_000;
// The tunnel rejects an entire MCP response above 10 MiB. Base64 adds about
// one third to the file size, so leave room for the MCP envelope and metadata.
const MAX_INLINE_FILE_BYTES = 6 * 1024 * 1024;

/** How to read the saved original the way an uploaded file is read: by looking at it, never by extracting its text. */
function inspectionHint(mimeType: string): string {
  if (mimeType === 'application/pdf')
    return 'Check its page count, then render the pages you need to images and look at them; for a summary of the whole document, look at every page. Read text, diagrams, tables, and layout from the page images.';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mimeType === 'application/vnd.ms-powerpoint')
    return 'Render the slides to images (converting the saved deck to PDF first if needed) and look at them, including diagrams and layout.';
  if (mimeType.startsWith('image/'))
    return 'Open the saved image and look at it.';
  if (mimeType.startsWith('text/'))
    return 'Read the saved file as it is, preserving its structure and links.';
  return 'Open the saved original with a viewer for its format. If this client cannot open the format, say so.';
}

/** Filename safe for any workspace: path separators and unusual characters become "_", the extension is kept. */
export function safeFilename(filename: string): string {
  const cleaned = filename.normalize('NFC').replace(/\.{2,}/g, '_').replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\s+/g, ' ').replace(/_+/g, '_').trim();
  const noDots = cleaned.replace(/^\.+/, '');
  return (/[\p{L}\p{N}]/u.test(noDots) ? noDots : 'onq-file').slice(-120);
}

/**
 * Why an HTML body cannot be the requested file, or null when it can be. Real
 * course HTML pages may mention "log in", so words alone only count when the
 * file is expected to be a binary document; a password field always counts.
 */
function htmlInsteadOfFile(data: Buffer, filename: string): 'expired_auth' | 'unavailable' | null {
  const head = data.subarray(0, 8192).toString('utf8');
  if (!/<(?:!doctype\s+html|html|body|form)\b/i.test(head)) return null;
  if (/<input\b[^>]*type\s*=\s*["']?password/i.test(head) || /\/d2l\/login\b/i.test(head)) return 'expired_auth';
  if (!NON_HTML_EXTS.has(fileExtension(filename) ?? '')) return null;
  return /(?:sign\s*in|log\s*in|login)/i.test(head) ? 'expired_auth' : 'unavailable';
}

/** Fetch a single authorized source and pass its bytes through unchanged. */
export async function handleRetrieveOnqFile(deps: RetrieveOnqFileDeps, rawInput: unknown) {
  // Validate before reserving capacity; every exit path releases uncommitted capacity.
  const input = retrieveOnqFileSchema.parse(rawInput);
  parseOnqFileRef(input.file_ref);
  let reservation: FileDeliveryReservation | undefined;
  try {
    reservation = deps.fileDelivery?.reserve();
    return await retrieveOriginal(deps, input, reservation);
  } catch (err) {
    if (err instanceof FileDeliveryError) return error(err.code, err.message);
    throw err;
  } finally {
    reservation?.release();
  }
}

async function retrieveOriginal(deps: RetrieveOnqFileDeps, rawInput: unknown, reservation?: FileDeliveryReservation) {
  const { file_ref } = retrieveOnqFileSchema.parse(rawInput);
  const ref = parseOnqFileRef(file_ref);
  const courseId = OrgUnitId.of(ref.courseId);
  let data: Buffer;
  let filename: string;
  try {
    switch (ref.source) {
    case 'topic': {
      const result = await readTopic({ repo: deps.contentRepo, courseId, topicId: ref.topicId });
      if (result.status === 'broken') return error('not_found', `The file behind "${result.topic.title}" was deleted or unlinked in OnQ.`);
      if (result.status === 'not_downloadable') {
        const target = result.topic.url ? ` Its target is ${result.topic.url}.` : '';
        return error('unsupported', `"${result.topic.title}" is a ${result.topic.kind} topic, not a file.${target}`);
      }
      data = result.content;
      filename = topicFilename(result.filename, result.topic?.title ?? `topic-${ref.topicId}`, result.topic?.fileExtension);
      break;
    }
    case 'path': {
      const result = await getCourseFile({ repo: deps.contentRepo, courseId, rawPath: ref.path, origin: deps.baseUrl });
      data = result.content;
      filename = result.path.filename;
      break;
    }
    case 'assignment': {
      const result = await deps.assignmentRepo.findFiles(courseId, AssignmentId.of(ref.assignmentId));
      const file = result.files.find(f => f.name === ref.name);
      if (!file) return error('not_found', 'Assignment attachment no longer exists. List its files again.');
      data = await deps.assignmentRepo.findFileBinary(courseId, file);
      filename = file.name;
      break;
    }
    case 'announcement': {
      const announcement = await deps.communicationsRepo.findAnnouncement(courseId, ref.announcementId);
      const file = announcement?.attachments.find(f => f.id === ref.attachmentId);
      if (!file) return error('not_found', 'Announcement attachment no longer exists. List it again.');
      data = await deps.communicationsRepo.downloadAnnouncementAttachment(courseId, ref.announcementId, ref.attachmentId);
      filename = file.name;
      break;
    }
    case 'submission': {
      const submissions = await deps.assignmentRepo.findMySubmissions(courseId, AssignmentId.of(ref.assignmentId));
      const file = submissions.find(s => s.id === ref.submissionId)?.files.find(f => f.name === ref.name);
      if (!file) return error('not_found', 'Submitted file no longer exists. List submissions again.');
      data = await deps.assignmentRepo.findFileBinary(courseId, file);
      filename = file.name;
      break;
    }
    }
  } catch (err) {
    if (err instanceof D2lApiError) {
      if (err.status === 403) return error('forbidden', 'OnQ does not permit this file for your account.');
      if (err.status === 404) return error('not_found', 'This OnQ file is missing or no longer accessible.');
      if (err.status === 401) return error('expired_auth', 'Your OnQ sign-in has expired.');
    }
    if (err instanceof DownloadRejectedError) {
      if (err.reason === 'too_large') return error('too_large', 'File exceeds the 25 MiB OnQ download limit.');
      if (err.reason === 'external_redirect') return error('unsupported', 'External-host files are not supported by OnQ file retrieval.');
      return error('unavailable', `OnQ sent an unusable redirect for this file (${err.message}).`);
    }
    throw err;
  }
  if (data.length === 0) return error('unavailable', 'OnQ returned an empty file.');
  if (data.length > MAX_DOWNLOAD_BYTES) return error('too_large', 'File exceeds the 25 MiB OnQ download limit.');
  if (!reservation && data.length > MAX_INLINE_FILE_BYTES)
    return error('too_large', `This ${data.length}-byte file cannot be delivered through the current tunnel's 10 MiB response limit. The original file was not sent.`);
  const wrongBody = htmlInsteadOfFile(data, filename);
  if (wrongBody === 'expired_auth') return error('expired_auth', 'OnQ returned a sign-in page instead of the file. Renew the Queen’s browser session.');
  if (wrongBody === 'unavailable') return error('unavailable', `OnQ returned an HTML page instead of ${filename}. The file may have been moved; list it again.`);
  const detected = detectFileFormat(data, filename);
  const digest = createHash('sha256').update(data).digest('hex');
  if (reservation) {
    const safeName = safeFilename(filename);
    const delivery = reservation.publish({ data, filename: safeName, mimeType: detected.mimeType });
    return {
      content: [
        { type: 'text' as const, text: `Original OnQ file: ${filename} (${data.length} bytes, ${detected.mimeType}). ` +
          `Download the unchanged original from the resource link before making content claims. ` +
          `Verify byte length and SHA-256 ${digest} when workspace tools allow. ` +
          'Read text and inspect page images for diagrams, tables and layout. ' +
          'If the link expires, call retrieve_onq_file with the same file_ref. ' +
          'If downloading or opening is unavailable, report that limitation; a link alone is not a read document. ' +
          'Do not send the private download URL to web search.' },
        { type: 'resource_link' as const, uri: delivery.downloadUrl, name: safeName,
          mimeType: detected.mimeType, size: data.length },
      ],
      structuredContent: { status: 'ok', delivery: 'download_url', file_ref,
        course_id: ref.courseId, filename, save_as: safeName, mime_type: detected.mimeType,
        byte_length: data.length, sha256: digest, download_url: delivery.downloadUrl,
        expires_at: delivery.expiresAt, retrieved_at: new Date().toISOString() },
    };
  }
  const uri = `onq-file://course/${ref.courseId}/${digest}/${encodeURIComponent(filename)}`;
  const blob = data.toString('base64');
  const saveAs = safeFilename(filename);
  return { content: [
    { type: 'text' as const, text: [
      `Original OnQ file: ${filename} (${data.length} bytes, ${detected.mimeType}). SHA-256: ${digest}.`,
      `The complete, unchanged bytes are in the attached MCP resource as base64 (${blob.length} characters).`,
      'Save the original before reading, summarizing, or making any claim about it:',
      `1. If this client already exposes the resource as a file, use that file and go to step 4.`,
      `2. Otherwise write resource.blob to "${saveAs}.b64" in the client workspace (/mnt/data when available), in chunks of at most ` +
        `${BLOB_CHUNK_CHARS} characters, appending each chunk exactly as given. Never stream or print the blob through an interactive terminal.`,
      `3. Check that "${saveAs}.b64" is exactly ${blob.length} characters, then base64-decode it once to "${saveAs}" and delete the .b64 file.`,
      `4. Check that the saved file is exactly ${data.length} bytes with SHA-256 ${digest}. If either check fails, delete it and ` +
        'repeat from step 2 (call retrieve_onq_file again if the blob is no longer available). Never use or link a partial copy.',
      `5. Link the saved "${saveAs}" in your answer as the source.`,
      `Then read the saved original the way an uploaded file is read. ${inspectionHint(detected.mimeType)} Do not extract its text.`,
      `SHA-256 is a checksum, not file data. Keep file_ref ${file_ref} for later questions; retrieve it again if the saved copy is gone.`,
      'The server passed the bytes through unchanged. If this client cannot save or open the file, say so.',
    ].join('\n') },
    { type: 'resource' as const, resource: {
      uri,
      mimeType: detected.mimeType,
      blob,
    } },
  ], structuredContent: { status: 'ok', file_ref, course_id: ref.courseId, filename,
    mime_type: detected.mimeType, byte_length: data.length, sha256: digest, resource_uri: uri,
    save_as: saveAs, base64_length: blob.length,
    retrieved_at: new Date().toISOString() } };
}

