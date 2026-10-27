import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Git, decodePath, encodePath } from '../dist/git.js';
import { configureApp, resetAppContextForTests } from '../dist/app-context.js';
import { cleanFiles, previewClean, resetTo, restoreFiles, stageFiles, unstageFiles } from '../dist/destructive.js';
import { fixture, ScriptedConsole } from './support.mjs';

function changing(change) { const ui = new ScriptedConsole(['y']); const confirm = ui.confirm.bind(ui); ui.confirm = async (...args) => { const answer = await confirm(...args); if (answer) await change(); return answer; }; return ui; }

test('file stage/unstage preserves unrelated index, supports unborn HEAD and explicit quick confirmation', async t => {
  const f = await fixture(t);
  await f.write('one.txt', 'one'); await f.write('two.txt', 'two');
  await stageFiles(new ScriptedConsole(['y'], { quick: true }), f.git, { paths: ['one.txt'] });
  assert.deepEqual((await f.git.changes()).filter(c => c.staged).map(c => c.path), ['one.txt']);
  await unstageFiles(new ScriptedConsole(['y']), f.git, { paths: ['one.txt'] });
  assert.equal(await readFile(join(f.path, 'one.txt'), 'utf8'), 'one');
  assert.equal((await f.git.changes()).filter(c => c.staged).length, 0);
  await stageFiles(new ScriptedConsole(['n'], { quick: true }), f.git, { paths: ['one.txt'] });
  assert.equal((await f.git.changes()).filter(c => c.staged).length, 0);
});

test('unstage a rename handles both ends without touching working bytes', async t => {
  const f = await fixture(t, { committed: true });
  await rename(join(f.path, 'hello.txt'), join(f.path, '-new [x]\n.txt'));
  await f.git.stagePaths(['hello.txt', '-new [x]\n.txt']);
  await unstageFiles(new ScriptedConsole(['y']), f.git, { paths: ['-new [x]\n.txt'] });
  assert.equal((await f.git.changes()).filter(c => c.staged).length, 0);
  assert.equal(await readFile(join(f.path, '-new [x]\n.txt'), 'utf8'), 'first\n');
  assert.equal(existsSync(join(f.path, 'hello.txt')), false);
});

test('byte-safe filenames round-trip stage, unstage and restore without replacement aliases', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const name = decodePath(Buffer.from([0x2d, 0x66, 0xff, 0x0a]));
  const absolute = Buffer.concat([Buffer.from(`${f.path}/`), encodePath(name)]);
  await writeFile(absolute, Buffer.from([0, 255, 17]));
  await stageFiles(new ScriptedConsole(['y']), f.git, { paths: [name] });
  await unstageFiles(new ScriptedConsole(['y']), f.git, { paths: [name] });
  await stageFiles(new ScriptedConsole(['y']), f.git, { paths: [name] });
  await f.git.run(['commit', '-m', 'raw']);
  await writeFile(absolute, 'dirty');
  await restoreFiles(new ScriptedConsole(['y']), f.git, { paths: [name], source: 'HEAD', target: 'both' });
  assert.deepEqual(await readFile(absolute), Buffer.from([0, 255, 17]));
});

test('restore supports HEAD/index/commit to worktree/index/both and partial staging', async t => {
  const f = await fixture(t, { committed: true }); const initial = await f.git.value('rev-parse', 'HEAD');
  await f.write('hello.txt', 'index\n'); await f.git.stagePaths(['hello.txt']); await f.write('hello.txt', 'worktree\n');
  await restoreFiles(new ScriptedConsole(['y']), f.git, { source: 'index', target: 'worktree', paths: ['hello.txt'] });
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'index\n');
  await restoreFiles(new ScriptedConsole(['y']), f.git, { source: initial, target: 'index', paths: ['hello.txt'] });
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'index\n');
  assert.equal((await f.git.changes())[0].index, ' ');
  await restoreFiles(new ScriptedConsole(['y']), f.git, { source: 'HEAD', target: 'both', paths: ['hello.txt'] });
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'first\n');
  assert.deepEqual(await f.git.changes(), []);
});

test('restore selected rename pair from earlier commit removes new tracked name', async t => {
  const f = await fixture(t, { committed: true });
  await rename(join(f.path, 'hello.txt'), join(f.path, 'renamed.txt')); await f.git.stagePaths(['hello.txt', 'renamed.txt']);
  await restoreFiles(new ScriptedConsole(['y']), f.git, { source: 'HEAD', target: 'both', paths: ['renamed.txt'] });
  assert.equal(existsSync(join(f.path, 'renamed.txt')), false); assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'first\n');
});

test('index to worktree restores the new name of a staged rename without undoing the rename', async t => {
  const f = await fixture(t, { committed: true });
  await rename(join(f.path, 'hello.txt'), join(f.path, 'new-name')); await f.git.stagePaths(['hello.txt', 'new-name']); await f.write('new-name', 'dirty');
  await restoreFiles(new ScriptedConsole(['y']), f.git, { source: 'index', target: 'worktree', paths: ['new-name'] });
  assert.equal(await readFile(join(f.path, 'new-name'), 'utf8'), 'first\n'); assert.equal(existsSync(join(f.path, 'hello.txt')), false);
  assert.equal((await f.git.changes())[0].index, 'R'); assert.equal((await f.git.changes())[0].worktree, ' ');
});

test('hard reset protects data removed from current HEAD or index, not only surviving target paths', async t => {
  const f = await fixture(t, { committed: true }); const before = await f.git.value('rev-parse', 'HEAD');
  const data = join(f.path, 'data'); await f.write('data/profile/key', 'fixture-not-real-key'); await f.commit('fixture data'); const withData = await f.git.value('rev-parse', 'HEAD');
  await configureApp(new ScriptedConsole(), { dataDir: data });
  await assert.rejects(resetTo(new ScriptedConsole(), f.git, { mode: 'hard', commit: before }), /AutoGit data|账号数据/);
  assert.equal(await readFile(join(data, 'profile/key'), 'utf8'), 'fixture-not-real-key'); assert.equal(await f.git.value('rev-parse', 'HEAD'), withData);
  await f.git.run(['reset', '--soft', before]);
  await assert.rejects(resetTo(new ScriptedConsole(), f.git, { mode: 'hard', commit: before }), /AutoGit data|账号数据/);
  assert.equal(await readFile(join(data, 'profile/key'), 'utf8'), 'fixture-not-real-key');
});

test('reset soft/mixed/hard uses one explicit confirmation and no forced backup', async t => {
  const f = await fixture(t, { committed: true }); const first = await f.git.value('rev-parse', 'HEAD');
  await f.write('hello.txt', 'second'); await f.commit('second'); const second = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['switch', '--detach']);
  await resetTo(new ScriptedConsole(['y']), f.git, { mode: 'soft', commit: first });
  assert.equal((await f.git.changes())[0].staged, true);
  await resetTo(new ScriptedConsole(['y']), f.git, { mode: 'mixed', commit: first });
  assert.equal((await f.git.changes())[0].staged, false);
  const ui = new ScriptedConsole(['y'], { quick: true }); await resetTo(ui, f.git, { mode: 'hard', commit: first });
  assert.match(ui.transcript, /未跟踪文件\/目录也可能被删除/);
  assert.deepEqual(await f.git.changes(), []); assert.equal(await f.git.value('rev-parse', 'refs/heads/main'), second);
  assert.equal(await f.git.value('for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/main');
});

test('reset hard warns and can remove an untracked blocker, including ignored content', async t => {
  const f = await fixture(t, { committed: true }); const first = await f.git.value('rev-parse', 'HEAD');
  await f.write('block', 'tracked target'); await f.commit('block'); const target = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['reset', '--hard', first]); await mkdir(join(f.path, 'block')); await f.write('block/private.tmp', 'discard');
  await resetTo(new ScriptedConsole(['y']), f.git, { mode: 'hard', commit: target }); assert.equal(await readFile(join(f.path, 'block'), 'utf8'), 'tracked target');
});

test('restore excludes pure untracked paths while allowing tracked paths absent from source as deletion', async t => {
  const f = await fixture(t, { committed: true }); const base = await f.git.value('rev-parse', 'HEAD');
  await f.write('foo', 'untracked');
  await assert.rejects(restoreFiles(new ScriptedConsole(), f.git, { source: base, target: 'index', paths: ['foo'] }), /所选路径不存在/);
  assert.equal(await readFile(join(f.path, 'foo'), 'utf8'), 'untracked');
  await f.write('added.txt', 'indexed'); await f.git.stagePaths(['added.txt']);
  await restoreFiles(new ScriptedConsole(['y']), f.git, { source: base, target: 'both', paths: ['added.txt'] });
  assert.equal(existsSync(join(f.path, 'added.txt')), false); assert.equal(await readFile(join(f.path, 'foo'), 'utf8'), 'untracked');
});

test('staging additional edits after a staged rename does not pass a vanished original name', async t => {
  const f = await fixture(t, { committed: true }); await rename(join(f.path, 'hello.txt'), join(f.path, 'renamed')); await f.git.stagePaths(['hello.txt', 'renamed']); await f.write('renamed', 'more changes');
  await stageFiles(new ScriptedConsole(['y']), f.git, { paths: ['renamed'] }); assert.equal(await f.git.value('show', ':renamed'), 'more changes');
});

test('same porcelain M but changed worktree bytes during confirmation rejects destructive edit', async t => {
  const f = await fixture(t, { committed: true }); await f.write('hello.txt', 'dirty one');
  await assert.rejects(restoreFiles(changing(() => f.write('hello.txt', 'dirty two')), f.git, { source: 'HEAD', target: 'both', paths: ['hello.txt'] }), /实际内容/);
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'dirty two');
});

test('ordinary files work in detached HEAD and a repository with gitlinks', async t => {
  const f = await fixture(t, { committed: true }); const oid = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['update-index', '--add', '--cacheinfo', `160000,${oid},module`]); await f.git.run(['commit', '-m', 'gitlink']);
  await f.git.run(['switch', '--detach']); await f.write('hello.txt', 'dirty');
  await restoreFiles(new ScriptedConsole(['y']), f.git, { source: 'HEAD', target: 'worktree', paths: ['hello.txt'] });
  await assert.rejects(restoreFiles(new ScriptedConsole(), f.git, { source: 'HEAD', target: 'both', paths: ['module'] }), /所选路径涉及子模块/);
});

test('raw-byte rename stage/unstage and restore preserve both path identities', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const first = decodePath(Buffer.from([97, 255])), second = decodePath(Buffer.from([98, 254]));
  const absolute = name => Buffer.concat([Buffer.from(`${f.path}/`), encodePath(name)]);
  await writeFile(absolute(first), 'raw-original'); await f.git.stagePaths([first]); await f.git.run(['commit', '-m', 'raw base']);
  await rename(absolute(first), absolute(second)); await f.git.stagePaths([first, second]);
  await unstageFiles(new ScriptedConsole(['y']), f.git, { paths: [second] }); assert.equal((await f.git.changes()).filter(c => c.staged).length, 0);
  await stageFiles(new ScriptedConsole(['y']), f.git, { paths: [first, second] });
  await restoreFiles(new ScriptedConsole(['y']), f.git, { paths: [second], source: 'HEAD', target: 'both' });
  assert.equal(existsSync(absolute(second)), false); assert.equal(await readFile(absolute(first), 'utf8'), 'raw-original');
});

test('hard reset and clean detect ignored blocker/content changes during final confirmation', async t => {
  const f = await fixture(t, { committed: true }); const base = await f.git.value('rev-parse', 'HEAD');
  await f.write('blocked', 'target'); await f.commit('target'); const target = await f.git.value('rev-parse', 'HEAD'); await f.git.run(['reset', '--hard', base]);
  await writeFile(await f.git.gitPath('info/exclude'), 'blocked/\n'); await f.write('blocked/cache', 'first');
  await assert.rejects(resetTo(changing(() => f.write('blocked/cache', 'second')), f.git, { mode: 'hard', commit: target }), /实际内容/);
  await assert.rejects(cleanFiles(changing(() => f.write('blocked/cache', 'third')), f.git, { scope: 'ignored', nested: false }), /实际内容/);
  assert.equal(await readFile(join(f.path, 'blocked/cache'), 'utf8'), 'third');
});

test('clean preview retains ignored children/nested repositories and covers nested empty directories', async t => {
  const f = await fixture(t, { committed: true }); await f.write('.gitignore', '*.keep\nignored/\n'); await f.commit('ignore');
  await f.write('folder/regular', 'remove'); await f.write('folder/private.keep', 'keep'); await mkdir(join(f.path, 'folder/empty'), { recursive: true });
  const nested = join(f.path, 'folder/nested'); await mkdir(nested); await new Git(nested).run(['init']);
  const preview = await previewClean(f.git, 'untracked', false); assert.deepEqual(preview.paths, ['folder/empty/', 'folder/regular']);
  await cleanFiles(new ScriptedConsole(['y']), f.git, { scope: 'untracked', nested: false });
  assert.equal(existsSync(join(f.path, 'folder/private.keep')), true); assert.equal(existsSync(nested), true); assert.equal(existsSync(join(f.path, 'folder/empty')), false);
  const ignoredNested = join(f.path, 'ignored/nested'); await mkdir(ignoredNested, { recursive: true }); await new Git(ignoredNested).run(['init']);
  assert.deepEqual((await previewClean(f.git, 'ignored', false)).paths, ['folder/private.keep']);
});

test('clean scope cancellation and declining hard reset do not mutate anything', async t => {
  const f = await fixture(t, { committed: true }); await f.write('untracked', 'keep'); await f.write('hello.txt', 'dirty');
  await cleanFiles(new ScriptedConsole(['0']), f.git, { scope: 'all' });
  await resetTo(new ScriptedConsole(['n'], { quick: true }), f.git, { commit: 'HEAD', mode: 'hard' });
  assert.equal(await readFile(join(f.path, 'untracked'), 'utf8'), 'keep'); assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'dirty');
});

test('clean scopes use NUL previews and preserve ignored/untracked as requested', async t => {
  const f = await fixture(t, { committed: true }); await f.write('.gitignore', '*.ignored\n'); await f.commit('ignore');
  await f.write('normal.txt', 'normal'); await f.write('cache.ignored', 'cache'); await mkdir(join(f.path, 'empty'));
  assert.deepEqual((await previewClean(f.git, 'untracked')).paths, ['empty/', 'normal.txt']);
  await cleanFiles(new ScriptedConsole(['y']), f.git, { scope: 'untracked', nested: false });
  assert.equal(existsSync(join(f.path, 'cache.ignored')), true); assert.equal(existsSync(join(f.path, 'normal.txt')), false);
  await f.write('normal.txt', 'normal'); await cleanFiles(new ScriptedConsole(['y']), f.git, { scope: 'ignored', nested: false });
  assert.equal(existsSync(join(f.path, 'normal.txt')), true); assert.equal(existsSync(join(f.path, 'cache.ignored')), false);
  await f.write('cache.ignored', 'cache'); await cleanFiles(new ScriptedConsole(['y']), f.git, { scope: 'all', nested: false }); assert.deepEqual(await f.git.changes(), []);
});

test('clean protects current AutoGit data for every scope including under an ignored ancestor', async t => {
  const f = await fixture(t, { committed: true });
  const data = join(f.path, 'ignored', 'data'); await mkdir(data, { recursive: true }); await writeFile(join(data, 'fixture-key'), 'not-a-real-key');
  await f.write('.gitignore', 'ignored/\n'); await f.commit('ignore'); // fixture only, remove accidental staging below
  await f.write('ignored/trash', 'discard');
  await configureApp(new ScriptedConsole(), { dataDir: data });
  for (const scope of ['untracked', 'ignored', 'all']) {
    const ui = new ScriptedConsole(['y']); await cleanFiles(ui, f.git, { scope, nested: false });
    assert.equal(await readFile(join(data, 'fixture-key'), 'utf8'), 'not-a-real-key'); assert.match(ui.transcript, /AutoGit data/);
  }
  resetAppContextForTests();
});

test('clean raw bytes and nested repositories require independent second force', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { committed: true }); const nested = join(f.path, 'nested'); await mkdir(nested); await new Git(nested).run(['init']);
  const raw = Buffer.concat([Buffer.from(`${f.path}/`), Buffer.from([255, 10])]); await writeFile(raw, 'raw');
  assert.deepEqual((await previewClean(f.git, 'all', false)).paths, [decodePath(Buffer.from([255, 10]))]);
  await cleanFiles(new ScriptedConsole(['y']), f.git, { scope: 'all', nested: false }); assert.equal(existsSync(nested), true); assert.equal(existsSync(raw), false);
  await cleanFiles(new ScriptedConsole(['y']), f.git, { scope: 'all', nested: true }); assert.equal(existsSync(nested), false);
});
