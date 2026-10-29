import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const root = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { PersonalGithubClient, PersonalGithubError } = await import(new URL('github-personal.js', root));
const { CredentialPin, CredentialPinError } = await import(new URL('credential-pin.js', root));
const { currentSession, setSession } = await import(new URL('session.js', root));
const { Console } = await import(new URL('ui.js', root));
const TOKEN = 'synthetic_pin_token_never_real', REPLACEMENT = 'synthetic_pin_replacement_never_real';
const zeroed = (buffer) => buffer.every((byte) => byte === 0);

async function fixture(t) {
  const previous = currentSession(), reads = [], cleanups = []; let stored = Buffer.from(TOKEN), requests = 0;
  const session = {
    closed: false,
    async getToken(host, account) {
      assert.equal(host, 'github.com'); assert.equal(account.toLowerCase(), 'alice');
      const token = stored === undefined ? undefined : Buffer.from(stored); if (token) reads.push(token); return token;
    },
    onClose(cleanup) { cleanups.push(cleanup); },
  };
  setSession(session);
  t.after(async () => { session.closed = true; for (const cleanup of cleanups) await cleanup(); stored?.fill(0); setSession(previous); });
  const request = (_options, listener) => {
    const outgoing = new EventEmitter(); outgoing.destroy = () => outgoing;
    outgoing.end = () => queueMicrotask(() => {
      requests++; const response = new PassThrough(); response.statusCode = 200; response.headers = {}; response.complete = true;
      listener(response); if (!response.destroyed) response.end('{"login":"Alice"}');
    });
    return outgoing;
  };
  const client = new PersonalGithubClient('Alice', { request });
  const ui = new Console(() => { throw new Error('unexpected credential enrollment'); }, () => {}, { quick: false });
  assert.throws(() => client.credentialPin(), (error) => error instanceof PersonalGithubError && error.code === 'unverified');
  assert.equal(await client.authenticate(ui), true);
  return {
    client, session, reads, cleanups, requests: () => requests,
    replace(value) { stored?.fill(0); stored = value === undefined ? undefined : Buffer.from(value); },
  };
}

test('credential proof is opaque, ephemeral and issued without a second API GET only after explicit client authentication', async (t) => {
  const f = await fixture(t), pin = f.client.credentialPin();
  assert.ok(pin instanceof CredentialPin); assert.equal(pin.host, 'github.com'); assert.equal(pin.account, 'Alice'); assert.equal(f.requests(), 1);
  assert.deepEqual(Object.keys(pin).sort(), ['account', 'host']); assert.equal(Object.isFrozen(pin), true);
  assert.doesNotMatch(JSON.stringify(pin), /synthetic_|digest|session/iu);
  await pin.assertCurrent(); assert.equal(f.requests(), 1); assert.ok(f.reads.every(zeroed));
  const token = Buffer.from(TOKEN);
  try { pin.assertToken(f.session, token); assert.equal(zeroed(token), false); }
  finally { token.fill(0); }
});

test('credential proof compares the exact provided buffer and never accepts replacement bytes for the same actor', async (t) => {
  const f = await fixture(t), pin = f.client.credentialPin(), changed = Buffer.from(REPLACEMENT), original = Buffer.from(TOKEN);
  try {
    assert.throws(() => pin.assertToken(f.session, changed), (error) => error instanceof CredentialPinError && error.code === 'pin' && error.cause === undefined && !error.message.includes(REPLACEMENT));
    f.replace(REPLACEMENT);
    await assert.rejects(pin.assertCurrent(), (error) => error instanceof CredentialPinError && error.code === 'pin');
    // The synchronous method validates its own argument, not a separate read of the vault.
    pin.assertToken(f.session, original);
    assert.ok(f.reads.every(zeroed)); assert.equal(f.requests(), 1);
  } finally { original.fill(0); changed.fill(0); }
});

test('credential proof checks current-session identity before and after a pending vault read and clears fetched buffers on failure', async (t) => {
  const f = await fixture(t), pin = f.client.credentialPin(); let release, entered;
  const fetched = Buffer.from(TOKEN), began = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  f.session.getToken = async () => { entered(); await gate; return fetched; };
  const pending = pin.assertCurrent(); const rejected = assert.rejects(pending, (error) => error instanceof CredentialPinError && error.code === 'session');
  await began; setSession({ ...f.session }); release(); await rejected;
  assert.ok(zeroed(fetched));
  const token = Buffer.from(TOKEN);
  try { assert.throws(() => pin.assertToken(f.session, token), (error) => error instanceof CredentialPinError && error.code === 'session'); }
  finally { token.fill(0); }
});

test('credential proof rejects missing tokens, foreign sessions and malformed buffers without exposing raw vault failures', async (t) => {
  const f = await fixture(t), pin = f.client.credentialPin(), token = Buffer.from(TOKEN);
  try {
    assert.throws(() => pin.assertToken({ ...f.session }, token), (error) => error instanceof CredentialPinError && error.code === 'session');
    for (const value of [undefined, '', Buffer.alloc(0)]) assert.throws(() => pin.assertToken(f.session, value), CredentialPinError);
    f.replace(undefined); await assert.rejects(pin.assertCurrent(), (error) => error instanceof CredentialPinError && error.code === 'pin');
    f.session.getToken = async () => { throw new Error('synthetic_raw_vault_secret'); };
    await assert.rejects(pin.assertCurrent(), (error) => error instanceof CredentialPinError && error.cause === undefined && !error.message.includes('synthetic_raw_vault_secret'));
  } finally { token.fill(0); }
});

test('proof disposal, session close and client task disposal fail closed and never fetch credentials afterward', async (t) => {
  const f = await fixture(t), pin = f.client.credentialPin(), sibling = f.client.credentialPin();
  const disposal = pin.dispose(); assert.equal(pin.dispose(), disposal); await disposal; const readsBefore = f.reads.length;
  await assert.rejects(pin.assertCurrent(), (error) => error instanceof CredentialPinError && error.code === 'pin'); assert.equal(f.reads.length, readsBefore);
  await sibling.assertCurrent();
  const clientDisposal = f.client.dispose(); assert.equal(f.client.dispose(), clientDisposal); await clientDisposal;
  await assert.rejects(sibling.assertCurrent(), CredentialPinError);
  assert.throws(() => f.client.credentialPin(), (error) => error instanceof PersonalGithubError && error.code === 'pin');
  await assert.rejects(f.client.currentLogin(), (error) => error instanceof PersonalGithubError && error.code === 'pin');
  await assert.rejects(f.client.inspectRepository('Alice', 'demo', 'private'), (error) => error instanceof PersonalGithubError && error.code === 'pin');
  assert.equal(f.requests(), 1); assert.ok(f.reads.every(zeroed));
});

test('session close invalidates a proof and a fresh explicit authentication invalidates prior proof identities', async (t) => {
  const f = await fixture(t), old = f.client.credentialPin();
  const ui = new Console(() => { throw new Error('unexpected enrollment'); }, () => {}, { quick: false });
  assert.equal(await f.client.authenticate(ui), true);
  await assert.rejects(old.assertCurrent(), (error) => error instanceof CredentialPinError && error.code === 'pin');
  const fresh = f.client.credentialPin(); assert.notEqual(fresh, old); await fresh.assertCurrent();
  f.session.closed = true; for (const cleanup of f.cleanups) await cleanup();
  await assert.rejects(fresh.assertCurrent(), CredentialPinError); assert.equal(f.requests(), 2); assert.ok(f.reads.every(zeroed));
});

test('proof disposal invalidates synchronously and awaits registered resource cleanups exactly once', async (t) => {
  const f = await fixture(t), pin = f.client.credentialPin(); let release, entered, cleanups = 0;
  const began = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  const remove = pin.onDispose(async () => { throw new Error('removed cleanup must not run'); }); remove();
  pin.onDispose(async () => { cleanups++; entered(); await gate; });
  const disposal = pin.dispose(); assert.equal(pin.dispose(), disposal);
  await assert.rejects(pin.assertCurrent(), (error) => error instanceof CredentialPinError && error.code === 'pin');
  assert.throws(() => pin.onDispose(async () => {}), CredentialPinError);
  await began; let settled = false; void disposal.then(() => { settled = true; }); await Promise.resolve();
  assert.equal(settled, false); assert.equal(cleanups, 1); release(); await disposal;
  assert.equal(settled, true); assert.equal(cleanups, 1); assert.equal(f.session.closed, false);
});
