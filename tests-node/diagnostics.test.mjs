import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main, runMenu, toolSummary, HELP } from '../dist/cli.js';
import { Console, Cancelled } from '../dist/ui.js';
import { GitError } from '../dist/git.js';
import { NativeAuthError } from '../dist/auth.js';
import { PersonalGithubError } from '../dist/github-personal.js';
import { ProfileStore, profilesMenu } from '../dist/profiles.js';
import { HostStore, hostsMenu } from '../dist/hosts.js';
import { backupMenu } from '../dist/backup.js';
import { chooseStartupProject } from '../dist/projects.js';
import { configureApp } from '../dist/app-context.js';
import { readNewPassword, unlockSession, currentSession, setSession } from '../dist/session.js';
import { Vault } from '../dist/vault.js';
import { dependencies, diagnostics, publicKey, setupWizard } from '../dist/setup.js';
import { chooseCloneTarget } from '../dist/clone-target.js';
import { autoIgnoreLargeFiles, DEFAULT_LARGE_FILE_BYTES } from '../dist/large-files.js';
import { templatesMenu, writeTemplate } from '../dist/templates.js';
import { fixture, ScriptedConsole } from './support.mjs';

function assertPlain(ui) { assert.doesNotMatch(ui.transcript, /\x1b/u); }
const controlled = 'synthetic controlled diagnostic';

for (const [name, error, label, code] of [
  ['known failure', new GitError(`${controlled} https://user:synthetic-secret@github.com/a/b?token=synthetic-secret\x1b[32m`), '错误', 1],
  ['unexpected failure', new Error(controlled), '错误', 1],
  ['native helper unavailable', new NativeAuthError('unavailable', controlled), '错误', 1],
  ['unknown repository write', new PersonalGithubError(controlled, 'unknown'), '警告', 1],
  ['created repository with incomplete verification', new PersonalGithubError(controlled, 'created'), '警告', 1],
  ['known uncreated repository', new PersonalGithubError(controlled, 'not-created'), '错误', 1],
  ['write cancelled after dispatch', new Cancelled(controlled, true), '警告', 0],
]) {
  test(`main reports ${name} with explicit severity and no injected ANSI or credential URL`, async t => {
    const f = await fixture(t), ui = new ScriptedConsole([], { secretInput: () => { throw Error('must not request a secret'); } });
    assert.equal(await main(['--path', f.path], ui, { unlock: async () => { throw error; } }), code);
    assert.ok(ui.messages.some(message => message.startsWith(`[${label}]`) && message.includes(controlled)), ui.transcript);
    assert.doesNotMatch(ui.transcript, /synthetic-secret/u); assertPlain(ui);
  });
}

test('ordinary cancellation remains neutral even when its wording resembles an error or a partial write', async t => {
  const f = await fixture(t), ui = new ScriptedConsole([], { secretInput: () => Buffer.alloc(0) });
  assert.equal(await main(['--path', f.path], ui, { unlock: async () => { throw new Cancelled('错误：远端结果未知；部分步骤完成'); } }), 0);
  assert.match(ui.transcript, /已退出/u); assert.doesNotMatch(ui.transcript, /\[(?:错误|警告|成功)\]/u); assertPlain(ui);
});

for (const [name, error, label] of [
  ['failed task', new GitError(controlled), '错误'],
  ['unknown creation', new PersonalGithubError(controlled, 'unknown'), '警告'],
  ['created but unverified task', new PersonalGithubError(controlled, 'created'), '警告'],
  ['known rejected creation', new PersonalGithubError(controlled), '错误'],
  ['flagged cancellation', new Cancelled(controlled, true), '警告'],
  ['ordinary cancellation', new Cancelled('部分成功或错误并不决定严重程度'), undefined],
]) {
  test(`runMenu reports ${name} and returns to the same six-group menu`, async t => {
    const f = await fixture(t), ui = new ScriptedConsole(['1', '0']), original = ui.menu;
    t.mock.method(ui, 'menu', async function(title, options, back) {
      if (title === '日常项目') throw error;
      return original.call(this, title, options, back);
    });
    await runMenu(ui, f.path);
    if (label) assert.ok(ui.messages.some(message => message.startsWith(`[${label}]`) && message.includes(controlled)), ui.transcript);
    else assert.doesNotMatch(ui.transcript, /\[(?:错误|警告|成功)\]/u);
    assert.match(ui.transcript, /已返回菜单|已返回主菜单/u); assert.deepEqual(ui.answers, []); assertPlain(ui);
    if (error instanceof PersonalGithubError && error.repositoryState !== 'not-created') assert.doesNotMatch(ui.transcript, /可以检查后重试/u);
  });
}

test('invalid CLI flags are errors without startup input or storage', async t => {
  const f = await fixture(t), ui = new ScriptedConsole();
  assert.equal(await main(['--invalid-option'], ui), 2);
  assert.match(ui.transcript, /^\[错误\] 参数错误：/u); assert.deepEqual(ui.answers, []); assertPlain(ui);
  await assert.rejects(readFile(join(process.env.AUTOGIT_DATA_DIR, 'vault.json')), { code: 'ENOENT' });
});

test('dependency checks distinguish missing required tools from optional gh and explain native personal creation', async t => {
  const f = await fixture(t), empty = join(f.base, 'no-tools'); await mkdir(empty); process.env.PATH = empty;
  const ui = new ScriptedConsole(); dependencies(ui); toolSummary(ui);
  assert.ok(ui.messages.some(message => message.startsWith('[错误]') && message.includes('git（必需）：未找到')));
  for (const name of ['ssh', 'ssh-keygen']) {
    assert.ok(ui.messages.some(message => message.startsWith('[警告]') && message.includes(`${name}（仅 SSH 模式需要）：未找到`)), name);
    assert.ok(!ui.messages.some(message => message.startsWith('[错误]') && message.includes(`${name}`)), name);
  }
  assert.ok(ui.messages.some(message => message.startsWith('[警告]') && message.includes('gh（可选）：未找到')));
  for (const text of [ui.transcript, HELP]) {
    assert.match(text, /github\.com 个人账号原生建库.*不需要 gh/u);
    assert.match(text, /组织建库、GitHub Enterprise、PR \/ Issue \/ Release.*仍需要/u);
  }
  assert.doesNotMatch(ui.transcript, /\[成功\]/u); assertPlain(ui);
});

test('profile and host menus color their locally caught failures instead of losing them to neutral text', async t => {
  const f = await fixture(t);
  t.mock.method(ProfileStore.prototype, 'resolve_binding', async () => { throw new GitError(`${controlled}\x1b[32m`); });
  const profile = new ScriptedConsole(['6', '0']); await profilesMenu(profile, f.path);
  assert.match(profile.transcript, /\[错误\] 账号操作未完成：synthetic controlled diagnostic/u); assertPlain(profile);
  t.mock.method(HostStore.prototype, 'get', async () => undefined);
  t.mock.method(HostStore.prototype, 'set', async () => { throw new GitError(controlled); });
  const host = new ScriptedConsole(['3', 'y', '0']); await hostsMenu(host, f.path);
  assert.match(host.transcript, /\[错误\] 主机配置未完成：/u); assertPlain(host);
});

test('backup and template menus report local failures and keep ordinary cancellation neutral', async t => {
  const f = await fixture(t), backup = new ScriptedConsole(['2', join(f.base, 'missing-backup'), '0']);
  await backupMenu(backup); assert.match(backup.transcript, /\[错误\] 资料操作未完成：/u); assertPlain(backup);
  const template = new ScriptedConsole(['5', '1', 'Holder', 'not-a-year', '0']); await templatesMenu(template, f.path);
  assert.match(template.transcript, /\[错误\] 模板操作未完成：版权年份无效/u); assertPlain(template);
  const cancelled = new ScriptedConsole(['4', ':q', '0']); await templatesMenu(cancelled, f.path);
  assert.match(cancelled.transcript, /已返回；已完成的文件保留/u); assert.doesNotMatch(cancelled.transcript, /\[(?:错误|警告|成功)\]/u);
});

test('flagged cancellation preserves its controlled partial-result message through local catches', async t => {
  const f = await fixture(t), ui = new ScriptedConsole(['6', '0']);
  t.mock.method(ProfileStore.prototype, 'resolve_binding', async () => { throw new Cancelled(controlled, true); });
  await profilesMenu(ui, f.path);
  assert.ok(ui.messages.includes(`[警告] ${controlled}`)); assert.doesNotMatch(ui.transcript, /\[错误\]|\[成功\]/u); assertPlain(ui);
});

test('startup stale shortcuts are warnings while selected invalid paths are errors', async t => {
  const f = await fixture(t), ui = new ScriptedConsole(['2', join(f.base, 'missing-selection'), '0']);
  assert.equal(await chooseStartupProject(ui, f.path, join(f.base, 'missing-remembered')), undefined);
  assert.ok(ui.messages.some(message => message.startsWith('[警告] 继续上次项目路径不可用：')));
  assert.ok(ui.messages.some(message => message.startsWith('[错误] 项目选择未完成：'))); assertPlain(ui);
});

test('invalid app locations and clone names report local input errors before returning', async t => {
  const f = await fixture(t), env = { ...process.env }; delete env.AUTOGIT_DATA_DIR;
  const app = new ScriptedConsole(['relative-path', join(f.base, 'valid-app')]); await configureApp(app, { env, deferLocationCommit: true });
  assert.match(app.transcript, /\[错误\] 位置不可用：/u); assertPlain(app);
  const collision = join(f.base, 'collision'); await mkdir(collision); await writeFile(join(collision, 'keep.txt'), 'untouched');
  const clone = new ScriptedConsole(['../invalid', 'collision', 'new-target']);
  assert.equal((await chooseCloneTarget(clone, f.base, 'default')).directory, join(f.base, 'new-target'));
  assert.equal(clone.messages.filter(message => message.startsWith('[错误]')).length, 2); assertPlain(clone);
  assert.equal(await readFile(join(collision, 'keep.txt'), 'utf8'), 'untouched');
});

test('public-key validation errors do not display rejected file contents', async t => {
  const f = await fixture(t), file = join(f.base, 'invalid.pub'); await writeFile(file, 'synthetic-private-material-not-a-public-key');
  const ui = new ScriptedConsole(); await publicKey(ui, join(f.base, 'private')); await publicKey(ui, join(f.base, 'missing.pub')); await publicKey(ui, file);
  assert.equal(ui.messages.filter(message => message.startsWith('[错误]')).length, 3);
  assert.doesNotMatch(ui.transcript, /synthetic-private-material/u); assertPlain(ui);
});

test('local diagnostics warn about incomplete configuration while preserving credential URL redaction', async t => {
  const f = await fixture(t); await f.git.run(['remote', 'add', 'origin', 'https://synthetic-user:synthetic-secret@github.com/a/b?token=synthetic-secret']);
  const ui = new ScriptedConsole(); await diagnostics(ui, f.path);
  assert.match(ui.transcript, /\[警告\] 当前项目未绑定软件账号/u); assert.match(ui.transcript, /\[警告\] 未设置可解析上游/u);
  assert.match(ui.transcript, /凭据已隐藏/u); assert.doesNotMatch(ui.transcript, /synthetic-secret|\[成功\]/u); assertPlain(ui);
});

test('setup local errors are red and do not emit a success diagnostic for merely completing a step', async t => {
  const f = await fixture(t), ui = new ScriptedConsole(['2', '1', 'bad\x1bvalue', '0']);
  await setupWizard(ui, f.path);
  assert.match(ui.transcript, /\[错误\] 操作未完成：/u); assert.doesNotMatch(ui.transcript, /\[成功\]/u); assertPlain(ui);
});

test('password validation and mismatches are errors, and rejected secret buffers never reach diagnostics', async () => {
  const values = ['synthetic-short', 'synthetic-valid-password', 'synthetic-different-password', new Cancelled()];
  // A separate short value exercises length validation before the mismatch pair.
  values[0] = 'short'; const buffers = [], messages = [];
  const ui = new Console(undefined, message => messages.push(message), { secretInput: () => {
    const value = values.shift(); if (value instanceof Error) throw value;
    const buffer = Buffer.from(value); buffers.push(buffer); return buffer;
  } });
  await assert.rejects(readNewPassword(ui), Cancelled);
  assert.equal(messages.filter(message => message.startsWith('[错误]')).length, 2);
  assert.ok(buffers.every(buffer => buffer.every(byte => byte === 0)));
  assert.doesNotMatch(messages.join('\n'), /synthetic-valid-password|synthetic-different-password|\x1b/u);
});

test('each failed vault unlock is an error, including the final attempt, without logging entered secrets', async t => {
  const f = await fixture(t), directory = process.env.AUTOGIT_DATA_DIR, password = Buffer.from('synthetic-autogit-password');
  const created = await Vault.create(directory, password); password.fill(0); created.vault.close();
  const before = await readFile(join(directory, 'vault.json')), secrets = [], ui = new ScriptedConsole(['1', '1', '0'], { secretInput: () => { const value = Buffer.from('synthetic-wrong-password'); secrets.push(value); return value; } });
  const previous = currentSession(); setSession(undefined); t.after(() => setSession(previous));
  await assert.rejects(unlockSession(ui, directory), Cancelled);
  assert.equal(ui.messages.filter(message => message.startsWith('[错误] 密码未能解锁凭据库')).length, 3);
  assert.deepEqual(await readFile(join(directory, 'vault.json')), before);
  assert.ok(secrets.every(buffer => buffer.every(byte => byte === 0))); assert.doesNotMatch(ui.transcript, /synthetic-wrong-password/u); assertPlain(ui);
});

test('large-file exclusion remains a warning even when its ignore rule was successfully saved', async t => {
  const f = await fixture(t), file = join(f.path, 'oversized.bin'), handle = await open(file, 'w');
  try { await handle.truncate(DEFAULT_LARGE_FILE_BYTES + 1); } finally { await handle.close(); }
  const ui = new ScriptedConsole(), excluded = await autoIgnoreLargeFiles(ui, f.git, await f.git.changes());
  assert.equal(excluded.has('oversized.bin'), true);
  assert.match(ui.transcript, /\[警告\] 已自动忽略/u); assert.doesNotMatch(ui.transcript, /\[成功\]/u); assertPlain(ui);
});

test('verified local template creation emits success only after the file was written', async t => {
  const f = await fixture(t), ui = new ScriptedConsole();
  assert.equal(await writeTemplate(ui, f.path, 'README.md', 'synthetic template\n'), true);
  assert.equal(await readFile(join(f.path, 'README.md'), 'utf8'), 'synthetic template\n');
  assert.ok(ui.messages.includes('[成功] 已生成 README.md；没有暂存或提交。')); assertPlain(ui);
  const again = new ScriptedConsole(); assert.equal(await writeTemplate(again, f.path, 'README.md', 'synthetic template\n'), false);
  assert.doesNotMatch(again.transcript, /\[成功\]/u);
});
