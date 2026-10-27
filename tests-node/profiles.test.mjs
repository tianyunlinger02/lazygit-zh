import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Git, GitError } from '../dist/git.js';
import { which } from '../dist/process.js';
import { Profile, ProfileStore, boundGit, profileGit, chooseProfile, bindProject, buildSshArgs, buildSshCommand, testProfile, IDENTITY_ENV, profilesMenu } from '../dist/profiles.js';
import { parseStrictJson, withStoreLock, writeJson } from '../dist/storage.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function profilesFixture(t) {
  const context = await fixture(t);
  const tools = join(context.base, "tools with ' space"); await fs.mkdir(tools);
  const ssh = join(tools, 'ssh'); const keygen = join(tools, 'ssh-keygen');
  await fs.writeFile(ssh, 'fake executable'); await fs.writeFile(keygen, 'fake executable');
  const secret = 'PRIVATE KEY CONTENT NEVER IN JSON';
  const calls = [];
  let nextStatus = 0; let sshOutput;
  const runner = async (program, args, options = {}) => {
    calls.push({ program, args: [...args], options });
    if (args.includes('-G')) {
      const privateKey = args[args.indexOf('-i') + 1]; const known = args.find((arg) => arg.startsWith('UserKnownHostsFile=')).split('=')[1].replaceAll('"', '');
      return { status: nextStatus, stdout: Buffer.from(sshOutput ?? `identitiesonly yes\nidentityfile ${privateKey}\nuserknownhostsfile ${known}\nglobalknownhostsfile none\nstricthostkeychecking ask\n`), stderr: Buffer.alloc(0) };
    }
    if (args.includes('-T')) return { status: nextStatus, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    if (!nextStatus && args.includes('-t')) {
      const file = args[args.indexOf('-f') + 1]; await fs.writeFile(file, secret); await fs.writeFile(`${file}.pub`, 'ssh-ed25519 AAAAPUBLIC\n');
    }
    return { status: nextStatus, stdout: Buffer.from(args.includes('-y') ? 'ssh-ed25519 AAAAPUBLIC\n' : ''), stderr: Buffer.alloc(0) };
  };
  const toolsWhich = (name) => name === 'ssh' ? ssh : name === 'ssh-keygen' ? keygen : undefined;
  const store = new ProfileStore(undefined, { runProcess: runner, which: toolsWhich });
  return { ...context, store, calls, secret, toolsWhich, runner, ssh, keygen,
    status(value) { nextStatus = value; }, sshOutput(value) { sshOutput = value; },
    async create(label = 'personal', options = {}) { return store.create(new ScriptedConsole(['y']), label, `${label} Name`, `${label}@example.invalid`, 'test-user', options); },
  };
}

const yes = () => new ScriptedConsole(['y']);

test('profile defaults are portable, explicit, read-only; strict JSON detects escaped and nested duplicate keys', async (t) => {
  const f = await profilesFixture(t); assert.deepEqual(await f.store.list(), []); assert.equal(existsSync(f.store.directory), false);
  for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}', '[{"x":1,"x":2}]', '{"a":1,}', '[1,]', 'true false']) assert.throws(() => parseStrictJson(raw));
  assert.deepEqual(parseStrictJson('{"a":[1,true,null,"x\\\"y"],"__proto__":{"safe":true}}'), JSON.parse('{"a":[1,true,null,"x\\\"y"],"__proto__":{"safe":true}}'));
});

test('new profiles retain schema 2 relative keys, no secrets, and restrictive permissions', async (t) => {
  const f = await profilesFixture(t); const profile = await f.create('../../label not a path', { remember_auth: true });
  assert.ok(profile instanceof Profile); assert.match(profile.profile_id, /^[a-f0-9]{32}$/u); assert.deepEqual(await f.store.load(profile.profile_id), profile);
  const metadata = join(dirname(profile.private_key), 'profile.json'); const data = await fs.readFile(metadata, 'utf8'); assert.equal(data.includes(f.secret), false); assert.equal(data.includes(f.base), false);
  const encoded = JSON.parse(data); assert.equal(encoded.schema_version, 2); assert.equal(encoded.private_key, `profiles/${profile.profile_id}/id_ed25519`); assert.equal(encoded.remember_auth, true);
  assert.deepEqual(f.calls[0].args.slice(-2), ['-N', '']); assert.equal(f.calls[0].options.interactive, true); assert.equal(f.calls[0].options.inputData, undefined);
  assert.equal(existsSync(join(f.home, '.gitconfig')), false);
  if (process.platform !== 'win32') {
    for (const dir of [f.store.directory, f.store.profiles_dir, dirname(profile.private_key)]) assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    for (const file of [metadata, profile.private_key, profile.public_key, join(f.store.directory, 'known_hosts')]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
});

test('import confirms before copy and derives a public key natively without receiving a passphrase', async (t) => {
  const f = await profilesFixture(t); const original = join(f.base, 'original private'); await fs.writeFile(original, f.secret);
  assert.equal(await f.store.create(new ScriptedConsole(['n']), 'cancelled', 'Name', 'email', 'login', { source: original }), undefined); assert.equal(f.calls.length, 0); assert.equal(existsSync(f.store.directory), false);
  const profile = await f.create('imported', { source: original, remember_auth: true }); assert.deepEqual(f.calls.map(({ args }) => args.slice(0, 1)), [['-p'], ['-y']]);
  assert.deepEqual(f.calls[0].args.slice(-2), ['-N', '']); assert.equal(f.calls[1].options.captureStdout, true); assert.equal(f.calls[1].options.interactive, true);
  assert.equal(await fs.readFile(original, 'utf8'), f.secret); assert.equal(await fs.readFile(profile.private_key, 'utf8'), f.secret); assert.equal(await fs.readFile(profile.public_key, 'utf8'), 'ssh-ed25519 AAAAPUBLIC\n');
  assert.ok(f.calls.every(({ options }) => options.inputData === undefined));
});

test('unsafe paths, symlinks and hardlinked metadata are refused without overwriting', async (t) => {
  const f = await profilesFixture(t); const original = join(f.base, 'private'); await fs.writeFile(original, f.secret);
  const link = join(f.base, 'linked');
  if (process.platform !== 'win32') await fs.symlink(original, link);
  for (const source of ['relative', `${original}\n`, `${original}"`, `${original}%h`, f.base, ...(process.platform !== 'win32' ? [link] : [])]) await assert.rejects(f.create('unsafe', { source }), GitError);
  assert.equal(f.calls.length, 0);
  const profile = await f.create(); const metadata = join(dirname(profile.private_key), 'profile.json');
  const hard = join(f.base, 'hard.json'); await fs.link(metadata, hard); await assert.rejects(f.store.load(profile.profile_id), /硬链接/u); await fs.unlink(hard);
  if (process.platform !== 'win32') {
    const real = `${metadata}.saved`; await fs.rename(metadata, real); await fs.symlink(real, metadata); await assert.rejects(f.store.list(), /符号链接/u);
    await fs.unlink(metadata); await fs.rename(real, metadata);
    const alias = join(f.base, 'alias'); await fs.symlink(f.store.directory, alias, 'dir'); assert.throws(() => new ProfileStore(alias), GitError);
    const profiles = f.store.profiles_dir; await fs.rename(profiles, `${profiles}.saved`); await fs.symlink(join(f.base, 'missing'), profiles); await assert.rejects(f.store.list(), /符号链接/u);
  }
});

test('unknown schema fields, wrong types, duplicate keys, traversal and schema 1 fail closed', async (t) => {
  const f = await profilesFixture(t); const profile = await f.create(); const file = join(dirname(profile.private_key), 'profile.json'); const original = await fs.readFile(file, 'utf8'); const data = JSON.parse(original);
  const invalid = ['broken', 'null', '[]', '{"schema_version":2,"schema_version":2}', JSON.stringify({ ...data, schema_version: true }), JSON.stringify({ ...data, token: 'never store' }), ...['email', 'ssh_program', 'status', 'remember_auth'].map((key) => JSON.stringify({ ...data, [key]: null }))];
  for (const raw of invalid) { await fs.writeFile(file, raw); await assert.rejects(f.store.list(), GitError); assert.equal(await fs.readFile(file, 'utf8'), raw); }
  await fs.writeFile(file, JSON.stringify({ ...data, schema_version: 1 })); await assert.rejects(f.store.load(profile.profile_id), /手工迁移.*不会自动扫描 HOME/u);
  await fs.writeFile(file, original);
  for (const value of ['../escape', '/outside', 'C:/outside', `profiles/${profile.profile_id}/../key`, `profiles/${'a'.repeat(32)}/key`, `profiles\\${profile.profile_id}\\key`, `profiles/${profile.profile_id}/nested/key`, `profiles/${profile.profile_id}/./key`]) assert.throws(() => f.store.decodeProfile({ ...data, private_key: value }, undefined, false), GitError);
});

test('exclusive locks are never auto-removed and atomic serialization failure preserves metadata', async (t) => {
  const f = await profilesFixture(t); await fs.mkdir(f.store.directory, { recursive: true }); const lock = join(f.store.directory, '.lock'); await fs.writeFile(lock, 'other owner');
  await assert.rejects(f.create(), /锁定/u); assert.equal(await fs.readFile(lock, 'utf8'), 'other owner'); await fs.unlink(lock);
  await assert.rejects(withStoreLock(f.store.directory, async () => { throw new Error('cancel operation'); }), /cancel operation/u); assert.equal(existsSync(lock), false);
  const file = join(f.store.directory, 'atomic.json'); await writeJson(file, { okay: true }); const original = await fs.readFile(file);
  await assert.rejects(writeJson(file, { cannotSerialize: 1n })); assert.deepEqual(await fs.readFile(file), original); assert.deepEqual((await fs.readdir(f.store.directory)).filter((name) => name.startsWith('.tmp-')), []);
});

test('two accounts bind independently, reordering JSON keys is safe, relocating data retains snapshots', async (t) => {
  const f = await profilesFixture(t); const first = await f.create('one'); const second = await f.create('two');
  const secondRoot = join(f.base, 'second project'); await fs.mkdir(secondRoot); const git = new Git(secondRoot); await git.run(['init', '--initial-branch=main']);
  await f.store.bind(f.path, first.profile_id); await f.store.bind(secondRoot, second.profile_id); assert.deepEqual(await f.store.resolveBinding(f.path), first); assert.deepEqual(await f.store.resolveBinding(secondRoot), second);
  const before = await fs.readFile(join(f.path, '.git', 'config'), 'utf8'); assert.equal(before.includes('sshCommand'), false); assert.equal(before.includes(first.name), false);
  const bindings = JSON.parse(await fs.readFile(f.store.bindings_file, 'utf8')); const key = Object.keys(bindings.bindings).find((root) => root === f.path || root === f.path.toLowerCase()); const snapshot = bindings.bindings[key].snapshot; bindings.bindings[key].snapshot = Object.fromEntries(Object.entries(snapshot).reverse()); await fs.writeFile(f.store.bindings_file, JSON.stringify(bindings)); assert.deepEqual(await f.store.resolveBinding(f.path), first);
  const moved = join(f.base, 'moved software', 'data'); await fs.mkdir(dirname(moved)); await fs.rename(f.store.directory, moved); const relocated = new ProfileStore(moved, { runProcess: f.runner, which: f.toolsWhich }); const updated = await relocated.load(first.profile_id); assert.equal(updated.private_key, join(moved, 'profiles', first.profile_id, 'id_ed25519')); assert.deepEqual(relocated.snapshot(updated), f.store.snapshot(first)); assert.deepEqual(await relocated.resolveBinding(f.path), updated); assert.ok(buildSshCommand(updated, moved, f.toolsWhich).includes(join(moved, 'known_hosts')));
});

test('stale, corrupted and missing-key bindings raise instead of falling back to ambient identity', async (t) => {
  const f = await profilesFixture(t); const profile = await f.create(); await f.store.bind(f.path, profile.profile_id);
  const file = join(dirname(profile.private_key), 'profile.json'); const data = JSON.parse(await fs.readFile(file, 'utf8')); data.name = 'Changed'; await fs.writeFile(file, JSON.stringify(data)); await assert.rejects(f.store.resolveBinding(f.path), /快照已过期/u);
  await f.store.bind(f.path, profile.profile_id); assert.equal((await f.store.resolveBinding(f.path)).name, 'Changed'); await fs.unlink(profile.private_key); await assert.rejects(f.store.resolveBinding(f.path), GitError);
  await fs.writeFile(f.store.bindings_file, '{"schema_version":2,"bindings":null}'); await assert.rejects(f.store.resolveBinding(f.path), GitError);
});

for (const quick of [true, false]) {
  test(`label-only profile edit preserves schema 2 binding with ${quick ? 'zero quick-mode' : 'one detailed-mode'} confirmation`, async (t) => {
    const f = await profilesFixture(t); const profile = await f.create(); await f.store.bind(f.path, profile.profile_id);
    const config = await fs.readFile(join(f.path, '.git', 'config'));
    const ui = new ScriptedConsole(['renamed', '', '', '', ...(quick ? [] : ['y'])], { quick });
    const ask = ui.ask.bind(ui); let questions = 0;
    ui.ask = async (...args) => { questions++; assert.equal(existsSync(join(f.store.directory, '.lock')), true); return ask(...args); };
    const updated = await f.store.edit(ui, profile.profile_id);
    assert.equal(updated.label, 'renamed'); assert.deepEqual(await f.store.resolveBinding(f.path), updated);
    const data = JSON.parse(await fs.readFile(f.store.bindings_file, 'utf8')); const binding = Object.values(data.bindings)[0];
    assert.equal(data.schema_version, 2); assert.equal(binding.snapshot.schema_version, 2); assert.equal(binding.snapshot.label, 'renamed');
    assert.deepEqual(binding.snapshot, f.store.snapshot(updated)); assert.equal(binding.profile_id, profile.profile_id);
    assert.equal(questions, 4); assert.equal(ui.messages.filter(message => /^确认保存账号编辑？/u.test(message)).length, quick ? 0 : 1);
    assert.match(ui.transcript, /保留项目绑定/u); assert.doesNotMatch(ui.transcript, /解除以下项目绑定/u); assert.equal(ui.answers.length, 0);
    assert.deepEqual(await fs.readFile(join(f.path, '.git', 'config')), config); assert.equal(existsSync(join(f.store.directory, '.lock')), false);
  });
}

test('label-only edit synchronizes display-only stale labels even when the old binding label equals the new label', async (t) => {
  const f = await profilesFixture(t); const profile = await f.create(); await f.store.bind(f.path, profile.profile_id);
  const bindings = JSON.parse(await fs.readFile(f.store.bindings_file, 'utf8')); const binding = Object.values(bindings.bindings)[0];
  binding.snapshot.label = 'next-label'; await fs.writeFile(f.store.bindings_file, JSON.stringify(bindings));
  await assert.rejects(f.store.resolveBinding(f.path), /快照已过期/u);
  const ui = new ScriptedConsole(['next-label', '', '', ''], { quick: true }); const updated = await f.store.edit(ui, profile.profile_id);
  assert.equal(updated.label, 'next-label'); assert.deepEqual(await f.store.resolveBinding(f.path), updated);
  const saved = JSON.parse(await fs.readFile(f.store.bindings_file, 'utf8')); assert.equal(Object.keys(saved.bindings).length, 1);
  assert.deepEqual(saved.bindings, bindings.bindings); assert.doesNotMatch(ui.transcript, /解除以下项目绑定/u); assert.equal(ui.answers.length, 0);
});

for (const field of ['name', 'email', 'github_login', 'private_key', 'public_key']) {
  test(`label-only edit refreshes valid bindings but cannot repair a stale ${field} identity snapshot`, async (t) => {
    const f = await profilesFixture(t); const profile = await f.create(); await f.store.bind(f.path, profile.profile_id);
    const staleRoot = join(f.base, 'stale project'); await fs.mkdir(staleRoot); await new Git(staleRoot).run(['init', '--initial-branch=main']); await f.store.bind(staleRoot, profile.profile_id);
    const bindings = JSON.parse(await fs.readFile(f.store.bindings_file, 'utf8'));
    const staleKey = Object.keys(bindings.bindings).find(root => root === staleRoot || root === staleRoot.toLowerCase());
    const stale = bindings.bindings[staleKey];
    stale.snapshot[field] = field === 'private_key' ? `profiles/${profile.profile_id}/previous_key` : field === 'public_key' ? `profiles/${profile.profile_id}/previous_key.pub` : field === 'github_login' ? 'previous-login' : 'Previous identity';
    await fs.writeFile(f.store.bindings_file, JSON.stringify(bindings)); await assert.rejects(f.store.resolveBinding(staleRoot), /快照已过期/u);
    const updated = await f.store.edit(new ScriptedConsole(['new-label', '', '', ''], { quick: true }), profile.profile_id);
    assert.deepEqual(await f.store.resolveBinding(f.path), updated); await assert.rejects(f.store.resolveBinding(staleRoot), /快照已过期/u);
    const saved = JSON.parse(await fs.readFile(f.store.bindings_file, 'utf8')); assert.deepEqual(saved.bindings[staleKey], stale); assert.equal(Object.keys(saved.bindings).length, 2);
  });
}

for (const [field, value, answerIndex] of [['name', 'Changed Name', 1], ['email', 'changed@example.invalid', 2], ['github_login', 'changed-login', 3]]) {
  for (const mixed of [false, true]) {
    test(`${mixed ? 'mixed label and' : 'pure'} ${field} edit explicitly unbinds instead of treating it as display metadata`, async (t) => {
      const f = await profilesFixture(t); const profile = await f.create(); await f.store.bind(f.path, profile.profile_id);
      const answers = [mixed ? 'renamed' : '', '', '', '']; answers[answerIndex] = value;
      const ui = new ScriptedConsole([...answers, 'y'], { quick: false }); const updated = await f.store.edit(ui, profile.profile_id);
      assert.equal(updated[field], value); assert.equal(updated.label, mixed ? 'renamed' : profile.label); assert.equal(await f.store.resolveBinding(f.path), undefined);
      assert.match(ui.transcript, /提交署名或预期 GitHub 登录名已变化/u); assert.match(ui.transcript, /解除以下项目绑定，请重新绑定/u);
      assert.equal(ui.messages.filter(message => /^确认保存账号编辑？/u.test(message)).length, 1); assert.equal(ui.answers.length, 0);
    });
  }
}

test('cancelling a label edit preserves profile and binding files without an extra confirmation', async (t) => {
  const f = await profilesFixture(t); const profile = await f.create(); await f.store.bind(f.path, profile.profile_id);
  const metadata = join(dirname(profile.private_key), 'profile.json'); const before = await fs.readFile(metadata); const binding = await fs.readFile(f.store.bindings_file);
  const ui = new ScriptedConsole(['cancelled-label', '', '', '', 'n'], { quick: false }); assert.equal(await f.store.edit(ui, profile.profile_id), undefined);
  assert.deepEqual(await fs.readFile(metadata), before); assert.deepEqual(await fs.readFile(f.store.bindings_file), binding);
  assert.equal(ui.messages.filter(message => /^确认保存账号编辑？/u.test(message)).length, 1); assert.equal(ui.answers.length, 0);
});

test('remember authentication updates only managed keys and deletion chooses scope then confirms once', async (t) => {
  const f = await profilesFixture(t); const source = join(f.base, 'original'); await fs.writeFile(source, f.secret); const profile = await f.create('one', { source }); await f.store.bind(f.path, profile.profile_id); const binding = await fs.readFile(f.store.bindings_file);
  const updated = await f.store.change_auth(yes(), profile.profile_id, true); assert.equal(updated.remember_auth, true); assert.deepEqual(await fs.readFile(f.store.bindings_file), binding); assert.equal((await f.store.resolveBinding(f.path)).remember_auth, true); assert.equal(await fs.readFile(source, 'utf8'), f.secret);
  f.status(1); await assert.rejects(f.store.change_auth(yes(), profile.profile_id, false), /没有更新/u); assert.equal((await f.store.load(profile.profile_id)).remember_auth, true); f.status(0);
  assert.equal(await f.store.delete(new ScriptedConsole(['1', 'n']), profile.profile_id), false); assert.equal(await f.store.delete(new ScriptedConsole(['1', 'y']), profile.profile_id), true); assert.equal(existsSync(profile.private_key), true); assert.equal(await f.store.resolveBinding(f.path), undefined);
  const again = await f.create('second', { source }); const deletion = new ScriptedConsole(['2', 'y']); assert.equal(await f.store.delete(deletion, again.profile_id), true); assert.equal(deletion.messages.filter((message) => /最终确认/u.test(message)).length, 1); assert.equal(existsSync(again.private_key), false); assert.equal(await fs.readFile(source, 'utf8'), f.secret);
});

test('offline SSH validation enforces one identity, dedicated known_hosts and strict checking', async (t) => {
  const f = await profilesFixture(t); const profile = await f.create(); const args = buildSshArgs(profile, f.store.directory, f.toolsWhich); assert.ok(args.includes('GlobalKnownHostsFile=none')); assert.ok(args.includes('StrictHostKeyChecking=ask')); assert.ok(args.includes(`UserKnownHostsFile="${join(f.store.directory, 'known_hosts')}"`));
  f.sshOutput('identitiesonly yes\nidentityfile /wrong\nuserknownhostsfile /wrong\nglobalknownhostsfile none\nstricthostkeychecking ask\n'); await assert.rejects(f.store.bind(f.path, profile.profile_id), /受控模式/u); assert.equal(f.calls.some(({ args }) => args.includes('-T')), false);
  f.sshOutput(undefined); await f.store.bind(f.path, profile.profile_id); await fs.unlink(join(f.store.directory, 'known_hosts')); await fs.mkdir(join(f.store.directory, 'known_hosts')); assert.throws(() => buildSshCommand(profile, undefined, f.toolsWhich), GitError);
});

test('network test requires opt-in and exact expected login confirmation, and never persists verified status', async (t) => {
  const f = await profilesFixture(t); const profile = await f.create(); const calls = f.calls.length;
  assert.equal(await testProfile(new ScriptedConsole(['n']), f.path, profile, { runProcess: f.runner, which: f.toolsWhich }), 'unverified'); assert.equal(f.calls.length, calls);
  const runner = async (program, args, options) => args.includes('-T') ? { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } : f.runner(program, args, options);
  assert.equal(await testProfile(new ScriptedConsole(['y', 'n']), f.path, profile, { runProcess: runner, which: f.toolsWhich }), 'unverified'); const ui = new ScriptedConsole(['y', 'y']); assert.equal(await testProfile(ui, f.path, profile, { runProcess: runner, which: f.toolsWhich }), 'verified'); assert.match(ui.transcript, /Hi test-user!/u); assert.equal((await f.store.load(profile.profile_id)).status, 'unverified');
});

test('profile-scoped Git preserves identity/environment guards and public APIs return Profile objects', async (t) => {
  if (!which('ssh')) return t.skip('OpenSSH not installed');
  const f = await profilesFixture(t); const profile = await f.create(); assert.equal(await chooseProfile(new ScriptedConsole(['0'])), undefined); assert.ok(await chooseProfile(new ScriptedConsole(['1'])) instanceof Profile);
  // Real ssh -G is an offline configuration probe; it does not connect to GitHub.
  await bindProject(f.path, profile); const git = await boundGit(f.path); assert.equal(git.overrides['user.name'], profile.name); assert.equal(await git.config('user.email'), profile.email); assert.equal(await new Git(f.path).config('user.name'), '测试用户');
  for (const key of [...IDENTITY_ENV, 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
    process.env[key] = 'SECRET OVERRIDE'; await assert.rejects(profileGit(f.path, profile), (error) => !error.message.includes('SECRET OVERRIDE')); await assert.rejects(git.value('status'), GitError); delete process.env[key];
  }
  for (const [key, value] of Object.entries({ 'author.name': 'Other Author', 'author.email': 'other-author@example.invalid', 'committer.name': 'Other Committer', 'committer.email': 'other-committer@example.invalid' })) await f.git.run(['config', key, value]);
  const originalConfig = await fs.readFile(join(f.path, '.git', 'config')); await f.write('scoped.txt', 'profile identity'); await git.run(['add', '--', 'scoped.txt']); await git.run(['commit', '-m', 'profile identity']); assert.equal(await git.value('log', '-1', '--format=%an|%ae|%cn|%ce'), `${profile.name}|${profile.email}|${profile.name}|${profile.email}`); assert.deepEqual(await fs.readFile(join(f.path, '.git', 'config')), originalConfig);
  const repo = await git.repository(); assert.equal(repo.overrides['core.sshCommand'], git.overrides['core.sshCommand']); const configured = git.configured({ 'color.ui': 'false' }); assert.deepEqual(configured.rejectedEnvironment, git.rejectedEnvironment);
});

test('native Node key generation and import work offline with no Python runtime', async (t) => {
  if (!which('ssh-keygen') || !which('ssh')) return t.skip('OpenSSH not installed');
  const f = await fixture(t); const store = new ProfileStore(); const profile = await store.create(yes(), 'native', 'Node User', 'node@example.invalid', 'node-user', { remember_auth: true });
  assert.ok(profile instanceof Profile); assert.match(await fs.readFile(profile.public_key, 'utf8'), /^ssh-ed25519 /u); await store.bind(f.path, profile.profile_id); assert.equal((await boundGit(f.path)).overrides['user.name'], 'Node User');
  const imported = await store.create(yes(), 'native-copy', 'Copy User', 'copy@example.invalid', 'copy-user', { source: profile.private_key, remember_auth: true }); assert.deepEqual(await fs.readFile(imported.public_key), await fs.readFile(profile.public_key));
});

test('Git executes a safely quoted SSH command with Chinese, spaces and apostrophes without networking', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX executable fixture; Windows Git shell coverage runs separately');
  const f = await fixture(t); const fakeSsh = join(f.base, "中文 tools with ' space", 'ssh'); await fs.mkdir(dirname(fakeSsh)); const log = join(f.base, 'ssh-argv.json');
  await fs.writeFile(fakeSsh, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nfs.writeFileSync(process.env.AUTOGIT_SSH_ARGV_LOG,JSON.stringify(args));\nprocess.exit(1);\n`, { mode: 0o700 });
  const profileId = 'a'.repeat(32); const directory = join(f.base, "中文 portable with ' space", 'data'); const folder = join(directory, 'profiles', profileId); await fs.mkdir(folder, { recursive: true }); const privateKey = join(folder, 'id_ed25519'); await fs.writeFile(privateKey, 'FAKE TEST KEY'); await fs.writeFile(join(directory, 'known_hosts'), '');
  const profile = new Profile({ profile_id: profileId, label: 'test', name: 'Name', email: 'email', github_login: 'user', private_key: privateKey, public_key: `${privateKey}.pub`, ssh_program: fakeSsh });
  const command = buildSshCommand(profile); const git = new Git(f.path, { config: { 'core.sshCommand': command, 'ssh.variant': 'ssh' }, env: { AUTOGIT_SSH_ARGV_LOG: log, GIT_ALLOW_PROTOCOL: 'file:ssh' } }); const result = await git.run(['ls-remote', 'git@github.com:fixture/no-network.git'], { check: false }); assert.notEqual(result.status, 0);
  const args = JSON.parse(await fs.readFile(log, 'utf8')); assert.deepEqual(args.slice(0, 12), buildSshArgs(profile).slice(1)); assert.ok(args.includes('git@github.com')); assert.ok(args.includes("git-upload-pack 'fixture/no-network.git'"));
});

test('native encrypted import uses the PTY for its old passphrase and removes only the managed-copy passphrase', { timeout: 30_000 }, async (t) => {
  if (process.platform !== 'linux' || !which('script') || !which('ssh-keygen') || !which('ssh')) return t.skip('requires util-linux script and OpenSSH');
  const f = await fixture(t); const source = join(f.base, 'encrypted-original'); const passphrase = 'temporary-test-fixture-passphrase'; const generated = spawnSync(which('ssh-keygen'), ['-q', '-t', 'ed25519', '-f', source, '-N', passphrase, '-C', 'fixture'], { cwd: f.base, env: { ...process.env }, encoding: 'utf8' }); assert.equal(generated.status, 0, generated.stderr); const before = await fs.readFile(source);
  const runnerFile = join(f.base, 'native-encrypted-import.mjs'); const output = join(f.base, 'imported-profile.json'); const profilesUrl = new URL('../dist/profiles.js', import.meta.url).href;
  await fs.writeFile(runnerFile, `import fs from 'node:fs/promises';\nimport {ProfileStore} from ${JSON.stringify(profilesUrl)};\nconst ui={text(){},async routineConfirm(){return true}};\nconst profile=await new ProfileStore().create(ui,'encrypted','Native User','native@example.invalid','native-user',{source:process.argv[2],remember_auth:true});\nawait fs.writeFile(process.argv[3],JSON.stringify(profile));\n`);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`; const command = [process.execPath, runnerFile, source, output].map(quote).join(' ');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(which('script'), ['-q', '-e', '-c', command, '/dev/null'], { cwd: f.base, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] }); let transcript = ''; let prompts = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`native import PTY timed out: ${transcript}`)); }, 20_000);
    const receive = (chunk) => { transcript += chunk.toString('utf8'); if (!prompts && /Enter old passphrase:/u.test(transcript)) { prompts++; child.stdin.write(`${passphrase}\n`); } };
    child.stdout.on('data', receive); child.stderr.on('data', receive); child.on('error', (error) => { clearTimeout(timer); reject(error); }); child.on('close', (status) => { clearTimeout(timer); resolve({ status, transcript, prompts }); });
  });
  assert.equal(result.status, 0, result.transcript); assert.equal(result.prompts, 1); assert.deepEqual(await fs.readFile(source), before); const imported = JSON.parse(await fs.readFile(output, 'utf8')); assert.equal(imported.remember_auth, true);
  const publicResult = spawnSync(which('ssh-keygen'), ['-y', '-P', '', '-f', imported.private_key], { cwd: f.base, env: { ...process.env }, encoding: 'utf8' }); assert.equal(publicResult.status, 0, publicResult.stderr); assert.equal(publicResult.stdout.trim(), (await fs.readFile(`${source}.pub`, 'utf8')).trim()); assert.equal(await fs.readFile(imported.public_key, 'utf8'), publicResult.stdout); assert.deepEqual(await fs.readFile(source), before);
  const metadata = await fs.readFile(join(dirname(imported.private_key), 'profile.json'), 'utf8'); assert.equal(metadata.includes(passphrase), false);
});

test('account menu folder help works even without any account and cancellation is safe', async (t) => {
  const f = await fixture(t); const ui = new ScriptedConsole(['10', '0']); await profilesMenu(ui, f.path); assert.match(ui.transcript, /SSH and GPG keys/u); assert.equal(existsSync(process.env.AUTOGIT_DATA_DIR), false);
});
