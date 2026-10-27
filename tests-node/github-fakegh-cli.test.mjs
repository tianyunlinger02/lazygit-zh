import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createScratch } from '../scripts/scratch.mjs';
const root = process.env.AUTOGIT_GITHUB_TEST_MODULE_DIR ?? new URL('../dist/', import.meta.url).href;
const { GithubClient } = await import(new URL('github.js', root));
const { repositoryContext } = await import(new URL('github.js', root));

test('real runProcess fake-gh CLI validates explicit host, argv, shell:false and no token use', async t => {
  const { directory: base, cleanup } = await createScratch('github-fakegh-');
  t.after(cleanup);
  const bin = join(base, 'bin'), log = join(base, 'calls.jsonl'); await mkdir(bin);
  const gh = join(bin, 'gh'); await writeFile(join(bin, 'package.json'), '{"type":"commonjs"}');
  await writeFile(gh, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({args, host:process.env.GH_HOST, token:process.env.GH_TOKEN, shell:process.env.GH_SHELL})+'\\n');
if (args[0] === 'api' && args[5] === 'user') process.stdout.write('alice\\n');
else if (args[0] === 'repo' && args[1] === 'create') process.stdout.write('created output ignored\\n');
else if (args[0] === 'api' && args[5].startsWith('repos/')) process.stdout.write(JSON.stringify({owner:{login:'acme'},name:'demo',full_name:'acme/demo',private:true,html_url:'https://git.example.invalid/acme/demo',ssh_url:'git@git.example.invalid:acme/demo.git',clone_url:'https://git.example.invalid/acme/demo.git'}));
else if (args[0] === 'api') process.stdout.write(JSON.stringify({ok:true}));
else process.exitCode=9;
`);
  await chmod(gh, 0o700);
  const env = { PATH: bin, HOME: join(base, 'home'), FAKE_GH_LOG: log };
  const client = new GithubClient(base, { host: 'git.example.invalid', actor: 'alice', owner: 'acme', env });
  const created = await client.createRepository('acme', 'demo', 'private');
  assert.equal(created.htmlUrl, 'https://git.example.invalid/acme/demo');
  const context = repositoryContext('git.example.invalid', 'acme', 'demo');
  const { updateRepository } = await import(new URL('github-repositories.js', root));
  await updateRepository(client, context, { private: false });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.length >= 4);
  assert.ok(calls.every(call => call.host === 'git.example.invalid' && call.token === undefined));
  assert.ok(calls.every(call => call.args[0] !== 'auth' && call.args.every(arg => !String(arg).includes('shell'))));
  assert.deepEqual(calls.find(call => call.args[0] === 'repo').args, ['repo', 'create', 'acme/demo', '--private']);
  assert.equal(calls.find(call => call.args[4] === 'PATCH').args[5], 'repos/acme/demo');
});
