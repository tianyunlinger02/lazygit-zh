/** Native process boundary. Never send credentials through a shell or application prompts. */
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { constants as osConstants } from 'node:os';
import { suspendInput, resumeInput, Cancelled } from './ui.js';

export interface ProcessResult { status: number; stdout: Buffer; stderr: Buffer; signal?: NodeJS.Signals | null }
export interface ProcessOptions { cwd: string; env?: NodeJS.ProcessEnv; interactive?: boolean; captureStdout?: boolean; inputData?: Buffer; check?: boolean }
export function which(name: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
  const windows = process.platform === 'win32';
  const lookup = (key: string) => Object.entries(env).find(([item]) => item.toUpperCase() === key)?.[1];
  const path = windows ? lookup('PATH') : env.PATH;
  const extensions = windows && !/\.[^/\\]+$/u.test(name) ? (lookup('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const folder of isAbsolute(name) || name.includes('/') || name.includes('\\') ? [''] : (path ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const candidate = resolve(cwd, folder ? join(folder, name + extension) : name + extension);
      try { if (statSync(candidate).isFile()) { accessSync(candidate, windows ? constants.F_OK : constants.X_OK); return candidate; } } catch { /* Try the next PATH entry. */ }
    }
  }
  return undefined;
}
export async function runProcess(program: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const env = options.env ?? process.env;
  const target = which(program, env, options.cwd) ?? program;
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(target)) throw new Error('原生工具必须是可执行程序，不能通过 shell 运行 .cmd/.bat。');
  const inheritInput = options.inputData === undefined;
  if (inheritInput) suspendInput();
  let interrupted = false;
  let interrupt: (() => void) | undefined;
  try {
    const result = await new Promise<ProcessResult>((resolveResult, reject) => {
      let child;
      try { child = spawn(target, [...args], { cwd: options.cwd, env, shell: false, stdio: [inheritInput ? 'inherit' : 'pipe', options.interactive && !options.captureStdout ? 'inherit' : 'pipe', options.interactive ? 'inherit' : 'pipe'] }); }
      catch (error) { reject(error); return; }
      if (inheritInput && process.stdin.isTTY) {
        interrupt = () => { interrupted = true; child.kill('SIGINT'); };
        process.on('SIGINT', interrupt);
      }
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', (status, signal) => resolveResult({ status: status ?? (signal ? 128 + (osConstants.signals[signal] ?? 1) : 1), stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), signal }));
      child.stdin?.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error); });
      if (options.inputData !== undefined) child.stdin?.end(options.inputData);
    });
    if (interrupted) throw new Cancelled('当前操作已中断；已完成的步骤不会自动回滚，请检查项目状态。');
    if (options.check && result.status !== 0) throw new Error(`程序退出码 ${result.status}：${result.stderr.toString('utf8')}`);
    return result;
  } finally { if (interrupt) process.removeListener('SIGINT', interrupt); if (inheritInput) resumeInput(); }
}
