import { z } from 'zod';
import type { CourseRepository } from '@/contexts/courses/domain/CourseRepository.js';
import type { ContentRepository } from '@/contexts/content/domain/ContentRepository.js';
import type { Module } from '@/contexts/content/domain/Module.js';
import { CourseId } from '@/contexts/courses/domain/CourseId.js';
import { CourseFilePath } from '@/contexts/content/domain/CourseFilePath.js';
import { extractHtmlLinks, htmlToPlainText } from '@/shared-kernel/text/htmlLinks.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import { encodeOnqFileRef } from '../onq-file-ref.js';
import { D2lApiError } from '@/contexts/http-api/errors.js';

export const findOnqFilesSchema = z.object({
  query: z.string().min(1).max(200).describe('Course, lecture, week, subject, or file type to search for.'),
  course_id: z.number().int().positive().optional().describe('Optional course ID to narrow the search.'),
  include_past: z.boolean().default(false).describe('Search past courses too.'),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

export interface FindOnqFilesDeps { courseRepo: CourseRepository; contentRepo: ContentRepository; baseUrl: string; }

interface Candidate { score: number; courseId: number; moduleId: number; course: string; module: string; label: string; filename: string; ref: string; context: string; }
const terms = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(w => w.length > 1) ?? [];

function score(query: string[], course: string, module: string, label: string, filename: string, context: string): number {
  const fields: Array<[string, number]> = [[course, 5], [module, 5], [label, 4], [context, 2], [filename, 1]];
  return query.reduce((sum, word) => sum + fields.reduce((part, [value, weight]) =>
    part + (value.toLowerCase().includes(word) ? weight : 0), 0), 0);
}

function candidateForPath(raw: string, courseId: number, origin: string): { path: string; filename: string } | null {
  try {
    const parsed = CourseFilePath.parse(raw, courseId, { origin });
    return { path: parsed.path, filename: parsed.filename };
  } catch { return null; }
}

/** Search metadata only. File bytes are fetched by retrieve_onq_file. */
export async function handleFindOnqFiles(deps: FindOnqFilesDeps, rawInput: unknown) {
  const input = findOnqFilesSchema.parse(rawInput);
  const all = await deps.courseRepo.findMyCourses({ activeOnly: !input.include_past });
  const selected = input.course_id ? all.filter(c => CourseId.toNumber(c.id) === input.course_id) : all;
  if (input.course_id && selected.length === 0) return { content: [{ type: 'text' as const, text: 'Course not found in the selected course range.' }],
    structuredContent: { status: 'unavailable', error_code: 'not_found', course_id: input.course_id, items: [], retrieved_at: new Date().toISOString() } };
  const query = terms(input.query);
  const candidates: Candidate[] = [];
  const coverage: Array<{ course_id: number; status: 'ok' | 'forbidden' | 'not_found' | 'unavailable' }> = [];
  for (const course of selected) {
    const courseId = CourseId.toNumber(course.id);
    let modules: Module[];
    try { modules = await deps.contentRepo.findModules(OrgUnitId.of(courseId)); }
    catch (err) {
      const status = err instanceof D2lApiError && err.status === 403 ? 'forbidden'
        : err instanceof D2lApiError && err.status === 404 ? 'not_found' : 'unavailable';
      coverage.push({ course_id: courseId, status });
      continue;
    }
    coverage.push({ course_id: courseId, status: 'ok' });
    const seen = new Set<string>();
    const walk = (items: readonly Module[], parents: string[]) => {
      for (const module of items) {
        const path = [...parents, module.title].join(' › ');
        const context = htmlToPlainText(module.descriptionHtml ?? '').slice(0, 600);
        for (const topic of module.topics) {
          if (topic.isBroken || !(topic.kind === 'file' || (topic.kind === 'other' && topic.url?.startsWith('/content/')))) continue;
          const ref = encodeOnqFileRef({ source: 'topic', courseId, topicId: topic.id });
          const filename = topic.url?.split(/[?#]/)[0]?.split('/').pop() || `${topic.title}${topic.fileExtension ?? ''}`;
          seen.add(topic.url ?? ref);
          candidates.push({ score: score(query, course.name, path, topic.title, filename, context),
            courseId, moduleId: module.id, course: course.name, module: path, label: topic.title, filename, ref, context: context.slice(0, 140) });
        }
        for (const link of extractHtmlLinks(module.descriptionHtml ?? '')) {
          const file = candidateForPath(link.url, courseId, deps.baseUrl);
          if (!file || seen.has(file.path)) continue;
          seen.add(file.path);
          candidates.push({ score: score(query, course.name, path, link.label, file.filename, context),
            courseId, moduleId: module.id, course: course.name, module: path, label: link.label || file.filename, filename: file.filename,
            ref: encodeOnqFileRef({ source: 'path', courseId, path: file.path }), context: context.slice(0, 140) });
        }
        walk(module.submodules, [...parents, module.title]);
      }
    };
    walk(modules, []);
  }
  candidates.sort((a, b) => b.score - a.score || a.course.localeCompare(b.course) || a.module.localeCompare(b.module));
  const shown = candidates.slice(0, input.limit);
  const lines = [`Found ${candidates.length} file references across ${selected.length} course(s). ${shown.length} shown.`];
  const failures = coverage.filter(c => c.status !== 'ok');
  if (failures.length) lines.push(`Could not search ${failures.length} course(s); coverage is incomplete. A forbidden course has inaccessible materials, not zero files.`);
  if (shown.every(c => c.score === 0) && shown.length) lines.push('No strong metadata match. These are candidates to inspect; filenames can be misleading.');
  for (const [i, c] of shown.entries()) lines.push(
    `${i + 1}. ${c.label} — ${c.course} / ${c.module}\n   filename: ${c.filename}\n   file_ref: ${c.ref}` +
    (c.context ? `\n   module context: ${c.context}` : ''),
  );
  lines.push('Use retrieve_onq_file(file_ref) for the complete original bytes. Search uses course/module/topic/link metadata only; it cannot identify an unlabeled file by its contents. External-host links are not downloadable by this tool.');
  return { content: [{ type: 'text' as const, text: lines.join('\n') }],
    structuredContent: { status: failures.length === coverage.length && coverage.length > 0 ? 'unavailable' : failures.length ? 'partial' : 'ok', items: shown.map(c => ({
      file_ref: c.ref, name: c.label, filename: c.filename, course_id: c.courseId,
      module_id: c.moduleId, course: c.course, module: c.module,
      source_location: c.module, mime_type: null, size_bytes: null,
      retrieval_hint: 'Pass file_ref to retrieve_onq_file; filename and type are verified on retrieval.',
    })), total: candidates.length, has_more: candidates.length > shown.length, coverage,
    retrieved_at: new Date().toISOString() } };
}
