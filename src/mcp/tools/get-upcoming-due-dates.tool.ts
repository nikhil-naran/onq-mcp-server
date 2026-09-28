import type { CourseRepository } from '@/contexts/courses/domain/CourseRepository.js';
import type { AssignmentRepository } from '@/contexts/assignments/domain/AssignmentRepository.js';
import type { QuizRepository } from '@/contexts/quizzes/domain/QuizRepository.js';
import type { CalendarRepository } from '@/contexts/calendar/domain/CalendarRepository.js';
import { getUpcomingDueDatesSchema } from '@/mcp/schemas.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import { CourseId } from '@/contexts/courses/domain/CourseId.js';
import { AssignmentId } from '@/contexts/assignments/domain/AssignmentId.js';
import type { OutputContext } from '@/shared-kernel/output/index.js';

export interface GetUpcomingDueDatesDeps {
  courseRepo: CourseRepository;
  assignmentRepo: AssignmentRepository;
  quizRepo?: QuizRepository;
  calendarRepo?: CalendarRepository;
  baseUrl?: string;
  output: OutputContext;
}
interface Entry {
  id: string; courseId: number; course: string; title: string;
  kind: 'assignment_due' | 'quiz_closes' | 'calendar_event'; at: string; url?: string;
}
export async function handleGetUpcomingDueDates(deps: GetUpcomingDueDatesDeps, rawInput: unknown) {
  const input = getUpcomingDueDatesSchema.parse(rawInput);
  const courses = await deps.courseRepo.findMyCourses({ activeOnly: true });
  const from = new Date();
  const to = new Date(from.getTime() + input.days * 86400000);
  const warnings: string[] = [];
  const entries: Entry[] = [];
  const coverage: Array<{ courseId: number; source: string; ok: boolean }> = [];
  await Promise.all(courses.map(async course => {
    const id = CourseId.toNumber(course.id);
    const org = OrgUnitId.of(id);
    const add = (key: number, title: string, kind: Entry['kind'], date: Date | null) => {
      if (!date || !Number.isFinite(date.getTime()) || date < from || date > to) return;
      entries.push({ id: `${kind}:${id}:${key}`, courseId: id, course: course.name, title, kind,
        at: date.toISOString(), ...(deps.baseUrl ? { url: `${deps.baseUrl}/d2l/home/${id}` } : {}) });
    };
    const jobs: Array<[string, () => Promise<void>]> = [
      ['assignments', async () => {
        for (const a of await deps.assignmentRepo.findByCourse(org))
          add(AssignmentId.toNumber(a.id), a.name, 'assignment_due', a.dueDate.toDate());
      }],
    ];
    if (deps.quizRepo) jobs.push(['quizzes', async () => {
      for (const q of await deps.quizRepo!.findByCourse(org)) add(q.id, q.name, 'quiz_closes', q.endDate);
    }]);
    if (deps.calendarRepo) jobs.push(['calendar', async () => {
      for (const e of await deps.calendarRepo!.findEvents(org, from, to)) add(e.id, e.title, 'calendar_event', e.startAt);
    }]);
    await Promise.all(jobs.map(async ([source, run]) => {
      try { await run(); coverage.push({ courseId: id, source, ok: true }); }
      catch { coverage.push({ courseId: id, source, ok: false }); warnings.push(`${course.name}: ${source} unavailable; this agenda is incomplete.`); }
    }));
  }));
  entries.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  coverage.sort((a, b) => a.courseId - b.courseId || a.source.localeCompare(b.source));
  warnings.sort();
  const labels = { assignment_due: 'Assignment due', quiz_closes: 'Quiz closes', calendar_event: 'Calendar event' };
  const rows = entries.map(e => `• ${deps.output.formatDate(new Date(e.at), 'datetime')} (${deps.output.tz}) — ${e.course}: ${e.title} [${labels[e.kind]}]`);
  const summary = rows.length ? `Upcoming agenda (next ${input.days} days):\n${rows.join('\n')}`
    : warnings.length ? 'No entries retrieved. Some sources failed; do not interpret this as no deadlines.'
    : 'No upcoming entries in the sources checked.';
  return {
    content: [{ type: 'text' as const, text: [summary, ...warnings, 'Quiz closing times and calendar events are labeled separately from assignment due dates.', deps.output.metaFooter()].filter(Boolean).join('\n\n') }],
    structuredContent: { entries, warnings, coverage, retrievedAt: from.toISOString(), timezone: deps.output.tz },
    ...(coverage.length && coverage.every(c => !c.ok) ? { isError: true } : {}),
  };
}
