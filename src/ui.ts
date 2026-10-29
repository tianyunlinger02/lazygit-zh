/** Chinese task prompts. A single input owner yields the terminal to native tools. */
import { createInterface, type Interface } from 'node:readline';

export class Cancelled extends Error { constructor(message = '已返回', readonly warning = false) { super(message); this.name = 'Cancelled'; } }
export class EndOfInput extends Error { constructor() { super('输入已结束'); this.name = 'EndOfInput'; } }
export class SecretTooLong extends Error { constructor() { super('秘密输入过长'); this.name = 'SecretTooLong'; } }
type Read = (prompt: string) => string | Promise<string>;
type Write = (message: string) => void;
export type SecretRead = (prompt: string, maxBytes: number) => Buffer | Promise<Buffer>;
export const DEFAULT_SECRET_MAX_BYTES = 1024;

interface SecretInput extends NodeJS.ReadableStream {
  isTTY?: boolean; isRaw?: boolean; readableEnded?: boolean; destroyed?: boolean;
  readableEncoding?: BufferEncoding | null; readableFlowing?: boolean | null;
  setRawMode?(mode: boolean): unknown;
  isPaused(): boolean;
}
const secretReaders = new WeakSet<SecretInput>();
/** Read-only capability check: no readline, raw-mode transition or input consumption. */
function requireTerminalSecretInput(input: SecretInput = process.stdin): void {
  if (!input.isTTY || typeof input.setRawMode !== 'function' || input.readableEncoding) throw new Error('秘密输入需要未解码的交互式终端和原始输入能力');
  if (input.readableEnded || input.destroyed) throw new EndOfInput();
}
/** No string conversion or echo. The caller owns, and must clear, the returned Buffer. */
export async function readSecret(prompt: string, options: { input?: SecretInput; output?: Pick<NodeJS.WritableStream, 'write'>; maxBytes?: number } = {}): Promise<Buffer> {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  const maxBytes = options.maxBytes ?? DEFAULT_SECRET_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_SECRET_MAX_BYTES) throw new Error('秘密输入长度限制无效');
  requireTerminalSecretInput(input);
  if (secretReaders.has(input)) throw new Error('秘密输入不能并发读取');
  secretReaders.add(input);
  const wasRaw = !!input.isRaw, wasPaused = input.isPaused() || input.readableFlowing !== true;
  const value = Buffer.alloc(maxBytes);
  let length = 0, completed = false;
  return new Promise<Buffer>((resolve, reject) => {
    const finish = (error?: Error, answer?: Buffer): void => {
      if (completed) { answer?.fill(0); return; }
      completed = true;
      secretReaders.delete(input);
      value.fill(0);
      input.pause();
      input.removeListener('data', onData); input.removeListener('end', onEnd);
      input.removeListener('close', onEnd); input.removeListener('error', onError);
      process.removeListener('SIGINT', onInterrupt);
      try { input.setRawMode!(wasRaw); if (!wasPaused) input.resume(); }
      catch { error = new Error('无法恢复终端输入状态'); }
      try { output.write('\n'); } catch { error ??= new Error('秘密输入输出失败'); }
      if (error) { answer?.fill(0); reject(error); } else resolve(answer!);
    };
    const onData = (chunk: Buffer | string): void => {
      if (!Buffer.isBuffer(chunk)) { finish(new Error('秘密输入不能使用字符串流')); return; }
      try {
        for (const byte of chunk) {
          if (byte === 3) { finish(new Cancelled()); break; }
          if (byte === 4 || (process.platform === 'win32' && byte === 26)) { finish(new EndOfInput()); break; }
          if (byte === 10 || byte === 13) { finish(undefined, Buffer.from(value.subarray(0, length))); break; }
          if (byte === 8 || byte === 127) {
            let start = Math.max(0, length - 1);
            while (start > 0 && (value[start] & 0xc0) === 0x80) start--;
            value.fill(0, start, length); length = start;
          } else if (byte < 32) { finish(new Error('秘密输入不支持控制字符')); break; }
          else if (length === maxBytes) { finish(new SecretTooLong()); break; }
          else value[length++] = byte;
        }
      } finally { chunk.fill(0); }
    };
    const onEnd = (): void => finish(new EndOfInput());
    const onError = (): void => finish(new Error('秘密输入失败'));
    const onInterrupt = (): void => finish(new Cancelled());
    input.on('data', onData); input.once('end', onEnd); input.once('close', onEnd); input.once('error', onError);
    process.once('SIGINT', onInterrupt);
    try { input.setRawMode!(true); output.write(prompt); input.resume(); }
    catch { finish(new Error('无法启用安全终端输入')); }
  });
}

class TerminalInput {
  private rl: Interface | undefined;
  private queue: string[] = [];
  private waiter: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
  private ended = false;
  private wasRaw = false;
  private suspensionDepth = 0;
  private readingSecret = false;
  private readonly onClose = (): void => { this.ended = true; const waiter = this.waiter; this.waiter = undefined; waiter?.reject(new EndOfInput()); };
  private readonly tty = !!process.stdin.isTTY;
  private attach(): void {
    if (this.rl || this.ended) return;
    const rl = this.rl = createInterface({ input: process.stdin, output: this.tty ? process.stdout : undefined, terminal: this.tty });
    rl.on('line', (line) => {
      const waiter = this.waiter; this.waiter = undefined;
      if (waiter) waiter.resolve(line); else this.queue.push(line);
    });
    rl.on('SIGINT', () => { const waiter = this.waiter; this.waiter = undefined; waiter?.reject(new Cancelled()); });
    rl.on('close', this.onClose);
  }
  async read(prompt: string): Promise<string> {
    if (this.readingSecret) throw new Error('交互问题不能并发读取');
    this.attach();
    process.stdout.write(prompt);
    if (this.queue.length) return this.queue.shift()!;
    if (this.ended) throw new EndOfInput();
    if (this.waiter) throw new Error('交互问题不能并发读取');
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  async secret(prompt: string, maxBytes: number): Promise<Buffer> {
    if (this.waiter || this.readingSecret || this.suspensionDepth) throw new Error('交互问题不能并发读取');
    if (this.ended) throw new EndOfInput();
    if (!this.tty) throw new Error('秘密输入需要交互式终端');
    this.readingSecret = true;
    const wasRaw = !!process.stdin.isRaw;
    const wasPaused = process.stdin.isPaused() || process.stdin.readableFlowing !== true;
    const oldReadline = this.rl;
    this.rl = undefined;
    let answer: Buffer | undefined;
    try {
      // Preserve readline's own close handler: it removes its echoing input listeners.
      if (oldReadline) {
        oldReadline.removeListener('close', this.onClose);
        oldReadline.close();
        oldReadline.removeAllListeners();
      }
      answer = await readSecret(prompt, { maxBytes });
      return answer;
    } finally {
      this.readingSecret = false;
      try {
        if (process.stdin.readableEnded || process.stdin.destroyed) this.ended = true;
        if (oldReadline && !this.ended) this.attach();
        if (!!process.stdin.isRaw !== wasRaw) process.stdin.setRawMode(wasRaw);
        if (wasPaused) process.stdin.pause(); else process.stdin.resume();
      } catch { answer?.fill(0); throw new Error('无法恢复终端输入状态'); }
    }
  }
  suspend(): void {
    if (this.readingSecret) throw new Error('秘密输入期间不能移交终端');
    if (!this.tty || this.suspensionDepth++ > 0) return;
    this.wasRaw = !!process.stdin.isRaw;
    this.rl?.pause();
    if (this.wasRaw) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  resume(): void {
    if (!this.tty || this.suspensionDepth === 0 || --this.suspensionDepth > 0) return;
    if (this.wasRaw) process.stdin.setRawMode(true);
    this.rl?.resume();
  }
  close(): void { this.rl?.close(); }
}
const terminal = new TerminalInput();
export function suspendInput(): void { terminal.suspend(); }
export function resumeInput(): void { terminal.resume(); }
export function closeInput(): void { terminal.close(); }

const defaultOutput: Write = (message) => console.log(message);
type ColorEnvironment = Readonly<Record<string, string | undefined>>;
/** Escape controls instead of allowing user or subprocess data to control the terminal. */
function diagnosticText(message: string): string {
  return message.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/gu, (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export interface ConsoleOptions {
  quick?: boolean;
  /** Code-only output capability override; injected writers otherwise default to plain text. */
  diagnosticTty?: boolean;
  /** Code-only environment substitute. Environment flags can suppress, never force, color. */
  colorEnv?: ColorEnvironment;
  /** Code-level test input; ordinary string prompts are never reused for secrets. */
  secretInput?: SecretRead;
  secretMaxBytes?: number;
}

export class Console {
  quick: boolean;
  private readonly secretInput: SecretRead;
  private readonly secretMaxBytes: number;
  private readonly injectedSecretInput: boolean;
  private readonly diagnosticColor: boolean;
  constructor(private input: Read = (prompt) => terminal.read(prompt), private output: Write = defaultOutput, options: ConsoleOptions = {}) {
    this.quick = options.quick ?? true;
    const env = options.colorEnv ?? process.env;
    this.diagnosticColor = (options.diagnosticTty ?? (output === defaultOutput && !!process.stdout.isTTY)) && !env.NO_COLOR && env.TERM !== 'dumb' && env.FORCE_COLOR !== '0';
    this.injectedSecretInput = typeof options.secretInput === 'function';
    this.secretInput = options.secretInput ?? ((prompt, maxBytes) => terminal.secret(prompt, maxBytes));
    this.secretMaxBytes = options.secretMaxBytes ?? DEFAULT_SECRET_MAX_BYTES;
  }
  text(message = ''): void { this.output(message); }
  private diagnostic(label: string, color: number, message: string): void {
    const safe = diagnosticText(message);
    this.output(`${this.diagnosticColor ? `\x1b[${color}m[${label}]\x1b[39m` : `[${label}]`} ${safe}`);
  }
  error(message: string): void { this.diagnostic('错误', 31, message); }
  warn(message: string): void { this.diagnostic('警告', 33, message); }
  success(message: string): void { this.diagnostic('成功', 32, message); }
  /** Validate production secret-input capability without opening readline or consuming input. */
  requireSecretInput(): void {
    if (this.injectedSecretInput) return;
    requireTerminalSecretInput(process.stdin);
  }
  async secret(prompt = '密码：', maxBytes = this.secretMaxBytes): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_SECRET_MAX_BYTES) throw new Error('秘密输入长度限制无效');
    const value = await this.secretInput(prompt, maxBytes);
    if (!Buffer.isBuffer(value)) throw new Error('秘密输入必须是 Buffer');
    if (value.length > maxBytes) { value.fill(0); throw new SecretTooLong(); }
    return value;
  }
  title(message: string): void { this.text(`\n── ${message} ──`); }
  async ask(prompt: string, defaultValue = '', options: { allowEmpty?: boolean } = {}): Promise<string> {
    for (;;) {
      const answer = (await this.input(`${prompt}${defaultValue ? ` [${defaultValue}]` : ''}（:q 返回）：`)).trim();
      if (answer === ':q') throw new Cancelled();
      const value = answer || defaultValue;
      if (value || options.allowEmpty) return value;
      this.error('此项不能为空；输入 :q 可返回。');
    }
  }
  async multiline(prompt: string, defaultValue = ''): Promise<string> {
    this.text(`${prompt}（单独一行 . 结束，:q 返回；保留正文中的空格和换行）`);
    const lines: string[] = [];
    for (;;) {
      const line = await this.input('> ');
      if (line === ':q') throw new Cancelled();
      if (line === '.') return lines.length ? lines.join('\n') : defaultValue;
      lines.push(line);
    }
  }
  async confirm(prompt: string, defaultValue = false): Promise<boolean> {
    for (;;) {
      const value = (await this.input(`${prompt} [${defaultValue ? 'Y/n' : 'y/N'}]：`)).trim().toLowerCase();
      if (value === ':q') throw new Cancelled();
      if (!value) return defaultValue;
      if (['y', 'yes', '是', '确认'].includes(value)) return true;
      if (['n', 'no', '否', '不'].includes(value)) return false;
      this.error('请输入 y（是）或 n（否）。');
    }
  }
  async routineConfirm(prompt: string, defaultValue = false): Promise<boolean> { return this.quick || await this.confirm(prompt, defaultValue); }
  async menu(title: string, options: readonly string[], back = '返回'): Promise<number> {
    this.title(title); options.forEach((value, index) => this.text(`  ${index + 1}. ${value}`)); this.text(`  0. ${back}`);
    for (;;) {
      const value = (await this.input('请选择编号：')).trim();
      if ([':q', 'q'].includes(value)) return 0;
      if (/^\d+$/u.test(value) && Number(value) <= options.length) return Number(value);
      this.error(`请输入 0 到 ${options.length} 之间的编号。`);
    }
  }
  async select(options: readonly string[]): Promise<number[]> {
    options.forEach((value, index) => this.text(`  ${index + 1}. ${value}`));
    for (;;) {
      const value = await this.ask('选择编号（空格或逗号分隔，a 全选，回车不添加）', '', { allowEmpty: true });
      if (!value) return [];
      if (value.toLowerCase() === 'a') return options.map((_, index) => index);
      const parts = value.split(/[\s,，]+/u);
      if (parts.every((part) => /^\d+$/u.test(part) && Number(part) >= 1 && Number(part) <= options.length)) return [...new Set(parts.map(Number))].sort((a, b) => a - b).map((item) => item - 1);
      this.error('编号无效，请重新选择；不会修改任何文件。');
    }
  }
}
