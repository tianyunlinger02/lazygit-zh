import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Git } from '../dist/git.js';
import { HostStore } from '../dist/hosts.js';
import { diagnoseLfs, installLfs, parseLfsPattern, statusLfs, trackLfs, transferLfs } from '../dist/lfs.js';
import { Cancelled } from '../dist/ui.js';
import { fixture, ScriptedConsole } from './support.mjs';

function fakeLfs({ missing = false, env = 'Endpoint=https://objects.example.invalid/owner/repo.git/info/lfs (auth=none)\nEndpoint (archive)=https://archive.example.invalid/lfs (auth=none)\n', fail } = {}) {
  const calls = [];
  const runLfs = async (repo, args, options) => {
    const command = args[0]; calls.push({ repo, args: [...args], options: { ...options } });
    assert.ok(['version', 'env', 'install', 'track', 'untrack', 'status', 'ls-files', 'fetch', 'pull', 'push'].includes(command), `未声明 LFS 命令绝不回落真实执行：${args}`);
    if (fail === command) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('fixture failed') };
    if (command === 'version') return { status: missing ? 1 : 0, stdout: Buffer.from(missing ? '' : 'git-lfs/fixture\n'), stderr: Buffer.from(missing ? 'git: lfs is not a git command' : '') };
    let text = command === 'env' ? typeof env === 'function' ? env() : env : command === 'status' ? 'Objects to be pushed\n' : command === 'ls-files' ? 'fixture.psd\n' : command === 'track' && args.length === 1 ? 'Listing tracked patterns\n' : '';
    return { status: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0) };
  };
  return { calls, runLfs };
}
async function remotes(f) {
  await f.remote(); const archive = join(f.base, 'archive.git'); await mkdir(archive); await new Git(archive).run(['init', '--bare', '--initial-branch=main']); await f.git.run(['remote', 'add', 'archive', archive]); return archive;
}

test('LFS diagnostics explains optional dependency without invoking installer or real git-lfs', async t => {
  const f = await fixture(t, { committed: true }); const fake = fakeLfs({ missing: true }); const ui = new ScriptedConsole();
  assert.equal(await diagnoseLfs(ui, f.path, fake), false); assert.match(ui.transcript, /手工安装/); assert.match(ui.transcript, /不会自动下载/); assert.deepEqual(fake.calls.map(call => call.args), [['version']]);
  await assert.rejects(installLfs(new ScriptedConsole(), f.path, fake), /未找到可用/);
});
test('diagnostics shows local endpoint config and explicitly no migrations', async t => {
  const f = await fixture(t, { committed: true }); const fake = fakeLfs(); const ui = new ScriptedConsole();
  assert.equal(await diagnoseLfs(ui, f.path, fake), true); assert.match(ui.transcript, /git-lfs\/fixture/); assert.match(ui.transcript, /objects.example.invalid/); assert.match(ui.transcript, /不迁移历史/);
});
test('install is --local only, never force/global/system, and preserves the Git context', async t => {
  const f = await fixture(t, { committed: true }); const fake = fakeLfs(); const repo = f.git.configured({ 'user.name': 'Controlled fixture', 'core.sshCommand': '/fixture/ssh -i /fixture/key' });
  await installLfs(new ScriptedConsole([], { quick: true }), repo, fake);
  const call = fake.calls.find(call => call.args[0] === 'install'); assert.deepEqual(call.args, ['install', '--local']); assert.equal(call.repo.overrides['user.name'], 'Controlled fixture'); assert.equal(call.repo.overrides['core.sshCommand'], repo.overrides['core.sshCommand']); assert.equal(call.options.interactive, true);
});
test('existing incompatible hook fails without a force retry', async t => {
  const f = await fixture(t, { committed: true }); const fake = fakeLfs({ fail: 'install' });
  await assert.rejects(installLfs(new ScriptedConsole([], { quick: true }), f.path, fake), /fixture failed/); assert.equal(fake.calls.filter(call => call.args[0] === 'install').length, 1);
});
test('pattern parser preserves spaces, UTF-8, quotes, glob syntax, and rejects lossy bytes', () => {
  for (const pattern of ['*.psd', ' leading *.bin ', '-option-like', '中文/**/[ab].dat', 'line\nnext', 'a"b', '😀.bin']) assert.equal(parseLfsPattern(JSON.stringify(pattern)), pattern);
  assert.throws(() => parseLfsPattern('"\\udcff"'), /无法无损/); assert.throws(() => parseLfsPattern('"\\u0000"'), /NUL/); assert.throws(() => parseLfsPattern('"bad'), /JSON/); assert.throws(() => parseLfsPattern(''), /不能为空/);
});
test('track/untrack each pass one exact pattern argv with -- and no splitting or shell', async t => {
  const f = await fixture(t, { committed: true }); const fake = fakeLfs();
  await trackLfs(new ScriptedConsole(['" leading 中文 *.bin "'], { quick: true }), f.path, false, fake);
  await trackLfs(new ScriptedConsole(['"-leading\\n*.dat"'], { quick: true }), f.path, true, fake);
  assert.deepEqual(fake.calls.filter(call => ['track', 'untrack'].includes(call.args[0])).map(call => call.args), [['track', '--', ' leading 中文 *.bin '], ['untrack', '--', '-leading\n*.dat']]);
});
test('status remains local with no transfer commands', async t => {
  const f = await fixture(t, { committed: true }); const fake = fakeLfs(); const ui = new ScriptedConsole();
  await statusLfs(ui, f.path, fake); assert.deepEqual(fake.calls.map(call => call.args[0]), ['version', 'track', 'status', 'ls-files']); assert.match(ui.transcript, /fixture.psd/);
});
test('fetch preserves selected non-origin remote and previews its endpoint', async t => {
  const f = await fixture(t, { committed: true }); const archive = await remotes(f); const fake = fakeLfs(); const ui = new ScriptedConsole(['1', 'y']);
  await transferLfs(ui, f.path, 'fetch', fake); const call = fake.calls.find(call => call.args[0] === 'fetch'); assert.deepEqual(call.args, ['fetch', 'archive']); assert.match(ui.transcript, /实际远程：archive/); assert.match(ui.transcript, /archive.example.invalid/); assert.ok(ui.transcript.includes(archive));
});
test('quick transfer skips routine confirmation but displays endpoint and scope', async t => {
  const f = await fixture(t, { committed: true }); await remotes(f); const fake = fakeLfs(); const ui = new ScriptedConsole(['2'], { quick: true });
  await transferLfs(ui, f.path, 'pull', fake); assert.deepEqual(fake.calls.find(call => call.args[0] === 'pull').args, ['pull', 'origin']); assert.equal(ui.messages.some(message => message.includes('[y/N]')), false); assert.match(ui.transcript, /LFS endpoint/); assert.match(ui.transcript, /不执行 Git pull/);
});
test('declining transfer never runs a network operation', async t => {
  const f = await fixture(t, { committed: true }); await f.remote(); const fake = fakeLfs(); await transferLfs(new ScriptedConsole(['1', 'n']), f.path, 'fetch', fake); assert.equal(fake.calls.some(call => ['fetch', 'pull', 'push'].includes(call.args[0])), false);
});
test('push uploads only current HEAD objects on actual push URL without pushing Git refs', async t => {
  const f = await fixture(t, { committed: true }); await f.remote(); const destination = join(f.base, 'push-only.git'); await mkdir(destination); await new Git(destination).run(['init', '--bare']); await f.git.run(['remote', 'set-url', '--push', 'origin', destination]);
  const repo = f.git.configured({ 'user.name': 'Controlled fixture' }); const fake = fakeLfs(); const ui = new ScriptedConsole(['1'], { quick: true }); const head = await f.git.value('rev-parse', 'HEAD');
  await transferLfs(ui, repo, 'push', fake); const call = fake.calls.find(call => call.args[0] === 'push'); assert.deepEqual(call.args, ['push', 'origin', head]); assert.equal(call.repo.overrides['user.name'], 'Controlled fixture'); assert.ok(ui.transcript.includes(destination)); assert.match(ui.transcript, /不推送 Git 分支/);
});
test('remote URL or endpoint race prevents transfer', async t => {
  const f = await fixture(t, { committed: true }); await f.remote(); let endpoint = 'Endpoint=https://one.example.invalid/lfs\n'; const fake = fakeLfs({ env: () => endpoint }); const ui = new ScriptedConsole(['1']); ui.routineConfirm = async () => { endpoint = 'Endpoint=https://other.example.invalid/lfs\n'; return true; };
  await assert.rejects(transferLfs(ui, f.path, 'fetch', fake), /配置.*变化/); assert.equal(fake.calls.some(call => call.args[0] === 'fetch'), false);
});
test('endpoint overrides and .lfsconfig are displayed and race-checked', async t => {
  const f = await fixture(t, { committed: true }); await f.remote(); await f.git.run(['config', 'remote.origin.lfspushurl', 'https://push.example.invalid/lfs']); await writeFile(join(f.path, '.lfsconfig'), '[lfs]\n url = https://download.example.invalid/lfs\n');
  const fake = fakeLfs(); const ui = new ScriptedConsole(['1']); ui.routineConfirm = async () => { await writeFile(join(f.path, '.lfsconfig'), '[lfs]\n url = https://changed.example.invalid/lfs\n'); return true; };
  await assert.rejects(transferLfs(ui, f.path, 'push', fake), /配置.*变化/); assert.match(ui.transcript, /push.example.invalid/); assert.match(ui.transcript, /download.example.invalid/); assert.equal(fake.calls.some(call => call.args[0] === 'push'), false);
});
test('selected remote controls LFS defaults only for this command', async t => {
  const f = await fixture(t, { committed: true }); await remotes(f); await f.git.run(['config', 'branch.main.remote', 'origin']); const fake = fakeLfs();
  await transferLfs(new ScriptedConsole(['1'], { quick: true }), f.path, 'fetch', fake); const call = fake.calls.find(call => call.args[0] === 'fetch'); assert.equal(call.repo.overrides['remote.lfsdefault'], 'archive'); assert.equal(call.repo.overrides['branch.main.remote'], 'archive'); assert.equal(call.repo.overrides['lfs.remote.searchall'], 'false'); assert.equal(await f.git.config('branch.main.remote'), 'origin'); assert.equal(await f.git.config('remote.lfsdefault'), '');
});
test('an HTTPS URL rewritten to SSH still requires its own managed identity', async t => {
  const f = await fixture(t, { committed: true }); await f.git.run(['remote', 'add', 'origin', 'https://rewrite.example.invalid/team/repo.git']); await f.git.run(['config', 'url.ssh://git@ssh.example.invalid/.insteadOf', 'https://rewrite.example.invalid/']); const fake = fakeLfs();
  await assert.rejects(transferLfs(new ScriptedConsole(['1'], { quick: true }), f.path, 'fetch', fake), /没有选择软件账号/); assert.equal(fake.calls.some(call => call.args[0] === 'fetch'), false);
});
test('native LFS transfer preserves an SSH rewrite and rejects a confirmation-time rewrite race', async t => {
  const f = await fixture(t, { committed: true }); await f.git.run(['remote', 'add', 'origin', 'https://rewrite.example.invalid/team/repo.git']); await f.git.run(['config', 'url.ssh://git@one.example.invalid/.insteadOf', 'https://rewrite.example.invalid/']);
  await new HostStore().set(f.path, { mode: 'native-ssh', host: { provider: 'generic', host: 'one.example.invalid', apiHost: '', webBase: 'https://one.example.invalid', sshHost: 'one.example.invalid' } });
  const fake = fakeLfs(); const ui = new ScriptedConsole(['1']); ui.routineConfirm = async () => { await f.git.run(['config', '--unset', 'url.ssh://git@one.example.invalid/.insteadOf']); await f.git.run(['config', 'url.ssh://git@two.example.invalid/.insteadOf', 'https://rewrite.example.invalid/']); return true; };
  await assert.rejects(transferLfs(ui, f.path, 'fetch', fake), /配置.*变化/); assert.match(ui.transcript, /one.example.invalid/); assert.equal(fake.calls.some(call => call.args[0] === 'fetch'), false);
});
test('multiple target URLs and unsafe URL rewrite are rejected before fake transfer', async t => {
  const f = await fixture(t, { committed: true }); const remote = await f.remote(); const fake = fakeLfs(); await f.git.run(['remote', 'set-url', '--add', 'origin', remote]);
  await assert.rejects(transferLfs(new ScriptedConsole(['1'], { quick: true }), f.path, 'fetch', fake), /单一明确/);
  await f.git.run(['remote', 'remove', 'origin']); await f.git.run(['remote', 'add', 'safe', remote]); await f.git.run(['config', `url.ext::not-executed.insteadOf`, remote]);
  await assert.rejects(transferLfs(new ScriptedConsole(['1'], { quick: true }), f.path, 'fetch', fake), /不是支持/); assert.equal(fake.calls.some(call => call.args[0] === 'fetch'), false);
});
test('cancellation from native LFS is propagated without retry', async t => {
  const f = await fixture(t, { committed: true }); await f.remote(); const fake = fakeLfs(); const original = fake.runLfs; fake.runLfs = async (...args) => { if (args[1][0] === 'fetch') throw new Cancelled(); return original(...args); };
  await assert.rejects(transferLfs(new ScriptedConsole(['1'], { quick: true }), f.path, 'fetch', fake), Cancelled);
});
