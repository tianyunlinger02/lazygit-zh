import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Git, GitError } from '../dist/git.js';
import { explicitGitTransport } from '../dist/github-repositories.js';
import { fixture } from './support.mjs';

test('explicit command-scoped push target works on Git 2.34 and cannot follow pushInsteadOf', async t => {
  const f = await fixture(t, { committed: true });
  const intended = join(f.base, 'intended.git'), other = join(f.base, 'other.git');
  for (const directory of [intended, other]) { await mkdir(directory); await new Git(directory).run(['init', '--bare', '--initial-branch=main']); }
  await f.git.run(['config', `url.${other}.pushInsteadOf`, intended]);
  const before = await f.git.value('config', '--local', '--list');
  const transport = await explicitGitTransport(f.git, intended, true);
  await transport.git.run(['push', '--no-follow-tags', '--', transport.remote, 'HEAD:refs/heads/main']);
  assert.equal(await new Git(intended).value('rev-parse', 'refs/heads/main'), await f.git.value('rev-parse', 'HEAD'));
  assert.notEqual((await new Git(other).run(['rev-parse', '--verify', 'refs/heads/main'], { check: false })).status, 0);
  assert.equal(await f.git.value('config', '--local', '--list'), before);
  assert.deepEqual(await f.git.remotes(), []);
});

test('explicit command-scoped targets reject insteadOf rewrites without any network request', async t => {
  const f = await fixture(t);
  await f.git.run(['config', 'url.https://other.example.invalid/.insteadOf', 'https://github.com/']);
  await assert.rejects(explicitGitTransport(f.git, 'https://github.com/acme/demo.git', true), GitError);
  assert.deepEqual(await f.git.remotes(), []);
});
