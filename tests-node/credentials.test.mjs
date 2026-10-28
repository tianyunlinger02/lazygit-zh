import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { connect } from 'node:net';
import { createScratch } from '../scripts/scratch.mjs';
const root = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { Vault } = await import(new URL('vault.js', root));
const { CredentialSession, setSession } = await import(new URL('session.js', root));
const { credentialsMenu, configureHttps } = await import(new URL('credentials.js', root));
const { CredentialHelper } = await import(new URL('credential-helper.js', root));
const { GithubClient, authenticateGithub } = await import(new URL('github.js', root));
const { Git, GitError } = await import(new URL('git.js', root));
const { Console } = await import(new URL('ui.js', root));
const TOKEN = 'synthetic_test_token_never_real';
const nativeTest = process.platform === 'win32' ? { skip: 'Windows session directories require the signed native ACL helper' } : {};

async function fixture(t) {
  const scratch = await createScratch('cred-'), directory = join(scratch.directory, 'data'), home = join(scratch.directory, 'home');
  await fs.mkdir(home);
  const saved = process.env; process.env = { PATH: saved.PATH, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' };
  const result = await Vault.create(directory, Buffer.from('synthetic-password'));
  const session = new CredentialSession(result.vault); setSession(session);
  t.after(async () => { await session.close(); setSession(undefined); process.env = saved; await scratch.cleanup(); });
  const repository = join(scratch.directory, "repo with ' space"); await fs.mkdir(repository); const git = new Git(repository); await git.run(['init', '--initial-branch=main']);
  return { base: scratch.directory, directory, session, git, async token(host = 'github.com', account = 'alice', token = TOKEN) { await session.storeToken(host, account, Buffer.from(token)); } };
}
function uiFixture(answers, secretValue = TOKEN) {
  const pending = [...answers], messages = [], secret = Buffer.from(secretValue), calls = [];
  const ui = new Console((prompt) => { calls.push('ask'); messages.push(prompt); assert.ok(pending.length); return pending.shift(); }, (message) => messages.push(message), { secretInput: (prompt) => { calls.push('secret'); messages.push(prompt); return secret; } });
  return { ui, secret, calls, messages };
}
function ghFixture(f, { host = 'github.com', actor = 'alice', login = 'alice', fail = false } = {}) {
  const calls = [], environments = [], env = { PATH: '/fixture/bin', HOME: join(f.base, 'unrelated-home'), GH_CONFIG_DIR: join(f.base, 'external-gh-config'), GH_DEBUG: 'api' };
  const client = new GithubClient(f.git.directory, { host, actor, env, which: () => '/fixture/gh', runProcess: async (program, args, options) => {
    // Never persist token-bearing environment snapshots or place values in assertion diagnostics.
    const key = host === 'github.com' || host.endsWith('.ghe.com') ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN';
    assert.equal(options.env[key] === TOKEN, true); assert.equal(options.env.GH_DEBUG, undefined); assert.equal(process.env[key], undefined);
    assert.notEqual(options.env.GH_CONFIG_DIR, env.GH_CONFIG_DIR); assert.equal(options.env.GH_HOST, host);
    assert.equal(args.some((arg) => String(arg).includes(TOKEN)), false);
    environments.push(options.env); calls.push([...args]);
    if (fail) throw new Error('synthetic launch failure with hidden data');
    return { status: 0, stdout: Buffer.from(args.includes('user') ? `${login}\n` : '{}'), stderr: Buffer.alloc(0) };
  } });
  return { client, calls, environments, env };
}

async function exchange(endpoint, message) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint), output = []; socket.setTimeout(2000);
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`)); socket.on('data', (chunk) => output.push(chunk));
    socket.once('error', reject); socket.once('timeout', () => socket.destroy(new Error('synthetic IPC timeout'))); socket.once('end', () => { try { resolve(JSON.parse(Buffer.concat(output).toString())); } catch (error) { reject(error); } });
  });
}

test('token enrollment asks host/account before secret, encrypts and clears input without a real API', async (t) => {
  const f = await fixture(t), scripted = uiFixture(['github.com', 'alice']);
  await credentialsMenu(scripted.ui, f.git.directory);
  assert.deepEqual(scripted.calls, ['ask', 'ask', 'secret']); assert.equal(scripted.secret.every((byte) => byte === 0), true);
  const token = await f.session.getToken('github.com', 'alice'); try { assert.equal(token.toString() === TOKEN, true); } finally { token.fill(0); }
  assert.equal((await fs.readFile(join(f.directory, 'vault.json'), 'utf8')).includes(TOKEN), false);
  assert.equal(scripted.messages.some((message) => message.includes(TOKEN)), false); assert.match(scripted.messages.join('\n'), /尚未联网验证/u);
});

test('invalid token input is rejected, cleared, and never stored', async (t) => {
  const f = await fixture(t);
  for (const token of ['', 'bad\ntoken', 'bad\u0000token', '非ASCII', ' '.repeat(3)]) {
    const scripted = uiFixture(['github.com', 'alice'], token); await assert.rejects(credentialsMenu(scripted.ui, f.git.directory), GitError); assert.equal(scripted.secret.every((byte) => byte === 0), true);
  }
  assert.equal(await f.session.getToken('github.com', 'alice'), undefined);
});

test('HTTPS helper resets inherited helpers, scopes protocol/host/path/account and never changes remote/config', nativeTest, async (t) => {
  const f = await fixture(t); await f.token();
  await f.git.run(['remote', 'add', 'origin', 'https://github.com/acme/demo.git']);
  const marker = join(f.base, 'external-helper-ran');
  await f.git.run(['config', '--add', 'credential.helper', `!printf external > '${marker}'`]);
  await f.git.run(['config', '--add', 'credential.https://github.com.helper', `!printf external > '${marker}'`]);
  const before = await fs.readFile(join(f.git.directory, '.git', 'config'));
  const configured = await configureHttps(f.git, { github_login: 'alice' }, { host: { host: 'github.com' } });
  const entries = configured.orderedConfig.filter(([key]) => key === 'credential.helper'); assert.equal(entries.length, 2); assert.equal(entries[0][1], ''); assert.match(entries[1][1], /^!/u); assert.equal(entries[1][1].includes(TOKEN), false);
  assert.deepEqual((await configured.repository()).orderedConfig, configured.orderedConfig); assert.deepEqual(configured.configured({ 'color.ui': 'false' }).orderedConfig, configured.orderedConfig);
  const result = await configured.run(['credential', 'fill'], { inputData: Buffer.from('protocol=https\nhost=github.com\npath=acme/demo.git\nusername=alice\n\n') });
  const output = result.stdout.toString(); assert.equal(output.includes(`password=${TOKEN}`), true); result.stdout.fill(0); assert.equal(output.includes('username=alice'), true);
  for (const request of [
    'protocol=http\nhost=github.com\npath=acme/demo.git\nusername=alice\n\n',
    'protocol=https\nhost=evil.example.invalid\npath=acme/demo.git\nusername=alice\n\n',
    'protocol=https\nhost=github.com\npath=acme/other.git\nusername=alice\n\n',
    'protocol=https\nhost=github.com\npath=acme/demo.git\nusername=bob\n\n',
  ]) {
    const failed = await configured.run(['credential', 'fill'], { check: false, inputData: Buffer.from(request) });
    assert.notEqual(failed.status, 0); assert.equal(failed.stdout.includes(Buffer.from(TOKEN)), false); assert.equal(failed.stderr.includes(Buffer.from(TOKEN)), false);
  }
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }); assert.deepEqual(await fs.readFile(join(f.git.directory, '.git', 'config')), before);
  assert.equal((await fs.readdir(f.directory)).includes('.sessions'), false); await f.session.close();
  const after = await configured.run(['credential', 'fill'], { check: false, inputData: Buffer.from('protocol=https\nhost=github.com\npath=acme/demo.git\nusername=alice\n\n') }); assert.notEqual(after.status, 0); assert.equal(after.stdout.includes(Buffer.from(TOKEN)), false);
});

test('HTTPS missing credentials or ambiguous targets fail instead of falling back', nativeTest, async (t) => {
  const f = await fixture(t), profile = { github_login: 'alice' }, target = { host: { host: 'github.com' }, url: 'https://github.com/acme/demo.git' };
  const local = await configureHttps(f.git, profile, { host: target.host });
  assert.equal((await local.run(['status', '--porcelain'])).status, 0); assert.deepEqual(local.orderedConfig.filter(([key]) => key === 'credential.helper'), [['credential.helper', '']]);
  const missing = await configureHttps(f.git, profile, target); assert.equal((await missing.run(['status', '--porcelain'])).status, 0);
  const denied = await missing.run(['credential', 'fill'], { check: false, inputData: Buffer.from('protocol=https\nhost=github.com\npath=acme/demo.git\nusername=alice\n\n') }); assert.notEqual(denied.status, 0);
  await f.token(); await configureHttps(f.git, profile, target);
  await f.git.run(['remote', 'add', 'one', target.url]); await f.git.run(['remote', 'add', 'two', 'https://github.com/acme/other.git']);
  const ambiguous = await configureHttps(f.git, profile, { host: target.host }); assert.deepEqual(ambiguous.orderedConfig.filter(([key]) => key === 'credential.helper'), [['credential.helper', '']]);
  for (const url of ['http://github.com/acme/demo.git', 'https://alice@github.com/acme/demo.git', 'https://github.com/acme/demo.git?token=hidden', 'https://github.com/acme/%64emo.git', 'https://github.com/acme/../demo.git', 'https://evil.example.invalid/acme/demo.git']) await assert.rejects(configureHttps(f.git, profile, { ...target, url }), GitError);
});

test('IPC rejects invalid capabilities/protocol and session close destroys idle sockets promptly', nativeTest, async (t) => {
  const f = await fixture(t); await f.token(); const helper = await CredentialHelper.start({ session: f.session, host: 'github.com', account: 'alice', repositoryPath: 'acme/demo.git' });
  const request = { protocol: 1, secret: helper.secret, operation: 'get', credential: { protocol: 'https', host: 'github.com', path: 'acme/demo.git', username: 'alice' } };
  for (const changed of [{ ...request, secret: 'wrong' }, { ...request, credential: { ...request.credential, protocol: 'http' } }, { ...request, credential: { ...request.credential, username: 'bob' } }]) {
    const response = await exchange(helper.endpoint, changed); assert.equal(response.ok, false); assert.equal(response.password, undefined);
  }
  const pending = connect(helper.endpoint); await new Promise((resolve, reject) => { pending.once('connect', resolve); pending.once('error', reject); });
  const began = Date.now(); await f.session.close(); assert.ok(Date.now() - began < 1500); pending.destroy();
  await assert.rejects(fs.stat(dirname(helper.endpoint)), { code: 'ENOENT' });
});

test('gh injects only selected host/actor tokens into child env and clears env on success or failure', nativeTest, async (t) => {
  const f = await fixture(t);
  for (const host of ['github.com', 'git.example.invalid']) {
    await f.token(host); const g = ghFixture(f, { host }); assert.equal(await g.client.currentLogin(), 'alice'); await g.client.writeJson('PATCH', 'repos/acme/demo', { description: 'synthetic' });
    assert.equal(g.calls.filter((args) => args.includes('user')).length, 2); assert.equal(g.env.GH_TOKEN, undefined); assert.equal(g.env.GH_ENTERPRISE_TOKEN, undefined);
    for (const env of g.environments) { assert.equal(env.GH_TOKEN, undefined); assert.equal(env.GH_ENTERPRISE_TOKEN, undefined); }
    const failed = ghFixture(f, { host, fail: true }); await assert.rejects(failed.client.currentLogin(), (error) => !error.message.includes(TOKEN));
    assert.equal(failed.environments[0].GH_TOKEN, undefined); assert.equal(failed.environments[0].GH_ENTERPRISE_TOKEN, undefined);
  }
});

test('managed gh refuses missing actor/token, external login/switch, session replacement and credential environment', nativeTest, async (t) => {
  const f = await fixture(t), g = ghFixture(f);
  await assert.rejects(g.client.currentLogin(), /尚未保存/u); assert.equal(g.calls.length, 0);
  await f.token();
  const unselected = new GithubClient(f.git.directory, { env: {}, which: () => '/fixture/gh', runProcess: async () => { throw new Error('must not run'); } });
  await assert.rejects(unselected.currentLogin(), /actor/u);
  await assert.rejects(g.client.switchAccount('alice'), /不允许/u); await assert.rejects(g.client.browserLogin(uiFixture([]).ui), /不允许/u);
  process.env.GH_TOKEN = 'synthetic external forbidden';
  try { const inherited = new GithubClient(f.git.directory, { actor: 'alice', which: () => '/fixture/gh' }); await assert.rejects(inherited.currentLogin(), /GH_TOKEN/u); } finally { delete process.env.GH_TOKEN; }
  await f.session.close(); await assert.rejects(g.client.currentLogin(), /不能回退外部/u); assert.equal(g.calls.length, 0);
});

test('managed authentication enrolls tokens explicitly, verifies actor, and never runs gh auth login/switch', nativeTest, async (t) => {
  const f = await fixture(t), g = ghFixture(f), scripted = uiFixture(['', '']);
  assert.equal(await authenticateGithub(scripted.ui, g.client, 'alice'), 'alice'); assert.deepEqual(scripted.calls, ['ask', 'ask', 'secret']); assert.equal(scripted.secret.every((byte) => byte === 0), true);
  assert.equal(g.calls.some((args) => args[0] === 'auth'), false);
  const mismatch = ghFixture(f, { login: 'bob' }); const ui = uiFixture(['0']); assert.equal(await authenticateGithub(ui.ui, mismatch.client, 'alice'), undefined); assert.equal(mismatch.calls.length, 1);
  await assert.rejects(mismatch.client.writeJson('PATCH', 'repos/acme/demo', {}), /不一致/u); assert.equal(mismatch.calls.some((args) => args[4] === 'PATCH'), false);
});
