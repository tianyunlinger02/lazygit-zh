import * as path from 'node:path';
import { GitError } from './git.js';
import type { Console } from './ui.js';
import { MISSING, exactKeys, readJson, record, withStoreLock, writeJson } from './storage.js';
import { appDataDir, changeAppDirectory } from './app-context.js';
import { currentSession, readNewPassword } from './session.js';

export const NOTICE_VERSION = 1;
export const PREFERENCES_FILE = 'settings.json';
export const DEFAULTS: Preferences = { schema_version: 1, interaction_mode: 'quick', notice_version: 0, last_project: '' };
export interface Preferences { schema_version: number; interaction_mode: 'quick' | 'confirm'; notice_version: number; last_project: string }

function validate(data: unknown): Preferences {
  if (!record(data) || !exactKeys(data, Object.keys(DEFAULTS)) || data.schema_version !== 1 || (data.interaction_mode !== 'quick' && data.interaction_mode !== 'confirm') || typeof data.notice_version !== 'number' || !Number.isInteger(data.notice_version) || data.notice_version < 0 || typeof data.last_project !== 'string') {
    throw new GitError('使用设置已损坏；没有自动覆盖，请检查 AutoGit 文件夹中的 data/settings.json。');
  }
  return { schema_version: 1, interaction_mode: data.interaction_mode, notice_version: data.notice_version, last_project: data.last_project };
}

export async function loadPreferences(): Promise<Preferences> {
  const data = await readJson(path.join(appDataDir(), PREFERENCES_FILE));
  return data === MISSING ? { ...DEFAULTS } : validate(data);
}

export async function savePreferences(changes: Partial<Omit<Preferences, 'schema_version'>>): Promise<Preferences> {
  const allowed = new Set(['interaction_mode', 'notice_version', 'last_project']);
  if (Object.keys(changes).some((key) => !allowed.has(key))) throw new GitError('未知的使用设置。');
  const directory = appDataDir();
  try {
    return await withStoreLock(directory, async () => {
      const data = validate({ ...(await loadPreferences()), ...changes });
      await writeJson(path.join(directory, 'settings.json'), data);
      return data;
    });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EACCES') throw new GitError('AutoGit 文件夹不可写，请将整个软件放到你有写入权限的文件夹后再启动。', { cause: error });
    throw error;
  }
}

export function preferencesFile(): string { return path.join(appDataDir(), PREFERENCES_FILE); }
export const validatePreferences = validate;

export function folderHelp(ui: Console): void {
  ui.title('保管好你的 AutoGit 文件夹');
  ui.text('账号、托管密钥、项目绑定、项目收藏、主机与传输配置、主机指纹和使用设置都保存在 AutoGit 的 data 文件夹。独立的 projects.json、hosts.json 等配置不会改变 profiles schema 2 或 settings schema 1。');
  ui.text(currentSession() ? '当前使用加密凭据库：每次启动输入独立的 AutoGit 解锁密码；托管私钥和 Token 仅在本次会话中解锁。公钥、署名、路径等元数据未加密。恢复码请与资料目录分开保管。' : '旧版记住认证使用免口令私钥；旧资料和旧备份仍可能包含明文，必须登录后完成加密迁移。不要分享或公开上传含 data 的软件副本。');
  ui.text('若文件夹泄露：到 GitHub → Settings → SSH and GPG keys 删除对应公钥，再在 AutoGit 换新密钥；仅删除本地文件不会撤销权限。');
  ui.text('撤销入口：https://github.com/settings/keys；同时检查 GitHub 账号安全记录。干净发行包不包含你的 data。');
}

export async function startup(ui: Console): Promise<Preferences> {
  let data = await loadPreferences();
  ui.quick = data.interaction_mode === 'quick';
  if (data.notice_version < NOTICE_VERSION) {
    folderHelp(ui);
    data = await savePreferences({ notice_version: NOTICE_VERSION });
  }
  return data;
}

export async function changeUnlockPassword(ui: Console): Promise<void> {
  const session = currentSession();
  if (!session || session.closed) throw new GitError('请重新启动 AutoGit 解锁后再修改密码。');
  ui.text('修改本资料库的独立 AutoGit 密码，不修改系统或 GitHub 密码。原恢复码仍有效；旧备份和其他已解锁进程不受影响。');
  let oldPassword: Buffer | undefined, newPassword: Buffer | undefined;
  try {
    oldPassword = await ui.secret('当前 AutoGit 解锁密码：');
    newPassword = await readNewPassword(ui);
    await session.vault.changePassword(oldPassword, newPassword);
    ui.text('AutoGit 解锁密码已修改，下次启动使用新密码。本次会话保持解锁，原恢复码仍有效。');
  } finally { oldPassword?.fill(0); newPassword?.fill(0); }
}
export async function settingsMenu(ui: Console): Promise<void> {
  const choice = await ui.menu('使用设置', ['快捷模式：选好任务后直接执行（推荐）', '详细模式：每一步都确认', '查看文件夹保管 / 泄露后的处理', '切换到另一个已有软件根目录（不搬运旧 data）', '备份 / 恢复 / 搬迁完整资料', '立即锁定并退出（下次启动重新登录）', '修改 AutoGit 解锁密码（忘记密码请在启动时用恢复码）']);
  if (choice === 1 || choice === 2) {
    const mode = choice === 1 ? 'quick' : 'confirm';
    await savePreferences({ interaction_mode: mode }); ui.quick = mode === 'quick'; ui.text(ui.quick ? '已启用快捷模式。删除密钥、丢弃工作等操作仍会确认。' : '已启用详细确认模式。');
  } else if (choice === 3) folderHelp(ui);
  else if (choice === 4 && await changeAppDirectory(ui)) await startup(ui);
  else if (choice === 5) { const { backupMenu } = await import('./backup.js'); await backupMenu(ui); await startup(ui); }
  else if (choice === 6) { await currentSession()?.close(); ui.text('本次凭据会话已锁定，请重新启动 AutoGit 登录。'); }
  else if (choice === 7) await changeUnlockPassword(ui);
}

export const load = loadPreferences;
export async function save(changes: Partial<Omit<Preferences, 'schema_version'>>): Promise<Preferences> { return savePreferences(changes); }
export const settings_menu = settingsMenu;
export const folder_help = folderHelp;
