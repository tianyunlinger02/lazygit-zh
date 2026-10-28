import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, readdir, cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Console, Cancelled, EndOfInput } from '../dist/ui.js';
import { currentSession, CredentialSession, setSession, unlockSession, readNewPassword } from '../dist/session.js';
import { Vault, VaultUnlockError } from '../dist/vault.js';
import { createScratch } from '../scripts/scratch.mjs';

const PASSWORD = 'synthetic-autogit-password';
const NEXT_PASSWORD = 'synthetic-new-autogit-password';
const zeroed = value => value.every(byte => byte === 0);
function loginUi(answers = [], values = []) {
  const pending = [...answers], remaining = [...values], messages = [], secrets = [], secretPrompts = [];
  const ui = new Console(prompt => {
    messages.push(prompt);
    assert.ok(pending.length, `unexpected interactive question: ${prompt}`);
    const value = pending.shift(); if (value instanceof Error) throw value; return value;
  }, message => messages.push(message), {
    secretInput: async prompt => {
      secretPrompts.push(prompt);
      assert.ok(remaining.length, `unexpected secret question: ${prompt}`);
      const value = remaining.shift(); if (value instanceof Error) throw value;
      const secret = Buffer.isBuffer(value) ? value : Buffer.from(value); secrets.push(secret); return secret;
    },
  });
  return { ui, pending, remaining, messages, secrets, secretPrompts };
}
async function fixture(t) {
  const scratch = await createScratch('login-session-');
  await currentSession()?.close(); setSession(undefined);
  t.after(async () => { await currentSession()?.close(); setSession(undefined); await scratch.cleanup(); });
  return { base: scratch.directory, directory: join(scratch.directory, 'private data') };
}
async function create(directory) {
  const password = Buffer.from(PASSWORD);
  try { return await Vault.create(directory, password); } finally { password.fill(0); }
}
function recoveredCode(messages) {
  const match = messages.join('\n').match(/[a-f0-9]{8}(?:-[a-f0-9]{8}){7}/u);
  assert.ok(match, 'recovery code is displayed exactly for offline acknowledgement'); return match[0];
}

test('missing vaults are never created unless initialization is explicitly allowed', async t => {
  const f = await fixture(t), input = loginUi();
  await assert.rejects(unlockSession(input.ui, f.directory), /不会自动创建/u);
  await assert.rejects(stat(f.directory), { code: 'ENOENT' });
  assert.deepEqual(input.secretPrompts, []); assert.equal(currentSession(), undefined);
});

test('creation confirms an independent password before touching storage and returns an active vault-only session', async t => {
  const f = await fixture(t), messages = [], entered = []; let reads = 0;
  const ui = new Console(() => 'y', text => messages.push(text), {
    secretInput: async () => {
      await assert.rejects(stat(f.directory), { code: 'ENOENT' });
      reads++; const value = Buffer.from(PASSWORD); entered.push(value); return value;
    },
  });
  const session = await unlockSession(ui, f.directory, { allowCreate: true });
  assert.equal(reads, 2); assert.equal(currentSession(), session); assert.ok(session instanceof CredentialSession);
  assert.equal(Object.hasOwn(session, 'identity'), false); assert.ok(entered.every(zeroed));
  const bytes = await readFile(join(f.directory, 'vault.json'));
  assert.equal(bytes.includes(Buffer.from(PASSWORD)), false);
  assert.equal(bytes.includes(Buffer.from(recoveredCode(messages))), false);
  await session.storeToken('git.example.invalid', 'synthetic', Buffer.from('synthetic-token'));
  const token = await session.getToken('git.example.invalid', 'synthetic');
  try { assert.equal(token.toString(), 'synthetic-token'); } finally { token.fill(0); }
  await session.close(); assert.equal(currentSession(), undefined);
  await assert.rejects(session.vault.get('absent'), /已关闭/u);
});

test('new-password validation and mismatched confirmation loop locally, clear rejected Buffers and create nothing on cancellation', async t => {
  const f = await fixture(t), input = loginUi([], ['', 'short', '😀'.repeat(11), PASSWORD, NEXT_PASSWORD, new Cancelled()]);
  await assert.rejects(unlockSession(input.ui, f.directory, { allowCreate: true }), Cancelled);
  assert.match(input.messages.join('\n'), /至少 12 个 Unicode 字符/u);
  assert.match(input.messages.join('\n'), /两次密码不一致/u);
  assert.ok(input.secrets.every(zeroed)); assert.equal(input.remaining.length, 0);
  await assert.rejects(stat(f.directory), { code: 'ENOENT' }); assert.equal(currentSession(), undefined);
  const eof = loginUi([], [PASSWORD, new EndOfInput()]);
  await assert.rejects(unlockSession(eof.ui, f.directory, { allowCreate: true }), EndOfInput);
  assert.ok(eof.secrets.every(zeroed)); await assert.rejects(stat(f.directory), { code: 'ENOENT' });
});

test('readNewPassword preserves spaces, Unicode normalization and literal :q and returns only the caller-owned Buffer', async () => {
  const exact = ' :q é😀 password ', input = loginUi([], ['short', PASSWORD, NEXT_PASSWORD, exact, exact]);
  const result = await readNewPassword(input.ui);
  try {
    assert.equal(result.toString(), exact); assert.notEqual(result.toString(), exact.normalize('NFC'));
    assert.equal(input.secrets.at(-2), result);
    assert.ok(input.secrets.filter(value => value !== result).every(zeroed));
  } finally { result.fill(0); }
});

test('existing vault retry choice can succeed, clears all attempts and never displays a new recovery code', async t => {
  const f = await fixture(t), first = await create(f.directory); first.vault.close();
  const input = loginUi(['1'], ['synthetic-wrong-password', PASSWORD]);
  const session = await unlockSession(input.ui, f.directory);
  assert.equal(currentSession(), session); assert.equal(input.secretPrompts.length, 2);
  assert.ok(input.secrets.every(zeroed)); assert.deepEqual(input.pending, []);
  assert.doesNotMatch(input.messages.join('\n'), /请离线保存恢复码|系统用户|系统密码已通过/u);
});

test('three failed passwords allow only explicit recovery or exit, never a fourth password or any store mutation', async t => {
  const f = await fixture(t), first = await create(f.directory); first.vault.close();
  const file = join(f.directory, 'vault.json'), bytes = await readFile(file), before = await stat(f.directory);
  const input = loginUi(['1', '1', '0'], ['wrong-password-one', 'wrong-password-two', 'wrong-password-three']);
  await assert.rejects(unlockSession(input.ui, f.directory), Cancelled);
  assert.equal(input.secretPrompts.length, 3); assert.equal(input.remaining.length, 0);
  assert.match(input.messages.join('\n'), /三次/u); assert.equal(currentSession(), undefined);
  assert.ok(input.secrets.every(zeroed)); assert.deepEqual(await readFile(file), bytes);
  const after = await stat(f.directory); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs);
  assert.deepEqual(await readdir(f.directory), ['vault.json']);
});

test('empty existing password offers forgotten-password recovery rather than an unlock retry or initialization', async t => {
  const f = await fixture(t), first = await create(f.directory); first.vault.close();
  const before = await readFile(join(f.directory, 'vault.json')), input = loginUi(['0'], ['']);
  await assert.rejects(unlockSession(input.ui, f.directory, { allowCreate: true }), Cancelled);
  assert.equal(input.secretPrompts.length, 1); assert.match(input.messages.join('\n'), /忘记 AutoGit/u);
  assert.deepEqual(await readFile(join(f.directory, 'vault.json')), before); assert.equal(currentSession(), undefined);
});

test('explicit offline recovery confirms a new password, preserves secrets and rotates the recovery code', async t => {
  const f = await fixture(t), first = await create(f.directory);
  await first.vault.put('synthetic', Buffer.from('synthetic-preserved-secret')); first.vault.close();
  const input = loginUi(['1', 'y'], ['', first.recoveryCode, NEXT_PASSWORD, NEXT_PASSWORD]);
  const session = await unlockSession(input.ui, f.directory);
  assert.equal(currentSession(), session); assert.ok(input.secrets.every(zeroed));
  const value = await session.vault.get('synthetic');
  try { assert.equal(value.toString(), 'synthetic-preserved-secret'); } finally { value.fill(0); }
  const code = recoveredCode(input.messages); assert.notEqual(code, first.recoveryCode);
  await assert.rejects(Vault.unlock(f.directory, Buffer.from(PASSWORD)), VaultUnlockError);
  await assert.rejects(Vault.recover(f.directory, first.recoveryCode, Buffer.from(PASSWORD)), VaultUnlockError);
  const reopened = await Vault.unlock(f.directory, Buffer.from(NEXT_PASSWORD)); reopened.close();
});

test('third password failure can recover explicitly without offering or reading another password attempt', async t => {
  const f = await fixture(t), first = await create(f.directory); first.vault.close();
  const input = loginUi(['1', '1', '1', 'y'], ['wrong-one', 'wrong-two', 'wrong-three', first.recoveryCode, NEXT_PASSWORD, NEXT_PASSWORD]);
  await unlockSession(input.ui, f.directory);
  assert.equal(input.secretPrompts.filter(prompt => prompt.startsWith('AutoGit 解锁密码')).length, 3);
  assert.equal(input.secretPrompts.filter(prompt => prompt === '离线恢复码：').length, 1);
  assert.ok(input.secrets.every(zeroed)); assert.deepEqual(input.pending, []); assert.deepEqual(input.remaining, []);
});

test('a wrong recovery code is read-only and cancellation before confirmed new password leaves the original store', async t => {
  const f = await fixture(t), first = await create(f.directory); first.vault.close();
  const file = join(f.directory, 'vault.json'), before = await readFile(file), info = await stat(f.directory);
  const wrong = loginUi(['1'], ['', 'aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa', NEXT_PASSWORD, NEXT_PASSWORD]);
  await assert.rejects(unlockSession(wrong.ui, f.directory), VaultUnlockError);
  assert.ok(wrong.secrets.every(zeroed)); assert.equal(currentSession(), undefined);
  assert.deepEqual(await readFile(file), before); assert.equal((await stat(f.directory)).mtimeMs, info.mtimeMs);
  const cancelled = loginUi(['1'], ['', first.recoveryCode, NEXT_PASSWORD, new Cancelled()]);
  await assert.rejects(unlockSession(cancelled.ui, f.directory), Cancelled);
  assert.ok(cancelled.secrets.every(zeroed)); assert.deepEqual(await readFile(file), before);
});

test('declining or cancelling recovery-code acknowledgement retains data but closes the created or recovered vault', async t => {
  const f = await fixture(t), initial = loginUi(['n'], [PASSWORD, PASSWORD]);
  await assert.rejects(unlockSession(initial.ui, f.directory, { allowCreate: true }), Cancelled);
  assert.equal(currentSession(), undefined); assert.ok(initial.secrets.every(zeroed));
  const code = recoveredCode(initial.messages), first = await Vault.unlock(f.directory, Buffer.from(PASSWORD));
  await first.put('synthetic', Buffer.from('synthetic-preserved-data')); first.close();
  const recovery = loginUi(['1', new Cancelled()], ['', code, NEXT_PASSWORD, NEXT_PASSWORD]);
  await assert.rejects(unlockSession(recovery.ui, f.directory), Cancelled);
  assert.equal(currentSession(), undefined); assert.ok(recovery.secrets.every(zeroed));
  const reopened = await Vault.unlock(f.directory, Buffer.from(NEXT_PASSWORD));
  const value = await reopened.get('synthetic');
  try { assert.equal(value.toString(), 'synthetic-preserved-data'); } finally { value.fill(0); reopened.close(); }
  assert.notEqual(recoveredCode(recovery.messages), code);
});

test('nonempty token-only or legacy data requires one explicit new-library confirmation, while empty data is silent', async t => {
  const f = await fixture(t), file = join(f.base, 'token-only', 'token.json');
  await mkdir(join(f.base, 'token-only'), { recursive: true, mode: 0o700 }); await writeFile(file, 'synthetic-token-only-data');
  const declined = loginUi(['n'], [PASSWORD, PASSWORD]);
  await assert.rejects(unlockSession(declined.ui, join(f.base, 'token-only'), { allowCreate: true }), Cancelled);
  assert.equal(declined.secretPrompts.length, 0); assert.equal(await readFile(file, 'utf8'), 'synthetic-token-only-data');
  const accepted = loginUi(['y', 'y'], [PASSWORD, PASSWORD]);
  const session = await unlockSession(accepted.ui, join(f.base, 'token-only'), { allowCreate: true });
  assert.equal(accepted.secretPrompts.length, 2); assert.ok(accepted.secrets.every(zeroed)); await session.close();
  const empty = join(f.base, 'empty-data'), emptyInput = loginUi(['y'], [PASSWORD, PASSWORD]);
  await mkdir(empty, { mode: 0o700 });
  const emptySession = await unlockSession(emptyInput.ui, empty, { allowCreate: true });
  assert.equal(emptyInput.messages.filter(value => value.includes('资料目录非空')).length, 0); await emptySession.close();
});

test('managed markers, including wrong IDs, malformed suffixes and orphaned profiles, prevent empty replacement vault creation', async t => {
  const f = await fixture(t), id = 'a'.repeat(32);
  for (const [name, marker] of [
    ['valid', `AUTOGIT-ENCRYPTED-SSH-1\nssh:${id}\n`],
    ['wrong-id', `AUTOGIT-ENCRYPTED-SSH-1\nssh:${'b'.repeat(32)}\n`],
    ['malformed', 'AUTOGIT-ENCRYPTED-SSH-1\nnot-a-reference\nextra\n'],
  ]) {
    const directory = join(f.base, name), folder = join(directory, 'profiles', id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, 'id_ed25519'); await writeFile(file, marker, { mode: 0o600 });
    const input = loginUi([], [PASSWORD, PASSWORD]);
    await assert.rejects(unlockSession(input.ui, directory, { allowCreate: true }), /vault\.json 缺失/u);
    await assert.rejects(stat(join(directory, 'vault.json')), { code: 'ENOENT' });
    assert.equal(await readFile(file, 'utf8'), marker); assert.deepEqual(input.secretPrompts, []);
    assert.equal(currentSession(), undefined);
  }
});

test('corrupt stores fail closed instead of offering password retries, recovery or replacement', async t => {
  const f = await fixture(t), first = await create(f.directory); first.vault.close();
  const file = join(f.directory, 'vault.json'); await writeFile(file, '{synthetic-corrupt');
  const input = loginUi([], [PASSWORD]);
  await assert.rejects(unlockSession(input.ui, f.directory, { allowCreate: true }), /结构|完整性/u);
  assert.deepEqual(input.pending, []); assert.equal(input.secretPrompts.length, 1); assert.ok(input.secrets.every(zeroed));
  assert.equal(await readFile(file, 'utf8'), '{synthetic-corrupt'); assert.equal(currentSession(), undefined);
});

test('a verified vault copy reopens without persisting a plaintext relocation key', async t => {
  const f = await fixture(t), original = join(f.base, 'original-data'), copied = join(f.base, 'copied-data');
  const result = await create(original);
  await result.vault.put('ssh:fixture', Buffer.from('fixture-private-key'));
  await cp(original, copied, { recursive: true, preserveTimestamps: true });
  const relocated = await result.vault.atDirectory(copied), value = await relocated.get('ssh:fixture');
  try { assert.equal(value.toString(), 'fixture-private-key'); } finally { value.fill(0); }
  assert.doesNotMatch(await readFile(join(copied, 'vault.json'), 'utf8'), /fixture-private-key|synthetic-autogit-password/u);
  relocated.close(); result.vault.close();
});
