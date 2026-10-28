/** Read-only repository fingerprints for confirmation-time state checks. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { Git, GitError, decodePath, encodePath, splitNul } from './git.js';
import { appDataDir } from './app-context.js';

const MARKERS = ['MERGE_HEAD', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'BISECT_START', 'rebase-merge', 'rebase-apply', 'sequencer'];
const nul = Buffer.from([0]);
function missing(error: unknown): boolean { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''); }
function within(file: string, parent: string): boolean { const relative = path.relative(parent, file); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }

/** Hash actual bytes, symlink targets and modes, not just porcelain's repeated M status. */
async function fingerprint(location: string, hash: ReturnType<typeof createHash>, recursive: boolean, protectedData: string): Promise<void> {
  if (within(location, protectedData)) { hash.update('protected-data'); return; }
  try {
    const info = await lstat(encodePath(location));
    hash.update(`${info.mode}:${info.size}:`);
    if (info.isSymbolicLink()) hash.update(await readlink(encodePath(location), { encoding: 'buffer' }));
    else if (info.isFile()) for await (const chunk of createReadStream(encodePath(location))) hash.update(chunk);
    else if (info.isDirectory() && recursive) {
      const names = (await readdir(encodePath(location), { encoding: 'buffer' })).sort(Buffer.compare);
      for (const raw of names) { hash.update(raw); hash.update(nul); await fingerprint(path.join(location, decodePath(raw)), hash, true, protectedData); }
    }
  } catch (error) { if (!missing(error)) throw error; hash.update('missing'); }
}

/** Stop at a parent symlink/file blocker; never follow it outside the worktree. */
async function worktreeFingerprint(repo: Git, name: string, hash: ReturnType<typeof createHash>, recursive: boolean, protectedData: string): Promise<void> {
  const location = path.resolve(repo.directory, name);
  const parts = path.relative(repo.directory, location).split(path.sep).filter(Boolean);
  let current = repo.directory;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (within(current, protectedData)) { hash.update('protected-data'); return; }
    try {
      const info = await lstat(encodePath(current));
      if (!info.isDirectory()) { hash.update('parent-blocker:'); hash.update(encodePath(current)); await fingerprint(current, hash, false, protectedData); return; }
    } catch (error) { if (!missing(error)) throw error; hash.update('missing-parent:' + current); return; }
  }
  await fingerprint(location, hash, recursive, protectedData);
}

export interface RepositoryStamp { readonly digest: string }
export async function repositoryStamp(repo: Git, extraPaths: readonly string[] = []): Promise<RepositoryStamp> {
  const hash = createHash('sha256');
  const protectedData = path.resolve(appDataDir()); hash.update(protectedData);
  for (const args of [['symbolic-ref', '-q', 'HEAD'], ['rev-parse', '--verify', 'HEAD'], ['ls-files', '--stage', '-z'], ['status', '--porcelain=v1', '-z', '--untracked-files=all']]) {
    const result = await repo.run(args, { check: false }); hash.update(`${result.status}:`); hash.update(result.stdout); hash.update(nul);
  }
  for (const marker of MARKERS) { hash.update(marker); await fingerprint(await repo.gitPath(marker), hash, true, protectedData); }
  const names = splitNul((await repo.run(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).stdout).filter(raw => raw.length).map(decodePath);
  const gitlinks = new Set(splitNul((await repo.run(['ls-files', '--stage', '-z'])).stdout).filter(raw => raw.subarray(0, 7).equals(Buffer.from('160000 '))).map(raw => decodePath(raw.subarray(raw.indexOf(9) + 1))));
  for (const name of [...new Set([...names, ...extraPaths])].sort()) {
    hash.update(encodePath(name)); hash.update(nul);
    // Gitlinks and untracked nested repositories are not recursively inspected by ordinary edits.
    await worktreeFingerprint(repo, name, hash, extraPaths.includes(name) && !gitlinks.has(name), protectedData);
  }
  return { digest: hash.digest('hex') };
}
export async function verifyRepositoryStamp(repo: Git, stamp: RepositoryStamp, extraPaths: readonly string[] = []): Promise<void> {
  if ((await repositoryStamp(repo, extraPaths)).digest !== stamp.digest) throw new GitError('确认期间 HEAD、暂存区、工作区实际内容或进行中的操作发生变化，请重新预览。');
}
