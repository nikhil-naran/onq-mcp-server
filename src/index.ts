#!/usr/bin/env node
/**
 * index.ts — ONQ MCP Server entry point
 *
 * Exposes Queen's University onQ (D2L Brightspace) data as MCP tools
 * for use with Claude Desktop and other MCP-compatible AI clients.
 *
 * Tools:
 *   login_status          — Check / trigger authentication
 *   list_courses          — All enrolled courses
 *   list_assignments      — Assignments for one or all courses
 *   get_assignment_details — Full rubric/instructions for a single assignment
 *   get_grades            — Grades for a course
 *   list_announcements    — Announcements/news for a course
 *   get_course_content    — Content tree (modules & files) for a course
 *   get_topic_content     — Full content of a topic (HTML text or saved PDF path)
 *   get_upcoming_deadlines — Upcoming due dates across all courses
 *   check_api_versions    — Debug: show which D2L API versions ONQ supports
 *   logout                — Clear saved session
 *
 * ⚠️  For personal academic use only. Do not use to facilitate
 *     academic misconduct or violate Queen's University policies.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// ─── DOMMatrix polyfill ────────────────────────────────────────────────────────
// pdfjs-dist (used internally by pdf-parse v2) requires DOMMatrix for 2-D text
// coordinate transforms. Node.js doesn't ship this browser API; we supply a
// minimal-but-correct implementation covering every operation getText() needs.
// Must run before any dynamic `import('pdf-parse')` call.
if (typeof (globalThis as Record<string, unknown>).DOMMatrix === 'undefined') {
  class _DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    m11 = 1; m12 = 0; m13 = 0; m14 = 0;
    m21 = 0; m22 = 1; m23 = 0; m24 = 0;
    m31 = 0; m32 = 0; m33 = 1; m34 = 0;
    m41 = 0; m42 = 0; m43 = 0; m44 = 1;
    is2D = true; isIdentity = true;

    constructor(init?: number[] | string) {
      if (Array.isArray(init)) {
        if (init.length === 6) {
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
          this.m11 = this.a; this.m12 = this.b;
          this.m21 = this.c; this.m22 = this.d;
          this.m41 = this.e; this.m42 = this.f;
          this.isIdentity = (this.a===1 && this.b===0 && this.c===0 && this.d===1 && this.e===0 && this.f===0);
        } else if (init.length === 16) {
          [this.m11,this.m12,this.m13,this.m14,
           this.m21,this.m22,this.m23,this.m24,
           this.m31,this.m32,this.m33,this.m34,
           this.m41,this.m42,this.m43,this.m44] = init;
          this.a=this.m11; this.b=this.m12; this.c=this.m21; this.d=this.m22;
          this.e=this.m41; this.f=this.m42; this.is2D=false;
        }
      }
    }

    transformPoint(p: {x?: number; y?: number}) {
      const x = p?.x ?? 0, y = p?.y ?? 0;
      return { x: this.a*x + this.c*y + this.e, y: this.b*x + this.d*y + this.f, z: 0, w: 1 };
    }
    multiply(o: _DOMMatrix): _DOMMatrix {
      return new _DOMMatrix([
        this.a*o.a + this.c*o.b, this.b*o.a + this.d*o.b,
        this.a*o.c + this.c*o.d, this.b*o.c + this.d*o.d,
        this.a*o.e + this.c*o.f + this.e, this.b*o.e + this.d*o.f + this.f,
      ]);
    }
    scale(sx = 1, sy = sx): _DOMMatrix { return this.multiply(new _DOMMatrix([sx,0,0,sy,0,0])); }
    translate(tx = 0, ty = 0): _DOMMatrix { return this.multiply(new _DOMMatrix([1,0,0,1,tx,ty])); }
    rotate(angle = 0): _DOMMatrix {
      const r = angle * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
      return this.multiply(new _DOMMatrix([cos, sin, -sin, cos, 0, 0]));
    }
    inverse(): _DOMMatrix {
      const det = this.a*this.d - this.b*this.c;
      if (!det) return new _DOMMatrix();
      const id = 1/det;
      return new _DOMMatrix([this.d*id, -this.b*id, -this.c*id, this.a*id,
        (this.c*this.f - this.d*this.e)*id, (this.b*this.e - this.a*this.f)*id]);
    }
    flipX(): _DOMMatrix { return this.multiply(new _DOMMatrix([-1,0,0,1,0,0])); }
    flipY(): _DOMMatrix { return this.multiply(new _DOMMatrix([1,0,0,-1,0,0])); }
    toFloat32Array(): Float32Array { return new Float32Array([this.m11,this.m12,this.m13,this.m14,this.m21,this.m22,this.m23,this.m24,this.m31,this.m32,this.m33,this.m34,this.m41,this.m42,this.m43,this.m44]); }
    toFloat64Array(): Float64Array { return new Float64Array([this.m11,this.m12,this.m13,this.m14,this.m21,this.m22,this.m23,this.m24,this.m31,this.m32,this.m33,this.m34,this.m41,this.m42,this.m43,this.m44]); }
    toString(): string { return `matrix(${this.a},${this.b},${this.c},${this.d},${this.e},${this.f})`; }
  }
  (globalThis as Record<string, unknown>).DOMMatrix = _DOMMatrix;
}

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import {
  loadSession,
  saveSession,
  clearSession,
  authenticate,
  type StoredSession,
} from './auth.js';
import { ONQ_HOST, KEEP_ALIVE_INTERVAL_MS } from './config.js';
import {
  ONQApiClient, ONQApiError,
  type TocModule, type TocTopic, type RubricCriterion,
  type EntityDropbox, type ContentCompletionData,
} from './api.js';

// ─── Local downloads folder (PDFs are saved here instead of base64'd) ─────────

const ONQ_DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads', 'onq-files');
fs.mkdirSync(ONQ_DOWNLOADS_DIR, { recursive: true });

// Gap 10: Configurable PDF page cap. Set ONQ_PDF_MAX_PAGES env var to override.
const PDF_MAX_PAGES = (() => {
  const v = parseInt(process.env.ONQ_PDF_MAX_PAGES ?? '', 10);
  return isNaN(v) || v < 1 ? 50 : v;
})();

// Average characters per page below this threshold → treat as a slide deck / image-heavy PDF
// and fall back to rendering pages as images instead of returning sparse extracted text.
const PDF_IMAGE_CHARS_PER_PAGE_THRESHOLD = 200;

// Maximum pages to render as images. Images are large — keep this conservative.
// Override with ONQ_PDF_IMAGE_MAX_PAGES env var.
const PDF_IMAGE_MAX_PAGES = (() => {
  const v = parseInt(process.env.ONQ_PDF_IMAGE_MAX_PAGES ?? '', 10);
  return isNaN(v) || v < 1 ? 60 : v;
})();

// ─── Session state (in-process cache) ─────────────────────────────────────────

let apiClient: ONQApiClient | null = null;
let currentSession: StoredSession | null = null;

/**
 * Returns a ready-to-use API client, authenticating if necessary.
 * Called before every tool handler.
 */
async function ensureAuthenticated(): Promise<ONQApiClient> {
  // Re-use in-memory client if we have one
  if (apiClient) {
    try {
      await apiClient.whoAmI(); // quick session check
      return apiClient;
    } catch (err) {
      if (err instanceof ONQApiError && (err.status === 401 || err.status === 403)) {
        console.error('Session expired — will re-authenticate.');
        clearSession();
        apiClient = null;
        currentSession = null;
      } else {
        throw err;
      }
    }
  }

  // Try loading a saved session from disk
  if (!currentSession) {
    const saved = loadSession();
    if (saved) {
      const candidate = new ONQApiClient(saved.cookies);
      try {
        await candidate.whoAmI();
        apiClient = candidate;
        currentSession = saved;
        return apiClient;
      } catch {
        console.error('Saved session is invalid — need fresh login.');
        clearSession();
      }
    }
  }

  // No valid session — open browser for SSO
  const cookies = await authenticate();
  currentSession = { cookies, savedAt: new Date().toISOString() };
  saveSession(currentSession);
  apiClient = new ONQApiClient(cookies);
  return apiClient;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'login_status',
    description:
      'Check if you are currently logged in to ONQ and display your name/NetID. ' +
      'Will open a browser window to log in if not already authenticated.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_courses',
    description:
      "List all courses you are currently enrolled in on ONQ (Queen's University D2L Brightspace). " +
      'Returns course names, IDs, and codes. Use the course ID with other tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_assignments',
    description:
      'List assignments (dropbox folders) for a specific course or all your courses. ' +
      'Shows assignment names, due dates, and point values.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: {
          type: 'number',
          description:
            'Optional. The numeric course ID from list_courses. ' +
            'If omitted, assignments from ALL your courses are returned.',
        },
      },
    },
  },
  {
    name: 'get_assignment_details',
    description:
      'Get the full rubric, instructions, and details for a single assignment. ' +
      'Use list_assignments first to get the assignment (folder) ID, then call this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: {
          type: 'number',
          description: 'The numeric course ID from list_courses.',
        },
        folder_id: {
          type: 'number',
          description: 'The numeric assignment folder ID from list_assignments.',
        },
      },
      required: ['course_id', 'folder_id'],
    },
  },
  {
    name: 'get_grades',
    description:
      'View your current grades for a specific course, including all grade items and their scores.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: {
          type: 'number',
          description: 'The numeric course ID from list_courses.',
        },
      },
      required: ['course_id'],
    },
  },
  {
    name: 'list_announcements',
    description:
      'Get the latest announcements / news posts for a specific course.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: {
          type: 'number',
          description: 'The numeric course ID from list_courses.',
        },
        limit: {
          type: 'number',
          description: 'How many recent announcements to return. Default: 10.',
        },
      },
      required: ['course_id'],
    },
  },
  {
    name: 'get_course_content',
    description:
      'Browse the content structure of a course — modules, files, links, and topics.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: {
          type: 'number',
          description: 'The numeric course ID from list_courses.',
        },
      },
      required: ['course_id'],
    },
  },
  {
    name: 'get_topic_content',
    description:
      'Get the full content of a specific course topic — lecture notes, HTML pages, assignment instructions, or rubrics. ' +
      'Use get_course_content first to find topic IDs, then call this tool to read the actual content.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: {
          type: 'number',
          description: 'The numeric course ID from list_courses.',
        },
        topic_id: {
          type: 'number',
          description: 'The numeric topic ID from get_course_content.',
        },
      },
      required: ['course_id', 'topic_id'],
    },
  },
  {
    name: 'get_upcoming_deadlines',
    description:
      'Get all upcoming assignment deadlines across all your courses, sorted by due date. ' +
      'Great for planning your week.',
    inputSchema: {
      type: 'object',
      properties: {
        days_ahead: {
          type: 'number',
          description: 'How many days ahead to look. Default: 30.',
        },
      },
    },
  },
  {
    name: 'check_api_versions',
    description:
      'Debug tool: shows which D2L REST API versions ONQ supports. ' +
      'Useful if you are getting 404 errors and need to adjust API versions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'logout',
    description:
      'Clear your saved ONQ session from disk. ' +
      'The next tool call will open a browser to log in again.',
    inputSchema: { type: 'object', properties: {} },
  },
  // ─── Gap 11 ─────────────────────────────────────────────────────────────────
  {
    name: 'get_calendar_events',
    description:
      'Get upcoming calendar events for a course — including exam dates, deadlines, ' +
      'and instructor-created events not visible in assignment lists.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: { type: 'number', description: 'The numeric course ID from list_courses.' },
        days_ahead: { type: 'number', description: 'How many days ahead to look. Default: 30.' },
      },
      required: ['course_id'],
    },
  },
  // ─── Gap 6 ──────────────────────────────────────────────────────────────────
  {
    name: 'get_quiz_attempts',
    description:
      'List all quizzes for a course and show your attempt history, scores, and completion status. ' +
      'Optionally narrow to a single quiz by quiz_id.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: { type: 'number', description: 'The numeric course ID from list_courses.' },
        quiz_id: {
          type: 'number',
          description: 'Optional. A specific quiz ID to focus on. If omitted, all quizzes are shown.',
        },
      },
      required: ['course_id'],
    },
  },
  // ─── Gap 8 ──────────────────────────────────────────────────────────────────
  {
    name: 'get_discussion_posts',
    description:
      'Browse discussion forums and read posts in a course. ' +
      'Call with just course_id to list all forums and topics. ' +
      'Add forum_id and topic_id to read the actual posts in a thread.',
    inputSchema: {
      type: 'object',
      properties: {
        course_id: { type: 'number', description: 'The numeric course ID from list_courses.' },
        forum_id: {
          type: 'number',
          description: 'Optional. The forum ID shown by a previous call. Required to see topics or posts.',
        },
        topic_id: {
          type: 'number',
          description: 'Optional. The topic (thread) ID. Provide along with forum_id to read posts.',
        },
      },
      required: ['course_id'],
    },
  },
];

// ─── Tool handlers ─────────────────────────────────────────────────────────────

async function handleLoginStatus(): Promise<string> {
  const client = await ensureAuthenticated();
  const user = await client.whoAmI();
  return (
    `✅ Logged in to ONQ\n\n` +
    `Name:    ${user.FirstName} ${user.LastName}\n` +
    `NetID:   ${user.UniqueName}\n` +
    `User ID: ${user.Identifier}`
  );
}

async function handleListCourses(): Promise<string> {
  const client = await ensureAuthenticated();
  const data = await client.getEnrollments();

  if (!data.Items?.length) {
    return 'No courses found in your ONQ account.';
  }

  const lines = data.Items.map((item) => {
    const ou = item.OrgUnit;
    const dates: string[] = [];
    if (ou.StartDate) dates.push(`Start: ${fmtDate(ou.StartDate)}`);
    if (ou.EndDate)   dates.push(`End: ${fmtDate(ou.EndDate)}`);
    return (
      `📚 ${ou.Name}\n` +
      `   ID: ${ou.Id}  |  Code: ${ou.Code || '—'}` +
      (dates.length ? `  |  ${dates.join('  ')}` : '') +
      `  |  Role: ${item.Access.ClasslistRoleName}`
    );
  });

  return `Your ONQ Courses (${data.Items.length} total)\n\n${lines.join('\n\n')}`;
}

async function handleListAssignments(courseId?: number): Promise<string> {
  const client = await ensureAuthenticated();

  let targets: Array<{ id: number; name: string }>;

  if (courseId !== undefined) {
    targets = [{ id: courseId, name: `Course ${courseId}` }];
  } else {
    const data = await client.getEnrollments();
    targets = data.Items.map((i) => ({
      id: i.OrgUnit.Id,
      name: i.OrgUnit.Name,
    }));
  }

  const sections: string[] = [];

  for (const target of targets) {
    try {
      const folders = await client.getAssignments(target.id);
      const visible = folders.filter((f) => !f.IsHidden && !f.IsDeleted);
      if (!visible.length) continue;

      const rows = visible.map((f) => {
        const due = f.DueDate ? `Due: ${fmtDateTime(f.DueDate)}` : 'No due date';
        const pts = f.Score?.MaxScore != null ? `  |  ${f.Score.MaxScore} pts` : '';
        const hasInstructions = f.Instructions?.Text?.trim() ? '  |  has instructions' : '';
        return `  📝 [ID:${f.Id}] ${f.Name}\n     ${due}${pts}${hasInstructions}`;
      });
      sections.push(`**${target.name}**\n${rows.join('\n')}`);
    } catch {
      // Silently skip courses where we can't get assignments
    }
  }

  if (!sections.length) return 'No visible assignments found.';
  return `Assignments\n\n${sections.join('\n\n')}\n\n(Use get_assignment_details with a folder [ID:N] to read the full rubric and instructions.)`;
}

async function handleGetAssignmentDetails(courseId: number, folderId: number): Promise<string> {
  const client = await ensureAuthenticated();
  const f = await client.getAssignmentDetails(courseId, folderId);

  const lines: string[] = [`📝 **${f.Name}** (Folder ID: ${f.Id})`];

  if (f.DueDate)                  lines.push(`Due: ${fmtDateTime(f.DueDate)}`);
  if (f.Availability?.StartDate)  lines.push(`Available from: ${fmtDateTime(f.Availability.StartDate)}`);
  if (f.Availability?.EndDate)    lines.push(`Closes: ${fmtDateTime(f.Availability.EndDate)}`);
  if (f.Score?.MaxScore != null)  lines.push(`Points: ${f.Score.MaxScore}`);

  // D2L uses different field names across versions — try all of them
  const richText =
    f.CustomInstructions ??
    f.Instructions ??
    f.Description ??
    null;
  const body = richText?.Html
    ? stripHtml(richText.Html)
    : (richText?.Text ?? '').trim();

  if (body) {
    lines.push('', '--- Instructions ---', '', body);
  } else {
    lines.push('', '(No inline instructions found.)');
  }

  // Download any files attached directly to the folder (e.g. a PDF of the assignment questions)
  const attachments = f.Attachments ?? [];
  if (attachments.length) {
    lines.push('', `--- Attached File${attachments.length > 1 ? 's' : ''} ---`);
    for (const att of attachments) {
      lines.push('', `📎 ${att.FileName} (${(att.Size / 1024).toFixed(0)} KB)`);
      try {
        const { contentType, buffer } = await client.downloadDropboxAttachment(
          courseId, folderId, att,
        );
        const ct = contentType.toLowerCase();
        if (ct.includes('application/pdf')) {
          // Save to disk and extract text (same pattern as get_topic_content)
          const safeName = att.FileName.replace(/[^\w\s.-]/g, '').trim().replace(/\s+/g, '_');
          const filepath = path.join(ONQ_DOWNLOADS_DIR, safeName);
          fs.writeFileSync(filepath, buffer);
          lines.push(`   Saved to: ${filepath}`);
          try {
            const { PDFParse, VerbosityLevel } = await import('pdf-parse');
            const parser = new PDFParse({ data: new Uint8Array(buffer), verbosity: VerbosityLevel.ERRORS });
            let result: Awaited<ReturnType<typeof parser.getText>>;
            try { result = await parser.getText(); }
            finally { await parser.destroy().catch(() => {}); }
            const text = result.text.trim();
            if (text) {
              const pageCount = result.total as number;
              lines.push('', `   --- Extracted Text (${pageCount} page${pageCount === 1 ? '' : 's'}) ---`, '');
              const cap = PDF_MAX_PAGES * 3000;
              if (text.length > cap) {
                lines.push(text.slice(0, cap));
                lines.push(`\n[…truncated at ${PDF_MAX_PAGES} pages — full file saved to: ${filepath}]`);
              } else {
                lines.push(text);
              }
            } else {
              lines.push('   (PDF has no selectable text — open the saved file to view it.)');
            }
          } catch (pdfErr) {
            const msg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
            lines.push(`   (Could not extract PDF text: ${msg.slice(0, 120)})`);
          }
        } else if (
          ct.includes('application/vnd.openxmlformats-officedocument.wordprocessingml') ||
          ct.includes('application/docx') ||
          att.FileName.toLowerCase().endsWith('.docx')
        ) {
          // Gap 5: Extract text from DOCX files using mammoth
          const safeName = att.FileName.replace(/[^\w\s.-]/g, '').trim().replace(/\s+/g, '_');
          const filepath = path.join(ONQ_DOWNLOADS_DIR, safeName);
          fs.writeFileSync(filepath, buffer);
          lines.push(`   Saved to: ${filepath}`);
          try {
            const { default: mammoth } = await import('mammoth') as unknown as {
              default: { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> }
            };
            const result = await mammoth.extractRawText({ buffer });
            const text = result.value.trim();
            if (text) {
              lines.push('', '   --- Extracted Text (DOCX) ---', '', text);
            } else {
              lines.push('   (DOCX has no extractable text — open the saved file to view it.)');
            }
          } catch (docxErr) {
            const msg = docxErr instanceof Error ? docxErr.message : String(docxErr);
            lines.push(`   (Could not extract DOCX text: ${msg.slice(0, 120)})`);
          }
        } else if (ct.includes('text/html')) {
          lines.push('', stripHtml(buffer.toString('utf-8')));
        } else if (ct.includes('text/')) {
          lines.push('', buffer.toString('utf-8'));
        } else {
          lines.push(`   (Binary file [${contentType}] — open in ONQ to view)`);
        }
      } catch (dlErr) {
        const msg = dlErr instanceof Error ? dlErr.message : String(dlErr);
        lines.push(`   (Could not download: ${msg.slice(0, 120)})`);
      }
    }
  }

  // Fetch rubrics — try silently and append if available
  try {
    const rubricAssocs = await client.getDropboxRubrics(courseId, folderId);
    const visible = rubricAssocs.filter((r) => !r.IsHidden);
    if (visible.length) {
      lines.push('', '--- Rubric(s) ---');
      for (const assoc of visible) {
        try {
          const rubric = await client.getRubricDetail(courseId, assoc.RubricId);
          lines.push('', `**${rubric.Name}**`);
          if (rubric.Description?.Text) lines.push(rubric.Description.Text.trim());
          if (rubric.Criteria?.length) {
            for (const crit of rubric.Criteria as RubricCriterion[]) {
              const pts = crit.OutOf != null ? ` (/${crit.OutOf} pts)` : '';
              lines.push(`\n  📌 ${crit.Name}${pts}`);
              if (crit.Description?.Text) lines.push(`     ${crit.Description.Text.trim()}`);
              for (const lvl of crit.Levels ?? []) {
                const lvlPts = lvl.Points != null ? ` [${lvl.Points} pts]` : '';
                const lvlDesc = lvl.Description?.Text?.trim();
                lines.push(`     • ${lvl.Name}${lvlPts}${lvlDesc ? ': ' + lvlDesc : ''}`);
              }
            }
          } else if (rubric.Levels?.length) {
            lines.push('  Levels: ' + rubric.Levels.map((l) =>
              `${l.Name}${l.Points != null ? ` (${l.Points} pts)` : ''}`
            ).join(' | '));
          }
        } catch {
          // Couldn't fetch full detail — just show the name
          lines.push(`\n  📌 ${assoc.Name} (rubric detail unavailable)`);
        }
      }
    }
  } catch {
    // Rubric endpoint not available — skip silently
  }

  // Gap 4: Submission status — show whether you've submitted and any released grade/feedback
  try {
    const submissions: EntityDropbox[] = await client.getMySubmissions(courseId, folderId);
    if (submissions.length > 0) {
      lines.push('', '--- Submission Status ---');
      for (const sub of submissions) {
        const statusIcon =
          sub.Status === 'Submitted' || sub.Status === 'Published' ? '✅' :
          sub.Status === 'Draft' ? '📝' : '⬜';
        lines.push(`${statusIcon} Status: ${sub.Status}`);
        if (sub.CompletionDate) lines.push(`   Submitted: ${fmtDateTime(sub.CompletionDate)}`);

        // Released grade/feedback
        if (sub.Feedback) {
          const score = sub.Feedback.Score != null
            ? `${sub.Feedback.Score}${sub.Feedback.OutOf != null ? ' / ' + sub.Feedback.OutOf : ''}`
            : null;
          if (score) lines.push(`   Score: ${score}`);
          const fbText = sub.Feedback.Feedback?.Text?.trim();
          if (fbText) lines.push(`   Feedback: ${fbText}`);
        }

        // List submitted files
        if (sub.Submissions?.length) {
          for (const s of sub.Submissions) {
            const fileNames = s.Files?.map((f) => f.FileName).join(', ') ?? '';
            lines.push(`   Files: ${fileNames || '(no files)'} — submitted ${fmtDateTime(s.SubmittedDate)}`);
          }
        }
      }
    } else {
      lines.push('', '--- Submission Status ---', '⬜ Not submitted yet.');
    }
  } catch {
    // Submission status not available for this assignment — skip silently
  }

  return lines.join('\n');
}

async function handleGetGrades(courseId: number): Promise<string> {
  const client = await ensureAuthenticated();
  // Try current LE_VERSION first, then fall back to older versions if we get an error or empty
  let grades = (await client.getGrades(courseId)) ?? [];
  if (!grades.length) {
    // Some course types or ONQ versions return grades under an older endpoint
    for (const fallbackVersion of ['1.71', '1.68', '1.51']) {
      try {
        const result = await client.getGradesWithVersion(courseId, fallbackVersion);
        if ((result ?? []).length) {
          grades = result;
          break;
        }
      } catch {
        // try next
      }
    }
  }

  const visible = grades.filter((g) => g.DisplayedGrade?.trim());
  if (!visible.length) {
    return (
      `No released grades found for course ${courseId}.\n\n` +
      `(Grades may not have been released yet, or this course may not use the D2L gradebook.)`
    );
  }

  const rows = visible.map((g) => {
    const pts =
      g.PointsNumerator != null && g.PointsDenominator != null
        ? ` (${g.PointsNumerator} / ${g.PointsDenominator})`
        : '';
    return `📊 ${g.GradeObjectName}: **${g.DisplayedGrade}**${pts}`;
  });

  return `Grades — Course ${courseId}\n\n${rows.join('\n')}`;
}

async function handleListAnnouncements(courseId: number, limit = 10): Promise<string> {
  const client = await ensureAuthenticated();
  const items = await client.getAnnouncements(courseId);

  const visible = items
    .filter((n) => !n.IsHidden && n.IsPublished)
    .sort((a, b) => Date.parse(b.StartDate) - Date.parse(a.StartDate))
    .slice(0, limit);

  if (!visible.length) return `No published announcements found for course ${courseId}.`;

  // Fetch full body + attachments for each item (the list endpoint truncates)
  const cards = await Promise.all(visible.map(async (n) => {
    const date = fmtDate(n.StartDate);
    let body = stripHtml(n.Body?.Html ?? n.Body?.Text ?? '');
    let attachments = n.Attachments ?? [];

    // If body looks truncated (< 500 chars or ends mid-sentence), fetch the full item
    if (body.length < 500 || body.endsWith('…') || body.endsWith('...')) {
      try {
        const full = await client.getAnnouncementDetail(courseId, n.Id);
        const fullBody = stripHtml(full.Body?.Html ?? full.Body?.Text ?? '');
        if (fullBody.length > body.length) body = fullBody;
        // Gap 12: also capture attachments from the detail response
        if (full.Attachments?.length) attachments = full.Attachments;
      } catch {
        // Leave as-is if detail fetch fails
      }
    }

    // Gap 12: Process attachments — extract text from PDFs, note others
    const attLines: string[] = [];
    for (const att of attachments) {
      attLines.push(`\n📎 Attachment: ${att.FileName} (${(att.Size / 1024).toFixed(0)} KB)`);
      try {
        const { contentType, buffer } = await client.downloadNewsAttachment(courseId, n.Id, att.FileId);
        const ct = contentType.toLowerCase();
        if (ct.includes('application/pdf')) {
          const safeName = att.FileName.replace(/[^\w\s.-]/g, '').trim().replace(/\s+/g, '_');
          const filepath = path.join(ONQ_DOWNLOADS_DIR, safeName);
          fs.writeFileSync(filepath, buffer);
          attLines.push(`   Saved to: ${filepath}`);
          try {
            const { PDFParse, VerbosityLevel } = await import('pdf-parse');
            const parser = new PDFParse({ data: new Uint8Array(buffer), verbosity: VerbosityLevel.ERRORS });
            let result: Awaited<ReturnType<typeof parser.getText>>;
            try { result = await parser.getText(); }
            finally { await parser.destroy().catch(() => {}); }
            const text = result.text.trim();
            if (text) {
              const cap = PDF_MAX_PAGES * 3000;
              attLines.push(text.length > cap ? text.slice(0, cap) + '\n[…truncated]' : text);
            }
          } catch { /* pdf extraction failed */ }
        } else if (ct.includes('text/')) {
          attLines.push(buffer.toString('utf-8').slice(0, 5000));
        } else {
          attLines.push(`   (${contentType} — open in ONQ to view)`);
        }
      } catch (dlErr) {
        const msg = dlErr instanceof Error ? dlErr.message : String(dlErr);
        attLines.push(`   (Could not download: ${msg.slice(0, 80)})`);
      }
    }

    return `📢 **${n.Title}** — ${date}\n${body}${attLines.join('\n')}`;
  }));

  return `Announcements — Course ${courseId}\n\n${cards.join('\n\n---\n\n')}`;
}

async function handleGetCourseContent(courseId: number): Promise<string> {
  const client = await ensureAuthenticated();

  // Gap 9: Fetch completion data upfront; build TopicId → IsComplete map
  let completionMap = new Map<number, boolean>();
  try {
    const completions = await client.getContentCompletions(courseId);
    for (const c of completions.Objects ?? []) {
      completionMap.set(c.TopicId, c.IsComplete);
    }
  } catch {
    // Completion data unavailable — proceed without it
  }

  function renderTocTopic(topic: TocTopic, depth: number): string {
    if (topic.IsHidden) return '';
    const pad = '  '.repeat(depth);
    const icon =
      topic.TypeIdentifier === 'File' ? '📄' :
      topic.TypeIdentifier === 'Link' ? '🔗' : '📌';
    const due = topic.DueDate ? `  (Due: ${fmtDate(topic.DueDate)})` : '';
    // Gap 9: completion checkmark if we have data; '○' if not yet complete
    const done = completionMap.has(topic.TopicId)
      ? (completionMap.get(topic.TopicId) ? ' ✓' : ' ○')
      : '';
    return `${pad}${icon} [ID:${topic.TopicId}] ${topic.Title}${due}${done}`;
  }

  function renderTocModule(mod: TocModule, depth: number): string {
    const pad = '  '.repeat(depth);
    const lines: string[] = [`${pad}📁 **${mod.Title}**`];
    for (const sub of mod.Modules ?? []) {
      if (!sub.IsHidden) lines.push(renderTocModule(sub, depth + 1));
    }
    for (const topic of mod.Topics ?? []) {
      const rendered = renderTocTopic(topic, depth + 1);
      if (rendered) lines.push(rendered);
    }
    return lines.join('\n');
  }

  // Try the TOC endpoint first — it returns the full tree in one call
  try {
    const toc = await client.getContentToc(courseId);
    const modules = toc.Modules ?? [];

    if (!modules.length) {
      return `Course Content — Course ${courseId}\n\nNo content modules found.`;
    }

    const sections = modules
      .filter((m) => !m.IsHidden)
      .map((m) => renderTocModule(m, 0));

    return (
      `Course Content — Course ${courseId}\n\n` +
      `(Topic IDs are shown as [ID:N] — use get_topic_content with a topic ID to read full content)\n\n` +
      sections.join('\n\n')
    );
  } catch (tocErr) {
    // TOC endpoint not available — fall back to recursive root fetch
    console.error('TOC endpoint failed, falling back to /root/:', tocErr);
  }

  // Fallback: use /root/ and recursively fetch sub-modules
  const root = await client.getCourseContent(courseId);

  async function fetchAndRenderModule(
    mod: Awaited<ReturnType<typeof client.getCourseContent>>,
    depth: number
  ): Promise<string> {
    const pad = '  '.repeat(depth);
    const lines: string[] = [`${pad}📁 **${mod.Title}**`];

    // Fetch sub-module structures recursively
    for (const sub of mod.Modules ?? []) {
      try {
        const full = await client.getModuleStructure(courseId, sub.ModuleId ?? (sub as unknown as { Id: number }).Id);
        lines.push(await fetchAndRenderModule(full, depth + 1));
      } catch {
        lines.push(`${'  '.repeat(depth + 1)}📁 ${sub.Title}`);
      }
    }

    // Topics
    for (const topic of mod.Structure ?? []) {
      if (topic.IsHidden) continue;
      const icon =
        topic.TypeIdentifier === 'File' ? '📄' :
        topic.TypeIdentifier === 'Link' ? '🔗' : '📌';
      const due = topic.DueDate ? `  (Due: ${fmtDate(topic.DueDate)})` : '';
      // Gap 9: completion indicator
      const done = completionMap.has(topic.Id)
        ? (completionMap.get(topic.Id) ? ' ✓' : ' ○')
        : '';
      lines.push(`${'  '.repeat(depth + 1)}${icon} [ID:${topic.Id}] ${topic.Title}${due}${done}`);
    }

    return lines.join('\n');
  }

  const rendered = await fetchAndRenderModule(root, 0);
  return (
    `Course Content — Course ${courseId}\n\n` +
    `(Topic IDs are shown as [ID:N] — use get_topic_content with a topic ID to read full content)\n\n` +
    rendered
  );
}

// MCP content item — text, image, or binary resource blob
type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };

async function handleGetTopicContent(
  courseId: number,
  topicId: number
): Promise<McpContent[]> {
  const client = await ensureAuthenticated();
  const topic = await client.getTopicContent(courseId, topicId);

  // Metadata text block
  const metaLines: string[] = [
    `📌 **${topic.Title}** (Topic ID: ${topic.TopicId})`,
    `Type: ${topic.TypeIdentifier}`,
  ];
  if (topic.DueDate)   metaLines.push(`Due: ${fmtDateTime(topic.DueDate)}`);
  if (topic.StartDate) metaLines.push(`Available from: ${fmtDateTime(topic.StartDate)}`);

  // Gap 1 & 2: Detect link-type topics by TypeIdentifier string OR by numeric Type=3.
  // Always return the URL so Claude can hand it off to WebFetch — never try to
  // download a file for a link topic.
  const LINK_TYPES = new Set([
    'Link', 'Url', 'ExternalLink', 'LtiLink', 'LtiResourceLink',
    'Scorm', 'Survey', 'Discussion', 'Quiz', 'Assignment',
    'Collaborate', 'CourseSchedule', 'ContentObject',
  ]);
  const isLinkTopic =
    topic.Type === 3 ||
    LINK_TYPES.has(topic.TypeIdentifier) ||
    topic.TypeIdentifier?.toLowerCase().includes('link');

  if (isLinkTopic) {
    let href = topic.Url ?? null;
    // Resolve ONQ-relative paths to absolute URLs
    if (href && href.startsWith('/')) href = `${ONQ_HOST}${href}`;
    const hrefText = href ?? '(no URL stored for this topic)';
    const isExternal = href && !href.includes('onq.queensu.ca') && !href.startsWith(ONQ_HOST);
    const fetchHint = isExternal && href
      ? `\n\n💡 Pass this URL to WebFetch to read the content.`
      : '';
    return [{
      type: 'text',
      text: metaLines.join('\n') + `\n\nURL: ${hrefText}${fetchHint}`,
    }];
  }

  try {
    const { contentType, buffer } = await client.fetchTopicFile(courseId, topicId);
    const ct = contentType.toLowerCase();

    if (ct.includes('application/pdf')) {
      // Save the PDF to disk so the user always has the actual file
      const safeTitle = topic.Title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || `topic_${topicId}`;
      const filename = `${safeTitle}.pdf`;
      const filepath = path.join(ONQ_DOWNLOADS_DIR, filename);
      fs.writeFileSync(filepath, buffer);
      metaLines.push(`Size: ${(buffer.length / 1024).toFixed(0)} KB`);
      metaLines.push(`Saved to: ${filepath}`);

      // Also extract text so Cowork can read it directly without needing a
      // mounted filesystem. (The Mac path above is inaccessible inside the VM
      // unless the user's home folder has been explicitly mounted.)
      try {
        const { PDFParse, VerbosityLevel } = await import('pdf-parse');
        const parser = new PDFParse({
          data: new Uint8Array(buffer), // explicit TypedArray avoids any Buffer quirks
          verbosity: VerbosityLevel.ERRORS, // suppress pdfjs info/warning logs
        });
        let result: Awaited<ReturnType<typeof parser.getText>>;
        try {
          result = await parser.getText();
        } finally {
          // Always destroy to release the worker thread — without this large PDFs hang
          await parser.destroy().catch(() => {});
        }
        const text = result.text.trim();
        const pageCount = result.total as number;

        // Detect slide decks and image-heavy PDFs by text density.
        // Lecture slides typically have < 200 chars/page on average.
        const avgCharsPerPage = pageCount > 0 ? text.length / pageCount : 0;
        const isSparse = avgCharsPerPage < PDF_IMAGE_CHARS_PER_PAGE_THRESHOLD;

        if (text && !isSparse) {
          // Dense text document — return extracted text (normal behaviour)
          const truncated = pageCount > PDF_MAX_PAGES;
          metaLines.push('');
          metaLines.push(
            `--- Extracted Text (${pageCount} page${pageCount === 1 ? '' : 's'}` +
            `${truncated ? `, showing first ${PDF_MAX_PAGES}` : ''}) ---`
          );
          metaLines.push('');
          // Gap 10: Cap at PDF_MAX_PAGES (configurable via ONQ_PDF_MAX_PAGES env var)
          const cap = PDF_MAX_PAGES * 3000; // ~3 KB per page budget
          if (text.length > cap) {
            metaLines.push(text.slice(0, cap));
            metaLines.push(
              `\n[…truncated at ${PDF_MAX_PAGES} pages — full file saved to: ${filepath}` +
              ` — set ONQ_PDF_MAX_PAGES env var to increase limit]`
            );
          } else {
            metaLines.push(text);
          }
          // falls through to: return [{ type: 'text', text: metaLines.join('\n') }]

        } else {
          // Sparse or no text — looks like slides or a scanned PDF.
          // Render each page as an image so Claude can see the visual content.
          const reason = text
            ? `sparse (~${Math.round(avgCharsPerPage)} chars/page avg)`
            : 'no selectable text';
          metaLines.push(`\n(PDF text is ${reason} — rendering pages as images for visual content like slides.)`);
          if (text) {
            metaLines.push('');
            metaLines.push('--- Extracted Text (sparse) ---');
            metaLines.push(text);
          }

          const contentBlocks: McpContent[] = [{ type: 'text', text: metaLines.join('\n') }];

          try {
            const { getDocumentProxy, renderPageAsImage } = await import('unpdf');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pdfDoc = await getDocumentProxy(new Uint8Array(buffer)) as any;
            const totalPages: number = pdfDoc.numPages ?? pageCount;
            const pagesToRender = Math.min(totalPages, PDF_IMAGE_MAX_PAGES);

            if (pagesToRender < totalPages) {
              contentBlocks.push({
                type: 'text',
                text: `(Showing first ${pagesToRender} of ${totalPages} pages — set ONQ_PDF_IMAGE_MAX_PAGES env var to increase limit.)`,
              });
            }

            for (let i = 0; i < pagesToRender; i++) {
              const imgArrayBuffer = await renderPageAsImage(pdfDoc, i, {
                canvasImport: () => import('@napi-rs/canvas'),
                scale: 1.5,
              });
              contentBlocks.push({
                type: 'image',
                data: Buffer.from(imgArrayBuffer as ArrayBuffer).toString('base64'),
                mimeType: 'image/png',
              });
            }
          } catch (imgErr) {
            const msg = imgErr instanceof Error ? imgErr.message : String(imgErr);
            contentBlocks.push({
              type: 'text',
              text: `(Image rendering failed: ${msg.slice(0, 200)} — open the saved file: ${filepath})`,
            });
          }

          return contentBlocks;
        }
      } catch (pdfErr) {
        // pdf-parse failed — path is still returned above so the user can open it manually
        const msg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
        metaLines.push(`\n(Could not extract PDF text: ${msg.slice(0, 120)} — open the saved file to view it.)`);
      }
      return [{ type: 'text', text: metaLines.join('\n') }];

    } else if (ct.includes('text/html')) {
      const text = stripHtml(buffer.toString('utf-8'));
      metaLines.push(`Size: ${(buffer.length / 1024).toFixed(0)} KB`);
      return [{
        type: 'text',
        text: metaLines.join('\n') + '\n\n--- Content ---\n\n' + text,
      }];

    } else if (ct.includes('text/plain')) {
      return [{
        type: 'text',
        text: metaLines.join('\n') + '\n\n--- Content ---\n\n' + buffer.toString('utf-8'),
      }];

    } else if (ct.startsWith('video/') || ct.includes('mp4') || ct.includes('webm')) {
      metaLines.push(`\n(Video [${contentType}] — ${(buffer.length / 1024 / 1024).toFixed(1)} MB. Open ONQ in a browser to watch it.)`);
      if (topic.Url) metaLines.push(`URL: ${topic.Url}`);
      return [{ type: 'text', text: metaLines.join('\n') }];

    } else {
      // Unknown binary — save it too if it's reasonably sized
      if (buffer.length < 50 * 1024 * 1024) {
        const ext = contentType.split('/')[1]?.split(';')[0] ?? 'bin';
        const safeTitle = topic.Title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || `topic_${topicId}`;
        const filepath = path.join(ONQ_DOWNLOADS_DIR, `${safeTitle}.${ext}`);
        fs.writeFileSync(filepath, buffer);
        metaLines.push(`Saved to: ${filepath}`);
      } else {
        metaLines.push(`\n(File [${contentType}] — ${(buffer.length / 1024 / 1024).toFixed(1)} MB, too large to save automatically.)`);
        if (topic.Url) metaLines.push(`URL: ${topic.Url}`);
      }
      return [{ type: 'text', text: metaLines.join('\n') }];
    }

  } catch (fetchErr) {
    // /file fetch failed — try inline Body first, then URL, then error
    if (topic.Body?.Html) {
      return [{ type: 'text', text: metaLines.join('\n') + '\n\n--- Content ---\n\n' + stripHtml(topic.Body.Html) }];
    }
    if (topic.Body?.Text) {
      return [{ type: 'text', text: metaLines.join('\n') + '\n\n--- Content ---\n\n' + topic.Body.Text }];
    }
    // If there's a URL, this topic is likely a link/redirect — surface the URL
    if (topic.Url) {
      return [{ type: 'text', text: metaLines.join('\n') + `\n\nLink: ${topic.Url}\n(File download not available — open the link directly in ONQ.)` }];
    }
    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    metaLines.push(`\n(Could not fetch content: ${errMsg})`);
    return [{ type: 'text', text: metaLines.join('\n') }];
  }
}

// ─── Gap 11: Calendar events ──────────────────────────────────────────────────

async function handleGetCalendarEvents(courseId: number, daysAhead: number): Promise<string> {
  const client = await ensureAuthenticated();
  const events = await client.getCalendarEvents(courseId);

  const now = Date.now();
  const cutoff = now + daysAhead * 86_400_000;

  const upcoming = events
    .filter((e) => {
      const start = Date.parse(e.StartDateTime);
      return !isNaN(start) && start >= now && start <= cutoff;
    })
    .sort((a, b) => Date.parse(a.StartDateTime) - Date.parse(b.StartDateTime));

  if (!upcoming.length) {
    return `No calendar events in the next ${daysAhead} days for course ${courseId}.`;
  }

  const rows = upcoming.map((e) => {
    const start = fmtDateTime(e.StartDateTime);
    const end = e.EndDateTime ? ` → ${fmtDateTime(e.EndDateTime)}` : '';
    const allDay = e.IsAllDayEvent ? ' (all day)' : '';
    const location = e.Location ? `\n   📍 ${e.Location}` : '';
    const desc = e.Description?.Text?.trim()
      ? `\n   ${e.Description.Text.trim().slice(0, 200)}`
      : '';
    return `📅 **${e.Title}**\n   ${start}${end}${allDay}${location}${desc}`;
  });

  return (
    `Calendar Events — Course ${courseId} (next ${daysAhead} days)\n\n` +
    rows.join('\n\n')
  );
}

// ─── Gap 6: Quiz attempts ─────────────────────────────────────────────────────

async function handleGetQuizAttempts(courseId: number, quizId?: number): Promise<string> {
  const client = await ensureAuthenticated();

  // Fetch all quizzes for the course first so we can show names
  let quizzes = await client.getQuizzes(courseId);
  const active = quizzes.filter((q) => q.IsActive !== false);

  if (!active.length) {
    return `No quizzes found for course ${courseId}.`;
  }

  // If a specific quiz was requested, narrow down
  const targets = quizId !== undefined
    ? active.filter((q) => q.QuizId === quizId)
    : active;

  if (!targets.length) {
    return `Quiz ${quizId} not found in course ${courseId}.`;
  }

  const sections: string[] = [];

  for (const quiz of targets) {
    const lines: string[] = [`🧪 **${quiz.Name}** (Quiz ID: ${quiz.QuizId})`];
    if (quiz.DueDate) lines.push(`   Due: ${fmtDateTime(quiz.DueDate)}`);
    if (quiz.Attempts) {
      const maxStr = quiz.Attempts.IsUnlimited
        ? 'unlimited'
        : String(quiz.Attempts.NumberOfAttemptsAllowed ?? '?');
      lines.push(`   Attempts allowed: ${maxStr}`);
    }

    try {
      const attempts = await client.getMyQuizAttempts(courseId, quiz.QuizId);
      if (!attempts.length) {
        lines.push('   No attempts yet.');
      } else {
        for (const att of attempts) {
          const score = att.Score?.ScoreGiven != null
            ? `${att.Score.ScoreGiven}${att.Score.ScoreDenominator != null ? ' / ' + att.Score.ScoreDenominator : ''}`
            : 'not graded';
          lines.push(
            `   Attempt ${att.AttemptNumber}: ${att.CompletionStatusTypeName}` +
            `  |  Score: ${score}` +
            `  |  Started: ${fmtDateTime(att.TimeStarted)}`
          );
        }
      }
    } catch {
      lines.push('   (Attempt data unavailable.)');
    }

    sections.push(lines.join('\n'));
  }

  return `Quiz Attempts — Course ${courseId}\n\n${sections.join('\n\n')}`;
}

// ─── Gap 8: Discussion posts ──────────────────────────────────────────────────

async function handleGetDiscussionPosts(
  courseId: number,
  forumId?: number,
  topicId?: number
): Promise<string> {
  const client = await ensureAuthenticated();

  // List forums
  const forums = await client.getDiscussionForums(courseId);
  const visibleForums = forums.filter((f) => !f.IsHidden);

  if (!visibleForums.length) {
    return `No discussion forums found for course ${courseId}.`;
  }

  // If only listing (no forumId given), show the forum/topic structure
  if (forumId === undefined) {
    const lines = [`Discussion Forums — Course ${courseId}\n`];
    for (const forum of visibleForums) {
      lines.push(`📋 **${forum.Name}** (Forum ID: ${forum.ForumId})`);
      try {
        const topics = await client.getDiscussionTopics(
          courseId,
          (forum as unknown as { ForumId: number }).ForumId ?? (forum as unknown as { Id: number }).Id
        );
        for (const t of topics.filter((tt) => !tt.IsHidden)) {
          const due = t.DueDate ? `  Due: ${fmtDate(t.DueDate)}` : '';
          lines.push(`   💬 [Topic ID:${t.TopicId}] ${t.Name}${due}`);
        }
      } catch {
        lines.push('   (Could not list topics.)');
      }
    }
    lines.push('\nUse get_discussion_posts with forum_id and topic_id to read posts.');
    return lines.join('\n');
  }

  // Fetch posts for a specific forum/topic
  if (topicId === undefined) {
    // List topics in the forum
    const topics = await client.getDiscussionTopics(courseId, forumId);
    const visible = topics.filter((t) => !t.IsHidden);
    if (!visible.length) return `No topics found in forum ${forumId}.`;
    const lines = [`Topics in Forum ${forumId} — Course ${courseId}\n`];
    for (const t of visible) {
      const due = t.DueDate ? `  Due: ${fmtDate(t.DueDate)}` : '';
      lines.push(`💬 [Topic ID:${t.TopicId}] ${t.Name}${due}`);
    }
    lines.push('\nUse get_discussion_posts with topic_id to read the posts.');
    return lines.join('\n');
  }

  // Fetch and render posts
  const posts = await client.getDiscussionPosts(courseId, forumId, topicId);
  if (!posts.length) {
    return `No posts found in forum ${forumId}, topic ${topicId} of course ${courseId}.`;
  }

  // Build thread structure: top-level posts with replies indented
  const topLevel = posts.filter((p) => p.ParentPostId == null);
  const byParent = new Map<number, typeof posts>();
  for (const p of posts) {
    if (p.ParentPostId != null) {
      if (!byParent.has(p.ParentPostId)) byParent.set(p.ParentPostId, []);
      byParent.get(p.ParentPostId)!.push(p);
    }
  }

  function renderPost(p: typeof posts[0], indent: number): string {
    const pad = '  '.repeat(indent);
    const body = stripHtml(p.Message?.Html ?? p.Message?.Text ?? '(no content)');
    const lines = [
      `${pad}💬 **${p.Poster?.DisplayName ?? 'Unknown'}** — ${fmtDateTime(p.DatePosted)}`,
      `${pad}${p.Subject ? p.Subject + '\n' + pad : ''}${body.slice(0, 1000)}`,
    ];
    for (const reply of byParent.get(p.PostId) ?? []) {
      lines.push(renderPost(reply, indent + 1));
    }
    return lines.join('\n');
  }

  const rendered = topLevel.map((p) => renderPost(p, 0)).join('\n\n---\n\n');
  return (
    `Discussion Posts — Course ${courseId}, Forum ${forumId}, Topic ${topicId}\n` +
    `(${posts.length} posts total)\n\n${rendered}`
  );
}

async function handleGetUpcomingDeadlines(daysAhead: number): Promise<string> {
  const client = await ensureAuthenticated();
  const data = await client.getEnrollments();

  const now = Date.now();
  const cutoff = now + daysAhead * 86_400_000;

  interface Deadline {
    courseName: string;
    name: string;
    dueDate: Date;
  }
  const deadlines: Deadline[] = [];

  for (const item of data.Items) {
    try {
      const folders = await client.getAssignments(item.OrgUnit.Id);
      for (const f of folders.filter((f) => !f.IsHidden && !f.IsDeleted && f.DueDate)) {
        const due = new Date(f.DueDate!);
        if (due.getTime() >= now && due.getTime() <= cutoff) {
          deadlines.push({ courseName: item.OrgUnit.Name, name: f.Name, dueDate: due });
        }
      }
    } catch {
      // Skip courses where we can't access assignments
    }
  }

  if (!deadlines.length) {
    return `No upcoming deadlines in the next ${daysAhead} days. 🎉`;
  }

  deadlines.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const rows = deadlines.map((d) => {
    const daysLeft = Math.ceil((d.dueDate.getTime() - now) / 86_400_000);
    const dot = daysLeft <= 2 ? '🔴' : daysLeft <= 7 ? '🟡' : '🟢';
    return (
      `${dot} **${d.name}**\n` +
      `   Course: ${d.courseName}\n` +
      `   Due: ${fmtDateTime(d.dueDate.toISOString())}  (${daysLeft} day${daysLeft === 1 ? '' : 's'} away)`
    );
  });

  return `Upcoming Deadlines — next ${daysAhead} days\n\n${rows.join('\n\n')}`;
}

async function handleCheckApiVersions(): Promise<string> {
  const client = await ensureAuthenticated();
  const versions = await client.getSupportedVersions();

  if (!versions.length) return 'Could not retrieve API version information from ONQ.';

  const rows = versions.map(
    (v) => `${v.ProductCode.padEnd(6)} latest: ${v.LatestVersion}`
  );
  return (
    `ONQ Supported API Versions\n\n${rows.join('\n')}\n\n` +
    `Current config: lp=${(await import('./config.js')).LP_VERSION}  ` +
    `le=${(await import('./config.js')).LE_VERSION}`
  );
}

async function handleLogout(): Promise<string> {
  clearSession();
  apiClient = null;
  currentSession = null;
  return '✅ Logged out of ONQ. Session cleared from disk. The next tool call will open a browser to log in.';
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── MCP Server setup ─────────────────────────────────────────────────────────

const server = new Server(
  { name: 'onq-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    // get_topic_content returns McpContent[] so it can carry binary PDF blobs
    if (name === 'get_topic_content') {
      const content = await handleGetTopicContent(
        a.course_id as number,
        a.topic_id as number
      );
      return { content };
    }

    let text: string;

    switch (name) {
      case 'login_status':
        text = await handleLoginStatus();
        break;
      case 'list_courses':
        text = await handleListCourses();
        break;
      case 'list_assignments':
        text = await handleListAssignments(a.course_id as number | undefined);
        break;
      case 'get_assignment_details':
        text = await handleGetAssignmentDetails(a.course_id as number, a.folder_id as number);
        break;
      case 'get_grades':
        text = await handleGetGrades(a.course_id as number);
        break;
      case 'list_announcements':
        text = await handleListAnnouncements(
          a.course_id as number,
          (a.limit as number | undefined) ?? 10
        );
        break;
      case 'get_course_content':
        text = await handleGetCourseContent(a.course_id as number);
        break;
      case 'get_upcoming_deadlines':
        text = await handleGetUpcomingDeadlines((a.days_ahead as number | undefined) ?? 30);
        break;
      case 'check_api_versions':
        text = await handleCheckApiVersions();
        break;
      case 'logout':
        text = await handleLogout();
        break;
      case 'get_calendar_events': {
        const courseId = (args ?? {}).course_id as number;
        const daysAhead = ((args ?? {}).days_ahead as number | undefined) ?? 30;
        text = await handleGetCalendarEvents(courseId, daysAhead);
        break;
      }
      case 'get_quiz_attempts': {
        const courseId = (args ?? {}).course_id as number;
        const quizId = ((args ?? {}).quiz_id as number | undefined);
        text = await handleGetQuizAttempts(courseId, quizId);
        break;
      }
      case 'get_discussion_posts': {
        const courseId = (args ?? {}).course_id as number;
        const forumId = ((args ?? {}).forum_id as number | undefined);
        const topicId = ((args ?? {}).topic_id as number | undefined);
        text = await handleGetDiscussionPosts(courseId, forumId, topicId);
        break;
      }
      default:
        text = `Unknown tool: ${name}`;
    }

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `❌ Error: ${msg}` }],
      isError: true,
    };
  }
});

// ─── Session keep-alive ───────────────────────────────────────────────────────
// Periodically ping D2L to prevent the server-side session from timing out
// during long Claude sessions. Only runs when we have an active client.

let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepAlive(): void {
  if (keepAliveTimer) return; // already running
  keepAliveTimer = setInterval(async () => {
    if (!apiClient) return;
    try {
      await apiClient.whoAmI();
    } catch {
      // Session expired between pings — will re-auth on next tool call
      console.error('Keep-alive ping failed — session may have expired.');
    }
  }, KEEP_ALIVE_INTERVAL_MS);
  // Don't let the timer prevent Node from exiting
  keepAliveTimer.unref();
}

// ─── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  startKeepAlive();
  console.error('ONQ MCP Server running — waiting for tool calls from Claude.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
