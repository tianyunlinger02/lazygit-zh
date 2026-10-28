/** Pull request collaboration through the GitHub API; no local checkout or branch changes. */
import { GithubClient, inputText, objectResponse, positiveNumber, repositoryPath, safeDisplay, textField, type RepositoryContext } from './github.js';
import { GitError } from './git.js';
import { githubAction, githubSession, chooseRepository, confirmGithubWrite, pagedSelection, readBody, assertHost, listResponse, PAGE_SIZE, type GithubSession } from './github-repositories.js';
import type { Console } from './ui.js';

export interface PullRequestSummary { number: number; title: string; state: string; draft: boolean; author: string; head: string; base: string; merged: boolean; }
const PR_FIELDS = ['number', 'title', 'state', 'draft', 'author', 'head', 'base', 'merged'] as const;
const PR_PROJECT = '{number: .number, title: .title, state: .state, draft: .draft, author: .user.login, head: .head.ref, base: .base.ref, merged: (.merged_at != null)}';
export function parsePullRequest(value: unknown): PullRequestSummary {
  const data = objectResponse(value, PR_FIELDS);
  if (typeof data.number !== 'number' || !Number.isSafeInteger(data.number) || data.number < 1 || typeof data.draft !== 'boolean' || typeof data.merged !== 'boolean') throw new GitError('GitHub PR 字段无效。');
  for (const key of ['title', 'state', 'author', 'head', 'base']) textField(data[key]);
  return { number: data.number, title: data.title as string, state: data.state as string, draft: data.draft, author: data.author as string, head: data.head as string, base: data.base as string, merged: data.merged };
}
export async function listPullRequests(client: GithubClient, context: RepositoryContext, page = 1, state = 'open'): Promise<PullRequestSummary[]> {
  assertHost(client, context); positiveNumber(page); if (!['open', 'closed', 'all'].includes(state)) throw new GitError('PR 状态必须是 open、closed 或 all。');
  return listResponse(await client.readJson(`${repositoryPath(context)}/pulls?state=${state}&per_page=${PAGE_SIZE}&page=${page}`, `map(${PR_PROJECT})`)).map(parsePullRequest);
}
export interface PullRequestView { readonly summary: PullRequestSummary; readonly body: string; readonly diff: string; readonly comments: readonly { author: string; body: string; created: string }[] }
export async function viewPullRequestFull(client: GithubClient, context: RepositoryContext, number: number): Promise<PullRequestView> {
  assertHost(client, context); positiveNumber(number);
  const raw = objectResponse(await client.readJson(`${repositoryPath(context)}/pulls/${number}`, '{number: .number, title: .title, state: .state, draft: .draft, author: .user.login, head: .head.ref, base: .base.ref, merged: (.merged_at != null), body: .body}'), ['number', 'title', 'state', 'draft', 'author', 'head', 'base', 'merged', 'body']);
  const summary = parsePullRequest({ number: raw.number, title: raw.title, state: raw.state, draft: raw.draft, author: raw.author, head: raw.head, base: raw.base, merged: raw.merged });
  const commentsValue = listResponse(await client.readJson(`${repositoryPath(context)}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=1`, 'map({author: .user.login, body: .body, created: .created_at})'));
  const comments = commentsValue.map((value) => { const row = objectResponse(value, ['author', 'body', 'created']); return { author: textField(row.author), body: textField(row.body, true), created: textField(row.created) }; });
  return { summary, body: textField(raw.body, true), diff: await client.readDiff(`${repositoryPath(context)}/pulls/${number}`), comments };
}
export async function viewPullRequest(client: GithubClient, context: RepositoryContext, number: number): Promise<PullRequestSummary> {
  return (await viewPullRequestFull(client, context, number)).summary;
}
export async function createPullRequest(client: GithubClient, context: RepositoryContext, title: string, body: string, head: string, base: string, draft = false): Promise<PullRequestSummary | undefined> {
  assertHost(client, context); inputText(title); inputText(body, true); inputText(head); inputText(base);
  const value = await client.writeJson('POST', `${repositoryPath(context)}/pulls`, { title, body, head, base, draft }, PR_PROJECT);
  return value === undefined ? undefined : parsePullRequest(value);
}
export async function commentPullRequest(client: GithubClient, context: RepositoryContext, number: number, body: string): Promise<void> { assertHost(client, context); positiveNumber(number); inputText(body, true); await client.writeJson('POST', `${repositoryPath(context)}/issues/${number}/comments`, { body }); }
export async function reviewPullRequest(client: GithubClient, context: RepositoryContext, number: number, event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body: string): Promise<void> { assertHost(client, context); positiveNumber(number); inputText(body, true); if (!['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(event)) throw new GitError('PR review 事件无效。'); await client.writeJson('POST', `${repositoryPath(context)}/pulls/${number}/reviews`, { body, event }); }
export async function mergePullRequest(client: GithubClient, context: RepositoryContext, number: number, method: 'merge' | 'squash' | 'rebase', commitTitle?: string): Promise<void> {
  assertHost(client, context); positiveNumber(number); if (!['merge', 'squash', 'rebase'].includes(method)) throw new GitError('合并策略无效。'); if (commitTitle) inputText(commitTitle);
  const response = objectResponse(await client.writeJson('PUT', `${repositoryPath(context)}/pulls/${number}/merge`, { merge_method: method, ...(commitTitle ? { commit_title: commitTitle } : {}) }, '{merged: .merged}'), ['merged']);
  if (response.merged !== true) throw new GitError('GitHub 未确认 PR 已合并；请检查冲突、分支保护和检查状态。不会自动重试。');
}
export async function setPullRequestState(client: GithubClient, context: RepositoryContext, number: number, state: 'open' | 'closed'): Promise<void> { assertHost(client, context); positiveNumber(number); if (!['open', 'closed'].includes(state)) throw new GitError('PR 状态无效。'); await client.writeJson('PATCH', `${repositoryPath(context)}/pulls/${number}`, { state }); }
async function choosePr(ui: Console, session: GithubSession, context: RepositoryContext): Promise<PullRequestSummary | undefined> {
  const state = (await ui.menu('PR 状态', ['open', 'closed', 'all', '直接输入编号'])); if (!state) return undefined;
  if (state === 4) {
    const number = positiveNumber(await ui.ask('PR 编号'));
    const pr = parsePullRequest(await session.client.readJson(`${repositoryPath(context)}/pulls/${number}`, PR_PROJECT));
    if (pr.number !== number) throw new GitError('PR 编号不一致。');
    return pr;
  }
  return pagedSelection(ui, 'Pull requests', (page) => listPullRequests(session.client, context, page, ['open', 'closed', 'all'][state - 1]), (pr) => `#${pr.number} ${pr.title} · ${pr.state} · ${pr.author}`);
}
async function commentsMenu(ui: Console, session: GithubSession, context: RepositoryContext, number: number): Promise<void> {
  for (;;) {
    const choice = await ui.menu('PR 评论 / Reviews / 行内讨论', ['普通评论（分页）', 'Reviews（分页）', '行内评论（分页）']); if (!choice) return;
    const endpoint = choice === 1 ? `${repositoryPath(context)}/issues/${number}/comments` : `${repositoryPath(context)}/pulls/${number}/${choice === 2 ? 'reviews' : 'comments'}`;
    await pagedSelection(ui, 'PR 讨论（选择仅查看）', async (page) => listResponse(await session.client.readJson(`${endpoint}?per_page=${PAGE_SIZE}&page=${page}`, 'map({author: .user.login, body: .body, created: (.created_at // .submitted_at), path: (.path // ""), state: (.state // "")})')).map((value) => objectResponse(value, ['author', 'body', 'created', 'path', 'state'])), (row) => `${row.author} · ${row.created} · ${row.state} · ${row.path}\n${row.body}`);
  }
}
export async function pullRequestsMenu(ui: Console, directory: string): Promise<void> {
  const session = await githubSession(ui, directory); if (!session) return;
  const selected = await chooseRepository(ui, session); if (!selected) return; let context: RepositoryContext = selected;
  for (;;) {
    const choice = await ui.menu(`Pull requests · ${context.owner}/${context.name}`, ['列出 PR', '查看 PR', '创建 PR', '评论 PR', 'review：approve / request-changes / comment', '合并 PR（服务端）', '关闭 PR', '重新打开 PR', '重新选择仓库']);
    if (!choice) return;
    await githubAction(ui, async () => {
      if (choice === 9) { context = await chooseRepository(ui, session) ?? context; return; }
      if (choice === 1) { await pagedSelection(ui, 'Pull requests', (page) => listPullRequests(session.client, context, page), (pr) => `#${pr.number} ${pr.title} · ${pr.state} · ${pr.author}`); return; }
      const pr = choice === 2 || choice >= 4 ? await choosePr(ui, session, context) : undefined;
      if (choice === 2) {
        if (pr) {
          const full = await viewPullRequestFull(session.client, context, pr.number), detail = full.summary;
          ui.text(safeDisplay(`#${detail.number} ${detail.title}\n${detail.state} · ${detail.author}\n${detail.head} → ${detail.base}\n${full.body}`));
          for (;;) { const action = await ui.menu('查看 PR 内容', ['完整 diff（可能含机密，至多 16 MiB）', '普通评论 / Reviews / 行内讨论（分页）']); if (!action) break; if (action === 1) ui.text(safeDisplay(full.diff) || '没有 diff。'); else await commentsMenu(ui, session, context, pr.number); }
        }
        return;
      }
      if (choice === 3) {
        const title = inputText(await ui.ask('PR 标题')); const body = await readBody(ui); const head = inputText(await ui.ask('head 分支或 owner:branch')); const base = inputText(await ui.ask('base 分支', 'main')); const draftChoice = await ui.menu('草稿状态', ['正式 PR', '草稿 PR']); if (!draftChoice) return; const draft = draftChoice === 2;
        if (await confirmGithubWrite(ui, session, context, '创建 PR', `标题：${title}\nhead：${head}\nbase：${base}\n草稿：${draft ? '是' : '否'}\n正文：\n${body}`)) { const created = await createPullRequest(session.client, context, title, body, head, base, draft); if (created) ui.text(`已创建 PR #${created.number}。`); }
        return;
      }
      if (!pr) return;
      if (choice === 4) { const body = await readBody(ui); if (await confirmGithubWrite(ui, session, context, '评论 PR', `PR #${pr.number}\n正文：\n${body}`)) await commentPullRequest(session.client, context, pr.number, body); return; }
      if (choice === 5) { const eventChoice = await ui.menu('review 类型', ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']); if (!eventChoice) return; const body = await readBody(ui); if (await confirmGithubWrite(ui, session, context, '提交 PR review', `PR #${pr.number}\n事件：${['APPROVE', 'REQUEST_CHANGES', 'COMMENT'][eventChoice - 1]}\n正文：\n${body}`)) await reviewPullRequest(session.client, context, pr.number, ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'][eventChoice - 1] as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body); return; }
      if (choice === 6) { const method = await ui.menu('合并策略', ['merge commit', 'squash', 'rebase']); if (!method) return; const title = await ui.ask('可选合并提交标题（空则默认）', '', { allowEmpty: true }); if (await confirmGithubWrite(ui, session, context, '合并 PR（服务端）', `PR #${pr.number}\n策略：${['merge', 'squash', 'rebase'][method - 1]}`)) await mergePullRequest(session.client, context, pr.number, ['merge', 'squash', 'rebase'][method - 1] as 'merge' | 'squash' | 'rebase', title || undefined); return; }
      const state = choice === 7 ? 'closed' : 'open'; if (await confirmGithubWrite(ui, session, context, state === 'closed' ? '关闭 PR' : '重新打开 PR', `PR #${pr.number}`)) await setPullRequestState(session.client, context, pr.number, state);
    });
  }
}
export const prMenu = pullRequestsMenu;
export const pullRequestMenu = pullRequestsMenu;
