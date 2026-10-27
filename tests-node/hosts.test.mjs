import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_HOST, DEFAULT_TRANSPORT, HostStore, hostsMenu, transportUrl, validateTransport } from '../dist/hosts.js';
import { Profile, ProfileStore, boundGit, buildSshArgs, profileGit, testProfile } from '../dist/profiles.js';
import { GitError } from '../dist/git.js';
import { fixture, ScriptedConsole } from './support.mjs';

const enterprise = { mode: 'managed-ssh', host: { provider: 'github-enterprise', host: 'code.example.invalid', apiHost: 'code.example.invalid', webBase: 'https://code.example.invalid', sshHost: 'ssh.example.invalid', sshPort: 2222, sshUser: 'git-enterprise', sshAlias: 'work-alias' } };
function fakeProfile(f) { return new Profile({ profile_id: 'a'.repeat(32), label: 'fake', name: 'Name', email: 'email', github_login: 'login', private_key: join(f.base, 'missing-key'), public_key: join(f.base, 'missing-key.pub') }); }

test('per-project host transport config preserves explicit Enterprise and generic provider boundary', async t => {
  const f = await fixture(t); const store = new HostStore(); assert.equal(await store.get(f.path), undefined); await store.set(f.path, enterprise); assert.deepEqual(await store.get(f.path), enterprise);
  assert.equal(transportUrl('org/repo', enterprise), 'ssh://git-enterprise@ssh.example.invalid:2222/org/repo.git');
  assert.equal(transportUrl('org/repo', { ...enterprise, mode: 'native-ssh' }), 'ssh://git-enterprise@work-alias:2222/org/repo.git');
  assert.equal(transportUrl('org/repo', { ...enterprise, mode: 'https' }), 'https://code.example.invalid/org/repo.git');
  assert.equal(transportUrl('owner/repo'), 'git@github.com:owner/repo.git'); assert.equal(DEFAULT_HOST.apiHost, 'api.github.com');
  assert.equal(validateTransport({ mode: 'https', host: { ...enterprise.host, provider: 'generic', apiHost: '' } }).host.provider, 'generic');
  const aliasTarget = { mode: 'native-ssh', host: { ...enterprise.host, provider: 'generic', host: 'corp_alias', webBase: 'https://corp_alias', sshHost: 'jump_host' } }; assert.equal(validateTransport(aliasTarget).host.sshHost, 'jump_host');
  await store.set(f.path, undefined); assert.deepEqual(Object.keys(await store.all()), []);
});

test('native SSH and HTTPS profile identity do not read managed keys or probe the network', async t => {
  const f = await fixture(t); const profile = fakeProfile(f); const target = { mode: 'native-ssh', host: { ...DEFAULT_HOST, sshAlias: 'existing-alias' } };
  const git = await profileGit(f.path, profile, target); assert.equal(git.overrides['user.name'], profile.name); assert.equal(git.overrides['core.sshCommand'], undefined);
  await new HostStore().set(f.path, { mode: 'native-ssh', host: { ...DEFAULT_HOST, sshHost: 'corp_alias', sshPort: 2200, sshUser: 'deploy' } }); const unbound = await boundGit(f.path); assert.match(unbound.overrides['core.sshCommand'], /-p.*2200/u); assert.match(unbound.overrides['core.sshCommand'], /-l.*deploy/u);
  const https = await profileGit(f.path, profile, { mode: 'https', host: DEFAULT_HOST }); assert.equal(https.overrides['core.sshCommand'], undefined);
  const fakeSsh = join(f.base, 'fake ssh'); await fs.writeFile(fakeSsh, 'FAKE EXECUTABLE');
  const args = buildSshArgs(profile, undefined, () => fakeSsh, { ...enterprise, mode: 'native-ssh' }); assert.ok(args.includes('2222')); assert.ok(args.includes('git-enterprise')); assert.equal(args.includes('-F'), false); assert.equal(args.includes('-i'), false);
  let calls = 0; const result = await testProfile(new ScriptedConsole([]), f.path, profile, { transport: { mode: 'https', host: DEFAULT_HOST }, runProcess: async () => { calls++; throw new Error('must not execute'); } }); assert.equal(result, 'unverified'); assert.equal(calls, 0);
});

for (const quick of [true, false]) {
  test(`native host UI retains its original endpoint/port/user/alias input sequence in ${quick ? 'quick' : 'detailed'} mode`, async t => {
    const f = await fixture(t); const ui = new ScriptedConsole(['1', '2', '2', 'enterprise.example.invalid', '', '', 'ssh.enterprise.example.invalid', '443', 'git', 'jump-alias', '0'], { quick });
    await hostsMenu(ui, f.path); const target = await new HostStore().get(f.path);
    assert.equal(target.mode, 'native-ssh'); assert.equal(target.host.sshHost, 'ssh.enterprise.example.invalid'); assert.equal(target.host.sshAlias, 'jump-alias'); assert.equal(target.host.sshPort, 443); assert.equal(target.host.sshUser, 'git');
    assert.equal(ui.messages.filter(message => /（:q 返回）：$/u.test(message)).length, 7); assert.equal(ui.messages.filter(message => /\[(?:Y\/n|y\/N)\]：$/u.test(message)).length, 0); assert.equal(ui.answers.length, 0);
    assert.match(ui.transcript, /ProxyJump/u); assert.doesNotMatch(ui.transcript, /永不支持|主机配置未完成/u);
  });

  test(`GitHub HTTPS host UI asks no SSH fields and adds no confirmation in ${quick ? 'quick' : 'detailed'} mode`, async t => {
    const f = await fixture(t); const remote = 'https://github.com/fixture/existing.git'; await f.git.run(['remote', 'add', 'origin', remote]); const config = await fs.readFile(join(f.path, '.git', 'config'));
    const ui = new ScriptedConsole(['1', '1', '3', '0'], { quick }); await hostsMenu(ui, f.path);
    assert.deepEqual(await new HostStore().get(f.path), { mode: 'https', host: DEFAULT_HOST });
    assert.equal(ui.messages.filter(message => /（:q 返回）：$/u.test(message)).length, 0); assert.equal(ui.messages.filter(message => /\[(?:Y\/n|y\/N)\]：$/u.test(message)).length, 0); assert.equal(ui.answers.length, 0);
    assert.doesNotMatch(ui.transcript, /SSH endpoint 主机|SSH 端口|SSH 用户|已有 SSH Host alias|主机配置未完成/u);
    assert.equal(await f.git.value('remote', 'get-url', 'origin'), remote); assert.deepEqual(await fs.readFile(join(f.path, '.git', 'config')), config);
  });

  test(`managed host UI omits native-only alias and preserves its existing value in ${quick ? 'quick' : 'detailed'} mode`, async t => {
    const f = await fixture(t); const store = new HostStore(); await store.set(f.path, { ...enterprise, mode: 'native-ssh' });
    const ui = new ScriptedConsole(['1', '2', '1', '', '', '', '', '2222', 'git-enterprise', '0'], { quick }); await hostsMenu(ui, f.path);
    assert.deepEqual(await store.get(f.path), enterprise); assert.doesNotMatch(ui.transcript, /已有 SSH Host alias|主机配置未完成/u);
    assert.equal(ui.messages.filter(message => /（:q 返回）：$/u.test(message)).length, 6); assert.equal(ui.messages.filter(message => /\[(?:Y\/n|y\/N)\]：$/u.test(message)).length, 0); assert.equal(ui.answers.length, 0);
  });
}

test('Enterprise HTTPS editing preserves same-host inactive SSH fields without prompting', async t => {
  const f = await fixture(t); const store = new HostStore(); await store.set(f.path, { ...enterprise, mode: 'native-ssh' });
  const ui = new ScriptedConsole(['1', '2', '3', '', '', '', '0'], { quick: true }); await hostsMenu(ui, f.path);
  assert.deepEqual(await store.get(f.path), { ...enterprise, mode: 'https' }); assert.equal(ui.messages.filter(message => /（:q 返回）：$/u.test(message)).length, 3);
  assert.doesNotMatch(ui.transcript, /SSH endpoint 主机|SSH 端口|SSH 用户|已有 SSH Host alias|主机配置未完成/u); assert.equal(ui.answers.length, 0);
});

test('HTTPS accepts an inactive native SSH endpoint alias and switching back preserves it', async t => {
  const f = await fixture(t); const store = new HostStore();
  const native = { ...enterprise, mode: 'native-ssh', host: { ...enterprise.host, sshHost: 'native_endpoint' } };
  await store.set(f.path, native);
  const httpsUi = new ScriptedConsole(['1', '2', '3', '', '', '', '0'], { quick: true }); await hostsMenu(httpsUi, f.path);
  const https = await store.get(f.path); assert.deepEqual(https, { ...native, mode: 'https' });
  assert.equal(transportUrl('org/repo', https), 'https://code.example.invalid/org/repo.git');
  assert.equal(httpsUi.answers.length, 0); assert.doesNotMatch(httpsUi.transcript, /SSH endpoint 主机|SSH 端口|SSH 用户|已有 SSH Host alias|主机配置未完成/u);
  const nativeUi = new ScriptedConsole(['1', '2', '2', '', '', '', '', '2222', 'git-enterprise', 'work-alias', '0'], { quick: true }); await hostsMenu(nativeUi, f.path);
  assert.deepEqual(await store.get(f.path), native); assert.equal(nativeUi.answers.length, 0);
  assert.doesNotMatch(nativeUi.transcript, /主机配置未完成/u);
  assert.throws(() => validateTransport({ ...https, host: { ...https.host, sshHost: '-oProxyCommand=oops' } }), GitError);
});

for (const mode of [1, 3]) {
  test(`changing host resets old SSH defaults instead of borrowing the previous endpoint in ${mode === 1 ? 'managed SSH' : 'HTTPS'}`, async t => {
    const f = await fixture(t); const store = new HostStore(); await store.set(f.path, enterprise);
    const host = 'next.example.invalid'; const ui = new ScriptedConsole(['1', '2', String(mode), host, '', '', ...(mode === 1 ? ['', '', ''] : []), '0'], { quick: true }); await hostsMenu(ui, f.path);
    assert.deepEqual(await store.get(f.path), { mode: mode === 1 ? 'managed-ssh' : 'https', host: { provider: 'github-enterprise', host, apiHost: host, webBase: `https://${host}`, sshHost: host } });
    assert.equal(ui.answers.length, 0); assert.doesNotMatch(ui.transcript, /SSH endpoint 主机 \[ssh\.example\.invalid\]|主机配置未完成/u);
  });
}

test('generic native SSH still accepts existing endpoint aliases without imposing managed SSH behavior', async t => {
  const f = await fixture(t); const ui = new ScriptedConsole(['1', '3', '2', 'corp_alias', '', 'jump_host', '', '', 'existing-alias', '0'], { quick: true }); await hostsMenu(ui, f.path);
  const target = await new HostStore().get(f.path); assert.equal(target.mode, 'native-ssh'); assert.equal(target.host.host, 'corp_alias'); assert.equal(target.host.sshHost, 'jump_host'); assert.equal(target.host.sshAlias, 'existing-alias');
  assert.equal(transportUrl('org/repo', target), 'git@existing-alias:org/repo.git'); assert.equal(ui.answers.length, 0); assert.doesNotMatch(ui.transcript, /主机配置未完成/u);
});

test('bad target/schema/duplicate host JSON is never silently overwritten', async t => {
  const f = await fixture(t); const store = new HostStore();
  const { sshHost, ...withoutSshHost } = enterprise.host;
  assert.throws(() => validateTransport({ mode: 'https', host: withoutSshHost }), GitError);
  assert.throws(() => validateTransport({ mode: 'managed-ssh', host: { ...enterprise.host, sshHost: 'native_only_endpoint' } }), GitError);
  for (const target of [{ ...enterprise, mode: 'typo' }, { ...enterprise, host: { ...enterprise.host, sshPort: 0 } }, { ...enterprise, host: { ...enterprise.host, sshAlias: '-oProxyCommand=oops' } }, { ...enterprise, host: { ...enterprise.host, provider: 'github' } }, { ...enterprise, host: { ...enterprise.host, webBase: 'https://user:password@code.example.invalid' } }]) assert.throws(() => validateTransport(target), GitError);
  await fs.mkdir(store.directory, { recursive: true }); const file = join(store.directory, 'hosts.json'); const raw = '{"schema_version":1,"schema_version":1,"projects":{}}'; await fs.writeFile(file, raw); await assert.rejects(store.set(f.path, DEFAULT_TRANSPORT), GitError); assert.equal(await fs.readFile(file, 'utf8'), raw);
});
