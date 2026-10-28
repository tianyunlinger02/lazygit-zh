import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Console, Cancelled, EndOfInput, SecretTooLong, readSecret } from '../dist/ui.js';
import { which } from '../dist/process.js';
import { fixture } from './support.mjs';

const zeroed = value => value.every(byte => byte === 0);
function terminalFixture({ raw = false, paused = true, setRawError = false } = {}) {
  const input = new PassThrough(), output = [], modes = [];
  input.isTTY = true; input.isRaw = raw;
  input.setRawMode = mode => {
    modes.push(mode);
    if (setRawError && mode) throw Error('fixture-raw-error');
    input.isRaw = mode;
    return input;
  };
  if (paused) input.pause(); else input.resume();
  return { input, output, modes, options: { input, output: { write: message => { output.push(message); return true; } } } };
}
function assertRestored(f, { raw = false, paused = true } = {}) {
  assert.equal(f.input.isRaw, raw);
  assert.equal(f.input.isPaused(), paused);
  for (const name of ['data', 'error', 'end', 'close']) assert.equal(f.input.listenerCount(name), 0);
}

test('Console.requireSecretInput is a non-consuming production TTY preflight and only code-created secret readers bypass it', async () => {
  const stdin = process.stdin, keys = ['isTTY', 'setRawMode', 'readableEncoding', 'readableEnded', 'destroyed'];
  const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(stdin, key)]));
  const patch = values => { for (const [key, value] of Object.entries(values)) Object.defineProperty(stdin, key, { configurable: true, value }); };
  const listeners = Object.fromEntries(['data', 'end', 'close', 'error'].map(name => [name, stdin.listenerCount(name)]));
  let ordinaryReads = 0, secretReads = 0, rawChanges = 0;
  const ui = new Console(() => { ordinaryReads++; throw Error('must not read ordinary input'); }, () => { throw Error('preflight must not write output'); });
  const injected = new Console(undefined, undefined, { secretInput: () => { secretReads++; return Buffer.alloc(0); } });
  try {
    patch({ isTTY: false, setRawMode: undefined, readableEncoding: null, readableEnded: false, destroyed: false });
    assert.throws(() => ui.requireSecretInput(), /交互式终端/u); assert.doesNotThrow(() => injected.requireSecretInput());
    patch({ isTTY: true }); assert.throws(() => ui.requireSecretInput(), /原始输入能力/u);
    patch({ setRawMode: () => { rawChanges++; }, readableEncoding: 'utf8' });
    assert.throws(() => ui.requireSecretInput(), /未解码/u);
    patch({ readableEncoding: null }); assert.doesNotThrow(() => ui.requireSecretInput());
    patch({ readableEnded: true }); assert.throws(() => ui.requireSecretInput(), EndOfInput);
    patch({ readableEnded: false, destroyed: true }); assert.throws(() => ui.requireSecretInput(), EndOfInput);
    assert.equal(rawChanges, 0); assert.equal(ordinaryReads, 0); assert.equal(secretReads, 0);
    for (const [name, count] of Object.entries(listeners)) assert.equal(stdin.listenerCount(name), count);
  } finally {
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(stdin, key, descriptor); else delete stdin[key];
  }
});

test('Console.secret never uses ordinary string input and validates its Buffer substitute', async () => {
  const output = [], tooLong = Buffer.from('fixture-overlong');
  const ui = new Console(() => { throw Error('ordinary read must not be used'); }, text => output.push(text), {
    secretInput: async (prompt, maxBytes) => { assert.equal(prompt, '秘密：'); assert.equal(maxBytes, 1024); return Buffer.from(' fixture-password '); },
  });
  const result = await ui.secret('秘密：');
  assert.equal(result.toString(), ' fixture-password ');
  assert.deepEqual(output, []);
  result.fill(0);
  const overlong = new Console(undefined, undefined, { secretInput: () => tooLong, secretMaxBytes: 4 });
  await assert.rejects(overlong.secret('秘密：'), SecretTooLong);
  assert.ok(zeroed(tooLong));
  await assert.rejects(overlong.secret('秘密：', 0), /长度限制/u);
  const wrongType = new Console(undefined, undefined, { secretInput: () => 'fixture-wrong-type' });
  await assert.rejects(wrongType.secret('秘密：'), /Buffer/u);
  const cancel = new Console(undefined, undefined, { secretInput: () => { throw new Cancelled(); } });
  await assert.rejects(cancel.secret('秘密：'), Cancelled);
});

test('secret input stays in Buffers, accepts literal :q/spaces, erases UTF-8 code points and never echoes', async () => {
  const f = terminalFixture();
  const interruptedListeners = process.listenerCount('SIGINT');
  const promise = readSecret('SECRET_WAIT', f.options);
  assert.equal(f.input.isRaw, true);
  const chunk = Buffer.from('  :q假\x7f密\bZ \r\n');
  f.input.write(chunk);
  const password = await promise;
  assert.equal(password.toString(), '  :qZ ');
  assert.ok(zeroed(chunk));
  assert.equal(f.output.join(''), 'SECRET_WAIT\n');
  assertRestored(f);
  assert.equal(process.listenerCount('SIGINT'), interruptedListeners);
  password.fill(0);
});

test('secret readers reject concurrent ownership and restore a previously idle stream', async () => {
  const f = terminalFixture();
  const first = readSecret('OWNER_WAIT', f.options);
  await assert.rejects(readSecret('SECOND_WAIT', f.options), /并发/u);
  f.input.write(Buffer.from('fixture-owner\n'));
  const value = await first;
  assert.equal(value.toString(), 'fixture-owner');
  assertRestored(f);
  value.fill(0);
});

test('secret backspace clears deleted bytes and never underflows at the start', async () => {
  const f = terminalFixture({ raw: true, paused: false });
  const promise = readSecret('BACKSPACE_WAIT', f.options);
  const first = Buffer.from('\b\x7fabc\b'), second = Buffer.from('Z\n');
  f.input.write(first); f.input.write(second);
  const password = await promise;
  assert.equal(password.toString(), 'abZ');
  assert.ok(zeroed(first)); assert.ok(zeroed(second));
  assertRestored(f, { raw: true, paused: false });
  password.fill(0);
});

test('Ctrl+C, Ctrl+D and stream EOF cancel partial secrets and restore terminal state', async t => {
  for (const [name, end, ErrorType] of [
    ['Ctrl+C', input => input.write(Buffer.from('\x03')), Cancelled],
    ['Ctrl+D', input => input.write(Buffer.from('\x04')), EndOfInput],
    ['stream EOF', input => input.end(), EndOfInput],
    ['closed stream', input => input.emit('close'), EndOfInput],
  ]) {
    await t.test(name, async () => {
      const f = terminalFixture();
      const before = process.listenerCount('SIGINT');
      const promise = readSecret('CANCEL_WAIT', f.options);
      const partial = Buffer.from('fixture-partial-password');
      f.input.write(partial); end(f.input);
      await assert.rejects(promise, ErrorType);
      assert.ok(zeroed(partial));
      assert.equal(f.output.join(''), 'CANCEL_WAIT\n');
      assertRestored(f);
      assert.equal(process.listenerCount('SIGINT'), before);
    });
  }
});

test('secret input limit is in bytes; exact limit succeeds and overflow is cleared and rejected', async () => {
  const f = terminalFixture();
  const exact = readSecret('LIMIT_WAIT', { ...f.options, maxBytes: 4 });
  f.input.write(Buffer.from('abcd\n'));
  const password = await exact;
  assert.equal(password.toString(), 'abcd'); password.fill(0);
  const overlong = readSecret('OVERFLOW_WAIT', { ...f.options, maxBytes: 4 });
  const chunk = Buffer.from('假密码\n');
  f.input.write(chunk);
  await assert.rejects(overlong, SecretTooLong);
  assert.ok(zeroed(chunk)); assertRestored(f);
});

test('secret input errors never disclose stream messages and restore raw mode and listeners', async () => {
  const f = terminalFixture();
  const promise = readSecret('ERROR_WAIT', f.options);
  f.input.emit('error', Error('fixture-password diagnostic'));
  await assert.rejects(promise, error => { assert.doesNotMatch(error.message, /fixture-password/u); return true; });
  assertRestored(f);
  const broken = terminalFixture({ setRawError: true });
  await assert.rejects(readSecret('RAW_WAIT', broken.options), /安全终端/u);
  assertRestored(broken);
  const notTTY = terminalFixture(); notTTY.input.isTTY = false;
  await assert.rejects(readSecret('PIPE_WAIT', notTTY.options), /交互式终端/u);
  assert.deepEqual(notTTY.output, []);
  const decoded = terminalFixture(); decoded.input.setEncoding('utf8');
  await assert.rejects(readSecret('DECODED_WAIT', decoded.options), /未解码/u);
});

test('real PTY secret input does not echo and restores ordinary prompts after success and cancellation', { skip: process.platform === 'win32' || !which('script'), timeout: 15000 }, async t => {
  const f = await fixture(t), driver = join(f.base, 'secret-driver.mjs');
  await writeFile(driver, `import{Console,Cancelled,EndOfInput,closeInput}from ${JSON.stringify(new URL('../dist/ui.js', import.meta.url).href)};const u=new Console();try{await u.ask('START_WAIT');const p=await u.secret('SUCCESS_WAIT');console.log(p.equals(Buffer.from('fixture-edited'))?'PASSWORD_OK':'PASSWORD_BAD');p.fill(0);try{await u.secret('CANCEL_WAIT')}catch(e){console.log(e instanceof Cancelled?'CANCEL_OK':'CANCEL_BAD')}try{await u.secret('EOF_WAIT')}catch(e){console.log(e instanceof EndOfInput?'EOF_OK':'EOF_BAD')}await u.ask('RETURN_WAIT');console.log('MENU_OK')}finally{closeInput()}`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const child = spawn('script', ['-q', '-e', '-c', `${quote(process.execPath)} ${quote(driver)}`, '/dev/null'], { cwd: f.base, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  const steps = [
    ['START_WAIT', 'go\n'],
    ['SUCCESS_WAIT', 'fixture-editedX\x7f\r'],
    ['CANCEL_WAIT', 'fixture-cancelled\x03'],
    ['EOF_WAIT', 'fixture-eof\x04'],
    ['RETURN_WAIT', 'back\n'],
  ];
  let output = '', index = 0;
  child.stdout.on('data', data => {
    output += data;
    if (index < steps.length && output.includes(steps[index][0])) child.stdin.write(steps[index++][1]);
  });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, output);
  for (const marker of ['PASSWORD_OK', 'CANCEL_OK', 'EOF_OK', 'MENU_OK']) assert.ok(output.includes(marker), output);
  assert.doesNotMatch(output, /fixture-edited|fixture-cancelled|fixture-eof/u);
});
