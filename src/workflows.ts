/** Task-oriented Git workflows with explicit write/network confirmations. */
import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Change, Git, GitError, decodePath, encodePath, redact, splitNul, validateGitUrl } from './git.js';
import { GithubClient, authenticateGithub, validateRepositoryName, type Visibility } from './github.js';
import type { Profile } from './profiles.js';
import type { Console } from './ui.js';
import { chooseCloneTarget, verifyCloneTarget } from './clone-target.js';
import { autoIgnoreLargeFiles } from './large-files.js';

/** A one-operation destination; never persisted in Git config or a process-global registry. */
export interface RemoteTarget {
  readonly remote: string;
  readonly urls?: Readonly<{ fetch: readonly string[]; push: readonly string[] }>;
  readonly created?: {
    readonly owner: string;
    readonly name: string;
    readonly profile: Readonly<Profile>;
  };
}

export interface PushOptions { remote?: string; target?: RemoteTarget; mode?: 'normal' | 'lease' | 'force'; branch?: string }

export async function remoteRefOid(repo: Git, address: string, ref: string): Promise<string> {
  if (!ref.startsWith('refs/') || (await repo.run(['check-ref-format', ref], { check: false })).status) throw new GitError('远端引用无效。');
  const result = await repo.run(['ls-remote', '--refs', '--', address, ref], { interactive: true, captureStdout: true });
  const lines = result.stdout.toString('ascii').trim().split('\n').filter(Boolean);
  if (!lines.length) return '';
  if (lines.length !== 1) throw new GitError('远端引用查询返回了多个结果，未上传。');
  const match = /^([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(lines[0]);
  if (!match || match[2] !== ref) throw new GitError('远端引用响应无效，不能把它当作不存在。');
  return match[1];
}

function expandHome(value: string): string {
  return value === '~' ? homedir() : /^~[/\\]/.test(value) ? path.join(homedir(), value.slice(2)) : value;
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function exists(location: string): Promise<boolean> {
  try {
    await lstat(encodePath(location));
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** Resolve existing symlinks, including when a deleted/new leaf does not exist. */
async function canonicalPath(location: string, depth = 0): Promise<string> {
  if (depth > 40) throw new GitError('路径包含循环或过多的符号链接，已停止。');
  try {
    return decodePath(await realpath(encodePath(location), { encoding: 'buffer' }));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    if ((await lstat(encodePath(location))).isSymbolicLink()) {
      const target = decodePath(await readlink(encodePath(location), { encoding: 'buffer' }));
      return canonicalPath(path.resolve(path.dirname(location), target), depth + 1);
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const parent = path.dirname(location);
  if (parent === location) return location;
  return path.join(await canonicalPath(parent, depth), path.basename(location));
}

function isWithin(location: string, directory: string): boolean {
  const relative = path.relative(directory, location);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function displayPath(value: string): string {
  // Escapes control characters and surrogateescaped file names in terminal output.
  return JSON.stringify(value);
}

export async function projectGit(directory: string): Promise<Git> {
  const { boundGit } = await import('./profiles.js');
  return boundGit(directory);
}

export async function chooseDirectory(ui: Console, current: string, { existing = true }: { existing?: boolean } = {}): Promise<string> {
  const value = expandHome(await ui.ask('项目文件夹路径', current));
  const directory = await canonicalPath(path.resolve(current, value));
  if (existing) {
    try {
      if (!(await stat(encodePath(directory))).isDirectory()) throw new GitError('该目录不存在或不是文件夹。请检查路径后重试。');
    } catch (error) {
      if (missing(error)) throw new GitError('该目录不存在或不是文件夹。请检查路径后重试。');
      throw error;
    }
  }
  return directory;
}

export async function showStatus(ui: Console, repo: Git): Promise<Change[]> {
  const changes = await repo.changes();
  ui.text(`项目：${repo.directory}`);
  try {
    ui.text(`分支：${await repo.branch()}`);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    ui.text('分支：游离 HEAD（可查看，但写入流程会停止）');
  }
  if (!changes.length) ui.text('工作区干净，没有未提交的修改。');
  for (const change of changes) ui.text(`  ${change.label()}`);
  return changes;
}

async function availableRemoteName(repo: Git, name: string): Promise<void> {
  if (!name || name.startsWith('-') || /[\s\x00-\x1f\x7f-\x9f]/u.test(name) ||
      (await repo.run(['check-ref-format', `refs/remotes/${name}/HEAD`], { check: false })).status) {
    throw new GitError('远程名无效：不能以 - 开头，或包含空白、控制字符及 Git 引用不支持的字符。');
  }
  if ((await repo.remotes()).includes(name)) throw new GitError('这个远程名已经存在。为保护原配置，没有覆盖；请选择其他名字，或在推送时选择已有远程。');
}

/** Resolve both URL rewrite directions offline; a created repository is never a generic destination. */
async function validateCreatedTarget(repo: Git, remote: string, owner: string, name: string): Promise<void> {
  const expected = `git@github.com:${owner}/${name}.git`.toLowerCase();
  for (const push of [false, true]) {
    const urls = await repo.remoteUrls(remote, push);
    if (urls.length === 1 && urls[0].startsWith('git@github.com:') && urls[0].toLowerCase() === expected) continue;
    throw new GitError('Git URL 重写或远程配置使实际获取/推送目标不再是预期 github.com 仓库的规范 SSH 地址，已拒绝继续上传。即使 HTTPS 指向同一仓库，也不能改用外部 HTTPS 凭据代替所选托管密钥；请检查 URL 重写及 pushurl 配置。');
  }
}

async function createdTargetContext(repo: Git, target?: RemoteTarget): Promise<Git> {
  if (!target?.created) return repo;
  const { profile: expected, owner, name } = target.created;
  const { profileGit, ProfileStore, resolveBinding } = await import('./profiles.js');
  const current = await new ProfileStore().load(expected.profile_id);
  const binding = await resolveBinding(repo.directory);
  if (!binding || !isDeepStrictEqual({ ...current }, expected) || !isDeepStrictEqual({ ...binding }, expected)) {
    throw new GitError('新建仓库选定的账号或项目绑定已发生变化，已拒绝上传；请重新核对。已创建的仓库和本地提交会保留。');
  }
  const runner = await profileGit(repo.directory, current);
  await validateCreatedTarget(runner, target.remote, owner, name);
  return runner;
}

export async function snapshotRemoteTarget(repo: Git, remote: string): Promise<RemoteTarget> {
  return Object.freeze({
    remote,
    urls: Object.freeze({
      fetch: Object.freeze(await repo.remoteUrls(remote)),
      push: Object.freeze(await repo.remoteUrls(remote, true)),
    }),
  });
}

export async function unchangedRemoteTarget(repo: Git, target?: RemoteTarget): Promise<void> {
  if (!target?.urls) return;
  if (!isDeepStrictEqual(await repo.remoteUrls(target.remote), target.urls.fetch) ||
      !isDeepStrictEqual(await repo.remoteUrls(target.remote, true), target.urls.push)) {
    throw new GitError('上传目标在选择或确认期间发生变化，已停止；请重新预览，未上传。');
  }
}

function oneTimeRemote({ remote, target }: PushOptions): string | undefined {
  if (target && remote !== undefined && target.remote !== remote) throw new GitError('一次性上传目标不一致，已停止。');
  return target?.remote ?? remote;
}

async function createPersonalRemote(ui: Console, repo: Git): Promise<RemoteTarget | undefined> {
  // Local validation precedes every API call, including authentication.
  const remote = await ui.ask('给这个远程起一个名字', 'origin');
  await availableRemoteName(repo, remote);
  const { bindProject, chooseProfile, profileGit, ProfileStore, resolveBinding } = await import('./profiles.js');
  const binding = await resolveBinding(repo.directory);
  const profile = binding ?? await chooseProfile(ui);
  if (profile == null) {
    ui.text('未选择 AutoGit 账号，没有创建或关联仓库。请先到“账号与密钥”新建或导入。');
    return undefined;
  }
  const snapshot = { ...profile };
  const bindingSnapshot = binding ? { ...binding } : undefined;
  const store = new ProfileStore();
  const checkProfile = async (): Promise<Git> => {
    const current = await store.load(profile.profile_id);
    const currentBinding = await resolveBinding(repo.directory);
    if (!isDeepStrictEqual({ ...current }, snapshot) || !isDeepStrictEqual(currentBinding ? { ...currentBinding } : undefined, bindingSnapshot)) {
      throw new GitError('账号或项目绑定在选择期间发生变化，已停止；请重新预览，不会自动更换项目账号。');
    }
    return profileGit(repo.directory, current);
  };
  let runner = await checkProfile();
  await runner.ensureReady();
  ui.text(`AutoGit 账号：${profile.label}；预期 GitHub 登录名：${profile.github_login}。${binding ? '沿用项目现有绑定，不会更换账号。' : '仅在远程关联成功后绑定项目。'}`);
  // Never sanitize or silently substitute the directory's (possibly Chinese) name.
  const name = validateRepositoryName(await ui.ask('新 GitHub 仓库名称（请明确输入普通仓库名，不自动使用文件夹名）'));
  const choice = await ui.menu('仓库可见性（必须明确选择）', ['Private 私有（推荐）', 'Public 公开（任何人都能看到）']);
  if (!choice) return undefined;
  const visibility: Visibility = choice === 1 ? 'private' : 'public';
  const owner = profile.github_login;
  const client = new GithubClient(repo.directory);
  const login = await authenticateGithub(ui, client, owner);
  if (!login) return undefined;
  ui.text(`GitHub API 登录：${login}\nAutoGit 账号：${profile.label}\n预期登录 / 仓库所有者：${owner}\n仓库：${owner}/${name}\n可见性：${visibility}\n项目：${repo.directory}\n本地远程名：${remote}`);
  ui.text('将创建一个空仓库，不添加 README、.gitignore 或许可证。此步骤只创建并关联，不会提交或推送。');
  if (!(await ui.confirm('最终确认：以以上 API 账号创建这个 GitHub 空仓库并关联当前项目？'))) return undefined;
  runner = await checkProfile();
  await runner.ensureReady();
  await availableRemoteName(runner, remote);
  let createdUrl = '';
  let linked = false;
  const onCreated = (url: string): void => {
    createdUrl = url;
    ui.text(`GitHub 仓库已创建：${url}`);
  };
  try {
    const created = await client.createRepository(owner, name, visibility, onCreated);
    if (!createdUrl) onCreated(created.htmlUrl);
    runner = await checkProfile();
    await availableRemoteName(runner, remote);
    await runner.run(['remote', 'add', remote, created.sshUrl]);
    linked = true;
    ui.text(`已关联远程 ${remote} → ${created.sshUrl}。尚未提交或上传。`);
    await validateCreatedTarget(runner, remote, owner, name);
    await checkProfile();
    if (!binding) await bindProject(repo.directory, profile);
    ui.text(`项目沿用 AutoGit 账号：${profile.label}。创建和关联已完成；尚未提交或推送。`);
    return Object.freeze({ remote, created: Object.freeze({ owner, name, profile: Object.freeze(snapshot) }) });
  } catch (error) {
    if (createdUrl) {
      ui.text(`已完成：GitHub 仓库已创建 ${createdUrl}；本地远程${linked ? `已关联为 ${remote}` : '尚未关联'}。仓库会保留，不自动删除或回滚。尚未提交或推送。`);
    }
    throw error;
  }
}

async function addRemoteTarget(ui: Console, repo: Git): Promise<RemoteTarget | undefined> {
  ui.title('关联远程仓库');
  for (const name of await repo.remotes()) ui.text(`已有 ${name}：${redact((await repo.remoteUrls(name)).join(', '))}`);
  const choice = await ui.menu('选择关联方式', ['新建个人 GitHub 空仓库（私有 / 公开）', '关联已有仓库（手工粘贴地址，无需 GitHub CLI）']);
  if (!choice) return undefined;
  if (choice === 1) return createPersonalRemote(ui, repo);
  ui.text('粘贴已有仓库地址即可；若尚未建库，可返回选择新建，或访问 https://github.com/new。');
  const address = validateGitUrl(await ui.ask('粘贴 Git 仓库地址（SSH/HTTPS，支持其他服务及 SSH Host alias）'));
  const name = await ui.ask('给这个远程起一个名字', 'origin');
  await availableRemoteName(repo, name);
  if (!(await ui.routineConfirm(`在当前仓库关联 ${name} → ${address}？（不会联网或创建 GitHub 仓库）`))) return undefined;
  await availableRemoteName(repo, name);
  await repo.run(['remote', 'add', name, address]);
  ui.text('已关联远程。仅记录了地址，不代表认证或推送已经成功。');
  return snapshotRemoteTarget(repo, name);
}

export async function addRemote(ui: Console, repo: Git): Promise<string> {
  return (await addRemoteTarget(ui, repo))?.remote ?? '';
}

/** Accept supported Git transports and existing local bare repositories. */
export async function validateExistingRemote(repo: Git, name: string, push = false): Promise<string[]> {
  const urls = await repo.remoteUrls(name, push);
  if (urls.length !== 1) throw new GitError('这个远程有多个地址；当前传输每次只处理一个目标。可在远程管理编辑列表，或把各地址分别添加为独立名称的远程后选择。');
  const address = urls[0];
  try {
    validateGitUrl(address);
    return urls;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
  }
  const local = expandHome(address.startsWith('file://') ? address.slice('file://'.length) : address);
  let directory = false;
  if (path.isAbsolute(local)) {
    try {
      directory = (await stat(encodePath(local))).isDirectory();
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  if (!directory) throw new GitError('远程地址无效：请使用 Git SSH/HTTPS 地址，或存在的本地 bare 仓库。');
  const probe = await new Git(local).run(['rev-parse', '--is-bare-repository'], { check: false });
  if (probe.status || probe.stdout.toString('utf8').trim() !== 'true') throw new GitError('本地远程不是 bare 仓库；为避免把文件推入工作区，本工具拒绝继续。');
  return urls;
}

async function chooseRemoteTarget(ui: Console, repo: Git): Promise<RemoteTarget | undefined> {
  const remotes = await repo.remotes();
  if (!remotes.length) return addRemoteTarget(ui, repo);
  const targets = await Promise.all(remotes.map((remote) => snapshotRemoteTarget(repo, remote)));
  const options = targets.map((target) => `${target.remote} → ${redact(target.urls!.push.join(', '))}`);
  const choice = await ui.menu('选择远程', [...options, '关联另一个远程']);
  if (!choice) return undefined;
  if (choice === remotes.length + 1) return addRemoteTarget(ui, repo);
  return targets[choice - 1];
}

export async function chooseRemote(ui: Console, repo: Git): Promise<string> {
  return (await chooseRemoteTarget(ui, repo))?.remote ?? '';
}

export async function remoteContext(ui: Console, repo: Git, urls: string[]): Promise<Git> {
  const { resolveTransport } = await import('./hosts.js');
  const transport = await resolveTransport(repo.directory);
  const usesSsh = urls.some((url) => url.startsWith('ssh://') || /^[^/\s:]+@[^/\s:]+:/u.test(url) || /^[A-Za-z0-9_.-]+:[^/]/u.test(url));
  if (usesSsh && transport?.mode === 'https') throw new GitError('项目传输模式是 HTTPS，但实际远程地址使用 SSH；请在项目工具切换为托管/原生 SSH，或在远程管理修改地址。没有使用默认 SSH 身份联网。');
  if (transport?.mode === 'native-ssh' || transport?.mode === 'https') return (await projectGit(repo.directory)).repository();
  if (!usesSsh) return repo;
  const { bindProject, chooseProfile, resolveBinding } = await import('./profiles.js');
  if ((await resolveBinding(repo.directory)) != null) return (await projectGit(repo.directory)).repository();
  ui.text('这个项目还未选择软件账号；选一次后会记住，不会使用默认外部 SSH 密钥。');
  const profile = await chooseProfile(ui);
  if (profile == null) throw new GitError('没有选择软件账号，未联网。请先到“账号与密钥”新建或导入。');
  if (!(await ui.routineConfirm(`此项目使用 ${profile.label}？`))) throw new GitError('已取消账号绑定，未联网。');
  await bindProject(repo.directory, profile);
  return (await projectGit(repo.directory)).repository();
}

export async function protectAccountData(repo: Git, changes: Change[]): Promise<void> {
  const { appDataDir } = await import('./profiles.js');
  const data = await canonicalPath(appDataDir());
  for (const change of changes) {
    for (const name of [change.path, change.original]) {
      if (name && isWithin(await canonicalPath(path.resolve(repo.directory, name)), data)) {
        throw new GitError('提交内容包含 AutoGit 账号数据，已停止；请取消暂存 data 并排除它，不要上传托管密钥。');
      }
    }
  }
}

export async function push(ui: Console, original: Git, options: PushOptions = {}): Promise<void> {
  const mode = options.mode ?? 'normal';
  if (!['normal', 'lease', 'force'].includes(mode)) throw new GitError('推送方式无效。');
  const explicitRemote = oneTimeRemote(options);
  let selection = options.target;
  let repo = await (await projectGit(original.directory)).repository();
  repo = await createdTargetContext(repo, selection);
  await unchangedRemoteTarget(repo, selection);
  await repo.ensureReady();
  if (!(await repo.hasCommits())) throw new GitError('还没有任何提交。请先用“保存并上传”选择文件、创建提交。');
  const branch = await repo.branch();
  const upstreamRemote = await repo.config(`branch.${branch}.remote`);
  const initialMergeRef = await repo.config(`branch.${branch}.merge`);
  let mergeRef = initialMergeRef;
  const branchPushRemote = await repo.config(`branch.${branch}.pushRemote`);
  const defaultPushRemote = await repo.config('remote.pushDefault');
  const hasExplicitRemote = explicitRemote !== undefined;
  let remote = explicitRemote ?? (branchPushRemote || defaultPushRemote || upstreamRemote);
  if (hasExplicitRemote && !(await repo.remotes()).includes(remote)) throw new GitError('指定的一次性上传远程不存在；没有上传。');
  let setUpstream = !upstreamRemote || !mergeRef;
  let separatePush = Boolean(upstreamRemote && remote && upstreamRemote !== remote);
  if (!hasExplicitRemote && upstreamRemote && !branchPushRemote && !defaultPushRemote && (await repo.remotes()).length > 1) {
    ui.text('此项目有多个远程。拉取上游不一定是你可上传的仓库，请明确选择推送目标。');
    selection = await chooseRemoteTarget(ui, repo);
    if (!selection) return;
    remote = selection.remote;
    separatePush = remote !== upstreamRemote;
  }
  if (hasExplicitRemote) {
    ui.text(`本次一次性上传目标：${remote}。已有拉取上游、pushRemote 和 pushDefault 配置均不会被替换。`);
    const target = options.branch ?? await ui.ask('本次推送的远程分支名称', branch);
    mergeRef = `refs/heads/${target}`;
    // Even an incomplete existing upstream must not be silently repaired to another destination.
    setUpstream = !upstreamRemote && !initialMergeRef;
  } else if (separatePush) {
    ui.text(`拉取上游：${upstreamRemote}；推送使用单独目标：${remote}。不会修改拉取上游。`);
    const target = options.branch ?? await ui.ask('本次推送的远程分支名称', branch);
    mergeRef = `refs/heads/${target}`;
    setUpstream = false;
  } else if (setUpstream) {
    ui.text('当前分支还没有设置上游（默认同步目标），请明确选择。');
    selection = await chooseRemoteTarget(ui, repo);
    if (!selection) return;
    remote = selection.remote;
    const target = options.branch ?? await ui.ask('远程分支名称', branch);
    mergeRef = `refs/heads/${target}`;
  }
  if (remote === '.') throw new GitError('当前上游指向本地分支，不是远程仓库。请检查分支配置后再推送。');
  if (!(await repo.remotes()).includes(remote)) throw new GitError('上游引用的远程已不存在，请先修复分支关联。');
  if (!mergeRef.startsWith('refs/heads/') || (await repo.run(['check-ref-format', mergeRef], { check: false })).status) {
    throw new GitError('远程分支名称无效，已停止；没有更改上游。');
  }
  repo = await createdTargetContext(repo, selection);
  await unchangedRemoteTarget(repo, selection);
  const urls = await validateExistingRemote(repo, remote, true);
  repo = await remoteContext(ui, repo, urls);
  const preview = await snapshotRemoteTarget(repo, remote);
  if (!isDeepStrictEqual(preview.urls!.push, urls)) throw new GitError('上传目标在预览期间发生变化，已停止；请重新选择。');
  const sourceOid = await repo.value('rev-parse', 'HEAD');
  const { resolveBinding } = await import('./profiles.js');
  const { resolveTransport } = await import('./hosts.js');
  const bindingSnapshot = await resolveBinding(repo.directory);
  const transportSnapshot = await resolveTransport(repo.directory);
  const remoteOid = mode === 'normal' ? undefined : await remoteRefOid(repo, urls[0], mergeRef);
  ui.text(`本地：${repo.directory}\n分支：${branch} → ${mergeRef.slice('refs/heads/'.length)}`);
  ui.text(`上传目标：${redact(urls[0])}`);
  if (mode !== 'normal') ui.text(`本地提交：${sourceOid}\n远程当前提交：${remoteOid || '不存在'}\n方式：${mode === 'lease' ? 'force-with-lease（远端被更新就停止）' : '无条件 force（允许覆盖远端提交历史）'}`);
  if (setUpstream) ui.text('首次推送成功后，将把这个远程分支设置为默认同步目标。');
  const confirmed = mode === 'normal' ? await ui.routineConfirm('确认联网并上传当前分支的所有尚未推送的提交？') : await ui.confirm(`确认${mode === 'lease' ? '使用 force-with-lease' : '无条件 force'}覆盖这个远程分支？`);
  if (!confirmed) {
    ui.text('未上传；已有本地提交仍然保留。');
    return;
  }
  // Prompts, commit hooks and account management can all change configuration.
  // Recheck after the last confirmation, then use the freshly validated managed context.
  repo = await createdTargetContext(repo, selection);
  await unchangedRemoteTarget(repo, selection);
  await unchangedRemoteTarget(repo, preview);
  await repo.ensureReady();
  if (await repo.branch() !== branch || await repo.value('rev-parse', 'HEAD') !== sourceOid) throw new GitError('当前分支或提交在确认期间发生变化，已停止；未上传。');
  if (!isDeepStrictEqual(await resolveBinding(repo.directory), bindingSnapshot) || !isDeepStrictEqual(await resolveTransport(repo.directory), transportSnapshot)) throw new GitError('项目账号或传输配置在确认期间发生变化，未上传。');
  if (mode === 'lease' && await remoteRefOid(repo, urls[0], mergeRef) !== remoteOid) throw new GitError('远端分支在确认期间发生变化，lease 拒绝覆盖；没有改用无条件强推。');
  if (setUpstream && ((await repo.config(`branch.${branch}.remote`)) !== upstreamRemote ||
      (await repo.config(`branch.${branch}.merge`)) !== initialMergeRef)) {
    throw new GitError('拉取上游在确认期间发生变化，已停止；不会替换新配置。');
  }
  const args = ['push', '--no-follow-tags'];
  if (mode === 'lease') args.push(`--force-with-lease=${mergeRef}:${remoteOid}`);
  else if (mode === 'force') args.push('--force');
  try {
    await repo.run([...args, '--', remote, `${sourceOid}:${mergeRef}`], { interactive: true });
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    throw new GitError(`上传没有确认成功，本地提交仍在；请先检查远端结果再重试。\n若提示 rejected/fetch first，可先获取更新；需要改写远端历史时，在“远程与强推工具”明确选择 lease 或无条件 force。没有自动升级推送方式。\n${error.message}`);
  }
  ui.text(`${mode === 'normal' ? '推送' : '强推'}成功：远程已接受本次上传。`);
  if (setUpstream) {
    try {
      if (await repo.branch() !== branch || await repo.value('rev-parse', 'HEAD') !== sourceOid ||
          await repo.config(`branch.${branch}.remote`) !== upstreamRemote || await repo.config(`branch.${branch}.merge`) !== initialMergeRef) {
        ui.text('远端上传已成功，但本地分支或上游配置在上传期间变化；没有替换现在的上游。');
        return;
      }
      await repo.run(['config', `branch.${branch}.remote`, remote]);
      await repo.run(['config', `branch.${branch}.merge`, mergeRef]);
      ui.text(`已设置默认同步目标：${remote}/${mergeRef.slice('refs/heads/'.length)}。`);
    } catch (error) {
      ui.text(`远端上传已经成功，本地上游关联未完整完成：${redact(error instanceof Error ? error.message : String(error))}。请单独检查配置，不必重复上传。`);
    }
  }
}

export async function riskyPaths(repo: Git, changes: Change[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const change of changes) {
    const name = path.basename(change.path).toLowerCase();
    if ((name.startsWith('.env') && !['.env.example', '.env.sample', '.env.template'].includes(name)) ||
        ['id_rsa', 'id_ed25519', 'credentials', 'credentials.json'].includes(name) ||
        ['.pem', '.key', '.p12', '.pfx'].includes(path.extname(change.path).toLowerCase())) {
      warnings.push(`可能包含机密：${displayPath(change.path)}`);
    }
    try {
      if ((await stat(encodePath(path.resolve(repo.directory, change.path)))).size > 10 * 1024 * 1024) warnings.push(`大于 10 MiB：${displayPath(change.path)}`);
    } catch {
      // Deleted and inaccessible files can still have staged content.
    }
  }
  return warnings;
}

function sameChanges(left: Change[], right: Change[]): boolean {
  return left.length === right.length && left.every((change, i) => {
    const other = right[i];
    return change.index === other.index && change.worktree === other.worktree && change.path === other.path && change.original === other.original;
  });
}

export async function saveAndPush(ui: Console, directory: string, { upload = true, remote, target }: PushOptions & { upload?: boolean } = {}): Promise<void> {
  const selectedRemote = oneTimeRemote({ remote, target });
  const pushOptions = { remote: selectedRemote, target };
  let repo = await (await projectGit(directory)).repository();
  repo = await createdTargetContext(repo, target);
  await unchangedRemoteTarget(repo, target);
  await repo.ensureReady();
  const sshUrls: string[] = [];
  for (const name of selectedRemote ? [selectedRemote] : await repo.remotes()) {
    sshUrls.push(...(await repo.remoteUrls(name)).filter((url) => url.startsWith('git@github.com:')));
  }
  if (sshUrls.length) repo = await remoteContext(ui, repo, sshUrls);
  const oversized = await autoIgnoreLargeFiles(ui, repo, await repo.changes());
  const changes = await showStatus(ui, repo);
  if (!changes.length) {
    if (upload && await repo.hasCommits() && await ui.routineConfirm('没有新修改，是否检查目标并重试上传已有提交？')) await push(ui, repo, pushOptions);
    return;
  }
  if (!(await repo.config('user.name')) || !(await repo.config('user.email'))) {
    const { bindProject, chooseProfile } = await import('./profiles.js');
    const profile = await chooseProfile(ui);
    if (profile != null && await ui.routineConfirm(`此项目使用 ${profile.label} 的提交署名？`)) {
      await bindProject(repo.directory, profile);
      repo = await (await projectGit(directory)).repository();
    }
  }
  await repo.ensureIdentity();
  const staged = changes.filter((change) => change.staged);
  const protectedChanges = changes.filter((change) => change.staged && change.unstaged);
  if (staged.length) ui.text('注意：已有暂存内容将一并提交，本工具不会偷偷取消你的暂存。');
  if (protectedChanges.length) {
    ui.text('有文件同时包含已暂存和未暂存修改；为保留部分暂存，这些文件仅提交已暂存版本，不加入其余改动：');
    for (const change of protectedChanges) ui.text(`  ${displayPath(change.path)}`);
  }
  const stagedPaths = new Set(staged.flatMap((change) => [change.path, ...(change.original ? [change.original] : [])]));
  const available = changes.filter((change) => change.unstaged && !change.staged &&
    !(change.index === '?' && oversized.has(change.path)) &&
    ![change.path, change.original].some((name) => name !== undefined && stagedPaths.has(name)));
  if (changes.some((change) => change.unstaged && !change.staged && stagedPaths.has(change.path))) {
    ui.text('已有暂存删除或重命名涉及的同名文件不会再次加入，以免撤销原来的暂存选择。');
  }
  let selected: Change[] = [];
  if (available.length) {
    ui.title('选择要加入本次提交的文件');
    selected = (await ui.select(available.map((change) => change.label()))).map((index) => available[index]);
  }
  const gitlinks = new Set(splitNul((await repo.run(['ls-files', '--stage', '-z'])).stdout).filter(entry => entry.subarray(0, 7).equals(Buffer.from('160000 '))).map(entry => decodePath(entry.subarray(entry.indexOf(9) + 1))));
  for (const change of selected) {
    if (!gitlinks.has(change.path) && await exists(path.join(repo.directory, change.path, '.git'))) throw new GitError('选择中包含尚未登记的嵌套 Git 仓库。请先在项目工具中添加为子模块，或仅选择其中普通文件。');
  }
  const included = [...staged, ...selected];
  if (!included.length) {
    ui.text('没有选择文件，也没有已有暂存内容。未进行暂存或提交。');
    if (upload && await repo.hasCommits() && await ui.routineConfirm('不创建新提交，仅检查目标并上传已有提交？')) await push(ui, repo, pushOptions);
    return;
  }
  await protectAccountData(repo, included);
  ui.title('本次提交包含');
  for (const change of included) ui.text(`  ${displayPath(change.path)}${protectedChanges.includes(change) ? '（保留已暂存版本）' : ''}`);
  if (!ui.quick) ui.text('请确认没有密码、令牌或私钥；文件名检查不能保证内容不泄密。');
  const warnings = await riskyPaths(repo, included);
  if (warnings.length) {
    ui.text(warnings.join('\n'));
    if (!(await ui.routineConfirm('仍然将上述风险文件包含在本次提交中？'))) {
      ui.text('已取消，没有添加文件或创建提交。');
      return;
    }
  }
  const message = await ui.ask('用一句话描述这次修改');
  ui.text(`提交说明：${message}\n项目：${repo.directory}`);
  if (!(await ui.routineConfirm('确认暂存选定文件，并创建这个本地提交？（还不会上传）'))) return;
  repo = await createdTargetContext(repo, target);
  await unchangedRemoteTarget(repo, target);
  if (!sameChanges(await repo.changes(), changes)) throw new GitError('选择期间文件状态发生变化。为避免误提交，请重新预览和选择。');
  const paths = selected.flatMap((change) => [change.path, ...(change.original ? [change.original] : [])]);
  if (paths.length) await repo.stagePaths(paths);
  try {
    await repo.run(['commit', '-m', message], { interactive: true });
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    throw new GitError(`没有创建成功的新提交，不会继续推送。暂存内容保留，请检查后重试。\n${error.message}`);
  }
  ui.text(`已保存到本地：${await repo.value('rev-parse', '--short', 'HEAD')}。尚未上传。`);
  if (upload && await ui.routineConfirm('继续选择上传目标并推送到远程吗？')) await push(ui, repo, pushOptions);
}

export async function uploadLocal(ui: Console, directory: string, { selectDirectory = true }: { selectDirectory?: boolean } = {}): Promise<string | undefined> {
  const location = selectDirectory ? await chooseDirectory(ui, directory) : directory;
  let repo = new Git(location);
  const probe = await repo.run(['rev-parse', '--show-toplevel'], { check: false });
  if (probe.status === 0) {
    const root = await repo.root();
    if (root !== location) throw new GitError(`这个目录属于上层仓库 ${root}，不能误把整个上层项目上传。请先切换到仓库根目录。`);
    ui.text('此项目已经是 Git 仓库，将沿用已有历史和配置。');
  } else {
    if (await exists(path.join(location, '.git')) || (await repo.run(['rev-parse', '--is-bare-repository'], { check: false })).status === 0) {
      throw new GitError('该目录不是可初始化的普通工作区（可能是 bare 仓库或异常 .git），请先检查。');
    }
    if (!(await ui.routineConfirm(`在 ${location} 创建 Git 仓库？不会修改上级目录或上传文件。`))) return;
    await repo.run(['init', '--initial-branch=main']);
    ui.text('本地 Git 仓库已初始化。');
  }
  repo = await projectGit(location);
  await repo.ensureReady();
  let target: RemoteTarget | undefined;
  if ((await repo.remotes()).length) {
    const choice = await ui.menu('本次上传目标', ['使用已有远程（沿用现有推送选择规则）', '新建 GitHub 仓库 / 关联另一个远程（不覆盖 origin）']);
    if (!choice) return location;
    if (choice === 2) {
      target = await addRemoteTarget(ui, repo);
      if (!target) return location;
    }
  } else {
    target = await addRemoteTarget(ui, repo);
    if (!target) return location;
  }
  // Creating a remote may have bound the selected account; refresh before checking identity.
  repo = await projectGit(location);
  if (!(await repo.config('user.name')) || !(await repo.config('user.email'))) {
    const { chooseProfile, bindProject } = await import('./profiles.js');
    ui.text('首次提交前需要一个 AutoGit 账号；署名和密钥在软件里管理，不修改项目或全局身份配置。');
    const profile = await chooseProfile(ui);
    if (profile == null) return location;
    if (!(await ui.routineConfirm(`将此项目绑定到 ${profile.label}？仅 AutoGit 操作使用这份身份。`))) return location;
    await bindProject(location, profile);
    repo = await projectGit(location);
    await repo.ensureIdentity();
  }
  if ((await repo.changes()).length) await saveAndPush(ui, location, { target });
  else if (await repo.hasCommits()) await push(ui, repo, { target });
  else ui.text('目录中没有可提交的文件。可以先添加 README 等文件，再运行“保存并上传”。');
  return location;
}

export async function clone(ui: Console, directory: string): Promise<string | undefined> {
  ui.title('下载已有项目');
  const address = validateGitUrl(await ui.ask('Git 仓库的 SSH/HTTPS 地址（支持其他 Git 服务和 SSH Host alias）'));
  const parent = await chooseDirectory(ui, directory);
  const defaultName = address.replace(/\/+$/, '').split(/[/:]/u).at(-1)!.replace(/\.git$/, '');
  const destination = await chooseCloneTarget(ui, parent, defaultName);
  const target = destination.directory;
  const { chooseProfile, profileGit, bindProject } = await import('./profiles.js');
  let profile: Awaited<ReturnType<typeof chooseProfile>> | undefined;
  let runner = new Git(parent);
  // --get-url only resolves configuration; it does not contact the remote.
  const effective = await runner.value('ls-remote', '--get-url', address);
  validateGitUrl(effective);
  // Account isolation follows the actual transport, not the spelling the user pasted.
  const { resolveTransport } = await import('./hosts.js');
  const transport = await resolveTransport(directory);
  let cloneTransport = transport;
  const usesSsh = effective.startsWith('ssh://') || /^[^/:]+:[^/]/u.test(effective);
  if (usesSsh && transport?.mode === 'https') throw new GitError('项目传输模式是 HTTPS，但下载地址使用 SSH；请先切换传输模式或使用 HTTPS 地址。没有联网下载。');
  if (transport?.mode === 'native-ssh') {
    const context = await projectGit(directory);
    runner = new Git(parent, { config: context.overrides, env: context.environment, rejectEnv: context.rejectedEnvironment });
  }
  if ((effective.startsWith('git@') || effective.startsWith('ssh://') || /^[^/:]+:[^/]/u.test(effective)) && transport?.mode !== 'native-ssh') {
    profile = await chooseProfile(ui);
    if (profile == null) {
      ui.text('未选择账号，没有联网下载。请先到“账号与密钥”新建或导入。');
      return;
    }
    if (!cloneTransport && !effective.startsWith('git@github.com:')) {
      const host = effective.startsWith('ssh://') ? new URL(effective).hostname : effective.split(':', 1)[0].split('@').at(-1)!;
      cloneTransport = { mode: 'managed-ssh', host: { provider: 'generic', host, apiHost: '', webBase: `https://${host}`, sshHost: host } };
    }
    runner = await profileGit(parent, profile, cloneTransport);
    ui.text(`下载使用 AutoGit 账号：${profile.label}；成功后自动绑定此项目。`);
  } else if (effective.startsWith('https://')) {
    ui.text('HTTPS 使用 Git 的凭据助手认证；SSH 账号密钥不会改变 HTTPS 登录身份。');
  }
  ui.text(`来源：${redact(effective)}\n保存到：${target}`);
  if (effective !== address) ui.text('注意：Git 的 URL 重写配置改变了原始地址，以上显示的是实际目标。');
  if (!(await ui.routineConfirm('确认联网下载？'))) return;
  if (await runner.value('ls-remote', '--get-url', address) !== effective || !isDeepStrictEqual(await resolveTransport(directory), transport)) throw new GitError('下载目标或传输配置在确认期间变化，未下载。');
  if (profile) {
    const { ProfileStore } = await import('./profiles.js');
    const selected = await new ProfileStore().load(profile.profile_id);
    if (!isDeepStrictEqual(selected, profile)) throw new GitError('下载账号在确认期间变化，未下载。');
    runner = await profileGit(parent, selected, cloneTransport);
  }
  await verifyCloneTarget(destination);
  await runner.run(['clone', '--', address, target], { interactive: true });
  if (cloneTransport) {
    try { const { HostStore } = await import('./hosts.js'); await new HostStore().set(target, cloneTransport); }
    catch (error) { ui.text(`下载已成功，但传输设置保存未完成：${redact(error instanceof Error ? error.message : String(error))}。目录保留，可在项目工具重新配置。`); }
  }
  if (profile != null) {
    try {
      await bindProject(target, profile);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      ui.text(`下载已成功，但账号绑定失败：${redact(error.message)}。请在账号管理重新绑定；目录已保留。`);
    }
  }
  ui.text('下载成功，已切换到该项目。尚未主动执行其中的任何脚本。');
  return target;
}

export async function pull(ui: Console, directory: string): Promise<void> {
  let repo = await (await projectGit(directory)).repository();
  await repo.ensureReady();
  if ((await repo.changes()).length) throw new GitError('工作区有未提交修改，请先保存。不会自动暂存、stash 或覆盖文件。');
  const branch = await repo.branch();
  const remote = await repo.config(`branch.${branch}.remote`);
  const mergeRef = await repo.config(`branch.${branch}.merge`);
  if (!remote || remote === '.' || !mergeRef) throw new GitError('当前分支没有远程上游。请进入“分支与合并 → 远程 fetch → 设置当前分支上游”；这不需要先上传。');
  if (!(await repo.remotes()).includes(remote) || !mergeRef.startsWith('refs/heads/') || (await repo.run(['check-ref-format', mergeRef], { check: false })).status) {
    throw new GitError('上游配置无效，请检查远程和分支配置。');
  }
  const urls = await validateExistingRemote(repo, remote);
  repo = await remoteContext(ui, repo, urls);
  const target = await snapshotRemoteTarget(repo, remote);
  const { repositoryStamp, verifyRepositoryStamp } = await import('./destructive.js');
  const { resolveBinding } = await import('./profiles.js');
  const { resolveTransport } = await import('./hosts.js');
  const stamp = await repositoryStamp(repo);
  const binding = await resolveBinding(repo.directory);
  const transport = await resolveTransport(repo.directory);
  ui.text(`来源：${redact(urls[0])}\n远程分支：${mergeRef.slice('refs/heads/'.length)}\n本地分支：${branch}`);
  if (!(await ui.routineConfirm('确认联网获取更新，并只做快进？（历史分叉时会停止）'))) return;
  await unchangedRemoteTarget(repo, target);
  await verifyRepositoryStamp(repo, stamp);
  if (await repo.config(`branch.${branch}.remote`) !== remote || await repo.config(`branch.${branch}.merge`) !== mergeRef || !isDeepStrictEqual(await resolveBinding(repo.directory), binding) || !isDeepStrictEqual(await resolveTransport(repo.directory), transport)) throw new GitError('上游、账号或传输配置在确认期间变化，未拉取。');
  repo = await (await projectGit(repo.directory)).repository();
  await repo.run(['pull', '--ff-only', '--no-rebase', '--', remote, mergeRef], { interactive: true });
  ui.text('更新成功：已安全快进或已经是最新状态。');
}

export async function inspect(ui: Console, directory: string): Promise<void> {
  const repo = await (await projectGit(directory)).repository();
  const choice = await ui.menu('查看项目', ['文件状态', '未暂存差异', '已暂存差异', '最近 20 条提交']);
  if (choice === 1) await showStatus(ui, repo);
  else if (choice === 2 || choice === 3) {
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--stat'];
    if (choice === 3) args.push('--cached');
    ui.text((await repo.value(...args)) || '没有差异。');
    args.splice(args.indexOf('--stat'), 1);
    await repo.run(args, { interactive: true });
  } else if (choice === 4) {
    if (!(await repo.hasCommits())) ui.text('还没有提交记录。');
    else ui.text(await repo.value('log', '-20', '--date=short', '--format=%h  %ad  %s'));
  }
}

export async function branches(ui: Console, directory: string): Promise<void> {
  const { branchesMenu } = await import('./branches.js');
  await branchesMenu(ui, directory);
}
