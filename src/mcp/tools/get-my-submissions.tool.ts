import { z } from 'zod';
import type { AssignmentRepository } from '@/contexts/assignments/domain/AssignmentRepository.js';
import { AssignmentId } from '@/contexts/assignments/domain/AssignmentId.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import { encodeOnqFileRef } from '../onq-file-ref.js';

export const getMySubmissionsSchema = z.object({
  course_id: z.number().int().positive(),
  assignment_id: z.number().int().positive(),
  submission_id: z.string().regex(/^\d+$/).optional(),
}).strict();
export interface GetMySubmissionsDeps { assignmentRepo: AssignmentRepository; }

export async function handleGetMySubmissions(deps: GetMySubmissionsDeps, rawInput: unknown) {
  const input = getMySubmissionsSchema.parse(rawInput);
  const all = await deps.assignmentRepo.findMySubmissions(OrgUnitId.of(input.course_id), AssignmentId.of(input.assignment_id));
  const selected = input.submission_id ? all.filter(s => s.id === input.submission_id) : all;
  if (!selected.length) return { content: [{ type: 'text' as const, text: 'No matching submissions found.' }] };
  const lines = [`${selected.length} submission(s), newest first:`];
  for (const submission of selected) {
    lines.push(`\n## Submission ${submission.id} — ${submission.submittedAt?.toISOString() ?? submission.submittedAtLabel ?? 'unknown date'}`);
    if (submission.comment) lines.push(`Comment: ${submission.comment}`);
    for (const file of submission.files) lines.push(`- ${file.name}\n  file_ref: ${encodeOnqFileRef({
      source: 'submission', courseId: input.course_id, assignmentId: input.assignment_id,
      submissionId: submission.id, name: file.name,
    })}`);
  }
  lines.push('\nUse retrieve_onq_file(file_ref) to pass through the original submitted file.');
  return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
}
