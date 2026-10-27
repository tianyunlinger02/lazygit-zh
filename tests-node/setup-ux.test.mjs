import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './support.mjs';

async function externalSshFixture(t, { quick, status, answer, selected = true }) {
  const f = await fixture(t); const tools = join(f.base, 'fake ssh tools'); await fs.mkdir(tools);
  const log = join(f.base, 'external-ssh.json'); const resultFile = join(f.base, 'setup-ui.json');
  const fakeSsh = join(tools, 'ssh');
  await fs.writeFile(fakeSsh, `#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(process.env.AUTOGIT_TEST_SSH_LOG, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),input:fs.readFileSync(0,'utf8')}));
process.stdout.write('NATIVE SSH STDOUT FIXTURE\\n');
process.stderr.write('NATIVE SSH STDERR FIXTURE\\n');
process.exit(Number(process.env.AUTOGIT_TEST_SSH_STATUS));
`, { mode: 0o700 });
  const answers = selected ? ['3', '5', ...(status === 1 ? [answer] : []), '0', '0'] : ['3', '0', '0'];
  const setupUrl = new URL('../dist/setup.js', import.meta.url).href; const uiUrl = new URL('../dist/ui.js', import.meta.url).href;
  const script = `
import fs from 'node:fs';
import {setupWizard} from ${JSON.stringify(setupUrl)};
import {Console} from ${JSON.stringify(uiUrl)};
const answers=JSON.parse(process.env.AUTOGIT_TEST_UI_ANSWERS), messages=[], prompts=[];
const ui=new Console(prompt=>{
  prompts.push({prompt,sshAlreadyRan:fs.existsSync(process.env.AUTOGIT_TEST_SSH_LOG)});
  if(!answers.length) throw new Error('Unexpected prompt: '+prompt);
  return answers.shift();
},message=>messages.push(message),{quick:${quick}});
await setupWizard(ui,process.cwd());
fs.writeFileSync(process.env.AUTOGIT_TEST_UI_RESULT,JSON.stringify({messages,prompts,remaining:answers}));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: f.path,
    env: { ...process.env, PATH: `${tools}${delimiter}${process.env.PATH ?? ''}`, AUTOGIT_TEST_SSH_LOG: log, AUTOGIT_TEST_SSH_STATUS: String(status), AUTOGIT_TEST_UI_ANSWERS: JSON.stringify(answers), AUTOGIT_TEST_UI_RESULT: resultFile },
    input: 'native terminal input fixture\n', encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const ui = JSON.parse(await fs.readFile(resultFile, 'utf8')); assert.deepEqual(ui.remaining, []);
  return { ...f, result, ui, log };
}

for (const quick of [true, false]) {
  for (const [status, answer, verified] of [[1, 'y', true], [1, 'n', false], [0, undefined, false], [255, undefined, false]]) {
    test(`external SSH selection executes directly in ${quick ? 'quick' : 'detailed'} mode; status ${status}, manual ${answer ?? 'not asked'}`, { skip: process.platform === 'win32' }, async t => {
      const f = await externalSshFixture(t, { quick, status, answer });
      const call = JSON.parse(await fs.readFile(f.log, 'utf8'));
      assert.deepEqual(call.args, ['-T', '-o', 'StrictHostKeyChecking=ask', 'git@github.com']); assert.equal(call.cwd, f.path);
      assert.equal(call.input, 'native terminal input fixture\n');
      assert.match(f.result.stdout, /NATIVE SSH STDOUT FIXTURE/u); assert.match(f.result.stderr, /NATIVE SSH STDERR FIXTURE/u);
      const confirmations = f.ui.prompts.filter(({ prompt }) => /\[(?:Y\/n|y\/N)\]：$/u.test(prompt));
      assert.equal(confirmations.length, status === 1 ? 1 : 0);
      for (const { prompt, sshAlreadyRan } of confirmations) { assert.match(prompt, /本次终端确实显示 Hi USER!/u); assert.equal(sshAlreadyRan, true); }
      assert.equal(f.ui.prompts.filter(({ prompt }) => prompt === '请选择编号：').length, 4);
      const transcript = [...f.ui.messages, ...f.ui.prompts.map(({ prompt }) => prompt)].join('\n');
      assert.doesNotMatch(transcript, /明确使用外部系统 SSH 联网测试/u);
      assert.match(transcript, /可能更新系统 known_hosts/u); assert.match(transcript, /首次连接请独立核对主机指纹/u);
      assert.match(transcript, new RegExp(`SSH 退出码 ${status} 不足以判定认证成功`, 'u'));
      assert.equal(transcript.includes('根据你的确认，本次系统 SSH 认证成功'), verified);
      if (!verified) assert.match(transcript, /未确认成功，请检查终端原始提示/u);
    });
  }
}

test('returning from external SSH menu does not execute a system SSH process', { skip: process.platform === 'win32' }, async t => {
  const f = await externalSshFixture(t, { quick: true, status: 1, selected: false });
  await assert.rejects(fs.stat(f.log), { code: 'ENOENT' });
  assert.equal(f.ui.prompts.length, 3); assert.doesNotMatch(f.result.stdout, /NATIVE SSH STDOUT FIXTURE/u);
});
