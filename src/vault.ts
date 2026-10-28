/** Standalone password-encrypted storage, with no operating-system authentication dependency.
 * Existing private paths are verified, never silently repaired; only newly created paths are hardened.
 */
import * as crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { GitError } from './git.js';
import { nativeRequest } from './auth.js';
import { checkedPath, exactKeys, isErrno, parseStrictJson, record, withStoreLock } from './storage.js';

export interface VaultMetadata { type: string; host?: string; account?: string }
interface Envelope { nonce: string; ciphertext: string; tag: string }
interface Kdf { name: 'scrypt'; N: number; r: number; p: number; key_length: number; salt: string }
interface Wrapper extends Envelope { kdf: Kdf }
interface SecretRecord extends Envelope { id: string; metadata: VaultMetadata | null }
interface Document {
  schema_version: 1; vault_id: string; cipher: 'aes-256-gcm';
  password: Wrapper; recovery: Wrapper; records: SecretRecord[]; integrity: Envelope;
}

const KEY_BYTES = 32, NONCE_BYTES = 12, TAG_BYTES = 16, SALT_BYTES = 16;
// One supported, bounded profile: untrusted files cannot lower its cost or request arbitrary resources.
const SCRYPT = { name: 'scrypt', N: 32_768, r: 8, p: 1, key_length: KEY_BYTES } as const;
const MAX_JSON_BYTES = 1_048_576, MAX_SECRET_BYTES = 65_536, MAX_RECORDS = 1024;
const ENVELOPE_KEYS = ['nonce', 'ciphertext', 'tag'];
const DOCUMENT_KEYS = ['schema_version', 'vault_id', 'cipher', 'password', 'recovery', 'records', 'integrity'];
const RECOVERY_CODE = /^[a-f0-9]{8}(?:-[a-f0-9]{8}){7}$/u;
const corrupt = (): GitError => new GitError('保险库结构、参数或完整性无效；未自动覆盖。');

/** Authentication failure only; malformed schemas and unsafe paths are not password failures. */
export class VaultUnlockError extends GitError {
  constructor() { super('保险库无法解锁：密码或恢复码错误，或密钥包装已损坏。'); this.name = 'VaultUnlockError'; }
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)) throw new GitError('保险库记录标识无效。');
  return value;
}
function label(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > maximum || /[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(value)) throw corrupt();
  return value;
}
function metadata(value: unknown): VaultMetadata | null {
  if (value === null) return null;
  if (!record(value) || !Object.hasOwn(value, 'type') || Object.keys(value).some((key) => !['type', 'host', 'account'].includes(key))) throw corrupt();
  const result: VaultMetadata = { type: label(value.type, 64) };
  if (Object.hasOwn(value, 'host')) result.host = label(value.host, 253);
  if (Object.hasOwn(value, 'account')) result.account = label(value.account, 256);
  return result;
}
function base64(value: unknown, minimum: number, maximum = minimum): string {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(maximum / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw corrupt();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < minimum || decoded.length > maximum || decoded.toString('base64') !== value) throw corrupt();
  return value;
}
function envelope(value: Record<string, unknown>, minimum: number, maximum = minimum): Envelope {
  return { nonce: base64(value.nonce, NONCE_BYTES), ciphertext: base64(value.ciphertext, minimum, maximum), tag: base64(value.tag, TAG_BYTES) };
}
function wrapper(value: unknown): Wrapper {
  if (!record(value) || !exactKeys(value, ['kdf', ...ENVELOPE_KEYS]) || !record(value.kdf) || !exactKeys(value.kdf, [...Object.keys(SCRYPT), 'salt'])) throw corrupt();
  const kdf = value.kdf;
  if (Object.entries(SCRYPT).some(([key, expected]) => kdf[key] !== expected)) throw corrupt();
  return { kdf: { ...SCRYPT, salt: base64(kdf.salt, SALT_BYTES) }, ...envelope(value, KEY_BYTES) };
}
function document(value: unknown): Document {
  if (!record(value) || !exactKeys(value, DOCUMENT_KEYS) || value.schema_version !== 1 || value.cipher !== 'aes-256-gcm' || typeof value.vault_id !== 'string' || !/^[a-f0-9]{32}$/u.test(value.vault_id) || !Array.isArray(value.records) || value.records.length > MAX_RECORDS || !record(value.integrity) || !exactKeys(value.integrity, ENVELOPE_KEYS)) throw corrupt();
  const ids = new Set<string>(), nonces = new Set<string>();
  const records = value.records.map((item: unknown): SecretRecord => {
    if (!record(item) || !exactKeys(item, ['id', 'metadata', ...ENVELOPE_KEYS])) throw corrupt();
    const id = identifier(item.id), encrypted = envelope(item, 0, MAX_SECRET_BYTES);
    if (ids.has(id) || nonces.has(encrypted.nonce)) throw corrupt();
    ids.add(id); nonces.add(encrypted.nonce);
    return { id, metadata: metadata(item.metadata), ...encrypted };
  });
  const integrity = envelope(value.integrity, 0);
  if (nonces.has(integrity.nonce)) throw corrupt();
  const password = wrapper(value.password), recovery = wrapper(value.recovery);
  if (password.kdf.salt === recovery.kdf.salt) throw corrupt();
  return { schema_version: 1, vault_id: value.vault_id, cipher: 'aes-256-gcm', password, recovery, records, integrity };
}

function privateStat(info: fs.Stats, kind: 'dir' | 'file'): void {
  if (kind === 'dir' ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) throw new GitError('保险库路径类型或硬链接数量异常。');
  if (process.platform !== 'win32') {
    const uid = process.geteuid?.() ?? process.getuid?.();
    if (uid === undefined || info.uid !== uid || (info.mode & 0o7777) !== (kind === 'dir' ? 0o700 : 0o600)) throw new GitError('保险库必须属于当前用户，目录权限为 0700、文件权限为 0600。');
  }
}
function privatePath(file: string, kind: 'dir' | 'file', missing = false): fs.Stats | undefined {
  checkedPath(file, kind, { missing });
  let info: fs.Stats;
  try { info = fs.lstatSync(file); }
  catch (error) { if (missing && isErrno(error, 'ENOENT')) return undefined; throw error; }
  privateStat(info, kind); return info;
}
function sameFile(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}
async function verifyNativePath(value: string, directory: boolean, verifyOnly: boolean): Promise<void> {
  if (process.platform === 'win32') await nativeRequest('secure-path', { path: value, directory, ...(verifyOnly ? { verifyOnly: true } : {}) });
}

/** Ensure a private credential directory, hardening only a newly created leaf. */
export async function secureCredentialDirectory(directoryValue: string): Promise<string> {
  const directory = checkedPath(directoryValue, 'dir', { missing: true });
  const existed = privatePath(directory, 'dir', true) !== undefined;
  if (existed) {
    await verifyNativePath(directory, true, true);
    return directory;
  }
  await fsp.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  let created = false;
  try { await fsp.mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) { if (!isErrno(error, 'EEXIST')) throw error; }
  // A racing existing directory is verification-only, just like any existing path.
  if (created) {
    checkedPath(directory, 'dir');
    if (process.platform !== 'win32') await fsp.chmod(directory, 0o700);
    else await verifyNativePath(directory, true, false);
  }
  privatePath(directory, 'dir');
  await verifyNativePath(directory, true, true);
  return directory;
}

async function prepareDirectory(directory: string): Promise<void> { await secureCredentialDirectory(directory); }
async function locked<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  privatePath(directory, 'dir');
  await verifyNativePath(directory, true, true);
  return withStoreLock(directory, async () => {
    privatePath(directory, 'dir'); privatePath(path.join(directory, '.lock'), 'file');
    await verifyNativePath(path.join(directory, '.lock'), false, false);
    await verifyNativePath(path.join(directory, '.lock'), false, true);
    return operation();
  });
}
async function readDocument(directory: string): Promise<Document> {
  privatePath(directory, 'dir');
  await verifyNativePath(directory, true, true);
  const file = path.join(directory, 'vault.json'), expected = privatePath(file, 'file', true);
  if (!expected) throw new GitError('保险库尚未初始化。');
  await verifyNativePath(file, false, true);
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const buffer = Buffer.alloc(MAX_JSON_BYTES + 1);
  try {
    const before = await handle.stat(); privateStat(before, 'file');
    if (!sameFile(expected, before) || before.size > MAX_JSON_BYTES) throw corrupt();
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    const after = await handle.stat(); privateStat(after, 'file'); privatePath(directory, 'dir');
    const current = privatePath(file, 'file');
    if (total > MAX_JSON_BYTES || !sameFile(before, after) || !current || !sameFile(after, current)) throw corrupt();
    let parsed: unknown;
    try { parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, total))); }
    catch { throw corrupt(); }
    return document(parsed);
  } finally { buffer.fill(0); await handle.close(); }
}

/** Unlike general metadata's best-effort chmod, vault staging permissions must succeed before rename. */
async function writeDocument(directory: string, data: Document, createOnly = false): Promise<void> {
  const encoded = `${JSON.stringify(data, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) throw new GitError('保险库容量超过限制；未写入。');
  privatePath(directory, 'dir');
  const file = path.join(directory, 'vault.json'), original = privatePath(file, 'file', true);
  await verifyNativePath(directory, true, true);
  if (original) await verifyNativePath(file, false, true);
  if (createOnly && original) throw new GitError('保险库已存在；不会覆盖初始化。');
  const temporary = path.join(directory, `.tmp-vault-${crypto.randomUUID()}`);
  let created = false;
  try {
    const handle = await fsp.open(temporary, 'wx', 0o600); created = true;
    let staged: fs.Stats;
    try {
      if (process.platform !== 'win32') await handle.chmod(0o600);
      else await verifyNativePath(temporary, false, false);
      privateStat(await handle.stat(), 'file');
      await verifyNativePath(temporary, false, true);
      await handle.writeFile(encoded, 'utf8'); await handle.sync(); staged = await handle.stat();
    } finally { await handle.close(); }
    privatePath(directory, 'dir');
    const current = privatePath(file, 'file', true), currentStage = privatePath(temporary, 'file');
    if ((original ? !current || !sameFile(original, current) : current !== undefined) || !currentStage || !sameFile(staged, currentStage)) throw new GitError('保险库文件在写入期间发生变化；未覆盖。');
    await fsp.rename(temporary, file); created = false;
    privatePath(file, 'file');
    await verifyNativePath(file, false, true);
    if (process.platform !== 'win32') {
      const folder = await fsp.open(directory, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try { privateStat(await folder.stat(), 'dir'); await folder.sync(); } finally { await folder.close(); }
    }
  } finally {
    if (created) await fsp.unlink(temporary).catch((error: unknown) => { if (!isErrno(error, 'ENOENT')) throw error; });
  }
}

function aad(data: Pick<Document, 'vault_id'>, purpose: string, binding: unknown): Buffer {
  return Buffer.from(JSON.stringify(['AutoGit/vault', 1, data.vault_id, 'aes-256-gcm', purpose, binding]), 'utf8');
}
function seal(key: Buffer, associated: Buffer, plaintext: Buffer, used = new Set<string>()): Envelope {
  let nonce: Buffer;
  do { nonce = crypto.randomBytes(NONCE_BYTES); } while (used.has(nonce.toString('base64')));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function open(key: Buffer, associated: Buffer, encrypted: Envelope): Buffer {
  const nonce = Buffer.from(encrypted.nonce, 'base64'), tag = Buffer.from(encrypted.tag, 'base64'), ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
  let partial: Buffer | undefined, final: Buffer | undefined;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(associated); decipher.setAuthTag(tag);
    partial = decipher.update(ciphertext); final = decipher.final();
    return Buffer.concat([partial, final]);
  } finally { partial?.fill(0); final?.fill(0); nonce.fill(0); tag.fill(0); ciphertext.fill(0); }
}
function derive(input: Buffer, kdf: Kdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(input, Buffer.from(kdf.salt, 'base64'), KEY_BYTES, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}
async function wrap(data: Pick<Document, 'vault_id'>, purpose: 'password' | 'recovery', input: Buffer, dek: Buffer): Promise<Wrapper> {
  const kdf: Kdf = { ...SCRYPT, salt: crypto.randomBytes(SALT_BYTES).toString('base64') };
  const key = await derive(input, kdf);
  try { return { kdf, ...seal(key, aad(data, purpose, kdf), dek) }; }
  finally { key.fill(0); }
}
async function unwrap(data: Document, purpose: 'password' | 'recovery', input: Buffer): Promise<Buffer> {
  const encrypted = data[purpose], key = await derive(input, encrypted.kdf);
  try {
    try { return open(key, aad(data, purpose, encrypted.kdf), encrypted); }
    catch { throw new VaultUnlockError(); }
  } finally { key.fill(0); }
}
function manifest(data: Document): Buffer {
  const { integrity: _integrity, ...payload } = data;
  return aad(data, 'manifest', payload);
}
function authenticate(data: Document, key: Buffer): void {
  try { open(key, manifest(data), data.integrity).fill(0); }
  catch { throw corrupt(); }
}
function nonces(data: Document): Set<string> { return new Set([data.integrity.nonce, ...data.records.map((item) => item.nonce)]); }
function sign(data: Document, key: Buffer): void { data.integrity = seal(key, manifest(data), Buffer.alloc(0), nonces(data)); }
function passwordBuffer(value: Buffer): Buffer {
  if (!Buffer.isBuffer(value) || !value.length || value.length > 4096) throw new GitError('保险库密码必须是非空 Buffer，且不超过 4096 字节。');
  return Buffer.from(value);
}
/** Validate without decoding/copying secrets; spaces and Unicode forms retain their exact bytes. */
export function validateNewPassword(value: Buffer): void {
  if (!Buffer.isBuffer(value) || value.length > 1024) throw new GitError('新保险库密码必须是至少 12 个 Unicode 字符，且不超过 1024 字节。');
  if (!isUtf8(value)) throw new GitError('新保险库密码必须是有效的 UTF-8 文本。');
  let characters = 0;
  for (const byte of value) if ((byte & 0xc0) !== 0x80) characters++;
  if (characters < 12) throw new GitError('新保险库密码必须是至少 12 个 Unicode 字符，且不超过 1024 字节。');
}
function newPasswordBuffer(value: Buffer): Buffer { validateNewPassword(value); return Buffer.from(value); }
function recoveryBuffer(value: Buffer | string): Buffer {
  if ((!Buffer.isBuffer(value) && typeof value !== 'string') || value.length !== 71) throw new VaultUnlockError();
  const result = Buffer.from(value);
  if (!RECOVERY_CODE.test(result.toString('utf8'))) { result.fill(0); throw new VaultUnlockError(); }
  return result;
}
function newRecoveryCode(): string {
  const bytes = crypto.randomBytes(KEY_BYTES);
  try { return bytes.toString('hex').match(/.{8}/gu)!.join('-'); }
  finally { bytes.fill(0); }
}

export class Vault {
  readonly directory: string;
  #dek: Buffer | undefined;
  readonly #id: string;
  private constructor(directory: string, id: string, dek: Buffer) { this.directory = directory; this.#id = id; this.#dek = dek; }

  /** The returned recovery code is never persisted in plaintext. The caller owns and clears its input Buffer. */
  static async create(directoryValue: string, password: Buffer): Promise<{ vault: Vault; recoveryCode: string }> {
    const directory = checkedPath(directoryValue, 'dir', { missing: true }), input = newPasswordBuffer(password);
    let dek: Buffer | undefined;
    try {
      await prepareDirectory(directory);
      const recoveryCode = newRecoveryCode(), recoveryInput = recoveryBuffer(recoveryCode);
      try {
        const data = await locked(directory, async () => {
          if (privatePath(path.join(directory, 'vault.json'), 'file', true)) throw new GitError('保险库已存在；不会覆盖初始化。');
          dek = crypto.randomBytes(KEY_BYTES);
          const identity = { vault_id: crypto.randomBytes(16).toString('hex') };
          const passwordWrap = await wrap(identity, 'password', input, dek), recoveryWrap = await wrap(identity, 'recovery', recoveryInput, dek);
          const result: Document = { schema_version: 1, ...identity, cipher: 'aes-256-gcm', password: passwordWrap, recovery: recoveryWrap, records: [], integrity: { nonce: '', ciphertext: '', tag: '' } };
          sign(result, dek); await writeDocument(directory, result, true); return result;
        });
        const vault = new Vault(directory, data.vault_id, dek!); dek = undefined;
        return { vault, recoveryCode };
      } finally { recoveryInput.fill(0); }
    } finally { input.fill(0); dek?.fill(0); }
  }

  static async unlock(directoryValue: string, password: Buffer): Promise<Vault> {
    const directory = checkedPath(directoryValue, 'dir'), input = passwordBuffer(password);
    let dek: Buffer | undefined;
    try {
      const data = await readDocument(directory); dek = await unwrap(data, 'password', input); authenticate(data, dek);
      const vault = new Vault(directory, data.vault_id, dek); dek = undefined; return vault;
    } finally { input.fill(0); dek?.fill(0); }
  }

  /** Change only the password wrapper, retaining the DEK, recovery wrapper, records and vault identity. */
  async changePassword(oldPassword: Buffer, newPassword: Buffer): Promise<void> {
    this.#key();
    let oldInput: Buffer | undefined, nextInput: Buffer | undefined, candidate: Buffer | undefined;
    try {
      oldInput = passwordBuffer(oldPassword); nextInput = newPasswordBuffer(newPassword);
      await locked(this.directory, async () => {
        const data = await readDocument(this.directory);
        if (data.vault_id !== this.#id) throw new GitError('保险库标识已变化；请重新解锁。');
        candidate = await unwrap(data, 'password', oldInput!);
        authenticate(data, candidate);
        if (!crypto.timingSafeEqual(candidate, this.#key())) throw new VaultUnlockError();
        data.password = await wrap(data, 'password', nextInput!, candidate);
        sign(data, candidate);
        await writeDocument(this.directory, data);
      });
    } finally { oldInput?.fill(0); nextInput?.fill(0); candidate?.fill(0); }
  }

  /** Recover the same DEK, rewrap with the new password, and rotate the recovery code atomically. */
  static async recover(directoryValue: string, recoveryCodeValue: Buffer | string, newPassword: Buffer): Promise<{ vault: Vault; recoveryCode: string }> {
    const directory = checkedPath(directoryValue, 'dir'), input = newPasswordBuffer(newPassword);
    let recoveryInput: Buffer | undefined, nextInput: Buffer | undefined, dek: Buffer | undefined, verifiedDek: Buffer | undefined;
    try {
      recoveryInput = recoveryBuffer(recoveryCodeValue);
      // A wrong code must not even acquire/create the store lock or change permissions.
      const before = await readDocument(directory);
      verifiedDek = await unwrap(before, 'recovery', recoveryInput); authenticate(before, verifiedDek);
      const recoveryCode = newRecoveryCode(); nextInput = recoveryBuffer(recoveryCode);
      const data = await locked(directory, async () => {
        const result = await readDocument(directory);
        if (result.vault_id !== before.vault_id) throw new GitError('保险库标识已变化；请重新恢复。');
        dek = await unwrap(result, 'recovery', recoveryInput!); authenticate(result, dek);
        if (!crypto.timingSafeEqual(dek, verifiedDek!)) throw new GitError('保险库密钥已变化；请重新恢复。');
        result.password = await wrap(result, 'password', input, dek); result.recovery = await wrap(result, 'recovery', nextInput!, dek);
        sign(result, dek); await writeDocument(directory, result); return result;
      });
      const vault = new Vault(directory, data.vault_id, dek!); dek = undefined; return { vault, recoveryCode };
    } finally { input.fill(0); recoveryInput?.fill(0); nextInput?.fill(0); dek?.fill(0); verifiedDek?.fill(0); }
  }

  #key(): Buffer { if (!this.#dek) throw new GitError('保险库已关闭。'); return this.#dek; }
  async #load(): Promise<Document> {
    this.#key();
    const data = await readDocument(this.directory);
    if (data.vault_id !== this.#id) throw new GitError('保险库标识已变化；请重新解锁。');
    authenticate(data, this.#key()); return data;
  }

  async get(idValue: string): Promise<Buffer | undefined> {
    this.#key(); const id = identifier(idValue), data = await this.#load(), item = data.records.find((value) => value.id === id);
    if (!item) return undefined;
    try { return open(this.#key(), aad(data, 'record', [item.id, item.metadata]), item); }
    catch { throw corrupt(); }
  }
  async has(idValue: string): Promise<boolean> {
    this.#key(); const id = identifier(idValue), data = await this.#load(); return data.records.some((item) => item.id === id);
  }
  async put(idValue: string, secret: Buffer, metadataValue?: VaultMetadata): Promise<void> {
    this.#key(); const id = identifier(idValue), info = metadata(metadataValue === undefined ? null : metadataValue);
    if (!Buffer.isBuffer(secret) || secret.length > MAX_SECRET_BYTES) throw new GitError('秘密必须是 Buffer，且不超过 65536 字节。');
    const input = Buffer.from(secret);
    try {
      await locked(this.directory, async () => {
        const data = await this.#load(), index = data.records.findIndex((item) => item.id === id);
        if (index < 0 && data.records.length >= MAX_RECORDS) throw new GitError('保险库记录数量超过限制。');
        const item: SecretRecord = { id, metadata: info, ...seal(this.#key(), aad(data, 'record', [id, info]), input, nonces(data)) };
        if (index < 0) data.records.push(item); else data.records[index] = item;
        sign(data, this.#key()); await writeDocument(this.directory, data);
      });
    } finally { input.fill(0); }
  }
  async delete(idValue: string): Promise<boolean> {
    this.#key(); const id = identifier(idValue);
    return locked(this.directory, async () => {
      const data = await this.#load(), index = data.records.findIndex((item) => item.id === id);
      if (index < 0) return false;
      data.records.splice(index, 1); sign(data, this.#key()); await writeDocument(this.directory, data); return true;
    });
  }
  /** Reopen only a verified copy of this same vault; no password/key is persisted for relocation. */
  async atDirectory(directoryValue: string): Promise<Vault> {
    const directory = checkedPath(directoryValue, 'dir');
    const data = await readDocument(directory);
    if (data.vault_id !== this.#id) throw new GitError('目标不是当前已解锁的凭据库；请在目标位置重新登录并恢复。');
    authenticate(data, this.#key());
    return new Vault(directory, this.#id, Buffer.from(this.#key()));
  }
  /** Best-effort memory hygiene, not a guarantee against JS/runtime copies. Does not revoke other open instances. */
  close(): void { this.#dek?.fill(0); this.#dek = undefined; }
}
