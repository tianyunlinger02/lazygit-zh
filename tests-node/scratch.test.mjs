import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createScratch, scratchRoot } from '../scripts/scratch.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

test('scratch root and default directories are absolute and inside the project', async t => {
  assert.ok(isAbsolute(scratchRoot));
  assert.equal(scratchRoot, join(projectRoot, '.claude-tmp'));
  const scratch = await createScratch();
  t.after(scratch.cleanup);
  assert.ok(isAbsolute(scratch.directory));
  assert.equal(dirname(scratch.directory), scratchRoot);
  assert.match(basename(scratch.directory), /^case-.+/u);
  assert.equal((await stat(scratch.directory)).isDirectory(), true);
});

test('scratch directories are exclusive even with the same prefix', async t => {
  const first = await createScratch('unique-');
  t.after(first.cleanup);
  const second = await createScratch('unique-');
  t.after(second.cleanup);
  assert.notEqual(first.directory, second.directory);
  for (const scratch of [first, second]) {
    assert.equal(dirname(scratch.directory), scratchRoot);
    assert.match(basename(scratch.directory), /^unique-.+/u);
    assert.equal((await stat(scratch.directory)).isDirectory(), true);
  }
});

test('scratch paths do not depend on the working directory', async t => {
  const cwd = await createScratch('cwd-');
  t.after(cwd.cleanup);
  const moduleUrl = new URL('../scripts/scratch.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    const { createScratch, scratchRoot } = await import(${JSON.stringify(moduleUrl)});
    const scratch = await createScratch('from-child-');
    try {
      process.stdout.write(JSON.stringify({ scratchRoot, directory: scratch.directory }));
    } finally {
      await scratch.cleanup();
    }
  `], { cwd: cwd.directory, env: {}, encoding: 'utf8' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.scratchRoot, scratchRoot);
  assert.equal(dirname(result.directory), scratchRoot);
  assert.notEqual(result.directory, cwd.directory);
  await assert.rejects(stat(result.directory), { code: 'ENOENT' });
});

test('cleanup removes only its own directory and can be repeated', async t => {
  const first = await createScratch('cleanup-');
  t.after(first.cleanup);
  const second = await createScratch('cleanup-');
  t.after(second.cleanup);
  const nested = join(first.directory, 'nested');
  await mkdir(nested);
  await writeFile(join(nested, 'fixture.txt'), 'first fixture\n');
  const siblingFile = join(second.directory, 'fixture.txt');
  await writeFile(siblingFile, 'second fixture\n');
  await first.cleanup();
  await assert.rejects(stat(first.directory), { code: 'ENOENT' });
  assert.equal(await readFile(siblingFile, 'utf8'), 'second fixture\n');
  await first.cleanup();
  assert.equal(await readFile(siblingFile, 'utf8'), 'second fixture\n');
  assert.equal((await stat(scratchRoot)).isDirectory(), true);
});

test('scratch prefixes reject escaping paths and non-plain names', async () => {
  for (const prefix of [
    '', '.', '..', '../escape', '..\\escape', 'a/b', 'a\\b', '/absolute', 'C:\\absolute',
    'normal..name', 'file:///escape', 'space name', 'name\n', 'name\u0000', '%2Fescape',
    null, 0, true, [], {},
  ]) {
    await assert.rejects(createScratch(prefix), TypeError);
  }
});
