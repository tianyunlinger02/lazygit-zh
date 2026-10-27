import assert from 'node:assert/strict';
import { test } from 'node:test';
const root = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { GithubClient, authenticateGithub, validateRepositoryName } = await import(new URL('github.js', root));
const { GitError } = await import(new URL('git.js', root));
const { Cancelled, Console } = await import(new URL('ui.js', root));
class ScriptedConsole extends Console {
  constructor(answers = [], options = {}) {
    const pending = [...answers], messages = [];
    super((prompt) => { messages.push(prompt); assert.ok(pending.length, `missing input: ${prompt}`); return pending.shift(); }, (message) => messages.push(message), options);
    this.messages = messages; this.answers = pending;
  }
  get transcript() { return this.messages.join('\n'); }
}

const empty = () => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
const loginResult = (login) => ({ status: 0, stdout: Buffer.from(`${login}\n`), stderr: Buffer.alloc(0) });
function repositoryJson({ owner = 'alice', name = 'demo', private: isPrivate = false, htmlUrl, sshUrl, cloneUrl, ...extra } = {}) {
  return Buffer.from(JSON.stringify({
    owner: { login: owner }, name, full_name: `${owner}/${name}`, private: isPrivate,
    html_url: htmlUrl ?? `https://github.com/${owner}/${name}`,
    ssh_url: sshUrl ?? `git@github.com:${owner}/${name}.git`,
    clone_url: cloneUrl ?? `https://github.com/${owner}/${name}.git`, ...extra,
  }));
}
function harness({ login = 'alice', verification = repositoryJson(), createStatus = 0, currentStatus = 0, currentOutput, onRun, env = { PATH: '/fixture/bin', HOME: '/fixture/home' } } = {}) {
  const calls = [];
  const runner = async (program, args, options) => {
    calls.push({ program, args: [...args], options });
    if (onRun) {
      const result = await onRun(program, [...args], options, calls);
      if (result) return result;
    }
    if (args[0] === 'api' && args.includes('user')) return currentStatus ? { status: currentStatus, stdout: Buffer.alloc(0), stderr: Buffer.from('fixture-only stderr') } : (currentOutput ? { status: 0, stdout: Buffer.from(currentOutput), stderr: Buffer.alloc(0) } : loginResult(login));
    if (args[0] === 'repo' && args[1] === 'create') return { status: createStatus, stdout: Buffer.from('human output ignored'), stderr: Buffer.from('fixture-only stderr') };
    if (args[0] === 'api' && args.some((arg) => arg.startsWith('repos/'))) return { status: 0, stdout: verification, stderr: Buffer.alloc(0) };
    if (args[0] === 'auth' && args[1] === 'login') return empty();
    if (args[0] === 'auth' && args[1] === 'switch') return empty();
    throw new Error(`unexpected fixture command ${args.join(' ')}`);
  };
  const findTool = (name) => name === 'gh' ? '/fixture/gh' : undefined;
  return { client: new GithubClient('/fixture/project', { runProcess: runner, which: findTool, env }), calls, runner };
}
function call(calls, predicate) { return calls.find((item) => predicate(item.args)); }


test('all credential names, including empty values, are rejected before any value is read', () => {
  const names = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  if (process.platform === 'win32') names.push('gH_tOkEn', 'github_TOKEN', 'gh_enterprise_token', 'Github_Enterprise_Token');
  for (const name of names) {
    let valuesRead = 0, toolChecks = 0;
    const env = {};
    Object.defineProperty(env, 'PATH', { enumerable: true, get() { valuesRead++; throw new Error('environment copied before credential rejection'); } });
    Object.defineProperty(env, name, { enumerable: true, get() { valuesRead++; return undefined; } });
    const client = new GithubClient('/fixture/project', { which: () => { toolChecks++; return '/fixture/gh'; }, env });
    assert.throws(() => client.ensureAvailable(), (error) => error instanceof GitError && error.message.includes(name.toUpperCase()) && error.cause === undefined);
    assert.equal(valuesRead, 0); assert.equal(toolChecks, 0);
  }
});

test('environment copies clear inherited GH controls and executable pager/browser/debug commands', async () => {
  const env = {
    PATH: '/fixture/bin', HOME: '/fixture/home', GH_HOST: 'enterprise.example.invalid', GH_CONFIG_DIR: '/fixture/config',
    GH_DEBUG: 'api', GH_TOKENLESS_FLAG: 'discard', GH_PROMPT_DISABLED: 'inherited', GH_PAGER: 'fixture-external-command',
    GH_BROWSER: 'fixture-external-command', GH_FORCE_TTY: '100%', GH_REPO: 'wrong/target', GH_NO_UPDATE_NOTIFIER: '0',
    DEBUG: 'api', PAGER: 'fixture-external-command', GIT_PAGER: 'fixture-external-command', BROWSER: 'fixture-external-command',
    FORCE_COLOR: '1', CLICOLOR_FORCE: '1', NO_COLOR: '', CLICOLOR: '1',
  };
  const original = { ...env };
  const f = harness({ env });
  await f.client.currentLogin(); await f.client.browserLogin(new ScriptedConsole(['y']));
  for (const { options } of f.calls) {
    assert.notEqual(options.env, env);
    assert.equal(options.env.PATH, env.PATH); assert.equal(options.env.HOME, env.HOME); assert.equal(options.env.GH_CONFIG_DIR, env.GH_CONFIG_DIR);
    assert.equal(options.env.GH_HOST, 'github.com'); assert.equal(options.env.GH_PAGER, 'cat');
    assert.equal(options.env.NO_COLOR, '1'); assert.equal(options.env.CLICOLOR, '0');
    assert.equal(options.env.GH_NO_UPDATE_NOTIFIER, '1'); assert.equal(options.env.GH_NO_EXTENSION_UPDATE_NOTIFIER, '1');
    for (const key of ['GH_DEBUG', 'GH_TOKENLESS_FLAG', 'GH_BROWSER', 'GH_FORCE_TTY', 'GH_REPO', 'DEBUG', 'PAGER', 'GIT_PAGER', 'BROWSER', 'FORCE_COLOR', 'CLICOLOR_FORCE']) assert.equal(options.env[key], undefined);
  }
  assert.equal(f.calls[0].options.env.GH_PROMPT_DISABLED, '1'); assert.equal(f.calls[1].options.env.GH_PROMPT_DISABLED, undefined);
  assert.deepEqual(env, original);
});

test('constructor default environment is resolved again for every call, not snapshotted or mutated', async () => {
  // Swap only the object reference for this isolated test process. Never inspect
  // the developer environment or invoke any native process with these values.
  const saved = process.env;
  const calls = [];
  try {
    process.env = { PATH: '/fixture/first', GH_HOST: 'ignored.example.invalid' };
    const client = new GithubClient('/fixture/project', { which: () => '/fixture/gh', runProcess: async (_program, _args, options) => { calls.push(options.env); return loginResult('alice'); } });
    process.env = { PATH: '/fixture/second', GH_HOST: 'ignored.example.invalid' };
    await client.currentLogin(); assert.equal(calls[0].PATH, '/fixture/second'); assert.equal(process.env.GH_HOST, 'ignored.example.invalid');
    process.env = { GH_TOKEN: '' };
    await assert.rejects(client.currentLogin(), /GH_TOKEN/u); assert.equal(calls.length, 1);
  } finally { process.env = saved; }
});

test('repository names are validated without normalization or URL/path acceptance', () => {
  for (const value of ['demo', 'demo_name', 'demo.name', 'demo-name', 'a'.repeat(100), '.hidden']) assert.equal(validateRepositoryName(value), value);
  for (const value of ['', 'a'.repeat(101), '-demo', '.', '..', '...', 'demo.git', 'DEMO.GIT', 'a/b', 'a\\b', 'https://github.com/a/b', 'a b', 'a\u0000b']) assert.throws(() => validateRepositoryName(value), GitError);
  assert.equal(validateRepositoryName('not.gitx'), 'not.gitx');
});

test('ensureAvailable checks only local tool/env state and never runs gh', () => {
  const calls = [];
  const client = new GithubClient('/fixture/project', { which: (name) => name === 'gh' ? '/fixture/gh' : undefined, runProcess: async (...args) => { calls.push(args); return empty(); }, env: { PATH: '/fixture/bin', GH_CONFIG_DIR: '/fixture/config' } });
  client.ensureAvailable();
  assert.equal(calls.length, 0);
});

test('missing gh is reported locally without invoking a process', () => {
  const calls = [];
  const client = new GithubClient('/fixture/project', { which: () => undefined, runProcess: async (...args) => { calls.push(args); return empty(); }, env: { PATH: '/fixture/bin' } });
  assert.throws(() => client.ensureAvailable(), /未找到.*gh/u);
  assert.equal(calls.length, 0);
});

test('credential environment names are rejected without exposing values or mutating the source', () => {
  const env = { PATH: '/fixture/bin', GH_TOKEN: 'fixture-token-never-real', GITHUB_TOKEN: '', GH_CONFIG_DIR: '/fixture/config', GH_DEBUG: '1' };
  const client = new GithubClient('/fixture/project', { which: () => '/fixture/gh', env });
  assert.throws(() => client.ensureAvailable(), (error) => error instanceof GitError && /GH_TOKEN/u.test(error.message) && !error.message.includes('fixture-token') && !error.message.includes('never-real'));
  assert.equal(env.GH_TOKEN, 'fixture-token-never-real'); assert.equal(env.GH_DEBUG, '1');
});

test('invalid create inputs are rejected offline before an owner check or callback', async () => {
  for (const [owner, name, visibility] of [['-alice', 'demo', 'public'], ['alice', '../demo', 'private'], ['alice', 'demo.git', 'public'], ['alice', 'demo', 'internal']]) {
    const f = harness(); let notified = false;
    await assert.rejects(f.client.createRepository(owner, name, visibility, () => { notified = true; }), GitError);
    assert.equal(f.calls.length, 0); assert.equal(notified, false);
  }
});

test('currentLogin rejects whitespace, control bytes, invalid logins and unbounded output without disclosure', async () => {
  for (const currentOutput of [' alice', 'alice ', 'alice\n\n', 'alice\r', 'alice\u001b[31m', '-alice', 'alice-', 'al--ice', 'a'.repeat(40), 'a'.repeat(129), '{"login":"alice","token":"fixture-secret"}', Buffer.from([0xff])]) {
    const f = harness({ currentOutput });
    await assert.rejects(f.client.currentLogin(), (error) => error instanceof GitError && !error.message.includes('fixture-secret') && error.cause === undefined);
  }
  for (const currentOutput of ['alice', 'alice\n', 'alice\r\n']) assert.equal(await harness({ currentOutput }).client.currentLogin(), 'alice');
});

test('currentLogin uses the documented API command and strict login output', async () => {
  const f = harness({ login: 'Alice-1' });
  assert.equal(await f.client.currentLogin(), 'Alice-1');
  assert.deepEqual(f.calls[0].args, ['api', '--hostname', 'github.com', '--method', 'GET', 'user', '--jq', '.login']);
  assert.equal(f.calls[0].options.interactive, false); assert.equal(f.calls[0].options.inputData, undefined); assert.equal(f.calls[0].options.env.GH_HOST, 'github.com');
  const invalid = harness({ currentOutput: 'not a login\n' });
  await assert.rejects(invalid.client.currentLogin(), /登录名无效/u);
  const expired = harness({ currentStatus: 1 });
  await assert.rejects(expired.client.currentLogin(), (error) => error instanceof GitError && !error.message.includes('fixture-only stderr'));
});

test('switchAccount uses a default github.com host and no token/status output', async () => {
  const f = harness(); await f.client.switchAccount('alice-1');
  assert.deepEqual(f.calls[0].args, ['auth', 'switch', '--hostname', 'github.com', '--user', 'alice-1']);
  assert.equal(f.calls[0].options.env.GH_PROMPT_DISABLED, '1');
  await assert.rejects(f.client.switchAccount('-bad'), GitError);
});

test('explicit browserLogin action runs without a second confirmation in quick and detailed modes', async () => {
  for (const quick of [true, false]) {
    const f = harness();
    const accepted = new ScriptedConsole([], { quick });
    assert.equal(await f.client.browserLogin(accepted), true);
    const loginCall = f.calls.find((item) => item.args[0] === 'auth' && item.args[1] === 'login');
    assert.deepEqual(loginCall.args, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'ssh', '--skip-ssh-key', '--web']);
    assert.equal(loginCall.options.interactive, true); assert.equal(loginCall.options.inputData, undefined); assert.equal(loginCall.options.env.GH_PROMPT_DISABLED, undefined);
  }
});

test('browserLogin refuses a pipe before starting the default native runner', { skip: Boolean(process.stdin.isTTY && process.stdout.isTTY) }, async () => {
  const client = new GithubClient('/fixture/project', { which: () => '/fixture/nonexistent-gh', env: { PATH: '/fixture/bin', HOME: '/fixture/home' } });
  const ui = new ScriptedConsole(['y']);
  assert.equal(await client.browserLogin(ui), false); assert.match(ui.transcript, /真实交互终端/u);
});

test('browserLogin launch failures and interruption never expose error text', async () => {
  for (const interrupted of [false, true]) {
    const f = harness({ onRun: async (_program, args) => {
      if (args[0] === 'auth' && args[1] === 'login') throw interrupted ? new Cancelled('fixture-secret') : new Error('fixture-secret');
    } });
    const ui = new ScriptedConsole(['y']);
    if (interrupted) await assert.rejects(f.client.browserLogin(ui), (error) => error instanceof Cancelled && /外部.*可能已改变/u.test(error.message) && !error.message.includes('fixture-secret'));
    else assert.equal(await f.client.browserLogin(ui), false);
    assert.equal(ui.transcript.includes('fixture-secret'), false);
  }
});

test('browserLogin returns false for a safe nonzero result and never displays stderr', async () => {
  const f = harness({ onRun: async (_program, args) => args[0] === 'auth' && args[1] === 'login' ? { status: 9, stdout: Buffer.alloc(0), stderr: Buffer.from('fixture-token-never-real') } : undefined });
  const ui = new ScriptedConsole(['y']);
  assert.equal(await f.client.browserLogin(ui), false); assert.match(ui.transcript, /退出码 9/u); assert.equal(ui.transcript.includes('fixture-token'), false);
});

test('createRepository uses explicit visibility, fixed owner/name argv and sanitized deterministic environment', async () => {
  for (const visibility of ['private', 'public']) {
    const f = harness({ login: 'Alice', verification: repositoryJson({ owner: 'Alice', name: 'demo', private: visibility === 'private' }) });
    const created = await f.client.createRepository('alice', 'demo', visibility);
    assert.equal(created.private, visibility === 'private');
    const create = call(f.calls, (args) => args[0] === 'repo');
    assert.deepEqual(create.args, ['repo', 'create', `alice/demo`, `--${visibility}`]);
    assert.equal(create.options.env.GH_HOST, 'github.com'); assert.equal(create.options.env.GH_PROMPT_DISABLED, '1'); assert.equal(create.options.env.GH_PAGER, 'cat'); assert.equal(create.options.env.NO_COLOR, '1');
    for (const key of ['GH_DEBUG', 'GH_BROWSER', 'BROWSER', 'PAGER', 'DEBUG']) assert.equal(create.options.env[key], undefined);
    assert.equal(f.calls.filter(({ args }) => args[0] === 'repo').length, 1);
  }
});

test('createRepository rechecks owner immediately before create and refuses a mismatch', async () => {
  const f = harness({ login: 'other' });
  await assert.rejects(f.client.createRepository('alice', 'demo', 'public'), /账号.*不一致/u);
  assert.equal(f.calls.some(({ args }) => args[0] === 'repo'), false);
});

test('createRepository notifies synchronously before verification and preserves created link on verification failure', async () => {
  const events = [];
  const f = harness({ verification: Buffer.from('{"broken":true}') });
  await assert.rejects(f.client.createRepository('alice', 'demo', 'public', (url) => events.push({ url, calls: f.calls.length })), (error) => error instanceof GitError && /已创建/u.test(error.message) && error.message.includes('https://github.com/alice/demo'));
  assert.deepEqual(events, [{ url: 'https://github.com/alice/demo', calls: 2 }]);
  assert.equal(f.calls.filter(({ args }) => args[0] === 'repo').length, 1); assert.equal(f.calls.filter(({ args }) => args[0] === 'api' && args.some((arg) => arg.startsWith('repos/'))).length, 1);
});

test('createRepository never retries or deletes after unknown nonzero creation result', async () => {
  const f = harness({ createStatus: 7 });
  await assert.rejects(f.client.createRepository('alice', 'demo', 'public'), (error) => error instanceof GitError && /结果未知|可能已创建/u.test(error.message) && !error.message.includes('fixture-only stderr'));
  assert.equal(f.calls.filter(({ args }) => args[0] === 'repo').length, 1); assert.equal(f.calls.some(({ args }) => args[0] === 'api' && args.some((arg) => arg.startsWith('repos/'))), false);
});

test('creation errors give predefined auth, permission, duplicate and network guidance without raw stderr', async () => {
  for (const [stderr, expected] of [
    ['HTTP 401 fixture-secret', /认证/u], ['HTTP 403 fixture-secret', /权限/u], ['HTTP 422 fixture-secret', /名称.*存在/u],
    ['HTTP 409 fixture-secret', /名称.*存在/u], ['name already exists fixture-secret', /名称.*存在/u],
    ['connection reset fixture-secret', /网络.*结果未知/u], ['unclassified fixture-secret', /结果未知/u],
  ]) {
    const f = harness({ onRun: async (_program, args) => args[0] === 'repo' ? { status: 1, stdout: Buffer.from('fixture-secret'), stderr: Buffer.from(stderr) } : undefined });
    await assert.rejects(f.client.createRepository('alice', 'demo', 'public'), (error) => error instanceof GitError && expected.test(error.message) && error.message.includes('https://github.com/alice/demo') && !error.message.includes('fixture-secret') && error.cause === undefined);
    assert.equal(f.calls.length, 2);
  }
});

test('createRepository turns cancellation into an explicit unknown-outcome Cancelled with link', async () => {
  const f = harness({ onRun: async (_program, args) => args[0] === 'repo' ? (() => { throw new Cancelled('fixture interrupt'); })() : undefined });
  await assert.rejects(f.client.createRepository('alice', 'demo', 'public'), (error) => error instanceof Cancelled && /结果未知/u.test(error.message) && error.message.includes('https://github.com/alice/demo'));
  assert.equal(f.calls.length, 2); assert.equal(f.calls.some(({ args }) => args[0] === 'api' && args.some((arg) => arg.startsWith('repos/'))), false);
});

test('unknown launch errors and create signals disclose only safe status/code and the known target', async () => {
  const failures = [
    Object.assign(new Error('fixture-secret-launch-error'), { code: 'EACCES' }),
    new Error('fixture-secret-launch-error'),
    { status: 143, signal: 'SIGTERM', stdout: Buffer.from('fixture-secret-output'), stderr: Buffer.from('fixture-secret-output') },
  ];
  for (const failure of failures) {
    const f = harness({ onRun: async (_program, args) => {
      if (args[0] !== 'repo') return undefined;
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    let notified = false;
    await assert.rejects(f.client.createRepository('alice', 'demo', 'private', () => { notified = true; }), (error) => error instanceof GitError && /可能已创建/u.test(error.message) && error.message.includes('https://github.com/alice/demo') && !error.message.includes('fixture-secret') && error.cause === undefined);
    assert.equal(notified, false); assert.equal(f.calls.length, 2);
  }
});

test('successful metadata verification returns only allowlisted canonical fields', async () => {
  const f = harness({ verification: repositoryJson({ owner: 'Alice', name: 'Demo' }) });
  assert.deepEqual(await f.client.createRepository('alice', 'demo', 'public'), {
    owner: 'Alice', name: 'Demo', private: false, htmlUrl: 'https://github.com/Alice/Demo', sshUrl: 'git@github.com:Alice/Demo.git', httpsUrl: 'https://github.com/Alice/Demo.git',
  });
  assert.equal(f.calls.length, 3);
  const verification = f.calls[2].args;
  assert.deepEqual(verification.slice(0, 6), ['api', '--hostname', 'github.com', '--method', 'GET', 'repos/alice/demo']);
  assert.equal(verification[6], '--jq'); assert.match(verification[7], /owner.*login.*full_name.*private.*html_url.*ssh_url.*clone_url/u);
});

test('verification cancellation keeps the already-created outcome and callback URL', async () => {
  const f = harness({ onRun: async (_program, args) => {
    if (args[0] === 'api' && args.some((arg) => arg.startsWith('repos/'))) throw new Cancelled('fixture-secret-interrupt');
  } });
  const urls = [];
  await assert.rejects(f.client.createRepository('alice', 'demo', 'public', (url) => urls.push(url)), (error) => error instanceof Cancelled && /已创建/u.test(error.message) && error.message.includes('https://github.com/alice/demo') && !error.message.includes('fixture-secret'));
  assert.deepEqual(urls, ['https://github.com/alice/demo']); assert.equal(f.calls.length, 3);
});

test('callback exceptions preserve creation and never start verification, retry or delete', async () => {
  for (const interrupted of [false, true]) {
    const f = harness();
    await assert.rejects(f.client.createRepository('alice', 'demo', 'public', () => { throw interrupted ? new Cancelled('fixture-secret') : new Error('fixture-secret'); }), (error) => (interrupted ? error instanceof Cancelled : error instanceof GitError) && /已创建/u.test(error.message) && !error.message.includes('fixture-secret'));
    assert.equal(f.calls.length, 2);
  }
});

test('verification rejects wrong fields, visibility and noncanonical URLs without leaking raw JSON', async () => {
  const cases = [
    repositoryJson({ owner: 'other' }),
    repositoryJson({ name: 'wrong' }),
    repositoryJson({ private: true }),
    repositoryJson({ htmlUrl: 'https://github.com/alice/demo?token=fixture-token-never-real' }),
    repositoryJson({ sshUrl: 'git@evil.example:alice/demo.git' }),
    repositoryJson({ cloneUrl: 'https://github.com/alice/demo.git?x=1' }),
    repositoryJson({ htmlUrl: 'https://github.com/alice/demo/' }),
    repositoryJson({ htmlUrl: 'https://github.com/alice/%64emo' }),
    repositoryJson({ htmlUrl: 'https://github.com:443/alice/demo' }),
    repositoryJson({ htmlUrl: 'https://fixture-secret@github.com/alice/demo' }),
    repositoryJson({ htmlUrl: 'https://github.com/alice/demo#fragment' }),
    repositoryJson({ cloneUrl: 'https://github.com.evil.example/alice/demo.git' }),
    repositoryJson({ sshUrl: 'ssh://git@github.com/alice/demo.git' }),
    repositoryJson({ full_name: 'alice/wrong' }),
    repositoryJson({ private: 'false' }),
    repositoryJson({ owner: '-alice' }),
    Buffer.from('null'), Buffer.from('[]'), Buffer.from('{"broken":'), Buffer.alloc(65_537, 32), Buffer.from([0xff]),
    Buffer.from(repositoryJson().toString().replace('"private":false', '"private":false,"private":false')),
    Buffer.from(repositoryJson().toString().replace('"login":"alice"', '"login":"alice","token":"fixture-secret"')),
    Buffer.from(repositoryJson().toString().replace('"name":"demo",', '')),
    Buffer.from(repositoryJson().toString().replace('"owner":{"login":"alice"}', '"owner":null')),
    Buffer.from('{"owner":{"login":"alice"},"name":"demo","full_name":"alice/demo","private":false,"html_url":"https://github.com/alice/demo","ssh_url":"git@github.com:alice/demo.git","clone_url":"https://github.com/alice/demo.git","extra":"unexpected"}'),
  ];
  for (const verification of cases) {
    const f = harness({ verification });
    await assert.rejects(f.client.createRepository('alice', 'demo', 'public'), (error) => error instanceof GitError && /已创建/u.test(error.message) && !error.message.includes('fixture-token'));
  }
});

test('authenticateGithub checks read-only login without redundant network confirmation', async () => {
  for (const quick of [true, false]) {
    const accepted = harness({ login: 'Alice' });
    assert.equal(await authenticateGithub(new ScriptedConsole([], { quick }), accepted.client, 'alice'), 'Alice');
    assert.equal(accepted.calls.length, 1);
  }
});

test('authenticateGithub offers explicit switch, discloses external default change, then rechecks login', async () => {
  let current = 'other';
  const f = harness({ onRun: async (_program, args) => {
    if (args[0] === 'api' && args.includes('user')) return loginResult(current);
    if (args[0] === 'auth' && args[1] === 'switch') { current = 'alice'; return empty(); }
  } });
  const ui = new ScriptedConsole(['1']);
  assert.equal(await authenticateGithub(ui, f.client, 'alice'), 'alice');
  assert.equal(f.calls.filter(({ args }) => args[0] === 'api' && args.includes('user')).length, 2);
});

test('failed external switch remains an explicit menu decision and never retries automatically', async () => {
  const f = harness({ login: 'other', onRun: async (_program, args) => args[0] === 'auth' && args[1] === 'switch' ? { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('fixture-secret') } : undefined });
  const ui = new ScriptedConsole(['1', '0']);
  assert.equal(await authenticateGithub(ui, f.client, 'alice'), undefined);
  assert.equal(f.calls.length, 2); assert.equal(ui.transcript.includes('fixture-secret'), false);
});

test('authenticateGithub returns when switched account still mismatches', async () => {
  const f = harness({ login: 'other' }); const ui = new ScriptedConsole(['1', '0'], { quick: true });
  assert.equal(await authenticateGithub(ui, f.client, 'alice'), undefined);
  assert.equal(f.calls.filter(({ args }) => args[0] === 'auth' && args[1] === 'switch').length, 1);
});

test('authentication menu return never changes an account', async () => {
  const menuReturn = harness({ login: 'other' });
  assert.equal(await authenticateGithub(new ScriptedConsole([':q']), menuReturn.client, 'alice'), undefined);
  assert.equal(menuReturn.calls.length, 1);
  assert.equal(menuReturn.calls.some(({ args }) => args[0] === 'auth'), false);
});

test('successful switch or browser flow still cannot bind a different login', async () => {
  for (const action of ['1', '2']) {
    const f = harness({ login: 'other' });
    const ui = new ScriptedConsole([action, '0']);
    assert.equal(await authenticateGithub(ui, f.client, 'alice'), undefined);
    assert.equal(f.calls.filter(({ args }) => args[0] === 'api' && args.includes('user')).length, 2);
    assert.match(ui.transcript, /不会静默重新绑定/u);
  }
});

test('authenticateGithub offers browser login after expired auth, then rechecks', async () => {
  let browser = false;
  const f = harness({ currentStatus: 1, onRun: async (_program, args) => {
    if (args[0] === 'auth' && args[1] === 'login') { browser = true; return empty(); }
    if (args[0] === 'api' && args.includes('user')) return browser ? loginResult('alice') : { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('fixture-only stderr') };
  } });
  const ui = new ScriptedConsole(['2']);
  assert.equal(await authenticateGithub(ui, f.client, 'alice'), 'alice');
});
