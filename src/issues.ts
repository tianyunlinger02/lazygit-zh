/** Issues use the native REST API with bounded allowlisted JSON projections. */
import { GithubClient, inputText, objectResponse, positiveNumber, repositoryPath, safeDisplay, textField, type RepositoryContext } from './github.js';
import { GitError } from './git.js';
import { assertHost, chooseRepository, confirmGithubWrite, githubAction, githubSession, listResponse, pagedSelection, readBody, PAGE_SIZE, type GithubSession } from './github-repositories.js';
import type { Console } from './ui.js';

export interface IssueSummary { number: number; title: string; state: string; author: string; body: string; labels: string[]; assignees: string[] }
const FIELDS = ['number', 'title', 'state', 'author', 'body', 'labels', 'assignees'] as const;
const PROJECT = '{number: .number, title: .title, state: .state, author: .user.login, body: .body, labels: [.labels[].name], assignees: [.assignees[].login]}';
function strings(value: unknown): string[] { if (!Array.isArray(value) || value.length > 100) throw new GitError('Issue 标签 / 负责人字段无效。'); return value.map((item) => textField(item)); }
export function parseIssue(value: unknown): IssueSummary {
  const data = objectResponse(value, FIELDS);
  return { number: positiveNumber(data.number), title: textField(data.title), state: textField(data.state), author: textField(data.author, true), body: textField(data.body, true), labels: strings(data.labels), assignees: strings(data.assignees) };
}
export async function listIssues(client: GithubClient, context: RepositoryContext, page = 1, state = 'open'): Promise<IssueSummary[]> {
  assertHost(client, context); positiveNumber(page); if (!['open', 'closed', 'all'].includes(state)) throw new GitError('Issue 状态无效。');
  // REST issues lists also contain PRs: filter them before exposing the selection.
  const pageData = objectResponse(await client.readJson(`${repositoryPath(context)}/issues?state=${state}&per_page=${PAGE_SIZE}&page=${page}`, `{hasNext: (length == ${PAGE_SIZE}), items: map(select(.pull_request == null) | ${PROJECT})}`), ['hasNext', 'items']);
  if (typeof pageData.hasNext !== 'boolean') throw new GitError('Issue 分页元数据无效。');
  return Object.assign(listResponse(pageData.items).map(parseIssue), { hasNext: pageData.hasNext });
}
export async function viewIssue(client: GithubClient, context: RepositoryContext, number: number): Promise<IssueSummary> {
  assertHost(client, context); positiveNumber(number);
  const value = await client.readJson(`${repositoryPath(context)}/issues/${number}`, `if .pull_request == null then ${PROJECT} else null end`);
  if (value === null) throw new GitError('此编号是 PR，不是 Issue；请进入 PR 菜单。');
  const issue = parseIssue(value); if (issue.number !== number) throw new GitError('Issue 编号与选择不一致。'); return issue;
}
export async function createIssue(client: GithubClient, context: RepositoryContext, title: string, body: string, labels: readonly string[] = [], assignees: readonly string[] = []): Promise<IssueSummary> {
  assertHost(client, context); inputText(title); inputText(body, true); labels.forEach((label) => inputText(label)); assignees.forEach((login) => inputText(login));
  return parseIssue(await client.writeJson('POST', `${repositoryPath(context)}/issues`, { title, body, labels, assignees }, PROJECT));
}
export async function editIssue(client: GithubClient, context: RepositoryContext, number: number, patch: { title?: string; body?: string; labels?: string[]; assignees?: string[]; state?: 'open' | 'closed'; state_reason?: 'completed' | 'not_planned' | 'reopened' }): Promise<void> {
  assertHost(client, context); positiveNumber(number);
  if (!Object.keys(patch).length || Object.keys(patch).some((key) => !['title', 'body', 'labels', 'assignees', 'state', 'state_reason'].includes(key))) throw new GitError('Issue 编辑字段无效。');
  if (patch.title !== undefined) inputText(patch.title);
  if (patch.body !== undefined) inputText(patch.body, true);
  patch.labels?.forEach((value) => inputText(value)); patch.assignees?.forEach((value) => inputText(value));
  if (patch.state !== undefined && !['open', 'closed'].includes(patch.state) || patch.state_reason !== undefined && !['completed', 'not_planned', 'reopened'].includes(patch.state_reason)) throw new GitError('Issue 状态无效。');
  await viewIssue(client, context, number);
  await client.writeJson('PATCH', `${repositoryPath(context)}/issues/${number}`, patch);
}
export async function commentIssue(client: GithubClient, context: RepositoryContext, number: number, body: string): Promise<void> { assertHost(client, context); positiveNumber(number); inputText(body, true); await viewIssue(client, context, number); await client.writeJson('POST', `${repositoryPath(context)}/issues/${number}/comments`, { body }); }
function commaList(value: string): string[] { inputText(value); return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]; }
async function selectIssue(ui: Console, session: GithubSession, context: RepositoryContext): Promise<IssueSummary | undefined> {
  const state = await ui.menu('Issue 状态', ['open', 'closed', 'all', '直接输入编号']); if (!state) return undefined;
  if (state === 4) return viewIssue(session.client, context, positiveNumber(await ui.ask('Issue 编号')));
  return pagedSelection(ui, 'Issues', (page) => listIssues(session.client, context, page, ['open', 'closed', 'all'][state - 1]), (issue) => `#${issue.number} ${issue.title} · ${issue.state} · ${issue.author}`);
}
async function showComments(ui: Console, session: GithubSession, context: RepositoryContext, number: number): Promise<void> {
  await pagedSelection(ui, 'Issue 评论（选择可查看全文）', async (page) => listResponse(await session.client.readJson(`${repositoryPath(context)}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`, 'map({author: .user.login, body: .body, created: .created_at})')).map((value) => objectResponse(value, ['author', 'body', 'created'])), (row) => `${row.author} · ${row.created}\n${row.body}`);
}
export async function issuesMenu(ui: Console, directory: string): Promise<void> {
  const session = await githubSession(ui, directory); if (!session) return;
  const selected = await chooseRepository(ui, session); if (!selected) return; let context = selected;
  for (;;) {
    const choice = await ui.menu(`Issues · ${context.owner}/${context.name}`, ['分页列表 / 查看 Issue', '创建 Issue', '编辑标题 / 正文 / 标签 / 负责人', '评论 Issue', '关闭 Issue', '重新打开 Issue', '重新选择仓库']);
    if (!choice) return;
    await githubAction(ui, async () => {
      if (choice === 7) { context = await chooseRepository(ui, session) ?? context; return; }
      if (choice === 2) {
        const title = inputText(await ui.ask('Issue 标题')), body = await readBody(ui), labels = commaList(await ui.ask('标签（逗号分隔，可留空）', '', { allowEmpty: true })), assignees = commaList(await ui.ask('负责人登录名（逗号分隔，可留空）', '', { allowEmpty: true }));
        if (await confirmGithubWrite(ui, session, context, '创建 Issue', `标题：${title}\n正文：\n${body}\n标签：${labels.join(', ')}\n负责人：${assignees.join(', ')}`)) { const issue = await createIssue(session.client, context, title, body, labels, assignees); ui.text(`已创建 Issue #${issue.number}。`); }
        return;
      }
      const issue = await selectIssue(ui, session, context); if (!issue) return;
      if (choice === 1) { const full = await viewIssue(session.client, context, issue.number); ui.text(safeDisplay(`#${full.number} ${full.title}\n状态：${full.state}\n作者：${full.author}\n标签：${full.labels.join(', ')}\n负责人：${full.assignees.join(', ')}\n${full.body}`)); await showComments(ui, session, context, issue.number); return; }
      if (choice === 3) {
        const field = await ui.menu('编辑字段', ['标题', '正文（可清空）', '标签（覆盖整个列表，可清空）', '负责人（覆盖整个列表，可清空）']); if (!field) return;
        const patch = field === 1 ? { title: inputText(await ui.ask('新标题', issue.title)) } : field === 2 ? { body: await readBody(ui, issue.body) } : field === 3 ? { labels: commaList(await ui.ask('完整新标签列表（逗号分隔，空则移除全部）', '', { allowEmpty: true })) } : { assignees: commaList(await ui.ask('完整新负责人列表（逗号分隔，空则移除全部）', '', { allowEmpty: true })) };
        if (await confirmGithubWrite(ui, session, context, '编辑 Issue', `Issue #${issue.number}\n新值：${JSON.stringify(patch)}`)) await editIssue(session.client, context, issue.number, patch);
      } else if (choice === 4) { const body = await readBody(ui); if (await confirmGithubWrite(ui, session, context, '评论 Issue', `Issue #${issue.number}\n正文：\n${body}`)) await commentIssue(session.client, context, issue.number, body); }
      else {
        let reason: 'completed' | 'not_planned' | 'reopened' = 'reopened';
        if (choice === 5) { const selected = await ui.menu('关闭原因', ['completed 已完成', 'not_planned 不计划处理']); if (!selected) return; reason = selected === 1 ? 'completed' : 'not_planned'; }
        if (await confirmGithubWrite(ui, session, context, choice === 5 ? '关闭 Issue' : '重新打开 Issue', `Issue #${issue.number}\n原因：${reason}`)) await editIssue(session.client, context, issue.number, { state: choice === 5 ? 'closed' : 'open', state_reason: reason });
      }
    });
  }
}
export const issueMenu = issuesMenu;
