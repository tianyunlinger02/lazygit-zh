/** Shared personal-repository prompts; API authorization is separate from Git transport. */
import path from 'node:path';
import { GitError } from './git.js';
import { PersonalGithubClient, PersonalGithubError, type PersonalGithubProgress } from './github-personal.js';
import { loginName, repositoryUrl, safeDisplay, validateRepositoryName, type CreatedRepository, type Visibility } from './github.js';
import type { Console } from './ui.js';
import type { TaskProgress } from './task-progress.js';

export interface PersonalRepositoryDraft {
  readonly client: PersonalGithubClient;
  readonly owner: string;
  readonly name: string;
  readonly visibility: Visibility;
}

export async function preparePersonalRepository(ui: Console, directory: string, account: string, checkContext: () => Promise<void>, task?: TaskProgress): Promise<PersonalRepositoryDraft | undefined> {
  const owner = loginName(account);
  const onProgress = (event: PersonalGithubProgress): void => {
    if (event.kind === 'start') {
      if (event.phase === 'create-write') task?.start('create', '创建 GitHub 仓库');
      else task?.check(event.phase === 'verification-read' ? '只读核对仓库结果' : '核对 GitHub 账号');
    } else if (event.kind === 'sent') task?.set('create', 'unknown', '创建请求已发送，正在等待明确结果。');
    else if (event.kind === 'created') task?.set('create', 'done', `${repositoryUrl(owner, draftName)}；GitHub 已返回 201，仓库信息仍待核对。`);
  };
  let draftName = '';
  const client = new PersonalGithubClient(owner, {
    recovery: async (error) => {
      ui.warn(error.message);
      ui.text('只读核验暂时不可用；已有 Token 保留，暂存输入只留在本次核验中，不会自动保存。重试仅重复这次 GET 核验，不会重发建库请求。');
      return await ui.menu('只读核验未完成', ['重新核验（保留本次已填内容）']) === 1;
    },
    onProgress,
  });
  task?.cleanup(() => client.dispose());
  await checkContext();
  if (!await client.authenticate(ui, checkContext)) return undefined;
  await checkContext();
  let suggested = '';
  try { suggested = validateRepositoryName(path.basename(directory)); }
  catch (error) { if (!(error instanceof GitError)) throw error; }
  ui.text(`这里填写 GitHub 网页上的仓库名称，不是账号名或本地远程别名。地址格式：https://github.com/${owner}/仓库名称`);
  if (!suggested) ui.text('当前文件夹名不能直接用作 GitHub 仓库名，请填写英文、数字、点、下划线或连字符；不会自动改写文件夹名。');
  let name: string;
  for (;;) {
    try { name = validateRepositoryName(await ui.ask(suggested ? 'GitHub 仓库名称（回车采用方括号中的建议）' : 'GitHub 仓库名称（例如 my-project）', suggested)); break; }
    catch (error) { if (!(error instanceof GitError)) throw error; ui.error(error.message); }
  }
  draftName = name;
  const choice = await ui.menu('仓库可见性（必须明确选择）', ['Private 私有（推荐）', 'Public 公开（任何人都能看到）']);
  if (!choice) return undefined;
  return Object.freeze({ client, owner, name, visibility: choice === 1 ? 'private' : 'public' });
}

export async function confirmPersonalRepository(ui: Console, draft: PersonalRepositoryDraft, details: string): Promise<boolean> {
  ui.text(safeDisplay(`GitHub API 账号 / 仓库所有者：${draft.owner}\n仓库：${draft.owner}/${draft.name}\n地址：${repositoryUrl(draft.owner, draft.name)}\n可见性：${draft.visibility}\n${details}`));
  ui.text('将创建空仓库，不添加 README、.gitignore、许可证或初始提交。API 账号核验不代表仓库推送权限已验证；HTTPS 使用 Token，SSH 才需要公钥授权。');
  return ui.confirm('最终确认：创建以上 GitHub 个人空仓库？');
}

export interface PersonalCreationResult { repository: CreatedRepository; recovered: boolean; uncertain: boolean }
/** Recovery can inspect a previous write, never replay it. Local continuation is separately confirmed by its caller. */
export async function createPersonalRepository(ui: Console, draft: PersonalRepositoryDraft, beforeWrite: () => Promise<void>, task: TaskProgress): Promise<PersonalCreationResult | undefined> {
  const { client, owner, name, visibility } = draft;
  const url = repositoryUrl(owner, name);
  try {
    const repository = await client.createRepository(owner, name, visibility, (createdUrl) => {
      task.set('create', 'done', `${createdUrl}；已创建，正在核对仓库信息。`);
      ui.success(`GitHub 仓库已创建：${createdUrl}；正在核对仓库信息。`);
    }, beforeWrite);
    task.set('create', 'done', `${repository.htmlUrl}；信息已核对。`);
    return { repository, recovered: false, uncertain: false };
  } catch (error) {
    if (!(error instanceof PersonalGithubError)) throw error;
    if (error.repositoryState === 'not-created') {
      if (error.phase === 'create-write') task.set('create', 'failed', 'GitHub 未接受创建请求。');
      else task.set('create', 'pending', '创建请求尚未发送。');
      throw error;
    }
    const uncertain = error.repositoryState === 'unknown';
    task.set('create', uncertain ? 'unknown' : 'done', `${url}；${uncertain ? '创建请求结果待核对' : '已返回 201，信息验证未完成'}。`);
    if (['session', 'pin', 'debug', 'terminal'].includes(error.code)) throw error;
    ui.warn(error.message);
    if (await ui.menu('先检查远端结果，不重复创建', ['只读检查以上仓库（仅 GET，不重新创建）']) !== 1) return undefined;
    await beforeWrite();
    let repository: CreatedRepository;
    try { repository = await client.inspectRepository(owner, name, visibility, beforeWrite); }
    catch (inspectionError) {
      if (!uncertain && inspectionError instanceof PersonalGithubError) {
        throw new PersonalGithubError(`GitHub 已返回 201，仓库已创建：${url}。只读核对仍未完成；不会重复创建。${inspectionError.message}`, {
          code: inspectionError.code, phase: inspectionError.phase, repositoryState: 'created', repositoryUrl: url, status: inspectionError.status,
        });
      }
      throw inspectionError;
    }
    await beforeWrite();
    task.set('create', uncertain ? 'unknown' : 'done', `${repository.htmlUrl}；${uncertain ? '已核对仓库存在，但不能确认由本次请求创建' : '已创建且信息已核对'}。`);
    ui.text(uncertain ? '已核对仓库存在；这不能证明它由刚才的请求创建。没有重新发送建库请求，也没有自动关联或上传。' : '已只读核对创建结果，没有再次创建。');
    return { repository, recovered: true, uncertain };
  }
}
