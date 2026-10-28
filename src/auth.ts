/** Bounded, non-shell transport for the packaged key, agent and path-security helper. */
import { createHash } from 'node:crypto';
import { access, constants, lstat, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export interface NativeHelperOptions {
  helperPath?: string;
  timeoutMs?: number;
  /** Only code-created test helpers may bypass the packaged manifest. */
  checkIntegrity?: boolean;
}

export class NativeAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'NativeAuthError'; this.code = code; }
}
/** Retained error name for denied private-key, agent and permission operations. */
export class AuthenticationDeniedError extends NativeAuthError {
  constructor() { super('denied', '原生操作被拒绝'); this.name = 'AuthenticationDeniedError'; }
}

const PROTOCOL = 1;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_HELPER_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const HELPER_CODES = new Set(['denied', 'unavailable', 'unsupported', 'account', 'invalid']);
const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const HELPER_COMMANDS = new Set(['generate-key', 'import-key', 'agent', 'secure-path']);

function unavailable(message = '原生辅助程序不可用'): NativeAuthError { return new NativeAuthError('unavailable', message); }
function protocolError(message = '原生辅助程序响应无效'): NativeAuthError { return new NativeAuthError('unsupported', message); }
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError();
  return value as Record<string, unknown>;
}
function validateResponse(value: unknown): Record<string, unknown> {
  const response = asRecord(value);
  if (response.protocol !== PROTOCOL || typeof response.ok !== 'boolean') throw protocolError();
  if (response.ok === false) {
    if (typeof response.code !== 'string' || !HELPER_CODES.has(response.code)) throw protocolError();
    throw helperError(response.code);
  }
  return response;
}
function helperError(code: string): NativeAuthError {
  if (code === 'denied') return new AuthenticationDeniedError();
  return new NativeAuthError(code, code === 'account' ? '当前系统账户不可用' : code === 'invalid' ? '原生请求无效' : code === 'unsupported' ? '原生辅助程序不支持此操作' : '原生辅助程序不可用');
}
function defaultHelperPath(): string {
  const file = process.platform === 'win32' ? 'autogit-auth.exe' : 'autogit-auth';
  return fileURLToPath(new URL(`../native/bin/${process.platform}-${process.arch}/${file}`, import.meta.url));
}
async function assertExecutable(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw unavailable();
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(file)) throw unavailable();
    let parent = dirname(file);
    while (parent !== dirname(parent)) {
      const folder = await lstat(parent);
      if (folder.isSymbolicLink() || !folder.isDirectory()) throw unavailable();
      parent = dirname(parent);
    }
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  } catch (error) {
    if (error instanceof NativeAuthError) throw error;
    throw unavailable();
  }
}
async function readBoundedFile(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw unavailable();
    const value = Buffer.alloc(info.size + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(value, length, value.length - length, null);
      length += bytesRead;
      if (length > info.size) throw unavailable();
      if (bytesRead === 0) return value.subarray(0, length);
    }
  } finally { await handle.close(); }
}
async function verifyPackagedHelper(file: string): Promise<void> {
  await assertExecutable(file);
  const directory = dirname(file), manifestFile = join(directory, 'manifest.json');
  try {
    const manifestInfo = await lstat(manifestFile);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MAX_MANIFEST_BYTES) throw unavailable();
    const manifest = asRecord(JSON.parse((await readBoundedFile(manifestFile, MAX_MANIFEST_BYTES)).toString('utf8')));
    if (manifest.protocol !== PROTOCOL || manifest.platform !== process.platform || manifest.arch !== process.arch ||
        typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) throw unavailable();
    const digest = createHash('sha256').update(await readBoundedFile(file, MAX_HELPER_BYTES)).digest('hex');
    if (digest !== manifest.sha256) throw unavailable();
  } catch (error) {
    if (error instanceof NativeAuthError) throw error;
    throw unavailable();
  }
}

/** Resolve only the packaged helper, unless a code-created test path opts out of integrity checking. */
export async function resolveNativeHelper(options: NativeHelperOptions = {}): Promise<string> {
  const helper = resolve(options.helperPath ?? defaultHelperPath());
  if (options.helperPath && options.checkIntegrity === false) {
    await assertExecutable(helper);
    return helper;
  }
  await verifyPackagedHelper(helper);
  return helper;
}

function requestBody(payload: Record<string, unknown> | undefined): Buffer | undefined {
  if (payload === undefined) return undefined;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new NativeAuthError('invalid', '原生请求无效');
  if ('protocol' in payload && payload.protocol !== PROTOCOL) throw new NativeAuthError('invalid', '原生请求无效');
  let text: string;
  try { text = JSON.stringify({ protocol: PROTOCOL, ...payload }); }
  catch { throw new NativeAuthError('invalid', '原生请求无效'); }
  const body = Buffer.from(text, 'utf8');
  if (body.length > MAX_JSON_BYTES) { body.fill(0); throw new NativeAuthError('invalid', '原生请求过大'); }
  return body;
}

/** Send one bounded JSON request; argv contains only an allowed command, never payload data. */
export async function nativeRequest(command: string, payload?: Record<string, unknown>, options: NativeHelperOptions = {}): Promise<Record<string, unknown>> {
  if (!COMMAND_PATTERN.test(command)) throw new NativeAuthError('invalid', '原生请求无效');
  // Refuse retired OS-login operations even if an older binary is still on disk.
  if (!HELPER_COMMANDS.has(command)) throw helperError('unsupported');
  return sendNative(command, requestBody(payload), options);
}
async function sendNative(command: string, body: Buffer | undefined, options: NativeHelperOptions): Promise<Record<string, unknown>> {
  let helper: string;
  try { helper = await resolveNativeHelper(options); }
  catch (error) { body?.fill(0); throw error; }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    body?.fill(0);
    throw new NativeAuthError('invalid', '原生辅助程序超时时间无效');
  }
  return new Promise<Record<string, unknown>>((resolveResult, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(helper, [command], {
        cwd: dirname(helper), shell: false,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch {
      body?.fill(0);
      reject(unavailable());
      return;
    }
    const stdout: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, settled = false;
    let timer: NodeJS.Timeout | undefined;
    const clear = (): void => { if (timer) clearTimeout(timer); timer = undefined; };
    const fail = (error: NativeAuthError): void => {
      if (settled) return;
      settled = true; clear(); body?.fill(0);
      try { child.kill('SIGKILL'); } catch { /* It may already have exited. */ }
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      stdout.forEach((part) => part.fill(0));
      reject(error);
    };
    const collect = (parts: Buffer[], size: number, chunk: Buffer, setSize: (value: number) => void): void => {
      if (settled) { chunk.fill(0); return; }
      const next = size + chunk.length;
      if (next > MAX_JSON_BYTES) { chunk.fill(0); fail(new NativeAuthError('invalid', '原生辅助程序输出过大')); return; }
      parts.push(chunk); setSize(next);
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, stdoutBytes, chunk, (value) => { stdoutBytes = value; }));
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) { chunk.fill(0); return; }
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_JSON_BYTES) fail(new NativeAuthError('invalid', '原生辅助程序输出过大'));
      chunk.fill(0);
    });
    child.once('error', () => fail(unavailable()));
    child.once('close', (status, signal) => {
      if (settled) return;
      settled = true; clear(); body?.fill(0);
      const output = Buffer.concat(stdout);
      stdout.forEach((part) => part.fill(0));
      if (signal || status !== 0) { output.fill(0); reject(unavailable()); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(output.toString('utf8').trim()); }
      catch { output.fill(0); reject(protocolError()); return; }
      output.fill(0);
      try { resolveResult(validateResponse(parsed)); }
      catch (error) { reject(error instanceof NativeAuthError ? error : protocolError()); }
    });
    timer = setTimeout(() => fail(unavailable('原生辅助程序超时')), timeoutMs);
    child.stdin?.once('error', () => fail(unavailable()));
    if (body) child.stdin?.end(body, () => body.fill(0));
    else child.stdin?.end();
  });
}
