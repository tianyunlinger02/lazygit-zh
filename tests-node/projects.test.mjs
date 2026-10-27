import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectStore, projectsMenu } from '../dist/projects.js';
import { Profile, ProfileStore } from '../dist/profiles.js';
import { Git, GitError } from '../dist/git.js';
import { savePreferences, loadPreferences } from '../dist/preferences.js';
import { HostStore, DEFAULT_TRANSPORT } from '../dist/hosts.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function secondRepo(f, name = 'same name') { const directory = join(f.base, name); await fs.mkdir(directory); await new Git(directory).run(['init', '--initial-branch=main']); return directory; }
async function fakeProfile(store) {
  const id = 'a'.repeat(32), folder = join(store.directory, 'profiles', id); await fs.mkdir(folder, { recursive: true });
  const profile = new Profile({ profile_id: id, label: 'fake', name: 'Fake', email: 'fake@example.invalid', github_login: 'fake', private_key: join(folder, 'key'), public_key: join(folder, 'key.pub') });
  await fs.writeFile(profile.private_key, 'FAKE KEY ONLY'); await fs.writeFile(profile.public_key, 'ssh-ed25519 AAAAfixture'); await fs.writeFile(join(folder, 'profile.json'), JSON.stringify(store.encodeProfile(profile))); return profile;
}

test('project registry keeps stable ids, favorites, recency and independent schema1', async t => {
  const f = await fixture(t); const store = new ProjectStore(); assert.deepEqual(await store.list(), []);
  const one = await store.add(f.path, 'one'), next = await secondRepo(f), two = await store.add(next, 'two');
  await store.setFavorite(one.project_id, true); assert.equal((await store.list())[0].project_id, one.project_id);
  assert.equal((await store.touch(f.path)).project_id, one.project_id); assert.equal((await store.list()).length, 2);
  assert.equal(await store.remove(two.project_id), true); assert.equal((await fs.stat(next)).isDirectory(), true);
  const data = JSON.parse(await fs.readFile(store.file)); assert.equal(data.schema_version, 1); assert.equal(data.projects[0].favorite, true);
});

test('project search opens a registered match and does not require extra confirmation', async t => {
  const f = await fixture(t); const store = new ProjectStore(); const next = await secondRepo(f, 'target project'); await store.add(next, 'needle');
  const ui = new ScriptedConsole(['2', 'needle', '1'], { quick: true }); assert.equal(await projectsMenu(ui, f.path), next); assert.doesNotMatch(ui.transcript, /确认/u);
});

test('exact path remap carries bindings, host settings and remembered project, never basename guesses', async t => {
  const f = await fixture(t); const store = new ProjectStore(); const entry = await store.add(f.path, 'same name'); const next = await secondRepo(f);
  const profiles = new ProfileStore(); const profile = await fakeProfile(profiles);
  await fs.writeFile(profiles.bindingsFile, JSON.stringify({ schema_version: 2, bindings: { [f.path]: { profile_id: profile.profile_id, snapshot: profiles.snapshot(profile) } } }));
  await new HostStore().set(f.path, DEFAULT_TRANSPORT); await savePreferences({ last_project: f.path });
  await store.remap(f.path, next); const moved = (await store.list())[0]; assert.equal(moved.path, next); assert.equal(moved.project_id, entry.project_id);
  assert.equal((await profiles.resolveBinding(next)).profile_id, profile.profile_id); assert.equal(await profiles.resolveBinding(f.path), undefined); assert.equal((await loadPreferences()).last_project, next);
  assert.deepEqual(await new HostStore().get(next), DEFAULT_TRANSPORT); assert.equal(await new HostStore().get(f.path), undefined);
  await assert.rejects(store.remap(join(f.base, 'other', 'same name'), f.path), /不会按同名/u);
});

test('project remap collision and malformed registry preserve original files', async t => {
  const f = await fixture(t); const store = new ProjectStore(); const one = await store.add(f.path), next = await secondRepo(f); await store.add(next); const original = await fs.readFile(store.file);
  await assert.rejects(store.remap(f.path, next), /已登记/u); assert.deepEqual(await fs.readFile(store.file), original);
  for (const raw of ['bad', '{"schema_version":1,"schema_version":1,"projects":[]}', JSON.stringify({ schema_version: 1, projects: [one, one] }), JSON.stringify({ schema_version: 1, projects: [{ ...one, last_used: false }] })]) { await fs.writeFile(store.file, raw); await assert.rejects(store.list(), GitError); assert.equal(await fs.readFile(store.file, 'utf8'), raw); }
});

test('normal quoted and percent project paths are stored without shell interpretation', async t => {
  if (process.platform === 'win32') return t.skip('quote is not a valid Windows filename');
  const f = await fixture(t); const next = await secondRepo(f, 'project "quote" %h'); const item = await new ProjectStore().add(next); assert.equal(item.path, next);
});
