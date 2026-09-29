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

export interface RetrieveOnqFileDeps {
  contentRepo: ContentRepository;
  assignmentRepo: AssignmentRepository;
  communicationsRepo: CommunicationsRepository;
  baseUrl: string;
}

const error = (code: string, message: string) => ({ isError: true,
  content: [{ type: 'text' as const, text: message }], structuredContent: { status: 'unavailable', error_code: code, message } });

function inspectionHint(mimeType: string): string {
  if (mimeType === 'application/pdf')
    return 'Read the saved PDF with a PDF-aware viewer. Check its page count, then render and inspect the pages needed for the answer; for a whole-deck summary, sample the beginning, middle, and end. Inspect diagrams, tables, and layouts visually before describing them. The PDF text layer or pdftotext may help locate passages, but cannot verify visual details.';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mimeType === 'application/vnd.ms-powerpoint')
    return 'Open or render the saved presentation with a slide viewer. Inspect the relevant slides visually, including diagrams and layout; extracted slide text alone is insufficient for visual claims.';
  if (mimeType.startsWith('image/'))
    return 'Open the saved image with an image viewer before describing its visual contents.';
  if (mimeType.startsWith('text/'))
    return 'Read the saved original with a text or Markdown viewer, preserving its structure and links.';
  return 'Open the saved original with a compatible viewer before describing its contents. If this client cannot inspect the format, say so.';
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
      if (err.reason === 'too_large') return error('too_large', 'File exceeds the 25 MB tunnel limit.');
      if (err.reason === 'external_redirect') return error('unsupported', 'External-host files are not supported by OnQ file retrieval.');
      return error('unavailable', `OnQ sent an unusable redirect for this file (${err.message}).`);
    }
    throw err;
  }
  if (data.length === 0) return error('unavailable', 'OnQ returned an empty file.');
  if (data.length > MAX_DOWNLOAD_BYTES) return error('too_large', 'File exceeds the 25 MB tunnel limit.');
  const wrongBody = htmlInsteadOfFile(data, filename);
  if (wrongBody === 'expired_auth') return error('expired_auth', 'OnQ returned a sign-in page instead of the file. Renew the Queen’s browser session.');
  if (wrongBody === 'unavailable') return error('unavailable', `OnQ returned an HTML page instead of ${filename}. The file may have been moved; list it again.`);
  const detected = detectFileFormat(data, filename);
  const digest = createHash('sha256').update(data).digest('hex');
  const uri = `onq-file://course/${ref.courseId}/${digest}/${encodeURIComponent(filename)}`;
  return { content: [
    { type: 'text' as const, text: `Original OnQ file: ${filename} (${data.length} bytes, ${detected.mimeType}). ` +
      `SHA-256: ${digest}. The complete, unchanged bytes are included as an MCP resource. ` +
      `Source file_ref for later questions: ${file_ref}. ` +
      'First save these unchanged bytes as a file in the client workspace (/mnt/data when available) ' +
      'using a safe filename based on the returned filename, then attach/link that file as a clickable source. ' +
      'If only resource.blob is exposed, base64-decode it directly to that final file with a binary-safe operation; ' +
      'do not stream or print the blob through an interactive terminal. ' +
      'Verify the saved byte length and SHA-256 against this result before reading it; SHA-256 is a checksum, not file data. ' +
      'Do not extract text, render, summarize, or make content claims before saving the original file. ' +
      `${inspectionHint(detected.mimeType)} ` +
      'If the earlier attachment is unavailable later, retrieve this file_ref again. ' +
      'The server did not extract text or render pages. If this client cannot open the resource as a file, say so.' },
    { type: 'resource' as const, resource: {
      uri,
      mimeType: detected.mimeType,
      blob: data.toString('base64'),
    } },
  ], structuredContent: { status: 'ok', file_ref, course_id: ref.courseId, filename,
    mime_type: detected.mimeType, byte_length: data.length, sha256: digest, resource_uri: uri,
    retrieved_at: new Date().toISOString() } };
}

