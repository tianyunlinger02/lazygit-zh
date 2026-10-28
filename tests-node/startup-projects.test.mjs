import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chooseStartupProject, ProjectStore } from '../dist/projects.js';
import { Git, GitError, decodePath, encodePath } from '../dist/git.js';
import { Cancelled, EndOfInput } from '../dist/ui.js';
import { currentSession, setSession } from '../dist/session.js';
import { loadPreferences, savePreferences } from '../dist/preferences.js';
import { fixture, ScriptedConsole } from './support.mjs';

function menuCalls(t, ui, before) {
  const calls = [], original = ui.menu;
  t.mock.method(ui, 'menu', async function(title, options, back) {
    calls.push({ title, options: [...options], back });
    await before?.(title, options, calls.length);
    return original.call(this, title, options, back);
  });
  return calls;
}
function startupMenus(calls) { return calls.filter(call => call.title === '启动项目选择'); }
async function plainFolder(f, name = '普通 中文 文件夹') {
  const directory = join(f.base, name); await fs.mkdir(directory); return directory;
}
async function registry(f, records) {
  const store = new ProjectStore(); await fs.mkdir(store.directory, { recursive: true });
  await fs.writeFile(store.file, JSON.stringify({ schema_version: 1, projects: records.map((item, index) => ({
    project_id: String(index + 1).padStart(32, '0'), path: item.path, label: item.label,
    favorite: item.favorite ?? false, last_used: item.last_used ?? index + 1,
  })) }));
  return { store, before: await fs.readFile(store.file) };
}

// The current-folder shortcut is the only optional entry in these fixture defaults.
const OPEN = '2', CREATE = '3', DOWNLOAD = '4', RECENT = '5';

test('startup project chooser always prompts even with a valid remembered project', async t => {
  const f = await fixture(t), remembered = await plainFolder(f);
  for (const lastProject of [remembered, f.path]) {
    const ui = new ScriptedConsole(['0']), calls = menuCalls(t, ui);
    assert.equal(await chooseStartupProject(ui, f.path, lastProject), undefined);
    const menus = startupMenus(calls); assert.equal(menus.length, 1); assert.equal(menus[0].back, '退出');
    assert.match(menus[0].options[0], /继续上次项目/u);
    assert.equal(menus[0].options.length, lastProject === f.path ? 5 : 6);
    assert.match(ui.transcript, /非 Git 文件夹.*不会自动初始化 Git、提交或上传/u);
  }
  await assert.rejects(fs.stat(process.env.AUTOGIT_DATA_DIR), { code: 'ENOENT' });
});

test('startup remembered and cwd shortcuts are optional and deduplicated without persisting selection', async t => {
  const f = await fixture(t), remembered = await plainFolder(f);
  await savePreferences({ last_project: remembered });
  const settings = join(process.env.AUTOGIT_DATA_DIR, 'settings.json'), before = await fs.readFile(settings);
  const ui = new ScriptedConsole(['1']), calls = menuCalls(t, ui);
  assert.equal(await chooseStartupProject(ui, f.path, remembered), remembered);
  assert.equal(startupMenus(calls)[0].options.length, 6);
  const current = new ScriptedConsole(['2']); assert.equal(await chooseStartupProject(current, f.path, remembered), f.path);
  const missing = new ScriptedConsole(['0']), missingCalls = menuCalls(t, missing);
  assert.equal(await chooseStartupProject(missing, join(f.base, 'missing cwd'), ''), undefined);
  assert.equal(startupMenus(missingCalls)[0].options.length, 4);
  assert.doesNotMatch(missing.transcript, /继续上次项目/u);
  const cwd = new ScriptedConsole(['1']), cwdCalls = menuCalls(t, cwd);
  assert.equal(await chooseStartupProject(cwd, f.path, ''), f.path);
  assert.match(startupMenus(cwdCalls)[0].options[0], /使用当前目录/u);
  assert.equal(startupMenus(cwdCalls)[0].options.length, 5);
  assert.deepEqual(await fs.readFile(settings), before);
  assert.equal((await loadPreferences()).last_project, remembered);
});

test('startup canonical shortcut deduplication and changed symlink revalidation do not silently switch projects', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), one = await plainFolder(f, 'one'), two = await plainFolder(f, 'two'), link = join(f.base, 'remembered-link');
  await fs.symlink(one, link);
  const dedup = new ScriptedConsole(['0']), dedupCalls = menuCalls(t, dedup);
  assert.equal(await chooseStartupProject(dedup, one, link), undefined);
  assert.equal(startupMenus(dedupCalls)[0].options.length, 5);
  const ui = new ScriptedConsole(['1', '0']); let changed = false;
  const calls = menuCalls(t, ui, async title => {
    if (title === '启动项目选择' && !changed) { changed = true; await fs.unlink(link); await fs.symlink(two, link); }
  });
  assert.equal(await chooseStartupProject(ui, f.path, link), undefined);
  assert.equal(startupMenus(calls).length, 2); assert.match(ui.transcript, /路径在选择期间发生变化/u);
});

test('startup stale remembered paths are explained and shortcuts are revalidated after the menu', async t => {
  const f = await fixture(t), remembered = await plainFolder(f), stale = join(f.base, 'stale remembered');
  const ui = new ScriptedConsole(['1', '0']); let changed = false;
  const calls = menuCalls(t, ui, async title => {
    if (title === '启动项目选择' && !changed) { changed = true; await fs.rmdir(remembered); }
  });
  assert.equal(await chooseStartupProject(ui, f.path, remembered), undefined);
  assert.equal(startupMenus(calls).length, 2); assert.match(ui.transcript, /上次项目路径不可用/u);
  const staleUi = new ScriptedConsole(['0']), staleCalls = menuCalls(t, staleUi);
  assert.equal(await chooseStartupProject(staleUi, f.path, stale), undefined);
  assert.equal(startupMenus(staleCalls)[0].options.length, 5); assert.match(staleUi.transcript, /原记录保持不变/u);
});

test('startup opening plain local folders supports relative, home, Chinese and spaced paths without Git initialization', async t => {
  const f = await fixture(t), relative = await plainFolder(f), homeFolder = join(f.home, '主目录 中文 项目'); await fs.mkdir(homeFolder);
  for (const [answer, expected] of [[join('..', '普通 中文 文件夹'), relative], ['~/主目录 中文 项目', homeFolder]]) {
    const ui = new ScriptedConsole([OPEN, answer]); assert.equal(await chooseStartupProject(ui, f.path, ''), expected);
    await assert.rejects(fs.stat(join(expected, '.git')), { code: 'ENOENT' }); assert.deepEqual(ui.answers, []);
  }
  await assert.rejects(fs.stat(process.env.AUTOGIT_DATA_DIR), { code: 'ENOENT' });
});

test('startup invalid local paths and cancelled subflows return to the chooser instead of cwd', async t => {
  const f = await fixture(t), collision = join(f.base, 'ordinary-file'); await fs.writeFile(collision, 'keep original bytes\n');
  const ui = new ScriptedConsole([OPEN, join(f.base, 'missing'), OPEN, collision, OPEN, 'bad\0path', OPEN, ':q', CREATE, ':q', '0']);
  const calls = menuCalls(t, ui);
  assert.equal(await chooseStartupProject(ui, f.path, ''), undefined);
  assert.equal(startupMenus(calls).length, 6); assert.deepEqual(ui.answers, []);
  assert.match(ui.transcript, /不存在|不是文件夹/u); assert.match(ui.transcript, /已返回启动项目选择/u);
  assert.equal(await fs.readFile(collision, 'utf8'), 'keep original bytes\n');
});

test('startup creates a new nested local folder without .git, account writes or additional confirmations', async t => {
  const f = await fixture(t), directory = join(f.base, 'new parent', '新建 中文 项目');
  const ui = new ScriptedConsole([CREATE, directory], { quick: false });
  assert.equal(await chooseStartupProject(ui, f.path, ''), directory);
  assert.deepEqual(await fs.readdir(directory), []); assert.deepEqual(ui.answers, []);
  assert.doesNotMatch(ui.transcript, /\[y\/N\]|\[Y\/n\]/u);
  assert.match(ui.transcript, /已创建本地文件夹.*尚未初始化 Git、提交或上传/u);
  await assert.rejects(fs.stat(process.env.AUTOGIT_DATA_DIR), { code: 'ENOENT' });
});

test('startup create refuses file, populated-folder and empty-folder collisions without changing contents', async t => {
  const f = await fixture(t), file = join(f.base, 'existing-file'), populated = await plainFolder(f, 'populated'), empty = await plainFolder(f, 'empty');
  const bytes = Buffer.from([0, 1, 255, 0, 80]); await fs.writeFile(file, bytes); await fs.writeFile(join(populated, 'keep.bin'), bytes);
  const before = await fs.stat(empty);
  const ui = new ScriptedConsole([CREATE, file, CREATE, populated, CREATE, empty, CREATE, join(file, 'child'), '0']);
  assert.equal(await chooseStartupProject(ui, f.path, ''), undefined); assert.deepEqual(ui.answers, []);
  assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await fs.readFile(join(populated, 'keep.bin')), bytes);
  assert.deepEqual(await fs.readdir(populated), ['keep.bin']); assert.deepEqual(await fs.readdir(empty), []);
  assert.equal((await fs.stat(empty)).ino, before.ino); assert.match(ui.transcript, /已存在.*未覆盖或清空/u);
});

test('startup create rejects credential-directory nesting even when data does not exist and permits a sibling prefix', async t => {
  const f = await fixture(t), data = process.env.AUTOGIT_DATA_DIR, sibling = `${data}-projects`;
  const ui = new ScriptedConsole([CREATE, join(data, 'new-project'), CREATE, data, CREATE, sibling]);
  assert.equal(await chooseStartupProject(ui, f.path, ''), sibling);
  assert.match(ui.transcript, /不能在 AutoGit 凭据资料目录 data 内创建项目/u);
  await assert.rejects(fs.stat(data), { code: 'ENOENT' }); assert.deepEqual(await fs.readdir(sibling), []);
});

test('startup create resolves symlink parents before rejecting credential nesting and preserves existing data', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), data = process.env.AUTOGIT_DATA_DIR, link = join(f.base, 'data-alias');
  await fs.mkdir(data, { recursive: true }); await fs.writeFile(join(data, 'keep.txt'), 'synthetic credential fixture only'); await fs.symlink(data, link);
  const ui = new ScriptedConsole([CREATE, join(link, 'nested', 'project'), '0']);
  assert.equal(await chooseStartupProject(ui, f.path, ''), undefined);
  assert.match(ui.transcript, /不能在 AutoGit 凭据资料目录/u);
  assert.deepEqual(await fs.readdir(data), ['keep.txt']); assert.equal(await fs.readFile(join(data, 'keep.txt'), 'utf8'), 'synthetic credential fixture only');
});

test('startup local directory resolution preserves surrogateescaped bytes rather than replacement-character aliases', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), raw = Buffer.concat([Buffer.from(`${f.base}/bytes-`), Buffer.from([0xff])]), directory = decodePath(raw);
  await fs.mkdir(raw); const alias = directory.replace('\udcff', '�'); await fs.mkdir(alias); await fs.writeFile(join(alias, 'wrong-folder'), 'untouched');
  const open = new ScriptedConsole([OPEN, directory]); assert.equal(await chooseStartupProject(open, f.path, ''), directory);
  const target = join(directory, '新建 项目'), create = new ScriptedConsole([CREATE, target]);
  assert.equal(await chooseStartupProject(create, f.path, ''), target);
  assert.deepEqual(await fs.readdir(encodePath(target)), []); assert.deepEqual(await fs.readdir(alias), ['wrong-folder']);
});

test('startup recent projects keep favorite and recency ordering without touching any registry or preferences', async t => {
  const f = await fixture(t), favorite = await plainFolder(f, 'favorite'), latest = await plainFolder(f, 'latest'), older = await plainFolder(f, 'older');
  const { store, before } = await registry(f, [
    { path: older, label: 'older', last_used: 2 }, { path: latest, label: 'latest', last_used: 3 }, { path: favorite, label: 'favorite', favorite: true, last_used: 1 },
  ]);
  await savePreferences({ last_project: older }); const settings = join(store.directory, 'settings.json'), settingsBefore = await fs.readFile(settings);
  const ui = new ScriptedConsole([RECENT, '2']), calls = menuCalls(t, ui);
  assert.equal(await chooseStartupProject(ui, f.path, ''), latest);
  const list = calls.find(call => call.title === '选择最近 / 收藏项目');
  assert.match(list.options[0], /\[收藏\] favorite/u); assert.match(list.options[1], /latest/u); assert.match(list.options[2], /older/u);
  assert.deepEqual(await fs.readFile(store.file), before); assert.deepEqual(await fs.readFile(settings), settingsBefore);
  assert.equal((await loadPreferences()).last_project, older);
});

test('startup stale or removed recent directories are explained and retained without recency changes', async t => {
  const f = await fixture(t), removed = await plainFolder(f, 'removed'), missing = join(f.base, 'already missing');
  const { store, before } = await registry(f, [{ path: removed, label: 'removed', last_used: 2 }, { path: missing, label: 'missing', last_used: 1 }]);
  const ui = new ScriptedConsole([RECENT, '1', RECENT, '2', '0']); let changed = false;
  const calls = menuCalls(t, ui, async title => { if (title === '选择最近 / 收藏项目' && !changed) { changed = true; await fs.rmdir(removed); } });
  assert.equal(await chooseStartupProject(ui, f.path, ''), undefined); assert.equal(startupMenus(calls).length, 3);
  assert.match(ui.transcript, /项目记录路径不可用/u); assert.match(ui.transcript, /记录未移除或更新/u);
  assert.deepEqual(await fs.readFile(store.file), before);
});

test('startup empty, cancelled and malformed recent menus recover without overwriting records', async t => {
  const f = await fixture(t);
  const empty = new ScriptedConsole([RECENT, '0']); assert.equal(await chooseStartupProject(empty, f.path, ''), undefined); assert.match(empty.transcript, /尚无最近使用或收藏项目/u);
  const { store } = await registry(f, [{ path: f.path, label: 'fixture' }]);
  const cancel = new ScriptedConsole([RECENT, '0', '0']); assert.equal(await chooseStartupProject(cancel, f.path, ''), undefined);
  const raw = '{"schema_version":1,"projects":false}'; await fs.writeFile(store.file, raw);
  const malformed = new ScriptedConsole([RECENT, '0']); assert.equal(await chooseStartupProject(malformed, f.path, ''), undefined);
  assert.match(malformed.transcript, /projects.json.*未覆盖/u); assert.equal(await fs.readFile(store.file, 'utf8'), raw);
});

test('startup download uses the existing clone workflow with a real isolated local bare repository', async t => {
  const f = await fixture(t, { committed: true }), bare = await f.remote(); await f.git.run(['push', 'origin', 'main']);
  const source = 'https://fixture.example.invalid/team/project.git', target = join(f.base, '下载 中文 项目'), original = Git.prototype.run; let downloads = 0;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'clone') { downloads++; assert.deepEqual(args, ['clone', '--', source, target]); return original.call(this, ['clone', '--', bare, target], options); }
    return original.call(this, args, options);
  });
  const ui = new ScriptedConsole([DOWNLOAD, '1', source, f.base, '下载 中文 项目'], { quick: true });
  assert.equal(await chooseStartupProject(ui, f.path, ''), target); assert.equal(downloads, 1); assert.deepEqual(ui.answers, []);
  assert.equal(await new Git(target).value('rev-parse', 'HEAD'), await f.git.value('rev-parse', 'HEAD'));
  await assert.rejects(fs.stat(join(process.env.AUTOGIT_DATA_DIR, 'projects.json')), { code: 'ENOENT' });
});

test('startup cancelled, declined and undefined downloads return to the chooser without defaulting to cwd', async t => {
  const f = await fixture(t), source = 'https://fixture.example.invalid/team/project.git';
  for (const answers of [
    [DOWNLOAD, '0', '0'], [DOWNLOAD, '1', ':q', '0'],
    [DOWNLOAD, '1', source, f.base, 'declined-clone', 'n', '0'],
    [DOWNLOAD, '1', 'git@github.com:fixture/project.git', f.base, 'no-account-clone', '0'],
  ]) {
    const ui = new ScriptedConsole(answers), calls = menuCalls(t, ui);
    assert.equal(await chooseStartupProject(ui, f.path, ''), undefined); assert.deepEqual(ui.answers, []);
    assert.equal(startupMenus(calls).length, 2);
  }
  await assert.rejects(fs.stat(join(f.base, 'declined-clone')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(join(f.base, 'no-account-clone')), { code: 'ENOENT' });
});

test('startup failed downloads are not retried and partial clone data remains intact', async t => {
  const f = await fixture(t), source = 'https://fixture.example.invalid/team/project.git', target = join(f.base, 'partial-clone'), original = Git.prototype.run; let attempts = 0;
  t.mock.method(Git.prototype, 'run', async function(args, options) {
    if (args[0] === 'clone') { attempts++; await fs.mkdir(target); await fs.writeFile(join(target, 'partial.txt'), 'partial fixture bytes'); throw new GitError('synthetic offline clone failure'); }
    return original.call(this, args, options);
  });
  const ui = new ScriptedConsole([DOWNLOAD, '1', source, f.base, 'partial-clone', '0'], { quick: true });
  assert.equal(await chooseStartupProject(ui, f.path, ''), undefined); assert.equal(attempts, 1);
  assert.match(ui.transcript, /部分下载目录会保留，不自动重试或删除/u);
  assert.equal(await fs.readFile(join(target, 'partial.txt'), 'utf8'), 'partial fixture bytes');
});

test('startup download submenu exposes first-account setup and encrypted token enrollment without a project', async t => {
  const f = await fixture(t), sessionBefore = currentSession(), tokens = [], synthetic = 'synthetic_startup_token_only';
  const session = { closed: false, async storeToken(host, account, token) { tokens.push({ host, account, token: Buffer.from(token) }); } };
  setSession(session); t.after(() => { setSession(sessionBefore); for (const item of tokens) item.token.fill(0); });
  const secret = Buffer.from(synthetic), ui = new ScriptedConsole([DOWNLOAD, '2', '3', '0', '3', 'github.com', 'fixture-user', '0', '0'], { secretInput: async () => secret });
  const calls = menuCalls(t, ui);
  assert.equal(await chooseStartupProject(ui, f.path, ''), undefined); assert.deepEqual(ui.answers, []);
  const setup = calls.find(call => call.title === 'AutoGit 账号管理'); assert.match(setup.options[0], /新建账号/u); assert.match(setup.options[1], /导入已有私钥/u);
  assert.match(ui.transcript, /尚无账号/u); assert.equal(tokens.length, 1); assert.equal(tokens[0].host, 'github.com'); assert.equal(tokens[0].account, 'fixture-user');
  assert.equal(tokens[0].token.equals(Buffer.from(synthetic)), true); assert.ok(secret.every(byte => byte === 0)); assert.equal(ui.transcript.includes(synthetic), false);
});

test('startup cancellation from nested menus returns to chooser while EndOfInput propagates at every input layer', async t => {
  const f = await fixture(t);
  const cancelled = new ScriptedConsole(['0']); let first = true;
  t.mock.method(cancelled, 'menu', async function() { if (first) { first = false; throw new Cancelled(); } return 0; });
  assert.equal(await chooseStartupProject(cancelled, f.path, ''), undefined); assert.match(cancelled.transcript, /已返回启动项目选择/u);
  for (const layer of ['startup', 'folder', 'create', 'download', 'recent']) {
    if (layer === 'recent') await registry(f, [{ path: f.path, label: 'fixture' }]);
    const ui = new ScriptedConsole(layer === 'folder' ? [OPEN] : layer === 'create' ? [CREATE] : layer === 'download' ? [DOWNLOAD] : layer === 'recent' ? [RECENT] : []);
    if (['folder', 'create'].includes(layer)) t.mock.method(ui, 'ask', async () => { throw new EndOfInput(); });
    else {
      const original = ui.menu; t.mock.method(ui, 'menu', async function(title, options, back) {
        if ((layer === 'startup' && title === '启动项目选择') || (layer === 'download' && title === '下载项目与准备账号') || (layer === 'recent' && title === '选择最近 / 收藏项目')) throw new EndOfInput();
        return original.call(this, title, options, back);
      });
    }
    await assert.rejects(chooseStartupProject(ui, resolve(f.path), ''), EndOfInput);
  }
});
