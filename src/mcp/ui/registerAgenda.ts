import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getUpcomingDueDatesSchema } from '../schemas.js';
import { handleGetUpcomingDueDates, type GetUpcomingDueDatesDeps } from '../tools/get-upcoming-due-dates.tool.js';
export function registerAgenda(server: McpServer, deps: GetUpcomingDueDatesDeps): void {
  const uri = 'ui://onq/agenda-v1.html';
  server.registerResource('onq-agenda', uri, {}, async () => ({ contents: [{
    uri, mimeType: 'text/html;profile=mcp-app', text: readFileSync(new URL('./agenda.html', import.meta.url), 'utf8'),
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
  }] }));
  server.registerTool('show_onq_agenda', {
    title: 'Show OnQ agenda', description: 'Show a visual course agenda with filters. Fetches current available assignment deadlines, quiz closing times and calendar events; displays coverage warnings.',
    inputSchema: getUpcomingDueDatesSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: uri } },
  }, input => handleGetUpcomingDueDates(deps, input));
}
