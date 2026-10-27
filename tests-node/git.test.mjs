import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Change, Git, GitError, parseStatus, validateUrl, validateGitUrl, redact, explain, encodePath, decodePath } from '../dist/git.js';
import { fixture } from './support.mjs';

test('NUL status preserves whitespace, line breaks, rename order and partial staging', () => {
  const changes = parseStatus(Buffer.from(' M name with spaces\0?? line\nbreak\0A  -leading\0R  new\0old\0MM partial\0UU conflict\0'));
  assert.deepEqual(changes.map(item => item.path), ['name with spaces', 'line\nbreak', '-leading', 'new', 'partial', 'conflict']);
  assert.deepEqual(changes[3], new Change('R', ' ', 'new', 'old'));
  assert.equal(changes[0].staged, false); assert.equal(changes[2].staged, true);
  assert.equal(changes[4].staged && changes[4].unstaged, true); assert.equal(changes[5].conflict, true);
  assert.match(changes[1].label(), /\\n/u);
});
test('malformed status and missing rename source fail closed', () => {
  for (const raw of ['broken\0', 'R  missing-original\0']) assert.throws(() => parseStatus(Buffer.from(raw)), GitError);
});
test('GitHub addresses whitelist rejects credentials, query and option injection', () => {
  for (const url of ['git@github.com:person/repo.git', 'https://github.com/person/repo', 'https://github.com/a/.github/']) assert.equal(validateUrl(url), url);
  for (const url of ['-u', 'https://secret@github.com/a/b', 'https://github.com/a/b?token=x', 'ext::anything', 'file:///tmp/repo', 'https://github.com.evil.test/a/b', 'git@github.com:/a/b', 'git@github.com:a/..', 'https://github.com:bad/a/b', 'git@github.com:a/b\n--upload-pack=x']) assert.throws(() => validateUrl(url), GitError);
});

test('generic Git addresses allow non-GitHub transports but reject unsafe schemes and credentials', () => {
  for (const url of ['https://gitlab.example.invalid/team/repo.git', 'ssh://git@git.example.invalid:2222/team/repo.git', 'git@git.example.invalid:team/repo.git', 'git://git.example.invalid/team/repo.git', 'host-alias:team/repo.git']) assert.equal(validateGitUrl(url), url);
  for (const url of ['-u', 'ext::ssh://git@example.invalid/%h', 'file:///tmp/repo', 'https://user:secret@example.invalid/team/repo', 'https://git.example.invalid/team/repo?token=x', 'https://git.example.invalid/team/repo#fragment', 'https://git.example.invalid/', 'git@example.invalid:/team/repo', 'host::team/repo', 'C:\\repo', 'https://git.example.invalid/team/../repo']) assert.throws(() => validateGitUrl(url), GitError);
});
test('error explanations and URL redaction do not print secrets', () => {
  assert.doesNotMatch(redact('https://user:secret@github.com/a/b?token=secret#secret'), /secret/);
  assert.match(explain('Permission denied (publickey).'), /SSH/); assert.match(explain('fatal: Not possible to fast-forward'), /分叉/);
});
test('all byte values and Unicode/BOM paths roundtrip without replacement', () => {
  for (const raw of [Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from('a﻿中文😀.txt'), Buffer.from([0xed, 0xa0, 0x80, 0xf0, 0x80, 0xc2])]) assert.deepEqual(encodePath(decodePath(raw)), raw);
  assert.equal(decodePath(Buffer.from('﻿x﻿')), '﻿x﻿');
});
test('real Unicode root and NUL literal staging select only the exact file', async t => {
  const f = await fixture(t); await f.write('[abc].txt'); await f.write('a.txt'); await f.write('中文 空格.txt');
  assert.equal(await f.git.root(), f.path); await f.git.ensureReady(); await f.git.stagePaths(['[abc].txt']);
  const changes = new Map((await f.git.changes()).map(item => [item.path, item])); assert.equal(changes.get('[abc].txt').staged, true); assert.equal(changes.get('a.txt').staged, false);
});
test('raw non-UTF8 and BOM file names are staged by original bytes', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const raw = Buffer.concat([Buffer.from(f.path + '/'), Buffer.from([0xff]), Buffer.from('.txt')]);
  await writeFile(raw, 'raw'); await f.write('a﻿.txt'); await f.write('a.txt');
  const changes = await f.git.changes(); await f.git.stagePaths(changes.filter(item => item.path !== 'a.txt').map(item => item.path));
  const staged = (await f.git.run(['diff', '--cached', '--name-only', '-z'])).stdout;
  assert.ok(staged.includes(Buffer.from([0xff]))); assert.ok(staged.includes(Buffer.from('a﻿.txt\0'))); assert.ok(!staged.includes(Buffer.from('a.txt\0')));
});
test('surrogateescaped directory refuses before aliasing replacement-character directory', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await mkdir(join(f.base, '�')); assert.throws(() => new Git(join(f.base, '\udcff')), /字节路径/);
});
test('interactive Git captureStdout preserves machine-readable bytes without changing scoped context', async t => {
  const f = await fixture(t);
  const git = new Git(f.path, { config: { 'user.name': 'Captured Author' } });
  const result = await git.run(['config', '--get', 'user.name'], { interactive: true, captureStdout: true });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout, Buffer.from('Captured Author\n'));
  assert.equal(await f.git.config('user.name'), '测试用户');
});

test('configuration/environment context stays child-local through repository and configured', async t => {
  const f = await fixture(t); const managed = new Git(f.path, { config: { 'user.name': '临时身份' }, env: { AUTOGIT_TEST_VALUE: 'child' } });
  assert.equal(await (await managed.repository()).config('user.name'), '临时身份');
  assert.equal(await (await managed.configured({ 'user.email': 'managed@example.invalid' }).repository()).config('user.email'), 'managed@example.invalid');
  assert.equal(await f.git.config('user.name'), '测试用户'); assert.equal(process.env.AUTOGIT_TEST_VALUE, undefined);
});
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) test(`repository/config injection ${key} is rejected without values`, async t => {
  const f = await fixture(t); process.env[key] = 'test-secret'; await assert.rejects(f.git.root(), error => /环境覆盖/u.test(error.message) && !error.message.includes('test-secret'));
});
test('explicit rejected identity environment survives derived contexts', async t => {
  const f = await fixture(t); process.env.GIT_AUTHOR_NAME = 'outside'; const git = new Git(f.path, { rejectEnv: ['GIT_AUTHOR_NAME'] }); await assert.rejects(git.root(), /环境覆盖/);
});
test('merge marker, autostash and detached HEAD are not ordinary ready states', async t => {
  const f = await fixture(t, { committed: true }); const marker = await f.git.gitPath('MERGE_AUTOSTASH'); await writeFile(marker, 'unknown\n');
  assert.equal(await f.git.operation(), 'MERGE_AUTOSTASH'); assert.deepEqual(await f.git.unmerged(), []); await assert.rejects(f.git.ensureReady(), /尚未完成/);
});
test('detached HEAD refuses writes but status remains readable', async t => {
  const f = await fixture(t, { committed: true }); await f.git.run(['checkout', '--detach', 'HEAD']); await assert.rejects(f.git.ensureReady(), /游离/); assert.deepEqual(await f.git.changes(), []);
});
test('non repository and absent Git produce readable errors', async t => {
  const f = await fixture(t); await assert.rejects(new Git(f.base).root(), /不是/); process.env.PATH = ''; await assert.rejects(f.git.changes(), /Git/);
});
test('registered gitlinks remain usable and Git commands disable recursive submodule changes', async t => {
  const f = await fixture(t, { committed: true });
  await f.git.run(['update-index', '--add', '--cacheinfo', `160000,${await f.git.value('rev-parse', 'HEAD')},module`]);
  await assert.doesNotReject(f.git.ensureSupported());
  const result = await f.git.run(['config', '--get', 'submodule.recurse']);
  assert.equal(result.stdout.toString().trim(), 'false');
});
