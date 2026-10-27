/** Git's on-disk sequencers are authoritative. No replacement operation API or auto-stash. */
import { lstat, readFile } from 'node:fs/promises';
import { Change, Git, GitError, decodePath, splitNul } from './git.js';
import { displayPaths, localRepository, pathInput, repositoryStamp, requireIdle, resolveCommit, selectCommit, verifyRepositoryStamp, type Directory } from './destructive.js';
import { protectAccountData } from './workflows.js';
import type { Console } from './ui.js';

export interface OperationState { readonly kind: string; readonly markers: readonly string[]; readonly actions: readonly string[] }
const KNOWN = ['rebase-merge', 'rebase-apply', 'rebase-apply/applying', 'rebase-apply/rebasing', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'BISECT_LOG', 'BISECT_START', 'MERGE_HEAD', 'MERGE_AUTOSTASH'];
async function present(repo: Git, marker: string): Promise<boolean> { try { await lstat(await repo.gitPath(marker)); return true; } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; } }
export async function operationState(repo: Git): Promise<{ kind: string; markers: readonly string[]; actions: readonly string[] }> {
  const markers: string[] = [];
  for (const marker of KNOWN) if (await present(repo, marker)) markers.push(marker);
  const has = (marker: string) => markers.includes(marker);
  let kind = 'none';
  if (has('rebase-merge') || has('rebase-apply/rebasing')) kind = 'rebase';
  else if (has('rebase-apply/applying')) kind = 'am';
  // An incomplete apply directory proves an operation exists but not whether
  // git am or rebase --apply owns it. Never guess a destructive control command.
  else if (has('rebase-apply')) kind = 'sequencer';
  else if (has('CHERRY_PICK_HEAD')) kind = 'cherry-pick';
  else if (has('REVERT_HEAD')) kind = 'revert';
  else if (has('sequencer')) {
    let todo = '';
    try { todo = await readFile(await repo.gitPath('sequencer/todo'), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const command = todo.split('\n').find(line => line.trim() && !line.trimStart().startsWith('#'))?.trim().split(/\s/u)[0];
    kind = command === 'pick' ? 'cherry-pick' : command === 'revert' ? 'revert' : 'sequencer';
  } else if (has('MERGE_HEAD')) kind = 'merge';
  else if (has('BISECT_LOG') || has('BISECT_START')) kind = 'bisect';
  else if (has('MERGE_AUTOSTASH')) kind = 'sequencer'; // No MERGE_HEAD: merge --continue/--abort are not valid.
  const actions = kind === 'none' || kind === 'sequencer' ? [] : kind === 'bisect' ? ['good', 'bad', 'skip', 'reset'] : kind === 'merge' ? ['continue', 'abort'] : ['continue', 'skip', 'abort'];
  return { kind, markers, actions };
}
async function startReady(repo: Git): Promise<void> {
  await requireIdle(repo);
  if (!await repo.hasCommits()) throw new GitError('此操作需要已有提交。');
  if ((await repo.changes()).length) throw new GitError('开始操作前请保存或自行 stash 未提交修改；不会自动 stash、备份或覆盖工作区。');
}
async function report(ui: Console, repo: Git): Promise<void> {
  const state = await operationState(repo);
  ui.text(`当前操作：${state.kind}；marker：${state.markers.join('、') || '无'}。`);
  const paths = await repo.unmerged();
  if (paths.length) { ui.text('冲突已原地保留；未自动暂存/跳过/中止：'); displayPaths(ui, paths); }
}
async function runOperation(ui: Console, repo: Git, args: string[]): Promise<void> {
  const result = await repo.run(args, { check: false, interactive: true });
  await report(ui, repo);
  if (result.status) {
    if ((await operationState(repo)).kind !== 'none') { ui.text('Git 尚未完成；操作状态已保留，请解决冲突后 continue，或明确 skip / abort。不会自动重试或 reset。'); return; }
    throw new GitError('Git 操作未完成；请查看终端提示，没有自动回滚或清理。');
  }
}
async function mainline(ui: Console, repo: Git, oid: string, supplied?: number): Promise<string[]> {
  const parents = (await repo.value('show', '-s', '--format=%P', oid)).split(/\s+/u).filter(Boolean);
  if (parents.length < 2) return [];
  const selected = supplied ?? await ui.menu('这是合并提交，选择主线父提交（-m）', parents.map((parent, index) => `父 ${index + 1}：${parent}`));
  if (!selected) return ['cancel'];
  if (!Number.isInteger(selected) || selected < 1 || selected > parents.length) throw new GitError('主线父提交编号无效。');
  return ['-m', String(selected)];
}
export interface CommitOperationOptions {
  /** Existing single-commit API and UI remain unchanged. */
  readonly commit?: string;
  /** Apply exactly this supplied order, resolving every ref before confirmation. */
  readonly commits?: readonly string[];
  /** Git A..B reachability: exclude A and its ancestors, include B. */
  readonly range?: string | Readonly<{ from: string; to: string }>;
  readonly mainline?: number;
}
export async function commitSequence(repo: Git, kind: 'revert' | 'cherry-pick', options: CommitOperationOptions): Promise<readonly string[]> {
  if (!['revert', 'cherry-pick'].includes(kind)) throw new GitError('提交操作类型无效。');
  const count = [options.commit !== undefined, options.commits !== undefined, options.range !== undefined].filter(Boolean).length;
  if (count !== 1) throw new GitError('请明确选择单个提交、固定提交列表或一个区间，不能混用。');
  let commits: string[];
  if (options.range !== undefined) {
    let from: string, to: string;
    if (typeof options.range === 'string') {
      const match = options.range.includes('...') ? [] : options.range.split('..');
      if (match.length !== 2 || !match[0] || !match[1]) throw new GitError('只接受明确的 A..B 区间（A 排除、B 包含），不接受 ... 或开放端点。');
      [from, to] = match;
    } else { from = options.range.from; to = options.range.to; }
    const fromOid = await resolveCommit(repo, from), toOid = await resolveCommit(repo, to);
    const result = await repo.run(['rev-list', '--topo-order', ...kind === 'cherry-pick' ? ['--reverse'] : [], `${fromOid}..${toOid}`, '--']);
    commits = result.stdout.toString('ascii').trim().split(/\s+/u).filter(Boolean);
  } else {
    const requested = options.commits !== undefined ? [...options.commits] : [options.commit!];
    commits = [];
    for (const value of requested) commits.push(await resolveCommit(repo, value));
  }
  if (!commits.length) throw new GitError('所选列表/区间没有提交，未开始操作。');
  return commits;
}
async function sequenceMainline(ui: Console, repo: Git, commits: readonly string[], supplied?: number): Promise<string[]> {
  const parents: string[] = [];
  for (const oid of commits) parents.push(await repo.value('show', '-s', '--format=%P', oid));
  const merge = parents.findIndex(value => value.split(/\s+/u).filter(Boolean).length > 1);
  if (merge < 0) return [];
  const args = await mainline(ui, repo, commits[merge], supplied);
  if (args[0] === 'cancel') return args;
  const selected = Number(args[1]);
  if (parents.some(value => value.split(/\s+/u).filter(Boolean).length < selected && selected > 1)) throw new GitError('这个批次不能共用所选主线父编号；请拆成各自适用主线父的批次，尚未执行任何提交。');
  return args;
}
export async function startCommitOperation(ui: Console, directory: Directory, kind: 'revert' | 'cherry-pick', options: CommitOperationOptions = {}): Promise<void> {
  if (!['revert', 'cherry-pick'].includes(kind)) throw new GitError('提交操作类型无效。');
  const repo = await localRepository(directory); await startReady(repo); await repo.ensureIdentity();
  const requested = options.commit !== undefined || options.commits !== undefined || options.range !== undefined
    ? options : { ...options, commit: await selectCommit(ui, repo, `选择 ${kind} 的本地提交`) };
  if (!requested.commit && requested.commits === undefined && requested.range === undefined) return;
  const commits = await commitSequence(repo, kind, requested);
  const parentArgs = await sequenceMainline(ui, repo, commits, options.mainline); if (parentArgs[0] === 'cancel') return;
  const stamp = await repositoryStamp(repo);
  ui.text(`${kind}：${commits.length} 个固定提交，严格按以下顺序执行：`);
  for (const [index, oid] of commits.entries()) ui.text(`  ${index + 1}. ${oid} | ${JSON.stringify(await repo.value('show', '-s', '--format=%s', oid))}`);
  ui.text(`${options.range !== undefined ? `区间已预先展开；${kind === 'cherry-pick' ? '父提交优先（旧→新）' : '子提交优先（新→旧）'}，确认后不再解析原引用/区间。\n` : ''}${kind === 'revert' ? '逐个创建反向修改的新提交，不删除原历史。' : '将这些提交的修改依次重放到当前 HEAD，逐个创建新提交。'}\n${parentArgs.length ? `整个批次使用主线父：${parentArgs[1]}。` : ''}不会联网、自动 stash 或 push；发生冲突会保留整个 Git sequencer，可 continue / skip / abort；abort 恢复批次开始前 HEAD。`);
  if (!await ui.confirm(`确认开始 ${kind}？`)) return;
  await verifyRepositoryStamp(repo, stamp); await startReady(repo);
  // Pass only already resolved hex OIDs, never revision expressions. Keeping
  // stdin inherited preserves the existing native terminal/Ctrl+C handoff.
  // --no-walk=unsorted keeps the previewed order rather than date-sorting it.
  await runOperation(ui, repo, ['-c', 'submodule.recurse=false', kind, '--no-edit', ...parentArgs, ...commits.length > 1 ? ['--no-walk=unsorted'] : [], ...commits]);
}
export async function startCommitSequence(ui: Console, directory: Directory, kind: 'revert' | 'cherry-pick'): Promise<void> {
  const repo = await localRepository(directory); await startReady(repo);
  const choice = await ui.menu(`${kind} 多提交选择`, ['按指定顺序输入多个本地提交 / OID / 引用', '选择 A..B 区间（排除 A，包含 B）']);
  if (!choice) return;
  if (choice === 1) {
    const commits = (await ui.ask('按执行顺序输入提交，以空格或逗号分隔')).split(/[\s,，]+/u).filter(Boolean);
    await startCommitOperation(ui, repo, kind, { commits });
  } else {
    const from = await selectCommit(ui, repo, '选择区间起点 A（排除 A 及其祖先）'); if (!from) return;
    const to = await selectCommit(ui, repo, '选择区间终点 B（包含 B）'); if (!to) return;
    await startCommitOperation(ui, repo, kind, { range: { from, to } });
  }
}
export async function startRebase(ui: Console, directory: Directory, options: { upstream?: string; interactive?: boolean } = {}): Promise<void> {
  const repo = await localRepository(directory); await startReady(repo); await repo.ensureIdentity();
  const oid = options.upstream ? await resolveCommit(repo, options.upstream) : await selectCommit(ui, repo, '选择 rebase 的本地基准提交'); if (!oid) return;
  let interactive = options.interactive;
  if (interactive === undefined) { const choice = await ui.menu('rebase 方式', ['普通 rebase', '交互 todo（交接 Git 原生编辑器，可 pick/reword/edit/squash/fixup/drop）']); if (!choice) return; interactive = choice === 2; }
  const stamp = await repositoryStamp(repo);
  ui.text(`rebase 基准：${oid}\n会重写当前分支/游离 HEAD 上待重放提交的 OID，不更新其他分支、不自动 stash、不联网。${interactive ? '\n交互 todo 使用 Git 配置的 sequence.editor / GIT_SEQUENCE_EDITOR / core.editor；需要可工作的本机编辑器，终端将交给原生 Git。todo 中 exec/break 等由 Git 原生执行，只使用自己信任的指令。编辑器退出后可在此中心继续/跳过/中止。' : ''}`);
  if (!await ui.confirm('确认开始重写本地历史的 rebase？')) return;
  await verifyRepositoryStamp(repo, stamp); await startReady(repo);
  await runOperation(ui, repo, ['-c', 'submodule.recurse=false', '-c', 'rebase.updateRefs=false', 'rebase', '--no-autostash', ...interactive ? ['--interactive'] : [], oid]);
}
export async function controlOperation(ui: Console, directory: Directory, action: 'continue' | 'skip' | 'abort' | 'good' | 'bad' | 'reset'): Promise<void> {
  const repo = await localRepository(directory);
  const state = await operationState(repo);
  if (!state.actions.includes(action)) throw new GitError(`当前 ${state.kind} 不支持 ${action}，未猜测操作或执行 reset 兜底。`);
  if (action === 'continue') {
    if ((await repo.unmerged()).length) throw new GitError('仍有未解决冲突，请先选择正确内容并标记 resolved。');
    await repo.ensureIdentity();
    await protectAccountData(repo, (await repo.changes()).filter(change => change.staged));
  }
  const stamp = await repositoryStamp(repo);
  ui.text(`操作：${state.kind} ${action}\n${action === 'abort' ? '将丢弃本次操作中的解决修改并尝试恢复开始前状态；失败时保留 Git 结果，不用 reset 兜底。' : action === 'skip' ? state.kind === 'bisect' ? '将当前提交标为无法测试，推进二分检查；不运行项目代码。' : '将跳过当前提交/补丁并丢弃它的解决修改。' : action === 'reset' ? '结束 bisect，Git 尝试回到开始前的分支/提交。' : action === 'continue' ? '使用现有暂存结果继续，不自动 add 全部；提交信息沿用 Git 当前信息。' : '仅按你明确给出的测试结果推进二分检查，不运行项目代码。'}`);
  const routine = action === 'continue' || state.kind === 'bisect' && ['good', 'bad', 'skip'].includes(action);
  if (!(routine ? await ui.routineConfirm(`确认 ${state.kind} ${action}？`) : await ui.confirm(`确认 ${state.kind} ${action}？`))) return;
  await verifyRepositoryStamp(repo, stamp);
  const now = await operationState(repo);
  if (JSON.stringify(now) !== JSON.stringify(state)) throw new GitError('操作状态变化，请重新预览。');
  if (action === 'continue') await protectAccountData(repo, (await repo.changes()).filter(change => change.staged));
  await runOperation(ui, repo, ['-c', 'core.editor=true', '-c', 'submodule.recurse=false', ...state.kind === 'bisect' ? ['bisect', action] : [state.kind, `--${action}`]]);
}
export async function startBisect(ui: Console, directory: Directory, options: { good?: string; bad?: string } = {}): Promise<void> {
  const repo = await localRepository(directory); await startReady(repo);
  const bad = options.bad ? await resolveCommit(repo, options.bad) : await selectCommit(ui, repo, '选择已确认 bad 的提交'); if (!bad) return;
  const good = options.good ? await resolveCommit(repo, options.good) : await selectCommit(ui, repo, '选择已确认 good 的提交'); if (!good) return;
  if (good === bad || (await repo.run(['merge-base', '--is-ancestor', good, bad], { check: false })).status) throw new GitError('good 必须是 bad 的不同祖先提交。');
  const stamp = await repositoryStamp(repo);
  ui.text(`bisect bad：${bad}\nbisect good：${good}\nGit 会临时进入游离 HEAD；请自行检查每个版本并选择 good/bad/skip；不自动执行仓库脚本。reset 可结束并回原分支。`);
  if (!await ui.confirm('确认开始本地 bisect？')) return;
  await verifyRepositoryStamp(repo, stamp); await startReady(repo);
  await runOperation(ui, repo, ['-c', 'submodule.recurse=false', 'bisect', 'start', bad, good]);
}
export interface ConflictEntry { readonly path: string; readonly stages: Readonly<Record<string, { mode: string; oid: string }>> }
export async function conflictEntries(repo: Git): Promise<ConflictEntry[]> {
  const entries = new Map<string, Record<string, { mode: string; oid: string }>>();
  for (const raw of splitNul((await repo.run(['ls-files', '--unmerged', '-z'])).stdout)) {
    if (!raw.length) continue;
    const tab = raw.indexOf(9); const [mode, oid, stage] = raw.subarray(0, tab).toString('ascii').split(' ');
    if (tab < 0 || !['1', '2', '3'].includes(stage)) throw new GitError('无法识别冲突 stage。');
    const name = decodePath(raw.subarray(tab + 1)); const stages = entries.get(name) ?? {}; stages[stage] = { mode, oid }; entries.set(name, stages);
  }
  return [...entries].map(([name, stages]) => ({ path: name, stages }));
}
export async function resolveConflictFiles(ui: Console, directory: Directory, options: { paths?: readonly string[]; resolution?: 'ours' | 'theirs' | 'delete' | 'resolved' } = {}): Promise<void> {
  const repo = await localRepository(directory);
  const entries = await conflictEntries(repo);
  if (!entries.length) { ui.text('没有未解决文件。'); return; }
  const state = await operationState(repo);
  ui.text('stage 1=共同祖先，2=ours，3=theirs；每条路径可能只存在一侧。rename 冲突可能涉及多个路径，请逐一核对。二进制文件按完整 blob 选择，不做文本拼接。');
  ui.text(state.kind === 'rebase' ? '特别注意 rebase：ours 是新基准及已重放结果，theirs 是正在重放的原分支提交；不是日常“我的分支/对方分支”的直觉角色。' : '普通 merge：ours 是当前 HEAD 一侧，theirs 是被合并一侧；cherry-pick/revert 请以 stage OID 核对。');
  const selected = options.paths ? entries.filter(entry => options.paths!.includes(entry.path)) : (await ui.select(entries.map(entry => `${JSON.stringify(entry.path)} | ours ${entry.stages['2']?.oid || '删除'} | theirs ${entry.stages['3']?.oid || '删除'}`))).map(index => entries[index]);
  if (!selected.length) return;
  if (options.paths?.some(name => !selected.some(entry => entry.path === name))) throw new GitError('所选路径已不是冲突文件。');
  let resolution = options.resolution;
  if (!resolution) { const choice = await ui.menu('解决方式（所选路径）', ['选择 ours / stage 2 并标记 resolved', '选择 theirs / stage 3 并标记 resolved', '明确删除这些路径并标记 resolved', '已外部编辑完成，仅标记 resolved']); if (!choice) return; resolution = (['ours', 'theirs', 'delete', 'resolved'] as const)[choice - 1]; }
  if (!['ours', 'theirs', 'delete', 'resolved'].includes(resolution)) throw new GitError('冲突解决方式无效。');
  const stage = resolution === 'ours' ? '2' : resolution === 'theirs' ? '3' : '';
  if (stage && selected.some(entry => entry.stages[stage]?.mode === '160000')) throw new GitError('所选一侧为子模块，请外部解决后标记 resolved，不自动检出子模块内容。');
  const paths = selected.map(entry => entry.path);
  await protectAccountData(repo, paths.map(name => new Change('U', 'U', name)));
  const stamp = await repositoryStamp(repo);
  const selectingSide = resolution !== 'resolved';
  ui.text(`解决方式：${resolution}；${stage ? '若所选一侧不存在该路径，将按该侧的删除处理。' : ''}${selectingSide ? '将覆盖或删除所选工作区内容，暂存且标记 resolved。' : '使用当前外部编辑后的内容，仅暂存并标记 resolved，不覆盖或删除工作区内容。'} 不自动 continue/提交；选择一侧只保证字节来源，不保证逻辑正确。`); displayPaths(ui, paths);
  if (!(selectingSide ? await ui.confirm('确认覆盖/删除所选冲突内容并标记 resolved？') : await ui.routineConfirm('确认仅暂存当前解决内容并标记 resolved？'))) return;
  await verifyRepositoryStamp(repo, stamp);
  await protectAccountData(repo, paths.map(name => new Change('U', 'U', name)));
  const deleted = selected.filter(entry => resolution === 'delete' || !!stage && !entry.stages[stage]).map(entry => entry.path);
  const kept = selected.filter(entry => !deleted.includes(entry.path)).map(entry => entry.path);
  if (deleted.length) await repo.run(['rm', '--force', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { inputData: pathInput(deleted) });
  if (kept.length) {
    if (stage) await repo.run(['checkout-index', '--force', `--stage=${stage}`, '-z', '--stdin'], { inputData: pathInput(kept) });
    await repo.stagePaths(kept);
  }
  ui.text('所选路径已标记 resolved；请复核结果，再单独选择 continue。');
}
export async function operationsMenu(ui: Console, directory: string): Promise<void> {
  const repo = await localRepository(directory);
  const state = await operationState(repo); await report(ui, repo);
  const labels = ['查看冲突 stage / 选择 ours、theirs、删除 / 标记 resolved'];
  const actions: (() => Promise<void>)[] = [() => resolveConflictFiles(ui, repo)];
  if (state.kind === 'none') {
    labels.push('revert：创建反向提交', 'cherry-pick：重放单个提交', 'rebase：普通 / 原生交互 todo', 'bisect：good / bad 二分查找', 'cherry-pick：多个提交 / A..B 区间', 'revert：多个提交 / A..B 区间');
    actions.push(() => startCommitOperation(ui, repo, 'revert'), () => startCommitOperation(ui, repo, 'cherry-pick'), () => startRebase(ui, repo), () => startBisect(ui, repo), () => startCommitSequence(ui, repo, 'cherry-pick'), () => startCommitSequence(ui, repo, 'revert'));
  } else {
    for (const action of state.actions) { labels.push(`${state.kind} ${action}`); actions.push(() => controlOperation(ui, repo, action as Parameters<typeof controlOperation>[2])); }
    if (state.kind === 'sequencer') ui.text('无法从 sequencer/todo 安全判定具体命令；只提供冲突处理，不猜测继续/中止命令。');
  }
  const choice = await ui.menu('操作与冲突中心', labels); if (choice) await actions[choice - 1]();
}
