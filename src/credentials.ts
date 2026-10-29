/** Explicit token enrollment and per-session HTTPS credentials. Never reads external credential stores. */
import { isDeepStrictEqual } from 'node:util';
import { Git, GitError, type GitConfigEntry } from './git.js';
import { CredentialHelper, createCredentialDirectory } from './credential-helper.js';
import type { CredentialPin } from './credential-pin.js';
import * as fs from 'node:fs/promises';
import { currentSession, requireSession, type CredentialSession } from './session.js';
import type { Console } from './ui.js';

export function credentialHost(value: string): string {
  if (typeof value !== 'string' || value.length > 253 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u.test(value)) throw new GitError('凭据 host 必须是明确的 DNS 主机名，不含协议、路径或端口。');
  return value.toLowerCase();
}
function loginName(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u.test(value)) throw new GitError('Token 对应的账号登录名无效。');
  return value;
}
const validateHost = credentialHost;
const ghDirectories = new WeakMap<CredentialSession, Promise<string>>();
export function sessionGhDirectory(session: CredentialSession): Promise<string> {
  let pending = ghDirectories.get(session);
  if (!pending) {
    pending = createCredentialDirectory(session, 'gh-').then((directory) => { session.onClose(() => fs.rm(directory, { recursive: true, force: true })); return directory; });
    ghDirectories.set(session, pending); pending.catch(() => ghDirectories.delete(session));
  }
  return pending;
}

export function validateToken(value: Buffer): void {
  if (!Buffer.isBuffer(value) || !value.length || value.length > 4096 || value.some((byte) => byte < 0x21 || byte > 0x7e)) throw new GitError('Token 必须为非空、单行 ASCII 秘密，且不超过 4096 字节。');
}
export async function enrollToken(ui: Console, hostValue: string, accountValue: string): Promise<void> {
  const session = requireSession(), host = validateHost(hostValue), account = loginName(accountValue);
  ui.text(`将 Token 加密保存在本次 AutoGit 保险库：${host} / ${account}。不会读取或改变外部 gh/Git 登录，也不会调用真实 API 测试。`);
  const token = await ui.secret('Token（不回显）：');
  try { validateToken(token); if (session !== requireSession()) throw new GitError('凭据会话已变化，请重试。'); await session.storeToken(host, account, token); }
  finally { token.fill(0); }
}
export async function credentialsMenu(ui: Console, _directory: string, defaults: { host?: string; account?: string } = {}): Promise<void> {
  const session = requireSession();
  const host = validateHost(await ui.ask('HTTPS / GitHub host（不含协议、路径或端口）', defaults.host ?? 'github.com'));
  const account = loginName(await ui.ask('Token 对应的账号登录名', defaults.account ?? ''));
  await enrollToken(ui, host, account); if (session !== requireSession()) throw new GitError('凭据会话已变化，请重试。'); ui.text('Token 已加密保存；账号归属尚未联网验证，API 操作前仍会核对 actor。');
}

interface HttpsTarget { host: { host: string }; url?: string; pin?: CredentialPin }
interface Scope { host: string; path: string; account: string }
const helpers = new WeakMap<CredentialSession, Map<string, Promise<CredentialHelper>>>();
// A proof is an identity, not merely an account/scope: never reuse an unpinned or earlier proof's helper.
const pinnedHelpers = new WeakMap<CredentialPin, Map<string, Promise<CredentialHelper>>>();
function checkedScope(urlValue: string, host: string, account: string): Scope {
  let url: URL;
  try { url = new URL(urlValue); } catch { throw new GitError('HTTPS 凭据需要明确的仓库 URL。'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== host || url.port || url.username || url.password || url.search || url.hash || urlValue !== `https://${url.host}${url.pathname}` || !/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u.test(url.pathname) || url.pathname.slice(1).split('/').some((part) => part === '.' || part === '..')) throw new GitError('HTTPS 仓库地址必须与选定 host 一致，不能带用户名、密码、端口、编码路径或额外参数。');
  return { host, path: url.pathname.slice(1), account };
}
async function inferScope(git: Git, host: string, account: string, explicit?: string): Promise<Scope | undefined> {
  if (explicit !== undefined) return checkedScope(explicit, host, account);
  const remotes = await git.remotes(), scopes: Scope[] = [];
  for (const name of remotes) {
    for (const push of [false, true]) for (const url of await git.remoteUrls(name, push)) {
      if (!url.startsWith('https://')) continue;
      let parsed: URL; try { parsed = new URL(url); } catch { throw new GitError('仓库 HTTPS remote 无法安全解析。'); }
      if (parsed.hostname.toLowerCase() !== host) continue;
      const scope = checkedScope(url, host, account); if (!scopes.some((item) => isDeepStrictEqual(item, scope))) scopes.push(scope);
    }
  }
  return scopes.length === 1 ? scopes[0] : undefined;
}
async function helperFor(session: CredentialSession, scope: Scope, pin?: CredentialPin): Promise<CredentialHelper> {
  // Each map belongs to one session or one proof identity, never both.
  let byScope = pin ? pinnedHelpers.get(pin) : helpers.get(session);
  if (!byScope) {
    byScope = new Map();
    if (pin) {
      const owned = byScope;
      pin.onDispose(async () => { owned.clear(); pinnedHelpers.delete(pin); });
      pinnedHelpers.set(pin, byScope);
    } else helpers.set(session, byScope);
  }
  const key = JSON.stringify(scope); let helper = byScope.get(key);
  if (!helper) {
    helper = CredentialHelper.start({ session, host: scope.host, account: scope.account, repositoryPath: scope.path, pin }); byScope.set(key, helper);
    helper.catch(() => { byScope!.delete(key); });
  }
  return helper;
}
/** Returns command-only overrides; does not persist helper commands or rewrite remote URLs. */
export async function configureHttps(git: Git, profile: { github_login: string }, target: HttpsTarget): Promise<Git> {
  const session = requireSession(), host = validateHost(target.host.host), account = loginName(profile.github_login), pin = target.pin;
  if (pin && (pin.host !== host || pin.account.toLowerCase() !== account.toLowerCase())) throw new GitError('HTTPS 认证绑定的 host / actor 与选定账号不一致。');
  await pin?.assertCurrent();
  // An explicit, validated API URL is used verbatim, including its repository-path case.
  const scope = await inferScope(git, host, account, target.url);
  if (session !== currentSession() || session.closed) throw new GitError('HTTPS 凭据会话已关闭或变化。');
  if (pin && !scope) throw new GitError('HTTPS 认证绑定需要唯一、明确的仓库地址；不会回退到其他凭据。');
  const helper = scope ? await helperFor(session, scope, pin) : undefined;
  if (session !== currentSession() || session.closed) throw new GitError('HTTPS 凭据会话已关闭或变化。');
  await pin?.assertCurrent();
  const config: GitConfigEntry[] = [
    ['credential.helper', ''], ...(helper ? [['credential.helper', helper.command()] as const] : []),
    ['credential.useHttpPath', 'true'], ['credential.username', account], ['credential.interactive', 'false'],
    ['core.askPass', ''], ['http.followRedirects', 'false'], ['http.extraHeader', ''],
  ];
  return git.configuredOrdered(config, {
    env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: null, SSH_ASKPASS: null, SSH_ASKPASS_REQUIRE: null },
    rejectEnv: ['GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE', 'GIT_TRACE_CURL_NO_DATA', 'GCM_TRACE', 'GCM_TRACE_SECRETS'],
  });
}
