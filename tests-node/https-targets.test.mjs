import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { createScratch } from '../scripts/scratch.mjs';
const root = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { Git } = await import(new URL('git.js', root));
const { Vault } = await import(new URL('vault.js', root));
const { CredentialSession, setSession } = await import(new URL('session.js', root));
const { Profile, ProfileStore } = await import(new URL('profiles.js', root));
const { DEFAULT_HOST } = await import(new URL('hosts.js', root));
const { resetAppContextForTests } = await import(new URL('app-context.js', root));
const { Console } = await import(new URL('ui.js', root));
const { tagsMenu } = await import(new URL('releases.js', root));
const HTTPS = { mode: 'https', host: DEFAULT_HOST };
const TOKEN = 'synthetic_child_specific_token';
const PARENT_TOKEN = 'synthetic_parent_only_token';
const nativeTest = process.platform === 'win32' ? { skip: 'requires native ACL helper on Windows' } : {};

function ui(answers = [], { quick = true } = {}) {
  const pending = [...answers], messages = [];
  const console = new Console((prompt) => { messages.push(prompt); assert.ok(pending.length, `unexpected prompt: ${prompt}`); return pending.shift(); }, (message) => messages.push(message), { quick });
  return Object.assign(console, { messages, pending });
}
async function fixture(t) {
  const scratch = await createScratch('ht-'), data = join(scratch.directory, 'data'), home = join(scratch.directory, 'home'); await fs.mkdir(home);
  const saved = process.env; process.env = { PATH: saved.PATH, HOME: home, USERPROFILE: home, AUTOGIT_DATA_DIR: data, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' }; resetAppContextForTests();
  const { vault } = await Vault.create(data, Buffer.from('synthetic-password'));
  const session = new CredentialSession(vault); setSession(session);
  t.after(async () => { await session.close(); setSession(undefined); resetAppContextForTests(); process.env = saved; await scratch.cleanup(); });
  const directory = join(scratch.directory, 'repo'); await fs.mkdir(directory); const git = new Git(directory);
  await git.run(['init', '--initial-branch=main']); await git.run(['config', 'user.name', 'Fixture']); await git.run(['config', 'user.email', 'fixture@example.invalid']); await git.run(['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(join(directory, 'file.txt'), 'synthetic data'); await git.run(['add', '.']); await git.run(['commit', '-m', 'fixture']);
  const store = new ProfileStore(data);
  async function profile(id, account, label) {
    const folder = join(data, 'profiles', id), privateKey = join(folder, 'id_ed25519'); await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    await fs.writeFile(privateKey, 'NONSECRET TEST MARKER', { mode: 0o600 }); await fs.writeFile(`${privateKey}.pub`, 'NONSECRET PUBLIC KEY', { mode: 0o600 });
    const value = new Profile({ profile_id: id, label, name: label, email: `${account}@example.invalid`, github_login: account, private_key: privateKey, public_key: `${privateKey}.pub` });
    await fs.writeFile(join(folder, 'profile.json'), JSON.stringify(store.encodeProfile(value)), { mode: 0o600 }); return value;
  }
  const parent = await profile('a'.repeat(32), 'parent', 'A parent'), child = await profile('b'.repeat(32), 'child', 'B child');
  await session.storeToken('github.com', 'parent', Buffer.from(PARENT_TOKEN)); await session.storeToken('github.com', 'child', Buffer.from(TOKEN));
  await git.run(['remote', 'add', 'origin', 'https://github.com/unrelated/origin.git']);
  return { base: scratch.directory, data, directory, git, session, parent, child, store };
}
async function fill(git, path, account = 'child', check = true) {
  return git.run(['credential', 'fill'], { check, inputData: Buffer.from(`protocol=https\nhost=github.com\npath=${path}\nusername=${account}\n\n`) });
}
async function assertScope(git, expected, wrong = 'unrelated/origin.git') {
  const found = await fill(git, expected); assert.equal(found.stdout.includes(Buffer.from(TOKEN)), true); assert.equal(found.stdout.includes(Buffer.from(PARENT_TOKEN)), false); found.stdout.fill(0);
  const denied = await fill(git, wrong, 'child', false); assert.notEqual(denied.status, 0); assert.equal(denied.stdout.includes(Buffer.from(TOKEN)), false); assert.equal(denied.stdout.includes(Buffer.from(PARENT_TOKEN)), false);
}

function workflowSession(f) {
  return { directory: f.directory, profile: f.child, host: 'github.com', transport: HTTPS, checkProfile: async () => {}, client: { host: 'github.com', async ensureActor() { return 'child'; } } };
}

test('release tag push scopes both profile contexts to selected release repository rather than origin', nativeTest, async (t) => {
  const f = await fixture(t); await f.git.run(['tag', 'v-test']); const selected = workflowSession(f), context = { host: 'github.com', owner: 'release-owner', name: 'release-repo' };
  const original = Git.prototype.run; let pushes = 0;
  Git.prototype.run = async function (args, options) {
    if (args[0] !== 'push') return original.call(this, args, options);
    pushes++; await assertScope(this, 'release-owner/release-repo.git');
    const remote = args[args.indexOf('--') + 1]; assert.equal(await this.config(`remote.${remote}.url`), 'https://github.com/release-owner/release-repo.git');
    return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  const menu = ui(['4', 'v-test', 'y', '0']);
  try { await tagsMenu(menu, selected, context); }
  finally { Git.prototype.run = original; }
  assert.equal(pushes, 1, menu.messages.join('\n')); assert.equal(await f.git.config('remote.origin.url'), 'https://github.com/unrelated/origin.git');
});
