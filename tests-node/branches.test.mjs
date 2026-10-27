import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  abortMerge, branchesMenu, conflictCenter, continueMerge, createBranch,
  deleteMergedBranch, fetchRemote, forceDeleteBranch, listBranches, mergeBranch, renameBranch,
  resolveConflicts, setUpstream, switchBranch, trackRemote,
} from '../dist/branches.js';
import { Git, GitError } from '../dist/git.js';
import { Cancelled } from '../dist/ui.js';
import { ProfileStore } from '../dist/profiles.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function initialFixture(t) {
  const f = await fixture(t);
  await f.write();
  await f.commit();
  f.initial = await f.git.value('rev-parse', 'HEAD');
  return f;
}

async function topic(f) {
  await f.git.run(['switch', '-c', 'topic']);
  await f.write('topic.txt', 'topic\n');
  await f.commit('topic summary');
  const source = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['switch', 'main']);
  return source;
}

async function divergent(f) {
  const source = await topic(f);
  await f.write('main.txt', 'main\n');
  await f.commit('main summary');
  return [await f.git.value('rev-parse', 'HEAD'), source];
}

async function pending(f) {
  const parents = await divergent(f);
  await mergeBranch(new ScriptedConsole(['1', 'y', 'n']), f.git);
  assert.equal(await f.git.operation(), 'MERGE_HEAD');
  return parents;
}

async function conflicted(f, name = 'hello.txt') {
  if (name !== 'hello.txt') {
    await f.write(name, 'base\n');
    await f.commit('conflict base');
  }
  await f.git.run(['switch', '-c', 'topic']);
  await f.write(name, 'topic version\n');
  await f.commit('topic conflict');
  const source = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['switch', 'main']);
  await f.write(name, 'main version\n');
  await f.commit('main conflict');
  const target = await f.git.value('rev-parse', 'HEAD');
  const ui = new ScriptedConsole(['1', 'y']);
  await mergeBranch(ui, f.git);
  assert.match(ui.transcript, /原地保留/);
  assert.deepEqual(await f.git.unmerged(), [name]);
  return [target, source];
}

async function seededRemote(f) {
  const target = await f.remote();
  await f.git.run(['push', 'origin', 'HEAD:refs/heads/remote-topic']);
  return target;
}

async function snapshot(f) {
  const marker = await f.git.gitPath('MERGE_HEAD');
  return {
    refs: (await f.git.run(['show-ref'])).stdout,
    index: (await f.git.run(['ls-files', '--stage', '-z'])).stdout,
    diff: (await f.git.run(['diff', '--no-ext-diff', '--binary'])).stdout,
    branch: await f.git.branch(),
    config: (await f.git.run(['config', '--local', '--list'])).stdout,
    marker: existsSync(marker) ? await readFile(marker) : Buffer.alloc(0),
  };
}

function assertSnapshot(actual, expected) {
  for (const field of ['refs', 'index', 'diff', 'config', 'marker']) {
    assert.ok(actual[field].equals(expected[field]), `${field} snapshot differs`);
  }
  assert.equal(actual.branch, expected.branch);
}

function changingConsole(answers, change, options = {}) {
  const ui = new ScriptedConsole(answers, options);
  const confirm = ui.confirm.bind(ui);
  ui.confirm = async (...args) => {
    const answer = await confirm(...args);
    if (answer) await change();
    return answer;
  };
  return ui;
}

async function parents(f) { return (await f.git.value('show', '-s', '--format=%P', 'HEAD')).split(/\s+/); }

test('branch menu retains numbering; create never inherits upstream', async t => {
  const f = await initialFixture(t);
  await seededRemote(f);
  await f.git.run(['branch', '--set-upstream-to=origin/remote-topic', 'main']);
  await f.git.run(['config', 'branch.autoSetupMerge', 'always']);
  await branchesMenu(new ScriptedConsole(['2', 'feature/中文', 'y']), f.path);
  assert.equal(await f.git.branch(), 'feature/中文');
  assert.equal(await f.git.config('branch.feature/中文.remote'), '');
  await branchesMenu(new ScriptedConsole(['1', '2', 'y']), f.path);
  assert.equal(await f.git.branch(), 'main');
});

test('raw ref bytes do not alias a legal U+FFFD branch name or reach Git argv', { skip: process.platform === 'win32' }, async t => {
  const f = await initialFixture(t);
  const legal = 'raw�';
  await f.git.run(['branch', legal]);
  const rawName = Buffer.from([0x72, 0x61, 0x77, 0xff]);
  const rawPath = Buffer.concat([Buffer.from(f.path), Buffer.from('/.git/refs/heads/'), rawName]);
  await writeFile(rawPath, Buffer.from(`${f.initial}\n`));
  const listed = await listBranches(new ScriptedConsole(), f.path);
  const raw = listed.findIndex(ref => ref.name.includes('\udcff'));
  const replacement = listed.findIndex(ref => ref.name === legal);
  assert.ok(raw >= 0);
  assert.ok(replacement >= 0);
  assert.notEqual(raw, replacement);
  await assert.rejects(switchBranch(new ScriptedConsole([String(raw + 1)], { quick: true }), f.git), /特殊字节/);
  assert.equal(await f.git.branch(), 'main');
  await switchBranch(new ScriptedConsole([String(replacement + 1)], { quick: true }), f.git);
  assert.equal(await f.git.branch(), legal);
});

test('list distinguishes local and cached refs and omits symbolic remote HEAD', async t => {
  const f = await initialFixture(t);
  await seededRemote(f);
  await f.git.run(['remote', 'set-head', 'origin', 'remote-topic']);
  const ui = new ScriptedConsole();
  const refs = await listBranches(ui, f.path);
  assert.deepEqual(new Set(refs.map(ref => ref.ref)), new Set(['refs/heads/main', 'refs/remotes/origin/remote-topic']));
  for (const text of ['[本地] main', '[远程缓存] origin/remote-topic', f.initial, 'initial']) assert.ok(ui.transcript.includes(text));
});

test('fast-forward advances HEAD without a pending merge', async t => {
  const f = await initialFixture(t);
  const source = await topic(f);
  const ui = new ScriptedConsole(['1', 'y']);
  await mergeBranch(ui, f.git);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), source);
  assert.equal(await f.git.operation(), '');
  assert.deepEqual(await f.git.changes(), []);
  for (const text of ['HEAD 已前进', f.initial, 'initial', 'topic summary', '可快进', 'topic.txt']) assert.ok(ui.transcript.includes(text));
});

test('non-fast-forward confirmation creates a two-parent commit', async t => {
  const f = await initialFixture(t);
  const expected = await divergent(f);
  const ui = new ScriptedConsole(['1', 'y', 'y']);
  await mergeBranch(ui, f.path);
  assert.deepEqual(await parents(f), expected);
  assert.equal(await f.git.operation(), '');
  assert.deepEqual(await f.git.changes(), []);
  for (const text of ['完整暂存区统计', '类型：非快进合并', '合并提交已创建']) assert.ok(ui.transcript.includes(text));
});

test('declining non-ff commit retains MERGE_HEAD and can continue', async t => {
  const f = await initialFixture(t);
  const expected = await pending(f);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), expected[0]);
  await continueMerge(new ScriptedConsole(['y']), f.git);
  assert.deepEqual(await parents(f), expected);
});

test('conflict continuation requires resolution; only chosen unusual path is staged', async t => {
  const f = await initialFixture(t);
  const name = '-中文 [x]\n文件.txt';
  const expected = await conflicted(f, name);
  await assert.rejects(continueMerge(new ScriptedConsole(), f.git), /未解决/);
  await f.write(name, 'resolved correctly\n');
  await f.write('do-not-stage.txt', 'private edit\n');
  await resolveConflicts(new ScriptedConsole(['1', 'y']), f.git);
  assert.deepEqual(await f.git.unmerged(), []);
  const ui = new ScriptedConsole(['y']);
  await continueMerge(ui, f.git);
  assert.deepEqual(await parents(f), expected);
  assert.equal(await f.git.value('show', `HEAD:${name}`), 'resolved correctly');
  const remaining = await f.git.changes();
  assert.deepEqual(remaining.map(change => change.path), ['do-not-stage.txt']);
  assert.equal(remaining[0].index, '?');
  assert.match(ui.transcript, /未暂存内容不会自动加入/);
});

test('conflict center keeps continue/abort numbering and displays the selected full diff without another prompt', async t => {
  const f = await initialFixture(t);
  await conflicted(f);
  const before = await snapshot(f);
  const ui = new ScriptedConsole(['1']);
  await conflictCenter(ui, f.git);
  for (const text of ['3. 继续合并', '4. 中止合并', 'hello.txt', 'main version', 'topic version']) assert.ok(ui.transcript.includes(text));
  assert.doesNotMatch(ui.transcript, /\[y\/N\]/u);
  assert.deepEqual(ui.answers, []);
  assertSnapshot(await snapshot(f), before);
});

test('full conflict diff remains read-only without modifying index, HEAD or pending merge', async t => {
  const f = await initialFixture(t);
  await conflicted(f);
  const before = await snapshot(f);
  const ui = new ScriptedConsole(['1']);
  await conflictCenter(ui, f.git);
  for (const text of ['diff --cc hello.txt', 'main version', 'topic version']) assert.ok(ui.transcript.includes(text));
  assert.deepEqual(ui.answers, []);
  assertSnapshot(await snapshot(f), before);
});

test('abort discards resolution and restores merge starting point', async t => {
  const f = await initialFixture(t);
  const [target] = await conflicted(f);
  await f.write('hello.txt', 'resolved then discarded\n');
  await resolveConflicts(new ScriptedConsole(['1', 'y']), f.git);
  await conflictCenter(new ScriptedConsole(['4', 'y']), f.git);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), target);
  assert.equal(await f.git.operation(), '');
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'main version\n');
  assert.deepEqual(await f.git.changes(), []);
});

test('abort failure retains merge and never falls back to reset', async t => {
  const f = await initialFixture(t);
  const [target] = await conflicted(f);
  await writeFile(await f.git.gitPath('index.lock'), 'held by another process\n');
  await assert.rejects(abortMerge(new ScriptedConsole(['y']), f.git), GitError);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), target);
  assert.equal(await f.git.operation(), 'MERGE_HEAD');
  assert.deepEqual(await f.git.unmerged(), ['hello.txt']);
});

test('stash conflicts can resolve but cannot merge-continue or abort', async t => {
  const f = await initialFixture(t);
  await f.write('hello.txt', 'stashed version\n');
  await f.git.run(['stash', 'push', '-m', 'stash conflict']);
  await f.write('hello.txt', 'new committed version\n');
  await f.commit('new version');
  const originalHead = await f.git.value('rev-parse', 'HEAD');
  assert.notEqual((await f.git.run(['stash', 'apply'], { check: false })).status, 0);
  assert.equal(await f.git.operation(), '');
  const ui = new ScriptedConsole(['1']);
  await conflictCenter(ui, f.git);
  assert.deepEqual(ui.answers, []);
  assert.ok(!ui.transcript.includes('3. 继续合并'));
  assert.ok(!ui.transcript.includes('4. 中止合并'));
  for (const action of [continueMerge, abortMerge]) await assert.rejects(action(new ScriptedConsole(), f.git), /没有 MERGE_HEAD/);
  await f.write('hello.txt', 'resolved stash\n');
  await conflictCenter(new ScriptedConsole(['2', '1', 'y']), f.git);
  assert.deepEqual(await f.git.unmerged(), []);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), originalHead);
  assert.ok(await f.git.value('stash', 'list'));
  assert.equal((await f.git.changes())[0].staged, true);
});

test('MERGE_AUTOSTASH is not treated as ordinary merge', async t => {
  const f = await initialFixture(t);
  await divergent(f);
  await f.write('hello.txt', 'dirty before native merge\n');
  await f.git.run(['merge', '--no-commit', '--autostash', 'topic']);
  assert.equal(await f.git.operation(), 'MERGE_AUTOSTASH');
  for (const action of [conflictCenter, resolveConflicts, continueMerge, abortMerge]) await assert.rejects(action(new ScriptedConsole(), f.git), /MERGE_AUTOSTASH/);
});

test('rebase conflict is never treated as a merge', async t => {
  const f = await initialFixture(t);
  await conflicted(f);
  await f.git.run(['merge', '--abort']);
  assert.notEqual((await f.git.run(['rebase', 'topic'], { check: false })).status, 0);
  await assert.rejects(conflictCenter(new ScriptedConsole(), f.git), /rebase/);
});

test('tracking and upstream use cache without fetch', async t => {
  const f = await initialFixture(t);
  await seededRemote(f);
  await trackRemote(new ScriptedConsole(['1', 'local-topic', 'y']), f.git);
  assert.equal(await f.git.branch(), 'local-topic');
  assert.equal(await f.git.config('branch.local-topic.remote'), 'origin');
  assert.equal(await f.git.config('branch.local-topic.merge'), 'refs/heads/remote-topic');
  await f.git.run(['switch', 'main']);
  await setUpstream(new ScriptedConsole(['1', 'y']), f.git);
  assert.equal(await f.git.config('branch.main.remote'), 'origin');
  assert.equal(await f.git.config('branch.main.merge'), 'refs/heads/remote-topic');
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), false);
});

test('cached remote merge targets the cached OID', async t => {
  const f = await initialFixture(t);
  const target = await seededRemote(f);
  const source = await topic(f);
  await f.git.run(['push', target, 'topic:refs/heads/remote-topic']);
  await f.git.run(['fetch', 'origin']);
  await f.git.run(['branch', '-D', 'topic']);
  const ui = new ScriptedConsole(['1', 'y']);
  await mergeBranch(ui, f.git);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), source);
  assert.match(ui.transcript, /origin\/remote-topic/);
});

test('declining fetch never executes a network command', async t => {
  const f = await initialFixture(t);
  await seededRemote(f);
  const before = await snapshot(f);
  const original = Git.prototype.run;
  const calls = [];
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    calls.push([...args]);
    assert.ok(!['fetch', 'ls-remote', 'push', 'pull'].includes(args[0]), 'unexpected network command');
    return original.call(this, args, options);
  });
  await fetchRemote(new ScriptedConsole(['1', 'n']), f.git);
  assert.ok(calls.length);
  assertSnapshot(await snapshot(f), before);
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), false);
});

test('fetch to local bare remote disables prune/pruneTags and never moves HEAD', async t => {
  const f = await initialFixture(t);
  await seededRemote(f);
  await f.git.run(['update-ref', 'refs/remotes/origin/stale', f.initial]);
  await f.git.run(['tag', 'local-kept']);
  for (const key of ['fetch.prune', 'fetch.pruneTags', 'remote.origin.prune']) await f.git.run(['config', key, 'true']);
  const originalHead = await f.git.value('rev-parse', 'HEAD');
  await fetchRemote(new ScriptedConsole(['1', 'y']), f.git);
  assert.equal(await f.git.value('rev-parse', 'refs/remotes/origin/stale'), f.initial);
  assert.equal(await f.git.value('rev-parse', 'refs/tags/local-kept'), f.initial);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), originalHead);
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), true);
});

test('fetch supports a generic host but rejects unsafe remote URLs before networking', async t => {
  const f = await initialFixture(t);
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

test('delete removes only the explicitly merged local branch', async t => {
  const f = await initialFixture(t);
  await f.git.run(['branch', 'topic']);
  const ui = new ScriptedConsole(['1', 'y']);
  await deleteMergedBranch(ui, f.git);
  assert.notEqual((await f.git.run(['show-ref', '--verify', 'refs/heads/topic'], { check: false })).status, 0);
  assert.equal(await f.git.branch(), 'main');
  assert.match(ui.transcript, /明确删除基准/);
  assert.ok(ui.transcript.includes(f.initial));
});

test('unmerged branch deletion is rejected before confirmation', async t => {
  const f = await initialFixture(t);
  await topic(f);
  const before = await snapshot(f);
  await assert.rejects(deleteMergedBranch(new ScriptedConsole(['1']), f.git), /未合并/);
  assertSnapshot(await snapshot(f), before);
});

test('delete respects branches checked out in other worktrees', async t => {
  const f = await initialFixture(t);
  await f.git.run(['branch', 'topic']);
  await f.git.run(['worktree', 'add', join(f.base, 'linked'), 'topic']);
  await assert.rejects(deleteMergedBranch(new ScriptedConsole(['1', 'y']), f.git), GitError);
  assert.equal(await f.git.value('rev-parse', 'refs/heads/topic'), f.initial);
});

test('detached HEAD permits viewing and explicit switch back only', async t => {
  const f = await initialFixture(t);
  await f.git.run(['switch', '--detach', 'HEAD']);
  const ui = new ScriptedConsole();
  await listBranches(ui, f.path);
  assert.match(ui.transcript, /游离 HEAD/);
  for (const action of [createBranch, mergeBranch, trackRemote, setUpstream, fetchRemote, deleteMergedBranch]) await assert.rejects(action(new ScriptedConsole(), f.git), /游离/);
  await branchesMenu(new ScriptedConsole(['1', '1', 'y']), f.path);
  assert.equal(await f.git.branch(), 'main');
});

async function branchActionFixture(t, action) {
  const f = await initialFixture(t);
  const source = await topic(f);
  if (action === trackRemote) {
    await seededRemote(f);
    await f.git.run(['update-ref', 'refs/remotes/origin/remote-topic', source]);
  }
  const answers = action === switchBranch ? ['2'] : action === createBranch ? ['created'] : ['1', 'tracked'];
  return { f, answers, branch: action === switchBranch ? 'topic' : action === createBranch ? 'created' : 'tracked' };
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

for (const action of [switchBranch, createBranch, trackRemote]) {
  for (const quick of [false, true]) {
    test(`${action.name} preserves native-safe staged, unstaged and untracked bytes in ${quick ? 'quick' : 'confirm'} mode`, async t => {
      const { f, answers, branch } = await branchActionFixture(t, action);
      await f.write('staged.txt', 'staged version\n');
      await f.git.stagePaths(['staged.txt']);
      await f.write('staged.txt', 'unstaged version of staged file\n');
      await f.write('hello.txt', 'unstaged edit\n');
      await f.write('untracked.txt', 'untracked bytes\n');
      const index = (await f.git.run(['ls-files', '--stage', '-z'])).stdout;
      const status = (await f.git.run(['status', '--porcelain=v1', '-z'])).stdout;
      const ui = new ScriptedConsole([...answers, ...quick ? [] : ['y']], { quick });
      await action(ui, f.git);
      assert.equal(await f.git.branch(), branch);
      if (action === createBranch) assert.ok((await f.git.run(['ls-files', '--stage', '-z'])).stdout.equals(index));
      const afterIndex = await f.git.value('show', ':staged.txt');
      assert.equal(afterIndex, 'staged version');
      assert.equal(await readFile(join(f.path, 'staged.txt'), 'utf8'), 'unstaged version of staged file\n');
      assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'unstaged edit\n');
      assert.equal(await readFile(join(f.path, 'untracked.txt'), 'utf8'), 'untracked bytes\n');
      assert.ok((await f.git.run(['status', '--porcelain=v1', '-z'])).stdout.equals(status));
      assert.equal(ui.messages.filter(message => message.includes('[y/N]')).length, quick ? 0 : 1);
      assert.equal(await f.git.value('stash', 'list'), '');
      assert.deepEqual(ui.answers, []);
    });
  }
  for (const kind of ['unstaged', 'staged', 'untracked']) {
    test(`${action.name} rejects same-status ${kind} byte races after routine preview`, async t => {
      const { f, answers } = await branchActionFixture(t, action);
      const name = kind === 'untracked' ? 'untracked.txt' : 'hello.txt';
      await f.write(name, 'before preview\n');
      if (kind === 'staged') await f.git.stagePaths([name]);
      const status = (await f.git.run(['status', '--porcelain=v1', '-z'])).stdout;
      const ui = changingRoutineConsole([...answers, 'y'], async () => {
        await f.write(name, 'changed bytes!\n');
        if (kind === 'staged') await f.git.stagePaths([name]);
        assert.ok((await f.git.run(['status', '--porcelain=v1', '-z'])).stdout.equals(status));
      });
      await assert.rejects(action(ui, f.git), /发生变化/);
      assert.equal(await f.git.branch(), 'main');
      assert.equal(await readFile(join(f.path, name), 'utf8'), 'changed bytes!\n');
      assert.equal(await f.git.value('stash', 'list'), '');
    });
  }
  test(`${action.name} refuses unresolved conflicts and active operations before selecting targets`, async t => {
    const f = await initialFixture(t);
    await conflicted(f);
    const before = await snapshot(f);
    await assert.rejects(action(new ScriptedConsole(), f.git), /操作|合并|冲突/);
    assertSnapshot(await snapshot(f), before);
    await f.git.run(['merge', '--quit']);
    assert.equal(await f.git.operation(), '');
    await assert.rejects(action(new ScriptedConsole(), f.git), /冲突/);
    assert.deepEqual(await f.git.unmerged(), ['hello.txt']);
  });
  test(`${action.name} rejects HEAD and operation changes even in quick mode`, async t => {
    const { f, answers } = await branchActionFixture(t, action);
    await assert.rejects(action(changingRoutineConsole(answers, () => f.git.run(['switch', 'topic']), { quick: true }), f.git), /HEAD|发生变化/);
    await f.git.run(['switch', 'main']);
    await assert.rejects(action(changingRoutineConsole(answers, async () => writeFile(await f.git.gitPath('CHERRY_PICK_HEAD'), `${f.initial}\n`), { quick: true }), f.git), /操作|合并|发生变化/);
    assert.equal(await f.git.branch(), 'main');
  });
}

for (const action of [switchBranch, trackRemote]) {
  for (const kind of ['staged', 'unstaged', 'untracked', 'ignored']) {
    test(`${action.name} lets native Git reject ${kind} overwrite without losing bytes or creating a branch`, async t => {
      const { f, answers, branch } = await branchActionFixture(t, action);
      if (kind === 'staged' || kind === 'unstaged') {
        await f.git.run(['switch', 'topic']);
        await f.write('hello.txt', 'target version\n');
        await f.commit('target changes tracked path');
        const source = await f.git.value('rev-parse', 'HEAD');
        await f.git.run(['switch', 'main']);
        if (action === trackRemote) await f.git.run(['update-ref', 'refs/remotes/origin/remote-topic', source]);
      }
      const name = ['untracked', 'ignored'].includes(kind) ? 'topic.txt' : 'hello.txt';
      if (kind === 'ignored') await writeFile(await f.git.gitPath('info/exclude'), 'topic.txt\n');
      await f.write(name, 'must survive\n');
      if (kind === 'staged') await f.git.stagePaths([name]);
      const before = await snapshot(f);
      await assert.rejects(action(new ScriptedConsole([...answers, 'y']), f.git), GitError);
      assertSnapshot(await snapshot(f), before);
      assert.equal(await readFile(join(f.path, name), 'utf8'), 'must survive\n');
      assert.equal(await f.git.value('stash', 'list'), '');
      if (action === trackRemote) assert.notEqual((await f.git.run(['show-ref', '--verify', `refs/heads/${branch}`], { check: false })).status, 0);
    });
  }
  test(`${action.name} rechecks selected source OID after confirmation`, async t => {
    const { f, answers } = await branchActionFixture(t, action);
    const ref = action === switchBranch ? 'refs/heads/topic' : 'refs/remotes/origin/remote-topic';
    const ui = changingRoutineConsole([...answers, 'y'], () => f.git.run(['update-ref', ref, f.initial]));
    await assert.rejects(action(ui, f.git), /目标分支|来源分支/);
    assert.equal(await f.git.branch(), 'main');
  });
}

test('dirty merge still stops, while a registered gitlink is handled without recursive submodule work', async t => {
  const f = await initialFixture(t);
  await f.write('hello.txt', 'uncommitted\n');
  await assert.rejects(mergeBranch(new ScriptedConsole(), f.git), /未提交/);
  await f.git.run(['update-index', '--add', '--cacheinfo', `160000,${f.initial},embedded`]);
  await f.git.run(['commit', '-m', 'register gitlink']);
  await assert.doesNotReject(f.git.ensureSupported());
  assert.match(await f.git.value('ls-tree', 'HEAD', '--', 'embedded'), /^160000 commit [a-f0-9]+\tembedded$/u);
});

test('merge rechecks source and worktree after confirmation', async t => {
  const f = await initialFixture(t);
  await topic(f);
  let ui = changingConsole(['1', 'y'], () => f.git.run(['update-ref', 'refs/heads/topic', f.initial]));
  await assert.rejects(mergeBranch(ui, f.git), /来源分支/);
  ui = changingConsole(['1', 'y'], () => f.write('surprise.txt'));
  await assert.rejects(mergeBranch(ui, f.git), /状态发生变化/);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), f.initial);
  assert.equal(await f.git.operation(), '');
});

test('continue rechecks index bytes after preview', async t => {
  const f = await initialFixture(t);
  await pending(f);
  const originalHead = await f.git.value('rev-parse', 'HEAD');
  const ui = changingConsole(['y'], async () => {
    await f.write('added-after-preview.txt');
    await f.git.stagePaths(['added-after-preview.txt']);
  });
  await assert.rejects(continueMerge(ui, f.git), /暂存内容发生变化/);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), originalHead);
  assert.equal(await f.git.operation(), 'MERGE_HEAD');
});

test('rename changes only the current local branch and leaves remote refs and linked worktrees intact', async t => {
  const f = await initialFixture(t);
  const target = await f.remote();
  await f.git.run(['push', '--set-upstream', 'origin', 'main']);
  await f.git.run(['branch', 'topic']);
  const linked = join(f.base, 'linked-rename');
  await f.git.run(['worktree', 'add', linked, 'topic']);
  await renameBranch(new ScriptedConsole(['renamed-main', 'y']), f.git);
  assert.equal(await f.git.branch(), 'renamed-main');
  assert.equal(await f.git.value('rev-parse', 'HEAD'), f.initial);
  assert.equal(await new Git(linked).branch(), 'topic');
  assert.equal(await f.git.value('rev-parse', 'refs/remotes/origin/main'), f.initial);
  assert.equal(await new Git(target).value('rev-parse', 'refs/heads/main'), f.initial);
  assert.equal(await f.git.config('branch.renamed-main.remote'), 'origin');
});

test('force deleting an unmerged local branch leaves another worktree and remote refs unchanged', async t => {
  const f = await initialFixture(t);
  const target = await seededRemote(f);
  const unmerged = await topic(f);
  const linked = join(f.base, 'linked-force-delete');
  await f.git.run(['worktree', 'add', linked, 'topic']);
  await f.git.run(['branch', 'doomed', unmerged]);
  const choices = (await listBranches(new ScriptedConsole(), f.git)).filter(ref => ref.local && ref.name !== 'main');
  const choice = choices.findIndex(ref => ref.name === 'doomed') + 1;
  assert.ok(choice > 0);
  await forceDeleteBranch(new ScriptedConsole([String(choice), 'y']), f.git);
  assert.notEqual((await f.git.run(['show-ref', '--verify', 'refs/heads/doomed'], { check: false })).status, 0);
  assert.equal(await new Git(linked).branch(), 'topic');
  assert.equal(await f.git.value('rev-parse', 'refs/heads/topic'), unmerged);
  assert.equal(await new Git(target).value('rev-parse', 'refs/heads/remote-topic'), f.initial);
});

test('force delete refuses a branch checked out in another worktree', async t => {
  const f = await initialFixture(t);
  await f.git.run(['branch', 'topic']);
  const linked = join(f.base, 'linked-force-refuse');
  await f.git.run(['worktree', 'add', linked, 'topic']);
  const choices = (await listBranches(new ScriptedConsole(), f.git)).filter(ref => ref.local && ref.name !== 'main');
  const choice = choices.findIndex(ref => ref.name === 'topic') + 1;
  await assert.rejects(forceDeleteBranch(new ScriptedConsole([String(choice), 'y']), f.git), GitError);
  assert.equal(await new Git(linked).branch(), 'topic');
  assert.equal(await f.git.value('rev-parse', 'refs/heads/topic'), f.initial);
});

test('delete rechecks target OID after confirmation', async t => {
  const f = await initialFixture(t);
  await f.git.run(['branch', 'topic']);
  await f.write('next.txt');
  await f.commit('next');
  const ui = changingConsole(['1', 'y'], () => f.git.run(['update-ref', 'refs/heads/topic', 'HEAD']));
  await assert.rejects(deleteMergedBranch(ui, f.git), /来源分支/);
  assert.equal(await f.git.value('rev-parse', 'refs/heads/topic'), await f.git.value('rev-parse', 'HEAD'));
});

test('cancelled menus and confirmations leave exact state unchanged', async t => {
  const f = await initialFixture(t);
  await f.git.run(['branch', 'topic']);
  const before = await snapshot(f);
  for (const [action, answers] of [[branchesMenu, ['0']], [createBranch, ['new', 'n']], [switchBranch, ['2', 'n']], [mergeBranch, ['1', 'n']], [deleteMergedBranch, ['1', 'n']]]) {
    await action(new ScriptedConsole(answers), f.git);
    assertSnapshot(await snapshot(f), before);
  }
  await assert.rejects(createBranch(new ScriptedConsole([':q']), f.git), Cancelled);
  assertSnapshot(await snapshot(f), before);
});

test('new branch menu actions append after the original nine and still require hard confirmation in quick mode', async t => {
  const f = await initialFixture(t);
  const ui = new ScriptedConsole(['0']);
  await branchesMenu(ui, f.git);
  for (const label of ['9. 删除已合并', '10. 改名当前', '11. 强制删除', '12. 删除远程', '13. 进行中的操作']) assert.ok(ui.transcript.includes(label), label);
  await topic(f);
  const before = await snapshot(f);
  await renameBranch(new ScriptedConsole(['not-renamed', 'n'], { quick: true }), f.git);
  await forceDeleteBranch(new ScriptedConsole(['1', 'n'], { quick: true }), f.git);
  assertSnapshot(await snapshot(f), before);
  await assert.rejects(renameBranch(new ScriptedConsole(['topic']), f.git), /已经存在/u);
  await assert.rejects(renameBranch(new ScriptedConsole([':q']), f.git), Cancelled);
  assertSnapshot(await snapshot(f), before);
});

test('rename and force delete recheck HEAD and selected branch OID after confirmation', async t => {
  const f = await initialFixture(t);
  const source = await topic(f);
  await assert.rejects(renameBranch(changingConsole(['renamed', 'y'], () => f.git.run(['switch', 'topic'])), f.git), /HEAD|分支.*发生变化/u);
  assert.notEqual((await f.git.run(['show-ref', '--verify', 'refs/heads/renamed'], { check: false })).status, 0);
  await f.git.run(['switch', 'main']);
  await assert.rejects(forceDeleteBranch(changingConsole(['1', 'y'], () => f.git.run(['update-ref', 'refs/heads/topic', f.initial])), f.git), /来源分支/u);
  assert.notEqual(source, f.initial);
  assert.equal(await f.git.value('rev-parse', 'refs/heads/topic'), f.initial);
});

test('declining conflict resolution and abort preserves merge and external edits', async t => {
  const f = await initialFixture(t);
  await conflicted(f);
  await f.write('hello.txt', 'external resolution not yet staged\n');
  const before = await snapshot(f);
  await resolveConflicts(new ScriptedConsole(['1', 'n']), f.git);
  await abortMerge(new ScriptedConsole(['n']), f.git);
  assertSnapshot(await snapshot(f), before);
});

test('merge treats a source gitlink as a pointer and never recurses into its contents', async t => {
  const f = await initialFixture(t);
  await f.git.run(['switch', '-c', 'topic']);
  await f.git.run(['update-index', '--add', '--cacheinfo', `160000,${f.initial},embedded`]);
  await f.git.run(['commit', '-m', 'source adds gitlink']);
  const source = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['switch', 'main']);
  const ui = new ScriptedConsole(['1', 'y']);
  await mergeBranch(ui, f.git);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), source);
  assert.equal(await f.git.operation(), '');
  assert.match(ui.transcript, /快进|gitlink|指针/u);
});

async function independentHistory(f, conflict = false) {
  await f.git.run(['switch', '--orphan', 'unrelated']);
  await f.write(conflict ? 'hello.txt' : 'alien.txt', 'unrelated root\n');
  await f.commit('unrelated history');
  const source = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['switch', 'main']);
  return source;
}

for (const quick of [false, true]) {
  test(`unrelated histories require explicit selection and exactly one hard confirmation in ${quick ? 'quick' : 'confirm'} mode`, async t => {
    const f = await initialFixture(t);
    const source = await independentHistory(f);
    const ui = new ScriptedConsole(['1', '1', 'y'], { quick });
    ui.routineConfirm = async () => assert.fail('unrelated merge must not stack routine confirmation');
    const original = Git.prototype.run;
    const merges = [];
    t.mock.method(Git.prototype, 'run', async function(args, options) {
      if (args[0] === 'merge') merges.push([...args]);
      return original.call(this, args, options);
    });
    await mergeBranch(ui, f.git);
    assert.deepEqual(await parents(f), [f.initial, source]);
    assert.equal(await f.git.operation(), '');
    assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'first\n');
    assert.equal(await readFile(join(f.path, 'alien.txt'), 'utf8'), 'unrelated root\n');
    assert.equal(ui.messages.filter(message => message.includes('[y/N]')).length, 1);
    assert.match(ui.transcript, /无冲突时将创建.*本地合并提交/);
    assert.deepEqual(ui.answers, []);
    assert.equal(merges.length, 1);
    assert.ok(merges[0].includes('--allow-unrelated-histories'));
    await topic(f);
    await mergeBranch(new ScriptedConsole(['1'], { quick: true }), f.git);
    assert.equal(merges.length, 2);
    assert.ok(!merges[1].includes('--allow-unrelated-histories'));
  });
  for (const answers of [['1', '0'], ['1', '1', 'n']]) {
    test(`declining unrelated history ${answers.length === 2 ? 'selection' : 'impact'} in ${quick ? 'quick' : 'confirm'} mode never runs merge`, async t => {
      const f = await initialFixture(t);
      await independentHistory(f);
      const before = await snapshot(f);
      const original = Git.prototype.run;
      t.mock.method(Git.prototype, 'run', async function(args, options) {
        assert.notEqual(args[0], 'merge', 'declined unrelated merge was executed');
        return original.call(this, args, options);
      });
      await mergeBranch(new ScriptedConsole(answers, { quick }), f.git);
      assertSnapshot(await snapshot(f), before);
    });
  }
}

test('unrelated history conflicts retain the merge and require a separate continue choice', async t => {
  const f = await initialFixture(t);
  const source = await independentHistory(f, true);
  const ui = new ScriptedConsole(['1', '1', 'y']);
  ui.routineConfirm = async () => assert.fail('a conflicting unrelated merge must not auto-continue');
  await mergeBranch(ui, f.git);
  assert.deepEqual(await f.git.unmerged(), ['hello.txt']);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), f.initial);
  assert.equal(await f.git.operation(), 'MERGE_HEAD');
  await f.write('hello.txt', 'external resolution\n');
  await resolveConflicts(new ScriptedConsole(['1', 'y']), f.git);
  await continueMerge(new ScriptedConsole(['n']), f.git);
  assert.equal(await f.git.operation(), 'MERGE_HEAD');
  await continueMerge(new ScriptedConsole(['y']), f.git);
  assert.deepEqual(await parents(f), [f.initial, source]);
});

for (const status of [2, 128, 1]) {
  test(`merge-base execution error status ${status} is never treated as unrelated history`, async t => {
    const f = await initialFixture(t);
    await topic(f);
    const before = await snapshot(f);
    const original = Git.prototype.run;
    t.mock.method(Git.prototype, 'run', async function(args, options) {
      assert.notEqual(args[0], 'merge');
      if (args[0] === 'merge-base') return { status, stdout: Buffer.alloc(0), stderr: Buffer.from('fatal: cannot read commit object\n') };
      return original.call(this, args, options);
    });
    const ui = new ScriptedConsole(['1']);
    await assert.rejects(mergeBranch(ui, f.git), /无法检查.*共同祖先/);
    assert.doesNotMatch(ui.transcript, /明确合并独立历史/);
    assertSnapshot(await snapshot(f), before);
  });
}

for (const kind of ['source', 'worktree']) {
  test(`unrelated history merge rechecks ${kind} after its hard confirmation`, async t => {
    const f = await initialFixture(t);
    await independentHistory(f);
    const ui = changingConsole(['1', '1', 'y'], () => kind === 'source' ? f.git.run(['update-ref', 'refs/heads/unrelated', f.initial]) : f.write('surprise.txt', 'raced\n'), { quick: true });
    await assert.rejects(mergeBranch(ui, f.git), /来源分支|状态发生变化/);
    assert.equal(await f.git.value('rev-parse', 'HEAD'), f.initial);
    assert.equal(await f.git.operation(), '');
  });
}

test('resolution rechecks index changes during ID selection', async t => {
  const f = await initialFixture(t);
  await conflicted(f);
  const ui = new ScriptedConsole(['1', 'y']);
  const select = ui.select.bind(ui);
  ui.select = async options => {
    const selected = await select(options);
    await f.write('hello.txt', 'externally staged resolution\n');
    await f.git.stagePaths(['hello.txt']);
    return selected;
  };
  await assert.rejects(resolveConflicts(ui, f.git), /暂存内容发生变化/);
  assert.equal(await f.git.operation(), 'MERGE_HEAD');
});

test('declining track and upstream does not write refs or config', async t => {
  const f = await initialFixture(t);
  await seededRemote(f);
  const before = await snapshot(f);
  await trackRemote(new ScriptedConsole(['1', 'cancelled', 'n']), f.git);
  await setUpstream(new ScriptedConsole(['1', 'n']), f.git);
  assertSnapshot(await snapshot(f), before);
});

test('quick create switch track upstream and local fetch skip routine confirmations', async t => {
  const f = await initialFixture(t);
  await seededRemote(f);
  await createBranch(new ScriptedConsole(['quick-local'], { quick: true }), f.git);
  assert.equal(await f.git.branch(), 'quick-local');
  await switchBranch(new ScriptedConsole(['1'], { quick: true }), f.git);
  assert.equal(await f.git.branch(), 'main');
  await trackRemote(new ScriptedConsole(['1', 'tracked'], { quick: true }), f.git);
  await setUpstream(new ScriptedConsole(['1'], { quick: true }), f.git);
  assert.equal(await f.git.config('branch.tracked.remote'), 'origin');
  await fetchRemote(new ScriptedConsole(['1'], { quick: true }), f.git);
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), true);
});

test('fetch command preserves the scoped Git context', async t => {
  const f = await initialFixture(t);
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

test('quick merge start and commit still create a proper two-parent commit', async t => {
  const f = await initialFixture(t);
  const expected = await divergent(f);
  await mergeBranch(new ScriptedConsole(['1'], { quick: true }), f.git);
  assert.deepEqual(await parents(f), expected);
});

test('quick mark resolution and continue skip routine confirmations', async t => {
  const f = await initialFixture(t);
  const expected = await conflicted(f);
  await f.write('hello.txt', 'quick resolution\n');
  await resolveConflicts(new ScriptedConsole(['1'], { quick: true }), f.git);
  await continueMerge(new ScriptedConsole([], { quick: true }), f.git);
  assert.deepEqual(await parents(f), expected);
});

test('quick mode retains abort and delete hard confirmations but selected full diff needs none', async t => {
  const f = await initialFixture(t);
  await conflicted(f);
  const before = await snapshot(f);
  await abortMerge(new ScriptedConsole(['n'], { quick: true }), f.git);
  const ui = new ScriptedConsole(['1'], { quick: true });
  await conflictCenter(ui, f.git);
  assert.ok(ui.transcript.includes('main version'));
  assert.deepEqual(ui.answers, []);
  assertSnapshot(await snapshot(f), before);
  await f.git.run(['merge', '--abort']);
  await f.git.run(['branch', 'disposable']);
  await deleteMergedBranch(new ScriptedConsole(['1', 'n'], { quick: true }), f.git);
  assert.equal(await f.git.value('rev-parse', 'disposable'), await f.git.value('rev-parse', 'HEAD'));
});

test('explicit scoped identity reaches merge commit without changing repository config', async t => {
  const f = await initialFixture(t);
  await divergent(f);
  await f.git.run(['config', '--unset', 'user.name']);
  await f.git.run(['config', '--unset', 'user.email']);
  const scoped = new Git(f.path, {
    config: { 'user.name': 'Bound Author', 'user.email': 'bound@example.invalid' },
    env: { GIT_COMMITTER_NAME: 'Bound Committer' },
  });
  await mergeBranch(new ScriptedConsole(['1', 'y', 'y']), scoped);
  assert.equal(await f.git.value('show', '-s', '--format=%an|%ae|%cn', 'HEAD'), 'Bound Author|bound@example.invalid|Bound Committer');
  assert.equal(await f.git.config('user.name'), '');
  assert.equal(await f.git.config('user.email'), '');
});

async function createOfflineProfile() {
  const store = new ProfileStore();
  const profile = await store.create(new ScriptedConsole([], { quick: true }), 'Local Test', 'Profile Author', 'profile@example.invalid', 'local-test', { rememberAuth: true });
  assert.ok(profile);
  return { store, profile };
}

test('real profile binding reaches merge commit through directory lookup', async t => {
  const f = await initialFixture(t);
  await divergent(f);
  const { store, profile } = await createOfflineProfile();
  await store.bind(f.path, profile.profile_id);
  await f.git.run(['config', '--unset', 'user.name']);
  await f.git.run(['config', '--unset', 'user.email']);
  await mergeBranch(new ScriptedConsole(['1'], { quick: true }), f.path);
  assert.equal(await f.git.value('show', '-s', '--format=%an|%ae', 'HEAD'), 'Profile Author|profile@example.invalid');
  assert.equal(await f.git.config('user.name'), '');
  assert.equal(await f.git.config('user.email'), '');
});

test('fetch uses a different Git returned by real remoteContext without contacting GitHub', async t => {
  const f = await initialFixture(t);
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
      // Execute the actual fetch only against the fixture bare repo. No SSH/network is launched.
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
  const f = await initialFixture(t);
  await f.git.run(['remote', 'add', 'origin', 'git@github.com:example/project.git']);
  const original = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    assert.ok(!['fetch', 'push', 'pull', 'ls-remote'].includes(args[0]), 'unexpected network/default SSH key use');
    return original.call(this, args, options);
  });
  await assert.rejects(fetchRemote(new ScriptedConsole(['1'], { quick: true }), f.git), /没有选择软件账号/);
  assert.equal(existsSync(await f.git.gitPath('FETCH_HEAD')), false);
});

test('merge continuation refuses staged managed account data and retains the merge', async t => {
  const f = await initialFixture(t);
  await pending(f);
  const originalHead = await f.git.value('rev-parse', 'HEAD');
  await f.write('account-data/private.key', 'never commit this\n');
  process.env.AUTOGIT_DATA_DIR = join(f.path, 'account-data');
  await f.git.stagePaths(['account-data/private.key']);
  const index = (await f.git.run(['ls-files', '--stage', '-z'])).stdout;
  await assert.rejects(continueMerge(new ScriptedConsole(), f.git), /账号数据/);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), originalHead);
  assert.equal(await f.git.operation(), 'MERGE_HEAD');
  assert.ok((await f.git.run(['ls-files', '--stage', '-z'])).stdout.equals(index));
});

test('conflict resolution refuses to stage paths inside managed account data', async t => {
  const f = await initialFixture(t);
  await conflicted(f);
  await f.write('hello.txt', 'external resolution\n');
  process.env.AUTOGIT_DATA_DIR = f.path;
  const index = (await f.git.run(['ls-files', '--stage', '-z'])).stdout;
  await assert.rejects(resolveConflicts(new ScriptedConsole(['1', 'y']), f.git), /账号数据/);
  assert.deepEqual(await f.git.unmerged(), ['hello.txt']);
  assert.ok((await f.git.run(['ls-files', '--stage', '-z'])).stdout.equals(index));
});
