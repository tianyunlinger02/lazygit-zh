import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess, which } from '../dist/process.js';
import { Console, Cancelled } from '../dist/ui.js';
import { ScriptedConsole, fixture } from './support.mjs';

test('ask, menu and selection validate input, defaults and cancellation', async () => {
  const ui = new ScriptedConsole(['', '0', 'x', '2', '0,2', '3，1 1', ':q']);
  assert.equal(await ui.ask('field', 'default'), 'default');
  assert.equal(await ui.menu('menu', ['a']), 0);
  assert.equal(await ui.menu('menu', ['a', 'b']), 2);
  assert.deepEqual(await ui.select(['a', 'b', 'c']), [0, 2]);
  await assert.rejects(ui.ask('cancel'), Cancelled);
});
test('multiline preserves exact whitespace, empty lines and embedded punctuation until a standalone dot', async () => {
  const ui = new ScriptedConsole(['  subject  ', '', '  indented body  ', ' . ', ':q is literal text', '.', 'next']);
  assert.equal(await ui.multiline('message'), '  subject  \n\n  indented body  \n . \n:q is literal text');
  assert.equal(await ui.ask('next'), 'next');
  assert.deepEqual(ui.answers, []);
});

test('multiline defaults apply only to no entered lines and cancellation never returns partial text', async () => {
  const ui = new ScriptedConsole(['.', '', '.', 'unfinished', ':q']);
  assert.equal(await ui.multiline('default', 'previous\nmessage'), 'previous\nmessage');
  assert.equal(await ui.multiline('blank', 'previous'), '');
  await assert.rejects(ui.multiline('cancel'), Cancelled);
  assert.deepEqual(ui.answers, []);
});

test('quick routine prompts skip input but destructive confirm never skips', async () => {
  const ui = new ScriptedConsole(['n'], { quick: true }); assert.equal(await ui.routineConfirm('push'), true); assert.equal(await ui.confirm('delete'), false); assert.equal(ui.answers.length, 0);
});
test('detailed confirmations await asynchronous answers instead of truthy Promise', async () => {
  const ui = new Console(async () => { await new Promise(resolve => setImmediate(resolve)); return 'n'; }, () => {}, { quick: false });
  assert.equal(await ui.routineConfirm('write'), false);
});
test('confirm retries invalid input and accepts Chinese/default', async () => {
  const ui = new ScriptedConsole(['wrong', '是', '', '否']); assert.equal(await ui.confirm('a'), true); assert.equal(await ui.confirm('b', true), true); assert.equal(await ui.confirm('c', true), false);
});
test('native process captures both streams as unbounded Buffers and keeps stdin data exact', async t => {
  const f = await fixture(t); const data = Buffer.from([0, 255, 10, 128]);
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.on("data",x=>process.stdout.write(x));process.stdin.on("end",()=>process.stderr.write(Buffer.alloc(200000,65)))'], { cwd: f.base, inputData: data });
  assert.equal(result.status, 0); assert.deepEqual(result.stdout, data); assert.equal(result.stderr.length, 200000);
});
test('native failures, signals, executable resolution and optional check are explicit', async t => {
  const f = await fixture(t);
  const result = await runProcess(process.execPath, ['-e', 'process.stderr.write("failed");process.exit(7)'], { cwd: f.base, inputData: Buffer.alloc(0) });
  assert.equal(result.status, 7); assert.equal(result.stderr.toString(), 'failed');
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(7)'], { cwd: f.base, check: true, inputData: Buffer.alloc(0) }), /7/);
  await assert.rejects(runProcess('autogit-nonexistent-program-123', [], { cwd: f.base, inputData: Buffer.alloc(0) }), /ENOENT/);
  assert.ok(which('git')); assert.equal(which('autogit-nonexistent-program-123'), undefined);
  if (process.platform !== 'win32') { const killed = await runProcess(process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM")'], { cwd: f.base, inputData: Buffer.alloc(0) }); assert.equal(killed.signal, 'SIGTERM'); assert.notEqual(killed.status, 0); }
});
test('child env/cwd is copied and arguments never interpreted by shell', async t => {
  const f = await fixture(t); const input = 'hello;$(touch forbidden) & %PATH%';
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.argv[1],process.cwd(),process.env.CHILD_ONLY]))', input], { cwd: f.base, env: { ...process.env, CHILD_ONLY: 'yes' }, inputData: Buffer.alloc(0) });
  assert.deepEqual(JSON.parse(result.stdout), [input, f.base, 'yes']); assert.equal(process.env.CHILD_ONLY, undefined);
});

test('piped menu lines remain queued and EOF exits without hanging', async t => {
  const f = await fixture(t); const module = new URL('../dist/ui.js', import.meta.url).href;
  const script = `import {Console,closeInput,EndOfInput} from ${JSON.stringify(module)};const u=new Console();try{console.log('VALUES',await u.ask('one'),await u.ask('two'),await u.menu('three',['a','b']));try{await u.ask('eof')}catch(e){console.log(e instanceof EndOfInput?'EOF_OK':'BAD')}}finally{closeInput()}`;
  const result = await runProcess(process.execPath, ['--input-type=module', '-e', script], { cwd: f.base, inputData: Buffer.from('first\nsecond\n2\n') });
  assert.equal(result.status, 0); assert.match(result.stdout.toString(), /VALUES first second 2/); assert.match(result.stdout.toString(), /EOF_OK/);
});

test('piped multiline consumes only its body and terminator and EOF rejects an incomplete body', async t => {
  const f = await fixture(t); const module = new URL('../dist/ui.js', import.meta.url).href;
  const script = `import{Console,closeInput,EndOfInput}from ${JSON.stringify(module)};const u=new Console();try{console.log('BODY',JSON.stringify(await u.multiline('BODY_WAIT')));console.log('NEXT',await u.ask('NEXT_WAIT'));try{await u.multiline('INCOMPLETE')}catch(e){console.log(e instanceof EndOfInput?'MULTILINE_EOF_OK':'BAD')}}finally{closeInput()}`;
  const result = await runProcess(process.execPath, ['--input-type=module', '-e', script], { cwd: f.base, inputData: Buffer.from('  first  \n\nbody\n.\nnext\npartial\n') });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.ok(result.stdout.toString().includes('BODY "  first  \\n\\nbody"'));
  assert.match(result.stdout.toString(), /NEXT next/u);
  assert.match(result.stdout.toString(), /MULTILINE_EOF_OK/u);
});

test('real terminal ownership returns from native input to the Chinese menu', { skip: process.platform === 'win32' || !which('script'), timeout: 15000 }, async t => {
  const f = await fixture(t); const uiModule = new URL('../dist/ui.js', import.meta.url).href; const processModule = new URL('../dist/process.js', import.meta.url).href;
  const driver = join(f.base, 'terminal-driver.mjs');
  const native = join(f.base, 'native-input.cjs');
  await writeFile(native, 'process.stdout.write("NATIVE_WAIT\\n");process.stdin.once("data",b=>{process.stdout.write(b.toString().trim()==="fixture-not-a-secret"?"NATIVE_OK\\n":"NATIVE_BAD\\n");process.exit(0)})');
  await writeFile(driver, `import {Console,closeInput} from ${JSON.stringify(uiModule)};import{runProcess}from ${JSON.stringify(processModule)};const u=new Console();try{await u.ask('START_WAIT');await Promise.all([runProcess(process.execPath,['-e','setTimeout(()=>{},50)'],{cwd:process.cwd()}),runProcess(process.execPath,['-e','setTimeout(()=>{},20)'],{cwd:process.cwd()})]);if(!process.stdin.isRaw)throw Error('RAW_NOT_RESTORED');console.log('RAW_OK');const r=await runProcess(process.execPath,[${JSON.stringify(native)}],{cwd:process.cwd(),interactive:true,captureStdout:false});await u.ask('END_WAIT');console.log('TERMINAL_OK '+r.status)}finally{closeInput()}`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const child = spawn('script', ['-q', '-e', '-c', `${quote(process.execPath)} ${quote(driver)}`, '/dev/null'], { cwd: f.base, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let output = '', sentStart = false, sentNative = false, sentEnd = false;
  child.stdout.on('data', data => {
    output += data;
    if (!sentStart && output.includes('START_WAIT')) { sentStart = true; child.stdin.write('go\n'); }
    if (!sentNative && output.includes('NATIVE_WAIT')) { sentNative = true; child.stdin.write('fixture-not-a-secret\n'); }
    if (!sentEnd && output.includes('END_WAIT')) { sentEnd = true; child.stdin.write('done\n'); }
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output); assert.match(output, /RAW_OK/); assert.match(output, /NATIVE_OK/); assert.match(output, /TERMINAL_OK 0/);
});
