/** Git subprocess context and NUL-safe paths. Git remains the implementation of Git. */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { runProcess, which, type ProcessResult } from './process.js';
import { Cancelled } from './ui.js';

export class GitError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'GitError'; } }
export function redact(text: string): string { return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s]*@/gu, '$1[凭据已隐藏]@').replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s?#]+)[?#][^\s]*/gu, '$1[参数已隐藏]'); }
export function explain(text: string): string {
  const lower = text.toLowerCase();
  for (const [patterns, message] of [
    [['permission denied (publickey)'], 'SSH 认证失败：请在账号与密钥中检查公钥及 GitHub 账号。'],
    [['authentication failed', 'could not read username'], 'HTTPS 认证失败：请使用 Git 凭据助手，GitHub 不支持账号密码推送。'],
    [['non-fast-forward', 'fetch first', 'rejected'], '推送被拒绝，请检查远程更新、lease 和权限；普通推送不会自动升级强推，可在远程工具明确选择。'],
    [['author identity unknown', 'unable to auto-detect email'], '缺少提交姓名或邮箱，请在软件中选择账号。'],
    [['could not resolve', 'connection timed out', 'network is unreachable'], '网络或域名连接失败，请检查网络。'],
    [['host key verification failed', 'remote host identification has changed'], 'SSH 主机验证失败，请核对官方指纹，不要关闭验证。'],
    [['repository not found'], '仓库不存在或没有访问权限，请核对地址与账号。'],
    [['not possible to fast-forward', 'divergent'], '历史已经分叉，不能快进；请使用外部 Git 处理本地历史后重试，强推不能解决本地分叉。'],
  ] as [string[], string][]) if (patterns.some((pattern) => lower.includes(pattern))) return message;
  return 'Git 操作未完成；没有自动强推、重置或清理。';
}
export function validateUrl(value: string): string {
  value = value.trim();
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)\/?$/u.exec(value);
  if (match && !['.', '..', '.git'].includes(match[2]) && !/[\s\x00-\x1f\x7f]/u.test(value)) return value;
  throw new GitError('仅接受 github.com 的 SSH/HTTPS 仓库地址，不能包含凭据、空白或额外参数。');
}

/** Validate a generic Git transport without treating it as a GitHub API repository. */
export function validateGitUrl(value: string): string {
  if (!value || value !== value.trim() || /[\s\x00-\x1f\x7f-\x9f]/u.test(value) || value.startsWith('-')) throw new GitError('仓库地址不能为空或包含空白、控制字符及命令选项。');
  if (/^(?:https?|ssh|git):\/\//u.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new GitError('仓库地址或端口无效。'); }
    if (!url.hostname || url.search || url.hash || url.password || url.protocol !== 'ssh:' && url.username || !url.pathname || url.pathname === '/') throw new GitError('仓库地址不能包含密码、查询参数、片段或空项目路径。');
    const rawPath = value.slice(value.indexOf('/', value.indexOf('://') + 3) + 1);
    let parts: string[];
    try { parts = rawPath.replace(/\/$/u, '').split('/').map(part => decodeURIComponent(part)); } catch { throw new GitError('仓库路径编码无效。'); }
    if (parts.some(part => !part || ['.', '..'].includes(part) || /[\\/\s\x00-\x1f\x7f?#]/u.test(part))) throw new GitError('仓库路径无效。');
    if (url.hostname.toLowerCase() === 'github.com' && parts.length !== 2) throw new GitError('GitHub 地址应是 owner/repository，不是文件或分支网页地址。');
    return value;
  }
  const match = /^(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9][A-Za-z0-9_.-]*):([^/].*)$/u.exec(value);
  if (!match || value.includes('::') || /^[A-Za-z]:[\\/]/u.test(value)) throw new GitError('请使用 SSH、HTTPS 或 Git 协议地址；SSH Host alias 也可以使用。');
  const repository = match[2].replace(/\/$/u, '');
  if (!repository || repository.split('/').some(part => !part || ['.', '..'].includes(part) || /[\\\s\x00-\x1f\x7f?#]/u.test(part))) throw new GitError('仓库路径无效。');
  if (match[1].toLowerCase() === 'github.com' && repository.split('/').length !== 2) throw new GitError('GitHub 地址应是 owner/repository，不是文件或分支网页地址。');
  return value;
}

/** Python-compatible surrogateescape for POSIX filename bytes, never for subprocess argv. */
export function decodePath(raw: Buffer): string {
  let result = '';
  for (let i = 0; i < raw.length;) {
    const first = raw[i];
    if (first < 0x80) { result += String.fromCharCode(first); i++; continue; }
    const size = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
    const piece = raw.subarray(i, i + size);
    let decoded: string | undefined;
    if (size && piece.length === size) { try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(piece); } catch { /* Escape the invalid byte. */ } }
    if (decoded !== undefined) { result += decoded; i += size; } else { result += String.fromCharCode(0xdc00 + first); i++; }
  }
  return result;
}
export function encodePath(value: string): Buffer {
  const parts: Buffer[] = [];
  let normal = '';
  const flush = () => { if (normal) { parts.push(Buffer.from(normal)); normal = ''; } };
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { normal += value[i] + value[++i]; }
    else if (code >= 0xdc80 && code <= 0xdcff) { flush(); parts.push(Buffer.from([code - 0xdc00])); }
    else normal += value[i];
  }
  flush(); return Buffer.concat(parts);
}
export class Change {
  constructor(readonly index: string, readonly worktree: string, readonly path: string, readonly original?: string) {}
  get staged(): boolean { return ![' ', '?', '!'].includes(this.index); }
  get unstaged(): boolean { return this.index === '?' || this.worktree !== ' '; }
  get conflict(): boolean { return this.index === 'U' || this.worktree === 'U' || ['AA', 'DD'].includes(this.index + this.worktree); }
  label(): string { return `[${[this.staged ? '已暂存' : '', this.unstaged ? this.index === '?' ? '新文件' : '未暂存' : '', this.conflict ? '冲突' : ''].filter(Boolean).join(' / ')}] ${this.original ? JSON.stringify(this.original) + ' → ' : ''}${JSON.stringify(this.path)}`; }
}
export function splitNul(raw: Buffer): Buffer[] {
  const result: Buffer[] = []; let start = 0;
  for (let i = 0; i < raw.length; i++) if (raw[i] === 0) { result.push(raw.subarray(start, i)); start = i + 1; }
  if (start < raw.length) result.push(raw.subarray(start)); return result;
}
export function parseStatus(raw: Buffer): Change[] {
  const fields = splitNul(raw); const changes: Change[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]; if (!entry.length) continue;
    if (entry.length < 4 || entry[2] !== 32) throw new GitError('无法识别 Git 状态输出。');
    const index = String.fromCharCode(entry[0]), worktree = String.fromCharCode(entry[1]);
    const path = decodePath(entry.subarray(3)); let original: string | undefined;
    if ('RC'.includes(index) || 'RC'.includes(worktree)) { const next = fields[++i]; if (!next?.length) throw new GitError('Git 重命名状态不完整。'); original = decodePath(next); }
    changes.push(new Change(index, worktree, path, original));
  }
  return changes;
}
export type GitConfigEntry = readonly [key: string, value: string];
export interface GitOptions { config?: Record<string, string>; orderedConfig?: readonly GitConfigEntry[]; env?: Record<string, string | undefined | null>; rejectEnv?: readonly string[] }
export interface GitRunOptions { check?: boolean; interactive?: boolean; captureStdout?: boolean; inputData?: Buffer }
export class Git {
  readonly directory: string; readonly overrides: Record<string, string>; readonly orderedConfig: readonly GitConfigEntry[]; readonly environment: Record<string, string | undefined | null>; readonly rejectedEnvironment: readonly string[];
  constructor(directory: string, options: GitOptions = {}) { if (/[\udc80-\udcff]/u.test(directory)) throw new GitError('项目目录包含不能无损传递的字节路径，已停止。'); const path = resolve(directory); this.directory = existsSync(path) ? realpathSync(path) : path; this.overrides = { ...options.config }; this.orderedConfig = (options.orderedConfig ?? []).map(([key, value]) => [key, value] as const); this.environment = { ...options.env }; this.rejectedEnvironment = [...options.rejectEnv ?? []]; }
  async run(args: readonly string[], options: GitRunOptions = {}): Promise<ProcessResult> {
    if (!which('git', process.env, this.directory)) throw new GitError('未找到 Git，请安装 Git for Windows 或发行版的 Git。');
    const env = { ...process.env }; const blocked: string[] = [];
    for (const key of Object.keys(env)) {
      const normalized = process.platform === 'win32' ? key.toUpperCase() : key;
      if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS'].includes(normalized) || normalized.startsWith('GIT_CONFIG_COUNT') || normalized.startsWith('GIT_CONFIG_KEY_') || normalized.startsWith('GIT_CONFIG_VALUE_') || this.rejectedEnvironment.includes(normalized) || this.rejectedEnvironment.includes('GIT_CONFIG_*') && normalized.startsWith('GIT_CONFIG_')) blocked.push(key);
    }
    if (blocked.length) throw new GitError(`检测到仓库/身份环境覆盖：${blocked.join('、')}，已停止（不显示值）。`);
    for (const [key, value] of Object.entries(this.environment)) {
      for (const existing of Object.keys(env)) if (existing === key || process.platform === 'win32' && existing.toUpperCase() === key.toUpperCase()) delete env[existing];
      if (value !== undefined && value !== null) env[key] = value;
    }
    env.GIT_LITERAL_PATHSPECS = '1';
    if (args.some((arg) => /[\udc80-\udcff]/u.test(arg)) || /[\udc80-\udcff]/u.test(this.directory)) throw new GitError('此命令参数无法无损传递特殊字节路径；已停止，未替换文件名。');
    const command = ['--no-pager', '-c', 'submodule.recurse=false', ...[...Object.entries(this.overrides), ...this.orderedConfig].flatMap(([key, value]) => ['-c', `${key}=${value}`]), ...args];
    let result: ProcessResult;
    try { result = await runProcess('git', command, { cwd: this.directory, env, interactive: options.interactive, captureStdout: options.captureStdout, inputData: options.inputData }); }
    catch (error) { if (error instanceof Cancelled) throw error; throw new GitError(`无法启动 Git：${redact(String(error))}`); }
    if (options.check !== false && result.status !== 0) { const detail = Git.output(result); throw new GitError(`${explain(detail)}\n${redact(detail).trim() || '请查看终端中的 Git 提示。'}`); }
    return result;
  }
  static output(result: ProcessResult): string { return Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]).toString('utf8'); }
  async value(...args: string[]): Promise<string> { return decodePath((await this.run(args)).stdout).trim(); }
  async config(key: string): Promise<string> { const result = await this.run(['config', '--get', key], { check: false }); return result.status === 0 ? decodePath(result.stdout).trim() : ''; }
  async root(): Promise<string> { const result = await this.run(['rev-parse', '--show-toplevel'], { check: false }); if (result.status) throw new GitError('当前目录还不是普通 Git 工作区。请选项目或使用“上传本地项目”初始化。'); return decodePath(result.stdout.subarray(0, result.stdout.length - (process.platform === 'win32' && result.stdout.at(-2) === 13 ? 2 : result.stdout.at(-1) === 10 ? 1 : 0))); }
  async repository(): Promise<Git> { return new Git(await this.root(), { config: this.overrides, orderedConfig: this.orderedConfig, env: this.environment, rejectEnv: this.rejectedEnvironment }); }
  configured(config: Record<string, string>): Git { return new Git(this.directory, { config: { ...this.overrides, ...config }, orderedConfig: this.orderedConfig, env: this.environment, rejectEnv: this.rejectedEnvironment }); }
  configuredOrdered(config: readonly GitConfigEntry[], options: Pick<GitOptions, 'env' | 'rejectEnv'> = {}): Git {
    return new Git(this.directory, { config: this.overrides, orderedConfig: [...this.orderedConfig, ...config], env: { ...this.environment, ...options.env }, rejectEnv: [...this.rejectedEnvironment, ...options.rejectEnv ?? []] });
  }
  async gitPath(marker: string): Promise<string> { const path = await this.value('rev-parse', '--git-path', marker); if (/[\udc80-\udcff]/u.test(path)) throw new GitError('Git 元数据目录包含不能无损访问的字节路径，已停止。'); return isAbsolute(path) ? path : join(this.directory, path); }
  async operation(): Promise<string> { for (const marker of ['rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'BISECT_LOG', 'MERGE_AUTOSTASH', 'MERGE_HEAD']) if (existsSync(await this.gitPath(marker))) return marker; return ''; }
  async unmerged(): Promise<string[]> { return [...new Set(splitNul((await this.run(['ls-files', '-u', '-z'])).stdout).filter((entry) => entry.length).map((entry) => decodePath(entry.subarray(entry.indexOf(9) + 1))))]; }
  async ensureSupported(): Promise<void> {
    // Ordinary operations update gitlink entries, not nested worktrees; recursion is not provided here.
    await this.run(['ls-files', '--stage', '-z']);
  }
  async stagePaths(paths: readonly string[]): Promise<void> { if (paths.length) await this.run(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { inputData: Buffer.concat([...new Set(paths)].flatMap((path) => [encodePath(path), Buffer.from([0])])) }); }
  async changes(): Promise<Change[]> { return parseStatus((await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout); }
  async branch(): Promise<string> { const result = await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { check: false }); if (result.status) throw new GitError('当前处于游离 HEAD；只读查看仍可使用，保存或传输前请使用外部 Git 切换到分支。'); return decodePath(result.stdout).trim(); }
  async hasCommits(): Promise<boolean> { return (await this.run(['rev-parse', '--verify', 'HEAD'], { check: false })).status === 0; }
  async remotes(): Promise<string[]> { const value = await this.value('remote'); return value ? value.split('\n') : []; }
  async remoteUrls(name: string, push = false): Promise<string[]> { const value = await this.value('remote', 'get-url', '--all', ...push ? ['--push'] : [], name); return value ? value.split('\n') : []; }
  async ensureReady(): Promise<void> { if (await this.operation()) throw new GitError('仓库有尚未完成的合并、变基或其他操作；请使用外部 Git 处理或完成该操作后重试。'); await this.branch(); if ((await this.changes()).some((change) => change.conflict)) throw new GitError('工作区存在冲突；请使用外部 Git 解决冲突后重试。'); await this.ensureSupported(); }
  async ensureIdentity(): Promise<void> { if (!await this.config('user.name') || !await this.config('user.email')) throw new GitError('缺少提交姓名或邮箱，请在软件中选择账号。'); }
}
