/**
 * auth.ts
 * Handles Queen's University SSO login via Playwright and persists
 * session cookies to disk so users don't have to log in every time.
 *
 * Flow:
 *  1. Try to load saved cookies from ~/.onq-session/session.json
 *  2. Validate them with a quick /whoami API call
 *  3. If expired/missing, open a real Chromium window for the user to log in
 *  4. Save the fresh cookies and return them
 *
 * Persistence strategy:
 *  - Uses a persistent Playwright browser profile (~/.onq-session/browser-data/)
 *    so Microsoft SSO "remember me" tokens survive across sessions.
 *  - Auto-accepts the Microsoft "Stay signed in?" (KMSI) prompt to get
 *    long-lived refresh tokens (~90 days) instead of short session cookies.
 *  - A keep-alive ping in index.ts prevents D2L session timeout during use.
 */

import { chromium, type Cookie, type BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { SESSION_DIR, SESSION_FILE, BROWSER_DATA_DIR, ONQ_HOST, LOGIN_TIMEOUT_MS } from './config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredSession {
  cookies: Cookie[];
  savedAt: string;
}

// ─── Disk helpers ─────────────────────────────────────────────────────────────

export function loadSession(): StoredSession | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  }
  // Write with owner-only permissions (mode 600)
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), {
    mode: 0o600,
    encoding: 'utf-8',
  });
}

export function clearSession(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch {
    // Ignore errors during cleanup
  }
  // Also clear the persistent browser profile so stale SSO tokens don't linger
  try {
    if (fs.existsSync(BROWSER_DATA_DIR)) {
      fs.rmSync(BROWSER_DATA_DIR, { recursive: true, force: true });
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// ─── Cookie utilities ─────────────────────────────────────────────────────────

/**
 * Convert Playwright cookies into an HTTP Cookie header string.
 * Only includes cookies from the queensu.ca domain.
 */
export function cookiesToHeader(cookies: Cookie[]): string {
  return cookies
    .filter(c => c.domain.includes('queensu.ca') || c.domain.includes('onq'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// ─── Authentication ────────────────────────────────────────────────────────────

/**
 * Auto-accept Microsoft's "Stay signed in?" (KMSI) prompt if it appears.
 * This gives us a persistent refresh token (~90 days) instead of a
 * short-lived session cookie that expires in hours.
 */
async function tryAcceptKMSI(context: BrowserContext): Promise<void> {
  // Listen on all pages in the context (SSO may open in the same or a new page)
  context.on('page', (page) => {
    page.on('load', async () => {
      try {
        const url = page.url();
        if (!url.includes('login.microsoftonline.com')) return;

        // Microsoft KMSI prompt: "Stay signed in?" with a "Yes" button
        // The button has id="idSIButton9" or text "Yes"
        const yesButton = page.locator('#idSIButton9, input[value="Yes"], button:has-text("Yes")');
        const visible = await yesButton.isVisible({ timeout: 2_000 }).catch(() => false);
        if (visible) {
          await yesButton.click();
          console.error('   ✓ Auto-accepted "Stay signed in?" for longer session.');
        }
      } catch {
        // Non-critical — the user can click it manually
      }
    });
  });
}

/**
 * Opens a real Chromium browser window and guides the user through Queen's
 * Microsoft SSO. Once the redirect back to ONQ is detected, cookies are
 * captured and saved.
 *
 * Uses a persistent browser profile so SSO tokens and "remember me"
 * cookies survive across sessions, reducing re-authentication frequency.
 */
export async function authenticate(): Promise<Cookie[]> {
  console.error(
    '\n🔐 ONQ MCP Server needs to log in to your Queen\'s account.\n' +
    '   A browser window will open — please complete the sign-in.\n' +
    '   Your credentials are never seen or stored by this server.\n'
  );

  // Ensure the browser data directory exists
  if (!fs.existsSync(BROWSER_DATA_DIR)) {
    fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true, mode: 0o700 });
  }

  // Use a persistent context so SSO cookies/tokens survive across logins.
  // This means Microsoft's "remember me" actually works between sessions.
  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false,
    args: ['--start-maximized'],
    viewport: null,
  });

  // Set up auto-accept for the "Stay signed in?" prompt
  await tryAcceptKMSI(context);

  const page = context.pages()[0] ?? await context.newPage();

  // Navigate to ONQ login page
  await page.goto(`${ONQ_HOST}/d2l/login`, {
    waitUntil: 'domcontentloaded',
  });

  // Also check the current page for the KMSI prompt (not just new pages)
  // This handles the case where the prompt appears on the initial page
  page.on('load', async () => {
    try {
      if (!page.url().includes('login.microsoftonline.com')) return;
      const yesButton = page.locator('#idSIButton9, input[value="Yes"], button:has-text("Yes")');
      const visible = await yesButton.isVisible({ timeout: 2_000 }).catch(() => false);
      if (visible) {
        await yesButton.click();
        console.error('   ✓ Auto-accepted "Stay signed in?" for longer session.');
      }
    } catch {
      // Non-critical
    }
  });

  // Wait until we're back at ONQ and NOT on any login/SSO page.
  // Queen's SSO goes through Microsoft (login.microsoftonline.com),
  // possibly sts.queensu.ca, and then back to onq.queensu.ca.
  await page.waitForURL(
    (url) => {
      const href = url.toString();
      return (
        href.startsWith(ONQ_HOST) &&
        !href.includes('/d2l/login') &&
        !href.includes('login.microsoftonline') &&
        !href.includes('sts.queensu') &&
        !href.includes('/adfs/')
      );
    },
    { timeout: LOGIN_TIMEOUT_MS }
  );

  // Give the page a moment to finish setting any final cookies
  await page.waitForTimeout(2_000);

  const cookies = await context.cookies();
  await context.close();

  console.error('✅ Successfully authenticated with ONQ!\n');
  return cookies;
}
