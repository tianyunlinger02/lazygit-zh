import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './support.mjs';
import { runProcess, which } from '../dist/process.js';
import { Git, GitError } from '../dist/git.js';

test('Windows PATH and PATHEXT names are case insensitive; native .cmd is not shell-executed', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); const bin = join(f.base, 'tools'); await mkdir(bin); const exe = join(bin, 'sample.EXE'), cmd = join(bin, 'native-fixture.CMD'); await writeFile(exe, 'fixture-not-executable'); await writeFile(cmd, '@echo should-not-run');
  const env = { Path: bin, PathExt: '.EXE;.CMD' };
  assert.equal(which('sample', env, f.base), exe); assert.equal(which('native-fixture', env, f.base), cmd);
  await assert.rejects(runProcess('native-fixture', [], { cwd: f.base, env, inputData: Buffer.alloc(0) }), /\.cmd\/\.bat/);
});
test('Windows lowercase repository/identity environment overrides cannot bypass guards', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); process.env.git_dir = 'SECRET'; await assert.rejects(f.git.root(), error => error instanceof GitError && /环境覆盖/u.test(error.message) && !error.message.includes('SECRET')); delete process.env.git_dir;
  process.env.git_author_name = 'SECRET'; await assert.rejects(new Git(f.path, { rejectEnv: ['GIT_AUTHOR_NAME'] }).root(), /环境覆盖/);
});
