import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Git, GitError } from '../dist/git.js';
import { Cancelled } from '../dist/ui.js';
import { deleteRemoteBranch, fetchRemote, forcePush, remotesMenu, setUpstream } from '../dist/remotes.js';
import { remoteRefOid } from '../dist/workflows.js';
import { ProfileStore } from '../dist/profiles.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function commitIn(repo, name, content, message = name) {
  await writeFile(join(repo.directory, name), content);
  await repo.stagePaths([name]);
  await repo.run(['commit', '-m', message]);
  return repo.value('rev-parse', 'HEAD');
}

async function divergent(t, { splitUrls = false } = {}) {
  const f = await fixture(t, { committed: true });
  process.env.GIT_ALLOW_PROTOCOL = 'file';
  const bare = await f.remote();
  const initial = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['push', 'origin', 'main']);
  const localPath = join(f.base, 'local clone');
  const peerPath = join(f.base, 'peer clone');
  // Two actual clones share one bare repository, then independently advance main.
  for (const directory of [localPath, peerPath]) await new Git(f.base).run(['clone', '--', bare, directory]);
  const local = new Git(localPath), peer = new Git(peerPath), server = new Git(bare);
  for (const repo of [local, peer]) {
    await repo.run(['config', 'user.name', 'Offline Fixture']);
    await repo.run(['config', 'user.email', 'offline@example.invalid']);
    await repo.run(['config', 'commit.gpgsign', 'false']);
  }
  const localOid = await commitIn(local, 'local.txt', 'local divergent commit\n');
  const peerOid = await commitIn(peer, 'peer.txt', 'peer divergent commit\n');
  await peer.run(['push', 'origin', 'main']);
  assert.equal(await local.value('rev-parse', 'refs/remotes/origin/main'), initial);
  await local.run(['fetch', '--no-tags', '--', bare, peerOid]);
  assert.equal((await local.run(['merge-base', '--is-ancestor', peerOid, localOid], { check: false })).status, 1);
  await local.run(['config', 'push.followTags', 'true']);
  await local.run(['tag', '-a', 'local-only-tag', '-m', 'must not be followed']);
  let fetchBare = bare;
  let fetchUrl = bare, pushUrl = bare;
  const transports = new Map([[bare, bare]]);
  if (splitUrls) {
    fetchBare = join(f.base, 'fetch-only.git');
    await new Git(f.base).run(['clone', '--bare', '--', bare, fetchBare]);
    await new Git(fetchBare).run(['update-ref', 'refs/heads/main', initial]);
    fetchUrl = 'https://fetch.example.invalid/team/project.git';
    pushUrl = 'https://push.example.invalid/team/project.git';
    await local.run(['remote', 'set-url', 'origin', fetchUrl]);
    await local.run(['remote', 'set-url', '--push', 'origin', pushUrl]);
    transports.set(fetchUrl, fetchBare);
    transports.set(pushUrl, bare);
  }
  const run = Git.prototype.run;
  const calls = [];
  const hooks = { beforePush: undefined };
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    const operation = args[0];
    if (operation === 'ls-remote' && !args.includes('--get-url')) {
      assert.deepEqual(args.slice(0, 3), ['ls-remote', '--refs', '--']);
      assert.ok(transports.has(args[3]), `unlisted ls-remote transport: ${args[3]}`);
      assert.equal(options?.interactive, true);
      assert.equal(options?.captureStdout, true);
      calls.push({ directory: this.directory, args: [...args] });
      return run.call(this, [...args.slice(0, 3), transports.get(args[3]), ...args.slice(4)], options);
    }
    if (operation === 'push') {
      const separator = args.indexOf('--');
      const name = separator >= 0 ? args[separator + 1] : args[1];
      assert.equal(name, 'origin', 'fixture only permits the known origin');
      const [url] = await this.remoteUrls(name, true);
      assert.ok(transports.has(url), `unlisted push transport: ${url}`);
      calls.push({ directory: this.directory, args: [...args] });
      if (this.directory === local.directory && hooks.beforePush) {
        const callback = hooks.beforePush; hooks.beforePush = undefined;
        await callback();
      }
      const rewritten = [...args];
      rewritten[separator >= 0 ? separator + 1 : 1] = transports.get(url);
      return run.call(this, rewritten, options);
    }
    assert.ok(!['fetch', 'pull', 'clone', 'submodule'].includes(operation), `unexpected network operation ${operation}`);
    return run.call(this, args, options);
  });
  return {
    ...f, local, peer, server, bare, initial, localOid, peerOid, fetchBare, fetchUrl, pushUrl, transports, hooks, calls,
    appPushes: () => calls.filter(call => call.directory === local.directory && call.args[0] === 'push'),
    appQueries: () => calls.filter(call => call.directory === local.directory && call.args[0] === 'ls-remote'),
  };
}

function afterConfirm(answers, change, { quick = true } = {}) {
  const ui = new ScriptedConsole(answers, { quick });
  const confirm = ui.confirm.bind(ui);
  ui.confirm = async (...args) => { const answer = await confirm(...args); if (answer) await change(); return answer; };
  return ui;
}

for (const [mode, flag] of [['1', 'lease'], ['2', 'force']]) {
  test(`explicit ${flag} replaces a real divergent remote with the previewed fixed local OID and no tags`, async t => {
    const f = await divergent(t);
    const ui = new ScriptedConsole(['1', 'main', mode, 'y'], { quick: true });
    await forcePush(ui, f.local.directory);
    assert.equal(await f.server.value('rev-parse', 'refs/heads/main'), f.localOid);
    assert.equal(await f.local.value('rev-parse', 'HEAD'), f.localOid);
    assert.notEqual((await f.server.run(['show-ref', '--verify', 'refs/tags/local-only-tag'], { check: false })).status, 0);
    assert.equal(f.appPushes().length, 1);
    const args = f.appPushes()[0].args;
    assert.ok(args.includes('--no-follow-tags'));
    assert.ok(args.includes(flag === 'lease' ? `--force-with-lease=refs/heads/main:${f.peerOid}` : '--force'));
    assert.equal(args.at(-1), `${f.localOid}:refs/heads/main`);
    assert.ok(!args.some(arg => arg.startsWith('HEAD:') || ['--tags', '--mirror', '--all', '--set-upstream'].includes(arg)));
    if (flag === 'lease') assert.ok(!args.includes('--force'));
    assert.ok(ui.transcript.includes(f.localOid));
    assert.ok(ui.transcript.includes(f.peerOid));
    assert.equal(ui.messages.filter(message => message.includes('[y/N]')).length, 1);
    assert.deepEqual(ui.answers, []);
  });
}

test('lease protects the actual push URL OID, not the fetch URL or stale tracking ref', async t => {
  const f = await divergent(t, { splitUrls: true });
  const ui = new ScriptedConsole(['1', 'main', '1', 'y']);
  await forcePush(ui, f.local.directory);
  assert.equal(await f.server.value('rev-parse', 'refs/heads/main'), f.localOid);
  assert.equal(await new Git(f.fetchBare).value('rev-parse', 'refs/heads/main'), f.initial);
  assert.ok(f.appQueries().length >= 1);
  assert.ok(f.appQueries().every(call => call.args[3] === f.pushUrl));
  assert.ok(f.appPushes()[0].args.includes(`--force-with-lease=refs/heads/main:${f.peerOid}`));
  assert.ok(ui.transcript.includes(f.pushUrl));
});

test('peer update after lease preview is rejected and never downgraded to unconditional force', async t => {
  const f = await divergent(t);
  let updated;
  const ui = afterConfirm(['1', 'main', '1', 'y'], async () => {
    updated = await commitIn(f.peer, 'peer-next.txt', 'updated during preview\n');
    await f.peer.run(['push', 'origin', 'main']);
  });
  await assert.rejects(forcePush(ui, f.local.directory), /lease|远端.*变化/u);
  assert.equal(await f.server.value('rev-parse', 'refs/heads/main'), updated);
  assert.equal(await f.local.value('rev-parse', 'HEAD'), f.localOid);
  assert.equal(f.appPushes().length, 0);
});

test('server-side lease rejects a peer update after the final query without a force retry', async t => {
  const f = await divergent(t);
  let updated;
  f.hooks.beforePush = async () => {
    updated = await commitIn(f.peer, 'late-peer.txt', 'updated immediately before push\n');
    await f.peer.run(['push', 'origin', 'main']);
  };
  await assert.rejects(forcePush(new ScriptedConsole(['1', 'main', '1', 'y']), f.local.directory), GitError);
  assert.equal(await f.server.value('rev-parse', 'refs/heads/main'), updated);
  assert.equal(f.appPushes().length, 1);
  assert.ok(f.appPushes()[0].args.includes(`--force-with-lease=refs/heads/main:${f.peerOid}`));
  assert.ok(!f.appPushes()[0].args.includes('--force'));
});

test('lease for a missing remote branch uses an explicit empty expected OID', async t => {
  const f = await divergent(t);
  await forcePush(new ScriptedConsole(['1', 'new-topic', '1', 'y']), f.local.directory);
  assert.equal(await f.server.value('rev-parse', 'refs/heads/new-topic'), f.localOid);
  assert.equal(await f.server.value('rev-parse', 'refs/heads/main'), f.peerOid);
  assert.ok(f.appPushes()[0].args.includes('--force-with-lease=refs/heads/new-topic:'));
});

test('force push menu and hard-confirm cancellations preserve refs, configuration and worktree', async t => {
  const f = await divergent(t);
  const config = (await f.local.run(['config', '--local', '--list'])).stdout;
  for (const answers of [['0'], ['1', 'main', '0'], ['1', 'main', '1', 'n'], ['1', 'main', '2', 'n']]) {
    const ui = new ScriptedConsole(answers, { quick: true });
    await forcePush(ui, f.local.directory);
    assert.deepEqual(ui.answers, []);
  }
  await assert.rejects(forcePush(new ScriptedConsole(['1', 'main', '1', ':q']), f.local.directory), Cancelled);
  assert.equal(f.appPushes().length, 0);
  assert.equal(await f.server.value('rev-parse', 'refs/heads/main'), f.peerOid);
  assert.equal(await f.local.value('rev-parse', 'HEAD'), f.localOid);
  assert.deepEqual((await f.local.run(['config', '--local', '--list'])).stdout, config);
  assert.deepEqual(await f.local.changes(), []);
});

for (const mode of ['1', '2']) {
  test(`force mode ${mode} rejects a changed push URL after hard confirmation`, async t => {
    const f = await divergent(t, { splitUrls: true });
    const ui = afterConfirm(['1', 'main', mode, 'y'], () => f.local.run(['remote', 'set-url', '--push', 'origin', f.fetchUrl]));
    await assert.rejects(forcePush(ui, f.local.directory), /目标.*发生变化/u);
    assert.equal(f.appPushes().length, 0);
    assert.equal(await f.server.value('rev-parse', 'refs/heads/main'), f.peerOid);
    assert.equal(await new Git(f.fetchBare).value('rev-parse', 'refs/heads/main'), f.initial);
  });
  test(`force mode ${mode} rejects a changed local HEAD after hard confirmation`, async t => {
    const f = await divergent(t);
    const ui = afterConfirm(['1', 'main', mode, 'y'], () => commitIn(f.local, 'surprise.txt', 'new local HEAD\n'));
    await assert.rejects(forcePush(ui, f.local.directory), /分支或提交.*发生变化|本地.*发生变化/u);
    assert.equal(f.appPushes().length, 0);
    assert.notEqual(await f.local.value('rev-parse', 'HEAD'), f.localOid);
    assert.equal(await f.server.value('rev-parse', 'refs/heads/main'), f.peerOid);
  });
}

test('remote branch deletion uses the actual push URL lease and leaves local branches untouched', async t => {
  const f = await divergent(t, { splitUrls: true });
  await f.server.run(['update-ref', 'refs/heads/remove-me', f.peerOid]);
  await f.local.run(['branch', 'remove-me']);
  const ui = new ScriptedConsole(['1', 'remove-me', 'y'], { quick: true });
  await deleteRemoteBranch(ui, f.local.directory);
  assert.notEqual((await f.server.run(['show-ref', '--verify', 'refs/heads/remove-me'], { check: false })).status, 0);
  assert.equal(await f.server.value('rev-parse', 'refs/heads/main'), f.peerOid);
  assert.equal(await f.local.value('rev-parse', 'refs/heads/remove-me'), f.localOid);
  assert.equal(await f.local.branch(), 'main');
  assert.deepEqual(f.appPushes()[0].args, ['push', '--no-follow-tags', `--force-with-lease=refs/heads/remove-me:${f.peerOid}`, '--', 'origin', ':refs/heads/remove-me']);
  assert.ok(f.appQueries().every(call => call.args[3] === f.pushUrl));
  assert.deepEqual(ui.answers, []);
});

test('remote branch deletion cancellation, missing branch and stale preview never push', async t => {
  const f = await divergent(t);
  await f.server.run(['update-ref', 'refs/heads/remove-me', f.peerOid]);
  await deleteRemoteBranch(new ScriptedConsole(['1', 'remove-me', 'n'], { quick: true }), f.local.directory);
  await deleteRemoteBranch(new ScriptedConsole(['1', 'missing']), f.local.directory);
  const ui = afterConfirm(['1', 'remove-me', 'y'], () => f.server.run(['update-ref', 'refs/heads/remove-me', f.initial]));
  await assert.rejects(deleteRemoteBranch(ui, f.local.directory), /发生变化/u);
  assert.equal(await f.server.value('rev-parse', 'refs/heads/remove-me'), f.initial);
  assert.equal(f.appPushes().length, 0);
});

test('remote management previews and cancels safely, then renames and removes only local configuration', async t => {
  const f = await divergent(t);
  await remotesMenu(new ScriptedConsole(['0']), f.local.directory);
  const before = await readFile(await f.local.gitPath('config'));
  const list = new ScriptedConsole(['1', '0']);
  await remotesMenu(list, f.local.directory);
  assert.match(list.transcript, /fetch:.*\n.*push:/u);
  for (const answers of [['6', '1', 'renamed', 'n'], ['7', '1', 'n']]) await remotesMenu(new ScriptedConsole(answers, { quick: true }), f.local.directory);
  assert.deepEqual(await readFile(await f.local.gitPath('config')), before);
  await remotesMenu(new ScriptedConsole(['6', '1', 'renamed', 'y']), f.local.directory);
  assert.deepEqual(await f.local.remotes(), ['renamed']);
  assert.equal(await f.local.config('branch.main.remote'), 'renamed');
  await remotesMenu(new ScriptedConsole(['7', '1', 'y']), f.local.directory);
  assert.deepEqual(await f.local.remotes(), []);
  assert.equal(await f.server.value('rev-parse', 'refs/heads/main'), f.peerOid);
  assert.equal(await f.local.value('rev-parse', 'HEAD'), f.localOid);
  assert.equal(f.appPushes().length, 0);
});

test('remote address editing supports generic URLs and requires confirmation even in quick mode', async t => {
  const f = await divergent(t);
  const urls = ['https://fetch.example.invalid/team/repo.git', 'https://push.example.invalid/team/repo.git'];
  await remotesMenu(new ScriptedConsole(['1', '1', '1', ...urls, 'n'], { quick: true }), f.local.directory);
  assert.deepEqual(await f.local.remoteUrls('origin'), [f.bare]);
  await remotesMenu(new ScriptedConsole(['1', '1', '1', ...urls, 'y'], { quick: true }), f.local.directory);
  assert.deepEqual(await f.local.remoteUrls('origin'), [urls[0]]);
  assert.deepEqual(await f.local.remoteUrls('origin', true), [urls[1]]);
  assert.equal(f.appPushes().length, 0);
});

test('remoteRefOid fails closed on malformed, wrong-ref or duplicate remote output', async t => {
  const f = await fixture(t);
  const oid = 'a'.repeat(40), sha256 = 'b'.repeat(64), ref = 'refs/heads/main';
  let stdout = '';
  const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'ls-remote') {
      assert.equal(options?.captureStdout, true);
      return { status: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
    }
    return run.call(this, args, options);
  });
  for (const value of ['not-an-oid\t' + ref, oid + '\trefs/heads/other', oid + '\t' + ref + '\n' + oid + '\t' + ref]) {
    stdout = value;
    await assert.rejects(remoteRefOid(f.git, 'https://example.invalid/team/repo.git', ref), /无效|多个/u);
  }
  for (const value of [oid, sha256]) {
    stdout = value + '\t' + ref + '\n';
    assert.equal(await remoteRefOid(f.git, 'https://example.invalid/team/repo.git', ref), value);
  }
  stdout = '';
  assert.equal(await remoteRefOid(f.git, 'https://example.invalid/team/repo.git', ref), '');
});

async function seededRemote(f) {
  const target = await f.remote();
  await f.git.run(['push', 'origin', 'HEAD:refs/heads/remote-topic']);
  return target;
}

async function remoteSnapshot(repo) {
  const marker = await repo.gitPath('MERGE_HEAD');
  return {
    refs: (await repo.run(['show-ref'])).stdout,
    index: (await repo.run(['ls-files', '--stage', '-z'])).stdout,
    diff: (await repo.run(['diff', '--no-ext-diff', '--binary'])).stdout,
    branch: await repo.branch(),
    config: (await repo.run(['config', '--local', '--list'])).stdout,
    marker: existsSync(marker) ? await readFile(marker) : Buffer.alloc(0),
  };
}

function changingRoutineConsole(answers, change, options) {
  const ui = new ScriptedConsole(answers, options);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async (...args) => {
    const answer = await confirm(...args);
    if (answer) await change();
    return answer;
  };
  return ui;
}

test('upstream uses cache without fetch or local branch creation', async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  const before = (await f.git.run(['show-ref'])).stdout;
  const original = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    assert.ok(!['fetch', 'ls-remote', 'push', 'pull', 'switch', 'checkout'].includes(args[0]), 'unexpected network or branch switching command');
    if (args[0] === 'branch') assert.ok(args[1].startsWith('--set-upstream-to='), 'unexpected local branch management');
    return original.call(this, args, options);
  });
  await setUpstream(new ScriptedConsole(['1', 'y']), f.git);
  assert.equal(await f.git.branch(), 'main');
  assert.equal(await f.git.config('branch.main.remote'), 'origin');
  assert.equal(await f.git.config('branch.main.merge'), 'refs/heads/remote-topic');
  assert.deepEqual((await f.git.run(['show-ref'])).stdout, before);
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), false);
});

test('declining fetch never executes a network command', async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  const before = await remoteSnapshot(f.git);
  const original = Git.prototype.run;
  const calls = [];
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    calls.push([...args]);
    assert.ok(!['fetch', 'ls-remote', 'push', 'pull'].includes(args[0]), 'unexpected network command');
    return original.call(this, args, options);
  });
  await fetchRemote(new ScriptedConsole(['1', 'n']), f.git);
  assert.ok(calls.length);
  assert.deepEqual(await remoteSnapshot(f.git), before);
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), false);
});

test('fetch to local bare remote disables prune/pruneTags and never moves HEAD', async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  const originalHead = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['update-ref', 'refs/remotes/origin/stale', originalHead]);
  await f.git.run(['tag', 'local-kept']);
  for (const key of ['fetch.prune', 'fetch.pruneTags', 'remote.origin.prune', 'fetch.recurseSubmodules']) await f.git.run(['config', key, 'true']);
  const original = Git.prototype.run, calls = [];
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'fetch') calls.push([...args]);
    return original.call(this, args, options);
  });
  await fetchRemote(new ScriptedConsole(['1', 'y']), f.git);
  assert.deepEqual(calls, [['fetch', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--', 'origin']]);
  assert.equal(await f.git.value('rev-parse', 'refs/remotes/origin/stale'), originalHead);
  assert.equal(await f.git.value('rev-parse', 'refs/tags/local-kept'), originalHead);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), originalHead);
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), true);
});

test('fetch supports a generic host but rejects unsafe remote URLs before networking', async t => {
  const f = await fixture(t, { committed: true });
  await f.git.run(['remote', 'add', 'origin', 'https://example.invalid/repo.git']);
  const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    assert.ok(!['fetch', 'push', 'pull'].includes(args[0]), 'unexpected network command');
    return run.call(this, args, options);
  });
  await fetchRemote(new ScriptedConsole(['1', 'n']), f.git);
  for (const url of ['ext::anything', 'https://user:secret@example.invalid/repo', 'https://example.invalid/repo?token=x', 'not-a-valid-url']) {
    await f.git.run(['remote', 'set-url', 'origin', url]);
    await assert.rejects(fetchRemote(new ScriptedConsole(['1']), f.git), /地址无效/u);
  }
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), false);
});

test('declining upstream does not write refs or config', async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  const before = await remoteSnapshot(f.git);
  await setUpstream(new ScriptedConsole(['1', 'n']), f.git);
  assert.deepEqual(await remoteSnapshot(f.git), before);
});

test('quick upstream and local fetch skip routine confirmations', async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  const upstream = new ScriptedConsole(['1'], { quick: true });
  await setUpstream(upstream, f.git);
  const fetch = new ScriptedConsole(['1'], { quick: true });
  await fetchRemote(fetch, f.git);
  assert.equal(await f.git.branch(), 'main');
  assert.equal(await f.git.config('branch.main.remote'), 'origin');
  assert.equal(await f.git.config('branch.main.merge'), 'refs/heads/remote-topic');
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), true);
  for (const ui of [upstream, fetch]) {
    assert.deepEqual(ui.answers, []);
    assert.doesNotMatch(ui.transcript, /\[y\/N\]/u);
  }
});

test('fetch command preserves the scoped Git context', async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  const scoped = new Git(f.path, { config: { 'user.name': 'Fetch Account' }, env: { AUTOGIT_FETCH_TEST: 'scoped' } });
  const original = Git.prototype.run;
  const seen = [];
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'fetch') seen.push({ config: { ...this.overrides }, env: { ...this.environment } });
    return original.call(this, args, options);
  });
  await fetchRemote(new ScriptedConsole(['1'], { quick: true }), scoped);
  assert.deepEqual(seen, [{ config: scoped.overrides, env: scoped.environment }]);
});

async function createOfflineProfile() {
  const store = new ProfileStore();
  const profile = await store.create(new ScriptedConsole([], { quick: true }), 'Local Test', 'Profile Author', 'profile@example.invalid', 'local-test', { rememberAuth: true });
  assert.ok(profile);
  return { store, profile };
}

test('fetch uses a different Git returned by real remoteContext without contacting GitHub', async t => {
  const f = await fixture(t, { committed: true });
  const bare = await seededRemote(f);
  await f.git.run(['push', 'origin', 'HEAD:refs/heads/main']);
  const { profile } = await createOfflineProfile();
  await f.git.run(['remote', 'set-url', 'origin', 'git@github.com:example/project.git']);
  const original = Git.prototype.run;
  const seen = [];
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'fetch') {
      assert.equal(args.at(-1), 'origin');
      seen.push({ config: { ...this.overrides }, env: { ...this.environment } });
      // Only the fixture bare repository is contacted; no SSH/network is launched.
      return original.call(this, [...args.slice(0, -1), bare], options);
    }
    assert.ok(!['push', 'pull', 'ls-remote'].includes(args[0]));
    return original.call(this, args, options);
  });
  await fetchRemote(new ScriptedConsole(['1', '1'], { quick: true }), f.git);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].config['user.name'], profile.name);
  assert.equal(seen[0].config['user.email'], profile.email);
  assert.ok(seen[0].config['core.sshCommand'].includes(profile.private_key));
  assert.equal(seen[0].env.GIT_SSH_COMMAND, undefined);
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), true);
});

test('SSH fetch without a selected managed profile never falls back to a default key', async t => {
  const f = await fixture(t, { committed: true });
  await f.git.run(['remote', 'add', 'origin', 'git@github.com:example/project.git']);
  const original = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    assert.ok(!['fetch', 'push', 'pull', 'ls-remote'].includes(args[0]), 'unexpected network/default SSH key use');
    return original.call(this, args, options);
  });
  await assert.rejects(fetchRemote(new ScriptedConsole(['1'], { quick: true }), f.git), /没有选择软件账号/);
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), false);
});

test('remote menu appends fetch and current upstream after its original seven actions', async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  const menu = new ScriptedConsole(['0']);
  await remotesMenu(menu, f.path);
  for (const label of ['1. 查看/管理远程地址', '2. 添加远程', '3. 仅上传已有提交', '4. force-with-lease', '5. 删除远程分支', '6. 远程改名', '7. 移除远程', '8. 单独 fetch', '9. 设置当前分支上游']) assert.ok(menu.transcript.includes(label), label);
  assert.doesNotMatch(menu.transcript, /10\. /u);
  await remotesMenu(new ScriptedConsole(['8', '1'], { quick: true }), f.path);
  await remotesMenu(new ScriptedConsole(['9', '1'], { quick: true }), f.path);
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), true);
  assert.equal(await f.git.branch(), 'main');
  assert.equal(await f.git.config('branch.main.remote'), 'origin');
  assert.equal(await f.git.config('branch.main.merge'), 'refs/heads/remote-topic');
});

test('upstream selection lists only cached remote refs and omits symbolic remote HEAD', async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  await f.git.run(['remote', 'set-head', 'origin', 'remote-topic']);
  const before = await remoteSnapshot(f.git);
  const ui = new ScriptedConsole(['1', 'n']);
  await setUpstream(ui, f.git);
  assert.match(ui.transcript, /\[远程缓存\] origin\/remote-topic/u);
  assert.ok(ui.transcript.includes(await f.git.value('rev-parse', 'HEAD')));
  assert.ok(ui.transcript.includes('initial'));
  assert.doesNotMatch(ui.transcript, /\[远程缓存\] origin\/HEAD|\[本地\]/u);
  assert.deepEqual(await remoteSnapshot(f.git), before);
});

test('upstream with no cached remote refs stops without fetching', async t => {
  const f = await fixture(t, { committed: true });
  await f.remote();
  const original = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    assert.ok(!['fetch', 'ls-remote', 'push', 'pull'].includes(args[0]), 'unexpected network command');
    return original.call(this, args, options);
  });
  await assert.rejects(setUpstream(new ScriptedConsole(), f.git), /远程缓存.*fetch/u);
  assert.equal(await f.git.config('branch.main.remote'), '');
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), false);
});

test('raw cached ref bytes cannot alias a legal U+FFFD upstream name or reach Git argv', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  const oid = await f.git.value('rev-parse', 'HEAD');
  const legal = 'raw�';
  await f.git.run(['update-ref', `refs/remotes/origin/${legal}`, oid]);
  const rawName = Buffer.from([0x72, 0x61, 0x77, 0xff]);
  const rawPath = Buffer.concat([Buffer.from(f.path), Buffer.from('/.git/refs/remotes/origin/'), rawName]);
  await writeFile(rawPath, Buffer.from(`${oid}\n`));
  let labels;
  const list = new ScriptedConsole();
  list.menu = async (_title, options) => { labels = [...options]; return 0; };
  await setUpstream(list, f.git);
  const raw = labels.findIndex(label => label.includes('\udcff'));
  const replacement = labels.findIndex(label => label.startsWith(`[远程缓存] origin/${legal} |`));
  assert.ok(raw >= 0);
  assert.ok(replacement >= 0);
  assert.notEqual(raw, replacement);
  await assert.rejects(setUpstream(new ScriptedConsole([String(raw + 1)], { quick: true }), f.git), /特殊字节/u);
  assert.equal(await f.git.config('branch.main.remote'), '');
  await setUpstream(new ScriptedConsole([String(replacement + 1)], { quick: true }), f.git);
  assert.equal(await f.git.config('branch.main.merge'), `refs/heads/${legal}`);
  assert.equal(await f.git.branch(), 'main');
});

for (const action of [fetchRemote, setUpstream]) {
  test(`${action.name} refuses detached HEAD without creating or switching a branch`, async t => {
    const f = await fixture(t, { committed: true });
    await seededRemote(f);
    await f.git.run(['switch', '--detach', 'HEAD']);
    const before = (await f.git.run(['show-ref'])).stdout;
    await assert.rejects(action(new ScriptedConsole(), f.git), /游离/u);
    assert.deepEqual((await f.git.run(['show-ref'])).stdout, before);
    assert.notEqual((await f.git.run(['symbolic-ref', '--quiet', 'HEAD'], { check: false })).status, 0);
    assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), false);
  });

  test(`${action.name} rechecks HEAD and active operations after routine confirmation`, async t => {
    const f = await fixture(t, { committed: true });
    await seededRemote(f);
    const headRace = changingRoutineConsole(['1'], () => f.git.run(['commit', '--allow-empty', '-m', 'changed during preview']), { quick: true });
    await assert.rejects(action(headRace, f.git), /HEAD|发生变化/u);
    const operationRace = changingRoutineConsole(['1'], async () => writeFile(await f.git.gitPath('CHERRY_PICK_HEAD'), `${await f.git.value('rev-parse', 'HEAD')}\n`), { quick: true });
    await assert.rejects(action(operationRace, f.git), /操作|合并|发生变化/u);
    assert.equal(await f.git.branch(), 'main');
    assert.equal(await f.git.config('branch.main.remote'), '');
    assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), false);
  });
}

test('fetch rechecks the actual remote URL after routine confirmation', async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  const original = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    assert.ok(!['fetch', 'ls-remote', 'push', 'pull'].includes(args[0]), 'unexpected network command');
    return original.call(this, args, options);
  });
  const ui = changingRoutineConsole(['1'], () => f.git.run(['remote', 'set-url', 'origin', 'https://changed.example.invalid/repo.git']), { quick: true });
  await assert.rejects(fetchRemote(ui, f.git), /远程地址.*变化/u);
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), false);
});

test('upstream rechecks the selected cached OID after routine confirmation', async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  await f.git.run(['commit', '--allow-empty', '-m', 'new local commit']);
  const ui = changingRoutineConsole(['1'], () => f.git.run(['update-ref', 'refs/remotes/origin/remote-topic', 'HEAD']), { quick: true });
  await assert.rejects(setUpstream(ui, f.git), /上游目标分支.*变化/u);
  assert.equal(await f.git.config('branch.main.remote'), '');
  assert.equal(await f.git.config('branch.main.merge'), '');
});

test('fetch and upstream preserve staged, unstaged and untracked bytes without local branch changes', async t => {
  const f = await fixture(t, { committed: true });
  await seededRemote(f);
  await f.write('staged.txt', 'staged version\n');
  await f.git.stagePaths(['staged.txt']);
  await f.write('staged.txt', 'unstaged version of staged file\n');
  await f.write('hello.txt', 'unstaged edit\n');
  await f.write('untracked.txt', 'untracked bytes\n');
  const before = await remoteSnapshot(f.git);
  await setUpstream(new ScriptedConsole(['1'], { quick: true }), f.git);
  await fetchRemote(new ScriptedConsole(['1'], { quick: true }), f.git);
  const after = await remoteSnapshot(f.git);
  for (const field of ['refs', 'index', 'diff', 'branch', 'marker']) assert.deepEqual(after[field], before[field], field);
  assert.equal(await f.git.value('show', ':staged.txt'), 'staged version');
  assert.equal(await readFile(join(f.path, 'staged.txt'), 'utf8'), 'unstaged version of staged file\n');
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'unstaged edit\n');
  assert.equal(await readFile(join(f.path, 'untracked.txt'), 'utf8'), 'untracked bytes\n');
});
