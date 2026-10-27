import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureClient, issues, context, result, issueData, GitError } from './github-support.mjs';

test('issue pagination excludes PRs without losing a following page of results', async () => {
  const f = fixtureClient({ handler: () => result({ hasNext: true, items: [issueData()] }) });
  const values = await issues.listIssues(f.client, context, 3, 'all');
  assert.equal(values[0].number, 4); assert.equal(values.hasNext, true);
  assert.equal(f.calls[0].args[5], 'repos/acme/demo/issues?state=all&per_page=30&page=3');
  assert.match(f.calls[0].args.at(-1), /select\(.pull_request == null\)/u);
});
test('issue view rejects PR number and wrong id before editing', async () => {
  const f = fixtureClient({ handler: () => result(null) });
  await assert.rejects(issues.viewIssue(f.client, context, 4), /PR/u);
  await assert.rejects(issues.editIssue(f.client, context, 4, { title: 'wrong kind' }), /PR/u);
  assert.ok(f.calls.every(call => call.args[4] === 'GET'));
});
test('issue create sends multiline body, labels and assignees as JSON stdin', async () => {
  const f = fixtureClient({ handler: () => result(issueData(5)) });
  assert.equal((await issues.createIssue(f.client, context, 'title', 'first\nsecond\n@literal', ['bug'], ['bob'])).number, 5);
  const write = f.calls.find(call => call.args[4] === 'POST');
  assert.deepEqual(write.body, { title: 'title', body: 'first\nsecond\n@literal', labels: ['bug'], assignees: ['bob'] });
});
test('issue edits can explicitly clear body/labels/assignees, comment, close and reopen', async () => {
  const f = fixtureClient({ handler: ({ args }) => args[4] === 'GET' ? result(issueData()) : undefined });
  await issues.editIssue(f.client, context, 4, { body: '', labels: [], assignees: [] });
  await issues.editIssue(f.client, context, 4, { title: 'edited' });
  await issues.commentIssue(f.client, context, 4, 'comment\nbody');
  await issues.editIssue(f.client, context, 4, { state: 'closed', state_reason: 'not_planned' });
  await issues.editIssue(f.client, context, 4, { state: 'open', state_reason: 'reopened' });
  const writes = f.calls.filter(call => call.args[4] !== 'GET');
  assert.deepEqual(writes.map(call => call.body), [{ body: '', labels: [], assignees: [] }, { title: 'edited' }, { body: 'comment\nbody' }, { state: 'closed', state_reason: 'not_planned' }, { state: 'open', state_reason: 'reopened' }]);
  assert.equal(f.calls.filter(call => call.args[5] === 'user').length, 5);
});
test('issue invalid field/state/number/control input is rejected offline', async () => {
  const f = fixtureClient();
  await assert.rejects(issues.editIssue(f.client, context, 4, { unsafe: true }), GitError);
  await assert.rejects(issues.editIssue(f.client, context, 4, { state: 'deleted' }), GitError);
  await assert.rejects(issues.commentIssue(f.client, context, -4, 'body'), GitError);
  await assert.rejects(issues.createIssue(f.client, context, 'bad\nflag', ''), GitError);
  assert.equal(f.calls.length, 0);
});
