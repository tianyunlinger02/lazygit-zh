import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scratchRoot = fileURLToPath(new URL('../.claude-tmp', import.meta.url));

export async function createScratch(prefix = 'case-') {
  if (typeof prefix !== 'string' || !prefix || /[^A-Za-z0-9_-]/u.test(prefix)) {
    throw new TypeError('Scratch prefix must be a non-empty name containing only letters, digits, underscores or hyphens.');
  }
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, prefix));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
