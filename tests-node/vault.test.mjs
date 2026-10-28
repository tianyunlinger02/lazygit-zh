import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createScratch } from '../scripts/scratch.mjs';

// An isolated compiler output can be selected without rebuilding a shared dist during parallel work.
const { Vault, VaultUnlockError } = await import(process.env.AUTOGIT_VAULT_TEST_MODULE ?? '../dist/vault.js');
const PASSWORD = Buffer.from('synthetic-vault-test-password-only');
const NEXT_PASSWORD = Buffer.from('synthetic-replacement-password-only');

async function fixture(t) {
  const scratch = await createScratch('vault-test-');
  const directory = join(scratch.directory, 'private data'), file = join(directory, 'vault.json'), opened = [];
  t.after(async () => { for (const vault of opened) vault.close(); await scratch.cleanup(); });
  const track = (vault) => { opened.push(vault); return vault; };
  return {
    base: scratch.directory, directory, file, track,
    async create() { const result = await Vault.create(directory, PASSWORD); track(result.vault); return result; },
    async read() { return JSON.parse(await fs.readFile(file, 'utf8')); },
    async write(data) { await fs.writeFile(file, JSON.stringify(data)); },
    async clean() { assert.deepEqual((await fs.readdir(directory)).filter((name) => name.startsWith('.tmp-') || name === '.lock'), []); },
  };
}
function notUnlock(error) { assert.ok(error instanceof Error); assert.equal(error instanceof VaultUnlockError, false); return true; }
function associated(data, purpose, binding) { return Buffer.from(JSON.stringify(['AutoGit/vault', 1, data.vault_id, 'aes-256-gcm', purpose, binding])); }
function decrypt(key, aad, box) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.nonce, 'base64'));
  decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]);
}
// These helpers only unwrap generated fixture data, to test record AAD independently of the manifest.
function fixtureDek(data, password = PASSWORD) {
  const { kdf } = data.password;
  const key = scryptSync(password, Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 64 * 1024 * 1024 });
  try { return decrypt(key, associated(data, 'password', kdf), data.password); } finally { key.fill(0); }
}
function fixturePasswordWrapper(data, password, dek) {
  const kdf = { ...data.password.kdf, salt: randomBytes(16).toString('base64') };
  const key = scryptSync(password, Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 64 * 1024 * 1024 });
  try {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(associated(data, 'password', kdf));
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    data.password = { kdf, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    signFixture(data, dek);
  } finally { key.fill(0); }
}
function signFixture(data, key) {
  const { integrity, ...payload } = data;
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associated(data, 'manifest', payload)); cipher.final();
  data.integrity = { nonce: nonce.toString('base64'), ciphertext: '', tag: cipher.getAuthTag().toString('base64') };
}

test('vault create, binary CRUD, independent nonces, no plaintext on disk, and close', async (t) => {
  const f = await fixture(t), parentMode = (await fs.stat(f.base)).mode;
  const { vault, recoveryCode } = await f.create();
  assert.equal(vault.directory, f.directory); assert.match(recoveryCode, /^[a-f0-9]{8}(?:-[a-f0-9]{8}){7}$/u);
  const secret = Buffer.concat([Buffer.from('SYNTHETIC SECRET NEVER STORE PLAINTEXT '), Buffer.from([0, 255, 128, 10])]);
  const original = Buffer.from(secret), meta = { type: 'ssh-key', host: 'test.example.invalid', account: '合成测试用户' };
  await vault.put('profile:one:key', secret, meta); await vault.put('profile:two:key', secret, meta); await vault.put('empty', Buffer.alloc(0));
  assert.deepEqual(secret, original); assert.deepEqual(await vault.get('profile:one:key'), secret); assert.deepEqual(await vault.get('empty'), Buffer.alloc(0));
  assert.equal(await vault.get('absent'), undefined); assert.equal(await vault.has('absent'), false); assert.equal(await vault.has('empty'), true);
  const first = await f.read(), nonces = [...first.records.map((item) => item.nonce), first.integrity.nonce];
  assert.equal(new Set(nonces).size, nonces.length); assert.notDeepEqual(first.password, first.recovery); assert.notEqual(first.password.kdf.salt, first.recovery.kdf.salt);
  assert.deepEqual(first.records[0].metadata, meta);
  const raw = await fs.readFile(f.file);
  for (const plaintext of [secret, PASSWORD, Buffer.from(recoveryCode)]) assert.equal(raw.includes(plaintext), false);
  assert.equal((await fs.stat(f.base)).mode, parentMode, 'external parent is not chmodded');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(f.directory)).mode & 0o7777, 0o700); assert.equal((await fs.stat(f.file)).mode & 0o7777, 0o600);
    assert.equal((await fs.stat(f.file)).uid, process.geteuid());
  }
  const returned = await vault.get('profile:one:key'); returned.fill(0); assert.deepEqual(await vault.get('profile:one:key'), secret);
  await vault.put('profile:one:key', Buffer.from('synthetic updated value'));
  const updated = await f.read(); assert.notEqual(updated.records[0].nonce, first.records[0].nonce); assert.notEqual(updated.integrity.nonce, first.integrity.nonce);
  assert.deepEqual(await vault.get('profile:one:key'), Buffer.from('synthetic updated value'));
  assert.equal(await vault.delete('profile:two:key'), true); assert.equal(await vault.delete('profile:two:key'), false); assert.equal(await vault.get('profile:two:key'), undefined);
  const reopened = f.track(await Vault.unlock(f.directory, PASSWORD)); assert.deepEqual(await reopened.get('profile:one:key'), Buffer.from('synthetic updated value'));
  vault.close(); vault.close();
  for (const operation of [() => vault.get('empty'), () => vault.has('empty'), () => vault.put('empty', secret), () => vault.delete('empty')]) await assert.rejects(operation, /已关闭/u);
  await f.clean();
});

test('wrong credentials do not modify the store or cause an implicit recovery', async (t) => {
  const f = await fixture(t), { vault } = await f.create(); await vault.put('one', Buffer.from('synthetic value'));
  const before = await fs.readFile(f.file);
  await assert.rejects(Vault.unlock(f.directory, NEXT_PASSWORD), VaultUnlockError);
  await assert.rejects(Vault.recover(f.directory, 'a'.repeat(8) + '-aaaaaaaa'.repeat(7), NEXT_PASSWORD), VaultUnlockError);
  for (const code of ['', 'not a recovery code', Buffer.from('invalid'), `${'a'.repeat(8)}${'-aaaaaaaa'.repeat(7)}\n`]) await assert.rejects(Vault.recover(f.directory, code, NEXT_PASSWORD), VaultUnlockError);
  await assert.rejects(Vault.create(f.directory, PASSWORD), /已存在/u);
  assert.deepEqual(await fs.readFile(f.file), before); await f.clean();
});

test('recovery rewraps the existing DEK, rotates the code, and invalidates old wrapping credentials', async (t) => {
  const f = await fixture(t), first = await f.create(); await first.vault.put('one', Buffer.from('synthetic preserved data'));
  const before = await f.read(), recoveryInput = Buffer.from(first.recoveryCode);
  const recovered = await Vault.recover(f.directory, recoveryInput, NEXT_PASSWORD); f.track(recovered.vault);
  assert.equal(recoveryInput.toString(), first.recoveryCode); assert.notEqual(recovered.recoveryCode, first.recoveryCode);
  const after = await f.read(); assert.equal(after.vault_id, before.vault_id); assert.deepEqual(after.records, before.records);
  assert.notDeepEqual(after.password, before.password); assert.notDeepEqual(after.recovery, before.recovery);
  assert.equal((await fs.readFile(f.file, 'utf8')).includes(recovered.recoveryCode), false);
  await assert.rejects(Vault.unlock(f.directory, PASSWORD), VaultUnlockError);
  await assert.rejects(Vault.recover(f.directory, first.recoveryCode, PASSWORD), VaultUnlockError);
  const unlocked = f.track(await Vault.unlock(f.directory, NEXT_PASSWORD)); assert.deepEqual(await unlocked.get('one'), Buffer.from('synthetic preserved data'));
  const twice = await Vault.recover(f.directory, recovered.recoveryCode, PASSWORD); f.track(twice.vault);
  assert.deepEqual(await twice.vault.get('one'), Buffer.from('synthetic preserved data'));
  await f.clean();
});

test('password changes authenticate the latest old wrapper while preserving DEK, recovery, records, identity and open sessions', async t => {
  const f = await fixture(t), first = await f.create(), second = f.track(await Vault.unlock(f.directory, PASSWORD));
  await first.vault.put('one', Buffer.from('synthetic-preserved-record'));
  const before = await f.read(), dekBefore = fixtureDek(before), old = Buffer.from(PASSWORD), next = Buffer.from(NEXT_PASSWORD);
  try {
    await first.vault.changePassword(old, next);
    assert.deepEqual(old, PASSWORD); assert.deepEqual(next, NEXT_PASSWORD);
    const after = await f.read(), dekAfter = fixtureDek(after, NEXT_PASSWORD);
    try { assert.deepEqual(dekAfter, dekBefore); } finally { dekAfter.fill(0); }
    assert.equal(after.schema_version, 1); assert.equal(after.vault_id, before.vault_id); assert.equal(after.cipher, before.cipher);
    assert.deepEqual(after.records, before.records); assert.deepEqual(after.recovery, before.recovery); assert.notDeepEqual(after.password, before.password);
    await assert.rejects(Vault.unlock(f.directory, PASSWORD), VaultUnlockError);
    assert.deepEqual(await second.get('one'), Buffer.from('synthetic-preserved-record'));
    const bytes = await fs.readFile(f.file);
    await assert.rejects(second.changePassword(PASSWORD, PASSWORD), VaultUnlockError);
    assert.deepEqual(await fs.readFile(f.file), bytes);
    await second.changePassword(NEXT_PASSWORD, PASSWORD);
    const recovered = await Vault.recover(f.directory, first.recoveryCode, NEXT_PASSWORD); f.track(recovered.vault);
    assert.deepEqual(await recovered.vault.get('one'), Buffer.from('synthetic-preserved-record'));
  } finally { dekBefore.fill(0); old.fill(0); next.fill(0); }
  await f.clean();
});

test('short legacy schema-1 passwords remain unlockable and change to exact Unicode passwords without normalization', async t => {
  const f = await fixture(t), first = await f.create(), data = await f.read(), dek = fixtureDek(data), legacy = Buffer.from('old');
  try { fixturePasswordWrapper(data, legacy, dek); await f.write(data); } finally { dek.fill(0); }
  first.vault.close();
  const vault = f.track(await Vault.unlock(f.directory, legacy));
  const exact = Buffer.from(' :q é😀 password '), normalized = Buffer.from(exact.toString().normalize('NFC'));
  try {
    await vault.changePassword(legacy, exact);
    f.track(await Vault.unlock(f.directory, exact));
    await assert.rejects(Vault.unlock(f.directory, normalized), VaultUnlockError);
    assert.deepEqual((await f.read()).records, data.records); assert.equal((await f.read()).schema_version, 1);
  } finally { exact.fill(0); normalized.fill(0); legacy.fill(0); }
  const astral = Buffer.from('😀'.repeat(12)), maximum = Buffer.alloc(1024, 0x61);
  try { await vault.changePassword(Buffer.from(' :q é😀 password '), astral); await vault.changePassword(astral, maximum); f.track(await Vault.unlock(f.directory, maximum)); }
  finally { astral.fill(0); maximum.fill(0); }
});

test('wrong recovery preflight never creates a lock, alters directory metadata or repairs existing permissions', async t => {
  const f = await fixture(t), { vault } = await f.create(); vault.close();
  const before = await fs.readFile(f.file), directoryInfo = await fs.stat(f.directory);
  await assert.rejects(Vault.recover(f.directory, 'aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa', NEXT_PASSWORD), VaultUnlockError);
  const after = await fs.stat(f.directory);
  assert.equal(after.mtimeMs, directoryInfo.mtimeMs); assert.equal(after.ctimeMs, directoryInfo.ctimeMs); assert.equal(after.mode, directoryInfo.mode);
  assert.deepEqual(await fs.readFile(f.file), before); await f.clean();
  const lock = join(f.directory, '.lock'); await fs.writeFile(lock, 'synthetic-foreign-lock', { mode: 0o600 });
  await assert.rejects(Vault.recover(f.directory, 'aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa', NEXT_PASSWORD), VaultUnlockError);
  assert.equal(await fs.readFile(lock, 'utf8'), 'synthetic-foreign-lock'); await fs.unlink(lock);
});

test('password-change failures preserve encrypted bytes and reject a replaced vault identity', async t => {
  const f = await fixture(t), { vault } = await f.create(), before = await fs.readFile(f.file);
  for (const password of [Buffer.alloc(0), Buffer.from('short'), Buffer.from('😀'.repeat(11)), Buffer.alloc(1025, 0x61)]) {
    await assert.rejects(vault.changePassword(PASSWORD, password)); assert.deepEqual(await fs.readFile(f.file), before);
  }
  await assert.rejects(vault.changePassword(NEXT_PASSWORD, PASSWORD), VaultUnlockError); assert.deepEqual(await fs.readFile(f.file), before);
  const replacement = join(f.base, 'replacement'), created = await Vault.create(replacement, PASSWORD); f.track(created.vault);
  await fs.copyFile(join(replacement, 'vault.json'), f.file);
  const replaced = await fs.readFile(f.file); await assert.rejects(vault.changePassword(PASSWORD, NEXT_PASSWORD), /标识已变化/u);
  assert.deepEqual(await fs.readFile(f.file), replaced); await f.clean();
});

test('strict schema, canonical base64, sizes and fixed KDF costs fail before attempting a KDF', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t), { vault } = await f.create(); await vault.put('one', Buffer.from('synthetic value'), { type: 'test' });
  const initial = await f.read();
  const invalid = [
    (d) => { d.extra = true; }, (d) => { d.schema_version = true; }, (d) => { d.schema_version = 2; },
    (d) => { d.cipher = 'aes-128-gcm'; }, (d) => { d.vault_id = '../escape'; }, (d) => { d.records = {}; },
    (d) => { d.records[0].extra = ''; }, (d) => { d.records.push(structuredClone(d.records[0])); },
    (d) => { d.records[0].id = '../unsafe'; }, (d) => { d.records[0].metadata = { type: 'test', token: 'not allowed' }; },
    (d) => { d.records[0].metadata = { type: 'test', host: null }; }, (d) => { d.records[0].metadata = { type: 'test', account: 'bad\nlabel' }; },
    (d) => { d.records[0].metadata = { type: 'x'.repeat(65) }; }, (d) => { d.records[0].nonce = d.integrity.nonce; },
    (d) => { d.records[0].nonce = 'AA=='; }, (d) => { d.records[0].tag = Buffer.alloc(15).toString('base64'); },
    (d) => { d.records[0].ciphertext = Buffer.alloc(65_537).toString('base64'); },
    (d) => { d.integrity.extra = true; }, (d) => { d.integrity.ciphertext = 'AA=='; },
    (d) => { d.password.ciphertext = Buffer.alloc(31).toString('base64'); },
    (d) => { d.password.tag = d.password.tag.slice(0, -2); },
    (d) => { d.recovery.kdf.salt = d.password.kdf.salt; },
  ];
  for (const role of ['password', 'recovery']) {
    for (const [field, value] of [['N', 2 ** 30], ['N', 16], ['N', 32768.5], ['N', '32768'], ['r', 0], ['r', 2 ** 30], ['p', 2], ['p', -1], ['key_length', 64], ['name', 'pbkdf2'], ['salt', 'AA=='], ['salt', Buffer.alloc(17).toString('base64')]]) invalid.push((d) => { d[role].kdf[field] = value; });
    invalid.push((d) => { d[role].kdf.extra = true; }); invalid.push((d) => { d[role].extra = true; });
    invalid.push((d) => { d[role].kdf.salt = `${d[role].kdf.salt.slice(0, -3)}B==`; }); // Nonzero unused base64 bits.
  }
  for (const change of invalid) {
    const changed = structuredClone(initial); change(changed); await f.write(changed);
    const raw = await fs.readFile(f.file); await assert.rejects(Vault.unlock(f.directory, PASSWORD), notUnlock); assert.deepEqual(await fs.readFile(f.file), raw);
  }
  const valid = JSON.stringify(initial);
  for (const raw of ['null', '[]', '{', `${valid} true`, valid.replace('"schema_version":1', '"schema_version":1,"schema_version":1'), valid.replace('"N":32768', '"N":32768,"\\u004e":32768'), Buffer.from([0xff, 0xfe]), `﻿${valid}`, ' '.repeat(1_048_577)]) {
    await fs.writeFile(f.file, raw); await assert.rejects(Vault.unlock(f.directory, PASSWORD), notUnlock);
  }
  await f.write(initial); assert.deepEqual(await vault.get('one'), Buffer.from('synthetic value')); await f.clean();
});

test('manifest rejects ciphertext, metadata, record removal and wrapper tampering for every open-session operation', async (t) => {
  const f = await fixture(t), { vault } = await f.create(); await vault.put('one', Buffer.from('synthetic first'), { type: 'test' }); await vault.put('two', Buffer.from('synthetic second'));
  const initial = await f.read(), changes = [
    (d) => { d.records.splice(0, 1); }, (d) => { d.records[0].metadata.type = 'renamed'; }, (d) => { d.records[0].id = 'renamed'; },
    (d) => { [d.records[0].ciphertext, d.records[1].ciphertext] = [d.records[1].ciphertext, d.records[0].ciphertext]; },
    (d) => { d.records[0].tag = Buffer.alloc(16).toString('base64'); }, (d) => { d.integrity.tag = Buffer.alloc(16).toString('base64'); },
    (d) => { d.recovery.tag = Buffer.alloc(16).toString('base64'); }, (d) => { d.password.kdf.salt = Buffer.alloc(16).toString('base64'); },
  ];
  for (const change of changes) {
    const altered = structuredClone(initial); change(altered); await f.write(altered); const raw = await fs.readFile(f.file);
    for (const operation of [() => vault.get('one'), () => vault.has('one'), () => vault.put('third', Buffer.from('synthetic third')), () => vault.delete('two')]) await assert.rejects(operation, /完整性/u);
    assert.deepEqual(await fs.readFile(f.file), raw); await f.clean();
  }
  const broken = structuredClone(initial); broken.records = []; await f.write(broken);
  await assert.rejects(Vault.unlock(f.directory, PASSWORD), notUnlock);
  await f.write(initial);
  // Canonical schema ordering, not the source JSON's property order, is authenticated.
  const reversed = Object.fromEntries(Object.entries(initial).reverse()); reversed.password.kdf = Object.fromEntries(Object.entries(reversed.password.kdf).reverse());
  await f.write(reversed); const reopened = f.track(await Vault.unlock(f.directory, PASSWORD)); assert.equal(await reopened.has('one'), true);
});

test('each record GCM AAD independently binds id, metadata, vault identity and purpose', async (t) => {
  const f = await fixture(t), { vault } = await f.create(); await vault.put('one', Buffer.from('synthetic first'), { type: 'test', account: 'one' }); await vault.put('two', Buffer.from('synthetic second'), { type: 'test' });
  const initial = await f.read(), dek = fixtureDek(initial); t.after(() => dek.fill(0));
  for (const change of [
    (d) => { d.records[0].id = 'renamed'; },
    (d) => { d.records[0].metadata.account = 'two'; },
    (d) => { for (const field of ['nonce', 'ciphertext', 'tag']) [d.records[0][field], d.records[1][field]] = [d.records[1][field], d.records[0][field]]; },
  ]) {
    const altered = structuredClone(initial); change(altered); signFixture(altered, dek); await f.write(altered);
    await assert.rejects(vault.get(altered.records[0].id), /完整性/u);
  }
  const item = initial.records[0];
  assert.throws(() => decrypt(dek, associated({ vault_id: 'a'.repeat(32) }, 'record', [item.id, item.metadata]), item));
  assert.throws(() => decrypt(dek, associated(initial, 'password', [item.id, item.metadata]), item));
  await f.write(initial); assert.deepEqual(await vault.get('one'), Buffer.from('synthetic first'));
});

test('locks are exclusive, never auto-removed, and independent instances do not lose successful writes', async (t) => {
  const f = await fixture(t), { vault, recoveryCode } = await f.create(), other = f.track(await Vault.unlock(f.directory, PASSWORD));
  await vault.put('one', Buffer.from('synthetic first')); await other.put('two', Buffer.from('synthetic second')); assert.equal(await vault.has('two'), true);
  const lock = join(f.directory, '.lock'); await fs.writeFile(lock, 'synthetic foreign lock', { mode: 0o600 });
  const before = await fs.readFile(f.file);
  for (const operation of [() => vault.put('three', Buffer.alloc(0)), () => vault.delete('one'), () => Vault.create(f.directory, PASSWORD), () => Vault.recover(f.directory, recoveryCode, NEXT_PASSWORD)]) await assert.rejects(operation, /锁定/u);
  assert.equal(await fs.readFile(lock, 'utf8'), 'synthetic foreign lock'); assert.deepEqual(await fs.readFile(f.file), before); assert.equal(await vault.has('one'), true); await fs.unlink(lock);
  const results = await Promise.allSettled([vault.put('three', Buffer.from('three')), other.put('four', Buffer.from('four'))]);
  assert.ok(results.some((item) => item.status === 'fulfilled'));
  for (let i = 0; i < results.length; i++) if (results[i].status === 'fulfilled') assert.equal(await vault.has(['three', 'four'][i]), true); else assert.match(results[i].reason.message, /锁定/u);
  assert.equal(await vault.has('one'), true); assert.equal(await vault.has('two'), true); await f.clean();
});

test('atomic rename failure keeps previous bytes, removes staging/lock, and does not change recovery credentials', async (t) => {
  const f = await fixture(t), { vault, recoveryCode } = await f.create(); await vault.put('one', Buffer.from('synthetic first'));
  const before = await fs.readFile(f.file), rename = fs.rename;
  fs.rename = async (from, to) => { if (to === f.file) throw new Error('synthetic rename failure'); return rename(from, to); }; syncBuiltinESMExports();
  try {
    await assert.rejects(vault.put('one', Buffer.from('synthetic replacement')), /synthetic rename failure/u);
    await assert.rejects(vault.delete('one'), /synthetic rename failure/u);
    await assert.rejects(vault.changePassword(PASSWORD, NEXT_PASSWORD), /synthetic rename failure/u);
    await assert.rejects(Vault.recover(f.directory, recoveryCode, NEXT_PASSWORD), /synthetic rename failure/u);
  } finally { fs.rename = rename; syncBuiltinESMExports(); }
  assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(await vault.get('one'), Buffer.from('synthetic first')); await f.clean();
  f.track(await Vault.unlock(f.directory, PASSWORD)); await assert.rejects(Vault.unlock(f.directory, NEXT_PASSWORD), VaultUnlockError);
});

test('POSIX chmod/fsync failures are not swallowed or allowed to replace the vault', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t), { vault } = await f.create(); await vault.put('one', Buffer.from('synthetic first'));
  const before = await fs.readFile(f.file), probe = await fs.open(join(f.base, 'synthetic-probe'), 'wx', 0o600), prototype = Object.getPrototypeOf(probe); await probe.close();
  for (const method of ['chmod', 'sync']) {
    const original = prototype[method]; prototype[method] = async () => { throw new Error(`synthetic ${method} failure`); };
    try { await assert.rejects(vault.put('one', Buffer.from('synthetic replacement')), new RegExp(`synthetic ${method} failure`, 'u')); }
    finally { prototype[method] = original; }
    assert.deepEqual(await fs.readFile(f.file), before); await f.clean();
  }
});

test('unsafe paths, symlinks and hard links are rejected without accessing an outside store', async (t) => {
  const f = await fixture(t);
  for (const directory of ['relative', join(f.base, 'x') + '/../escape', `${f.directory}\n`]) await assert.rejects(Vault.create(directory, PASSWORD));
  await assert.rejects(Vault.unlock(f.directory, PASSWORD)); assert.equal(existsSync(f.directory), false);
  const { vault } = await f.create(), before = await fs.readFile(f.file), hard = join(f.base, 'hard-copy');
  await fs.link(f.file, hard); await assert.rejects(vault.get('one'), /硬链接/u); await assert.rejects(Vault.unlock(f.directory, PASSWORD), /硬链接/u); await fs.unlink(hard);
  if (process.platform !== 'win32') {
    const saved = join(f.directory, 'saved.json'); await fs.rename(f.file, saved); await fs.symlink(saved, f.file);
    await assert.rejects(vault.get('one'), /符号链接/u); await assert.rejects(vault.put('one', Buffer.alloc(0)), /符号链接/u); await fs.unlink(f.file); await fs.rename(saved, f.file);
    const alias = join(f.base, 'alias'); await fs.symlink(f.directory, alias, 'dir'); await assert.rejects(Vault.unlock(alias, PASSWORD), /符号链接/u);
    const lock = join(f.directory, '.lock'); await fs.symlink(f.file, lock); await assert.rejects(vault.put('one', Buffer.alloc(0)), /符号链接/u); await fs.unlink(lock);
  }
  assert.deepEqual(await fs.readFile(f.file), before); await f.clean();
});

test('POSIX modes and ownership are strict and never silently repaired on existing paths', { skip: process.platform === 'win32' }, async (t) => {
  const f = await fixture(t), { vault } = await f.create(), before = await fs.readFile(f.file);
  for (const mode of [0o750, 0o701, 0o2700]) {
    await fs.chmod(f.directory, mode);
    for (const operation of [() => Vault.create(f.directory, PASSWORD), () => Vault.unlock(f.directory, PASSWORD), () => vault.get('one'), () => vault.put('one', Buffer.alloc(0))]) await assert.rejects(operation, /0700/u);
    assert.equal((await fs.stat(f.directory)).mode & 0o7777, mode); await fs.chmod(f.directory, 0o700);
  }
  for (const mode of [0o640, 0o400, 0o666]) {
    await fs.chmod(f.file, mode); await assert.rejects(Vault.unlock(f.directory, PASSWORD), /0600/u); await assert.rejects(vault.put('one', Buffer.alloc(0)), /0600/u);
    assert.equal((await fs.stat(f.file)).mode & 0o7777, mode); await fs.chmod(f.file, 0o600);
  }
  const actual = process.geteuid;
  process.geteuid = () => actual() + 1;
  try { await assert.rejects(Vault.unlock(f.directory, PASSWORD), /当前用户/u); await assert.rejects(vault.put('one', Buffer.alloc(0)), /当前用户/u); }
  finally { process.geteuid = actual; }
  assert.deepEqual(await fs.readFile(f.file), before); await f.clean();
});

test('input limits and aggregate capacity fail without changing existing ciphertext', async (t) => {
  const f = await fixture(t);
  for (const password of ['', Buffer.alloc(0), Buffer.from('short'), Buffer.from('😀'.repeat(11)), Buffer.alloc(1025, 0x61), Buffer.from([0xff, ...Buffer.alloc(12, 0x61)]), Buffer.alloc(4097)]) await assert.rejects(Vault.create(f.directory, password));
  assert.equal(existsSync(f.directory), false);
  const { vault } = await f.create();
  for (const id of ['', '../unsafe', 'a/b', 'x'.repeat(129)]) { await assert.rejects(vault.get(id)); await assert.rejects(vault.put(id, Buffer.alloc(0))); }
  for (const secret of ['not Buffer', Buffer.alloc(65_537)]) await assert.rejects(vault.put('one', secret));
  await assert.rejects(vault.put('one', Buffer.alloc(0), { type: 'test', extra: 'unknown' }));
  let failed = false;
  for (let i = 0; i < 15; i++) {
    const before = await fs.readFile(f.file);
    try { await vault.put(`record:${i}`, Buffer.alloc(65_536, i)); }
    catch (error) { assert.match(error.message, /容量/u); assert.deepEqual(await fs.readFile(f.file), before); failed = true; break; }
  }
  assert.equal(failed, true); await f.clean();
});

test('relocation works, but an already-open instance rejects a replacement vault identity', async (t) => {
  const f = await fixture(t), { vault } = await f.create(); await vault.put('one', Buffer.from('synthetic portable data')); vault.close();
  const moved = join(f.base, 'moved private data'); await fs.rename(f.directory, moved);
  const relocated = f.track(await Vault.unlock(moved, PASSWORD)); assert.deepEqual(await relocated.get('one'), Buffer.from('synthetic portable data'));
  const replacement = join(f.base, 'replacement'), next = await Vault.create(replacement, PASSWORD); f.track(next.vault);
  await fs.copyFile(join(replacement, 'vault.json'), join(moved, 'vault.json'));
  await assert.rejects(relocated.get('one'), /标识已变化/u); await assert.rejects(relocated.put('one', Buffer.alloc(0)), /标识已变化/u);
});
