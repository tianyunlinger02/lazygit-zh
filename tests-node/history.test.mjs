import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Git } from '../dist/git.js';
import { chooseCommit, commitDetails, commitPage, historyGraph, historyMenu } from '../dist/history.js';
import { inspect } from '../dist/workflows.js';
import { fixture, ScriptedConsole } from './support.mjs';

test('commit pages, fixed-text search, selection pagination and graph stay offline', async t => {
  const f = await fixture(t, { committed: true });
  for (let i = 0; i < 22; i++) { await f.write('hello.txt', String(i)); await f.commit(`entry ${i} ${i === 3 ? '[fixed].*中文' : ''}`); }
  assert.equal((await commitPage(f.git)).length, 20); assert.equal((await commitPage(f.git, { skip: 20 })).length, 3);
  const searched = await commitPage(f.git, { search: '[FIXED].*中文' }); assert.equal(searched.length, 1);
  const oid = await chooseCommit(new ScriptedConsole(['21', '1']), f.git); assert.equal(oid, (await commitPage(f.git, { skip: 20 }))[0].oid);
  assert.equal(await chooseCommit(new ScriptedConsole(['23', '[fixed].*中文', '1']), f.git), searched[0].oid);
  const ui = new ScriptedConsole(['0']); await historyGraph(ui, f.git); assert.match(ui.transcript, /entry 21/);
  for (const options of [{ skip: -1 }, { skip: 0.5 }, { limit: 0 }, { limit: 101 }, { limit: NaN }]) await assert.rejects(commitPage(f.git, options), /分页/);
});

test('commit details separate metadata/stat from sensitive patch confirmation', async t => {
  const f = await fixture(t, { committed: true }); const oid = await f.git.value('rev-parse', 'HEAD');
  const ui = new ScriptedConsole(['0'], { quick: true }); await commitDetails(ui, f.git, oid);
  assert.match(ui.transcript, /initial/); assert.match(ui.transcript, /hello.txt/); assert.doesNotMatch(ui.transcript, /\+first/);
  assert.equal(ui.answers.length, 0);
});

test('unborn read-only history and cancellation are nonmutating', async t => {
  const f = await fixture(t); assert.deepEqual(await commitPage(f.git), []);
  await historyMenu(new ScriptedConsole(['0']), f.path);
  assert.equal(await chooseCommit(new ScriptedConsole(['0']), f.git), undefined);
  const ui = new ScriptedConsole(); await historyGraph(ui, f.git); assert.match(ui.transcript, /还没有提交/);
  assert.equal(await f.git.hasCommits(), false); assert.deepEqual(await f.git.changes(), []);
});

test('history exposes only read-only APIs and its menu has no recovery action', async t => {
  const f = await fixture(t);
  const history = await import('../dist/history.js');
  assert.deepEqual(Object.keys(history).sort(), ['browseHistory', 'chooseCommit', 'commitDetails', 'commitPage', 'historyGraph', 'historyMenu'].sort());
  const ui = new ScriptedConsole(['0']), menus = [], menu = ui.menu.bind(ui);
  ui.menu = async (title, options, back) => { menus.push({ title, options: [...options] }); return menu(title, options, back); };
  await historyMenu(ui, f.path);
  assert.deepEqual(menus, [{ title: '只读历史', options: ['历史分页 / 搜索 / 提交详情', '本地历史图（分支、合并、远程缓存）'] }]);
});

test('inspect retains its first four read-only choices and adds history as the fifth', async t => {
  const f = await fixture(t, { committed: true }), head = await f.git.value('rev-parse', 'HEAD');
  const ui = new ScriptedConsole(['5', '1', '1', '0']), menus = [], menu = ui.menu.bind(ui);
  ui.menu = async (title, options, back) => { menus.push({ title, options: [...options] }); return menu(title, options, back); };
  await inspect(ui, f.path);
  assert.deepEqual(menus[0], { title: '查看项目', options: ['文件状态', '未暂存差异', '已暂存差异', '最近 20 条提交', '只读历史（分页 / 搜索 / 详情 / 图）'] });
  assert.equal(menus[1].title, '只读历史'); assert.equal(menus[1].options.length, 2);
  assert.match(ui.transcript, /提交：/u); assert.match(ui.transcript, /initial/u); assert.deepEqual(ui.answers, []);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), head); assert.deepEqual(await f.git.changes(), []);
});

test('history detail and graph routes stay offline and do not change detached HEAD, index or dirty bytes', async t => {
  const f = await fixture(t, { committed: true }); await f.git.run(['checkout', '--detach', 'HEAD']);
  await f.write('hello.txt', 'indexed version'); await f.git.stagePaths(['hello.txt']); await f.write('hello.txt', 'unfinished worktree');
  const head = await f.git.value('rev-parse', 'HEAD'), refs = await f.git.value('for-each-ref', '--format=%(refname) %(objectname)');
  const index = (await f.git.run(['ls-files', '--stage', '-z'])).stdout, run = Git.prototype.run, calls = [];
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    calls.push([...args]);
    assert.ok(['config', 'rev-parse', 'symbolic-ref', 'log', 'show', 'ls-files', 'for-each-ref'].includes(args[0]), `read-only history must not run ${args[0]}`);
    return run.call(this, args, options);
  });
  await historyMenu(new ScriptedConsole(['1', '1', '1']), f.path);
  const graph = new ScriptedConsole(['2', '1', '2', '0']); await historyMenu(graph, f.path);
  assert.match(graph.transcript, /initial/u);
  const patches = calls.filter(args => args[0] === 'show' && !args.includes('--no-patch') && !args.includes('--stat'));
  assert.equal(patches.length, 1); assert.ok(patches[0].includes('--no-ext-diff')); assert.ok(patches[0].includes('--no-textconv'));
  assert.ok(calls.some(args => args[0] === 'log' && args.includes('--graph') && args.includes('--skip=30')));
  assert.equal(await f.git.value('rev-parse', 'HEAD'), head); assert.equal((await f.git.run(['symbolic-ref', '-q', 'HEAD'], { check: false })).status, 1);
  assert.equal(await f.git.value('for-each-ref', '--format=%(refname) %(objectname)'), refs);
  assert.deepEqual((await f.git.run(['ls-files', '--stage', '-z'])).stdout, index);
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'unfinished worktree');
});

test('history manual references resolve only local commits and reject option-like or unavailable targets', async t => {
  const f = await fixture(t, { committed: true }), oid = await f.git.value('rev-parse', 'HEAD');
  assert.equal(await chooseCommit(new ScriptedConsole(['5', 'HEAD']), f.git), oid);
  assert.equal((await commitPage(f.git, { ref: 'HEAD', limit: 1 }))[0].oid, oid);
  for (const ref of ['--all', 'missing-local-ref', 'HEAD:hello.txt']) {
    await assert.rejects(commitPage(f.git, { ref }), /不是可用的本地提交/u);
    await assert.rejects(commitDetails(new ScriptedConsole(), f.path, ref), /不是可用的本地提交/u);
  }
  assert.equal(await f.git.value('rev-parse', 'HEAD'), oid);
});
