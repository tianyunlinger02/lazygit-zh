/** Linked worktrees are real repositories; bindings are keyed by their own root, not common-dir. */
import { realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Git, GitError, decodePath, splitNul } from './git.js';
import { resolveBinding } from './profiles.js';
import { projectGit } from './workflows.js';
import type { Console } from './ui.js';

type Directory = string | Git;
export interface Worktree { path: string; head: string; branch?: string; bare: boolean; detached: boolean; locked?: string; prunable?: string }
async function repository(directory: Directory): Promise<Git> {
  const git = directory instanceof Git ? directory : await projectGit(directory);
  return await git.value('rev-parse', '--is-bare-repository') === 'true' ? git : git.repository();
}

export function parseWorktrees(raw: Buffer): Worktree[] {
  const result: Worktree[] = []; let current: Worktree | undefined;
  for (const field of splitNul(raw)) {
    if (!field.length) { if (current) result.push(current); current = undefined; continue; }
    const separator = field.indexOf(32);
    const key = field.subarray(0, separator < 0 ? field.length : separator).toString('ascii');
    const value = separator < 0 ? '' : decodePath(field.subarray(separator + 1));
    if (key === 'worktree') { if (current) result.push(current); current = { path: value, head: '', bare: false, detached: false }; }
    else if (!current) throw new GitError('worktree 列表不完整，请检查 Git 版本。');
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = value;
    else if (key === 'prunable') current.prunable = value;
  }
  if (current) result.push(current);
  return result;
}
/** Git <2.36 lacks -z and does not quote paths, even with core.quotePath. Recognize
 * the fixed HEAD/bare header rather than splitting a path at its first newline. */
export function parseLegacyWorktrees(raw: Buffer): Worktree[] {
  const value = decodePath(raw); const result: Worktree[] = []; let remaining = value;
  while (remaining) {
    const header = /^worktree ([\s\S]*?)\n(HEAD ([0-9a-f]{40,64})|bare)\n/u.exec(remaining);
    if (!header) throw new GitError('旧版 Git 的 worktree 输出有歧义；请升级 Git，未猜测路径。');
    const item: Worktree = { path: header[1], head: header[3] || '', bare: header[2] === 'bare', detached: false };
    remaining = remaining.slice(header[0].length);
    if (item.bare) { if (remaining.startsWith('\n')) remaining = remaining.slice(1); else throw new GitError('旧版 Git 的 bare worktree 输出不完整；未猜测列表。'); result.push(item); continue; }
    const end = remaining.indexOf('\n\n');
    // A bare entry may have no attributes: only its blank terminator remains.
    let attributes = '';
    if (remaining.startsWith('\n')) remaining = remaining.slice(1);
    else if (end >= 0) { attributes = remaining.slice(0, end); remaining = remaining.slice(end + 2); }
    else { attributes = remaining.replace(/\n$/u, ''); remaining = ''; }
    for (const field of attributes.split('\n').filter(Boolean)) {
      if (field.startsWith('branch ')) item.branch = field.slice(7);
      else if (field === 'detached') item.detached = true;
      else if (field === 'locked' || field.startsWith('locked ')) item.locked = field.slice(7);
      else if (field === 'prunable' || field.startsWith('prunable ')) item.prunable = field.slice(9);
      else throw new GitError('旧版 Git 的 worktree 字段无法无损辨认；请升级 Git，未猜测路径。');
    }
    result.push(item);
  }
  return result;
}
export async function worktreeRecords(repo: Git): Promise<Worktree[]> {
  const result = await repo.run(['worktree', 'list', '--porcelain', '-z'], { check: false });
  if (!result.status) return parseWorktrees(result.stdout);
  if (result.status !== 129 || !Git.output(result).includes("unknown switch `z'")) throw new GitError(`无法列出 worktree：${Git.output(result)}`);
  return parseLegacyWorktrees((await repo.run(['worktree', 'list', '--porcelain'])).stdout);
}
function label(item: Worktree): string { return `${JSON.stringify(item.path)}  ${item.branch?.replace(/^refs\/heads\//u, '') || (item.bare ? 'bare' : '游离 HEAD')}  ${item.head.slice(0, 10)}${item.locked !== undefined ? `  已锁定 ${JSON.stringify(item.locked)}` : ''}${item.prunable !== undefined ? `  可清理 ${JSON.stringify(item.prunable)}` : ''}`; }
async function selected(ui: Console, repo: Git, title: string): Promise<{ item: Worktree; all: Worktree[] } | undefined> {
  const all = await worktreeRecords(repo); const choice = await ui.menu(title, all.map(label));
  return choice ? { item: all[choice - 1], all } : undefined;
}
async function unchanged(repo: Git, previous: Worktree[]): Promise<void> { if (!isDeepStrictEqual(await worktreeRecords(repo), previous)) throw new GitError('worktree 列表在确认期间发生变化，请重新选择。'); }
async function ready(repo: Git): Promise<void> {
  if (await repo.value('rev-parse', '--is-bare-repository') === 'true') return;
  if (await repo.operation() || (await repo.changes()).some(change => change.conflict)) throw new GitError('当前工作区有未完成操作或冲突；请先处理，再管理 worktree。');
}
async function bindingNotice(ui: Console, directory: string): Promise<void> {
  const profile = await resolveBinding(directory);
  ui.text(profile ? `此工作区明确绑定：${profile.label} / ${profile.github_login}` : '此工作区没有 AutoGit 账号绑定；不从主工作区 / common-dir 猜测或复制账号。需要联网时请明确绑定。');
}
async function forceChoice(ui: Console, description: string): Promise<number | undefined> {
  const choice = await ui.menu(description, ['普通模式（Git 的保护保持开启）', 'force（允许脏工作区 / 已占用分支等 Git 允许的覆盖）', '双 force（也允许处理已锁定的工作区）']);
  return choice ? choice - 1 : undefined;
}
function forces(count: number): string[] { return Array.from({ length: count }, () => '--force'); }
function samePath(left: string, right: string): boolean { const key = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value); return key(left) === key(right); }
async function targetStatus(item: Worktree): Promise<string> {
  try { return (await new Git(item.path).run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'])).stdout.toString('base64'); }
  catch (error) { if (item.prunable !== undefined) return ''; throw error; }
}

export async function addWorktree(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory); await ready(repo);
  if (!await repo.hasCommits()) throw new GitError('请先完成第一次提交，再创建 linked worktree。');
  const all = await worktreeRecords(repo);
  const destination = resolve(repo.directory, await ui.ask('新工作区目录', resolve(dirname(repo.directory), 'new-worktree')));
  const mode = await ui.menu('新工作区的分支', ['已有本地分支', '创建新分支', '游离 HEAD（不占用分支）']); if (!mode) return;
  let branch = '', start = 'HEAD';
  if (mode === 1) {
    const names = (await repo.value('for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/')).split('\n').filter(Boolean);
    const pick = await ui.menu('选择分支（已占用也可明确选择 force）', names.map(name => `${name}${all.some(item => item.branch === `refs/heads/${name}`) ? '  [其他工作区已占用]' : ''}`));
    if (!pick) return; branch = names[pick - 1];
  } else if (mode === 2) {
    branch = await ui.ask('新分支名');
    if (branch.startsWith('-') || (await repo.run(['check-ref-format', '--branch', branch], { check: false })).status) throw new GitError('分支名无效。');
    if (!(await repo.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { check: false })).status) throw new GitError('分支已存在，请选择已有分支；不会重置它。');
    start = await ui.ask('起点提交 / 分支', 'HEAD');
  } else start = await ui.ask('起点提交 / 分支', 'HEAD');
  if (start.startsWith('-') || (await repo.run(['rev-parse', '--verify', '--end-of-options', `${start}^{commit}`], { check: false })).status) throw new GitError('起点不是有效提交。');
  const force = await forceChoice(ui, 'worktree add 的保护选项'); if (force === undefined) return;
  ui.text(`创建 linked .git 文件工作区：${JSON.stringify(destination)}\n${mode === 3 ? `游离 HEAD：${start}` : `分支：${branch}${mode === 2 ? `，起点 ${start}` : ''}`}\nforce 次数：${force}。不自动绑定账号。`);
  if (!(force ? await ui.confirm('确认按以上范围创建 / force 使用该分支？') : await ui.routineConfirm('创建这个工作区？'))) return;
  await unchanged(repo, all);
  const local = new Git(repo.directory, { config: repo.overrides, env: { ...repo.environment, GIT_LFS_SKIP_SMUDGE: '1' }, rejectEnv: repo.rejectedEnvironment });
  await local.run(['worktree', 'add', ...forces(force), ...(mode === 2 ? ['-b', branch] : mode === 3 ? ['--detach'] : []), '--', destination, mode === 1 ? branch : start], { interactive: true });
  ui.text('工作区已创建；原工作区未切换。请在工作区菜单进入它，并按需明确绑定账号。LFS 自动 smudge 已跳过，请在新工作区 LFS 菜单按 endpoint 下载对象。');
}

export async function switchWorktree(ui: Console, directory: Directory): Promise<string | undefined> {
  const repo = await repository(directory); const selection = await selected(ui, repo, '进入工作区（不 checkout 当前目录）'); if (!selection) return undefined;
  const { item, all } = selection;
  if (item.bare) throw new GitError('bare 仓库没有可进入的工作区。');
  if (!(await stat(item.path)).isDirectory()) throw new GitError('工作区目录不存在，请检查或清理登记。');
  const root = await new Git(item.path).root();
  if (await realpath(root) !== await realpath(item.path)) throw new GitError('目标不是登记的独立工作区，未切换。');
  await bindingNotice(ui, root); await unchanged(repo, all);
  return samePath(root, repo.directory) ? undefined : root;
}

export async function moveWorktree(ui: Console, directory: Directory): Promise<string | undefined> {
  const repo = await repository(directory); const selection = await selected(ui, repo, '移动 linked worktree'); if (!selection) return undefined;
  const { item, all } = selection;
  if (all[0] === item) throw new GitError('主工作区不能用 git worktree move 移动；请选择 linked worktree。');
  const destination = resolve(repo.directory, await ui.ask('目标完整目录（新路径，不是已有父目录）'));
  try { await stat(destination); throw new GitError('目标目录已存在；请选择最终的新路径，避免 Git 自动移入现有父目录而切换到错误位置。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const force = await forceChoice(ui, 'worktree move 的保护选项'); if (force === undefined) return undefined;
  const before = await targetStatus(item);
  ui.text(`${JSON.stringify(item.path)} → ${JSON.stringify(destination)}\nforce 次数：${force}；保留分支与文件。旧路径的账号绑定不会按 common-dir 自动转移，新位置需明确绑定。`);
  if (!await ui.confirm('确认移动上述工作区？')) return undefined;
  await unchanged(repo, all);
  if (await targetStatus(item) !== before) throw new GitError('工作区状态在确认期间变化，未移动。');
  await repo.run(['worktree', 'move', ...forces(force), '--', item.path, destination], { interactive: true });
  ui.text('移动完成。请在新目录明确检查 / 绑定账号；旧路径绑定未改写。');
  return samePath(item.path, repo.directory) ? new Git(destination).directory : undefined;
}

export async function removeWorktree(ui: Console, directory: Directory): Promise<string | undefined> {
  const repo = await repository(directory); const selection = await selected(ui, repo, '删除 linked worktree（分支保留）'); if (!selection) return undefined;
  const { item, all } = selection;
  if (all[0] === item) throw new GitError('不能用 worktree remove 删除主工作区。');
  const before = await targetStatus(item);
  ui.text(`目标：${label(item)}\n${before ? '工作区状态（含忽略文件）：\n' + JSON.stringify(Buffer.from(before, 'base64').toString('utf8')) : '工作区干净或目录已缺失。'}`);
  const force = await forceChoice(ui, '删除保护（force 可能永久删除未提交 / 未跟踪 / 忽略的文件）'); if (force === undefined) return undefined;
  if (!await ui.confirm(`确认删除 ${JSON.stringify(item.path)}？force 次数 ${force}；分支和仓库提交保留，未提交文件可能无法恢复。`)) return undefined;
  await unchanged(repo, all);
  if (await targetStatus(item) !== before) throw new GitError('工作区状态在确认期间变化，未删除。');
  const executor = samePath(item.path, repo.directory) ? new Git(all[0].path, { config: repo.overrides, env: repo.environment, rejectEnv: repo.rejectedEnvironment }) : repo;
  await executor.run(['worktree', 'remove', ...forces(force), '--', item.path], { interactive: true });
  ui.text('已删除指定工作区；没有删除分支，没有清除其他 worktree。');
  return samePath(item.path, repo.directory) ? (await repository(executor)).directory : undefined;
}

export async function lockWorktree(ui: Console, directory: Directory, unlock = false): Promise<void> {
  const repo = await repository(directory); const selection = await selected(ui, repo, unlock ? '解锁工作区' : '锁定工作区'); if (!selection) return;
  const { item, all } = selection;
  const reason = unlock ? '' : await ui.ask('锁定原因（可空）', '', { allowEmpty: true });
  ui.text(`${unlock ? '解锁' : '锁定'} ${JSON.stringify(item.path)}${reason ? `：${JSON.stringify(reason)}` : ''}`);
  if (!await ui.routineConfirm('应用上述锁定状态？')) return;
  await unchanged(repo, all);
  await repo.run(['worktree', unlock ? 'unlock' : 'lock', ...reason ? ['--reason', reason] : [], '--', item.path]);
}

export async function pruneWorktrees(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  const preview = await repo.run(['worktree', 'prune', '--dry-run', '--verbose', '--expire=now']);
  ui.text(Git.output(preview).trim() || '没有可清理的过期登记。');
  if (!Git.output(preview).trim()) return;
  ui.text('只清理失效 worktree 管理登记，不删除仍存在的工作区文件；锁定登记会保留。');
  if (!await ui.confirm('确认现在清理以上失效登记？')) return;
  const again = await repo.run(['worktree', 'prune', '--dry-run', '--verbose', '--expire=now']);
  if (Git.output(again) !== Git.output(preview)) throw new GitError('待清理登记发生变化，请重新预览。');
  await repo.run(['worktree', 'prune', '--verbose', '--expire=now'], { interactive: true });
}

export async function worktreesMenu(ui: Console, directory: string): Promise<string | undefined> {
  const choice = await ui.menu('多工作区 / worktree', ['列出工作区及分支占用', '创建 linked worktree', '进入 / 切换工作区', '移动工作区', '删除工作区（保留分支）', '锁定工作区', '解锁工作区', '清理失效登记']);
  if (choice === 1) for (const item of await worktreeRecords(await repository(directory))) ui.text(label(item));
  else if (choice === 2) await addWorktree(ui, directory);
  else if (choice === 3) return switchWorktree(ui, directory);
  else if (choice === 4) return moveWorktree(ui, directory);
  else if (choice === 5) return removeWorktree(ui, directory);
  else if (choice === 6 || choice === 7) await lockWorktree(ui, directory, choice === 7);
  else if (choice === 8) await pruneWorktrees(ui, directory);
  return undefined;
}
