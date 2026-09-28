import { mkdir } from 'node:fs/promises';
import type { chromium, BrowserContext } from 'playwright';
import type { AuthContext, AuthStrategy } from '../../domain/AuthStrategy.js';
import type { Session } from '../../domain/Session.js';
import { AccessToken } from '../../domain/AccessToken.js';
import type { UserIdentity } from '../../domain/UserIdentity.js';
import { expandPath } from '@/shared-kernel/path/expandPath.js';

interface Options {
  profileDir: string;
  timeoutMs: number;
  sessionTtlMs: number;
  whoami: (token: AccessToken, baseUrl: string) => Promise<UserIdentity>;
  launch?: typeof chromium.launchPersistentContext;
}

/** Human SSO/MFA only. Never fills credentials or accepts consent prompts. */
export class InteractiveBrowserStrategy implements AuthStrategy {
  readonly kind = 'interactive' as const;
  constructor(private readonly opts: Options) {}
  canRefresh(): boolean { return false; }

  async authenticate(ctx: AuthContext): Promise<Session> {
    const dir = expandPath(this.opts.profileDir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const launch = this.opts.launch ?? (await import('playwright')).chromium.launchPersistentContext.bind((await import('playwright')).chromium);
    const origin = new URL(ctx.baseUrl).origin;
    const identify = async (browser: BrowserContext): Promise<Session | null> => {
      // Let Chromium apply domain, path, secure and expiry rules; never forward IdP cookies.
      const cookies = await browser.cookies(`${origin}/d2l/api/`);
      if (!cookies.length) return null;
      const token = AccessToken.cookie(cookies.map(c => `${c.name}=${c.value}`).join('; '));
      try {
        const identity = await this.opts.whoami(token, origin);
        const now = new Date();
        return { token, profile: ctx.profile, issuedAt: now,
          expiresAt: new Date(now.getTime() + this.opts.sessionTtlMs),
          source: this.kind, userIdentity: identity };
      } catch (err) {
        // Network/version errors must not be mistaken for a request to log in.
        if (err && typeof err === 'object' && 'status' in err &&
            (err.status === 401 || err.status === 403)) return null;
        throw err;
      }
    };
    const quiet = await launch(dir, { headless: true });
    try {
      const session = await identify(quiet);
      if (session) return session;
    } finally { await quiet.close(); }

    process.stderr.write('OnQ needs sign-in. Complete Queen’s SSO in the browser on this machine.\n');
    const browser = await launch(dir, { headless: false });
    try {
      const page = browser.pages()[0] ?? await browser.newPage();
      await page.goto(`${origin}/d2l/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const deadline = Date.now() + this.opts.timeoutMs;
      while (Date.now() < deadline) {
        if (page.isClosed()) throw new Error('OnQ sign-in was cancelled. Run the login script again.');
        const url = new URL(page.url());
        if (url.origin === origin && url.pathname.startsWith('/d2l/') && !url.pathname.startsWith('/d2l/login')) {
          const session = await identify(browser);
          if (session) return session;
        }
        await page.waitForTimeout(1500);
      }
      throw new Error('OnQ sign-in timed out. Run scripts/windows/Login-OnQ.ps1 on the Windows machine, then retry.');
    } finally { await browser.close(); }
  }
}
