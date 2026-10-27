/** Explicit local index/worktree edits. Confirmation never uses quick-mode shortcuts. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { Change, Git, GitError, decodePath, encodePath, splitNul } from './git.js';
import { appDataDir, boundGit } from './profiles.js';
import { protectAccountData } from './workflows.js';
import type { Console } from './ui.js';

export type Directory = string | Git;
export type CleanScope = 'untracked' | 'ignored' | 'all';
export type RestoreTarget = 'worktree' | 'index' | 'both';
const MARKERS = ['MERGE_HEAD', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'BISECT_START', 'rebase-merge', 'rebase-apply', 'sequencer'];
const nul = Buffer.from([0]);
export function pathInput(paths: readonly string[]): Buffer { return Buffer.concat([...new Set(paths)].flatMap(name => [encodePath(name), nul])); }
export async function localRepository(directory: Directory): Promise<Git> { return (directory instanceof Git ? directory : await boundGit(directory)).repository(); }
function missing(error: unknown): boolean { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''); }
function within(file: string, parent: string): boolean { const relative = path.relative(parent, file); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function dataPath(): string { return path.resolve(appDataDir()); }
export function displayPaths(ui: Console, paths: readonly string[]): void { paths.forEach(name => ui.text(`  ${JSON.stringify(name)}`)); }

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
  const protectedData = dataPath(); hash.update(protectedData);
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
export async function requireIdle(repo: Git): Promise<void> { if (await repo.operation()) throw new GitError('有进行中的 Git 操作，请先进入操作与冲突中心；没有自动中止或重置。'); if ((await repo.unmerged()).length) throw new GitError('仍有未解决冲突，请先处理冲突。'); }
export async function resolveCommit(repo: Git, value: string): Promise<string> {
  const result = await repo.run(['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`], { check: false });
  if (result.status) throw new GitError('目标不是可用的本地提交；不会联网获取或猜测。');
  return result.stdout.toString('ascii').trim();
}
export async function selectCommit(ui: Console, repo: Git, title = '选择本地提交'): Promise<string | undefined> {
  const { chooseCommit } = await import('./history.js');
  return chooseCommit(ui, repo, title);
}
async function protectPaths(repo: Git, paths: readonly string[]): Promise<void> {
  const data = dataPath();
  if (paths.some(name => { const location = path.resolve(repo.directory, name); return within(location, data) || within(data, location); })) throw new GitError('所选路径包含 AutoGit data 或其祖先，拒绝覆盖/暂存资料内容。');
  await protectAccountData(repo, paths.map(name => new Change('M', ' ', name)));
}
async function chosenChanges(ui: Console, repo: Git, staged: boolean, explicit?: readonly string[]): Promise<string[]> {
  const changes = (await repo.changes()).filter(change => staged ? change.staged : change.unstaged);
  if (explicit) {
    const requested = new Set(explicit);
    const matches = changes.filter(change => requested.has(change.path) || change.original !== undefined && requested.has(change.original));
    if (explicit.some(name => !matches.some(change => change.path === name || change.original === name))) throw new GitError('所选路径不在当前可操作文件列表，请重新预览。');
    return [...new Set(matches.flatMap(change => [change.path, ...change.original ? [change.original] : []]))];
  }
  if (!changes.length) { ui.text(staged ? '没有已暂存文件。' : '没有未暂存修改。'); return []; }
  return [...new Set((await ui.select(changes.map(change => change.label()))).flatMap(index => [changes[index].path, ...changes[index].original ? [changes[index].original!] : []]))];
}
export async function stageFiles(ui: Console, directory: Directory, options: { paths?: readonly string[] } = {}): Promise<void> {
  const repo = await localRepository(directory);
  const selected = await chosenChanges(ui, repo, false, options.paths);
  // A previously staged rename has already removed its old name from index.
  // Passing that now-absent name to git add would reject the entire selection.
  const indexed = new Set(splitNul((await repo.run(['ls-files', '-z'])).stdout).filter(raw => raw.length).map(decodePath));
  const paths: string[] = [];
  for (const name of selected) {
    if (indexed.has(name)) { paths.push(name); continue; }
    try { await lstat(encodePath(path.resolve(repo.directory, name))); paths.push(name); } catch (error) { if (!missing(error)) throw error; }
  }
  if (!paths.length) return;
  await protectPaths(repo, paths);
  const stamp = await repositoryStamp(repo);
  ui.text('暂存以下完整工作区版本（包括删除；重命名的两端一起处理），不会提交：'); displayPaths(ui, paths);
  if (!await ui.confirm('确认仅暂存所选路径？')) return;
  await verifyRepositoryStamp(repo, stamp); await protectPaths(repo, paths);
  await repo.stagePaths(paths); ui.text('所选文件已暂存，未创建提交。');
}
export async function unstageFiles(ui: Console, directory: Directory, options: { paths?: readonly string[] } = {}): Promise<void> {
  const repo = await localRepository(directory);
  const paths = await chosenChanges(ui, repo, true, options.paths);
  if (!paths.length) return;
  const stamp = await repositoryStamp(repo);
  const committed = await repo.hasCommits();
  ui.text('仅将以下路径的暂存区恢复到 HEAD；空 HEAD 时从暂存区移除；实际文件保持不变：'); displayPaths(ui, paths);
  if (!await ui.confirm('确认取消这些路径的暂存？')) return;
  await verifyRepositoryStamp(repo, stamp);
  await repo.run(committed ? ['restore', '--source=HEAD', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'] : ['rm', '--cached', '-r', '--force', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], { inputData: pathInput(paths) });
  ui.text('已取消所选路径的暂存，工作区文件未删除。');
}
async function rejectGitlinks(repo: Git, paths: readonly string[], source?: string): Promise<void> {
  const records = splitNul((await repo.run(source ? ['ls-tree', '-r', '-z', source] : ['ls-files', '--stage', '-z'])).stdout);
  const links = records.filter(raw => raw.subarray(0, 7).equals(Buffer.from('160000 '))).map(raw => decodePath(raw.subarray(raw.indexOf(9) + 1)));
  if (links.some(name => paths.some(selected => selected === name || name.startsWith(`${selected}/`) || selected.startsWith(`${name}/`)))) throw new GitError('所选路径涉及子模块本身，请使用专门的子模块工具；其他普通文件仍可操作。');
}
export async function restoreFiles(ui: Console, directory: Directory, options: { source?: string; target?: RestoreTarget; paths?: readonly string[] } = {}): Promise<void> {
  const repo = await localRepository(directory);
  let source = options.source;
  if (source === undefined) { const choice = await ui.menu('还原来源', ['HEAD', '当前暂存区 index', '指定本地提交']); if (!choice) return; source = choice === 1 ? 'HEAD' : choice === 2 ? 'index' : await selectCommit(ui, repo); if (!source) return; }
  const oid = source === 'index' ? undefined : await resolveCommit(repo, source);
  let target = options.target;
  if (!target) { const choice = await ui.menu('还原目标', ['仅工作区 worktree', '仅暂存区 index', '暂存区和工作区 both']); if (!choice) return; target = (['worktree', 'index', 'both'] as const)[choice - 1]; }
  if (!['worktree', 'index', 'both'].includes(target)) throw new GitError('还原目标无效。');
  if (source === 'index' && target === 'index') { ui.text('来源与目标均为当前 index，无需修改。'); return; }
  const sourceNames = splitNul((await repo.run(oid ? ['ls-tree', '-r', '--name-only', '-z', oid] : ['ls-files', '-z'])).stdout).filter(raw => raw.length).map(decodePath);
  const changes = await repo.changes();
  const indexNames = splitNul((await repo.run(['ls-files', '-z'])).stdout).filter(raw => raw.length).map(decodePath);
  // Native restore can remove a currently indexed path absent from source, but
  // cannot restore a path absent from both source and index (pure untracked).
  const available = [...new Set(source === 'index' ? sourceNames : [...sourceNames, ...indexNames])].sort();
  let paths = options.paths ? [...new Set(options.paths)] : (await ui.select(available.map(name => JSON.stringify(name)))).map(index => available[index]);
  // A commit restore undoes the rename pair. An index→worktree restore must
  // instead keep the staged rename and restore only paths actually in index.
  if (source !== 'index') paths = [...new Set(paths.flatMap(name => { const rename = changes.find(change => change.original && [change.path, change.original].includes(name)); return rename ? [rename.path, rename.original!].filter(item => available.includes(item)) : [name]; }))];
  if (!paths.length) return;
  if (paths.some(name => !available.includes(name))) throw new GitError('所选路径不存在于来源/当前文件列表。');
  if (source === 'index' && paths.some(name => !sourceNames.includes(name))) throw new GitError('index 中没有所选路径，请改用 HEAD/提交来源或明确 clean 未跟踪文件。');
  await protectPaths(repo, paths); await rejectGitlinks(repo, paths); if (oid) await rejectGitlinks(repo, paths, oid);
  const stamp = await repositoryStamp(repo, paths);
  ui.text(`来源：${source === 'index' ? '当前 index' : oid}\n目标：${target}；覆盖目标中的未保存内容；来源没有的已跟踪路径会删除。HEAD 不移动。`); displayPaths(ui, paths);
  if (!await ui.confirm('确认丢弃目标内容并还原这些路径？')) return;
  await verifyRepositoryStamp(repo, stamp, paths); await protectPaths(repo, paths);
  const args = ['restore', ...oid ? [`--source=${oid}`] : [], ...target === 'index' ? ['--staged'] : target === 'both' ? source === 'index' ? ['--worktree'] : ['--staged', '--worktree'] : ['--worktree'], '--pathspec-from-file=-', '--pathspec-file-nul'];
  await repo.run(args, { inputData: pathInput(paths) }); ui.text('所选路径已还原；没有移动 HEAD。');
}
export async function resetTo(ui: Console, directory: Directory, options: { mode?: 'soft' | 'mixed' | 'hard'; commit?: string } = {}): Promise<void> {
  const repo = await localRepository(directory); await requireIdle(repo);
  const oid = options.commit ? await resolveCommit(repo, options.commit) : await selectCommit(ui, repo, '选择 reset 的目标提交'); if (!oid) return;
  let mode = options.mode;
  if (!mode) { const choice = await ui.menu('reset 模式', ['soft：只移动 HEAD，保留暂存区和工作区', 'mixed：移动 HEAD 并重置暂存区，保留工作区', 'hard：移动 HEAD 并重置暂存区和工作区']); if (!choice) return; mode = (['soft', 'mixed', 'hard'] as const)[choice - 1]; }
  if (!['soft', 'mixed', 'hard'].includes(mode)) throw new GitError('reset 模式无效。');
  let targets: string[] = [];
  if (mode === 'hard') {
    const targetTree = splitNul((await repo.run(['ls-tree', '-r', '--name-only', '-z', oid])).stdout).filter(raw => raw.length).map(decodePath);
    const currentTree = await repo.run(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { check: false });
    const headTree = currentTree.status === 0 ? splitNul(currentTree.stdout).filter(raw => raw.length).map(decodePath) : [];
    const indexTree = splitNul((await repo.run(['ls-files', '--stage', '-z'])).stdout).filter(raw => raw.length).map(raw => decodePath(raw.subarray(raw.indexOf(9) + 1)));
    targets = [...new Set([...targetTree, ...headTree, ...indexTree])];
    // hard reset can delete current index/HEAD content absent from the target;
    // protect the union, not just files that survive in the destination tree.
    await protectPaths(repo, targets);
  }
  const stamp = await repositoryStamp(repo, targets);
  ui.text(`reset --${mode} → ${oid}\n${mode === 'soft' ? '仅移动当前分支/游离 HEAD；index/worktree 保留。' : mode === 'mixed' ? '重置 index，保留实际工作区文件。' : '丢弃已跟踪的暂存及工作区修改。阻挡目标已跟踪路径的未跟踪文件/目录也可能被删除；不是“只删除已跟踪文件”。'}\n不会强制 stash、创建备份分支或联网；原提交通常可通过 reflog 查找。`);
  if (!await ui.confirm(`确认执行 reset --${mode}？`)) return;
  await verifyRepositoryStamp(repo, stamp, targets); await requireIdle(repo);
  if (mode === 'hard') await protectPaths(repo, targets);
  await repo.run(['-c', 'submodule.recurse=false', 'reset', `--${mode}`, oid]); ui.text(`reset --${mode} 已完成。`);
}

function pattern(value: string): string { return value.replace(/[\\*?[\]]/gu, '\\$&'); }
async function cleanExclusions(repo: Git, scope: CleanScope): Promise<string[]> {
  const data = dataPath();
  if (within(repo.directory, data)) throw new GitError('当前仓库位于 AutoGit data 内，拒绝 clean。');
  if (!within(data, repo.directory)) return [];
  const relative = path.relative(repo.directory, data).split(path.sep).join('/');
  // -X treats positive excludes as deletion candidates. Re-open each ignored
  // ancestor, then re-include its siblings before protecting the next component.
  // A lone !/parent/data cannot protect data when parent/ itself is ignored.
  if (scope !== 'ignored') return [`/${pattern(relative)}/`];
  const parts = relative.split('/'); const rules: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const name = parts.slice(0, i).join('/') + '/';
    const ignored = await repo.run(['--no-literal-pathspecs', 'check-ignore', '-z', '--stdin'], { check: false, inputData: pathInput(['./' + name]) });
    if (ignored.status === 0) { const ancestor = pattern(name.slice(0, -1)); rules.push(`!/${ancestor}/`, `/${ancestor}/*`); }
    else if (ignored.status !== 1) throw new GitError('无法核对 AutoGit data 祖先的忽略规则。');
  }
  rules.push(`!/${pattern(relative)}/`, `!/${pattern(relative)}/**`);
  return rules;
}
export interface CleanPreview { readonly paths: readonly string[]; readonly args: readonly string[]; readonly exclusions: readonly string[] }
export async function previewClean(repo: Git, scope: CleanScope, nested = false): Promise<CleanPreview> {
  if (!['untracked', 'ignored', 'all'].includes(scope)) throw new GitError('clean 范围无效。');
  const exclusions = await cleanExclusions(repo, scope);
  const args = ['clean', '-f', '-d', ...nested ? ['-f'] : [], ...scope === 'ignored' ? ['-X'] : scope === 'all' ? ['-x'] : [], ...exclusions.flatMap(value => ['-e', value])];
  // Native -n output is quoted, locale-dependent and not NUL-safe; never parse it.
  // Do not collapse directories: a collapsed name can hide an ignored child or
  // nested repository that a single -f would retain.
  const flags = [...scope === 'untracked' ? ['--exclude-standard'] : scope === 'ignored' ? ['--ignored', '--exclude-standard'] : [], ...exclusions.map(value => `--exclude=${value}`)];
  const candidates = splitNul((await repo.run(['ls-files', '--others', '-z', ...flags])).stdout).filter(raw => raw.length).map(decodePath);
  const paths: string[] = [], empty: string[] = [];
  const protectedData = dataPath();
  const nestedRepository = async (location: string): Promise<boolean> => {
    try { const info = await lstat(encodePath(path.join(location, '.git'))); return info.isDirectory() || info.isFile(); } catch (error) { if (!missing(error)) throw error; return false; }
  };
  for (const name of candidates) {
    const location = path.resolve(repo.directory, name);
    if (within(location, protectedData)) continue;
    if (name.endsWith('/') && await nestedRepository(location) && !nested) continue;
    paths.push(name);
  }
  const visitEmpty = async (name: string): Promise<void> => {
    const location = path.resolve(repo.directory, name);
    if (within(location, protectedData)) return;
    let info; try { info = await lstat(encodePath(location)); } catch (error) { if (missing(error)) return; throw error; }
    if (!info.isDirectory() || await nestedRepository(location)) return;
    const children = await readdir(encodePath(location), { encoding: 'buffer' });
    if (!children.length) empty.push(name.endsWith('/') ? name : name + '/');
    else for (const child of children) await visitEmpty(name.replace(/\/$/u, '') + '/' + decodePath(child));
  };
  for (const name of splitNul((await repo.run(['ls-files', '--others', '--directory', '-z', ...flags])).stdout).filter(raw => raw.length).map(decodePath)) if (name.endsWith('/')) await visitEmpty(name);
  if (empty.length) {
    const result = await repo.run(['--no-literal-pathspecs', 'check-ignore', '-z', '--stdin'], { check: false, inputData: pathInput(empty.map(name => './' + name)) });
    if (![0, 1].includes(result.status)) throw new GitError('无法核对空目录的 clean 范围。');
    const ignored = new Set(splitNul(result.stdout).map(raw => decodePath(raw).replace(/^\.\//u, '')));
    paths.push(...empty.filter(name => scope === 'all' || (scope === 'ignored') === ignored.has(name)));
  }
  return { paths: [...new Set(paths)].sort(), args, exclusions };
}
export async function cleanFiles(ui: Console, directory: Directory, options: { scope?: CleanScope; nested?: boolean } = {}): Promise<void> {
  const repo = await localRepository(directory); await requireIdle(repo);
  let scope = options.scope;
  if (!scope) { const choice = await ui.menu('clean 范围（永久删除，不能从 reflog 恢复）', ['-fd：未跟踪且未被忽略', '-fdX：仅被忽略的文件/目录', '-fdx：全部未跟踪（含忽略）']); if (!choice) return; scope = (['untracked', 'ignored', 'all'] as const)[choice - 1]; }
  let nested = options.nested;
  if (nested === undefined) { const choice = await ui.menu('嵌套仓库保护（独立于 clean 范围）', ['保留嵌套 Git 仓库（单 -f）', '也删除嵌套 Git 仓库（第二个 -f，含其历史）']); if (!choice) return; nested = choice === 2; }
  const preview = await previewClean(repo, scope, nested);
  ui.text(`命令范围：${preview.args.join(' ')}\n始终排除当前 AutoGit data：${JSON.stringify(dataPath())}；不会扫描其中内容。${nested ? '第二个 -f 已明确启用，嵌套仓库及历史可能永久删除。' : '保留嵌套 Git 仓库。'}\nNUL 枚举的删除预览：`); displayPaths(ui, preview.paths);
  if (!preview.paths.length) { ui.text('该范围没有可清理路径。'); return; }
  const stamp = await repositoryStamp(repo, preview.paths);
  if (!await ui.confirm('确认永久删除以上范围内的未跟踪内容？')) return;
  await verifyRepositoryStamp(repo, stamp, preview.paths); await requireIdle(repo);
  const next = await previewClean(repo, scope, nested);
  if (JSON.stringify(next) !== JSON.stringify(preview)) throw new GitError('clean 范围在确认期间变化，请重新预览。');
  await repo.run(preview.args); ui.text('clean 已完成；AutoGit data 已排除，没有自动备份。');
}
export async function destructiveMenu(ui: Console, directory: string): Promise<void> {
  const actions = [stageFiles, unstageFiles, restoreFiles, resetTo, cleanFiles];
  const choice = await ui.menu('暂存、还原与清理', ['按文件暂存（完整工作区版本）', '按文件取消暂存（不改工作区）', '从 HEAD / index / 本地提交还原路径', 'reset soft / mixed / hard', 'clean 未跟踪 / 忽略 / 全部']);
  if (choice) await actions[choice - 1](ui, directory);
}
