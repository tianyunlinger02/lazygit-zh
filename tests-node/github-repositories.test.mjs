import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureClient, repositories as r, github, ScriptedConsole, session, context, result, repoData, GitError } from './github-support.mjs';

test('GitHub host/context rejects implicit or credential-bearing targets offline', () => {
  for (const host of ['https://github.com', 'github.com/path', 'github.com:443', 'user@github.com', '-bad.example', 'localhost', 'github.com\n']) assert.throws(() => github.repositoryContext(host, 'acme', 'demo'), GitError);
  assert.deepEqual(github.repositoryContext('git.example.invalid', 'acme', 'demo'), { host: 'git.example.invalid', owner: 'acme', name: 'demo' });
  assert.equal(github.repositorySsh(github.repositoryContext('git.example.invalid', 'acme', 'demo')), 'git@git.example.invalid:acme/demo.git');
});
test('organization creation checks selected actor, allows owner != actor, and canonical Enterprise host', async () => {
  const host = 'git.example.invalid';
  const f = fixtureClient({ host, handler: ({ args }) => args[0] === 'repo' ? result() : result({ owner: { login: 'acme' }, name: 'demo', full_name: 'acme/demo', private: true, html_url: `https://${host}/acme/demo`, ssh_url: `git@${host}:acme/demo.git`, clone_url: `https://${host}/acme/demo.git` }) });
  const created = await f.client.createRepository('acme', 'demo', 'private');
  assert.equal(created.owner, 'acme'); assert.equal(created.sshUrl, `git@${host}:acme/demo.git`);
  assert.deepEqual(f.calls.find(call => call.args[0] === 'repo').args, ['repo', 'create', 'acme/demo', '--private']);
  assert.ok(f.calls.every(call => call.options.env.GH_HOST === host));
  assert.ok(f.calls.filter(call => call.args[0] === 'api').every(call => call.args[2] === host));
});
test('repository actor mismatch prevents writes, with no token/status/config command', async () => {
  const f = fixtureClient();
  f.client.currentLogin = async () => 'other';
  await assert.rejects(r.deleteRepository(f.client, context), /actor/u);
  assert.equal(f.calls.length, 0);
});
test('repository list pages preserve private own repositories and use organization endpoint', async () => {
  const f = fixtureClient({ handler: ({ args }) => args[5] === 'users/acme' ? result({ type: 'Organization' }) : result([repoData(args[5].startsWith('user/repos') ? 'alice' : 'acme')]) });
  assert.equal((await r.listRepositories(f.client, 'alice', 2))[0].owner, 'alice');
  assert.equal((await r.listRepositories(f.client, 'acme', 3))[0].owner, 'acme');
  const endpoints = f.calls.map(call => call.args[5]);
  assert.ok(endpoints.includes('user/repos?affiliation=owner&per_page=30&page=2&sort=updated'));
  assert.ok(endpoints.includes('orgs/acme/repos?per_page=30&page=3&sort=updated'));
  assert.ok(f.calls.every(call => call.args[4] === 'GET' && call.args.includes('--jq')));
});
test('search is encoded with explicit owner and rejects cross-owner response', async () => {
  const f = fixtureClient({ handler: () => result([repoData()]) });
  await r.listRepositories(f.client, 'acme', 2, 'hello & sort:updated');
  assert.match(f.calls[0].args[5], /^search\/repositories\?q=hello%20%26%20sort%3Aupdated%20user%3Aacme&per_page=30&page=2$/u);
  const bad = fixtureClient({ handler: () => result([repoData('evil')]) });
  await assert.rejects(r.listRepositories(bad.client, 'acme', 1, 'x'), /owner/u);
});
test('view enforces repository identity and strict projected response', async () => {
  const f = fixtureClient({ handler: () => result(repoData()) });
  assert.equal((await r.viewRepository(f.client, context)).private, true);
  const bad = fixtureClient({ handler: () => result({ ...repoData(), token: 'fixture-secret' }) });
  await assert.rejects(r.viewRepository(bad.client, context), error => error instanceof GitError && !error.message.includes('fixture-secret'));
});
test('repository update, fork and delete use explicit API paths and JSON stdin only', async () => {
  const f = fixtureClient();
  await r.updateRepository(f.client, context, { private: false });
  await r.updateRepository(f.client, context, { name: 'renamed' });
  await r.forkRepository(f.client, context, 'alice', 'personal-fork');
  await r.forkRepository(f.client, context, 'another-org', 'org-fork');
  await r.deleteRepository(f.client, context);
  const writes = f.calls.filter(call => call.args[4] !== 'GET');
  assert.deepEqual(writes.map(call => [call.args[4], call.args[5], call.body]), [
    ['PATCH', 'repos/acme/demo', { private: false }], ['PATCH', 'repos/acme/demo', { name: 'renamed' }],
    ['POST', 'repos/acme/demo/forks', { name: 'personal-fork' }], ['POST', 'repos/acme/demo/forks', { name: 'org-fork', organization: 'another-org' }], ['DELETE', 'repos/acme/demo', undefined],
  ]);
  assert.equal(f.calls.filter(call => call.args[5] === 'user').length, writes.length);
  assert.ok(f.calls.every(call => call.args[0] === 'api')); // no gh repo fork, clone or remote side effects
});
test('collaborator invite/update/remove and team roles use whitelisted permissions', async () => {
  const f = fixtureClient();
  await r.setCollaborator(f.client, context, 'bob', 'triage'); await r.setCollaborator(f.client, context, 'bob', 'admin'); await r.setCollaborator(f.client, context, 'bob', undefined);
  await r.setTeamPermission(f.client, context, 'acme', 'developers', 'push'); await r.setTeamPermission(f.client, context, 'acme', 'developers', undefined);
  const before = f.calls.length;
  await assert.rejects(r.setTeamPermission(f.client, context, 'wrong', 'developers', 'admin'), GitError);
  await assert.rejects(r.setCollaborator(f.client, context, 'bob', 'owner'), GitError);
  assert.equal(f.calls.length, before);
  assert.deepEqual(f.calls.filter(call => call.args[4] !== 'GET').map(call => [call.args[4], call.args[5], call.body]), [
    ['PUT', 'repos/acme/demo/collaborators/bob', { permission: 'triage' }], ['PUT', 'repos/acme/demo/collaborators/bob', { permission: 'admin' }], ['DELETE', 'repos/acme/demo/collaborators/bob', undefined], ['PUT', 'orgs/acme/teams/developers/repos/acme/demo', { permission: 'push' }], ['DELETE', 'orgs/acme/teams/developers/repos/acme/demo', undefined],
  ]);
});
test('one final summary confirmation cannot be skipped in quick mode; decline is inert', async () => {
  for (const quick of [false, true]) {
    const f = fixtureClient(); let checks = 0;
    const ui = new ScriptedConsole(['n'], { quick });
    assert.equal(await r.confirmGithubWrite(ui, session(f.client, { checkProfile: async () => checks++ }), context, 'delete', '不可撤销'), false);
    assert.equal(checks, 0); assert.equal(f.calls.length, 0); assert.match(ui.transcript, /actor：alice/u); assert.match(ui.transcript, /仓库：acme\/demo/u);
    const accept = new ScriptedConsole(['y'], { quick });
    assert.equal(await r.confirmGithubWrite(accept, session(f.client, { checkProfile: async () => checks++ }), context, 'rename', 'name'), true); assert.equal(checks, 1);
  }
});
test('page navigation reaches second page and supports filtered-empty pages via hasNext', async () => {
  const loaded = [], ui = new ScriptedConsole(['1', '1']);
  const selected = await r.pagedSelection(ui, 'fixture', async page => { loaded.push(page); return page === 1 ? Object.assign([], { hasNext: true }) : ['second']; }, String);
  assert.equal(selected, 'second'); assert.deepEqual(loaded, [1, 2]);
});
test('unknown remote write outcome redacts stderr and never retries or compensates', async () => {
  const f = fixtureClient({ handler: () => result('fixture-secret', 1, 'connection reset fixture-secret') });
  await assert.rejects(r.deleteRepository(f.client, context), error => /结果未知/u.test(error.message) && !error.message.includes('fixture-secret'));
  assert.equal(f.calls.filter(call => call.args[4] === 'DELETE').length, 1);
});
test('remote display neutralizes terminal escapes and bidirectional controls', () => { assert.equal(github.safeDisplay('hello\x1b[2J‮'), 'hello\\u001b[2J\\u202e'); });
test('routine GitHub downloads/local work skip only quick confirmation and always check profile', async () => {
  const f = fixtureClient(); let checks = 0;
  const selected = session(f.client, { checkProfile: async () => { checks++; } });
  const quick = new ScriptedConsole([], { quick: true });
  assert.equal(await r.confirmGithubRoutine(quick, selected, context, 'download', 'new file'), true);
  assert.equal(checks, 1); assert.equal(f.calls.length, 0); assert.doesNotMatch(quick.transcript, /最终确认/u);
  const decline = new ScriptedConsole(['n'], { quick: false });
  assert.equal(await r.confirmGithubRoutine(decline, selected, context, 'tag', 'new tag'), false); assert.equal(checks, 1);
  const stale = session(f.client, { checkProfile: async () => { throw new GitError('fixture profile changed'); } });
  await assert.rejects(r.confirmGithubRoutine(new ScriptedConsole([], { quick: true }), stale, context, 'download', ''), /profile changed/u);
});
