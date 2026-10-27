/** Submodules are processed one repository at a time. Never forward a parent's identity recursively. */
import { lstat, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Git, GitError, decodePath, encodePath, redact, splitNul, validateGitUrl } from './git.js';
import { bindProject, chooseProfile, profileGit, resolveBinding, type Profile } from './profiles.js';
import { projectGit } from './workflows.js';
import { HostStore, resolveTransport, type TransportTarget } from './hosts.js';
import type { Console } from './ui.js';

type Directory = string | Git;
export interface Submodule { name: string; path: string; url: string; configuredUrl: string; oid?: string; initialized: boolean; head?: string; dirty?: boolean }
async function repository(directory: Directory): Promise<Git> { return (directory instanceof Git ? directory : await projectGit(directory)).repository(); }
function at(context: Git, directory: string): Git { return new Git(directory, { config: context.overrides, env: { ...context.environment, GIT_LFS_SKIP_SMUDGE: '1' }, rejectEnv: context.rejectedEnvironment }); }
function within(child: string, root: string): boolean { const relative = path.relative(root, child); return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function childPath(repo: Git, relative: string): Promise<string> {
  const child = path.resolve(repo.directory, relative);
  if (!within(child, repo.directory) || relative.split(/[\\/]/u).some(part => part.toLowerCase() === '.git') || /[\udc80-\udcff\x00]/u.test(relative)) throw new GitError('子模块路径越界、指向 Git 元数据或含不可传递字节，已停止。');
  // Resolve every existing ancestor; a missing leaf must not disguise an escaping symlink.
  let ancestor = child;
  for (;;) {
    try { const actual = await realpath(ancestor); if (actual !== repo.directory && !within(actual, repo.directory)) throw new GitError('子模块路径经符号链接越界，已停止。'); break; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; const parent = path.dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; }
  }
  try { if ((await lstat(child)).isSymbolicLink()) throw new GitError('子模块目录不能是符号链接。'); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  return child;
}
async function initialized(repo: Git, relative: string): Promise<boolean> {
  const child = await childPath(repo, relative);
  try { await lstat(path.join(child, '.git')); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
  const childRepo = new Git(child); const root = await childRepo.root();
  const parentCommon = await realpath(await repo.gitPath('objects'));
  const childCommon = await realpath(await childRepo.gitPath('objects'));
  if (await realpath(root) !== await realpath(child) || parentCommon === childCommon) throw new GitError('子模块目录并非独立仓库；不会递归操作主仓库。');
  return true;
}
export async function submoduleRecords(repo: Git): Promise<Submodule[]> {
  const config = await repo.run(['config', '--null', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], { check: false });
  if (config.status !== 0 && config.status !== 1) throw new GitError('无法读取 .gitmodules，请检查格式。');
  const links = new Map<string, string>();
  for (const entry of splitNul((await repo.run(['ls-files', '--stage', '-z'])).stdout)) {
    const tab = entry.indexOf(9); if (tab < 0) continue;
    const [mode, oid, stage] = entry.subarray(0, tab).toString('ascii').split(' ');
    if (mode === '160000' && stage === '0') links.set(decodePath(entry.subarray(tab + 1)), oid);
  }
  const result: Submodule[] = []; const seen = new Set<string>();
  for (const entry of splitNul(config.stdout)) {
    if (!entry.length) continue;
    const newline = entry.indexOf(10); if (newline < 0) throw new GitError('.gitmodules 路径条目不完整。');
    const key = entry.subarray(0, newline).toString('utf8');
    const name = key.slice('submodule.'.length, -'.path'.length), relative = decodePath(entry.subarray(newline + 1));
    if (!name || path.isAbsolute(name) || name.split(/[\\/]/u).some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || /[\x00-\x1f\x7f]/u.test(name)) throw new GitError('子模块名称会越界或不能作为 Git 配置键，已停止。');
    const absolute = await childPath(repo, relative);
    if (seen.has(absolute)) throw new GitError('.gitmodules 有重复路径，未操作。'); seen.add(absolute);
    const urlResult = await repo.run(['config', '--file', '.gitmodules', '--get', `submodule.${name}.url`], { check: false });
    const url = urlResult.status === 0 ? decodePath(urlResult.stdout).replace(/\r?\n$/u, '') : '';
    const active = await initialized(repo, relative);
    const childRepo = active ? new Git(absolute) : undefined;
    const configured = await repo.run(['config', '--get', `submodule.${name}.url`], { check: false });
    result.push({ name, path: relative, url, configuredUrl: configured.status ? '' : decodePath(configured.stdout).replace(/\r?\n$/u, ''), oid: links.get(relative), initialized: active, ...(childRepo ? { head: await childRepo.value('rev-parse', '--verify', 'HEAD'), dirty: (await childRepo.changes()).length > 0 } : {}) });
  }
  return result;
}
function label(item: Submodule): string { return `${JSON.stringify(item.path)}  ${item.initialized ? '已初始化' : '未初始化'}${item.dirty ? ' / 有未提交修改' : ''}${item.head && item.head !== item.oid ? ' / HEAD 与 gitlink 不同' : ''}  gitlink ${item.oid?.slice(0, 10) || '未暂存'}${item.head ? ` / HEAD ${item.head.slice(0, 10)}` : ''} → ${redact(item.configuredUrl || item.url)}`; }
async function select(ui: Console, repo: Git, title: string): Promise<Submodule | undefined> { const items = await submoduleRecords(repo); if (!items.length) { ui.text('没有 .gitmodules 子模块。'); return undefined; } const choice = await ui.menu(title, items.map(label)); return choice ? items[choice - 1] : undefined; }
async function ready(repo: Git): Promise<void> { if (await repo.operation() || (await repo.changes()).some(change => change.conflict)) throw new GitError('仓库有未完成操作或冲突，请先处理。'); }
async function state(repo: Git): Promise<string> { return JSON.stringify([await submoduleRecords(repo), (await repo.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout.toString('base64')]); }
async function unchanged(repo: Git, before: string): Promise<void> { if (await state(repo) !== before) throw new GitError('子模块配置或工作区状态在确认期间变化，请重新预览。'); }

/** Inspect retained .git/modules repositories too: deinit does not discard their remotes. */
async function retainedRepository(parent: Git, item: Submodule): Promise<Git | undefined> {
  if (item.initialized) return new Git(await childPath(parent, item.path));
  const directory = await parent.gitPath(`modules/${item.name}`);
  try { if (!(await stat(directory)).isDirectory()) return undefined; }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
  const modules = await parent.gitPath('modules');
  if (!within(await realpath(directory), await realpath(modules))) throw new GitError('保留的子模块管理目录越界，已停止。');
  // Reading refs/config must also work after git rm removed the old core.worktree.
  return new Git(directory).configured({ 'core.worktree': parent.directory });
}
async function actualUrls(parent: Git, item: Submodule): Promise<{ urls: string[]; remote: string }> {
  const retained = await retainedRepository(parent, item); if (!retained) return { urls: [], remote: '' };
  let branch = ''; try { branch = await retained.branch(); } catch (error) { if (!(error instanceof GitError)) throw error; }
  const remote = (branch ? await retained.config(`branch.${branch}.remote`) : '') || 'origin';
  if (remote === '.') throw new GitError('子模块更新远程指向本地 .，请明确修复远程配置。');
  const addresses = await retained.remoteUrls(remote);
  if (addresses.length !== 1) throw new GitError('子模块远程有多个地址，需先明确目标。');
  const urls: string[] = [];
  for (const url of addresses) { await validateAddress(retained, url); const effective = await retained.value('ls-remote', '--get-url', url); await validateAddress(retained, effective); urls.push(effective); }
  return { urls, remote };
}
async function validateAddress(repo: Git, value: string): Promise<string> {
  if (!value || /[\x00-\x1f\x7f]/u.test(value)) throw new GitError('子模块 URL 无效。');
  try { return validateGitUrl(value); } catch (error) { if (!(error instanceof GitError)) throw error; }
  let local = value;
  if (value.startsWith('file://')) { try { local = new URL(value).pathname; local = decodeURIComponent(local); } catch { throw new GitError('本地子模块 URL 无效。'); } }
  if (!path.isAbsolute(local)) throw new GitError('子模块地址不是支持的 SSH/HTTPS URL 或本地 bare 仓库。');
  try { if (!(await stat(encodePath(local))).isDirectory()) throw new Error('not directory'); }
  catch { throw new GitError('本地子模块仓库不存在。'); }
  if (await new Git(local).value('rev-parse', '--is-bare-repository') !== 'true') throw new GitError('本地子模块来源必须是 bare 仓库。');
  return value;
}
async function effectiveAddress(repo: Git, item: Submodule): Promise<string> {
  let address = item.configuredUrl || item.url;
  if (/^\.\.?\//u.test(address)) {
    const branch = await repo.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { check: false });
    const name = branch.status ? '' : decodePath(branch.stdout).trim();
    const remote = name ? await repo.config(`branch.${name}.remote`) : '';
    const source = remote === '.' ? repo.directory : (await repo.remoteUrls(remote || 'origin'))[0];
    if (!source) throw new GitError('相对子模块 URL 缺少主仓库默认远程，不能猜测来源。');
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(source)) address = new URL(address, source.replace(/\/$/u, '') + '/').href;
    else if (/^(?:[^/\s:@]+@)?[A-Za-z0-9_.-]+:[^/]/u.test(source)) { const colon = source.indexOf(':'); address = source.slice(0, colon + 1) + path.posix.normalize(source.slice(colon + 1) + '/' + address); }
    else address = path.resolve(source, address);
  }
  await validateAddress(repo, address);
  // This resolves insteadOf without contacting a remote. Validate the actual transport too.
  const effective = await repo.value('ls-remote', '--get-url', address);
  return validateAddress(repo, effective);
}
function isSsh(address: string): boolean { return /^ssh:\/\//iu.test(address) || /^(?:[^/\s:@]+@)?[A-Za-z0-9_.-]+:[^/]/u.test(address); }
function sshTransport(address: string, mode: 'managed-ssh' | 'native-ssh'): TransportTarget {
  const parsed = address.startsWith('ssh://') ? new URL(address) : undefined;
  const host = parsed?.hostname ?? address.slice(address.indexOf('@') + 1, address.indexOf(':'));
  const user = parsed?.username || (address.includes('@') ? address.slice(0, address.indexOf('@')) : '');
  return { mode, host: { provider: host === 'github.com' ? 'github' : 'generic', host, apiHost: host === 'github.com' ? 'api.github.com' : '', webBase: `https://${host}`, sshHost: host, ...(parsed?.port ? { sshPort: Number(parsed.port) } : {}), ...(user ? { sshUser: user } : {}) } };
}
async function nativeContext(runner: Git, item: Submodule): Promise<Git> {
  // submodule update runs from its parent. Pin the child's native command so the
  // parent's local core.sshCommand cannot silently choose the parent's identity.
  const command = runner.overrides['core.sshCommand'] || (item.initialized ? await runner.config('core.sshCommand') : '') || 'ssh';
  const variant = runner.overrides['ssh.variant'] || (item.initialized ? await runner.config('ssh.variant') : '') || 'ssh';
  return runner.configured({ 'core.sshCommand': command, 'ssh.variant': variant });
}
export async function submoduleContext(ui: Console, parent: Git, item: Submodule, urls: string[]): Promise<{ runner: Git; profile?: Profile; transport?: TransportTarget }> {
  const child = await childPath(parent, item.path);
  const bound = item.initialized ? await resolveBinding(child) : undefined;
  const configured = item.initialized ? await resolveTransport(child) : undefined;
  const ssh = urls.find(isSsh);
  if (ssh && configured?.mode === 'https') throw new GitError('子模块独立传输模式是 HTTPS，但实际 URL 使用 SSH；请在子模块项目工具明确切换 SSH 模式或修改远程，未使用默认 SSH 身份联网。');
  let runner = item.initialized ? await projectGit(child) : new Git(parent.directory);
  if (ssh && configured?.mode === 'native-ssh') runner = await nativeContext(runner, item);
  ui.text(`独立子模块上下文：${JSON.stringify(child)}\n地址：${urls.map(redact).join(', ')}\n身份：${bound ? `${bound.label} / ${bound.github_login}` : '无独立 AutoGit 绑定；不继承主仓库账号'}。`);
  if (ssh && !bound && configured?.mode !== 'native-ssh') {
    const choice = await ui.menu('为这个子模块明确选择 SSH 模式（不继承主仓库）', ['托管 SSH：选择软件账号', '原生 SSH：使用已有 SSH config / Host alias / 凭据']);
    if (!choice) throw new GitError('未选择子模块身份，没有联网。');
    const transport = sshTransport(ssh, choice === 1 ? 'managed-ssh' : 'native-ssh');
    if (choice === 2) return { runner: await nativeContext(new Git(item.initialized ? child : parent.directory), item), transport };
    const profile = await chooseProfile(ui); if (!profile) throw new GitError('未选择子模块身份，没有联网。');
    runner = await profileGit(item.initialized ? child : parent.directory, profile, transport);
    return { runner, profile, transport };
  }
  return { runner };
}
async function saveContext(child: string, identity: { profile?: Profile; transport?: TransportTarget }): Promise<void> {
  if (identity.transport) await new HostStore().set(child, identity.transport);
  if (identity.profile) await bindProject(child, identity.profile);
}

export async function addSubmodule(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory); await ready(repo);
  const url = await validateAddress(repo, await ui.ask('子模块 SSH/HTTPS 地址或本地 bare 路径'));
  const relative = await ui.ask('仓库内的子模块目录'); await childPath(repo, relative);
  if ((await submoduleRecords(repo)).some(item => item.path === relative)) throw new GitError('这个子模块目录已登记。');
  const forceMode = await ui.menu('add 的保护选项', ['普通添加', 'force（允许 Git 接纳被忽略目录 / 已有模块登记）']); if (!forceMode) return;
  // Git's default module name is the path, but config keys cannot contain newlines.
  const moduleName = /[\r\n]/u.test(relative) ? `autogit-${createHash('sha256').update(relative).digest('hex').slice(0, 24)}` : relative;
  const item: Submodule = { name: moduleName, path: relative, url, configuredUrl: '', initialized: false };
  const effective = await effectiveAddress(repo, item);
  const reused = await actualUrls(repo, item);
  const identity = await submoduleContext(ui, repo, item, [effective, ...reused.urls]);
  const before = await state(repo);
  ui.text(`添加 ${JSON.stringify(relative)} ← ${redact(effective)}；force=${forceMode === 2}。将修改 .gitmodules 和暂存 gitlink；不自动提交。`);
  if (!(forceMode === 2 ? await ui.confirm('确认按上述范围 force 添加子模块？') : await ui.routineConfirm('添加这个子模块？'))) return;
  await unchanged(repo, before);
  if (await effectiveAddress(repo, item) !== effective || !isDeepStrictEqual(await actualUrls(repo, item), reused)) throw new GitError('子模块实际 URL 在确认期间变化，未添加。');
  await at(identity.runner, repo.directory).configured({ 'submodule.recurse': 'false', 'fetch.recurseSubmodules': 'false' }).run(['submodule', 'add', '--name', moduleName, ...forceMode === 2 ? ['--force'] : [], '--', effective, relative], { interactive: true });
  await saveContext(await childPath(repo, relative), identity);
  ui.text('子模块已添加。请检查 .gitmodules 和暂存区，再自行提交；没有递归下载其他子模块。LFS 自动 smudge 已跳过，请进入子仓 LFS 菜单按 endpoint 下载对象。');
}

export async function initSubmodule(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory); await ready(repo); const item = await select(ui, repo, '初始化一个子模块（仅登记 URL，不下载）'); if (!item) return;
  const before = await state(repo); ui.text(label(item));
  if (!await ui.routineConfirm('将这个子模块的 URL 登记到本地 Git config？不会联网。')) return;
  await unchanged(repo, before); await repo.run(['submodule', 'init', '--', item.path], { interactive: true });
}

interface UpdateOptions { recursive: boolean; remote: boolean; force: boolean }
async function updateOne(ui: Console, parent: Git, item: Submodule, options: UpdateOptions, visited: Set<string>, depth = 0): Promise<void> {
  if (depth > 32) throw new GitError('嵌套子模块超过 32 层，已停止；已完成的更新保留。');
  await ready(parent);
  const child = await childPath(parent, item.path);
  if (visited.has(child)) throw new GitError('重复 / 循环子模块路径，已停止。'); visited.add(child);
  const address = await effectiveAddress(parent, item);
  if (item.initialized) await ready(await new Git(child).repository());
  const actual = await actualUrls(parent, item);
  const urls = [address, ...actual.urls]; const actualRemote = actual.remote;
  const identity = await submoduleContext(ui, parent, item, [...new Set(urls)]);
  const contextBefore = item.initialized ? JSON.stringify([await resolveBinding(child), await resolveTransport(child)]) : '';
  const before = await state(parent);
  const childBefore = item.initialized ? (await new Git(child).run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout : undefined;
  ui.text(`更新 ${JSON.stringify(child)}\n来源：${[...new Set(urls)].map(redact).join(', ')}${actualRemote ? `\n实际子仓远程：${actualRemote}` : ''}\n模式：${options.remote ? 'remote：跟随子模块配置分支的远程 tip' : '固定到主仓记录的 gitlink 提交'}；recursive=${options.recursive}；force=${options.force}。${options.force ? '可能覆盖子仓未提交修改。' : '保留 Git 的脏文件保护。'}`);
  if (childBefore?.length) ui.text(`子仓当前未提交 / 未跟踪状态：${JSON.stringify(decodePath(childBefore))}`);
  // Every new nested URL is previewed with its own context. No hidden --recursive invocation.
  if (!(options.force ? await ui.confirm('确认按上述范围更新此子模块？') : await ui.routineConfirm('更新此子模块？'))) return;
  await unchanged(parent, before);
  if (await effectiveAddress(parent, item) !== address || !isDeepStrictEqual(await actualUrls(parent, item), actual)) throw new GitError('子模块实际 URL 在确认期间变化，未更新。');
  if (item.initialized && JSON.stringify([await resolveBinding(child), await resolveTransport(child)]) !== contextBefore) throw new GitError('子模块身份 / 传输配置在确认期间变化，未更新。');
  if (childBefore && !(await new Git(child).run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout.equals(childBefore)) throw new GitError('子模块工作区状态在确认期间变化，未更新。');
  const runner = at(identity.runner, parent.directory).configured({ 'submodule.recurse': 'false', 'fetch.recurseSubmodules': 'false', [`submodule.${item.name}.url`]: address });
  await runner.run(['submodule', 'update', '--init', '--checkout', ...options.remote ? ['--remote'] : [], ...options.force ? ['--force'] : [], '--', item.path], { interactive: true });
  if (!await initialized(parent, item.path)) throw new GitError('更新后子模块没有独立 Git 上下文，已停止递归。');
  await saveContext(child, identity);
  if (options.recursive) {
    const childRepo = await (await projectGit(child)).repository();
    for (const nested of await submoduleRecords(childRepo)) await updateOne(ui, childRepo, nested, options, visited, depth + 1);
  }
}
export async function updateSubmodules(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory); await ready(repo); const item = await select(ui, repo, '选择更新范围的起点'); if (!item) return;
  const recursive = await ui.menu('是否递归更新嵌套子模块？', ['仅选定这一层', '递归（逐仓展示 URL / 选择身份，不继承账号）']); if (!recursive) return;
  const remote = await ui.menu('更新到哪里？', ['主仓记录的固定提交（不使用 --remote）', '子模块远程分支 tip（--remote，会改变 gitlink 状态）']); if (!remote) return;
  const force = await ui.menu('checkout 保护', ['普通模式（保留 Git 脏文件保护）', 'force（可能覆盖子模块未提交修改）']); if (!force) return;
  await updateOne(ui, repo, item, { recursive: recursive === 2, remote: remote === 2, force: force === 2 }, new Set());
  ui.text('选定更新流程已结束；请检查各子仓状态及主仓 gitlink 差异。失败 / 取消不回滚已完成的子模块。LFS 自动 smudge 已跳过，请在各子仓 LFS 菜单按 endpoint 下载对象。');
}

export async function enterSubmodule(ui: Console, directory: Directory): Promise<string | undefined> {
  const repo = await repository(directory); const item = await select(ui, repo, '进入子模块独立项目'); if (!item) return undefined;
  if (!item.initialized) throw new GitError('子模块尚未下载；请先执行 update --init。');
  const child = await childPath(repo, item.path); const binding = await resolveBinding(child);
  await projectGit(child); ui.text(binding ? `子模块独立绑定：${binding.label}` : '子模块未独立绑定账号；不继承主仓账号，请按需明确绑定。');
  return child;
}

export async function removeSubmodule(ui: Console, directory: Directory, deinit = false): Promise<void> {
  const repo = await repository(directory); await ready(repo); const item = await select(ui, repo, deinit ? 'deinit：移除子模块工作区 / 本地登记' : 'remove：从主仓移除子模块'); if (!item) return;
  if (!deinit && !item.oid) throw new GitError('此路径没有已暂存 gitlink，不能当作子模块删除。');
  const force = await ui.menu('删除 / 取消初始化保护', ['普通模式（保留 Git 的脏工作区保护）', 'force（可能永久删除子仓未提交文件）']); if (!force) return;
  const before = await state(repo);
  const child = await childPath(repo, item.path);
  const childBefore = item.initialized ? (await new Git(child).run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'])).stdout : undefined;
  ui.text(`目标：${label(item)}\n${childBefore?.length ? `子仓未提交 / 未跟踪 / 忽略状态：${JSON.stringify(childBefore.toString('utf8'))}\n` : ''}${deinit ? '删除子模块工作区文件并解除本地登记；保留 .gitmodules / gitlink，可再次 update --init。' : 'git rm 子模块目录，修改 .gitmodules 并暂存删除；不自动提交。'}\n保留 Git 管理目录中的子仓对象，不额外 rm -rf .git/modules；force=${force === 2}。`);
  if (!await ui.confirm('确认以上删除范围？未提交文件可能无法恢复。')) return;
  await unchanged(repo, before);
  if (childBefore && !(await new Git(child).run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'])).stdout.equals(childBefore)) throw new GitError('子模块状态变化，请重新预览。');
  await repo.configured({ 'submodule.recurse': 'false' }).run(deinit ? ['submodule', 'deinit', ...force === 2 ? ['--force'] : [], '--', item.path] : ['rm', ...force === 2 ? ['--force'] : [], '--', item.path], { interactive: true });
  ui.text(deinit ? '选定子模块已取消初始化；没有递归删除其他仓库。' : '选定子模块已移除；请检查暂存差异，再自行提交。');
}

export async function submodulesMenu(ui: Console, directory: string): Promise<string | undefined> {
  const choice = await ui.menu('子模块 / submodule', ['列出子模块', '添加子模块', 'init（仅本地登记）', 'update（明确 recursive / remote）', '进入子模块', 'remove（从主仓移除）', 'deinit（保留 gitlink）']);
  if (choice === 1) { const items = await submoduleRecords(await repository(directory)); for (const item of items) ui.text(label(item)); if (!items.length) ui.text('没有子模块。'); }
  else if (choice === 2) await addSubmodule(ui, directory);
  else if (choice === 3) await initSubmodule(ui, directory);
  else if (choice === 4) await updateSubmodules(ui, directory);
  else if (choice === 5) return enterSubmodule(ui, directory);
  else if (choice === 6 || choice === 7) await removeSubmodule(ui, directory, choice === 7);
  return undefined;
}
