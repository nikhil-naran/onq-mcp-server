import * as os from 'os';
import * as path from 'path';

// ONQ / D2L Brightspace host for Queen's University
export const ONQ_HOST = process.env.ONQ_HOST ?? 'https://onq.queensu.ca';

// Where session cookies are stored on disk
export const SESSION_DIR = path.join(os.homedir(), '.onq-session');
export const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

// Persistent Playwright browser profile — keeps SSO cookies/tokens across sessions
export const BROWSER_DATA_DIR = path.join(SESSION_DIR, 'browser-data');

// How often to ping D2L to keep the session alive (15 minutes)
export const KEEP_ALIVE_INTERVAL_MS = 15 * 60 * 1000;

// How long to wait for the user to complete SSO login (5 minutes)
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// D2L REST API versions — Queen's may run a specific Brightspace release.
// If you get 404 errors, check /d2l/api/versions/ on ONQ and update these.
// You can also override them via environment variables.
export const LP_VERSION = process.env.ONQ_LP_VERSION ?? '1.57';
export const LE_VERSION = process.env.ONQ_LE_VERSION ?? '1.92';
