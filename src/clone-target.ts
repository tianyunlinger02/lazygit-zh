/** Shared destination selection for Git and GitHub downloads. */
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { GitError } from './git.js';
import { isErrno } from './storage.js';
import type { Console } from './ui.js';

interface DirectoryIdentity { dev: number; ino: number; birthtimeMs: number }
export interface CloneTarget { directory: string; identity?: DirectoryIdentity }
function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean { return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs; }
async function unchangedParent(parent: string): Promise<boolean> {
  const actual = await realpath(parent);
  return process.platform === 'win32' ? actual.toLowerCase() === parent.toLowerCase() : actual === parent;
}
function validName(name: string): boolean {
  return !!name && !['.', '..'].includes(name) && !/[/\\<>:"|?*\x00-\x1f\x7f]/u.test(name) && !name.startsWith('-') && !path.win32.parse(name).root && !/[. ]$/u.test(name) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name);
}
async function inspect(directory: string): Promise<DirectoryIdentity | undefined> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new GitError('目标不是普通文件夹，请选择另一个名称。');
    if ((await readdir(directory)).length) throw new GitError('目标文件夹已存在且非空，请换一个名称；已有文件保持原样。');
    const after = await lstat(directory);
    if (!after.isDirectory() || after.isSymbolicLink() || !sameDirectory(info, after)) throw new GitError('目标文件夹在检查期间变化，请重新选择。');
    return { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
  } catch (error) { if (isErrno(error, 'ENOENT')) return undefined; throw error; }
}
export async function chooseCloneTarget(ui: Console, parent: string, defaultName: string): Promise<CloneTarget> {
  for (;;) {
    const name = await ui.ask('新建文件夹名称（也可使用已有空目录）', defaultName);
    if (!validName(name)) { ui.text('请输入单个普通文件夹名称，不要包含盘符、路径分隔符或特殊符号。'); continue; }
    const directory = path.join(parent, name);
    if (!await unchangedParent(parent)) throw new GitError('目标父目录已变化，请重新选择父目录。');
    try {
      const identity = await inspect(directory);
      if (identity) ui.text('将使用这个已有空目录，不删除或清空其他内容。');
      return { directory, ...(identity ? { identity } : {}) };
    } catch (error) { if (!(error instanceof GitError)) throw error; ui.text(error.message); }
  }
}
export async function verifyCloneTarget(target: CloneTarget): Promise<void> {
  if (!await unchangedParent(path.dirname(target.directory))) throw new GitError('目标父目录在选择期间变化，未下载。');
  let current: DirectoryIdentity | undefined;
  try { current = await inspect(target.directory); }
  catch (error) { if (!(error instanceof GitError)) throw error; throw new GitError(`目标文件夹在选择期间变化，未下载：${error.message}`); }
  if (target.identity ? !current || !sameDirectory(target.identity, current) : current !== undefined) throw new GitError('目标文件夹在选择期间变化或出现，请重新选择；未下载。');
}
