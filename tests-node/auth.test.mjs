import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as nativeTransport from '../dist/auth.js';
import { AuthenticationDeniedError, NativeAuthError, nativeRequest, resolveNativeHelper } from '../dist/auth.js';
import { fixture } from './support.mjs';

const executableOptions = { skip: process.platform === 'win32' };
const hasCode = code => error => error instanceof NativeAuthError && error.code === code;

async function helperFixture(t, body) {
  const f = await fixture(t);
  const helper = join(f.base, 'fake-native.cjs'), calls = join(f.base, 'calls.jsonl');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const command = process.argv[2];
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const respond = value => process.stdout.write(JSON.stringify(value));
const success = () => respond({ok:true,protocol:1,value:'fixture-result'});
${body}
`;
  await writeFile(helper, script, { mode: 0o700 });
  await chmod(helper, 0o700);
  return { ...f, helper, calls, script, options: { helperPath: helper, checkIntegrity: false } };
}

test('native transport no longer exposes OS-login APIs', () => {
  assert.equal('NativeAuthenticator' in nativeTransport, false);
  assert.equal('authenticateSession' in nativeTransport, false);
  assert.equal(typeof nativeRequest, 'function');
  assert.equal(typeof resolveNativeHelper, 'function');
});

test('nativeRequest uses command-only argv and protocol-tagged JSON stdin ending at EOF', executableOptions, async t => {
  const payload = { privateKey: Buffer.from('fixture-private-key-only').toString('base64'), passphrase: Buffer.from('fixture-key-passphrase-only').toString('base64') };
  const f = await helperFixture(t, `
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const expected = ${JSON.stringify(payload)};
  if (command !== 'import-key' || request.protocol !== 1 || request.privateKey !== expected.privateKey || request.passphrase !== expected.passphrase) throw Error('invalid fixture request');
  for (const secret of Object.values(expected)) {
    if (process.argv.some(value => value.includes(secret)) || Object.values(process.env).some(value => value.includes(secret))) throw Error('fixture secret outside stdin');
  }
  success();
});
`);
  const result = await nativeRequest('import-key', payload, f.options);
  assert.equal(result.value, 'fixture-result');
  assert.deepEqual((await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse), [['import-key']]);
});

test('nativeRequest forwards both read-only and default secure-path modes', executableOptions, async t => {
  for (const verifyOnly of [undefined, false, true]) {
    await t.test(String(verifyOnly), async t => {
      const payload = { path: 'fixture-public-path', directory: true, ...(verifyOnly === undefined ? {} : { verifyOnly }) };
      const f = await helperFixture(t, `const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>{const r=JSON.parse(Buffer.concat(chunks));if(JSON.stringify(r)!==${JSON.stringify(JSON.stringify({ protocol: 1, ...payload }))})throw Error('bad fixture request');success()});`);
      const result = await nativeRequest('secure-path', payload, f.options);
      assert.equal(result.value, 'fixture-result');
      assert.deepEqual((await readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse), [['secure-path']]);
    });
  }
});

test('retired identity/authenticate and unknown operations never reach even a permissive old helper', executableOptions, async t => {
  const f = await helperFixture(t, 'respond({ok:true,protocol:1,identity:{id:"fixture-id",name:"Fixture User"}});');
  await assert.rejects(nativeRequest('identity', undefined, f.options), hasCode('unsupported'));
  await assert.rejects(nativeRequest('authenticate', { password: 'fixture-not-an-OS-password' }, f.options), hasCode('unsupported'));
  await assert.rejects(nativeRequest('unknown', undefined, f.options), hasCode('unsupported'));
  await assert.rejects(readFile(f.calls), { code: 'ENOENT' });
});

test('native helper errors use only known fixed messages and never replay helper diagnostics', executableOptions, async t => {
  for (const code of ['denied', 'unavailable', 'unsupported', 'account', 'invalid']) {
    await t.test(code, async t => {
      const f = await helperFixture(t, `process.stderr.write('fixture-secret stderr');respond({ok:false,protocol:1,code:${JSON.stringify(code)},message:'fixture-secret response'});`);
      await assert.rejects(nativeRequest('import-key', { privateKey: 'fixture' }, f.options), error => {
        assert.ok(error instanceof NativeAuthError);
        assert.equal(error.code, code);
        if (code === 'denied') assert.ok(error instanceof AuthenticationDeniedError);
        assert.doesNotMatch(error.message, /fixture-secret/u);
        return true;
      });
    });
  }
});

test('native protocol rejects malformed, multiple, versioned and invalid response envelopes', executableOptions, async t => {
  const cases = [
    `process.stdout.write('fixture-secret invalid JSON')`,
    `process.stdout.write('{}\\n{}')`,
    `respond({ok:true,protocol:2})`,
    `respond({ok:'yes',protocol:1})`,
    `respond({ok:true,protocol:'1'})`,
    `respond({ok:false,protocol:1,code:'fixture-secret'})`,
    `respond({ok:false,protocol:1})`,
    `respond([true,1])`,
    `respond(null)`,
  ];
  for (const [index, body] of cases.entries()) {
    await t.test(`response ${index + 1}`, async t => {
      const f = await helperFixture(t, body);
      await assert.rejects(nativeRequest('generate-key', undefined, f.options), error => {
        assert.ok(error instanceof NativeAuthError);
        assert.doesNotMatch(error.message, /fixture-secret/u);
        return true;
      });
    });
  }
});

test('native failures, signals, timeouts and output limits fail closed', executableOptions, async t => {
  const cases = [
    ['exit', `process.stderr.write('fixture-secret');success();process.exitCode=7`, 'unavailable', 5000],
    ['signal', `process.kill(process.pid,'SIGTERM')`, 'unavailable', 5000],
    ['timeout', `setInterval(()=>{},1000)`, 'unavailable', 50],
    ['stdout limit', `process.stdout.write(Buffer.alloc(65537,65))`, 'invalid', 5000],
    ['stderr limit', `process.stderr.write(Buffer.alloc(65537,65));success()`, 'invalid', 5000],
  ];
  for (const [name, body, code, timeoutMs] of cases) {
    await t.test(name, async t => {
      const f = await helperFixture(t, body);
      await assert.rejects(nativeRequest('generate-key', undefined, { ...f.options, timeoutMs }), error => {
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /fixture-secret/u);
        return true;
      });
    });
  }
});

test('helper validation requires matching platform manifest/hash unless code explicitly injects an executable', executableOptions, async t => {
  const f = await helperFixture(t, 'success();');
  await assert.rejects(resolveNativeHelper({ helperPath: f.helper }), hasCode('unavailable'));
  const manifest = { protocol: 1, platform: process.platform, arch: process.arch, sha256: createHash('sha256').update(f.script).digest('hex') };
  const path = join(f.base, 'manifest.json');
  await writeFile(path, JSON.stringify(manifest));
  assert.equal(await resolveNativeHelper({ helperPath: f.helper }), f.helper);
  await writeFile(path, JSON.stringify({ ...manifest, arch: 'fixture-other-arch' }));
  await assert.rejects(resolveNativeHelper({ helperPath: f.helper }), hasCode('unavailable'));
  await writeFile(path, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
  await assert.rejects(resolveNativeHelper({ helperPath: f.helper }), hasCode('unavailable'));
  await writeFile(path, JSON.stringify(manifest));
  await writeFile(f.helper, `${f.script}\n// fixture changed\n`);
  await assert.rejects(resolveNativeHelper({ helperPath: f.helper }), hasCode('unavailable'));
  assert.equal(await resolveNativeHelper(f.options), f.helper);
});

test('helper paths and manifests may not be symlinks, even for test injection', executableOptions, async t => {
  const f = await helperFixture(t, 'success();');
  const link = join(f.base, 'helper-link');
  await symlink(f.helper, link);
  await assert.rejects(resolveNativeHelper({ helperPath: link, checkIntegrity: false }), hasCode('unavailable'));
  const dirLink = join(f.base, 'parent-link');
  await symlink(f.base, dirLink);
  await assert.rejects(resolveNativeHelper({ helperPath: join(dirLink, 'fake-native.cjs'), checkIntegrity: false }), hasCode('unavailable'));
  const manifest = join(f.base, 'real-manifest.json');
  await writeFile(manifest, JSON.stringify({ protocol: 1, platform: process.platform, arch: process.arch, sha256: createHash('sha256').update(f.script).digest('hex') }));
  await symlink(manifest, join(f.base, 'manifest.json'));
  await assert.rejects(resolveNativeHelper({ helperPath: f.helper }), hasCode('unavailable'));
});

test('environment variables cannot replace a missing packaged helper or bypass integrity', executableOptions, async t => {
  const f = await helperFixture(t, 'success();');
  process.env.AUTOGIT_AUTH_HELPER = f.helper;
  process.env.AUTOGIT_SKIP_AUTH = '1';
  const modules = join(f.base, 'isolated', 'dist');
  await mkdir(modules, { recursive: true });
  await writeFile(join(dirname(modules), 'package.json'), '{"type":"module"}');
  await copyFile(new URL('../dist/auth.js', import.meta.url), join(modules, 'auth.js'));
  const { nativeRequest: isolatedRequest } = await import(pathToFileURL(join(modules, 'auth.js')).href);
  await assert.rejects(isolatedRequest('generate-key', { protocol: 1 }), error => error.name === 'NativeAuthError' && error.code === 'unavailable');
  await assert.rejects(readFile(f.calls), { code: 'ENOENT' });
});

test('invalid commands, oversized or invalid requests and timeout settings never start a helper', executableOptions, async t => {
  const f = await helperFixture(t, 'success();');
  await assert.rejects(nativeRequest('secure-path;bad', undefined, f.options), hasCode('invalid'));
  await assert.rejects(nativeRequest('import-key', { privateKey: 'x'.repeat(65536) }, f.options), hasCode('invalid'));
  await assert.rejects(nativeRequest('secure-path', { protocol: 2 }, f.options), hasCode('invalid'));
  await assert.rejects(nativeRequest('secure-path', [], f.options), hasCode('invalid'));
  await assert.rejects(nativeRequest('secure-path', null, f.options), hasCode('invalid'));
  const circular = {}; circular.self = circular;
  await assert.rejects(nativeRequest('secure-path', circular, f.options), hasCode('invalid'));
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 120001]) {
    await assert.rejects(nativeRequest('generate-key', undefined, { ...f.options, timeoutMs }), hasCode('invalid'));
  }
  await assert.rejects(readFile(f.calls), { code: 'ENOENT' });
});
