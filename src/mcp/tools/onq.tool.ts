import type { OnqRepository } from '@/contexts/onq/domain/OnqRepository.js';
import { readAssignmentDetails, readContentCompletions } from '@/contexts/onq/application/readOnq.js';
import { onqAssignmentSchema, onqCourseSchema } from '../schemas.js';
export async function handleOnqAssignment(repo: OnqRepository, raw: unknown) {
  const input = onqAssignmentSchema.parse(raw);
  const result = await readAssignmentDetails(repo, input.course_id, input.assignment_id);
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result } };
}
export async function handleOnqCompletions(repo: OnqRepository, raw: unknown) {
  const input = onqCourseSchema.parse(raw);
  const result = await readContentCompletions(repo, input.course_id);
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result } };
}
