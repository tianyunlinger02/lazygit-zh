/** GitHub CLI boundary. Managed sessions use only explicitly enrolled Vault tokens. */
import { resolve } from 'node:path';
import { currentSession, requireSession, type CredentialSession } from './session.js';
import { credentialsMenu, enrollToken, validateToken, sessionGhDirectory } from './credentials.js';
import { GitError, validateUrl } from './git.js';
import { runProcess, which, type ProcessResult } from './process.js';
import { exactKeys, parseStrictJson, record } from './storage.js';
import { Cancelled, type Console } from './ui.js';

export type Visibility = 'private' | 'public';
export interface CreatedRepository {
  owner: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  sshUrl: string;
  httpsUrl: string;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const CREDENTIAL_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
const SIDE_EFFECT_ENV = ['DEBUG', 'PAGER', 'GIT_PAGER', 'BROWSER', 'CLICOLOR_FORCE', 'FORCE_COLOR'];
const REPOSITORY_FIELDS = ['owner', 'name', 'full_name', 'private', 'html_url', 'ssh_url', 'clone_url'];
const REPOSITORY_QUERY = '{owner: {login: .owner.login}, name: .name, full_name: .full_name, private: .private, html_url: .html_url, ssh_url: .ssh_url, clone_url: .clone_url}';

export function loginName(value: string): string {
  if (typeof value !== 'string' || !LOGIN.test(value)) throw new GitError('GitHub 登录名无效；需要 1–39 位字母、数字或单个连字符，且不能以连字符开头或结尾。');
  return value;
}

export function validateRepositoryName(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/u.test(value) || value.startsWith('-') || /^\.+$/u.test(value)) {
    throw new GitError('仓库名必须是 1–100 位 ASCII 字母、数字、下划线、点或连字符，不能以 - 开头或全部为点；不能填写地址、路径或空白。');
  }
  if (/\.git$/iu.test(value)) throw new GitError('仓库名不能带 .git 后缀；请明确输入实际仓库名，不会自动截取或改名。');
  return value;
}

function statusDetail(result: ProcessResult): string {
  return Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? `退出码 ${result.status}` : '退出状态未知';
}
function launchDetail(error: unknown): string {
  if (error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'EPERM', 'EINTR'].includes(String(error.code))) return `（${String(error.code)}）`;
  return '（启动或执行状态未知）';
}
function safeStderr(result: ProcessResult): string {
  if (!Buffer.isBuffer(result.stderr) || result.stderr.length > 16_384) return '';
  return result.stderr.toString('utf8').toLowerCase();
}
function creationFailure(result: ProcessResult, url: string): string {
  if (result.signal) return `GitHub 创建已中断，结果未知，仓库可能已创建。${recovery(url)}`;
  const stderr = safeStderr(result);
  const code = /\b(401|403|409|422)\b/u.exec(stderr)?.[1];
  if (code === '401' || /authentication required|not logged in|authentication failed|bad credentials|unauthorized/u.test(stderr)) {
    return `GitHub 创建未完成（401：认证未通过或已过期）；请重新明确登录 gh 当前账号。${recovery(url)}`;
  }
  if (code === '403' || /forbidden|permission denied|must have admin rights|resource not accessible/u.test(stderr)) {
    return `GitHub 创建未完成（403：当前账号没有创建权限）；请核对 gh 当前账号与组织权限。${recovery(url)}`;
  }
  if (code === '422' || code === '409' || /already exists|name already exists|name is already taken|repository.*exists|validation failed/u.test(stderr)) {
    return `GitHub 创建未完成（名称可能已存在或参数无效）；请检查 ${url} 或选择关联已有仓库。不会自动重试、删除或覆盖仓库。`;
  }
  if (/rate limit|timed out|timeout|could not resolve|connection refused|connection reset|network is unreachable|temporary failure|tls|socket/u.test(stderr)) {
    return `GitHub 创建请求网络失败，结果未知，仓库可能已创建。${recovery(url)}`;
  }
  return `GitHub 创建未确认成功（${statusDetail(result)}），结果未知，仓库可能已创建。${recovery(url)}`;
}
function outputText(result: ProcessResult, limit: number): string {
  if (!Buffer.isBuffer(result.stdout) || result.stdout.length > limit) throw new GitError('gh 输出格式无效，已停止；不会显示原始输出。');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout); }
  catch { throw new GitError('gh 输出编码无效，已停止；不会显示原始输出。'); }
}
function sameName(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
export interface RepositoryContext { readonly host: string; readonly owner: string; readonly name: string }
export interface GithubOptions {
  runProcess?: typeof runProcess; which?: typeof which; env?: NodeJS.ProcessEnv;
  host?: string; actor?: string; actorLogin?: string; owner?: string;
}
export function validateHost(value: string): string {
  if (typeof value !== 'string' || value.length > 253 || !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u.test(value)) throw new GitError('GitHub host 必须是明确的 DNS 主机名，不能带协议、端口、路径或凭据。');
  return value.toLowerCase();
}
export function repositoryContext(host: string, owner: string, name: string): RepositoryContext {
  return Object.freeze({ host: validateHost(host), owner: loginName(owner), name: validateRepositoryName(name) });
}
export function repositoryUrl(owner: string, name: string, host = 'github.com'): string {
  const context = repositoryContext(host, owner, name);
  return `https://${context.host}/${context.owner}/${context.name}`;
}
export function repositoryPath(context: RepositoryContext): string {
  const checked = repositoryContext(context.host, context.owner, context.name);
  return `repos/${checked.owner}/${checked.name}`;
}
export function repositorySsh(context: RepositoryContext): string { return `git@${validateHost(context.host)}:${loginName(context.owner)}/${validateRepositoryName(context.name)}.git`; }
export function safeDisplay(value: unknown): string {
  // Remote titles/bodies are untrusted terminal text, never terminal control sequences.
  return String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export function inputText(value: string, multiline = false): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 262_144 || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u : /[\x00-\x1f\x7f-\x9f]/u).test(value)) throw new GitError('输入含不支持的控制字符或过长，已停止。');
  return value;
}
export function positiveNumber(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw new GitError('需要明确的正整数编号。');
  return number;
}
export function objectResponse(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!record(value) || !exactKeys(value, fields)) throw new GitError('GitHub JSON 投影字段无效；原始响应已隐藏。');
  return value;
}
export function textField(value: unknown, nullable = false): string {
  if (nullable && value === null) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value) > 262_144) throw new GitError('GitHub JSON 文本字段无效。');
  return value;
}
function readFailure(result: ProcessResult, writing = false): GitError {
  const stderr = safeStderr(result);
  const reason = /\b401\b|bad credentials|authentication required|not logged in/u.test(stderr) ? '401：认证未通过或已过期' :
    /rate limit/u.test(stderr) ? '请求频率受限' : /\b403\b|forbidden|permission denied|resource not accessible/u.test(stderr) ? '403：权限不足' :
    /\b404\b|not found/u.test(stderr) ? '404：对象不存在或当前账号不可见' : /\b409\b|\b422\b|validation failed/u.test(stderr) ? '409/422：状态冲突或参数无效' :
    /timeout|timed out|could not resolve|connection|network|tls|socket/u.test(stderr) ? '网络失败' : statusDetail(result);
  return new GitError(`GitHub 操作未确认成功（${reason}）${writing ? '；写入结果未知，请先只读检查目标。不会自动重试或回滚已完成步骤' : ''}。原始输出已隐藏。`);
}
function recovery(url: string): string {
  return `请先检查 ${url}；如仓库已存在，请选择关联已有仓库。不会自动重试、删除仓库或回滚已完成步骤。`;
}
function knownCreated(url: string): string { return `GitHub 仓库已创建：${url}。后续确认未完成；${recovery(url)}`; }

function checkedRepository(result: ProcessResult, owner: string, name: string, visibility: Visibility, host = 'github.com'): CreatedRepository {
  let data: unknown;
  try { data = parseStrictJson(outputText(result, 65_536)); }
  catch { throw new GitError('GitHub 仓库验证响应不是支持的严格 JSON。'); }
  if (!record(data) || !exactKeys(data, REPOSITORY_FIELDS) || !record(data.owner) || !exactKeys(data.owner, ['login']) ||
      typeof data.owner.login !== 'string' || typeof data.name !== 'string' || typeof data.full_name !== 'string' || typeof data.private !== 'boolean') {
    throw new GitError('GitHub 仓库验证字段无效。');
  }
  const actualOwner = loginName(data.owner.login), actualName = validateRepositoryName(data.name);
  if (!sameName(actualOwner, owner) || !sameName(actualName, name) || !sameName(data.full_name, `${actualOwner}/${actualName}`) || data.private !== (visibility === 'private')) {
    throw new GitError('GitHub 仓库验证的归属、名称或可见性不匹配。');
  }
  const checkedHost = validateHost(host);
  const urls = {
    htmlUrl: repositoryUrl(actualOwner, actualName, checkedHost),
    sshUrl: checkedHost === 'github.com' ? validateUrl(`git@github.com:${actualOwner}/${actualName}.git`) : `git@${checkedHost}:${actualOwner}/${actualName}.git`,
    httpsUrl: `https://${checkedHost}/${actualOwner}/${actualName}.git`,
  };
  // Exact prefixes and case-insensitive repository paths: no redirects, credentials,
  // query strings, fragments, encoded paths, trailing slash or alternative hosts.
  for (const [value, expected, prefix] of [
    [data.html_url, urls.htmlUrl, `https://${checkedHost}/`],
    [data.ssh_url, urls.sshUrl, `git@${checkedHost}:`],
    [data.clone_url, urls.httpsUrl, `https://${checkedHost}/`],
  ] as const) {
    if (typeof value !== 'string' || !value.startsWith(prefix) || !sameName(value, expected)) throw new GitError('GitHub 仓库验证地址不是预期 host 的规范地址。');
  }
  return { owner: actualOwner, name: actualName, private: data.private, ...urls };
}

export class GithubClient {
  private readonly cwd: string;
  private readonly runner: typeof runProcess;
  private readonly findTool: typeof which;
  private readonly environment: NodeJS.ProcessEnv | undefined;
  private managedSession: CredentialSession | undefined;
  readonly host: string;
  private selectedActor: string | undefined;
  get actor(): string | undefined { return this.selectedActor; }
  readonly owner: string | undefined;
  constructor(cwd: string, options: GithubOptions = {}) {
    this.cwd = resolve(cwd);
    this.runner = options.runProcess ?? runProcess;
    this.findTool = options.which ?? which;
    // Do not snapshot process.env: credentials added after construction must still
    // be rejected, and the caller's environment is never mutated.
    this.environment = options.env;
    this.managedSession = currentSession();
    this.host = validateHost(options.host ?? 'github.com');
    if (options.actor && options.actorLogin && !sameName(options.actor, options.actorLogin)) throw new GitError('选定 actor 不一致。');
    this.selectedActor = options.actor || options.actorLogin ? loginName(options.actor ?? options.actorLogin!) : undefined;
    this.owner = options.owner ? loginName(options.owner) : undefined;
  }

  private session(): CredentialSession | undefined {
    const active = currentSession();
    if (this.managedSession) {
      if (this.managedSession.closed || active !== this.managedSession) throw new GitError('GitHub 凭据会话已关闭或变化；请重新选择账号，不能回退外部 gh。');
      return this.managedSession;
    }
    if (active) { if (active.closed) throw new GitError('GitHub 凭据会话已经关闭。'); this.managedSession = active; }
    return active;
  }
  private prepareEnvironment(interactive = false): NodeJS.ProcessEnv {
    const source = this.environment ?? process.env;
    const normalize = (key: string): string => process.platform === 'win32' ? key.toUpperCase() : key;
    const keys = Object.keys(source);
    const blocked = keys.map(normalize).filter((key) => CREDENTIAL_ENV.includes(key));
    // Inspect names before copying/reading ANY environment values, even empty or
    // undefined token values. Never include an external value in an error.
    if (blocked.length) throw new GitError(`检测到 GitHub 凭据环境变量（不显示值），请先移除：${blocked.join('、')}。不会读取 gh 令牌。`);
    const env: NodeJS.ProcessEnv = {};
    for (const key of keys) {
      const normalized = normalize(key);
      if (normalized.startsWith('GH_')) {
        if (normalized === 'GH_CONFIG_DIR') env.GH_CONFIG_DIR = source[key];
      } else if (!SIDE_EFFECT_ENV.includes(normalized)) env[key] = source[key];
    }
    Object.assign(env, {
      GH_HOST: this.host, GH_PAGER: 'cat', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      NO_COLOR: '1', CLICOLOR: '0',
    });
    for (const key of Object.keys(env)) if (['NO_COLOR', 'CLICOLOR'].includes(normalize(key)) && key !== normalize(key)) delete env[key];
    if (!interactive) env.GH_PROMPT_DISABLED = '1'; return env;
  }
  private findGh(env: NodeJS.ProcessEnv): string {
    let program: string | undefined;
    try { program = this.findTool('gh', env, this.cwd); }
    catch { throw new GitError('无法在本地检查可选 GitHub CLI（gh）；未进行网络请求。'); }
    if (!program) throw new GitError('未找到可选 GitHub CLI（gh）；请访问 https://cli.github.com/ 获取 Windows 官方安装包或 Linux 官方发行版安装指引。不会自动安装；也可返回选择关联已有仓库。');
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(program)) throw new GitError('GitHub CLI（gh）必须是原生可执行程序，不能通过 shell 运行 .cmd/.bat。');
    return program;
  }
  private async prepare(interactive = false): Promise<{ program: string; env: NodeJS.ProcessEnv }> {
    const env = this.prepareEnvironment(interactive), program = this.findGh(env), session = this.session();
    if (session) {
      if (!this.actor) throw new GitError('托管 GitHub 请求必须先明确选择 actor。');
      if (interactive) throw new GitError('托管会话不允许外部 gh 登录或切换账号。');
      const token = await session.getToken(this.host, this.actor);
      if (!token) throw new GitError(`尚未保存 ${this.host} / ${this.actor} 的 Token；请先进入“HTTPS / GitHub 凭据”录入。不会读取外部 gh 凭据，也不会回退外部凭据助手。`);
      try { validateToken(token); env.GH_CONFIG_DIR = await sessionGhDirectory(session); if (session !== this.session()) throw new GitError('GitHub 凭据会话已经变化。'); const tokenKey = this.host === 'github.com' || this.host.endsWith('.ghe.com') ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN'; env[tokenKey] = token.toString('ascii'); }
      finally { token.fill(0); }
    }
    return { program, env };
  }
  selectActor(value: string): void {
    const selected = loginName(value); if (this.actor && !sameName(this.actor, selected)) throw new GitError('所选 GitHub actor 与客户端不一致。'); this.selectedActor = selected;
  }
  private clearToken(env: NodeJS.ProcessEnv): void { for (const name of CREDENTIAL_ENV) delete env[name]; }

  /** Purely local: no subprocess, credential-store or auth-status reads. */
  ensureAvailable(): void { this.findGh(this.prepareEnvironment()); }

  private async command(args: readonly string[]): Promise<ProcessResult> {
    const { program, env } = await this.prepare();
    try { return await this.runner(program, args, { cwd: this.cwd, env, interactive: false, check: false }); }
    catch (error) {
      if (error instanceof Cancelled) throw new Cancelled('GitHub CLI 操作已中断；已完成的外部步骤不会自动还原。');
      throw new GitError(`gh 未完成${launchDetail(error)}；原始输出已隐藏，请检查工具、认证或网络。`);
    } finally { this.clearToken(env); }
  }

  /** All writes recheck the explicitly selected actor; never infer it from a token environment. */
  async ensureActor(expected = this.actor): Promise<string> {
    if (!expected) throw new GitError('写操作必须先明确选择 GitHub actor。');
    const selected = loginName(expected);
    if (!sameName(await this.currentLogin(), selected)) throw new GitError('当前 gh 账号与选定 actor 不一致，已停止；不会自动切换或重新绑定。');
    return selected;
  }

  private endpoint(value: string): string {
    if (!/^(?:user(?:[/?]|$)|users\/|orgs\/|repos\/|search\/repositories\?)/u.test(value) || /[\x00-\x20\x7f#\\{}]/u.test(value) || value.includes('..') || value.length > 4096) throw new GitError('GitHub API 路径无效。');
    return value;
  }

  private async apiResult(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', endpoint: string, query?: string, body?: Record<string, unknown> | Buffer, headers: readonly string[] = []): Promise<ProcessResult> {
    const path = this.endpoint(endpoint), writing = method !== 'GET';
    if (writing || this.session()) await this.ensureActor();
    const args = ['api', '--hostname', this.host, '--method', method, path];
    if (query) args.push('--jq', query);
    else if (writing) args.push('--silent');
    for (const header of headers) args.push('--header', header);
    if (body !== undefined) args.push('--input', '-');
    const { program, env } = await this.prepare();
    let result: ProcessResult;
    try { result = await this.runner(program, args, { cwd: this.cwd, env, check: false, interactive: false, ...(body === undefined ? {} : { inputData: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)) }) }); }
    catch (error) {
      const message = `GitHub 请求未完成${launchDetail(error)}${writing ? '；写入结果未知，请先只读检查目标，不会自动重试或回滚' : ''}。原始错误已隐藏。`;
      if (error instanceof Cancelled) throw new Cancelled(message);
      throw new GitError(message);
    } finally { this.clearToken(env); }
    if (result.status !== 0 || result.signal) throw readFailure(result, writing);
    return result;
  }

  /** Callers use constant native API JSON projections; raw response objects are never exposed. */
  async readJson(endpoint: string, projection: string): Promise<unknown> {
    const result = await this.apiResult('GET', endpoint, projection);
    try { return parseStrictJson(outputText(result, 2_097_152)); }
    catch { throw new GitError('GitHub 响应不是受支持的严格 JSON；原始输出已隐藏。'); }
  }
  async writeJson(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', endpoint: string, body?: Record<string, unknown>, projection?: string): Promise<unknown> {
    const result = await this.apiResult(method, endpoint, projection, body);
    if (!projection) return undefined;
    try { return parseStrictJson(outputText(result, 2_097_152)); }
    catch { throw new GitError('GitHub 写操作已返回，但验证响应无效；请先只读检查结果，不会自动重试或回滚。'); }
  }
  async readDiff(endpoint: string): Promise<string> {
    const result = await this.apiResult('GET', endpoint, undefined, undefined, ['Accept: application/vnd.github.diff']);
    return outputText(result, 16_777_216);
  }
  async readBytes(endpoint: string, limit = 67_108_864): Promise<Buffer> {
    const result = await this.apiResult('GET', endpoint, undefined, undefined, ['Accept: application/octet-stream']);
    if (!Buffer.isBuffer(result.stdout) || result.stdout.length > limit) throw new GitError('附件超过支持的单文件 64 MiB 上限；未写入文件。');
    return result.stdout;
  }
  async addSshKey(publicKey: string, title: string): Promise<void> {
    inputText(title); inputText(publicKey);
    await this.ensureActor();
    const { program, env } = await this.prepare();
    let result: ProcessResult;
    try { result = await this.runner(program, ['ssh-key', 'add', '-', '--title', title, '--type', 'authentication'], { cwd: this.cwd, env, check: false, interactive: false, inputData: Buffer.from(`${publicKey}\n`) }); }
    catch (error) {
      const message = 'SSH 公钥添加结果未知；请先到选定 host 的账号 SSH keys 页面检查，不会自动重试或删除。原始错误已隐藏。';
      if (error instanceof Cancelled) throw new Cancelled(message);
      throw new GitError(message);
    } finally { this.clearToken(env); }
    if (result.status !== 0 || result.signal) throw readFailure(result, true);
  }
  async uploadRelease(context: RepositoryContext, tag: string, files: readonly string[], options: { clobber?: boolean } = {}): Promise<void> {
    if (validateHost(context.host) !== this.host || !files.length || files.some((file) => !file.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(file) || /[\x00-\x1f#]/u.test(file))) throw new GitError('发布附件必须是明确的绝对文件路径，不能带 # 或控制字符。');
    inputText(tag);
    if (!tag || tag.startsWith('-') || /[\s~^:?*\[\]\\]/u.test(tag) || tag.includes('..')) throw new GitError('Release Tag 无效。');
    if (options.clobber !== undefined && typeof options.clobber !== 'boolean') throw new GitError('必须明确选择是否覆盖附件。');
    await this.ensureActor();
    const { program, env } = await this.prepare();
    let result: ProcessResult;
    try { result = await this.runner(program, ['release', 'upload', tag, '--repo', `${this.host}/${loginName(context.owner)}/${validateRepositoryName(context.name)}`, ...(options.clobber ? ['--clobber'] : []), '--', ...files], { cwd: this.cwd, env, interactive: false, check: false }); }
    catch (error) {
      const message = '发布附件上传结果未知；部分附件可能已上传，请先只读检查，不会自动重试、覆盖或回滚。';
      if (error instanceof Cancelled) throw new Cancelled(message);
      throw new GitError(message);
    } finally { this.clearToken(env); }
    if (result.status !== 0 || result.signal) throw readFailure(result, true);
  }

  async currentLogin(): Promise<string> {
    const result = await this.command(['api', '--hostname', this.host, '--method', 'GET', 'user', '--jq', '.login']);
    if (result.status !== 0) throw new GitError(`无法确认当前 GitHub 账号（${statusDetail(result)}）；可能未登录、认证已过期或网络不可用。原始输出已隐藏。`);
    return loginName(outputText(result, 128).replace(/\r?\n$/u, ''));
  }

  async switchAccount(login: string): Promise<void> {
    if (this.session()) throw new GitError('托管会话不允许修改外部 gh 默认账号；请使用 AutoGit 的加密 Token。');
    const expected = loginName(login);
    const result = await this.command(['auth', 'switch', '--hostname', this.host, '--user', expected]);
    if (result.status !== 0) throw new GitError(`外部 gh 账号切换未完成（${statusDetail(result)}）；不会自动恢复或重试。原始输出已隐藏。`);
  }

  async browserLogin(ui: Console): Promise<boolean> {
    if (this.session()) throw new GitError('托管会话不允许外部 gh 登录；请使用 AutoGit 的加密 Token。');
    this.ensureAvailable();
    ui.text('gh 使用自己的外部网络传输与凭据存储，与 AutoGit 托管的 SSH 密钥分开；可能改变外部 gh/Git 配置与默认账号，不会自动恢复。');
    ui.text('登录由原生 gh 与浏览器处理；安全凭据存储不可用时，gh 可能回退到明文存储令牌。AutoGit 不接收、读取或保存令牌，也不会上传 SSH 密钥。');
    if (this.runner === runProcess && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      ui.text('gh 浏览器登录需要真实交互终端；请不要通过管道提供凭据。未启动登录。');
      return false;
    }
    const { program, env } = await this.prepare(true);
    let result: ProcessResult;
    try {
      result = await this.runner(program, ['auth', 'login', '--hostname', this.host, '--git-protocol', 'ssh', '--skip-ssh-key', '--web'], { cwd: this.cwd, env, interactive: true, check: false });
    } catch (error) {
      if (error instanceof Cancelled) throw new Cancelled('外部 gh 登录已中断；外部凭据或默认账号可能已改变，不会自动恢复。');
      ui.text(`gh 浏览器登录未完成${launchDetail(error)}；外部状态可能已改变，原始错误已隐藏。`);
      return false;
    } finally { this.clearToken(env); }
    ui.text(`外部 gh 登录流程结束（${statusDetail(result)}）；不会据此认定账号匹配，仍需重新联网核对登录名。`);
    return result.status === 0;
  }

  async createRepository(owner: string, name: string, visibility: Visibility, onCreated?: (url: string) => void, options: { actor?: string; actorLogin?: string; owner?: string; host?: string } = {}): Promise<CreatedRepository> {
    const expected = loginName(owner), repository = validateRepositoryName(name);
    if (visibility !== 'private' && visibility !== 'public') throw new GitError('仓库可见性必须明确选择 private 或 public。');
    const host = validateHost(options.host ?? this.host), actor = loginName(options.actor ?? options.actorLogin ?? this.actor ?? expected);
    if (this.session()) this.selectActor(actor);
    if (host !== this.host) throw new GitError('建库 host 与客户端上下文不一致；请为该 host 创建独立客户端。');
    if (this.actor && !sameName(actor, this.actor) || options.actor && options.actorLogin && !sameName(options.actor, options.actorLogin)) throw new GitError('建库 actor 与选定客户端不一致。');
    const selectedOwner = loginName(options.owner ?? this.owner ?? expected);
    const url = repositoryUrl(expected, repository, host);
    if (!sameName(await this.currentLogin(), actor)) throw new GitError('当前 gh 账号已与选定 actor 不一致，未创建仓库；请返回重新明确认证。');
    if (!sameName(selectedOwner, expected)) throw new GitError('仓库 owner 与选定上下文不一致。');
    const { program, env } = await this.prepare();
    let result: ProcessResult;
    const createArgs = ['repo', 'create', `${expected}/${repository}`, `--${visibility}`];
    try {
      result = await this.runner(program, createArgs, { cwd: this.cwd, env, interactive: false, check: false });
    } catch (error) {
      const message = `GitHub 创建结果未知，仓库可能已创建${error instanceof Cancelled ? '（操作已中断）' : launchDetail(error)}。${recovery(url)}`;
      if (error instanceof Cancelled) throw new Cancelled(message);
      throw new GitError(message);
    } finally { this.clearToken(env); }
    if (result.status !== 0) throw new GitError(creationFailure(result, url));
    // Synchronous notification must precede verification so callers retain the
    // irreversible creation state even if the next API call is interrupted.
    try { onCreated?.(url); }
    catch (error) {
      if (error instanceof Cancelled) throw new Cancelled(knownCreated(url));
      throw new GitError(knownCreated(url));
    }
    try {
      const verification = await this.command(['api', '--hostname', host, '--method', 'GET', `repos/${expected}/${repository}`, '--jq', REPOSITORY_QUERY]);
      if (verification.status !== 0) throw new GitError(`仓库验证未完成（${statusDetail(verification)}）。`);
      return checkedRepository(verification, expected, repository, visibility, host);
    } catch (error) {
      if (error instanceof Cancelled) throw new Cancelled(knownCreated(url));
      throw new GitError(knownCreated(url));
    }
  }
}

/** Consent and selected AutoGit identity are never inferred from gh's defaults. */
export async function authenticateGithub(ui: Console, client: GithubClient, expected: string): Promise<string | undefined> {
  const selected = loginName(expected);
  client.ensureAvailable();
  const session = currentSession();
  if (session) {
    client.selectActor(selected);
    for (;;) {
      const existing = await session.getToken(client.host, selected);
      if (!existing) await credentialsMenu(ui, '', { host: client.host, account: selected });
      else existing.fill(0);
      try {
        const actual = await client.currentLogin();
        if (sameName(actual, selected)) return actual;
        ui.text('Token 对应的 actor 与选定账号不一致；未改变账号或绑定。');
      } catch (error) { if (error instanceof Cancelled) throw error; ui.text('托管 Token 的只读账号核验未通过；可能令牌过期、host 不匹配或网络不可用。不会读取外部 gh 凭据。'); }
      if (!await ui.menu('托管 GitHub 凭据', ['重新录入选定 host / actor 的 Token'])) return undefined;
      await enrollToken(ui, client.host, selected);
    }
  }
  ui.text(`选定 AutoGit 账号的预期 GitHub 登录名：${selected}。gh 默认账号是独立的，不会据此更改 AutoGit 账号或项目绑定。`);
  let checkLogin = true;
  for (;;) {
    if (checkLogin) {
      checkLogin = false;
      try {
        const current = await client.currentLogin();
        if (sameName(current, selected)) return current;
        ui.text(`当前 gh 账号 ${current} 与选定的 ${selected} 不一致；不会使用错误账号继续，也不会静默重新绑定。`);
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        ui.text('无法确认当前 gh 账号：可能未登录、认证已过期或网络失败。没有读取令牌或显示原始输出。');
      }
    }
    const choice = await ui.menu('明确选择 GitHub 认证方式', [`切换外部 gh 到预期账号 ${selected}`, '启动外部 gh 浏览器登录']);
    if (!choice) return undefined;
    if (choice === 1) {
      ui.text('此操作会改变外部 gh 的默认账号，影响其他使用 gh 的程序；不会自动恢复，也不会修改 AutoGit 绑定。');
      try { await client.switchAccount(selected); checkLogin = true; }
      catch (error) {
        if (error instanceof Cancelled) throw error;
        ui.text('外部 gh 账号切换未完成；原始输出已隐藏，不会自动重试或恢复。可明确选择浏览器登录，或返回。');
      }
    } else if (choice === 2) {
      if (await client.browserLogin(ui)) checkLogin = true;
    }
  }
}
