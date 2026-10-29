import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fixture, ScriptedConsole } from './support.mjs';

// Test-only root keeps profile provenance/session identity within the installed graph.
const moduleRoot = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { Profile, ProfileStore, bindProject, boundGit, buildSshArgs, chooseProfile, isHttpsOnlyProfile, profileGit, profileStoreDirectory, profilesMenu, testProfile } = await import(new URL('profiles.js', moduleRoot));
const { CredentialSession, currentSession, setSession, unlockSession } = await import(new URL('session.js', moduleRoot));
const { Vault } = await import(new URL('vault.js', moduleRoot));
const { HostStore, DEFAULT_HOST, DEFAULT_TRANSPORT } = await import(new URL('hosts.js', moduleRoot));
const { prepareCredentialDirectory } = await import(new URL('app-context.js', moduleRoot));
const { managedKeyMarker, managedKeyReferences, migrateManagedKeys } = await import(new URL('managed-keys.js', moduleRoot));
const { GitError } = await import(new URL('git.js', moduleRoot));
const { publicKeyMenu } = await import(new URL('public-key.js', moduleRoot));

const PASSWORD = 'synthetic-https-profile-password';
const HTTPS = { mode: 'https', host: { ...DEFAULT_HOST } };
const yes = () => new ScriptedConsole(['y']);
async function allFiles(directory) {
  const names = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = join(directory, entry.name);
    if (entry.isDirectory()) names.push(...await allFiles(name));
    else names.push(name);
  }
  return names.sort();
}
async function encryptedFixture(t) {
  if (process.platform === 'win32') { t.skip('real Windows ACL compatibility remains unverified'); return; }
  const f = await fixture(t);
  const directory = process.env.AUTOGIT_DATA_DIR, before = currentSession();
  assert.equal(before, undefined);
  const password = Buffer.from(PASSWORD);
  let created;
  try { created = await Vault.create(directory, password); } finally { password.fill(0); }
  const session = new CredentialSession(created.vault); setSession(session);
  const spawn = childProcess.spawn, calls = [];
  t.mock.method(childProcess, 'spawn', function(program, args, options) {
    calls.push({ program, args: [...args] });
    assert.match(basename(String(program)), /^git(?:\.exe)?$/u, 'HTTPS-only operations must never run SSH, keygen, agent or native auth');
    return Reflect.apply(spawn, this, [program, args, options]);
  });
  syncBuiltinESMExports();
  t.mock.method(session, 'storeSsh', async () => { assert.fail('HTTPS-only must not store SSH material'); });
  t.mock.method(session, 'sshAgent', async () => { assert.fail('HTTPS-only must fail before agent access'); });
  t.after(async () => {
    try { await currentSession()?.close(); await session.close(); }
    finally { setSession(before); t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
  const store = new ProfileStore(directory, {
    which() { assert.fail('HTTPS-only must not probe SSH programs'); },
    async runProcess() { assert.fail('HTTPS-only must not execute SSH programs'); },
  });
  return { ...f, directory, session, store, calls, recoveryCode: created.recoveryCode,
    create(label = 'https') { return store.createHttps(yes(), label, 'HTTPS User', 'https@example.invalid', 'https-user'); },
  };
}
async function sshMetadata(f, id = 'a'.repeat(32)) {
  const folder = join(f.directory, 'profiles', id); await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const profile = new Profile({ profile_id: id, label: 'ssh-fixture', name: 'SSH User', email: 'ssh@example.invalid', github_login: 'https-user', private_key: join(folder, 'id_ed25519'), public_key: join(folder, 'id_ed25519.pub'), remember_auth: true });
  await fs.writeFile(profile.private_key, managedKeyMarker(id), { mode: 0o600 });
  await fs.writeFile(profile.public_key, 'ssh-ed25519 AAAAsynthetic\n', { mode: 0o600 });
  const metadata = join(folder, 'profile.json'); await fs.writeFile(metadata, JSON.stringify(f.store.encodeProfile(profile)), { mode: 0o600 });
  const secret = Buffer.from('synthetic-encrypted-ssh-record');
  try { await f.session.vault.put(`ssh:${id}`, secret); } finally { secret.fill(0); }
  return { profile, metadata };
}

test('HTTPS-only creation saves strict schema 3 identity with real encrypted vault and no SSH artifacts or program probes', async t => {
  const f = await encryptedFixture(t); if (!f) return;
  const profile = await f.create(); assert.equal(isHttpsOnlyProfile(profile), true);
  assert.equal(profile.private_key, null); assert.equal(profile.public_key, null);
  assert.equal(profile.ssh_program, ''); assert.equal(profile.status, 'unverified'); assert.equal(profile.remember_auth, false);
  const metadata = join(f.store.profilesDir, profile.profile_id, 'profile.json');
  const bytes = await fs.readFile(metadata, 'utf8'), data = JSON.parse(bytes);
  assert.equal(data.schema_version, 3); assert.equal(data.private_key, null); assert.equal(data.public_key, null);
  assert.deepEqual(Object.keys(data).sort(), ['schema_version', 'profile_id', 'label', 'name', 'email', 'github_login', 'private_key', 'public_key', 'ssh_program', 'status', 'remember_auth'].sort());
  assert.equal(bytes.includes(f.directory), false); assert.equal(bytes.includes('known_hosts'), false);
  assert.deepEqual(await allFiles(f.directory), [metadata, join(f.directory, 'vault.json')].sort());
  assert.equal((await fs.stat(metadata)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dirname(metadata))).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await fs.readFile(join(f.directory, 'vault.json'))).records, []);
  assert.deepEqual(await f.store.load(profile.profile_id), profile);
  assert.equal(profileStoreDirectory({ ...profile }), f.directory);
  assert.equal(profileStoreDirectory(new Profile({ ...profile })), f.directory);
  await migrateManagedKeys(new ScriptedConsole([]), await f.store.list());
  await prepareCredentialDirectory(undefined, f.session);
  assert.deepEqual(await managedKeyReferences(f.directory), []);
  assert.equal(f.calls.length, 0);
});

test('HTTPS-only creation requires the matching live vault, validates before confirmation and never guesses a root', async t => {
  const f = await encryptedFixture(t); if (!f) return;
  const other = new ProfileStore(join(f.base, 'other data'));
  await assert.rejects(other.createHttps(new ScriptedConsole([]), 'other', 'User', 'email', 'user'), /资料目录不匹配/u);
  await assert.rejects(fs.stat(other.directory), { code: 'ENOENT' });
  const unproven = new Profile({ schema_version: 3, profile_id: 'f'.repeat(32), label: 'unproven', name: 'User', email: 'email', github_login: 'user', private_key: null, public_key: null });
  assert.throws(() => profileStoreDirectory(unproven), /归属未经验证/u);
  await assert.rejects(profileGit(f.path, { ...unproven, directory: f.directory, storeDirectory: f.directory }, HTTPS), /归属未经验证/u);
  const before = await allFiles(f.directory);
  assert.equal(await f.store.createHttps(new ScriptedConsole(['n']), 'cancelled', 'User', 'email', 'user'), undefined);
  assert.deepEqual(await allFiles(f.directory), before);
  await f.session.close();
  await assert.rejects(f.create(), /尚未解锁/u);
  assert.deepEqual(await allFiles(f.directory), before);
});

test('schema 2 SSH stays strict while schema 3 rejects every mixed-key or SSH-only state and extra root field', async t => {
  const f = await encryptedFixture(t); if (!f) return;
  const keyless = await f.create(), { profile: ssh, metadata } = await sshMetadata(f);
  const oldBytes = await fs.readFile(metadata), old = JSON.parse(oldBytes), next = f.store.encodeProfile(keyless);
  for (const patch of [{ private_key: null }, { public_key: null }, { private_key: null, public_key: null }, { schema_version: 3 }, { storeDirectory: f.directory }]) {
    assert.throws(() => f.store.decodeProfile({ ...old, ...patch }, undefined, false), GitError);
  }
  for (const patch of [
    { private_key: old.private_key }, { public_key: old.public_key }, { private_key: old.private_key, public_key: old.public_key },
    { ssh_program: '/unprobed/ssh' }, { status: 'verified' }, { remember_auth: true }, { schema_version: 2 },
    { private_key: undefined }, { public_key: undefined }, { schema_version: '3' }, { storeDirectory: f.directory }, { root: f.directory },
  ]) assert.throws(() => f.store.decodeProfile({ ...next, ...patch }, undefined, false), GitError);
  assert.throws(() => f.store.encodeProfile(new Profile({ ...keyless, schema_version: 2 })), GitError);
  await f.store.validateMetadata(); await prepareCredentialDirectory(undefined, f.session);
  assert.deepEqual(await fs.readFile(metadata), oldBytes, 'existing schema 2 metadata is never rewritten');
  assert.equal((await f.store.load(ssh.profile_id)).schema_version, 2);
  await fs.unlink(ssh.private_key);
  await assert.rejects(f.store.load(ssh.profile_id), GitError);
  await assert.rejects(f.store.validateMetadata(), GitError);
  assert.equal((await f.store.load(ssh.profile_id, false)).schema_version, 2, 'missing SSH files do not turn a profile into keyless');
});

test('HTTPS binding keeps envelope 2 and strict snapshot 3 across restart; default managed SSH refuses keyless before fallback', async t => {
  const f = await encryptedFixture(t); if (!f) return;
  const profile = await f.create();
  await assert.rejects(f.store.bind(f.path, profile.profile_id), /没有 SSH 密钥/u);
  assert.throws(() => buildSshArgs(profile, f.directory, () => assert.fail('SSH lookup')), /没有 SSH 密钥/u);
  for (const target of [DEFAULT_TRANSPORT, { mode: 'native-ssh', host: { ...DEFAULT_HOST } }]) {
    await assert.rejects(profileGit(f.path, { ...profile }, target), /没有 SSH 密钥/u);
    await assert.rejects(testProfile(new ScriptedConsole([]), f.path, { ...profile }, { transport: target, which: () => assert.fail('SSH lookup') }), /没有 SSH 密钥/u);
  }
  await bindProject(f.path, { ...profile }, HTTPS);
  const binding = JSON.parse(await fs.readFile(f.store.bindingsFile));
  assert.equal(binding.schema_version, 2); assert.equal(Object.values(binding.bindings)[0].snapshot.schema_version, 3);
  await assert.rejects(f.store.resolveBinding(f.path), /没有 SSH 密钥/u, 'binding does not silently change the project transport');
  await new HostStore().set(f.path, HTTPS);
  const token = Buffer.from('synthetic-https-token');
  try { await f.session.storeToken('github.com', profile.github_login, token); } finally { token.fill(0); }
  await f.session.close();
  const password = Buffer.from(PASSWORD); let reopened;
  try { reopened = new CredentialSession(await Vault.unlock(f.directory, password)); } finally { password.fill(0); }
  setSession(reopened); await prepareCredentialDirectory(undefined, reopened);
  const loaded = await new ProfileStore().resolveBinding(f.path); assert.deepEqual(loaded, profile);
  const git = await boundGit(f.path);
  assert.equal(git.overrides['user.name'], profile.name); assert.equal(git.overrides['core.sshCommand'], undefined);
  assert.equal(git.orderedConfig.find(([key]) => key === 'credential.interactive')?.[1], 'false');
  assert.equal(await git.value('config', 'user.email'), profile.email);
  const restored = await reopened.getToken('github.com', profile.github_login);
  try { assert.equal(restored.toString(), 'synthetic-https-token'); } finally { restored.fill(0); }
  const saved = await fs.readFile(f.store.bindingsFile);
  for (const snapshot of [
    { ...Object.values(binding.bindings)[0].snapshot, schema_version: 2 },
    { ...Object.values(binding.bindings)[0].snapshot, public_key: 'profiles/invalid/key.pub' },
    { ...Object.values(binding.bindings)[0].snapshot, root: f.directory },
  ]) {
    const root = Object.keys(binding.bindings)[0];
    await fs.writeFile(f.store.bindingsFile, JSON.stringify({ ...binding, bindings: { [root]: { profile_id: profile.profile_id, snapshot } } }));
    await assert.rejects(new ProfileStore().resolveBinding(f.path), GitError);
  }
  await fs.writeFile(f.store.bindingsFile, saved);
  await assert.rejects(fs.stat(join(f.directory, 'known_hosts')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(join(dirname(f.directory), '.autogit-sessions')), { code: 'ENOENT' });
});

test('explicit HTTPS binding and resolution never demand existing SSH key files but SSH/default still do', async t => {
  const f = await encryptedFixture(t); if (!f) return;
  const { profile } = await sshMetadata(f); await fs.unlink(profile.private_key); await fs.unlink(profile.public_key);
  await assert.rejects(bindProject(f.path, profile), GitError);
  await bindProject(f.path, profile, HTTPS); await new HostStore().set(f.path, HTTPS);
  assert.equal((await f.store.resolveBinding(f.path)).schema_version, 2);
  assert.equal(Object.values(JSON.parse(await fs.readFile(f.store.bindingsFile)).bindings)[0].snapshot.schema_version, 2);
  const git = await profileGit(f.path, profile, HTTPS); assert.equal(git.overrides['core.sshCommand'], undefined);
  assert.equal(await testProfile(new ScriptedConsole([]), f.path, profile, { transport: HTTPS }), 'unverified');
});

test('validated provenance rejects both keyless and legacy SSH spread snapshots from another active vault before agents or credential fallback', async t => {
  const f = await encryptedFixture(t); if (!f) return;
  const keyless = await f.create(), { profile: ssh } = await sshMetadata(f);
  const directory = join(f.base, 'foreign data'), password = Buffer.from(PASSWORD); let foreign;
  try { foreign = new CredentialSession((await Vault.create(directory, password)).vault); } finally { password.fill(0); }
  t.after(() => foreign.close()); setSession(foreign);
  t.mock.method(foreign, 'sshAgent', async () => assert.fail('foreign profile must be rejected before agent access'));
  for (const profile of [keyless, ssh]) {
    for (const value of [profile, { ...profile }, new Profile({ ...profile })]) {
      for (const transport of [HTTPS, { ...HTTPS, credentials: 'external' }, DEFAULT_TRANSPORT]) {
        await assert.rejects(profileGit(f.path, value, transport), /不属于当前解锁/u);
      }
    }
  }
  assert.throws(() => buildSshArgs({ ...ssh }, f.directory), /不属于当前解锁/u);
  setSession(f.session);
});

test('schema 3 UI creation, display, auth help and deletion never claim keys or remove a shared host/account Token', async t => {
  const f = await encryptedFixture(t); if (!f) return;
  const ui = new ScriptedConsole(['1', '1', 'menu-account', 'Menu User', 'menu@example.invalid', 'https-user', 'y', '3', '1', '9', '1', '0']);
  await profilesMenu(ui, f.path); assert.deepEqual(ui.answers, []);
  assert.match(ui.transcript, /新建账号类型/u); assert.match(ui.transcript, /HTTPS-only（无 SSH 密钥）/u);
  assert.doesNotMatch(ui.transcript, /当前系统 SSH|下面是完整 SSH 公钥|托管私钥已纳入/u);
  const profile = (await f.store.list())[0];
  await f.session.storeToken('github.com', profile.github_login, Buffer.from('synthetic-shared-token'));
  const view = new ScriptedConsole([]); await f.store.change_auth(view, profile.profile_id, true);
  assert.match(view.transcript, /没有 SSH 私钥/u);
  const deletion = new ScriptedConsole(['y']); assert.equal(await f.store.delete(deletion, profile.profile_id), true);
  assert.deepEqual(deletion.answers, []); assert.match(deletion.transcript, /不会删除.*共享的 Token/u);
  assert.doesNotMatch(deletion.transcript, /删除账号范围|将永久删除托管私钥/u);
  const shared = await f.session.getToken('github.com', profile.github_login);
  try { assert.equal(shared.toString(), 'synthetic-shared-token'); } finally { shared.fill(0); }
  const chooser = new ScriptedConsole(['1', 'inline-account', 'Inline User', 'inline@example.invalid', 'https-user', 'y']);
  assert.equal(isHttpsOnlyProfile(await chooseProfile(chooser, { createHttps: true })), true); assert.deepEqual(chooser.answers, []);
  assert.match(chooser.transcript, /新建 HTTPS-only 账号/u);
});

test('bound HTTPS-only public-key menu stops before gh, actor authentication or public-key input', async t => {
  const f = await encryptedFixture(t); if (!f) return;
  const profile = await f.create(); await new HostStore().set(f.path, HTTPS); await f.store.bind(f.path, profile.profile_id, HTTPS);
  t.mock.method(f.session, 'getToken', async () => assert.fail('public-key menu must stop before actor authentication'));
  const ui = new ScriptedConsole([]); await publicKeyMenu(ui, f.path);
  assert.match(ui.transcript, /没有 SSH 公钥/u); assert.deepEqual(ui.answers, []);
  assert.equal(f.calls.every(({ program }) => /^git(?:\.exe)?$/u.test(basename(program))), true, 'no gh or native auth subprocess may run');
});

test('keyless compatibility still validates every encrypted Token and orphan marker reference', async t => {
  const f = await encryptedFixture(t); if (!f) return;
  const profile = await f.create();
  await f.session.storeToken('github.com', profile.github_login, Buffer.from('synthetic-token-record'));
  await prepareCredentialDirectory(undefined, f.session);
  const recordGets = [], original = f.session.vault.get.bind(f.session.vault);
  t.mock.method(f.session.vault, 'get', async id => { recordGets.push(id); return original(id); });
  await prepareCredentialDirectory(undefined, f.session);
  assert.equal(recordGets.some(id => id.startsWith('token:')), true);
  const orphan = 'b'.repeat(32), folder = join(f.store.profilesDir, orphan); await fs.mkdir(folder, { mode: 0o700 });
  await fs.writeFile(join(folder, 'retained-key'), managedKeyMarker(orphan), { mode: 0o600 });
  await assert.rejects(prepareCredentialDirectory(undefined, f.session), /可解密凭据/u);
  await f.session.vault.put(`ssh:${orphan}`, Buffer.from('synthetic-orphan-encrypted-record'));
  await prepareCredentialDirectory(undefined, f.session); assert.ok(recordGets.includes(`ssh:${orphan}`));
  const keylessOrphan = join(f.store.profilesDir, profile.profile_id, 'orphan-key');
  await fs.writeFile(keylessOrphan, managedKeyMarker(profile.profile_id), { mode: 0o600 });
  await assert.rejects(prepareCredentialDirectory(undefined, f.session), /可解密凭据/u);
});
