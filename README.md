# onq-mcp-server

An MCP (Model Context Protocol) server that connects Claude Desktop to **ONQ** — Queen's University's D2L Brightspace learning management system.

Ask Claude things like:
- *"What assignments do I have due this week?"*
- *"What's my current grade in CISC 101?"*
- *"Summarize the latest announcements from my courses."*
- *"What does the rubric say for my ELEC 392 lab report?"*
- *"Have I submitted Assignment 2 yet?"*
- *"Show me upcoming exam dates for CHEM 112."*
- *"What did I score on my last quiz attempt?"*
- *"What's on the course content page for my bio class?"*

---

## How it works

1. On first use, a real Chromium browser window opens.
2. You log in with your Queen's NetID and password (standard SSO — this server never sees your password).
3. The session cookies are saved to `~/.onq-session/session.json` (owner-only permissions).
4. All subsequent tool calls reuse that saved session until it expires (~24 h).

---

## Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **npm 9+** (included with Node.js)
- **Claude Desktop** — [claude.ai/download](https://claude.ai/download)

---

## Installation

```bash
# 1. Clone or download this folder, then:
cd onq-mcp-server

# 2. Install dependencies (also auto-installs Chromium via Playwright)
npm install

# 3. Build TypeScript
npm run build
```

---

## Connecting to Claude Desktop

Open your Claude Desktop configuration file:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add the `onq` entry inside `"mcpServers"`:

```json
{
  "mcpServers": {
    "onq": {
      "command": "node",
      "args": ["/FULL/PATH/TO/onq-mcp-server/dist/index.js"]
    }
  }
}
```

Replace `/FULL/PATH/TO/` with the actual path where you placed this folder.

**macOS example:**
```json
"args": ["/Users/yourname/Projects/onq-mcp-server/dist/index.js"]
```

**Windows example:**
```json
"args": ["C:\\Users\\yourname\\Projects\\onq-mcp-server\\dist\\index.js"]
```

Restart Claude Desktop after saving.

---

## First run

The first time you use any ONQ tool in Claude (e.g. *"list my courses"*), a Chromium browser window will pop up. Log in with your Queen's NetID. Once the page loads your ONQ dashboard, the window closes automatically and Claude gets your data.

---

## Available tools

| Tool | Description |
|------|-------------|
| `login_status` | Check if you're logged in; triggers login if not |
| `list_courses` | All enrolled courses with IDs and codes |
| `list_assignments` | Assignments for one course or all courses |
| `get_assignment_details` | Full rubric, instructions, and attached files (PDF/DOCX extracted) for one assignment; includes submission status |
| `get_grades` | Your grades for a specific course |
| `list_announcements` | Latest announcements for a course, including any file attachments |
| `get_course_content` | Full content tree (modules → topics) with completion status for a course |
| `get_topic_content` | Text content of one topic — HTML stripped, or PDF/DOCX text extracted |
| `get_upcoming_deadlines` | All due dates in the next N days across all courses |
| `get_calendar_events` | Upcoming calendar events including exam dates for a course |
| `get_quiz_attempts` | All quizzes for a course with your attempt history and scores |
| `get_discussion_posts` | Browse discussion forums and read posts in a course |
| `check_api_versions` | Debug: shows what D2L API versions ONQ supports |
| `logout` | Clear the saved session from disk |

---

## Configuration

You can override defaults with environment variables in the Claude Desktop config:

```json
{
  "mcpServers": {
    "onq": {
      "command": "node",
      "args": ["/path/to/onq-mcp-server/dist/index.js"],
      "env": {
        "ONQ_HOST": "https://onq.queensu.ca",
        "ONQ_LP_VERSION": "1.28",
        "ONQ_LE_VERSION": "1.53",
        "ONQ_PDF_MAX_PAGES": "50",
        "ONQ_PDF_IMAGE_MAX_PAGES": "15"
      }
    }
  }
}
```

| Variable | Default | Description |
|----------|---------|-------------|
| `ONQ_HOST` | `https://onq.queensu.ca` | Base URL (change for other Brightspace instances) |
| `ONQ_LP_VERSION` | `1.57` | D2L Learning Platform API version |
| `ONQ_LE_VERSION` | `1.92` | D2L Learning Environment API version |
| `ONQ_PDF_MAX_PAGES` | `50` | Max pages to extract from any PDF before truncating |
| `ONQ_PDF_IMAGE_MAX_PAGES` | `15` | Max pages to render as images for slide-style PDFs |

### Fixing 404 errors

If you see "Endpoint not found" errors, ONQ may be running a different Brightspace version. Run the `check_api_versions` tool to see what's supported, then update `ONQ_LP_VERSION` and `ONQ_LE_VERSION` in the env config above.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Browser doesn't open | Make sure you ran `npm install` (installs Chromium) |
| "Session expired" after a day | Normal — just use any tool again to re-login |
| 404 errors on API calls | See "Fixing 404 errors" above |
| Login window closes too fast | Increase the `LOGIN_TIMEOUT_MS` value in `src/config.ts` |
| Data looks stale | Run `logout` then use any tool to get a fresh session |
| Large PDFs are slow or get cut off | Lower or raise `ONQ_PDF_MAX_PAGES` to control how many pages are extracted |

---

## Privacy & security

- **Your password is never stored or seen** by this server — login happens in a real browser via Queen's SSO.
- Session cookies are stored in `~/.onq-session/session.json` with `chmod 600` (only your OS user can read it).
- All communication goes directly from your machine to `onq.queensu.ca` — no data is sent anywhere else.
- This tool is for **personal academic use only**. Do not use it to facilitate academic misconduct or violate Queen's University policies.

---

## Project structure

```
onq-mcp-server/
├── src/
│   ├── config.ts      # Host URL and API version constants
│   ├── auth.ts        # Playwright SSO login + cookie persistence
│   ├── api.ts         # Typed D2L REST API client
│   └── index.ts       # MCP server — tool definitions and handlers
├── dist/              # Compiled JavaScript (generated by `npm run build`)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Based on

Research into existing D2L MCP servers:
- [bencered/d2l-mcp-server](https://github.com/bencered/d2l-mcp-server)
- [General-Mudkip/d2l-mcp-server](https://github.com/General-Mudkip/d2l-mcp-server)
- [pranav-vijayananth/brightspace-mcp-server](https://github.com/pranav-vijayananth/brightspace-mcp-server)

D2L API reference: [docs.valence.desire2learn.com](https://docs.valence.desire2learn.com)
