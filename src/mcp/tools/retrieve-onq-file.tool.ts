import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ContentRepository } from '@/contexts/content/domain/ContentRepository.js';
import type { AssignmentRepository } from '@/contexts/assignments/domain/AssignmentRepository.js';
import type { CommunicationsRepository } from '@/contexts/communications/domain/CommunicationsRepository.js';
import { AssignmentId } from '@/contexts/assignments/domain/AssignmentId.js';
import { getCourseFile } from '@/contexts/content/application/getCourseFile.js';
import { readTopic } from '@/contexts/content/application/readTopic.js';
import { detectFileFormat } from '@/shared-kernel/extract/detectFileFormat.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import { parseOnqFileRef } from '../onq-file-ref.js';
import { D2lApiError, NetworkError } from '@/contexts/http-api/errors.js';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
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
    return 'Open or render the PDF with a client-side viewer and inspect the relevant pages visually, including diagrams. Text extraction alone does not verify visual details.';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mimeType === 'application/vnd.ms-powerpoint')
    return 'Open or render the presentation with a client-side viewer and inspect the relevant slides visually, including diagrams. Text extraction alone does not verify slide layout.';
  if (mimeType.startsWith('image/'))
    return 'Open the image with a client-side viewer before describing its visual contents.';
  return 'Open the original file with a compatible client-side viewer before describing its contents. If this client cannot inspect the format, say so.';
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
      if (result.status !== 'file') return error('unsupported', 'This topic does not have a downloadable file.');
      data = result.content;
      filename = result.filename?.split(/[?#]/)[0]?.split('/').pop() ||
        `${result.topic?.title ?? `topic-${ref.topicId}`}${result.topic?.fileExtension ?? ''}`;
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
    const cause = err instanceof NetworkError ? err.cause : err;
    if (cause instanceof Error && cause.message.includes('25 MB limit'))
      return error('too_large', 'File exceeds the 25 MB tunnel limit.');
    if (cause instanceof Error && cause.message.includes('outside the LMS'))
      return error('unsupported', 'External-host files are not supported by OnQ file retrieval.');
    throw err;
  }
  if (data.length === 0) return error('unavailable', 'OnQ returned an empty file.');
  if (data.length > MAX_FILE_BYTES) return error('too_large', 'File exceeds the 25 MB tunnel limit.');
  const head = data.subarray(0, 8192).toString('utf8');
  if (/<(?:!doctype\s+html|html|body|form)\b/i.test(head) &&
      /(?:sign\s*in|log\s*in|login)/i.test(head)) {
    return error('expired_auth', 'OnQ returned a sign-in page instead of the file. Renew the Queen’s browser session.');
  }
  const detected = detectFileFormat(data, filename);
  const digest = createHash('sha256').update(data).digest('hex');
  const uri = `onq-file://course/${ref.courseId}/${digest}/${encodeURIComponent(filename)}`;
  return { content: [
    { type: 'text' as const, text: `Original OnQ file: ${filename} (${data.length} bytes, ${detected.mimeType}). ` +
      `SHA-256: ${digest}. The complete, unchanged bytes are included as an MCP resource. ` +
      `Source file_ref for later questions: ${file_ref}. ${inspectionHint(detected.mimeType)} ` +
      'If this client only exposes resource.blob, base64-decode it into a temporary client-side file ' +
      'using a safe filename based on the returned filename; SHA-256 is a checksum, not decodable file data. ' +
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
