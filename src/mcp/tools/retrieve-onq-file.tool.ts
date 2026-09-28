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

const error = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

/** Fetch a single authorized source and pass its bytes through unchanged. */
export async function handleRetrieveOnqFile(deps: RetrieveOnqFileDeps, rawInput: unknown) {
  const { file_ref } = retrieveOnqFileSchema.parse(rawInput);
  const ref = parseOnqFileRef(file_ref);
  const courseId = OrgUnitId.of(ref.courseId);
  let data: Buffer;
  let filename: string;
  switch (ref.source) {
    case 'topic': {
      const result = await readTopic({ repo: deps.contentRepo, courseId, topicId: ref.topicId });
      if (result.status !== 'file') return error('This topic does not have a downloadable file.');
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
      if (!file) return error('Assignment attachment no longer exists. List its files again.');
      data = await deps.assignmentRepo.findFileBinary(courseId, file);
      filename = file.name;
      break;
    }
    case 'announcement': {
      const announcement = await deps.communicationsRepo.findAnnouncement(courseId, ref.announcementId);
      const file = announcement?.attachments.find(f => f.id === ref.attachmentId);
      if (!file) return error('Announcement attachment no longer exists. List it again.');
      data = await deps.communicationsRepo.downloadAnnouncementAttachment(courseId, ref.announcementId, ref.attachmentId);
      filename = file.name;
      break;
    }
    case 'submission': {
      const submissions = await deps.assignmentRepo.findMySubmissions(courseId, AssignmentId.of(ref.assignmentId));
      const file = submissions.find(s => s.id === ref.submissionId)?.files.find(f => f.name === ref.name);
      if (!file) return error('Submitted file no longer exists. List submissions again.');
      data = await deps.assignmentRepo.findFileBinary(courseId, file);
      filename = file.name;
      break;
    }
  }
  if (data.length === 0) return error('OnQ returned an empty file.');
  if (data.length > MAX_FILE_BYTES) return error('File exceeds the 25 MB tunnel limit.');
  const head = data.subarray(0, 8192).toString('utf8');
  if (/<(?:!doctype\s+html|html|body|form)\b/i.test(head) &&
      /(?:sign\s*in|log\s*in|login)/i.test(head)) {
    return error('OnQ returned a sign-in page instead of the file. Renew the Queen’s browser session.');
  }
  const detected = detectFileFormat(data, filename);
  const digest = createHash('sha256').update(data).digest('hex');
  return { content: [
    { type: 'text' as const, text: `Original OnQ file: ${filename} (${data.length} bytes, ${detected.mimeType}). ` +
      'The complete, unchanged file is attached. The server did not extract text or render pages. ' +
      'If this client cannot inspect this file type, say so rather than inferring its contents.' },
    { type: 'resource' as const, resource: {
      uri: `onq-file://course/${ref.courseId}/${digest}/${encodeURIComponent(filename)}`,
      mimeType: detected.mimeType,
      blob: data.toString('base64'),
    } },
  ] };
}
