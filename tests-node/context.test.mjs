import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configureApp, commitConfiguredApp, appDataDir, appRoot, resolveApp, changeAppDirectory, activateUnlockedDirectory, resetAppContextForTests } from '../dist/app-context.js';
import { loadPreferences, savePreferences, startup, settingsMenu, DEFAULTS } from '../dist/preferences.js';
import { GitError } from '../dist/git.js';
import { fixture, ScriptedConsole } from './support.mjs';
import { Vault, VaultUnlockError } from '../dist/vault.js';
import { CredentialSession, currentSession, setSession } from '../dist/session.js';
import { Cancelled } from '../dist/ui.js';

function noOverrides() { delete process.env.AUTOGIT_DATA_DIR; resetAppContextForTests(); }
function pointer(f) { return process.platform === 'win32' ? join(process.env.APPDATA, 'AutoGit', 'location.json') : join(process.env.XDG_CONFIG_HOME, 'autogit', 'location.json'); }

test('unconfigured access requires explicit data, never assumes the current project is software root', async (t) => {
  const f = await fixture(t); const override = process.env.AUTOGIT_DATA_DIR;
  assert.equal(appDataDir(), override); assert.equal(existsSync(override), false);
  noOverrides(); assert.throws(() => appDataDir(), /尚未配置/u); assert.notEqual(resolveApp().appRoot, f.path); assert.equal(existsSync(pointer(f)), false);
});

test('first configuration asks for home/AutoGit and writes only the minimal schema 1 pointer', async (t) => {
  const f = await fixture(t); noOverrides(); const ui = new ScriptedConsole(['']); await configureApp(ui);
  assert.equal(appRoot(), join(f.home, 'AutoGit')); assert.equal(appDataDir(), join(f.home, 'AutoGit', 'data')); assert.match(ui.transcript, /软件根目录/u);
  assert.deepEqual(JSON.parse(await fs.readFile(pointer(f), 'utf8')), { schema_version: 1, appRoot: join(f.home, 'AutoGit') }); assert.equal(existsSync(appDataDir()), false);
  resetAppContextForTests(); await configureApp(new ScriptedConsole([])); assert.equal(appRoot(), join(f.home, 'AutoGit'));
});

test('custom first root survives restart and explicit flags never read or overwrite pointers', async (t) => {
  const f = await fixture(t); noOverrides(); const root = join(f.base, 'portable 软件'); await configureApp(new ScriptedConsole([root])); const file = pointer(f); const original = await fs.readFile(file, 'utf8');
  const other = join(f.base, 'override 软件'); process.env.AUTOGIT_DATA_DIR = join(f.base, 'environment-data'); resetAppContextForTests(); await configureApp(new ScriptedConsole([]), { appDir: other }); assert.equal(appRoot(), other); assert.equal(appDataDir(), join(other, 'data')); assert.equal(await fs.readFile(file, 'utf8'), original);
  await configureApp(new ScriptedConsole([]), { appDir: other, dataDir: join(f.base, 'explicit-data') }); assert.equal(appDataDir(), join(f.base, 'explicit-data'));
  resetAppContextForTests(); await configureApp(new ScriptedConsole([])); assert.equal(appDataDir(), process.env.AUTOGIT_DATA_DIR);
  noOverrides(); await configureApp(new ScriptedConsole([])); assert.equal(appRoot(), root);
});

test('configure environment injection stays isolated and leaves personal locations untouched', async (t) => {
  const f = await fixture(t); noOverrides(); const isolatedHome = join(f.base, 'isolated-home'); await fs.mkdir(isolatedHome); const config = join(isolatedHome, 'config'); const appdata = join(isolatedHome, 'roaming');
  await configureApp(new ScriptedConsole(['']), { env: { HOME: isolatedHome, USERPROFILE: isolatedHome, XDG_CONFIG_HOME: config, APPDATA: appdata } }); assert.equal(appDataDir(), join(isolatedHome, 'AutoGit', 'data')); assert.equal(existsSync(pointer(f)), false); assert.equal(existsSync(join(f.home, '.ssh')), false); assert.equal(existsSync(join(f.home, '.gitconfig')), false);
});

test('corrupt/duplicate location JSON fails without being overwritten, explicit app-dir bypasses it', async (t) => {
  const f = await fixture(t); noOverrides(); const file = pointer(f); await fs.mkdir(dirname(file), { recursive: true });
  for (const raw of ['null', 'broken', '{"schema_version":1,"schema_version":1,"appRoot":"/tmp"}', JSON.stringify({ schema_version: 1, appRoot: f.base, extra: 'no' }), JSON.stringify({ schema_version: true, appRoot: f.base }), JSON.stringify({ schema_version: 1, appRoot: 'relative' })]) {
    await fs.writeFile(file, raw); await assert.rejects(configureApp(new ScriptedConsole([])), GitError); assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
  await configureApp(new ScriptedConsole([]), { appDir: join(f.base, 'rescue') }); assert.equal(appDataDir(), join(f.base, 'rescue', 'data')); assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify({ schema_version: 1, appRoot: 'relative' }));
});

test('unsafe app roots and symlink pointers are rejected before any data is created', async (t) => {
  const f = await fixture(t); noOverrides();
  for (const root of ['relative', '', join(f.base, '..', 'unsafe') + '/..', `${f.base}"`, `${f.base}%h`, `${f.base}\n`]) await assert.rejects(configureApp(new ScriptedConsole([]), { appDir: root }), GitError);
  const target = join(f.base, 'file'); await fs.writeFile(target, '{}'); await assert.rejects(configureApp(new ScriptedConsole([]), { appDir: target }), GitError);
  if (process.platform !== 'win32') { const file = pointer(f); await fs.mkdir(dirname(file), { recursive: true }); await fs.symlink(target, file); await assert.rejects(configureApp(new ScriptedConsole([])), /符号链接/u); }
});

test('software directory switching retains old data and only persists pointers in pointer mode', async (t) => {
  const f = await fixture(t); noOverrides(); const first = join(f.base, 'first'); await configureApp(new ScriptedConsole([first])); await savePreferences({ last_project: f.path }); const oldSettings = await fs.readFile(join(appDataDir(), 'settings.json'));
  const second = join(f.base, 'second'); assert.equal(await changeAppDirectory(new ScriptedConsole([second, 'n'])), false); assert.equal(appDataDir(), join(first, 'data'));
  await fs.mkdir(join(second, 'data'), { recursive: true }); await fs.writeFile(join(second, 'data', 'settings.json'), JSON.stringify({ schema_version: 1, interaction_mode: 'confirm', notice_version: 1, last_project: '' }));
  const switched = new ScriptedConsole(['4', second, 'y']); await settingsMenu(switched); assert.equal(appDataDir(), join(second, 'data')); assert.equal(switched.quick, false); assert.deepEqual(JSON.parse(await fs.readFile(pointer(f), 'utf8')), { schema_version: 1, appRoot: second }); assert.deepEqual(await fs.readFile(join(first, 'data', 'settings.json')), oldSettings);
  const pointerBefore = await fs.readFile(pointer(f)); await configureApp(new ScriptedConsole([]), { appDir: first }); const transient = new ScriptedConsole([second, 'y']); assert.equal(await changeAppDirectory(transient), true); assert.deepEqual(await fs.readFile(pointer(f)), pointerBefore); assert.match(transient.transcript, /仅切换本次会话/u);
});

test('software/data directories cannot live inside npm installations or npx cache', async (t) => {
  const f = await fixture(t); noOverrides();
  for (const component of ['node_modules', '_npx']) {
    const directory = join(f.base, component, 'autogit'); await assert.rejects(configureApp(new ScriptedConsole([]), { appDir: directory }), /不能放在 node_modules/u); await assert.rejects(configureApp(new ScriptedConsole([]), { dataDir: directory }), GitError);
    process.env.AUTOGIT_DATA_DIR = directory; assert.throws(() => appDataDir(), GitError); delete process.env.AUTOGIT_DATA_DIR;
  }
});

test('preferences preserve schema 1 legacy field names and startup notice is shown exactly once', async (t) => {
  const f = await fixture(t); assert.deepEqual(await loadPreferences(), DEFAULTS); assert.equal(existsSync(appDataDir()), false);
  const ui = new ScriptedConsole([]); const data = await startup(ui); assert.equal(ui.quick, true); assert.equal(data.notice_version, 1); assert.match(ui.transcript, /SSH and GPG keys/u); assert.match(ui.transcript, /免口令/u);
  const second = new ScriptedConsole([]); await startup(second); assert.doesNotMatch(second.transcript, /若文件夹泄露/u);
  await savePreferences({ last_project: f.path }); await settingsMenu(new ScriptedConsole(['2'])); assert.equal((await loadPreferences()).interaction_mode, 'confirm'); assert.equal((await loadPreferences()).last_project, f.path);
  const settings = JSON.parse(await fs.readFile(join(appDataDir(), 'settings.json'), 'utf8')); assert.deepEqual(Object.keys(settings).sort(), ['schema_version', 'interaction_mode', 'notice_version', 'last_project'].sort());
  const next = new ScriptedConsole([]); await startup(next); assert.equal(next.quick, false);
});

test('corrupt and unknown preferences never get silently replaced; lock collisions preserve files', async (t) => {
  await fixture(t); await savePreferences({ last_project: 'remembered' }); const file = join(appDataDir(), 'settings.json');
  for (const raw of ['null', 'bad json', '{"schema_version":1}', '{"schema_version":1,"interaction_mode":"quick","notice_version":0,"last_project":"x","last_project":"y"}', JSON.stringify({ ...DEFAULTS, interaction_mode: [] }), JSON.stringify({ ...DEFAULTS, notice_version: true }), JSON.stringify({ ...DEFAULTS, token: 'no' })]) {
    await fs.writeFile(file, raw); await assert.rejects(loadPreferences(), GitError); await assert.rejects(savePreferences({ interaction_mode: 'confirm' }), GitError); assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
  await fs.writeFile(file, JSON.stringify(DEFAULTS)); await assert.rejects(savePreferences({ token: 'must not persist' }), /未知/u); const lock = join(appDataDir(), '.lock'); await fs.writeFile(lock, 'another writer'); await assert.rejects(savePreferences({ last_project: 'changed' }), /锁定/u); assert.equal(await fs.readFile(lock, 'utf8'), 'another writer'); assert.deepEqual(await loadPreferences(), DEFAULTS);
});

test('switching an existing library decrypts its standalone vault but refuses unmigrated legacy keys', async (t) => {
  const f = await fixture(t); noOverrides(); const first = join(f.base, 'first-secure'); await configureApp(new ScriptedConsole([first]));
  const profile = { profile_id: 'c'.repeat(32), label: 'legacy', name: 'Fixture User', email: 'fixture@example.invalid', github_login: 'fixture-login', private_key: join(appDataDir(), 'profiles', 'c'.repeat(32), 'id_ed25519'), public_key: join(appDataDir(), 'profiles', 'c'.repeat(32), 'id_ed25519.pub') };
  await fs.mkdir(dirname(profile.private_key), { recursive: true }); await fs.writeFile(profile.private_key, 'FIXTURE LEGACY KEY'); await fs.writeFile(profile.public_key, 'ssh-ed25519 AAAAfixture\n'); await fs.writeFile(join(dirname(profile.private_key), 'profile.json'), JSON.stringify({ schema_version: 2, ...profile, ssh_program: '', status: 'unverified', remember_auth: true, private_key: `profiles/${profile.profile_id}/id_ed25519`, public_key: `profiles/${profile.profile_id}/id_ed25519.pub` }));
  if (process.platform !== 'win32') await fs.chmod(appDataDir(), 0o700);
  const password = Buffer.from('fixture-password'); const created = await Vault.create(appDataDir(), password); password.fill(0); const session = new CredentialSession(created.vault); setSession(session); t.after(async () => { await currentSession()?.close(); setSession(undefined); });
  const second = join(f.base, 'second-secure'); await fs.cp(first, second, { recursive: true }); const answers = [second, 'y', 'n'];
  const interactive = new ScriptedConsole(answers, { secretInput: async () => Buffer.from('fixture-password') });
  await assert.rejects(changeAppDirectory(interactive), /未迁移旧私钥/u);
  assert.equal(appRoot(), first); assert.equal(currentSession(), session); assert.equal(session.closed, false); assert.deepEqual(JSON.parse(await fs.readFile(pointer(f), 'utf8')).appRoot, first);
});

test('three real target Vault password failures then exit leave the remembered location and protected session unchanged', async (t) => {
  const f = await fixture(t); noOverrides(); const first = join(f.base, 'first-password'); await configureApp(new ScriptedConsole([first]));
  const password = Buffer.from('fixture-password'); const created = await Vault.create(appDataDir(), password); password.fill(0);
  const session = new CredentialSession(created.vault); setSession(session); t.after(async () => { await currentSession()?.close(); setSession(undefined); });
  const second = join(f.base, 'second-password'); await fs.cp(first, second, { recursive: true });
  const pointerBefore = await fs.readFile(pointer(f)), vaultBefore = await fs.readFile(join(second, 'data', 'vault.json'));
  const inputs = Array.from({ length: 3 }, () => Buffer.from('wrong-fixture-password')), pending = [...inputs], failures = [], unlock = Vault.unlock;
  t.mock.method(Vault, 'unlock', async function(...args) {
    try { return await unlock.apply(this, args); } catch (error) { failures.push(error); throw error; }
  });
  const ui = new ScriptedConsole([second, 'y', '1', '1', '0'], { secretInput: async () => { assert.ok(pending.length); return pending.shift(); } });
  await assert.rejects(changeAppDirectory(ui), Cancelled);
  assert.equal(failures.length, 3); assert.ok(failures.every(error => error instanceof VaultUnlockError)); assert.deepEqual(pending, []); assert.deepEqual(ui.answers, []);
  assert.ok(inputs.every(value => value.every(byte => byte === 0))); assert.deepEqual(await fs.readFile(pointer(f)), pointerBefore); assert.deepEqual(await fs.readFile(join(second, 'data', 'vault.json')), vaultBefore);
  assert.equal(appRoot(), first); assert.equal(currentSession(), session); assert.equal(session.closed, false);
});

test('switching to an independently encrypted target asks its distinct password, commits it and closes the old session', async (t) => {
  const f = await fixture(t); noOverrides(); const first = join(f.base, 'secure-first'); await configureApp(new ScriptedConsole([first]));
  const password = Buffer.from('fixture-password'); const created = await Vault.create(appDataDir(), password); password.fill(0);
  const session = new CredentialSession(created.vault); setSession(session); t.after(async () => { await currentSession()?.close(); setSession(undefined); });
  const second = join(f.base, 'secure-second'), targetPassword = Buffer.from('independent-target-password');
  const target = await Vault.create(join(second, 'data'), targetPassword); targetPassword.fill(0); await target.vault.put('fixture:target', Buffer.from('fixture-target-record')); target.vault.close();
  let calls = 0; const entered = Buffer.from('independent-target-password');
  const ui = new ScriptedConsole([second, 'y'], { secretInput: () => { calls++; return entered; } });
  assert.equal(await changeAppDirectory(ui), true); assert.equal(calls, 1); assert.deepEqual(ui.answers, []); assert.ok(entered.every(byte => byte === 0));
  assert.equal(appRoot(), second); assert.equal(appDataDir(), join(second, 'data')); assert.equal(session.closed, true); assert.equal(currentSession().vault.directory, join(second, 'data')); assert.equal(JSON.parse(await fs.readFile(pointer(f))).appRoot, second);
  const value = await currentSession().vault.get('fixture:target'); assert.equal(value.toString(), 'fixture-target-record'); value.fill(0);
});

test('switching to a missing library requires explicit creation before new-password input and preserves the old library on decline', async t => {
  const f = await fixture(t); noOverrides(); const first = join(f.base, 'create-source'); await configureApp(new ScriptedConsole([first]));
  const created = await Vault.create(appDataDir(), Buffer.from('source-fixture-password'));
  const session = new CredentialSession(created.vault); setSession(session); t.after(async () => { await currentSession()?.close(); await session.close(); setSession(undefined); });
  const second = join(f.base, 'create-target'), before = await fs.readFile(pointer(f));
  const declined = new ScriptedConsole([second, 'y', 'n'], { secretInput: () => assert.fail('declined creation must not prompt for a password') });
  assert.equal(await changeAppDirectory(declined), false); assert.deepEqual(declined.answers, []);
  assert.deepEqual(await fs.readFile(pointer(f)), before); await assert.rejects(fs.stat(second), { code: 'ENOENT' }); assert.equal(currentSession(), session); assert.equal(session.closed, false);
  const entered = [Buffer.from('new-independent-password'), Buffer.from('new-independent-password')], pending = [...entered];
  const accepted = new ScriptedConsole([second, 'y', 'y', 'y'], { secretInput: () => { assert.ok(pending.length); return pending.shift(); } });
  assert.equal(await changeAppDirectory(accepted), true); assert.deepEqual(accepted.answers, []); assert.deepEqual(pending, []); assert.ok(entered.every(value => value.every(byte => byte === 0)));
  assert.equal(session.closed, true); assert.equal(currentSession().vault.directory, join(second, 'data')); assert.equal(JSON.parse(await fs.readFile(pointer(f))).appRoot, second);
  assert.equal((await fs.stat(join(first, 'data', 'vault.json'))).isFile(), true); assert.equal((await fs.stat(join(second, 'data', 'vault.json'))).isFile(), true);
});

test('activateUnlockedDirectory verifies a distinct target password without an OS authenticator', async t => {
  const f = await fixture(t); noOverrides(); const first = join(f.base, 'activate-source'); await configureApp(new ScriptedConsole([first]));
  const created = await Vault.create(appDataDir(), Buffer.from('source-fixture-password'));
  const session = new CredentialSession(created.vault); setSession(session); t.after(async () => { await currentSession()?.close(); await session.close(); setSession(undefined); });
  const next = join(f.base, 'activate-target'), target = await Vault.create(join(next, 'data'), Buffer.from('target-fixture-password')); target.vault.close();
  const input = Buffer.from('target-fixture-password'), ui = new ScriptedConsole([], { secretInput: () => input });
  const result = await activateUnlockedDirectory(ui, next);
  assert.equal(result.dataDir, join(next, 'data')); assert.equal(result.persisted, true); assert.equal(appRoot(), next); assert.equal(session.closed, true);
  assert.equal(currentSession().vault.directory, join(next, 'data')); assert.equal(JSON.parse(await fs.readFile(pointer(f))).appRoot, next); assert.ok(input.every(byte => byte === 0));
});

test('a failure after the old session closes cannot fall back to an unprotected menu session', async (t) => {
  const f = await fixture(t); noOverrides(); const first = join(f.base, 'closed-first'); await configureApp(new ScriptedConsole([first])); const password = Buffer.from('fixture-password'); const created = await Vault.create(appDataDir(), password); password.fill(0); const session = new CredentialSession(created.vault); setSession(session); t.after(async () => { await currentSession()?.close(); setSession(undefined); });
  const second = join(f.base, 'closed-second'); await fs.cp(first, second, { recursive: true }); const originalClose = session.close.bind(session); session.close = async () => { await originalClose(); throw new GitError('fixture-close-failed'); }; const ui = new ScriptedConsole([second, 'y'], { secretInput: () => Buffer.from('fixture-password') });
  await assert.rejects(changeAppDirectory(ui), /fixture-close-failed/u); assert.equal(currentSession(), undefined); assert.equal(session.closed, true); assert.equal(appRoot(), first); assert.equal(JSON.parse(await fs.readFile(pointer(f))).appRoot, first);
});

test('code-only workflow driver accepts piped first-root input, while help/version never configure locations', async (t) => {
  const f = await fixture(t); noOverrides(); const root = join(f.base, 'pipe 软件');
  const cli = fileURLToPath(new URL('./cli-driver.mjs', import.meta.url));
  for (const flag of ['--help', '--version']) {
    const result = spawnSync(process.execPath, [cli, flag], { cwd: f.path, env: { ...process.env }, input: '', encoding: 'utf8', timeout: 10_000 }); assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(pointer(f)), false); assert.equal(existsSync(root), false);
  }
  const result = spawnSync(process.execPath, [cli], { cwd: f.path, env: { ...process.env }, input: `${root}\n0\n`, encoding: 'utf8', timeout: 10_000 }); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(await fs.readFile(pointer(f), 'utf8')), { schema_version: 1, appRoot: root }); assert.equal(existsSync(join(f.path, 'data')), false);
});
