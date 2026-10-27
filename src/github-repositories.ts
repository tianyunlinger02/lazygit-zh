/** Guided GitHub repository operations. Every target is an explicit host/owner/name tuple. */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Git, GitError } from './git.js';
import {
  GithubClient, authenticateGithub, inputText, loginName, objectResponse, positiveNumber, repositoryContext,
  repositoryPath, repositoryUrl, safeDisplay, textField, validateHost, validateRepositoryName,
  type RepositoryContext, type Visibility,
} from './github.js';
import { chooseProfile, ProfileStore, resolveBinding, profileGit, bindProject, type Profile } from './profiles.js';
import { DEFAULT_TRANSPORT, HostStore, resolveTransport, transportUrl, validateTransport, type TransportTarget } from './hosts.js';
import { checkedPath } from './storage.js';
import { chooseCloneTarget, verifyCloneTarget } from './clone-target.js';
import { Cancelled, type Console } from './ui.js';

export interface GithubSession {
  readonly client: GithubClient;
  readonly profile: Profile;
  readonly directory: string;
  readonly host: string;
  readonly transport?: TransportTarget;
  checkProfile(): Promise<void>;
}
export interface RepositorySummary extends RepositoryContext { readonly private: boolean; readonly description: string; readonly defaultBranch: string }
const REPO_FIELDS = ['owner', 'name', 'private', 'description', 'default_branch'] as const;
const REPO_PROJECT = '{owner: .owner.login, name: .name, private: .private, description: .description, default_branch: .default_branch}';
export const PAGE_SIZE = 30;
export function pageNumber(value: number): number { return positiveNumber(value); }
export function listResponse(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100) throw new GitError('GitHub 列表响应无效或超过单页上限。');
  return value;
}
export function parseRepository(value: unknown, host: string): RepositorySummary {
  const data = objectResponse(value, REPO_FIELDS);
  const context = repositoryContext(host, textField(data.owner), textField(data.name));
  if (typeof data.private !== 'boolean') throw new GitError('GitHub 仓库可见性字段无效。');
  return { ...context, private: data.private, description: textField(data.description, true), defaultBranch: textField(data.default_branch, true) };
}
export async function listRepositories(client: GithubClient, owner: string, page = 1, search?: string): Promise<RepositorySummary[]> {
  loginName(owner); pageNumber(page);
  const endpoint = search === undefined ? `users/${owner}/repos?per_page=${PAGE_SIZE}&page=${page}&sort=updated` :
    `search/repositories?q=${encodeURIComponent(`${inputText(search)} user:${owner}`)}&per_page=${PAGE_SIZE}&page=${page}`;
  // /user/repos includes private repositories of the selected actor. /users/{owner}/repos does not.
  let actual = search === undefined && owner.toLowerCase() === client.actor?.toLowerCase() ? `user/repos?affiliation=owner&per_page=${PAGE_SIZE}&page=${page}&sort=updated` : endpoint;
  if (search === undefined && owner.toLowerCase() !== client.actor?.toLowerCase()) {
    const kind = objectResponse(await client.readJson(`users/${owner}`, '{type: .type}'), ['type']);
    if (kind.type === 'Organization') actual = `orgs/${owner}/repos?per_page=${PAGE_SIZE}&page=${page}&sort=updated`;
    else if (kind.type !== 'User') throw new GitError('仓库 owner 类型不是支持的 User / Organization。');
  }
  const result = listResponse(await client.readJson(actual, `${search === undefined ? '.' : '.items'} | map(${REPO_PROJECT})`)).map((data) => parseRepository(data, client.host));
  if (result.some((item) => item.owner.toLowerCase() !== owner.toLowerCase())) throw new GitError('搜索 / 列表返回了不同 owner；请移除冲突搜索条件后重新选择。');
  return result;
}
export async function viewRepository(client: GithubClient, context: RepositoryContext): Promise<RepositorySummary> {
  assertHost(client, context);
  const data = parseRepository(await client.readJson(repositoryPath(context), REPO_PROJECT), context.host);
  if (data.owner.toLowerCase() !== context.owner.toLowerCase() || data.name.toLowerCase() !== context.name.toLowerCase()) throw new GitError('GitHub 返回的仓库与选择不一致；仓库可能已转移或改名，请重新选择。');
  return data;
}
export function assertHost(client: GithubClient, context: RepositoryContext): void {
  repositoryContext(context.host, context.owner, context.name);
  if (validateHost(context.host) !== client.host) throw new GitError('仓库 host 与选定客户端不一致。');
}

/** Remote writes default to one hard confirmation; explicit local/download actions can be routine. */
export interface ConfirmGithubWriteOptions { readonly mode?: 'hard' | 'routine'; readonly scope?: 'remote' | 'local' }
export async function confirmGithubWrite(ui: Console, session: GithubSession, context: RepositoryContext | undefined, action: string, details: string, options: ConfirmGithubWriteOptions = {}): Promise<boolean> {
  if (context) assertHost(session.client, context);
  ui.text(safeDisplay(`操作：${action}\nGitHub actor：${session.profile.github_login}\nhost：${session.host}${context ? `\n仓库：${context.owner}/${context.name}` : ''}\n${details}`));
  ui.text(options.mode === 'routine' || options.scope === 'local' ? '不会写入 GitHub 远程状态，也不会隐式 push、fork 或更改本地远程。' : '不会隐式 push、fork 或更改本地远程；未知写入结果不会自动重试或回滚。');
  if (!await (options.mode === 'routine' ? ui.routineConfirm('执行以上下载 / 本地操作？') : ui.confirm('最终确认：执行以上操作？'))) return false;
  await session.checkProfile();
  return true;
}
export async function confirmGithubRoutine(ui: Console, session: GithubSession, context: RepositoryContext | undefined, action: string, details: string): Promise<boolean> {
  return confirmGithubWrite(ui, session, context, action, details, { mode: 'routine' });
}
function defaultGithubTransport(host: string): TransportTarget {
  const checked = validateHost(host);
  return checked === 'github.com' ? validateTransport(DEFAULT_TRANSPORT) : validateTransport({ mode: 'managed-ssh', host: { provider: 'github-enterprise', host: checked, apiHost: checked, webBase: `https://${checked}`, sshHost: checked } });
}
export function githubTransport(session: GithubSession, context?: RepositoryContext): TransportTarget {
  const target = validateTransport(session.transport ?? defaultGithubTransport(session.host));
  if (target.host.provider === 'generic' || validateHost(target.host.host) !== session.host || context && validateHost(context.host) !== session.host) throw new GitError('GitHub 仓库与明确选择的 GitHub / Enterprise 传输主机不一致；不会把 generic Git 当成 GitHub API 服务。');
  return target;
}
export function transportSummary(transport: TransportTarget): string {
  return transport.mode === 'managed-ssh' ? 'managed-ssh：使用选定 AutoGit 托管密钥及独立 known_hosts。' : transport.mode === 'native-ssh' ? 'native-ssh：沿用外部 SSH config / alias / 代理与认证；API actor 和 AutoGit 绑定不代表实际 SSH 登录身份。' : 'https：使用外部 Git 凭据助手认证；API actor 和托管 SSH 密钥不会决定 HTTPS 登录身份。';
}
export async function githubSession(ui: Console, directory: string): Promise<GithubSession | undefined> {
  const binding = await resolveBinding(directory), profile = binding ?? await chooseProfile(ui);
  if (!profile) return undefined;
  const configuredTransport = await resolveTransport(directory);
  const githubConfigured = configuredTransport?.host.provider !== 'generic' ? configuredTransport : undefined;
  if (configuredTransport?.host.provider === 'generic') ui.text('当前项目是 generic Git；它不提供 GitHub 协作 API。请明确选择另一个 GitHub / Enterprise host，不会把 generic 主机冒充 GitHub。');
  const host = validateHost(await ui.ask('GitHub host（不带协议或路径）', githubConfigured?.host.host ?? 'github.com'));
  const transport = githubConfigured?.host.host.toLowerCase() === host ? validateTransport(githubConfigured) : defaultGithubTransport(host);
  const snapshot = { ...profile }, bindingSnapshot = binding ? { ...binding } : undefined;
  const store = new ProfileStore();
  const checkProfile = async (): Promise<void> => {
    const current = await store.load(profile.profile_id), currentBinding = await resolveBinding(directory);
    if (!isDeepStrictEqual({ ...current }, snapshot) || !isDeepStrictEqual(currentBinding ? { ...currentBinding } : undefined, bindingSnapshot)) throw new GitError('选定 AutoGit 账号或项目绑定已变化；请重新进入操作，不会自动更换账号。');
    if (!isDeepStrictEqual(await resolveTransport(directory), configuredTransport)) throw new GitError('项目传输配置已变化；请重新预览，不会静默改用其它主机或认证模式。');
  };
  await checkProfile();
  const client = new GithubClient(directory, { host, actor: profile.github_login });
  if (!await authenticateGithub(ui, client, profile.github_login)) return undefined;
  return { client, profile, host, directory, transport, checkProfile };
}

export async function pagedSelection<T>(ui: Console, title: string, load: (page: number) => Promise<T[]>, label: (item: T) => string): Promise<T | undefined> {
  let page = 1;
  for (;;) {
    const items = await load(page);
    const navigation = [...(page > 1 ? ['上一页'] : []), ...((items as T[] & { hasNext?: boolean }).hasNext ?? items.length === PAGE_SIZE ? ['下一页'] : [])];
    if (!items.length) ui.text('本页没有结果。');
    const choice = await ui.menu(`${title} · 第 ${page} 页`, [...items.map((item) => safeDisplay(label(item))), ...navigation]);
    if (!choice) return undefined;
    if (choice <= items.length) return items[choice - 1];
    const action = navigation[choice - items.length - 1];
    page += action === '上一页' ? -1 : 1;
  }
}
export async function chooseRepository(ui: Console, session: GithubSession): Promise<RepositoryContext | undefined> {
  const owner = loginName(await ui.ask('仓库 owner（个人或组织）', session.profile.github_login));
  const mode = await ui.menu('明确选择仓库', ['分页列出 owner 的仓库', '搜索 owner 的仓库', '输入仓库名称']);
  if (!mode) return undefined;
  if (mode === 3) {
    const context = repositoryContext(session.host, owner, await ui.ask('仓库名称'));
    await viewRepository(session.client, context);
    return context;
  }
  const query = mode === 2 ? await ui.ask('搜索词（可使用 GitHub 仓库搜索语法）') : undefined;
  const selected = await pagedSelection(ui, `${session.host}/${owner} 仓库`, (page) => listRepositories(session.client, owner, page, query), (repo) => `${repo.owner}/${repo.name} · ${repo.private ? 'private' : 'public'} · ${repo.description}`);
  return selected ? repositoryContext(selected.host, selected.owner, selected.name) : undefined;
}
export async function readBody(ui: Console, defaultValue = ''): Promise<string> {
  const choice = await ui.menu('正文来源', ['多行输入', '从明确的 UTF-8 文本文件导入', '空正文']);
  if (!choice) throw new Cancelled();
  if (choice === 3) return '';
  if (choice === 1) return inputText(await (ui as Console & { multiline(prompt: string, defaultValue?: string): Promise<string> }).multiline('正文（可能公开，请勿包含机密）', defaultValue), true);
  const { constants } = await import('node:fs');
  const { open } = await import('node:fs/promises');
  const file = checkedPath(path.resolve(await ui.ask('正文文件绝对路径')), 'file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 262_144) throw new GitError('正文文件必须是至多 256 KiB 的单链接普通文件。');
    const bytes = Buffer.alloc(262_145);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 262_144) throw new GitError('正文文件过大。');
    try { return inputText(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)), true); }
    catch { throw new GitError('正文文件不是受支持的 UTF-8 文本；不会显示原始内容。'); }
  } finally { await handle.close(); }
}
export async function githubAction(ui: Console, action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) {
    if (error instanceof Cancelled || error instanceof GitError) ui.text(safeDisplay(error.message));
    else if (error instanceof Error && 'code' in error) ui.text('文件操作未完成；已有外部步骤不会自动恢复。请检查路径与权限。');
    else throw error;
  }
}

/** An ephemeral remote makes Git resolve pushInsteadOf/pushurl exactly as push will, without persisting config. */
export async function explicitGitTransport(repo: Git, address: string, push = false): Promise<{ git: Git; remote: string }> {
  const remote = `autogit-explicit-${randomBytes(12).toString('hex')}`;
  if ((await repo.remotes()).includes(remote)) throw new GitError('一次性远程名冲突；请重新选择。');
  const git = repo.configured({ [`remote.${remote}.url`]: address });
  const urls = await git.remoteUrls(remote, push);
  if (urls.length !== 1 || urls[0].toLowerCase() !== address.toLowerCase()) throw new GitError('Git URL 重写 / pushurl 改变了明确选择的目标；已停止，不会传输。');
  return { git, remote };
}
export async function cloneRepository(ui: Console, session: GithubSession, context: RepositoryContext): Promise<string | undefined> {
  assertHost(session.client, context);
  const parent = checkedPath(path.resolve(session.directory, await ui.ask('下载父目录', session.directory)), 'dir');
  const target = await chooseCloneTarget(ui, parent, context.name);
  const transport = githubTransport(session, context), address = transportUrl(`${context.owner}/${context.name}`, transport);
  let git = await profileGit(parent, session.profile, transport);
  if ((await git.value('ls-remote', '--get-url', address)).toLowerCase() !== address.toLowerCase()) throw new GitError('Git URL 重写改变了选定仓库目标，拒绝下载。');
  if (!await confirmGithubRoutine(ui, session, context, '按明确传输模式下载仓库', `来源：${address}\n传输：${transportSummary(transport)}\n新目录：${target.directory}\n成功后先保存该主机/传输配置，再绑定选定 AutoGit 账号；绑定仅决定 AutoGit 提交署名及托管模式身份。不会改写 clone 生成的 origin，不执行项目脚本。`)) return undefined;
  git = await profileGit(parent, session.profile, transport);
  if ((await git.value('ls-remote', '--get-url', address)).toLowerCase() !== address.toLowerCase()) throw new GitError('确认期间 Git 下载目标发生变化，已停止。');
  await verifyCloneTarget(target);
  await git.run(['clone', '--', address, target.directory], { interactive: true });
  ui.text(`下载已完成：${target.directory}。尚未执行项目脚本。`);
  let savedTransport = false;
  try {
    await session.checkProfile();
    await new HostStore().set(target.directory, transport); savedTransport = true;
    ui.text('新项目主机 / 传输配置已保存；origin 保持 clone 时的明确地址。');
    await bindProject(target.directory, session.profile);
  } catch {
    ui.text(`下载目录保留；主机 / 传输配置${savedTransport ? '已保存' : '尚未保存'}，账号绑定未完成。请在项目工具核对主机及传输模式，再在账号管理明确绑定；不会自动回滚或改用默认认证。`);
    return target.directory;
  }
  ui.text('下载、传输配置保存及 AutoGit 账号绑定均已完成；未执行项目脚本。');
  return target.directory;
}
export async function updateRepository(client: GithubClient, context: RepositoryContext, patch: { private?: boolean; name?: string }): Promise<void> {
  assertHost(client, context);
  if (patch.private !== undefined && typeof patch.private !== 'boolean') throw new GitError('必须明确选择可见性。');
  if (patch.name !== undefined) validateRepositoryName(patch.name);
  if (!Object.keys(patch).length || Object.keys(patch).some((key) => !['private', 'name'].includes(key))) throw new GitError('仓库修改字段无效。');
  await client.writeJson('PATCH', repositoryPath(context), patch);
}
export async function forkRepository(client: GithubClient, context: RepositoryContext, owner: string, name: string): Promise<void> {
  assertHost(client, context); loginName(owner); validateRepositoryName(name);
  await client.writeJson('POST', `${repositoryPath(context)}/forks`, { name, ...(owner.toLowerCase() === client.actor?.toLowerCase() ? {} : { organization: owner }) });
}
export async function deleteRepository(client: GithubClient, context: RepositoryContext): Promise<void> { assertHost(client, context); await client.writeJson('DELETE', repositoryPath(context)); }
export type Permission = 'pull' | 'triage' | 'push' | 'maintain' | 'admin';
export function permission(value: string): Permission {
  if (!['pull', 'triage', 'push', 'maintain', 'admin'].includes(value)) throw new GitError('权限必须明确选择 pull/triage/push/maintain/admin。');
  return value as Permission;
}
export async function setCollaborator(client: GithubClient, context: RepositoryContext, login: string, role: Permission | undefined): Promise<void> {
  assertHost(client, context); loginName(login); if (role) permission(role);
  await client.writeJson(role ? 'PUT' : 'DELETE', `${repositoryPath(context)}/collaborators/${login}`, role ? { permission: role } : undefined);
}
export async function setTeamPermission(client: GithubClient, context: RepositoryContext, organization: string, slug: string, role: Permission | undefined): Promise<void> {
  assertHost(client, context); loginName(organization);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u.test(slug)) throw new GitError('团队 slug 无效。');
  if (role) permission(role);
  if (organization.toLowerCase() !== context.owner.toLowerCase()) throw new GitError('团队必须属于仓库 owner 组织。');
  await client.writeJson(role ? 'PUT' : 'DELETE', `orgs/${organization}/teams/${slug}/repos/${context.owner}/${context.name}`, role ? { permission: role } : undefined);
}
async function choosePermission(ui: Console): Promise<Permission | undefined> {
  const values = ['pull', 'triage', 'push', 'maintain', 'admin'] as const;
  const selected = await ui.menu('权限（admin 可控制仓库，请谨慎）', values);
  return selected ? values[selected - 1] : undefined;
}
async function permissionsMenu(ui: Console, session: GithubSession, context: RepositoryContext): Promise<void> {
  for (;;) {
    const choice = await ui.menu('协作者 / 组织团队权限', ['分页查看协作者', '分页查看待接受邀请', '邀请协作者 / 修改协作者权限', '移除协作者', '撤销待接受邀请', '分页查看已授权团队', '添加团队 / 修改团队权限', '移除团队权限']);
    if (!choice) return;
    await githubAction(ui, async () => {
      const root = repositoryPath(context), { client } = session;
      if ([1, 2, 6].includes(choice)) {
        const endpoint = choice === 1 ? 'collaborators' : choice === 2 ? 'invitations' : 'teams';
        const fields = choice === 1 ? ['login', 'role'] : choice === 2 ? ['id', 'login', 'permission'] : ['slug', 'permission'];
        const query = choice === 1 ? 'map({login: .login, role: .role_name})' : choice === 2 ? 'map({id: .id, login: .invitee.login, permission: .permissions})' : 'map({slug: .slug, permission: .permission})';
        await pagedSelection(ui, '权限列表（选择仅查看）', async (page) => listResponse(await client.readJson(`${root}/${endpoint}?per_page=${PAGE_SIZE}&page=${page}`, query)).map((value) => objectResponse(value, fields)), (data) => fields.map((field) => `${field}: ${String(data[field] ?? '')}`).join(' · '));
        return;
      }
      if (choice === 5) {
        const id = positiveNumber(await ui.ask('待撤销邀请编号（从邀请列表查看）'));
        if (await confirmGithubWrite(ui, session, context, '撤销协作者邀请', `邀请编号：${id}`)) await client.writeJson('DELETE', `${root}/invitations/${id}`);
        return;
      }
      const team = choice >= 7;
      const target = team ? await ui.ask('仓库 owner 组织内的团队 slug') : loginName(await ui.ask('协作者 GitHub 登录名'));
      const remove = choice === 4 || choice === 8;
      const role = remove ? undefined : await choosePermission(ui);
      if (!remove && !role) return;
      if (await confirmGithubWrite(ui, session, context, remove ? '移除仓库权限' : '邀请 / 设置仓库权限', `${team ? '组织团队' : '协作者'}：${target}\n权限：${role ?? '移除'}`)) {
        if (team) await setTeamPermission(client, context, context.owner, target, role);
        else await setCollaborator(client, context, target, role);
        ui.text('GitHub 已接受权限请求；邀请是否被接受、继承的组织权限请通过只读列表核对。');
      }
    });
  }
}

export async function githubMenu(ui: Console, directory: string): Promise<string | undefined> {
  const session = await githubSession(ui, directory); if (!session) return undefined;
  let context: RepositoryContext | undefined;
  for (;;) {
    const choice = await ui.menu(`GitHub 仓库${context ? ` · ${context.host}/${context.owner}/${context.name}` : ''}`, ['选择仓库 / 分页列表 / 搜索', '查看仓库', '下载选定仓库', '新建个人 / 组织空仓库', 'Fork 到个人 / 组织（不 clone、不关联远程）', '修改公开 / 私有', '重命名仓库', '删除仓库', '协作者 / 团队权限', '向选定账号上传 SSH 公钥', 'Pull requests', 'Issues', 'Tags / Releases']);
    if (!choice) return undefined;
    let downloaded: string | undefined;
    await githubAction(ui, async () => {
      if (choice === 1) { context = await chooseRepository(ui, session); return; }
      if (choice === 11) { const { pullRequestsMenu } = await import('./pull-requests.js'); await pullRequestsMenu(ui, directory); return; }
      if (choice === 12) { const { issuesMenu } = await import('./issues.js'); await issuesMenu(ui, directory); return; }
      if (choice === 13) { const { releasesMenu } = await import('./releases.js'); await releasesMenu(ui, directory); return; }
      if (choice === 4) {
        const owner = loginName(await ui.ask('新仓库 owner（个人或有创建权限的组织）', session.profile.github_login));
        const name = validateRepositoryName(await ui.ask('新仓库名称'));
        const selected = await ui.menu('明确选择可见性', ['private 私有', 'public 公开']); if (!selected) return;
        const visibility: Visibility = selected === 1 ? 'private' : 'public';
        const target = repositoryContext(session.host, owner, name);
        if (await confirmGithubWrite(ui, session, target, '创建空仓库', `可见性：${visibility}\n不添加 README、提交、推送或本地 remote。组织创建权限由 GitHub 核对。`)) {
          await session.client.createRepository(owner, name, visibility, (url) => ui.text(`已创建：${url}；后续验证失败也不会删除。`)); context = target;
        }
        return;
      }
      if (choice === 10) { const { uploadPublicKey } = await import('./public-key.js'); await uploadPublicKey(ui, session); return; }
      if (!context) { context = await chooseRepository(ui, session); if (!context) return; }
      const target = context;
      if (choice === 2) { const repo = await viewRepository(session.client, target); ui.text(safeDisplay(`${repositoryUrl(repo.owner, repo.name, repo.host)}\n${repo.private ? 'private' : 'public'}\n默认分支：${repo.defaultBranch}\n${repo.description}`)); }
      else if (choice === 3) downloaded = await cloneRepository(ui, session, target);
      else if (choice === 5) {
        const owner = loginName(await ui.ask('Fork 目标 owner', session.profile.github_login)), name = validateRepositoryName(await ui.ask('Fork 仓库名称', target.name));
        if (await confirmGithubWrite(ui, session, target, 'Fork 仓库', `目标：${session.host}/${owner}/${name}\nFork 可能异步创建；不 clone、不修改本地 remote。`)) { await forkRepository(session.client, target, owner, name); ui.text('GitHub 已接受 Fork 请求；请用列表 / 查看检查完成情况。'); }
      } else if (choice === 6) {
        const selected = await ui.menu('新可见性', ['private 私有', 'public 公开（所有人可见）']); if (!selected) return;
        if (await confirmGithubWrite(ui, session, target, '修改仓库可见性', `新可见性：${selected === 1 ? 'private' : 'public'}\n此操作可能影响 fork、星标、访问权限及敏感内容曝光。`)) await updateRepository(session.client, target, { private: selected === 1 });
      } else if (choice === 7) {
        const name = validateRepositoryName(await ui.ask('新仓库名称'));
        if (await confirmGithubWrite(ui, session, target, '重命名仓库', `新名称：${name}\n不自动修改任何本地 remote；请随后明确更新。`)) { await updateRepository(session.client, target, { name }); context = repositoryContext(target.host, target.owner, name); }
      } else if (choice === 8) {
        if (await confirmGithubWrite(ui, session, target, '永久删除仓库', '不可撤销：代码、issues、PR、release 等远程数据可能永久丢失；本地 remote 和文件不会删除。')) { await deleteRepository(session.client, target); context = undefined; }
      } else if (choice === 9) await permissionsMenu(ui, session, target);
    });
    if (downloaded) return downloaded;
  }
}
