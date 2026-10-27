import test from 'node:test';
import assert from 'node:assert/strict';
import { remotesMenu } from '../dist/remotes.js';
import { Git, GitError } from '../dist/git.js';
import { fixture, ScriptedConsole } from './support.mjs';

const first = 'https://one.example.invalid/team/repo.git';
const second = 'https://two.example.invalid/team/repo.git';
const third = 'ssh://git@three.example.invalid/team/repo.git';

async function configured(t) {
  const f = await fixture(t, { committed: true });
  await f.git.run(['remote', 'add', 'origin', first]);
  await f.git.run(['remote', 'set-url', '--add', 'origin', second]);
  await f.git.run(['config', 'branch.main.remote', 'origin']);
  await f.git.run(['config', 'branch.main.merge', 'refs/heads/main']);
  return f;
}

test('remote list replacement explicitly replaces all URLs without changing upstream or contacting a server', async t => {
  const f = await configured(t);
  const ui = new ScriptedConsole(['1', '1', '1', third, second, 'y'], { quick: true });
  await remotesMenu(ui, f.path);
  assert.deepEqual(await f.git.remoteUrls('origin'), [third]);
  assert.deepEqual(await f.git.remoteUrls('origin', true), [second]);
  assert.equal(await f.git.config('branch.main.remote'), 'origin');
  assert.equal(await f.git.config('branch.main.merge'), 'refs/heads/main');
  assert.match(ui.transcript, /完整列表/u);
  assert.equal(ui.messages.filter(value => value.includes('[y/N]')).length, 1);
  assert.deepEqual(ui.answers, []);
});

test('remote URL list add, remove and inherited push reset preserve the other list', async t => {
  const f = await configured(t);
  await remotesMenu(new ScriptedConsole(['1', '2', '1', '2', '1', third, 'y']), f.path);
  assert.deepEqual(await f.git.remoteUrls('origin', true), [third]);
  assert.deepEqual(await f.git.remoteUrls('origin'), [first, second]);
  await remotesMenu(new ScriptedConsole(['1', '2', '1', '1', '2', '2', 'y']), f.path);
  assert.deepEqual(await f.git.remoteUrls('origin'), [first]);
  await remotesMenu(new ScriptedConsole(['1', '2', '1', '2', '3', 'y']), f.path);
  assert.deepEqual(await f.git.remoteUrls('origin', true), [first]);
  assert.equal(await f.git.config('remote.origin.pushurl'), '');
});

test('remote URL list refuses removing the last fetch URL and cancellation leaves configuration unchanged', async t => {
  const f = await configured(t);
  const before = (await f.git.run(['config', '--local', '--list'])).stdout;
  await remotesMenu(new ScriptedConsole(['1', '2', '1', '2', '1', third, 'n'], { quick: true }), f.path);
  assert.deepEqual((await f.git.run(['config', '--local', '--list'])).stdout, before);
  await f.git.run(['config', '--replace-all', 'remote.origin.url', first]);
  await assert.rejects(remotesMenu(new ScriptedConsole(['1', '2', '1', '1', '2', '1']), f.path), /至少保留一个/u);
  assert.deepEqual(await f.git.remoteUrls('origin'), [first]);
});

test('remote URL replacement detects changed raw lists even when effective push destination stays unchanged', async t => {
  const f = await configured(t);
  await f.git.run(['config', 'remote.origin.pushurl', third]);
  const ui = new ScriptedConsole(['1', '1', '1', third, second, 'y']);
  const confirm = ui.confirm.bind(ui);
  ui.confirm = async (...args) => { const answer = await confirm(...args); await f.git.run(['config', '--add', 'remote.origin.pushurl', third]); return answer; };
  await assert.rejects(remotesMenu(ui, f.path), /变化/u);
  assert.deepEqual(await f.git.remoteUrls('origin'), [first, second]);
});

test('remote URL partial failure reports completed fetch without retrying or claiming atomic success', async t => {
  const f = await configured(t);
  const run = Git.prototype.run;
  let attempted = 0;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'config' && args.includes('--replace-all') && args.includes('remote.origin.pushurl')) { attempted++; throw new GitError('fixture push config failure'); }
    return run.call(this, args, options);
  });
  await assert.rejects(remotesMenu(new ScriptedConsole(['1', '1', '1', third, second, 'y']), f.path), /可能已经部分写入.*fetch/u);
  assert.equal(attempted, 1);
  assert.deepEqual(await f.git.remoteUrls('origin'), [third]);
  assert.equal(await f.git.config('remote.origin.pushurl'), '');
});
