import type { AssignmentRepository } from '@/contexts/assignments/domain/AssignmentRepository.js';
import { getAssignments } from '@/contexts/assignments/application/getAssignments.js';
import { getAssignmentsSchema } from '@/mcp/schemas.js';
import { assignmentsToCompact, assignmentsToDetailed } from '@/mcp/tool-helpers.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import type { OutputContext } from '@/shared-kernel/output/index.js';
import { AssignmentId } from '@/contexts/assignments/domain/AssignmentId.js';
import { accessResult } from '@/mcp/access-result.js';

export interface GetAssignmentsDeps { assignmentRepo: AssignmentRepository; output: OutputContext; }

export async function handleGetAssignments(deps: GetAssignmentsDeps, rawInput: unknown) {
  const input = getAssignmentsSchema.parse(rawInput);
  try {
  const list = await getAssignments({
    repo: deps.assignmentRepo,
    courseId: OrgUnitId.of(input.course_id),
    includePast: input.include_past,
  });
  const text = input.format === 'detailed' ? assignmentsToDetailed(list, deps.output) : assignmentsToCompact(list, deps.output);
  const footer = deps.output.metaFooter();
  const body = footer ? `${text}\n\n${footer}` : text;
  return { content: [{ type: 'text' as const, text: body }], structuredContent: {
    status: 'ok', course_id: input.course_id, items: list.map(a => ({
      assignment_id: AssignmentId.toNumber(a.id), title: a.name,
      due_at: a.dueDate.toDate()?.toISOString() ?? null, closes_at: a.endDate?.toISOString() ?? null,
      submission_status: a.submissionStatus,
    })), retrieved_at: new Date().toISOString(),
  } };
  } catch (err) { return accessResult(err, 'assignments', input.course_id); }
}
