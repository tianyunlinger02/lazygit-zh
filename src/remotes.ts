import { Git, GitError, decodePath, redact, splitNul, validateGitUrl } from './git.js';
import { Console } from './ui.js';
import { isDeepStrictEqual } from 'node:util';
import { resolveBinding } from './profiles.js';
import { resolveTransport } from './hosts.js';
import {
  addRemote,
  projectGit,
  remoteContext,
  remoteRefOid,
  snapshotRemoteTarget,
  unchangedRemoteTarget,
  validateExistingRemote,
  type RemoteTarget,
} from './workflows.js';

type Directory = string | Git;
type Head = readonly [branch: string, oid: string];
interface CachedRemoteRef { readonly ref: string; readonly name: string; readonly oid: string; readonly subject: string }

async function repository(directory: Directory): Promise<Git> {
  return (directory instanceof Git ? directory : await projectGit(directory)).repository();
}

async function head(repo: Git): Promise<Head> {
  const result = await repo.run(['rev-parse', '--verify', 'HEAD'], { check: false });
  return [await repo.branch(), result.status === 0 ? result.stdout.toString('ascii').trim() : ''];
}

async function verifyHead(repo: Git, snapshot: Head, source?: CachedRemoteRef): Promise<void> {
  await repo.ensureReady();
  const current = await head(repo);
  if (current[0] !== snapshot[0] || current[1] !== snapshot[1]) throw new GitError('确认期间 HEAD 发生变化，请重新预览。');
  if (source) {
    const result = await repo.run(['rev-parse', '--verify', source.ref], { check: false });
    if (result.status || result.stdout.toString('ascii').trim() !== source.oid) throw new GitError('上游目标分支在确认期间发生变化，请重新预览。');
  }
}

async function cachedRemoteRefs(repo: Git): Promise<CachedRemoteRef[]> {
  const result = await repo.run(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(subject)%00%(symref)%00', 'refs/remotes/']);
  const refs: CachedRemoteRef[] = [];
  for (const record of decodePath(result.stdout).split('\0\n')) {
    if (!record) continue;
    const fields = record.split('\0');
    if (fields.length !== 4 || !fields[0].startsWith('refs/remotes/')) throw new GitError('无法识别 Git 远程缓存列表，已停止操作。');
    const [ref, oid, subject, symref] = fields;
    if (!symref) refs.push({ ref, name: ref.slice('refs/remotes/'.length), oid, subject });
  }
  return refs;
}

async function chooseRemote(ui: Console, repo: Git): Promise<string | undefined> {
  const names = await repo.remotes();
  if (!names.length) throw new GitError('当前项目还没有远程仓库。');
  const labels = await Promise.all(names.map(async name => {
    const fetch = await repo.remoteUrls(name);
    const push = await repo.remoteUrls(name, true);
    return `${name}：获取 ${redact(fetch.join(', '))}；上传 ${redact(push.join(', '))}`;
  }));
  const choice = await ui.menu('选择远程', labels);
  return choice ? names[choice - 1] : undefined;
}

async function verifyRemoteSnapshot(repo: Git, snapshot: RemoteTarget): Promise<void> {
  await unchangedRemoteTarget(repo, snapshot);
  if ((await repo.remotes()).indexOf(snapshot.remote) < 0) throw new GitError('远程在确认期间被移除，未执行操作。');
}

export async function fetchRemote(ui: Console, directory: Directory): Promise<void> {
  let repo = await repository(directory);
  await repo.ensureReady();
  const snapshot = await head(repo);
  const remote = await chooseRemote(ui, repo); if (!remote) return;
  const urls = await validateExistingRemote(repo, remote, false);
  repo = await remoteContext(ui, repo, urls);
  ui.text(`来源：${redact(urls[0])}\n目标：当前仓库的远程缓存；不 prune，不合并，不 stash，不 push。`);
  if (!await ui.routineConfirm('确认单独联网 fetch 这个远程？')) return;
  await verifyHead(repo, snapshot);
  if (!isDeepStrictEqual(urls, await validateExistingRemote(repo, remote, false))) throw new GitError('确认期间远程地址发生变化，请重新预览。');
  await repo.run(['fetch', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--', remote]);
  ui.text('fetch 已完成；工作区与当前分支没有自动合并。');
}

export async function setUpstream(ui: Console, directory: Directory): Promise<void> {
  const repo = await repository(directory);
  await repo.ensureReady();
  const snapshot = await head(repo);
  if (!snapshot[1]) throw new GitError('当前分支还没有提交，不能设置上游。');
  const refs = await cachedRemoteRefs(repo);
  if (!refs.length) throw new GitError('没有可用的远程缓存分支；请单独选择 fetch，不会自动联网。');
  const choice = await ui.menu('选择当前分支的上游（远程缓存）', refs.map(ref => `[远程缓存] ${ref.name} | ${ref.oid} | ${JSON.stringify(ref.subject)}`));
  if (!choice) return;
  const source = refs[choice - 1];
  ui.text(`本地：${snapshot[0]}\nOID：${snapshot[1]}\n摘要：${JSON.stringify(await repo.value('show', '-s', '--format=%s', snapshot[1]))}`);
  ui.text(`上游目标（缓存）：${source.name}\nOID：${source.oid}\n摘要：${JSON.stringify(source.subject)}`);
  if (!await ui.routineConfirm(`设置 ${snapshot[0]} 的上游为 ${source.name}？（不联网）`)) return;
  await verifyHead(repo, snapshot, source);
  await repo.run(['branch', `--set-upstream-to=${source.ref}`, '--', snapshot[0]]);
  ui.text('已设置上游；没有 fetch 或 push，也没有新建或切换分支。');
}

export async function forcePush(ui: Console, directory: string): Promise<void> {
  const repo = await repository(directory);
  await repo.ensureReady();
  if (!(await repo.hasCommits())) throw new GitError('还没有提交，不能强推。');
  const branch = await repo.branch();
  const remote = await chooseRemote(ui, repo); if (!remote) return;
  const target = await snapshotRemoteTarget(repo, remote);
  const targetBranch = await ui.ask('远程分支名称', branch);
  const ref = `refs/heads/${targetBranch}`;
  if ((await repo.run(['check-ref-format', ref], { check: false })).status) throw new GitError('远程分支名称无效。');
  const mode = await ui.menu('强推方式', ['force-with-lease（远端有变化就停止）', '无条件 force（直接覆盖远端分支历史）']);
  if (!mode) return;
  const { push } = await import('./workflows.js');
  await push(ui, repo, { target, branch: targetBranch, mode: mode === 1 ? 'lease' : 'force' });
}

export async function deleteRemoteBranch(ui: Console, directory: string): Promise<void> {
  let repo = await repository(directory);
  const remote = await chooseRemote(ui, repo);
  if (!remote) return;
  const urls = await validateExistingRemote(repo, remote, true);
  repo = await remoteContext(ui, repo, urls);
  const branch = await ui.ask('要删除的远程分支名称');
  const ref = `refs/heads/${branch}`;
  if ((await repo.run(['check-ref-format', ref], { check: false })).status) throw new GitError('远程分支名称无效。');
  const snapshot = await snapshotRemoteTarget(repo, remote);
  const pushUrl = snapshot.urls!.push[0];
  const expected = await remoteRefOid(repo, pushUrl, ref);
  const binding = await resolveBinding(repo.directory);
  const transport = await resolveTransport(repo.directory);
  if (!expected) { ui.text('远程分支不存在，没有删除。'); return; }
  ui.text(`远程：${remote}\n实际地址：${redact(pushUrl)}\n待删除：${ref}\n当前提交：${expected}`);
  if (!await ui.confirm(`确认删除远程分支 ${branch}？本地分支和本地工作区不会删除。`)) return;
  await verifyRemoteSnapshot(repo, snapshot);
  if (!isDeepStrictEqual(await resolveBinding(repo.directory), binding) || !isDeepStrictEqual(await resolveTransport(repo.directory), transport)) throw new GitError('账号或传输配置在确认期间变化，未删除远程分支。');
  repo = await (await projectGit(directory)).repository();
  const current = await remoteRefOid(repo, (await repo.remoteUrls(remote, true))[0], ref);
  if (current !== expected) throw new GitError('远程分支在确认期间发生变化，未删除。');
  await repo.run(['push', '--no-follow-tags', `--force-with-lease=${ref}:${expected}`, '--', remote, `:${ref}`], { interactive: true });
  ui.text(`已删除远程分支 ${branch}；本地分支未改变。`);
}

async function renameRemote(ui: Console, repo: Git): Promise<void> {
  const oldName = await chooseRemote(ui, repo); if (!oldName) return;
  const newName = await ui.ask('新的远程名称');
  if (!newName || newName.startsWith('-') || (await repo.remotes()).includes(newName)) throw new GitError('新远程名称无效或已经存在。');
  const snapshot = await snapshotRemoteTarget(repo, oldName);
  ui.text(`将把远程 ${oldName} 改名为 ${newName}；fetch/push 地址不变；引用此远程的分支上游由 Git 一并改名。`);
  if (!await ui.confirm('确认修改远程名称？')) return;
  await verifyRemoteSnapshot(repo, snapshot);
  await repo.run(['remote', 'rename', oldName, newName]);
  ui.text(`远程已改名：${oldName} → ${newName}。分支上游配置由 Git 一并改写。`);
}

interface UrlLists { fetch: string[]; push: string[] }

async function configuredUrls(repo: Git, name: string, local = false): Promise<UrlLists> {
  const values = async (key: string): Promise<string[]> => {
    const result = await repo.run(['config', ...local ? ['--local', '--no-includes'] : [], '--null', '--get-all', `remote.${name}.${key}`], { check: false });
    if (result.status === 1) return [];
    if (result.status) throw new GitError('无法读取远程 URL 配置，未修改。');
    return splitNul(result.stdout).map(decodePath);
  };
  return { fetch: await values('url'), push: await values('pushurl') };
}

async function localUrls(repo: Git, name: string): Promise<UrlLists> {
  const local = await configuredUrls(repo, name, true);
  if (!isDeepStrictEqual(local, await configuredUrls(repo, name))) throw new GitError('这个远程的 URL 来自外部或 include 配置；请在对应配置来源修改，不能把本地修改误报为已替换全部地址。');
  return local;
}

async function writeUrlLists(ui: Console, repo: Git, name: string, before: UrlLists, next: UrlLists, snapshot: RemoteTarget): Promise<void> {
  if (!next.fetch.length) throw new GitError('fetch 地址至少保留一个；移除整个远程请使用“移除远程”。');
  ui.text(`远程：${name}\nfetch：${redact(JSON.stringify(before.fetch))} → ${redact(JSON.stringify(next.fetch))}\npush：${redact(JSON.stringify(before.push))} → ${next.push.length ? redact(JSON.stringify(next.push)) : '继承 fetch 地址'}`);
  ui.text('本次只修改本地 URL 列表，不联网；branch upstream、pushRemote、pushDefault 和本地提交不变。传输菜单每次处理一个目标，多个地址可拆成不同名称的远程。');
  if (!await ui.confirm('确认按以上完整列表修改远程地址？')) return;
  await verifyRemoteSnapshot(repo, snapshot);
  if (!isDeepStrictEqual(before, await localUrls(repo, name))) throw new GitError('远程原始 URL 列表在确认期间变化，未修改。');
  const completed: string[] = [];
  try {
    for (const [kind, key] of [['fetch', 'url'], ['push', 'pushurl']] as const) {
      if (isDeepStrictEqual(before[kind], next[kind])) continue;
      const values = next[kind];
      if (values.length) {
        await repo.run(['config', '--local', '--replace-all', `remote.${name}.${key}`, values[0]]);
        for (const value of values.slice(1)) await repo.run(['config', '--local', '--add', `remote.${name}.${key}`, value]);
      } else {
        const result = await repo.run(['config', '--local', '--unset-all', `remote.${name}.${key}`], { check: false });
        if (result.status && result.status !== 5) throw new GitError(`清除 ${kind} 列表失败。`);
      }
      completed.push(kind);
    }
    if (!isDeepStrictEqual(await localUrls(repo, name), next)) throw new GitError('写入后的列表与目标不一致。');
  } catch (error) {
    throw new GitError(`远程地址修改未完整完成，可能已经部分写入；完成的列表：${completed.join('、') || '无'}。请重新查看当前地址后继续；没有重试或自动回滚。\n${redact(error instanceof Error ? error.message : String(error))}`);
  }
  ui.text(`远程 ${name} 的完整地址列表已更新；分支上游和本地提交未改变。`);
}

async function editRemoteUrls(ui: Console, repo: Git): Promise<void> {
  const name = await chooseRemote(ui, repo); if (!name) return;
  const snapshot = await snapshotRemoteTarget(repo, name);
  const before = await localUrls(repo, name);
  const fetch = validateGitUrl(await ui.ask('新的 fetch 地址（替换整个 fetch 列表）', before.fetch[0]));
  const push = validateGitUrl(await ui.ask('新的 push 地址（替换整个 push 列表，可与 fetch 相同）', before.push[0] ?? fetch));
  await writeUrlLists(ui, repo, name, before, { fetch: [fetch], push: [push] }, snapshot);
}

async function manageUrlLists(ui: Console, repo: Git): Promise<void> {
  const name = await chooseRemote(ui, repo); if (!name) return;
  const snapshot = await snapshotRemoteTarget(repo, name);
  const before = await localUrls(repo, name);
  const kindChoice = await ui.menu('选择 URL 列表', ['fetch 地址', 'push 地址（空列表时继承 fetch）']);
  if (!kindChoice) return;
  const kind = kindChoice === 1 ? 'fetch' : 'push';
  ui.text(redact(JSON.stringify(before[kind])));
  const action = await ui.menu('地址列表操作', ['添加一个地址', '移除一个地址', ...kind === 'push' ? ['清空 push 列表，恢复继承 fetch'] : []]);
  if (!action) return;
  const next = { fetch: [...before.fetch], push: [...before.push] };
  if (action === 1) {
    const value = validateGitUrl(await ui.ask('要添加的地址'));
    if (next[kind].includes(value)) throw new GitError('列表已经包含这个地址，未重复添加。');
    next[kind].push(value);
  } else if (action === 2) {
    const choice = await ui.menu('选择要移除的地址', before[kind].map(redact));
    if (!choice) return;
    next[kind].splice(choice - 1, 1);
  } else next.push = [];
  await writeUrlLists(ui, repo, name, before, next, snapshot);
}

async function removeRemote(ui: Console, repo: Git): Promise<void> {
  const name = await chooseRemote(ui, repo); if (!name) return;
  const snapshot = await snapshotRemoteTarget(repo, name);
  const branches = await repo.value('config', '--get-regexp', String.raw`^branch\..+\.(remote|merge|pushRemote)$|^remote\.pushDefault$`).catch(() => '');
  ui.text(`将移除远程 ${name}。相关分支配置可能变成无效上游：\n${branches || '（未发现分支上游配置）'}`);
  if (!await ui.confirm(`确认移除远程 ${name}？不会删除服务器仓库、本地分支或提交。`)) return;
  await verifyRemoteSnapshot(repo, snapshot);
  await repo.run(['remote', 'remove', name]);
  ui.text(`已移除本地远程 ${name}；服务器仓库未删除。`);
}

export async function remotesMenu(ui: Console, directory: string): Promise<void> {
  const repo = await repository(directory);
  const choice = await ui.menu('远程与上传工具', ['查看/管理远程地址', '添加远程（含新建 GitHub 仓库）', '仅上传已有提交', 'force-with-lease / 无条件 force 强推', '删除远程分支', '远程改名', '移除远程', '单独 fetch 远程（更新缓存）', '设置当前分支上游（使用缓存）']);
  if (!choice) return;
  if (choice === 1) {
    const names = await repo.remotes();
    if (!names.length) {
      ui.warn('当前项目尚未关联远程仓库，不能修改已有地址。请先新建或关联一个仓库。');
      const name = await addRemote(ui, repo);
      if (name) ui.success(`已添加远程：${name}。尚未上传代码。`);
      return;
    }
    for (const name of names) ui.text(`${name}\n  fetch: ${redact((await repo.remoteUrls(name)).join(', '))}\n  push: ${redact((await repo.remoteUrls(name, true)).join(', '))}`);
    const next = await ui.menu('远程操作', ['替换 fetch/push 地址列表', '逐项添加 / 移除 fetch/push 地址']);
    if (next === 1) await editRemoteUrls(ui, repo);
    else if (next === 2) await manageUrlLists(ui, repo);
  } else if (choice === 2) {
    const name = await addRemote(ui, repo); if (name) ui.text(`已添加远程：${name}`);
  } else if (choice === 3) {
    const { push } = await import('./workflows.js'); await push(ui, repo);
  } else if (choice === 4) await forcePush(ui, directory);
  else if (choice === 5) await deleteRemoteBranch(ui, directory);
  else if (choice === 6) await renameRemote(ui, repo);
  else if (choice === 7) await removeRemote(ui, repo);
  else if (choice === 8) await fetchRemote(ui, repo);
  else if (choice === 9) await setUpstream(ui, repo);
}
