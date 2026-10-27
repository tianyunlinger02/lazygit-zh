import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browseReflog, chooseCommit, commitDetails, commitPage, historyGraph, historyMenu, recoverBranch, reflogPage } from '../dist/history.js';
import { fixture, ScriptedConsole } from './support.mjs';

test('commit pages, fixed-text search, selection pagination and graph stay offline', async t => {
  const f = await fixture(t, { committed: true });
  for (let i = 0; i < 22; i++) { await f.write('hello.txt', String(i)); await f.commit(`entry ${i} ${i === 3 ? '[fixed].*中文' : ''}`); }
  assert.equal((await commitPage(f.git)).length, 20); assert.equal((await commitPage(f.git, { skip: 20 })).length, 3);
  const searched = await commitPage(f.git, { search: '[fixed].*中文' }); assert.equal(searched.length, 1);
  const oid = await chooseCommit(new ScriptedConsole(['21', '1']), f.git); assert.equal(oid, (await commitPage(f.git, { skip: 20 }))[0].oid);
  const ui = new ScriptedConsole(['0']); await historyGraph(ui, f.git); assert.match(ui.transcript, /entry 21/);
  await assert.rejects(commitPage(f.git, { skip: -1 }), /分页/);
});

test('commit details separate metadata/stat from sensitive patch confirmation', async t => {
  const f = await fixture(t, { committed: true }); const oid = await f.git.value('rev-parse', 'HEAD');
  const ui = new ScriptedConsole(['0'], { quick: true }); await commitDetails(ui, f.git, oid);
  assert.match(ui.transcript, /initial/); assert.match(ui.transcript, /hello.txt/); assert.doesNotMatch(ui.transcript, /\+first/);
  assert.equal(ui.answers.length, 0);
});

test('reflog recovers lost commit to a new branch without moving HEAD or touching dirty worktree', async t => {
  const f = await fixture(t, { committed: true }); const base = await f.git.value('rev-parse', 'HEAD');
  await f.write('lost.txt', 'saved'); await f.commit('lost commit'); const lost = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['reset', '--hard', base]); await f.write('hello.txt', 'unsaved');
  assert.ok((await reflogPage(f.git)).some(entry => entry.oid === lost));
  await recoverBranch(new ScriptedConsole(['y']), f.git, { commit: lost, name: 'recovery/lost' });
  assert.equal(await f.git.value('rev-parse', 'refs/heads/recovery/lost'), lost); assert.equal(await f.git.value('rev-parse', 'HEAD'), base);
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'unsaved');
  await assert.rejects(recoverBranch(new ScriptedConsole(), f.git, { commit: lost, name: 'recovery/lost' }), /已存在/);
});

test('reflog recovery menu selects a pinned OID, confirmation cannot overwrite a newly created branch', async t => {
  const f = await fixture(t, { committed: true }); const head = await f.git.value('rev-parse', 'HEAD');
  await browseReflog(new ScriptedConsole(['1', 'saved', 'y']), f.git); assert.equal(await f.git.value('rev-parse', 'saved'), head);
  const ui = new ScriptedConsole(['y']); const confirm = ui.confirm.bind(ui); ui.confirm = async (...args) => { const result = await confirm(...args); await f.git.run(['branch', 'raced']); return result; };
  await assert.rejects(recoverBranch(ui, f.git, { commit: head, name: 'raced' }), /already exists/);
});

test('unborn history/reflog and cancellation are nonmutating', async t => {
  const f = await fixture(t); assert.deepEqual(await commitPage(f.git), []); assert.deepEqual(await reflogPage(f.git), []);
  await historyMenu(new ScriptedConsole(['0']), f.path); const ui = new ScriptedConsole(); await historyGraph(ui, f.git); assert.match(ui.transcript, /还没有提交/);
});
