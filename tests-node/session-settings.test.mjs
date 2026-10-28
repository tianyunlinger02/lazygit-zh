import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Vault, VaultUnlockError } from '../dist/vault.js';
import { CredentialSession, currentSession, setSession } from '../dist/session.js';
import { changeUnlockPassword, settingsMenu } from '../dist/preferences.js';
import { Cancelled, Console } from '../dist/ui.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function sessionFixture(t, password = 'old-fixture-password') {
  const f = await fixture(t), directory = join(f.base, 'data');
  const input = Buffer.from(password);
  const created = await Vault.create(directory, input); input.fill(0);
  const session = new CredentialSession(created.vault); setSession(session);
  t.after(async () => { await currentSession()?.close(); await session.close(); setSession(undefined); });
  return { ...f, directory, session, ...created };
}
function passwordConsole(secrets) {
  const inputs = secrets.map(value => value instanceof Error ? value : Buffer.from(value)), entered = inputs.filter(Buffer.isBuffer), output = [];
  const ui = new Console(() => { assert.fail('password change must not ask for ordinary input'); }, text => output.push(text), {
    secretInput: async () => { assert.ok(inputs.length, 'unexpected secret prompt'); const value = inputs.shift(); if (value instanceof Error) throw value; return value; },
  });
  return { ui, entered, inputs, output };
}

test('explicit lock closes the vault and removes the current session', async t => {
  const f = await sessionFixture(t);
  await settingsMenu(new ScriptedConsole(['6']));
  assert.equal(f.session.closed, true); assert.equal(currentSession(), undefined);
  await assert.rejects(f.vault.get('ssh:test'));
});

test('standalone password change verifies old/new/new and keeps the same live session, records and recovery wrapper', async t => {
  const f = await sessionFixture(t);
  await f.vault.put('ssh:test', Buffer.from('synthetic-private-key'));
  let cleanups = 0; f.session.onClose(async () => { cleanups++; });
  const before = JSON.parse(await readFile(join(f.directory, 'vault.json')));
  const scripted = passwordConsole(['old-fixture-password', 'new-fixture-password', 'new-fixture-password']);
  await changeUnlockPassword(scripted.ui);
  assert.deepEqual(scripted.inputs, []); assert.ok(scripted.entered.every(value => value.every(byte => byte === 0)));
  assert.equal(currentSession(), f.session); assert.equal(currentSession().vault, f.vault); assert.equal(f.session.closed, false); assert.equal(cleanups, 0);
  const after = JSON.parse(await readFile(join(f.directory, 'vault.json')));
  assert.equal(after.vault_id, before.vault_id); assert.deepEqual(after.records, before.records); assert.deepEqual(after.recovery, before.recovery); assert.notDeepEqual(after.password, before.password);
  const secret = await f.vault.get('ssh:test');
  try { assert.equal(secret.toString(), 'synthetic-private-key'); } finally { secret.fill(0); }
  const reopened = await Vault.unlock(f.directory, Buffer.from('new-fixture-password')); reopened.close();
  await assert.rejects(Vault.unlock(f.directory, Buffer.from('old-fixture-password')), VaultUnlockError);
  assert.doesNotMatch(scripted.output.join('\n'), /old-fixture-password|new-fixture-password|synthetic-private-key/);
  await f.session.close(); assert.equal(cleanups, 1);
});

test('wrong current unlock password preserves ciphertext and the still-live credential session', async t => {
  const f = await sessionFixture(t);
  await f.vault.put('fixture:record', Buffer.from('synthetic-current-record'));
  const before = await readFile(join(f.directory, 'vault.json'));
  const scripted = passwordConsole(['wrong-fixture-password', 'new-fixture-password', 'new-fixture-password']);
  await assert.rejects(changeUnlockPassword(scripted.ui), VaultUnlockError);
  assert.ok(scripted.entered.every(value => value.every(byte => byte === 0))); assert.deepEqual(scripted.inputs, []);
  assert.deepEqual(await readFile(join(f.directory, 'vault.json')), before); assert.equal(currentSession(), f.session); assert.equal(f.session.closed, false);
  const value = await f.vault.get('fixture:record'); try { assert.equal(value.toString(), 'synthetic-current-record'); } finally { value.fill(0); }
});

test('new password mismatch retries locally, and cancelling the retry preserves the current wrapper and live session', async t => {
  const f = await sessionFixture(t), before = await readFile(join(f.directory, 'vault.json'));
  const scripted = passwordConsole(['old-fixture-password', 'new-fixture-password', 'different-fixture-password', new Cancelled()]);
  await assert.rejects(changeUnlockPassword(scripted.ui), Cancelled);
  assert.match(scripted.output.join('\n'), /不一致|不匹配/u);
  assert.deepEqual(scripted.inputs, []); assert.ok(scripted.entered.every(value => value.every(byte => byte === 0)));
  assert.deepEqual(await readFile(join(f.directory, 'vault.json')), before); assert.equal(currentSession(), f.session); assert.equal(f.session.closed, false);
});

test('password change requires an active unlocked session and performs no secret prompts when locked', async t => {
  const f = await sessionFixture(t); await f.session.close();
  const ui = new ScriptedConsole([], { secretInput: () => { assert.fail('closed session must fail before input'); } });
  await assert.rejects(changeUnlockPassword(ui), /解锁|锁定|启动/u);
});
