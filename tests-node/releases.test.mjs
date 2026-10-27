import assert from 'node:assert/strict';
import test from 'node:test';
import { link, lstat, readFile, readdir, rename, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createScratch } from '../scripts/scratch.mjs';
import { fixtureClient, releases, context, result, releaseData, ScriptedConsole, session, GitError } from './github-support.mjs';

test('release list/view use explicit repo and bounded projections', async () => {
  const f = fixtureClient({ handler: ({ args }) => args[5].includes('/releases/') ? result(releaseData()) : result([releaseData()]) });
  assert.equal((await releases.listReleases(f.client, context, 2))[0].id, 12);
  assert.equal((await releases.viewRelease(f.client, context, 12)).tag, 'v0.5.0');
  assert.equal(f.calls[0].args[5], 'repos/acme/demo/releases?per_page=30&page=2');
});
test('release creation refuses implicit tag creation and sends draft/prerelease choices', async () => {
  const f = fixtureClient({ handler: ({ args }) => args[5].includes('/git/ref/tags/') ? result({ ref: 'refs/tags/v0.5.0' }) : result(releaseData(13)) });
  const release = await releases.createRelease(f.client, context, 'v0.5.0', 'name', 'body\nline', true, false);
  assert.equal(release.id, 13);
  const write = f.calls.find(call => call.args[4] === 'POST'); assert.deepEqual(write.body, { tag_name: 'v0.5.0', name: 'name', body: 'body\nline', draft: true, prerelease: false });
  const absent = fixtureClient({ handler: ({ args }) => args[5].includes('/git/ref/tags/') ? result(undefined, 1, 'Not Found fixture-secret') : undefined });
  await assert.rejects(releases.createRelease(absent.client, context, 'missing', 'n', '', false, false), error => /404/u.test(error.message) && !error.message.includes('fixture-secret'));
  assert.equal(absent.calls.filter(call => call.args[4] === 'POST').length, 0);
});
test('release edit/publish/delete and asset list/edit/delete are separate explicit writes', async () => {
  const asset = { id: 30, name: 'a.zip', size: 3, contentType: 'application/zip', state: 'uploaded' };
  const f = fixtureClient({ handler: ({ args }) => args[5].includes('/assets?') ? result([asset]) : undefined });
  await releases.editRelease(f.client, context, 12, { name: 'renamed', body: '', prerelease: true });
  await releases.editRelease(f.client, context, 12, { draft: false });
  assert.equal((await releases.listReleaseAssets(f.client, context, 12))[0].id, 30);
  await releases.editReleaseAsset(f.client, context, 30, 'renamed.zip', 'label');
  await releases.deleteReleaseAsset(f.client, context, 30); await releases.deleteRelease(f.client, context, 12);
  const writes = f.calls.filter(call => call.args[4] !== 'GET');
  assert.deepEqual(writes.map(call => call.body), [{ name: 'renamed', body: '', prerelease: true }, { draft: false }, { name: 'renamed.zip', label: 'label' }, undefined, undefined]);
  assert.ok(writes.every(call => call.args[0] === 'api'));
});
test('release malformed fields and asset destination protections fail offline', async () => {
  const f = fixtureClient({ handler: () => result({ id: 1, name: 'missing fields' }) });
  await assert.rejects(releases.viewRelease(f.client, context, 1), GitError);
  await assert.rejects(releases.deleteReleaseAsset(f.client, context, 0), GitError);
  await assert.rejects(releases.editRelease(f.client, context, 1, { bad: 'field' }), GitError);
});
test('release download installs new files exclusively and replaces only an unchanged hashed file', async t => {
  const { directory, cleanup } = await createScratch('release-download-'); t.after(cleanup);
  const asset = { id: 30, name: 'asset.bin', size: 3, contentType: 'application/octet-stream', state: 'uploaded' };
  const bytes = Buffer.from('new');
  const f = fixtureClient({ handler: ({ args }) => args[5].includes('/assets/30') ? result(bytes) : undefined });
  const destination = join(directory, 'asset.bin');
  await releases.downloadReleaseAsset(f.client, context, asset, destination);
  assert.deepEqual(await readFile(destination), bytes); assert.equal(f.calls.filter(call => call.args[4] === 'GET').length, 1);
  await assert.rejects(releases.downloadReleaseAsset(f.client, context, asset, destination), /已存在/u);
  await writeFile(destination, 'old');
  const ui = new ScriptedConsole([directory, 'asset.bin', '2', 'y']);
  await releases.downloadReleaseAssetGuided(ui, session(f.client), context, { id: 12, tag: 'v0.5.0', name: 'release', body: '', draft: false, prerelease: false, published: '' }, asset);
  assert.deepEqual(await readFile(destination), bytes); assert.match(ui.transcript, /原文件 SHA-256/u);
  if (process.platform !== 'win32') {
    const symbolic = join(directory, 'link.bin'); await symlink(destination, symbolic);
    await assert.rejects(releases.downloadReleaseAsset(f.client, context, asset, symbolic), GitError);
  }
  const hard = join(directory, 'hard.bin'); await link(destination, hard);
  await assert.rejects(releases.downloadReleaseAsset(f.client, context, asset, hard, { overwrite: true }), GitError);
  assert.deepEqual(await readFile(destination), bytes);
});
test('release overwrite failure retains original bytes', async t => {
  const { directory, cleanup } = await createScratch('release-download-failure-'); t.after(cleanup);
  const destination = join(directory, 'asset.bin'); await writeFile(destination, 'old');
  const asset = { id: 30, name: 'asset.bin', size: 3, contentType: 'application/octet-stream', state: 'uploaded' };
  const f = fixtureClient({ handler: ({ args }) => args[5].includes('/assets/30') ? result(undefined, 1, 'fixture failure') : undefined });
  const ui = new ScriptedConsole([directory, 'asset.bin', '2', 'y']);
  await assert.rejects(releases.downloadReleaseAssetGuided(ui, session(f.client), context, { id: 12, tag: 'v0.5.0', name: 'release', body: '', draft: false, prerelease: false, published: '' }, asset));
  assert.equal(await readFile(destination, 'utf8'), 'old');
  assert.deepEqual(await readdir(directory), ['asset.bin']);
});
test('release overwrite detects same-size same-mtime bytes, identity changes and new-file races', async t => {
  const { directory, cleanup } = await createScratch('release-download-race-'); t.after(cleanup);
  const asset = { id: 30, name: 'asset.bin', size: 3, contentType: 'application/octet-stream', state: 'uploaded' };
  for (const change of ['bytes', 'identity', 'appeared']) {
    const destination = join(directory, `${change}.bin`);
    if (change !== 'appeared') await writeFile(destination, 'old');
    const original = change === 'appeared' ? undefined : await lstat(destination);
    const f = fixtureClient({ handler: async ({ args }) => {
      if (!args[5].includes('/assets/30')) return;
      if (change === 'identity') { await rename(destination, `${destination}.previous`); await writeFile(destination, 'old'); }
      else await writeFile(destination, change === 'appeared' ? 'own' : 'bad');
      if (original) await utimes(destination, original.atime, original.mtime);
      return result(Buffer.from('new'));
    } });
    await assert.rejects(releases.downloadReleaseAsset(f.client, context, asset, destination, { overwrite: true }), /变化|改变|出现/u);
    assert.equal(await readFile(destination, 'utf8'), change === 'identity' ? 'old' : change === 'appeared' ? 'own' : 'bad');
  }
});
test('release download guided rename/return are local and only overwrite asks a hard confirmation', async t => {
  const { directory, cleanup } = await createScratch('release-download-guided-'); t.after(cleanup);
  const destination = join(directory, 'asset.bin'); await writeFile(destination, 'old');
  const asset = { id: 30, name: 'asset.bin', size: 3, contentType: 'application/octet-stream', state: 'uploaded' };
  const selected = { id: 12, tag: 'v0.5.0', name: 'release', body: '', draft: false, prerelease: false, published: '' };
  const f = fixtureClient({ handler: () => result(Buffer.from('new')) }); let checks = 0;
  const selectedSession = session(f.client, { checkProfile: async () => { checks++; } });
  const back = new ScriptedConsole([directory, 'asset.bin', '0']);
  await releases.downloadReleaseAssetGuided(back, selectedSession, context, selected, asset); assert.equal(f.calls.length, 0);
  const renameUi = new ScriptedConsole([directory, 'asset.bin', '1', 'renamed.bin'], { quick: true });
  await releases.downloadReleaseAssetGuided(renameUi, selectedSession, context, selected, asset);
  assert.equal(await readFile(destination, 'utf8'), 'old'); assert.equal(await readFile(join(directory, 'renamed.bin'), 'utf8'), 'new');
  assert.doesNotMatch(renameUi.transcript, /最终确认/u); assert.equal(checks, 1);
  const decline = new ScriptedConsole([directory, 'asset.bin', '2', 'n'], { quick: true });
  await releases.downloadReleaseAssetGuided(decline, selectedSession, context, selected, asset); assert.match(decline.transcript, /最终确认/u); assert.equal(checks, 1);
});
