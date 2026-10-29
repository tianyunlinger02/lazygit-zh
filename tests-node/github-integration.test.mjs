import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratch } from '../scripts/scratch.mjs';
import { root, Git, profiles, resetAppContextForTests, github, prs, repositories, releases, ScriptedConsole } from './github-support.mjs';
const { runProcess, which } = await import(new URL('process.js', root));
const { HostStore, transportUrl } = await import(new URL('hosts.js', root));

async function isolated(t) {
  const saved = { ...process.env };
  const { directory: base, cleanup } = await createScratch('github-integration-');
  t.after(async () => { resetAppContextForTests(); for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); await cleanup(); });
  for (const key of Object.keys(process.env)) if (/^(?:GIT_|GH_|GITHUB_|SSH_|NODE_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/iu.test(key)) delete process.env[key];
  const home = join(base, 'home'); await mkdir(home); resetAppContextForTests();
  Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'AppData'), GH_CONFIG_DIR: join(home, 'gh'), AUTOGIT_DATA_DIR: join(base, 'AutoGit', 'data'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C' });
  const project = join(base, 'project'); await mkdir(project); const git = new Git(project); await git.run(['init', '--initial-branch=main']); await git.run(['config', 'user.name', 'Fixture']); await git.run(['config', 'user.email', 'fixture@example.invalid']); await git.run(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(project, 'file.txt'), 'base\n'); await git.run(['add', '--all']); await git.run(['commit', '-m', 'base']);
  const store = new profiles.ProfileStore(); const profile = await store.create(new ScriptedConsole(['y']), 'Integration', 'Managed Fixture', 'managed@example.invalid', 'alice', { remember_auth: true }); await store.bind(project, profile.profile_id);
  return { base, home, project, git, profile, store };
}
function fakeGhSource() { return `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const body = a.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.FIXTURE_GH_LOG, JSON.stringify({args:a,body,host:process.env.GH_HOST})+'\\n');
const ep=a[5], method=a[4];
if(a[0]!=='api') { process.stderr.write('blocked unexpected gh action');process.exit(81); }
if(ep==='user') { process.stdout.write('alice\\n'); }
else if(ep==='repos/acme/demo' && method==='GET') { process.stdout.write(JSON.stringify({owner:'acme',name:'demo',private:true,description:'offline fixture',default_branch:'main'})); }
else if(ep==='repos/acme/demo/issues' && method==='POST') { const b=JSON.parse(body); process.stdout.write(JSON.stringify({number:42,title:b.title,state:'open',author:'alice',body:b.body,labels:b.labels,assignees:b.assignees})); }
else if(ep==='repos/acme/demo/collaborators/bob' && method==='PUT') { const b=JSON.parse(body); if(b.permission!=='triage')process.exit(82); }
else { process.stderr.write('blocked unexpected fake API');process.exit(83); }
`; }

test('legacy workflow CLI (code-only unlock stub) new GitHub menu creates an Issue and collaborator invitation using only fake gh', { skip: process.platform === 'win32' || !which('ssh') || !which('ssh-keygen') }, async t => {
  const f = await isolated(t), bin = join(f.base, 'bin'); await mkdir(bin); await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
  await writeFile(join(bin, 'gh'), fakeGhSource(), { mode: 0o700 });
  const log = join(f.base, 'gh.jsonl'); const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FIXTURE_GH_LOG: log };
  // GitHub group -> Issue menu -> explicit target -> create -> final confirmation -> return.
  // Repository management also invites a collaborator, entirely under the same fixture actor.
  const answers = ['3', '12', '', '', 'acme', '3', 'demo', '2', 'CLI issue fixture', '3', '', '', 'y', '0', '9', 'acme', '3', 'demo', '3', 'bob', '2', 'y', '0', '0', '0'];
  const cliPath = fileURLToPath(new URL('./cli-driver.mjs', import.meta.url));
  const result = await runProcess(process.execPath, [cliPath, '--path', f.project], { cwd: f.base, env, inputData: Buffer.from(answers.join('\n') + '\n') });
  const text = result.stdout.toString() + result.stderr.toString(); assert.equal(result.status, 0, text); assert.match(text, /已创建 Issue #42/u); assert.match(text, /GitHub 已接受权限请求/u); assert.match(text, /已退出/u); assert.doesNotMatch(text, /程序异常/u);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.every(call => call.host === 'github.com'));
  assert.equal(calls.filter(call => call.args[4] === 'POST').length, 1); assert.equal(calls.filter(call => call.args[4] === 'PUT').length, 1);
  const post = calls.find(call => call.args[4] === 'POST'); assert.equal(post.args[5], 'repos/acme/demo/issues'); assert.deepEqual(JSON.parse(post.body), { title: 'CLI issue fixture', body: '', labels: [], assignees: [] });
  assert.deepEqual(await f.git.remotes(), []); assert.equal(await f.git.value('rev-list', '--count', 'HEAD'), '1');
  if (process.env.AUTOGIT_VERIFICATION_DIR) await writeFile(join(process.env.AUTOGIT_VERIFICATION_DIR, 'github-cli-collaboration-0.5.0.txt'), `OFFLINE ONLY: fake gh; no GitHub or real credentials.\n${text}\nCalls:\n${JSON.stringify(calls, null, 2)}\n`);
});

test('PR submenu keeps remote collaboration actions without local checkout', { skip: process.platform === 'win32' || !which('ssh') || !which('ssh-keygen') }, async t => {
  const f = await isolated(t), bin = join(f.base, 'bin'); await mkdir(bin); await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
  await writeFile(join(bin, 'gh'), fakeGhSource(), { mode: 0o700 });
  const log = join(f.base, 'gh.jsonl'); Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, FIXTURE_GH_LOG: log });
  const head = await f.git.value('rev-parse', 'HEAD');
  const ui = new ScriptedConsole(['', 'acme', '3', 'demo', '0'], { quick: true });
  const menus = [], original = ui.menu;
  t.mock.method(ui, 'menu', async function(title, options, back) {
    menus.push({ title, options: [...options] });
    return original.call(this, title, options, back);
  });
  await prs.pullRequestsMenu(ui, f.project);
  const menu = menus.find(item => item.title === 'Pull requests · acme/demo'); assert.ok(menu);
  assert.deepEqual(menu.options, ['列出 PR', '查看 PR', '创建 PR', '评论 PR', 'review：approve / request-changes / comment', '合并 PR（服务端）', '关闭 PR', '重新打开 PR', '重新选择仓库']);
  assert.ok(menu.options.every(option => !/checkout/iu.test(option)));
  assert.equal(Object.hasOwn(prs, 'checkoutPullRequest'), false, 'retired checkout must not remain an exported API');
  assert.deepEqual(ui.answers, []); assert.equal(await f.git.branch(), 'main');
  assert.equal(await f.git.value('rev-parse', 'HEAD'), head); assert.deepEqual(await f.git.remotes(), []);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.length > 0); assert.ok(calls.every(call => call.args[0] === 'api' && call.args[4] === 'GET'));
});

test('new local Tag is routine and has no additional GitHub actor request; deletion stays hard', { skip: process.platform === 'win32' || !which('ssh') || !which('ssh-keygen') }, async t => {
  const f = await isolated(t), transport = enterpriseTransport('https'); let checks = 0, actorChecks = 0;
  const client = new github.GithubClient(f.project, { host: transport.host.host, actor: 'alice', env: { PATH: '/fixture/bin', HOME: '/fixture/home' }, which: () => '/fixture/gh', runProcess: async () => { throw new Error('local Tag must not contact gh'); } });
  client.ensureActor = async () => { actorChecks++; throw new Error('local Tag must not check actor'); };
  const session = { client, host: transport.host.host, directory: f.project, profile: f.profile, transport, checkProfile: async () => { checks++; } };
  const context = github.repositoryContext(transport.host.host, 'acme', 'demo');
  const createUi = new ScriptedConsole(['2', 'local-tag', '', '', '0'], { quick: true });
  await releases.tagsMenu(createUi, session, context);
  assert.equal(await f.git.value('rev-parse', 'refs/tags/local-tag'), await f.git.value('rev-parse', 'HEAD')); assert.equal(actorChecks, 0); assert.equal(checks, 1); assert.doesNotMatch(createUi.transcript, /最终确认/u);
  const decline = new ScriptedConsole(['3', 'local-tag', 'n', '0'], { quick: true });
  await releases.tagsMenu(decline, session, context); assert.match(decline.transcript, /最终确认/u); assert.equal(actorChecks, 0);
  assert.equal((await f.git.run(['show-ref', '--verify', '--quiet', 'refs/tags/local-tag'], { check: false })).status, 0);
});

function enterpriseTransport(mode) {
  return { mode, host: { provider: 'github-enterprise', host: 'git.example.invalid', apiHost: 'api.example.invalid', webBase: 'https://git.example.invalid', sshHost: 'ssh.example.invalid', ...(mode === 'https' ? {} : { sshPort: 2222, sshUser: 'git' }), ...(mode === 'native-ssh' ? { sshAlias: 'enterprise-alias' } : {}) } };
}
for (const mode of ['managed-ssh', 'native-ssh', 'https']) {
  test(`GitHub clone preserves Enterprise ${mode} transport, endpoint/port and new project binding`, { skip: process.platform === 'win32' || !which('ssh') || !which('ssh-keygen') }, async t => {
    const f = await isolated(t), transport = enterpriseTransport(mode), hosts = new HostStore();
    await hosts.set(f.project, transport);
    const bare = join(f.base, 'clone-source.git'); await mkdir(bare); await new Git(bare).run(['init', '--bare', '--initial-branch=main']); await f.git.run(['push', '--', bare, 'refs/heads/main:refs/heads/main']);
    const address = transportUrl('acme/demo', transport), realGit = which('git'), bin = join(f.base, 'bin'), log = join(f.base, 'clone.jsonl'); await mkdir(bin); await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
    await writeFile(join(bin, 'gh'), fakeGhSource(), { mode: 0o700 });
    await writeFile(join(bin, 'git'), `#!${process.execPath}
const fs=require('node:fs');const {spawnSync}=require('node:child_process');const a=process.argv.slice(2);const i=a.indexOf('clone');
if(i>=0){const j=a.indexOf('--',i);if(a[j+1]!==process.env.FIXTURE_EXPECTED_URL)throw new Error('unmapped clone denied');fs.appendFileSync(process.env.FIXTURE_GIT_LOG,JSON.stringify(a)+'\\n');a.unshift('-c','url.'+process.env.FIXTURE_BARE+'.insteadOf='+process.env.FIXTURE_EXPECTED_URL);}
else if(a.some(x=>['fetch','push','pull'].includes(x))||a.includes('ls-remote')&&!a.includes('--get-url'))throw new Error('unmapped transport denied');
const r=spawnSync(process.env.FIXTURE_REAL_GIT,a,{stdio:'inherit',env:process.env,shell:false});process.exit(r.status??1);
`, { mode: 0o700 });
    Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, FIXTURE_REAL_GIT: realGit, FIXTURE_BARE: bare, FIXTURE_EXPECTED_URL: address, FIXTURE_GIT_LOG: log, FIXTURE_GH_LOG: join(f.base, 'gh.jsonl'), GIT_ALLOW_PROTOCOL: 'file' });
    const sessionUi = new ScriptedConsole(['']); const session = await repositories.githubSession(sessionUi, f.project);
    assert.equal(session.host, 'git.example.invalid'); assert.deepEqual(session.transport, transport); assert.match(sessionUi.transcript, /\[git.example.invalid\]/u);
    if (mode === 'native-ssh') await mkdir(join(f.base, `clone-${mode}`));
    const ui = new ScriptedConsole([f.base, `clone-${mode}`], { quick: true });
    const cloned = await repositories.cloneRepository(ui, session, github.repositoryContext(session.host, 'acme', 'demo'));
    assert.equal(cloned, join(f.base, `clone-${mode}`));
    assert.deepEqual(await hosts.get(cloned), transport); assert.equal((await profiles.resolveBinding(cloned)).profile_id, f.profile.profile_id);
    assert.equal(await new Git(cloned).config('remote.origin.url'), address); assert.equal(await new Git(cloned).value('rev-parse', 'HEAD'), await f.git.value('rev-parse', 'HEAD'));
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.equal(calls.length, 1);
    const ssh = calls[0].find(arg => arg.startsWith('core.sshCommand='));
    if(mode === 'managed-ssh') { assert.ok(ssh.includes('IdentitiesOnly=yes')); assert.ok(ssh.includes("'-p' '2222'")); assert.ok(ssh.includes(f.profile.private_key)); }
    else if(mode === 'native-ssh') { assert.ok(ssh.includes("'-p' '2222'")); assert.ok(!ssh.includes('IdentitiesOnly=yes')); assert.ok(!ssh.includes(f.profile.private_key)); assert.ok(address.includes('@enterprise-alias:2222/')); }
    else { assert.equal(ssh, undefined); assert.equal(address, 'https://git.example.invalid/acme/demo.git'); assert.match(ui.transcript, /凭据助手/u); }
    assert.match(ui.transcript, /主机 \/ 传输配置已保存/u);
    assert.ok((await readFile(process.env.FIXTURE_GH_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).every(call => call.host === 'git.example.invalid'));
    if (mode === 'https') {
      const originalSet = HostStore.prototype.set;
      HostStore.prototype.set = async function () { throw new Error('fixture metadata write failure'); };
      try {
        const partialUi = new ScriptedConsole([f.base, 'clone-metadata-failure'], { quick: true });
        const partial = await repositories.cloneRepository(partialUi, session, github.repositoryContext(session.host, 'acme', 'demo'));
        assert.equal(await new Git(partial).value('rev-parse', 'HEAD'), await f.git.value('rev-parse', 'HEAD'));
        assert.equal(await hosts.get(partial), undefined); assert.equal(await profiles.resolveBinding(partial), undefined);
        assert.match(partialUi.transcript, /下载已完成/u); assert.match(partialUi.transcript, /尚未保存，账号绑定未完成/u);
      } finally { HostStore.prototype.set = originalSet; }
    }
  });
}

test('generic project does not become the default GitHub API provider', { skip: process.platform === 'win32' || !which('ssh') || !which('ssh-keygen') }, async t => {
  const f = await isolated(t), hosts = new HostStore();
  const generic = { mode: 'https', host: { provider: 'generic', host: 'gitlab.example.invalid', apiHost: '', webBase: 'https://gitlab.example.invalid', sshHost: 'gitlab.example.invalid' } }; await hosts.set(f.project, generic);
  const bin = join(f.base, 'bin'); await mkdir(bin); await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}'); await writeFile(join(bin, 'gh'), fakeGhSource(), { mode: 0o700 }); Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH}`, FIXTURE_GH_LOG: join(f.base, 'gh.jsonl') });
  const ui = new ScriptedConsole(['']), session = await repositories.githubSession(ui, f.project);
  assert.equal(session.host, 'github.com'); assert.equal(session.transport.host.provider, 'github'); assert.match(ui.transcript, /generic Git/u); assert.match(ui.transcript, /\[github.com\]/u);
  assert.throws(() => repositories.githubTransport({ ...session, transport: generic }), /generic/u);
});
