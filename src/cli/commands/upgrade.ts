import { isNewerVersion } from '@/shared-kernel/updates/UpdateChecker.js';

export { isNewerVersion };

export async function runUpgrade(): Promise<void> {
  process.stdout.write('This OnQ fork updates from GitHub, not the brightspace-mcp npm package. Follow docs/onq/UPDATE-WINDOWS.md in this checkout.\n');
}
