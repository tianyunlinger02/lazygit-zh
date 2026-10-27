/** Pull request workflows: gh API metadata plus profile-bound native Git checkout. */
import { GithubClient, inputText, objectResponse, positiveNumber, repositoryContext, repositoryPath, safeDisplay, textField, type RepositoryContext } from './github.js';
import { GitError, type Git } from './git.js';
import { repositoryStamp, verifyRepositoryStamp } from './destructive.js';
import { worktreeRecords } from './worktrees.js';
import { profileGit } from './profiles.js';
import { transportUrl } from './hosts.js';
import { githubAction, githubSession, githubTransport, transportSummary, chooseRepository, confirmGithubWrite, confirmGithubRoutine, pagedSelection, readBody, assertHost, listResponse, PAGE_SIZE, type GithubSession } from './github-repositories.js';
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
function branchName(number: number): string { return `autogit-pr-${positiveNumber(number)}`; }
async function branchOID(repo: Git, branch: string): Promise<string | undefined> {
  const result = await repo.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { check: false });
  if (result.status === 1) return undefined;
  if (result.status || !/^[0-9a-f]{40,64}$/u.test(result.stdout.toString().trim())) throw new GitError('无法核对本地分支对象，请重新预览。');
  return result.stdout.toString().trim();
}
export async function checkoutPullRequest(ui: Console, session: GithubSession, context: RepositoryContext, pr: PullRequestSummary): Promise<void> {
  assertHost(session.client, context); positiveNumber(pr.number);
  const projection = '{number: .number, sha: .head.sha, head: {ref: .head.ref, owner: .head.repo.owner.login, name: .head.repo.name}, base: {owner: .base.repo.owner.login, name: .base.repo.name}}';
  const raw = await session.client.readJson(`${repositoryPath(context)}/pulls/${pr.number}`, projection);
  const data = objectResponse(raw, ['number', 'sha', 'head', 'base']);
  if (data.number !== pr.number || !/^[0-9a-f]{40,64}$/u.test(textField(data.sha))) throw new GitError('PR 编号或 head SHA 无效。');
  const head = objectResponse(data.head, ['ref', 'owner', 'name']), base = objectResponse(data.base, ['owner', 'name']);
  const headContext = repositoryContext(context.host, textField(head.owner), textField(head.name));
  if (textField(base.owner).toLowerCase() !== context.owner.toLowerCase() || textField(base.name).toLowerCase() !== context.name.toLowerCase()) throw new GitError('PR base 仓库与选定上下文不一致。');
  const transport = githubTransport(session, context);
  const remote = transportUrl(`${headContext.owner}/${headContext.name}`, transport), ref = `refs/heads/${textField(head.ref)}`;
  const fetched = `refs/autogit/pull-requests/${pr.number}/${data.sha}`;
  let repo = await (await profileGit(session.directory, session.profile, transport)).repository();
  await repo.ensureReady();
  const originalBranch = await repo.branch(), originalOID = await branchOID(repo, originalBranch), stamp = await repositoryStamp(repo);
  let branch = branchName(pr.number), mode: 'create' | 'switch' | 'rebuild' = 'create', previousOID: string | undefined;
  for (;;) {
    if (branch.startsWith('-') || branch === 'HEAD' || (await repo.run(['check-ref-format', `refs/heads/${branch}`], { check: false })).status) {
      ui.text('本地分支名称无效，请使用另一个名称。'); branch = await ui.ask('新本地分支名称', branchName(pr.number)); continue;
    }
    previousOID = await branchOID(repo, branch);
    if (!previousOID) break;
    const choice = await ui.menu(`本地分支 ${safeDisplay(branch)} 已存在 · ${previousOID}`, ['换一个本地分支名称', '仅切换已有分支（不 fetch、不更新，不保证是最新 PR）', '明确重建该分支到预览的 PR SHA（替换分支指向）']);
    if (!choice) return;
    if (choice === 1) { branch = await ui.ask('新本地分支名称', `${branchName(pr.number)}-new`); continue; }
    mode = choice === 2 ? 'switch' : 'rebuild'; break;
  }
  const validate = async (): Promise<void> => {
    await session.checkProfile();
    await repo.ensureReady();
    if (await repo.branch() !== originalBranch || await branchOID(repo, originalBranch) !== originalOID) throw new GitError('当前分支或其对象在预览后改变，请重新预览。');
    await verifyRepositoryStamp(repo, stamp);
    if ((await repo.run(['check-ref-format', ref], { check: false })).status) throw new GitError('PR head 分支无效。');
    if (await branchOID(repo, branch) !== previousOID) throw new GitError('目标本地分支在预览后改变或出现，请重新选择。');
    if ((await worktreeRecords(repo)).some((item) => item.branch === `refs/heads/${branch}` && item.path !== repo.directory)) throw new GitError('目标分支被其他 worktree 占用；不会切换、重建或绕过 Git 保护。');
    if ((await repo.value('ls-remote', '--get-url', remote)).toLowerCase() !== remote.toLowerCase()) throw new GitError('Git URL 重写改变了 PR fetch 目标，已停止。');
  };
  const verifyMetadata = async (): Promise<void> => {
    if (JSON.stringify(await session.client.readJson(`${repositoryPath(context)}/pulls/${pr.number}`, projection)) !== JSON.stringify(raw)) throw new GitError('确认期间 PR head 或归属改变，请重新预览。');
  };
  await validate();
  const details = `PR #${pr.number}\n来源：${remote}\n传输：${transportSummary(transport)}\nhead：${ref}\n预览 PR SHA：${data.sha}\n本地分支：${branch}\n${mode === 'switch' ? `仅切换已有分支，OID：${previousOID}；不 fetch、不更新，不保证是最新 PR。` : mode === 'rebuild' ? `明确重建分支指向：\n旧 OID：${previousOID}\n新 OID：${data.sha}\n旧分支独有提交可能失去分支引用；不自动备份、不 stash、不丢弃本地修改。` : '新建本地分支；Git 可保留的本地修改随切换保留，有覆盖冲突时停止。'}\n不会 push、fork、添加 remote 或设置上游。`;
  if (!await (mode === 'rebuild' ? confirmGithubWrite(ui, session, context, '明确重建本地 PR 分支', details, { scope: 'local' }) : confirmGithubRoutine(ui, session, context, mode === 'switch' ? '仅切换已有本地 PR 分支（不更新）' : 'fetch 并 checkout PR', details))) return;
  if (mode !== 'switch') await session.client.ensureActor();
  await verifyMetadata();
  repo = await (await profileGit(session.directory, session.profile, transport)).repository(); await validate();
  if (mode !== 'switch') {
    await repo.run(['fetch', '--no-tags', '--no-write-fetch-head', '--', remote, `${ref}:${fetched}`], { interactive: true });
    if (await repo.value('rev-parse', '--verify', fetched) !== data.sha) throw new GitError('获取的 PR SHA 与预览不一致；已获取的 ref 保留，不会切换或自动回滚。');
    await verifyMetadata();
  }
  await validate();
  await repo.run(mode === 'switch' ? ['switch', '--no-overwrite-ignore', '--', branch] : ['switch', '--no-overwrite-ignore', '--no-track', mode === 'rebuild' ? '--force-create' : '--create', branch, textField(data.sha)], { interactive: true });
  const expectedOID = mode === 'switch' ? previousOID : data.sha;
  if (await repo.branch() !== branch || await branchOID(repo, branch) !== expectedOID || await repo.value('rev-parse', '--verify', 'HEAD') !== expectedOID) throw new GitError('切换已执行，但分支或对象随后改变；请只读核对，不会自动回滚。');
  await session.checkProfile();
  ui.text(mode === 'switch' ? `已仅切换到已有本地分支 ${branch}（${previousOID}）；未 fetch、未更新，不保证是最新 PR。` : `已切换到本地分支 ${branch}（${data.sha}）；未设置 upstream 或 push。`);
}
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
    const choice = await ui.menu(`Pull requests · ${context.owner}/${context.name}`, ['列出 PR', '查看 PR', '创建 PR', 'checkout PR（原生 Git + 明确传输模式）', '评论 PR', 'review：approve / request-changes / comment', '合并 PR', '关闭 PR', '重新打开 PR', '重新选择仓库']);
    if (!choice) return;
    await githubAction(ui, async () => {
      if (choice === 10) { context = await chooseRepository(ui, session) ?? context; return; }
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
      if (choice === 4) { await checkoutPullRequest(ui, session, context, pr); return; }
      if (choice === 5) { const body = await readBody(ui); if (await confirmGithubWrite(ui, session, context, '评论 PR', `PR #${pr.number}\n正文：\n${body}`)) await commentPullRequest(session.client, context, pr.number, body); return; }
      if (choice === 6) { const eventChoice = await ui.menu('review 类型', ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']); if (!eventChoice) return; const body = await readBody(ui); if (await confirmGithubWrite(ui, session, context, '提交 PR review', `PR #${pr.number}\n事件：${['APPROVE', 'REQUEST_CHANGES', 'COMMENT'][eventChoice - 1]}\n正文：\n${body}`)) await reviewPullRequest(session.client, context, pr.number, ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'][eventChoice - 1] as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body); return; }
      if (choice === 7) { const method = await ui.menu('合并策略', ['merge commit', 'squash', 'rebase']); if (!method) return; const title = await ui.ask('可选合并提交标题（空则默认）', '', { allowEmpty: true }); if (await confirmGithubWrite(ui, session, context, '合并 PR', `PR #${pr.number}\n策略：${['merge', 'squash', 'rebase'][method - 1]}`)) await mergePullRequest(session.client, context, pr.number, ['merge', 'squash', 'rebase'][method - 1] as 'merge' | 'squash' | 'rebase', title || undefined); return; }
      const state = choice === 8 ? 'closed' : 'open'; if (await confirmGithubWrite(ui, session, context, state === 'closed' ? '关闭 PR' : '重新打开 PR', `PR #${pr.number}`)) await setPullRequestState(session.client, context, pr.number, state);
    });
  }
}
export const prMenu = pullRequestsMenu;
export const pullRequestMenu = pullRequestsMenu;
