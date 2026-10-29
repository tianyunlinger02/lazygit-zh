/** Ignore oversized, never-tracked files before ordinary file selection; never change the index. */
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Git, GitError, decodePath, encodePath, splitNul, type Change } from './git.js';
import { isErrno } from './storage.js';
import type { Console } from './ui.js';

export const DEFAULT_LARGE_FILE_BYTES = 50 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
type FileInfo = Awaited<ReturnType<typeof lstat>>;
interface IgnoreSnapshot { readonly bytes: Buffer; readonly info: FileInfo }
interface Candidate { readonly name: string; readonly raw: Buffer; readonly rule?: Buffer; readonly info: FileInfo }

function sameFile(left: FileInfo, right: FileInfo): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode && left.nlink === right.nlink;
}
function display(value: string): string { return JSON.stringify(value); }
function filePath(repo: Git, name: string): Buffer { return encodePath(path.join(repo.directory, name)); }
function pathSet(bytes: Buffer): Set<string> { return new Set(splitNul(bytes).filter(item => item.length).map(decodePath)); }

function exactRule(raw: Buffer): Buffer | undefined {
  if (raw.includes(10) || raw.includes(13)) return undefined;
  const result = [47];
  for (const byte of raw) {
    if ([92, 32, 33, 35, 42, 63, 91, 93].includes(byte)) result.push(92);
    result.push(byte);
  }
  return Buffer.from(result);
}
function lines(bytes: Buffer): Buffer[] {
  const result: Buffer[] = []; let start = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) {
    result.push(bytes.subarray(start, i > start && bytes[i - 1] === 13 ? i - 1 : i)); start = i + 1;
  }
  if (start < bytes.length) result.push(bytes.subarray(start));
  return result;
}
function additionsFor(before: Buffer, candidates: readonly Candidate[]): Buffer[] {
  // A later negation can reopen a path: only deduplicate rules after the last negation.
  const existing = lines(before); let lastNegation = -1;
  for (let i = 0; i < existing.length; i++) if (existing[i][0] === 33) lastNegation = i;
  const known = new Set(existing.slice(lastNegation + 1).map(line => line.toString('hex')));
  const additions: Buffer[] = [];
  for (const { rule } of candidates) if (rule && !known.has(rule.toString('hex'))) { known.add(rule.toString('hex')); additions.push(rule); }
  return additions;
}
async function readIgnore(file: string): Promise<IgnoreSnapshot | undefined> {
  let info: FileInfo;
  try { info = await lstat(file); } catch (error) { if (isErrno(error, 'ENOENT')) return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new GitError('.gitignore 不是单链接普通文件，未改写。');
  if (info.size > DEFAULT_LARGE_FILE_BYTES) throw new GitError('.gitignore 本身已超过 50 MiB，未读取或改写。');
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    if (!sameFile(info, await handle.stat())) throw new GitError('.gitignore 在读取期间变化，未改写。');
    const bytes = await handle.readFile();
    if (!sameFile(info, await handle.stat()) || !sameFile(info, await lstat(file))) throw new GitError('.gitignore 在读取期间变化，未改写。');
    return { bytes, info };
  } finally { await handle.close(); }
}
async function appendIgnore(file: string, before: IgnoreSnapshot | undefined, additions: readonly Buffer[]): Promise<void> {
  if (before && !(Number(before.info.mode) & 0o222)) throw new GitError('.gitignore 为只读文件，未替换。');
  const old = before?.bytes ?? Buffer.alloc(0), firstLF = old.indexOf(10);
  const ending = Buffer.from(firstLF > 0 && old[firstLF - 1] === 13 ? '\r\n' : '\n');
  const content = Buffer.concat([old, old.length && old.at(-1) !== 10 ? ending : Buffer.alloc(0), ...additions.flatMap(rule => [rule, ending])]);
  const temporary = path.join(path.dirname(file), `.autogit-ignore-${randomUUID()}`), mode = before ? Number(before.info.mode) & 0o777 : 0o600;
  let created = false;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode); created = true;
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    if (process.platform !== 'win32') await chmod(temporary, mode);
    const current = await readIgnore(file);
    if (before ? !current || !sameFile(before.info, current.info) || !before.bytes.equals(current.bytes) : current !== undefined) throw new GitError('.gitignore 在操作期间变化，未覆盖。');
    if (before) await rename(temporary, file);
    else await link(temporary, file);
  } finally { if (created) await unlink(temporary).catch((error: unknown) => { if (!isErrno(error, 'ENOENT')) throw error; }); }
}
async function trackedPaths(repo: Git, changes: readonly Change[]): Promise<Set<string>> {
  const tracked = pathSet((await repo.run(['ls-files', '-z'])).stdout);
  if (await repo.hasCommits()) for (const name of pathSet((await repo.run(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])).stdout)) tracked.add(name);
  for (const change of changes) if (change.index !== '?' || change.worktree !== '?') {
    tracked.add(change.path); if (change.original) tracked.add(change.original);
  }
  return tracked;
}
async function ignoredPaths(repo: Git, candidates: readonly Candidate[]): Promise<Set<string>> {
  const result = await repo.run(['--no-literal-pathspecs', 'check-ignore', '-z', '--stdin'], {
    check: false, inputData: Buffer.concat(candidates.flatMap(item => [item.raw, Buffer.from([0])])),
  });
  if (result.status !== 0 && result.status !== 1) throw new GitError('无法核对自动忽略规则是否生效。');
  return pathSet(result.stdout);
}

/** Returns known oversized untracked paths, including any that could not be persistently ignored. */
export async function autoIgnoreLargeFiles(ui: Console, repo: Git, changes: readonly Change[]): Promise<ReadonlySet<string>> {
  const excluded = new Set<string>(), candidates: Candidate[] = [];
  const protectedPaths = new Set(changes.filter(item => item.index !== '?' || item.worktree !== '?').flatMap(item => [item.path, ...item.original ? [item.original] : []]));
  for (const change of changes) {
    if (change.index !== '?' || change.worktree !== '?' || protectedPaths.has(change.path)) continue;
    try {
      const info = await lstat(filePath(repo, change.path));
      if (!info.isFile() || info.isSymbolicLink() || info.size <= DEFAULT_LARGE_FILE_BYTES) continue;
      excluded.add(change.path);
      if (change.path === '.gitignore') { ui.warn('.gitignore 本身已超过 50 MiB，本次不加入提交，也不添加自我忽略规则。'); continue; }
      candidates.push({ name: change.path, raw: encodePath(change.path), rule: exactRule(encodePath(change.path)), info });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      excluded.add(change.path); ui.warn(`无法检查 ${display(change.path)} 的大小，本次跳过：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!candidates.length) return excluded;
  try {
    const tracked = await trackedPaths(repo, changes);
    let eligible = candidates.filter(item => { if (!tracked.has(item.name)) return true; excluded.delete(item.name); return false; });
    for (const item of eligible) if (!item.rule) ui.warn(`超大文件 ${display(item.name)} 的名称含换行，无法写入 .gitignore；仅跳过本次提交。`);
    eligible = eligible.filter(item => item.rule);
    if (!eligible.length) return excluded;
    const file = path.join(repo.directory, '.gitignore'), before = await readIgnore(file);
    const currentChanges = await repo.changes(), currentTracked = await trackedPaths(repo, currentChanges);
    const fresh = new Set(currentChanges.filter(item => item.index === '?' && item.worktree === '?').map(item => item.path));
    const live: Candidate[] = [];
    for (const item of eligible) {
      if (!fresh.has(item.name) || currentTracked.has(item.name)) { excluded.delete(item.name); continue; }
      try {
        const info = await lstat(filePath(repo, item.name));
        if (!info.isFile() || info.isSymbolicLink() || info.size <= DEFAULT_LARGE_FILE_BYTES) { excluded.delete(item.name); continue; }
        if (!sameFile(item.info, info)) { ui.warn(`超大文件 ${display(item.name)} 在检查期间变化，未追加规则；本次跳过。`); continue; }
        live.push(item);
      } catch (error) { if (!isErrno(error, 'ENOENT')) ui.warn(`无法复核超大文件 ${display(item.name)}，本次跳过。`); }
    }
    if (!live.length) return excluded;
    const additions = additionsFor(before?.bytes ?? Buffer.alloc(0), live);
    if (additions.length) await appendIgnore(file, before, additions);
    const ignored = await ignoredPaths(repo, live);
    for (const item of live) {
      if (ignored.has(item.name)) ui.warn(`已自动忽略 ${display(item.name)}（${(Number(item.info.size) / 1024 / 1024).toFixed(1)} MiB，默认阈值 50 MiB）；文件仍保留在磁盘。`);
      else ui.warn(`超大文件 ${display(item.name)} 的忽略规则未生效（可能被子目录规则重新包含）；仅跳过本次提交，不修改其它规则。`);
    }
  } catch (error) {
    ui.warn(`自动忽略未完成，以下超大未跟踪文件仅跳过本次提交，其它文件仍可保存：${candidates.map(item => display(item.name)).join('、')}。${error instanceof Error ? `原因：${error.message}` : ''}`);
  }
  return excluded;
}
