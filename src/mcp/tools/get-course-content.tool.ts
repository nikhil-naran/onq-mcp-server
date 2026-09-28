import type { ContentRepository } from '@/contexts/content/domain/ContentRepository.js';
import { getCourseContent } from '@/contexts/content/application/getCourseContent.js';
import { getCourseContentSchema } from '@/mcp/schemas.js';
import { courseContentToText } from '@/mcp/tool-helpers.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import type { OutputContext } from '@/shared-kernel/output/index.js';
import { accessResult } from '@/mcp/access-result.js';

export interface GetCourseContentDeps { contentRepo: ContentRepository; output: OutputContext; }

export async function handleGetCourseContent(deps: GetCourseContentDeps, rawInput: unknown) {
  const input = getCourseContentSchema.parse(rawInput);
  try {
    const modules = await getCourseContent({ repo: deps.contentRepo, courseId: OrgUnitId.of(input.course_id) });
    return { content: [{ type: 'text' as const, text: courseContentToText(modules, input.depth, deps.output, input.course_id) }],
      structuredContent: { status: 'ok', course_id: input.course_id,
        items: modules.slice(0, 50).map(m => ({ module_id: m.id, title: m.title, topic_count: m.topics.length,
          submodule_count: m.submodules.length, topics: m.topics.slice(0, 100).map(t => ({ topic_id: t.id, title: t.title, kind: t.kind })),
          topics_has_more: m.topics.length > 100 })), has_more: modules.length > 50,
        retrieved_at: new Date().toISOString() } };
  } catch (err) { return accessResult(err, 'course content', input.course_id); }
}
