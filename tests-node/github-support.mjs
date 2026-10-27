import assert from 'node:assert/strict';
export const root = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
export const github = await import(new URL('github.js', root));
export const repositories = await import(new URL('github-repositories.js', root));
export const prs = await import(new URL('pull-requests.js', root));
export const issues = await import(new URL('issues.js', root));
export const releases = await import(new URL('releases.js', root));
export const publicKeys = await import(new URL('public-key.js', root));
export const profiles = await import(new URL('profiles.js', root));
export const { Console, Cancelled } = await import(new URL('ui.js', root));
export const { Git, GitError } = await import(new URL('git.js', root));
export const { resetAppContextForTests } = await import(new URL('app-context.js', root));
export class ScriptedConsole extends Console {
  constructor(answers = [], { quick = false } = {}) {
    const pending = [...answers], messages = [];
    super((prompt) => { messages.push(prompt); assert.ok(pending.length, `missing scripted input: ${prompt}`); return pending.shift(); }, (message) => messages.push(message), { quick });
    this.messages = messages; this.answers = pending;
  }
  get transcript() { return this.messages.join('\n'); }
}
export const result = (value, status = 0, stderr = '') => ({ status, stdout: value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), stderr: Buffer.from(stderr) });
export function fixtureClient({ host = 'github.com', actor = 'alice', owner, handler = () => undefined } = {}) {
  const calls = [];
  const client = new github.GithubClient('/fixture/project', { host, actor, owner, env: { PATH: '/fixture/bin', HOME: '/fixture/home' }, which: () => '/fixture/gh', runProcess: async (program, args, options) => {
    const call = { program, args: [...args], options, body: options.inputData?.toString().startsWith('{') ? JSON.parse(options.inputData.toString()) : undefined };
    calls.push(call);
    if (args[0] === 'api' && args[5] === 'user') return result(`${actor}\n`);
    const answer = await handler(call, calls); if (answer !== undefined) return answer;
    if (args[0] === 'api' && args[4] !== 'GET') return result();
    throw new Error(`unexpected fixture command: ${JSON.stringify(args)}`);
  } });
  return { client, calls };
}
export const context = github.repositoryContext('github.com', 'acme', 'demo');
export const repoData = (owner = 'acme', name = 'demo') => ({ owner, name, private: true, description: 'fixture only', default_branch: 'main' });
export const prData = (number = 7) => ({ number, title: 'fixture PR', state: 'open', draft: false, author: 'alice', head: 'topic', base: 'main', merged: false });
export const issueData = (number = 4) => ({ number, title: 'fixture issue', state: 'open', author: 'alice', body: 'line one\nline two', labels: ['bug'], assignees: ['alice'] });
export const releaseData = (id = 12) => ({ id, tag: 'v0.5.0', name: 'fixture release', body: 'release body', draft: true, prerelease: false, published: null });
export function session(client, extra = {}) { return { client, profile: { github_login: 'alice', label: 'Fixture', public_key: '/fixture/key.pub' }, host: client.host, directory: '/fixture/project', checkProfile: async () => {}, ...extra }; }
