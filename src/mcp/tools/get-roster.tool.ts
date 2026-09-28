import type { CourseRepository } from '@/contexts/courses/domain/CourseRepository.js';
import { getRoster } from '@/contexts/courses/application/getRoster.js';
import { getRosterSchema } from '@/mcp/schemas.js';
import { emailsToText, rosterToText } from '@/mcp/tool-helpers.js';
import { CourseId } from '@/contexts/courses/domain/CourseId.js';
import type { OutputContext } from '@/shared-kernel/output/index.js';

export interface GetRosterDeps { courseRepo: CourseRepository; output: OutputContext; }

export async function handleGetRoster(deps: GetRosterDeps, rawInput: unknown) {
  const input = getRosterSchema.parse(rawInput);
  const all = await getRoster({ repo: deps.courseRepo, courseId: CourseId.of(input.course_id) });
  const filtered = input.role_filter === 'all' ? all : all.filter((c) => c.role === input.role_filter);
  const emails = filtered.map(c => c.email).filter((email): email is string => Boolean(email));
  return {
    content: [{ type: 'text' as const, text: input.format === 'emails'
      ? emailsToText(emails, deps.output) : rosterToText(filtered, deps.output) }],
    structuredContent: {
      status: 'ok', course_id: input.course_id, format: input.format,
      items: input.format === 'emails' ? emails : filtered.map(c => ({
        id: Number(c.userId), name: c.displayName, role: c.role, email: c.email,
      })),
      retrieved_at: new Date().toISOString(),
    },
  };
}
