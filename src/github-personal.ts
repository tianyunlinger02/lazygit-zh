/** Native github.com personal-repository boundary. No gh, environment credentials or configurable URLs. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { debuglog } from 'node:util';
import { validateToken } from './credentials.js';
import { CredentialPin } from './credential-pin.js';
import { GitError } from './git.js';
import { checkedRepositoryData, loginName, repositoryUrl, validateRepositoryName, type CreatedRepository, type Visibility } from './github.js';
import { currentSession, requireSession, type CredentialSession } from './session.js';
import { parseStrictJson, record } from './storage.js';
import { Cancelled, EndOfInput, resumeInput, suspendInput, type Console } from './ui.js';

/** Code-only seam: fixtures may map these fixed HTTPS options to a local Node server. */
export type PersonalGithubRequest = (options: RequestOptions, listener: (response: IncomingMessage) => void) => ClientRequest;
export type PersonalGithubPhase = 'auth-read' | 'prewrite-read' | 'create-write' | 'verification-read';
export type PersonalGithubCode = 'unavailable' | 'unauthorized' | 'invalid-token' | 'actor-mismatch' | 'forbidden' |
  'rate-limited' | 'not-found' | 'protocol' | 'debug' | 'session' | 'pin' | 'terminal' | 'invalid-input' |
  'unverified' | 'write-rejected' | 'write-unknown';
export type PersonalRepositoryState = 'not-created' | 'unknown' | 'created';
export type PersonalGithubProgress =
  | { phase: Exclude<PersonalGithubPhase, 'create-write'>; kind: 'start' }
  | { phase: 'auth-read' | 'prewrite-read'; kind: 'verified'; result: { actor: string } }
  | { phase: 'create-write'; kind: 'start' | 'sent' | 'created'; repositoryUrl: string }
  | { phase: 'verification-read'; kind: 'verified'; result: CreatedRepository };
export interface PersonalGithubOptions {
  request?: PersonalGithubRequest;
  recovery?: (error: PersonalGithubError) => Promise<boolean>;
  onProgress?: (event: PersonalGithubProgress) => void;
}
export interface PersonalGithubErrorDetails {
  code: PersonalGithubCode; phase: PersonalGithubPhase; repositoryState?: PersonalRepositoryState;
  status?: number; repositoryUrl?: string;
}
/** Only controlled messages, classification and a canonical recovery URL cross this boundary. */
export class PersonalGithubError extends GitError {
  readonly code: PersonalGithubCode; readonly phase: PersonalGithubPhase;
  readonly repositoryState: PersonalRepositoryState; readonly repositoryUrl?: string; readonly status?: number;
  constructor(message: string, details?: PersonalGithubErrorDetails | PersonalRepositoryState, repositoryUrl?: string) {
    super(message); this.name = 'PersonalGithubError';
    const fields = typeof details === 'object' ? details : undefined;
    this.code = fields?.code ?? 'unverified'; this.phase = fields?.phase ?? 'auth-read';
    this.repositoryState = fields?.repositoryState ?? (typeof details === 'string' ? details : 'not-created');
    this.repositoryUrl = fields?.repositoryUrl ?? repositoryUrl;
    this.status = Number.isInteger(fields?.status) && fields!.status! >= 100 && fields!.status! <= 599 ? fields!.status : undefined;
  }
}

type FailureKind = 'network' | 'timeout' | 'response' | 'status' | 'cancelled';
class RequestFailure extends Error {
  constructor(readonly kind: FailureKind, readonly status?: number) { super('GitHub 请求未完成。'); }
}
const MAX_RESPONSE_BYTES = 256 * 1024, TOTAL_TIMEOUT_MS = 30_000;
const sameName = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const digest = (value: Buffer): Buffer => createHash('sha256').update(value).digest();
function sameDigest(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && timingSafeEqual(left, right);
}
function failure(message: string, code: PersonalGithubCode, phase: PersonalGithubPhase,
  repositoryState: PersonalRepositoryState = 'not-created', repositoryUrl?: string, status?: number): PersonalGithubError {
  return new PersonalGithubError(message, { code, phase, repositoryState, repositoryUrl, status });
}
function classified(error: unknown, phase: PersonalGithubPhase, state: PersonalRepositoryState = 'not-created', url?: string): PersonalGithubError | Cancelled | EndOfInput {
  if (error instanceof Cancelled || error instanceof EndOfInput) return error;
  if (error instanceof PersonalGithubError) return failure(error.message, error.code, phase, state, url ?? error.repositoryUrl, error.status);
  if (error instanceof RequestFailure && error.kind === 'cancelled') {
    return new Cancelled(state === 'not-created' ? 'GitHub 只读核验已取消；未创建仓库，也未保存新 Token。' : `GitHub 只读核验已取消；仓库状态仍需检查：${url}。`, state !== 'not-created');
  }
  const status = error instanceof RequestFailure ? error.status : undefined;
  const code: PersonalGithubCode = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not-found' :
    status === 429 ? 'rate-limited' : status !== undefined && status >= 500 || error instanceof RequestFailure && (error.kind === 'network' || error.kind === 'timeout') ? 'unavailable' : 'protocol';
  const reason = status === 401 ? '401：Token 无效或已过期' : status === 403 ? '403：权限不足或请求频率受限，不能据此判定 Token 无效' :
    status === 404 ? '404：对象不存在或当前账号不可见，不能据此确认先前创建没有生效' : status === 429 ? '429：请求频率受限' :
    status !== undefined && status >= 300 && status < 400 ? '不接受重定向' : status !== undefined ? `HTTP ${status}` :
    error instanceof RequestFailure && error.kind === 'timeout' ? '30 秒总时限已到' :
    error instanceof RequestFailure && error.kind === 'network' ? '网络或 TLS 暂不可用' : '响应格式无效或超过 256 KiB';
  return failure(`GitHub 请求未完成（${reason}）。原始响应和错误已隐藏；${state === 'not-created' ? '未创建仓库' : '不会重放创建请求'}。`, code, phase, state, url, status);
}
function recovery(url: string): string {
  return `请先只读检查 ${url}；如已存在，请选择关联已有仓库。不会自动重试、删除或回滚，也不会自动关联未经验证的结果。`;
}
function projectedRepository(data: unknown, owner: string, name: string, visibility: Visibility, phase: PersonalGithubPhase): CreatedRepository {
  try {
    if (!record(data) || !record(data.owner)) throw new Error();
    return checkedRepositoryData({
      owner: { login: data.owner.login }, name: data.name, full_name: data.full_name, private: data.private,
      html_url: data.html_url, ssh_url: data.ssh_url, clone_url: data.clone_url,
    }, owner, name, visibility);
  } catch { throw failure('GitHub 仓库验证的字段、归属、名称、可见性或规范地址无效；原始响应已隐藏。', 'protocol', phase); }
}
function checkedToken(token: Buffer, phase: PersonalGithubPhase): void {
  try { validateToken(token); }
  catch { throw failure('Token 必须为非空、单行 ASCII 秘密，且不超过 4096 字节；未发送此凭据。', 'invalid-token', phase); }
}

export class PersonalGithubClient {
  readonly actor: string;
  private readonly requester: PersonalGithubRequest;
  private readonly recover: PersonalGithubOptions['recovery'];
  private readonly progress: PersonalGithubOptions['onProgress'];
  private boundSession: CredentialSession | undefined;
  private authenticatedDigest: Buffer | undefined;
  private authenticatedContext: (() => Promise<void>) | undefined;
  private readonly issuedPins = new Set<CredentialPin>();
  private busy = false;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private authenticationCleanup: Promise<void> | undefined;

  constructor(account: string, options: PersonalGithubOptions = {}) {
    this.actor = loginName(account);
    this.requester = options.request ?? httpsRequest; this.recover = options.recovery; this.progress = options.onProgress;
  }

  private session(phase: PersonalGithubPhase): CredentialSession {
    if (this.disposed) throw failure('本次 GitHub 操作已结束；请重新选择账号并认证。', 'pin', phase);
    let active: CredentialSession;
    try { active = requireSession(); }
    catch { throw failure('账号凭据尚未解锁或会话已关闭；请重新启动 AutoGit 并解锁。', 'session', phase); }
    if (this.boundSession && this.boundSession !== active) throw failure('GitHub 凭据会话已关闭或变化；请重新选择账号并认证。', 'session', phase);
    this.boundSession ??= active;
    this.checkSession(active, phase);
    return active;
  }
  private checkSession(expected: CredentialSession, phase: PersonalGithubPhase = 'auth-read'): void {
    if (this.disposed) throw failure('本次 GitHub 操作已结束；不会继续使用认证凭据。', 'pin', phase);
    if (expected.closed || currentSession() !== expected || this.boundSession !== expected) {
      throw failure('GitHub 凭据会话已关闭或变化；未继续操作。', 'session', phase);
    }
  }
  private async operation<T>(work: () => Promise<T>, phase: PersonalGithubPhase = 'auth-read'): Promise<T> {
    if (this.disposed) throw failure('本次 GitHub 操作已结束；请重新明确认证。', 'pin', phase);
    if (this.busy) throw failure('同一 GitHub 客户端不能并发认证或操作仓库。', 'invalid-input', phase);
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  private emit(event: PersonalGithubProgress): void {
    try { this.progress?.(event); }
    catch (error) {
      if (error instanceof PersonalGithubError || error instanceof Cancelled || error instanceof EndOfInput) throw error;
      throw failure('GitHub 进度通知未完成；已停止，原始错误已隐藏。', 'protocol', event.phase);
    }
  }
  /** Vault buffers are owned by this boundary: copy once, clear the returned original even on failure. */
  private async storedToken(session: CredentialSession, phase: PersonalGithubPhase = 'auth-read'): Promise<Buffer | undefined> {
    this.checkSession(session, phase);
    let source: Buffer | undefined, copy: Buffer | undefined;
    try {
      source = await session.getToken('github.com', this.actor);
      this.checkSession(session, phase);
      if (source !== undefined) {
        if (!Buffer.isBuffer(source)) throw failure('保险库返回的 Token 格式无效。', 'pin', phase);
        copy = Buffer.from(source);
      }
      return copy;
    } catch (error) {
      copy?.fill(0);
      if (error instanceof PersonalGithubError || error instanceof Cancelled || error instanceof EndOfInput) throw error;
      this.checkSession(session, phase);
      throw failure('无法安全读取选定账号的加密 Token；未读取外部凭据。', 'pin', phase);
    } finally { if (Buffer.isBuffer(source)) source.fill(0); }
  }
  private async assertStoredToken(session: CredentialSession, expected: Buffer | undefined, phase: PersonalGithubPhase = 'auth-read'): Promise<void> {
    const token = await this.storedToken(session, phase);
    let actual: Buffer | undefined;
    try {
      actual = token === undefined ? undefined : digest(token);
      if (!sameDigest(expected, actual)) throw failure('选定账号的 Token 已变化；已停止，请重新认证，不会静默接受替换后的凭据。', 'pin', phase);
      this.checkSession(session, phase);
    } finally { token?.fill(0); actual?.fill(0); }
  }
  private pin(value: Buffer, checkContext: () => Promise<void>): void {
    this.authenticatedDigest?.fill(0); this.authenticatedDigest = Buffer.from(value); this.authenticatedContext = checkContext;
  }
  private clearAuthentication(): Promise<void> {
    this.authenticatedDigest?.fill(0); this.authenticatedDigest = undefined; this.authenticatedContext = undefined;
    const cleanups = [...this.issuedPins].map((pin) => pin.dispose()); this.issuedPins.clear();
    this.authenticationCleanup = Promise.allSettled([...(this.authenticationCleanup ? [this.authenticationCleanup] : []), ...cleanups]).then((results) => {
      if (results.some((result) => result.status === 'rejected')) throw failure('GitHub HTTPS 凭据资源清理未全部确认完成；认证绑定已失效。', 'pin', 'auth-read');
    });
    return this.authenticationCleanup;
  }
  /** No API call. The HTTPS helper must still check the exact fetched token on every use. */
  credentialPin(): CredentialPin {
    const session = this.session('auth-read');
    if (!this.authenticatedDigest) throw failure('请先完成选定账号的 GitHub Token 认证。', 'unverified', 'auth-read');
    const pin = CredentialPin.fromAuthenticated(session, this.actor, this.authenticatedDigest);
    this.issuedPins.add(pin); return pin;
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true; this.disposal = this.clearAuthentication();
    return this.disposal;
  }

  /** One request, one total deadline, bounded streaming, no redirects and no retries. */
  private async requestJson(session: CredentialSession, token: Buffer, method: 'GET' | 'POST', path: string,
    onSent?: () => void, onCreated?: () => void, body?: Buffer, phase: PersonalGithubPhase = method === 'POST' ? 'create-write' : 'auth-read'): Promise<unknown> {
    this.checkSession(session, phase); checkedToken(token, phase);
    // Node's built-in HTTP diagnostics include request headers, including Authorization.
    // Check its actual cached debug state, not only the mutable process.env value.
    if (debuglog('http').enabled || debuglog('https').enabled) throw failure('检测到 Node HTTP 调试输出已启用；请关闭 NODE_DEBUG 的 http/https 调试后重启，避免泄露 Token。未发送请求。', 'debug', phase);
    // The only paths are constants, or validated ASCII owner/repository components.
    if (!(method === 'GET' && (path === '/user' || /^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(path)) || method === 'POST' && path === '/user/repos')) {
      throw failure('不支持的 GitHub 个人仓库 API 路径。', 'protocol', phase);
    }
    const controller = new AbortController();
    let suspended = false;
    try {
      try { suspendInput(); suspended = true; }
      catch { throw failure('无法安全移交终端输入；未发送 GitHub 请求。', 'terminal', phase); }
      const data = await new Promise<unknown>((resolve, reject) => {
        let request: ClientRequest | undefined, response: IncomingMessage | undefined, completed = false, length = 0;
        const bytes = Buffer.alloc(MAX_RESPONSE_BYTES);
        const finish = (error?: RequestFailure | PersonalGithubError | Cancelled | EndOfInput, result?: unknown): void => {
          if (completed) return;
          completed = true; clearTimeout(timer);
          process.removeListener('SIGINT', interrupt); controller.signal.removeEventListener('abort', aborted);
          bytes.fill(0);
          if (error) { response?.destroy(); request?.destroy(); reject(error); }
          else resolve(result);
        };
        const safeFailure = (error: unknown): RequestFailure | PersonalGithubError | Cancelled | EndOfInput =>
          error instanceof PersonalGithubError || error instanceof Cancelled || error instanceof EndOfInput ? error : new RequestFailure(controller.signal.aborted ? 'cancelled' : 'network');
        const aborted = (): void => finish(new RequestFailure('cancelled'));
        const interrupt = (): void => controller.abort();
        const timer = setTimeout(() => finish(new RequestFailure('timeout')), TOTAL_TIMEOUT_MS);
        process.once('SIGINT', interrupt);
        controller.signal.addEventListener('abort', aborted, { once: true });
        const headers: Record<string, string | number> = {
          Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'AutoGit-personal-repository', Authorization: `Bearer ${token.toString('ascii')}`,
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
        };
        try {
          this.checkSession(session, phase);
          request = this.requester({ protocol: 'https:', hostname: 'api.github.com', port: 443,
            rejectUnauthorized: true, agent: false, method, path, headers, signal: controller.signal }, (incoming) => {
            response = incoming;
            // Absorb subsequent stream errors even when a header alone rejects the response.
            incoming.once('error', () => finish(new RequestFailure('network')));
            if (completed) { incoming.destroy(); return; }
            const status = incoming.statusCode;
            if (method === 'POST' && status === 201) {
              try { onCreated?.(); }
              catch (error) {
                finish(error instanceof Cancelled || error instanceof EndOfInput || error instanceof PersonalGithubError ? error : new RequestFailure('response')); return;
              }
              if (completed) return;
            }
            if (!Number.isInteger(status) || status !== (method === 'POST' ? 201 : 200)) {
              finish(new RequestFailure('status', Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined)); return;
            }
            const declared = incoming.headers['content-length'], encoding = incoming.headers['content-encoding'];
            if (declared !== undefined && (typeof declared !== 'string' || !/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES) || encoding !== undefined && encoding !== 'identity') {
              finish(new RequestFailure('response')); return;
            }
            incoming.once('aborted', () => finish(new RequestFailure('network')));
            incoming.once('close', () => { if (!incoming.complete) finish(new RequestFailure('network')); });
            incoming.on('data', (chunk: Buffer) => {
              if (completed) return;
              if (!Buffer.isBuffer(chunk) || length + chunk.length > MAX_RESPONSE_BYTES) { finish(new RequestFailure('response')); return; }
              chunk.copy(bytes, length); length += chunk.length;
            });
            incoming.once('end', () => {
              if (completed) return;
              try {
                const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
                const parsed = parseStrictJson(text);
                finish(undefined, parsed);
              } catch { finish(new RequestFailure('response')); }
            });
          });
          request.once('error', () => finish(new RequestFailure(controller.signal.aborted ? 'cancelled' : 'network')));
          // end() can have transmitted bytes even if it throws; uncertainty begins here.
          if (!completed) { this.checkSession(session, phase); onSent?.(); this.checkSession(session, phase); request.end(body); }
          else request.destroy();
        } catch (error) { finish(safeFailure(error)); }
        finally { delete headers.Authorization; }
      });
      this.checkSession(session, phase);
      return data;
    } finally {
      if (suspended) {
        try { resumeInput(); }
        catch { throw failure('无法安全恢复终端输入；GitHub 流程已停止，不会重新请求凭据。', 'terminal', phase); }
      }
    }
  }

  /** Only exact GET calls may reach the explicit recovery policy; POST never passes here. */
  private async readJson(session: CredentialSession, token: Buffer, path: string, phase: Exclude<PersonalGithubPhase, 'create-write'>,
    baseline: Buffer | undefined, checkContext: () => Promise<void>, state: PersonalRepositoryState = 'not-created', url?: string): Promise<unknown> {
    const tokenDigest = digest(token);
    const guard = async (context = false): Promise<void> => {
      this.checkSession(session, phase);
      await this.assertStoredToken(session, baseline, phase);
      if (context) await checkContext();
      this.checkSession(session, phase);
      if (context) await this.assertStoredToken(session, baseline, phase);
      const actual = digest(token);
      try { if (!sameDigest(tokenDigest, actual)) throw failure('本次核验的 Token 已变化；请重新明确认证。', 'pin', phase); }
      finally { actual.fill(0); }
    };
    try {
      for (;;) {
        await guard(); this.emit({ phase, kind: 'start' });
        try {
          const data = await this.requestJson(session, token, 'GET', path, undefined, undefined, undefined, phase);
          await guard(); return data;
        } catch (error) {
          const safe = classified(error, phase, state, url);
          if (!(safe instanceof PersonalGithubError) || safe.code !== 'unavailable' || !this.recover) throw safe;
          await guard(true);
          const retry = await this.recover(safe);
          await guard(true);
          if (!retry) throw safe;
        }
      }
    } finally { tokenDigest.fill(0); }
  }
  private async actorWithToken(session: CredentialSession, token: Buffer, baseline: Buffer | undefined,
    checkContext: () => Promise<void>, phase: 'auth-read' | 'prewrite-read' = 'auth-read'): Promise<string> {
    const data = await this.readJson(session, token, '/user', phase, baseline, checkContext);
    let actual: string;
    try {
      if (!record(data) || typeof data.login !== 'string') throw new Error();
      actual = loginName(data.login);
    } catch { throw failure('GitHub 账号核验响应字段无效；原始响应已隐藏。', 'protocol', phase); }
    if (!sameName(actual, this.actor)) throw failure('Token 对应的 GitHub actor 与选定账号不一致；未保存 Token，也未创建仓库。', 'actor-mismatch', phase);
    this.emit({ phase, kind: 'verified', result: { actor: actual } });
    return actual;
  }

  async currentLogin(): Promise<string> {
    return this.operation(async () => {
      const session = this.session('auth-read'), token = await this.storedToken(session);
      let expected: Buffer | undefined;
      try {
        if (!token) throw failure('选定账号尚未保存 GitHub Token；请先明确录入并认证。', 'unverified', 'auth-read');
        checkedToken(token, 'auth-read'); expected = digest(token);
        if (this.authenticatedDigest && !sameDigest(this.authenticatedDigest, expected)) throw failure('Token 已变化，请重新认证。', 'pin', 'auth-read');
        const actual = await this.actorWithToken(session, token, expected, this.authenticatedContext ?? (async () => {}));
        await this.assertStoredToken(session, expected);
        return actual;
      } finally { token?.fill(0); expected?.fill(0); }
    });
  }

  async authenticate(ui: Console, checkContext: () => Promise<void> = async () => {}): Promise<boolean> {
    return this.operation(async () => {
      const session = this.session('auth-read');
      await this.clearAuthentication();
      let existing: Buffer | undefined, baseline: Buffer | undefined, staged: Buffer | undefined, stagedDigest: Buffer | undefined;
      let saved = false;
      const correction = (error: unknown): error is PersonalGithubError => error instanceof PersonalGithubError &&
        (error.code === 'unauthorized' || error.code === 'invalid-token' || error.code === 'actor-mismatch');
      try {
        await checkContext(); this.checkSession(session);
        existing = await this.storedToken(session);
        baseline = existing === undefined ? undefined : digest(existing);
        let verified = false;
        if (existing) {
          try { checkedToken(existing, 'auth-read'); await this.actorWithToken(session, existing, baseline, checkContext); verified = true; }
          catch (error) {
            if (!correction(error)) throw error;
            this.checkSession(session); ui.error(error.message);
          }
        }
        existing?.fill(0); existing = undefined;
        if (verified && baseline) {
          await checkContext(); await this.assertStoredToken(session, baseline); this.pin(baseline, checkContext);
          ui.success('GitHub 个人 API 账号核验通过；尚未创建仓库，SSH / Git 推送权限未验证。');
          return true;
        }
        ui.text(`GitHub 个人 API 固定使用 https://api.github.com；仅使用 AutoGit 保险库中的 github.com / ${this.actor} Token，不读取外部 gh、环境变量或 Git 凭据。`);
        if (!await ui.menu('GitHub API 授权', [`明确录入并核验 ${this.actor} 的 GitHub Personal Access Token`])) return false;
        this.checkSession(session); await checkContext(); this.checkSession(session);
        ui.text('Token 是 GitHub Personal Access Token，不是 GitHub 密码、AutoGit 解锁密码或 SSH 私钥。不会自动打开浏览器或读取外部凭据。');
        ui.text('GitHub 官方 classic Token 建库最低权限：私有仓库需要 repo；公开仓库需要 public_repo 或 repo。fine-grained Token 是否支持及权限请核对 GitHub 官方文档，不会猜测或自动扩权。');
        ui.text('在 GitHub 网页创建或管理 Token：https://github.com/settings/tokens 。只在下一个不回显的专用提示中粘贴，不要填进账号名、仓库名或聊天。');
        ui.text('权限说明：https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user');
        ui.requireSecretInput(); staged = await ui.secret('GitHub Token（不回显；先只读核验，通过后仍需明确确认保存）：');
        try { checkedToken(staged, 'auth-read'); await this.actorWithToken(session, staged, baseline, checkContext); }
        catch (error) {
          if (!correction(error)) throw error;
          this.checkSession(session); ui.error(error.message); return false;
        }
        stagedDigest = digest(staged);
        await checkContext(); await this.assertStoredToken(session, baseline);
        if (!await ui.confirm(`已核验 Token 属于 ${this.actor}。明确加密保存到当前 AutoGit 保险库${baseline ? '（替换此账号原 Token）' : ''}？`)) return false;
        await checkContext(); await this.assertStoredToken(session, baseline); this.checkSession(session);
        try { await session.storeToken('github.com', this.actor, staged); }
        catch (error) {
          if (error instanceof Cancelled || error instanceof EndOfInput) throw error;
          this.checkSession(session);
          throw failure('Token 加密保存未确认成功；请检查保险库，不会自动重试或继续创建仓库。', 'unverified', 'auth-read');
        }
        saved = true;
        ui.success('GitHub Token 已加密保存；账号只读核验通过。尚未创建仓库，SSH / Git 推送权限未验证。');
        this.checkSession(session); await checkContext(); await this.assertStoredToken(session, stagedDigest);
        this.pin(stagedDigest, checkContext);
        return true;
      } catch (error) {
        if (saved) {
          const message = 'GitHub Token 已加密保存；后续流程已停止，尚未创建仓库。保存的凭据不会自动删除或回滚。';
          if (error instanceof Cancelled) throw new Cancelled(message);
          if (error instanceof EndOfInput) throw error;
          throw failure(message, error instanceof PersonalGithubError ? error.code : 'unverified', 'auth-read', 'not-created', undefined, error instanceof PersonalGithubError ? error.status : undefined);
        }
        throw error;
      } finally { existing?.fill(0); baseline?.fill(0); staged?.fill(0); stagedDigest?.fill(0); }
    });
  }

  private repositoryTarget(owner: string, name: string, visibility: Visibility, phase: PersonalGithubPhase): { owner: string; name: string; url: string } {
    let expected: string, repository: string;
    try { expected = loginName(owner); repository = validateRepositoryName(name); }
    catch { throw failure('个人仓库 owner 登录名或仓库名无效；请明确输入合法名称。', 'invalid-input', phase); }
    if (!sameName(expected, this.actor)) throw failure('个人建库 owner 必须与已明确认证的 actor 一致；不支持组织建库。', 'actor-mismatch', phase);
    if (visibility !== 'private' && visibility !== 'public') throw failure('仓库可见性必须明确选择 private 或 public。', 'invalid-input', phase);
    return { owner: expected, name: repository, url: repositoryUrl(expected, repository) };
  }
  private context(additional?: () => Promise<void>): () => Promise<void> {
    return async () => { await this.authenticatedContext?.(); if (additional !== this.authenticatedContext) await additional?.(); };
  }
  private async authenticatedToken(session: CredentialSession, phase: PersonalGithubPhase): Promise<Buffer> {
    const pinned = this.authenticatedDigest;
    if (!pinned) throw failure('请先完成选定账号的 GitHub Token 认证，再确认操作仓库。', 'unverified', phase);
    const token = await this.storedToken(session, phase);
    if (!token) throw failure('已认证的 Token 已移除，请重新认证。', 'pin', phase);
    let actual: Buffer | undefined;
    try {
      checkedToken(token, phase); actual = digest(token);
      if (!sameDigest(pinned, actual)) throw failure('已认证的 Token 已变化，请重新认证；未创建仓库。', 'pin', phase);
      return token;
    } catch (error) { token.fill(0); throw error; }
    finally { actual?.fill(0); }
  }

  /** A separate pinned GET only. A 404 cannot prove that an earlier write had no effect. */
  async inspectRepository(owner: string, name: string, visibility: Visibility, checkContext?: () => Promise<void>): Promise<CreatedRepository> {
    return this.operation(async () => {
      const target = this.repositoryTarget(owner, name, visibility, 'verification-read'), session = this.session('verification-read');
      const token = await this.authenticatedToken(session, 'verification-read'), pinned = this.authenticatedDigest!;
      const context = this.context(checkContext);
      try {
        await context(); await this.assertStoredToken(session, pinned, 'verification-read');
        const data = await this.readJson(session, token, `/repos/${target.owner}/${target.name}`, 'verification-read', pinned, context, 'unknown', target.url);
        const checked = projectedRepository(data, target.owner, target.name, visibility, 'verification-read');
        await context(); await this.assertStoredToken(session, pinned, 'verification-read');
        this.emit({ phase: 'verification-read', kind: 'verified', result: checked });
        return checked;
      } catch (error) { throw classified(error, 'verification-read', 'unknown', target.url); }
      finally { token.fill(0); }
    }, 'verification-read');
  }

  async createRepository(owner: string, name: string, visibility: Visibility, onCreated?: (url: string) => void,
    beforeWrite?: () => Promise<void>): Promise<CreatedRepository> {
    return this.operation(async () => {
      const target = this.repositoryTarget(owner, name, visibility, 'prewrite-read'), session = this.session('prewrite-read');
      const token = await this.authenticatedToken(session, 'prewrite-read'), pinned = this.authenticatedDigest!, url = target.url;
      const context = this.context(beforeWrite);
      let sent = false, created = false;
      const body = Buffer.from(JSON.stringify({ name: target.name, private: visibility === 'private', auto_init: false }));
      try {
        await this.actorWithToken(session, token, pinned, context, 'prewrite-read');
        await this.assertStoredToken(session, pinned, 'prewrite-read');
        await context();
        await this.assertStoredToken(session, pinned, 'create-write'); this.checkSession(session, 'create-write');
        try {
          this.emit({ phase: 'create-write', kind: 'start', repositoryUrl: url });
          await this.assertStoredToken(session, pinned, 'create-write');
          const response = await this.requestJson(session, token, 'POST', '/user/repos', () => {
            sent = true; this.emit({ phase: 'create-write', kind: 'sent', repositoryUrl: url });
          }, () => {
            created = true; onCreated?.(url); this.emit({ phase: 'create-write', kind: 'created', repositoryUrl: url });
          }, body, 'create-write');
          projectedRepository(response, target.owner, target.name, visibility, 'create-write');
          await this.assertStoredToken(session, pinned, 'verification-read');
          const verification = await this.readJson(session, token, `/repos/${target.owner}/${target.name}`, 'verification-read', pinned, context, 'created', url);
          const checked = projectedRepository(verification, target.owner, target.name, visibility, 'verification-read');
          await this.assertStoredToken(session, pinned, 'verification-read'); this.checkSession(session, 'verification-read');
          this.emit({ phase: 'verification-read', kind: 'verified', result: checked });
          return checked;
        } catch (error) {
          if (created) {
            const message = `GitHub 已返回 201，仓库已创建：${url}。后续验证未完成；${recovery(url)}`;
            const safe = classified(error, error instanceof PersonalGithubError ? error.phase : 'create-write', 'created', url);
            if (safe instanceof Cancelled) throw new Cancelled(message, true);
            if (safe instanceof EndOfInput) throw safe;
            throw failure(message, safe.code, safe.phase, 'created', url, safe.status);
          }
          if (error instanceof RequestFailure && error.kind === 'status' && error.status !== undefined && error.status >= 300 && error.status < 500) {
            const safe = classified(error, 'create-write', 'not-created', url) as PersonalGithubError;
            throw failure(`${safe.message} ${recovery(url)}`, safe.code === 'protocol' && error.status >= 400 ? 'write-rejected' : safe.code, 'create-write', 'not-created', url, safe.status);
          }
          if (sent) {
            const message = `GitHub 创建请求已发出，但结果未知，仓库可能已创建。${recovery(url)}`;
            const safe = classified(error, 'create-write', 'unknown', url);
            if (safe instanceof Cancelled) throw new Cancelled(message, true);
            if (safe instanceof EndOfInput) throw safe;
            throw failure(message, error instanceof PersonalGithubError ? error.code : 'write-unknown', 'create-write', 'unknown', url, safe.status);
          }
          // Preserve typed guards and ordinary caller cancellation before an irreversible request.
          throw classified(error, 'create-write', 'not-created', url);
        }
      } finally { token.fill(0); body.fill(0); }
    }, 'prewrite-read');
  }
}
