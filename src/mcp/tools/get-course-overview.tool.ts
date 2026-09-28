import { z } from 'zod';
import type { AssignmentRepository } from '@/contexts/assignments/domain/AssignmentRepository.js';
import type { ContentRepository } from '@/contexts/content/domain/ContentRepository.js';
import type { CommunicationsRepository } from '@/contexts/communications/domain/CommunicationsRepository.js';
import type { QuizRepository } from '@/contexts/quizzes/domain/QuizRepository.js';
import type { CalendarRepository } from '@/contexts/calendar/domain/CalendarRepository.js';
import { D2lApiError } from '@/contexts/http-api/errors.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import { AssignmentId } from '@/contexts/assignments/domain/AssignmentId.js';

const sectionSchema = z.enum(['content', 'assignments', 'announcements', 'quizzes', 'calendar']);
type Section = z.infer<typeof sectionSchema>;
export const getCourseOverviewSchema = z.object({
  course_id: z.number().int().positive(),
  sections: z.array(sectionSchema).min(1).max(5).default(['assignments', 'announcements', 'quizzes', 'calendar'])
    .describe('Only these sections are fetched for this one course. Pass content explicitly when needed; it can require many module requests.'),
  days: z.number().int().min(1).max(365).default(30).describe('Calendar window in days.'),
}).strict();

export interface GetCourseOverviewDeps {
  assignmentRepo: AssignmentRepository;
  contentRepo: ContentRepository;
  communicationsRepo: CommunicationsRepository;
  quizRepo: QuizRepository;
  calendarRepo: CalendarRepository;
}

function accessError(err: unknown): { status: 'forbidden' | 'not_found' | 'unavailable'; reason: string; http_status?: number } {
  if (err instanceof D2lApiError) {
    if (err.status === 403) return { status: 'forbidden', reason: 'OnQ does not permit this section for your account.', http_status: 403 };
    if (err.status === 404) return { status: 'not_found', reason: 'This section is not available in this course.', http_status: 404 };
    if (err.status === 401) return { status: 'unavailable', reason: 'Your OnQ sign-in has expired.', http_status: 401 };
    return { status: 'unavailable', reason: 'OnQ could not return this section.', http_status: err.status };
  }
  return { status: 'unavailable', reason: 'This section could not be read.' };
}

/** A bounded, single-course overview with independent access status for each source. */
export async function handleGetCourseOverview(deps: GetCourseOverviewDeps, raw: unknown) {
  const input = getCourseOverviewSchema.parse(raw);
  const course = OrgUnitId.of(input.course_id);
  const now = new Date();
  const until = new Date(now.getTime() + input.days * 86_400_000);
  const readers: Record<Section, () => Promise<{ count: number; items: unknown[]; has_more: boolean }>> = {
    content: async () => {
      const all = await deps.contentRepo.findModules(course);
      return { count: all.length, has_more: all.length > 10,
        items: all.slice(0, 10).map(m => ({ module_id: m.id, title: m.title, topic_count: m.topics.length })) };
    },
    assignments: async () => {
      const all = await deps.assignmentRepo.findByCourse(course);
      return { count: all.length, has_more: all.length > 10,
        items: all.slice(0, 10).map(a => ({ assignment_id: AssignmentId.toNumber(a.id), title: a.name, due_at: a.dueDate.toDate()?.toISOString() ?? null })) };
    },
    announcements: async () => {
      const all = await deps.communicationsRepo.findAnnouncements(course);
      return { count: all.length, has_more: all.length > 10,
        items: all.slice(0, 10).map(a => ({ announcement_id: a.id, title: a.title, posted_at: a.postedAt.toISOString() })) };
    },
    quizzes: async () => {
      const all = await deps.quizRepo.findByCourse(course);
      return { count: all.length, has_more: all.length > 10,
        items: all.slice(0, 10).map(q => ({ quiz_id: q.id, title: q.name, due_at: q.dueDate?.toISOString() ?? null, closes_at: q.endDate?.toISOString() ?? null })) };
    },
    calendar: async () => {
      const all = await deps.calendarRepo.findEvents(course, now, until);
      return { count: all.length, has_more: all.length > 10,
        items: all.slice(0, 10).map(e => ({ event_id: e.id, title: e.title, starts_at: e.startAt.toISOString() })) };
    },
  };
  const coverage = await Promise.all([...new Set(input.sections)].map(async section => {
    try { return { section, status: 'ok' as const, ...(await readers[section]()) }; }
    catch (err) { return { section, ...accessError(err) }; }
  }));
  const failures = coverage.filter(c => c.status !== 'ok');
  const status = failures.length === coverage.length ? 'unavailable' : failures.length ? 'partial' : 'ok';
  const lines = coverage.map(c => c.status === 'ok'
    ? `${c.section}: ${c.count} item(s)${c.has_more ? '; first 10 shown' : ''}`
    : `${c.section}: ${c.status} — ${c.reason}`);
  return {
    content: [{ type: 'text' as const, text: `Course ${input.course_id} overview:\n${lines.join('\n')}\nUse the section-specific tool for full details.` }],
    structuredContent: { status, course_id: input.course_id,
      coverage, retrieved_at: now.toISOString() },
  };
}
