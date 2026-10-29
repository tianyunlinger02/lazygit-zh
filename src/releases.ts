/** Tags and GitHub releases stay separate: publishing never implicitly pushes tags or creates one. */
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdtemp, open, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Git, GitError } from './git.js';
import { GithubClient, inputText, objectResponse, positiveNumber, repositoryPath, safeDisplay, textField, type RepositoryContext } from './github.js';
import { assertHost, chooseRepository, confirmGithubWrite, confirmGithubRoutine, explicitGitTransport, githubAction, githubSession, githubTransport, transportSummary, listResponse, pagedSelection, readBody, PAGE_SIZE, type GithubSession } from './github-repositories.js';
import { profileGit } from './profiles.js';
import { transportUrl } from './hosts.js';
import { checkedPath, isErrno } from './storage.js';
import type { Console } from './ui.js';

export interface Release { id: number; tag: string; name: string; body: string; draft: boolean; prerelease: boolean; published: string }
export interface ReleaseAsset { id: number; name: string; size: number; contentType: string; state: string }
const RELEASE_FIELDS = ['id', 'tag', 'name', 'body', 'draft', 'prerelease', 'published'] as const;
const RELEASE_PROJECT = '{id: .id, tag: .tag_name, name: .name, body: .body, draft: .draft, prerelease: .prerelease, published: .published_at}';
const ASSET_FIELDS = ['id', 'name', 'size', 'contentType', 'state'] as const;
const ASSET_PROJECT = '{id: .id, name: .name, size: .size, contentType: .content_type, state: .state}';
function releaseId(value: unknown): number { return positiveNumber(value); }
export function parseRelease(value: unknown): Release {
  const data = objectResponse(value, RELEASE_FIELDS);
  if (typeof data.draft !== 'boolean' || typeof data.prerelease !== 'boolean') throw new GitError('Release 布尔字段无效。');
  return { id: releaseId(data.id), tag: textField(data.tag), name: textField(data.name, true), body: textField(data.body, true), draft: data.draft, prerelease: data.prerelease, published: textField(data.published, true) };
}
export function parseAsset(value: unknown): ReleaseAsset {
  const data = objectResponse(value, ASSET_FIELDS);
  if (typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0) throw new GitError('Release 附件大小无效。');
  return { id: releaseId(data.id), name: textField(data.name), size: data.size, contentType: textField(data.contentType), state: textField(data.state) };
}
export async function listReleases(client: GithubClient, context: RepositoryContext, page = 1): Promise<Release[]> { assertHost(client, context); positiveNumber(page); return listResponse(await client.readJson(`${repositoryPath(context)}/releases?per_page=${PAGE_SIZE}&page=${page}`, `map(${RELEASE_PROJECT})`)).map(parseRelease); }
export async function viewRelease(client: GithubClient, context: RepositoryContext, id: number): Promise<Release> { assertHost(client, context); releaseId(id); const result = parseRelease(await client.readJson(`${repositoryPath(context)}/releases/${id}`, RELEASE_PROJECT)); if (result.id !== id) throw new GitError('Release 编号不匹配。'); return result; }
export async function createRelease(client: GithubClient, context: RepositoryContext, tag: string, name: string, body: string, draft: boolean, prerelease: boolean): Promise<Release> {
  assertHost(client, context); inputText(tag); inputText(name); inputText(body, true);
  if (!tag || tag.startsWith('-') || /[~^:?*\[\]\\\s]/u.test(tag) || tag.includes('..')) throw new GitError('Tag 名称无效。');
  // GitHub's releases POST otherwise creates missing tags. Require an existing remote tag first.
  const ref = objectResponse(await client.readJson(`${repositoryPath(context)}/git/ref/tags/${encodeURIComponent(tag)}`, '{ref: .ref}'), ['ref']);
  if (ref.ref !== `refs/tags/${tag}`) throw new GitError('远程 Tag 不存在或不匹配；请先单独创建并明确推送 Tag。');
  return parseRelease(await client.writeJson('POST', `${repositoryPath(context)}/releases`, { tag_name: tag, name, body, draft, prerelease }, RELEASE_PROJECT));
}
export async function editRelease(client: GithubClient, context: RepositoryContext, id: number, patch: { name?: string; body?: string; draft?: boolean; prerelease?: boolean }): Promise<void> {
  assertHost(client, context); releaseId(id);
  if (!Object.keys(patch).length || Object.keys(patch).some((key) => !['name', 'body', 'draft', 'prerelease'].includes(key))) throw new GitError('Release 编辑字段无效。');
  if (patch.name !== undefined) inputText(patch.name); if (patch.body !== undefined) inputText(patch.body, true);
  if (patch.draft !== undefined && typeof patch.draft !== 'boolean' || patch.prerelease !== undefined && typeof patch.prerelease !== 'boolean') throw new GitError('Release 状态无效。');
  await client.writeJson('PATCH', `${repositoryPath(context)}/releases/${id}`, patch);
}
export async function deleteRelease(client: GithubClient, context: RepositoryContext, id: number): Promise<void> { assertHost(client, context); releaseId(id); await client.writeJson('DELETE', `${repositoryPath(context)}/releases/${id}`); }
export async function listReleaseAssets(client: GithubClient, context: RepositoryContext, id: number, page = 1): Promise<ReleaseAsset[]> { assertHost(client, context); releaseId(id); positiveNumber(page); return listResponse(await client.readJson(`${repositoryPath(context)}/releases/${id}/assets?per_page=${PAGE_SIZE}&page=${page}`, `map(${ASSET_PROJECT})`)).map(parseAsset); }
export async function deleteReleaseAsset(client: GithubClient, context: RepositoryContext, id: number): Promise<void> { assertHost(client, context); releaseId(id); await client.writeJson('DELETE', `${repositoryPath(context)}/releases/assets/${id}`); }
export async function editReleaseAsset(client: GithubClient, context: RepositoryContext, id: number, name: string, label: string): Promise<void> {
  assertHost(client, context); releaseId(id); filename(name); inputText(label);
  await client.writeJson('PATCH', `${repositoryPath(context)}/releases/assets/${id}`, { name, label });
}
function filename(value: string): string {
  if (!value || value === '.' || value === '..' || value.startsWith('-') || /[/\\<>:"|?*\x00-\x1f\x7f-\x9f]/u.test(value) || /[. ]$/u.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)) throw new GitError('附件文件名不是可移植的单个普通文件名；请明确使用另一个保存名称。');
  return value;
}
interface FileIdentity { readonly dev: number; readonly ino: number; readonly birthtimeMs: number }
export interface DownloadTargetSnapshot extends FileIdentity { readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number; readonly mode: number; readonly hash: string }
export interface DownloadReleaseAssetOptions { readonly overwrite?: boolean; readonly expected?: DownloadTargetSnapshot }
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs; }
function sameFile(left: DownloadTargetSnapshot, right: DownloadTargetSnapshot): boolean { return sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode && left.hash === right.hash; }
async function downloadTargetSnapshot(file: string): Promise<DownloadTargetSnapshot | undefined> {
  checkedPath(file, 'file', { missing: true });
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (isErrno(error, 'ENOENT')) return undefined; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new GitError('保存目标必须是单链接普通文件。');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65_536); let total = 0;
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; total += bytesRead; hash.update(buffer.subarray(0, bytesRead)); }
    const after = await handle.stat(); checkedPath(file, 'file'); const current = await lstat(file);
    if (!sameIdentity(info, after) || !sameIdentity(info, current) || after.nlink !== 1 || info.size !== total || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs || info.mode !== after.mode) throw new GitError('保存文件在检查期间变化，请重新选择。');
    return { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, mode: info.mode, hash: hash.digest('hex') };
  } finally { await handle.close(); }
}
export async function downloadReleaseAsset(client: GithubClient, context: RepositoryContext, asset: ReleaseAsset, destination: string, options: DownloadReleaseAssetOptions | boolean = {}): Promise<void> {
  assertHost(client, context); releaseId(asset.id);
  if (!Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > 67_108_864 || asset.state !== 'uploaded') throw new GitError('只支持已上传且至多 64 MiB 的单附件下载。');
  const overwrite = typeof options === 'boolean' ? options : options.overwrite, suppliedExpected = typeof options === 'boolean' ? undefined : options.expected;
  if (overwrite !== undefined && typeof overwrite !== 'boolean' || suppliedExpected && overwrite !== true) throw new GitError('覆盖必须由可选参数明确选择。');
  filename(path.basename(destination)); const parent = checkedPath(path.dirname(destination), 'dir'), parentIdentity = await lstat(parent);
  const initial = await downloadTargetSnapshot(destination);
  if (initial && overwrite !== true) throw new GitError('保存文件已存在，拒绝覆盖。');
  if (suppliedExpected && (!initial || !sameFile(suppliedExpected, initial))) throw new GitError('确认期间保存文件身份或实际内容改变，请重新预览。');
  const expected = suppliedExpected ?? initial;
  const verifyTarget = async (): Promise<void> => {
    checkedPath(parent, 'dir');
    if (!sameIdentity(parentIdentity, await lstat(parent))) throw new GitError('保存目录在下载期间变化；未替换文件。');
    const current = await downloadTargetSnapshot(destination);
    if (expected ? !current || !sameFile(expected, current) : current !== undefined) throw new GitError('保存文件在下载期间出现、身份或实际内容改变；未替换文件。');
  };
  const temporaryDirectory = await mkdtemp(path.join(parent, '.autogit-asset-'));
  const temporaryIdentity = await lstat(temporaryDirectory), temporary = path.join(temporaryDirectory, 'download');
  try {
    if (process.platform !== 'win32') await chmod(temporaryDirectory, 0o700);
    checkedPath(temporaryDirectory, 'dir');
    const bytes = await client.readBytes(`${repositoryPath(context)}/releases/assets/${asset.id}`);
    if (bytes.length !== asset.size || bytes.length > 67_108_864) throw new GitError('附件下载字节数与元数据不一致；未写入保存文件。');
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const staged = await downloadTargetSnapshot(temporary);
    if (!staged || staged.size !== asset.size || staged.hash !== createHash('sha256').update(bytes).digest('hex')) throw new GitError('临时下载文件校验失败；未替换保存文件。');
    await verifyTarget();
    if (!sameIdentity(temporaryIdentity, await lstat(temporaryDirectory))) throw new GitError('私有下载目录已变化；未替换保存文件。');
    // rename replaces an explicitly approved old file atomically; link installs a new file exclusively.
    if (expected) await rename(temporary, destination);
    else await link(temporary, destination);
  } finally {
    // Never remove a user's destination, including when a download or rename fails.
    if (sameIdentity(temporaryIdentity, await lstat(temporaryDirectory))) {
      await unlink(temporary).catch((error: unknown) => { if (!isErrno(error, 'ENOENT')) throw error; });
      await rmdir(temporaryDirectory);
    }
  }
}
async function assetSnapshot(file: string): Promise<string> {
  checkedPath(file, 'file');
  if (file.includes('#')) throw new GitError('gh 附件路径不能包含 #（它会被解释为 label）；请先明确重命名文件。');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 67_108_864) throw new GitError('上传附件必须是至多 64 MiB 的单链接普通文件。');
    const bytes = Buffer.alloc(67_108_865); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    if (offset > 67_108_864) throw new GitError('附件过大。');
    return createHash('sha256').update(bytes.subarray(0, offset)).digest('hex');
  } finally { await handle.close(); }
}
async function selectRelease(ui: Console, session: GithubSession, context: RepositoryContext): Promise<Release | undefined> { return pagedSelection(ui, 'Releases', (page) => listReleases(session.client, context, page), (release) => `#${release.id} ${release.tag} · ${release.name} · ${release.draft ? 'draft' : 'published'}${release.prerelease ? ' · prerelease' : ''}`); }
export async function downloadReleaseAssetGuided(ui: Console, session: GithubSession, context: RepositoryContext, selected: Release, asset: ReleaseAsset): Promise<void> {
  const parent = checkedPath(path.resolve(await ui.ask('保存目录', session.directory)), 'dir');
  let defaultName: string; try { defaultName = filename(asset.name); } catch { defaultName = `asset-${asset.id}`; }
  for (;;) {
    let name: string;
    try { name = filename(await ui.ask('保存文件名', defaultName)); }
    catch (error) { if (!(error instanceof GitError)) throw error; ui.error(error.message); continue; }
    const destination = path.join(parent, name), expected = await downloadTargetSnapshot(destination);
    if (expected) {
      const choice = await ui.menu(`保存文件已存在：${safeDisplay(destination)}`, ['换一个保存文件名', '明确覆盖此本地文件（校验成功后原子替换）']);
      if (!choice) return;
      if (choice === 1) { defaultName = name; continue; }
    }
    const details = `Release #${selected.id}\n附件 #${asset.id} · ${asset.name}\n大小：${asset.size} bytes\n保存到：${destination}${expected ? `\n将替换原文件：${expected.size} bytes\n原文件 SHA-256：${expected.hash}\n下载或校验失败保留原文件；不会先删除旧文件。` : '\n写入新文件，不覆盖已有文件。'}`;
    if (!await (expected ? confirmGithubWrite(ui, session, context, '明确覆盖本地 Release 附件', details, { scope: 'local' }) : confirmGithubRoutine(ui, session, context, '下载 Release 附件并写入新文件', details))) return;
    await downloadReleaseAsset(session.client, context, asset, destination, expected ? { overwrite: true, expected } : {});
    ui.success('附件下载成功；未运行下载文件。'); return;
  }
}
async function assetsMenu(ui: Console, session: GithubSession, context: RepositoryContext, selected: Release): Promise<void> {
  for (;;) {
    const choice = await ui.menu(`Release 附件 · ${selected.tag}`, ['分页查看附件', '上传附件（不覆盖同名文件）', '下载附件（已有文件可换名 / 明确覆盖）', '删除远程附件', '编辑附件名称 / 标签', '明确覆盖同名附件（失败可能丢失旧附件）']); if (!choice) return;
    await githubAction(ui, async () => {
      if (choice === 2 || choice === 6) {
        const clobber = choice === 6;
        const files = [...new Set((await (ui as Console & { multiline(prompt: string, defaultValue?: string): Promise<string> }).multiline('附件绝对路径（每行一个，无 glob 展开）')).split(/\r?\n/u).filter(Boolean).map((file) => checkedPath(file, 'file')))];
        if (!files.length || files.length > 20) throw new GitError('每次明确上传 1–20 个普通附件。');
        const snapshots = await Promise.all(files.map(assetSnapshot));
        if (!await confirmGithubWrite(ui, session, context, clobber ? '覆盖上传 Release 同名附件' : '上传 Release 附件', `Release #${selected.id} · ${selected.tag}\n文件：\n${files.join('\n')}\n${clobber ? '会先删除同名旧附件再上传；中断或失败可能永久丢失旧附件。' : '不覆盖同名附件。'}多文件部分成功不会自动回滚。`)) return;
        const current = await viewRelease(session.client, context, selected.id);
        if (current.tag !== selected.tag) throw new GitError('Release Tag 已改变，请重新选择。');
        const rechecked = await Promise.all(files.map(assetSnapshot));
        if (rechecked.some((hash, index) => hash !== snapshots[index])) throw new GitError('确认期间附件内容改变，请重新预览。');
        await session.client.uploadRelease(context, selected.tag, files, { clobber }); ui.warn('附件上传请求已完成；请用列表核对全部附件。'); return;
      }
      const asset = await pagedSelection(ui, 'Release assets', (page) => listReleaseAssets(session.client, context, selected.id, page), (asset) => `#${asset.id} ${asset.name} · ${asset.size} bytes · ${asset.state}`); if (!asset) return;
      if (choice === 1) { ui.text(safeDisplay(JSON.stringify(asset, null, 2))); return; }
      if (choice === 5) {
        const name = filename(await ui.ask('新附件名称', asset.name)), label = inputText(await ui.ask('新附件标签（可清空）', '', { allowEmpty: true }));
        if (await confirmGithubWrite(ui, session, context, '编辑 Release 附件名称 / 标签', `附件 #${asset.id}\n旧名称：${asset.name}\n新名称：${name}\n新标签：${label}`)) await editReleaseAsset(session.client, context, asset.id, name, label);
        return;
      }
      if (choice === 3) await downloadReleaseAssetGuided(ui, session, context, selected, asset);
      else if (await confirmGithubWrite(ui, session, context, '永久删除远程 Release 附件', `Release #${selected.id}\n附件 #${asset.id} · ${asset.name}`)) await deleteReleaseAsset(session.client, context, asset.id);
    });
  }
}
async function tagRef(repo: Git, tag: string): Promise<string> {
  inputText(tag); const ref = `refs/tags/${tag}`;
  if (!tag || tag.startsWith('-') || (await repo.run(['check-ref-format', ref], { check: false })).status) throw new GitError('Tag 名称无效。');
  return ref;
}
export async function tagsMenu(ui: Console, session: GithubSession, context: RepositoryContext): Promise<void> {
  for (;;) {
    const choice = await ui.menu('Tag / 原生 Git', ['查看本地 Tags', '创建本地 Tag（不推送）', '删除本地 Tag（不删除远程）', '推送一个明确的 Tag', '删除一个明确的远程 Tag']); if (!choice) return;
    await githubAction(ui, async () => {
      const transport = githubTransport(session, context), remote = transportUrl(`${context.owner}/${context.name}`, transport);
      let repo = await (await profileGit(session.directory, session.profile, transport, remote)).repository();
      await repo.ensureReady();
      if (choice === 1) { ui.text(safeDisplay(await repo.value('tag', '--list', '--format=%(refname:short)  %(objectname:short)')) || '没有本地 Tag。'); return; }
      const tag = await ui.ask('明确的 Tag 名称'), ref = await tagRef(repo, tag);
      let target = '', message = '';
      if (choice === 2) {
        const source = inputText(await ui.ask('Tag 指向的提交 / 分支 / SHA', 'HEAD'));
        if (source.startsWith('-')) throw new GitError('提交不能以 - 开头。');
        target = await repo.value('rev-parse', '--verify', '--end-of-options', `${source}^{commit}`);
        message = inputText(await ui.ask('注释 Tag 说明（空则 lightweight）', '', { allowEmpty: true }));
        if (!(await repo.run(['show-ref', '--verify', '--quiet', ref], { check: false })).status) throw new GitError('本地 Tag 已存在；不会覆盖。');
      } else if (choice !== 5) target = await repo.value('rev-parse', '--verify', ref);
      if (choice >= 4) await explicitGitTransport(repo, remote, true);
      const action = ['', '', '创建本地 Tag', '删除本地 Tag', '推送单个 Tag', '删除远程 Tag'][choice];
      const confirm = choice === 2 ? confirmGithubRoutine : choice === 3 ? (ui: Console, session: GithubSession, context: RepositoryContext, action: string, details: string) => confirmGithubWrite(ui, session, context, action, details, { scope: 'local' }) : confirmGithubWrite;
      if (!await confirm(ui, session, context, action, `本地：${repo.directory}\nTag：${ref}\n对象：${target || '远程已有 Tag'}\n${choice >= 4 ? `目标：${remote}\n传输：${transportSummary(transport)}` : '不联网、不推送；远程 Tag 不变。'}${message ? `\n说明：${message}` : ''}`)) return;
      if (choice >= 4) await session.client.ensureActor();
      repo = await (await profileGit(session.directory, session.profile, transport, remote)).repository(); await repo.ensureReady();
      if (choice === 2) { if (!(await repo.run(['show-ref', '--verify', '--quiet', ref], { check: false })).status) throw new GitError('确认期间本地 Tag 已出现，拒绝覆盖。'); await repo.run(['tag', '--no-sign', ...(message ? ['--annotate', '--message', message] : []), '--', tag, target]); }
      else if (choice === 3) { if (await repo.value('rev-parse', '--verify', ref) !== target) throw new GitError('确认期间 Tag 改变，已停止。'); await repo.run(['tag', '--delete', '--', tag]); }
      else {
        const transport = await explicitGitTransport(repo, remote, true);
        if (choice === 4 && await repo.value('rev-parse', '--verify', ref) !== target) throw new GitError('确认期间本地 Tag 改变。');
        await transport.git.run(['push', '--no-follow-tags', '--', transport.remote, choice === 5 ? `:${ref}` : `${target}:${ref}`], { interactive: true });
      }
      ui.success('明确选择的 Tag 操作已完成；没有创建 Release 或推送其它引用。');
    });
  }
}
export async function releasesMenu(ui: Console, directory: string): Promise<void> {
  const session = await githubSession(ui, directory); if (!session) return;
  const selected = await chooseRepository(ui, session); if (!selected) return; let context = selected;
  for (;;) {
    const choice = await ui.menu(`Tags / Releases · ${context.owner}/${context.name}`, ['分页列表 / 查看 Release', '创建 Release（必须已有远程 Tag）', '编辑 Release', '发布 Draft', '删除 Release（保留 Tag）', 'Release 附件上传 / 下载 / 删除', 'Tag / 原生 Git', '重新选择仓库']); if (!choice) return;
    await githubAction(ui, async () => {
      if (choice === 8) { context = await chooseRepository(ui, session) ?? context; return; }
      if (choice === 7) { await tagsMenu(ui, session, context); return; }
      if (choice === 2) {
        const tag = inputText(await ui.ask('已经存在的远程 Tag')), name = inputText(await ui.ask('Release 标题', tag)), body = await readBody(ui);
        const mode = await ui.menu('发布方式', ['Draft 草稿', '正式发布', '预发布']); if (!mode) return;
        if (await confirmGithubWrite(ui, session, context, '创建 Release', `Tag：${tag}\n标题：${name}\n模式：${['Draft', '正式发布', '预发布'][mode - 1]}\n正文：\n${body}\n不隐式创建或 push Tag。`)) { const release = await createRelease(session.client, context, tag, name, body, mode === 1, mode === 3); ui.success(`已创建 Release #${release.id}。`); } return;
      }
      const release = await selectRelease(ui, session, context); if (!release) return;
      if (choice === 1) { const full = await viewRelease(session.client, context, release.id); ui.text(safeDisplay(`Release #${full.id} · ${full.tag}\n${full.name}\n${full.draft ? 'Draft' : 'Published'}${full.prerelease ? ' · Prerelease' : ''}\n${full.body}`)); return; }
      if (choice === 3) {
        const field = await ui.menu('编辑字段', ['标题', '正文（可清空）', '预发布状态']); if (!field) return;
        let patch: { name?: string; body?: string; prerelease?: boolean };
        if (field === 1) patch = { name: inputText(await ui.ask('新标题', release.name)) };
        else if (field === 2) patch = { body: await readBody(ui, release.body) };
        else { const mode = await ui.menu('预发布状态', ['正式发布', '预发布']); if (!mode) return; patch = { prerelease: mode === 2 }; }
        if (await confirmGithubWrite(ui, session, context, '编辑 Release', `Release #${release.id} · ${release.tag}\n${JSON.stringify(patch)}`)) await editRelease(session.client, context, release.id, patch);
      } else if (choice === 4) {
        if (!release.draft) { ui.warn('此 Release 已发布，不是 Draft。'); return; }
        if (await confirmGithubWrite(ui, session, context, '发布 Draft Release', `Release #${release.id} · ${release.tag}\n标题：${release.name}\n正文与附件将按当前远程内容发布。`)) await editRelease(session.client, context, release.id, { draft: false });
      } else if (choice === 5) { if (await confirmGithubWrite(ui, session, context, '永久删除 Release 及全部远程附件', `Release #${release.id} · ${release.tag}\n不删除本地或远程 Tag。`)) await deleteRelease(session.client, context, release.id); }
      else if (choice === 6) await assetsMenu(ui, session, context, release);
    });
  }
}
export const releaseMenu = releasesMenu;
