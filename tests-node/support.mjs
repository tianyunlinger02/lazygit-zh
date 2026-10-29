import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createScratch } from '../scripts/scratch.mjs';
// Test-only module root: installed verification must share one production module graph.
const moduleRoot = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { Git } = await import(new URL('git.js', moduleRoot));
const { Console } = await import(new URL('ui.js', moduleRoot));
const { resetAppContextForTests } = await import(new URL('app-context.js', moduleRoot));

export class ScriptedConsole extends Console {
  constructor(answers = [], { quick = false, secretInput } = {}) {
    const messages = [], pending = [...answers];
    super((prompt) => {
      messages.push(prompt);
      assert.ok(pending.length, `缺少测试输入：${prompt}`);
      return pending.shift();
    }, (message) => messages.push(message), { quick, secretInput });
    this.messages = messages;
    this.answers = pending;
  }
  get transcript() { return this.messages.join('\n'); }
}

export async function fixture(t, { committed = false } = {}) {
  resetAppContextForTests();
  const original = { ...process.env };
  const { directory: base, cleanup } = await createScratch('node-tests-');
  t.after(async () => {
    resetAppContextForTests();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, original);
    await cleanup();
  });
  const home = join(base, 'home');
  await mkdir(home);
  for (const key of Object.keys(process.env)) if (/^(?:GIT_|GH_|GITHUB_)/u.test(key.toUpperCase()) || ['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'BROWSER', 'DEBUG'].includes(key.toUpperCase())) delete process.env[key];
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'AppData'), GH_CONFIG_DIR: join(home, 'gh'),
    AUTOGIT_DATA_DIR: join(base, 'AutoGit', 'data'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_ATTR_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file', GIT_CEILING_DIRECTORIES: dirname(base), LC_ALL: 'C', TMPDIR: base, TMP: base, TEMP: base,
  });
  const path = join(base, '中文 项目');
  await mkdir(path);
  const git = new Git(path);
  await git.run(['init', '--initial-branch=main']);
  await git.run(['config', 'user.name', '测试用户']);
  await git.run(['config', 'user.email', 'test@example.invalid']);
  await git.run(['config', 'commit.gpgsign', 'false']);
  await git.run(['config', 'core.autocrlf', 'false']);
  const result = {
    base, home, path, git,
    async write(name = 'hello.txt', content = 'first\n') {
      const file = join(path, name); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); return file;
    },
    async commit(message = 'initial') { await git.run(['add', '--all']); await git.run(['commit', '-m', message]); },
    async remote() {
      const target = join(base, '远程 空仓库.git'); await mkdir(target); await new Git(target).run(['init', '--bare', '--initial-branch=main']);
      await git.run(['remote', 'add', 'origin', target]); return target;
    },
  };
  if (committed) { await result.write(); await result.commit(); }
  return result;
}
