/** Ephemeral proof of one explicitly authenticated actor/session/token. Never serializes a secret. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { GitError } from './git.js';
import { currentSession, type CredentialSession } from './session.js';

export class CredentialPinError extends GitError {
  constructor(readonly code: 'session' | 'pin', message: string) { super(message); this.name = 'CredentialPinError'; }
}

export class CredentialPin {
  readonly host = 'github.com';
  readonly account: string;
  readonly #session: CredentialSession;
  readonly #digest: Buffer;
  #disposed = false;
  #disposal: Promise<void> | undefined;
  readonly #cleanups = new Set<() => Promise<void>>();

  private constructor(session: CredentialSession, account: string, authenticatedDigest: Buffer) {
    this.#session = session; this.account = account; this.#digest = Buffer.from(authenticatedDigest);
    this.assertSession(session);
    session.onClose?.(() => this.dispose());
    Object.freeze(this);
  }

  /** Internal code boundary: callers obtain this proof from PersonalGithubClient.credentialPin(). */
  static fromAuthenticated(session: CredentialSession, account: string, authenticatedDigest: Buffer): CredentialPin {
    if (!Buffer.isBuffer(authenticatedDigest) || authenticatedDigest.length !== 32 || !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u.test(account)) {
      throw new CredentialPinError('pin', 'HTTPS 凭据认证绑定无效；请重新明确认证。');
    }
    return new CredentialPin(session, account, authenticatedDigest);
  }

  private assertSession(session: CredentialSession): void {
    if (this.#disposed) throw new CredentialPinError('pin', '本次 HTTPS 凭据认证绑定已结束；不会继续提供 Token。');
    if (session !== this.#session || session.closed || currentSession() !== session) {
      throw new CredentialPinError('session', 'HTTPS 凭据会话已关闭或变化；请重新选择账号并认证。');
    }
  }

  /** Validate the exact fetched Buffer before the helper converts it to protocol text. */
  assertToken(session: CredentialSession, token: Buffer): void {
    this.assertSession(session);
    if (!Buffer.isBuffer(token) || !token.length) throw new CredentialPinError('pin', '已认证的 Token 已移除或变化；不会静默使用替换后的凭据。');
    const actual = createHash('sha256').update(token).digest();
    try {
      if (!timingSafeEqual(actual, this.#digest)) throw new CredentialPinError('pin', '已认证的 Token 已变化；不会静默使用替换后的凭据，请重新明确认证。');
      this.assertSession(session);
    } finally { actual.fill(0); }
  }

  /** Read only the selected encrypted token; no API request or authentication fallback. */
  async assertCurrent(): Promise<void> {
    this.assertSession(this.#session);
    let token: Buffer | undefined;
    try {
      token = await this.#session.getToken(this.host, this.account);
      this.assertSession(this.#session);
      if (!token) throw new CredentialPinError('pin', '已认证的 Token 已移除；请重新明确认证。');
      this.assertToken(this.#session, token);
    } catch (error) {
      if (error instanceof CredentialPinError) throw error;
      this.assertSession(this.#session);
      throw new CredentialPinError('pin', '无法安全核对已认证的 HTTPS Token；不会读取外部凭据。');
    } finally { if (Buffer.isBuffer(token)) token.fill(0); }
  }

  /** Register a resource owned by this proof; late registration fails before resources are allocated. */
  onDispose(cleanup: () => Promise<void>): () => void {
    this.assertSession(this.#session);
    this.#cleanups.add(cleanup);
    return () => { this.#cleanups.delete(cleanup); };
  }

  /** Invalidates synchronously; every caller can await the same complete resource cleanup. */
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true; this.#digest.fill(0);
    const cleanups = [...this.#cleanups]; this.#cleanups.clear();
    this.#disposal = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()));
      if (results.some((result) => result.status === 'rejected')) throw new CredentialPinError('pin', 'HTTPS 凭据资源清理未全部确认完成；认证绑定已失效。');
    });
    return this.#disposal;
  }
}
