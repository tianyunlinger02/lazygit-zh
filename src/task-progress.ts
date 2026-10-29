/** One in-memory task, truthful stage facts, and one outermost outcome summary. */
import { redact } from './git.js';
import { safeDisplay } from './github.js';
import type { Console } from './ui.js';

export type TaskStage = 'create' | 'associate' | 'commit' | 'upload' | 'upstream';
export type TaskStatus = 'pending' | 'not-applicable' | 'reused' | 'running' | 'done' | 'partial' | 'unknown' | 'failed';
const stages: readonly TaskStage[] = ['create', 'associate', 'commit', 'upload', 'upstream'];
const labels: Record<TaskStage, string> = { create: '仓库创建', associate: '本地关联', commit: '本地提交', upload: '远端上传', upstream: '默认同步目标' };
const statuses: Record<TaskStatus, string> = { pending: '未执行', 'not-applicable': '无需执行', reused: '沿用已有', running: '进行中', done: '已完成', partial: '部分完成', unknown: '结果待核对', failed: '失败' };
interface StageFact { status: TaskStatus; detail: string }
const display = (value: string): string => safeDisplay(redact(value));

export class TaskProgress {
  private readonly facts = new Map<TaskStage, StageFact>();
  private readonly cleanups: (() => void | Promise<void>)[] = [];
  private readonly notes = new Set<string>();
  private finished = false;
  private current: TaskStage | undefined;
  constructor(private readonly ui: Console) {
    for (const stage of stages) this.facts.set(stage, { status: 'pending', detail: '' });
  }
  status(stage: TaskStage): TaskStatus { return this.facts.get(stage)!.status; }
  set(stage: TaskStage, status: TaskStatus, detail = ''): void {
    this.facts.set(stage, { status, detail: display(detail) });
    if (this.current === stage && status !== 'running') this.current = undefined;
  }
  start(stage: TaskStage, message: string): void {
    this.current = stage; this.set(stage, 'running'); this.check(message);
  }
  check(message: string): void { this.ui.text(display(`正在${message}……`)); }
  note(message: string): void { this.notes.add(display(message)); }
  cleanup(callback: () => void | Promise<void>): void { this.cleanups.push(callback); }
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.current && this.status(this.current) === 'running') this.set(this.current, 'failed', '此步骤未确认完成；已完成的其他步骤会保留。');
    try {
      this.ui.title('本次操作结果');
      for (const stage of stages) {
        const fact = this.facts.get(stage)!;
        this.ui.text(`${labels[stage]}：${statuses[fact.status]}${fact.detail ? ` · ${fact.detail}` : ''}`);
      }
      for (const note of this.notes) this.ui.text(note);
      if (this.status('upload') === 'done' && ['partial', 'failed', 'unknown'].includes(this.status('upstream'))) this.ui.text('下一步：仅检查默认同步目标，不必重复上传。');
      else if (this.status('upload') === 'unknown') this.ui.text('下一步：先核对远端分支；本地提交保留，不自动再次上传或强推。');
      else if (this.status('create') === 'unknown') this.ui.text('下一步：先只读检查仓库是否存在，不要直接重复创建。');
      else if (this.status('commit') === 'unknown') this.ui.text('下一步：先检查本地 HEAD 和提交历史，不自动重复提交。');
      else if (this.status('create') === 'done' && !['done', 'reused'].includes(this.status('associate'))) this.ui.text('下一步：先核对已创建的仓库，再选择关联已有仓库；不会删除或重建。');
    } finally {
      for (const cleanup of this.cleanups.reverse()) {
        try { await cleanup(); }
        catch {
          try { this.ui.warn('本次任务的临时资源清理未确认完成；请退出 AutoGit 锁定会话。'); } catch { /* Continue releasing resources even when terminal output fails. */ }
        }
      }
    }
  }
}

export async function withTask<T>(ui: Console, existing: TaskProgress | undefined, action: (task: TaskProgress) => Promise<T>): Promise<T> {
  if (existing) return action(existing);
  const task = new TaskProgress(ui);
  let failed = false;
  try { return await action(task); }
  catch (error) { failed = true; throw error; }
  finally {
    try { await task.finish(); }
    catch (error) { if (!failed) throw error; }
  }
}
