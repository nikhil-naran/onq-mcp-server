import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockD2l } from './mock-d2l.js';

describe('Windows coursework tool profile', () => {
  let mock: Awaited<ReturnType<typeof startMockD2l>>;
  let client: Client;
  beforeAll(async () => {
    mock = await startMockD2l();
    const dir = mkdtempSync(join(tmpdir(), 'onq-coursework-'));
    const config = join(dir, 'config.yaml');
    writeFileSync(config, `default_profile: coursework\nprofiles:\n  coursework:\n    base_url: ${mock.url}\n    auth:\n      strategy: api_token\n      api_token: { token_ref: env:COURSEWORK_TOK }\n`);
    client = new Client({ name: 'coursework-test', version: '0' }, {});
    await client.connect(new StdioClientTransport({ command: 'node', args: ['build/cli/main.js', 'serve', '--config', config],
      env: { ...process.env, COURSEWORK_TOK: 'test', ONQ_TOOL_PROFILE: 'coursework',
        BRIGHTSPACE_ALLOW_HTTP_LOCALHOST: '1', BRIGHTSPACE_AUDIT_LOG: join(dir, 'audit.log') } as Record<string, string> }));
  }, 60_000);
  afterAll(async () => { await client?.close(); await mock?.close(); });

  it('retains coursework capabilities while hiding unverified and maintenance actions', async () => {
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names.length).toBeLessThanOrEqual(27);
    expect(names).toEqual(expect.arrayContaining([
      'list_my_courses', 'get_course_overview', 'get_course_content', 'get_module',
      'get_assignments', 'get_assignment_details', 'get_assignment_files', 'get_my_submissions',
      'get_my_grades', 'get_feedback', 'get_roster', 'get_announcements', 'get_announcement',
      'get_calendar_events', 'get_upcoming_due_dates', 'show_onq_agenda', 'list_quizzes',
      'find_onq_files', 'retrieve_onq_file', 'check_auth',
    ]));
    for (const hidden of ['get_content_completions', 'get_quiz_attempts', 'get_classlist_emails',
      'clear_cache', 'get_diagnostics', 'get_audit_log', 'submit_assignment']) expect(names).not.toContain(hidden);
    const roster = await client.callTool({ name: 'get_roster', arguments: { course_id: 1, format: 'emails' } });
    expect((roster.content as Array<{ text?: string }>)[0]?.text).toContain('test@x.edu');
    expect((roster.content as Array<{ text?: string }>)[0]?.text).not.toContain('Smoke Instructor');
  });
});
