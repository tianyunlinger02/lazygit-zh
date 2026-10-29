import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createScratch } from '../scripts/scratch.mjs';

const root = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { PersonalGithubClient, PersonalGithubError } = await import(new URL('github-personal.js', root));
const { checkedRepositoryData } = await import(new URL('github.js', root));
const { Console, Cancelled, readSecret } = await import(new URL('ui.js', root));
const { CredentialSession, currentSession, setSession } = await import(new URL('session.js', root));
const { Vault } = await import(new URL('vault.js', root));
const TOKEN = 'synthetic_native_token_never_real', REPLACEMENT = 'synthetic_replacement_token_never_real';
const RECOVERY_URL = 'https://github.com/alice/demo';
const zeroed = (buffer) => buffer.every((byte) => byte === 0);
const repo = (extra = {}) => ({
  owner: { login: 'Alice', id: 42, type: 'User' }, name: 'Demo', full_name: 'Alice/Demo', private: true,
  html_url: 'https://github.com/Alice/Demo', ssh_url: 'git@github.com:Alice/Demo.git', clone_url: 'https://github.com/Alice/Demo.git',
  id: 123, description: 'offline fixture', ...extra,
});
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
function scripted(answers = [], secretValue = TOKEN) {
  const pending = [...answers], messages = [], events = [], secret = Buffer.from(secretValue);
  const ui = new Console((prompt) => {
    messages.push(prompt); events.push('prompt'); assert.ok(pending.length, `unexpected prompt: ${prompt}`); return pending.shift();
  }, (message) => messages.push(message), { quick: false, secretInput: () => { events.push('secret'); return secret; } });
  return { ui, pending, secret, events, messages, get transcript() { return messages.join('\n'); } };
}
function sessionFixture(t, initial = TOKEN) {
  const previous = currentSession(), reads = [], saves = [], keys = [];
  let stored = initial === undefined ? undefined : Buffer.from(initial);
  const session = {
    closed: false,
    async getToken(host, account) {
      keys.push([host, account]); const copy = stored === undefined ? undefined : Buffer.from(stored);
      if (copy) reads.push(copy); return copy;
    },
    async storeToken(host, account, value) { keys.push([host, account]); saves.push(value); stored?.fill(0); stored = Buffer.from(value); },
  };
  setSession(session);
  t.after(() => { session.closed = true; stored?.fill(0); setSession(previous); });
  return { session, reads, saves, keys, peek: () => stored?.toString('ascii'), replace: (value) => { stored?.fill(0); stored = value === undefined ? undefined : Buffer.from(value); } };
}
async function loopback(t, handler = undefined) {
  const calls = [], optionsSeen = [], failures = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const call = { method: request.method, path: request.url, body: text ? JSON.parse(text) : undefined };
      calls.push(call);
      Promise.resolve().then(async () => {
        if (handler && await handler(call, response, calls)) return;
        if (call.method === 'GET' && call.path === '/user') json(response, 200, { login: 'Alice', id: 42, extra: 'ignored' });
        else if (call.method === 'POST' && call.path === '/user/repos') json(response, 201, repo());
        else if (call.method === 'GET' && call.path === '/repos/alice/demo') json(response, 200, repo());
        else throw new Error('unexpected offline request');
      }).catch((error) => { failures.push(error); response.destroy(); });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); assert.deepEqual(failures, []);
  });
  const port = server.address().port;
  const request = (options, listener) => {
    assert.equal(options.protocol, 'https:'); assert.equal(options.hostname, 'api.github.com'); assert.equal(options.port, 443);
    assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
    assert.equal(options.headers.Accept, 'application/vnd.github+json'); assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    assert.match(options.headers['User-Agent'], /^AutoGit/u); assert.equal(/^Bearer synthetic_/u.test(options.headers.Authorization), true);
    assert.ok(options.signal instanceof AbortSignal);
    optionsSeen.push({ method: options.method, path: options.path, signal: options.signal });
    // This is the sole fixture URL mapping. Production always receives the fixed HTTPS options above.
    return httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port, headers: { ...options.headers } }, listener);
  };
  return { request, calls, optionsSeen };
}
async function authenticated(t, handler) {
  const session = sessionFixture(t), network = await loopback(t, handler), client = new PersonalGithubClient('alice', { request: network.request });
  assert.equal(await client.authenticate(scripted().ui), true);
  return { ...network, ...session, client };
}
function cleanError(error) {
  assert.equal(error.cause, undefined); assert.doesNotMatch(error.message, /synthetic_.*token|response-secret|raw-network-secret/u); return true;
}
function injectedRequest(respond) {
  return (options, listener) => {
    const request = new EventEmitter(); request.destroy = () => request;
    request.end = () => queueMicrotask(() => respond(options, listener, request));
    return request;
  };
}
function injectedResponse(listener, status, body, headers = {}) {
  const response = new PassThrough(); response.statusCode = status; response.headers = headers; response.complete = true;
  listener(response); if (!response.destroyed) response.end(body);
}

test('constructor is lazy; session/inputs/auth are required only at actual methods without gh or network fallback', async (t) => {
  const previous = currentSession(); setSession(undefined); t.after(() => setSession(previous));
  let requests = 0;
  const client = new PersonalGithubClient('Alice', { request: () => { requests++; throw new Error('must not run'); } });
  assert.equal(client.actor, 'Alice');
  await assert.rejects(client.currentLogin(), /解锁/u);
  await assert.rejects(client.createRepository('Alice', 'demo', 'private'), /解锁/u);
  assert.throws(() => new PersonalGithubClient('bad--login'), /登录名/u);
  sessionFixture(t);
  for (const args of [['other', 'demo', 'private'], ['Alice', '../demo', 'private'], ['Alice', 'demo.git', 'private'], ['Alice', 'demo', 'internal']]) await assert.rejects(client.createRepository(...args));
  await assert.rejects(client.createRepository('Alice', 'demo', 'private'), /认证/u); assert.equal(requests, 0);
});

test('native fixed Node request maps only to loopback and projects full REST data through the unchanged pure validator', async (t) => {
  const f = await authenticated(t);
  const events = [];
  const created = await f.client.createRepository('alice', 'demo', 'private', (url) => events.push({ url, calls: f.calls.length }), async () => events.push('before-write'));
  assert.deepEqual(created, { owner: 'Alice', name: 'Demo', private: true, htmlUrl: 'https://github.com/Alice/Demo', sshUrl: 'git@github.com:Alice/Demo.git', httpsUrl: 'https://github.com/Alice/Demo.git' });
  assert.deepEqual(f.calls.map(({ method, path }) => `${method} ${path}`), ['GET /user', 'GET /user', 'POST /user/repos', 'GET /repos/alice/demo']);
  assert.deepEqual(f.calls[2].body, { name: 'demo', private: true, auto_init: false });
  assert.deepEqual(events, ['before-write', { url: RECOVERY_URL, calls: 3 }]);
  assert.ok(f.reads.every(zeroed)); assert.ok(f.keys.every(([host, account]) => host === 'github.com' && account === 'alice'));
  const projected = repo(); delete projected.id; delete projected.description; projected.owner = { login: 'Alice' };
  assert.deepEqual(checkedRepositoryData(projected, 'alice', 'demo', 'private'), created);
  assert.throws(() => checkedRepositoryData({ ...projected, extra: 'not a projection' }, 'alice', 'demo', 'private'));
});

test('public creation sends explicit private:false and no auto initialization', async (t) => {
  const f = await authenticated(t, (call, response) => {
    if (call.path === '/user') return false; json(response, call.method === 'POST' ? 201 : 200, repo({ private: false })); return true;
  });
  const result = await f.client.createRepository('alice', 'demo', 'public'); assert.equal(result.private, false);
  assert.deepEqual(f.calls.find((call) => call.method === 'POST').body, { name: 'demo', private: false, auto_init: false });
});

test('missing token presents explicit enroll menu before secret and verifies actor/context before explicit encrypted save', async (t) => {
  const f = sessionFixture(t, undefined); f.replace(undefined);
  const network = await loopback(t), client = new PersonalGithubClient('alice', { request: network.request });
  const ui = scripted(['1', 'y']); let checks = 0;
  assert.equal(await client.authenticate(ui.ui, async () => { checks++; }), true);
  assert.deepEqual(ui.events, ['prompt', 'secret', 'prompt']); assert.equal(checks, 5);
  assert.equal(f.saves.length, 1); assert.equal(f.peek() === TOKEN, true); assert.ok(zeroed(ui.secret)); assert.ok(zeroed(f.saves[0]));
  assert.equal(network.calls.length, 1); assert.match(ui.transcript, /不是 GitHub 密码.*SSH 私钥/u);
  assert.match(ui.transcript, /私有仓库需要 repo.*公开仓库需要 public_repo 或 repo/u); assert.match(ui.transcript, /fine-grained/u);
  assert.match(ui.transcript, /已加密保存/u); assert.doesNotMatch(ui.transcript, /synthetic_native_token/u);
});

test('menu return, invalid staged token, mismatch and declined save never overwrite the existing token', async (t) => {
  for (const [label, answers, secret, login] of [
    ['menu return', ['0'], TOKEN, 'other'], ['invalid token', ['1'], 'invalid token', 'other'],
    ['actor mismatch', ['1'], REPLACEMENT, 'other'], ['declined save', ['1', 'n'], REPLACEMENT, 'alice'],
  ]) await t.test(label, async (t) => {
    const f = sessionFixture(t), network = await loopback(t, (call, response, calls) => {
      json(response, 200, { login: calls.length === 1 ? 'other' : login }); return true;
    });
    const ui = scripted(answers, secret), client = new PersonalGithubClient('alice', { request: network.request });
    assert.equal(await client.authenticate(ui.ui), false); assert.equal(f.peek() === TOKEN, true); assert.equal(f.saves.length, 0);
    if (ui.events.includes('secret')) assert.ok(zeroed(ui.secret)); assert.ok(f.reads.every(zeroed));
  });
});

test('invalid existing token is not sent and enrollment remains opt-in', async (t) => {
  const f = sessionFixture(t, 'bad token'), network = await loopback(t), ui = scripted(['0']);
  assert.equal(await new PersonalGithubClient('alice', { request: network.request }).authenticate(ui.ui), false);
  assert.equal(network.calls.length, 0); assert.equal(f.saves.length, 0); assert.ok(f.reads.every(zeroed)); assert.match(ui.transcript, /Token/u);
});

test('staged authentication cancellation clears secrets and never saves; cancellation after successful save says saved', async (t) => {
  for (const afterSave of [false, true]) await t.test(afterSave ? 'after save' : 'before save', async (t) => {
    const f = sessionFixture(t); f.replace(undefined); const network = await loopback(t), ui = scripted(['1', 'y']);
    let checks = 0;
    await assert.rejects(new PersonalGithubClient('alice', { request: network.request }).authenticate(ui.ui, async () => {
      if (++checks === (afterSave ? 5 : 3)) throw new Cancelled('context cancelled');
    }), (error) => error instanceof Cancelled && (afterSave ? /已加密保存/u.test(error.message) : !/已加密保存/u.test(error.message)));
    assert.equal(f.saves.length, afterSave ? 1 : 0); assert.ok(zeroed(ui.secret));
  });
});

test('session replacement or token changes during GET and confirmation stop without save or POST', async (t) => {
  for (const change of ['session', 'token']) await t.test(`${change} replacement during GET`, async (t) => {
    const f = await authenticated(t, (call, response, calls) => {
      if (calls.length === 2) { if (change === 'session') setSession({ ...f.session }); else f.replace(REPLACEMENT); }
      json(response, 200, { login: 'alice' }); return true;
    });
    await assert.rejects(f.client.createRepository('alice', 'demo', 'private'), (error) => cleanError(error) && /会话|Token/u.test(error.message));
    assert.equal(f.calls.length, 2); assert.equal(f.saves.length, 0);
  });
  await t.test('confirmation changes token', async (t) => {
    const f = sessionFixture(t, 'bad token'), network = await loopback(t), ui = scripted(['1', 'y']);
    const confirm = ui.ui.confirm.bind(ui.ui); ui.ui.confirm = async (...args) => { const choice = await confirm(...args); f.replace(REPLACEMENT); return choice; };
    await assert.rejects(new PersonalGithubClient('alice', { request: network.request }).authenticate(ui.ui), /Token 已变化/u);
    assert.equal(f.saves.length, 0); assert.ok(zeroed(ui.secret));
  });
});

test('successful authentication pins token; replacement is rejected before any further request even with same actor', async (t) => {
  const f = await authenticated(t); f.replace(REPLACEMENT);
  await assert.rejects(f.client.createRepository('alice', 'demo', 'private'), /Token 已变化/u);
  await assert.rejects(f.client.currentLogin(), /Token 已变化/u); assert.equal(f.calls.length, 1);
});

test('actor is revalidated before POST and differs only by case, never by partial or similar login', async (t) => {
  for (const login of ['alice-extra', 'bob', 'al1ce']) await t.test(login, async (t) => {
    const f = await authenticated(t, (call, response, calls) => { json(response, 200, { login: calls.length === 1 ? 'Alice' : login }); return true; });
    await assert.rejects(f.client.createRepository('alice', 'demo', 'private'), /actor/u); assert.equal(f.calls.length, 2);
  });
});

test('beforeWrite runs after actor GET and errors or credential replacement there never send POST or claim uncertainty', async (t) => {
  for (const change of ['error', 'cancel', 'token', 'session']) await t.test(`beforeWrite ${change}`, async (t) => {
    const f = await authenticated(t);
    await assert.rejects(f.client.createRepository('alice', 'demo', 'private', undefined, async () => {
      assert.equal(f.calls.length, 2);
      if (change === 'error') throw new Error('pre-write context changed');
      if (change === 'cancel') throw new Cancelled('pre-write cancelled');
      if (change === 'token') f.replace(REPLACEMENT); else f.session.closed = true;
    }), (error) => !/结果未知|可能已创建/u.test(error.message));
    assert.equal(f.calls.length, 2);
  });
});

test('201 notification precedes body completion/validation and GET verification', async (t) => {
  let releaseBody; const bodyGate = new Promise((resolve) => { releaseBody = resolve; }); const order = [];
  const f = await authenticated(t, async (call, response) => {
    if (call.method !== 'POST') return false;
    response.writeHead(201, { 'Content-Type': 'application/json' }); response.flushHeaders(); order.push('headers');
    await bodyGate; order.push('body'); response.end(JSON.stringify(repo())); return true;
  });
  await f.client.createRepository('alice', 'demo', 'private', (url) => { assert.equal(url, RECOVERY_URL); order.push('callback'); releaseBody(); });
  assert.deepEqual(order, ['headers', 'callback', 'body']); assert.equal(f.calls.length, 4);
});

test('malformed, duplicate-key, invalid-UTF8, oversize and wrong-metadata 201 preserve created state before verification', async (t) => {
  for (const [label, bytes, headers] of [
    ['malformed', '{"response-secret":', {}], ['duplicate', '{"x":1,"x":2}', {}], ['invalid UTF8', Buffer.from([0xff]), {}],
    ['streaming limit', Buffer.alloc(256 * 1024 + 1, 32), {}], ['content-length limit', '{}', { 'content-length': String(256 * 1024 + 1) }],
    ['wrong owner', JSON.stringify(repo({ owner: { login: 'other' } })), {}], ['wrong visibility', JSON.stringify(repo({ private: false })), {}],
    ['noncanonical RECOVERY_URL', JSON.stringify(repo({ clone_url: 'https://response-secret@evil.invalid/repo.git' })), {}],
  ]) await t.test(label, async (t) => {
    sessionFixture(t); let requests = 0, notifications = 0;
    const request = injectedRequest((options, listener) => {
      requests++; injectedResponse(listener, options.method === 'POST' ? 201 : 200, options.method === 'POST' ? bytes : '{"login":"alice"}', options.method === 'POST' ? headers : {});
    });
    const client = new PersonalGithubClient('alice', { request }); assert.equal(await client.authenticate(scripted().ui), true);
    await assert.rejects(client.createRepository('alice', 'demo', 'private', () => { notifications++; }), (error) => error instanceof PersonalGithubError && error.repositoryState === 'created' && error.repositoryUrl === RECOVERY_URL && cleanError(error));
    assert.equal(notifications, 1); assert.equal(requests, 3);
  });
});

test('verification failures and callback exceptions preserve creation and do not retry, delete or autoassociate', async (t) => {
  for (const fault of ['get', 'callback-error', 'callback-cancel']) await t.test(fault, async (t) => {
    const f = await authenticated(t, (call, response) => { if (call.path.startsWith('/repos/')) { json(response, 200, repo({ full_name: 'other/demo' })); return true; } return false; });
    let notifications = 0;
    await assert.rejects(f.client.createRepository('alice', 'demo', 'private', () => {
      notifications++; if (fault === 'callback-error') throw new Error('raw-network-secret'); if (fault === 'callback-cancel') throw new Cancelled('raw-network-secret');
    }), (error) => cleanError(error) && /已创建/u.test(error.message) && (fault === 'callback-cancel' ? error instanceof Cancelled && error.warning === true : error.repositoryState === 'created'));
    assert.equal(notifications, 1); assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(f.calls.length, fault === 'get' ? 4 : 3);
  });
});

test('redirects and status failures are sanitized; no Location is visited and POST is never retried', async (t) => {
  for (const status of [301, 302, 307, 308, 401, 403, 409, 422, 429, 500]) await t.test(String(status), async (t) => {
    const f = await authenticated(t, (call, response) => {
      if (call.method !== 'POST') return false;
      response.writeHead(status, { Location: 'https://response-secret.example.invalid/token' }); response.end('response-secret'); return true;
    });
    await assert.rejects(f.client.createRepository('alice', 'demo', 'private'), (error) => cleanError(error) && error.repositoryState === (status >= 500 ? 'unknown' : 'not-created') && error.repositoryUrl === RECOVERY_URL);
    assert.equal(f.calls.length, 3); assert.ok(f.calls.every((call) => ['GET', 'POST'].includes(call.method)));
  });
});

test('read-only redirects, duplicate JSON, wrong encodings and raw transport errors never leak response or credentials', async (t) => {
  for (const fault of ['redirect', 'duplicate', 'encoding', 'network']) await t.test(`read-only ${fault}`, async (t) => {
    sessionFixture(t);
    const request = injectedRequest((_options, listener, request) => {
      if (fault === 'network') { request.emit('error', new Error('raw-network-secret')); return; }
      injectedResponse(listener, fault === 'redirect' ? 302 : 200, fault === 'duplicate' ? '{"login":"alice","login":"alice"}' : '{"login":"alice"}', fault === 'encoding' ? { 'content-encoding': 'gzip' } : {});
    });
    await assert.rejects(new PersonalGithubClient('alice', { request }).currentLogin(), (error) => error instanceof PersonalGithubError && cleanError(error));
  });
});

test('disconnect and SIGINT after POST was sent report unknown outcome with canonical URL and warning cancellation', async (t) => {
  for (const interrupt of [false, true]) await t.test(interrupt ? 'SIGINT' : 'disconnect', async (t) => {
    const listeners = process.listenerCount('SIGINT');
    const f = await authenticated(t, (call, response) => {
      if (call.method !== 'POST') return false;
      if (interrupt) process.emit('SIGINT'); else response.destroy(new Error('raw-network-secret'));
      return true;
    });
    await assert.rejects(f.client.createRepository('alice', 'demo', 'private'), (error) => cleanError(error) && /结果未知/u.test(error.message) && error.message.includes(RECOVERY_URL) && (interrupt ? error instanceof Cancelled && error.warning === true : error.repositoryState === 'unknown'));
    assert.equal(f.calls.length, 3); assert.equal(process.listenerCount('SIGINT'), listeners);
    assert.equal(f.optionsSeen.at(-1).signal.aborted, interrupt);
  });
});

test('30-second total timeout spans body streaming and 201 still retains creation; SIGINT listeners are cleaned up', async (t) => {
  sessionFixture(t); let requests = 0, bodyResponse;
  const listeners = process.listenerCount('SIGINT');
  const request = injectedRequest((options, listener) => {
    requests++;
    if (options.method !== 'POST') { injectedResponse(listener, 200, '{"login":"alice"}'); return; }
    bodyResponse = new PassThrough(); bodyResponse.statusCode = 201; bodyResponse.headers = {}; bodyResponse.complete = false;
    listener(bodyResponse); if (!bodyResponse.destroyed) bodyResponse.write('{');
  });
  const client = new PersonalGithubClient('alice', { request }); assert.equal(await client.authenticate(scripted().ui), true);
  t.mock.timers.enable({ apis: ['setTimeout'] }); let notified;
  const headers = new Promise((resolve) => { notified = resolve; });
  const pending = client.createRepository('alice', 'demo', 'private', notified);
  const rejected = assert.rejects(pending, (error) => cleanError(error) && error.repositoryState === 'created' && /已创建/u.test(error.message));
  await headers; t.mock.timers.tick(30_001); await rejected;
  assert.equal(requests, 3); assert.equal(bodyResponse.destroyed, true); assert.equal(process.listenerCount('SIGINT'), listeners);
});

test('Node HTTP debug diagnostics are rejected before token-bearing options are constructed', async () => {
  const source = `import{PersonalGithubClient}from${JSON.stringify(new globalThis.URL('github-personal.js', root).href)};import{setSession}from${JSON.stringify(new globalThis.URL('session.js', root).href)};setSession({closed:false,getToken:async()=>Buffer.from('synthetic_debug_token_never_real')});try{await new PersonalGithubClient('alice',{request:()=>{throw Error('REQUEST_MUST_NOT_RUN')}}).currentLogin();process.exitCode=3}catch(e){console.log(e.message);if(!e.message.includes('HTTP 调试'))process.exitCode=4}`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env: { NODE_DEBUG: 'http,https' }, cwd: process.cwd() });
  assert.match(result.stdout, /HTTP 调试/u); assert.doesNotMatch(result.stdout + result.stderr, /synthetic_debug_token|REQUEST_MUST_NOT_RUN/u);
});

test('request cancellation releases input ownership before the next secret reader', async (t) => {
  const f = await authenticated(t, (call, response) => {
    if (call.method !== 'POST') return false; process.emit('SIGINT'); return true;
  });
  await assert.rejects(f.client.createRepository('alice', 'demo', 'private'), Cancelled);
  const input = new PassThrough(); input.isTTY = true; input.isRaw = false; input.pause(); input.setRawMode = (value) => { input.isRaw = value; };
  const output = [];
  const pending = readSecret('SECRET_WAIT', { input, output: { write: (value) => output.push(value) } });
  input.write(Buffer.from('synthetic-next-secret\n')); const value = await pending;
  assert.equal(value.toString(), 'synthetic-next-secret'); value.fill(0);
  assert.equal(input.isRaw, false); assert.equal(input.isPaused(), true); assert.equal(input.listenerCount('data'), 0); assert.deepEqual(output, ['SECRET_WAIT', '\n']);
});

test('verified enrollment uses the real encrypted Vault without storing plaintext or touching external credentials', { skip: process.platform === 'win32' }, async (t) => {
  const scratch = await createScratch('native-personal-');
  const previous = currentSession(), password = Buffer.from('synthetic-vault-password'); let session;
  t.after(async () => { await session?.close(); setSession(previous); await scratch.cleanup(); });
  const directory = join(scratch.directory, 'vault');
  try { const { vault } = await Vault.create(directory, password); session = new CredentialSession(vault); } finally { password.fill(0); }
  setSession(session); const network = await loopback(t), ui = scripted(['1', 'y']);
  assert.equal(await new PersonalGithubClient('alice', { request: network.request }).authenticate(ui.ui), true);
  const token = await session.getToken('github.com', 'alice'); try { assert.equal(token.toString() === TOKEN, true); } finally { token.fill(0); }
  const encrypted = await readFile(join(directory, 'vault.json')); assert.equal(encrypted.includes(Buffer.from(TOKEN)), false); assert.ok(zeroed(ui.secret));
});

test('native read failures expose controlled classifications without turning unavailable, forbidden or protocol failures into enrollment', async (t) => {
  for (const [status, code] of [[403, 'forbidden'], [429, 'rate-limited'], [500, 'unavailable'], [503, 'unavailable'], [302, 'protocol'], [404, 'not-found']]) await t.test(`classification HTTP ${status}`, async (t) => {
    const f = sessionFixture(t), ui = scripted(); let requests = 0;
    const request = injectedRequest((_options, listener) => { requests++; injectedResponse(listener, status, 'response-secret', { location: 'https://response-secret.invalid' }); });
    const client = new PersonalGithubClient('alice', { request });
    await assert.rejects(client.authenticate(ui.ui), (error) => error instanceof PersonalGithubError && error.code === code && error.phase === 'auth-read' && error.repositoryState === 'not-created' && error.status === status && cleanError(error));
    assert.equal(requests, 1); assert.deepEqual(ui.events, []); assert.equal(f.saves.length, 0); assert.ok(f.reads.every(zeroed));
  });
  await t.test('401 permits explicit correction but never automatic enrollment', async (t) => {
    const f = sessionFixture(t), ui = scripted(['0']); let requests = 0;
    const request = injectedRequest((_options, listener) => { requests++; injectedResponse(listener, 401, 'response-secret'); });
    assert.equal(await new PersonalGithubClient('alice', { request }).authenticate(ui.ui), false);
    assert.equal(requests, 1); assert.deepEqual(ui.events, ['prompt']); assert.equal(f.saves.length, 0);
  });
});

test('native GET retry is opt-in, reports a typed unavailable error and preserves the same actor/token without new enrollment', async (t) => {
  const f = sessionFixture(t), ui = scripted(), phases = [], requests = []; let decisions = 0, checks = 0;
  const request = injectedRequest((options, listener, outgoing) => {
    requests.push([options.method, options.path]);
    if (requests.length === 1) outgoing.emit('error', new Error('raw-network-secret'));
    else injectedResponse(listener, 200, '{"login":"Alice"}');
  });
  const client = new PersonalGithubClient('alice', { request, onProgress: (event) => phases.push(event), recovery: async (error) => {
    decisions++; assert.equal(error.code, 'unavailable'); assert.equal(error.phase, 'auth-read'); assert.equal(error.status, undefined); cleanError(error); return true;
  } });
  assert.equal(await client.authenticate(ui.ui, async () => { checks++; }), true);
  assert.deepEqual(requests, [['GET', '/user'], ['GET', '/user']]); assert.equal(decisions, 1); assert.ok(checks >= 4);
  assert.deepEqual(phases.map((event) => [event.phase, event.kind]), [['auth-read', 'start'], ['auth-read', 'start'], ['auth-read', 'verified']]);
  assert.deepEqual(ui.events, []); assert.equal(f.saves.length, 0); assert.ok(f.reads.every(zeroed));
});

test('staged token survives only its explicit GET retry and is zeroized after save, decline, cancellation or changed retry context', async (t) => {
  for (const outcome of ['save', 'decline', 'cancel', 'stored-change', 'staged-change', 'session-change', 'context-change']) await t.test(`staged retry ${outcome}`, async (t) => {
    const f = sessionFixture(t); f.replace(undefined);
    const ui = scripted(outcome === 'save' ? ['1', 'y'] : ['1'], REPLACEMENT); let requests = 0, policies = 0, contextChanged = false;
    const request = injectedRequest((_options, listener) => { requests++; injectedResponse(listener, requests === 1 ? 503 : 200, requests === 1 ? 'response-secret' : '{"login":"alice"}'); });
    const client = new PersonalGithubClient('alice', { request, recovery: async (error) => {
      policies++; assert.equal(error.code, 'unavailable'); assert.equal(error.phase, 'auth-read'); assert.equal(error.status, 503);
      assert.equal(zeroed(ui.secret), false); assert.equal(f.saves.length, 0);
      if (outcome === 'cancel') throw new Cancelled('retry cancelled');
      if (outcome === 'stored-change') f.replace(TOKEN);
      if (outcome === 'staged-change') ui.secret.fill(0);
      if (outcome === 'session-change') setSession({ ...f.session });
      if (outcome === 'context-change') contextChanged = true;
      return outcome !== 'decline';
    } });
    const pending = client.authenticate(ui.ui, async () => { if (contextChanged) throw new Cancelled('profile changed'); });
    if (outcome === 'save') assert.equal(await pending, true);
    else await assert.rejects(pending, (error) => (outcome === 'cancel' || outcome === 'context-change' ? error instanceof Cancelled : error instanceof PersonalGithubError) && cleanError(error));
    assert.equal(requests, outcome === 'save' ? 2 : 1); assert.equal(policies, 1); assert.equal(f.saves.length, outcome === 'save' ? 1 : 0);
    assert.ok(zeroed(ui.secret)); assert.ok(f.reads.every(zeroed)); assert.ok(f.saves.every(zeroed));
    assert.deepEqual(ui.events, outcome === 'save' ? ['prompt', 'secret', 'prompt'] : ['prompt', 'secret']);
  });
});

test('stored-token retry rechecks the original session, digest and caller context before and after the recovery decision', async (t) => {
  for (const change of ['token-before-policy', 'token-in-policy', 'session-in-policy', 'context-in-policy']) await t.test(change, async (t) => {
    const f = sessionFixture(t), ui = scripted(); let requests = 0, policies = 0, contextChanged = false;
    const request = injectedRequest((_options, listener) => {
      requests++; if (change === 'token-before-policy') f.replace(REPLACEMENT); injectedResponse(listener, 503, 'response-secret');
    });
    const client = new PersonalGithubClient('alice', { request, recovery: async () => {
      policies++;
      if (change === 'token-in-policy') f.replace(REPLACEMENT);
      if (change === 'session-in-policy') setSession({ ...f.session });
      if (change === 'context-in-policy') contextChanged = true;
      return true;
    } });
    await assert.rejects(client.authenticate(ui.ui, async () => { if (contextChanged) throw new Cancelled('local profile changed'); }), (error) =>
      change === 'context-in-policy' ? error instanceof Cancelled : error instanceof PersonalGithubError && error.code === (change === 'session-in-policy' ? 'session' : 'pin'));
    assert.equal(requests, 1); assert.equal(policies, change === 'token-before-policy' ? 0 : 1); assert.equal(f.saves.length, 0); assert.deepEqual(ui.events, []); assert.ok(f.reads.every(zeroed));
  });
});

test('prewrite actor GET total timeout retries only the read, retains authentication and runs the final beforeWrite guard after retry', async (t) => {
  const f = sessionFixture(t), calls = [], guards = [], progress = []; let policies = 0, timedOut;
  const waiting = new Promise((resolve) => { timedOut = resolve; });
  const request = injectedRequest((options, listener) => {
    calls.push([options.method, options.path]);
    if (calls.length === 2) { timedOut(); return; }
    injectedResponse(listener, options.method === 'POST' ? 201 : 200, options.path === '/user' ? '{"login":"alice"}' : JSON.stringify(repo()));
  });
  const client = new PersonalGithubClient('alice', { request, onProgress: (event) => progress.push([event.phase, event.kind]), recovery: async (error) => {
    policies++; assert.equal(error.code, 'unavailable'); assert.equal(error.phase, 'prewrite-read'); assert.equal(error.repositoryState, 'not-created'); return true;
  } });
  assert.equal(await client.authenticate(scripted().ui), true);
  t.mock.timers.enable({ apis: ['setTimeout'] }); let notifications = 0;
  const pending = client.createRepository('alice', 'demo', 'private', () => { notifications++; }, async () => guards.push(calls.length));
  await waiting; t.mock.timers.tick(30_001);
  const created = await pending;
  assert.equal(created.httpsUrl, 'https://github.com/Alice/Demo.git'); assert.equal(policies, 1); assert.equal(notifications, 1);
  assert.deepEqual(calls, [['GET', '/user'], ['GET', '/user'], ['GET', '/user'], ['POST', '/user/repos'], ['GET', '/repos/alice/demo']]);
  assert.deepEqual(guards, [2, 2, 3]); assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
  assert.deepEqual(progress.slice(-4), [['create-write', 'sent'], ['create-write', 'created'], ['verification-read', 'start'], ['verification-read', 'verified']]); assert.ok(f.reads.every(zeroed));
});

test('beforeWrite guard after a recovered actor read blocks POST if local context or token changed', async (t) => {
  for (const fault of ['token', 'cancel']) await t.test(`recovered prewrite ${fault}`, async (t) => {
    const f = sessionFixture(t), calls = []; let decisions = 0, finalGuard = 0;
    const request = injectedRequest((options, listener) => {
      calls.push([options.method, options.path]); injectedResponse(listener, calls.length === 2 ? 503 : 200, calls.length === 2 ? 'response-secret' : '{"login":"alice"}');
    });
    const client = new PersonalGithubClient('alice', { request, recovery: async () => { decisions++; return true; } });
    assert.equal(await client.authenticate(scripted().ui), true);
    await assert.rejects(client.createRepository('alice', 'demo', 'private', undefined, async () => {
      if (calls.length !== 3) return; finalGuard++;
      if (fault === 'token') f.replace(REPLACEMENT); else throw new Cancelled('final local guard cancelled');
    }), (error) => fault === 'cancel' ? error instanceof Cancelled && error.warning === false : error instanceof PersonalGithubError && error.code === 'pin');
    assert.equal(decisions, 1); assert.equal(finalGuard, 1); assert.equal(calls.length, 3); assert.equal(calls.some(([method]) => method === 'POST'), false);
  });
});

test('201 followed by a verification timeout permits only explicit GET retry and exactly one POST/creation callback', async (t) => {
  const f = sessionFixture(t), calls = []; let timeoutReady, notifications = 0, decisions = 0;
  const waiting = new Promise((resolve) => { timeoutReady = resolve; });
  const request = injectedRequest((options, listener) => {
    calls.push([options.method, options.path]);
    if (calls.length === 4) { timeoutReady(); return; }
    injectedResponse(listener, options.method === 'POST' ? 201 : 200, options.path === '/user' ? '{"login":"alice"}' : JSON.stringify(repo()));
  });
  const client = new PersonalGithubClient('alice', { request, recovery: async (error) => {
    decisions++; assert.equal(error.code, 'unavailable'); assert.equal(error.phase, 'verification-read'); assert.equal(error.repositoryState, 'created'); assert.equal(error.repositoryUrl, RECOVERY_URL); return true;
  } });
  assert.equal(await client.authenticate(scripted().ui), true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = client.createRepository('alice', 'demo', 'private', () => { notifications++; });
  await waiting; t.mock.timers.tick(30_001); await pending;
  assert.equal(decisions, 1); assert.equal(notifications, 1); assert.deepEqual(calls.slice(-2), [['GET', '/repos/alice/demo'], ['GET', '/repos/alice/demo']]);
  assert.equal(calls.filter(([method]) => method === 'POST').length, 1); assert.ok(f.reads.every(zeroed));
});

test('POST failures and invalid 201 bodies never consult the read retry policy; unknown/created inspection is a separate pinned GET', async (t) => {
  for (const fault of ['disconnect', '500', 'invalid-201']) await t.test(`no POST replay ${fault}`, async (t) => {
    sessionFixture(t); const calls = []; let decisions = 0, notifications = 0, inspectExists = false;
    const request = injectedRequest((options, listener, outgoing) => {
      calls.push([options.method, options.path]);
      if (options.path === '/user') injectedResponse(listener, 200, '{"login":"alice"}');
      else if (options.method === 'POST') {
        if (fault === 'disconnect') outgoing.emit('error', new Error('raw-network-secret'));
        else injectedResponse(listener, fault === '500' ? 500 : 201, 'response-secret');
      } else injectedResponse(listener, inspectExists ? 200 : 404, inspectExists ? JSON.stringify(repo()) : 'response-secret');
    });
    const client = new PersonalGithubClient('alice', { request, recovery: async () => { decisions++; return true; } });
    assert.equal(await client.authenticate(scripted().ui), true);
    await assert.rejects(client.createRepository('alice', 'demo', 'private', () => { notifications++; }), (error) => error instanceof PersonalGithubError && error.repositoryState === (fault === 'invalid-201' ? 'created' : 'unknown') && error.phase === 'create-write' && cleanError(error));
    assert.equal(decisions, 0); assert.equal(notifications, fault === 'invalid-201' ? 1 : 0);
    await assert.rejects(client.inspectRepository('alice', 'demo', 'private'), (error) => error instanceof PersonalGithubError && error.code === 'not-found' && error.status === 404 && error.repositoryState === 'unknown' && error.phase === 'verification-read');
    inspectExists = true;
    const checked = await client.inspectRepository('alice', 'demo', 'private'); assert.equal(checked.httpsUrl, 'https://github.com/Alice/Demo.git');
    assert.equal(calls.filter(([method]) => method === 'POST').length, 1); assert.deepEqual(calls.slice(-2), [['GET', '/repos/alice/demo'], ['GET', '/repos/alice/demo']]);
    assert.equal(decisions, 0);
  });
});

test('session, debug and terminal typed guards are preserved rather than flattened into unavailable or enrollment', async (t) => {
  for (const code of ['session', 'debug', 'terminal', 'pin', 'protocol']) await t.test(`typed ${code} guard`, async (t) => {
    const f = sessionFixture(t), ui = scripted(); let policies = 0, requests = 0;
    const client = new PersonalGithubClient('alice', { request: () => {
      requests++; throw new PersonalGithubError('controlled guard fixture', { code, phase: 'auth-read' });
    }, recovery: async () => { policies++; return true; } });
    await assert.rejects(client.authenticate(ui.ui), (error) => error instanceof PersonalGithubError && error.code === code && error.phase === 'auth-read' && error.repositoryState === 'not-created' && cleanError(error));
    assert.equal(requests, 1); assert.equal(policies, 0); assert.equal(f.saves.length, 0); assert.deepEqual(ui.events, []);
  });
});

test('ordinary authentication cancellation never invokes recovery or asks for a replacement token', async (t) => {
  const f = sessionFixture(t), ui = scripted(); let policies = 0, requests = 0;
  const request = injectedRequest(() => { requests++; process.emit('SIGINT'); });
  const client = new PersonalGithubClient('alice', { request, recovery: async () => { policies++; return true; } });
  await assert.rejects(client.authenticate(ui.ui), (error) => error instanceof Cancelled && error.warning === false);
  assert.equal(requests, 1); assert.equal(policies, 0); assert.deepEqual(ui.events, []); assert.equal(f.saves.length, 0); assert.ok(f.reads.every(zeroed));
});
