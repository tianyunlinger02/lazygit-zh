// Code-only native API stubs: these do not exercise HTTP, OAuth, tokens or vault unlock.
import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { GithubClient } from '../dist/github.js';
import { PersonalGithubClient } from '../dist/github-personal.js';
import { GitError } from '../dist/git.js';

export function personalRepository(owner, name, visibility) {
  return {
    owner, name, private: visibility === 'private', htmlUrl: `https://github.com/${owner}/${name}`,
    sshUrl: `git@github.com:${owner}/${name}.git`, httpsUrl: `https://github.com/${owner}/${name}.git`,
  };
}

// An opaque code-level guard, deliberately not a credential capability or real session.
export function stubCredentialPin() {
  let disposed = false;
  return Object.freeze({
    host: 'github.com', account: 'fixture-login',
    assertCurrent() { assert.equal(disposed, false, 'fixture pin used after disposal'); },
    assertToken() { assert.equal(disposed, false, 'fixture pin used after disposal'); },
    dispose() { disposed = true; },
  });
}

export function mockPersonalGithub(t, initialLogin = 'fixture-login') {
  const state = {
    login: initialLogin, authentications: 0, logins: 0, ghCalls: [], creates: [],
    authenticateResult: true, authenticateError: undefined, duringAuthenticate: undefined,
    beforeCreateWrite: undefined, afterCreated: undefined, createError: undefined, remoteAddError: undefined,
    repositoryResult: undefined, inspections: [], inspectResult: undefined, inspectError: undefined,
    pin: stubCredentialPin(),
  };
  // Guard the legacy class without changing collaboration tests in other files.
  for (const method of Object.getOwnPropertyNames(GithubClient.prototype)) {
    if (method === 'constructor' || typeof GithubClient.prototype[method] !== 'function') continue;
    t.mock.method(GithubClient.prototype, method, () => {
      state.ghCalls.push(method);
      assert.fail(`personal creation must not call GithubClient.${method}`);
    });
  }
  t.after(() => assert.deepEqual(state.ghCalls, [], 'personal creation must not depend on gh'));
  t.mock.method(PersonalGithubClient.prototype, 'currentLogin', async () => { state.logins++; return state.login; });
  t.mock.method(PersonalGithubClient.prototype, 'credentialPin', () => state.pin);
  t.mock.method(PersonalGithubClient.prototype, 'inspectRepository', async (owner, name, visibility, checkContext) => {
    if (checkContext) await checkContext();
    state.inspections.push({ owner, name, visibility });
    if (state.inspectError) throw state.inspectError;
    return state.inspectResult ?? personalRepository(owner, name, visibility);
  });
  t.mock.method(PersonalGithubClient.prototype, 'authenticate', async function (ui, checkContext) {
    state.authentications++;
    assert.equal(this.actor, 'fixture-login', 'native client must be constructed for the chosen AutoGit account');
    assert.equal(typeof checkContext, 'function', 'authentication must receive the context race check');
    await checkContext();
    if (state.duringAuthenticate) await state.duringAuthenticate(ui);
    if (state.authenticateError) throw state.authenticateError;
    if (!state.authenticateResult) return false;
    if ((await this.currentLogin()).toLowerCase() !== 'fixture-login') throw new GitError('GitHub API 登录账号与预期 fixture-login 不一致，已停止；不会自动切换账号。');
    return true;
  });
  t.mock.method(PersonalGithubClient.prototype, 'createRepository', async function (owner, name, visibility, onCreated, beforeWrite) {
    assert.equal((await this.currentLogin()).toLowerCase(), owner.toLowerCase(), 'native client must recheck the expected actor before its write');
    if (state.beforeCreateWrite) await state.beforeCreateWrite();
    if (beforeWrite) await beforeWrite();
    state.creates.push({ owner, name, visibility });
    const created = state.repositoryResult ?? personalRepository(owner, name, visibility);
    onCreated?.(created.htmlUrl);
    if (state.afterCreated) await state.afterCreated(created);
    if (state.createError) throw state.createError;
    return created;
  });
  return state;
}

export async function writePersonalCliDriver(file) {
  await writeFile(file, `import { runPersonalCli } from ${JSON.stringify(import.meta.url)}; await runPersonalCli(process.argv.slice(2));\n`);
}

export async function runPersonalCli(args) {
  const { main } = await import('../dist/cli.js');
  const { appDataDir } = await import('../dist/app-context.js');
  const { Console, closeInput } = await import('../dist/ui.js');
  const record = async call => appendFile(process.env.AUTOGIT_TEST_NATIVE_LOG, `${JSON.stringify(call)}\n`);
  for (const method of Object.getOwnPropertyNames(GithubClient.prototype)) {
    if (method === 'constructor' || typeof GithubClient.prototype[method] !== 'function') continue;
    GithubClient.prototype[method] = async () => {
      await record({ method: `GithubClient.${method}` });
      assert.fail(`personal CLI must not call GithubClient.${method}`);
    };
  }
  // A missed native stub must fail offline rather than reach a production API.
  globalThis.fetch = async () => { throw new Error('HTTP is blocked in the code-only native API CLI stub'); };
  PersonalGithubClient.prototype.currentLogin = async () => 'fixture-login';
  PersonalGithubClient.prototype.credentialPin = () => stubCredentialPin();
  PersonalGithubClient.prototype.inspectRepository = async () => { throw new Error('unexpected inspection in code-only legacy CLI fixture'); };
  PersonalGithubClient.prototype.authenticate = async function (ui, checkContext) {
    assert.equal(typeof checkContext, 'function');
    await checkContext();
    assert.equal(this.actor, 'fixture-login');
    await record({ method: 'authenticate', account: await this.currentLogin() });
    return true;
  };
  PersonalGithubClient.prototype.createRepository = async function (owner, name, visibility, onCreated, beforeWrite) {
    assert.equal(owner, await this.currentLogin());
    assert.equal(name, process.env.AUTOGIT_TEST_REPO);
    assert.equal(visibility, process.env.AUTOGIT_TEST_VISIBILITY);
    if (beforeWrite) await beforeWrite();
    const created = personalRepository(owner, name, visibility);
    await record({ method: 'createRepository', owner, name, visibility });
    await writeFile(process.env.AUTOGIT_TEST_CREATED, `${owner}/${name}`);
    onCreated?.(created.htmlUrl);
    return created;
  };
  const ui = new Console(undefined, undefined, { secretInput: async () => { throw new Error('code-only native CLI driver must not request a secret'); } });
  try {
    process.exitCode = await main(args, ui, {
      async unlock(console, directory, options) {
        assert.equal(console, ui);
        assert.equal(directory, appDataDir(), 'location must be configured before unlock');
        assert.deepEqual(options, { allowCreate: true });
        return { async close() {} };
      },
    });
  } finally { closeInput(); }
}
