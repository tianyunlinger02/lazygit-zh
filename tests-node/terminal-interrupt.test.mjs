import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, ScriptedConsole } from './support.mjs';
import { which, runProcess } from '../dist/process.js';
import { setupWizard } from '../dist/setup.js';
import { Git } from '../dist/git.js';

test('Ctrl+C in a native foreground child preserves the parent and restores menu input', { skip: process.platform === 'win32' || !which('script'), timeout: 15000 }, async t => {
  const f = await fixture(t); const driver = join(f.base, 'interrupt-driver.mjs'); const native = join(f.base, 'interrupt-native.cjs');
  await writeFile(native, 'process.stdout.write("INTERRUPT_WAIT\\n");setInterval(()=>{},1000)');
  await writeFile(driver, `import{Console,Cancelled,closeInput}from ${JSON.stringify(new URL('../dist/ui.js', import.meta.url).href)};import{runProcess}from ${JSON.stringify(new URL('../dist/process.js', import.meta.url).href)};const u=new Console();try{await u.ask('START_WAIT');try{await runProcess(process.execPath,[${JSON.stringify(native)}],{cwd:process.cwd(),interactive:true})}catch(e){console.log(e instanceof Cancelled?'CANCEL_OK':'CANCEL_BAD')}await u.ask('RETURN_WAIT');console.log('PARENT_OK')}finally{closeInput()}`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const child = spawn('script', ['-q', '-e', '-c', `${quote(process.execPath)} ${quote(driver)}`, '/dev/null'], { cwd: f.base, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  t.after(() => child.kill('SIGKILL'));
  let output = '', started = false, interrupted = false, returned = false;
  child.stdout.on('data', data => {
    output += data;
    if (!started && output.includes('START_WAIT')) { started = true; child.stdin.write('go\n'); }
    if (!interrupted && output.includes('INTERRUPT_WAIT')) { interrupted = true; child.stdin.write('\x03'); }
    if (!returned && output.includes('RETURN_WAIT')) { returned = true; child.stdin.write('back\n'); }
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output); assert.match(output, /CANCEL_OK/); assert.match(output, /PARENT_OK/);
});
test('Ctrl+C during a native GitHub create (code-only API stub) reports unknown result and restores the menu without retry', { skip: process.platform === 'win32' || !which('script'), timeout: 15000 }, async t => {
  const f = await fixture(t);
  const calls = join(f.base, 'native-api-stub-calls.jsonl');
  const effect = join(f.base, 'native-api-stub-request-started.json');
  const driver = join(f.base, 'native-personal-interrupt-driver.mjs');
  // Only the terminal interrupt/recovery contract is real here. The prototype stub
  // records a request-side-effect marker and throws the native unknown-result warning;
  // production HTTP interruption is covered by the native client's separate tests.
  await writeFile(driver, `
import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { Console, Cancelled, closeInput, suspendInput, resumeInput } from ${JSON.stringify(new URL('../dist/ui.js', import.meta.url).href)};
import { GithubClient } from ${JSON.stringify(new URL('../dist/github.js', import.meta.url).href)};
import { PersonalGithubClient } from ${JSON.stringify(new URL('../dist/github-personal.js', import.meta.url).href)};
const record = async call => appendFile(${JSON.stringify(calls)}, JSON.stringify(call) + '\\n');
for (const method of Object.getOwnPropertyNames(GithubClient.prototype)) {
  if (method === 'constructor' || typeof GithubClient.prototype[method] !== 'function') continue;
  GithubClient.prototype[method] = () => { throw new Error('Forbidden legacy GithubClient.' + method); };
}
globalThis.fetch = async () => { throw new Error('No HTTP is allowed in this code-only native API stub'); };
PersonalGithubClient.prototype.createRepository = async function (owner, name, visibility) {
  assert.equal(owner, 'fixture-login'); assert.equal(name, 'interrupted'); assert.equal(visibility, 'private');
  await record({ method: 'createRepository', owner, name, visibility });
  await writeFile(${JSON.stringify(effect)}, JSON.stringify({ codeOnlyStub: true, method: 'POST', path: '/user/repos', name }));
  suspendInput();
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await new Promise((resolve, reject) => {
      process.once('SIGINT', () => reject(new Cancelled('创建结果未知，仓库可能已创建；请先核对 https://github.com/fixture-login/interrupted，不要自动重试。')));
      console.log('NATIVE_CREATE_WAIT');
    });
  } finally { clearInterval(keepAlive); resumeInput(); }
};
const ui = new Console();
try {
  await ui.ask('NATIVE_START_WAIT');
  try { await new PersonalGithubClient('fixture-login').createRepository('fixture-login', 'interrupted', 'private', () => console.log('CREATED_CALLBACK')); }
  catch (error) { console.log(error instanceof Cancelled ? 'NATIVE_CANCEL_OK' : 'NATIVE_CANCEL_BAD'); console.log(error.message); }
  await ui.ask('NATIVE_RETURN_WAIT'); console.log('NATIVE_PARENT_OK');
} finally { closeInput(); }
`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const child = spawn('script', ['-q', '-e', '-c', `${quote(process.execPath)} ${quote(driver)}`, '/dev/null'], { cwd: f.base, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  t.after(() => child.kill('SIGKILL'));
  let output = '', started = false, interrupted = false, returned = false;
  child.stdout.on('data', data => {
    output += data;
    if (!started && output.includes('NATIVE_START_WAIT')) { started = true; child.stdin.write('go\n'); }
    if (!interrupted && output.includes('NATIVE_CREATE_WAIT')) { interrupted = true; child.stdin.write('\x03'); }
    if (!returned && output.includes('NATIVE_RETURN_WAIT')) { returned = true; child.stdin.write('back\n'); }
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output); assert.match(output, /NATIVE_CANCEL_OK/u); assert.match(output, /创建结果未知/u);
  assert.match(output, /https:\/\/github\.com\/fixture-login\/interrupted/u); assert.match(output, /NATIVE_PARENT_OK/u);
  assert.doesNotMatch(output, /CREATED_CALLBACK|NATIVE_CANCEL_BAD|Forbidden legacy GithubClient/u);
  const requests = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(requests, [{ method: 'createRepository', owner: 'fixture-login', name: 'interrupted', visibility: 'private' }]);
  assert.deepEqual(JSON.parse(await readFile(effect, 'utf8')), { codeOnlyStub: true, method: 'POST', path: '/user/repos', name: 'interrupted' });
});

test('Ctrl+C during an upload workflow emits one unknown-result summary and restores input without replaying the local Git adapter', { skip: process.platform === 'win32' || !which('script'), timeout: 15000 }, async t => {
  const f = await fixture(t, { committed: true }); const target = await f.remote();
  const head = await f.git.value('rev-parse', 'HEAD');
  const driver = join(f.base, 'upload-progress-interrupt-driver.mjs');
  const calls = join(f.base, 'upload-progress-interrupt-calls.jsonl');
  // Real PTY, Console, cancellation boundary, workflow and summary; only push is a code stub.
  // The marker means attempted transport, not an HTTP request or accepted remote update.
  await writeFile(driver, `
import { appendFile } from 'node:fs/promises';
import { Console, Cancelled, closeInput, suspendInput, resumeInput } from ${JSON.stringify(new URL('../dist/ui.js', import.meta.url).href)};
import { Git } from ${JSON.stringify(new URL('../dist/git.js', import.meta.url).href)};
import { push } from ${JSON.stringify(new URL('../dist/workflows.js', import.meta.url).href)};
const original = Git.prototype.run;
Git.prototype.run = async function (args, options) {
  if (args[0] !== 'push') return original.call(this, args, options);
  await appendFile(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
  suspendInput(); const keepAlive = setInterval(() => {}, 1000);
  try {
    await new Promise((resolve, reject) => {
      process.once('SIGINT', () => reject(new Cancelled()));
      console.log('UPLOAD_PROGRESS_WAIT');
    });
  } finally { clearInterval(keepAlive); resumeInput(); }
};
const ui = new Console(undefined, undefined, { quick: true });
try {
  await ui.ask('UPLOAD_PROGRESS_START');
  try { await push(ui, new Git(${JSON.stringify(f.path)})); }
  catch (error) { console.log(error instanceof Cancelled ? 'UPLOAD_PROGRESS_CANCEL_OK' : 'UPLOAD_PROGRESS_CANCEL_BAD'); }
  await ui.ask('UPLOAD_PROGRESS_RETURN'); console.log('UPLOAD_PROGRESS_PARENT_OK');
} finally { closeInput(); }
`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const child = spawn('script', ['-q', '-e', '-c', `${quote(process.execPath)} ${quote(driver)}`, '/dev/null'], { cwd: f.base, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '', started = false, interrupted = false, returned = false;
  child.stdout.on('data', data => {
    output += data;
    if (!started && output.includes('UPLOAD_PROGRESS_START')) { started = true; child.stdin.write('go\n1\n\n'); }
    if (!interrupted && output.includes('UPLOAD_PROGRESS_WAIT')) { interrupted = true; child.stdin.write('\x03'); }
    if (!returned && output.includes('UPLOAD_PROGRESS_RETURN')) { returned = true; child.stdin.write('back\n'); }
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output); assert.match(output, /UPLOAD_PROGRESS_CANCEL_OK/u); assert.match(output, /UPLOAD_PROGRESS_PARENT_OK/u);
  assert.doesNotMatch(output, /UPLOAD_PROGRESS_CANCEL_BAD/u);
  assert.equal(output.split('本次操作结果').length - 1, 1);
  assert.match(output, /远端上传：结果待核对/u); assert.match(output, /不自动.*上传|不会自动重试/u);
  const attempts = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(attempts, [['push', '--no-follow-tags', '--', 'origin', `${head}:refs/heads/main`]]);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), head); assert.equal(await new Git(target).hasCommits(), false);
  assert.equal(await f.git.config('branch.main.remote'), '');
});

test('Ctrl+C cancels a partial multiline body and restores the next menu input', { skip: process.platform === 'win32' || !which('script'), timeout: 15000 }, async t => {
  const f = await fixture(t);
  const driver = join(f.base, 'multiline-interrupt-driver.mjs');
  await writeFile(driver, `import{Console,Cancelled,closeInput}from ${JSON.stringify(new URL('../dist/ui.js', import.meta.url).href)};const u=new Console();try{await u.ask('MULTI_START_WAIT');try{await u.multiline('MULTI_BODY_WAIT');console.log('MULTI_BAD')}catch(e){console.log(e instanceof Cancelled?'MULTI_CANCEL_OK':'MULTI_CANCEL_BAD')}await u.ask('MULTI_RETURN_WAIT');console.log('MULTI_PARENT_OK')}finally{closeInput()}`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const child = spawn('script', ['-q', '-e', '-c', `${quote(process.execPath)} ${quote(driver)}`, '/dev/null'], { cwd: f.base, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '', started = false, body = false, interrupted = false, returned = false;
  child.stdout.on('data', data => {
    output += data;
    if (!started && output.includes('MULTI_START_WAIT')) { started = true; child.stdin.write('go\n'); }
    if (!body && output.includes('MULTI_BODY_WAIT') && output.includes('> ')) { body = true; child.stdin.write('partial body\n'); }
    if (!interrupted && body && (output.match(/> /gu) ?? []).length >= 2) { interrupted = true; child.stdin.write('\x03'); }
    if (!returned && output.includes('MULTI_RETURN_WAIT')) { returned = true; child.stdin.write('back\n'); }
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output);
  assert.match(output, /MULTI_CANCEL_OK/u);
  assert.match(output, /MULTI_PARENT_OK/u);
  assert.doesNotMatch(output, /MULTI_BAD|MULTI_CANCEL_BAD/u);
});

test('relative PATH lookup uses child cwd and never parent cwd', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const bin = join(f.base, 'bin'); await mkdir(bin); const command = join(bin, 'fixture-relative-tool');
  await writeFile(command, '#!/bin/sh\nprintf child-cwd-tool\n'); await chmod(command, 0o700);
  const env = { ...process.env, PATH: './bin' };
  assert.equal(which('fixture-relative-tool', env, f.base), command);
  const result = await runProcess('fixture-relative-tool', [], { cwd: f.base, env, inputData: Buffer.alloc(0) }); assert.equal(result.status, 0); assert.equal(result.stdout.toString(), 'child-cwd-tool');
});
test('Git project root preserves trailing carriage return rather than aliasing another folder', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const path = join(f.base, 'trailing\r'); await mkdir(path); const git = new Git(path); await git.run(['init', '--initial-branch=main']); assert.equal(await git.root(), path);
});
test('advanced .pub input expands home directory without opening private keys', async t => {
  const f = await fixture(t); await mkdir(join(f.home, '.ssh')); await writeFile(join(f.home, '.ssh', 'fixture.pub'), 'ssh-ed25519 AAAAFIXTURE\n');
  const ui = new ScriptedConsole(['3', '3', '~/.ssh/fixture.pub', '0', '0']); await setupWizard(ui, f.path); assert.match(ui.transcript, /ssh-ed25519 AAAAFIXTURE/); assert.doesNotMatch(ui.transcript, /找不到公钥/);
});
