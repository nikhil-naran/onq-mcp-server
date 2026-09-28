import { describe, it, expect } from 'vitest';
import { handleGetUpcomingDueDates } from '@/mcp/tools/get-upcoming-due-dates.tool';
import { FakeCourseRepository } from '@tests/helpers/fakes/FakeCourseRepository';
import { FakeAssignmentRepository } from '@tests/helpers/fakes/FakeAssignmentRepository';
import { Course } from '@/contexts/courses/domain/Course';
import { CourseId } from '@/contexts/courses/domain/CourseId';
import { Assignment } from '@/contexts/assignments/domain/Assignment';
import { AssignmentId } from '@/contexts/assignments/domain/AssignmentId';
import { DueDate } from '@/contexts/assignments/domain/DueDate';
import { Quiz } from '@/contexts/quizzes/domain/Quiz';
import type { QuizRepository } from '@/contexts/quizzes/domain/QuizRepository';
import { testOutputContext } from '../../helpers/test-output-context.js';
import { FakeCalendarRepository } from '@tests/helpers/fakes/FakeCalendarRepository.js';
import { CalendarEvent } from '@/contexts/calendar/domain/CalendarEvent.js';

const noQuizzes: QuizRepository = { findByCourse: async () => [], findAttempts: async () => [] };

const course = (id: number, name: string) =>
  new Course({ id: CourseId.of(id), name, code: `C${id}`, active: true });

const asn = (id: number, courseOrgUnit: number, name: string, due: Date) =>
  new Assignment({
    id: AssignmentId.of(id),
    courseOrgUnitId: courseOrgUnit,
    name,
    instructions: null,
    dueDate: DueDate.at(due),
    submissions: [],
  });

describe('get_upcoming_due_dates tool', () => {
  it('shows matching assignment and calendar deadlines once with both stable source IDs', async () => {
    const due = new Date(Date.now() + 86_400_000);
    const courseRepo = new FakeCourseRepository([course(101, 'ECE 264')]);
    const assignmentRepo = new FakeAssignmentRepository(new Map([[101, [asn(1, 101, 'Lab report', due)]]]));
    const calendarRepo = new FakeCalendarRepository(new Map([[101, [new CalendarEvent({
      id: 22, courseOrgUnitId: 101, title: 'Lab report', description: null,
      startAt: due, endAt: null, location: null,
    })]]]));
    const r = await handleGetUpcomingDueDates({ courseRepo, assignmentRepo, calendarRepo,
      output: testOutputContext() }, { days: 7 });
    expect(r.structuredContent.entries).toHaveLength(1);
    expect(r.structuredContent.entries[0]?.sources).toEqual([
      { id: 'assignment_due:101:1', kind: 'assignment_due' },
      { id: 'calendar_event:101:22', kind: 'calendar_event' },
    ]);
    expect(r.content[0]?.text?.match(/Lab report/g)).toHaveLength(1);
  });
  it('aggregates assignments across all active courses inside the window', async () => {
    const courseRepo = new FakeCourseRepository([course(101, 'ECE 264'), course(202, 'MA 261')]);
    const assignmentRepo = new FakeAssignmentRepository(new Map([
      [101, [asn(1, 101, 'ECE Essay', new Date(Date.now() + 24 * 60 * 60 * 1000))]],
      [202, [asn(2, 202, 'MA Test', new Date(Date.now() + 48 * 60 * 60 * 1000))]],
    ]));
    const r = await handleGetUpcomingDueDates(
      { courseRepo, assignmentRepo, quizRepo: noQuizzes, output: testOutputContext() },
      { days: 7 },
    );
    expect(r.content[0]?.text).toContain('ECE Essay');
    expect(r.content[0]?.text).toContain('MA Test');
  });

  it('excludes due dates beyond the window', async () => {
    const courseRepo = new FakeCourseRepository([course(101, 'ECE 264')]);
    const assignmentRepo = new FakeAssignmentRepository(new Map([
      [101, [asn(1, 101, 'FarFuture', new Date(Date.now() + 60 * 24 * 60 * 60 * 1000))]],
    ]));
    const r = await handleGetUpcomingDueDates(
      { courseRepo, assignmentRepo, quizRepo: noQuizzes, output: testOutputContext() },
      { days: 7 },
    );
    expect(r.content[0]?.text).toMatch(/nothing|no upcoming/i);
  });

  it('renders due dates in the configured timezone, not UTC', async () => {
    // 04:59Z the next day is 23:59 in Bogotá (UTC-5).
    const due = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    due.setUTCHours(4, 59, 0, 0);
    const courseRepo = new FakeCourseRepository([course(101, 'ECE 264')]);
    const assignmentRepo = new FakeAssignmentRepository(new Map([[101, [asn(1, 101, 'Lab', due)]]]));
    const r = await handleGetUpcomingDueDates(
      { courseRepo, assignmentRepo, quizRepo: noQuizzes, output: testOutputContext({ tz: 'America/Bogota', locale: 'en-US' }) },
      { days: 7 },
    );
    const text = r.content[0]?.text ?? '';
    expect(text).toContain('Lab');
    expect(text).toContain('11:59');
    expect(text).not.toContain('04:59');
  });

  it('includes active quizzes with a due/end date in the window, labeled and sorted with assignments', async () => {
    const day = 24 * 60 * 60 * 1000;
    const courseRepo = new FakeCourseRepository([course(101, 'ECE 264')]);
    const assignmentRepo = new FakeAssignmentRepository(new Map([
      [101, [asn(1, 101, 'Essay', new Date(Date.now() + 3 * day))]],
    ]));
    const q = (id: number, name: string, due: Date | null, extra: Partial<ConstructorParameters<typeof Quiz>[0]> = {}) =>
      new Quiz({
        id, courseOrgUnitId: 101, name, startDate: null, endDate: due, dueDate: due,
        attemptsTaken: null, attemptsAllowed: 1, timeLimitMinutes: null, autoGrade: false, instructions: null,
        ...extra,
      });
    const quizRepo: QuizRepository = {
      findByCourse: async () => [
        q(10, 'Quiz 2', new Date(Date.now() + 1 * day)),
        q(11, 'Old quiz', new Date(Date.now() - 1 * day)),
        q(12, 'Far quiz', new Date(Date.now() + 30 * day)),
        q(13, 'Hidden quiz', new Date(Date.now() + 2 * day), { isActive: false }),
        q(14, 'Undated quiz', null),
      ],
      findAttempts: async () => [],
    };
    const r = await handleGetUpcomingDueDates(
      { courseRepo, assignmentRepo, quizRepo, output: testOutputContext() },
      { days: 7 },
    );
    const text = r.content[0]?.text ?? '';
    expect(text).toContain('Quiz 2 [Quiz due]');
    expect(text).toContain('Essay');
    expect(text.indexOf('Quiz 2')).toBeLessThan(text.indexOf('Essay'));
    expect(text).not.toContain('Old quiz');
    expect(text).not.toContain('Far quiz');
    expect(text).not.toContain('Hidden quiz');
    expect(text).not.toContain('Undated quiz');
  });

  it('still lists assignments when the quiz lookup fails for a course', async () => {
    const courseRepo = new FakeCourseRepository([course(101, 'ECE 264')]);
    const assignmentRepo = new FakeAssignmentRepository(new Map([
      [101, [asn(1, 101, 'Essay', new Date(Date.now() + 24 * 60 * 60 * 1000))]],
    ]));
    const quizRepo: QuizRepository = {
      findByCourse: async () => { throw new Error('boom'); },
      findAttempts: async () => [],
    };
    const r = await handleGetUpcomingDueDates(
      { courseRepo, assignmentRepo, quizRepo, output: testOutputContext() },
      { days: 7 },
    );
    expect(r.content[0]?.text).toContain('Essay');
  });

  it('returns friendly message when no active courses', async () => {
    const courseRepo = new FakeCourseRepository([]);
    const assignmentRepo = new FakeAssignmentRepository(new Map());
    const r = await handleGetUpcomingDueDates(
      { courseRepo, assignmentRepo, quizRepo: noQuizzes, output: testOutputContext() },
      { days: 7 },
    );
    expect(r.content[0]?.text).toMatch(/no upcoming|nothing/i);
  });
});
