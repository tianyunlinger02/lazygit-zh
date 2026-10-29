import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createBackup, validateBackup, restoreBackup, relocateData, remapDataPaths, backupMenu } from '../dist/backup.js';
import { appDataDir, configureApp, resetAppContextForTests } from '../dist/app-context.js';
import { Vault, VaultUnlockError } from '../dist/vault.js';
import { Cancelled } from '../dist/ui.js';
import { CredentialSession, currentSession, setSession } from '../dist/session.js';
import { managedKeyMarker } from '../dist/managed-keys.js';
import { savePreferences } from '../dist/preferences.js';
import { Profile, ProfileStore } from '../dist/profiles.js';
import { Git, GitError } from '../dist/git.js';
import { HostStore, DEFAULT_HOST } from '../dist/hosts.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function fixtureData(f) {
  const store = new ProfileStore(); const id = 'b'.repeat(32); const folder = join(store.directory, 'profiles', id); await fs.mkdir(folder, { recursive: true });
  const profile = new Profile({ profile_id: id, label: 'fixture', name: 'Fixture', email: 'fixture@example.invalid', github_login: 'fixture', private_key: join(folder, 'id_ed25519'), public_key: join(folder, 'id_ed25519.pub') });
  await fs.writeFile(profile.private_key, 'FAKE PRIVATE KEY'); await fs.writeFile(profile.public_key, 'ssh-ed25519 AAAAfixture\n'); await fs.writeFile(join(folder, 'profile.json'), JSON.stringify(store.encodeProfile(profile))); await fs.writeFile(join(store.directory, 'known_hosts'), 'fixture'); await savePreferences({ last_project: f.path });
  return profile;
}

test('backup manifest includes all data and fake keys but excludes lock and external pointers', async t => {
  const f = await fixture(t); await fixtureData(f); const target = join(f.base, 'backup'); const manifest = await createBackup(target);
  assert.equal(manifest.schema_version, 1); assert.ok(manifest.files.some((item) => item.path.endsWith('id_ed25519'))); assert.ok(!manifest.files.some((item) => item.path === '.lock')); assert.ok(existsSync(join(target, 'manifest.json'))); assert.equal((await validateBackup(target)).files.length, manifest.files.length);
  const pointer = process.platform === 'win32' ? join(process.env.APPDATA, 'AutoGit', 'location.json') : join(process.env.XDG_CONFIG_HOME, 'autogit', 'location.json'); assert.equal(existsSync(pointer), false);
});

test('backup validation rejects traversal, duplicates, missing parents, unsupported versions and changed bytes', async t => {
  const f = await fixture(t); await fixtureData(f); const target = join(f.base, 'backup'); await createBackup(target); const manifestFile = join(target, 'manifest.json'); const original = await fs.readFile(manifestFile); const manifest = JSON.parse(original);
  for (const invalid of [
    { ...manifest, files: [{ ...manifest.files[0], path: '../escape' }] },
    { ...manifest, files: [...manifest.files, { ...manifest.files[0], path: manifest.files[0].path.toUpperCase() }] },
    { ...manifest, directories: [] },
    { ...manifest, schema_version: 2 },
    { ...manifest, app_version: '99.0.0' },
  ]) { await fs.writeFile(manifestFile, JSON.stringify(invalid)); await assert.rejects(validateBackup(target), GitError); }
  await fs.writeFile(manifestFile, '{"schema_version":1,"schema_version":1}'); await assert.rejects(validateBackup(target), GitError); await fs.writeFile(manifestFile, original);
  const changed = join(target, 'files', ...manifest.files[0].path.split('/')); await fs.appendFile(changed, 'tampered'); await assert.rejects(validateBackup(target), /SHA-256/u);
  if (process.platform !== 'win32') { const link = join(target, 'files', 'symlink'); await fs.symlink(changed, link); await assert.rejects(validateBackup(target), /额外文件|符号链接/u); }
});

test('restore requires explicit replacement, supports exact remap, and preserves existing data aside', async t => {
  const f = await fixture(t); await fixtureData(f); const target = join(f.base, 'backup'); await createBackup(target); const root = join(f.base, 'restored'); const data = join(root, 'data');
  await restoreBackup(target, data); assert.equal((await new ProfileStore(data).list()).length, 1);
  await fs.writeFile(join(data, 'keep.txt'), 'keep'); await assert.rejects(restoreBackup(target, data), /明确选择替换/u);
  const restored = await restoreBackup(target, data, { replace: true, pathRemap: { [f.path]: join(f.base, 'new project') }, sshProgram: 'system' });
  assert.ok(restored.previousDataDir); assert.equal(await fs.readFile(join(restored.previousDataDir, 'keep.txt'), 'utf8'), 'keep'); const settings = JSON.parse(await fs.readFile(join(data, 'settings.json'))); assert.equal(settings.last_project, join(f.base, 'new project')); assert.match(await fs.readFile(join(data, 'profiles', 'b'.repeat(32), 'profile.json'), 'utf8'), /schema_version/);
});

test('relocation copies and verifies before context switch, retaining or explicitly deleting the source', async t => {
  const f = await fixture(t); await fixtureData(f); const root = join(f.base, 'moved'); const result = await relocateData(root);
  assert.equal(result.dataDir, join(root, 'data')); assert.equal(appDataDir(), result.dataDir); assert.equal(existsSync(join(f.base, 'AutoGit', 'data', 'profiles')), true);
  resetAppContextForTests(); process.env.AUTOGIT_DATA_DIR = join(f.base, 'AutoGit', 'data'); await configureApp(new ScriptedConsole([])); const root2 = join(f.base, 'moved-two'); const result2 = await relocateData(root2, { deleteSource: true }); assert.equal(result2.dataDir, join(root2, 'data')); assert.equal(existsSync(join(f.base, 'AutoGit', 'data')), false);
});

test('remapDataPaths only changes exact absolute paths and rejects collisions', async t => {
  const f = await fixture(t); await fixtureData(f); const file = join(f.base, 'AutoGit', 'data', 'hosts.json');
  const host = { mode: 'managed-ssh', host: { provider: 'github', host: 'github.com', apiHost: 'api.github.com', webBase: 'https://github.com', sshHost: 'github.com' } };
  await fs.writeFile(file, JSON.stringify({ schema_version: 1, projects: { [f.path]: host } })); const next = join(f.base, 'new'); await remapDataPaths(join(f.base, 'AutoGit', 'data'), { [f.path]: next }); assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(file)).projects), [next]);
  await assert.rejects(remapDataPaths(join(f.base, 'AutoGit', 'data'), { [f.path]: next, [join(f.base, 'other')]: next }), /重复|冲突/u);
});

test('source hardlinks/symlinks, nested targets and active source/restore locks fail without overwrite', async t => {
  const f = await fixture(t); const profile = await fixtureData(f); const source = appDataDir(); const target = join(f.base, 'backup'); const lock = join(source, '.lock');
  await fs.writeFile(lock, 'another writer'); await assert.rejects(createBackup(target), /锁定/u); assert.equal(await fs.readFile(lock, 'utf8'), 'another writer'); await fs.unlink(lock);
  await assert.rejects(createBackup(join(source, 'nested-backup')), /嵌套/u);
  const hard = join(source, 'hard-key'); await fs.link(profile.private_key, hard); await assert.rejects(createBackup(target), /硬链接/u); await fs.unlink(hard); assert.equal(existsSync(target), false);
  if (process.platform !== 'win32') { const link = join(source, 'linked-key'); await fs.symlink(profile.private_key, link); await assert.rejects(createBackup(target), /符号链接/u); await fs.unlink(link); }
  await createBackup(target); const restore = join(f.base, 'restore-data'); await fs.mkdir(restore); await fs.writeFile(join(restore, '.lock'), 'restore writer'); await fs.writeFile(join(restore, 'keep'), 'keep'); await assert.rejects(restoreBackup(target, restore, { replace: true }), /锁定/u); assert.equal(await fs.readFile(join(restore, 'keep'), 'utf8'), 'keep');
});

test('relocation updates only the configured pointer after verified copy, never embeds that pointer or gh token', async t => {
  const f = await fixture(t); await fixtureData(f); delete process.env.AUTOGIT_DATA_DIR; resetAppContextForTests(); await configureApp(new ScriptedConsole([join(f.base, 'AutoGit')]));
  const pointer = process.platform === 'win32' ? join(process.env.APPDATA, 'AutoGit', 'location.json') : join(process.env.XDG_CONFIG_HOME, 'autogit', 'location.json');
  await fs.mkdir(process.env.GH_CONFIG_DIR, { recursive: true }); await fs.writeFile(join(process.env.GH_CONFIG_DIR, 'hosts.yml'), 'FAKE EXTERNAL TOKEN');
  const next = join(f.base, 'pointer-moved'); const result = await relocateData(next); assert.equal(result.persisted, true); assert.equal(JSON.parse(await fs.readFile(pointer)).appRoot, next); assert.equal(existsSync(join(next, 'data', 'location.json')), false); assert.equal(existsSync(join(next, 'data', 'hosts.yml')), false);
});

test('restore explicitly clears old custom SSH executable paths without changing portable profile schema2', async t => {
  const f = await fixture(t); const profile = await fixtureData(f); const metadata = join(appDataDir(), 'profiles', profile.profile_id, 'profile.json'); const encoded = JSON.parse(await fs.readFile(metadata)); encoded.ssh_program = '/missing/previous-computer/ssh'; await fs.writeFile(metadata, JSON.stringify(encoded));
  const backup = join(f.base, 'backup'); await createBackup(backup); const data = join(f.base, 'restored-data'); await restoreBackup(backup, data, { sshProgram: 'system' }); const restored = JSON.parse(await fs.readFile(join(data, 'profiles', profile.profile_id, 'profile.json'))); assert.equal(restored.schema_version, 2); assert.equal(restored.ssh_program, ''); assert.equal(restored.private_key, `profiles/${profile.profile_id}/id_ed25519`);
});

function passwordUi({ secrets = ['fixture-password'], answers = [], onSecret } = {}) {
  const entered = secrets.map((value) => Buffer.from(value)), pending = [...entered];
  let calls = 0;
  const ui = new ScriptedConsole(answers, { secretInput: async () => {
    calls++; assert.ok(pending.length, 'unexpected secret input request');
    const value = pending.shift(); await onSecret?.(value); return value;
  } });
  Object.defineProperty(ui, 'secretCalls', { get: () => calls });
  ui.entered = entered;
  return ui;
}
function realUnlockFailures(t) {
  const failures = [], original = Vault.unlock;
  t.mock.method(Vault, 'unlock', async function(...args) {
    try { return await original.apply(this, args); }
    catch (error) { failures.push(error); throw error; }
  });
  return failures;
}
async function currentVaultSession(t, f, withLegacyProfile = false) {
  setSession(undefined);
  if (withLegacyProfile) await fixtureData(f);
  const password = Buffer.from('fixture-password');
  const created = await Vault.create(appDataDir(), password); password.fill(0);
  const session = new CredentialSession(created.vault);
  setSession(session);
  t.after(async () => { await currentSession()?.close(); setSession(undefined); });
  return session;
}

test('restore decrypts staging with its standalone password before replacement and activates without a second password', async t => {
  const f = await fixture(t); const session = await currentVaultSession(t, f);
  const backup = join(f.base, 'encrypted-backup'); await createBackup(backup);
  const target = join(f.base, 'restored-root', 'data'); const ui = passwordUi();
  const result = await restoreBackup(backup, target, { replace: false, ui, activate: true });
  assert.equal(ui.secretCalls, 1); assert.ok(ui.entered.every(value => value.every(byte => byte === 0)));
  assert.equal(result.activated.dataDir, target); assert.equal(currentSession()?.vault.directory, target); assert.notEqual(currentSession(), session); assert.equal(session.closed, true); assert.equal(await fs.readFile(join(target, 'vault.json')).then(() => true), true);
});

test('three real staging password failures followed by exit never replace target or close the protected session', async t => {
  const f = await fixture(t); const session = await currentVaultSession(t, f);
  const backup = join(f.base, 'encrypted-backup'); await createBackup(backup);
  const before = await fs.readFile(join(backup, 'files', 'vault.json'));
  const target = join(f.base, 'existing-root', 'data'); await fs.mkdir(target, { recursive: true }); await fs.writeFile(join(target, 'keep.txt'), 'fixture-old-target');
  const ui = passwordUi({ secrets: Array(3).fill('wrong-fixture-password'), answers: ['1', '1', '0'] }), failures = realUnlockFailures(t);
  await assert.rejects(restoreBackup(backup, target, { replace: true, ui, activate: true }), Cancelled);
  assert.equal(failures.length, 3); assert.ok(failures.every(error => error instanceof VaultUnlockError));
  assert.equal(ui.secretCalls, 3); assert.deepEqual(ui.answers, []); assert.ok(ui.entered.every(value => value.every(byte => byte === 0)));
  assert.deepEqual(await fs.readFile(join(backup, 'files', 'vault.json')), before);
  assert.equal(await fs.readFile(join(target, 'keep.txt'), 'utf8'), 'fixture-old-target'); assert.deepEqual(await fs.readdir(target), ['keep.txt']); assert.equal(currentSession(), session); assert.equal(session.closed, false);
});

test('cryptographic staging validation rejects tampered ciphertext even when backup SHA-256 is consistent', async t => {
  const f = await fixture(t); const session = await currentVaultSession(t, f); const secret = Buffer.from('fixture-encrypted-value'); await session.vault.put('fixture:record', secret); secret.fill(0);
  const backup = join(f.base, 'tampered-backup'); await createBackup(backup);
  const vaultFile = join(backup, 'files', 'vault.json'); const vaultDocument = JSON.parse(await fs.readFile(vaultFile)); const tag = Buffer.from(vaultDocument.records[0].tag, 'base64'); tag[0] ^= 1; vaultDocument.records[0].tag = tag.toString('base64'); const bytes = Buffer.from(JSON.stringify(vaultDocument)); await fs.writeFile(vaultFile, bytes);
  const manifestFile = join(backup, 'manifest.json'); const manifest = JSON.parse(await fs.readFile(manifestFile)); const entry = manifest.files.find(item => item.path === 'vault.json'); entry.size = bytes.length; entry.sha256 = createHash('sha256').update(bytes).digest('hex'); await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const target = join(f.base, 'unchanged-target', 'data'); await fs.mkdir(target, { recursive: true }); await fs.writeFile(join(target, 'keep.txt'), 'fixture-before');
  await assert.rejects(restoreBackup(backup, target, { replace: true, ui: passwordUi(), activate: true }), /完整性/u);
  assert.equal(await fs.readFile(join(target, 'keep.txt'), 'utf8'), 'fixture-before'); assert.deepEqual(await fs.readdir(target), ['keep.txt']); assert.equal(currentSession(), session); assert.equal(session.closed, false);
  const stillReadable = await session.vault.get('fixture:record'); assert.equal(stillReadable.toString(), 'fixture-encrypted-value'); stillReadable.fill(0);
});

test('a managed-key marker without a decryptable vault record cannot replace a restore target', async t => {
  const f = await fixture(t); setSession(undefined); const profile = await fixtureData(f); await fs.writeFile(profile.private_key, managedKeyMarker(profile.profile_id));
  const password = Buffer.from('fixture-password'); const created = await Vault.create(appDataDir(), password); password.fill(0); const session = new CredentialSession(created.vault); setSession(session); t.after(async () => { await currentSession()?.close(); setSession(undefined); });
  const backup = join(f.base, 'missing-record-backup'); await createBackup(backup); const target = join(f.base, 'missing-record-target', 'data'); await fs.mkdir(target, { recursive: true }); await fs.writeFile(join(target, 'keep.txt'), 'fixture-before');
  await assert.rejects(restoreBackup(backup, target, { replace: true, ui: passwordUi(), activate: true }), /可解密凭据/u);
  assert.equal(await fs.readFile(join(target, 'keep.txt'), 'utf8'), 'fixture-before'); assert.equal(currentSession(), session); assert.equal(session.closed, false);
});

test('restore without an interactive verifier accepts only a verified copy of the currently unlocked vault', async t => {
  const f = await fixture(t); const original = await currentVaultSession(t, f); const backup = join(f.base, 'same-copy-backup'); await createBackup(backup); const first = join(f.base, 'same-copy'); await restoreBackup(backup, first); assert.equal(currentSession(), original);
  const password = Buffer.from('fixture-password'); const directory = join(f.base, 'different-current', 'data'); const created = await Vault.create(directory, password); password.fill(0); const other = new CredentialSession(created.vault); setSession(other); await original.close(); await configureApp(new ScriptedConsole([]), { dataDir: directory });
  const target = join(f.base, 'different-target', 'data'); await fs.mkdir(target, { recursive: true }); await fs.writeFile(join(target, 'keep.txt'), 'fixture-before');
  await assert.rejects(restoreBackup(backup, target, { replace: true }), /不是当前已解锁/u);
  assert.equal(await fs.readFile(join(target, 'keep.txt'), 'utf8'), 'fixture-before'); assert.equal(currentSession(), other); assert.equal(other.closed, false);
});

test('a location commit failure rolls installed restore data back and never drops the old protected session', async t => {
  const f = await fixture(t); delete process.env.AUTOGIT_DATA_DIR; resetAppContextForTests(); const first = join(f.base, 'pointer-source'); await configureApp(new ScriptedConsole([first])); const session = await currentVaultSession(t, f); const backup = join(f.base, 'pointer-backup'); await createBackup(backup);
  const pointer = process.platform === 'win32' ? join(process.env.APPDATA, 'AutoGit', 'location.json') : join(process.env.XDG_CONFIG_HOME, 'autogit', 'location.json'); const target = join(f.base, 'pointer-target', 'data'); await fs.mkdir(target, { recursive: true }); await fs.writeFile(join(target, 'keep.txt'), 'fixture-before');
  const ui = passwordUi({ onSecret: async () => { await fs.writeFile(pointer, 'fixture-broken-pointer'); } });
  await assert.rejects(restoreBackup(backup, target, { replace: true, ui, activate: true }), /损坏/u);
  assert.equal(await fs.readFile(join(target, 'keep.txt'), 'utf8'), 'fixture-before'); assert.deepEqual(await fs.readdir(target), ['keep.txt']); assert.equal(appDataDir(), join(first, 'data')); assert.equal(currentSession(), session); assert.equal(session.closed, false); assert.equal(await fs.readFile(pointer, 'utf8'), 'fixture-broken-pointer');
});

test('a separately encrypted restored vault uses its own distinct staging password and activates with one prompt', async t => {
  const f = await fixture(t); const original = await currentVaultSession(t, f); const source = join(f.base, 'foreign-source', 'data'); const password = Buffer.from('independent-restore-password'); const foreign = await Vault.create(source, password); password.fill(0); const record = Buffer.from('fixture-foreign-record'); await foreign.vault.put('fixture:foreign', record); record.fill(0); foreign.vault.close(); const backup = join(f.base, 'foreign-backup'); await createBackup(backup, source);
  const target = join(f.base, 'foreign-target', 'data'); const ui = passwordUi({ secrets: ['independent-restore-password'] }); const result = await restoreBackup(backup, target, { ui, activate: true });
  assert.equal(ui.secretCalls, 1); assert.ok(ui.entered.every(value => value.every(byte => byte === 0))); assert.equal(result.activated.dataDir, target); assert.equal(original.closed, true); assert.equal(currentSession().vault.directory, target); const value = await currentSession().vault.get('fixture:foreign'); assert.equal(value.toString(), 'fixture-foreign-record'); value.fill(0);
});

test('encrypted backup with no live session requires UI verification and rejects three real wrong passwords before installation', async t => {
  const f = await fixture(t), original = await currentVaultSession(t, f);
  await original.vault.put('fixture:restored', Buffer.from('synthetic-restored-value'));
  const backup = join(f.base, 'no-active-backup'); await createBackup(backup); await original.close();
  const target = join(f.base, 'no-active-target', 'data'); await fs.mkdir(target, { recursive: true }); await fs.writeFile(join(target, 'keep.txt'), 'preserve-before-unlock');
  const failures = realUnlockFailures(t), denied = passwordUi({ secrets: Array(3).fill('wrong-fixture-password'), answers: ['1', '1', '0'] });
  await assert.rejects(restoreBackup(backup, target, { replace: true, ui: denied, activate: true }), Cancelled);
  assert.equal(failures.length, 3); assert.ok(failures.every(error => error instanceof VaultUnlockError)); assert.equal(currentSession(), undefined);
  assert.deepEqual(await fs.readdir(target), ['keep.txt']); assert.equal(await fs.readFile(join(target, 'keep.txt'), 'utf8'), 'preserve-before-unlock');
  const accepted = passwordUi(); await restoreBackup(backup, target, { replace: true, ui: accepted, activate: true });
  assert.equal(accepted.secretCalls, 1); assert.equal(currentSession().vault.directory, target);
  const value = await currentSession().vault.get('fixture:restored'); try { assert.equal(value.toString(), 'synthetic-restored-value'); } finally { value.fill(0); }
});

test('an independent encrypted backup cannot be installed without UI or a matching live DEK', async t => {
  const f = await fixture(t), session = await currentVaultSession(t, f);
  const backup = join(f.base, 'locked-backup'); await createBackup(backup); await session.close();
  const target = join(f.base, 'locked-target', 'data'); await fs.mkdir(target, { recursive: true }); await fs.writeFile(join(target, 'keep.txt'), 'locked-target-unchanged');
  await assert.rejects(restoreBackup(backup, target, { replace: true }), /解锁|验证|凭据会话/u);
  assert.equal(currentSession(), undefined); assert.deepEqual(await fs.readdir(target), ['keep.txt']); assert.equal(await fs.readFile(join(target, 'keep.txt'), 'utf8'), 'locked-target-unchanged');
});

test('mixed schema 2 SSH and schema 3 HTTPS-only encrypted backup restore remaps strict snapshots without rewriting profile metadata', async t => {
  const f = await fixture(t), session = await currentVaultSession(t, f, true);
  const store = new ProfileStore(), ssh = (await store.list())[0];
  await fs.writeFile(ssh.private_key, managedKeyMarker(ssh.profile_id));
  await session.vault.put(`ssh:${ssh.profile_id}`, Buffer.from('synthetic-encrypted-SSH-record'));
  const https = await store.createHttps(new ScriptedConsole(['y']), 'https-fixture', 'HTTPS Fixture', 'https@example.invalid', 'fixture');
  await session.storeToken('github.com', https.github_login, Buffer.from('synthetic-shared-backup-token'));
  const transport = { mode: 'https', host: { ...DEFAULT_HOST } };
  await new HostStore().set(f.path, transport); await store.bind(f.path, https.profile_id, transport);
  const sshMetadata = join(store.profilesDir, ssh.profile_id, 'profile.json'), httpsMetadata = join(store.profilesDir, https.profile_id, 'profile.json');
  const beforeSsh = await fs.readFile(sshMetadata), beforeHttps = await fs.readFile(httpsMetadata), beforeKnown = await fs.readFile(join(store.directory, 'known_hosts'));
  const backup = join(f.base, 'mixed-profile-backup'), manifest = await createBackup(backup);
  assert.equal(manifest.files.filter(item => item.path.startsWith(`profiles/${https.profile_id}/`)).length, 1);
  const project = join(f.base, 'remapped HTTPS project'); await fs.mkdir(project); await new Git(project).run(['init', '--initial-branch=main']);
  const target = join(f.base, 'mixed-restored', 'data');
  await restoreBackup(backup, target, { pathRemap: { [f.path]: project }, sshProgram: 'system' });
  assert.deepEqual(await fs.readFile(join(target, 'profiles', ssh.profile_id, 'profile.json')), beforeSsh);
  assert.deepEqual(await fs.readFile(join(target, 'profiles', https.profile_id, 'profile.json')), beforeHttps);
  assert.deepEqual(await fs.readFile(join(target, 'known_hosts')), beforeKnown);
  const bindings = JSON.parse(await fs.readFile(join(target, 'bindings.json')));
  assert.equal(bindings.schema_version, 2); assert.deepEqual(Object.keys(bindings.bindings), [process.platform === 'win32' ? project.toLowerCase() : project]);
  assert.equal(Object.values(bindings.bindings)[0].snapshot.schema_version, 3);
  assert.equal(Object.values(bindings.bindings)[0].snapshot.private_key, null);
  await session.close();
  const password = Buffer.from('fixture-password'); let restored;
  try { restored = new CredentialSession(await Vault.unlock(target, password)); } finally { password.fill(0); }
  setSession(restored);
  const loaded = await new ProfileStore(target).resolveBinding(project);
  assert.equal(loaded.profile_id, https.profile_id); assert.equal(loaded.private_key, null); assert.equal(loaded.public_key, null);
  const token = await restored.getToken('github.com', https.github_login);
  try { assert.equal(token.toString(), 'synthetic-shared-backup-token'); } finally { token.fill(0); }
  assert.equal((await new ProfileStore(target).load(ssh.profile_id)).schema_version, 2);
  assert.deepEqual(await fs.readdir(join(target, 'profiles', https.profile_id)), ['profile.json']);
});

test('HTTPS-only relocation verifies a real encrypted Token, retains keyless schema and creates no SSH artifacts', async t => {
  const f = await fixture(t), session = await currentVaultSession(t, f), store = new ProfileStore();
  const profile = await store.createHttps(new ScriptedConsole(['y']), 'relocate-keyless', 'HTTPS User', 'https@example.invalid', 'https-user');
  await session.storeToken('github.com', profile.github_login, Buffer.from('synthetic-relocated-token'));
  const transport = { mode: 'https', host: { ...DEFAULT_HOST } };
  await new HostStore().set(f.path, transport); await store.bind(f.path, profile.profile_id, transport);
  const metadata = await fs.readFile(join(store.profilesDir, profile.profile_id, 'profile.json'));
  const root = join(f.base, 'keyless-relocated'), result = await relocateData(root);
  assert.equal(result.dataDir, join(root, 'data')); assert.equal(session.closed, true);
  assert.equal(currentSession().vault.directory, result.dataDir);
  const moved = await new ProfileStore().resolveBinding(f.path);
  assert.equal(moved.schema_version, 3); assert.equal(moved.private_key, null); assert.equal(moved.public_key, null);
  assert.deepEqual(await fs.readFile(join(result.dataDir, 'profiles', profile.profile_id, 'profile.json')), metadata);
  assert.equal(existsSync(join(result.dataDir, 'known_hosts')), false);
  assert.equal(existsSync(join(root, '.autogit-sessions')), false);
  assert.deepEqual(await fs.readdir(join(result.dataDir, 'profiles', profile.profile_id)), ['profile.json']);
  const token = await currentSession().getToken('github.com', profile.github_login);
  try { assert.equal(token.toString(), 'synthetic-relocated-token'); } finally { token.fill(0); }
});

test('HTTPS-only backup with a lost vault is not accepted as a portable legacy SSH store', async t => {
  const f = await fixture(t), session = await currentVaultSession(t, f), store = new ProfileStore();
  const profile = await store.createHttps(new ScriptedConsole(['y']), 'lost-vault', 'HTTPS User', 'https@example.invalid', 'https-user');
  const file = join(store.profilesDir, profile.profile_id, 'profile.json'), before = await fs.readFile(file);
  await session.close(); await fs.unlink(join(store.directory, 'vault.json'));
  await assert.rejects(createBackup(join(f.base, 'missing-keyless-vault-backup')), /vault\.json 缺失/u);
  assert.deepEqual(await fs.readFile(file), before); assert.equal(existsSync(join(store.directory, 'vault.json')), false);
});

test('backup menu refuses to continue as a legacy menu if its protected session closes', async t => {
  const f = await fixture(t); const session = await currentVaultSession(t, f); let prompts = 0;
  await assert.rejects(backupMenu({ async menu() { prompts++; await session.close(); return 0; } }), /凭据会话已锁定/u);
  assert.equal(prompts, 1); assert.equal(currentSession(), undefined);
});

test('staging migration cancellation never replaces target or enables an unprotected legacy copy', async t => {
  const f = await fixture(t); setSession(undefined); await fixtureData(f); const password = Buffer.from('fixture-password'); const created = await Vault.create(appDataDir(), password); password.fill(0);
  const backup = join(f.base, 'legacy-encrypted-backup'); await createBackup(backup); const session = new CredentialSession(created.vault); setSession(session); t.after(async () => { await currentSession()?.close(); setSession(undefined); });
  const target = join(f.base, 'legacy-target', 'data'); await fs.mkdir(target, { recursive: true }); await fs.writeFile(join(target, 'keep.txt'), 'fixture-old-target'); const ui = passwordUi({ answers: ['n'] });
  await assert.rejects(restoreBackup(backup, target, { replace: true, ui, activate: true }), /未迁移旧私钥/u);
  assert.equal(ui.secretCalls, 1); assert.equal(await fs.readFile(join(target, 'keep.txt'), 'utf8'), 'fixture-old-target'); assert.equal(currentSession(), session); assert.equal(session.closed, false);
});
