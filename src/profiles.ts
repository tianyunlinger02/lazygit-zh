import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { folderHelp } from './preferences.js';
import { Git, GitError } from './git.js';
import { runProcess, which } from './process.js';
import { Cancelled, type Console } from './ui.js';
import { currentSession, requireSession } from './session.js';
import { managedKeyMarker, parsePrivateKey } from './managed-keys.js';
import { configureHttps } from './credentials.js';
import {
  MISSING, checkedPath, exactKeys, isErrno, location, mkdirPrivate, readJson, record,
  setMode, text, withStoreLock, writeJson,
} from './storage.js';
import { appDataDir } from './app-context.js';
import { DEFAULT_TRANSPORT, HostStore, resolveTransport, transportGitConfig, validateTransport, type TransportTarget } from './hosts.js';

export { appDataDir } from './app-context.js';
export const SCHEMA_VERSION = 2;
export const IDENTITY_ENV = ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const;
export const REJECT_ENV = [...IDENTITY_ENV, 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'] as const;
export const STATUS_LABELS = { unverified: '未验证', verified: '用户曾确认成功' } as const;
const PROFILE_KEYS = ['profile_id', 'label', 'name', 'email', 'github_login', 'private_key', 'public_key', 'ssh_program', 'status', 'remember_auth'] as const;
const SNAPSHOT_KEYS = ['profile_id', 'label', 'name', 'email', 'github_login', 'private_key', 'public_key'] as const;
const PROFILE_ID = /^[0-9a-f]{32}$/u;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/u;

export type ProcessResult = { status: number; stdout: Buffer; stderr: Buffer };
export type ProcessRunner = (program: string, args: string[], options?: Record<string, unknown>) => Promise<ProcessResult>;
export interface ProfileStoreOptions { runProcess?: ProcessRunner; which?: (program: string) => string | undefined; transport?: TransportTarget }

export class Profile {
  profile_id: string;
  label: string;
  name: string;
  email: string;
  github_login: string;
  private_key: string;
  public_key: string;
  ssh_program: string;
  status: 'unverified' | 'verified';
  remember_auth: boolean;
  constructor(values: {
    profile_id: string; label: string; name: string; email: string; github_login: string;
    private_key: string; public_key: string; ssh_program?: string; status?: 'unverified' | 'verified'; remember_auth?: boolean;
  }) {
    this.profile_id = values.profile_id; this.label = values.label; this.name = values.name; this.email = values.email;
    this.github_login = values.github_login; this.private_key = values.private_key; this.public_key = values.public_key;
    this.ssh_program = values.ssh_program ?? ''; this.status = values.status ?? 'unverified'; this.remember_auth = values.remember_auth ?? false;
  }
}

function isWindowsPath(value: string): boolean { return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\'); }
function rootKey(directory: string): string { const resolved = path.resolve(directory); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
function id(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE_ID.test(value)) throw new GitError('账号标识无效。');
  return value;
}
function safeText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || CONTROL.test(value)) throw new GitError('字段不能为空或包含控制字符。');
  return value;
}
function asProfile(value: Profile | Record<string, unknown>): Profile {
  if (value instanceof Profile) return value;
  if (!record(value)) throw new GitError('账号参数无效。');
  try { return new Profile(value as unknown as ConstructorParameters<typeof Profile>[0]); }
  catch (error) { throw new GitError('账号参数无效。', { cause: error }); }
}
function quoteShell(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function normalizePath(value: string): string { return process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value; }
async function displayPublicKey(ui: Console, file: string): Promise<void> {
  if (!file.endsWith('.pub')) { ui.text('只接受 .pub 公钥文件；不会打开私钥。'); return; }
  checkedPath(file, 'file');
  if ((await fsp.stat(file)).size > 65_536) { ui.text('文件过大，不作为 SSH 公钥读取。'); return; }
  const value = (await fsp.readFile(file, 'utf8')).trim();
  if (CONTROL.test(value) || !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/u.test(value)) { ui.text('文件不是支持的单行 OpenSSH 公钥，已停止，不显示其内容。'); return; }
  ui.text('下面是完整 SSH 公钥，不是私钥；可复制到 GitHub。绝不要分享没有 .pub 后缀的私钥。'); ui.text(value); ui.text('请手工访问 https://github.com/settings/keys，添加此公钥用于认证。'); ui.text('AutoGit 会为绑定项目自动选用这把密钥。');
}

function profileKeyArgs(profile: Profile, storeDirectory: string, whichFn: (program: string) => string | undefined, target: TransportTarget = DEFAULT_TRANSPORT): string[] {
  validateTransport(target);
  if (target.mode === 'https') throw new GitError('HTTPS 模式不使用 SSH 参数。');
  if (target.mode === 'native-ssh') {
    const args = [programPath('ssh', '', whichFn)];
    if (target.host.sshPort !== undefined) args.push('-p', String(target.host.sshPort));
    if (target.host.sshUser) args.push('-l', target.host.sshUser);
    return args;
  }
  const privateKey = checkedPath(currentSession() ? profile.public_key : profile.private_key, 'file');
  const expectedParent = path.join(storeDirectory, 'profiles', id(profile.profile_id));
  if (path.dirname(privateKey) !== expectedParent) throw new GitError('私钥不在该账号的托管目录。');
  const known = checkedPath(path.join(storeDirectory, 'known_hosts'), 'file');
  const ssh = programPath('ssh', profile.ssh_program, whichFn);
  const values = [ssh, privateKey, known].map((value) => process.platform === 'win32' ? value.replaceAll('\\', '/') : value);
  const args = [values[0], '-F', 'none', '-i', values[1]];
  const session = currentSession();
  if (session) {
    if (path.resolve(session.vault.directory) !== path.resolve(storeDirectory)) throw new GitError('此账号不属于当前解锁的凭据库。');
    const endpoint = session.agentEndpoint(profile.profile_id);
    if (!endpoint) throw new GitError('此账号的本次 SSH 会话尚未解锁。');
    args.push('-o', `IdentityAgent="${endpoint.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`);
  }
  args.push('-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile="${values[2]}"`, '-o', 'GlobalKnownHostsFile=none', '-o', 'StrictHostKeyChecking=ask');
  if (target.host.sshPort !== undefined) args.push('-p', String(target.host.sshPort));
  if (target.host.sshUser) args.push('-l', target.host.sshUser);
  return args;
}
function programPath(name: string, custom: string, whichFn: (program: string) => string | undefined): string {
  let found: string | undefined;
  if (custom) {
    const candidate = location(custom);
    try { checkedPath(candidate, 'file'); }
    catch (error) { if (!fs.existsSync(candidate)) throw new GitError('指定的 SSH 程序已缺失；请恢复该程序或重新导入账号以使用当前系统 SSH。', { cause: error }); throw error; }
    found = candidate;
  } else {
    const system = whichFn(name);
    if (!system) throw new GitError(`未找到 ${name}。`);
    found = checkedPath(fs.realpathSync.native(system), 'file');
  }
  return found;
}

export function buildSshArgs(profileValue: Profile, directory?: string, whichFn = which, target: TransportTarget = DEFAULT_TRANSPORT): string[] {
  const profile = asProfile(profileValue);
  const storeDirectory = directory ?? path.dirname(path.dirname(path.dirname(profile.private_key)));
  return profileKeyArgs(profile, storeDirectory, whichFn, target);
}
export function build_ssh_command(profileValue: Profile, directory?: string, whichFn = which, target: TransportTarget = DEFAULT_TRANSPORT): string {
  return buildSshArgs(profileValue, directory, whichFn, target).map(quoteShell).join(' ');
}
export const buildSshCommand = build_ssh_command;

function checkEnvironment(): void {
  const blocked = Object.keys(process.env).filter((key) => { const normalized = process.platform === 'win32' ? key.toUpperCase() : key; return (REJECT_ENV as readonly string[]).includes(normalized) || normalized.startsWith('GIT_CONFIG_KEY_') || normalized.startsWith('GIT_CONFIG_VALUE_'); });
  if (blocked.length) throw new GitError(`检测到账号环境覆盖（不显示值），请先移除：${blocked.join('、')}`);
}

async function validateSsh(profileValue: Profile, directory: string, runner: ProcessRunner, whichFn: (program: string) => string | undefined, target: TransportTarget = DEFAULT_TRANSPORT): Promise<void> {
  validateTransport(target);
  if (target.mode !== 'managed-ssh') return;
  const profile = asProfile(profileValue);
  if (currentSession()) await requireSession().sshAgent(profile.profile_id);
  const args = buildSshArgs(profileValue, directory, whichFn, target);
  const result = await runner(args[0], args.slice(1).concat(['-G', `${target.host.sshUser ?? 'git'}@${target.host.sshHost}`]), { cwd: directory, interactive: false, check: false });
  const settings = new Map<string, string[]>();
  for (const line of result.stdout.toString('utf8').split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf(' ');
    const key = (separator < 0 ? line : line.slice(0, separator)).toLowerCase();
    const value = separator < 0 ? '' : line.slice(separator + 1).trim();
    settings.set(key, [...(settings.get(key) ?? []), value]);
  }
  const expected: Record<string, string[]> = {
    identitiesonly: ['yes'], identityfile: [normalizePath(args[args.indexOf('-i') + 1])],
    userknownhostsfile: [normalizePath(path.join(directory, 'known_hosts'))], globalknownhostsfile: ['none'], stricthostkeychecking: ['ask'],
  };
  const okay = result.status === 0 && Object.entries(expected).every(([key, values]) => (settings.get(key) ?? []).map(normalizePath).join('\u0000') === values.map(normalizePath).join('\u0000'));
  if (!okay) throw new GitError('SSH 不支持单密钥、独立 known_hosts 和严格主机校验的受控模式；请使用兼容 OpenSSH。');
}

export async function profileGit(directory: string, profileValue: Profile, transport?: TransportTarget, url?: string): Promise<Git> {
  checkEnvironment();
  const profile = asProfile(profileValue);
  const storeDirectory = path.dirname(path.dirname(path.dirname(profile.private_key)));
  const session = currentSession();
  if (session && rootKey(session.vault.directory) !== rootKey(storeDirectory)) throw new GitError('此账号不属于当前解锁的凭据库。');
  const target = transport ? validateTransport(transport) : (await new HostStore(storeDirectory).get(directory)) ?? DEFAULT_TRANSPORT;
  if (session && target.mode === 'managed-ssh') await session.sshAgent(profile.profile_id);
  await validateSsh(profile, storeDirectory, runProcess as unknown as ProcessRunner, which, target);
  const config: Record<string, string> = {
    'user.name': safeText(profile.name), 'user.email': safeText(profile.email),
    'author.name': safeText(profile.name), 'author.email': safeText(profile.email),
    'committer.name': safeText(profile.name), 'committer.email': safeText(profile.email),
  };
  if (target.mode !== 'https' && target.mode !== 'native-ssh') {
    config['core.sshCommand'] = build_ssh_command(profile, storeDirectory, which, target); config['ssh.variant'] = 'ssh';
  }
  if (target.mode === 'native-ssh' && (target.host.sshPort !== undefined || target.host.sshUser)) {
    config['core.sshCommand'] = build_ssh_command(profile, storeDirectory, which, target); config['ssh.variant'] = 'ssh';
  }
  const env: Record<string, undefined> = {};
  for (const key of IDENTITY_ENV) env[key] = undefined;
  const git = new Git(directory, { config, env, rejectEnv: REJECT_ENV });
  if (!session || target.credentials === 'external') return git;
  return target.mode === 'https' ? configureHttps(git, profile, { host: target.host, url }) : withoutExternalCredentials(git);
}

export class ProfileStore {
  readonly directory: string;
  readonly profiles_dir: string;
  readonly bindings_file: string;
  readonly runProcess: ProcessRunner;
  readonly which: (program: string) => string | undefined;
  constructor(directory = appDataDir(), options: ProfileStoreOptions = {}) {
    this.directory = checkedPath(directory, 'dir', { missing: true });
    this.profiles_dir = path.join(this.directory, 'profiles');
    this.bindings_file = path.join(this.directory, 'bindings.json');
    this.runProcess = options.runProcess ?? (runProcess as unknown as ProcessRunner);
    this.which = options.which ?? which;
  }
  get profilesDir(): string { return this.profiles_dir; }
  get bindingsFile(): string { return this.bindings_file; }

  private validate(profileValue: Profile, files: boolean): Profile {
    const profile = asProfile(profileValue);
    for (const field of ['label', 'name', 'email', 'github_login', 'status']) safeText(profile[field as keyof Profile]);
    if (profile.status !== 'unverified' && profile.status !== 'verified' || typeof profile.remember_auth !== 'boolean' || !LOGIN.test(profile.github_login)) throw new GitError('账号状态、记住认证标志或 GitHub 登录名无效。');
    const parent = path.join(this.profiles_dir, id(profile.profile_id));
    for (const value of [profile.private_key, profile.public_key]) {
      const candidate = files ? checkedPath(value, 'file') : location(value);
      if (path.dirname(candidate) !== parent || path.basename(candidate) === 'profile.json') throw new GitError('密钥必须位于该账号的托管目录。');
    }
    if (profile.private_key === profile.public_key || !profile.public_key.endsWith('.pub') || profile.private_key.toLowerCase().endsWith('.pub')) throw new GitError('私钥/公钥路径无效。');
    if (typeof profile.ssh_program !== 'string') throw new GitError('SSH 程序路径无效。');
    if (profile.ssh_program) {
      safeText(profile.ssh_program);
      if (!(path.posix.isAbsolute(profile.ssh_program) || isWindowsPath(profile.ssh_program)) || /["%]/u.test(profile.ssh_program) || profile.ssh_program.split(/[\\/]/u).includes('..')) throw new GitError('自定义 SSH 程序必须是无双引号、百分号的绝对路径。');
      if (files) programPath('ssh', profile.ssh_program, this.which);
    }
    return profile;
  }
  encode_profile(profileValue: Profile): Record<string, unknown> {
    const profile = this.validate(asProfile(profileValue), false);
    const data: Record<string, unknown> = { schema_version: SCHEMA_VERSION };
    for (const key of PROFILE_KEYS) data[key] = profile[key];
    for (const key of ['private_key', 'public_key'] as const) data[key] = path.relative(this.directory, profile[key]).split(path.sep).join('/');
    return data;
  }
  encodeProfile(profile: Profile): Record<string, unknown> { return this.encode_profile(profile); }
  decode_profile(data: unknown, profileId?: string, files = true): Profile {
    if (record(data) && data.schema_version === 1) throw new GitError('旧版 schema 1 包含绝对路径，请先备份并手工迁移到便携 schema 2；不会自动扫描 HOME 或覆盖旧数据。');
    if (!record(data) || data.schema_version !== SCHEMA_VERSION || !exactKeys(data, ['schema_version', ...PROFILE_KEYS])) throw new GitError('元数据结构或版本号无效。');
    if (typeof data.ssh_program !== 'string' || typeof data.remember_auth !== 'boolean' || (data.status !== 'unverified' && data.status !== 'verified')) throw new GitError('账号状态、记住认证标志或 SSH 程序无效。');
    const values = { ...data } as Record<string, unknown>; delete values.schema_version;
    const profile = new Profile(values as unknown as ConstructorParameters<typeof Profile>[0]);
    if (id(profile.profile_id) !== id(profileId ?? profile.profile_id)) throw new GitError('账号标识不匹配。');
    for (const key of ['private_key', 'public_key'] as const) {
      const value = safeText(profile[key]);
      const parts = value.split('/');
      if (value.includes('\\') || value.includes(':') || path.posix.isAbsolute(value) || parts.includes('..') || parts.includes('.') || parts.length !== 3 || parts[0] !== 'profiles' || parts[1] !== profile.profile_id) throw new GitError('磁盘密钥路径必须是 profiles/账号标识/文件名，不能越界。');
      profile[key] = path.join(this.directory, ...parts);
    }
    return this.validate(profile, files);
  }
  decodeProfile(data: unknown, profileId?: string, files = true): Profile { return this.decode_profile(data, profileId, files); }
  snapshot(profileValue: Profile): Record<string, unknown> {
    const data = this.encode_profile(profileValue);
    for (const key of ['ssh_program', 'status', 'remember_auth']) delete data[key];
    return data;
  }
  private schema(data: unknown): Record<string, unknown> {
    if (record(data) && data.schema_version === 1) throw new GitError('账号绑定使用 schema 1，包含不可移植的绝对路径；请手工迁移，未自动扫描 HOME。');
    if (!record(data) || data.schema_version !== SCHEMA_VERSION) throw new GitError('元数据结构或版本号无效。');
    return data;
  }
  private async bindings(): Promise<Record<string, { profile_id: string; snapshot: Record<string, unknown> }>> {
    const data = await readJson(this.bindings_file);
    if (data === MISSING) return {};
    const value = this.schema(data);
    if (!exactKeys(value, ['schema_version', 'bindings']) || !record(value.bindings)) throw new GitError('绑定文件结构无效。');
    for (const [root, item] of Object.entries(value.bindings)) {
      if (!root.trim() || CONTROL.test(root) || !(path.isAbsolute(root) || isWindowsPath(root)) || root.split(/[\\/]/u).includes('..') || !record(item) || !exactKeys(item, ['profile_id', 'snapshot']) || !record(item.snapshot) || !exactKeys(item.snapshot, ['schema_version', ...SNAPSHOT_KEYS])) throw new GitError('项目绑定损坏。');
      const snapshot = item.snapshot;
      this.decode_profile({ ...snapshot, ssh_program: '', status: 'unverified', remember_auth: false }, id(item.profile_id), false);
    }
    return value.bindings as Record<string, { profile_id: string; snapshot: Record<string, unknown> }>;
  }
  private async saveBindings(bindings: Record<string, { profile_id: string; snapshot: Record<string, unknown> }>): Promise<void> {
    await writeJson(this.bindings_file, { schema_version: SCHEMA_VERSION, bindings });
  }
  async load(profileId: string, files = true): Promise<Profile> {
    const value = await readJson(path.join(this.profiles_dir, id(profileId), 'profile.json'));
    if (value === MISSING) throw new GitError('账号元数据不存在。');
    return this.decode_profile(value, profileId, files);
  }
  async list(): Promise<Profile[]> {
    const profiles: Profile[] = []; const labels = new Set<string>();
    checkedPath(this.profiles_dir, 'dir', { missing: true });
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(this.profiles_dir, { withFileTypes: true }); }
    catch (error) { if (isErrno(error, 'ENOENT')) return profiles; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const folder = path.join(this.profiles_dir, entry.name); checkedPath(folder, 'dir'); id(entry.name);
      const value = await readJson(path.join(folder, 'profile.json')); if (value === MISSING) continue;
      const profile = this.decode_profile(value, entry.name, false);
      const label = process.platform === 'win32' ? profile.label.toLowerCase() : profile.label;
      if (labels.has(label)) throw new GitError('存在重复账号标签。'); labels.add(label); profiles.push(profile);
    }
    return profiles;
  }
  async create(ui: Console, label: string, name: string, email: string, githubLogin: string, options: { source?: string; ssh_program?: string; sshProgram?: string; remember_auth?: boolean; rememberAuth?: boolean } = {}): Promise<Profile | undefined> {
    for (const value of [label, name, email, githubLogin]) safeText(value);
    if (currentSession()) return this.createEncrypted(ui, label, name, email, githubLogin, options.source);
    const remember = options.remember_auth ?? options.rememberAuth ?? false;
    if (typeof remember !== 'boolean' || !LOGIN.test(githubLogin)) throw new GitError('记住认证标志或 GitHub 登录名无效。');
    const sshProgram = options.ssh_program ?? options.sshProgram ?? '';
    programPath('ssh', sshProgram, this.which);
    const keygen = programPath('ssh-keygen', '', this.which);
    const original = options.source === undefined ? undefined : checkedPath(options.source, 'file');
    if (original?.toLowerCase().endsWith('.pub')) throw new GitError('导入源必须是私钥，不能是 .pub 文件。');
    if (this.runProcess === (runProcess as unknown as ProcessRunner) && !process.stdin.isTTY) {
      const terminalError = (): never => { throw new GitError('此密钥操作需要原生口令交互；请在真实终端运行，不要通过管道输入口令。AutoGit 不接收或保存口令。'); };
      if (!original && !remember) terminalError();
      if (original) {
        // An empty, fixed old passphrase is only an offline capability probe. It never reads input.
        const probe = await this.runProcess(keygen, ['-y', '-P', '', '-f', original], { cwd: path.dirname(original), interactive: false, inputData: Buffer.alloc(0), check: false });
        if (probe.status) terminalError();
      }
    }
    ui.text(remember ? '账号保存在软件 data 文件夹。记住认证使用无口令私钥；不会保存口令，外部原件不变。' : '口令由原生 ssh-keygen 终端处理，AutoGit 不接收或保存口令。');
    if (!(await ui.routineConfirm(original ? '确认复制已有私钥到 AutoGit？' : '确认生成新 Ed25519 密钥（不覆盖）？'))) return undefined;
    return withStoreLock(this.directory, async () => {
      const existing = await this.list(); const compare = process.platform === 'win32' ? label.toLowerCase() : label;
      if (existing.some((profile) => (process.platform === 'win32' ? profile.label.toLowerCase() : profile.label) === compare)) throw new GitError('账号标签重复。');
      await mkdirPrivate(this.profiles_dir);
      const profileId = crypto.randomBytes(16).toString('hex'); const folder = path.join(this.profiles_dir, profileId);
      await fsp.mkdir(folder, { mode: 0o700 }); await setMode(folder, 0o700);
      const privateKey = path.join(folder, 'id_ed25519'); const publicKey = `${privateKey}.pub`;
      let status = -1;
      try {
        if (original) {
          const sourceStat = await fsp.lstat(original); if (!sourceStat.isFile() || sourceStat.nlink !== 1) throw new GitError('导入源不是普通文件。');
          const handle = await fsp.open(privateKey, 'wx', 0o600); await handle.close(); await fsp.copyFile(original, privateKey); await setMode(privateKey, 0o600);
          if (remember) {
            status = (await this.runProcess(keygen, ['-p', '-f', privateKey, '-N', ''], { cwd: folder, interactive: true, check: false })).status;
            if (status) throw new GitError('ssh-keygen 未完成；托管文件已保留，不自动重试或删除。');
          }
          const result = await this.runProcess(keygen, ['-y', '-f', privateKey], { cwd: folder, interactive: true, captureStdout: true, check: false });
          status = result.status;
          if (!status) { const pub = result.stdout; const handlePub = await fsp.open(publicKey, 'wx', 0o600); try { await handlePub.writeFile(pub); await handlePub.sync(); } finally { await handlePub.close(); } }
        } else {
          const args = ['-t', 'ed25519', '-f', privateKey, '-C', 'AutoGit']; if (remember) args.push('-N', '');
          status = (await this.runProcess(keygen, args, { cwd: folder, interactive: true, check: false })).status;
        }
      } finally { if (fs.existsSync(privateKey)) await setMode(privateKey, 0o600); if (fs.existsSync(publicKey)) await setMode(publicKey, 0o600); }
      if (status) throw new GitError('ssh-keygen 未完成；托管文件已保留，不自动重试或删除。');
      const profile = this.validate(new Profile({ profile_id: profileId, label, name, email, github_login: githubLogin, private_key: privateKey, public_key: publicKey, ssh_program: sshProgram, remember_auth: remember }), true);
      const known = path.join(this.directory, 'known_hosts');
      checkedPath(known, 'file', { missing: true });
      try { const handle = await fsp.open(known, 'wx', 0o600); await handle.close(); } catch (error) { if (!isErrno(error, 'EEXIST')) throw error; }
      checkedPath(known, 'file'); await setMode(known, 0o600);
      await writeJson(path.join(folder, 'profile.json'), this.encode_profile(profile));
      return profile;
    });
  }
  private async createEncrypted(ui: Console, label: string, name: string, email: string, githubLogin: string, source?: string): Promise<Profile | undefined> {
    const session = requireSession();
    if (path.resolve(session.vault.directory) !== path.resolve(this.directory) || !LOGIN.test(githubLogin)) throw new GitError('账号身份或解锁的资料目录不匹配。');
    if (source?.toLowerCase().endsWith('.pub')) throw new GitError('导入源必须是私钥，不能是 .pub 文件。');
    ui.text('私钥将在内存中生成/导入并加密保存；本次登录后复用，不生成免口令明文副本。');
    if (!(await ui.routineConfirm(source ? '确认将这把私钥加密导入 AutoGit？外部原件保持不变。' : '确认生成并加密保存新 Ed25519 密钥？'))) return undefined;
    const existing = await this.list(); const compare = process.platform === 'win32' ? label.toLowerCase() : label;
    if (existing.some((profile) => (process.platform === 'win32' ? profile.label.toLowerCase() : profile.label) === compare)) throw new GitError('账号标签重复。');
    const profileId = crypto.randomBytes(16).toString('hex'); const folder = path.join(this.profiles_dir, profileId);
    const parsed = await parsePrivateKey(ui, source);
    try {
      await session.storeSsh(profileId, parsed.privateKey);
      return await withStoreLock(this.directory, async () => {
        if ((await this.list()).some((profile) => (process.platform === 'win32' ? profile.label.toLowerCase() : profile.label) === compare)) throw new GitError('账号标签重复。');
        await mkdirPrivate(this.profiles_dir); await fsp.mkdir(folder, { mode: 0o700 });
        const privateKey = path.join(folder, 'id_ed25519'); const publicKey = `${privateKey}.pub`;
        await fsp.writeFile(privateKey, managedKeyMarker(profileId), { flag: 'wx', mode: 0o600 });
        await fsp.writeFile(publicKey, parsed.publicKey, { flag: 'wx', mode: 0o600 });
        const known = path.join(this.directory, 'known_hosts'); checkedPath(known, 'file', { missing: true });
        try { await fsp.writeFile(known, '', { flag: 'wx', mode: 0o600 }); } catch (error) { if (!isErrno(error, 'EEXIST')) throw error; }
        const profile = new Profile({ profile_id: profileId, label, name, email, github_login: githubLogin, private_key: privateKey, public_key: publicKey, remember_auth: true });
        await writeJson(path.join(folder, 'profile.json'), this.encode_profile(profile)); return profile;
      });
    } finally { parsed.privateKey.fill(0); }
  }
  async bind(directory: string, profileId: string, transport?: TransportTarget): Promise<Profile> {
    const root = rootKey(await new Git(directory).root());
    const target = transport ?? (await new HostStore(this.directory).get(directory)) ?? DEFAULT_TRANSPORT;
    return withStoreLock(this.directory, async () => {
      const profile = await this.load(profileId, target.mode === 'managed-ssh'); await validateSsh(profile, this.directory, this.runProcess, this.which, target);
      const bindings = await this.bindings(); bindings[root] = { profile_id: profile.profile_id, snapshot: this.snapshot(profile) }; await this.saveBindings(bindings); return profile;
    });
  }
  async unbind(directory: string): Promise<void> {
    const git = new Git(directory); const root = rootKey(await git.root());
    await withStoreLock(this.directory, async () => { const bindings = await this.bindings(); delete bindings[root]; await this.saveBindings(bindings); });
  }
  async validateMetadata(): Promise<void> {
    const profiles = await this.list();
    await this.bindings();
    for (const profile of profiles) { checkedPath(profile.private_key, 'file'); checkedPath(profile.public_key, 'file'); }
  }
  async remapBinding(oldDirectory: string, nextDirectory: string): Promise<void> {
    const oldRoot = rootKey(oldDirectory); const nextRoot = rootKey(await new Git(nextDirectory).root());
    if (oldRoot === nextRoot) throw new GitError('新旧项目路径相同。');
    await withStoreLock(this.directory, async () => {
      const bindings = await this.bindings(); const item = bindings[oldRoot];
      if (!item) throw new GitError('没有与旧绝对路径匹配的账号绑定；不会按同名猜测。');
      if (bindings[nextRoot]) throw new GitError('新项目路径已有账号绑定；不会覆盖。');
      delete bindings[oldRoot]; bindings[nextRoot] = item; await this.saveBindings(bindings);
    });
  }
  async resolve_binding(directory: string): Promise<Profile | undefined> {
    let root: string; try { root = rootKey((await new Git(directory).root()) as unknown as string); } catch (error) { if (error instanceof GitError) return undefined; throw error; }
    const bindings = await this.bindings(); const item = bindings[root]; if (!item) return undefined;
    const target = await new HostStore(this.directory).get(directory);
    const profile = await this.load(item.profile_id, !target || target.mode === 'managed-ssh'); if (!isDeepStrictEqual(this.snapshot(profile), item.snapshot)) throw new GitError('当前绑定快照已过期，请明确重新绑定账号。'); return profile;
  }
  async resolveBinding(directory: string): Promise<Profile | undefined> { return this.resolve_binding(directory); }
  async edit(ui: Console, profileId: string): Promise<Profile | undefined> {
    return withStoreLock(this.directory, async () => {
      const old = await this.load(profileId, false); const bindings = await this.bindings(); const roots = Object.entries(bindings).filter(([, item]) => item.profile_id === profileId).map(([root]) => root);
      const values = [await ui.ask('账号标签', old.label), await ui.ask('提交姓名', old.name), await ui.ask('提交邮箱', old.email), await ui.ask('预期 GitHub 登录名', old.github_login)];
      const updated = this.validate(new Profile({ ...old, label: values[0], name: values[1], email: values[2], github_login: values[3] }), false);
      const compare = process.platform === 'win32' ? updated.label.toLowerCase() : updated.label; const all = await this.list(); if (all.some((item) => item.profile_id !== profileId && (process.platform === 'win32' ? item.label.toLowerCase() : item.label) === compare)) throw new GitError('账号标签重复。');
      if (isDeepStrictEqual(updated, old)) return old;
      const identityChanged = updated.name !== old.name || updated.email !== old.email || updated.github_login !== old.github_login;
      const oldSnapshot = this.snapshot(old);
      // A label is display metadata; only bindings with the same identity may follow its change.
      const refreshRoots = identityChanged ? [] : roots.filter((root) => isDeepStrictEqual({ ...bindings[root].snapshot, label: oldSnapshot.label }, oldSnapshot));
      if (identityChanged && roots.length) ui.text(`提交署名或预期 GitHub 登录名已变化；保存后解除以下项目绑定，请重新绑定账号：\n${roots.join('\n')}`);
      else if (roots.length) ui.text('仅更新账号标签，保留项目绑定并同步身份一致的标签快照；身份快照已过期的绑定仍需明确重新绑定。');
      if (!(await ui.routineConfirm('确认保存账号编辑？'))) return undefined;
      await writeJson(path.join(this.profiles_dir, profileId, 'profile.json'), this.encode_profile(updated));
      if (identityChanged && roots.length) await this.saveBindings(Object.fromEntries(Object.entries(bindings).filter(([root]) => !roots.includes(root))));
      else if (refreshRoots.length) {
        const snapshot = this.snapshot(updated);
        for (const root of refreshRoots) bindings[root] = { ...bindings[root], snapshot };
        await this.saveBindings(bindings);
      }
      return updated;
    });
  }
  async change_auth(ui: Console, profileId: string, remember: boolean): Promise<Profile | undefined> {
    if (currentSession()) {
      const profile = await this.load(profileId);
      ui.text('此账号由加密凭据库统一管理；每次启动输入 AutoGit 解锁密码，不再通过移除私钥口令记住认证。');
      return profile;
    }
    if (typeof remember !== 'boolean') throw new GitError('记住认证标志无效。');
    if (!remember && this.runProcess === (runProcess as unknown as ProcessRunner) && !process.stdin.isTTY) throw new GitError('设置新私钥口令需要原生交互终端；请在真实终端运行，不要通过管道输入口令。');
    return withStoreLock(this.directory, async () => {
      const profile = await this.load(profileId); ui.text(remember ? '将移除托管副本的口令，持有 data 文件夹即可使用密钥。' : '由原生工具设置新口令；仍可输入空口令，取消记住不代表已加密。');
      if (!(await ui.routineConfirm('确认更改托管私钥的口令设置？'))) return undefined;
      const keygen = programPath('ssh-keygen', '', this.which);
      if (this.runProcess === (runProcess as unknown as ProcessRunner) && !process.stdin.isTTY) {
        const probe = await this.runProcess(keygen, ['-y', '-P', '', '-f', profile.private_key], { cwd: path.dirname(profile.private_key), interactive: false, inputData: Buffer.alloc(0), check: false });
        if (probe.status) throw new GitError('移除已有私钥口令需要原生交互终端；请在真实终端运行，不要通过管道输入口令。');
      }
      const args = ['-p', '-f', profile.private_key]; if (remember) args.push('-N', '');
      const result = await this.runProcess(keygen, args, { cwd: path.dirname(profile.private_key), interactive: true, check: false }); if (result.status) throw new GitError('口令操作未完成；没有更新记住认证标志。');
      await setMode(checkedPath(profile.private_key, 'file'), 0o600);
      const updated = new Profile({ ...profile, remember_auth: remember }); await writeJson(path.join(this.profiles_dir, profileId, 'profile.json'), this.encode_profile(updated)); return updated;
    });
  }
  async delete(ui: Console, profileId: string): Promise<boolean> {
    let removeSecret = false;
    const removed = await withStoreLock(this.directory, async () => {
      const profile = await this.load(profileId, false); const bindings = await this.bindings(); const roots = Object.entries(bindings).filter(([, item]) => item.profile_id === profileId).map(([root]) => root);
      const action = await ui.menu('删除账号范围', ['仅删除账号资料 / 解绑项目（保留托管密钥）', '删除账号资料和托管私钥、公钥 / 解绑项目']); if (!action) return false;
      const deleteKeys = action === 2;
      ui.text(`以下项目将解除绑定：\n${roots.join('\n') || '（无）'}\n${deleteKeys ? '将永久删除托管私钥与公钥。' : '保留托管密钥，不删除磁盘密钥文件。'}外部原件永不删除。`);
      if (!(await ui.confirm(`最终确认：删除 ${profile.label} 的${deleteKeys ? '资料及托管密钥' : '资料'}并解除以上绑定？`))) return false;
      await this.saveBindings(Object.fromEntries(Object.entries(bindings).filter(([root]) => !roots.includes(root))));
      removeSecret = deleteKeys;
      if (deleteKeys) for (const key of [profile.private_key, profile.public_key]) { checkedPath(key, 'file', { missing: true }); await fsp.unlink(key).catch((error: unknown) => { if (!isErrno(error, 'ENOENT')) throw error; }); }
      await fsp.unlink(path.join(this.profiles_dir, profileId, 'profile.json')); return true;
    });
    if (removed && removeSecret && currentSession()) await requireSession().removeSsh(profileId);
    return removed;
  }
}

export async function chooseProfile(ui: Console): Promise<Profile | undefined> {
  const profiles = await new ProfileStore().list(); if (!profiles.length) { ui.text('尚无账号，请先进入账号管理新建或导入密钥，再选择项目绑定。'); return undefined; }
  const choice = await ui.menu('选择项目账号', profiles.map((profile) => `${profile.label} / ${profile.github_login}`)); return choice ? profiles[choice - 1] : undefined;
}
export async function bindProject(directory: string, profileValue: Profile): Promise<Profile> {
  const profile = asProfile(profileValue); const store = new ProfileStore(); const loaded = await store.load(profile.profile_id); if (!isDeepStrictEqual(store.snapshot(loaded), store.snapshot(profile))) throw new GitError('账号已变化，请重新选择。'); return store.bind(directory, profile.profile_id);
}
export async function resolveBinding(directory: string, store = new ProfileStore()): Promise<Profile | undefined> { return store.resolve_binding(directory); }
function withoutExternalCredentials(git: Git): Git {
  return git.configuredOrdered([['credential.helper', ''], ['core.askPass', ''], ['credential.interactive', 'false'], ['http.extraHeader', ''], ['http.followRedirects', 'false']], {
    env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: null }, rejectEnv: ['GIT_ASKPASS', 'GIT_TRACE_CURL', 'GIT_CURL_VERBOSE', 'GCM_TRACE', 'GCM_TRACE_SECRETS'],
  });
}
export async function boundGit(directory: string): Promise<Git> {
  const profile = await resolveBinding(directory); if (profile) return profileGit(directory, profile);
  const target = await resolveTransport(directory);
  const git = target ? new Git(directory, { config: transportGitConfig(target) }) : new Git(directory);
  return currentSession() && target?.credentials !== 'external' ? withoutExternalCredentials(git) : git;
}
export async function testProfile(ui: Console, directory: string, profileValue: Profile, options: ProfileStoreOptions = {}): Promise<'verified' | 'unverified'> {
  checkEnvironment(); const profile = asProfile(profileValue); const storeDirectory = path.dirname(path.dirname(path.dirname(profile.private_key))); const runner = options.runProcess ?? (runProcess as unknown as ProcessRunner);
  const target = options.transport ?? (await new HostStore(storeDirectory).get(directory)) ?? DEFAULT_TRANSPORT;
  validateTransport(target);
  if (target.mode === 'https') { ui.text('HTTPS 模式请通过仓库获取/推送验证外部凭据；不执行 SSH 测试。'); return 'unverified'; }
  if (currentSession() && target.mode === 'managed-ssh') await requireSession().sshAgent(profile.profile_id);
  const args = buildSshArgs(profile, storeDirectory, options.which ?? which, target);
  const endpoint = target.mode === 'native-ssh' ? target.host.sshAlias ?? target.host.sshHost : target.host.sshHost;
  ui.text(`连接 ${endpoint}；${target.mode === 'managed-ssh' ? '主机指纹保存在软件 data/known_hosts' : '沿用现有 SSH config、代理、跳板与 known_hosts'}；不自动接受主机密钥。`);
  if (target.host.provider === 'github') ui.text('请核对 https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints');
  else ui.text('请向该主机管理员独立核对 SSH 主机指纹。');
  if (!(await ui.routineConfirm('使用此传输配置联网测试？'))) return 'unverified';
  await validateSsh(profile, storeDirectory, runner, options.which ?? which, target); const result = await runner(args[0], args.slice(1).concat(['-T', `${target.host.sshUser ?? 'git'}@${endpoint}`]), { cwd: directory, interactive: true, check: false });
  if (target.host.provider === 'generic') { ui.text(`SSH 退出码 ${result.status} 不足以证明通用 Git 服务身份或仓库权限；请检查原始终端输出。`); return 'unverified'; }
  ui.text(`请核对本次终端完整信息：Hi ${profile.github_login}! You've successfully authenticated, but GitHub does not provide shell access.`);
  return result.status === 1 && await ui.confirm('本次终端确实显示上述完全一致的成功信息和登录名？') ? 'verified' : 'unverified';
}
export const test_profile = testProfile;

export async function profilesMenu(ui: Console, directory: string): Promise<void> {
  const store = new ProfileStore(); ui.text('托管 SSH 使用独立密钥与 known_hosts；需要已有 SSH config / 代理 / 跳板时，在“主机与传输”明确选择原生 SSH 模式。');
  while (true) {
    const choice = await ui.menu('AutoGit 账号管理', ['新建账号 / 生成密钥', '导入已有私钥', '列出 / 查看账号', '绑定当前项目', '解绑当前项目', '测试当前绑定', '删除账号', '编辑账号署名 / 标签 / 预期登录名', '记住认证 / 更改私钥口令', '文件夹保管 / 泄露撤销帮助']); if (!choice) return;
    try {
      if (choice === 1 || choice === 2) {
        const remember = currentSession() ? true : await ui.confirm('记住认证（推荐）？使用无口令私钥，需保管好软件文件夹；不记住则由原生工具处理口令。', true);
        const values = [await ui.ask('标签'), await ui.ask('提交姓名'), await ui.ask('提交邮箱'), await ui.ask('GitHub 登录名')];
        const source = choice === 2 ? await ui.ask('已有私钥的绝对路径') : undefined; const profile = await store.create(ui, values[0], values[1], values[2], values[3], { source, remember_auth: remember });
        if (profile) { ui.text(`已保存账号 ${profile.label}。`); await displayPublicKey(ui, profile.public_key); }
      } else if (choice === 5) {
        if (await ui.routineConfirm('解除当前项目的 AutoGit 绑定？')) await store.unbind(directory);
      } else if (choice === 6) {
        const profile = await store.resolve_binding(directory); if (!profile) throw new GitError('当前项目未绑定账号。'); ui.text(`本次测试（不保存验证状态）：${STATUS_LABELS[await testProfile(ui, directory, profile)]}`);
      } else if (choice === 10) {
        folderHelp(ui);
      } else {
        const profiles = await store.list(); if (!profiles.length) { ui.text('尚无账号。'); continue; }
        const selected = await ui.menu('选择账号', profiles.map((profile) => `${profile.label} / ${profile.github_login}`)); if (!selected) continue; const profile = profiles[selected - 1];
        if (choice === 3) { for (const key of PROFILE_KEYS) ui.text(`${key}：${key === 'status' ? STATUS_LABELS[profile.status] : key === 'remember_auth' ? (profile.remember_auth ? '是' : '否') : profile[key] || '当前系统 SSH'}`); await displayPublicKey(ui, profile.public_key); }
        else if (choice === 4 && await ui.routineConfirm(`将当前项目绑定到 ${profile.label}？`)) await store.bind(directory, profile.profile_id);
        else if (choice === 7) await store.delete(ui, profile.profile_id);
        else if (choice === 8) await store.edit(ui, profile.profile_id);
        else if (choice === 9) {
          if (currentSession()) ui.text('此账号的托管私钥已纳入加密库，每次启动通过独立 AutoGit 密码解锁；无需移除私钥口令。可在“使用设置”修改解锁密码，忘记密码则使用离线恢复码。');
          else { const auth = await ui.menu('更改私钥口令', ['记住认证（移除托管副本口令）', '取消记住 / 原生设置新口令（可能仍为空）']); if (auth) await store.change_auth(ui, profile.profile_id, auth === 1); }
        }
      }
    } catch (error) { if (error instanceof Cancelled) ui.text('已返回，尚未确认的操作不会执行。'); else if (error instanceof Error && (error instanceof GitError || 'code' in error)) ui.text(`账号操作未完成：${error.message}`); else throw error; }
  }
}
