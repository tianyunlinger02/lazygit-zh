// Evidence boundary: synthetic encrypted vault + real client/control flow and local Git.
// requestJson is a parsed-response code adapter, NOT HTTP/TLS or real GitHub evidence.
// Push substitutes only the transport with a local bare repository; helper release/security
// is covered separately and is not exercised by that file transport.
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, ScriptedConsole } from './support.mjs';

// Code-only suite seam; no production environment override is added.
const moduleRoot = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { Git, GitError } = await import(new URL('git.js', moduleRoot));
const { PersonalGithubClient, PersonalGithubError } = await import(new URL('github-personal.js', moduleRoot));
const { DEFAULT_HOST, HostStore } = await import(new URL('hosts.js', moduleRoot));
const { Profile, ProfileStore, resolveBinding } = await import(new URL('profiles.js', moduleRoot));
const { CredentialSession, setSession } = await import(new URL('session.js', moduleRoot));
const { Cancelled } = await import(new URL('ui.js', moduleRoot));
const { Vault } = await import(new URL('vault.js', moduleRoot));
const { addRemote, push, saveAndPush, uploadLocal } = await import(new URL('workflows.js', moduleRoot));

const HTTPS = { mode: 'https', host: DEFAULT_HOST };
const TOKEN = 'synthetic_upload_experience_token_never_real';
const labels = { create: '仓库创建', associate: '本地关联', commit: '本地提交', upload: '远端上传', upstream: '默认同步目标' };
function summary(ui) {
  assert.equal(ui.transcript.split('本次操作结果').length - 1, 1, 'one outer task must produce exactly one final summary');
  assert.doesNotMatch(ui.transcript, /synthetic_upload_experience_token|credential-helper|Authorization:|Bearer |[0-9]+%|\u001b\[/u);
  return ui.transcript.split('本次操作结果')[1];
}
function stage(text, name, status) { assert.match(text, new RegExp(`${labels[name]}：${status}(?: ·|\\n|$)`, 'u')); }
function unavailable(phase, state = 'not-created') {
  return new PersonalGithubError('合成只读服务暂时不可用；原始错误已隐藏。', { code: 'unavailable', phase, repositoryState: state, status: 503 });
}
function repository(name, visibility = 'private') {
  return {
    owner: { login: 'Fixture-Login' }, name, full_name: `Fixture-Login/${name}`, private: visibility === 'private',
    html_url: `https://github.com/Fixture-Login/${name}`, ssh_url: `git@github.com:Fixture-Login/${name}.git`,
    clone_url: `https://github.com/Fixture-Login/${name}.git`,
  };
}
async function httpsFixture(t, { bound = false, configured = true } = {}) {
  const f = await fixture(t);
  const password = Buffer.from('synthetic-upload-password');
  let vault;
  try { ({ vault } = await Vault.create(process.env.AUTOGIT_DATA_DIR, password)); } finally { password.fill(0); }
  const session = new CredentialSession(vault); setSession(session);
  t.after(async () => { await session.close(); setSession(undefined); });
  const token = Buffer.from(TOKEN);
  try { await session.storeToken('github.com', 'fixture-login', token); } finally { token.fill(0); }
  t.mock.method(session, 'sshAgent', async () => assert.fail('HTTPS-only workflow must not start an SSH agent'));
  t.mock.method(session, 'storeSsh', async () => assert.fail('HTTPS-only workflow must not store an SSH key'));
  const hosts = new HostStore();
  if (configured) await hosts.set(f.path, HTTPS);
  const store = new ProfileStore(undefined, {
    runProcess: async () => assert.fail('HTTPS-only account must not invoke keygen or SSH'),
    which: () => assert.fail('HTTPS-only account must not locate keygen or SSH'),
  });
  const profile = await store.createHttps(new ScriptedConsole([], { quick: true }), 'Token only', 'HTTPS Author', 'https@example.invalid', 'fixture-login');
  assert.ok(profile);
  if (bound) await store.bind(f.path, profile.profile_id);
  const target = join(f.base, 'upload-experience.git');
  await new Git(f.base).run(['init', '--bare', '--initial-branch=main', target]);
  const state = { calls: [], gitCalls: [], pushes: [], body: undefined, serverName: undefined, handle: undefined };
  t.mock.method(PersonalGithubClient.prototype, 'requestJson', async function (_session, _token, method, path, onSent, onCreated, body, phase) {
    const call = { method, path, phase, ...(body ? { body: JSON.parse(body.toString('utf8')) } : {}) };
    state.calls.push(call);
    if (state.handle) {
      const result = await state.handle(call, { sent: onSent, created: onCreated });
      if (result !== undefined) return result;
    }
    if (method === 'GET' && path === '/user') return { login: 'Fixture-Login' };
    if (method === 'POST' && path === '/user/repos') {
      state.body = call.body; onSent?.(); onCreated?.();
      return repository(state.serverName ?? call.body.name, call.body.private ? 'private' : 'public');
    }
    if (method === 'GET' && path.startsWith('/repos/')) {
      const name = state.serverName ?? path.split('/').at(-1);
      return repository(name, state.body?.private === false ? 'public' : 'private');
    }
    assert.fail(`unexpected parsed-response fixture call: ${method} ${path}`);
  });
  const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    state.gitCalls.push([...args]);
    if (args[0] === 'push') {
      assert.deepEqual(args.slice(0, 3), ['push', '--no-follow-tags', '--']);
      assert.ok(!args.some(arg => /^(?:--force|--mirror|\+)/u.test(arg)));
      const remote = args[3];
      state.pushes.push({ args: [...args], overrides: { ...this.overrides }, ordered: [...this.orderedConfig] });
      return run.call(this.configured({ [`remote.${remote}.pushurl`]: target }), args, options);
    }
    assert.ok(!['fetch', 'pull', 'clone'].includes(args[0]), 'fixture must never launch a network transport');
    assert.ok(args[0] !== 'ls-remote' || args.includes('--get-url'), 'only offline URL resolution is permitted');
    return run.call(this, args, options);
  });
  return { ...f, session, hosts, store, profile, target, state };
}
function writes(f) { return f.state.calls.filter(call => call.method === 'POST'); }
function finalConfirms(ui) { return ui.messages.filter(message => message.startsWith('最终确认：创建')); }
async function assertNoSshArtifacts(f) {
  assert.equal(f.profile.schema_version, 3); assert.equal(f.profile.private_key, null); assert.equal(f.profile.public_key, null);
  assert.deepEqual(await readdir(join(f.store.profilesDir, f.profile.profile_id)), ['profile.json']);
  for (const location of [join(f.store.directory, 'known_hosts'), join(f.home, '.ssh')]) await assert.rejects(stat(location), { code: 'ENOENT' });
}

for (const [visibility, choice] of [['private', '1'], ['public', '2']]) {
  test(`upload UX managed HTTPS ${visibility} creation preserves returned URL case and uploads to local bare with a keyless synthetic account`, async t => {
    const f = await httpsFixture(t); await f.write('upload.txt', 'offline HTTPS workflow\n');
    f.state.serverName = 'Case_Repo';
    const ui = new ScriptedConsole(['1', '1', 'case_repo', choice, 'y', 'a', `offline ${visibility}`, ''], { quick: true });
    assert.equal(await uploadLocal(ui, f.path, { selectDirectory: false }), f.path);
    const url = 'https://github.com/Fixture-Login/Case_Repo.git';
    assert.deepEqual(await f.git.remoteUrls('origin'), [url]); assert.deepEqual(await f.git.remoteUrls('origin', true), [url]);
    assert.equal(writes(f).length, 1); assert.deepEqual(writes(f)[0].body, { name: 'case_repo', private: visibility === 'private', auto_init: false });
    assert.equal(f.state.pushes.length, 1);
    const head = await f.git.value('rev-parse', 'HEAD');
    assert.equal(await new Git(f.target).value('rev-parse', 'refs/heads/main'), head);
    assert.deepEqual(f.state.pushes[0].args, ['push', '--no-follow-tags', '--', 'origin', `${head}:refs/heads/main`]);
    assert.equal(f.state.pushes[0].overrides['user.name'], 'HTTPS Author');
    assert.equal(f.state.pushes[0].overrides['core.sshCommand'], undefined);
    assert.ok(f.state.pushes[0].ordered.some(([key, value]) => key === 'credential.helper' && value === ''));
    assert.equal(await f.git.value('log', '-1', '--format=%an <%ae>'), 'HTTPS Author <https@example.invalid>');
    assert.equal(await f.git.config('user.name'), '测试用户'); assert.equal(await f.git.config('credential.helper'), '');
    assert.equal(await f.git.config('branch.main.remote'), 'origin'); assert.equal(await f.git.config('branch.main.merge'), 'refs/heads/main');
    assert.equal((await resolveBinding(f.path)).profile_id, f.profile.profile_id);
    assert.deepEqual(await f.hosts.get(f.path), HTTPS); await assertNoSshArtifacts(f);
    const result = summary(ui); for (const name of Object.keys(labels)) stage(result, name, '已完成');
    assert.match(result, /Fixture-Login\/Case_Repo/u); assert.equal(finalConfirms(ui).length, 1); assert.deepEqual(ui.answers, []);
  });
}

test('upload UX unconfigured project explicitly chooses and saves recommended HTTPS without changing another project', async t => {
  const f = await httpsFixture(t, { configured: false });
  const other = join(f.base, 'other-project'); await mkdir(other); await new Git(other).run(['init', '--initial-branch=main']);
  assert.equal(await f.hosts.get(f.path), undefined);
  const ui = new ScriptedConsole(['1', '1', '1', 'chosen-https', '1', 'n'], { quick: true });
  assert.equal(await addRemote(ui, f.git), '');
  assert.deepEqual(await f.hosts.get(f.path), HTTPS); assert.equal(await f.hosts.get(other), undefined);
  assert.match(ui.transcript, /HTTPS.*推荐/u); assert.match(ui.transcript, /(?:配置|设置).*保留|(?:保留|已保存).*(?:配置|设置)/u);
  assert.deepEqual(writes(f), []); assert.deepEqual(await f.git.remotes(), []); assert.equal(await resolveBinding(f.path), undefined);
  summary(ui); assert.deepEqual(ui.answers, []);
});

test('upload UX cancelling unconfigured transport choice neither authenticates nor persists a transport', async t => {
  const f = await httpsFixture(t, { configured: false });
  const ui = new ScriptedConsole(['1', '0']);
  assert.equal(await addRemote(ui, f.git), '');
  assert.equal(await f.hosts.get(f.path), undefined); assert.deepEqual(f.state.calls, []); assert.deepEqual(await f.git.remotes(), []);
  summary(ui); assert.deepEqual(ui.answers, []);
});

for (const direction of ['insteadOf', 'pushInsteadOf']) {
  test(`upload UX managed HTTPS creation refuses ${direction} rewrites without falling back to SSH or another repository`, async t => {
    const f = await httpsFixture(t);
    await f.git.run(['config', `url.git@github.com:unexpected/.${direction}`, 'https://github.com/']);
    const ui = new ScriptedConsole(['1', '1', 'rewrite-blocked', '1', 'y'], { quick: true });
    await assert.rejects(addRemote(ui, f.git), /实际获取\/推送目标|规范地址|重写/u);
    assert.equal(writes(f).length, 1); assert.equal(f.state.pushes.length, 0);
    assert.equal(await f.git.config('remote.origin.url'), 'https://github.com/Fixture-Login/rewrite-blocked.git');
    assert.equal(await resolveBinding(f.path), undefined);
    const result = summary(ui); stage(result, 'create', '已完成'); stage(result, 'associate', '部分完成'); stage(result, 'upload', '无需执行');
    assert.deepEqual(ui.answers, []);
  });
}

for (const mutation of ['url-case', 'pushurl', 'multiple-pushurls', 'profile', 'binding', 'transport']) {
  test(`upload UX managed HTTPS creation rechecks ${mutation} after final upload consent and never transports a changed target`, async t => {
    const f = await httpsFixture(t, { bound: true }); await f.write(); await f.commit();
    const original = await f.git.value('rev-parse', 'HEAD');
    const ui = new ScriptedConsole(['1', 'pinned-https', '1', 'y', '', 'y']);
    const confirm = ui.routineConfirm.bind(ui);
    ui.routineConfirm = async (prompt, ...rest) => {
      const answer = await confirm(prompt, ...rest);
      if (prompt.includes('确认联网并上传')) {
        if (mutation === 'url-case') await f.git.run(['remote', 'set-url', 'origin', 'https://github.com/fixture-login/pinned-https.git']);
        else if (mutation === 'pushurl') await f.git.run(['remote', 'set-url', '--push', 'origin', 'https://github.com/other/not-created.git']);
        else if (mutation === 'multiple-pushurls') {
          await f.git.run(['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/Fixture-Login/pinned-https.git']);
          await f.git.run(['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/other/not-created.git']);
        } else if (mutation === 'profile') {
          const changed = new Profile({ ...f.profile, name: 'Different author' });
          await writeFile(join(f.store.profilesDir, f.profile.profile_id, 'profile.json'), JSON.stringify(f.store.encodeProfile(changed)), { mode: 0o600 });
        } else if (mutation === 'binding') await f.store.unbind(f.path);
        else await f.hosts.set(f.path, { mode: 'https', host: DEFAULT_HOST, credentials: 'external' });
      }
      return answer;
    };
    await assert.rejects(uploadLocal(ui, f.path, { selectDirectory: false }), /目标.*发生变化|规范地址|账号或项目绑定|快照已过期|传输配置.*发生变化|多个地址/u);
    assert.equal(writes(f).length, 1); assert.equal(f.state.pushes.length, 0);
    assert.equal(await f.git.value('rev-parse', 'HEAD'), original); assert.equal(await new Git(f.target).hasCommits(), false);
    assert.equal(await f.git.config('branch.main.remote'), ''); summary(ui); assert.deepEqual(ui.answers, []);
  });
}

test('upload UX real post-commit hook cannot replace the managed HTTPS created target with SSH', { skip: process.platform === 'win32' }, async t => {
  const f = await httpsFixture(t); await f.write();
  const hooks = join(f.base, 'synthetic-https-hooks'); await mkdir(hooks);
  const hook = join(hooks, 'post-commit');
  await writeFile(hook, '#!/bin/sh\ngit config remote.origin.url git@github.com:fixture-login/hook-target.git\n'); await chmod(hook, 0o700);
  await f.git.run(['config', 'core.hooksPath', hooks]);
  const ui = new ScriptedConsole(['1', '1', 'hook-target', '1', 'y', 'a', 'preserve committed work'], { quick: true });
  await assert.rejects(uploadLocal(ui, f.path, { selectDirectory: false }), /规范地址|目标.*发生变化/u);
  assert.equal(writes(f).length, 1); assert.equal(f.state.pushes.length, 0); assert.equal(await f.git.hasCommits(), true);
  assert.equal(await f.git.config('remote.origin.url'), 'git@github.com:fixture-login/hook-target.git');
  const result = summary(ui); stage(result, 'create', '已完成'); stage(result, 'commit', '已完成'); stage(result, 'upload', '未执行');
  assert.deepEqual(ui.answers, []);
});

for (const phase of ['prewrite-read', 'verification-read']) {
  test(`upload UX ${phase} read retry retains repository visibility and alias with one final creation consent and one parsed POST`, async t => {
    const f = await httpsFixture(t); const existing = await f.remote();
    let failed = false;
    f.state.handle = async call => {
      if (!failed && call.method === 'GET' && call.phase === phase) { failed = true; throw unavailable(phase, phase === 'verification-read' ? 'created' : 'not-created'); }
    };
    const ui = new ScriptedConsole(['1', '1', 'Preserved_Name', '2', 'preserved-alias', 'y', '1'], { quick: true });
    assert.equal(await addRemote(ui, f.git), 'preserved-alias');
    assert.equal(failed, true); assert.equal(writes(f).length, 1); assert.deepEqual(writes(f)[0].body, { name: 'Preserved_Name', private: false, auto_init: false });
    assert.deepEqual(await f.git.remoteUrls('origin'), [existing]);
    assert.deepEqual(await f.git.remoteUrls('preserved-alias'), ['https://github.com/Fixture-Login/Preserved_Name.git']);
    assert.equal(finalConfirms(ui).length, 1);
    assert.equal(ui.messages.filter(message => message.startsWith('GitHub 仓库名称')).length, 1);
    assert.equal(ui.messages.filter(message => message.startsWith('新地址的本地远程别名')).length, 1);
    assert.equal(ui.messages.filter(message => message.includes('── 仓库可见性（必须明确选择） ──')).length, 1);
    assert.match(ui.transcript, /已有 Token 保留/u); assert.doesNotMatch(ui.transcript, /GitHub Token（不回显|明确录入并核验/u);
    const result = summary(ui); stage(result, 'create', '已完成'); stage(result, 'associate', '已完成'); stage(result, 'commit', '无需执行');
    assert.equal(f.state.pushes.length, 0); assert.deepEqual(ui.answers, []);
  });
}

test('upload UX a local alias collision during read recovery invalidates authorization before the first POST', async t => {
  const f = await httpsFixture(t); let failed = false;
  f.state.handle = async call => { if (!failed && call.phase === 'prewrite-read') { failed = true; throw unavailable('prewrite-read'); } };
  const ui = new ScriptedConsole(['1', '1', 'stale-alias', '1', 'y', '1'], { quick: true });
  const menu = ui.menu.bind(ui);
  ui.menu = async (title, ...rest) => {
    const answer = await menu(title, ...rest);
    if (title === '只读核验未完成') await f.git.run(['remote', 'add', 'origin', 'https://github.com/other/keep.git']);
    return answer;
  };
  await assert.rejects(addRemote(ui, f.git), /没有覆盖/u);
  assert.deepEqual(writes(f), []); assert.deepEqual(await f.git.remoteUrls('origin'), ['https://github.com/other/keep.git']);
  assert.equal(finalConfirms(ui).length, 1); summary(ui); assert.deepEqual(ui.answers, []);
});

test('upload UX a 201 followed by declined verification recovery reports creation not failed or absent', async t => {
  const f = await httpsFixture(t);
  f.state.handle = async call => { if (call.phase === 'verification-read') throw unavailable('verification-read', 'created'); };
  const ui = new ScriptedConsole(['1', '1', 'created-unverified', '1', 'y', '0', '0'], { quick: true });
  assert.equal(await addRemote(ui, f.git), '');
  assert.equal(writes(f).length, 1); assert.deepEqual(await f.git.remotes(), []); assert.equal(await resolveBinding(f.path), undefined);
  assert.equal(ui.messages.filter(message => message.includes('GitHub 仓库已创建：')).length, 1);
  const result = summary(ui); stage(result, 'create', '已完成'); stage(result, 'associate', '未执行');
  assert.match(result, /201|验证未完成|信息验证未完成/u); assert.equal(f.state.pushes.length, 0); assert.deepEqual(ui.answers, []);
});

for (const associate of [false, true]) {
  test(`upload UX unknown parsed POST outcome uses GET inspection then ${associate ? 'explicit association only' : 'declined association'} without replay or automatic upload`, async t => {
    const f = await httpsFixture(t); await f.write('remain-local.txt', 'not implicitly staged\n');
    f.state.handle = async (call, effect) => {
      if (call.method === 'POST') {
        effect.sent();
        throw new PersonalGithubError('合成创建请求结果未知。', { code: 'write-unknown', phase: 'create-write', repositoryState: 'unknown', repositoryUrl: 'https://github.com/fixture-login/unknown-create' });
      }
    };
    const ui = new ScriptedConsole(['1', '1', 'unknown-create', '1', 'y', '1', associate ? 'y' : 'n'], { quick: true });
    assert.equal(await uploadLocal(ui, f.path, { selectDirectory: false }), f.path);
    assert.equal(writes(f).length, 1); assert.equal(f.state.calls.filter(call => call.method === 'GET' && call.path.startsWith('/repos/')).length, 1);
    assert.equal(f.state.pushes.length, 0); assert.equal(await f.git.hasCommits(), false); assert.equal((await f.git.changes())[0].staged, false);
    assert.deepEqual(await f.git.remotes(), associate ? ['origin'] : []);
    assert.equal((await resolveBinding(f.path))?.profile_id, associate ? f.profile.profile_id : undefined);
    assert.match(ui.transcript, /不能.*(?:本次|刚才)|不.*证明.*(?:本次|刚才)/u); assert.equal(finalConfirms(ui).length, 1);
    assert.ok(ui.messages.some(message => /关联/u.test(message) && /\[y\/N\]/u.test(message) && !message.startsWith('最终确认：创建')));
    const result = summary(ui); stage(result, 'create', '结果待核对'); stage(result, 'associate', associate ? '已完成' : '未执行'); stage(result, 'commit', '未执行'); stage(result, 'upload', '未执行');
    assert.deepEqual(ui.answers, []);
  });
}

test('upload UX managed HTTPS binding failure retains the actual added remote and reports partial association', async t => {
  const f = await httpsFixture(t);
  t.mock.method(ProfileStore.prototype, 'bind', async () => { throw new GitError('synthetic binding failed after remote add'); });
  const ui = new ScriptedConsole(['1', '1', 'binding-partial', '1', 'y'], { quick: true });
  await assert.rejects(addRemote(ui, f.git), /synthetic binding failed/u);
  assert.deepEqual(await f.git.remoteUrls('origin'), ['https://github.com/Fixture-Login/binding-partial.git']);
  assert.equal(await resolveBinding(f.path), undefined); assert.equal(f.state.pushes.length, 0);
  const result = summary(ui); stage(result, 'create', '已完成'); stage(result, 'associate', '部分完成'); stage(result, 'commit', '无需执行'); assert.deepEqual(ui.answers, []);
});

for (const interrupted of [false, true]) {
  test(`upload UX commit completion survives ${interrupted ? 'interrupted unknown push' : 'failed push'} with one final summary and no automatic retry`, async t => {
    const f = await fixture(t); const target = await f.remote(); await f.write();
    const run = Git.prototype.run; let attempts = 0;
    t.mock.method(Git.prototype, 'run', async function (args, options) {
      if (args[0] === 'push') { attempts++; throw interrupted ? new Cancelled() : new GitError('synthetic transport rejection'); }
      return run.call(this, args, options);
    });
    const ui = new ScriptedConsole(['a', 'preserve local commit', '1', ''], { quick: true });
    await assert.rejects(saveAndPush(ui, f.path), interrupted ? /上传已中断/u : /上传没有确认成功/u);
    assert.equal(attempts, 1); assert.equal(await f.git.hasCommits(), true); assert.deepEqual(await f.git.changes(), []);
    assert.equal(await new Git(target).hasCommits(), false); assert.equal(await f.git.config('branch.main.remote'), '');
    const result = summary(ui); stage(result, 'commit', '已完成'); stage(result, 'upload', '结果待核对'); stage(result, 'upstream', '未执行'); assert.deepEqual(ui.answers, []);
  });
}

test('upload UX commit display failure does not erase a completed local commit in the final summary', async t => {
  const f = await fixture(t); await f.write(); const run = Git.prototype.run;
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    if (args[0] === 'rev-parse' && args[1] === '--short') throw new GitError('synthetic short OID display failure');
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole(['a', 'commit before display'], { quick: true });
  // Production may safely suppress this display-only error or propagate it; facts must agree either way.
  try { await saveAndPush(ui, f.path, { upload: false }); } catch (error) { assert.match(error.message, /synthetic short OID display failure/u); }
  assert.equal(await f.git.hasCommits(), true); assert.deepEqual(await f.git.changes(), []);
  const result = summary(ui); stage(result, 'commit', '已完成'); stage(result, 'upload', '无需执行'); assert.deepEqual(ui.answers, []);
});

test('upload UX accepted upload and partial upstream write are separated and direct the user not to upload again', async t => {
  const f = await fixture(t, { committed: true }); const target = await f.remote(); const run = Git.prototype.run; let attempts = 0;
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    if (args[0] === 'push') attempts++;
    if (args[0] === 'config' && args[1] === 'branch.main.merge') throw new GitError('synthetic merge config lock');
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole(['1', ''], { quick: true }); await push(ui, f.git);
  assert.equal(attempts, 1); assert.equal(await new Git(target).value('rev-parse', 'refs/heads/main'), await f.git.value('rev-parse', 'HEAD'));
  assert.equal(await f.git.config('branch.main.remote'), 'origin'); assert.equal(await f.git.config('branch.main.merge'), '');
  const result = summary(ui); stage(result, 'upload', '已完成'); stage(result, 'upstream', '部分完成'); assert.match(result, /不必重复上传/u); assert.deepEqual(ui.answers, []);
});
