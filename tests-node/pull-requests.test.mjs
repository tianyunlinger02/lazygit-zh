import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureClient, prs, context, result, prData, Git, GitError } from './github-support.mjs';

test('PR list uses explicit target, pagination and allowlisted native projection', async () => {
  const f = fixtureClient({ handler: () => result([prData()]) });
  assert.equal((await prs.listPullRequests(f.client, context, 2, 'all'))[0].number, 7);
  assert.equal(f.calls[0].args[5], 'repos/acme/demo/pulls?state=all&per_page=30&page=2');
  assert.match(f.calls[0].args.at(-1), /^map\(\{number:/u); assert.match(f.calls[0].args.at(-1), /head: .head.ref/u);
});
test('full PR view includes body, complete diff and first comments; no browser/pager execution', async () => {
  const f = fixtureClient({ handler: ({ args }) => args.includes('Accept: application/vnd.github.diff') ? result('diff --git a/a b/a\n+line\n') : args[5].includes('/comments?') ? result([{ author: 'bob', body: 'comment\ntext', created: '2026-10-27' }]) : result({ ...prData(), body: 'full body\nsecond line' }) });
  const full = await prs.viewPullRequestFull(f.client, context, 7);
  assert.equal(full.body, 'full body\nsecond line'); assert.match(full.diff, /\+line/u); assert.equal(full.comments[0].author, 'bob');
  assert.ok(f.calls.every(call => call.args[0] === 'api' && call.args[4] === 'GET'));
});
test('PR create is an API-only action without implicit push or fork', async () => {
  const f = fixtureClient({ handler: () => result(prData(8)) });
  const pr = await prs.createPullRequest(f.client, context, 'title', 'line one\nline two\n@not-a-file', 'alice:topic', 'main', true);
  assert.equal(pr.number, 8);
  const write = f.calls.find(call => call.args[4] === 'POST');
  assert.deepEqual(write.body, { title: 'title', body: 'line one\nline two\n@not-a-file', head: 'alice:topic', base: 'main', draft: true });
  assert.ok(write.args.includes('--input')); assert.ok(!write.args.includes('--field'));
  assert.ok(f.calls.every(call => call.args[0] === 'api'));
});
test('PR comments, all review kinds, close and reopen have explicit actor and repo', async () => {
  const f = fixtureClient();
  await prs.commentPullRequest(f.client, context, 7, 'body\nline');
  for (const event of ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']) await prs.reviewPullRequest(f.client, context, 7, event, 'review');
  await prs.setPullRequestState(f.client, context, 7, 'closed'); await prs.setPullRequestState(f.client, context, 7, 'open');
  const writes = f.calls.filter(call => call.args[4] !== 'GET');
  assert.equal(writes.length, 6); assert.equal(f.calls.filter(call => call.args[5] === 'user').length, 6);
  assert.deepEqual(writes.map(call => call.body), [{ body: 'body\nline' }, { body: 'review', event: 'APPROVE' }, { body: 'review', event: 'REQUEST_CHANGES' }, { body: 'review', event: 'COMMENT' }, { state: 'closed' }, { state: 'open' }]);
  assert.ok(writes.slice(-2).every(call => call.args[5] === 'repos/acme/demo/pulls/7'));
});
test('merge enforces chosen strategy and checks GitHub merged:true', async t => {
  t.mock.method(Git.prototype, 'run', async () => assert.fail('server PR merge must never invoke native Git'));
  for (const method of ['merge', 'squash', 'rebase']) {
    const f = fixtureClient({ handler: () => result({ merged: true }) });
    await prs.mergePullRequest(f.client, context, 7, method);
    assert.deepEqual(f.calls.find(call => call.args[4] === 'PUT').body, { merge_method: method });
    assert.ok(f.calls.every(call => call.args[0] === 'api'), 'server merge must not run local Git operations');
  }
  const f = fixtureClient({ handler: () => result({ merged: false }) });
  await assert.rejects(prs.mergePullRequest(f.client, context, 7, 'squash'), /未确认/u);
});
test('invalid PR inputs are rejected offline and unknown writes are not retried', async () => {
  const f = fixtureClient();
  await assert.rejects(prs.reviewPullRequest(f.client, context, 0, 'APPROVE', ''), GitError);
  await assert.rejects(prs.reviewPullRequest(f.client, context, 7, 'DELETE', ''), GitError);
  await assert.rejects(prs.mergePullRequest(f.client, context, 7, 'force'), GitError);
  await assert.rejects(prs.commentPullRequest(f.client, context, 7, 'bad\x1b'), GitError);
  assert.equal(f.calls.length, 0);
  const unknown = fixtureClient({ handler: () => result(undefined, 1, 'timeout fixture-secret') });
  await assert.rejects(prs.setPullRequestState(unknown.client, context, 7, 'closed'), error => /结果未知/u.test(error.message) && !error.message.includes('fixture-secret'));
  assert.equal(unknown.calls.filter(call => call.args[4] !== 'GET').length, 1);
});
test('PR checkout API is absent while server collaboration APIs remain available', () => {
  assert.equal('checkoutPullRequest' in prs, false);
  for (const name of ['listPullRequests', 'viewPullRequestFull', 'createPullRequest', 'commentPullRequest', 'reviewPullRequest', 'mergePullRequest', 'setPullRequestState', 'pullRequestsMenu']) assert.equal(typeof prs[name], 'function', name);
});
