import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Git, GitError } from '../dist/git.js';
import { addWorktree, lockWorktree, moveWorktree, parseLegacyWorktrees, parseWorktrees, pruneWorktrees, removeWorktree, switchWorktree, worktreeRecords, worktreesMenu } from '../dist/worktrees.js';
import { Profile, ProfileStore, resolveBinding } from '../dist/profiles.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function linked(f, name = 'linked 中文') { const target = join(f.base, name); await f.git.run(['worktree', 'add', '-b', name.replaceAll(' ', '-'), '--', target]); return target; }

test('legacy parser preserves raw newline/tab/quote paths without guessing C escapes', () => {
  const raw = 'worktree /tmp/raw\nline\tquote"path\nHEAD 1234567890abcdef1234567890abcdef12345678\ndetached\n\n';
  const records = parseLegacyWorktrees(Buffer.from(raw)); assert.equal(records[0].path, '/tmp/raw\nline\tquote"path'); assert.equal(records[0].detached, true);
});
test('porcelain -z parser preserves newlines, spaces, and locked/prunable reasons', () => {
  const records = parseWorktrees(Buffer.from('worktree /tmp/a\nb\0HEAD 123\0branch refs/heads/main\0\0worktree /tmp/link\0HEAD 456\0detached\0locked disk\nmissing\0prunable missing\0\0'));
  assert.equal(records[0].path, '/tmp/a\nb'); assert.equal(records[1].locked, 'disk\nmissing'); assert.equal(records[1].prunable, 'missing'); assert.equal(records[1].detached, true);
});
test('add creates a real linked .git file and does not switch the original repo', async t => {
  const f = await fixture(t, { committed: true }); const target = join(f.base, 'new 中文 tree');
  await addWorktree(new ScriptedConsole([target, '2', 'topic', 'HEAD', '1'], { quick: true }), f.path);
  assert.equal((await lstat(join(target, '.git'))).isFile(), true); assert.match(await readFile(join(target, '.git'), 'utf8'), /^gitdir: /);
  assert.equal(await new Git(target).branch(), 'topic'); assert.equal(await f.git.branch(), 'main'); assert.equal((await worktreeRecords(f.git)).length, 2);
});
test('branch occupancy is visible; explicit force permits sharing a branch', async t => {
  const f = await fixture(t, { committed: true }); const target = join(f.base, 'occupied');
  const ui = new ScriptedConsole([target, '1', '1', '2', 'y'], { quick: true });
  await addWorktree(ui, f.path); assert.match(ui.transcript, /已占用/); assert.equal(await new Git(target).branch(), 'main');
});
test('ordinary add keeps Git branch occupancy protection', async t => {
  const f = await fixture(t, { committed: true }); const target = join(f.base, 'occupied');
  await assert.rejects(addWorktree(new ScriptedConsole([target, '1', '1', '1'], { quick: true }), f.path), GitError);
  assert.equal(existsSync(target), false);
});
test('detached worktree supports an option-like destination safely as a path', async t => {
  const f = await fixture(t, { committed: true }); const target = join(f.base, '-detached');
  await addWorktree(new ScriptedConsole([target, '3', 'HEAD', '1'], { quick: true }), f.path);
  assert.equal((await new Git(target).run(['symbolic-ref', '--quiet', 'HEAD'], { check: false })).status, 1);
});
test('switch returns a new project root without checkout and explains independent bindings', async t => {
  const f = await fixture(t, { committed: true }); const target = await linked(f);
  const ui = new ScriptedConsole(['2'], { quick: true }); assert.equal(await switchWorktree(ui, f.path), target); assert.match(ui.transcript, /不从主工作区 \/ common-dir/);
  assert.equal(await f.git.branch(), 'main'); assert.equal(await switchWorktree(new ScriptedConsole(['1']), f.path), undefined);
});
test('move from a linked root returns the replacement project directory', async t => {
  const f = await fixture(t, { committed: true }); const original = await linked(f); const target = join(f.base, 'moved tree');
  assert.equal(await moveWorktree(new ScriptedConsole(['2', target, '1', 'y']), original), target);
  assert.equal(existsSync(original), false); assert.equal((await lstat(join(target, '.git'))).isFile(), true); assert.equal(await new Git(target).value('show', 'HEAD:hello.txt'), 'first');
});
test('move decline does not move files and main worktree cannot move', async t => {
  const f = await fixture(t, { committed: true }); const original = await linked(f); const target = join(f.base, 'not moved');
  await moveWorktree(new ScriptedConsole(['2', target, '1', 'n']), f.path); assert.equal(existsSync(original), true); assert.equal(existsSync(target), false);
  await assert.rejects(moveWorktree(new ScriptedConsole(['1']), f.path), /主工作区不能/);
});
test('lock / unlock use real metadata and ordinary removal respects lock', async t => {
  const f = await fixture(t, { committed: true }); const target = await linked(f);
  await lockWorktree(new ScriptedConsole(['2', 'external disk'], { quick: true }), f.path);
  assert.equal((await worktreeRecords(f.git))[1].locked, 'external disk');
  await assert.rejects(removeWorktree(new ScriptedConsole(['2', '1', 'y']), f.path), GitError); assert.equal(existsSync(target), true);
  await lockWorktree(new ScriptedConsole(['2'], { quick: true }), f.path, true); assert.equal((await worktreeRecords(f.git))[1].locked, undefined);
});
test('dirty deletion offers force and requires one confirmation even in quick mode', async t => {
  const f = await fixture(t, { committed: true }); const target = await linked(f);
  await import('node:fs/promises').then(fs => fs.writeFile(join(target, 'unsaved.txt'), 'unsaved'));
  await assert.rejects(removeWorktree(new ScriptedConsole(['2', '1', 'y'], { quick: true }), f.path), GitError);
  await removeWorktree(new ScriptedConsole(['2', '2', 'n'], { quick: true }), f.path); assert.equal(existsSync(target), true);
  const ui = new ScriptedConsole(['2', '2', 'y'], { quick: true }); await removeWorktree(ui, f.path); assert.equal(existsSync(target), false);
  assert.equal(ui.messages.filter(message => message.includes('[y/N]')).length, 1);
  assert.equal(await f.git.value('show-ref', '--verify', 'refs/heads/linked-中文').then(() => true), true);
});
test('double-force deletion supports explicitly locked targets and returns main root', async t => {
  const f = await fixture(t, { committed: true }); const target = await linked(f);
  await f.git.run(['worktree', 'lock', target]);
  assert.equal(await removeWorktree(new ScriptedConsole(['2', '3', 'y']), target), f.path); assert.equal(existsSync(target), false);
});
test('prune previews stale records and preserves locked missing worktrees', async t => {
  const f = await fixture(t, { committed: true }); const target = await linked(f, 'stale'); const locked = await linked(f, 'locked');
  await f.git.run(['worktree', 'lock', locked]); await rm(target, { recursive: true }); await rm(locked, { recursive: true });
  await pruneWorktrees(new ScriptedConsole(['n']), f.path); assert.equal((await worktreeRecords(f.git)).length, 3);
  await pruneWorktrees(new ScriptedConsole(['y']), f.path); const records = await worktreeRecords(f.git); assert.equal(records.length, 2); assert.equal(records[1].path, locked);
});
test('list/operation confirmation race stops deletion', async t => {
  const f = await fixture(t, { committed: true }); const target = await linked(f);
  const ui = new ScriptedConsole(['2', '2']); ui.confirm = async () => { await f.git.run(['worktree', 'lock', target]); return true; };
  await assert.rejects(removeWorktree(ui, f.path), /列表.*变化/); assert.equal(existsSync(target), true);
});
test('a main-root profile never binds linked worktrees by shared common-dir', async t => {
  const f = await fixture(t, { committed: true }); const target = await linked(f); const store = new ProfileStore(); const id = 'a'.repeat(32); const folder = join(store.profiles_dir, id); await mkdir(folder, { recursive: true });
  const profile = new Profile({ profile_id: id, label: 'main only', name: 'Fixture', email: 'fixture@example.invalid', github_login: 'fixture', private_key: join(folder, 'id_fixture'), public_key: join(folder, 'id_fixture.pub') });
  await writeFile(profile.private_key, 'fixture only, not a real private key'); await writeFile(profile.public_key, 'ssh-ed25519 AAAAFIXTURE'); await writeFile(join(folder, 'profile.json'), JSON.stringify(store.encodeProfile(profile)));
  const root = process.platform === 'win32' ? f.path.toLowerCase() : f.path;
  await writeFile(store.bindings_file, JSON.stringify({ schema_version: 2, bindings: { [root]: { profile_id: id, snapshot: store.snapshot(profile) } } }));
  assert.equal((await resolveBinding(f.path)).profile_id, id); assert.equal(await resolveBinding(target), undefined);
  const ui = new ScriptedConsole(['2']); assert.equal(await switchWorktree(ui, f.git), target); assert.match(ui.transcript, /没有 AutoGit 账号绑定/);
});
test('real legacy worktree list supports unusual registered paths', async t => {
  const f = await fixture(t, { committed: true }); const target = join(f.base, 'raw\n中文\tquote"'); await f.git.run(['worktree', 'add', '--detach', '--', target]);
  assert.equal((await worktreeRecords(f.git))[1].path, target); assert.equal(await switchWorktree(new ScriptedConsole(['2']), f.path), target);
});
test('worktree management also works from a local bare repository', async t => {
  const f = await fixture(t, { committed: true }); const bare = join(f.base, 'bare.git'); await f.git.run(['clone', '--bare', '--', f.path, bare]); const target = join(f.base, 'bare-linked');
  await addWorktree(new ScriptedConsole([target, '2', 'from-bare', 'HEAD', '1'], { quick: true }), bare); const records = await worktreeRecords(new Git(bare)); assert.equal(records[0].bare, true); assert.equal(records[1].path, target);
  assert.equal(await removeWorktree(new ScriptedConsole(['2', '1', 'y']), target), bare);
});
test('menu exposes all requested worktree actions and propagates directory switch', async t => {
  const f = await fixture(t, { committed: true }); const target = await linked(f);
  const ui = new ScriptedConsole(['3', '2']); assert.equal(await worktreesMenu(ui, f.path), target);
  for (const action of ['列出', '创建', '进入', '移动', '删除', '锁定', '解锁', '清理']) assert.ok(ui.transcript.includes(action));
});
