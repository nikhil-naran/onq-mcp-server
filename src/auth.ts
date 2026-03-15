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
 */

import { chromium, type Cookie } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { SESSION_DIR, SESSION_FILE, ONQ_HOST, LOGIN_TIMEOUT_MS } from './config.js';

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
 * Opens a real Chromium browser window and guides the user through Queen's
 * Microsoft SSO. Once the redirect back to ONQ is detected, cookies are
 * captured and saved.
 */
export async function authenticate(): Promise<Cookie[]> {
  console.error(
    '\n🔐 ONQ MCP Server needs to log in to your Queen\'s account.\n' +
    '   A browser window will open — please complete the sign-in.\n' +
    '   Your credentials are never seen or stored by this server.\n'
  );

  const browser = await chromium.launch({
    headless: false,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  // Navigate to ONQ login page
  await page.goto(`${ONQ_HOST}/d2l/login`, {
    waitUntil: 'domcontentloaded',
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
  await browser.close();

  console.error('✅ Successfully authenticated with ONQ!\n');
  return cookies;
}
