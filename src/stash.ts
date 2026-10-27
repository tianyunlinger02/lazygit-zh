import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Git, GitError, encodePath } from './git.js';
import { Console } from './ui.js';
import { boundGit } from './profiles.js';

type Directory = string | Git;
export type StashRecord = readonly [index: string, oid: string, message: string];
type ChangeValue = { index: string; worktree: string; path: string; original?: string | null };

async function repository(directory: Directory): Promise<Git> {
  return (directory instanceof Git ? directory : await boundGit(directory)).repository();
}

async function exists(path: string): Promise<boolean> {
  try { await stat(encodePath(path)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw error;
  }
}

async function ready(repo: Git): Promise<void> {
  await repo.ensureReady();
  if (!await repo.hasCommits()) throw new GitError('空仓库还没有提交，暂不能收起工作；请先完成第一次提交。');
  for (const change of await repo.changes()) {
    const path = join(repo.directory, change.path);
    if (await exists(join(path, '.git'))) {
      throw new GitError('工作区包含嵌套仓库，不能保证 stash 完整保存，已停止。');
    }
  }
}

type RepositoryState = { branch: string; oid: string; operation: string };

async function repositoryState(repo: Git): Promise<RepositoryState> {
  return {
    branch: await repo.branch(), oid: await repo.value('rev-parse', '--verify', 'HEAD'),
    operation: await repo.operation(),
  };
}

async function checkRepositoryState(repo: Git, previous: RepositoryState): Promise<void> {
  const current = await repositoryState(repo);
  if (current.branch !== previous.branch || current.oid !== previous.oid || current.operation !== previous.operation) {
    throw new GitError('确认期间 HEAD、当前分支或操作状态发生变化，请重新预览。');
  }
}

function snapshot(changes: readonly ChangeValue[]): ChangeValue[] {
  return changes.map(({ index, worktree, path, original }) => ({ index, worktree, path, original }));
}

function sameChanges(left: readonly ChangeValue[], right: readonly ChangeValue[]): boolean {
  return left.length === right.length && left.every((change, index) => {
    const other = right[index];
    return change.index === other.index && change.worktree === other.worktree && change.path === other.path && change.original === other.original;
  });
}

export async function records(repo: Git): Promise<StashRecord[]> {
  const raw = (await repo.run(['stash', 'list', '--format=%gd%x00%H%x00%gs%x00'])).stdout;
  const parts = raw.toString('utf8').split('\0');
  const items: StashRecord[] = [];
  for (let position = 0; position < parts.length - 2; position += 3) {
    const index = parts[position].trim();
    if (index) items.push([index, parts[position + 1], parts[position + 2]]);
  }
  return items;
}

export async function save(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  await ready(repo);
  const changes = await repo.changes();
  if (!changes.length) { ui.text('没有未完成修改，无需收起。'); return; }
  const previous = snapshot(changes);
  const state = await repositoryState(repo);
  ui.title('收起当前工作区');
  for (const change of changes) ui.text(change.label());
  ui.text('此操作保存整个工作区（不是按文件保存）。忽略文件不保存；记录属于仓库，不只属于当前分支。');
  let include = false;
  if (changes.some(change => change.index === '?')) include = await ui.confirm('同时收起以上未跟踪的新文件？不包含忽略文件。');
  if (!include && !changes.some(change => change.index !== '?')) {
    ui.text('只有未跟踪文件，且未选择包含它们；没有执行 stash。');
    return;
  }
  const message = await ui.ask('给这份未完成工作写一个说明', `${state.branch} 的未完成工作`);
  if (!await ui.routineConfirm('确认保存并从工作区移走上述范围的修改？')) return;
  await checkRepositoryState(repo, state);
  if (!sameChanges(previous, await repo.changes())) throw new GitError('选择期间工作区状态发生变化，请重新查看后操作。');
  const args = ['stash', 'push', '-m', message];
  if (include) args.push('--include-untracked');
  await repo.run(args, { interactive: true });
  ui.text('工作已收起。请查看状态确认；之后可选择恢复，记录不会自动删除。');
}

export async function restore(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  await ready(repo);
  if ((await repo.changes()).length) throw new GitError('恢复前工作区和暂存区必须干净，请先保存当前工作。');
  const state = await repositoryState(repo);
  const items = await records(repo);
  if (!items.length) { ui.text('没有收起的工作记录。'); return; }
  const choice = await ui.menu('选择要恢复的工作（恢复后仍保留记录）', items.map(([index, oid, message]) => `${index}  ${oid.slice(0, 8)}  ${message}`));
  if (!choice) return;
  const [, oid, message] = items[choice - 1];
  ui.text(`将恢复到当前 ${state.branch}：${message}\n记录：${oid}`);
  ui.text('会尝试恢复原暂存划分；冲突或失败可能已经产生部分修改，不会自动回滚或删除原记录。');
  if (!await ui.routineConfirm('确认恢复这份工作？')) return;
  await checkRepositoryState(repo, state);
  if ((await repo.changes()).length) throw new GitError('确认期间工作区有变化，已停止。');
  const result = await repo.run(['stash', 'apply', '--index', oid], { interactive: true, check: false });
  if (result.status) {
    ui.text('恢复未完整成功，工作区可能已有部分修改，原记录仍然保留。');
    if ((await repo.unmerged()).length) {
      ui.text('存在冲突：请进入“分支与合并 → 冲突处理”查看并逐个标记解决；这不是 merge，不能用 merge 中止。');
    } else ui.text('请查看 Git 原始提示和当前差异，不要反复恢复同一条记录。');
    return;
  }
  ui.text('恢复完成；原记录仍保留，确认内容无误后可另行删除。');
}

export async function drop(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  await ready(repo);
  const items = await records(repo);
  if (!items.length) { ui.text('没有可删除的记录。'); return; }
  const choice = await ui.menu('删除一份收起记录（不是删除工作区文件）', items.map(([index, oid, message]) => `${index}  ${oid.slice(0, 8)}  ${message}`));
  if (!choice) return;
  const item = items[choice - 1];
  ui.text(`将删除：${item[0]}  ${item[1]}  ${item[2]}`);
  if (!await ui.confirm('确定删除这条恢复记录？若尚未恢复，可能丢失这份未完成工作。')) return;
  const current = new Map((await records(repo)).map(([index, oid]) => [index, oid]));
  if (current.get(item[0]) !== item[1]) throw new GitError('记录列表已被其他操作改变，请重新选择；未删除。');
  await repo.run(['stash', 'drop', item[0]], { interactive: true });
  ui.text('已删除选定记录，没有清空其他 stash。');
}

export async function stashMenu(ui: Console, directory: Directory): Promise<void> {
  const choice = await ui.menu('临时收起 / 恢复未完成的工作', ['收起整个工作区', '查看收起记录', '恢复一份工作（保留记录）', '删除一条收起记录']);
  if (choice === 1) await save(ui, directory);
  else if (choice === 2) {
    const items = await records(await repository(directory));
    for (const [index, oid, message] of items) ui.text(`${index}  ${oid.slice(0, 8)}  ${message}`);
    if (!items.length) ui.text('没有收起的工作记录。');
  } else if (choice === 3) await restore(ui, directory);
  else if (choice === 4) await drop(ui, directory);
}
