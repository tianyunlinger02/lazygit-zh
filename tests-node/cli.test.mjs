import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, open, readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, delimiter } from 'node:path';
import { runProcess, which } from '../dist/process.js';
import { configureIdentity, diagnostics, publicKey, setupWizard } from '../dist/setup.js';
import { dispatch, main, runMenu, VERSION } from '../dist/cli.js';
import { fileURLToPath } from 'node:url';
import { fixture, ScriptedConsole } from './support.mjs';
import { ProfileStore } from '../dist/profiles.js';
import { DEFAULT_TRANSPORT, HostStore } from '../dist/hosts.js';
import { Git } from '../dist/git.js';
import { Vault } from '../dist/vault.js';
import { writePersonalCliDriver } from './personal-support.mjs';

const cli = fileURLToPath(new URL('./cli-driver.mjs', import.meta.url));
const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
async function launch(f, answers, args = [], env = process.env, driver = cli) {
  const result = await runProcess(process.execPath, [driver, '--path', f.path, ...args], { cwd: f.path, env, inputData: Buffer.from(answers.join('\n') + '\n') });
  return { ...result, text: result.stdout.toString('utf8') + result.stderr.toString('utf8') };
}
test('help/version and invalid flags do not create data or pointer', async t => {
  const f = await fixture(t);
  for (const [args, code, pattern] of [[['--help'], 0, /用法/], [['--version'], 0, new RegExp(`autogit ${packageVersion.replaceAll('.', '\\.')}\\b`, 'u')], [['--not-an-option'], 2, /参数错误/]]) {
    const result = await launch(f, [], args); assert.equal(result.status, code, result.text); assert.match(result.text, pattern);
  }
  await assert.rejects(stat(process.env.AUTOGIT_DATA_DIR), /ENOENT/); assert.deepEqual(await readdir(f.home), []);
});
test('version follows the package and main menu exposes exactly six task groups', async t => {
  const f = await fixture(t);
  assert.equal(VERSION, packageVersion);
  const ui = new ScriptedConsole(['0']);
  const menus = [], original = ui.menu;
  t.mock.method(ui, 'menu', async function(title, options, back) {
    menus.push({ title, options: [...options], back });
    return original.call(this, title, options, back);
  });
  await runMenu(ui, f.path);
  const labels = ['日常项目', '远程传输', 'GitHub 协作', '账号与资料', '项目管理', '查看与诊断'];
  assert.deepEqual(menus, [{ title: '你想做什么？', options: labels, back: '退出' }]);
  for (const [index, label] of labels.entries()) assert.ok(ui.transcript.includes(`  ${index + 1}. ${label}`), label);
  assert.deepEqual(ui.answers, []);
});

test('legacy workflow CLI (code-only unlock stub) accepts multiple piped menu lines, remembers mode and exits on EOF', async t => {
  const f = await fixture(t);
  const first = await launch(f, ['4', '4', '2', '6', '1', '1', '0']);
  assert.equal(first.status, 0, first.text); assert.match(first.text, /已启用详细确认模式/); assert.match(first.text, /工作区干净/); assert.match(first.text, /已退出/);
  const preferences = JSON.parse(await readFile(join(process.env.AUTOGIT_DATA_DIR, 'settings.json'), 'utf8'));
  assert.equal(preferences.interaction_mode, 'confirm'); assert.equal(preferences.last_project, f.path);
  const again = await launch(f, []); assert.equal(again.status, 0, again.text); assert.match(again.text, /详细模式/); assert.doesNotMatch(again.text, /保管好你的 AutoGit 文件夹/);
});
test('legacy workflow CLI (code-only unlock stub) --app-dir outranks AUTOGIT_DATA_DIR without locator', async t => {
  const f = await fixture(t); const root = join(f.base, '独立 AutoGit');
  const result = await launch(f, ['0'], ['--app-dir', root]); assert.equal(result.status, 0, result.text);
  assert.match(result.text, /独立 AutoGit/); assert.equal((await stat(join(root, 'data', 'settings.json'))).isFile(), true);
  await assert.rejects(stat(process.env.AUTOGIT_DATA_DIR), /ENOENT/); assert.deepEqual(await readdir(f.home), []);
});
test('legacy workflow driver configures a path-only first-run locator before its unlock stub and reuses it from another cwd', async t => {
  const f = await fixture(t); const env = { ...process.env }; delete env.AUTOGIT_DATA_DIR;
  const root = join(f.base, '资料 根'); const first = await launch(f, [root, '0'], [], env);
  assert.equal(first.status, 0, first.text);
  const pointer = process.platform === 'win32' ? join(env.APPDATA, 'AutoGit/location.json') : join(env.XDG_CONFIG_HOME, 'autogit/location.json');
  assert.deepEqual(JSON.parse(await readFile(pointer)), { schema_version: 1, appRoot: root });
  const password = Buffer.from('synthetic-locator-password');
  const { vault } = await Vault.create(join(root, 'data'), password); password.fill(0); vault.close();
  const second = await runProcess(process.execPath, [cli], { cwd: f.base, env, inputData: Buffer.from('1\n0\n') });
  assert.equal(second.status, 0, second.stderr.toString()); assert.match(second.stdout.toString(), /启动项目选择/u); assert.match(second.stdout.toString(), /当前目录：.*中文 项目/); assert.ok(!second.stdout.toString().includes('软件根目录 ['));
});
test('legacy workflow CLI (code-only unlock stub) cancels file selection without staging or committing', async t => {
  const f = await fixture(t); await f.write(); const result = await launch(f, ['1', '5', ':q', '0']); assert.equal(result.status, 0, result.text); assert.match(result.text, /已返回菜单/); assert.equal(await f.git.hasCommits(), false); assert.equal((await f.git.changes())[0].staged, false);
});
test('legacy workflow CLI (code-only unlock stub) generates a managed remembered account, binds and commits with no Python', { skip: !which('ssh') || !which('ssh-keygen') }, async t => {
  const f = await fixture(t); await f.write();
  const result = await launch(f, ['4', '1', '1', '2', 'y', '测试软件账号', 'Managed User', 'managed@example.invalid', 'fixture-login', '4', '1', '0', '1', '5', 'a', 'Node CLI commit', '0']);
  assert.equal(result.status, 0, result.text); assert.match(result.text, /已保存账号/); assert.match(result.text, /ssh-ed25519 /); assert.match(result.text, /https:\/\/github.com\/settings\/keys/);
  assert.equal(await f.git.value('log', '-1', '--format=%an <%ae>'), 'Managed User <managed@example.invalid>');
  assert.equal(await f.git.config('user.name'), '测试用户');
  const ids = await readdir(join(process.env.AUTOGIT_DATA_DIR, 'profiles')); assert.equal(ids.length, 1);
  const profile = JSON.parse(await readFile(join(process.env.AUTOGIT_DATA_DIR, 'profiles', ids[0], 'profile.json'))); assert.equal(profile.schema_version, 2); assert.equal(profile.remember_auth, true); assert.ok(!resolve(profile.private_key).startsWith(process.env.AUTOGIT_DATA_DIR));
  const key = join(process.env.AUTOGIT_DATA_DIR, profile.private_key); const derived = await runProcess('ssh-keygen', ['-y', '-P', '', '-f', key], { cwd: f.base, inputData: Buffer.alloc(0) }); assert.equal(derived.status, 0);
  await assert.rejects(stat(join(f.home, '.ssh')), /ENOENT/);
});
test('legacy workflow CLI (code-only unlock stub) pushes local bare repo and refuses unfinished local operations without changing conflict state', async t => {
  const f = await fixture(t); await f.write('shared.txt', 'base\n'); await f.commit(); const bare = await f.remote();
  const pushed = await launch(f, ['1', '3', '1', '', '0']); assert.equal(pushed.status, 0, pushed.text); assert.match(pushed.text, /推送成功/u);
  const remoteHead = await new Git(bare).value('rev-parse', 'main');
  // Native Git prepares an unfinished operation; AutoGit must only detect and refuse it.
  await f.git.run(['switch', '-c', 'topic']); await f.write('shared.txt', 'topic\n'); await f.commit('topic');
  await f.git.run(['switch', 'main']); await f.write('shared.txt', 'main\n'); await f.commit('main');
  assert.notEqual((await f.git.run(['merge', 'topic'], { check: false })).status, 0);
  assert.equal(await f.git.operation(), 'MERGE_HEAD');
  const head = await f.git.value('rev-parse', 'HEAD'), index = (await f.git.run(['ls-files', '--stage', '-z'])).stdout;
  const bytes = await readFile(join(f.path, 'shared.txt'));
  const result = await launch(f, ['1', '5', '1', '4', '0']);
  assert.equal(result.status, 0, result.text);
  assert.match(result.text, /外部 Git/u); assert.match(result.text, /操作未完成/u);
  assert.doesNotMatch(result.text, /冲突中心|操作中心|合并提交已创建/u);
  assert.equal(await f.git.operation(), 'MERGE_HEAD'); assert.equal(await f.git.value('rev-parse', 'HEAD'), head);
  assert.deepEqual((await f.git.run(['ls-files', '--stage', '-z'])).stdout, index);
  assert.deepEqual(await readFile(join(f.path, 'shared.txt')), bytes);
  assert.equal(await new Git(bare).value('rev-parse', 'main'), remoteHead);
});

test('legacy workflow CLI (code-only unlock stub) HTTPS setup does not ask irrelevant SSH fields in quick mode', async t => {
  const f = await fixture(t);
  const result = await launch(f, ['4', '3', '1', '1', '3', '0', '0']);
  assert.equal(result.status, 0, result.text);
  assert.match(result.text, /已保存本项目配置/u);
  assert.doesNotMatch(result.text, /SSH endpoint 主机|SSH 端口|SSH 用户|已有 SSH Host alias|操作未完成|请输入 0 到/u);
  const hosts = JSON.parse(await readFile(join(process.env.AUTOGIT_DATA_DIR, 'hosts.json'), 'utf8'));
  assert.equal(hosts.projects[f.path].mode, 'https');
});

async function largeFile(f, name = 'oversized.bin') {
  const file = join(f.path, name), handle = await open(file, 'w');
  try { await handle.truncate(50 * 1024 * 1024 + 1); } finally { await handle.close(); }
  return file;
}

test('legacy workflow CLI (code-only unlock stub) automatically ignores oversized new files before local commit with no LFS or extra confirmation', async t => {
  const f = await fixture(t); await f.write('small.txt', 'small file\n'); const large = await largeFile(f);
  const result = await launch(f, ['1', '5', 'a', 'small files only', '0']);
  assert.equal(result.status, 0, result.text); assert.match(result.text, /已自动忽略.*oversized\.bin/u); assert.match(result.text, /已保存到本地/u);
  assert.doesNotMatch(result.text, /\[y\/N\]|操作未完成|请输入 0 到|git-lfs|LFS 工具/u);
  assert.equal((await lstat(large)).size, 50 * 1024 * 1024 + 1);
  assert.equal(await f.git.value('ls-tree', '-r', '--name-only', 'HEAD'), '.gitignore\nsmall.txt');
  assert.equal(await f.git.value('show', 'HEAD:.gitignore'), '/oversized.bin');
  assert.equal((await f.git.run(['--no-literal-pathspecs', 'check-ignore', '-z', '--stdin'], { inputData: Buffer.from('oversized.bin\0') })).stdout.toString(), 'oversized.bin\0');
  await assert.rejects(stat(join(f.path, '.gitattributes')), { code: 'ENOENT' });
  const before = await readFile(join(f.path, '.gitignore'));
  const second = await launch(f, ['1', '5', '0']); assert.equal(second.status, 0, second.text); assert.match(second.text, /工作区干净/u);
  assert.deepEqual(await readFile(join(f.path, '.gitignore')), before); assert.equal(await f.git.value('rev-list', '--count', 'HEAD'), '1');
});

test('legacy workflow CLI (code-only unlock stub) save and push excludes oversized new files from a real local bare remote', async t => {
  const f = await fixture(t, { committed: true }); const bare = await f.remote(); await f.write('small.txt', 'small update\n'); await largeFile(f);
  const result = await launch(f, ['1', '3', 'a', 'skip oversized asset', '1', '', '0']);
  assert.equal(result.status, 0, result.text); assert.match(result.text, /已自动忽略/u); assert.match(result.text, /推送成功/u);
  assert.doesNotMatch(result.text, /\[y\/N\]|操作未完成|请输入 0 到|git-lfs|LFS 工具/u);
  const remote = new Git(bare);
  assert.equal(await remote.value('rev-parse', 'main'), await f.git.value('rev-parse', 'HEAD'));
  assert.equal(await remote.value('ls-tree', '-r', '--name-only', 'main'), '.gitignore\nhello.txt\nsmall.txt');
  assert.equal((await lstat(join(f.path, 'oversized.bin'))).size, 50 * 1024 * 1024 + 1);
});

test('legacy workflow CLI (code-only unlock stub) auto ignore preserves partial staging of gitignore and only commits its existing index version', async t => {
  const f = await fixture(t, { committed: true }); await f.write('.gitignore', '# index version\n'); await f.git.stagePaths(['.gitignore']);
  await f.write('.gitignore', '# index version\n# worktree only\n'); await largeFile(f); await f.write('small.txt', 'small\n');
  const result = await launch(f, ['1', '5', 'a', 'preserve ignore index', '0']);
  assert.equal(result.status, 0, result.text); assert.match(result.text, /保留已暂存版本/u); assert.match(result.text, /已保存到本地/u);
  assert.equal((await f.git.run(['show', 'HEAD:.gitignore'])).stdout.toString(), '# index version\n');
  assert.equal(await readFile(join(f.path, '.gitignore'), 'utf8'), '# index version\n# worktree only\n/oversized.bin\n');
  assert.equal(await f.git.value('ls-tree', '-r', '--name-only', 'HEAD'), '.gitignore\nhello.txt\nsmall.txt');
  assert.doesNotMatch(result.text, /\[y\/N\]|操作未完成|请输入 0 到/u);
});

test('legacy workflow CLI (code-only unlock stub) daily upload-only action does not save dirty worktree files', async t => {
  const f = await fixture(t, { committed: true });
  const bare = await f.remote();
  const head = await f.git.value('rev-parse', 'HEAD');
  await f.write('not-saved.txt', 'must remain local\n');
  const result = await launch(f, ['1', '6', '1', '', '0']);
  assert.equal(result.status, 0, result.text);
  assert.match(result.text, /推送成功/u);
  assert.equal(await new Git(bare).value('rev-parse', 'refs/heads/main'), head);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), head);
  assert.deepEqual((await f.git.changes()).map(change => change.path), ['not-saved.txt']);
});

test('six-group submenus retain daily, remote, account, project and read-only actions without retired local tools', async t => {
  const f = await fixture(t, { committed: true });
  await f.write('hello.txt', 'staged work\n'); await f.git.stagePaths(['hello.txt']);
  await f.write('hello.txt', 'staged work plus local edits\n'); await f.write('draft.txt', 'keep draft\n');
  const head = await f.git.value('rev-parse', 'HEAD'), index = (await f.git.run(['diff', '--cached', '--binary'])).stdout;
  const ui = new ScriptedConsole(['1', '0', '2', '0', '4', '0', '5', '3', '0', '6', '1', '5', '0', '0']);
  const menus = [], original = ui.menu;
  t.mock.method(ui, 'menu', async function(title, options, back) {
    menus.push({ title, options: [...options] });
    return original.call(this, title, options, back);
  });
  await runMenu(ui, f.path);
  const expectMenu = (title, options) => {
    const found = menus.find(menu => menu.title === title); assert.ok(found, title);
    assert.equal(found.options.length, options.length, title);
    for (const [index, pattern] of options.entries()) assert.match(found.options[index], pattern, title);
  };
  expectMenu('日常项目', [/^下载已有项目/u, /^上传本地项目/u, /^保存修改并上传/u, /^获取远程最新代码/u, /^仅保存到本地/u, /^仅上传已有提交/u]);
  expectMenu('远程与上传工具', [/^查看\/管理远程地址/u, /^添加远程/u, /^仅上传已有提交/u, /^force-with-lease/u, /^删除远程分支/u, /^远程改名/u, /^移除远程/u, /^单独 fetch/u, /^设置当前分支上游/u]);
  expectMenu('账号与资料', [/^账号与密钥/u, /^HTTPS \/ GitHub 凭据/u, /^项目主机/u, /^使用设置/u, /^账号资料备份/u, /^首次配置/u]);
  expectMenu('项目管理', [/^切换当前项目目录/u, /^项目收藏与最近使用/u, /^\.gitignore \/ README \/ 许可证/u]);
  expectMenu('查看与诊断', [/^查看状态、差异和只读历史/u, /^检查配置和诊断/u]);
  expectMenu('查看项目', [/^文件状态/u, /^未暂存差异/u, /^已暂存差异/u, /^最近 20 条提交/u, /^只读历史/u]);
  expectMenu('只读历史', [/^历史分页 \/ 搜索 \/ 提交详情/u, /^本地历史图/u]);
  expectMenu('项目模板（不隐式提交）', [/^添加内置 \.gitignore 模板/u, /^追加自定义忽略规则/u, /^停止跟踪已忽略文件/u, /^生成 README\.md/u, /^生成真实开源 LICENSE/u]);
  const retiredActions = /^(?:分支与合并|临时收起|撤销、还原和清理|进行中的操作|历史与恢复|worktree 多工作区|子模块$|Git LFS$|reflog|创建恢复分支)/u;
  for (const menu of menus) for (const option of menu.options) assert.doesNotMatch(option, retiredActions, menu.title);
  assert.deepEqual(ui.answers, []); assert.doesNotMatch(ui.transcript, /请输入 0 到|操作未完成/u);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), head);
  assert.deepEqual((await f.git.run(['diff', '--cached', '--binary'])).stdout, index);
  assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'staged work plus local edits\n');
  assert.equal(await readFile(join(f.path, 'draft.txt'), 'utf8'), 'keep draft\n');
});

test('legacy workflow CLI (code-only unlock stub) remote group performs real lease and unconditional force against a local bare remote', async t => {
  const f = await fixture(t, { committed: true });
  const bare = await f.remote();
  await f.git.run(['push', 'origin', 'main']);
  const peerPath = join(f.base, 'cli-peer');
  await new Git(f.base).run(['clone', '--', bare, peerPath]);
  const peer = new Git(peerPath);
  await peer.run(['config', 'user.name', 'CLI Peer']);
  await peer.run(['config', 'user.email', 'cli-peer@example.invalid']);
  await f.write('local-cli.txt', 'local branch\n');
  await f.commit('local CLI divergence');
  await writeFile(join(peerPath, 'peer-cli.txt'), 'peer branch\n');
  await peer.stagePaths(['peer-cli.txt']);
  await peer.run(['commit', '-m', 'peer CLI divergence']);
  const peerHead = await peer.value('rev-parse', 'HEAD');
  await peer.run(['push', 'origin', 'main']);
  const localHead = await f.git.value('rev-parse', 'HEAD');
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
  const server = new Git(bare);
  const leased = await launch(f, ['2', '4', '1', 'main', '1', 'y', '0'], [], env);
  assert.equal(leased.status, 0, leased.text);
  assert.match(leased.text, /强推成功/u);
  assert.equal(await server.value('rev-parse', 'refs/heads/main'), localHead);
  await server.run(['update-ref', 'refs/heads/main', peerHead]);
  const forced = await launch(f, ['2', '4', '1', 'main', '2', 'y', '0'], [], env);
  assert.equal(forced.status, 0, forced.text);
  assert.match(forced.text, /强推成功/u);
  assert.equal(await server.value('rev-parse', 'refs/heads/main'), localHead);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), localHead);
  for (const result of [leased, forced]) {
    assert.match(result.text, new RegExp(peerHead));
    assert.match(result.text, new RegExp(localHead));
    assert.doesNotMatch(result.text, /--follow-tags/u);
  }
});

test('advanced external identity decline is inert; confirmed writes are scoped and deduplicated', async t => {
  const f = await fixture(t); assert.equal(await configureIdentity(new ScriptedConsole(['1', 'Changed', 'changed@example.invalid', 'n']), f.path), false); assert.equal(await f.git.config('user.name'), '测试用户');
  assert.equal(await configureIdentity(new ScriptedConsole(['1', 'Changed', 'changed@example.invalid', 'y']), f.path), true); assert.equal(await f.git.config('user.name'), 'Changed');
  assert.equal(await configureIdentity(new ScriptedConsole(['1', '', '']), f.path), true);
  assert.equal((await f.git.value('config', '--get-all', 'user.name')).split('\n').length, 1);
});
test('local diagnostics redacts external credentials and never authenticates', async t => {
  const f = await fixture(t); await f.git.run(['remote', 'add', 'origin', 'https://user:secret@github.com/a/b?token=secret']); const ui = new ScriptedConsole(); await diagnostics(ui, f.path); assert.match(ui.transcript, /本地诊断/); assert.doesNotMatch(ui.transcript, /secret/); assert.match(ui.transcript, /凭据已隐藏/);
});
test('public key helper refuses private file, malformed contents and oversized .pub', async t => {
  const f = await fixture(t); const ui = new ScriptedConsole(); await publicKey(ui, join(f.base, 'private')); const file = join(f.base, 'bad.pub'); await writeFile(file, 'PRIVATE SECRET'); await publicKey(ui, file); await writeFile(file, 'X'.repeat(65537)); await publicKey(ui, file); assert.doesNotMatch(ui.transcript, /PRIVATE SECRET/);
});
test('advanced setup menu and main dispatch allow returning without changes', async t => {
  const f = await fixture(t); await setupWizard(new ScriptedConsole(['0']), f.path); assert.equal(await dispatch(new ScriptedConsole(['6', '0']), f.path, 4), f.path); assert.equal(await main(['--version'], new ScriptedConsole()), 0);
});

async function creationCliFixture(t) {
  const f = await fixture(t);
  // The code-only legacy unlock driver intentionally exercises explicit SSH, not HTTPS security.
  await new HostStore().set(f.path, DEFAULT_TRANSPORT);
  const realGit = which('git');
  assert.ok(realGit);
  const tools = join(f.base, 'offline git tools'); await mkdir(tools);
  await writeFile(join(tools, 'package.json'), '{"type":"commonjs"}\n');
  const nativeLog = join(f.base, 'native-api-stub-calls.jsonl');
  const ghLog = join(f.base, 'forbidden-gh-calls.jsonl');
  const driver = join(f.base, 'native-personal-cli-driver.mjs');
  await writePersonalCliDriver(driver);
  const pushLog = join(f.base, 'push-calls.jsonl');
  const bare = join(f.base, 'creation-target.git'); await mkdir(bare);
  await new Git(bare).run(['init', '--bare', '--initial-branch=main']);
  const store = new ProfileStore();
  const profile = await store.create(new ScriptedConsole(['y']), 'CLI fixture', 'Managed CLI', 'cli@example.invalid', 'fixture-login', { remember_auth: true });
  assert.ok(profile); await store.bind(f.path, profile.profile_id);
  // This is a failing sentinel, not a gh creation implementation: every invocation is a bug.
  await writeFile(join(tools, 'gh'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.AUTOGIT_TEST_GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
throw new Error('Personal creation must not invoke gh');
`, { mode: 0o700 });
  await writeFile(join(tools, 'git'), `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.some(a => ['fetch', 'pull', 'clone'].includes(a)) || args.includes('ls-remote') && !args.includes('--get-url')) {
  throw new Error('Network Git operation blocked by CLI fixture');
}
if (args.includes('push')) {
  if (args.at(-2) !== 'origin' || !/^[a-f0-9]{40,64}:refs\\/heads\\/main$/u.test(args.at(-1))) throw new Error('Unexpected push target');
  if (args.some(arg => /^(?:--force|--mirror|\\+)/u.test(arg)) || !args.includes('--no-follow-tags') || args.includes('--set-upstream')) throw new Error('Unexpected force, tag or upstream push option');
  fs.appendFileSync(process.env.AUTOGIT_TEST_PUSH_LOG, JSON.stringify(args) + '\\n');
  args.unshift('-c', 'remote.origin.pushurl=' + process.env.AUTOGIT_TEST_BARE);
}
const result = spawnSync(process.env.AUTOGIT_TEST_REAL_GIT, args, {stdio: 'inherit', env: process.env});
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  return { ...f, driver, nativeLog, ghLog, pushLog, bare, env: { ...process.env, PATH: `${tools}${delimiter}${process.env.PATH ?? ''}`, AUTOGIT_TEST_NATIVE_LOG: nativeLog, AUTOGIT_TEST_GH_LOG: ghLog, AUTOGIT_TEST_PUSH_LOG: pushLog, AUTOGIT_TEST_CREATED: join(f.base, 'created.txt'), AUTOGIT_TEST_REAL_GIT: realGit, AUTOGIT_TEST_BARE: bare } };
}

for (const [visibility, choice] of [['private', '1'], ['public', '2']]) {
  test(`legacy workflow CLI (code-only unlock/native API stubs) creates a ${visibility} fixture repository, links and uploads offline`, { skip: process.platform === 'win32' || !which('ssh') || !which('ssh-keygen') }, async t => {
    const f = await creationCliFixture(t); await f.write();
    const repo = `cli-${visibility}`;
    const env = { ...f.env, AUTOGIT_TEST_REPO: repo, AUTOGIT_TEST_VISIBILITY: visibility };
    const result = await launch(f, ['1', '2', '', '1', repo, choice, 'y', 'a', `create ${visibility}`, '', '0'], [], env, f.driver);
    assert.equal(result.status, 0, result.text);
    assert.match(result.text, /推送成功/u);
    assert.match(result.text, /已退出/u);
    assert.equal(await f.git.config('remote.origin.url'), `git@github.com:fixture-login/${repo}.git`);
    assert.equal(await f.git.config('branch.main.remote'), 'origin');
    assert.equal(await f.git.value('rev-parse', 'HEAD'), await new Git(f.bare).value('rev-parse', 'main'));
    assert.equal(await f.git.value('log', '-1', '--format=%an <%ae>'), 'Managed CLI <cli@example.invalid>');
    assert.equal(await f.git.config('user.name'), '测试用户');
    const calls = (await readFile(f.nativeLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls, [
      { method: 'authenticate', account: 'fixture-login' },
      { method: 'createRepository', owner: 'fixture-login', name: repo, visibility },
    ]);
    assert.equal(await readFile(env.AUTOGIT_TEST_CREATED, 'utf8'), `fixture-login/${repo}`);
    await assert.rejects(stat(f.ghLog), { code: 'ENOENT' });
    assert.doesNotMatch(result.text, /新地址的本地远程别名|给这个远程起一个名字|操作未完成|请输入 0 到/u);
    assert.equal((await readFile(f.pushLog, 'utf8')).trim().split('\n').length, 1);
    if (process.env.AUTOGIT_VERIFICATION_DIR) {
      await writeFile(join(process.env.AUTOGIT_VERIFICATION_DIR, `cli-creation-${visibility}-${packageVersion}.txt`), `CODE-ONLY OFFLINE FIXTURE: unlock and native API methods are stubbed; Git uploads to a real local bare target. No HTTP/OAuth/token/session or real GitHub/SSH interoperability evidence. No gh commands were invoked.\n${result.text}\nNative API stub calls:\n${JSON.stringify(calls, null, 2)}\n`);
    }
  });
}

test('legacy workflow CLI (code-only unlock/native API stubs) declining final public creation makes no repository and no push', { skip: process.platform === 'win32' || !which('ssh') || !which('ssh-keygen') }, async t => {
  const f = await creationCliFixture(t);
  const env = { ...f.env, AUTOGIT_TEST_REPO: 'cancelled-public', AUTOGIT_TEST_VISIBILITY: 'public' };
  const result = await launch(f, ['1', '2', '', '1', 'cancelled-public', '2', 'n', '0'], [], env, f.driver);
  assert.equal(result.status, 0, result.text); assert.match(result.text, /已退出/u);
  assert.deepEqual(await f.git.remotes(), []);
  const calls = (await readFile(f.nativeLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls, [{ method: 'authenticate', account: 'fixture-login' }]);
  await assert.rejects(stat(f.ghLog), { code: 'ENOENT' });
  await assert.rejects(stat(env.AUTOGIT_TEST_CREATED), {code: 'ENOENT'});
  await assert.rejects(stat(f.pushLog), {code: 'ENOENT'});
});
