import * as os from 'node:os';
import * as path from 'node:path';
import { checkedPath, location, readJson, writeJson, withStoreLock, MISSING, record, exactKeys } from './storage.js';
import { GitError } from './git.js';
import type { Console } from './ui.js';

type Environment = Record<string, string | undefined>;
export interface AppOptions { appDir?: string; dataDir?: string; env?: Environment }

let resolvedData: string | undefined;
let resolvedRoot: string | undefined;
let pointerFile: string | undefined;
let explicitMode = false;

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

export async function configureApp(ui: Console, options: AppOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const explicitData = options.dataDir ?? envValue(env, 'AUTOGIT_DATA_DIR');
  if (explicitData !== undefined || options.appDir !== undefined) {
    const result = resolveApp(options);
    resolvedRoot = result.appRoot;
    resolvedData = result.dataDir;
    pointerFile = undefined;
    explicitMode = true;
    return;
  }

  const pointer = pointerPath(env);
  const remembered = await readLocation(pointer);
  let appRoot = remembered;
  if (!appRoot) {
    appRoot = validateRoot(await ui.ask('软件根目录', defaultRoot(env)));
    validateData(path.join(appRoot, 'data'));
    appRoot = await persistLocation(pointer, appRoot);
  }
  const data = validateData(path.join(appRoot, 'data'));
  resolvedRoot = appRoot;
  resolvedData = data;
  pointerFile = pointer;
  explicitMode = false;
}

export async function changeAppDirectory(ui: Console): Promise<boolean> {
  const currentData = appDataDir();
  const currentRoot = resolvedRoot ?? path.dirname(currentData);
  ui.text('只切换 AutoGit 软件根目录，不移动、复制或删除旧 data；请先备份并手工搬运需要保留的数据。');
  const nextRoot = validateRoot(await ui.ask('新的软件根目录', currentRoot));
  const nextData = validateData(path.join(nextRoot, 'data'));
  if (nextRoot === currentRoot && nextData === currentData) { ui.text('软件根目录没有变化。'); return false; }
  if (!(await ui.confirm(`确认切换到 ${nextRoot}？旧 data 将保留原样。`))) return false;
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

/** Switch only after a caller has copied and verified the destination. Never moves data itself. */
export async function activateAppDirectory(nextRootValue: string): Promise<{ persisted: boolean; dataDir: string }> {
  const nextRoot = validateRoot(nextRootValue); const nextData = validateData(path.join(nextRoot, 'data'));
  if (pointerFile && !explicitMode) {
    await readLocation(pointerFile);
    await persistLocation(pointerFile, nextRoot, true);
  }
  resolvedRoot = nextRoot; resolvedData = nextData;
  return { persisted: !!pointerFile && !explicitMode, dataDir: nextData };
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
}
