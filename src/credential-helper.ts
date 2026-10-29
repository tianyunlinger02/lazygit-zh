/** Git credential protocol bridge. The token is returned only on helper stdout to Git.
 * The parent process keeps the session/Vault; this short-lived child never stores a token on disk,
 * in argv, or in its environment. Its IPC endpoint carries only an authenticated request/response.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { lstat } from 'node:fs/promises';
import { nativeRequest } from './auth.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedPath, isErrno, parseStrictJson } from './storage.js';
import { currentSession, type CredentialSession } from './session.js';
import type { CredentialPin } from './credential-pin.js';
import { GitError } from './git.js';

const PROTOCOL = 1, MAX_MESSAGE = 16_384, MAX_TOKEN = 4096;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u;
const PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u;

type Operation = 'get' | 'store' | 'erase';
interface CredentialInput { protocol: 'https'; host: string; path: string; username?: string }
interface Request { protocol: 1; secret: string; operation: Operation; credential: CredentialInput }
interface Response { protocol: 1; ok: boolean; code?: 'invalid' | 'missing' | 'closed'; username?: string; password?: string }

function invalid(message = 'Git 凭据辅助程序请求无效。'): GitError { return new GitError(message); }
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\x00-\x1f\x7f-\x9f]/u.test(value)) throw invalid();
  return value;
}
function host(value: unknown): string { const result = text(value, 253).toLowerCase(); if (!HOST.test(result)) throw invalid(); return result; }
function account(value: unknown): string { const result = text(value, 39); if (!LOGIN.test(result)) throw invalid(); return result; }
function repositoryPath(value: unknown): string {
  const result = text(value, 512);
  if (!PATH.test(result) || result.split('/').some((part) => part === '.' || part === '..')) throw invalid();
  return result;
}
function operation(value: unknown): Operation { if (value !== 'get' && value !== 'store' && value !== 'erase') throw invalid(); return value; }
function parseCredentialInput(raw: Buffer): CredentialInput {
  if (raw.length > MAX_MESSAGE) throw invalid();
  const values = new Map<string, string>();
  for (const line of raw.toString('utf8').split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf('='); if (separator <= 0) throw invalid();
    const key = line.slice(0, separator), value = line.slice(separator + 1);
    if (!['protocol', 'host', 'path', 'username'].includes(key) || values.has(key)) throw invalid();
    values.set(key, value);
  }
  if (values.get('protocol') !== 'https' || !values.has('host') || !values.has('path')) throw invalid();
  const result: CredentialInput = { protocol: 'https', host: host(values.get('host')), path: repositoryPath(values.get('path')) };
  if (values.has('username')) result.username = account(values.get('username'));
  return result;
}
function parseRequest(raw: Buffer): Request {
  if (raw.length > MAX_MESSAGE) throw invalid();
  let parsed: unknown;
  try { parsed = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'credential,operation,protocol,secret' || value.protocol !== PROTOCOL) throw invalid();
  const secret = text(value.secret, 256), credential = value.credential;
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) throw invalid();
  const fields = credential as Record<string, unknown>;
  if (!['host', 'path', 'protocol'].every((key) => Object.hasOwn(fields, key)) || Object.keys(fields).some((key) => !['host', 'path', 'protocol', 'username'].includes(key)) || fields.protocol !== 'https') throw invalid();
  return { protocol: PROTOCOL, secret, operation: operation(value.operation), credential: { protocol: 'https', host: host(fields.host), path: repositoryPath(fields.path), ...(fields.username === undefined ? {} : { username: account(fields.username) }) } };
}
function response(value: Response): Buffer { return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'); }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right); try { return a.length === b.length && crypto.timingSafeEqual(a, b); } finally { a.fill(0); b.fill(0); }
}
function tokenText(value: Buffer): string {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > MAX_TOKEN) throw invalid('凭据令牌格式无效。');
  let result: string;
  try { result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value); } catch { throw invalid('凭据令牌格式无效。'); }
  if (!result || /[\x00-\x1f\x7f-\x9f]/u.test(result)) throw invalid('凭据令牌格式无效。');
  return result;
}
function endpointName(directory: string): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\autogit-credential-${crypto.randomBytes(24).toString('hex')}` : path.join(directory, 'c.sock');
}
async function privateDirectory(directory: string, create = false): Promise<void> {
  checkedPath(directory, 'dir', { missing: true });
  let created = false;
  try { await lstat(directory); }
  catch (error) {
    if (!create || !isErrno(error, 'ENOENT')) throw error;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 }); created = true;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new GitError('凭据辅助程序目录类型无效。');
  if (process.platform !== 'win32') {
    const uid = process.geteuid?.() ?? process.getuid?.();
    if (uid === undefined || info.uid !== uid || (info.mode & 0o7777) !== 0o700) {
      if (!created) throw new GitError('凭据辅助程序目录必须属于当前用户且权限为 0700。');
      try { await fs.chmod(directory, 0o700); } catch { throw new GitError('凭据辅助程序目录权限设置失败。'); }
      const after = await lstat(directory);
      if (after.uid !== uid || (after.mode & 0o7777) !== 0o700) throw new GitError('凭据辅助程序目录必须属于当前用户且权限为 0700。');
    }
  }
}

export async function createCredentialDirectory(session: CredentialSession, prefix: string): Promise<string> {
  const root = path.join(path.dirname(session.vault.directory), '.autogit-sessions');
  await privateDirectory(root, true);
  if (process.platform === 'win32') {
    const secured = await nativeRequest('secure-path', { path: root, directory: true });
    if (secured.ok !== true) throw new GitError('Windows 凭据目录 ACL 设置失败。');
  }
  const child = await fs.mkdtemp(path.join(root, prefix));
  try {
    if (process.platform === 'win32') { const secured = await nativeRequest('secure-path', { path: child, directory: true }); if (secured.ok !== true) throw new GitError('Windows 凭据目录 ACL 设置失败。'); }
    else { await fs.chmod(child, 0o700); await privateDirectory(child); }
    return child;
  } catch (error) { await fs.rm(child, { recursive: true, force: true }); throw error; }
}

export interface CredentialHelperOptions { session: CredentialSession; host: string; account: string; repositoryPath: string; pin?: CredentialPin }

export class CredentialHelper {
  readonly host: string; readonly account: string; readonly repositoryPath: string;
  readonly endpoint: string; readonly secret: string;
  #server: Server | undefined; #closed = false; #started = false; readonly #sockets = new Set<Socket>();
  #closing: Promise<void> | undefined; #removePinCleanup: (() => void) | undefined;
  private readonly session: CredentialSession; private readonly cleanupDirectory: string; private readonly pin?: CredentialPin;
  private constructor(options: CredentialHelperOptions, endpoint: string, secret: string, cleanupDirectory: string) {
    this.session = options.session; this.pin = options.pin; this.host = host(options.host); this.account = account(options.account); this.repositoryPath = repositoryPath(options.repositoryPath); this.endpoint = endpoint; this.secret = secret; this.cleanupDirectory = cleanupDirectory;
  }
  static start(options: CredentialHelperOptions): Promise<CredentialHelper> {
    let pending: Promise<CredentialHelper>, removeCleanup: (() => void) | undefined;
    try {
      // Register before the first await or directory allocation: task disposal also owns an in-flight start.
      removeCleanup = options.pin?.onDispose(async () => {
        const helper = await pending.catch(() => undefined);
        await helper?.close();
      });
      pending = CredentialHelper.create(options);
    } catch (error) { removeCleanup?.(); return Promise.reject(error); }
    void pending.then((helper) => { helper.#removePinCleanup = removeCleanup; }, () => { removeCleanup?.(); });
    return pending;
  }
  private static async create(options: CredentialHelperOptions): Promise<CredentialHelper> {
    if (options.session.closed || currentSession() !== options.session) throw invalid('HTTPS 凭据会话已关闭或变化。');
    if (options.pin && (options.pin.host !== host(options.host) || options.pin.account.toLowerCase() !== account(options.account).toLowerCase())) throw invalid('HTTPS 认证绑定的 host / actor 不匹配。');
    await options.pin?.assertCurrent();
    const child = await createCredentialDirectory(options.session, 'c-');
    const helper = new CredentialHelper(options, endpointName(child), crypto.randomBytes(32).toString('base64url'), child);
    try {
      await helper.listen();
      if (options.session.closed || currentSession() !== options.session) throw invalid('HTTPS 凭据会话已关闭或变化。');
      await options.pin?.assertCurrent();
      options.session.onClose(() => helper.close()); return helper;
    }
    catch (error) { await helper.close(); throw error; }
  }
  private async listen(): Promise<void> {
    if (this.#started) return; this.#started = true;
    if (process.platform !== 'win32' && Buffer.byteLength(this.endpoint) > 103) throw new GitError('资料目录路径过长，无法建立安全的 HTTPS 凭据 socket；请使用更短的 AutoGit 目录。');
    const server = createServer({ allowHalfOpen: true }, (socket) => this.handle(socket)); this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => { server.removeListener('listening', ready); reject(error); };
      const ready = (): void => { server.removeListener('error', fail); resolve(); };
      server.once('error', fail); server.once('listening', ready); server.listen(this.endpoint);
    }).catch((error) => { this.#server = undefined; this.#started = false; throw new GitError(`HTTPS 凭据辅助程序无法启动：${error instanceof Error ? error.message : '未知错误'}`); });
  }
  private handle(socket: Socket): void {
    this.#sockets.add(socket); socket.once('close', () => this.#sockets.delete(socket));
    socket.setTimeout(5000); const chunks: Buffer[] = []; let size = 0, done = false, processing = false;
    const finish = (value: Response): void => { if (done) return; done = true; const output = response(value); socket.end(output, () => output.fill(0)); };
    socket.on('data', (chunk: Buffer) => {
      if (done || processing) return; size += chunk.length; if (size > MAX_MESSAGE) { finish({ protocol: PROTOCOL, ok: false, code: 'invalid' }); return; }
      chunks.push(chunk); if (!chunk.includes(10)) return; processing = true;
      void this.answer(Buffer.concat(chunks)).then(finish, () => finish({ protocol: PROTOCOL, ok: false, code: 'invalid' }));
    });
    socket.once('timeout', () => { socket.destroy(); }); socket.once('error', () => { done = true; });
  }
  private async answer(raw: Buffer): Promise<Response> {
    let request: Request;
    try { request = parseRequest(raw.subarray(0, raw.indexOf(10))); } catch { return { protocol: PROTOCOL, ok: false, code: 'invalid' }; }
    if (!equalSecret(request.secret, this.secret) || request.credential.host !== this.host || request.credential.path !== this.repositoryPath || request.credential.username !== undefined && request.credential.username.toLowerCase() !== this.account.toLowerCase()) return { protocol: PROTOCOL, ok: false, code: 'invalid' };
    if (this.#closed || this.session.closed || currentSession() !== this.session) return { protocol: PROTOCOL, ok: false, code: 'closed' };
    if (request.operation !== 'get') return { protocol: PROTOCOL, ok: true };
    const token = await this.session.getToken(this.host, this.account);
    if (!token) return { protocol: PROTOCOL, ok: false, code: 'missing' };
    try {
      if (this.#closed || this.session.closed || currentSession() !== this.session) return { protocol: PROTOCOL, ok: false, code: 'closed' };
      // Validate this exact Buffer, not another vault read that could race with replacement.
      this.pin?.assertToken(this.session, token);
      const value = tokenText(token);
      if (this.#closed || this.session.closed || currentSession() !== this.session) return { protocol: PROTOCOL, ok: false, code: 'closed' };
      return { protocol: PROTOCOL, ok: true, username: this.account, password: value };
    } finally { if (Buffer.isBuffer(token)) token.fill(0); }
  }
  command(): string {
    if (!this.#started || this.#closed) throw new GitError('HTTPS 凭据辅助程序已经关闭。');
    return `!${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(import.meta.url))} --socket ${shellQuote(this.endpoint)} --secret ${shellQuote(this.secret)}`;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true; const server = this.#server; this.#server = undefined;
    this.#removePinCleanup?.(); this.#removePinCleanup = undefined;
    for (const socket of this.#sockets) socket.destroy(); this.#sockets.clear();
    this.#closing = (async () => {
      if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); });
      await fs.rm(this.cleanupDirectory, { recursive: true, force: true });
    })();
    return this.#closing;
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name), value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error('invalid helper arguments'); return value;
}
async function childMain(): Promise<void> {
  const endpoint = argument('--socket'), secret = argument('--secret'), operation = process.argv.at(-1);
  if (!['get', 'store', 'erase'].includes(operation ?? '')) throw new Error('invalid helper operation');
  const input: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); size += value.length; if (size > MAX_MESSAGE) throw new Error('invalid helper input'); input.push(value); }
  if (operation !== 'get') { input.forEach((item) => item.fill(0)); return; }
  const credential = parseCredentialInput(Buffer.concat(input)); input.forEach((item) => item.fill(0));
  const request = Buffer.from(JSON.stringify({ protocol: PROTOCOL, secret, operation, credential }) + '\n');
  const result = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(endpoint); const output: Buffer[] = []; let bytes = 0;
    socket.setTimeout(5000); socket.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_MESSAGE) { socket.destroy(new Error('invalid helper response')); return; } output.push(chunk); });
    socket.once('timeout', () => socket.destroy(new Error('helper timeout'))); socket.once('error', reject); socket.once('close', () => resolve(Buffer.concat(output)));
    socket.on('connect', () => socket.end(request));
  });
  request.fill(0);
  let parsed: unknown;
  try { parsed = JSON.parse(result.toString('utf8').trim()); } finally { result.fill(0); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid helper response');
  const value = parsed as Record<string, unknown>;
  if (value.protocol !== PROTOCOL || value.ok !== true) throw new Error('credential unavailable');
  if (operation !== 'get') return;
  if (typeof value.username !== 'string' || typeof value.password !== 'string' || !LOGIN.test(value.username)) throw new Error('credential unavailable');
  const token = Buffer.from(value.password); if (token.length > MAX_TOKEN || /[\x00-\x1f\x7f-\x9f]/u.test(value.password)) { token.fill(0); throw new Error('credential unavailable'); }
  const output = Buffer.from(`username=${value.username}\npassword=${value.password}\n\n`, 'utf8'); token.fill(0);
  await new Promise<void>((resolve, reject) => process.stdout.write(output, (error) => { output.fill(0); error ? reject(error) : resolve(); }));
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) childMain().catch(() => { process.stderr.write('credential helper unavailable\n', () => process.exitCode = 1); });
