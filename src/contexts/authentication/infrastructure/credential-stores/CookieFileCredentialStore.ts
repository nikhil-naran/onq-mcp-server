import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CredentialStore } from '../../domain/CredentialStore.js';
import { SecretValue } from '../../domain/SecretValue.js';

/** Explicit legacy plaintext-cookie scheme; distinct from encrypted file: secrets. */
export class CookieFileCredentialStore implements CredentialStore {
  async get(key: string): Promise<SecretValue | null> {
    const path = key.slice('cookiefile:'.length);
    if (!key.startsWith('cookiefile:') || !isAbsolute(path)) throw new Error('cookiefile: requires an absolute path');
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid cookie file size/type');
      const value = (await file.readFile('utf8')).trim();
      if (!value || /[\r\n\0]/.test(value)) throw new Error('Invalid cookie file contents');
      return new SecretValue(value);
    } finally { await file.close(); }
  }
  async set(): Promise<void> { throw new Error('Use record-auth to save a cookie file'); }
  async delete(): Promise<void> { throw new Error('Remove the cookie file directly'); }
}
