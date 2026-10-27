import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { drop, records, restore, save, stashMenu } from '../dist/stash.js';
import { GitError } from '../dist/git.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function prepare(t) {
  const f = await fixture(t);
  await f.write();
  await f.write('.gitignore', 'ignored.txt\n');
  await f.commit();
  return f;
}

test('save and restore preserves index, untracked file, ignored file, and record', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'staged\n');
  await f.git.run(['add', 'hello.txt']);
  await f.write('hello.txt', 'unstaged\n');
  await f.write('中文 新文件.txt');
  await f.write('ignored.txt', 'not stashed\n');
  await save(new ScriptedConsole(['y', '未完成任务', 'y']), f.path);
  assert.deepEqual(await f.git.changes(), []);
  assert.equal(existsSync(join(f.path, 'ignored.txt')), true);
  assert.equal((await records(f.git)).length, 1);
  await restore(new ScriptedConsole(['1', 'y']), f.path);
  assert.equal(await f.git.value('show', ':hello.txt'), 'staged');
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'unstaged\n');
  assert.equal(existsSync(join(f.path, '中文 新文件.txt')), true);
  assert.equal((await records(f.git)).length, 1);
});

test('declining save leaves index and worktree unchanged', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'changed\n');
  const original = await f.git.changes();
  await save(new ScriptedConsole(['later', 'n']), f.path);
  assert.deepEqual(await f.git.changes(), original);
  assert.deepEqual(await records(f.git), []);
});

test('excluding untracked leaves new file in worktree', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'changed\n');
  await f.write('new.txt');
  await save(new ScriptedConsole(['n', 'tracked only', 'y']), f.path);
  assert.equal((await f.git.changes())[0].path, 'new.txt');
  assert.equal(existsSync(join(f.path, 'new.txt')), true);
});

test('untracked-only worktree without inclusion does nothing', async t => {
  const f = await prepare(t);
  await f.write('new.txt');
  await save(new ScriptedConsole(['n']), f.path);
  assert.deepEqual(await records(f.git), []);
});

test('restore failure keeps the original stash record', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'stash version\n');
  await save(new ScriptedConsole(['saved', 'y']), f.path);
  await f.write('hello.txt', 'branch version\n');
  await f.commit('branch changed');
  const ui = new ScriptedConsole(['1', 'y']);
  await restore(ui, f.path);
  assert.equal((await records(f.git)).length, 1);
  assert.equal(existsSync(await f.git.gitPath('MERGE_HEAD')), false);
  assert.match(ui.transcript, /恢复未完整成功/);
});

test('restore refuses dirty target', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'dirty\n');
  await assert.rejects(restore(new ScriptedConsole(), f.path), /必须干净/);
});

test('drop respects decline then deletes only after hard confirmation', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'change\n');
  await save(new ScriptedConsole(['saved', 'y']), f.path);
  await drop(new ScriptedConsole(['1', 'n']), f.path);
  assert.equal((await records(f.git)).length, 1);
  await drop(new ScriptedConsole(['1', 'y']), f.path);
  assert.deepEqual(await records(f.git), []);
});

test('multiple records select by index and detect record list race', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'one\n');
  await save(new ScriptedConsole(['one', 'y']), f.path);
  await f.write('hello.txt', 'two\n');
  await save(new ScriptedConsole(['two', 'y']), f.path);
  assert.equal((await records(f.git)).length, 2);
  const ui = new ScriptedConsole(['2']);
  ui.confirm = async () => { await f.git.run(['stash', 'drop', 'stash@{0}']); return true; };
  await assert.rejects(drop(ui, f.path), /列表已被/);
  assert.equal((await records(f.git)).length, 1);
});

test('quick mode skips routine confirmations but drop remains hard confirmation', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'quick unfinished work\n');
  await save(new ScriptedConsole(['quick work'], { quick: true }), f.path);
  assert.deepEqual(await f.git.changes(), []);
  assert.equal((await records(f.git)).length, 1);
  await restore(new ScriptedConsole(['1'], { quick: true }), f.path);
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'quick unfinished work\n');
  assert.equal((await records(f.git)).length, 1);
  const ui = new ScriptedConsole(['1', 'n'], { quick: true });
  await drop(ui, f.path);
  assert.match(ui.transcript, /确定删除/);
  assert.equal((await records(f.git)).length, 1);
  await drop(new ScriptedConsole(['1', 'y'], { quick: true }), f.path);
  assert.deepEqual(await records(f.git), []);
});

test('quick save still asks about untracked scope', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'tracked unfinished\n');
  await f.write('untracked.txt', 'leave this file\n');
  const ui = new ScriptedConsole(['n', 'tracked only'], { quick: true });
  await save(ui, f.path);
  assert.match(ui.transcript, /同时收起/);
  assert.deepEqual((await f.git.changes()).map(change => change.path), ['untracked.txt']);
  assert.equal((await records(f.git)).length, 1);
});

test('unborn repository cannot be stashed', async t => {
  const f = await fixture(t);
  await assert.rejects(save(new ScriptedConsole(), f.path), /空仓库/);
});

test('stash menu retains numbered actions and records', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'menu work\n');
  await save(new ScriptedConsole(['menu', 'y']), f.path);
  const ui = new ScriptedConsole(['2']);
  await stashMenu(ui, f.path);
  assert.match(ui.transcript, /stash@\{0\}/);
  assert.match(ui.transcript, /menu/);
});

test('restore confirmation detects a changed HEAD or branch before applying', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'saved\n');
  await save(new ScriptedConsole(['saved', 'y']), f.path);
  const ui = new ScriptedConsole(['1', 'y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async prompt => {
    const result = await confirm(prompt);
    await f.git.run(['switch', '-c', 'other']);
    return result;
  };
  await assert.rejects(restore(ui, f.path), /HEAD、当前分支/);
  assert.equal((await records(f.git)).length, 1);
});

test('save detects branch changes even when fresh Change objects have identical values', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'unfinished\n');
  const before = await f.git.changes();
  const ui = new ScriptedConsole(['saved', 'y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async prompt => {
    const answer = await confirm(prompt);
    await f.git.run(['switch', '-c', 'other']);
    assert.deepEqual(await f.git.changes(), before);
    return answer;
  };
  await assert.rejects(save(ui, f.path), /HEAD、当前分支/);
  assert.deepEqual(await records(f.git), []);
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'unfinished\n');
});

test('restore rejects a merge operation started after preview without deleting stash', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'saved\n');
  await save(new ScriptedConsole(['saved', 'y']), f.path);
  await f.git.run(['switch', '-c', 'topic']);
  await f.write('topic.txt', 'topic\n');
  await f.commit('topic');
  await f.git.run(['switch', 'main']);
  const ui = new ScriptedConsole(['1', 'y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async prompt => {
    const answer = await confirm(prompt);
    await f.git.run(['merge', '--no-ff', '--no-commit', 'topic']);
    return answer;
  };
  await assert.rejects(restore(ui, f.path), /HEAD、当前分支/);
  assert.equal(await f.git.operation(), 'MERGE_HEAD');
  assert.equal((await records(f.git)).length, 1);
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'first\n');
});

test('save refuses new worktree entries that appear during confirmation', async t => {
  const f = await prepare(t);
  await f.write('hello.txt', 'unfinished\n');
  const ui = new ScriptedConsole(['saved', 'y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async prompt => {
    const answer = await confirm(prompt);
    await f.write('surprise.txt');
    return answer;
  };
  await assert.rejects(save(ui, f.path), /工作区状态发生变化/);
  assert.deepEqual(await records(f.git), []);
});
