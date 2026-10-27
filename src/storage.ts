import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GitError } from './git.js';

export const MISSING = Symbol('missing metadata');
const MAX_JSON_BYTES = 1_048_576;

export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f-\x9f]/u.test(value)) {
    throw new GitError('字段不能为空或包含控制字符。');
  }
  return value;
}

export function location(value: unknown): string {
  const result = text(value);
  if (!path.isAbsolute(result) || /["%]/u.test(result) || result.split(/[\\/]/u).includes('..') || path.normalize(result) !== result) {
    throw new GitError('路径必须是真实绝对路径，不能包含双引号、百分号或上级跳转。');
  }
  return result;
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Validate every existing component before any read or mutation; never follow links. */
export function checkedPath(value: unknown, kind?: 'dir' | 'file', { missing = false } = {}): string {
  const result = location(value);
  const parents: string[] = [];
  let current = result;
  while (true) {
    parents.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const part of parents.reverse()) {
    let info: fs.Stats;
    try {
      info = fs.lstatSync(part);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        if (part === result && !missing) throw new GitError('所需路径不存在。');
        continue;
      }
      throw error;
    }
    if (info.isSymbolicLink()) throw new GitError('拒绝符号链接或目录联接。');
    if (part !== result && !info.isDirectory()) throw new GitError('路径的父级不是目录。');
    if (part === result && ((kind === 'dir' && !info.isDirectory()) || (kind === 'file' && (!info.isFile() || info.nlink !== 1)))) {
      throw new GitError('目录/文件类型异常，或文件存在硬链接。');
    }
    const real = fs.realpathSync.native(part);
    if (process.platform === 'win32' ? real.toLowerCase() !== part.toLowerCase() : real !== part) throw new GitError('路径不是规范化的真实路径。');
  }
  return result;
}

export async function setMode(file: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  try { await fsp.chmod(file, mode); } catch { /* Best effort, as in the portable Python implementation. */ }
}

export async function mkdirPrivate(directory: string): Promise<void> {
  checkedPath(directory, 'dir', { missing: true });
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  checkedPath(directory, 'dir');
  await setMode(directory, 0o700);
}

/** JSON.parse alone silently accepts duplicate keys, including escaped equivalents. */
export function parseStrictJson(source: string): unknown {
  let offset = 0;
  const whitespace = (): void => { while (/^[\x20\t\r\n]$/u.test(source[offset] ?? '')) offset++; };
  const invalid = (): never => { throw new SyntaxError('无效或重复字段的 JSON'); };
  const string = (): string => {
    if (source[offset] !== '"') return invalid();
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '"') return JSON.parse(source.slice(start, offset)) as string;
      if (char === '\\') offset++;
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > 128) invalid();
    whitespace();
    const char = source[offset];
    if (char === '{') {
      offset++;
      whitespace();
      const keys = new Set<string>();
      if (source[offset] === '}') { offset++; return; }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) invalid();
        keys.add(key);
        whitespace();
        if (source[offset++] !== ':') invalid();
        value(depth + 1);
        whitespace();
        const separator = source[offset++];
        if (separator === '}') return;
        if (separator !== ',') invalid();
      }
    }
    if (char === '[') {
      offset++;
      whitespace();
      if (source[offset] === ']') { offset++; return; }
      while (true) {
        value(depth + 1);
        whitespace();
        const separator = source[offset++];
        if (separator === ']') return;
        if (separator !== ',') invalid();
      }
    }
    if (char === '"') { string(); return; }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(offset));
    if (!token) invalid();
    offset += token![0].length;
  };
  value(0);
  whitespace();
  if (offset !== source.length) invalid();
  return JSON.parse(source) as unknown;
}

export async function readJson(file: string): Promise<unknown | typeof MISSING> {
  checkedPath(file, 'file', { missing: true });
  let handle: fsp.FileHandle;
  try { handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (isErrno(error, 'ENOENT')) return MISSING; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new GitError('目录/文件类型异常，或文件存在硬链接。');
    if (info.size > MAX_JSON_BYTES) throw new GitError('元数据 JSON 损坏，未自动覆盖。');
    // A bounded read also protects against a file growing after stat().
    const buffer = Buffer.alloc(MAX_JSON_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_JSON_BYTES) throw new GitError('元数据 JSON 损坏，未自动覆盖。');
    try { return parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, total))); }
    catch (error) { throw new GitError('元数据 JSON 损坏，未自动覆盖。', { cause: error }); }
  } finally { await handle.close(); }
}

/** Write, fsync, then rename within the same directory; leave existing metadata intact on failure. */
export async function writeJson(file: string, data: unknown): Promise<void> {
  checkedPath(file, 'file', { missing: true });
  const temporary = path.join(path.dirname(file), `.tmp-${randomUUID().replaceAll('-', '')}`);
  let created = false;
  try {
    const handle = await fsp.open(temporary, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    checkedPath(file, 'file', { missing: true });
    await fsp.rename(temporary, file);
    created = false;
    await setMode(file, 0o600);
    if (process.platform !== 'win32') {
      const directory = await fsp.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    if (created) await fsp.unlink(temporary).catch((error: unknown) => { if (!isErrno(error, 'ENOENT')) throw error; });
  }
}

export async function withStoreLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await mkdirPrivate(directory);
  const lock = path.join(directory, '.lock');
  checkedPath(lock, 'file', { missing: true });
  let handle: fsp.FileHandle;
  try { handle = await fsp.open(lock, 'wx', 0o600); }
  catch (error) {
    if (isErrno(error, 'EEXIST')) throw new GitError('账号存储已锁定；请确认其他操作已结束，不会自动移除锁。');
    throw error;
  }
  const owned = await handle.stat();
  await handle.close();
  try { return await operation(); }
  finally {
    checkedPath(lock, 'file');
    const current = await fsp.lstat(lock);
    if (current.ino !== owned.ino || current.dev !== owned.dev) throw new GitError('存储锁已变化，不会自动移除其他操作的锁。');
    await fsp.unlink(lock);
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
