import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createScratch } from '../scripts/scratch.mjs';
async function temporary(t) { const { directory, cleanup } = await createScratch('public-key-'); t.after(cleanup); return directory; }
import { publicKeys, GitError, fixtureClient, session, result, ScriptedConsole } from './github-support.mjs';

const valid = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF2e9wQyZ3bD0B8qV8l5YJxWf+QxJ7uW6p+2Cj4c8rM9 fixture';
test('public key parser accepts only matching OpenSSH public material and returns fingerprint', () => {
  const parsed = publicKeys.parsePublicKey(valid, '/fixture/key.pub');
  assert.equal(parsed.algorithm, 'ssh-ed25519'); assert.match(parsed.fingerprint, /^SHA256:/u); assert.equal(parsed.text, valid);
  for (const bad of ['id_ed25519 PRIVATE', 'ssh-ed25519 bad', 'ssh-rsa AAAA', valid.replace('ssh-ed25519', 'ssh-rsa'), `${valid}\nsecond`]) assert.throws(() => publicKeys.parsePublicKey(bad), GitError);
});
test('public-key reader checks .pub before filesystem and refuses links/oversize/private names', async t => {
  const dir = await temporary(t);
  await writeFile(join(dir, 'key.pub'), valid); await writeFile(join(dir, 'private'), valid); await chmod(join(dir, 'private'), 0o600);
  await assert.rejects(publicKeys.readPublicKey(join(dir, 'private')), /\.pub/u);
  assert.equal((await publicKeys.readPublicKey(join(dir, 'key.pub'))).algorithm, 'ssh-ed25519');
  await writeFile(join(dir, 'bad.pub'), 'PRIVATE SECRET'); await assert.rejects(publicKeys.readPublicKey(join(dir, 'bad.pub')), GitError);
  await symlink(join(dir, 'key.pub'), join(dir, 'link.pub')); await assert.rejects(publicKeys.readPublicKey(join(dir, 'link.pub')), GitError);
});
test('upload sends only public bytes through gh ssh-key add and keeps title explicit', async t => {
  const f = fixtureClient({ handler: ({ args }) => args[0] === 'ssh-key' ? result() : undefined });
  const ui = new ScriptedConsole(['', 'title', 'y']);
  const temp = await temporary(t); const file = join(temp, 'key.pub'); await writeFile(file, valid);
  await publicKeys.uploadPublicKey(ui, session(f.client, { profile: { github_login: 'alice', label: 'Fixture', public_key: file } }));
  const call = f.calls.find(item => item.args[0] === 'ssh-key'); assert.deepEqual(call.args, ['ssh-key', 'add', '-', '--title', 'title', '--type', 'authentication']); assert.equal(call.options.inputData.toString(), `${valid}\n`); assert.doesNotMatch(call.options.inputData.toString(), /PRIVATE/u);
});
test('unknown public-key write is not retried or deleted', async t => {
  const f = fixtureClient({ handler: ({ args }) => args[0] === 'ssh-key' ? result(undefined, 1, 'timeout fixture-secret') : undefined });
  const temp = await temporary(t); const file = join(temp, 'key.pub'); await writeFile(file, valid);
  await assert.rejects(publicKeys.uploadPublicKey(new ScriptedConsole(['', 'title', 'y']), session(f.client, { profile: { github_login: 'alice', label: 'Fixture', public_key: file } })), error => /结果未知/u.test(error.message) && !error.message.includes('fixture-secret'));
  assert.equal(f.calls.filter(item => item.args[0] === 'ssh-key').length, 1);
});
