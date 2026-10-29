import * as crypto from 'node:crypto';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { appDataDir } from './app-context.js';
import { clone, chooseDirectory } from './workflows.js';
import { decodePath, encodePath, Git, GitError } from './git.js';
import { credentialsMenu } from './credentials.js';
import { profilesMenu, ProfileStore } from './profiles.js';
import { Cancelled, type Console } from './ui.js';
import { checkedPath, exactKeys, isErrno, MISSING, readJson, record, text, withStoreLock, writeJson } from './storage.js';

export interface ProjectRecord { project_id: string; path: string; label: string; favorite: boolean; last_used: number }
const PROJECT_KEYS = ['project_id', 'path', 'label', 'favorite', 'last_used'];
const ID = /^[0-9a-f]{32}$/u;
function projectId(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) throw new GitError('项目标识无效。'); return value; }
function projectPath(value: unknown): string {
  const result = text(value);
  if (!(path.isAbsolute(result) || /^[A-Za-z]:[\\/]/u.test(result) || result.startsWith('\\\\')) || result.split(/[\\/]/u).includes('..')) throw new GitError('项目路径必须是规范化绝对路径。');
  return result;
}
function recordValue(value: unknown): ProjectRecord {
  if (!record(value) || !exactKeys(value, PROJECT_KEYS) || projectId(value.project_id) !== value.project_id || projectPath(value.path) !== value.path || typeof value.label !== 'string' || !value.label.trim() || /[\x00-\x1f\x7f-\x9f]/u.test(value.label) || typeof value.favorite !== 'boolean' || typeof value.last_used !== 'number' || !Number.isSafeInteger(value.last_used) || value.last_used < 0) throw new GitError('projects.json 项目记录无效；未覆盖。');
  return { project_id: value.project_id, path: value.path, label: value.label, favorite: value.favorite, last_used: value.last_used };
}
function normalize(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value; }
export class ProjectStore {
  readonly directory: string;
  readonly file: string;
  constructor(directory = appDataDir()) { this.directory = checkedPath(directory, 'dir', { missing: true }); this.file = path.join(directory, 'projects.json'); }
  async list(): Promise<ProjectRecord[]> {
    const data = await readJson(this.file);
    if (data === MISSING) return [];
    if (!record(data) || !exactKeys(data, ['schema_version', 'projects']) || data.schema_version !== 1 || !Array.isArray(data.projects)) throw new GitError('projects.json 结构或版本无效；未覆盖。');
    const records = data.projects.map(recordValue);
    const ids = new Set<string>(); const paths = new Set<string>();
    for (const item of records) { if (ids.has(item.project_id) || paths.has(normalize(item.path))) throw new GitError('projects.json 含重复项目；未覆盖。'); ids.add(item.project_id); paths.add(normalize(item.path)); }
    return records.sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.last_used - a.last_used || a.label.localeCompare(b.label));
  }
  private async save(projects: ProjectRecord[]): Promise<void> { await writeJson(this.file, { schema_version: 1, projects }); }
  async add(directory: string, label = path.basename(directory)): Promise<ProjectRecord> {
    const root = await this.root(directory); const name = text(label);
    return withStoreLock(this.directory, async () => {
      const records = await this.list(); const existing = records.find((item) => normalize(item.path) === normalize(root));
      if (existing) { existing.label = name; existing.last_used = Date.now(); await this.save(records); return existing; }
      const item: ProjectRecord = { project_id: crypto.randomBytes(16).toString('hex'), path: root, label: name, favorite: false, last_used: Date.now() };
      await this.save([...records, item]); return item;
    });
  }
  async touch(directory: string): Promise<ProjectRecord> {
    const root = await this.root(directory);
    return withStoreLock(this.directory, async () => {
      const records = await this.list(); const item = records.find((value) => normalize(value.path) === normalize(root));
      if (!item) return this.addUnlocked(root, path.basename(root), records);
      item.last_used = Date.now(); await this.save(records); return item;
    });
  }
  private async addUnlocked(root: string, label: string, records: ProjectRecord[]): Promise<ProjectRecord> {
    const item: ProjectRecord = { project_id: crypto.randomBytes(16).toString('hex'), path: root, label: text(label), favorite: false, last_used: Date.now() }; await this.save([...records, item]); return item;
  }
  async setFavorite(projectIdValue: string, favorite: boolean): Promise<void> {
    projectId(projectIdValue);
    await withStoreLock(this.directory, async () => { const records = await this.list(); const item = records.find((value) => value.project_id === projectIdValue); if (!item) throw new GitError('项目不存在。'); item.favorite = favorite; await this.save(records); });
  }
  async remove(projectIdValue: string): Promise<boolean> {
    projectId(projectIdValue);
    return withStoreLock(this.directory, async () => { const records = await this.list(); const item = records.find((value) => value.project_id === projectIdValue); if (!item) return false; await this.save(records.filter((value) => value.project_id !== projectIdValue)); return true; });
  }
  async remap(oldDirectory: string, nextDirectory: string): Promise<ProjectRecord> {
    const oldRoot = projectPath(oldDirectory); const nextRoot = await this.root(nextDirectory);
    if (normalize(oldRoot) === normalize(nextRoot)) throw new GitError('新旧项目路径相同。');
    return withStoreLock(this.directory, async () => {
      const records = await this.list(); const item = records.find((value) => normalize(value.path) === normalize(oldRoot)); if (!item) throw new GitError('没有匹配的旧项目路径；不会按同名猜测。');
      if (records.some((value) => normalize(value.path) === normalize(nextRoot))) throw new GitError('新项目路径已登记；不会合并记录。');
      const { remapDataPaths } = await import('./backup.js');
      await new ProfileStore(this.directory).validateMetadata();
      await remapDataPaths(this.directory, { [item.path]: nextRoot });
      item.path = nextRoot; item.last_used = Date.now(); await this.save(records); return item;
    });
  }
  async root(directory: string): Promise<string> { const root = await new Git(directory).root(); return projectPath(root); }
}
export async function listProjects(): Promise<ProjectRecord[]> { return new ProjectStore().list(); }

async function startupDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new GitError('项目快捷路径必须是绝对路径。');
  try {
    if (!(await stat(encodePath(directory))).isDirectory()) throw new GitError('该路径不是文件夹。');
    return decodePath(await realpath(encodePath(directory), { encoding: 'buffer' }));
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) throw new GitError('该文件夹已不存在或路径不可用。');
    throw error;
  }
}

function startupError(error: unknown): error is Error { return error instanceof Error && (error instanceof GitError || 'code' in error); }

function outsideCredentialDirectory(directory: string): void {
  const relative = path.relative(normalize(appDataDir()), normalize(directory));
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new GitError('不能在 AutoGit 凭据资料目录 data 内创建项目；请选择独立的项目文件夹。');
  }
}

async function createStartupDirectory(directory: string): Promise<string> {
  outsideCredentialDirectory(directory);
  const parents: string[] = [];
  let parent = path.dirname(directory);
  for (;;) {
    try {
      const info = await lstat(encodePath(parent));
      if (!info.isDirectory() || info.isSymbolicLink()) throw new GitError('项目父目录不是普通文件夹，或在选择期间发生变化。');
      break;
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      parents.push(parent); parent = path.dirname(parent);
    }
  }
  for (const next of [...parents.reverse(), directory]) {
    outsideCredentialDirectory(next);
    const expected = path.dirname(next);
    if (normalize(await startupDirectory(expected)) !== normalize(expected)) throw new GitError('项目父目录在选择期间发生变化；请重新选择路径。');
    try { await mkdir(encodePath(next)); }
    catch (error) {
      if (isErrno(error, 'EEXIST')) throw new GitError('该路径已存在，未覆盖或清空任何内容；请换一个新路径，或选择“打开已有本地文件夹”。');
      throw error;
    }
  }
  const created = await startupDirectory(directory);
  if (normalize(created) !== normalize(directory)) throw new GitError('项目目录在创建期间发生变化；已创建的目录保留，请重新选择。');
  return created;
}

async function startupDownload(ui: Console, current: string): Promise<string | undefined> {
  for (;;) {
    const choice = await ui.menu('下载项目与准备账号', ['下载已有远程项目', '管理账号与密钥（新建 / 导入）', '录入加密 HTTPS Token']);
    if (!choice) return undefined;
    if (choice === 2) await profilesMenu(ui, current);
    else if (choice === 3) await credentialsMenu(ui, current);
    else {
      try { return await clone(ui, current); }
      catch (error) {
        if (startupError(error)) ui.warn('下载未确认成功；已有文件和可能的部分下载目录会保留，不自动重试或删除。');
        throw error;
      }
    }
  }
}

/** Startup only selects a local folder; the caller owns recency and last_project persistence. */
export async function chooseStartupProject(ui: Console, current: string, lastProject: string): Promise<string | undefined> {
  ui.text('请选择本次要打开的项目。普通非 Git 文件夹也可以；打开或新建文件夹不会自动初始化 Git、提交或上传。');
  for (;;) {
    try {
      const shortcuts: { label: string; source: string; directory: string }[] = [];
      for (const [label, source] of [['继续上次项目', lastProject], ['使用当前目录', current]]) {
        if (!source) continue;
        try {
          const directory = await startupDirectory(source);
          if (!shortcuts.some(item => normalize(item.directory) === normalize(directory))) shortcuts.push({ label, source, directory });
        } catch (error) {
          if (!startupError(error)) throw error;
          ui.warn(`${label}路径不可用：${JSON.stringify(source)}；${error.message}。可选择其他文件夹，原记录保持不变。`);
        }
      }
      const choice = await ui.menu('启动项目选择', [
        ...shortcuts.map(item => `${item.label} — ${JSON.stringify(item.directory)}`),
        '打开已有本地文件夹', '创建新的本地文件夹', '下载远程项目 / 准备账号与 Token', '最近使用 / 收藏项目',
      ], '退出');
      if (!choice) return undefined;
      if (choice <= shortcuts.length) {
        const item = shortcuts[choice - 1], directory = await startupDirectory(item.source);
        if (normalize(directory) !== normalize(item.directory)) throw new GitError('项目路径在选择期间发生变化；请重新选择。');
        return directory;
      }
      const action = choice - shortcuts.length;
      if (action === 1) return await startupDirectory(await chooseDirectory(ui, current));
      if (action === 2) {
        const directory = await createStartupDirectory(await chooseDirectory(ui, current, { existing: false }));
        ui.success(`已创建本地文件夹：${JSON.stringify(directory)}；尚未初始化 Git、提交或上传。`);
        return directory;
      }
      if (action === 3) {
        const directory = await startupDownload(ui, current);
        if (directory !== undefined) return await startupDirectory(directory);
        continue;
      }
      const records = await new ProjectStore().list();
      if (!records.length) { ui.text('尚无最近使用或收藏项目；可以打开、新建或下载项目。'); continue; }
      const selected = await ui.menu('选择最近 / 收藏项目', records.map(item => `${item.favorite ? '[收藏] ' : ''}${item.label} — ${JSON.stringify(item.path)}`));
      if (!selected) continue;
      const item = records[selected - 1];
      try { return await startupDirectory(item.path); }
      catch (error) {
        if (!startupError(error)) throw error;
        ui.warn(`项目记录路径不可用：${JSON.stringify(item.path)}；${error.message}。记录未移除或更新，请重新选择。`);
      }
    } catch (error) {
      if (error instanceof Cancelled) { if (error.warning) ui.warn(error.message); else ui.text('已返回启动项目选择；未自动进入当前目录。'); }
      else if (startupError(error)) ui.error(`项目选择未完成：${error.message}`);
      else throw error;
    }
  }
}

export async function projectsMenu(ui: Console, directory: string): Promise<string | undefined> {
  const store = new ProjectStore();
  try { await store.touch(directory); } catch (error) { if (!(error instanceof GitError)) throw error; }
  for (;;) {
    const records = await store.list();
    const choice = await ui.menu('项目收藏与最近使用', ['打开已登记项目', '搜索项目', '登记当前项目', '收藏 / 取消收藏项目', '移除项目记录', '重新映射已登记路径']);
    if (!choice) return directory;
    try {
      if (choice === 3) { const label = await ui.ask('项目显示名', path.basename(directory)); await store.add(directory, label); continue; }
      if (!records.length) { ui.text('尚无项目记录。'); continue; }
      let candidates = records;
      if (choice === 2) { const query = (await ui.ask('搜索（路径或名称）')).toLocaleLowerCase(); candidates = records.filter((item) => `${item.label} ${item.path}`.toLocaleLowerCase().includes(query)); if (!candidates.length) { ui.text('没有匹配项目。'); continue; } }
      const selected = await ui.menu('选择项目', candidates.map((item) => `${item.favorite ? '[收藏] ' : ''}${item.label} — ${item.path}`)); if (!selected) continue;
      const item = candidates[selected - 1];
      if (choice === 1 || choice === 2) { try { await store.touch(item.path); return item.path; } catch (error) { ui.warn(`项目路径不可用：${error instanceof Error ? error.message : String(error)}`); } }
      else if (choice === 4) await store.setFavorite(item.project_id, !item.favorite);
      else if (choice === 5) { if (await ui.confirm(`移除项目记录 ${item.label}？不会删除项目文件。`)) await store.remove(item.project_id); }
      else if (choice === 6) {
        const next = await ui.ask('新项目绝对路径'); const updated = await store.remap(item.path, next);
        ui.success('已按旧绝对路径重新映射项目记录、账号绑定与主机配置；不会按同名项目猜测。');
        if (directory === item.path) return updated.path;
      }
    } catch (error) {
      if (error instanceof Cancelled) { if (error.warning) ui.warn(error.message); else ui.text('已返回，未修改项目记录。'); }
      else if (error instanceof GitError || error instanceof Error && 'code' in error) ui.error(`项目操作未完成：${error.message}`);
      else throw error;
    }
  }
}
