# ONQ MCP Server — How It Works

A TypeScript/Node.js server that connects Claude Desktop to Queen's University's ONQ learning management system (D2L Brightspace). It speaks the **Model Context Protocol (MCP)** over stdio, so Claude can read your courses, assignments, grades, announcements, and course content files directly inside a conversation — no copy-pasting required.

---

## High-level architecture

```
Claude Desktop
     │  (stdio — JSON-RPC)
     ▼
index.ts  ←── Tool router & handlers
     │
     ├── auth.ts   ←── Queen's SSO login via Playwright
     ├── api.ts    ←── Typed D2L REST API client
     └── config.ts ←── Host, API versions, paths
```

When Claude needs ONQ data it calls one of the MCP tools. `index.ts` receives the call, ensures you're authenticated, calls one or more methods on `ONQApiClient` (`api.ts`), formats the result as plain text, and returns it to Claude.

---

## Source files

### `src/config.ts`
Central constants. Everything configurable lives here.

| Export | Default | What it is |
|---|---|---|
| `ONQ_HOST` | `https://onq.queensu.ca` | Base URL. Override with `ONQ_HOST` env var. |
| `LP_VERSION` | `1.57` | D2L LP (Learning Platform) API version |
| `LE_VERSION` | `1.92` | D2L LE (Learning Environment) API version |
| `SESSION_DIR` | `~/.onq-session/` | Directory where session cookies are stored |
| `SESSION_FILE` | `~/.onq-session/session.json` | The actual cookie file |
| `LOGIN_TIMEOUT_MS` | `300 000` (5 min) | How long the browser window stays open waiting for you to log in |

---

### `src/auth.ts`
Handles authentication. Uses **Playwright** to open a real Chromium window and let you complete Queen's Microsoft SSO in the browser (no credentials ever pass through the server). Once you're redirected back to ONQ after login, it captures the session cookies and writes them to disk.

**Login flow:**
1. Try loading `~/.onq-session/session.json`
2. Validate those cookies with a `/whoami` API call
3. If expired or missing → open a headless-off Chromium window at `onq.queensu.ca/d2l/login`
4. Wait (up to 5 minutes) for the URL to leave all SSO domains and land back at ONQ
5. Capture all `queensu.ca` cookies, write to `session.json` with mode `0600` (owner-only)

The cookie file is written as **JSON with 600 permissions** — only your Mac user account can read it.

---

### `src/api.ts`
The typed HTTP client for D2L's REST API. All network calls go through here.

**`ONQApiClient`** takes a cookie array in its constructor and attaches them as a `Cookie` header on every request. It uses `axios` under the hood.

Key methods and the D2L endpoints they call:

| Method | D2L endpoint |
|---|---|
| `whoAmI()` | `GET /d2l/api/lp/{LP}/users/whoami` |
| `getEnrollments()` | `GET /d2l/api/lp/{LP}/enrollments/myenrollments/?orgUnitTypeId=3` |
| `getAssignments(courseId)` | `GET /d2l/api/le/{LE}/{courseId}/dropbox/folders/` |
| `getAssignmentDetails(courseId, folderId)` | `GET /d2l/api/le/{LE}/{courseId}/dropbox/folders/{folderId}` — tries 5 URL variants with version fallback |
| `downloadDropboxAttachment(courseId, folderId, attachment)` | `GET /d2l/api/le/{LE}/{courseId}/dropbox/folders/{folderId}/attachments/{FileId}` — tries numeric `FileId` first, falls back to encoded `FileSystemLocator` |
| `getGrades(courseId)` | `GET /d2l/api/le/{LE}/{courseId}/grades/values/myGradeValues/` |
| `getAnnouncements(courseId)` | `GET /d2l/api/le/{LE}/{courseId}/news/` |
| `getAnnouncementDetail(courseId, newsItemId)` | `GET /d2l/api/le/{LE}/{courseId}/news/{newsItemId}/` |
| `getCourseToc(courseId)` | `GET /d2l/api/le/{LE}/{courseId}/content/toc` |
| `getTopicContent(courseId, topicId)` | `GET /d2l/api/le/{LE}/{courseId}/content/topics/{topicId}` |
| `fetchTopicFile(courseId, topicId)` | `GET /d2l/api/le/{LE}/{courseId}/content/topics/{topicId}/file` |
| `getDropboxRubrics(courseId, folderId)` | `GET /d2l/api/le/{LE}/{courseId}/dropbox/folders/{folderId}/rubrics/` |
| `getRubricDetail(courseId, rubricId)` | `GET /d2l/api/le/{LE}/{courseId}/rubrics/{rubricId}/` — version fallback |
| `checkApiVersions()` | `GET /d2l/api/versions/` |

**Version fallback pattern:** Several endpoints (assignment details, rubric detail, attachment download) silently try multiple `LE_VERSION` strings (1.92 → 1.71 → 1.68 → 1.51) in case ONQ's Brightspace release doesn't support the latest version for a given endpoint.

**Error handling:** `ONQApiError` wraps HTTP errors with the status code. The `get<T>()` helper parses `application/problem+json` responses and extracts the `detail` or `title` field so errors are human-readable.

---

### `src/index.ts`
The MCP server entry point. Registers all tools, receives calls from Claude over stdio, dispatches to handler functions, and returns results.

**Startup side effects (happen once at process start):**
- Installs a `DOMMatrix` polyfill on `globalThis` — pdfjs-dist (used by `pdf-parse`) requires this browser-only Web API for 2D text transforms. Without it, PDF text extraction crashes with `DOMMatrix is not defined`.
- Creates `~/Downloads/onq-files/` if it doesn't already exist.

**Session caching:** An `ONQApiClient` instance is kept in memory (`apiClient`). Every tool call goes through `ensureAuthenticated()` which runs a quick `/whoami` check; if that 401s the stale client is discarded and re-auth runs.

---

## The 11 MCP tools

| Tool | What it does |
|---|---|
| `login_status` | Validates current session; opens browser for SSO if needed |
| `list_courses` | Lists all enrolled courses with IDs and codes |
| `list_assignments` | Lists dropbox folders for one course or all courses |
| `get_assignment_details` | Returns instructions, attached PDFs (text-extracted), and rubric for one assignment |
| `get_grades` | Returns all grade items and scores for a course |
| `list_announcements` | Returns full announcement bodies (fetches each item individually to avoid list-truncation) |
| `get_course_content` | Returns the full content tree (modules → topics) for a course |
| `get_topic_content` | Returns the content of one topic — HTML stripped to text, or PDF text-extracted |
| `get_upcoming_deadlines` | Returns assignments due within N days across all courses |
| `check_api_versions` | Debug: calls `/d2l/api/versions/` and shows which LP/LE versions ONQ supports |
| `logout` | Deletes `~/.onq-session/session.json` and clears the in-memory client |

---

## PDF extraction pipeline

Used in both `get_topic_content` (course content PDFs) and `get_assignment_details` (dropbox instruction PDFs).

1. Download file as `ArrayBuffer` via axios
2. Save the raw bytes to `~/Downloads/onq-files/<sanitised_filename>.pdf`
3. Dynamically import `pdf-parse` (ESM): `const { PDFParse, VerbosityLevel } = await import('pdf-parse')`
4. Construct parser: `new PDFParse({ data: new Uint8Array(buffer), verbosity: VerbosityLevel.ERRORS })`
5. `await parser.getText()` — returns `{ text: string, total: number }` (total = page count)
6. `await parser.destroy()` in a `finally` block — **required** to release the pdfjs worker thread; omitting this causes large PDFs to hang indefinitely
7. Cap text at 50 pages / ~150 KB before returning to Claude
8. If the PDF has no selectable text (scanned image-only), report that and direct the user to the saved file

The `DOMMatrix` polyfill is critical — pdfjs-dist uses it internally for coordinate transforms when placing text glyphs. It's a complete implementation covering `transformPoint`, `multiply`, `scale`, `translate`, `rotate`, `inverse`, `flipX/Y`, and the `Float32Array`/`Float64Array` export methods.

---

## Where files are stored

| Path | What's there | Permissions |
|---|---|---|
| `~/.onq-session/session.json` | D2L session cookies (JSON array of Playwright `Cookie` objects) | `0600` — owner read/write only |
| `~/.onq-session/` | Parent directory | `0700` — owner only |
| `~/Downloads/onq-files/` | Every PDF downloaded through the MCP — course readings, lecture slides, assignment instruction PDFs | Normal user file permissions |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | Claude Desktop MCP server registration — points `command` at `node` and `args` at `dist/index.js` | Normal |
| `<project>/dist/` | Compiled JavaScript output (`tsc` output of `src/`) | Auto-generated — do not edit |
| `<project>/src/` | TypeScript source files | Edit these |

---

## Build & development

```bash
# One-time setup
npm install                  # installs deps + runs playwright install chromium

# Compile TypeScript → dist/
npm run build                # tsc (strict, ESM, NodeNext)

# Watch mode (auto-recompile on save)
npm run dev

# Run directly (normally started by Claude Desktop)
npm start
```

After any source change, run `npm run build` then **restart Claude Desktop** to reload `dist/index.js` (Claude spawns the server as a subprocess and doesn't hot-reload).

---

## How Claude Desktop connects to it

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "onq": {
      "command": "node",
      "args": ["/path/to/onq-mcp-server/dist/index.js"]
    }
  }
}
```

Claude Desktop spawns `node dist/index.js` as a child process on startup. The server communicates over **stdio** using JSON-RPC (the MCP wire format). Claude sends `tools/list` to discover available tools, then `tools/call` with a tool name and arguments when it wants data. Responses go back as plain text content blocks.

---

## Known limitations

- **Dropbox attachment downloads** require the attachment's `FileId` field to be populated in the D2L API response. If D2L returns `FileId: null` (older course configurations), the fallback uses a URL-encoded `FileSystemLocator` which may also be rejected. In that case the raw file must be opened directly in ONQ.
- **Scanned PDFs** (image-only, no selectable text layer) cannot be text-extracted — `pdf-parse` returns an empty string and the file path is surfaced instead.
- **Videos** have no transcript or metadata available through the D2L REST API.
- **Session cookies expire** with Brightspace's session timeout (typically a few hours to a day). The next tool call after expiry automatically re-opens the browser for SSO.
- **LTI / SCORM / Quiz / Discussion links** in course content are returned as their URL only — the underlying content is on a third-party system that requires a real browser session.
