import type { CourseRepository } from '@/contexts/courses/domain/CourseRepository.js';
import { listMyCourses } from '@/contexts/courses/application/listMyCourses.js';
import { listMyCoursesSchema } from '@/mcp/schemas.js';
import { coursesToCompact, coursesToDetailed } from '@/mcp/tool-helpers.js';
import type { OutputContext } from '@/shared-kernel/output/index.js';
import { CourseId } from '@/contexts/courses/domain/CourseId.js';

export interface ListMyCoursesDeps {
  courseRepo: CourseRepository;
  output: OutputContext;
}

export async function handleListMyCourses(deps: ListMyCoursesDeps, rawInput: unknown) {
  const input = listMyCoursesSchema.parse(rawInput);
  const all = await listMyCourses({ repo: deps.courseRepo, activeOnly: input.active_only });
  const courses = all.slice(
    0,
    input.limit,
  );
  const text = input.format === 'detailed' ? coursesToDetailed(courses, deps.output) : coursesToCompact(courses, deps.output);
  const footer = deps.output.metaFooter();
  const body = footer ? `${text}\n\n${footer}` : text;
  return { content: [{ type: 'text' as const, text: body }], structuredContent: {
    status: 'ok', items: courses.map(c => ({ course_id: CourseId.toNumber(c.id),
      name: c.name, code: c.code, active: c.active, starts_at: c.startDate?.toISOString() ?? null,
      ends_at: c.endDate?.toISOString() ?? null })),
    has_more: all.length > courses.length, retrieved_at: new Date().toISOString(),
  } };
}
