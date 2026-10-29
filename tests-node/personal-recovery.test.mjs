import assert from 'node:assert/strict';
import test from 'node:test';
import { ScriptedConsole } from './support.mjs';
const moduleRoot = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { PersonalGithubError } = await import(new URL('github-personal.js', moduleRoot));
const { createPersonalRepository } = await import(new URL('personal-repository.js', moduleRoot));
const { withTask } = await import(new URL('task-progress.js', moduleRoot));

// Code-only controller fixture: no HTTP, token access, GitHub request or local Git write.
test('known 201 creation survives a failed separate inspection without downgrading its error or summary to unknown creation', async () => {
  const ui = new ScriptedConsole(['1']); let posts = 0, inspections = 0;
  const client = {
    async createRepository() { posts++; throw new PersonalGithubError('201 confirmed; invalid response', { code: 'protocol', phase: 'verification-read', repositoryState: 'created' }); },
    async inspectRepository() { inspections++; throw new PersonalGithubError('repository not visible', { code: 'not-found', phase: 'verification-read', repositoryState: 'unknown', status: 404 }); },
  };
  await assert.rejects(withTask(ui, undefined, task => createPersonalRepository(ui, { client, owner: 'fixture', name: 'demo', visibility: 'private' }, async () => {}, task)), error => {
    assert.equal(error.repositoryState, 'created'); assert.equal(error.status, 404); assert.equal(error.code, 'not-found');
    assert.match(error.message, /GitHub 已返回 201，仓库已创建/u); return true;
  });
  assert.equal(posts, 1); assert.equal(inspections, 1);
  assert.match(ui.transcript, /仓库创建：已完成/u);
  assert.doesNotMatch(ui.transcript, /仓库创建：结果待核对|仓库创建：失败/u);
});

test('credential and terminal safety guards after 201 preserve created facts and never offer a recovery menu', async () => {
  for (const code of ['session', 'pin', 'debug', 'terminal']) {
    const ui = new ScriptedConsole([]);
    const failure = new PersonalGithubError('controlled safety guard', { code, phase: 'verification-read', repositoryState: 'created' });
    const draft = { owner: 'fixture', name: 'demo', visibility: 'private', client: {
      async createRepository() { throw failure; }, async inspectRepository() { assert.fail('no inspection'); },
    } };
    await assert.rejects(withTask(ui, undefined, task => createPersonalRepository(ui, draft, async () => {}, task)), error => error === failure);
    assert.match(ui.transcript, /仓库创建：已完成/u);
    assert.doesNotMatch(ui.transcript, /先检查远端结果/u);
  }
});
