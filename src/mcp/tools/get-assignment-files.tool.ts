import type { AssignmentRepository } from '@/contexts/assignments/domain/AssignmentRepository.js';
import type { ContentRepository } from '@/contexts/content/domain/ContentRepository.js';
import type { Module } from '@/contexts/content/domain/Module.js';
import { getAssignmentFilesSchema } from '@/mcp/schemas.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import { AssignmentId } from '@/contexts/assignments/domain/AssignmentId.js';
import { encodeOnqFileRef } from '../onq-file-ref.js';

export interface GetAssignmentFilesDeps { assignmentRepo: AssignmentRepository; contentRepo: ContentRepository; }

function matchingTopics(modules: readonly Module[], needle: string): Array<{ id: number; title: string }> {
  const out: Array<{ id: number; title: string }> = [];
  for (const module of modules) {
    for (const topic of module.topics) {
      if ((topic.kind === 'file' || (topic.kind === 'other' && topic.url?.startsWith('/content/'))) &&
          topic.title.toLowerCase().includes(needle)) out.push({ id: topic.id, title: topic.title });
    }
    out.push(...matchingTopics(module.submodules, needle));
  }
  return out;
}

export async function handleGetAssignmentFiles(deps: GetAssignmentFilesDeps, rawInput: unknown) {
  const input = getAssignmentFilesSchema.parse(rawInput);
  const courseId = OrgUnitId.of(input.course_id);
  const result = await deps.assignmentRepo.findFiles(courseId, AssignmentId.of(input.assignment_id));
  const lines = [`# ${result.assignmentName}`];
  const items: Array<{ name: string; file_ref: string; source: string; mime_type: null; size_bytes: null }> = [];
  if (result.instructions) lines.push(`\n## Instructions\n${result.instructions}`);
  if (result.files.length) {
    lines.push(`\n## Attachments (${result.files.length})`);
    for (const file of result.files) {
      const file_ref = encodeOnqFileRef({ source: 'assignment', courseId: input.course_id,
        assignmentId: input.assignment_id, name: file.name });
      items.push({ name: file.name, file_ref, source: 'assignment', mime_type: null, size_bytes: null });
      lines.push(`- ${file.name}\n  file_ref: ${file_ref}`);
    }
  } else {
    const needle = result.assignmentName.toLowerCase();
    const topics = matchingTopics(await deps.contentRepo.findModules(courseId), needle);
    lines.push(topics.length ? '\n## Possible files in course content' : '\nNo attachments found.');
    for (const topic of topics) {
      const file_ref = encodeOnqFileRef({ source: 'topic', courseId: input.course_id, topicId: topic.id });
      items.push({ name: topic.title, file_ref, source: 'course_topic_fallback', mime_type: null, size_bytes: null });
      lines.push(`- ${topic.title}\n  file_ref: ${file_ref}`);
    }
  }
  lines.push('\nUse retrieve_onq_file(file_ref) to pass through any original file.');
  return { content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: { status: 'ok', course_id: input.course_id, assignment_id: input.assignment_id,
      instructions: result.instructions, items, retrieval_hint: 'Pass file_ref to retrieve_onq_file.',
      retrieved_at: new Date().toISOString() } };
}
