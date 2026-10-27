import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Git, GitError } from '../dist/git.js';
import { addSubmodule, enterSubmodule, initSubmodule, removeSubmodule, submoduleContext, submoduleRecords, submodulesMenu, updateSubmodules } from '../dist/submodules.js';
import { HostStore } from '../dist/hosts.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function prepare(t) {
  const f = await fixture(t, { committed: true });
  await writeFile(join(f.home, '.gitconfig'), '[protocol "file"]\n\tallow = always\n');
  const source = join(f.base, 'source'); await mkdir(source); const git = new Git(source);
  await git.run(['init', '--initial-branch=main']); await git.run(['config', 'user.name', 'Fixture']); await git.run(['config', 'user.email', 'fixture@example.invalid']); await git.run(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(source, 'child.txt'), 'one\n'); await git.run(['add', '.']); await git.run(['commit', '-m', 'first']);
  const bare = join(f.base, 'child bare.git'); await f.git.run(['clone', '--bare', '--', source, bare]);
  async function add(relative = 'modules/中文 child') { await addSubmodule(new ScriptedConsole([bare, relative, '1'], { quick: true }), f.path); return join(f.path, relative); }
  async function advance() { await writeFile(join(source, 'child.txt'), 'two\n'); await git.run(['add', '.']); await git.run(['commit', '-m', 'second']); await git.run(['push', '--', bare, 'main']); }
  return { ...f, source, sourceGit: git, bare, add, advance };
}
test('list is empty on ordinary repo and add stages gitlink plus .gitmodules', async t => {
  const f = await prepare(t); assert.deepEqual(await submoduleRecords(f.git), []); const child = await f.add();
  const records = await submoduleRecords(f.git); assert.equal(records.length, 1); assert.equal(records[0].initialized, true); assert.equal(records[0].url, f.bare); assert.equal(records[0].path, 'modules/中文 child'); assert.ok(records[0].oid);
  assert.equal(await readFile(join(child, 'child.txt'), 'utf8'), 'one\n'); assert.equal(await f.git.branch(), 'main'); assert.equal((await f.git.run(['ls-files', '--stage', '--', 'modules/中文 child'])).stdout.toString().startsWith('160000 '), true);
});
test('list preserves unusual path characters and enter returns independent root', async t => {
  const f = await prepare(t); const relative = 'odd\n中文 child'; const child = await f.add(relative);
  assert.equal((await submoduleRecords(f.git))[0].path, relative);
  const ui = new ScriptedConsole(['1']); assert.equal(await enterSubmodule(ui, f.path), child); assert.match(ui.transcript, /不继承主仓/); assert.equal(await new Git(child).root(), child);
});
test('init does not fetch or checkout; update --init restores a deinitialized module', async t => {
  const f = await prepare(t); const child = await f.add(); await f.commit('module');
  await removeSubmodule(new ScriptedConsole(['1', '1', 'y']), f.path, true);
  assert.equal((await submoduleRecords(f.git))[0].initialized, false);
  await initSubmodule(new ScriptedConsole(['1'], { quick: true }), f.path); assert.equal(existsSync(join(child, 'child.txt')), false);
  await assert.rejects(enterSubmodule(new ScriptedConsole(['1']), f.path), /尚未下载/);
  await updateSubmodules(new ScriptedConsole(['1', '1', '1', '1'], { quick: true }), f.path);
  assert.equal((await submoduleRecords(f.git))[0].initialized, true); assert.equal(await readFile(join(child, 'child.txt'), 'utf8'), 'one\n');
});
test('update explicitly distinguishes pinned gitlink from remote tip without changing main HEAD', async t => {
  const f = await prepare(t); const child = await f.add(); await f.commit('module'); const main = await f.git.value('rev-parse', 'HEAD'); await f.advance();
  await updateSubmodules(new ScriptedConsole(['1', '1', '1', '1'], { quick: true }), f.path); assert.equal(await readFile(join(child, 'child.txt'), 'utf8'), 'one\n');
  const ui = new ScriptedConsole(['1', '1', '2', '1'], { quick: true }); await updateSubmodules(ui, f.path); assert.equal(await readFile(join(child, 'child.txt'), 'utf8'), 'two\n');
  assert.match(ui.transcript, /remote=true|remote：/); assert.equal(await f.git.value('rev-parse', 'HEAD'), main);
  await updateSubmodules(new ScriptedConsole(['1', '1', '1', '1'], { quick: true }), f.path); assert.equal(await readFile(join(child, 'child.txt'), 'utf8'), 'one\n');
});
test('normal update preserves dirty changes; explicit force works after one hard confirm', async t => {
  const f = await prepare(t); const child = await f.add(); await f.commit('module'); await f.advance(); await writeFile(join(child, 'child.txt'), 'unsaved\n');
  await assert.rejects(updateSubmodules(new ScriptedConsole(['1', '1', '2', '1'], { quick: true }), f.path), GitError);
  assert.equal(await readFile(join(child, 'child.txt'), 'utf8'), 'unsaved\n');
  const ui = new ScriptedConsole(['1', '1', '2', '2', 'y'], { quick: true }); await updateSubmodules(ui, f.path); assert.equal(await readFile(join(child, 'child.txt'), 'utf8'), 'two\n'); assert.equal(ui.messages.filter(message => message.includes('[y/N]')).length, 1);
});
test('deinit protects dirty module unless force is explicitly chosen', async t => {
  const f = await prepare(t); const child = await f.add(); await f.commit('module'); await writeFile(join(child, 'child.txt'), 'dirty');
  await assert.rejects(removeSubmodule(new ScriptedConsole(['1', '1', 'y']), f.path, true), GitError);
  assert.equal(existsSync(join(child, 'child.txt')), true);
  await removeSubmodule(new ScriptedConsole(['1', '2', 'n']), f.path, true); assert.equal(existsSync(join(child, 'child.txt')), true);
  await removeSubmodule(new ScriptedConsole(['1', '2', 'y']), f.path, true); assert.equal(existsSync(join(child, 'child.txt')), false); assert.equal((await submoduleRecords(f.git)).length, 1);
});
test('remove updates only selected gitlink/.gitmodules and preserves child object store', async t => {
  const f = await prepare(t); const child = await f.add(); await f.commit('module'); const modules = await f.git.gitPath('modules/modules/中文 child');
  const ui = new ScriptedConsole(['1', '1', 'y'], { quick: true }); await removeSubmodule(ui, f.path); assert.equal(existsSync(child), false); assert.deepEqual(await submoduleRecords(f.git), []); assert.equal(existsSync(modules), true);
  assert.equal(await f.git.value('show', 'HEAD:hello.txt'), 'first'); assert.equal(ui.messages.filter(message => message.includes('[y/N]')).length, 1);
});
test('recursive update discovers each nested URL in its own repository and never updates parent recursively', async t => {
  const f = await prepare(t);
  const nestedSource = join(f.base, 'nested source'); await mkdir(nestedSource); const nested = new Git(nestedSource);
  await nested.run(['init', '--initial-branch=main']); await nested.run(['config', 'user.name', 'Fixture']); await nested.run(['config', 'user.email', 'fixture@example.invalid']); await nested.run(['config', 'commit.gpgsign', 'false']); await writeFile(join(nestedSource, 'deep.txt'), 'deep'); await nested.run(['add', '.']); await nested.run(['commit', '-m', 'deep']);
  const nestedBare = join(f.base, 'nested.git'); await nested.run(['clone', '--bare', '--', nestedSource, nestedBare]);
  await f.sourceGit.run(['submodule', 'add', '--', nestedBare, 'nested']); await f.sourceGit.run(['commit', '-am', 'nested module']); await f.sourceGit.run(['push', '--', f.bare, 'main']);
  const child = await f.add(); await f.commit('module'); const main = await f.git.value('rev-parse', 'HEAD');
  await updateSubmodules(new ScriptedConsole(['1', '1', '1', '1'], { quick: true }), f.path); assert.equal(existsSync(join(child, 'nested', 'deep.txt')), false);
  const ui = new ScriptedConsole(['1', '2', '1', '1'], { quick: true }); await updateSubmodules(ui, f.path); assert.equal(await readFile(join(child, 'nested', 'deep.txt'), 'utf8'), 'deep'); assert.ok(ui.transcript.includes(nestedBare)); assert.equal(await f.git.value('rev-parse', 'HEAD'), main);
});
test('relative module URL is resolved against parent remote, not process cwd', async t => {
  const f = await prepare(t); await f.add('child'); await f.commit('module'); await f.git.run(['remote', 'add', 'origin', join(f.base, 'parent.git')]);
  await f.git.run(['config', '--file', '.gitmodules', 'submodule.child.url', './child bare.git']); await f.git.run(['config', '--unset', 'submodule.child.url']);
  const ui = new ScriptedConsole(['1', '1', '1', '1'], { quick: true }); await assert.rejects(updateSubmodules(ui, f.path), /本地子模块仓库不存在/);
  await f.git.run(['config', '--file', '.gitmodules', 'submodule.child.url', '../child bare.git']);
  await updateSubmodules(new ScriptedConsole(['1', '1', '1', '1'], { quick: true }), f.path);
});
test('path escape and forged .git pointing at main metadata are rejected before any recursive action', async t => {
  const f = await prepare(t); await f.git.run(['config', '--file', '.gitmodules', 'submodule.bad.path', '../escape']); await f.git.run(['config', '--file', '.gitmodules', 'submodule.bad.url', f.bare]); await assert.rejects(submoduleRecords(f.git), /路径越界/);
  await f.git.run(['config', '--file', '.gitmodules', 'submodule.bad.path', 'forged']); await mkdir(join(f.path, 'forged')); await writeFile(join(f.path, 'forged', '.git'), `gitdir: ${join(f.path, '.git')}\n`);
  await assert.rejects(submoduleRecords(f.git), /并非独立仓库/);
});
test('URL rewrite to unknown command transport is refused without contacting it', async t => {
  const f = await prepare(t); await f.add('child'); await f.commit('module');
  await f.git.run(['config', 'url.ext::never-execute.insteadOf', f.bare]);
  await assert.rejects(updateSubmodules(new ScriptedConsole(['1', '1', '1', '1'], { quick: true }), f.path), /不是支持/);
});
test('uninitialized retained module URL is independently validated before update', async t => {
  const f = await prepare(t); await f.add('child'); await f.commit('module'); await removeSubmodule(new ScriptedConsole(['1', '1', 'y']), f.path, true);
  const metadata = await f.git.gitPath('modules/child'); await new Git(metadata).run(['config', 'remote.origin.url', 'ext::never-execute']);
  await assert.rejects(updateSubmodules(new ScriptedConsole(['1', '1', '2', '1'], { quick: true }), f.path), /不是支持/);
});
test('SSH identity selection is explicit per child and never inherits parent runner', async t => {
  const f = await prepare(t); const parent = f.git.configured({ 'core.sshCommand': '/do-not-run-parent-ssh', 'user.name': 'Parent identity' });
  const item = { name: 'child', path: 'child', url: 'git@child.example.invalid:team/repo.git', configuredUrl: '', initialized: false };
  const managed = new ScriptedConsole(['1']); await assert.rejects(submoduleContext(managed, parent, item, [item.url]), /未选择子模块身份/); assert.match(managed.transcript, /不继承主仓库/);
  await f.git.run(['config', 'core.sshCommand', '/do-not-run-parent-config-ssh']);
  const result = await submoduleContext(new ScriptedConsole(['2']), parent, item, [item.url]); assert.equal(result.transport.mode, 'native-ssh'); assert.equal(result.runner.overrides['core.sshCommand'], 'ssh'); assert.equal(result.runner.overrides['user.name'], undefined);
});
test('initialized child respects its own native transport without inheriting parent identity', async t => {
  const f = await prepare(t); const child = await f.add('child'); await new HostStore().set(child, { mode: 'native-ssh', host: { provider: 'generic', host: 'child.example.invalid', apiHost: '', webBase: 'https://child.example.invalid', sshHost: 'child.example.invalid' } });
  const item = (await submoduleRecords(f.git))[0]; const parent = f.git.configured({ 'core.sshCommand': '/do-not-run-parent-ssh' });
  await f.git.run(['config', 'core.sshCommand', '/do-not-run-parent-config-ssh']); await new Git(child).run(['config', 'core.sshCommand', '/do-not-run-child-config-ssh']);
  const result = await submoduleContext(new ScriptedConsole(), parent, item, ['git@child.example.invalid:team/repo.git']); assert.equal(result.runner.directory, child); assert.equal(result.runner.overrides['core.sshCommand'], '/do-not-run-child-config-ssh');
});
test('child HTTPS mode does not silently use SSH when its actual URL differs', async t => {
  const f = await prepare(t); const child = await f.add('child'); await new HostStore().set(child, { mode: 'https', host: { provider: 'generic', host: 'child.example.invalid', apiHost: '', webBase: 'https://child.example.invalid', sshHost: 'child.example.invalid' } });
  const item = (await submoduleRecords(f.git))[0]; await assert.rejects(submoduleContext(new ScriptedConsole(), f.git, item, ['git@child.example.invalid:team/repo.git']), /HTTPS.*SSH/);
});
test('a changed child remote during confirmation stops before update contacts it', async t => {
  const f = await prepare(t); const child = await f.add('child'); await f.commit('module'); const ui = new ScriptedConsole(['1', '1', '2', '1']);
  ui.routineConfirm = async () => { await new Git(child).run(['remote', 'set-url', 'origin', 'ext::never-execute']); return true; };
  await assert.rejects(updateSubmodules(ui, f.path), /不是支持|URL.*变化/); assert.equal(await readFile(join(child, 'child.txt'), 'utf8'), 'one\n');
});
test('unsafe nested source stops recursion without altering main repository history', async t => {
  const f = await prepare(t); await f.sourceGit.run(['config', '--file', '.gitmodules', 'submodule.nested.path', 'nested']); await f.sourceGit.run(['config', '--file', '.gitmodules', 'submodule.nested.url', 'ext::never-execute']); await f.sourceGit.run(['add', '.gitmodules']); await f.sourceGit.run(['commit', '-m', 'unsafe nested config']); await f.sourceGit.run(['push', '--', f.bare, 'main']);
  await f.add('child'); await f.commit('module'); const main = await f.git.value('rev-parse', 'HEAD');
  await assert.rejects(updateSubmodules(new ScriptedConsole(['1', '2', '1', '1'], { quick: true }), f.path), /不是支持/); assert.equal(await f.git.value('rev-parse', 'HEAD'), main);
});
test('menu returns the selected child directory', async t => {
  const f = await prepare(t); const child = await f.add(); const ui = new ScriptedConsole(['5', '1']); assert.equal(await submodulesMenu(ui, f.path), child);
  for (const action of ['init', 'update', 'recursive', 'remote', 'remove', 'deinit']) assert.ok(ui.transcript.includes(action));
});
