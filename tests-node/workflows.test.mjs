import assert from 'node:assert/strict';
import { chmod, mkdir, open, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { Change, Git, GitError, decodePath, encodePath } from '../dist/git.js';
import { mockPersonalGithub } from './personal-support.mjs';
import { DEFAULT_HOST, DEFAULT_TRANSPORT, HostStore } from '../dist/hosts.js';
import { Profile, ProfileStore, resolveBinding } from '../dist/profiles.js';
import {
  addRemote, chooseDirectory, clone, inspect, protectAccountData, pull, push,
  remoteContext, riskyPaths, saveAndPush, uploadLocal, validateExistingRemote,
} from '../dist/workflows.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function prepared(t) {
  const f = await fixture(t);
  await f.write();
  await f.commit();
  const target = await f.remote();
  return { ...f, target };
}

async function managedCreation(t, { bound = false, login = 'fixture-login' } = {}) {
  const f = await fixture(t);
  // Legacy SSH coverage is explicit; unconfigured-project choices are tested separately.
  await new HostStore().set(f.path, DEFAULT_TRANSPORT);
  const store = new ProfileStore();
  const id = 'a'.repeat(32);
  const folder = path.join(store.profilesDir, id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  // These are deliberately not credentials. profileGit uses only offline ssh -G validation.
  const privateKey = path.join(folder, 'id_ed25519');
  await writeFile(privateKey, 'OFFLINE TEST FIXTURE; NOT A PRIVATE KEY\n', { mode: 0o600 });
  await writeFile(`${privateKey}.pub`, 'OFFLINE TEST FIXTURE; NOT A PUBLIC KEY\n', { mode: 0o600 });
  await writeFile(path.join(store.directory, 'known_hosts'), '', { mode: 0o600 });
  const profile = new Profile({
    profile_id: id, label: 'Offline Profile', name: 'Offline Author', email: 'offline@example.invalid',
    github_login: 'fixture-login', private_key: privateKey, public_key: `${privateKey}.pub`,
  });
  await writeFile(path.join(folder, 'profile.json'), JSON.stringify(store.encodeProfile(profile)), { mode: 0o600 });
  if (bound) await store.bind(f.path, profile.profile_id);
  const api = mockPersonalGithub(t, login);
  const transports = new Map();
  const pushes = [];
  const gitCalls = [];
  const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    gitCalls.push([...args]);
    if (api.remoteAddError && args[0] === 'remote' && args[1] === 'add') throw api.remoteAddError;
    if (args[0] === 'push') {
      const remote = args[args.indexOf('--') + 1];
      assert.ok(args.includes('--'), 'workflow push must separate its remote from options');
      assert.ok(transports.has(remote), `unexpected network push to ${remote}`);
      assert.ok(!args.some((arg) => /^(?:--force|--mirror|\+)/u.test(arg)), 'never force or mirror');
      pushes.push({ args: [...args], config: { ...this.overrides } });
      // Redirect only the actual transport. All prior get-url checks retain real GitHub config.
      return run.call(this.configured({ [`remote.${remote}.pushurl`]: transports.get(remote) }), args, options);
    }
    assert.ok(!['fetch', 'pull', 'clone'].includes(args[0]), `unexpected network command ${args[0]}`);
    assert.ok(args[0] !== 'ls-remote' || args.includes('--get-url'), 'only offline URL resolution is allowed');
    return run.call(this, args, options);
  });
  return { ...f, store, profile, api, transports, pushes, gitCalls };
}

async function synchronized(t) {
  const f = await prepared(t);
  await push(new ScriptedConsole(['1', '', 'y']), f.git);
  const other = path.join(f.base, 'other');
  await new Git(f.base).run(['clone', '--', f.target, other]);
  const peer = new Git(other);
  await peer.run(['config', 'user.name', 'Peer']);
  await peer.run(['config', 'user.email', 'peer@example.invalid']);
  return { ...f, peer };
}

async function advance(peer) {
  await writeFile(path.join(peer.directory, 'new.txt'), 'new\n');
  await peer.stagePaths(['new.txt']);
  await peer.run(['commit', '-m', 'remote update']);
  await peer.run(['push', 'origin', 'main']);
}

test('declining save never stages or commits', async (t) => {
  const f = await fixture(t);
  await f.write();
  await saveAndPush(new ScriptedConsole(['1', 'test', 'n']), f.path);
  assert.equal(await f.git.hasCommits(), false);
  assert.equal((await f.git.changes())[0].staged, false);
});

test('save includes only selected Unicode/leading-dash filename', async (t) => {
  const f = await fixture(t);
  await f.write('-中文 空格.txt');
  await f.write('leave.txt');
  const ui = new ScriptedConsole(['1', '保存一个文件', 'y', 'n']);
  await saveAndPush(ui, f.path);
  assert.deepEqual((await f.git.run(['ls-tree', '-z', '--name-only', 'HEAD'])).stdout, Buffer.from('-中文 空格.txt\0'));
  assert.equal((await f.git.changes())[0].staged, false);
  assert.match(ui.transcript, /尚未上传/u);
});

test('partial staging commits the index version and retains worktree edits', async (t) => {
  const f = await fixture(t);
  await f.write('hello.txt', 'initial\n');
  await f.commit();
  await f.write('hello.txt', 'staged\n');
  await f.git.stagePaths(['hello.txt']);
  await f.write('hello.txt', 'unstaged\n');
  const ui = new ScriptedConsole(['保留部分暂存', 'y', 'n']);
  await saveAndPush(ui, f.path);
  assert.equal(await f.git.value('show', 'HEAD:hello.txt'), 'staged');
  assert.equal(await readFile(path.join(f.path, 'hello.txt'), 'utf8'), 'unstaged\n');
  assert.equal((await f.git.changes())[0].index, ' ');
  assert.match(ui.transcript, /仅提交已暂存版本/u);
});

test('staged deletion is not undone by an untracked file at the same path', async (t) => {
  const f = await fixture(t);
  await f.write();
  await f.commit();
  await f.git.run(['rm', '--cached', 'hello.txt']);
  const ui = new ScriptedConsole(['保留删除', 'y', 'n']);
  await saveAndPush(ui, f.path);
  assert.equal(await f.git.value('ls-tree', '--name-only', 'HEAD'), '');
  assert.equal((await stat(path.join(f.path, 'hello.txt'))).isFile(), true);
  assert.equal((await f.git.changes())[0].index, '?');
  assert.match(ui.transcript, /同名文件不会再次加入/u);
});

test('staged rename does not restage a replacement of its original filename', async (t) => {
  const f = await fixture(t);
  await f.write('old.txt', 'initial\n');
  await f.commit();
  await f.git.run(['mv', 'old.txt', 'new.txt']);
  await f.write('old.txt', 'replacement\n');
  const ui = new ScriptedConsole(['保留重命名', 'y', 'n']);
  await saveAndPush(ui, f.path);
  assert.equal(await f.git.value('ls-tree', '--name-only', 'HEAD'), 'new.txt');
  assert.equal(await readFile(path.join(f.path, 'old.txt'), 'utf8'), 'replacement\n');
  assert.equal((await f.git.changes())[0].path, 'old.txt');
});

test('existing staged content is disclosed and retained when nothing extra is selected', async (t) => {
  const f = await fixture(t);
  await f.write('a.txt');
  await f.git.stagePaths(['a.txt']);
  await f.write('b.txt');
  const ui = new ScriptedConsole(['', 'existing', 'y', 'n']);
  await saveAndPush(ui, f.path);
  assert.equal(await f.git.value('ls-tree', '--name-only', 'HEAD'), 'a.txt');
  assert.match(ui.transcript, /已有暂存内容将一并提交/u);
});

test('sensitive path warning can stop before any staging', async (t) => {
  const f = await fixture(t);
  await f.write('.env', 'TEST_FIXTURE=value\n');
  const ui = new ScriptedConsole(['a', 'n']);
  await saveAndPush(ui, f.path);
  assert.equal(await f.git.hasCommits(), false);
  assert.equal((await f.git.changes())[0].staged, false);
  assert.match(ui.transcript, /可能包含机密/u);
});

test('quick local-only save creates a commit without any remote or extra confirmation', async (t) => {
  const f = await fixture(t);
  await f.write();
  const ui = new ScriptedConsole(['a', 'local only'], { quick: true });
  await saveAndPush(ui, f.path, { upload: false });
  assert.equal(await f.git.hasCommits(), true);
  assert.deepEqual(await f.git.remotes(), []);
  assert.doesNotMatch(ui.transcript, /\[y\/N\]/u);
});

test('quick mode still shows sensitive filename warnings', async (t) => {
  const f = await fixture(t);
  await f.write('.env', 'TEST_FIXTURE=value\n');
  const ui = new ScriptedConsole(['a', 'warning only'], { quick: true });
  await saveAndPush(ui, f.path, { upload: false });
  assert.match(ui.transcript, /可能包含机密/u);
  assert.equal(await f.git.hasCommits(), true);
});

test('missing commit identity stops without staging files', async (t) => {
  const f = await fixture(t);
  await f.write();
  await f.git.run(['config', '--unset', 'user.email']);
  await assert.rejects(saveAndPush(new ScriptedConsole(), f.path), /姓名或邮箱/u);
  assert.equal((await f.git.changes())[0].staged, false);
  assert.equal(await f.git.hasCommits(), false);
});

test('nested repository selection stops before staging', async (t) => {
  const f = await fixture(t);
  const nested = path.join(f.path, 'nested');
  await mkdir(nested);
  const git = new Git(nested);
  await git.run(['init', '--initial-branch=main']);
  await writeFile(path.join(nested, 'file.txt'), 'nested\n');
  await git.stagePaths(['file.txt']);
  await git.run(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'nested']);
  await assert.rejects(saveAndPush(new ScriptedConsole(['a']), f.path), /嵌套/u);
  assert.equal(await f.git.hasCommits(), false);
  assert.equal((await f.git.changes())[0].staged, false);
});

test('registered gitlink save records only its pointer and leaves nested dirty content untouched', async t => {
  const f = await fixture(t, { committed: true });
  const nestedPath = path.join(f.path, 'registered-module');
  await mkdir(nestedPath);
  const nested = new Git(nestedPath);
  await nested.run(['init', '--initial-branch=main']);
  await writeFile(path.join(nestedPath, 'module.txt'), 'committed module content\n');
  await nested.stagePaths(['module.txt']);
  await nested.run(['-c', 'user.name=Module Fixture', '-c', 'user.email=module@example.invalid', 'commit', '-m', 'module commit']);
  const oid = await nested.value('rev-parse', 'HEAD');
  await f.git.run(['update-index', '--add', '--cacheinfo', `160000,${oid},registered-module`]);
  await writeFile(path.join(nestedPath, 'module.txt'), 'private unfinished module work\n');
  const ui = new ScriptedConsole(['', 'record module pointer'], { quick: true });
  await saveAndPush(ui, f.path, { upload: false });
  assert.match(await f.git.value('ls-tree', 'HEAD', '--', 'registered-module'), new RegExp(`^160000 commit ${oid}\\tregistered-module$`, 'u'));
  assert.equal(await readFile(path.join(nestedPath, 'module.txt'), 'utf8'), 'private unfinished module work\n');
  assert.equal(await nested.value('rev-parse', 'HEAD'), oid);
  assert.equal(await nested.value('show', 'HEAD:module.txt'), 'committed module content');
});

test('state changes during confirmation stop before staging', async (t) => {
  const f = await fixture(t);
  await f.write();
  const ui = new ScriptedConsole(['a', 'test', 'y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async (prompt, ...args) => {
    const answer = await confirm(prompt, ...args);
    if (prompt.includes('确认暂存')) await f.write('changed-during-confirm.txt');
    return answer;
  };
  await assert.rejects(saveAndPush(ui, f.path), /文件状态发生变化/u);
  assert.equal(await f.git.hasCommits(), false);
  assert.ok((await f.git.changes()).every((change) => !change.staged));
});

test('commit failure retains staged content and never attempts push', async (t) => {
  const f = await fixture(t);
  await f.write();
  const run = Git.prototype.run;
  let attemptedPush = false;
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    if (args[0] === 'commit') throw new GitError('simulated commit failure');
    if (args[0] === 'push') attemptedPush = true;
    return run.call(this, args, options);
  });
  await assert.rejects(saveAndPush(new ScriptedConsole(['a', 'test', 'y']), f.path), /不会继续推送/u);
  assert.equal(attemptedPush, false);
  assert.equal(await f.git.hasCommits(), false);
  assert.equal((await f.git.changes())[0].staged, true);
});

test('managed account data is blocked even when already staged and quick mode enabled', async (t) => {
  const f = await fixture(t);
  process.env.AUTOGIT_DATA_DIR = path.join(f.path, 'data');
  await f.write('data/id_ed25519', 'TEST FIXTURE NOT A KEY\n');
  await f.git.stagePaths(['data/id_ed25519']);
  await assert.rejects(saveAndPush(new ScriptedConsole([], { quick: true }), f.path, { upload: false }), /账号数据/u);
  assert.equal(await f.git.hasCommits(), false);
  assert.equal((await f.git.changes())[0].staged, true);
});

test('managed account data protection also checks a renamed original path', async (t) => {
  const f = await fixture(t);
  process.env.AUTOGIT_DATA_DIR = path.join(f.path, 'data');
  await f.write('data/test-fixture.txt', 'not a key\n');
  await rename(path.join(f.path, 'data/test-fixture.txt'), path.join(f.path, 'moved.txt'));
  await assert.rejects(protectAccountData(f.git, [new Change('R', ' ', 'moved.txt', 'data/test-fixture.txt')]), /账号数据/u);
});

test('managed account data protection follows symlink destinations', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const data = process.env.AUTOGIT_DATA_DIR;
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, 'fixture.txt'), 'test fixture\n');
  await symlink(path.join(data, 'fixture.txt'), path.join(f.path, 'linked.txt'));
  await assert.rejects(protectAccountData(f.git, [new Change('?', '?', 'linked.txt')]), /账号数据/u);
});

test('managed data protection follows dangling symlinks and does not block a sibling prefix', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const data = process.env.AUTOGIT_DATA_DIR;
  await mkdir(data, { recursive: true });
  await symlink(path.join(data, 'missing-fixture.txt'), path.join(f.path, 'linked.txt'));
  await assert.rejects(protectAccountData(f.git, [new Change('?', '?', 'linked.txt')]), /账号数据/u);
  process.env.AUTOGIT_DATA_DIR = path.join(f.path, 'data');
  await f.write('database/safe.txt', 'safe fixture\n');
  await protectAccountData(f.git, [new Change('?', '?', 'database/safe.txt')]);
});

test('surrogateescaped filename survives the workflow without UTF-8 replacement', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t);
  const filename = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x0a, 0x2e, 0x74, 0x78, 0x74]);
  await writeFile(Buffer.concat([Buffer.from(f.path + path.sep), filename]), 'raw bytes\n');
  const ui = new ScriptedConsole(['a', 'raw path'], { quick: true });
  await saveAndPush(ui, f.path, { upload: false });
  assert.deepEqual((await f.git.run(['ls-tree', '-z', '--name-only', 'HEAD'])).stdout, Buffer.concat([filename, Buffer.from([0])]));
  assert.deepEqual(await f.git.changes(), []);
  assert.deepEqual(encodePath(decodePath(filename)), filename);
});

async function oversizedFixtureFile(f, name = 'large.bin') {
  const file = await open(encodePath(path.join(f.path, name)), 'w');
  try { await file.truncate(50 * 1024 * 1024 + 1); } finally { await file.close(); }
}

test('cancelling file selection keeps automatic large-file ignore rules without staging or committing', async t => {
  const f = await fixture(t); await oversizedFixtureFile(f); const ui = new ScriptedConsole([':q'], { quick: true });
  await assert.rejects(saveAndPush(ui, f.path, { upload: false }), error => error.name === 'Cancelled');
  assert.equal(await readFile(path.join(f.path, '.gitignore'), 'utf8'), '/large.bin\n');
  assert.deepEqual((await f.git.run(['ls-files', '--stage', '-z'])).stdout, Buffer.alloc(0));
  assert.equal(await f.git.hasCommits(), false); assert.deepEqual(ui.answers, []);
});

test('all oversized unrepresentable files produce no empty commit and require no confirmation', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await oversizedFixtureFile(f, 'line\nlarge.bin'); const ui = new ScriptedConsole([], { quick: true });
  await saveAndPush(ui, f.path, { upload: false });
  assert.match(ui.transcript, /没有选择文件，也没有已有暂存内容/u); assert.doesNotMatch(ui.transcript, /已保存到本地|\[y\/N\]/u);
  assert.equal(await f.git.hasCommits(), false); assert.deepEqual((await f.git.run(['ls-files', '-z'])).stdout, Buffer.alloc(0));
});

test('first local upload automatically ignores oversized files using the common save workflow', async t => {
  const f = await fixture(t); const bare = await f.remote(); await f.write('small.txt', 'first upload\n'); await oversizedFixtureFile(f);
  const ui = new ScriptedConsole(['1', 'a', 'first small upload', '1', ''], { quick: true });
  assert.equal(await uploadLocal(ui, f.path, { selectDirectory: false }), f.path);
  assert.equal(await new Git(bare).value('ls-tree', '-r', '--name-only', 'main'), '.gitignore\nsmall.txt');
  assert.match(ui.transcript, /已自动忽略/u); assert.match(ui.transcript, /推送成功/u); assert.deepEqual(ui.answers, []);
});

test('risk filename rules allow templates and detect private key extensions and large files', async (t) => {
  const f = await fixture(t);
  await f.write('.env.example', 'placeholder\n');
  await f.write('private.KEY', 'fixture not a key\n');
  await f.write('large.bin', Buffer.alloc(10 * 1024 * 1024 + 1));
  const warnings = await riskyPaths(f.git, await f.git.changes());
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((line) => line.includes('private.KEY') && line.includes('机密')));
  assert.ok(warnings.some((line) => line.includes('large.bin') && line.includes('10 MiB')));
});

test('first push sets upstream only after success', async (t) => {
  const f = await prepared(t);
  const ui = new ScriptedConsole(['1', '', 'y']);
  await push(ui, f.git);
  assert.equal(await f.git.config('branch.main.remote'), 'origin');
  assert.equal(await new Git(f.target).value('rev-parse', 'main'), await f.git.value('rev-parse', 'HEAD'));
  assert.match(ui.transcript, /推送成功/u);
});

test('fork push uses branch pushRemote without changing fetch upstream', async (t) => {
  const f = await prepared(t);
  await push(new ScriptedConsole(['1', '', 'y']), f.git);
  const originalHead = await new Git(f.target).value('rev-parse', 'main');
  const fork = path.join(f.base, 'fork.git');
  await new Git(f.base).run(['init', '--bare', '--initial-branch=main', fork]);
  await f.git.run(['remote', 'add', 'fork', fork]);
  await f.git.run(['config', 'branch.main.pushRemote', 'fork']);
  await f.write('more.txt');
  await f.commit('fork update');
  await push(new ScriptedConsole(['', 'y']), f.git);
  assert.equal(await new Git(f.target).value('rev-parse', 'main'), originalHead);
  assert.equal(await new Git(fork).value('rev-parse', 'main'), await f.git.value('rev-parse', 'HEAD'));
  assert.equal(await f.git.config('branch.main.remote'), 'origin');
  assert.equal(await f.git.config('branch.main.merge'), 'refs/heads/main');
});

test('multiple remotes require explicit push selection instead of assuming upstream', async (t) => {
  const f = await prepared(t);
  await push(new ScriptedConsole(['1', '', 'y']), f.git);
  const upstreamHead = await new Git(f.target).value('rev-parse', 'main');
  const fork = path.join(f.base, 'fork.git');
  await new Git(f.base).run(['init', '--bare', '--initial-branch=main', fork]);
  await f.git.run(['remote', 'add', 'fork', fork]);
  await f.write('fork.txt');
  await f.commit('fork update');
  // Git sorts remotes alphabetically: fork, origin.
  const ui = new ScriptedConsole(['1', '', 'y']);
  await push(ui, f.git);
  assert.equal(await new Git(f.target).value('rev-parse', 'main'), upstreamHead);
  assert.equal(await new Git(fork).value('rev-parse', 'main'), await f.git.value('rev-parse', 'HEAD'));
  assert.equal(await f.git.config('branch.main.remote'), 'origin');
  assert.match(ui.transcript, /明确选择推送目标/u);
});

test('declining first push keeps upstream unset and remote empty', async (t) => {
  const f = await prepared(t);
  await push(new ScriptedConsole(['1', '', 'n']), f.git);
  assert.equal(await f.git.config('branch.main.remote'), '');
  assert.equal(await new Git(f.target).hasCommits(), false);
});

test('invalid destination ref is rejected without writing upstream', async (t) => {
  const f = await prepared(t);
  await assert.rejects(push(new ScriptedConsole(['1', 'bad..branch']), f.git), /分支名称无效/u);
  assert.equal(await f.git.config('branch.main.remote'), '');
  assert.equal(await new Git(f.target).hasCommits(), false);
});

test('push failure preserves local commit and never forces remote history', async (t) => {
  const f = await synchronized(t);
  await advance(f.peer);
  await f.write('local.txt');
  await f.commit('local update');
  const head = await f.git.value('rev-parse', 'HEAD');
  const remoteHead = await new Git(f.target).value('rev-parse', 'main');
  const calls = [], run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'push') {
      calls.push([...args]);
      assert.ok(!args.some(arg => /^(?:--force|--mirror|\+)/u.test(arg)), 'ordinary daily push must never force');
      assert.ok(args.includes('--no-follow-tags'));
      assert.equal(args.at(-1), `${head}:refs/heads/main`);
    }
    return run.call(this, args, options);
  });
  await assert.rejects(push(new ScriptedConsole(['y']), f.git), /上传没有(?:确认)?成功/u);
  assert.equal(calls.length, 1, 'failed normal push must not retry or escalate');
  assert.equal(await f.git.value('rev-parse', 'HEAD'), head);
  assert.equal(await new Git(f.target).value('rev-parse', 'main'), remoteHead);
});

test('push rechecks a changed HEAD after confirmation and never uploads either commit', async t => {
  const f = await prepared(t);
  const run = Git.prototype.run;
  const pushes = [];
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'push') pushes.push([...args]);
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole(['1', '', 'y']);
  const confirm = ui.confirm.bind(ui);
  ui.confirm = async (...args) => {
    const confirmed = await confirm(...args);
    if (confirmed) { await f.write('after-preview.txt'); await f.commit('new HEAD during confirmation'); }
    return confirmed;
  };
  await assert.rejects(push(ui, f.git), /分支或提交.*发生变化/u);
  assert.equal(pushes.length, 0);
  assert.equal(await new Git(f.target).hasCommits(), false);
  assert.equal(await f.git.config('branch.main.remote'), '');
});

test('push pins the previewed OID when HEAD changes immediately before transport and skips new upstream writes', async t => {
  const f = await prepared(t);
  const before = await f.git.value('rev-parse', 'HEAD');
  const run = Git.prototype.run;
  const pushes = [];
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'push') {
      pushes.push([...args]);
      assert.equal(args.at(-1), `${before}:refs/heads/main`);
      assert.ok(!args.includes('--set-upstream'));
      await f.write('after-preview.txt');
      await f.commit('concurrent local commit before native push');
    }
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole(['1', '', 'y']);
  await push(ui, f.git);
  assert.equal(pushes.length, 1);
  assert.equal(await new Git(f.target).value('rev-parse', 'refs/heads/main'), before);
  assert.notEqual(await f.git.value('rev-parse', 'HEAD'), before);
  assert.equal(await f.git.config('branch.main.remote'), '');
  assert.equal(await f.git.config('branch.main.merge'), '');
  assert.match(ui.transcript, /远端上传已成功.*没有替换现在的上游/u);
});

test('successful push followed by a partial upstream-config failure is reported without repushing', async t => {
  const f = await prepared(t);
  const run = Git.prototype.run;
  let pushes = 0;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'push') pushes++;
    if (args[0] === 'config' && args[1] === 'branch.main.merge') throw new GitError('fixture config lock');
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole(['1', '', 'y']);
  await push(ui, f.git);
  assert.equal(pushes, 1);
  assert.equal(await new Git(f.target).value('rev-parse', 'refs/heads/main'), await f.git.value('rev-parse', 'HEAD'));
  assert.equal(await f.git.config('branch.main.remote'), 'origin');
  assert.equal(await f.git.config('branch.main.merge'), '');
  assert.match(ui.transcript, /远端上传已经成功.*上游关联未完整完成/u);
  assert.match(ui.transcript, /不必重复上传/u);
});

test('multiple push URLs are refused before network', async (t) => {
  const f = await prepared(t);
  await f.git.run(['remote', 'set-url', '--add', '--push', 'origin', path.join(f.base, 'one')]);
  await f.git.run(['remote', 'set-url', '--add', '--push', 'origin', path.join(f.base, 'two')]);
  await assert.rejects(push(new ScriptedConsole(['1', '']), f.git), /多个地址/u);
});

test('generic service and safe rewritten URLs are accepted while unsafe rewritten destinations stop before network', async (t) => {
  const f = await prepared(t);
  const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    assert.ok(!['push', 'fetch', 'pull', 'clone'].includes(args[0]), 'unexpected network command');
    assert.ok(args[0] !== 'ls-remote' || args.includes('--get-url'));
    return run.call(this, args, options);
  });
  await f.git.run(['remote', 'set-url', 'origin', 'https://gitlab.com/person/repo.git']);
  assert.deepEqual(await validateExistingRemote(f.git, 'origin', true), ['https://gitlab.com/person/repo.git']);
  await f.git.run(['remote', 'set-url', 'origin', 'https://github.com/person/repo.git']);
  await f.git.run(['config', 'url.https://gitlab.com/.pushInsteadOf', 'https://github.com/']);
  assert.deepEqual(await validateExistingRemote(f.git, 'origin', true), ['https://gitlab.com/person/repo.git']);
  await push(new ScriptedConsole(['1', '', 'n']), f.git);
  await f.git.run(['config', '--unset-all', 'url.https://gitlab.com/.pushInsteadOf']);
  for (const unsafe of ['ext::anything', 'https://user:secret@example.invalid/repo', 'https://example.invalid/repo?token=x', 'not-a-valid-url']) {
    await f.git.run(['remote', 'set-url', 'origin', unsafe]);
    await assert.rejects(validateExistingRemote(f.git, 'origin', true), /地址无效/u);
  }
});

test('existing local remotes must be bare repositories', async (t) => {
  const f = await prepared(t);
  assert.deepEqual(await validateExistingRemote(f.git, 'origin', true), [f.target]);
  const worktree = path.join(f.base, 'worktree');
  await mkdir(worktree);
  await new Git(worktree).run(['init', '--initial-branch=main']);
  await f.git.run(['remote', 'set-url', 'origin', worktree]);
  await assert.rejects(validateExistingRemote(f.git, 'origin'), /bare/u);
});

test('add remote can be declined and never overwrites existing configuration', async (t) => {
  const f = await fixture(t);
  assert.equal(await addRemote(new ScriptedConsole(['2', 'git@github.com:person/repo.git', '', 'n']), f.git), '');
  assert.deepEqual(await f.git.remotes(), []);
  const target = await f.remote();
  await assert.rejects(addRemote(new ScriptedConsole(['2', 'https://github.com/person/another', 'origin']), f.git), /没有覆盖/u);
  assert.deepEqual(await f.git.remoteUrls('origin'), [target]);
});

test('manual existing-repository branch refuses an origin collision introduced during final confirmation', async (t) => {
  const f = await fixture(t);
  const api = mockPersonalGithub(t);
  const retained = 'https://github.com/other/retained.git';
  const ui = new ScriptedConsole(['2', 'https://github.com/person/intended.git', '', 'y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async (...args) => {
    const result = await confirm(...args);
    await f.git.run(['remote', 'add', 'origin', retained]);
    return result;
  };
  await assert.rejects(addRemote(ui, f.git), /没有覆盖/u);
  assert.deepEqual(await f.git.remoteUrls('origin'), [retained]);
  assert.equal(api.authentications, 0);
  assert.deepEqual(api.creates, []);
  assert.deepEqual(ui.answers, []);
});

test('manual add remote accepts generic Git transports without networking and rejects unsafe addresses', async t => {
  const f = await fixture(t);
  const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    assert.ok(!['push', 'fetch', 'pull', 'clone', 'ls-remote'].includes(args[0]), 'manual association must stay offline');
    return run.call(this, args, options);
  });
  for (const [index, url] of ['https://gitlab.example.invalid/team/repo.git', 'host-alias:team/repo.git'].entries()) {
    const name = `generic-${index}`;
    const ui = new ScriptedConsole(['2', url, name, 'y']);
    assert.equal(await addRemote(ui, f.git), name);
    assert.deepEqual(await f.git.remoteUrls(name), [url]);
    assert.deepEqual(ui.answers, []);
  }
  for (const url of ['ext::anything', 'https://user:secret@example.invalid/team/repo', 'not-a-valid-url']) {
    await assert.rejects(addRemote(new ScriptedConsole(['2', url]), f.git), /地址|协议/u);
  }
  assert.deepEqual(await f.git.remotes(), ['generic-0', 'generic-1']);
});

test('add remote rejects a name that could become a command-line option', async (t) => {
  const f = await fixture(t);
  await assert.rejects(addRemote(new ScriptedConsole(['2', 'https://github.com/person/repo', '--mirror']), f.git), /远程名/u);
  assert.deepEqual(await f.git.remotes(), []);
});

for (const [visibility, selection, bound, quick] of [['private', '1', false, true], ['public', '2', true, false]]) {
  test(`code-only native API stub creates ${visibility} personal repository, links canonical SSH and never commits or pushes`, async (t) => {
    const f = await managedCreation(t, { bound });
    await f.write();
    const answers = ['1', ...(!bound ? ['1'] : []), 'Explicit_Repo', selection, 'y'];
    const ui = new ScriptedConsole(answers, { quick });
    const result = await addRemote(ui, f.git);
    assert.equal(result, 'origin');
    assert.deepEqual(f.api.creates, [{ owner: 'fixture-login', name: 'Explicit_Repo', visibility }]);
    assert.deepEqual(await f.git.remoteUrls('origin'), ['git@github.com:fixture-login/Explicit_Repo.git']);
    assert.equal((await resolveBinding(f.path)).profile_id, f.profile.profile_id);
    assert.equal(await f.git.hasCommits(), false);
    assert.equal((await f.git.changes())[0].staged, false);
    assert.equal(f.pushes.length, 0);
    assert.ok(!f.gitCalls.some((args) => args[0] === 'commit'));
    assert.match(ui.transcript, /GitHub API 登录：fixture-login/u);
    assert.match(ui.transcript, /AutoGit 账号：Offline Profile/u);
    assert.match(ui.transcript, /GitHub API 账号 \/ 仓库所有者：fixture-login/u);
    assert.match(ui.transcript, new RegExp(`可见性：${visibility}`, 'u'));
    assert.ok(ui.transcript.includes(`项目：${f.path}`));
    assert.match(ui.transcript, /本地远程别名：origin/u);
    assert.match(ui.transcript, /空仓库，不添加 README、\.gitignore、许可证或初始提交/u);
    assert.match(ui.transcript, /最终确认.*\[y\/N\]/u);
    assert.match(ui.transcript, /GitHub 仓库已创建：https:\/\/github\.com\/fixture-login\/Explicit_Repo/u);
    assert.deepEqual(f.api.ghCalls, []);
    assert.equal(f.api.authentications, 1);
    assert.doesNotMatch(ui.transcript, /给这个远程起一个名字/u);
    assert.deepEqual(ui.answers, []);
  });
}

test('unconfigured personal creation explicitly chooses and saves SSH without silently adopting a default', async t => {
  const f = await managedCreation(t);
  await new HostStore().set(f.path, undefined);
  const ui = new ScriptedConsole(['1', '2', '1', 'explicit-ssh-choice', '1', 'y'], { quick: true });
  assert.equal(await addRemote(ui, f.git), 'origin');
  assert.deepEqual(await new HostStore().get(f.path), DEFAULT_TRANSPORT);
  assert.deepEqual(await f.git.remoteUrls('origin'), ['git@github.com:fixture-login/explicit-ssh-choice.git']);
  assert.deepEqual(f.api.creates, [{ owner: 'fixture-login', name: 'explicit-ssh-choice', visibility: 'private' }]);
  assert.match(ui.transcript, /HTTPS.*推荐/u);
  assert.match(ui.transcript, /托管 SSH/u);
  assert.equal(f.pushes.length, 0);
  assert.deepEqual(ui.answers, []);
});

for (const [label, target] of [
  ['external HTTPS', { mode: 'https', host: DEFAULT_HOST, credentials: 'external' }],
  ['native SSH', { mode: 'native-ssh', host: DEFAULT_HOST }],
  ['GitHub Enterprise', { mode: 'managed-ssh', host: { provider: 'github-enterprise', host: 'github.example.invalid', apiHost: 'github.example.invalid', webBase: 'https://github.example.invalid', sshHost: 'github.example.invalid' } }],
]) {
  test(`personal creation refuses ${label} transport before native authentication or repository creation`, async (t) => {
    const f = await managedCreation(t);
    const hosts = new HostStore();
    await hosts.set(f.path, target);
    const ui = new ScriptedConsole(['1']);
    await assert.rejects(addRemote(ui, f.git), /github\.com.*(?:托管 HTTPS|托管 SSH).*尚未创建仓库/u);
    assert.equal(f.api.authentications, 0);
    assert.equal(f.api.logins, 0);
    assert.deepEqual(f.api.creates, []);
    assert.deepEqual(f.api.ghCalls, []);
    assert.deepEqual(await hosts.get(f.path), target);
    assert.deepEqual(await f.git.remotes(), []);
    assert.equal(await resolveBinding(f.path), undefined);
    assert.doesNotMatch(ui.transcript, /GitHub 仓库名称|仓库可见性|远程别名|最终确认/u);
    assert.deepEqual(ui.answers, []);
  });
}

test('quick mode final hard confirmation can cancel after authentication without creating or binding', async (t) => {
  const f = await managedCreation(t);
  const ui = new ScriptedConsole(['1', '1', 'cancel-create', '1', 'n'], { quick: true });
  assert.equal(await addRemote(ui, f.git), '');
  assert.ok(f.api.logins > 0);
  assert.deepEqual(f.api.creates, []);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.match(ui.transcript, /最终确认.*\[y\/N\]/u);
  assert.deepEqual(ui.answers, []);
});

test('code-only native authentication success adds no duplicate consent while final server write remains hard-confirmed', async (t) => {
  const f = await managedCreation(t);
  const ui = new ScriptedConsole(['1', '1', 'no-network', '1', 'n'], { quick: true });
  assert.equal(await addRemote(ui, f.git), '');
  assert.ok(f.api.logins > 0);
  assert.equal(ui.messages.filter(message => message.includes('[y/N]')).length, 1);
  assert.deepEqual(f.api.creates, []);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.deepEqual(ui.answers, []);
});

test('creation without an available profile returns before any GitHub call or remote-name prompt', async (t) => {
  const f = await fixture(t);
  await new HostStore().set(f.path, DEFAULT_TRANSPORT);
  const api = mockPersonalGithub(t);
  const ui = new ScriptedConsole(['1']);
  assert.equal(await addRemote(ui, f.git), '');
  assert.equal(api.authentications, 0);
  assert.equal(api.logins, 0);
  assert.deepEqual(api.creates, []);
  assert.deepEqual(await f.git.remotes(), []);
  assert.match(ui.transcript, /未选择 AutoGit 账号/u);
  assert.doesNotMatch(ui.transcript, /远程别名|给这个远程起一个名字|GitHub 仓库名称/u);
  assert.deepEqual(ui.answers, []);
});

test('cancelling creation menu or profile avoids authentication; visibility cancellation occurs after native authentication', async (t) => {
  const f = await managedCreation(t);
  for (const answers of [['0'], ['1', '0']]) {
    const ui = new ScriptedConsole(answers);
    assert.equal(await addRemote(ui, f.git), '');
    assert.deepEqual(ui.answers, []);
    assert.equal(f.api.authentications, 0);
  }
  const ui = new ScriptedConsole(['1', '1', 'cancel-visibility', '0']);
  assert.equal(await addRemote(ui, f.git), '');
  assert.equal(f.api.authentications, 1);
  assert.equal(f.api.logins, 1);
  assert.deepEqual(f.api.creates, []);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.doesNotMatch(ui.transcript, /最终确认|新地址的本地远程别名|本地远程别名自动使用/u);
  assert.deepEqual(ui.answers, []);
});

test('native authentication cancellation returns before repository name, visibility or remote-name prompts', async (t) => {
  const f = await managedCreation(t);
  f.api.authenticateResult = false;
  const ui = new ScriptedConsole(['1', '1']);
  assert.equal(await addRemote(ui, f.git), '');
  assert.equal(f.api.authentications, 1);
  assert.deepEqual(f.api.creates, []);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.doesNotMatch(ui.transcript, /GitHub 仓库名称|仓库可见性|远程别名|最终确认/u);
  assert.deepEqual(ui.answers, []);
});

test('creation loops over invalid and occupied remote aliases after authentication without overwriting origin', async (t) => {
  const f = await managedCreation(t);
  const target = await f.remote();
  const ui = new ScriptedConsole(['1', '1', 'new-remote-project', '1', '--mirror', 'bad..name', 'bad[name', 'trailing.lock', 'origin', '', 'y']);
  assert.equal(await addRemote(ui, f.git), 'origin-2');
  assert.deepEqual(await f.git.remoteUrls('origin'), [target]);
  assert.deepEqual(await f.git.remoteUrls('origin-2'), ['git@github.com:fixture-login/new-remote-project.git']);
  assert.equal(f.api.authentications, 1);
  assert.deepEqual(f.api.creates, [{ owner: 'fixture-login', name: 'new-remote-project', visibility: 'private' }]);
  assert.match(ui.transcript, /新地址的本地远程别名 \[origin-2\]/u);
  assert.match(ui.transcript, /远程名无效/u);
  assert.match(ui.transcript, /没有覆盖/u);
  assert.deepEqual(ui.answers, []);
});

test('creation proposes the next unique origin alias and preserves all existing remotes', async (t) => {
  const f = await managedCreation(t, { bound: true });
  const target = await f.remote();
  await f.git.run(['remote', 'add', 'origin-2', target]);
  const ui = new ScriptedConsole(['1', 'another-project', '2', '', 'y']);
  assert.equal(await addRemote(ui, f.git), 'origin-3');
  assert.match(ui.transcript, /新地址的本地远程别名 \[origin-3\]/u);
  assert.deepEqual(await f.git.remoteUrls('origin'), [target]);
  assert.deepEqual(await f.git.remoteUrls('origin-2'), [target]);
  assert.deepEqual(await f.git.remoteUrls('origin-3'), ['git@github.com:fixture-login/another-project.git']);
  assert.equal(f.api.authentications, 1);
  assert.deepEqual(ui.answers, []);
});

test('creation loops over invalid repository names without sanitizing an invalid Chinese basename', async (t) => {
  const f = await managedCreation(t);
  const invalid = ['中文仓库', 'bad/name', '-option', '..', 'repo.git'];
  const ui = new ScriptedConsole(['1', '1', '', ...invalid, 'Valid_Repo', '1', 'y']);
  let namesAsked = 0;
  const ask = ui.ask.bind(ui);
  ui.ask = async (prompt, defaultValue) => {
    if (prompt.startsWith('GitHub 仓库名称')) {
      namesAsked++;
      assert.equal(defaultValue, '', 'invalid basename must not be sanitized into a suggested name');
      assert.equal(f.api.authentications, 1, 'native actor authentication must precede repository-name input');
    }
    return ask(prompt, defaultValue);
  };
  assert.equal(await addRemote(ui, f.git), 'origin');
  assert.equal(namesAsked, invalid.length + 1);
  assert.match(ui.transcript, /不会自动改写文件夹名/u);
  assert.match(ui.transcript, /此项不能为空/u);
  assert.match(ui.transcript, /仓库名不能带 \.git 后缀/u);
  assert.deepEqual(f.api.creates, [{ owner: 'fixture-login', name: 'Valid_Repo', visibility: 'private' }]);
  assert.deepEqual(ui.answers, []);
});

test('creation accepts a legal project basename by pressing Enter without an unused-origin prompt', async (t) => {
  const f = await managedCreation(t);
  const directory = path.join(f.base, 'Legal_Project-1.0');
  await rename(f.path, directory);
  await new HostStore().set(directory, DEFAULT_TRANSPORT);
  const repo = new Git(directory);
  const ui = new ScriptedConsole(['1', '1', '', '1', 'y']);
  const ask = ui.ask.bind(ui);
  ui.ask = async (prompt, defaultValue) => {
    if (prompt.startsWith('GitHub 仓库名称')) {
      assert.equal(defaultValue, 'Legal_Project-1.0');
      assert.equal(f.api.authentications, 1);
    }
    assert.doesNotMatch(prompt, /远程别名|给这个远程起一个名字/u);
    return ask(prompt, defaultValue);
  };
  assert.equal(await addRemote(ui, repo), 'origin');
  assert.deepEqual(f.api.creates, [{ owner: 'fixture-login', name: 'Legal_Project-1.0', visibility: 'private' }]);
  assert.deepEqual(await repo.remoteUrls('origin'), ['git@github.com:fixture-login/Legal_Project-1.0.git']);
  assert.equal((await resolveBinding(directory)).profile_id, f.profile.profile_id);
  assert.deepEqual(ui.answers, []);
});

test('creation rechecks remote uniqueness after the final hard confirmation', async (t) => {
  const f = await managedCreation(t);
  const ui = new ScriptedConsole(['1', '1', 'race-remote', '1', 'y']);
  const confirm = ui.confirm.bind(ui);
  ui.confirm = async (prompt, ...args) => {
    const result = await confirm(prompt, ...args);
    if (prompt.includes('最终确认')) await f.git.run(['remote', 'add', 'origin', 'https://github.com/other/keep.git']);
    return result;
  };
  await assert.rejects(addRemote(ui, f.git), /没有覆盖/u);
  assert.deepEqual(f.api.creates, []);
  assert.deepEqual(await f.git.remoteUrls('origin'), ['https://github.com/other/keep.git']);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.deepEqual(ui.answers, []);
});

test('creation rechecks transport after native actor precheck immediately before the server write', async (t) => {
  const f = await managedCreation(t);
  const hosts = new HostStore();
  f.api.beforeCreateWrite = async () => hosts.set(f.path, { mode: 'https', host: DEFAULT_HOST });
  const ui = new ScriptedConsole(['1', '1', 'transport-race', '1', 'y']);
  await assert.rejects(addRemote(ui, f.git), /传输配置.*发生变化/u);
  assert.equal(f.api.authentications, 1);
  assert.equal(f.api.logins, 2, 'the native API stub must model its actor precheck before the write guard');
  assert.deepEqual(f.api.creates, []);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.deepEqual(await hosts.get(f.path), { mode: 'https', host: DEFAULT_HOST });
  assert.deepEqual(ui.answers, []);
});

test('creation rechecks profile snapshot after confirmation and never silently rebinds', async (t) => {
  const f = await managedCreation(t);
  const ui = new ScriptedConsole(['1', '1', 'race-profile', '1', 'y']);
  const confirm = ui.confirm.bind(ui);
  ui.confirm = async (prompt, ...args) => {
    const result = await confirm(prompt, ...args);
    if (prompt.includes('最终确认')) {
      const changed = new Profile({ ...f.profile, github_login: 'changed-user' });
      await writeFile(path.join(path.dirname(f.profile.private_key), 'profile.json'), JSON.stringify(f.store.encodeProfile(changed)));
    }
    return result;
  };
  await assert.rejects(addRemote(ui, f.git), /账号或项目绑定.*发生变化/u);
  assert.deepEqual(f.api.creates, []);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.deepEqual(ui.answers, []);
});

test('creation rechecks an independently changed project binding before server write', async (t) => {
  const f = await managedCreation(t);
  const ui = new ScriptedConsole(['1', '1', 'race-binding', '1', 'y']);
  const confirm = ui.confirm.bind(ui);
  ui.confirm = async (prompt, ...args) => {
    const result = await confirm(prompt, ...args);
    if (prompt.includes('最终确认')) await f.store.bind(f.path, f.profile.profile_id);
    return result;
  };
  await assert.rejects(addRemote(ui, f.git), /账号或项目绑定.*发生变化/u);
  assert.deepEqual(f.api.creates, []);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal((await resolveBinding(f.path)).profile_id, f.profile.profile_id);
  assert.deepEqual(ui.answers, []);
});

test('native actor mismatch stops a bound personal creation before draft prompts without automatic gh switching', async (t) => {
  const f = await managedCreation(t, { bound: true, login: 'other-user' });
  const ui = new ScriptedConsole(['1'], { quick: true });
  await assert.rejects(addRemote(ui, f.git), /登录账号.*不一致.*不会自动切换账号/u);
  assert.equal(f.api.authentications, 1);
  assert.deepEqual(f.api.ghCalls, []);
  assert.deepEqual(f.api.creates, []);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal((await resolveBinding(f.path)).profile_id, f.profile.profile_id);
  assert.doesNotMatch(ui.transcript, /GitHub 仓库名称|仓库可见性|最终确认|改变外部 gh/u);
  assert.deepEqual(ui.answers, []);
});

test('native authentication failure leaves an unbound project untouched before name and visibility', async (t) => {
  const f = await managedCreation(t);
  f.api.authenticateError = new GitError('native authentication fixture failed');
  const ui = new ScriptedConsole(['1', '1']);
  await assert.rejects(addRemote(ui, f.git), /native authentication fixture failed/u);
  assert.equal(f.api.authentications, 1);
  assert.deepEqual(f.api.ghCalls, []);
  assert.deepEqual(f.api.creates, []);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.doesNotMatch(ui.transcript, /GitHub 仓库名称|仓库可见性|最终确认/u);
  assert.deepEqual(ui.answers, []);
});

test('creation stops if a Git operation starts during final confirmation', async (t) => {
  const f = await managedCreation(t);
  const ui = new ScriptedConsole(['1', '1', 'operation-started', '1', 'y']);
  const confirm = ui.confirm.bind(ui);
  ui.confirm = async (prompt, ...args) => {
    const result = await confirm(prompt, ...args);
    if (prompt.includes('最终确认')) await writeFile(await f.git.gitPath('MERGE_HEAD'), '0'.repeat(40));
    return result;
  };
  await assert.rejects(addRemote(ui, f.git), /尚未完成的合并/u);
  assert.deepEqual(f.api.creates, []);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.deepEqual(ui.answers, []);
});

test('created URL is printed immediately even when subsequent repository metadata validation fails', async (t) => {
  const f = await managedCreation(t);
  const ui = new ScriptedConsole(['1', '1', 'metadata-fails', '1', 'y']);
  f.api.afterCreated = async () => assert.match(ui.transcript, /GitHub 仓库已创建：https:\/\/github\.com\/fixture-login\/metadata-fails/u);
  f.api.createError = new GitError('simulated metadata validation failure');
  await assert.rejects(addRemote(ui, f.git), /metadata validation/u);
  assert.match(ui.transcript, /仓库创建：已完成/u);
  assert.match(ui.transcript, /本地关联：未执行|本地关联：失败/u);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.deepEqual(ui.answers, []);
});

test('created repository survives remote-add failure and reports completed stage and URL', async (t) => {
  const f = await managedCreation(t);
  f.api.remoteAddError = new GitError('simulated remote-add failure');
  const ui = new ScriptedConsole(['1', '1', 'link-fails', '1', 'y']);
  await assert.rejects(addRemote(ui, f.git), /remote-add failure/u);
  assert.match(ui.transcript, /GitHub 仓库已创建：https:\/\/github\.com\/fixture-login\/link-fails/u);
  assert.match(ui.transcript, /仓库创建：已完成/u);
  assert.match(ui.transcript, /本地关联：未执行|本地关联：失败/u);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.equal(f.pushes.length, 0);
  assert.deepEqual(ui.answers, []);
});

test('created and linked repository survives binding failure without deletion or push', async (t) => {
  const f = await managedCreation(t);
  t.mock.method(ProfileStore.prototype, 'bind', async () => { throw new GitError('simulated binding failure'); });
  const ui = new ScriptedConsole(['1', '1', 'bind-fails', '1', 'y']);
  await assert.rejects(addRemote(ui, f.git), /binding failure/u);
  assert.match(ui.transcript, /GitHub 仓库已创建：https:\/\/github\.com\/fixture-login\/bind-fails/u);
  assert.match(ui.transcript, /本地关联：部分完成/u);
  assert.match(ui.transcript, /不会自动删除或回滚/u);
  assert.deepEqual(await f.git.remoteUrls('origin'), ['git@github.com:fixture-login/bind-fails.git']);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.equal(f.pushes.length, 0);
  assert.deepEqual(ui.answers, []);
});

for (const direction of ['insteadOf', 'pushInsteadOf']) {
  test(`created repository refuses rewritten ${direction} destination and retains completed stages`, async (t) => {
    const f = await managedCreation(t);
    await f.git.run(['config', `url.git@github.com:unexpected-owner/.${direction}`, 'git@github.com:fixture-login/']);
    const ui = new ScriptedConsole(['1', '1', 'wrong-target', '1', 'y']);
    await assert.rejects(addRemote(ui, f.git), /实际获取\/推送目标.*拒绝继续上传/u);
    assert.equal(f.api.creates.length, 1);
    assert.equal(await f.git.config('remote.origin.url'), 'git@github.com:fixture-login/wrong-target.git');
    assert.match(ui.transcript, /GitHub 仓库已创建：https:\/\/github\.com\/fixture-login\/wrong-target/u);
    assert.match(ui.transcript, /本地关联：部分完成/u);
  assert.match(ui.transcript, /不会自动删除或回滚/u);
    assert.equal(await resolveBinding(f.path), undefined);
    assert.equal(f.pushes.length, 0);
    assert.deepEqual(ui.answers, []);
  });
}

test('created repository rejects even same-owner SSH-to-HTTPS rewrites instead of using external credentials', async (t) => {
  const f = await managedCreation(t);
  await f.git.run(['config', 'url.https://github.com/.insteadOf', 'git@github.com:']);
  const ui = new ScriptedConsole(['1', '1', 'same-target', '1', 'y']);
  await assert.rejects(addRemote(ui, f.git), /不能换协议.*外部凭据|HTTPS.*不能改用外部 HTTPS 凭据/u);
  assert.equal(f.api.creates.length, 1);
  assert.equal(await f.git.config('remote.origin.url'), 'git@github.com:fixture-login/same-target.git');
  assert.match(ui.transcript, /GitHub 仓库已创建：https:\/\/github\.com\/fixture-login\/same-target/u);
  assert.match(ui.transcript, /本地关联：部分完成/u);
  assert.match(ui.transcript, /不会自动删除或回滚/u);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.equal(f.pushes.length, 0);
  assert.deepEqual(ui.answers, []);
});

test('new target is propagated through uploadLocal saveAndPush and push despite origin upstream and pushRemote', async (t) => {
  const f = await managedCreation(t, { bound: true });
  await f.git.run(['branch', '-m', 'feature/local']);
  await f.write();
  await f.commit();
  const origin = await f.remote();
  f.transports.set('origin', origin);
  await push(new ScriptedConsole(['1', 'upstream-main', 'y']), f.git);
  const original = await new Git(origin).value('rev-parse', 'upstream-main');
  const oldPush = path.join(f.base, 'old-push.git');
  const chosen = path.join(f.base, 'chosen.git');
  for (const bare of [oldPush, chosen]) await new Git(f.base).run(['init', '--bare', '--initial-branch=main', bare]);
  await f.git.run(['remote', 'add', 'old-push', oldPush]);
  await f.git.run(['config', 'branch.feature/local.pushRemote', 'old-push']);
  await f.git.run(['config', 'remote.pushDefault', 'origin']);
  await f.write('only-chosen.txt', 'one-time target\n');
  f.transports.set('chosen', chosen);
  const ui = new ScriptedConsole(['2', '1', 'chosen-project', '1', 'chosen', 'y', 'a', 'upload only chosen', 'y', 'y', '', 'y']);
  assert.equal(await uploadLocal(ui, f.path, { selectDirectory: false }), f.path);
  const head = await f.git.value('rev-parse', 'HEAD');
  assert.equal(await new Git(chosen).value('rev-parse', 'refs/heads/feature/local'), head);
  assert.equal(await new Git(origin).value('rev-parse', 'upstream-main'), original);
  assert.equal(await new Git(oldPush).hasCommits(), false);
  assert.equal(await f.git.config('remote.origin.url'), origin);
  assert.equal(await f.git.config('branch.feature/local.remote'), 'origin');
  assert.equal(await f.git.config('branch.feature/local.merge'), 'refs/heads/upstream-main');
  assert.equal(await f.git.config('branch.feature/local.pushRemote'), 'old-push');
  assert.equal(await f.git.config('remote.pushDefault'), 'origin');
  assert.equal(await f.git.branch(), 'feature/local');
  assert.equal(f.pushes.length, 2);
  assert.deepEqual(f.pushes.at(-1).args, ['push', '--no-follow-tags', '--', 'chosen', `${head}:refs/heads/feature/local`]);
  assert.equal(f.pushes.at(-1).config['user.name'], f.profile.name);
  assert.match(ui.transcript, /一次性上传目标：chosen/u);
  assert.deepEqual(ui.answers, []);
});

test('uploadLocal new first target pushes once and sets upstream only on successful upload', async (t) => {
  const f = await managedCreation(t);
  await f.write();
  const target = path.join(f.base, 'first-target.git');
  await new Git(f.base).run(['init', '--bare', '--initial-branch=main', target]);
  f.transports.set('origin', target);
  const ui = new ScriptedConsole(['1', '1', 'first-project', '1', 'y', 'a', 'first upload', 'y', 'y', '', 'y']);
  assert.equal(await uploadLocal(ui, f.path, { selectDirectory: false }), f.path);
  assert.equal(f.pushes.length, 1);
  assert.deepEqual(f.pushes[0].args, ['push', '--no-follow-tags', '--', 'origin', `${await f.git.value('rev-parse', 'HEAD')}:refs/heads/main`]);
  assert.equal(await new Git(target).value('rev-parse', 'main'), await f.git.value('rev-parse', 'HEAD'));
  assert.equal(await f.git.config('branch.main.remote'), 'origin');
  assert.equal(await f.git.config('branch.main.merge'), 'refs/heads/main');
  assert.equal(await f.git.branch(), 'main');
  assert.deepEqual(ui.answers, []);
});

test('one-time target validates refspec and never repairs an incomplete existing pull upstream', async (t) => {
  const f = await prepared(t);
  await f.git.run(['config', 'branch.main.remote', 'origin']);
  const invalid = new ScriptedConsole(['bad..branch']);
  await assert.rejects(push(invalid, f.git, { remote: 'origin' }), /分支名称无效/u);
  assert.deepEqual(invalid.answers, []);
  const ui = new ScriptedConsole(['release', 'y']);
  await push(ui, f.git, { remote: 'origin' });
  assert.equal(await f.git.config('branch.main.remote'), 'origin');
  assert.equal(await f.git.config('branch.main.merge'), '');
  assert.equal(await new Git(f.target).value('rev-parse', 'refs/heads/release'), await f.git.value('rev-parse', 'HEAD'));
  assert.deepEqual(ui.answers, []);
});

test('push selecting a newly created remote never recursively pushes inside addRemote', async (t) => {
  const f = await managedCreation(t);
  await f.write();
  await f.commit();
  const target = path.join(f.base, 'push-target.git');
  await new Git(f.base).run(['init', '--bare', '--initial-branch=main', target]);
  f.transports.set('origin', target);
  const ui = new ScriptedConsole(['1', '1', 'push-target', '1', 'y', '', 'y']);
  await push(ui, f.git);
  assert.equal(f.api.creates.length, 1);
  assert.equal(f.pushes.length, 1);
  assert.equal(await new Git(target).value('rev-parse', 'main'), await f.git.value('rev-parse', 'HEAD'));
  assert.deepEqual(ui.answers, []);
});

for (const address of ['git@github.com:other-owner/not-created.git', 'https://github.com/fixture-login/pinned-project.git']) {
  test(`created target stays pinned when a real post-commit hook changes remote to ${address}`, { skip: process.platform === 'win32' }, async (t) => {
    const f = await managedCreation(t);
    await f.write();
    const hooks = path.join(f.base, 'offline-hooks');
    await mkdir(hooks);
    const hook = path.join(hooks, 'post-commit');
    await writeFile(hook, `#!/bin/sh\ngit config remote.origin.url '${address}'\n`);
    await chmod(hook, 0o700);
    await f.git.run(['config', 'core.hooksPath', hooks]);
    const ui = new ScriptedConsole(['1', '1', 'pinned-project', '1', 'y', 'a', 'saved locally'], { quick: true });
    await assert.rejects(uploadLocal(ui, f.path, { selectDirectory: false }), /规范(?: SSH)?地址.*拒绝继续上传/u);
    assert.equal(f.api.creates.length, 1);
    assert.equal(f.pushes.length, 0);
    assert.equal(await f.git.hasCommits(), true);
    assert.equal(await f.git.config('remote.origin.url'), address);
    assert.equal(await f.git.config('branch.main.remote'), '');
    assert.match(ui.transcript, /GitHub 仓库已创建：https:\/\/github\.com\/fixture-login\/pinned-project/u);
    assert.deepEqual(ui.answers, []);
  });
}

test('created selection from push chooseRemote remains pinned through the final upload confirmation', async (t) => {
  const f = await managedCreation(t);
  await f.write();
  await f.commit();
  const ui = new ScriptedConsole(['1', '1', 'direct-pinned', '1', 'y', '', 'y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async (prompt, ...args) => {
    const result = await confirm(prompt, ...args);
    if (prompt.includes('确认联网并上传')) await f.git.run(['remote', 'set-url', '--push', 'origin', 'git@github.com:other/private.git']);
    return result;
  };
  await assert.rejects(push(ui, f.git), /规范(?: SSH)?地址.*拒绝继续上传/u);
  assert.equal(f.api.creates.length, 1);
  assert.equal(f.pushes.length, 0);
  assert.equal(await f.git.config('branch.main.remote'), '');
  assert.match(ui.transcript, /GitHub 仓库已创建：https:\/\/github\.com\/fixture-login\/direct-pinned/u);
  assert.deepEqual(ui.answers, []);
});

test('created selection refuses a same-repository HTTPS rewrite introduced during final upload confirmation', async (t) => {
  const f = await managedCreation(t, { bound: true });
  await f.write();
  await f.commit();
  const ui = new ScriptedConsole(['1', 'last-second-rewrite', '1', 'y', '', 'y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async (prompt, ...args) => {
    const result = await confirm(prompt, ...args);
    if (prompt.includes('确认联网并上传')) await f.git.run(['config', 'url.https://github.com/.pushInsteadOf', 'git@github.com:']);
    return result;
  };
  await assert.rejects(uploadLocal(ui, f.path, { selectDirectory: false }), /不能换协议.*外部凭据|HTTPS.*不能改用外部 HTTPS 凭据/u);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.api.creates.length, 1);
  assert.equal(await f.git.config('remote.origin.url'), 'git@github.com:fixture-login/last-second-rewrite.git');
  assert.deepEqual(ui.answers, []);
});

test('created selection refuses a project binding removed during final upload confirmation', async (t) => {
  const f = await managedCreation(t, { bound: true });
  await f.write();
  await f.commit();
  const ui = new ScriptedConsole(['1', 'last-second-unbind', '1', 'y', '', 'y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async (prompt, ...args) => {
    const result = await confirm(prompt, ...args);
    if (prompt.includes('确认联网并上传')) await f.store.unbind(f.path);
    return result;
  };
  await assert.rejects(uploadLocal(ui, f.path, { selectDirectory: false }), /账号或项目绑定已发生变化/u);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.api.creates.length, 1);
  assert.equal(await f.git.hasCommits(), true);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.deepEqual(ui.answers, []);
});

test('created selection refuses profile edits during final upload confirmation', async (t) => {
  const f = await managedCreation(t, { bound: true });
  await f.write();
  await f.commit();
  const ui = new ScriptedConsole(['1', 'last-second-profile', '1', 'y', '', 'y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async (prompt, ...args) => {
    const result = await confirm(prompt, ...args);
    if (prompt.includes('确认联网并上传')) {
      const changed = new Profile({ ...f.profile, name: 'Changed Author' });
      await writeFile(path.join(path.dirname(f.profile.private_key), 'profile.json'), JSON.stringify(f.store.encodeProfile(changed)));
    }
    return result;
  };
  await assert.rejects(uploadLocal(ui, f.path, { selectDirectory: false }), /快照已过期|账号或项目绑定已发生变化/u);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.api.creates.length, 1);
  assert.equal(await f.git.hasCommits(), true);
  assert.deepEqual(ui.answers, []);
});

test('manually configured existing HTTPS target cannot change after its final displayed confirmation', async (t) => {
  const f = await prepared(t);
  await f.git.run(['remote', 'set-url', 'origin', 'https://github.com/expected/repo.git']);
  let attemptedPush = false;
  const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    if (args[0] === 'push') { attemptedPush = true; throw new Error('unexpected network push'); }
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole(['1', '', 'y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async (prompt, ...args) => {
    const result = await confirm(prompt, ...args);
    if (prompt.includes('确认联网并上传')) await f.git.run(['remote', 'set-url', 'origin', 'https://github.com/unexpected/repo.git']);
    return result;
  };
  await assert.rejects(push(ui, f.git), /上传目标在选择或确认期间发生变化/u);
  assert.equal(attemptedPush, false);
  assert.equal(await new Git(f.target).hasCommits(), false);
  assert.equal(await f.git.config('branch.main.remote'), '');
  assert.match(ui.transcript, /上传目标：https:\/\/github\.com\/expected\/repo.git/u);
  assert.deepEqual(ui.answers, []);
});

test('created repository rechecks remote-name collision after the server callback without overwriting', async (t) => {
  const f = await managedCreation(t);
  f.api.afterCreated = async () => { await f.git.run(['remote', 'add', 'origin', 'https://github.com/other/retained.git']); };
  const ui = new ScriptedConsole(['1', '1', 'created-before-collision', '1', 'y']);
  await assert.rejects(addRemote(ui, f.git), /没有覆盖/u);
  assert.equal(f.api.creates.length, 1);
  assert.deepEqual(await f.git.remoteUrls('origin'), ['https://github.com/other/retained.git']);
  assert.match(ui.transcript, /GitHub 仓库已创建：https:\/\/github\.com\/fixture-login\/created-before-collision/u);
  assert.match(ui.transcript, /仓库创建：已完成/u);
  assert.match(ui.transcript, /本地关联：未执行|本地关联：失败/u);
  assert.equal(f.pushes.length, 0);
  assert.deepEqual(ui.answers, []);
});

test('unbound SSH remote never falls back to an external default key', async (t) => {
  const f = await fixture(t);
  await assert.rejects(remoteContext(new ScriptedConsole([], { quick: true }), f.git, ['git@github.com:demo/project.git']), /没有选择软件账号/u);
});

test('HTTPS project mode rejects actual SSH URLs without reading a default key or networking', async t => {
  const f = await fixture(t);
  await new HostStore().set(f.path, { mode: 'https', host: DEFAULT_HOST });
  const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    assert.ok(!['push', 'fetch', 'pull', 'clone', 'ls-remote'].includes(args[0]), 'transport mismatch must fail before any network operation');
    return run.call(this, args, options);
  });
  for (const address of ['git@github.com:person/repo.git', 'ssh://git@git.example.invalid/team/repo.git', 'host-alias:team/repo.git']) {
    const ui = new ScriptedConsole([], { quick: true });
    await assert.rejects(remoteContext(ui, f.git, [address]), /HTTPS.*SSH|传输模式/u);
    assert.deepEqual(ui.answers, []);
  }
});

for (const rewritten of [false, true]) {
  test(`HTTPS project clone rejects ${rewritten ? 'a URL rewritten to' : 'a pasted'} SSH transport before download`, async t => {
    const f = await fixture(t);
    await new HostStore().set(f.path, { mode: 'https', host: DEFAULT_HOST });
    if (rewritten) await f.git.run(['config', 'url.git@github.com:.insteadOf', 'https://github.com/']);
    const run = Git.prototype.run;
    t.mock.method(Git.prototype, 'run', async function(args, options) {
      assert.ok(!['push', 'fetch', 'pull', 'clone'].includes(args[0]), 'mismatched clone must never launch a transport');
      assert.ok(args[0] !== 'ls-remote' || args.includes('--get-url'), 'only offline URL resolution is allowed');
      return run.call(this, args, options);
    });
    const address = rewritten ? 'https://github.com/person/repo.git' : 'git@github.com:person/repo.git';
    const ui = new ScriptedConsole([address, f.path, 'mismatched-clone'], { quick: true });
    await assert.rejects(clone(ui, f.path), /HTTPS.*SSH|传输模式/u);
    await assert.rejects(stat(path.join(f.path, 'mismatched-clone')), { code: 'ENOENT' });
    assert.deepEqual(ui.answers, []);
  });
}

test('quick save uploads and clean retry does not ask redundant confirmations', async (t) => {
  const f = await fixture(t);
  const target = await f.remote();
  await f.write();
  const ui = new ScriptedConsole(['a', 'quick commit', '1', ''], { quick: true });
  await saveAndPush(ui, f.path);
  assert.equal(await new Git(target).value('rev-parse', 'main'), await f.git.value('rev-parse', 'HEAD'));
  const retry = new ScriptedConsole([], { quick: true });
  await saveAndPush(retry, f.path);
  assert.match(retry.transcript, /推送成功/u);
  assert.doesNotMatch(ui.transcript + retry.transcript, /\[y\/N\]/u);
});

test('unselected dirty files do not prevent retrying only existing commits', async (t) => {
  const f = await prepared(t);
  await f.write('hello.txt', 'remaining local changes\n');
  const ui = new ScriptedConsole(['', 'y', '1', '', 'y']);
  await saveAndPush(ui, f.path);
  assert.equal(await new Git(f.target).value('rev-parse', 'main'), await f.git.value('rev-parse', 'HEAD'));
  assert.equal((await f.git.changes())[0].staged, false);
  assert.match(ui.transcript, /仅检查目标并上传已有提交/u);
});

test('pull fast-forwards from a local bare remote', async (t) => {
  const f = await synchronized(t);
  await advance(f.peer);
  await pull(new ScriptedConsole(['y']), f.path);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), await f.peer.value('rev-parse', 'HEAD'));
});

test('declining pull does not even fetch remote-tracking refs', async (t) => {
  const f = await synchronized(t);
  await advance(f.peer);
  const head = await f.git.value('rev-parse', 'HEAD');
  await pull(new ScriptedConsole(['n']), f.path);
  assert.equal(await f.git.value('rev-parse', 'refs/remotes/origin/main'), head);
});

test('divergent pull stops without merge or history loss', async (t) => {
  const f = await synchronized(t);
  await advance(f.peer);
  await f.write('local.txt');
  await f.commit('local update');
  const head = await f.git.value('rev-parse', 'HEAD');
  await assert.rejects(pull(new ScriptedConsole(['y']), f.path), GitError);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), head);
  assert.equal(await f.git.operation(), '');
});

test('dirty worktree and missing upstream both stop pull', async (t) => {
  const f = await fixture(t);
  await f.write();
  await assert.rejects(pull(new ScriptedConsole(), f.path), /未提交/u);
  await f.commit();
  await assert.rejects(pull(new ScriptedConsole(), f.path), /没有远程上游/u);
});

test('pull rejects local or malformed upstream configuration', async (t) => {
  const f = await prepared(t);
  await f.git.run(['config', 'branch.main.remote', '.']);
  await f.git.run(['config', 'branch.main.merge', 'refs/heads/main']);
  await assert.rejects(pull(new ScriptedConsole(), f.path), /没有远程上游/u);
  await f.git.run(['config', 'branch.main.remote', 'origin']);
  await f.git.run(['config', 'branch.main.merge', 'refs/tags/main']);
  await assert.rejects(pull(new ScriptedConsole(), f.path), /上游配置无效/u);
});

test('uploading a subdirectory cannot capture the parent repository', async (t) => {
  const f = await fixture(t);
  const child = path.join(f.path, 'child');
  await mkdir(child);
  await assert.rejects(uploadLocal(new ScriptedConsole([child]), f.path), /上层仓库/u);
});

test('declining initialization leaves an existing folder untouched', async (t) => {
  const f = await fixture(t);
  const fresh = path.join(f.base, 'fresh');
  await mkdir(fresh);
  await uploadLocal(new ScriptedConsole([fresh, 'n']), f.path);
  await assert.rejects(stat(path.join(fresh, '.git')), { code: 'ENOENT' });
});

test('initialize and upload a project using isolated identity and a real local remote', async (t) => {
  const f = await fixture(t);
  const fresh = path.join(f.base, '新建项目');
  await mkdir(fresh);
  await writeFile(path.join(fresh, 'README.md'), '# Demo\n');
  const target = await f.remote();
  const run = Git.prototype.run;
  const handle = t.mock.method(Git.prototype, 'run', async function (args, options) {
    if (this.directory !== fresh) return run.call(this, args, options);
    if (args[0] === 'config' && args[1] === '--get' && args[2] === 'user.name') return { status: 0, stdout: Buffer.from('应用身份\n'), stderr: Buffer.alloc(0) };
    if (args[0] === 'config' && args[1] === '--get' && args[2] === 'user.email') return { status: 0, stdout: Buffer.from('app@example.invalid\n'), stderr: Buffer.alloc(0) };
    let effective = args;
    if (args[0] === 'remote' && args[1] === 'add') effective = ['remote', 'add', args[2], target];
    // Model the ephemeral -c identity provided by projectGit, without creating real profiles or keys.
    return run.call(this, ['-c', 'user.name=应用身份', '-c', 'user.email=app@example.invalid', ...effective], options);
  });
  const ui = new ScriptedConsole([fresh, 'y', '2', 'https://github.com/demo/repo', '', 'y', 'a', '首次提交', 'y', 'y', '', 'y']);
  assert.equal(await uploadLocal(ui, f.path), fresh);
  handle.mock.restore();
  const git = new Git(fresh);
  assert.equal(await git.config('user.name'), '');
  assert.equal(await git.config('user.email'), '');
  assert.equal(await git.value('log', '-1', '--format=%an|%ae'), '应用身份|app@example.invalid');
  assert.equal(await git.value('rev-parse', 'HEAD'), await new Git(target).value('rev-parse', 'main'));
  assert.match(ui.transcript, /本地 Git 仓库已初始化/u);
  assert.match(ui.transcript, /推送成功/u);
});

test('bare repository and malformed .git directory are not initialized over', async (t) => {
  const f = await fixture(t);
  const bare = await f.remote();
  await assert.rejects(uploadLocal(new ScriptedConsole([bare]), f.path), /不是可初始化/u);
  const fresh = path.join(f.base, 'broken');
  await mkdir(fresh);
  await writeFile(path.join(fresh, '.git'), 'broken\n');
  await assert.rejects(uploadLocal(new ScriptedConsole([fresh]), f.path), /不是可初始化/u);
  assert.equal(await readFile(path.join(fresh, '.git'), 'utf8'), 'broken\n');
});

test('choose directory resolves relative paths and rejects missing directories', async (t) => {
  const f = await fixture(t);
  const child = path.join(f.path, 'child');
  await mkdir(child);
  assert.equal(await chooseDirectory(new ScriptedConsole(['child']), f.path), child);
  await assert.rejects(chooseDirectory(new ScriptedConsole(['missing']), f.path), /目录不存在/u);
  assert.equal(await chooseDirectory(new ScriptedConsole(['missing']), f.path, { existing: false }), path.join(f.path, 'missing'));
});

test('declining clone does not connect or create a directory', async (t) => {
  const f = await fixture(t);
  const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    assert.notEqual(args[0], 'clone', 'declined clone must not run network command');
    assert.notEqual(args[0], 'fetch');
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole(['https://github.com/person/repo.git', f.base, 'new', 'n']);
  assert.equal(await clone(ui, f.path), undefined);
  await assert.rejects(stat(path.join(f.base, 'new')), { code: 'ENOENT' });
});

test('clone accepts a generic host after safe URL resolution but rejects unsafe rewritten destinations', async (t) => {
  const f = await fixture(t);
  await f.git.run(['config', 'url.https://gitlab.example.invalid/.insteadOf', 'https://source.example.invalid/']);
  const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    assert.notEqual(args[0], 'clone', 'declined generic clone must not run network command');
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole(['https://source.example.invalid/team/repo.git', f.path, 'cloned', 'n']);
  assert.equal(await clone(ui, f.path), undefined);
  assert.match(ui.transcript, /https:\/\/gitlab\.example\.invalid\/team\/repo\.git/u);
  await f.git.run(['config', '--unset-all', 'url.https://gitlab.example.invalid/.insteadOf']);
  await f.git.run(['config', 'url.ext::unsafe.insteadOf', 'https://source.example.invalid/']);
  await assert.rejects(clone(new ScriptedConsole(['https://source.example.invalid/team/repo.git', f.path, 'unsafe']), f.path), /地址|协议/u);
  await assert.rejects(stat(path.join(f.path, 'cloned')), { code: 'ENOENT' });
});

test('HTTPS-to-SSH clone rewrite requires a software account before any download', async (t) => {
  const f = await fixture(t);
  await f.git.run(['config', 'url.git@github.com:.insteadOf', 'https://github.com/']);
  const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    assert.notEqual(args[0], 'clone', 'unbound SSH must never reach the network');
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole(['https://github.com/person/repo.git', f.path, 'cloned'], { quick: true });
  assert.equal(await clone(ui, f.path), undefined);
  assert.match(ui.transcript, /未选择账号/u);
  await assert.rejects(stat(path.join(f.path, 'cloned')), { code: 'ENOENT' });
});

test('clone rejects credentials, web tree URLs, ext transports and unsafe hosts while generic hosts remain valid', async (t) => {
  const f = await fixture(t);
  for (const address of ['https://token@github.com/person/repo', 'https://github.com/person/repo/tree/main', 'ext::ssh://git@example.invalid/%h', 'file:///tmp/repo']) {
    await assert.rejects(clone(new ScriptedConsole([address]), f.path), /地址|协议|仅接受/u);
  }
  const ui = new ScriptedConsole(['https://gitlab.com/person/repo.git', f.path, 'generic', 'n']);
  assert.equal(await clone(ui, f.path), undefined);
  assert.match(ui.transcript, /gitlab\.com\/person\/repo\.git/u);
});

test('clone locally retries traversal and Windows-incompatible destination names without repeating earlier inputs', async (t) => {
  const f = await fixture(t);
  const source = 'https://github.com/person/repo.git';
  for (const name of ['.', '..', '../escape', 'C:project', 'C:\\project', 'folder/name', 'trailing.', '-option', 'bad?name', 'CON']) {
    const ui = new ScriptedConsole([source, f.base, name, 'valid-name', 'n']);
    assert.equal(await clone(ui, f.path), undefined);
    assert.match(ui.transcript, /普通文件夹名称/u);
    assert.equal(ui.messages.filter(line => line.startsWith('Git 仓库的 SSH/HTTPS 地址')).length, 1);
    assert.equal(ui.messages.filter(line => line.startsWith('项目文件夹路径')).length, 1);
    assert.deepEqual(ui.answers, []);
  }
});

test('clone never overwrites an existing target', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.base, 'existing');
  await mkdir(target);
  await writeFile(path.join(target, 'keep.txt'), 'keep\n');
  const ui = new ScriptedConsole(['https://github.com/person/repo.git', f.base, 'existing', 'another-name', 'n']);
  assert.equal(await clone(ui, f.path), undefined);
  assert.match(ui.transcript, /已存在且非空/u);
  assert.deepEqual(ui.answers, []);
  assert.equal(await readFile(path.join(target, 'keep.txt'), 'utf8'), 'keep\n');
});

test('clone success path downloads only a local test repository via an intercepted transport', async (t) => {
  const f = await prepared(t);
  await push(new ScriptedConsole(['1', '', 'y']), f.git);
  const run = Git.prototype.run;
  const source = 'https://github.com/person/repo.git';
  let downloads = 0;
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    if (args[0] === 'clone') {
      downloads++;
      assert.deepEqual(args.slice(0, 3), ['clone', '--', source]);
      // No real GitHub connection: substitute only the transport, retaining real Git clone behavior.
      return run.call(this, ['clone', '--', f.target, args[3]], options);
    }
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole([source, f.base, '下载项目'], { quick: true });
  const target = await clone(ui, f.path);
  assert.equal(downloads, 1);
  assert.equal(await new Git(target).value('rev-parse', 'HEAD'), await f.git.value('rev-parse', 'HEAD'));
  assert.equal(await readFile(path.join(target, 'hello.txt'), 'utf8'), 'first\n');
  assert.match(ui.transcript, /尚未主动执行其中的任何脚本/u);
  assert.doesNotMatch(ui.transcript, /\[y\/N\]/u);
});

test('empty history can be inspected without requiring a commit', async (t) => {
  const f = await fixture(t);
  const ui = new ScriptedConsole(['4']);
  await inspect(ui, f.path);
  assert.match(ui.transcript, /还没有提交记录/u);
});

test('inspect diff directly displays selected full text with external diff and textconv disabled', async (t) => {
  const f = await fixture(t);
  await f.write();
  await f.commit();
  await f.write('hello.txt', 'changed\n');
  const run = Git.prototype.run;
  const diffs = [];
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    if (args[0] === 'diff') diffs.push([...args]);
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole(['2']);
  await inspect(ui, f.path);
  assert.ok(ui.transcript.includes('changed'));
  assert.doesNotMatch(ui.transcript, /\[y\/N\]/u);
  assert.deepEqual(ui.answers, []);
  assert.equal(diffs.length, 2);
  assert.ok(diffs.every((args) => args.includes('--no-ext-diff') && args.includes('--no-textconv')));
  assert.ok(diffs[0].includes('--stat'));
  assert.ok(!diffs[1].includes('--stat'));
});

test('detached HEAD is viewable but write workflows stop', async (t) => {
  const f = await fixture(t);
  await f.write();
  await f.commit();
  await f.git.run(['checkout', '--detach']);
  const ui = new ScriptedConsole(['1']);
  await inspect(ui, f.path);
  assert.match(ui.transcript, /游离 HEAD/u);
  await assert.rejects(saveAndPush(new ScriptedConsole(), f.path), /游离 HEAD/u);
});
