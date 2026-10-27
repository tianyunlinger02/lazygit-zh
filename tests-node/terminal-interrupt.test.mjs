import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, mkdir, chmod, symlink, readFile } from 'node:fs/promises';
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
test('Ctrl+C during a GitHub create reports unknown result and restores the menu without retry', { skip: process.platform === 'win32' || !which('script'), timeout: 15000 }, async t => {
  const f = await fixture(t), tools = join(f.base, 'fake-gh-bin'); await mkdir(tools);
  const calls = join(f.base, 'gh-calls.jsonl'), gh = join(tools, 'gh');
  await writeFile(join(tools, 'package.json'), '{"type":"commonjs"}\n');
  await writeFile(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (JSON.stringify(args) === JSON.stringify(['api','--hostname','github.com','--method','GET','user','--jq','.login'])) process.stdout.write('fixture-login\\n');
else if (JSON.stringify(args) === JSON.stringify(['repo','create','fixture-login/interrupted','--private'])) {
  fs.writeSync(fs.openSync('/dev/tty', 'w'), 'GH_CREATE_WAIT\\n'); setInterval(() => {}, 1000);
} else throw new Error('Unexpected fixture command');
`, {mode: 0o700});
  const driver = join(f.base, 'github-interrupt-driver.mjs');
  await writeFile(driver, `import{Console,Cancelled,closeInput}from ${JSON.stringify(new URL('../dist/ui.js', import.meta.url).href)};import{GithubClient}from ${JSON.stringify(new URL('../dist/github.js', import.meta.url).href)};const u=new Console();try{await u.ask('GH_START_WAIT');try{await new GithubClient(process.cwd()).createRepository('fixture-login','interrupted','private',()=>console.log('CREATED_CALLBACK'))}catch(e){console.log(e instanceof Cancelled?'GH_CANCEL_OK':'GH_CANCEL_BAD');console.log(e.message)}await u.ask('GH_RETURN_WAIT');console.log('GH_PARENT_OK')}finally{closeInput()}`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const child = spawn('script', ['-q', '-e', '-c', `${quote(process.execPath)} ${quote(driver)}`, '/dev/null'], {cwd: f.base, stdio: ['pipe','pipe','pipe'], env: {...process.env, PATH: `${tools}:${process.env.PATH ?? ''}`}});
  t.after(() => child.kill('SIGKILL'));
  let output = '', started = false, interrupted = false, returned = false;
  child.stdout.on('data', data => {
    output += data;
    if (!started && output.includes('GH_START_WAIT')) { started = true; child.stdin.write('go\n'); }
    if (!interrupted && output.includes('GH_CREATE_WAIT')) { interrupted = true; child.stdin.write('\x03'); }
    if (!returned && output.includes('GH_RETURN_WAIT')) { returned = true; child.stdin.write('back\n'); }
  });
  const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});
  assert.equal(code, 0, output); assert.match(output, /GH_CANCEL_OK/u); assert.match(output, /创建结果未知/u);
  assert.match(output, /https:\/\/github\.com\/fixture-login\/interrupted/u); assert.match(output, /GH_PARENT_OK/u); assert.doesNotMatch(output, /CREATED_CALLBACK/u);
  const commands = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(commands.length, 2); assert.equal(commands.filter(args => args[0] === 'repo').length, 1);
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
