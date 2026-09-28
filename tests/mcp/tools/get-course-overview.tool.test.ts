import { describe, expect, it, vi } from 'vitest';
import { handleGetCourseOverview } from '@/mcp/tools/get-course-overview.tool.js';
import { D2lApiError } from '@/contexts/http-api/errors.js';

describe('single-course overview', () => {
  it('reports historical access denials per section without calling other sections', async () => {
    const findModules = vi.fn().mockRejectedValue(new D2lApiError(403, '/content/', '{}'));
    const findByCourse = vi.fn().mockRejectedValue(new D2lApiError(403, '/dropbox/', '{}'));
    const findAnnouncements = vi.fn();
    const deps = { contentRepo: { findModules }, assignmentRepo: { findByCourse },
      communicationsRepo: { findAnnouncements }, quizRepo: { findByCourse: vi.fn() },
      calendarRepo: { findEvents: vi.fn() } } as never;
    const result = await handleGetCourseOverview(deps, { course_id: 101, sections: ['content', 'assignments'] });
    expect(result.structuredContent.status).toBe('unavailable');
    expect(result.structuredContent.coverage).toEqual([
      expect.objectContaining({ section: 'content', status: 'forbidden', http_status: 403 }),
      expect.objectContaining({ section: 'assignments', status: 'forbidden', http_status: 403 }),
    ]);
    expect(result.content[0]?.text).not.toContain('0 item(s)');
    expect(findAnnouncements).not.toHaveBeenCalled();
  });
});
