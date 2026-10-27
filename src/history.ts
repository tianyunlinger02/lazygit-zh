/** Offline commit/reflog browsing and non-overwriting recovery branches. */
import { Git, GitError, decodePath } from './git.js';
import { localRepository, repositoryStamp, resolveCommit, verifyRepositoryStamp, type Directory } from './destructive.js';
import type { Console } from './ui.js';

export interface CommitEntry { readonly oid: string; readonly short: string; readonly date: string; readonly subject: string }
function records(raw: Buffer, width: number): string[][] {
  return decodePath(raw).split('\0\n').filter(Boolean).map(record => {
    const fields = record.replace(/\n$/u, '').split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length !== width) throw new GitError('无法识别历史记录输出。');
    return fields;
  });
}
export async function commitPage(repo: Git, options: { skip?: number; limit?: number; search?: string; ref?: string } = {}): Promise<CommitEntry[]> {
  const skip = options.skip ?? 0, limit = options.limit ?? 20;
  if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GitError('历史分页参数无效。');
  if (!await repo.hasCommits() && !options.ref) return [];
  const ref = options.ref ? await resolveCommit(repo, options.ref) : undefined;
  const result = await repo.run(['log', `--skip=${skip}`, `--max-count=${limit}`, '--date=iso-strict', '--format=%H%x00%h%x00%ad%x00%s%x00', ...options.search ? ['--fixed-strings', '--regexp-ignore-case', `--grep=${options.search}`] : [], ...ref ? [ref] : ['--all', 'HEAD'], '--']);
  return records(result.stdout, 4).map(([oid, short, date, subject]) => ({ oid, short, date, subject }));
}
function label(entry: CommitEntry): string { return `${entry.short} | ${entry.date} | ${JSON.stringify(entry.subject)}`; }
export async function chooseCommit(ui: Console, repo: Git, title = '选择本地提交'): Promise<string | undefined> {
  let skip = 0, search = '';
  for (;;) {
    const entries = await commitPage(repo, { skip, search });
    const choice = await ui.menu(`${title}（第 ${Math.floor(skip / 20) + 1} 页${search ? `；搜索 ${JSON.stringify(search)}` : ''}）`, [...entries.map(label), '下一页', '上一页', '搜索提交说明（固定文本）', '手工输入提交 / 引用']);
    if (!choice) return undefined;
    if (choice <= entries.length) return entries[choice - 1].oid;
    if (choice === entries.length + 1) { if (entries.length === 20) skip += 20; else ui.text('已经到最后一页。'); }
    else if (choice === entries.length + 2) skip = Math.max(0, skip - 20);
    else if (choice === entries.length + 3) { search = await ui.ask('搜索说明（空白清除）', '', { allowEmpty: true }); skip = 0; }
    else return resolveCommit(repo, await ui.ask('本地提交 / 引用（如 HEAD~2）'));
  }
}
export async function commitDetails(ui: Console, directory: Directory, commit?: string): Promise<void> {
  const repo = await localRepository(directory);
  const oid = commit ? await resolveCommit(repo, commit) : await chooseCommit(ui, repo); if (!oid) return;
  const metadata = await repo.run(['show', '--no-patch', '--format=%H%x00%P%x00%an <%ae>%x00%aI%x00%B', oid, '--']);
  const fields = decodePath(metadata.stdout).split('\0');
  ui.text(`提交：${fields[0]}\n父提交：${fields[1]}\n作者：${JSON.stringify(fields[2])}\n时间：${fields[3]}\n说明：${JSON.stringify(fields.slice(4).join('\0').trimEnd())}`);
  ui.text((await repo.run(['show', '--format=', '--stat', '--no-ext-diff', '--no-textconv', '--no-renames', oid, '--'])).stdout.toString('utf8') || '（无文件差异）');
  if (await ui.menu('提交详情', ['查看完整补丁'])) await repo.run(['show', '--format=', '--no-ext-diff', '--no-textconv', '--no-color', oid, '--'], { interactive: true });
}
export async function browseHistory(ui: Console, directory: Directory): Promise<void> {
  const repo = await localRepository(directory);
  const oid = await chooseCommit(ui, repo, '历史分页 / 搜索 / 提交详情'); if (oid) await commitDetails(ui, repo, oid);
}
export async function historyGraph(ui: Console, directory: Directory): Promise<void> {
  const repo = await localRepository(directory);
  if (!await repo.hasCommits()) { ui.text('还没有提交记录。'); return; }
  let skip = 0;
  for (;;) {
    const result = await repo.run(['log', '--graph', '--all', 'HEAD', '--decorate=short', '--no-color', `--skip=${skip}`, '--max-count=30', '--format=%h %d %s', '--']);
    // Quote controls while preserving native Git graph line layout.
    ui.text(decodePath(result.stdout).split('\n').map(line => JSON.stringify(line).slice(1, -1)).join('\n') || '（无更多记录）');
    const choice = await ui.menu(`本地历史图（第 ${Math.floor(skip / 30) + 1} 页；远程仅缓存）`, ['下一页', '上一页']);
    if (!choice) return; skip = choice === 1 ? skip + 30 : Math.max(0, skip - 30);
  }
}
export interface ReflogEntry { readonly oid: string; readonly selector: string; readonly subject: string }
export async function reflogPage(repo: Git, options: { skip?: number; limit?: number } = {}): Promise<ReflogEntry[]> {
  const skip = options.skip ?? 0, limit = options.limit ?? 20;
  if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GitError('reflog 分页参数无效。');
  if (!await repo.hasCommits()) return [];
  return records((await repo.run(['reflog', 'show', `--skip=${skip}`, `--max-count=${limit}`, '--format=%H%x00%gD%x00%gs%x00', 'HEAD', '--'])).stdout, 3).map(([oid, selector, subject]) => ({ oid, selector, subject }));
}
export async function recoverBranch(ui: Console, directory: Directory, options: { commit?: string; name?: string } = {}): Promise<void> {
  const repo = await localRepository(directory);
  const oid = options.commit ? await resolveCommit(repo, options.commit) : await chooseCommit(ui, repo, '选择恢复提交'); if (!oid) return;
  const name = options.name ?? await ui.ask('恢复用新分支名称', 'recovery');
  if (!name || name.startsWith('-') || name === 'HEAD' || (await repo.run(['check-ref-format', `refs/heads/${name}`], { check: false })).status) throw new GitError('恢复分支名无效。');
  if (!(await repo.run(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { check: false })).status) throw new GitError('恢复分支已存在，不会覆盖。');
  const stamp = await repositoryStamp(repo);
  ui.text(`恢复提交：${oid}\n新分支：${JSON.stringify(name)}\n只创建新分支，不切换，不覆盖文件，不移动当前 HEAD；reflog 可能过期。`);
  if (!await ui.confirm('确认创建这个恢复分支？')) return;
  await verifyRepositoryStamp(repo, stamp);
  await repo.run(['branch', '--no-track', '--', name, oid]); ui.text('恢复分支已创建；当前工作区保持原样。');
}
export async function browseReflog(ui: Console, directory: Directory): Promise<void> {
  const repo = await localRepository(directory); let skip = 0;
  ui.text('reflog 是本地 HEAD 移动记录，不是永久备份；失去引用的提交可能被回收。');
  for (;;) {
    const entries = await reflogPage(repo, { skip });
    const choice = await ui.menu(`HEAD reflog（第 ${Math.floor(skip / 20) + 1} 页，选记录恢复新分支）`, [...entries.map(entry => `${entry.selector} | ${entry.oid} | ${JSON.stringify(entry.subject)}`), '下一页', '上一页']);
    if (!choice) return;
    if (choice <= entries.length) { await recoverBranch(ui, repo, { commit: entries[choice - 1].oid }); return; }
    if (choice === entries.length + 1) { if (entries.length === 20) skip += 20; else ui.text('已到最后一页。'); }
    else skip = Math.max(0, skip - 20);
  }
}
export async function historyMenu(ui: Console, directory: string): Promise<void> {
  const actions = [browseHistory, historyGraph, browseReflog];
  const choice = await ui.menu('历史与恢复', ['历史分页 / 搜索 / 提交详情', '本地历史图（分支、合并、远程缓存）', 'reflog 与恢复到新分支']);
  if (choice) await actions[choice - 1](ui, directory);
}
