/** Public-key-only reader and explicit gh SSH-key upload. Never open a private-key path. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { GitError } from './git.js';
import { inputText, safeDisplay } from './github.js';
import { checkedPath } from './storage.js';
import { confirmGithubWrite, githubSession, type GithubSession } from './github-repositories.js';
import type { Console } from './ui.js';
import { isHttpsOnlyProfile, resolveBinding } from './profiles.js';

export interface PublicKey { readonly file: string; readonly text: string; readonly algorithm: string; readonly fingerprint: string }
const TYPES = ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'];
export function parsePublicKey(value: string, file = ''): PublicKey {
  const text = value.replace(/\r?\n$/u, '');
  const match = /^(\S+) ([A-Za-z0-9+/]+={0,2})(?: ([^\x00-\x1f\x7f-\x9f]*))?$/u.exec(text);
  if (!match || !TYPES.includes(match[1])) throw new GitError('文件不是支持的单行 OpenSSH 公钥；不会显示内容。');
  const algorithm = match[1], blob = Buffer.from(match[2], 'base64');
  if (blob.toString('base64').replace(/=+$/u, '') !== match[2].replace(/=+$/u, '')) throw new GitError('SSH 公钥 Base64 无效。');
  let offset = 0;
  const field = (): Buffer => {
    if (offset + 4 > blob.length) throw new GitError('SSH 公钥结构无效。');
    const size = blob.readUInt32BE(offset); offset += 4;
    if (!size || offset + size > blob.length) throw new GitError('SSH 公钥字段无效。');
    const result = blob.subarray(offset, offset + size); offset += size; return result;
  };
  if (field().toString('ascii') !== algorithm) throw new GitError('SSH 公钥算法与内容不一致。');
  if (algorithm.includes('ed25519')) { if (field().length !== 32) throw new GitError('Ed25519 公钥长度无效。'); }
  else if (algorithm === 'ssh-rsa') { const exponent = field(), modulus = field(); if (exponent.length > 8 || modulus.length < 128 || modulus.length > 2049) throw new GitError('RSA 公钥参数无效。'); }
  else {
    const curve = algorithm.match(/nistp(?:256|384|521)/u)![0], curveField = field().toString('ascii'), point = field();
    const length = curve === 'nistp256' ? 65 : curve === 'nistp384' ? 97 : 133;
    if (curveField !== curve || point.length !== length || point[0] !== 4) throw new GitError('ECDSA 公钥参数无效。');
  }
  if (algorithm.startsWith('sk-')) field();
  if (offset !== blob.length) throw new GitError('SSH 公钥包含额外数据。');
  return Object.freeze({ file, text, algorithm, fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}` });
}
export async function readPublicKey(file: string): Promise<PublicKey> {
  // Extension check precedes every filesystem access, including metadata probes.
  if (typeof file !== 'string' || !file.endsWith('.pub')) throw new GitError('只接受明确的 .pub 公钥文件；不会打开没有 .pub 后缀的私钥。');
  const checked = checkedPath(file, 'file');
  const handle = await open(checked, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 65_536) throw new GitError('公钥必须是至多 64 KiB 的单链接普通文件。');
    const bytes = Buffer.alloc(65_537), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65_536) throw new GitError('公钥文件过大。');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)); }
    catch { throw new GitError('公钥文件编码无效。'); }
    return parsePublicKey(text, checked);
  } finally { await handle.close(); }
}
export async function uploadPublicKey(ui: Console, session: GithubSession): Promise<void> {
  if (isHttpsOnlyProfile(session.profile)) { ui.text('此 HTTPS-only 账号没有 SSH 公钥；HTTPS / Token 无需上传公钥。'); return; }
  if (typeof session.profile.public_key !== 'string') throw new GitError('SSH 账号公钥元数据无效，不会选择外部密钥。');
  const file = path.resolve(await ui.ask('明确选择要上传的 .pub 公钥文件', session.profile.public_key));
  const key = await readPublicKey(file), title = inputText(await ui.ask('GitHub SSH 公钥标题', `AutoGit ${session.profile.label}`));
  if (!await confirmGithubWrite(ui, session, undefined, '添加认证 SSH 公钥（不是私钥）', `文件：${file}\n算法：${key.algorithm}\n指纹：${key.fingerprint}\n标题：${title}\n作用：此公钥将获得选定 GitHub 账号的 Git SSH 认证能力；不会读取配对私钥。`)) return;
  // Upload the already validated immutable bytes, not an externally reopened filename.
  await session.client.addSshKey(key.text, title);
  ui.text(safeDisplay(`GitHub 已接受 SSH 公钥添加请求：${key.fingerprint}。这不等于已验证 SSH 网络连接或组织 SSO 授权。`));
}
export async function publicKeyMenu(ui: Console, directory: string): Promise<void> {
  const profile = await resolveBinding(directory);
  if (profile && isHttpsOnlyProfile(profile)) { ui.text('此 HTTPS-only 账号没有 SSH 公钥；HTTPS / Token 无需上传公钥。'); return; }
  const session = await githubSession(ui, directory); if (session) await uploadPublicKey(ui, session);
}
export const publicKeyUploadMenu = publicKeyMenu;
