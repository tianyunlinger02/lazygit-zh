import { readFile } from 'node:fs/promises';
import { decodePath, Git, GitError, redact } from './git.js';
import { Console } from './ui.js';
import { boundGit } from './profiles.js';
import { protectAccountData, remoteContext, validateExistingRemote } from './workflows.js';
import { repositoryStamp, requireIdle, verifyRepositoryStamp } from './destructive.js';

type Directory = string | Git;
type Head = readonly [branch: string, oid: string];

export class BranchRef {
  constructor(readonly ref: string, readonly oid: string, readonly subject: string) {}

  get local(): boolean { return this.ref.startsWith('refs/heads/'); }
  get name(): string { return this.ref.slice(this.local ? 'refs/heads/'.length : 'refs/remotes/'.length); }
  label(): string { return `[${this.local ? '本地' : '远程缓存'}] ${this.name} | ${this.oid} | ${quote(this.subject)}`; }
}

function quote(value: string): string { return JSON.stringify(value); }

async function repository(directory: Directory): Promise<Git> {
  return (directory instanceof Git ? directory : await boundGit(directory)).repository();
}

async function current(repo: Git): Promise<string> {
  const result = await repo.run(['symbolic-ref', '--quiet', 'HEAD'], { check: false });
  return result.status === 0 ? decodePath(result.stdout).trim().replace(/^refs\/heads\//, '') : '';
}

async function head(repo: Git): Promise<Head> {
  const result = await repo.run(['rev-parse', '--verify', 'HEAD'], { check: false });
  return [await current(repo), result.status === 0 ? result.stdout.toString('ascii').trim() : ''];
}

function sameHead(left: Head, right: Head): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

async function ready(repo: Git, clean = true): Promise<Head> {
  await repo.ensureReady();
  if (clean && (await repo.changes()).length) {
    throw new GitError('合并前请先保存或手工 stash 未提交修改；不会自动 stash。');
  }
  const snapshot = await head(repo);
  if (clean && !snapshot[1]) throw new GitError('空仓库还没有提交，请先创建第一次提交。');
  return snapshot;
}

async function refs(repo: Git): Promise<BranchRef[]> {
  const result = await repo.run(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(subject)%00%(symref)%00', 'refs/heads/', 'refs/remotes/']);
  const resultRefs: BranchRef[] = [];
  for (const record of decodePath(result.stdout).split('\0\n')) {
    if (!record) continue;
    const fields = record.split('\0');
    if (fields.length !== 4) throw new GitError('无法识别 Git 分支列表，已停止操作。');
    const [ref, oid, subject, symref] = fields;
    if (!ref.startsWith('refs/remotes/') || !symref) resultRefs.push(new BranchRef(ref, oid, subject));
  }
  return resultRefs;
}

function sameRef(left: BranchRef, right: BranchRef): boolean {
  return left.ref === right.ref && left.oid === right.oid && left.subject === right.subject;
}

async function choose(ui: Console, title: string, options: BranchRef[]): Promise<BranchRef | undefined> {
  if (!options.length) throw new GitError('没有可用的分支；远程缓存为空时请单独选择 fetch，不会自动联网。');
  const choice = await ui.menu(title, options.map(ref => ref.label()));
  return choice ? options[choice - 1] : undefined;
}

async function describe(ui: Console, repo: Git, role: string, name: string, oid: string): Promise<void> {
  const summary = oid ? await repo.value('show', '-s', '--format=%s', oid) : '无提交';
  ui.text(`${role}：${name || '游离 HEAD'}\nOID：${oid || '无提交'}\n摘要：${quote(summary)}`);
}

async function verify(repo: Git, snapshot: Head, source?: BranchRef, clean = true): Promise<void> {
  await repo.ensureReady();
  if (!sameHead(await head(repo), snapshot) || (clean && (await repo.changes()).length)) {
    throw new GitError('确认期间 HEAD 或工作区状态发生变化，请重新预览。');
  }
  if (source) {
    const result = await repo.run(['rev-parse', '--verify', source.ref], { check: false });
    if (result.status || result.stdout.toString('ascii').trim() !== source.oid) {
      throw new GitError('来源分支在确认期间发生变化，请重新预览。');
    }
  }
}

async function newName(ui: Console, repo: Git, fallback = ''): Promise<string> {
  const name = await ui.ask('新分支名称', fallback);
  if (name.startsWith('-') || name === 'HEAD' || (await repo.run(['check-ref-format', `refs/heads/${name}`], { check: false })).status) {
    throw new GitError('分支名无效，请使用 feature/login 等普通名称。');
  }
  if ((await repo.run(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { check: false })).status === 0) {
    throw new GitError('这个本地分支已经存在，不会覆盖。');
  }
  return name;
}

export async function listBranches(ui: Console, directory: Directory): Promise<BranchRef[]> {
  const repo = await repository(directory);
  ui.text(`当前分支：${await current(repo) || '游离 HEAD（可查看或明确切回已有分支）'}`);
  const items = await refs(repo);
  for (const ref of items) ui.text(ref.label());
  if (!items.length) ui.text('还没有本地或远程缓存分支。');
  return items;
}

export async function switchBranch(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  await requireIdle(repo);
  await repo.ensureSupported();
  const snapshot = await head(repo);
  const contents = await repositoryStamp(repo);
  const target = await choose(ui, '选择本地分支', (await refs(repo)).filter(ref => ref.local));
  if (!target) return;
  if (target.name === snapshot[0]) {
    ui.text('已经在这个分支上，未执行切换。');
    return;
  }
  await describe(ui, repo, '来源', ...snapshot);
  await describe(ui, repo, '目标', target.name, target.oid);
  if (!await ui.routineConfirm(`确认切换到 ${target.name}？`)) return;
  await requireIdle(repo);
  if (!sameHead(await head(repo), snapshot) || !(await refs(repo)).some(ref => sameRef(ref, target))) {
    throw new GitError('确认期间仓库或目标分支发生变化，请重新预览。');
  }
  await repo.ensureSupported();
  await verifyRepositoryStamp(repo, contents);
  await repo.run(['switch', '--no-guess', '--no-overwrite-ignore', '--', target.name]);
  ui.text(`已切换到 ${target.name}。`);
}

export async function createBranch(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  const snapshot = await ready(repo, false);
  if (!snapshot[1]) throw new GitError('空仓库还没有提交，请先创建第一次提交。');
  const contents = await repositoryStamp(repo);
  const name = await newName(ui, repo);
  await describe(ui, repo, '来源', ...snapshot);
  await describe(ui, repo, '目标（新建）', name, snapshot[1]);
  if (await ui.routineConfirm(`从 ${snapshot[0]} 新建并切换到 ${name}？`)) {
    await verify(repo, snapshot, undefined, false);
    await verifyRepositoryStamp(repo, contents);
    await repo.run(['switch', '--no-overwrite-ignore', '--no-track', '-c', name]);
    ui.text(`已新建并切换到 ${name}，未继承上游。`);
  }
}

export async function trackRemote(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  const snapshot = await ready(repo, false);
  if (!snapshot[1]) throw new GitError('空仓库还没有提交，请先创建第一次提交。');
  const contents = await repositoryStamp(repo);
  const source = await choose(ui, '选择要跟踪的远程缓存分支', (await refs(repo)).filter(ref => !ref.local));
  if (!source) return;
  const name = await newName(ui, repo, source.name.slice(source.name.indexOf('/') + 1));
  await describe(ui, repo, '来源（缓存，非实时远程）', source.name, source.oid);
  await describe(ui, repo, '目标（新建本地分支）', name, source.oid);
  if (await ui.routineConfirm(`新建并切换到 ${name}，直接跟踪 ${source.name}？`)) {
    await verify(repo, snapshot, source, false);
    await verifyRepositoryStamp(repo, contents);
    await repo.run(['switch', '--no-overwrite-ignore', '--track', '-c', name, source.ref]);
    ui.text(`已跟踪 ${source.name}，未联网。`);
  }
}

export async function fetchRemote(ui: Console, directory: Directory): Promise<void> {
  let repo = await repository(directory);
  const snapshot = await ready(repo, false);
  const remotes = await repo.remotes();
  if (!remotes.length) throw new GitError('没有已配置的远程仓库。');
  const labels = await Promise.all(remotes.map(async name => `${name} → ${redact((await repo.remoteUrls(name)).join(', '))}`));
  const choice = await ui.menu('选择要 fetch 的远程', labels);
  if (!choice) return;
  const remote = remotes[choice - 1];
  const urls = await validateExistingRemote(repo, remote, false);
  repo = await remoteContext(ui, repo, urls);
  ui.text(`来源：${redact(urls[0])}\n目标：当前仓库的远程缓存；不 prune，不合并，不 stash，不 push。`);
  if (await ui.routineConfirm('确认单独联网 fetch 这个远程？')) {
    await verify(repo, snapshot, undefined, false);
    const currentUrls = await validateExistingRemote(repo, remote, false);
    if (urls.length !== currentUrls.length || urls.some((url, index) => url !== currentUrls[index])) {
      throw new GitError('确认期间远程地址发生变化，请重新预览。');
    }
    await repo.run(['fetch', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--', remote]);
    ui.text('fetch 已完成；工作区与当前分支没有自动合并。');
  }
}

export async function setUpstream(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  const snapshot = await ready(repo, false);
  if (!snapshot[1]) throw new GitError('当前分支还没有提交，不能设置上游。');
  const source = await choose(ui, '选择当前分支的上游（远程缓存）', (await refs(repo)).filter(ref => !ref.local));
  if (!source) return;
  await describe(ui, repo, '本地', ...snapshot);
  await describe(ui, repo, '上游目标（缓存）', source.name, source.oid);
  if (await ui.routineConfirm(`设置 ${snapshot[0]} 的上游为 ${source.name}？（不联网）`)) {
    await verify(repo, snapshot, source, false);
    await repo.run(['branch', `--set-upstream-to=${source.ref}`, '--', snapshot[0]]);
    ui.text('已设置上游；没有 fetch 或 push。');
  }
}

export async function mergeBranch(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  const snapshot = await ready(repo);
  const source = await choose(ui, '选择合并来源（远程分支仅使用本地缓存）', (await refs(repo)).filter(ref => ref.ref !== `refs/heads/${snapshot[0]}`));
  if (!source) return;
  await describe(ui, repo, '来源', source.name, source.oid);
  await describe(ui, repo, '目标（当前分支）', ...snapshot);
  const tree = await repo.run(['ls-tree', '-r', '-z', source.oid]);
  if (tree.stdout.toString('utf8').split('\0').some(entry => entry.startsWith('160000 '))) {
    ui.text('来源包含子模块：本次只合并 gitlink 指针，不递归更新子模块工作区；可在项目工具中单独更新。');
  }
  const base = await repo.run(['merge-base', snapshot[1], source.oid], { check: false });
  const ancestor = base.stdout.toString('ascii').trim();
  const unrelated = base.status === 1 && !ancestor && !base.stderr.toString('utf8').trim();
  if (base.status && !unrelated || !base.status && !ancestor) {
    throw new GitError('无法检查来源与目标的共同祖先，已停止；不会当作独立历史。\n' + redact(Git.output(base)));
  }
  const kind = unrelated ? '独立历史（没有共同祖先，需要明确允许）' : ancestor === source.oid ? '来源已包含（无需更新 HEAD）' : ancestor === snapshot[1] ? '可快进（实际遵循 Git 的 ff 配置）' : '非快进合并（需要合并提交；ff-only 配置将拒绝）';
  ui.text(`类型：${kind}\n来源相对当前 HEAD 的差异统计（不等同于最终合并结果）：`);
  ui.text(await repo.value('diff', '--no-ext-diff', '--no-textconv', '--stat', snapshot[1], source.oid) || '（无差异）');
  if (unrelated) {
    if (await ui.menu('来源与目标没有共同祖先', ['明确合并独立历史（仅本次允许无共同祖先）']) !== 1) return;
    ui.text(`将把 ${source.name} 的独立历史并入 ${snapshot[0]}；仅本次使用 --allow-unrelated-histories。无冲突时将创建包含双方历史的本地合并提交；若有冲突则保留现场，需另行解决并选择 continue。不会自动 stash、强制覆盖、丢弃修改或上传。`);
    if (!await ui.confirm('确认合并独立历史，并在无冲突时创建本地合并提交？')) return;
  } else if (!await ui.routineConfirm(`确认把 ${source.name} 合并到 ${snapshot[0]}？`)) return;
  await verify(repo, snapshot, source);
  const result = await repo.run(['merge', '--no-commit', '--no-edit', '--no-autostash', '--no-overwrite-ignore', ...unrelated ? ['--allow-unrelated-histories'] : [], source.oid], { check: false });
  if (result.status) {
    const paths = await repo.unmerged();
    if ((await markerBytes(repo)).length && paths.length) {
      ui.text('合并产生冲突，原地保留待处理；未自动暂存或提交。');
      ui.text(paths.map(path => `  ${quote(path)}`).join('\n'));
      return;
    }
    throw new GitError('合并未完成；没有自动重置。\n' + redact(Git.output(result)));
  }
  if ((await markerBytes(repo)).length) {
    ui.text('非快进合并结果已暂存，MERGE_HEAD 保留，尚未提交。');
    await commitMerge(ui, repo, `Merge ${source.name} into ${snapshot[0]}`, unrelated);
  } else {
    const after = await head(repo);
    if (after[1] !== snapshot[1]) ui.text(`快进成功，HEAD 已前进至 ${after[1]}；不是待提交的合并。`);
    else ui.text('已经包含来源提交，HEAD 没有变化。');
  }
}

async function conflictState(repo: Git, requireMerge = false): Promise<boolean> {
  await repo.ensureSupported();
  const operation = await repo.operation();
  if (operation && operation !== 'MERGE_HEAD') {
    throw new GitError(`当前为 ${operation}，只支持普通 MERGE_HEAD；不会自动恢复其他操作。`);
  }
  const merging = operation === 'MERGE_HEAD';
  if (requireMerge && !merging) throw new GitError('没有 MERGE_HEAD，不能继续合并或 merge --abort（包括 stash 冲突）。');
  return merging;
}

async function markerBytes(repo: Git): Promise<Buffer> {
  try { return await readFile(await repo.gitPath('MERGE_HEAD')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

type Stamp = { head: Head; operation: string; marker: Buffer; index: Buffer };

async function stamp(repo: Git): Promise<Stamp> {
  return {
    head: await head(repo), operation: await repo.operation(), marker: await markerBytes(repo),
    index: (await repo.run(['ls-files', '--stage', '-z'])).stdout,
  };
}

async function checkStamp(repo: Git, previous: Stamp): Promise<void> {
  const next = await stamp(repo);
  if (!sameHead(next.head, previous.head) || next.operation !== previous.operation || !next.marker.equals(previous.marker) || !next.index.equals(previous.index)) {
    throw new GitError('确认期间 HEAD、合并状态或暂存内容发生变化，请重新预览。');
  }
}

export async function resolveConflicts(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  await conflictState(repo);
  await repo.branch();
  const paths = await repo.unmerged();
  if (!paths.length) { ui.text('没有未解决的文件。'); return; }
  const snapshot = await stamp(repo);
  ui.text('请先在外部编辑文件，再按 ID 选择已解决项；内容逻辑正确性需要用户自行保证。');
  const selected = (await ui.select(paths.map(quote))).map(index => paths[index]);
  if (!selected.length) return;
  ui.text('仅标记这些路径：' + selected.map(quote).join('、'));
  if (await ui.routineConfirm('确认所选文件内容已正确解决，并仅暂存这些路径？')) {
    await checkStamp(repo, snapshot);
    const selectedPaths = new Set(selected);
    await protectAccountData(repo, (await repo.changes()).filter(change => selectedPaths.has(change.path)));
    await repo.stagePaths(selected);
    ui.text('所选文件已暂存并标记已解决；没有自动 add --all 或提交。');
  }
}

export async function continueMerge(ui: Console, directory: Directory, options: { message?: string } = {}): Promise<void> {
  await commitMerge(ui, directory, options.message);
}

async function commitMerge(ui: Console, directory: Directory, message?: string, confirmed = false): Promise<void> {
  const repo = await repository(directory);
  await conflictState(repo, true);
  const branch = await repo.branch();
  if ((await repo.unmerged()).length) throw new GitError('仍有未解决冲突，拒绝继续提交；请先外部编辑并按 ID 标记已解决。');
  await repo.ensureIdentity();
  await protectAccountData(repo, (await repo.changes()).filter(change => change.staged));
  const snapshot = await stamp(repo);
  ui.text('完整暂存区统计（未暂存内容不会自动加入）：');
  ui.text(await repo.value('diff', '--cached', '--no-ext-diff', '--no-textconv', '--stat') || '（无暂存差异）');
  if (!confirmed && !await ui.routineConfirm('确认创建这个本地合并提交？（不会上传）')) {
    ui.text('未提交；MERGE_HEAD 和当前解决结果仍保留，可在冲突中心继续或中止。');
    return;
  }
  await checkStamp(repo, snapshot);
  await protectAccountData(repo, (await repo.changes()).filter(change => change.staged));
  await repo.run(['-c', 'core.editor=true', 'commit', '-m', message || `Merge resolved conflicts into ${branch}`]);
  ui.text(`合并提交已创建：${(await head(repo))[1]}，尚未上传。`);
}

export async function abortMerge(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  await conflictState(repo, true);
  await repo.branch();
  const snapshot = await stamp(repo);
  ui.text('中止会丢弃本次合并的解决修改；不会执行 reset 兜底。');
  if (await ui.confirm('确认丢弃解决修改并执行 merge --abort？')) {
    await checkStamp(repo, snapshot);
    await repo.run(['merge', '--abort']);
    ui.text('合并已中止；没有执行 reset 或强制清理。');
  }
}

export async function conflictCenter(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  const merging = await conflictState(repo);
  const paths = await repo.unmerged();
  ui.text(merging ? '普通合并待处理。' : '没有 MERGE_HEAD；若为 stash 冲突，只能查看或标记已解决，不能继续/中止合并。');
  ui.text(paths.map((path, index) => `  ${index + 1}. ${quote(path)}`).join('\n') || '没有未解决文件。');
  if (!merging && !paths.length) return;
  const labels = ['查看冲突文件和差异', '选择已解决文件并暂存', '继续合并（预览后提交）', '中止合并（丢弃解决修改）'];
  const choice = await ui.menu('冲突中心', merging ? labels : labels.slice(0, 2));
  if (choice === 1) {
    ui.text((await repo.unmerged()).map(quote).join('\n') || '没有未解决文件。');
    ui.text(await repo.value('diff', '--no-ext-diff', '--no-textconv', '--stat') || '（无工作区差异）');
    ui.text(await repo.value('diff', '--no-ext-diff', '--no-textconv') || '（无工作区差异）');
  } else if (choice === 2) await resolveConflicts(ui, repo);
  else if (choice === 3) await continueMerge(ui, repo);
  else if (choice === 4) await abortMerge(ui, repo);
}

export async function deleteMergedBranch(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  const snapshot = await ready(repo, false);
  if (!snapshot[1]) throw new GitError('当前分支还没有提交，没有删除基准。');
  const target = await choose(ui, '选择已合并到当前分支的本地分支（未合并会拒绝）', (await refs(repo)).filter(ref => ref.local && ref.name !== snapshot[0]));
  if (!target) return;
  await describe(ui, repo, '待删除', target.name, target.oid);
  await describe(ui, repo, '明确删除基准（当前分支）', ...snapshot);
  if ((await repo.run(['merge-base', '--is-ancestor', target.oid, snapshot[1]], { check: false })).status) {
    throw new GitError('此分支未合并到当前分支，拒绝删除；不会使用 -D。');
  }
  if (await ui.confirm(`确认只用 branch -d 删除本地分支 ${target.name}？`)) {
    await verify(repo, snapshot, target, false);
    await repo.run(['branch', '-d', '--', target.name]);
    ui.text(`已删除本地分支 ${target.name}；没有删除远程分支。`);
  }
}

export async function renameBranch(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory); await repo.ensureReady();
  const oldName = await current(repo); if (!oldName) throw new GitError('当前处于游离 HEAD，不能直接改名；请先切换或新建分支。');
  const snapshot = await head(repo); const name = await newName(ui, repo);
  ui.text(`将把当前分支 ${oldName} 改名为 ${name}。本地提交和工作区不变；不会删除远程旧分支。`);
  if (!await ui.confirm('确认改名当前分支？')) return;
  await verify(repo, snapshot, undefined, false);
  if (await current(repo) !== oldName) throw new GitError('确认期间当前分支发生变化，未改名。');
  await repo.run(['branch', '-m', '--', name]); ui.text(`本地分支已改名：${oldName} → ${name}。远程分支未改名。`);
}

export async function forceDeleteBranch(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory); const snapshot = await ready(repo, false);
  const choices = (await refs(repo)).filter(ref => ref.local && ref.name !== snapshot[0]);
  const target = await choose(ui, '选择要强制删除的本地分支', choices); if (!target) return;
  const unique = await repo.value('log', '--oneline', `${snapshot[0]}..${target.name}`, '--').catch(() => '');
  ui.text(`待删除：${target.name}\n提交：${target.oid}\n未合并到当前分支的提交：\n${unique || '（无；可使用普通删除）'}\n不会删除远程分支。`);
  if (!await ui.confirm(`确认使用 branch -D 删除本地分支 ${target.name}？`)) return;
  await verify(repo, snapshot, target, false);
  await repo.run(['branch', '-D', '--', target.name]); ui.text(`已强制删除本地分支 ${target.name}；远程分支未改变。`);
}

export async function branchesMenu(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  ui.text(`当前分支：${await current(repo) || '游离 HEAD（可查看或明确切回已有分支）'}`);
  const actions = [switchBranch, createBranch, listBranches, fetchRemote, trackRemote, setUpstream, mergeBranch, conflictCenter, deleteMergedBranch];
  const choice = await ui.menu('分支与合并', ['切换到已有本地分支', '新建并切换分支', '查看本地/远程缓存分支', '远程 fetch（单独联网确认）', '跟踪远程缓存分支', '设置当前分支上游', '合并其他本地/缓存远程分支', '冲突中心', '删除已合并本地分支', '改名当前本地分支', '强制删除未合并本地分支', '删除远程分支', '进行中的操作中心']);
  if (choice <= actions.length && choice) await actions[choice - 1](ui, repo);
  else if (choice === 10) await renameBranch(ui, repo);
  else if (choice === 11) await forceDeleteBranch(ui, repo);
  else if (choice === 12) { const { deleteRemoteBranch } = await import('./remotes.js'); await deleteRemoteBranch(ui, repo.directory); }
  else if (choice === 13) { const { operationsMenu } = await import('./operations.js'); await operationsMenu(ui, repo.directory); }
}
