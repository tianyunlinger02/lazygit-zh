import assert from 'node:assert/strict';
import test from 'node:test';
import { ScriptedConsole } from './support.mjs';
const moduleRoot = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { withTask } = await import(new URL('task-progress.js', moduleRoot));

test('nested task progress prints one truthful summary and awaits reverse-order cleanup without replacing the original error', async () => {
  const ui = new ScriptedConsole([]), cleanups = [], original = new Error('controlled action failure');
  await assert.rejects(withTask(ui, undefined, async task => {
    task.cleanup(async () => { cleanups.push('first'); });
    task.cleanup(async () => { await Promise.resolve(); cleanups.push('second'); });
    task.set('create', 'done', 'https://github.com/fixture/repo');
    await withTask(ui, task, async nested => {
      assert.equal(nested, task);
      task.set('commit', 'done', 'abc123');
      task.set('upload', 'unknown', 'check remote first');
      throw original;
    });
  }), error => error === original);
  assert.deepEqual(cleanups, ['second', 'first']);
  assert.equal(ui.transcript.split('本次操作结果').length - 1, 1);
  assert.match(ui.transcript, /仓库创建：已完成/u);
  assert.match(ui.transcript, /本地提交：已完成 · abc123/u);
  assert.match(ui.transcript, /远端上传：结果待核对/u);
  assert.match(ui.transcript, /不自动再次上传或强推/u);
});

test('task summary output failure still cleans resources and cannot mask a prior operation error', async () => {
  const original = new Error('operation'), outputFailure = new Error('output'), cleanups = [];
  const ui = { title() { throw outputFailure; }, text() {}, warn() {} };
  await assert.rejects(withTask(ui, undefined, async task => {
    task.cleanup(async () => { cleanups.push('cleaned'); });
    throw original;
  }), error => error === original);
  assert.deepEqual(cleanups, ['cleaned']);
  await assert.rejects(withTask(ui, undefined, async () => {}), error => error === outputFailure);
});

test('task cleanup attempts every resource even when another cleanup and warning output fail', async () => {
  const cleaned = [], ui = { title() {}, text() {}, warn() { throw new Error('output'); } };
  await withTask(ui, undefined, async task => {
    task.cleanup(async () => { cleaned.push('first'); });
    task.cleanup(async () => { cleaned.push('second'); throw new Error('cleanup'); });
  });
  assert.deepEqual(cleaned, ['second', 'first']);
});

test('task progress preserves completed upload and directs only upstream repair after a partial configuration write', async () => {
  const ui = new ScriptedConsole([]);
  await withTask(ui, undefined, async task => {
    task.set('upload', 'done', 'accepted'); task.set('upstream', 'partial', 'remote saved');
    task.note('project HTTPS setting retained'); task.note('project HTTPS setting retained');
    await task.finish();
  });
  assert.equal(ui.transcript.split('本次操作结果').length - 1, 1);
  assert.equal(ui.transcript.split('project HTTPS setting retained').length - 1, 1);
  assert.match(ui.transcript, /远端上传：已完成/u);
  assert.match(ui.transcript, /默认同步目标：部分完成/u);
  assert.match(ui.transcript, /仅检查默认同步目标，不必重复上传/u);
});
