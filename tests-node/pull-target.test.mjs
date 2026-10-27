import test from 'node:test';
import assert from 'node:assert/strict';
import { Git } from '../dist/git.js';
import { clone, pull } from '../dist/workflows.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostStore, DEFAULT_HOST } from '../dist/hosts.js';
import { fixture, ScriptedConsole } from './support.mjs';

for (const change of ['rewrite', 'transport', 'appeared-target']) {
  test(`clone rejects ${change} changed during confirmation without starting a download`, async t => {
    const f = await fixture(t);
    const source = 'https://source.example.invalid/team/repo.git';
    const ui = new ScriptedConsole([source, f.path, 'download', 'y']);
    const confirm = ui.routineConfirm.bind(ui);
    const run = Git.prototype.run;
    let downloads = 0;
    t.mock.method(Git.prototype, 'run', async function(args, options) {
      if (args[0] === 'clone') downloads++;
      return run.call(this, args, options);
    });
    ui.routineConfirm = async (...args) => {
      const result = await confirm(...args);
      if (change === 'rewrite') await f.git.run(['config', 'url.https://changed.example.invalid/.insteadOf', 'https://source.example.invalid/']);
      else if (change === 'transport') await new HostStore().set(f.path, { mode: 'https', host: DEFAULT_HOST });
      else await mkdir(join(f.path, 'download'));
      return result;
    };
    await assert.rejects(clone(ui, f.path), /变化|出现/u);
    assert.equal(downloads, 0);
    assert.deepEqual(ui.answers, []);
  });
}

for (const change of ['url', 'upstream', 'head', 'worktree', 'transport']) {
  test(`pull rejects ${change} changed during confirmation before contacting the remote`, async t => {
    const f = await fixture(t, { committed: true });
    await f.remote();
    await f.git.run(['config', 'branch.main.remote', 'origin']);
    await f.git.run(['config', 'branch.main.merge', 'refs/heads/main']);
    const before = await f.git.value('rev-parse', 'HEAD');
    const run = Git.prototype.run;
    let pulls = 0;
    t.mock.method(Git.prototype, 'run', async function(args, options) {
      if (args[0] === 'pull') pulls++;
      return run.call(this, args, options);
    });
    const ui = new ScriptedConsole(['y']);
    const confirm = ui.routineConfirm.bind(ui);
    ui.routineConfirm = async (...args) => {
      const result = await confirm(...args);
      if (change === 'url') await f.git.run(['remote', 'set-url', 'origin', 'https://changed.example.invalid/team/repo.git']);
      else if (change === 'upstream') await f.git.run(['config', 'branch.main.merge', 'refs/heads/other']);
      else if (change === 'head') await f.git.run(['commit', '--allow-empty', '-m', 'concurrent commit']);
      else if (change === 'worktree') await f.write('hello.txt', 'changed during confirmation\n');
      else await new HostStore().set(f.path, { mode: 'https', host: DEFAULT_HOST });
      return result;
    };
    await assert.rejects(pull(ui, f.path), /变化/u);
    assert.equal(pulls, 0);
    if (change !== 'head') assert.equal(await f.git.value('rev-parse', 'HEAD'), before);
  });
}
