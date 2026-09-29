import { readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { parse, stringify } from 'yaml';
import { ConfigSchema } from '../build/shared-kernel/config/schema.js';

const [configPath, publicUrl, port] = process.argv.slice(2);
if (!configPath || !publicUrl || !port) throw new Error('Usage: configure-downloads.mjs CONFIG HTTPS_ORIGIN PORT');
const raw = parse(readFileSync(configPath, 'utf8'));
raw.file_delivery = { mode: 'download', public_base_url: publicUrl, port: Number(port) };
// Validate without printing potentially sensitive configuration data on errors.
if (!ConfigSchema.safeParse(raw).success) throw new Error('Invalid configuration. Check HTTPS hostname, port and existing OnQ settings.');
const backup = `${configPath}.${randomUUID()}.bak`;
copyFileSync(configPath, backup);
const temporary = `${configPath}.${randomUUID()}.tmp`;
writeFileSync(temporary, stringify(raw), { mode: 0o600, flag: 'wx' });
renameSync(temporary, configPath);
process.stdout.write('Download mode saved. The previous configuration was backed up alongside config.yaml.\n');
