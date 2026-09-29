import { z } from 'zod';
import type { CourseRepository } from '@/contexts/courses/domain/CourseRepository.js';
import type { ContentRepository } from '@/contexts/content/domain/ContentRepository.js';
import type { Module } from '@/contexts/content/domain/Module.js';
import { CourseId } from '@/contexts/courses/domain/CourseId.js';
import { CourseFilePath } from '@/contexts/content/domain/CourseFilePath.js';
import { extractHtmlLinks, htmlToPlainText } from '@/shared-kernel/text/htmlLinks.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import { encodeOnqFileRef, topicFilename } from '../onq-file-ref.js';
import { D2lApiError } from '@/contexts/http-api/errors.js';

export const findOnqFilesSchema = z.object({
  query: z.string().min(1).max(200).describe('Course, lecture, week, subject, or file type to search for.'),
  course_id: z.number().int().positive().optional().describe('Optional course ID to narrow the search.'),
  include_past: z.boolean().default(false).describe('Search past courses too.'),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

export interface FindOnqFilesDeps { courseRepo: CourseRepository; contentRepo: ContentRepository; baseUrl: string; }

interface Candidate { score: number; courseId: number; moduleId: number; course: string; module: string; label: string; filename: string; ref: string; context: string; }

const STOPWORDS = new Set(['the', 'and', 'for', 'of', 'in', 'on', 'to', 'an', 'from', 'with', 'my', 'me', 'is', 'are',
  'what', 'where', 'find', 'get', 'show']);

/**
 * Letter runs and digit runs are separate tokens, so "Week8" and "L03" split
 * into ["week", "8"] and ["l", "03"]. Digits are normalized ("03" → "3").
 */
function tokens(s: string): string[] {
  return (s.toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? []).map(t => /^\d+$/.test(t) ? String(Number(t)) : t);
}

/** Query terms: numbers are kept even when one digit ("week 8"); stopwords and single letters are dropped. */
function queryTerms(s: string): string[] {
  return [...new Set(tokens(s).filter(t => /^\d+$/.test(t) || (t.length > 1 && !STOPWORDS.has(t))))];
}

/** A word matches a token prefix ("slide" → "slides"); a number only matches the same number ("8" ≠ "18"). */
function matches(word: string, field: readonly string[]): boolean {
  const numeric = /^\d+$/.test(word);
  return field.some(t => numeric ? t === word : t.startsWith(word));
}

function score(query: readonly string[], course: string, module: string, label: string, filename: string, context: string): number {
  const fields: Array<[string[], number]> = [[tokens(course), 5], [tokens(module), 5], [tokens(label), 4], [tokens(context), 2], [tokens(filename), 1]];
  return query.reduce((sum, word) => sum + fields.reduce((part, [value, weight]) =>
    part + (matches(word, value) ? weight : 0), 0), 0);
}

type Coverage = { course_id: number; status: 'ok' | 'forbidden' | 'not_found' | 'unavailable' };

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
  const query = queryTerms(input.query);
  // Courses are fetched concurrently; the client's bulkhead caps backend pressure.
  const perCourse = await Promise.all(selected.map(async (course) => {
    const courseId = CourseId.toNumber(course.id);
    try {
      return { courseId, course, modules: await deps.contentRepo.findModules(OrgUnitId.of(courseId)) };
    } catch (err) {
      const status: Coverage['status'] = err instanceof D2lApiError && err.status === 403 ? 'forbidden'
        : err instanceof D2lApiError && err.status === 404 ? 'not_found' : 'unavailable';
      return { courseId, course, status };
    }
  }));
  const candidates: Candidate[] = [];
  const coverage: Coverage[] = [];
  for (const entry of perCourse) {
    const { courseId, course } = entry;
    if (!('modules' in entry)) { coverage.push({ course_id: courseId, status: entry.status }); continue; }
    coverage.push({ course_id: courseId, status: 'ok' });
    // Keyed by canonical /content/enforced/ path so a topic and a description link to the same file appear once.
    const seen = new Set<string>();
    const walk = (items: readonly Module[], parents: string[]) => {
      for (const module of items) {
        const path = [...parents, module.title].join(' › ');
        const context = htmlToPlainText(module.descriptionHtml ?? '').slice(0, 600);
        for (const topic of module.topics) {
          if (topic.isBroken || !(topic.kind === 'file' || (topic.kind === 'other' && topic.url?.startsWith('/content/')))) continue;
          const ref = encodeOnqFileRef({ source: 'topic', courseId, topicId: topic.id });
          const key = (topic.url && candidateForPath(topic.url, courseId, deps.baseUrl)?.path) || ref;
          if (seen.has(key)) continue;
          seen.add(key);
          const filename = topicFilename(topic.url, topic.title, topic.fileExtension);
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
    walk(entry.modules, []);
  }
  // Unrelated files only pad the list once something actually matched.
  const ranked = candidates.some(c => c.score > 0) ? candidates.filter(c => c.score > 0) : candidates;
  ranked.sort((a, b) => b.score - a.score || a.course.localeCompare(b.course) || a.module.localeCompare(b.module));
  const shown = ranked.slice(0, input.limit);
  const lines = [`Found ${ranked.length} file references across ${selected.length} course(s). ${shown.length} shown.`];
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
    })), total: ranked.length, has_more: ranked.length > shown.length, coverage,
    retrieved_at: new Date().toISOString() } };
}
