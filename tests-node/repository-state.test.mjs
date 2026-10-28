import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Git, decodePath, encodePath } from '../dist/git.js';
import { configureApp } from '../dist/app-context.js';
import { repositoryStamp, verifyRepositoryStamp } from '../dist/repository-state.js';
import { stopTrackingIgnored } from '../dist/templates.js';
import { pull } from '../dist/workflows.js';
import { fixture, ScriptedConsole } from './support.mjs';

const changed = /确认期间.*HEAD.*暂存区.*实际内容.*进行中的操作/u;
function changing(change) {
  const ui = new ScriptedConsole(['y'], { quick: true });
  const confirm = ui.confirm.bind(ui);
  ui.confirm = async (...args) => { const answer = await confirm(...args); if (answer) await change(); return answer; };
  return ui;
}

test('repository stamps are stable and read-only for unborn HEAD and staged files', async t => {
  const f = await fixture(t);
  await f.write('staged.txt', 'indexed'); await f.git.stagePaths(['staged.txt']); await f.write('untracked.txt', 'untracked');
  const headFile = await f.git.gitPath('HEAD');
  const head = await readFile(headFile), index = (await f.git.run(['ls-files', '--stage', '-z'])).stdout;
  const commands = [], run = f.git.run.bind(f.git);
  t.mock.method(f.git, 'run', async (args, options) => {
    commands.push([...args]);
    assert.ok(['symbolic-ref', 'rev-parse', 'ls-files', 'status'].includes(args[0]), `unexpected fingerprint command: ${args[0]}`);
    assert.ok(!options?.interactive);
    return run(args, options);
  });
  const stamp = await repositoryStamp(f.git);
  assert.match(stamp.digest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await repositoryStamp(f.git), stamp);
  await verifyRepositoryStamp(f.git, stamp);
  assert.ok(commands.length > 0);
  assert.deepEqual(await readFile(headFile), head); assert.deepEqual((await f.git.run(['ls-files', '--stage', '-z'])).stdout, index);
  assert.equal(await readFile(join(f.path, 'staged.txt'), 'utf8'), 'indexed');
});

test('repository stamps reject changed HEAD OIDs and symbolic targets with identical trees', async t => {
  const f = await fixture(t, { committed: true });
  const tree = await f.git.value('rev-parse', 'HEAD^{tree}'), stamp = await repositoryStamp(f.git);
  await f.git.run(['commit', '--allow-empty', '-m', 'same tree, new HEAD']);
  assert.equal(await f.git.value('rev-parse', 'HEAD^{tree}'), tree);
  await assert.rejects(verifyRepositoryStamp(f.git, stamp), changed);
  const next = await repositoryStamp(f.git), oid = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['branch', 'same-commit', oid]); await f.git.run(['symbolic-ref', 'HEAD', 'refs/heads/same-commit']);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), oid);
  await assert.rejects(verifyRepositoryStamp(f.git, next), changed);
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'first\n');
});

test('repository stamps detect index-only changes with identical porcelain and working bytes', async t => {
  const f = await fixture(t, { committed: true });
  await f.write('hello.txt', 'index-one\n'); await f.git.stagePaths(['hello.txt']); await f.write('hello.txt', 'worktree\n');
  const status = (await f.git.run(['status', '--porcelain=v1', '-z'])).stdout, stamp = await repositoryStamp(f.git);
  const blob = (await f.git.run(['hash-object', '-w', '--stdin'], { inputData: Buffer.from('index-two\n') })).stdout.toString('ascii').trim();
  await f.git.run(['update-index', '--cacheinfo', `100644,${blob},hello.txt`]);
  assert.deepEqual((await f.git.run(['status', '--porcelain=v1', '-z'])).stdout, status);
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'worktree\n');
  await assert.rejects(verifyRepositoryStamp(f.git, stamp), changed);
});

test('repository stamps reject same porcelain M with same-size changed worktree bytes', async t => {
  const f = await fixture(t, { committed: true }); await f.write('hello.txt', 'dirty one');
  const status = (await f.git.run(['status', '--porcelain=v1', '-z'])).stdout, stamp = await repositoryStamp(f.git);
  await f.write('hello.txt', 'dirty two');
  assert.deepEqual((await f.git.run(['status', '--porcelain=v1', '-z'])).stdout, status);
  await assert.rejects(verifyRepositoryStamp(f.git, stamp), changed);
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'dirty two');
});

test('repository stamps distinguish byte-safe filenames from replacement-character aliases', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), raw = Buffer.from([0x2d, 0x66, 0xff, 0x0a]);
  const name = decodePath(raw), absolute = Buffer.concat([Buffer.from(`${f.path}/`), encodePath(name)]), alias = raw.toString('utf8');
  await writeFile(absolute, Buffer.from([0, 255, 17])); await f.write(alias, Buffer.from([0, 255, 17]));
  const stamp = await repositoryStamp(f.git);
  await writeFile(absolute, Buffer.from([0, 255, 18]));
  await assert.rejects(verifyRepositoryStamp(f.git, stamp), changed);
  assert.deepEqual(await readFile(join(f.path, alias)), Buffer.from([0, 255, 17]));
  const next = await repositoryStamp(f.git);
  await f.write(alias, Buffer.from([0, 255, 19]));
  await assert.rejects(verifyRepositoryStamp(f.git, next), changed);
  assert.deepEqual(await readFile(absolute), Buffer.from([0, 255, 18]));
});

test('repository stamps fingerprint every operation marker including recursive sequencer state', async t => {
  const f = await fixture(t, { committed: true }), oid = await f.git.value('rev-parse', 'HEAD');
  for (const marker of ['MERGE_HEAD', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'BISECT_START', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const location = await f.git.gitPath(marker), stamp = await repositoryStamp(f.git);
    const directory = ['rebase-merge', 'rebase-apply', 'sequencer'].includes(marker);
    if (directory) { await mkdir(join(location, 'nested'), { recursive: true }); await writeFile(join(location, 'nested', 'todo'), 'step one'); }
    else await writeFile(location, `${oid}\n`);
    await assert.rejects(verifyRepositoryStamp(f.git, stamp), changed, marker);
    const present = await repositoryStamp(f.git);
    await writeFile(directory ? join(location, 'nested', 'todo') : location, directory ? 'step two' : `${'0'.repeat(oid.length)}\n`);
    await assert.rejects(verifyRepositoryStamp(f.git, present), changed, `${marker} bytes`);
    const edited = await repositoryStamp(f.git);
    await rm(location, { recursive: true });
    await assert.rejects(verifyRepositoryStamp(f.git, edited), changed, `${marker} removal`);
    await verifyRepositoryStamp(f.git, stamp);
  }
});

test('repository stamps include ignored blocker bytes only when explicitly requested as extra paths', async t => {
  const f = await fixture(t, { committed: true }); await f.write('.gitignore', 'blocked/\n'); await f.commit('ignore blockers');
  await f.write('blocked/cache', 'first');
  const ordinary = await repositoryStamp(f.git), explicit = await repositoryStamp(f.git, ['blocked']);
  await f.write('blocked/cache', 'other');
  assert.deepEqual(await f.git.changes(), []);
  await verifyRepositoryStamp(f.git, ordinary);
  await assert.rejects(verifyRepositoryStamp(f.git, explicit, ['blocked']), changed);
  const next = await repositoryStamp(f.git, ['blocked']);
  const child = process.platform === 'win32' ? Buffer.from('raw-child') : Buffer.from([0xff, 0x0a]);
  await writeFile(Buffer.concat([Buffer.from(`${f.path}/blocked/`), child]), 'raw-one');
  await assert.rejects(verifyRepositoryStamp(f.git, next, ['blocked']), changed);
  const rawStamp = await repositoryStamp(f.git, ['blocked']);
  await writeFile(Buffer.concat([Buffer.from(`${f.path}/blocked/`), child]), 'raw-two');
  await assert.rejects(verifyRepositoryStamp(f.git, rawStamp, ['blocked']), changed);
});

test('repository stamps hash symlink targets without following outside file contents', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), first = join(f.base, 'outside-a'), second = join(f.base, 'outside-b'), link = join(f.path, 'link');
  await writeFile(first, 'first'); await writeFile(second, 'other'); await symlink(first, link);
  const stamp = await repositoryStamp(f.git);
  await writeFile(first, 'changed outside bytes'); await verifyRepositoryStamp(f.git, stamp);
  await unlink(link); await symlink(second, link);
  await assert.rejects(verifyRepositoryStamp(f.git, stamp), changed);
  assert.equal(await readFile(first, 'utf8'), 'changed outside bytes'); assert.equal(await readFile(second, 'utf8'), 'other');
});

test('repository stamps stop at parent symlinks, file blockers and missing parents', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { committed: true }); await f.write('folder/tracked', 'base'); await f.commit('nested tracked path');
  const folder = join(f.path, 'folder'), outside = join(f.base, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'tracked'), 'outside-one'); await rm(folder, { recursive: true }); await symlink(outside, folder);
  const paths = ['folder/tracked'], symlinkStamp = await repositoryStamp(f.git, paths);
  await writeFile(join(outside, 'tracked'), 'outside-two'); await verifyRepositoryStamp(f.git, symlinkStamp, paths);
  await unlink(folder); await writeFile(folder, 'block-one');
  await assert.rejects(verifyRepositoryStamp(f.git, symlinkStamp, paths), changed);
  const blocked = await repositoryStamp(f.git, paths); await writeFile(folder, 'block-two');
  await assert.rejects(verifyRepositoryStamp(f.git, blocked, paths), changed);
  await unlink(folder); const missing = await repositoryStamp(f.git, paths);
  await mkdir(folder); await assert.rejects(verifyRepositoryStamp(f.git, missing, paths), changed);
  const empty = await repositoryStamp(f.git, paths); await f.write('folder/tracked', 'restored');
  await assert.rejects(verifyRepositoryStamp(f.git, empty, paths), changed);
  assert.equal(await readFile(join(outside, 'tracked'), 'utf8'), 'outside-two');
});

test('repository stamps detect file mode changes even when porcelain and bytes stay unchanged', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { committed: true }), file = join(f.path, 'hello.txt');
  await chmod(file, 0o644);
  const status = (await f.git.run(['status', '--porcelain=v1', '-z'])).stdout, stamp = await repositoryStamp(f.git);
  await chmod(file, 0o600);
  assert.deepEqual((await f.git.run(['status', '--porcelain=v1', '-z'])).stdout, status);
  await assert.rejects(verifyRepositoryStamp(f.git, stamp), changed);
  assert.equal(await readFile(file, 'utf8'), 'first\n');
});

test('repository stamps do not recursively fingerprint gitlinks or untracked nested repositories', async t => {
  const f = await fixture(t, { committed: true });
  for (const name of ['module', 'loose']) {
    const directory = join(f.path, name); await mkdir(directory);
    const nested = new Git(directory, { config: { 'user.name': 'Nested Fixture', 'user.email': 'nested@example.invalid' } });
    await nested.run(['init', '--initial-branch=main']); await f.write(`${name}/file`, 'base'); await nested.stagePaths(['file']); await nested.run(['commit', '-m', 'nested base']);
    if (name === 'module') await f.git.run(['update-index', '--add', '--cacheinfo', `160000,${await nested.value('rev-parse', 'HEAD')},module`]);
    await f.write(`${name}/file`, 'dirty-one');
  }
  const paths = ['module'], status = (await f.git.run(['status', '--porcelain=v1', '-z'])).stdout, stamp = await repositoryStamp(f.git, paths);
  await f.write('module/file', 'dirty-two'); await f.write('loose/file', 'dirty-two');
  assert.deepEqual((await f.git.run(['status', '--porcelain=v1', '-z'])).stdout, status);
  await verifyRepositoryStamp(f.git, stamp, paths);
  await f.write('hello.txt', 'ordinary change'); await assert.rejects(verifyRepositoryStamp(f.git, stamp, paths), changed);
  assert.equal(await readFile(join(f.path, 'module/file'), 'utf8'), 'dirty-two'); assert.equal(await readFile(join(f.path, 'loose/file'), 'utf8'), 'dirty-two');
});

test('repository stamps exclude protected account data under ignored ancestors but still hash siblings', async t => {
  const f = await fixture(t, { committed: true }); await f.write('.gitignore', 'ignored/\n'); await f.commit('ignore account-data ancestor');
  const data = join(f.path, 'ignored', 'data');
  await f.write('ignored/data/fixture-key', 'synthetic-one'); await f.write('ignored/cache', 'cache-one'); await f.write('database/safe', 'safe-one');
  await configureApp(new ScriptedConsole(), { dataDir: data });
  const paths = ['ignored', 'ignored/data/fixture-key'], stamp = await repositoryStamp(f.git, paths);
  await f.write('ignored/data/fixture-key', 'synthetic-two'); await f.write('ignored/data/new-child/fixture-token', 'synthetic token only');
  await verifyRepositoryStamp(f.git, stamp, paths);
  await f.write('ignored/cache', 'cache-two'); await assert.rejects(verifyRepositoryStamp(f.git, stamp, paths), changed);
  const next = await repositoryStamp(f.git, paths);
  await f.write('database/safe', 'safe-two'); await assert.rejects(verifyRepositoryStamp(f.git, next, paths), changed);
  assert.equal(await readFile(join(data, 'fixture-key'), 'utf8'), 'synthetic-two');
});

test('repository stamps pin the configured account-data location', async t => {
  const f = await fixture(t, { committed: true }), stamp = await repositoryStamp(f.git);
  await configureApp(new ScriptedConsole(), { dataDir: join(f.base, 'different-data') });
  await assert.rejects(verifyRepositoryStamp(f.git, stamp), changed);
  assert.deepEqual(await f.git.changes(), []);
});

test('pull rechecks repository fingerprints after confirmation before any network command', async t => {
  const f = await fixture(t, { committed: true }); await f.remote();
  await f.git.run(['config', 'branch.main.remote', 'origin']); await f.git.run(['config', 'branch.main.merge', 'refs/heads/main']);
  const head = await f.git.value('rev-parse', 'HEAD'), run = Git.prototype.run, network = [];
  t.mock.method(Git.prototype, 'run', async function (args, options) {
    if (['fetch', 'pull', 'push', 'clone', 'ls-remote'].includes(args[0])) { network.push(args[0]); throw new Error('fingerprint check must precede network'); }
    return run.call(this, args, options);
  });
  const ui = new ScriptedConsole(['y']);
  const confirm = ui.routineConfirm.bind(ui);
  ui.routineConfirm = async (...args) => { const answer = await confirm(...args); if (answer) await writeFile(await f.git.gitPath('MERGE_AUTOSTASH'), `${head}\n`); return answer; };
  await assert.rejects(pull(ui, f.path), changed);
  assert.deepEqual(network, []); assert.equal(await f.git.value('rev-parse', 'HEAD'), head);
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'first\n');
});

test('template stop-tracking rejects same-status byte changes during confirmation', async t => {
  const f = await fixture(t, { committed: true }); await f.write('ignored.bin', 'base'); await f.commit('tracked ignored fixture');
  await f.write('.gitignore', 'ignored.bin\n'); await f.write('ignored.bin', 'dirty one');
  const head = await f.git.value('rev-parse', 'HEAD'), status = (await f.git.run(['status', '--porcelain=v1', '-z'])).stdout;
  const ui = changing(() => f.write('ignored.bin', 'dirty two'));
  await assert.rejects(stopTrackingIgnored(ui, f.path), changed);
  assert.equal(ui.messages.filter(line => line.includes('确认仅从 Git index 移除')).length, 1);
  assert.deepEqual((await f.git.run(['status', '--porcelain=v1', '-z'])).stdout, status);
  assert.ok((await f.git.run(['ls-files', '-z'])).stdout.includes(Buffer.from('ignored.bin\0')));
  assert.equal(await readFile(join(f.path, 'ignored.bin'), 'utf8'), 'dirty two'); assert.equal(await f.git.value('rev-parse', 'HEAD'), head);
});
