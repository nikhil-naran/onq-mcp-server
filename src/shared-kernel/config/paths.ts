import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT_DIR_NAME = '.brightspace-mcp';

function root(): string {
  return process.env['ONQ_DATA_DIR'] || join(homedir(), ROOT_DIR_NAME);
}

export const Paths = {
  rootDir: root,
  configYaml: (): string => join(root(), 'config.yaml'),
  credentialsEnc: (): string => join(root(), 'credentials.enc'),
  sessionsJson: (): string => join(root(), 'sessions.json'),
  domainCacheJson: (): string => join(root(), 'domain-cache.json'),
  idempotencyJson: (): string => join(root(), 'idempotency.json'),
} as const;
