import { CourseFilePath } from '@/contexts/content/domain/CourseFilePath.js';

export type OnqFileRef =
  | { source: 'topic'; courseId: number; topicId: number }
  | { source: 'path'; courseId: number; path: string }
  | { source: 'assignment'; courseId: number; assignmentId: number; name: string }
  | { source: 'announcement'; courseId: number; announcementId: number; attachmentId: number }
  | { source: 'submission'; courseId: number; assignmentId: number; submissionId: string; name: string };

/** References contain identifiers only. Download URLs and credentials never enter the model-facing token. */
export function encodeOnqFileRef(ref: OnqFileRef): string {
  switch (ref.source) {
    case 'topic': return `onq-file:topic:${ref.courseId}:${ref.topicId}`;
    case 'path': return `onq-file:path:${ref.courseId}:${encodeURIComponent(ref.path)}`;
    case 'assignment': return `onq-file:assignment:${ref.courseId}:${ref.assignmentId}:${encodeURIComponent(ref.name)}`;
    case 'announcement': return `onq-file:announcement:${ref.courseId}:${ref.announcementId}:${ref.attachmentId}`;
    case 'submission': return `onq-file:submission:${ref.courseId}:${ref.assignmentId}:${ref.submissionId}:${encodeURIComponent(ref.name)}`;
  }
}

/**
 * Human-readable filename for a content topic: the decoded last segment of its
 * /content/ URL, else its title plus extension. D2L extensions come without a
 * dot ("pdf") from the repository but some fixtures carry one (".pdf").
 */
export function topicFilename(url: string | null | undefined, title: string, fileExtension: string | null | undefined): string {
  const last = url?.split(/[?#]/)[0]?.split('/').pop();
  if (last) {
    try { return decodeURIComponent(last); } catch { return last; }
  }
  const ext = fileExtension?.replace(/^\./, '');
  return ext && !title.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${title}.${ext}` : title;
}

function id(value: string | undefined): number {
  const n = Number(value);
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(n)) throw new Error('Invalid OnQ file reference.');
  return n;
}

function decoded(value: string | undefined): string {
  if (!value) throw new Error('Invalid OnQ file reference.');
  try { return decodeURIComponent(value); } catch { throw new Error('Invalid OnQ file reference.'); }
}

export function parseOnqFileRef(raw: string): OnqFileRef {
  const parts = raw.split(':');
  if (parts[0] !== 'onq-file' || raw.length > 4096) throw new Error('Invalid OnQ file reference.');
  const courseId = id(parts[2]);
  switch (parts[1]) {
    case 'topic':
      if (parts.length === 4) return { source: 'topic', courseId, topicId: id(parts[3]) };
      break;
    case 'path':
      if (parts.length === 4) return { source: 'path', courseId, path: CourseFilePath.parse(decoded(parts[3]), courseId).path };
      break;
    case 'assignment':
      if (parts.length === 5) return { source: 'assignment', courseId, assignmentId: id(parts[3]), name: decoded(parts[4]) };
      break;
    case 'announcement':
      if (parts.length === 5) return { source: 'announcement', courseId, announcementId: id(parts[3]), attachmentId: id(parts[4]) };
      break;
    case 'submission':
      if (parts.length === 6 && /^\d+$/.test(parts[4] ?? '')) return {
        source: 'submission', courseId, assignmentId: id(parts[3]), submissionId: parts[4]!, name: decoded(parts[5]),
      };
      break;
  }
  throw new Error('Invalid OnQ file reference.');
}
