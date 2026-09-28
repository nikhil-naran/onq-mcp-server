import { z } from 'zod';

import type { AssignmentRepository } from '@/contexts/assignments/domain/AssignmentRepository.js';
import { getAssignmentRubric } from '@/contexts/assignments/application/getAssignmentRubric.js';
import { AssignmentId } from '@/contexts/assignments/domain/AssignmentId.js';
import { rubricsToText } from '@/mcp/rubric-helpers.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import type { OutputContext } from '@/shared-kernel/output/index.js';
import { accessResult } from '@/mcp/access-result.js';

export const getAssignmentRubricSchema = z.object({
  course_id: z.number().int().positive(),
  assignment_id: z.number().int().positive(),
}).strict();

export interface GetAssignmentRubricDeps { assignmentRepo: AssignmentRepository; output: OutputContext; }

export async function handleGetAssignmentRubric(deps: GetAssignmentRubricDeps, rawInput: unknown) {
  const input = getAssignmentRubricSchema.parse(rawInput);
  try {
  const rubrics = await getAssignmentRubric({
    repo: deps.assignmentRepo,
    courseId: OrgUnitId.of(input.course_id),
    assignmentId: AssignmentId.of(input.assignment_id),
  });
  return { content: [{ type: 'text' as const, text: rubricsToText(rubrics, deps.output) }],
    structuredContent: { status: 'ok', course_id: input.course_id, assignment_id: input.assignment_id,
      rubric_count: rubrics.length, retrieved_at: new Date().toISOString() } };
  } catch (err) { return accessResult(err, 'rubric associations or details', input.course_id); }
}
