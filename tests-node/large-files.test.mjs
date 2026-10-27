import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { autoIgnoreLargeFiles, DEFAULT_LARGE_FILE_BYTES } from '../dist/large-files.js';
import { Git, encodePath } from '../dist/git.js';
import { saveAndPush } from '../dist/workflows.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function sparse(f, name, size = DEFAULT_LARGE_FILE_BYTES + 1) {
  const file = encodePath(path.join(f.path, name));
  await mkdir(encodePath(path.dirname(path.join(f.path, name))), { recursive: true });
  const handle = await open(file, 'w');
  try { await handle.truncate(size); } finally { await handle.close(); }
  return file;
}
async function apply(f, ui = new ScriptedConsole([], { quick: true })) {
  const result = await autoIgnoreLargeFiles(ui, f.git, await f.git.changes());
  assert.deepEqual(ui.answers, []);
  return { result, ui };
}
async function checkIgnored(f, names) {
  const result = await f.git.run(['--no-literal-pathspecs', 'check-ignore', '-z', '--stdin'], { check: false, inputData: Buffer.concat(names.flatMap(name => [encodePath(name), Buffer.from([0])])) });
  assert.ok([0, 1].includes(result.status));
  return result.stdout;
}

for (const [offset, ignored] of [[-1, false], [0, false], [1, true]]) {
  test(`automatic large-file ignore uses strict 50 MiB threshold; offset ${offset}`, async t => {
    const f = await fixture(t); await sparse(f, 'asset.bin', DEFAULT_LARGE_FILE_BYTES + offset);
    const before = (await f.git.run(['ls-files', '--stage', '-z'])).stdout;
    const { result, ui } = await apply(f);
    assert.equal(result.has('asset.bin'), ignored);
    assert.equal((await checkIgnored(f, ['asset.bin'])).length > 0, ignored);
    assert.equal((await lstat(path.join(f.path, 'asset.bin'))).size, DEFAULT_LARGE_FILE_BYTES + offset);
    assert.deepEqual((await f.git.run(['ls-files', '--stage', '-z'])).stdout, before);
    assert.doesNotMatch(ui.transcript, /最终确认|\[y\/N\]/u);
    if (!ignored) await assert.rejects(readFile(path.join(f.path, '.gitignore')), { code: 'ENOENT' });
  });
}

test('automatic large-file ignore is idempotent and does not stage its new rules', async t => {
  const f = await fixture(t); await sparse(f, 'asset.bin');
  const first = await apply(f); assert.match(first.ui.transcript, /已自动忽略.*asset\.bin/u);
  const before = await readFile(path.join(f.path, '.gitignore'));
  await apply(f);
  assert.deepEqual(await readFile(path.join(f.path, '.gitignore')), before);
  assert.equal(before.toString(), '/asset.bin\n');
  assert.deepEqual((await f.git.run(['ls-files', '-z'])).stdout, Buffer.alloc(0));
  assert.deepEqual((await f.git.changes()).map(change => change.path), ['.gitignore']);
});

for (const original of [Buffer.from('# old\nsmall.keep\n'), Buffer.from('# old\r\nsmall.keep\r\n'), Buffer.from('# no final newline'), Buffer.from([35, 32, 255, 10])]) {
  test(`automatic large-file ignore preserves existing bytes ${original.toString('hex')}`, async t => {
    const f = await fixture(t); await writeFile(path.join(f.path, '.gitignore'), original); await sparse(f, 'asset.bin');
    if (process.platform !== 'win32') await chmod(path.join(f.path, '.gitignore'), 0o640);
    await apply(f); const result = await readFile(path.join(f.path, '.gitignore'));
    assert.deepEqual(result.subarray(0, original.length), original);
    assert.equal(result.subarray(original.length).toString(), `${original.at(-1) === 10 ? '' : '\n'}/asset.bin${original.includes(Buffer.from('\r\n')) ? '\r\n' : '\n'}`);
    if (process.platform !== 'win32') assert.equal((await lstat(path.join(f.path, '.gitignore'))).mode & 0o777, 0o640);
  });
}

test('automatic large-file ignore overrides an earlier root negation once without duplicating rules', async t => {
  const f = await fixture(t); await f.write('.gitignore', '/asset.bin\n!/asset.bin\n'); await sparse(f, 'asset.bin');
  await apply(f); const before = await readFile(path.join(f.path, '.gitignore'));
  assert.equal(before.toString(), '/asset.bin\n!/asset.bin\n/asset.bin\n');
  assert.deepEqual(await checkIgnored(f, ['asset.bin']), Buffer.from('asset.bin\0'));
  await apply(f); assert.deepEqual(await readFile(path.join(f.path, '.gitignore')), before);
});

for (const name of ['space name.bin', '中文/文件.bin', '#file.bin', '!file.bin', '[abc].bin', '*.bin', 'a?.bin', 'back\\slash.bin', 'tail .bin', 'trailing ']) {
  const portable = !/[?*\\]| $/u.test(name);
  test(`automatic large-file ignore writes exact Git patterns for ${JSON.stringify(name)}`, { skip: process.platform === 'win32' && !portable }, async t => {
    const f = await fixture(t); await sparse(f, name); await sparse(f, `other/${path.basename(name)}`, 1); await f.write('a.bin', 'small\n');
    await apply(f);
    assert.deepEqual(await checkIgnored(f, [name, `other/${path.basename(name)}`, 'a.bin']), Buffer.concat([encodePath(name), Buffer.from([0])]));
  });
}

test('automatic large-file ignore preserves POSIX non-UTF-8 path bytes exactly', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), raw = Buffer.from([0x62, 0x61, 0x64, 0xff, 0x2e, 0x62, 0x69, 0x6e]);
  const handle = await open(Buffer.concat([Buffer.from(f.path + path.sep), raw]), 'w');
  try { await handle.truncate(DEFAULT_LARGE_FILE_BYTES + 1); } finally { await handle.close(); }
  await apply(f);
  assert.deepEqual(await readFile(path.join(f.path, '.gitignore')), Buffer.concat([Buffer.from('/'), raw, Buffer.from('\n')]));
  assert.deepEqual((await f.git.run(['--no-literal-pathspecs', 'check-ignore', '-z', '--stdin'], { inputData: Buffer.concat([raw, Buffer.from([0])]) })).stdout, Buffer.concat([raw, Buffer.from([0])]));
});

test('automatic large-file ignore never changes HEAD-tracked, staged or partially staged files', async t => {
  const f = await fixture(t); await f.write('tracked.bin', 'committed\n'); await f.commit();
  await f.write('staged.bin', 'staged\n'); await f.git.stagePaths(['staged.bin']);
  await sparse(f, 'tracked.bin'); await sparse(f, 'staged.bin');
  const before = (await f.git.run(['ls-files', '--stage', '-z'])).stdout, head = await f.git.value('rev-parse', 'HEAD');
  const { result } = await apply(f);
  assert.equal(result.size, 0); assert.equal(await f.git.value('rev-parse', 'HEAD'), head);
  assert.deepEqual((await f.git.run(['ls-files', '--stage', '-z'])).stdout, before);
  await assert.rejects(readFile(path.join(f.path, '.gitignore')), { code: 'ENOENT' });
});

test('automatic large-file ignore respects staged deletions and renamed original paths', async t => {
  const f = await fixture(t); await f.write('deleted.bin', 'old\n'); await f.write('original.bin', 'old rename\n'); await f.commit();
  await f.git.run(['rm', '--cached', 'deleted.bin']); await f.git.run(['mv', 'original.bin', 'renamed.bin']);
  await sparse(f, 'deleted.bin'); await sparse(f, 'original.bin');
  const before = (await f.git.run(['ls-files', '--stage', '-z'])).stdout;
  assert.equal((await apply(f)).result.size, 0);
  assert.deepEqual((await f.git.run(['ls-files', '--stage', '-z'])).stdout, before);
  await assert.rejects(readFile(path.join(f.path, '.gitignore')), { code: 'ENOENT' });
});

test('automatic large-file ignore preserves a partially staged gitignore blob', async t => {
  const f = await fixture(t); await f.write('.gitignore', '# committed\n'); await f.commit();
  await f.write('.gitignore', '# committed\n# staged\n'); await f.git.stagePaths(['.gitignore']);
  await f.write('.gitignore', '# committed\n# staged\n# unstaged\n'); await sparse(f, 'asset.bin');
  const before = (await f.git.run(['ls-files', '--stage', '-z'])).stdout;
  await apply(f);
  assert.deepEqual((await f.git.run(['ls-files', '--stage', '-z'])).stdout, before);
  assert.equal((await f.git.run(['show', ':.gitignore'])).stdout.toString(), '# committed\n# staged\n');
  assert.equal(await readFile(path.join(f.path, '.gitignore'), 'utf8'), '# committed\n# staged\n# unstaged\n/asset.bin\n');
});

test('automatic large-file ignore skips nested repositories, symlinks and already ignored files', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await f.write('.gitignore', 'already.bin\n'); await sparse(f, 'already.bin');
  const nested = path.join(f.path, 'nested'); await mkdir(nested); await new Git(nested).run(['init', '--initial-branch=main']); await sparse(f, 'nested/asset.bin');
  await symlink(path.join(f.path, 'already.bin'), path.join(f.path, 'linked.bin'));
  assert.equal((await apply(f)).result.size, 0);
  assert.equal(await readFile(path.join(f.path, '.gitignore'), 'utf8'), 'already.bin\n');
});

for (const name of ['line\nname.bin', 'line\rname.bin']) {
  test(`unrepresentable oversized path ${JSON.stringify(name)} is excluded without blocking small-file commits`, { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t); await sparse(f, name); await f.write('small.txt', 'keep\n');
    const ui = new ScriptedConsole(['a', 'small only'], { quick: true }); await saveAndPush(ui, f.path, { upload: false });
    assert.deepEqual((await f.git.run(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])).stdout, Buffer.from('small.txt\0'));
    assert.match(ui.transcript, /名称含换行/u); assert.doesNotMatch(ui.transcript, /\[y\/N\]/u); assert.deepEqual(ui.answers, []);
    assert.equal((await lstat(encodePath(path.join(f.path, name)))).size, DEFAULT_LARGE_FILE_BYTES + 1);
  });
}

test('subdirectory negations cannot silently include oversized files or duplicate root rules', async t => {
  const f = await fixture(t); await f.write('sub/.gitignore', '!asset.bin\n'); await sparse(f, 'sub/asset.bin'); await f.write('small.txt', 'keep\n');
  const first = await apply(f); assert.equal(first.result.has('sub/asset.bin'), true); assert.match(first.ui.transcript, /未生效/u);
  const before = await readFile(path.join(f.path, '.gitignore')); await apply(f); assert.deepEqual(await readFile(path.join(f.path, '.gitignore')), before);
  const ui = new ScriptedConsole(['a', 'no oversized file'], { quick: true }); await saveAndPush(ui, f.path, { upload: false });
  assert.equal((await f.git.run(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])).stdout.includes(Buffer.from('sub/asset.bin')), false);
});

test('unwritable gitignore targets skip only oversized candidates and allow a normal commit', async t => {
  const f = await fixture(t); await mkdir(path.join(f.path, '.gitignore')); await sparse(f, 'asset.bin'); await f.write('small.txt', 'keep\n');
  const ui = new ScriptedConsole(['a', 'small despite ignore target'], { quick: true }); await saveAndPush(ui, f.path, { upload: false });
  assert.equal(await f.git.value('ls-tree', '-r', '--name-only', 'HEAD'), 'small.txt');
  assert.match(ui.transcript, /自动忽略未完成/u); assert.deepEqual(ui.answers, []);
  assert.equal((await lstat(path.join(f.path, 'asset.bin'))).size, DEFAULT_LARGE_FILE_BYTES + 1);
  assert.equal((await lstat(path.join(f.path, '.gitignore'))).isDirectory(), true);
});

test('read-only gitignore contents remain intact while oversized files are skipped', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await f.write('.gitignore', '# read-only\n'); await sparse(f, 'asset.bin');
  const file = path.join(f.path, '.gitignore'); await chmod(file, 0o444);
  try {
    const { result, ui } = await apply(f); assert.equal(result.has('asset.bin'), true); assert.match(ui.transcript, /只读/u);
    assert.equal(await readFile(file, 'utf8'), '# read-only\n'); assert.equal((await lstat(file)).mode & 0o777, 0o444);
    assert.equal((await readdir(f.path)).some(name => name.startsWith('.autogit-ignore-')), false);
  } finally { await chmod(file, 0o644); }
});

test('linked gitignore is not followed or rewritten during automatic large-file ignore', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), target = path.join(f.base, 'external-ignore'); await writeFile(target, '# original external\n');
  await symlink(target, path.join(f.path, '.gitignore')); await sparse(f, 'asset.bin');
  const { result, ui } = await apply(f); assert.equal(result.has('asset.bin'), true); assert.match(ui.transcript, /不是单链接普通文件/u);
  assert.equal(await readFile(target, 'utf8'), '# original external\n'); assert.equal((await lstat(path.join(f.path, '.gitignore'))).isSymbolicLink(), true);
});

for (const existed of [false, true]) {
  test(`concurrent gitignore ${existed ? 'editing' : 'creation'} is preserved and leaves no temporary files`, async t => {
    const f = await fixture(t); if (existed) await f.write('.gitignore', '# before\n'); await sparse(f, 'asset.bin');
    const changes = await f.git.changes(), original = f.git.run.bind(f.git); let changed = false;
    f.git.run = async (args, options) => {
      if (!changed && args[0] === 'status') { changed = true; await f.write('.gitignore', '# concurrent\n'); }
      return original(args, options);
    };
    const ui = new ScriptedConsole([], { quick: true }); const result = await autoIgnoreLargeFiles(ui, f.git, changes);
    assert.equal(result.has('asset.bin'), true); assert.equal(await readFile(path.join(f.path, '.gitignore'), 'utf8'), '# concurrent\n');
    assert.match(ui.transcript, /变化/u); assert.equal((await readdir(f.path)).some(name => name.startsWith('.autogit-ignore-')), false);
  });
}

for (const action of ['shrink', 'stage', 'replace']) {
  test(`candidate ${action} during large-file preparation is rechecked without undoing user work`, async t => {
    const f = await fixture(t); await sparse(f, 'asset.bin'); const changes = await f.git.changes(), original = f.git.run.bind(f.git); let changed = false;
    f.git.run = async (args, options) => {
      if (!changed && args[0] === 'status') {
        changed = true;
        if (action === 'shrink') await f.write('asset.bin', 'now small\n');
        else if (action === 'replace') { await rename(path.join(f.path, 'asset.bin'), path.join(f.base, 'original.bin')); await sparse(f, 'asset.bin'); }
        else { await f.write('asset.bin', 'user staged\n'); await f.git.stagePaths(['asset.bin']); }
      }
      return original(args, options);
    };
    const result = await autoIgnoreLargeFiles(new ScriptedConsole([], { quick: true }), f.git, changes);
    if (action === 'replace') assert.equal(result.has('asset.bin'), true);
    else assert.equal(result.has('asset.bin'), false);
    if (action === 'stage') assert.equal((await f.git.run(['show', ':asset.bin'])).stdout.toString(), 'user staged\n');
    await assert.rejects(readFile(path.join(f.path, '.gitignore')), { code: 'ENOENT' });
  });
}

test('oversized gitignore is not read or given a self-ignore rule and small files still commit', async t => {
  const f = await fixture(t); await sparse(f, '.gitignore'); await f.write('small.txt', 'keep\n');
  const ui = new ScriptedConsole(['a', 'small only'], { quick: true }); await saveAndPush(ui, f.path, { upload: false });
  assert.equal(await f.git.value('ls-tree', '-r', '--name-only', 'HEAD'), 'small.txt'); assert.match(ui.transcript, /不添加自我忽略/u);
  assert.equal((await lstat(path.join(f.path, '.gitignore'))).size, DEFAULT_LARGE_FILE_BYTES + 1);
});
