import * as path from 'node:path';
import { appDataDir } from './app-context.js';
import { Git, GitError } from './git.js';
import { Cancelled, type Console } from './ui.js';
import { currentSession } from './session.js';
import { checkedPath, exactKeys, MISSING, readJson, record, text, withStoreLock, writeJson } from './storage.js';

export type HostProvider = 'github' | 'github-enterprise' | 'generic';
export type TransportMode = 'managed-ssh' | 'native-ssh' | 'https';
export interface HostOptions {
  provider: HostProvider;
  host: string;
  apiHost: string;
  webBase: string;
  sshHost: string;
  sshPort?: number;
  sshUser?: string;
  sshAlias?: string;
}
export interface TransportTarget { mode: TransportMode; host: HostOptions; credentials?: 'external' }
export const DEFAULT_HOST: HostOptions = { provider: 'github', host: 'github.com', apiHost: 'api.github.com', webBase: 'https://github.com', sshHost: 'github.com' };
export const DEFAULT_TRANSPORT: TransportTarget = { mode: 'managed-ssh', host: DEFAULT_HOST };
const HOST_KEYS = ['provider', 'host', 'apiHost', 'webBase', 'sshHost'];
const OPTIONAL_KEYS = ['sshPort', 'sshUser', 'sshAlias'];

function hostname(value: unknown): string {
  const result = text(value);
  if (result.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(result) || result.includes('..')) throw new GitError('主机名无效；不能含协议、路径、凭据或选项。');
  return result;
}
function sshName(value: unknown): string {
  const result = text(value);
  if (result.length > 253 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(result) || result.includes('..')) throw new GitError('SSH endpoint 或 alias 无效；不能含协议、路径、凭据或选项。');
  return result;
}
export function validateTransport(value: unknown): TransportTarget {
  if (!record(value) || !['mode', 'host'].every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !['mode', 'host', 'credentials'].includes(key)) || !['managed-ssh', 'native-ssh', 'https'].includes(String(value.mode)) || !record(value.host) || Object.hasOwn(value, 'credentials') && (value.mode !== 'https' || value.credentials !== 'external')) throw new GitError('项目传输配置无效。');
  const host = value.host;
  if (!HOST_KEYS.every((key) => Object.hasOwn(host, key)) || Object.keys(host).some((key) => ![...HOST_KEYS, ...OPTIONAL_KEYS].includes(key)) || !['github', 'github-enterprise', 'generic'].includes(String(host.provider))) throw new GitError('主机配置结构无效。');
  if (value.mode === 'native-ssh' && host.provider === 'generic') sshName(host.host); else hostname(host.host);
  // HTTPS keeps the inactive native endpoint so switching modes does not lose it.
  if (value.mode === 'managed-ssh') hostname(host.sshHost); else sshName(host.sshHost);
  if (host.provider === 'generic' && host.apiHost === '') { /* No API provider for generic Git. */ } else hostname(host.apiHost);
  let web: URL;
  try { web = new URL(text(host.webBase)); } catch { throw new GitError('网页基础地址必须是 HTTPS URL。'); }
  if (web.protocol !== 'https:' || web.username || web.password || web.search || web.hash || web.port || web.hostname !== host.host || (web.pathname !== '/' && web.pathname.endsWith('/'))) throw new GitError('网页基础地址必须是同主机 HTTPS 地址，不能含凭据、查询或端口。');
  if (host.provider === 'github' && (host.host !== 'github.com' || host.apiHost !== 'api.github.com' || host.webBase !== 'https://github.com')) throw new GitError('非 github.com 请明确选择 GitHub Enterprise 或通用 Git。');
  if (host.sshPort !== undefined && (!Number.isInteger(host.sshPort) || Number(host.sshPort) < 1 || Number(host.sshPort) > 65535)) throw new GitError('SSH 端口必须是 1–65535。');
  if (host.sshUser !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(text(host.sshUser))) throw new GitError('SSH 用户名无效。');
  if (host.sshAlias !== undefined) sshName(host.sshAlias);
  return { mode: value.mode as TransportMode, host: { ...host } as unknown as HostOptions, ...(value.credentials === 'external' ? { credentials: 'external' as const } : {}) };
}
export async function projectRoot(directory: string): Promise<string> {
  const root = (await new Git(directory).root()).toString();
  return process.platform === 'win32' ? root.toLowerCase() : root;
}
function absoluteProject(value: unknown): string {
  const result = text(value);
  if (!(path.isAbsolute(result) || /^[A-Za-z]:[\\/]/u.test(result) || result.startsWith('\\\\')) || result.split(/[\\/]/u).includes('..')) throw new GitError('项目配置路径必须是明确的绝对路径。');
  return result;
}
export class HostStore {
  readonly directory: string;
  constructor(directory = appDataDir()) { this.directory = checkedPath(directory, 'dir', { missing: true }); }
  async all(): Promise<Record<string, TransportTarget>> {
    const data = await readJson(path.join(this.directory, 'hosts.json'));
    if (data === MISSING) return {};
    if (!record(data) || !exactKeys(data, ['schema_version', 'projects']) || data.schema_version !== 1 || !record(data.projects)) throw new GitError('hosts.json 结构或版本无效；未覆盖。');
    const projects: Record<string, TransportTarget> = Object.create(null) as Record<string, TransportTarget>;
    for (const [root, target] of Object.entries(data.projects)) projects[absoluteProject(root)] = validateTransport(target);
    return projects;
  }
  async get(directory: string): Promise<TransportTarget | undefined> {
    let root: string;
    try { root = await projectRoot(directory); } catch (error) { if (error instanceof GitError) return undefined; throw error; }
    return (await this.all())[root];
  }
  async set(directory: string, target: TransportTarget | undefined): Promise<void> {
    const root = await projectRoot(directory);
    if (target) validateTransport(target);
    await withStoreLock(this.directory, async () => {
      const projects = await this.all(); if (target) projects[root] = target; else delete projects[root];
      await writeJson(path.join(this.directory, 'hosts.json'), { schema_version: 1, projects });
    });
  }
}
export async function resolveTransport(directory: string): Promise<TransportTarget | undefined> { return new HostStore().get(directory); }
/** Per-command settings only: never rewrites the project's stored remote or external SSH config. */
export function transportGitConfig(targetValue: TransportTarget): Record<string, string> {
  const target = validateTransport(targetValue); const host = target.host; const config: Record<string, string> = {};
  if (target.mode === 'https') return config;
  if (target.mode === 'native-ssh' && (host.sshPort !== undefined || host.sshUser)) {
    config['core.sshCommand'] = ['ssh', ...(host.sshPort !== undefined ? ['-p', String(host.sshPort)] : []), ...(host.sshUser ? ['-l', host.sshUser] : [])].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(' ');
    config['ssh.variant'] = 'ssh';
  }
  return config;
}
export function transportUrl(repository: string, target: TransportTarget = DEFAULT_TRANSPORT): string {
  validateTransport(target);
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u.test(repository) || repository.split('/').some((part) => part === '.' || part === '..')) throw new GitError('仓库路径无效。');
  const repo = repository.endsWith('.git') ? repository : `${repository}.git`; const host = target.host;
  if (target.mode === 'https') return `${host.webBase}/${repo}`;
  const endpoint = target.mode === 'native-ssh' ? host.sshAlias ?? host.sshHost : host.sshHost;
  return host.sshPort ? `ssh://${host.sshUser ?? 'git'}@${endpoint}:${host.sshPort}/${repo}` : `${host.sshUser ?? 'git'}@${endpoint}:${repo}`;
}
export async function hostsMenu(ui: Console, directory: string): Promise<void> {
  const store = new HostStore();
  for (;;) {
    const current = await store.get(directory);
    ui.text(current ? `当前项目：${current.host.provider} / ${current.host.host} / ${current.mode}` : '当前项目未配置；默认 github.com 托管 SSH。');
    const choice = await ui.menu('项目主机与传输', ['配置主机 / SSH / HTTPS', '查看完整项目配置', '移除项目配置（恢复默认）']);
    if (!choice) return;
    try {
      if (choice === 2) { ui.text(JSON.stringify(current ?? DEFAULT_TRANSPORT, null, 2)); continue; }
      if (choice === 3) { if (await ui.confirm('移除当前项目的主机与传输配置？不修改 Git remote 或 SSH config。')) await store.set(directory, undefined); continue; }
      const provider = await ui.menu('服务提供方', ['GitHub.com', 'GitHub Enterprise（明确指定主机）', '通用 Git（含 GitLab 等；不提供 GitHub PR API）']); if (!provider) continue;
      const mode = await ui.menu('认证与传输模式', ['托管 SSH（软件密钥和独立 known_hosts）', '原生 SSH（外部管理：已有 SSH config、代理和跳板）', currentSession() ? 'HTTPS（本次加密库凭据助手，需绑定账号并录入 Token）' : 'HTTPS（旧版外部凭据助手）', 'HTTPS 外部管理（明确沿用现有凭据助手，不纳入加密库）']); if (!mode) continue;
      const rawHost = provider === 1 ? 'github.com' : await ui.ask('仓库网页主机（通用原生 SSH 可用 alias）', current?.host.host);
      const host = mode === 2 && provider === 3 ? sshName(rawHost) : hostname(rawHost);
      const providerValue = (['github', 'github-enterprise', 'generic'] as const)[provider - 1];
      const modeValue = (['managed-ssh', 'native-ssh', 'https', 'https'] as const)[mode - 1];
      const externalHttps = modeValue === 'https' && (!currentSession() || mode === 4);
      const previousHost = current?.host.provider === providerValue && current.host.host === host ? current.host : undefined;
      const apiHost = provider === 1 ? 'api.github.com' : provider === 2 ? hostname(await ui.ask('Enterprise API 主机（通常与网页相同）', host)) : '';
      const webBase = provider === 1 ? 'https://github.com' : await ui.ask('网页基础地址', `https://${host}`);
      let sshHost = previousHost?.sshHost ?? host;
      let port = previousHost?.sshPort === undefined ? '' : String(previousHost.sshPort);
      let user = previousHost?.sshUser ?? '';
      let alias = previousHost?.sshAlias ?? '';
      if (modeValue !== 'https') {
        const sshHostInput = await ui.ask('SSH endpoint 主机', sshHost);
        sshHost = modeValue === 'native-ssh' ? sshName(sshHostInput) : hostname(sshHostInput);
        port = await ui.ask('SSH 端口（空值沿用配置/默认）', '', { allowEmpty: true });
        user = await ui.ask('SSH 用户（空值沿用配置/默认 git）', '', { allowEmpty: true });
        if (modeValue === 'native-ssh') alias = await ui.ask('已有 SSH Host alias（可空，仅原生模式使用）', '', { allowEmpty: true });
      }
      const target = validateTransport({ mode: modeValue, ...(mode === 4 ? { credentials: 'external' } : {}), host: { provider: providerValue, host, apiHost, webBase, sshHost, ...(port ? { sshPort: /^\d+$/u.test(port) ? Number(port) : NaN } : {}), ...(user ? { sshUser: user } : {}), ...(alias ? { sshAlias: alias } : {}) } });
      await store.set(directory, target);
      ui.text(`已保存本项目配置；不会改写现有 remote。原生模式允许现有 Host / ProxyCommand / ProxyJump；配置的 alias 需用于远程地址。${modeValue === 'https' && !externalHttps ? 'HTTPS 仅使用当前加密库；请绑定账号并在“HTTPS / GitHub 凭据”录入 Token。' : '外部 SSH / HTTPS 缓存不纳入加密库，退出 AutoGit 不会清除它们。'}`);
    } catch (error) { if (error instanceof Cancelled) ui.text('已返回，未保存配置。'); else if (error instanceof GitError || error instanceof Error && 'code' in error) ui.text(`主机配置未完成：${error.message}`); else throw error; }
  }
}
