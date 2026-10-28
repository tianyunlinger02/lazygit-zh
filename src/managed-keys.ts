import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { nativeRequest, NativeAuthError } from './auth.js';
import { requireSession } from './session.js';
import { GitError } from './git.js';
import { type Console } from './ui.js';
import { checkedPath, withStoreLock } from './storage.js';
import type { Profile } from './profiles.js';

const MARKER = 'AUTOGIT-ENCRYPTED-SSH-1';
export async function isManagedKey(file: string): Promise<boolean> {
  checkedPath(file, 'file');
  const handle = await fs.open(file, 'r');
  try { const buffer = Buffer.alloc(128); const { bytesRead } = await handle.read(buffer); return buffer.subarray(0, bytesRead).equals(managedKeyMarker(path.basename(path.dirname(file)))); }
  finally { await handle.close(); }
}
export function managedKeyMarker(profileId: string): Buffer { return Buffer.from(`${MARKER}\nssh:${profileId}\n`); }
export async function parsePrivateKey(ui: Console, original?: string): Promise<{ privateKey: Buffer; publicKey: string }> {
  let input: Buffer | undefined; let passphrase: Buffer | undefined;
  try {
    if (original !== undefined) {
      checkedPath(original, 'file');
      const info = await fs.lstat(original); if (info.size > 32_768 || info.nlink !== 1) throw new GitError('导入私钥文件超过 32 KiB 或链接异常。');
      input = await fs.readFile(original);
    }
    let response: Record<string, unknown>;
    try { response = await nativeRequest(input ? 'import-key' : 'generate-key', input ? { protocol: 1, privateKey: input.toString('base64') } : { protocol: 1 }); }
    catch (error) {
      if (!input || !(error instanceof NativeAuthError) || error.code !== 'denied') throw error;
      ui.text('无法无口令解析此私钥；若它已加密，请输入原私钥口令。外部原件不会改动。');
      passphrase = await ui.secret('原私钥口令');
      response = await nativeRequest('import-key', { protocol: 1, privateKey: input.toString('base64'), passphrase: passphrase.toString('base64') });
    }
    if (typeof response.privateKey !== 'string' || typeof response.publicKey !== 'string' || !/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n]*)?\n?$/u.test(response.publicKey) && !/^(?:ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: [^\r\n]*)?\n?$/u.test(response.publicKey)) throw new GitError('原生工具返回了无效密钥，未保存。');
    const privateKey = Buffer.from(response.privateKey, 'base64'); response.privateKey = undefined;
    if (!privateKey.length || privateKey.length > 32_768) { privateKey.fill(0); throw new GitError('私钥大小无效。'); }
    return { privateKey, publicKey: response.publicKey.trim() + '\n' };
  } finally { input?.fill(0); passphrase?.fill(0); }
}

export async function migrateManagedKeys(ui: Console, profiles: Profile[]): Promise<void> {
  const session = requireSession();
  const pending: Profile[] = [];
  for (const profile of profiles) if (!await isManagedKey(profile.private_key)) pending.push(profile);
  if (!pending.length) return;
  ui.text(`检测到 ${pending.length} 个旧托管私钥。需要先加密迁移，完成后仅保留密文和公钥。外部导入原件与旧备份不变。`);
  if (!await ui.confirm('确认加密迁移并在校验成功后替换这些旧托管私钥？')) throw new GitError('未迁移旧私钥，凭据库未解锁供 Git 使用；请确认迁移后重新登录。');
  for (const profile of pending) {
    const before = await fs.readFile(profile.private_key);
    let key: { privateKey: Buffer; publicKey: string } | undefined;
    try {
      key = await parsePrivateKey(ui, profile.private_key);
      const publicKey = await fs.readFile(checkedPath(profile.public_key, 'file'), 'utf8');
      if (key.publicKey.trim().split(/\s/u).slice(0, 2).join(' ') !== publicKey.trim().split(/\s/u).slice(0, 2).join(' ')) throw new GitError('私钥与现有公钥不匹配，未替换旧私钥。');
      await session.storeSsh(profile.profile_id, key.privateKey);
      const verified = await session.vault.get(`ssh:${profile.profile_id}`);
      try { if (!verified?.equals(key.privateKey)) throw new GitError('密文校验失败，未替换旧私钥。'); } finally { verified?.fill(0); }
      await withStoreLock(session.vault.directory, async () => {
        const latest = await fs.readFile(profile.private_key);
        try { if (!latest.equals(before)) throw new GitError('迁移期间旧私钥发生变化，未覆盖。'); } finally { latest.fill(0); }
        const temporary = `${profile.private_key}.encrypted-ref`;
        checkedPath(temporary, 'file', { missing: true });
        try {
          const leftover = await fs.readFile(temporary);
          if (!leftover.equals(managedKeyMarker(profile.profile_id))) throw new GitError('迁移暂存引用异常，未覆盖。');
          await fs.unlink(temporary);
        } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
        await fs.writeFile(temporary, managedKeyMarker(profile.profile_id), { flag: 'wx', mode: 0o600 });
        const handle = await fs.open(temporary, 'r'); try { await handle.sync(); } finally { await handle.close(); }
        checkedPath(profile.private_key, 'file'); await fs.rename(temporary, profile.private_key);
      });
      ui.text(`已加密迁移：${profile.label}。历史备份/快照中的旧私钥不会被自动擦除。`);
    } finally { before.fill(0); key?.privateKey.fill(0); }
  }
}
