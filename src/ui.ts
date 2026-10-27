/** Chinese task prompts. A single input owner yields the terminal to native tools. */
import { createInterface, type Interface } from 'node:readline';

export class Cancelled extends Error { constructor(message = '已返回') { super(message); this.name = 'Cancelled'; } }
export class EndOfInput extends Error { constructor() { super('输入已结束'); this.name = 'EndOfInput'; } }
type Read = (prompt: string) => string | Promise<string>;
type Write = (message: string) => void;

class TerminalInput {
  private rl: Interface | undefined;
  private queue: string[] = [];
  private waiter: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined;
  private ended = false;
  private wasRaw = false;
  private suspensionDepth = 0;
  private readonly tty = !!process.stdin.isTTY;
  private attach(): void {
    if (this.rl || this.ended) return;
    this.rl = createInterface({ input: process.stdin, output: this.tty ? process.stdout : undefined, terminal: this.tty });
    this.rl.on('line', (line) => {
      const waiter = this.waiter; this.waiter = undefined;
      if (waiter) waiter.resolve(line); else this.queue.push(line);
    });
    this.rl.on('SIGINT', () => { const waiter = this.waiter; this.waiter = undefined; waiter?.reject(new Cancelled()); });
    this.rl.on('close', () => { this.ended = true; const waiter = this.waiter; this.waiter = undefined; waiter?.reject(new EndOfInput()); });
  }
  async read(prompt: string): Promise<string> {
    this.attach();
    process.stdout.write(prompt);
    if (this.queue.length) return this.queue.shift()!;
    if (this.ended) throw new EndOfInput();
    if (this.waiter) throw new Error('交互问题不能并发读取');
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  suspend(): void {
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

export class Console {
  quick: boolean;
  constructor(private input: Read = (prompt) => terminal.read(prompt), private output: Write = (message) => console.log(message), options: { quick?: boolean } = {}) { this.quick = options.quick ?? true; }
  text(message = ''): void { this.output(message); }
  title(message: string): void { this.text(`\n── ${message} ──`); }
  async ask(prompt: string, defaultValue = '', options: { allowEmpty?: boolean } = {}): Promise<string> {
    for (;;) {
      const answer = (await this.input(`${prompt}${defaultValue ? ` [${defaultValue}]` : ''}（:q 返回）：`)).trim();
      if (answer === ':q') throw new Cancelled();
      const value = answer || defaultValue;
      if (value || options.allowEmpty) return value;
      this.text('此项不能为空；输入 :q 可返回。');
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
      this.text('请输入 y（是）或 n（否）。');
    }
  }
  async routineConfirm(prompt: string, defaultValue = false): Promise<boolean> { return this.quick || await this.confirm(prompt, defaultValue); }
  async menu(title: string, options: readonly string[], back = '返回'): Promise<number> {
    this.title(title); options.forEach((value, index) => this.text(`  ${index + 1}. ${value}`)); this.text(`  0. ${back}`);
    for (;;) {
      const value = (await this.input('请选择编号：')).trim();
      if ([':q', 'q'].includes(value)) return 0;
      if (/^\d+$/u.test(value) && Number(value) <= options.length) return Number(value);
      this.text(`请输入 0 到 ${options.length} 之间的编号。`);
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
      this.text('编号无效，请重新选择；不会修改任何文件。');
    }
  }
}
