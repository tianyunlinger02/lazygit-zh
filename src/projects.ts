import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { appDataDir } from './app-context.js';
import { Git, GitError } from './git.js';
import { ProfileStore } from './profiles.js';
import { Cancelled, type Console } from './ui.js';
import { checkedPath, exactKeys, MISSING, readJson, record, text, withStoreLock, writeJson } from './storage.js';

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
      if (choice === 1 || choice === 2) { try { await store.touch(item.path); return item.path; } catch (error) { ui.text(`项目路径不可用：${error instanceof Error ? error.message : String(error)}`); } }
      else if (choice === 4) await store.setFavorite(item.project_id, !item.favorite);
      else if (choice === 5) { if (await ui.confirm(`移除项目记录 ${item.label}？不会删除项目文件。`)) await store.remove(item.project_id); }
      else if (choice === 6) {
        const next = await ui.ask('新项目绝对路径'); const updated = await store.remap(item.path, next);
        ui.text('已按旧绝对路径重新映射项目记录、账号绑定与主机配置；不会按同名项目猜测。');
        if (directory === item.path) return updated.path;
      }
    } catch (error) { if (error instanceof Cancelled) ui.text('已返回，未修改项目记录。'); else if (error instanceof GitError || error instanceof Error && 'code' in error) ui.text(`项目操作未完成：${error.message}`); else throw error; }
  }
}
