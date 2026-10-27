/** Optional git-lfs integration. No downloads, global installs, or history migrations. */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Git, GitError, redact, validateGitUrl, type GitRunOptions } from './git.js';
import { resolveBinding } from './profiles.js';
import { projectGit, remoteContext } from './workflows.js';
import { Cancelled, type Console } from './ui.js';
import { resolveTransport } from './hosts.js';
import type { ProcessResult } from './process.js';

type Directory = string | Git;
/** Only the git-lfs boundary is injectable; ordinary Git always remains the existing Git implementation. */
export type LfsRunner = (repo: Git, args: readonly string[], options: GitRunOptions) => Promise<ProcessResult>;
export interface LfsOptions { runLfs?: LfsRunner }
const nativeLfs: LfsRunner = (repo, args, options) => repo.run(['lfs', ...args], options);
async function repository(directory: Directory): Promise<Git> { return (directory instanceof Git ? directory : await projectGit(directory)).repository(); }
async function run(repo: Git, args: readonly string[], options: LfsOptions, interactive = false, check = true): Promise<ProcessResult> {
  const result = await (options.runLfs ?? nativeLfs)(repo, args, { interactive, check: false });
  if (check && result.status) throw new GitError(`Git LFS 操作失败；已完成步骤不会自动回滚。\n${redact(Git.output(result)).trim() || '请检查原生终端提示。'}`);
  return result;
}
const missingHelp = '未找到可用的 git-lfs。Git 本身不包含 LFS：请从 https://git-lfs.com/ 或系统包管理器手工安装，并重新打开终端。AutoGit 不会自动下载或安装依赖；已有 LFS 指针文件不等于实际大文件内容。';
export async function diagnoseLfs(ui: Console, directory: Directory, options: LfsOptions = {}): Promise<boolean> {
  const repo = await repository(directory);
  let result: ProcessResult;
  try { result = await run(repo, ['version'], options, false, false); }
  catch (error) { if (error instanceof Cancelled) throw error; if (!(error instanceof GitError)) throw error; ui.text(missingHelp); ui.text(redact(error.message)); return false; }
  if (result.status) { ui.text(missingHelp); ui.text(redact(Git.output(result)).trim()); return false; }
  ui.text(redact(Git.output(result)).trim());
  ui.text('可用：本地 install、track / untrack、status、fetch / pull / push。不迁移历史，不删除 LFS 对象，不自动修改已有提交。');
  ui.text(redact(Git.output(await run(repo, ['env'], options))).trim());
  return true;
}
async function requireLfs(repo: Git, options: LfsOptions): Promise<void> { if ((await run(repo, ['version'], options, false, false)).status) throw new GitError(missingHelp); }
async function ready(repo: Git): Promise<void> { if (await repo.operation() || (await repo.changes()).some(change => change.conflict)) throw new GitError('仓库有未完成操作或冲突，请先处理。'); }

export async function installLfs(ui: Console, directory: Directory, options: LfsOptions = {}): Promise<void> {
  const repo = await repository(directory); await requireLfs(repo, options);
  ui.text(`仅为 ${JSON.stringify(repo.directory)} 安装 LFS 本地过滤配置及 pre-push hook；不改全局配置，不覆盖已有不兼容 hook。linked worktree 的本地配置可能由 common-dir 共享。`);
  if (!await ui.routineConfirm('执行 git lfs install --local？')) return;
  await run(repo, ['install', '--local'], options, true);
  ui.text('本地 LFS 安装已完成。遇到已有 hook 时请手工整合；不会自动 --force 覆盖。');
}

/** JSON quoting preserves whitespace/control escapes that the normal Console.ask trims. */
export function parseLfsPattern(input: string): string {
  let value = input;
  if (input.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(input); if (typeof parsed !== 'string') throw new Error('not string'); value = parsed; }
    catch { throw new GitError('pattern 的 JSON 字符串无效；例如 " leading *.bin "。'); }
  }
  if (!value || value.includes('\0') || /[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/gu, ''))) throw new GitError('pattern 不能为空或包含 NUL / 无法无损传递的字节；没有替换 pattern。');
  return value;
}
export async function trackLfs(ui: Console, directory: Directory, untrack = false, options: LfsOptions = {}): Promise<void> {
  const repo = await repository(directory); await requireLfs(repo, options); await ready(repo);
  ui.text('输入 glob pattern，例如 *.psd；首尾空格 / 换行等请用 JSON 双引号字符串表达（如 " leading *.bin "），不会按空格拆分。不自动添加、提交文件，不改写历史。');
  const pattern = parseLfsPattern(await ui.ask(untrack ? '取消跟踪的 pattern' : '跟踪的 pattern'));
  ui.text(`${untrack ? 'untrack' : 'track'} pattern（精确值）：${JSON.stringify(pattern)}\n只修改 .gitattributes；已经提交的大文件不会自动迁移，untrack 也不会删除远程对象。`);
  if (!await ui.routineConfirm('应用上述 LFS pattern？')) return;
  await ready(repo);
  await run(repo, [untrack ? 'untrack' : 'track', '--', pattern], options, true);
  ui.text('操作完成。请查看 .gitattributes 差异并自行暂存 / 提交。');
}
export async function statusLfs(ui: Console, directory: Directory, options: LfsOptions = {}): Promise<void> {
  const repo = await repository(directory); await requireLfs(repo, options);
  ui.text(redact(Git.output(await run(repo, ['track'], options))).trim());
  ui.text(redact(Git.output(await run(repo, ['status'], options))).trim());
  ui.text(redact(Git.output(await run(repo, ['ls-files'], options))).trim());
}

async function validateAddress(address: string): Promise<void> {
  try { validateGitUrl(address); return; } catch (error) { if (!(error instanceof GitError)) throw error; }
  let local = address;
  if (address.startsWith('file://')) { try { local = decodeURIComponent(new URL(address).pathname); } catch { throw new GitError('LFS 远程地址无效。'); } }
  if (path.isAbsolute(local)) {
    try { if ((await stat(local)).isDirectory() && await new Git(local).value('rev-parse', '--is-bare-repository') === 'true') return; }
    catch (error) { if (error instanceof Cancelled) throw error; }
  }
  throw new GitError('LFS 远程不是支持的 SSH/HTTPS URL 或本地 bare 仓库。');
}
interface LfsTarget { remote: string; urls: string[]; effectiveUrls: string[]; env: string; endpoints: string[]; config: string; endpointSettings: string; identity: string }
function endpointSettings(raw: Buffer): string {
  return raw.toString('utf8').split('\0').filter(entry => /^(?:lfs\.(?:url|pushurl)|remote\..*\.(?:lfsurl|lfspushurl|url|pushurl))\n/u.test(entry)).map(entry => { const newline = entry.indexOf('\n'); return `${entry.slice(0, newline)}=${JSON.stringify(entry.slice(newline + 1))}`; }).join('\n');
}
async function target(repo: Git, remote: string, push: boolean, options: LfsOptions): Promise<LfsTarget> {
  const urls = await repo.remoteUrls(remote, push);
  if (urls.length !== 1) throw new GitError('LFS 需要单一明确的远程 URL，请先拆分多个目标。');
  for (const url of urls) await validateAddress(url);
  const effective = await repo.value('ls-remote', '--get-url', urls[0]); await validateAddress(effective);
  const effectiveUrls = [effective];
  const environment = Git.output(await run(repo, ['env'], options));
  const endpoints: string[] = [];
  const wanted = `Endpoint (${remote})=`;
  // The selected remote's Endpoint line, not the default remote's unrelated endpoint.
  let entries = environment.split(/\r?\n/u).filter(line => line.startsWith(wanted));
  if (!entries.length) entries = environment.split(/\r?\n/u).filter(line => line.startsWith('Endpoint='));
  for (const line of entries) { const value = line.slice(line.indexOf('=') + 1).replace(/ \(auth=.*\)$/u, ''); if (value) endpoints.push(value); }
  // Capture all endpoint/SSH settings too: .lfsconfig and lfs.url can redirect away from Git remotes.
  const configRaw = (await repo.run(['config', '--null', '--get-regexp', '^(lfs\\.|remote\\..*\\.(lfsurl|lfspushurl|url|pushurl))'], { check: false })).stdout;
  const fileConfig = (await repo.run(['config', '--file', '.lfsconfig', '--null', '--get-regexp', '^lfs\\.(url|pushurl)$'], { check: false })).stdout;
  const config = Buffer.concat([configRaw, Buffer.from([0]), fileConfig]).toString('base64');
  const endpointSettingsValue = [endpointSettings(configRaw), fileConfig.length ? `.lfsconfig:\n${endpointSettings(fileConfig)}` : ''].filter(Boolean).join('\n');
  const binding = await resolveBinding(repo.directory);
  return { remote, urls, effectiveUrls, env: environment, endpoints, config, endpointSettings: endpointSettingsValue, identity: JSON.stringify([binding, await resolveTransport(repo.directory)]) };
}

export async function transferLfs(ui: Console, directory: Directory, operation: 'fetch' | 'pull' | 'push', options: LfsOptions = {}): Promise<void> {
  let repo = await repository(directory); await requireLfs(repo, options);
  if (operation === 'pull') await ready(repo);
  const remotes = await repo.remotes(); if (!remotes.length) throw new GitError('没有远程；请先关联 Git 远程。');
  const labels = await Promise.all(remotes.map(async name => `${name} → ${redact((await repo.remoteUrls(name, operation === 'push')).join(', '))}`));
  const choice = await ui.menu(`LFS ${operation}：选择实际远程（不会替换 origin）`, labels); if (!choice) return;
  const remote = remotes[choice - 1]; if (remote.startsWith('-')) throw new GitError('LFS 不支持以 - 开头的远程名，请先重命名。');
  const urls = await repo.remoteUrls(remote, operation === 'push');
  const transportUrls: string[] = [];
  for (const url of urls) { await validateAddress(url); transportUrls.push(url); const effective = await repo.value('ls-remote', '--get-url', url); await validateAddress(effective); transportUrls.push(effective); }
  repo = await remoteContext(ui, repo, [...new Set(transportUrls)]);
  // Command-scoped defaults make `lfs env` and transfer agree on the selected remote;
  // disable autodetection/search across other remotes without persisting any config.
  const defaults: Record<string, string> = { 'remote.lfsdefault': remote, 'remote.lfspushdefault': remote, 'lfs.remote.autodetect': 'false', 'lfs.remote.searchall': 'false' };
  const branch = await repo.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { check: false });
  if (!branch.status) defaults[`branch.${branch.stdout.toString('utf8').trim()}.remote`] = remote;
  repo = repo.configured(defaults);
  const preview = await target(repo, remote, operation === 'push', options);
  const binding = await resolveBinding(repo.directory);
  ui.text(`项目：${JSON.stringify(repo.directory)}\n操作：LFS ${operation}\n实际远程：${remote}\nGit URL：${preview.urls.map(redact).join(', ')}\n实际传输 URL：${preview.effectiveUrls.map(redact).join(', ')}\n身份：${binding ? `${binding.label} / ${binding.github_login}` : '无 AutoGit 绑定；使用该 URL 对应的原生 Git 凭据配置'}\nLFS endpoint：${preview.endpoints.map(redact).join(', ') || '工具未给出，核对下方完整 env'}\nEndpoint 配置（可能来自 .lfsconfig / remote.*.lfsurl）：${redact(preview.endpointSettings) || '（无）'}\n${redact(preview.env).trim()}`);
  ui.text('endpoint 可能由 .lfsconfig / lfs.url 指向独立服务；请核对其域名与权限。保留实际远程和受控身份，不自动改成 origin，不下载 git-lfs。');
  let ref = '';
  if (operation === 'push') {
    ref = await repo.value('rev-parse', '--verify', 'HEAD');
    ui.text(`只上传当前 HEAD 的 LFS 对象：${ref}；不上传所有历史、不推送 Git 分支。`);
  } else ui.text(operation === 'pull' ? '下载当前检出引用的 LFS 对象并更新工作区文件，不执行 Git pull；脏文件由 LFS 保护。' : '下载当前检出引用的 LFS 对象，不切换分支、不修改工作区。');
  // Daily transfers keep quick mode; changing endpoint configuration is not part of this operation.
  if (!await ui.routineConfirm('确认以上 LFS endpoint、实际远程、身份和传输范围？')) return;
  const fresh = await target(repo, remote, operation === 'push', options);
  if (!isDeepStrictEqual(preview, fresh)) throw new GitError('LFS 远程 / endpoint / 身份配置在确认期间变化，请重新预览；没有传输。');
  if (operation === 'pull') await ready(repo);
  if (ref && await repo.value('rev-parse', '--verify', 'HEAD') !== ref) throw new GitError('HEAD 在确认期间变化，请重新预览。');
  await run(repo, [operation, remote, ...ref ? [ref] : []], options, true);
  ui.text(`LFS ${operation} 完成；没有迁移历史或推送 Git 分支。`);
}

export async function lfsMenu(ui: Console, directory: string): Promise<string | undefined> {
  const choice = await ui.menu('Git LFS / 大文件', ['工具诊断 / endpoint 配置', 'install --local（不改全局）', 'track pattern', 'untrack pattern', 'status / 已跟踪文件', 'fetch（只下载对象）', 'pull（下载并检出大文件）', 'push（当前 HEAD 的对象）']);
  if (choice === 1) await diagnoseLfs(ui, directory);
  else if (choice === 2) await installLfs(ui, directory);
  else if (choice === 3 || choice === 4) await trackLfs(ui, directory, choice === 4);
  else if (choice === 5) await statusLfs(ui, directory);
  else if (choice >= 6 && choice <= 8) await transferLfs(ui, directory, (['fetch', 'pull', 'push'] as const)[choice - 6]);
  return undefined;
}
