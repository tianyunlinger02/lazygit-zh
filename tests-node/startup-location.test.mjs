import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { configureApp, commitConfiguredApp, appRoot, appDataDir, resetAppContextForTests } from '../dist/app-context.js';
import { Vault, VaultUnlockError } from '../dist/vault.js';
import { Cancelled } from '../dist/ui.js';
import { fixture, ScriptedConsole } from './support.mjs';

function normalMode() { delete process.env.AUTOGIT_DATA_DIR; resetAppContextForTests(); }
function pointer() { return process.platform === 'win32' ? join(process.env.APPDATA, 'AutoGit', 'location.json') : join(process.env.XDG_CONFIG_HOME, 'autogit', 'location.json'); }
async function newVault(root, password = 'synthetic-location-password') {
  const secret = Buffer.from(password);
  try { const { vault } = await Vault.create(join(root, 'data'), secret); vault.close(); }
  finally { secret.fill(0); }
}

test('startup location retries invalid input, expands home and commits only after encrypted directory creation', async t => {
  const f = await fixture(t); normalMode();
  const ui = new ScriptedConsole(['relative', '~/个人 资料']);
  await configureApp(ui, { deferLocationCommit: true });
  const root = join(f.home, '个人 资料');
  assert.equal(appRoot(), root); assert.equal(appDataDir(), join(root, 'data'));
  assert.match(ui.transcript, /位置不可用/u); assert.match(ui.transcript, /自动创建/u); assert.match(ui.transcript, /不是项目代码目录/u);
  await assert.rejects(fs.stat(pointer()), { code: 'ENOENT' }); await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  await newVault(root); await commitConfiguredApp();
  assert.deepEqual(JSON.parse(await fs.readFile(pointer(), 'utf8')), { schema_version: 1, appRoot: root });
  assert.equal((await fs.stat(join(root, 'data', 'vault.json'))).isFile(), true);
});

test('missing remembered location requires an explicit choice and never initializes an empty replacement', async t => {
  const f = await fixture(t); normalMode(); const root = join(f.base, 'missing-library');
  await configureApp(new ScriptedConsole([root])); const before = await fs.readFile(pointer());
  const ui = new ScriptedConsole(['0']);
  await assert.rejects(configureApp(ui, { deferLocationCommit: true }), Cancelled);
  assert.match(ui.transcript, /不会自动创建空库替代/u);
  assert.deepEqual(await fs.readFile(pointer()), before); await assert.rejects(fs.stat(root), { code: 'ENOENT' });
});

test('a moved encrypted library is selected without changing its remembered pointer before unlock', async t => {
  const f = await fixture(t); normalMode(); const first = join(f.base, 'first'), moved = join(f.base, 'moved 中文');
  await configureApp(new ScriptedConsole([first])); await newVault(first); const before = await fs.readFile(pointer());
  await fs.rename(first, moved);
  await configureApp(new ScriptedConsole(['2', moved]), { deferLocationCommit: true });
  assert.equal(appRoot(), moved); assert.deepEqual(await fs.readFile(pointer()), before);
  const password = Buffer.from('synthetic-location-password');
  try { const vault = await Vault.unlock(appDataDir(), password); vault.close(); } finally { password.fill(0); }
  await commitConfiguredApp(); assert.equal(JSON.parse(await fs.readFile(pointer())).appRoot, moved);
});

test('wrong password for a located library leaves both the pointer and encrypted bytes unchanged', async t => {
  const f = await fixture(t); normalMode(); const lost = join(f.base, 'lost'), target = join(f.base, 'target');
  await configureApp(new ScriptedConsole([lost])); await newVault(target, 'different-synthetic-password');
  const before = await fs.readFile(pointer()), vaultBefore = await fs.readFile(join(target, 'data', 'vault.json'));
  await configureApp(new ScriptedConsole(['2', target]), { deferLocationCommit: true });
  const wrong = Buffer.from('wrong-synthetic-password');
  try { await assert.rejects(Vault.unlock(appDataDir(), wrong), VaultUnlockError); } finally { wrong.fill(0); }
  assert.deepEqual(await fs.readFile(pointer()), before); assert.deepEqual(await fs.readFile(join(target, 'data', 'vault.json')), vaultBefore);
});

test('new replacement library requires one explicit confirmation and never overwrites a nonempty target', async t => {
  const f = await fixture(t); normalMode(); const lost = join(f.base, 'lost'), used = join(f.base, 'used'), fresh = join(f.base, 'fresh');
  await configureApp(new ScriptedConsole([lost])); const before = await fs.readFile(pointer());
  await fs.mkdir(join(used, 'data'), { recursive: true }); await fs.writeFile(join(used, 'data', 'keep.txt'), 'unchanged');
  const cancelled = new ScriptedConsole(['3', used, '3', fresh, 'n', '0']);
  await assert.rejects(configureApp(cancelled, { deferLocationCommit: true }), Cancelled);
  assert.match(cancelled.transcript, /data 非空/u); assert.equal(await fs.readFile(join(used, 'data', 'keep.txt'), 'utf8'), 'unchanged');
  assert.deepEqual(await fs.readFile(pointer()), before); await assert.rejects(fs.stat(fresh), { code: 'ENOENT' });
  const accepted = new ScriptedConsole(['3', fresh, 'y']); await configureApp(accepted, { deferLocationCommit: true });
  assert.equal((accepted.transcript.match(/\[y\/N\]/gu) ?? []).length, 1);
  assert.deepEqual(await fs.readFile(pointer()), before); await newVault(fresh); await commitConfiguredApp();
  assert.equal(JSON.parse(await fs.readFile(pointer())).appRoot, fresh);
});

test('a deleted vault is not silently recreated even when its data directory remains', async t => {
  const f = await fixture(t); normalMode(); const root = join(f.base, 'existing-data');
  await configureApp(new ScriptedConsole([root])); await newVault(root); await fs.writeFile(join(root, 'data', 'settings.json'), 'fixture metadata');
  await fs.unlink(join(root, 'data', 'vault.json')); const before = await fs.readFile(pointer());
  await assert.rejects(configureApp(new ScriptedConsole(['0']), { deferLocationCommit: true }), Cancelled);
  await assert.rejects(fs.stat(join(root, 'data', 'vault.json')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(join(root, 'data', 'settings.json'), 'utf8'), 'fixture metadata'); assert.deepEqual(await fs.readFile(pointer()), before);
});

test('a concurrent pointer change cannot be overwritten by a staged first startup', async t => {
  const f = await fixture(t); normalMode(); const first = join(f.base, 'first'), concurrent = join(f.base, 'concurrent');
  await configureApp(new ScriptedConsole([first]), { deferLocationCommit: true });
  await fs.mkdir(dirname(pointer()), { recursive: true }); const changed = JSON.stringify({ schema_version: 1, appRoot: concurrent }); await fs.writeFile(pointer(), changed);
  await assert.rejects(commitConfiguredApp(), /另一进程修改/u); assert.equal(await fs.readFile(pointer(), 'utf8'), changed);
});

test('a concurrent pointer change is detected while reusing an unlocked remembered location too', async t => {
  const f = await fixture(t); normalMode(); const root = join(f.base, 'root'), concurrent = join(f.base, 'other');
  await configureApp(new ScriptedConsole([root])); await newVault(root);
  await configureApp(new ScriptedConsole([]), { deferLocationCommit: true });
  const changed = JSON.stringify({ schema_version: 1, appRoot: concurrent }); await fs.writeFile(pointer(), changed);
  await assert.rejects(commitConfiguredApp(), /另一进程修改/u); assert.equal(await fs.readFile(pointer(), 'utf8'), changed);
});
