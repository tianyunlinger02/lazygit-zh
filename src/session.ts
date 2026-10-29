import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { nativeRequest, resolveNativeHelper } from './auth.js';
import { Vault, VaultUnlockError, secureCredentialDirectory, validateNewPassword } from './vault.js';
export { secureCredentialDirectory } from './vault.js';
import { GitError } from './git.js';
import { Cancelled, type Console } from './ui.js';
import { checkedPath, isErrno, mkdirPrivate } from './storage.js';

interface AgentHandle { child: ChildProcess; endpoint: string; directory: string; publicKey: string }
let active: CredentialSession | undefined;
export function currentSession(): CredentialSession | undefined { return active; }
export function requireSession(): CredentialSession {
  if (!active || active.closed) throw new GitError('账号凭据尚未解锁，请重新启动 AutoGit 并输入 AutoGit 解锁密码。');
  return active;
}
export function setSession(session: CredentialSession | undefined): void { active = session; }
export function tokenRecord(host: string, account: string): string {
  return `token:${createHash('sha256').update(`${host.toLowerCase()}\0${account.toLowerCase()}`).digest('hex')}`;
}

export class CredentialSession {
  readonly vault: Vault;
  closed = false;
  private agents = new Map<string, AgentHandle>();
  private pendingAgents = new Map<string, Promise<string>>();
  private cleanups = new Set<() => Promise<void>>();
  onClose(cleanup: () => Promise<void>): void { this.check(); this.cleanups.add(cleanup); }
  constructor(vault: Vault) { this.vault = vault; }
  async storeSsh(profileId: string, privateKey: Buffer): Promise<void> {
    this.check(); await this.vault.put(`ssh:${profileId}`, privateKey);
  }
  async getToken(host: string, account: string): Promise<Buffer | undefined> {
    this.check(); return this.vault.get(tokenRecord(host, account));
  }
  async storeToken(host: string, account: string, value: Buffer): Promise<void> {
    this.check(); if (!value.length) throw new GitError('凭据不能为空。');
    await this.vault.put(tokenRecord(host, account), value);
  }
  async removeSsh(profileId: string): Promise<void> {
    this.check(); await this.stopAgent(profileId); await this.vault.delete(`ssh:${profileId}`);
  }
  private check(): void { if (this.closed) throw new GitError('本次会话已经锁定，请重新登录。'); }
  agentEndpoint(profileId: string): string | undefined {
    const item = this.agents.get(profileId);
    return item && item.child.exitCode === null && !item.child.killed ? item.endpoint : undefined;
  }
  async sshAgent(profileId: string): Promise<string> {
    this.check();
    const pending = this.pendingAgents.get(profileId);
    if (pending) return pending;
    const started = this.startAgent(profileId);
    this.pendingAgents.set(profileId, started);
    try { return await started; }
    finally { if (this.pendingAgents.get(profileId) === started) this.pendingAgents.delete(profileId); }
  }
  private async startAgent(profileId: string): Promise<string> {
    this.check();
    const existing = this.agents.get(profileId);
    if (existing && existing.child.exitCode === null && !existing.child.killed) return existing.endpoint;
    const privateKey = await this.vault.get(`ssh:${profileId}`);
    if (!privateKey) throw new GitError('此账号没有已加密的 SSH 凭据，请导入或迁移密钥。');
    const root = path.join(path.dirname(this.vault.directory), '.autogit-sessions');
    const directory = path.join(root, randomUUID());
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\autogit-${randomBytes(24).toString('hex')}` : path.join(directory, 'agent.sock');
    let child: ChildProcess | undefined;
    let request: Buffer | undefined;
    let created = false;
    try {
      await mkdirPrivate(root);
      const rootInfo = await fs.lstat(root);
      if (process.platform !== 'win32' && (rootInfo.uid !== process.geteuid?.() || (rootInfo.mode & 0o7777) !== 0o700)) throw new GitError('会话目录必须由当前用户独占。');
      if (process.platform === 'win32') await nativeRequest('secure-path', { path: root, directory: true });
      await fs.mkdir(directory, { mode: 0o700 }); created = true;
      if (process.platform === 'win32') await nativeRequest('secure-path', { path: directory, directory: true });
      child = spawn(await resolveNativeHelper(), ['agent'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const ready = new Promise<string>((resolve, reject) => {
        let output = Buffer.alloc(0);
        const timer = setTimeout(() => { child?.kill(); reject(new GitError('SSH 会话代理启动超时。')); }, 10_000);
        const fail = (): void => { clearTimeout(timer); reject(new GitError('SSH 会话代理未启动，未写入明文私钥。')); };
        child!.once('error', fail); child!.once('exit', fail);
        child!.stderr?.on('data', () => { /* Native diagnostic output is never exposed. */ });
        child!.stdout?.on('data', (chunk: Buffer) => {
          output = Buffer.concat([output, chunk]);
          if (output.length > 16_384) { child?.kill(); fail(); return; }
          const newline = output.indexOf(10); if (newline < 0) return;
          try {
            const response = JSON.parse(output.subarray(0, newline).toString('utf8')) as Record<string, unknown>;
            if (response.ok !== true || response.protocol !== 1 || response.endpoint !== endpoint || typeof response.publicKey !== 'string') { fail(); return; }
            clearTimeout(timer); resolve(response.publicKey);
          } catch { fail(); }
        });
      });
      request = Buffer.from(`${JSON.stringify({ protocol: 1, privateKey: privateKey.toString('base64'), endpoint })}\n`);
      child.stdin!.on('error', () => { /* The ready/exit boundary reports failures without secrets. */ });
      child.stdin!.write(request, () => request?.fill(0));
      const publicKey = await ready;
      this.check();
      this.agents.set(profileId, { child, endpoint, directory, publicKey });
      return endpoint;
    } catch (error) { child?.kill(); if (created) await fs.rm(directory, { recursive: true, force: true }); throw error; }
    finally { privateKey.fill(0); request?.fill(0); }
  }
  async stopAgent(profileId: string): Promise<void> {
    const item = this.agents.get(profileId); if (!item) return;
    this.agents.delete(profileId); item.child.stdin?.end();
    if (item.child.exitCode === null) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { item.child.kill(); resolve(); }, 1000);
      item.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await fs.rm(item.directory, { recursive: true, force: true });
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    try {
      for (const cleanup of this.cleanups) await cleanup().catch(() => undefined);
      this.cleanups.clear();
      await Promise.allSettled(this.pendingAgents.values());
      await Promise.allSettled([...this.agents.keys()].map((key) => this.stopAgent(key)));
    } finally { this.vault.close(); if (active === this) active = undefined; }
  }
}

/** A successful result belongs to the caller; every failed/cancelled input is cleared here. */
export async function readNewPassword(ui: Console): Promise<Buffer> {
  ui.requireSecretInput();
  for (;;) {
    let password: Buffer | undefined, confirmation: Buffer | undefined;
    try {
      password = await ui.secret('新的 AutoGit 解锁密码：');
      try { validateNewPassword(password); }
      catch (error) {
        if (!(error instanceof GitError)) throw error;
        password.fill(0); ui.error(error.message); continue;
      }
      confirmation = await ui.secret('再次输入新的 AutoGit 解锁密码：');
      if (password.length !== confirmation.length || !timingSafeEqual(password, confirmation)) {
        password.fill(0); confirmation.fill(0); ui.error('两次密码不一致，请重新设置。'); continue;
      }
      const result = password; password = undefined; return result;
    } finally { password?.fill(0); confirmation?.fill(0); }
  }
}

/** Dynamic imports avoid profiles -> session -> profiles initialization cycles. No data is written. */
async function rejectMissingManagedVault(directory: string): Promise<void> {
  const { ProfileStore, isHttpsOnlyProfile } = await import('./profiles.js');
  const { managedKeyReferences } = await import('./managed-keys.js');
  const profiles = await new ProfileStore(directory).list(); // Broken schema 2 is never keyless.
  // Scan every orphan even when a keyless profile is present; neither type hides markers.
  const references = await managedKeyReferences(directory);
  if (references.length) throw new GitError('检测到托管加密密钥引用，但 vault.json 缺失；请恢复原凭据库，不会创建空库覆盖关联。');
  if (profiles.some(isHttpsOnlyProfile)) throw new GitError('检测到 HTTPS-only 账号，但 vault.json 缺失；请恢复原凭据库，不会创建空库替代原 Token。');
}

async function acknowledgeRecoveryCode(ui: Console, result: { vault: Vault; recoveryCode: string }, rotated: boolean): Promise<Vault> {
  try {
    ui.text(`${rotated ? '密码已重设。请单独保存新的恢复码' : '请离线保存恢复码（不要放在资料目录或聊天/日志中）'}：\n${result.recoveryCode}`);
    if (!await ui.confirm('已将恢复码单独保管？忘记 AutoGit 密码时需要它。')) throw new Cancelled('尚未确认保管恢复码；加密凭据库已保留，请保管恢复码后重新登录');
    return result.vault;
  } catch (error) { result.vault.close(); throw error; }
}

async function recoverSessionVault(ui: Console, directory: string): Promise<Vault> {
  const recovery = await ui.secret('离线恢复码：');
  let password: Buffer | undefined;
  try {
    password = await readNewPassword(ui);
    return await acknowledgeRecoveryCode(ui, await Vault.recover(directory, recovery, password), true);
  } finally { recovery.fill(0); password?.fill(0); }
}

async function chooseRecovery(ui: Console, directory: string, title: string): Promise<Vault> {
  if (!await ui.menu(title, ['使用离线恢复码恢复'], '退出')) throw new Cancelled('未解锁凭据库，已退出');
  return recoverSessionVault(ui, directory);
}

/** Every startup unlocks using the standalone AutoGit password; missing stores are opt-in only. */
export async function unlockSession(ui: Console, directoryValue: string, options: { allowCreate?: boolean } = {}): Promise<CredentialSession> {
  ui.requireSecretInput();
  const directory = checkedPath(directoryValue, 'dir', { missing: true });
  let vault: Vault | undefined;
  try {
    if (!await hasVault(directory)) {
      if (!options.allowCreate) throw new GitError('保险库尚未初始化；此操作不会自动创建新凭据库。');
      await rejectMissingManagedVault(directory);
      let entries: string[] = [];
      try { entries = await fs.readdir(directory); }
      catch (error) { if (!isErrno(error, 'ENOENT')) throw error; }
      if (entries.length && !await ui.confirm('此资料目录非空但缺少 vault.json，可能遗失加密库。明确创建独立新库（不会恢复旧凭据）？')) throw new Cancelled('未明确创建独立新库；原资料保持不变');
      ui.text('首次初始化加密凭据库。请设置独立 AutoGit 密码（至少 12 个 Unicode 字符），不是系统或 GitHub 密码。');
      const password = await readNewPassword(ui);
      try {
        await rejectMissingManagedVault(directory);
        // Directory creation and Windows hardening start only after a confirmed valid password.
        await secureCredentialDirectory(directory);
        vault = await acknowledgeRecoveryCode(ui, await Vault.create(directory, password), false);
      } finally { password.fill(0); }
    } else {
      ui.text('请输入独立的 AutoGit 解锁密码；输入不会回显。忘记密码可使用离线恢复码，不会自动覆盖原库。');
      for (let attempt = 1; attempt <= 3; attempt++) {
        const password = await ui.secret('AutoGit 解锁密码（忘记密码请直接回车）：');
        let empty = false, failed = false;
        try {
          empty = password.length === 0;
          if (!empty) {
            try { vault = await Vault.unlock(directory, password); }
            catch (error) { if (!(error instanceof VaultUnlockError)) throw error; failed = true; }
          }
        } finally { password.fill(0); }
        if (vault) break;
        if (empty) { vault = await chooseRecovery(ui, directory, '忘记 AutoGit 解锁密码'); break; }
        if (failed) ui.error('密码未能解锁凭据库，原数据未修改。');
        if (failed && attempt < 3) {
          const choice = await ui.menu('选择解锁方式', ['重试 AutoGit 解锁密码', '使用离线恢复码恢复'], '退出');
          if (!choice) throw new Cancelled('未解锁凭据库，已退出');
          if (choice === 2) { vault = await recoverSessionVault(ui, directory); break; }
        } else { vault = await chooseRecovery(ui, directory, '已连续三次未能解锁；可恢复或退出'); break; }
      }
    }
    if (!vault) throw new GitError('凭据库尚未解锁。');
    const session = new CredentialSession(vault); setSession(session); vault = undefined; return session;
  } finally { vault?.close(); }
}

export async function hasVault(directory: string): Promise<boolean> {
  try { checkedPath(path.join(directory, 'vault.json'), 'file'); return true; }
  catch (error) { if (isErrno(error, 'ENOENT') || error instanceof GitError && error.message === '所需路径不存在。') return false; throw error; }
}
