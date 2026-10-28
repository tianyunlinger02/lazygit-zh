import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../dist/cli.js';
import { Console, Cancelled } from '../dist/ui.js';
import { configureApp, resetAppContextForTests } from '../dist/app-context.js';
import { currentSession } from '../dist/session.js';
import { Vault } from '../dist/vault.js';
import { fixture, ScriptedConsole } from './support.mjs';

const PASSWORD = 'synthetic-startup-password';
function login(answers, values = [PASSWORD, PASSWORD]) {
  const pending = [...answers], remaining = [...values], messages = [], secrets = [], prompts = [];
  const ui = new Console(prompt => {
    messages.push(prompt); assert.ok(pending.length, `unexpected prompt: ${prompt}`);
    const value = pending.shift(); if (value instanceof Error) throw value; return value;
  }, message => messages.push(message), {
    secretInput: prompt => {
      prompts.push(prompt); messages.push(prompt); assert.ok(remaining.length, `unexpected secret: ${prompt}`);
      const value = remaining.shift(); if (value instanceof Error) throw value;
      const secret = Buffer.from(value); secrets.push(secret); return secret;
    },
  });
  return { ui, messages, pending, remaining, secrets, prompts };
}
async function bare(f, input, args = []) {
  const cwd = process.cwd(); process.chdir(f.base);
  try { return await main(args, input.ui); } finally { process.chdir(cwd); }
}
function normalMode() { delete process.env.AUTOGIT_DATA_DIR; resetAppContextForTests(); }
function pointer() { return process.platform === 'win32' ? join(process.env.APPDATA, 'AutoGit', 'location.json') : join(process.env.XDG_CONFIG_HOME, 'autogit', 'location.json'); }
const cleared = input => assert.ok(input.secrets.every(value => value.every(byte => byte === 0)));

test('startup help/version bypass terminal preflight, input and credential storage', async t => {
  const f = await fixture(t), ui = new Console(() => { throw Error('help must not consume input'); }, () => {});
  for (const flag of ['--help', '--version']) assert.equal(await main([flag], ui), 0);
  await assert.rejects(fs.stat(process.env.AUTOGIT_DATA_DIR), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.home), []); assert.equal(currentSession(), undefined);
});

test('bare startup chooses location, confirms a real standalone password, selects a project and unlocks again next time', async t => {
  const f = await fixture(t); normalMode(); const root = join(f.home, '个人 AutoGit');
  const first = login([root, 'y', '2', f.path, '0']);
  assert.equal(await bare(f, first), 0, first.messages.join('\n')); assert.equal(first.pending.length, 0); assert.equal(first.remaining.length, 0);
  const transcript = first.messages.join('\n');
  assert.ok(transcript.indexOf('选择 AutoGit 资料保存位置') < transcript.indexOf('新的 AutoGit 解锁密码：'));
  assert.ok(transcript.indexOf('再次输入新的 AutoGit 解锁密码：') < transcript.indexOf('请离线保存恢复码'));
  assert.ok(transcript.indexOf('请离线保存恢复码') < transcript.indexOf('启动项目选择'));
  assert.ok(transcript.indexOf('启动项目选择') < transcript.indexOf('你想做什么'));
  assert.doesNotMatch(transcript, /当前系统用户|Windows Hello|PAM/u);
  assert.equal(JSON.parse(await fs.readFile(pointer())).appRoot, root);
  assert.equal(JSON.parse(await fs.readFile(join(root, 'data', 'settings.json'))).last_project, f.path);
  const bytes = await fs.readFile(join(root, 'data', 'vault.json')); assert.equal(bytes.includes(Buffer.from(PASSWORD)), false);
  cleared(first); assert.equal(currentSession(), undefined);
  const second = login(['1', '0'], [PASSWORD]); assert.equal(await bare(f, second), 0, second.messages.join('\n'));
  assert.match(second.messages.join('\n'), /启动项目选择/u); assert.match(second.messages.join('\n'), /继续上次项目/u);
  assert.doesNotMatch(second.messages.join('\n'), /选择 AutoGit 资料保存位置|请离线保存恢复码|再次输入新的/u);
  assert.equal(second.prompts.length, 1); cleared(second); assert.equal(currentSession(), undefined);
});

test('cancelling the bare startup chooser preserves last project and recent records and locks the vault', async t => {
  const f = await fixture(t), data = process.env.AUTOGIT_DATA_DIR;
  const first = login(['y', '0']); assert.equal(await bare(f, first, ['--path', f.path]), 0);
  const settings = await fs.readFile(join(data, 'settings.json')), projects = await fs.readFile(join(data, 'projects.json'));
  const cancelled = login(['0'], [PASSWORD]); assert.equal(await bare(f, cancelled), 0, cancelled.messages.join('\n'));
  assert.match(cancelled.messages.join('\n'), /未选择项目/u); assert.doesNotMatch(cancelled.messages.join('\n'), /你想做什么/u);
  assert.deepEqual(await fs.readFile(join(data, 'settings.json')), settings); assert.deepEqual(await fs.readFile(join(data, 'projects.json')), projects);
  assert.equal(currentSession(), undefined); cleared(cancelled);
});

test('bare startup can create a local project folder without Git initialization or another creation confirmation', async t => {
  const f = await fixture(t), data = process.env.AUTOGIT_DATA_DIR, project = join(f.base, '新建 项目', 'child');
  const input = login(['y', '3', project, '0']); assert.equal(await bare(f, input), 0, input.messages.join('\n'));
  assert.equal((await fs.stat(project)).isDirectory(), true); await assert.rejects(fs.stat(join(project, '.git')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(join(data, 'settings.json'))).last_project, project);
  await assert.rejects(fs.stat(join(data, 'projects.json')), { code: 'ENOENT' });
  assert.equal((input.messages.join('\n').match(/\[y\/N\]/gu) ?? []).length, 1, 'only recovery-code acknowledgement is a hard confirmation');
  cleared(input);
});

test('declining first recovery-code acknowledgement retains the encrypted library but never commits its startup pointer', async t => {
  const f = await fixture(t); normalMode(); const root = join(f.home, 'unconfirmed');
  const input = login([root, 'n']); assert.equal(await bare(f, input), 0, input.messages.join('\n'));
  await assert.rejects(fs.stat(pointer()), { code: 'ENOENT' }); assert.equal((await fs.stat(join(root, 'data', 'vault.json'))).isFile(), true);
  assert.doesNotMatch(input.messages.join('\n'), /启动项目选择|你想做什么/u); assert.equal(currentSession(), undefined); cleared(input);
  const recovered = await Vault.unlock(join(root, 'data'), Buffer.from(PASSWORD)); recovered.close();
});

test('failed unlock of a located library preserves its pointer and bytes and never reaches the project guide', async t => {
  const f = await fixture(t); normalMode(); const lost = join(f.base, 'lost'), target = join(f.base, 'existing');
  await configureApp(new ScriptedConsole([lost])); const before = await fs.readFile(pointer());
  const password = Buffer.from('other-synthetic-password');
  const { vault } = await Vault.create(join(target, 'data'), password); password.fill(0); vault.close();
  const encrypted = await fs.readFile(join(target, 'data', 'vault.json'));
  const input = login(['2', target, '1', '1', '0'], ['wrong-synthetic-one', 'wrong-synthetic-two', 'wrong-synthetic-three']);
  assert.equal(await bare(f, input), 0, input.messages.join('\n'));
  assert.deepEqual(await fs.readFile(pointer()), before); assert.deepEqual(await fs.readFile(join(target, 'data', 'vault.json')), encrypted);
  assert.equal(input.prompts.length, 3); assert.equal(input.pending.length, 0);
  assert.doesNotMatch(input.messages.join('\n'), /启动项目选择|你想做什么/u); assert.equal(currentSession(), undefined); cleared(input);
});

test('explicit project path skips only project selection, while cancelled new passwords create no location or library directories', async t => {
  const f = await fixture(t), input = login(['y', '0']);
  assert.equal(await bare(f, input, ['--path', f.path]), 0, input.messages.join('\n'));
  assert.match(input.messages.join('\n'), /加密凭据库/u); assert.match(input.messages.join('\n'), /新的 AutoGit 解锁密码/u);
  assert.doesNotMatch(input.messages.join('\n'), /启动项目选择/u); cleared(input);
  normalMode(); const root = join(f.home, 'cancelled'), cancelled = login([root], ['', 'too-short', PASSWORD, new Cancelled()]);
  assert.equal(await bare(f, cancelled), 0, cancelled.messages.join('\n'));
  await assert.rejects(fs.stat(pointer()), { code: 'ENOENT' }); await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  assert.doesNotMatch(cancelled.messages.join('\n'), /启动项目选择|你想做什么/u); assert.equal(currentSession(), undefined); cleared(cancelled);
});
