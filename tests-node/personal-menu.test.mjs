import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { PersonalGithubError } from '../dist/github-personal.js';
import { githubAction, githubMenu } from '../dist/github-repositories.js';
import { Profile, ProfileStore, resolveBinding } from '../dist/profiles.js';
import { remotesMenu } from '../dist/remotes.js';
import { Cancelled } from '../dist/ui.js';
import { mockPersonalGithub } from './personal-support.mjs';
import { fixture, ScriptedConsole } from './support.mjs';

test('GitHub menu can return before any account, gh or network authentication', async t => {
  const f = await fixture(t), api = mockPersonalGithub(t);
  const ui = new ScriptedConsole(['0']);
  assert.equal(await githubMenu(ui, f.path), undefined);
  assert.equal(api.authentications, 0);
  assert.deepEqual(ui.answers, []);
});

test('GitHub collaboration personal creation is native and creates only without binding or a remote', async t => {
  const f = await fixture(t, { committed: true }), api = mockPersonalGithub(t), store = new ProfileStore();
  const id = 'b'.repeat(32), folder = join(store.profilesDir, id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const privateKey = join(folder, 'id_ed25519');
  await writeFile(privateKey, 'OFFLINE TEST FIXTURE; NOT A PRIVATE KEY\n', { mode: 0o600 });
  await writeFile(`${privateKey}.pub`, 'OFFLINE TEST FIXTURE; NOT A PUBLIC KEY\n', { mode: 0o600 });
  const profile = new Profile({ profile_id: id, label: 'Offline Profile', name: 'Fixture', email: 'fixture@example.invalid', github_login: 'fixture-login', private_key: privateKey, public_key: `${privateKey}.pub` });
  await writeFile(join(folder, 'profile.json'), JSON.stringify(store.encodeProfile(profile)), { mode: 0o600 });
  const head = await f.git.value('rev-parse', 'HEAD');
  const ui = new ScriptedConsole(['4', '1', '1', 'native-only', '1', 'y', '0'], { quick: true });
  assert.equal(await githubMenu(ui, f.path), undefined);
  assert.deepEqual(api.creates, [{ owner: 'fixture-login', name: 'native-only', visibility: 'private' }]);
  assert.deepEqual(await f.git.remotes(), []);
  assert.equal(await resolveBinding(f.path), undefined);
  assert.equal(await f.git.value('rev-parse', 'HEAD'), head);
  assert.deepEqual(await f.git.changes(), []);
  assert.match(ui.transcript, /未关联本地项目，也未上传代码/u);
  assert.equal(ui.transcript.split('本次操作结果').length - 1, 1);
  const result = ui.transcript.split('本次操作结果')[1];
  assert.match(result, /仓库创建：已完成/u);
  for (const label of ['本地关联', '本地提交', '远端上传', '默认同步目标']) assert.match(result, new RegExp(`${label}：无需执行`, 'u'));
  assert.deepEqual(ui.answers, []);
});

test('empty remote management offers association instead of editing nonexistent addresses', async t => {
  const f = await fixture(t);
  const ui = new ScriptedConsole(['1', '0']);
  await remotesMenu(ui, f.path);
  assert.match(ui.transcript, /\[警告\].*尚未关联/u);
  assert.match(ui.transcript, /选择关联方式/u);
  assert.doesNotMatch(ui.transcript, /替换 fetch\/push 地址列表|当前项目还没有远程仓库/u);
  assert.deepEqual(await f.git.remotes(), []);
  assert.deepEqual(ui.answers, []);
});

test('GitHub local boundary distinguishes ordinary cancellation, failed writes and unknown outcomes', async () => {
  const plain = new ScriptedConsole();
  await githubAction(plain, async () => { throw new Cancelled(); });
  assert.doesNotMatch(plain.transcript, /\[错误\]|\[警告\]/u);
  const unknown = new ScriptedConsole();
  await githubAction(unknown, async () => { throw new PersonalGithubError('safe unknown outcome', 'unknown', 'https://github.com/fixture/demo'); });
  assert.match(unknown.transcript, /\[警告\] safe unknown outcome/u);
  const interrupted = new ScriptedConsole();
  await githubAction(interrupted, async () => { throw new Cancelled('safe interrupted write', true); });
  assert.match(interrupted.transcript, /\[警告\] safe interrupted write/u);
  const failed = new ScriptedConsole();
  await githubAction(failed, async () => { throw new PersonalGithubError('safe rejected request'); });
  assert.match(failed.transcript, /\[错误\] safe rejected request/u);
});
