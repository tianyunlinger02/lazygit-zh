import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, createServer } from 'node:net';
import { scratchRoot } from '../scripts/scratch.mjs';

const execFile = promisify(childProcess.execFile);
const root = process.env.AUTOGIT_MANAGED_TEST_MODULE_DIR ?? process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { Vault } = await import(new URL('vault.js', root));
const { CredentialSession, currentSession, setSession } = await import(new URL('session.js', root));
const { Profile, ProfileStore, buildSshArgs, profileGit } = await import(new URL('profiles.js', root));
const { isManagedKey, managedKeyMarker, migrateManagedKeys } = await import(new URL('managed-keys.js', root));
const { Console } = await import(new URL('ui.js', root));
const { Git, GitError } = await import(new URL('git.js', root));
const { NativeAuthError, nativeRequest, resolveNativeHelper } = await import(new URL('auth.js', root));
const { which } = await import(new URL('process.js', root));

// Only these offline native commands are permitted. No identity, authenticate,
// PAM, real HOME key, remote SSH connection, or credential-service call is used.
async function fixture(t, tools = []) {
  if (process.platform === 'win32') {
    t.skip('Windows native ACL/named-pipe compatibility is not verified by these POSIX tests.');
    return undefined;
  }
  const helperFile = fileURLToPath(new URL(`../native/bin/${process.platform}-${process.arch}/autogit-auth`, root));
  try { await fs.lstat(helperFile); await fs.lstat(join(dirname(helperFile), 'manifest.json')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('packaged native key/agent helper or manifest is absent; no helper substitute is used.');
    return undefined;
  }
  // Existing but invalid artifacts must fail, rather than turn into a passing skip.
  const helper = await resolveNativeHelper();
  const programs = Object.fromEntries(tools.map((name) => [name, which(name)]));
  if (tools.some((name) => !programs[name])) {
    t.skip(`required offline tools are absent: ${tools.filter((name) => !programs[name]).join(', ')}`);
    return undefined;
  }
  const temporaryRoot = scratchRoot;
  await fs.mkdir(temporaryRoot, { recursive: true });
  // A short prefix with a space exercises IdentityAgent quoting without adding
  // unnecessary pathname length to the native Unix-domain socket.
  const base = await fs.mkdtemp(join(temporaryRoot, ' '));
  const endpointLength = Buffer.byteLength(join(base, '.autogit-sessions', '0'.repeat(36), 'agent.sock'));
  if (endpointLength > (process.platform === 'linux' ? 107 : 103)) {
    await fs.rm(base, { recursive: true, force: true });
    t.skip('isolated temporary path exceeds this platform\'s Unix socket limit.');
    return undefined;
  }
  const home = join(base, 'home'), directory = join(base, 'data vault');
  const previousEnvironment = process.env, previousSession = currentSession();
  let session;
  const nativeCalls = [], agentChildren = [];
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', function (program, args, options) {
    if (program === helper) {
      assert.ok(['generate-key', 'import-key', 'agent'].includes(args[0]), 'only offline key/agent commands may run');
      nativeCalls.push([...args]);
    }
    const child = Reflect.apply(spawn, this, [program, args, options]);
    if (program === helper && args[0] === 'agent') agentChildren.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    try { await session?.close(); }
    finally {
      setSession(previousSession);
      process.env = previousEnvironment;
      t.mock.restoreAll(); syncBuiltinESMExports();
      await fs.rm(base, { recursive: true, force: true });
    }
  });
  await fs.mkdir(home);
  // Deliberately do not copy ambient Git/SSH/Token/askpass settings or real HOME.
  process.env = {
    PATH: previousEnvironment.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'AppData'), GH_CONFIG_DIR: join(home, 'gh'),
    AUTOGIT_DATA_DIR: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', LC_ALL: 'C', TMPDIR: base, TMP: base, TEMP: base,
  };
  setSession(undefined);
  const password = Buffer.from('synthetic-session-password');
  let vault;
  try { ({ vault } = await Vault.create(directory, password)); } finally { password.fill(0); }
  session = new CredentialSession(vault);
  setSession(session);
  return { base, directory, session, store: new ProfileStore(directory), nativeCalls, agentChildren, programs };
}

function scriptedConsole(answers = [], secrets = []) {
  const pending = [...answers], privateInputs = secrets.map((value) => Buffer.from(value)), messages = [];
  const ui = new Console((prompt) => {
    messages.push(prompt); assert.ok(pending.length, 'unexpected ordinary input request'); return pending.shift();
  }, (message) => messages.push(message), {
    quick: false,
    secretInput: () => { assert.ok(privateInputs.length, 'unexpected secret input request'); return privateInputs.shift(); },
  });
  return { ui, messages, pending, privateInputs };
}

async function filesIn(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) files.push(...await filesIn(file));
    else { assert.equal(entry.isFile(), true); files.push(file); }
  }
  return files.sort();
}

// Use the real SSH-agent wire protocol, not a mocked native process. Public
// blobs are safe test data; private keys never cross this test client socket.
async function agentPacket(endpoint, type = 11) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let received = Buffer.alloc(0), settled = false;
    const finish = (error, packet) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(packet);
    };
    const timer = setTimeout(() => finish(new Error('synthetic SSH-agent response timeout')), 2000);
    socket.once('error', (error) => finish(error));
    socket.once('end', () => { if (!settled) finish(new Error('truncated synthetic SSH-agent response')); });
    socket.once('connect', () => socket.write(Buffer.from([0, 0, 0, 1, type])));
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4) return;
      const length = received.readUInt32BE(0);
      if (length < 1 || length > 1 << 20) { finish(new Error('invalid synthetic SSH-agent packet length')); return; }
      if (received.length >= length + 4) finish(undefined, received.subarray(4, length + 4));
    });
  });
}

async function agentKeys(endpoint) {
  const packet = await agentPacket(endpoint);
  assert.equal(packet[0], 12);
  let offset = 1;
  const uint32 = () => { assert.ok(offset + 4 <= packet.length); const n = packet.readUInt32BE(offset); offset += 4; return n; };
  const string = () => { const length = uint32(); assert.ok(offset + length <= packet.length); const value = packet.subarray(offset, offset + length); offset += length; return value; };
  const count = uint32(), blobs = [];
  assert.ok(count <= 16);
  for (let index = 0; index < count; index += 1) { blobs.push(string().toString('base64')); string(); }
  assert.equal(offset, packet.length);
  return blobs;
}

const publicBlob = (publicKey) => publicKey.trim().split(/\s+/u)[1];

async function sshSettings(args) {
  const { stdout } = await execFile(args[0], [...args.slice(1), '-G', 'git@example.invalid'], { timeout: 3000, maxBuffer: 128 * 1024 });
  const values = (key) => stdout.split(/\r?\n/u).filter((line) => line.startsWith(`${key} `)).map((line) => line.slice(key.length + 1));
  return values;
}

async function legacyFixture(f, id, { encrypted = false } = {}) {
  const external = join(f.base, `external ${id}`);
  await fs.mkdir(external);
  const source = join(external, 'synthetic-key'), passphrase = encrypted ? 'synthetic-correct-passphrase' : '';
  // This fixed argv value is synthetic test data, never an actual user password.
  await execFile(f.programs['ssh-keygen'], ['-q', '-t', 'ed25519', '-N', passphrase, '-f', source, '-C', 'Synthetic legacy fixture'], { cwd: external, timeout: 5000 });
  const original = await fs.readFile(source), publicKey = await fs.readFile(`${source}.pub`, 'utf8');
  tWipe(f, original);
  const folder = join(f.directory, 'profiles', id);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const privateKey = join(folder, 'id_ed25519'), publicFile = `${privateKey}.pub`;
  await fs.writeFile(privateKey, original, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(publicFile, publicKey, { flag: 'wx', mode: 0o600 });
  const profile = new Profile({ profile_id: id, label: id.slice(0, 8), name: 'Synthetic User', email: 'synthetic@example.invalid', github_login: `user-${id.slice(0, 8)}`, private_key: privateKey, public_key: publicFile, remember_auth: true });
  await fs.writeFile(join(folder, 'profile.json'), JSON.stringify(f.store.encodeProfile(profile)), { flag: 'wx', mode: 0o600 });
  const metadata = await fs.readFile(join(folder, 'profile.json'));
  return { source, original, publicKey, profile, metadata, passphrase };
}

function tWipe(f, buffer) { f.buffers ??= []; f.buffers.push(buffer); }
async function unchanged(fixture, { managed = true } = {}) {
  const original = await fs.readFile(fixture.source);
  try { assert.equal(original.equals(fixture.original), true, 'external private original must remain byte-for-byte unchanged'); } finally { original.fill(0); }
  if (managed) {
    const managedBytes = await fs.readFile(fixture.profile.private_key);
    try { assert.equal(managedBytes.equals(fixture.original), true, 'failed/cancelled migration must preserve managed legacy bytes'); } finally { managedBytes.fill(0); }
  }
  assert.equal(await fs.readFile(`${fixture.source}.pub`, 'utf8'), fixture.publicKey);
  assert.equal(await fs.readFile(fixture.profile.public_key, 'utf8'), fixture.publicKey);
  assert.deepEqual(await fs.readFile(join(dirname(fixture.profile.private_key), 'profile.json')), fixture.metadata);
}

test('encrypted profiles use single-key native agents, deduplicate starts, quote spaces and lock without fallback', async (t) => {
  const f = await fixture(t, ['ssh', 'git']); if (!f) return;
  const scripted = scriptedConsole(['y', 'y']);
  const first = await f.store.create(scripted.ui, 'first', 'First User', 'first@example.invalid', 'first-user');
  const second = await f.store.create(scripted.ui, 'second', 'Second User', 'second@example.invalid', 'second-user');
  assert.ok(first); assert.ok(second); assert.notEqual(first.profile_id, second.profile_id);
  assert.equal(scripted.pending.length, 0); assert.equal(scripted.privateInputs.length, 0);
  assert.deepEqual(f.nativeCalls, [['generate-key'], ['generate-key']]);
  const files = await filesIn(f.directory);
  assert.deepEqual(files, [join(f.directory, 'known_hosts'), join(f.directory, 'vault.json'), ...[first, second].flatMap((profile) => [profile.private_key, profile.public_key, join(dirname(profile.private_key), 'profile.json')])].sort());
  assert.equal((await fs.stat(f.directory)).mode & 0o7777, 0o700);
  for (const profile of [first, second]) {
    assert.equal(await isManagedKey(profile.private_key), true);
    assert.equal((await fs.readFile(profile.private_key)).equals(managedKeyMarker(profile.profile_id)), true);
    const privateKey = await f.session.vault.get(`ssh:${profile.profile_id}`);
    assert.ok(privateKey);
    try {
      assert.equal(privateKey.includes(Buffer.from('BEGIN OPENSSH PRIVATE KEY')), true);
      for (const file of files) {
        const bytes = await fs.readFile(file);
        try {
          assert.equal(bytes.includes(privateKey), false, 'no decrypted private key may exist in managed storage');
          assert.equal(bytes.includes(Buffer.from('PRIVATE KEY')), false);
          assert.equal(bytes.includes(Buffer.from(privateKey.toString('base64'))), false);
          assert.equal((await fs.stat(file)).mode & 0o7777, 0o600);
        } finally { bytes.fill(0); }
      }
    } finally { privateKey.fill(0); }
  }
  const [firstPublic, secondPublic] = await Promise.all([first, second].map((profile) => fs.readFile(profile.public_key, 'utf8')));
  assert.notEqual(publicBlob(firstPublic), publicBlob(secondPublic));

  const endpoints = await Promise.all(Array.from({ length: 8 }, () => f.session.sshAgent(first.profile_id)));
  const firstEndpoint = endpoints[0], sessionRoot = join(f.base, '.autogit-sessions');
  assert.equal(new Set(endpoints).size, 1);
  assert.equal(f.agentChildren.length, 1, 'concurrent requests must launch exactly one native agent');
  assert.equal((await fs.readdir(sessionRoot)).length, 1);
  assert.deepEqual(await agentKeys(firstEndpoint), [publicBlob(firstPublic)]);
  const secondEndpoint = await f.session.sshAgent(second.profile_id);
  assert.notEqual(firstEndpoint, secondEndpoint);
  assert.equal(f.agentChildren.length, 2);
  assert.deepEqual(await agentKeys(secondEndpoint), [publicBlob(secondPublic)]);
  assert.deepEqual(await agentKeys(firstEndpoint), [publicBlob(firstPublic)]);
  // Agent mutation (RemoveAll) is denied and does not alter the bound key.
  assert.deepEqual(await agentPacket(firstEndpoint, 19), Buffer.from([5]));
  assert.deepEqual(await agentKeys(firstEndpoint), [publicBlob(firstPublic)]);

  // Deliberately offer a test-owned ambient socket; managed commands must never
  // contact it, including after the selected agent has been closed.
  let ambientConnections = 0;
  const ambientPath = join(f.base, 'ambient.sock');
  const ambient = createServer((socket) => { ambientConnections += 1; socket.destroy(); });
  await new Promise((resolve, reject) => { ambient.once('error', reject); ambient.listen(ambientPath, resolve); });
  t.after(() => new Promise((resolve) => ambient.close(resolve)));
  process.env.SSH_AUTH_SOCK = ambientPath;
  const repository = join(f.base, 'repository'); await fs.mkdir(repository);
  await new Git(repository).run(['init', '--initial-branch=main']);
  for (const [profile, endpoint] of [[first, firstEndpoint], [second, secondEndpoint]]) {
    assert.ok(endpoint.includes(' '));
    const args = buildSshArgs(profile, f.directory);
    assert.ok(args.includes(`IdentityAgent="${endpoint}"`));
    assert.equal(args[args.indexOf('-i') + 1], profile.public_key);
    assert.equal(args.includes(profile.private_key), false);
    const settings = await sshSettings(args);
    assert.deepEqual(settings('identityagent'), [endpoint]);
    assert.deepEqual(settings('identityfile'), [profile.public_key]);
    assert.deepEqual(settings('identitiesonly'), ['yes']);
    await f.store.bind(repository, profile.profile_id);
    assert.equal((await f.store.resolveBinding(repository)).profile_id, profile.profile_id);
    const configured = await profileGit(repository, profile);
    assert.equal((await configured.run(['status', '--porcelain'])).status, 0);
  }
  assert.equal(f.agentChildren.length, 2, 'binding/command preparation must reuse existing agents');
  const capturedArgs = buildSshArgs(first, f.directory);
  await f.session.close();
  assert.equal(f.session.closed, true); assert.equal(currentSession(), undefined);
  assert.equal(f.session.agentEndpoint(first.profile_id), undefined);
  assert.equal(f.session.agentEndpoint(second.profile_id), undefined);
  for (const endpoint of [firstEndpoint, secondEndpoint]) {
    await assert.rejects(fs.lstat(endpoint), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(dirname(endpoint)), { code: 'ENOENT' });
    await assert.rejects(agentKeys(endpoint), (error) => ['ENOENT', 'ECONNREFUSED'].includes(error.code));
  }
  assert.deepEqual(await fs.readdir(sessionRoot), []);
  assert.ok(f.agentChildren.every((child) => child.exitCode !== null || child.signalCode !== null));
  await assert.rejects(f.session.vault.get(`ssh:${first.profile_id}`), /保险库已关闭/u);
  await assert.rejects(f.session.sshAgent(first.profile_id), /会话已经锁定/u);
  // Even a previously prepared command continues to name the dead endpoint,
  // not SSH_AUTH_SOCK; -G is offline and never establishes a remote connection.
  assert.deepEqual((await sshSettings(capturedArgs))('identityagent'), [firstEndpoint]);
  assert.equal(ambientConnections, 0);
});

test('legacy plain/encrypted migration verifies ciphertext and changes only the managed private copy', async (t) => {
  const f = await fixture(t, ['ssh-keygen']); if (!f) return;
  t.after(() => { for (const buffer of f.buffers ?? []) buffer.fill(0); });
  const legacy = [await legacyFixture(f, 'a'.repeat(32)), await legacyFixture(f, 'b'.repeat(32), { encrypted: true })];
  const scripted = scriptedConsole(['y'], [legacy[1].passphrase]);
  // Retain this synthetic adapter Buffer only to verify production clears it.
  const secret = scripted.privateInputs[0];
  await migrateManagedKeys(scripted.ui, legacy.map((item) => item.profile));
  assert.equal(secret.every((byte) => byte === 0), true);
  assert.equal(scripted.pending.length, 0); assert.equal(scripted.privateInputs.length, 0);
  for (const item of legacy) {
    await unchanged(item, { managed: false });
    assert.equal((await fs.readFile(item.profile.private_key)).equals(managedKeyMarker(item.profile.profile_id)), true);
    const privateKey = await f.session.vault.get(`ssh:${item.profile.profile_id}`);
    assert.ok(privateKey);
    try {
      const imported = await nativeRequest('import-key', { privateKey: privateKey.toString('base64') });
      assert.equal(publicBlob(imported.publicKey), publicBlob(item.publicKey));
      imported.privateKey = undefined;
      const ciphertext = await fs.readFile(join(f.directory, 'vault.json'));
      assert.equal(ciphertext.includes(privateKey), false); assert.equal(ciphertext.includes(item.original), false);
    } finally { privateKey.fill(0); }
    const endpoint = await f.session.sshAgent(item.profile.profile_id);
    assert.deepEqual(await agentKeys(endpoint), [publicBlob(item.publicKey)]);
    await assert.rejects(fs.lstat(`${item.profile.private_key}.encrypted-ref`), { code: 'ENOENT' });
  }
  assert.equal(scripted.messages.some((message) => message.includes('PRIVATE KEY')), false);
  assert.equal(scripted.messages.some((message) => message.includes(legacy[1].passphrase)), false);
});

test('cancelled migration preserves external and managed originals and leaves the vault unchanged', async (t) => {
  const f = await fixture(t, ['ssh-keygen']); if (!f) return;
  t.after(() => { for (const buffer of f.buffers ?? []) buffer.fill(0); });
  const item = await legacyFixture(f, 'c'.repeat(32));
  const before = await fs.readFile(join(f.directory, 'vault.json'));
  const scripted = scriptedConsole(['n']);
  await assert.rejects(migrateManagedKeys(scripted.ui, [item.profile]), (error) => error instanceof GitError && /未迁移/u.test(error.message));
  await unchanged(item);
  assert.equal(await f.session.vault.has(`ssh:${item.profile.profile_id}`), false);
  assert.deepEqual(await fs.readFile(join(f.directory, 'vault.json')), before);
  assert.equal(f.nativeCalls.length, 0, 'declining migration must not invoke a native key parser');
});

test('wrong legacy passphrase clears input and preserves all originals without writing a vault record', async (t) => {
  const f = await fixture(t, ['ssh-keygen']); if (!f) return;
  t.after(() => { for (const buffer of f.buffers ?? []) buffer.fill(0); });
  const item = await legacyFixture(f, 'd'.repeat(32), { encrypted: true });
  const before = await fs.readFile(join(f.directory, 'vault.json'));
  const scripted = scriptedConsole(['y'], ['synthetic-wrong-passphrase']);
  const secret = scripted.privateInputs[0];
  await assert.rejects(migrateManagedKeys(scripted.ui, [item.profile]), (error) => error instanceof NativeAuthError && error.code === 'denied');
  assert.equal(secret.every((byte) => byte === 0), true);
  await unchanged(item);
  assert.equal(await f.session.vault.has(`ssh:${item.profile.profile_id}`), false);
  assert.deepEqual(await fs.readFile(join(f.directory, 'vault.json')), before);
  assert.deepEqual(f.nativeCalls, [['import-key'], ['import-key']]);
  await assert.rejects(fs.lstat(`${item.profile.private_key}.encrypted-ref`), { code: 'ENOENT' });
});
