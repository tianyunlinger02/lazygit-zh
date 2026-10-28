import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault, VaultUnlockError } from '../dist/vault.js';
import { which } from '../dist/process.js';
import { fixture } from './support.mjs';
import { productionPty } from './pty-driver.mjs';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const options = { skip: process.platform === 'win32' || !which('script'), timeout: 60000 };
const PASSWORD = 'synthetic-standalone-passphrase';
const NEXT_PASSWORD = 'synthetic-replacement-passphrase';
function completed(result) {
  assert.equal(result.status, 0, result.output + result.errors);
  assert.equal(result.steps, result.expectedSteps, result.output + result.errors);
  assert.doesNotMatch(result.output, /synthetic-standalone-passphrase|synthetic-replacement-passphrase|synthetic-mismatched-passphrase/u);
  assert.doesNotMatch(result.output, /当前系统用户|PAM|Hello PIN/u);
}

test('production CLI PTY sets and confirms a standalone password, unlocks again and changes only its wrapping password', options, async t => {
  const f = await fixture(t); delete process.env.AUTOGIT_DATA_DIR;
  const root = join(f.home, '个人 凭据库'), data = join(root, 'data');
  const first = await productionPty(t, cli, { cwd: f.path, env: process.env, steps: [
    ['AutoGit 资料文件夹（软件根目录）', `${root}\n`],
    ['新的 AutoGit 解锁密码：', `${PASSWORD}\r`],
    ['再次输入新的 AutoGit 解锁密码：', 'synthetic-mismatched-passphrase\r'],
    ['新的 AutoGit 解锁密码：', `${PASSWORD}\r`],
    ['再次输入新的 AutoGit 解锁密码：', `${PASSWORD}\r`],
    ['[y/N]：', 'y\n'],
    ['请选择编号：', '1\n'],
    ['请选择编号：', '0\n'],
  ] });
  completed(first);
  assert.match(first.output, /启动项目选择/u);
  assert.match(first.output, /你想做什么/u);
  assert.ok(first.output.indexOf('AutoGit 资料文件夹') < first.output.indexOf('新的 AutoGit 解锁密码：'));
  const original = JSON.parse(await fs.readFile(join(data, 'vault.json')));
  const recoveryCode = first.output.match(/[a-f0-9]{8}(?:-[a-f0-9]{8}){7}/u)?.[0];
  assert.ok(recoveryCode, 'creation must show an offline recovery code');
  const second = await productionPty(t, cli, { cwd: f.path, env: process.env, steps: [
    ['AutoGit 解锁密码（忘记密码请直接回车）：', `${PASSWORD}\r`],
    ['请选择编号：', '1\n'],
    ['请选择编号：', '4\n'],
    ['请选择编号：', '4\n'],
    ['请选择编号：', '7\n'],
    ['当前 AutoGit 解锁密码：', `${PASSWORD}\r`],
    ['新的 AutoGit 解锁密码：', `${NEXT_PASSWORD}\r`],
    ['再次输入新的 AutoGit 解锁密码：', `${NEXT_PASSWORD}\r`],
    ['请选择编号：', '0\n'],
  ] });
  completed(second);
  assert.doesNotMatch(second.output, /选择 AutoGit 资料保存位置|离线保存恢复码/u);
  assert.match(second.output, /AutoGit 解锁密码已修改/u);
  const changed = JSON.parse(await fs.readFile(join(data, 'vault.json')));
  assert.equal(changed.vault_id, original.vault_id);
  assert.deepEqual(changed.records, original.records);
  assert.deepEqual(changed.recovery, original.recovery);
  assert.notDeepEqual(changed.password, original.password);
  const old = Buffer.from(PASSWORD), next = Buffer.from(NEXT_PASSWORD);
  try {
    await assert.rejects(Vault.unlock(data, old), VaultUnlockError);
    const unlocked = await Vault.unlock(data, next); unlocked.close();
  } finally { old.fill(0); next.fill(0); }
  const third = await productionPty(t, cli, { cwd: f.path, env: process.env, steps: [
    ['AutoGit 解锁密码（忘记密码请直接回车）：', `${NEXT_PASSWORD}\r`],
    ['请选择编号：', '0\n'],
  ] });
  completed(third);
  assert.match(third.output, /未选择项目/u);
  assert.doesNotMatch(third.output, /你想做什么/u);
});

test('production CLI PTY cancellation before password confirmation creates no directory or location pointer', options, async t => {
  const f = await fixture(t); delete process.env.AUTOGIT_DATA_DIR;
  const root = join(f.home, 'cancelled credentials');
  const result = await productionPty(t, cli, { cwd: f.path, env: process.env, steps: [
    ['AutoGit 资料文件夹（软件根目录）', `${root}\n`],
    ['新的 AutoGit 解锁密码：', `${PASSWORD}\r`],
    ['再次输入新的 AutoGit 解锁密码：', '\x03'],
  ] });
  completed(result);
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  await assert.rejects(fs.stat(join(process.env.XDG_CONFIG_HOME, 'autogit', 'location.json')), { code: 'ENOENT' });
  assert.doesNotMatch(result.output, /启动项目选择|你想做什么/u);
});
