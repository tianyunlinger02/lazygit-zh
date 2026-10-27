import test from 'node:test';
import assert from 'node:assert/strict';
import { stopTrackingIgnored } from '../dist/templates.js';
import { fixture, ScriptedConsole } from './support.mjs';

for (const change of ['index', 'rules']) {
  test(`stop tracking ignored files rejects ${change} changed during confirmation`, async t => {
    const f = await fixture(t, { committed: true });
    await f.write('.gitignore', 'hello.txt\n');
    const ui = new ScriptedConsole(['y']);
    const confirm = ui.confirm.bind(ui);
    ui.confirm = async (...args) => {
      const answer = await confirm(...args);
      if (change === 'rules') await f.write('.gitignore', '# no longer ignored\n');
      else await f.git.run(['rm', '--cached', 'hello.txt']);
      return answer;
    };
    await assert.rejects(stopTrackingIgnored(ui, f.path), /变化/u);
    assert.equal(await f.git.value('rev-parse', 'HEAD:hello.txt'), await f.git.value('hash-object', 'hello.txt'));
    if (change === 'rules') assert.equal(await f.git.value('ls-files', 'hello.txt'), 'hello.txt');
  });
}
