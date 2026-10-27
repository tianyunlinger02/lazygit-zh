import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { chooseCloneTarget, verifyCloneTarget } from '../dist/clone-target.js';
import { Git, GitError } from '../dist/git.js';
import { clone, addRemote } from '../dist/workflows.js';
import { Cancelled } from '../dist/ui.js';
import { fixture, ScriptedConsole } from './support.mjs';

test('clone destination selection accepts an existing empty directory without confirmation', async t => {
  const f = await fixture(t), directory = join(f.base, 'empty');
  await mkdir(directory);
  const ui = new ScriptedConsole(['empty'], { quick: true });
  const destination = await chooseCloneTarget(ui, f.base, 'download');
  assert.equal(destination.directory, directory);
  assert.ok(destination.identity);
  await verifyCloneTarget(destination);
  assert.deepEqual(ui.answers, []);
  assert.doesNotMatch(ui.transcript, /\[y\/N\]/u);
  assert.deepEqual(await readdir(directory), []);
});

test('clone destination input can be cancelled after a local retry', async t => {
  const f = await fixture(t);
  const ui = new ScriptedConsole(['../escape', ':q']);
  await assert.rejects(chooseCloneTarget(ui, f.base, 'download'), Cancelled);
  assert.match(ui.transcript, /普通文件夹名称/u);
  assert.deepEqual(ui.answers, []);
});

for (const change of ['appeared', 'replaced', 'new-file']) {
  test(`clone destination rejects ${change} after selection without clearing user files`, async t => {
    const f = await fixture(t), directory = join(f.base, 'download');
    if (change !== 'appeared') await mkdir(directory);
    const destination = await chooseCloneTarget(new ScriptedConsole(['download']), f.base, 'download');
    if (change === 'appeared') await mkdir(directory);
    else if (change === 'replaced') { await rename(directory, `${directory}-original`); await mkdir(directory); }
    else await writeFile(join(directory, 'keep.txt'), 'new user content\n');
    await assert.rejects(verifyCloneTarget(destination), /变化|出现/u);
    assert.equal((await lstat(directory)).isDirectory(), true);
    if (change === 'new-file') assert.deepEqual(await readdir(directory), ['keep.txt']);
  });
}

test('clone reuses an existing empty directory with real local Git and no extra quick confirmation', async t => {
  const f = await fixture(t, { committed: true });
  const target = join(f.base, 'existing-empty'), source = 'https://fixture.example.invalid/team/project.git';
  await mkdir(target);
  const initial = await lstat(target), original = Git.prototype.run;
  let downloads = 0;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'clone') {
      downloads++;
      assert.deepEqual(args, ['clone', '--', source, target]);
      return original.call(this, ['clone', '--', f.path, target], options);
    }
    return original.call(this, args, options);
  });
  const ui = new ScriptedConsole([source, f.base, 'existing-empty'], { quick: true });
  assert.equal(await clone(ui, f.path), target);
  assert.equal(downloads, 1);
  assert.equal((await lstat(target)).ino, initial.ino);
  assert.equal(await new Git(target).value('rev-parse', 'HEAD'), await f.git.value('rev-parse', 'HEAD'));
  assert.deepEqual(ui.answers, []);
  assert.doesNotMatch(ui.transcript, /\[y\/N\]/u);
});

test('failed clone never removes the existing empty directory selected by the user', async t => {
  const f = await fixture(t), directory = join(f.base, 'existing-empty');
  await mkdir(directory);
  const before = await lstat(directory), original = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'clone') throw new GitError('offline fixture clone failure');
    return original.call(this, args, options);
  });
  const ui = new ScriptedConsole(['https://fixture.example.invalid/team/project.git', f.base, 'existing-empty'], { quick: true });
  await assert.rejects(clone(ui, f.path), /offline fixture clone failure/u);
  assert.equal((await lstat(directory)).ino, before.ino);
  assert.deepEqual(await readdir(directory), []);
});

test('quick manual remote association asks only URL and name after selecting the existing workflow', async t => {
  const f = await fixture(t);
  const ui = new ScriptedConsole(['2', 'https://gitlab.example.invalid/team/project.git', 'upstream'], { quick: true });
  assert.equal(await addRemote(ui, f.git), 'upstream');
  assert.deepEqual(await f.git.remoteUrls('upstream'), ['https://gitlab.example.invalid/team/project.git']);
  assert.deepEqual(ui.answers, []);
  assert.doesNotMatch(ui.transcript, /需要现在打开|\[y\/N\]/u);
});
