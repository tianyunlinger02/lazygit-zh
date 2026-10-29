import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { activateAppDirectory, appDataDir, prepareCredentialDirectory, resolveApp } from './app-context.js';
import { currentSession, CredentialSession, setSession, unlockSession, hasVault, secureCredentialDirectory } from './session.js';
import { nativeRequest } from './auth.js';
import { isManagedKey } from './managed-keys.js';
import { GitError } from './git.js';
import { ProfileStore, isHttpsOnlyProfile, isSshProfile } from './profiles.js';
import { HostStore } from './hosts.js';
import { Cancelled, type Console } from './ui.js';
import { checkedPath, exactKeys, isErrno, MISSING, mkdirPrivate, readJson, record, withStoreLock, writeJson } from './storage.js';

export interface BackupEntry { path: string; size: number; sha256: string }
export interface BackupManifest { schema_version: 1; app_version: string; created_at: string; platform: string; directories: string[]; files: BackupEntry[] }
export interface RestoreOptions {
  replace?: boolean; pathRemap?: Record<string, string>; sshProgram?: 'preserve' | 'system';
  /** Code-level console input; secrets never come from environment variables. */
  ui?: Console;
  /** Menu restores activate the already validated staging session without asking twice. */
  activate?: boolean;
}
const MANIFEST_KEYS = ['schema_version', 'app_version', 'created_at', 'platform', 'directories', 'files'];
function childPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || /[\x00-\x1f\x7f-\x9f]/u.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..') || path.posix.isAbsolute(value)) throw new GitError('备份路径无效或越界。');
  return value;
}
function contains(parent: string, child: string): boolean { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function separate(a: string, b: string): void { if (contains(a, b) || contains(b, a)) throw new GitError('源与目标不能相同、嵌套或互为父目录。'); }
async function exists(value: string): Promise<boolean> { try { await fsp.lstat(value); return true; } catch (error) { if (isErrno(error, 'ENOENT')) return false; throw error; } }
async function protectCreatedDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') await nativeRequest('secure-path', { path: directory, directory: true });
}
async function directoryTree(root: string, skipLock = false): Promise<{ directories: string[]; files: string[] }> {
  checkedPath(root, 'dir'); const directories: string[] = []; const files: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    const directory = relative ? path.join(root, ...relative.split('/')) : root; checkedPath(directory, 'dir');
    for (const entry of (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && entry.name === '.lock' && skipLock) { checkedPath(path.join(root, '.lock'), 'file'); continue; }
      const child = childPath(relative ? `${relative}/${entry.name}` : entry.name); const absolute = path.join(root, ...child.split('/')); const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) throw new GitError('备份拒绝符号链接。');
      if (stat.isDirectory()) { checkedPath(absolute, 'dir'); directories.push(child); await visit(child); }
      else if (stat.isFile() && stat.nlink === 1) { checkedPath(absolute, 'file'); files.push(child); }
      else throw new GitError('备份拒绝硬链接或非常规文件。');
      if (directories.length + files.length > 10_000) throw new GitError('备份文件数量超过 10000。');
    }
  };
  await visit(''); return { directories: directories.sort(), files: files.sort() };
}
async function digest(file: string, copyTo?: string): Promise<{ size: number; sha256: string }> {
  checkedPath(file, 'file'); const source = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let destination: fsp.FileHandle | undefined;
  try {
    const before = await source.stat(); if (!before.isFile() || before.nlink !== 1) throw new GitError('备份文件类型或硬链接异常。');
    if (copyTo) { checkedPath(copyTo, 'file', { missing: true }); destination = await fsp.open(copyTo, 'wx', 0o600); }
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let size = 0;
    for (;;) { const { bytesRead } = await source.read(buffer, 0, buffer.length, null); if (!bytesRead) break; const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); size += bytesRead; if (destination) await destination.writeFile(chunk); }
    const after = await source.stat(); if (after.nlink !== 1 || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== before.size) throw new GitError('备份过程中源文件发生变化。');
    if (destination) await destination.sync(); return { size, sha256: hash.digest('hex') };
  } finally { await source.close(); await destination?.close(); }
}
function manifestValue(data: unknown): BackupManifest {
  if (!record(data) || !exactKeys(data, MANIFEST_KEYS) || data.schema_version !== 1 || data.app_version !== '0.5.0' || typeof data.created_at !== 'string' || !Number.isFinite(Date.parse(data.created_at)) || !['linux', 'win32', 'darwin', 'freebsd', 'openbsd', 'aix', 'sunos', 'android', 'netbsd', 'haiku', 'cygwin'].includes(String(data.platform)) || !Array.isArray(data.directories) || !Array.isArray(data.files) || data.files.length + data.directories.length > 10_000) throw new GitError('备份 manifest 结构或版本无效。');
  const seen = new Set<string>(); const directories: string[] = [];
  for (const value of data.directories) { const item = childPath(value); const key = item.toLowerCase(); if (seen.has(key)) throw new GitError('备份包含重复或大小写冲突路径。'); seen.add(key); directories.push(item); }
  const files: BackupEntry[] = [];
  for (const value of data.files) {
    if (!record(value) || !exactKeys(value, ['path', 'size', 'sha256']) || !Number.isSafeInteger(value.size) || Number(value.size) < 0 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new GitError('备份文件校验信息无效。');
    const item = childPath(value.path); const key = item.toLowerCase(); if (seen.has(key)) throw new GitError('备份包含重复或大小写冲突路径。'); seen.add(key); files.push({ path: item, size: value.size as number, sha256: value.sha256 });
  }
  const dirs = new Set(directories);
  for (const item of [...directories, ...files.map((file) => file.path)]) { const parent = path.posix.dirname(item); if (parent !== '.' && !dirs.has(parent)) throw new GitError('备份缺失父目录或文件/目录冲突。'); }
  if (seen.has('.lock')) throw new GitError('备份不能包含运行中的存储锁。');
  return { schema_version: 1, app_version: data.app_version, created_at: data.created_at, platform: data.platform as string, directories: directories.sort(), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
async function verifyFiles(directory: string, manifest: BackupManifest): Promise<void> {
  const tree = await directoryTree(directory);
  if (JSON.stringify(tree.directories) !== JSON.stringify([...manifest.directories].sort()) || JSON.stringify(tree.files) !== JSON.stringify(manifest.files.map((file) => file.path).sort())) throw new GitError('备份实际文件/目录与 manifest 不一致（含缺失或额外文件）。');
  for (const entry of manifest.files) { const actual = await digest(path.join(directory, ...entry.path.split('/'))); if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new GitError(`备份 SHA-256 / 大小校验失败：${entry.path}`); }
}
export async function validateBackup(directory: string): Promise<BackupManifest> {
  checkedPath(directory, 'dir'); const entries = await fsp.readdir(directory);
  if (entries.length !== 2 || !entries.includes('manifest.json') || !entries.includes('files')) throw new GitError('备份目录只能包含 manifest.json 与 files/。');
  const manifest = manifestValue(await readJson(path.join(directory, 'manifest.json')));
  await verifyFiles(path.join(directory, 'files'), manifest); await validateStoreMetadata(path.join(directory, 'files')); return manifest;
}
async function snapshotLocked(source: string, destination: string): Promise<BackupManifest> {
  checkedPath(destination, 'dir', { missing: true }); if (await exists(destination)) throw new GitError('备份目标已存在；不会覆盖。');
  const tree = await directoryTree(source, true);
  if (currentSession()) {
    for (const profile of await new ProfileStore(source).list()) {
      if (isHttpsOnlyProfile(profile)) continue;
      if (!isSshProfile(profile)) throw new GitError('SSH 账号密钥元数据无效。');
      if (!await isManagedKey(profile.private_key)) throw new GitError('仍有未加密的旧托管私钥，请先完成迁移再备份。');
    }
  }
  await mkdirPrivate(path.dirname(destination)); await fsp.mkdir(destination, { mode: 0o700 }); await protectCreatedDirectory(destination);
  const filesRoot = path.join(destination, 'files'); await fsp.mkdir(filesRoot, { mode: 0o700 }); await protectCreatedDirectory(filesRoot);
  const manifest: BackupManifest = { schema_version: 1, app_version: '0.5.0', created_at: new Date().toISOString(), platform: process.platform, directories: tree.directories, files: [] };
  for (const directory of tree.directories.sort((a, b) => a.split('/').length - b.split('/').length)) await mkdirPrivate(path.join(filesRoot, ...directory.split('/')));
  for (const file of tree.files) { const result = await digest(path.join(source, ...file.split('/')), path.join(filesRoot, ...file.split('/'))); manifest.files.push({ path: file, ...result }); }
  await writeJson(path.join(destination, 'manifest.json'), manifest); await validateBackup(destination);
  const after = await directoryTree(source, true);
  if (JSON.stringify(after.directories) !== JSON.stringify([...manifest.directories].sort()) || JSON.stringify(after.files) !== JSON.stringify(manifest.files.map((entry) => entry.path).sort())) throw new GitError('备份过程中资料目录发生变化；不会把不完整快照标记为成功。');
  for (const entry of manifest.files) { const actual = await digest(path.join(source, ...entry.path.split('/'))); if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new GitError('备份过程中资料文件发生变化；请停止其他资料操作后重试。'); }
  return manifest;
}
export async function createBackup(destinationValue: string, sourceValue = appDataDir()): Promise<BackupManifest> {
  const source = checkedPath(sourceValue, 'dir'); const destination = checkedPath(destinationValue, 'dir', { missing: true }); separate(source, destination);
  return withStoreLock(source, () => snapshotLocked(source, destination));
}
function projectKey(value: string): string {
  if (!value || /[\x00-\x1f\x7f-\x9f]/u.test(value) || !(path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) || value.split(/[\\/]/u).includes('..')) throw new GitError('重映射必须给出完整旧/新绝对路径。');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
/** Apply only explicitly supplied exact paths. No basename matching, no repository discovery. Caller owns the store lock. */
export async function remapDataPaths(directory: string, mappings: Record<string, string>): Promise<void> {
  const map = new Map<string, string>(); const targets = new Set<string>();
  for (const [old, next] of Object.entries(mappings)) { const from = projectKey(old); const to = projectKey(next); if (map.has(from) || targets.has(to) || from === to) throw new GitError('重映射路径重复或冲突。'); map.set(from, to); targets.add(to); }
  const writes: [string, unknown][] = [];
  for (const [filename, field] of [['bindings.json', 'bindings'], ['hosts.json', 'projects']] as const) {
    const file = path.join(directory, filename); const data = await readJson(file); if (data === MISSING) continue;
    if (!record(data) || !record(data[field]) || !exactKeys(data, ['schema_version', field]) || data.schema_version !== (filename === 'bindings.json' ? 2 : 1)) throw new GitError(`${filename} 结构或版本无效。`);
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [root, value] of Object.entries(data[field])) { const next = map.get(projectKey(root)) ?? root; if (Object.hasOwn(values, next)) throw new GitError('重映射目标已有绑定或主机配置；未覆盖。'); values[next] = value; }
    writes.push([file, { ...data, [field]: values }]);
  }
  const projectsFile = path.join(directory, 'projects.json'); const projects = await readJson(projectsFile);
  if (projects !== MISSING) {
    if (!record(projects) || !exactKeys(projects, ['schema_version', 'projects']) || projects.schema_version !== 1 || !Array.isArray(projects.projects)) throw new GitError('projects.json 结构或版本无效。');
    const paths = new Set<string>(); const updated = projects.projects.map((item) => { if (!record(item) || typeof item.path !== 'string') throw new GitError('项目路径记录无效。'); const next = map.get(projectKey(item.path)) ?? item.path; const key = projectKey(next); if (paths.has(key)) throw new GitError('重映射目标已登记；未合并。'); paths.add(key); return { ...item, path: next }; });
    writes.push([projectsFile, { ...projects, projects: updated }]);
  }
  const settingsFile = path.join(directory, 'settings.json'); const settings = await readJson(settingsFile);
  if (settings !== MISSING) {
    if (!record(settings) || !exactKeys(settings, ['schema_version', 'interaction_mode', 'notice_version', 'last_project']) || settings.schema_version !== 1 || !['quick', 'confirm'].includes(String(settings.interaction_mode)) || !Number.isSafeInteger(settings.notice_version) || Number(settings.notice_version) < 0 || typeof settings.last_project !== 'string') throw new GitError('settings.json 结构或版本无效。');
    const lastProject = settings.last_project && (path.isAbsolute(settings.last_project) || /^[A-Za-z]:[\\/]/u.test(settings.last_project) || settings.last_project.startsWith('\\\\')) ? map.get(projectKey(settings.last_project)) ?? settings.last_project : settings.last_project;
    writes.push([settingsFile, { ...settings, last_project: lastProject }]);
  }
  for (const [file, data] of writes) await writeJson(file, data);
}
async function validateStoreMetadata(directory: string): Promise<void> {
  const store = new ProfileStore(directory);
  await store.validateMetadata();
  if ((await store.list()).some(isHttpsOnlyProfile) && !await hasVault(directory)) throw new GitError('HTTPS-only 账号的 vault.json 缺失；请恢复原凭据库，不会用空库替代原 Token。');
  await new HostStore(directory).all();
  const { ProjectStore } = await import('./projects.js'); await new ProjectStore(directory).list();
  const settings = await readJson(path.join(directory, 'settings.json'));
  if (settings !== MISSING && (!record(settings) || !exactKeys(settings, ['schema_version', 'interaction_mode', 'notice_version', 'last_project']) || settings.schema_version !== 1 || !['quick', 'confirm'].includes(String(settings.interaction_mode)) || !Number.isSafeInteger(settings.notice_version) || Number(settings.notice_version) < 0 || typeof settings.last_project !== 'string')) throw new GitError('settings.json 结构或版本无效。');
}
async function prepareRestoredData(directory: string, options: RestoreOptions): Promise<void> {
  const store = new ProfileStore(directory); const profiles = await store.list();
  await new HostStore(directory).all();
  if (options.sshProgram !== undefined && !['preserve', 'system'].includes(options.sshProgram)) throw new GitError('SSH 程序恢复策略无效。');
  if (options.sshProgram === 'system') for (const profile of profiles) if (profile.ssh_program) { profile.ssh_program = ''; await writeJson(path.join(store.profilesDir, profile.profile_id, 'profile.json'), store.encodeProfile(profile)); }
  await remapDataPaths(directory, options.pathRemap ?? {});
  await validateStoreMetadata(directory);
  // Project paths may legitimately be missing or belong to another platform after restore.
}
async function install(directory: string, staged: string, replace: boolean, onInstalled?: () => Promise<void>): Promise<{ previousDataDir?: string }> {
  checkedPath(directory, 'dir', { missing: true }); const existed = await exists(directory);
  if (existed && !replace) throw new GitError('目标 data 已存在；请选择新位置，或明确选择替换。');
  let previousDataDir: string | undefined;
  if (process.platform === 'win32') await secureCredentialDirectory(directory);
  await withStoreLock(directory, async () => {
    const existing = (await fsp.readdir(directory)).filter((entry) => entry !== '.lock');
    if (existing.length && !replace) throw new GitError('目标在操作期间已出现资料；未覆盖。');
    await directoryTree(directory, true);
    if (existing.length) { previousDataDir = path.join(path.dirname(directory), `data-before-restore-${randomUUID()}`); await fsp.mkdir(previousDataDir, { mode: 0o700 }); await protectCreatedDirectory(previousDataDir); }
    const installed: string[] = []; const saved: string[] = [];
    try {
      for (const entry of existing) { await fsp.rename(path.join(directory, entry), path.join(previousDataDir!, entry)); saved.push(entry); }
      for (const entry of await fsp.readdir(staged)) { await fsp.rename(path.join(staged, entry), path.join(directory, entry)); installed.push(entry); }
      await onInstalled?.();
    } catch (error) {
      for (const entry of installed.reverse()) await fsp.rename(path.join(directory, entry), path.join(staged, entry));
      for (const entry of saved.reverse()) await fsp.rename(path.join(previousDataDir!, entry), path.join(directory, entry));
      throw error;
    }
  });
  return previousDataDir ? { previousDataDir } : {};
}
async function materialize(backup: string, destination: string, manifest: BackupManifest): Promise<void> {
  await fsp.mkdir(destination, { mode: 0o700 }); await protectCreatedDirectory(destination);
  for (const directory of [...manifest.directories].sort((a, b) => a.split('/').length - b.split('/').length)) {
    const target = path.join(destination, ...directory.split('/')); await mkdirPrivate(target); await protectCreatedDirectory(target);
  }
  for (const entry of manifest.files) {
    const target = path.join(destination, ...entry.path.split('/'));
    const actual = await digest(path.join(backup, 'files', ...entry.path.split('/')), target);
    if (process.platform === 'win32') await nativeRequest('secure-path', { path: target, directory: false });
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new GitError('复制恢复数据时校验失败。');
  }
  await verifyFiles(destination, manifest);
}
export async function restoreBackup(backupValue: string, dataDirectoryValue: string, options: RestoreOptions = {}): Promise<{ previousDataDir?: string; activated?: { persisted: boolean; dataDir: string } }> {
  const backup = checkedPath(backupValue, 'dir'); const dataDirectory = resolveApp({ dataDir: dataDirectoryValue }).dataDir; separate(backup, dataDirectory);
  const manifest = await validateBackup(backup); if (await exists(dataDirectory) && !options.replace) throw new GitError('目标 data 已存在；必须明确选择替换。');
  const previous = currentSession();
  if (previous?.closed) throw new GitError('凭据会话已经锁定，不能继续恢复资料。');
  if (options.activate && path.basename(dataDirectory) !== 'data') throw new GitError('启用恢复资料时目标必须是软件根目录下的 data。');
  await mkdirPrivate(path.dirname(dataDirectory)); const staged = path.join(path.dirname(dataDirectory), `.autogit-restore-${randomUUID()}`);
  let prepared: CredentialSession | undefined;
  let activated: { persisted: boolean; dataDir: string } | undefined;
  try {
    await materialize(backup, staged, manifest); await prepareRestoredData(staged, options);
    if (previous || options.ui) {
      try {
        if (options.ui) {
          // The restored Vault has its own password; never reuse the active Vault's password.
          const encrypted = await hasVault(staged);
          if (!encrypted && !await options.ui.confirm('此备份没有加密凭据库。设置独立 AutoGit 密码并迁移旧资料后恢复？旧备份不会改变。')) throw new Cancelled('未迁移旧版备份');
          prepared = await unlockSession(options.ui, staged, { allowCreate: !encrypted });
        } else {
          // A pre-unlocked session may verify its own copy, never an unrelated vault.
          prepared = new CredentialSession(await previous!.vault.atDirectory(staged));
        }
        await prepareCredentialDirectory(options.ui, prepared);
      } finally { setSession(previous && !previous.closed ? previous : undefined); }
    } else if (await hasVault(staged)) {
      throw new GitError('恢复独立加密库必须通过交互输入其 AutoGit 密码，或提供同一已解锁会话；未替换目标。');
    }
    const onInstalled = async (): Promise<void> => {
      if (options.activate) {
        activated = await activateAppDirectory(path.dirname(dataDirectory), { ui: options.ui, session: prepared });
      } else if (prepared && previous && path.resolve(previous.vault.directory) === path.resolve(dataDirectory)) {
        const replacement = new CredentialSession(await prepared.vault.atDirectory(dataDirectory));
        try { await prepareCredentialDirectory(options.ui, replacement); await previous.close(); setSession(replacement); }
        catch (error) { try { await replacement.close(); } finally { setSession(!previous.closed ? previous : undefined); } throw error; }
      }
    };
    const result = await install(dataDirectory, staged, !!options.replace, onInstalled);
    return activated ? { ...result, activated } : result;
  } finally {
    await prepared?.close();
    if (await exists(staged)) { await directoryTree(staged); await fsp.rm(staged, { recursive: true }); }
  }
}
export async function relocateData(nextRootValue: string, options: { deleteSource?: boolean } = {}): Promise<{ persisted: boolean; dataDir: string }> {
  const source = appDataDir(); const resolved = resolveApp({ appDir: nextRootValue }); const root = resolved.appRoot; const destination = resolved.dataDir; separate(source, destination);
  if (await exists(destination)) throw new GitError('迁移目标 data 已存在；迁移不合并、不覆盖。');
  await mkdirPrivate(root); const temporary = path.join(root, `.autogit-relocate-${randomUUID()}`); let switched: { persisted: boolean; dataDir: string } | undefined;
  await withStoreLock(source, async () => {
    try {
      await snapshotLocked(source, temporary); const manifest = await validateBackup(temporary);
      const staged = path.join(root, `.autogit-relocate-data-${randomUUID()}`);
      try { await materialize(temporary, staged, manifest); await verifyFiles(staged, manifest); await fsp.rename(staged, destination); }
      finally { if (await exists(staged)) { await directoryTree(staged); await fsp.rm(staged, { recursive: true }); } }
      switched = await activateAppDirectory(root);
      if (options.deleteSource) { const tree = await directoryTree(source, true); for (const entry of tree.files) await fsp.unlink(path.join(source, ...entry.split('/'))); for (const directory of tree.directories.sort((a, b) => b.split('/').length - a.split('/').length)) await fsp.rmdir(path.join(source, ...directory.split('/'))); }
    } finally { if (await exists(temporary)) { await directoryTree(temporary); await fsp.rm(temporary, { recursive: true }); } }
  });
  if (options.deleteSource) await fsp.rmdir(source);
  return switched!;
}
async function remapPrompts(ui: Console, backup: string): Promise<Record<string, string>> {
  const mappings: Record<string, string> = Object.create(null) as Record<string, string>;
  const choice = await ui.menu('项目路径跨机处理', ['保留原绝对路径（可稍后重新映射）', '明确输入旧路径 → 新路径']);
  if (!choice) throw new Cancelled();
  if (choice === 2) {
    ui.text('仅精确匹配你给出的旧路径；不会按同名项目猜测。');
    const bindings = await readJson(path.join(backup, 'files', 'bindings.json')); if (record(bindings) && record(bindings.bindings)) ui.text(`备份绑定路径：\n${Object.keys(bindings.bindings).join('\n')}`);
    for (;;) { const old = await ui.ask('旧项目绝对路径（空值完成）', '', { allowEmpty: true }); if (!old) break; if (Object.hasOwn(mappings, old)) throw new GitError('旧路径重复。'); mappings[old] = await ui.ask('新的项目绝对路径'); }
  }
  return mappings;
}
export async function backupMenu(ui: Console): Promise<void> {
  const protectedSession = !!currentSession();
  for (;;) {
    if (protectedSession && (!currentSession() || currentSession()!.closed)) throw new Cancelled('凭据会话已锁定，请重新启动并登录');
    const choice = await ui.menu('资料备份 / 恢复 / 迁移', ['备份全部 AutoGit data（含托管密钥）', '校验已有备份', '恢复备份到新位置 / 明确替换', '迁移资料（复制→校验→切换位置）']);
    if (protectedSession && (!currentSession() || currentSession()!.closed)) throw new Cancelled('凭据会话已锁定，请重新启动并登录');
    if (!choice) return;
    try {
      if (choice === 1) { ui.text(currentSession() ? '备份包含密文凭据库、公钥和普通元数据；不含恢复码、AutoGit 解锁密码或会话密钥。外部工具管理的凭据不在备份中。' : '旧版备份包含全部 AutoGit data 和托管私钥；不包含外部 gh 令牌和 location 指针。备份不是加密文件，请妥善保管。'); const target = await ui.ask('新备份目录绝对路径（必须不存在）'); const manifest = await createBackup(target); ui.success(`已校验备份：${manifest.files.length} 个文件。`); }
      else if (choice === 2) { const manifest = await validateBackup(await ui.ask('备份目录绝对路径')); ui.success(`SHA-256、路径和版本校验通过：${manifest.files.length} 个文件。`); }
      else if (choice === 3) {
        const backup = await ui.ask('备份目录绝对路径'); await validateBackup(backup); const root = resolveApp({ appDir: await ui.ask('恢复到的软件根目录') }).appRoot; const data = path.join(root, 'data');
        const mappings = await remapPrompts(ui, backup); const ssh = await ui.menu('跨机 SSH 程序', ['改用当前系统 SSH（清除旧自定义程序绝对路径）', '保留备份的自定义 SSH 程序路径']); if (!ssh) continue;
        const replace = await exists(data); ui.text(`恢复目标：${data}${replace ? '（已存在，将替换；原资料保留在旁边的 data-before-restore-*）' : '（新位置）'}`);
        if (!await ui.confirm(replace ? '最终确认：替换目标 data 的全部现有资料？' : '确认恢复备份到这个新位置并切换？')) continue;
        const result = await restoreBackup(backup, data, { replace, pathRemap: mappings, sshProgram: ssh === 1 ? 'system' : 'preserve', ui, activate: true }); const activated = result.activated!;
        ui.success(`已恢复并切换到 ${data}。${result.previousDataDir ? `原资料保留：${result.previousDataDir}` : ''}`);
        if (!activated.persisted) ui.text(`显式目录启动：下次请使用 --app-dir ${JSON.stringify(root)}，未改位置指针。`);
      } else if (choice === 4) {
        const root = await ui.ask('新的软件根目录（目标 data 必须不存在）');
        const keep = await ui.menu('迁移后旧资料', ['保留源 data（推荐）', '校验切换成功后删除源 data']); if (!keep) continue;
        if (!await ui.confirm(`最终确认：复制并校验后切换到 ${root}？${keep === 2 ? '成功后永久删除旧 data。' : '旧 data 保留原样。'}`)) continue;
        const result = await relocateData(root, { deleteSource: keep === 2 }); ui.success(`已迁移并校验：${result.dataDir}`); if (!result.persisted) ui.text(`本次显式目录模式仅切换会话；下次使用 --app-dir ${JSON.stringify(root)}。`);
      }
    } catch (error) {
      if (error instanceof Cancelled) { if (error.warning) ui.warn(error.message); else ui.text('已返回；未执行尚未确认的替换或删除。'); }
      else if (error instanceof GitError || error instanceof Error && 'code' in error) ui.error(`资料操作未完成：${error.message}`);
      else throw error;
    }
  }
}
