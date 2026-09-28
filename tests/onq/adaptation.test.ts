import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { InteractiveBrowserStrategy } from '@/contexts/authentication/infrastructure/strategies/InteractiveBrowserStrategy.js';
import { CookieFileCredentialStore } from '@/contexts/authentication/infrastructure/credential-stores/CookieFileCredentialStore.js';
import { EnsureAuthenticated } from '@/contexts/authentication/application/EnsureAuthenticated.js';
import { InMemorySessionCache } from '@/contexts/authentication/infrastructure/session-caches/InMemorySessionCache.js';
import { UserId } from '@/shared-kernel/types/UserId.js';
import { AccessToken } from '@/contexts/authentication/domain/AccessToken.js';
import { D2lApiClient } from '@/contexts/http-api/D2lApiClient.js';
import { D2lOnqRepository } from '@/contexts/onq/infrastructure/D2lOnqRepository.js';
import { handleGetUpcomingDueDates } from '@/mcp/tools/get-upcoming-due-dates.tool.js';
import { FakeCourseRepository } from '@tests/helpers/fakes/FakeCourseRepository.js';
import { FakeAssignmentRepository } from '@tests/helpers/fakes/FakeAssignmentRepository.js';
import { Course } from '@/contexts/courses/domain/Course.js';
import { CourseId } from '@/contexts/courses/domain/CourseId.js';
import { testOutputContext } from '@tests/helpers/test-output-context.js';

const dirs: string[] = [];
async function temp() { const d = await mkdtemp(join(tmpdir(), 'onq-test-')); dirs.push(d); return d; }
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const identity = { userId: UserId.of(1), displayName: 'Student', uniqueName: 'student' };
const ctx = { baseUrl: 'https://onq.queensu.ca', profile: 'onq' };
function browser(cookies = [{ name: 'session', value: 'fake' }]) {
  const page = { goto: vi.fn(), isClosed: () => false, url: () => ctx.baseUrl + '/d2l/home', waitForTimeout: vi.fn() };
  return { cookies: vi.fn().mockResolvedValue(cookies), close: vi.fn(), pages: () => [page], newPage: vi.fn() };
}

describe('persistent human login', () => {
  it('reuses saved cookies without opening a visible window and shares concurrent login work', async () => {
    const b = browser(); const launch = vi.fn().mockResolvedValue(b);
    const whoami = vi.fn().mockResolvedValue(identity);
    const strategy = new InteractiveBrowserStrategy({ profileDir: await temp(), timeoutMs: 1000, sessionTtlMs: 10000, whoami, launch });
    const auth = new EnsureAuthenticated(new InMemorySessionCache(), strategy);
    const [a, c] = await Promise.all([auth.execute(ctx), auth.execute(ctx)]);
    expect(a).toBe(c); expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[1]).toEqual({ headless: true });
    expect(b.cookies).toHaveBeenCalledWith('https://onq.queensu.ca/d2l/api/');
    expect(b.close).toHaveBeenCalledTimes(1);
  });
  it('opens interactive login only after an expired session and validates the new identity', async () => {
    const quiet = browser(), visible = browser();
    const launch = vi.fn().mockResolvedValueOnce(quiet).mockResolvedValueOnce(visible);
    const whoami = vi.fn().mockRejectedValueOnce({ status: 401 }).mockResolvedValueOnce(identity);
    const strategy = new InteractiveBrowserStrategy({ profileDir: await temp(), timeoutMs: 1000, sessionTtlMs: 10000, whoami, launch });
    expect((await strategy.authenticate(ctx)).userIdentity).toEqual(identity);
    expect(launch.mock.calls[1]?.[1]).toEqual({ headless: false });
    expect(quiet.close).toHaveBeenCalled(); expect(visible.close).toHaveBeenCalled();
  });
  it('does not turn network failures into repeated sign-in prompts', async () => {
    const b = browser(), launch = vi.fn().mockResolvedValue(b);
    const strategy = new InteractiveBrowserStrategy({ profileDir: await temp(), timeoutMs: 1000, sessionTtlMs: 10000, whoami: vi.fn().mockRejectedValue(new Error('offline')), launch });
    await expect(strategy.authenticate(ctx)).rejects.toThrow('offline');
    expect(launch).toHaveBeenCalledTimes(1); expect(b.close).toHaveBeenCalled();
  });
  it('closes the visible context when the user cancels', async () => {
    const q = browser([]); const b = browser(); b.pages()[0].isClosed = () => true;
    const launch = vi.fn().mockResolvedValueOnce(q).mockResolvedValueOnce(b as unknown as BrowserContext);
    const strategy = new InteractiveBrowserStrategy({ profileDir: await temp(), timeoutMs: 1000, sessionTtlMs: 10000, whoami: vi.fn(), launch });
    await expect(strategy.authenticate(ctx)).rejects.toThrow('cancelled'); expect(b.close).toHaveBeenCalled();
  });
});

describe('cookie file compatibility', () => {
  it('reads the explicit recorder scheme and rejects header injection', async () => {
    const path = join(await temp(), 'cookie.txt'), store = new CookieFileCredentialStore();
    await writeFile(path, 'session=fake');
    expect((await store.get(`cookiefile:${path}`))?.reveal()).toBe('session=fake');
    await writeFile(path, 'session=fake\r\nInjected: yes');
    await expect(store.get(`cookiefile:${path}`)).rejects.toThrow('Invalid');
    await expect(store.get(`file:${path}`)).rejects.toThrow('absolute path');
  });
});

describe('bounded authenticated downloads', () => {
  const client = () => new D2lApiClient({ baseUrl: ctx.baseUrl, getToken: async () => AccessToken.cookie('session=fake') });
  it('does not forward session cookies to a redirect outside OnQ', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://other.example/file' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(client().getRaw('/file')).rejects.toThrow('failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('enforces the byte limit before buffering a declared large body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('small', { headers: { 'content-length': String(30 * 1024 * 1024) } })));
    await expect(client().getRaw('/file')).rejects.toThrow('25 MB');
  });
  it('refreshes once after a 401 on a binary download', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(new Response('document'));
    const refresh = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('fetch', fetch);
    const c = new D2lApiClient({ baseUrl: ctx.baseUrl, getToken: async () => AccessToken.cookie('session=fake'), onAuthFailure: refresh });
    expect((await c.getRaw('/file')).toString()).toBe('document'); expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('OnQ additions', () => {
  it('keeps missing rubric/completion access explicit instead of claiming absence', async () => {
    const get = vi.fn().mockResolvedValueOnce([{ Id: 7, Instructions: { Text: 'Read this' } }]).mockRejectedValue({ status: 403 });
    const repo = new D2lOnqRepository({ get } as unknown as D2lApiClient, '1.92', ctx.baseUrl);
    const details = await repo.assignmentDetails(1, 7);
    expect(details.warnings).toHaveLength(1); expect(details.folder).toMatchObject({ Id: 7 });
    expect((await repo.contentCompletions(1)).warnings).toHaveLength(1);
  });
  it('returns accessible rubric criteria while filtering hidden associations', async () => {
    const get = vi.fn().mockResolvedValueOnce([{ Id: 7 }]).mockResolvedValueOnce([{ RubricId: 4 }, { RubricId: 5, IsHidden: true }]).mockResolvedValueOnce({ Name: 'Clarity', Criteria: [{ Name: 'Evidence' }] });
    const repo = new D2lOnqRepository({ get } as unknown as D2lApiClient, '1.92', ctx.baseUrl);
    expect((await repo.assignmentDetails(1, 7)).rubrics).toHaveLength(1); expect(get).toHaveBeenCalledTimes(3);
  });
  it('returns incomplete coverage when one course fails rather than saying nothing is due', async () => {
    const courseRepo = new FakeCourseRepository([new Course({ id: CourseId.of(1), name: 'Math', code: 'MATH', active: true })]);
    const assignmentRepo = new FakeAssignmentRepository(); assignmentRepo.findByCourse = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await handleGetUpcomingDueDates({ courseRepo, assignmentRepo, output: testOutputContext() }, { days: 7 });
    expect(result.isError).toBe(true); expect(result.structuredContent.warnings).toHaveLength(1);
    expect(result.content[0]?.text).toContain('do not interpret this as no deadlines');
  });
});
