import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createBackup, validateBackup, restoreBackup, relocateData, remapDataPaths } from '../dist/backup.js';
import { appDataDir, configureApp, resetAppContextForTests } from '../dist/app-context.js';
import { savePreferences } from '../dist/preferences.js';
import { Profile, ProfileStore } from '../dist/profiles.js';
import { GitError } from '../dist/git.js';
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
