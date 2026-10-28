import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { checkedPath, location, readJson, writeJson, withStoreLock, MISSING, record, exactKeys, isErrno } from './storage.js';
import { GitError } from './git.js';
import { Cancelled, type Console } from './ui.js';
import { currentSession, CredentialSession, setSession, unlockSession, hasVault } from './session.js';
import { migrateManagedKeys, isManagedKey } from './managed-keys.js';
import { ProfileStore } from './profiles.js';

type Environment = Record<string, string | undefined>;
export interface AppOptions { appDir?: string; dataDir?: string; env?: Environment; deferLocationCommit?: boolean }

let resolvedData: string | undefined;
let resolvedRoot: string | undefined;
let pointerFile: string | undefined;
let explicitMode = false;
let pendingLocation: { file: string; previous: string | undefined; selected: string } | undefined;

function envValue(env: Environment, key: string): string | undefined { return env[key]; }
function homeDirectory(env: Environment): string {
  const home = process.platform === 'win32' ? (env.USERPROFILE || env.HOME) : (env.HOME || os.homedir());
  if (!home) throw new GitError('无法确定用户主目录；请使用 --app-dir 或 AUTOGIT_DATA_DIR。');
  return location(home);
}
function pointerPath(env: Environment): string {
  if (process.platform === 'win32') {
    const appData = env.APPDATA || path.join(homeDirectory(env), 'AppData', 'Roaming');
    return path.join(location(appData), 'AutoGit', 'location.json');
  }
  const config = env.XDG_CONFIG_HOME || path.join(homeDirectory(env), '.config');
  return path.join(location(config), 'autogit', 'location.json');
}
function defaultRoot(env: Environment): string { return path.join(homeDirectory(env), 'AutoGit'); }
function validateRoot(value: unknown): string {
  const result = location(value);
  rejectPackageDirectory(result);
  checkedPath(result, 'dir', { missing: true });
  return result;
}
function rejectPackageDirectory(value: string): void {
  if (value.split(/[\\/]/u).some((part) => ['node_modules', '_npx'].includes(part.toLowerCase()))) throw new GitError('软件根目录和资料目录不能放在 node_modules 或 npx 缓存中；卸载/清理可能丢失账号密钥，请选择独立文件夹。');
}
function validateData(value: unknown): string {
  const result = location(value);
  rejectPackageDirectory(result);
  checkedPath(result, 'dir', { missing: true });
  return result;
}

async function readLocation(file: string): Promise<string | undefined> {
  const data = await readJson(file);
  if (data === MISSING) return undefined;
  if (!record(data) || !exactKeys(data, ['schema_version', 'appRoot']) || data.schema_version !== 1 || typeof data.appRoot !== 'string') {
    throw new GitError('AutoGit 位置指针损坏；没有自动覆盖，请手工检查 location.json。');
  }
  return validateRoot(data.appRoot);
}

async function persistLocation(file: string, appRoot: string, overwrite = false): Promise<string> {
  return withStoreLock(path.dirname(file), async () => {
    // A second process may have finished its first-run prompt while this process was asking.
    const remembered = await readLocation(file);
    if (remembered && !overwrite) return remembered;
    await writeJson(file, { schema_version: 1, appRoot });
    return appRoot;
  });
}

/** Resolve application locations without doing any I/O beyond validating existing ancestors. */
export function resolveApp(options: AppOptions = {}): { appRoot: string; dataDir: string; pointer: string | undefined; explicit: boolean } {
  const env = options.env ?? process.env;
  if (options.dataDir !== undefined) {
    const dataDir = validateData(options.dataDir);
    return { appRoot: options.appDir === undefined ? path.dirname(dataDir) : validateRoot(options.appDir), dataDir, pointer: undefined, explicit: true };
  }
  if (options.appDir !== undefined) {
    const appRoot = validateRoot(options.appDir);
    return { appRoot, dataDir: validateData(path.join(appRoot, 'data')), pointer: undefined, explicit: true };
  }
  const override = envValue(env, 'AUTOGIT_DATA_DIR');
  if (override !== undefined) {
    const dataDir = validateData(override);
    return { appRoot: path.dirname(dataDir), dataDir, pointer: undefined, explicit: true };
  }
  return { appRoot: defaultRoot(env), dataDir: path.join(defaultRoot(env), 'data'), pointer: pointerPath(env), explicit: false };
}

function showLocation(ui: Console): void {
  ui.text(`AutoGit 资料文件夹：${resolvedRoot}\n资料目录：${resolvedData}\n加密凭据库：${path.join(resolvedData!, 'vault.json')}`);
  ui.text('这里保存账号资料，不是项目代码目录。托管私钥和 Token 加密保存，AutoGit 解锁密码不保存；以后会记住此位置，可在使用设置中切换或搬迁。');
}

async function chooseRoot(ui: Console, env: Environment, initial: string, existing = false): Promise<string> {
  for (;;) {
    const answer = await ui.ask('AutoGit 资料文件夹（软件根目录）', initial);
    try {
      const value = answer === '~' ? homeDirectory(env) : /^~[/\\]/u.test(answer) ? path.join(homeDirectory(env), answer.slice(2)) : answer;
      const root = validateRoot(value);
      const data = validateData(path.join(root, 'data'));
      if (existing && !await credentialDataExists(data)) throw new GitError('此处没有可用的已有凭据库或旧版账号资料；请选择包含 data 的原 AutoGit 文件夹。');
      return root;
    } catch (error) {
      if (!(error instanceof GitError || error instanceof Error && 'code' in error)) throw error;
      ui.text(`位置不可用：${error.message} 请重新选择；输入 :q 可返回。`);
    }
  }
}

async function credentialDataExists(data: string): Promise<boolean> {
  if (await hasVault(data)) return true;
  try { await fs.lstat(data); } catch (error) { if (isErrno(error, 'ENOENT')) return false; throw error; }
  const profiles = await new ProfileStore(data).list();
  if (!profiles.length) return false;
  for (const profile of profiles) if (await isManagedKey(profile.private_key)) return false;
  return true;
}

async function recoverLocation(ui: Console, env: Environment, remembered: string): Promise<string> {
  for (;;) {
    ui.text(`已记住的资料位置缺少凭据库：${remembered}。可能是文件夹被移动、磁盘未挂载或凭据库丢失；不会自动创建空库替代。`);
    const choice = await ui.menu('找回 AutoGit 资料', ['重试原位置（例如重新挂载磁盘后）', '选择已搬迁或恢复的 AutoGit 文件夹', '明确创建新的加密资料库（不恢复旧凭据）'], '退出');
    if (!choice) throw new Cancelled('未选择资料位置');
    try {
      if (choice === 1) {
        if (await credentialDataExists(path.join(remembered, 'data'))) return remembered;
      } else if (choice === 2) return await chooseRoot(ui, env, remembered, true);
      else {
        const root = await chooseRoot(ui, env, defaultRoot(env));
        const data = path.join(root, 'data');
        try { if ((await fs.readdir(data)).length) throw new GitError('目标 data 非空，不会覆盖或混入新库。请选择未使用的位置，或选择找回已有资料。'); }
        catch (error) { if (!isErrno(error, 'ENOENT')) throw error; }
        if (await ui.confirm(`在 ${root} 新建独立凭据库？这不会找回旧账号或旧 Token，也不会删除原资料。`)) return root;
      }
    } catch (error) {
      if (error instanceof Cancelled) continue;
      if (!(error instanceof GitError || error instanceof Error && 'code' in error)) throw error;
      ui.text(`资料位置未更改：${error.message}`);
    }
  }
}

/** Commit a staged startup choice only after the selected vault is unlocked and migrated. */
export async function commitConfiguredApp(): Promise<void> {
  const pending = pendingLocation;
  if (!pending) return;
  await withStoreLock(path.dirname(pending.file), async () => {
    if (await readLocation(pending.file) !== pending.previous) throw new GitError('资料位置在引导期间被另一进程修改；未覆盖位置指针，请重新启动并选择。');
    if (pending.selected !== pending.previous) await writeJson(pending.file, { schema_version: 1, appRoot: pending.selected });
  });
  if (pendingLocation === pending) pendingLocation = undefined;
}

export async function configureApp(ui: Console, options: AppOptions = {}): Promise<void> {
  pendingLocation = undefined;
  const env = options.env ?? process.env;
  const explicitData = options.dataDir ?? envValue(env, 'AUTOGIT_DATA_DIR');
  if (explicitData !== undefined || options.appDir !== undefined) {
    const result = resolveApp(options);
    resolvedRoot = result.appRoot;
    resolvedData = result.dataDir;
    pointerFile = undefined;
    explicitMode = true;
    showLocation(ui);
    return;
  }

  const pointer = pointerPath(env);
  const remembered = await readLocation(pointer);
  let appRoot = remembered;
  if (!appRoot) {
    ui.title('选择 AutoGit 资料保存位置');
    ui.text('首次使用请选择持久的个人文件夹，不要选程序安装目录或 Git 项目。不存在的文件夹会在创建加密库时自动创建。');
    appRoot = await chooseRoot(ui, env, defaultRoot(env));
  } else if (options.deferLocationCommit && !await credentialDataExists(path.join(appRoot, 'data'))) {
    appRoot = await recoverLocation(ui, env, appRoot);
  }
  const data = validateData(path.join(appRoot, 'data'));
  resolvedRoot = appRoot;
  resolvedData = data;
  pointerFile = pointer;
  explicitMode = false;
  if (options.deferLocationCommit || appRoot !== remembered) {
    pendingLocation = { file: pointer, previous: remembered, selected: appRoot };
    if (!options.deferLocationCommit) await commitConfiguredApp();
  }
  showLocation(ui);
}

/** Validate/decrypt every record before enabling a copied or independently unlocked store. */
export async function prepareCredentialDirectory(ui: Console | undefined, session: CredentialSession): Promise<void> {
  if (session.closed) throw new GitError('目标凭据会话已经锁定。');
  const previous = currentSession();
  setSession(session);
  try {
    const store = new ProfileStore(session.vault.directory);
    await store.validateMetadata();
    const profiles = await store.list();
    if (ui) await migrateManagedKeys(ui, profiles);
    else for (const profile of profiles) if (!await isManagedKey(profile.private_key)) throw new GitError('切换到目标资料前必须完成旧托管私钥迁移；请从菜单执行并解锁目标凭据库。');
    const verified = new Set<string>();
    for (const profile of profiles) {
      if (!await isManagedKey(profile.private_key)) throw new GitError('目标仍有未加密的托管私钥，未切换资料。');
      const id = `ssh:${profile.profile_id}`, secret = await session.vault.get(id);
      try { if (!secret?.length) throw new GitError('目标托管私钥缺少对应的可解密凭据，未切换资料。'); }
      finally { secret?.fill(0); }
      verified.add(id);
    }
    const document = await readJson(path.join(session.vault.directory, 'vault.json'));
    if (!record(document) || !Array.isArray(document.records)) throw new GitError('目标凭据库记录无效。');
    for (const value of document.records) {
      if (!record(value) || typeof value.id !== 'string') throw new GitError('目标凭据库记录无效。');
      if (verified.has(value.id)) continue;
      const secret = await session.vault.get(value.id);
      try { if (!secret) throw new GitError('目标凭据库记录已变化，未切换资料。'); }
      finally { secret?.fill(0); }
    }
  } finally { setSession(previous && !previous.closed ? previous : undefined); }
}

async function commitDirectory(nextRoot: string, nextData: string, target: CredentialSession | undefined, previous: CredentialSession | undefined): Promise<{ persisted: boolean; dataDir: string }> {
  const persisted = !!pointerFile && !explicitMode;
  let pointerBefore: string | undefined, pointerAttempted = false;
  try {
    if (persisted) {
      pointerBefore = await readLocation(pointerFile!);
      pointerAttempted = true;
      await persistLocation(pointerFile!, nextRoot, true);
    }
    if (target) { await previous?.close(); setSession(target); }
    resolvedRoot = nextRoot; resolvedData = nextData;
    return { persisted, dataDir: nextData };
  } catch (error) {
    let rollbackFailed = false;
    if (pointerAttempted) {
      try {
        if (await readLocation(pointerFile!) !== pointerBefore) await persistLocation(pointerFile!, pointerBefore ?? resolvedRoot ?? path.dirname(appDataDir()), true);
      } catch { rollbackFailed = true; }
    }
    try { await target?.close(); }
    finally {
      if (rollbackFailed) { try { await previous?.close(); } finally { setSession(undefined); } }
      else setSession(previous && !previous.closed ? previous : undefined);
    }
    if (rollbackFailed) throw new GitError('资料位置提交失败且无法恢复位置指针；本次会话已锁定，请检查位置后重新登录。', { cause: error });
    throw error;
  }
}

export async function changeAppDirectory(ui: Console): Promise<boolean> {
  const currentData = appDataDir();
  const currentRoot = resolvedRoot ?? path.dirname(currentData);
  ui.text('只切换 AutoGit 软件根目录，不移动、复制或删除旧 data；请先备份并手工搬运需要保留的数据。');
  const nextRoot = validateRoot(await ui.ask('新的软件根目录', currentRoot));
  const nextData = validateData(path.join(nextRoot, 'data'));
  if (nextRoot === currentRoot && nextData === currentData) { ui.text('软件根目录没有变化。'); return false; }
  if (!(await ui.confirm(`确认切换到 ${nextRoot}？旧 data 将保留原样。`))) return false;
  const previous = currentSession();
  if (previous?.closed) throw new GitError('凭据会话已锁定，不能继续切换资料。');
  if (previous) {
    let target: CredentialSession | undefined;
    try {
      const existing = await credentialDataExists(nextData);
      if (!existing && !await ui.confirm('目标没有凭据库。明确设置新 AutoGit 密码并创建独立加密库？不会找回旧凭据。')) return false;
      target = await unlockSession(ui, nextData, { allowCreate: !await hasVault(nextData) });
      // unlockSession makes the target active. Migrate while its vault is the active session,
      // then restore the old session until the pointer and context commit succeed.
      await prepareCredentialDirectory(ui, target);
      setSession(previous);
      await commitDirectory(nextRoot, nextData, target, previous);
    } catch (error) { try { await target?.close(); } finally { setSession(!previous.closed ? previous : undefined); } throw error; }
    return true;
  }
  if (pointerFile && !explicitMode) {
    // Do not hide a damaged pointer under a settings operation.
    await readLocation(pointerFile);
    await persistLocation(pointerFile, nextRoot, true);
  } else {
    ui.text(`本次通过显式目录启动，仅切换本次会话，不写位置指针；下次请使用 --app-dir ${JSON.stringify(nextRoot)}。`);
  }
  resolvedRoot = nextRoot;
  resolvedData = nextData;
  return true;
}

/** Unlock an independent vault before changing the remembered location. */
export async function activateUnlockedDirectory(ui: Console, nextRootValue: string): Promise<{ persisted: boolean; dataDir: string }> {
  const nextRoot = validateRoot(nextRootValue); const nextData = validateData(path.join(nextRoot, 'data'));
  const previous = currentSession();
  if (previous?.closed) throw new GitError('凭据会话已经锁定，不能继续启用资料。');
  let target: CredentialSession | undefined;
  try {
    target = await unlockSession(ui, nextData);
    await prepareCredentialDirectory(ui, target);
    setSession(previous);
    return await commitDirectory(nextRoot, nextData, target, previous);
  } catch (error) { try { await target?.close(); } finally { setSession(previous && !previous.closed ? previous : undefined); } throw error; }
}

/** Switch only after a caller has copied and verified the destination. Never moves data itself. */
export async function activateAppDirectory(nextRootValue: string, options: { ui?: Console; session?: CredentialSession } = {}): Promise<{ persisted: boolean; dataDir: string }> {
  const nextRoot = validateRoot(nextRootValue); const nextData = validateData(path.join(nextRoot, 'data'));
  const previous = currentSession();
  const source = options.session ?? previous;
  if (source?.closed) throw new GitError('待启用的凭据会话已经锁定。');
  const replacement = source ? new CredentialSession(await source.vault.atDirectory(nextData)) : undefined;
  try {
    if (replacement) await prepareCredentialDirectory(options.ui, replacement);
    return await commitDirectory(nextRoot, nextData, replacement, previous);
  } catch (error) { try { await replacement?.close(); } finally { setSession(previous && !previous.closed ? previous : undefined); } throw error; }
}

export function appDataDir(): string {
  if (resolvedData) return validateData(resolvedData);
  const explicit = process.env.AUTOGIT_DATA_DIR;
  if (explicit !== undefined) return validateData(explicit);
  throw new GitError('AutoGit 尚未配置；请先调用 configureApp，或设置 AUTOGIT_DATA_DIR。');
}

export function appRoot(): string {
  if (!resolvedRoot) throw new GitError('AutoGit 尚未配置；请先调用 configureApp，或设置 AUTOGIT_DATA_DIR。');
  return resolvedRoot;
}

export function resetAppContextForTests(): void {
  resolvedData = undefined;
  resolvedRoot = undefined;
  pointerFile = undefined;
  explicitMode = false;
  pendingLocation = undefined;
}
