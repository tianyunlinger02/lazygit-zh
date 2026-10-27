import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Git, decodePath, encodePath } from '../dist/git.js';
import { commitSequence, conflictEntries, controlOperation, operationsMenu, operationState, resolveConflictFiles, startBisect, startCommitOperation, startCommitSequence, startRebase } from '../dist/operations.js';
import { fixture, ScriptedConsole } from './support.mjs';

async function initial(f) { await f.write(); await f.commit(); return await f.git.value('rev-parse', 'HEAD'); }
async function divergent(f) {
  const base = await initial(f); await f.git.run(['switch', '-c', 'topic']); await f.write('hello.txt', 'topic\n'); await f.commit('topic'); const topic = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['switch', 'main']); await f.write('hello.txt', 'main\n'); await f.commit('main'); return { base, topic, main: await f.git.value('rev-parse', 'HEAD') };
}
function changing(change) { const ui = new ScriptedConsole(['y']); const confirm = ui.confirm.bind(ui); ui.confirm = async (...args) => { const answer = await confirm(...args); if (answer) await change(); return answer; }; return ui; }

test('operationState distinguishes real marker shapes without changing Git.operation', async t => {
  const f = await fixture(t, { committed: true }); assert.equal((await operationState(f.git)).kind, 'none');
  const gitDir = await f.git.gitPath(''); const oid = await f.git.value('rev-parse', 'HEAD');
  for (const [marker, kind] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']]) {
    await writeFile(join(gitDir, marker), `${oid}\n`); assert.equal((await operationState(f.git)).kind, kind); await rm(join(gitDir, marker));
  }
  await mkdir(join(gitDir, 'rebase-merge')); assert.equal((await operationState(f.git)).kind, 'rebase'); await rm(join(gitDir, 'rebase-merge'), { recursive: true });
  await mkdir(join(gitDir, 'rebase-apply')); await writeFile(join(gitDir, 'rebase-apply/applying'), ''); assert.equal((await operationState(f.git)).kind, 'am');
  await rm(join(gitDir, 'rebase-apply/applying')); await writeFile(join(gitDir, 'rebase-apply/rebasing'), ''); assert.equal((await operationState(f.git)).kind, 'rebase'); await rm(join(gitDir, 'rebase-apply'), { recursive: true });
  await mkdir(join(gitDir, 'sequencer'));
  for (const [todo, kind] of [['pick abc\n', 'cherry-pick'], ['revert abc\n', 'revert'], ['# incomplete\n', 'sequencer']]) {
    await writeFile(join(gitDir, 'sequencer/todo'), todo); assert.equal((await operationState(f.git)).kind, kind);
  }
  assert.equal(await f.git.operation(), 'sequencer'); assert.deepEqual((await operationState(f.git)).actions, []);
});

test('revert and cherry-pick create new commits with one confirmation and no networking', async t => {
  const f = await fixture(t, { committed: true }); await f.write('topic.txt', 'topic'); await f.commit('topic'); const topic = await f.git.value('rev-parse', 'HEAD');
  await startCommitOperation(new ScriptedConsole(['y']), f.git, 'revert', { commit: topic }); assert.notEqual(await f.git.value('rev-parse', 'HEAD'), topic); assert.equal((await f.git.run(['cat-file', '-e', 'HEAD:topic.txt'], { check: false })).status !== 0, true);
  await f.git.run(['switch', '-c', 'source']); await f.write('source.txt', 'source'); await f.commit('source'); const source = await f.git.value('rev-parse', 'HEAD'); await f.git.run(['switch', 'main']);
  await startCommitOperation(new ScriptedConsole(['y']), f.git, 'cherry-pick', { commit: source }); assert.equal(await f.git.value('show', 'HEAD:source.txt'), 'source'); assert.equal(await f.git.operation(), '');
});

test('fixed multi-commit sequence expands OIDs before confirmation and preserves requested order', async t => {
  const f = await fixture(t, { committed: true });
  await f.write('one.txt', 'one'); await f.commit('one'); const one = await f.git.value('rev-parse', 'HEAD');
  await f.write('two.txt', 'two'); await f.commit('two'); const two = await f.git.value('rev-parse', 'HEAD');
  const commits = await commitSequence(f.git, 'cherry-pick', { commits: [two, one] }); assert.deepEqual(commits, [two, one]);
  await f.git.run(['switch', '-c', 'target', await f.git.value('rev-parse', 'HEAD~2')]);
  const ui = new ScriptedConsole(['y']); await startCommitOperation(ui, f.git, 'cherry-pick', { commits: [two, one] });
  assert.match(ui.transcript, /2 个固定提交/); assert.match(ui.transcript, new RegExp(`${two}.*${one}`, 's')); assert.equal(await f.git.value('show', 'HEAD:one.txt'), 'one'); assert.equal(await f.git.value('show', 'HEAD:two.txt'), 'two');
  assert.deepEqual((await f.git.value('log', '-2', '--format=%s')).split('\n'), ['one', 'two']);
});

test('A..B range expands locally, excludes A, and rejects open or symmetric ranges', async t => {
  const f = await fixture(t, { committed: true }); await f.write('a.txt', 'a'); await f.commit('a'); const a = await f.git.value('rev-parse', 'HEAD'); await f.write('b.txt', 'b'); await f.commit('b'); const b = await f.git.value('rev-parse', 'HEAD');
  await f.write('c.txt', 'c'); await f.commit('c'); const c = await f.git.value('rev-parse', 'HEAD');
  assert.deepEqual(await commitSequence(f.git, 'cherry-pick', { range: `${a}..${c}` }), [b, c]);
  await assert.rejects(commitSequence(f.git, 'cherry-pick', { range: '..' }), /明确的 A..B/); await assert.rejects(commitSequence(f.git, 'cherry-pick', { range: `${a}...${c}` }), /不接受/);
});

test('multi-commit sequencer conflict can continue, skip or abort the entire already-started batch', async t => {
  const f = await fixture(t, { committed: true }); const base = await f.git.value('rev-parse', 'HEAD');
  await f.write('one.txt', 'one'); await f.commit('one'); const one = await f.git.value('rev-parse', 'HEAD');
  await f.write('two.txt', 'two'); await f.commit('two'); const two = await f.git.value('rev-parse', 'HEAD');
  await f.write('three.txt', 'three'); await f.commit('three'); const three = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['switch', '-c', 'target', base]); await f.write('two.txt', 'target conflict'); await f.commit('target conflict'); const before = await f.git.value('rev-parse', 'HEAD');
  const options = { commits: [one, two, three] };
  await startCommitOperation(new ScriptedConsole(['y']), f.git, 'cherry-pick', options);
  assert.equal((await operationState(f.git)).kind, 'cherry-pick'); assert.ok((await operationState(f.git)).markers.includes('sequencer'));
  assert.equal(await readFile(join(f.path, 'one.txt'), 'utf8'), 'one'); assert.match(await readFile(await f.git.gitPath('sequencer/todo'), 'utf8'), /two[\s\S]*three/);
  await controlOperation(new ScriptedConsole(['y']), f.git, 'abort'); assert.equal((await operationState(f.git)).kind, 'none'); assert.equal(await f.git.value('rev-parse', 'HEAD'), before); assert.equal(existsSync(join(f.path, 'one.txt')), false);
  await startCommitOperation(new ScriptedConsole(['y']), f.git, 'cherry-pick', options); await controlOperation(new ScriptedConsole(['y']), f.git, 'skip');
  assert.equal((await operationState(f.git)).kind, 'none'); assert.equal(await readFile(join(f.path, 'two.txt'), 'utf8'), 'target conflict'); assert.equal(await readFile(join(f.path, 'three.txt'), 'utf8'), 'three');
  await f.git.run(['reset', '--hard', before]); await startCommitOperation(new ScriptedConsole(['y']), f.git, 'cherry-pick', options);
  await resolveConflictFiles(new ScriptedConsole(['y']), f.git, { paths: ['two.txt'], resolution: 'theirs' }); await controlOperation(new ScriptedConsole(['y']), f.git, 'continue');
  assert.equal((await operationState(f.git)).kind, 'none'); assert.equal(await readFile(join(f.path, 'two.txt'), 'utf8'), 'two'); assert.equal(await readFile(join(f.path, 'three.txt'), 'utf8'), 'three');
});

test('multi-commit revert reuses fixed OIDs and sequence menu supports list and range', async t => {
  const f = await fixture(t, { committed: true }); await f.write('one.txt', 'one'); await f.commit('one'); const one = await f.git.value('rev-parse', 'HEAD'); await f.write('two.txt', 'two'); await f.commit('two'); const two = await f.git.value('rev-parse', 'HEAD');
  await startCommitOperation(new ScriptedConsole(['y']), f.git, 'revert', { commits: [two, one] }); assert.equal((await operationState(f.git)).kind, 'none'); assert.equal((await f.git.run(['cat-file', '-e', 'HEAD:one.txt'], { check: false })).status !== 0, true);
  const ui = new ScriptedConsole(['1', `${one},${two}`, 'n']); await startCommitSequence(ui, f.git, 'revert'); assert.match(ui.transcript, /多提交选择/);
});

test('range execution pins expanded commits even if its source ref moves during the one confirmation', async t => {
  const f = await fixture(t, { committed: true }); const base = await f.git.value('rev-parse', 'HEAD'); await f.git.run(['switch', '-c', 'source']);
  await f.write('dependent.txt', 'first\n'); await f.commit('first'); const first = await f.git.value('rev-parse', 'HEAD'); await f.write('dependent.txt', 'second\n'); await f.commit('second'); const second = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['switch', 'main']);
  const ui = changing(() => f.git.run(['update-ref', 'refs/heads/source', base]));
  await startCommitOperation(ui, f.git, 'cherry-pick', { range: { from: base, to: 'source' } });
  assert.equal(await f.git.value('rev-parse', 'source'), base); assert.equal(await readFile(join(f.path, 'dependent.txt'), 'utf8'), 'second\n');
  assert.match(ui.transcript, new RegExp(`${first}.*${second}`, 's')); assert.equal(ui.messages.filter(message => message.startsWith('确认开始 cherry-pick')).length, 1);
});

test('revert range runs newest-to-oldest and returns the tree to the excluded endpoint', async t => {
  const f = await fixture(t, { committed: true }); const base = await f.git.value('rev-parse', 'HEAD');
  await f.write('dependent.txt', 'first\n'); await f.commit('first'); const first = await f.git.value('rev-parse', 'HEAD'); await f.write('dependent.txt', 'second\n'); await f.commit('second'); const second = await f.git.value('rev-parse', 'HEAD');
  assert.deepEqual(await commitSequence(f.git, 'revert', { range: `${base}..${second}` }), [second, first]);
  const ui = new ScriptedConsole(['y']); await startCommitOperation(ui, f.git, 'revert', { range: `${base}..${second}` });
  assert.equal((await operationState(f.git)).kind, 'none'); assert.equal(await f.git.value('rev-parse', 'HEAD^{tree}'), await f.git.value('rev-parse', `${base}^{tree}`)); assert.match(ui.transcript, /新→旧/);
});

test('batch list/range validation is atomic and never applies an earlier valid prefix', async t => {
  const f = await fixture(t, { committed: true }); const head = await f.git.value('rev-parse', 'HEAD');
  for (const options of [{ commits: [] }, { commits: [head, 'not-an-existing-ref'] }, { commit: head, commits: [head] }, { range: `${head}..${head}` }]) {
    await assert.rejects(startCommitOperation(new ScriptedConsole(), f.git, 'cherry-pick', options), /没有提交|不是可用|不能混用/);
    assert.equal(await f.git.value('rev-parse', 'HEAD'), head); assert.deepEqual(await f.git.changes(), []); assert.equal((await operationState(f.git)).kind, 'none');
  }
});

test('multi-commit selection is reachable from the preserved operations menu', async t => {
  const f = await fixture(t, { committed: true }); await f.git.run(['switch', '-c', 'source']);
  await f.write('one.txt', 'one'); await f.commit('one'); const one = await f.git.value('rev-parse', 'HEAD'); await f.write('two.txt', 'two'); await f.commit('two'); const two = await f.git.value('rev-parse', 'HEAD'); await f.git.run(['switch', 'main']);
  await operationsMenu(new ScriptedConsole(['6', '1', `${one},${two}`, 'y']), f.path);
  assert.equal(await readFile(join(f.path, 'two.txt'), 'utf8'), 'two'); assert.equal((await operationState(f.git)).kind, 'none');
});

test('operations menu exposes both multi-commit entries without changing old single entry positions', async t => {
  const f = await fixture(t, { committed: true }); const ui = new ScriptedConsole(['0']); await operationsMenu(ui, f.path); assert.match(ui.transcript, /cherry-pick：多个提交/); assert.match(ui.transcript, /revert：多个提交/);
});

test('merge conflict stage selection and explicit continuation preserve unrelated untracked files', async t => {
  const f = await fixture(t); const { topic } = await divergent(f); await f.git.run(['merge', '--no-commit', topic], { check: false });
  const entries = await conflictEntries(f.git); assert.deepEqual(entries.map(e => e.path), ['hello.txt']);
  await assert.rejects(controlOperation(new ScriptedConsole(), f.git, 'continue'), /未解决/);
  const ui = new ScriptedConsole(['y']); await resolveConflictFiles(ui, f.git, { paths: ['hello.txt'], resolution: 'theirs' }); assert.match(ui.transcript, /普通 merge/);
  assert.deepEqual(await f.git.unmerged(), []); assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'topic\n');
  await f.write('unrelated.txt', 'untouched'); await controlOperation(new ScriptedConsole(['y']), f.git, 'continue'); assert.equal(await f.git.operation(), ''); assert.equal((await f.git.changes())[0].path, 'unrelated.txt');
});

test('one-sided missing stage is resolved as deletion, not a failed checkout', async t => {
  const f = await fixture(t); await f.write('base.bin', 'base'); await f.commit('base'); await f.git.run(['switch', '-c', 'topic']); await f.git.run(['rm', 'base.bin']); await f.git.run(['commit', '-m', 'delete']); const topic = await f.git.value('rev-parse', 'HEAD'); await f.git.run(['switch', 'main']); await f.write('base.bin', 'changed'); await f.commit('change');
  await f.git.run(['merge', '--no-commit', topic], { check: false }); assert.equal((await conflictEntries(f.git))[0].stages['3'], undefined);
  await resolveConflictFiles(new ScriptedConsole(['y']), f.git, { paths: ['base.bin'], resolution: 'theirs' }); assert.equal(existsSync(join(f.path, 'base.bin')), false); assert.deepEqual(await f.git.unmerged(), []);
  await controlOperation(new ScriptedConsole(['y']), f.git, 'continue'); assert.equal((await f.git.run(['cat-file', '-e', 'HEAD:base.bin'], { check: false })).status !== 0, true);
});

test('binary/raw-byte stage checkout and rename conflict path choices are NUL safe', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { committed: true }); const name = decodePath(Buffer.from([45, 255, 10]));
  const ours = Buffer.from([0, 255, 3]), theirs = Buffer.from([0, 254, 4]);
  const blobs = [];
  for (const bytes of [Buffer.from([0, 1]), ours, theirs]) blobs.push((await f.git.run(['hash-object', '-w', '--stdin'], { inputData: bytes })).stdout.toString('ascii').trim());
  const input = Buffer.concat(blobs.map((oid, index) => Buffer.concat([Buffer.from(`100644 ${oid} ${index + 1}\t`), encodePath(name), Buffer.from([0])])));
  await f.git.run(['update-index', '-z', '--index-info'], { inputData: input });
  await resolveConflictFiles(new ScriptedConsole(['y']), f.git, { paths: [name], resolution: 'ours' });
  assert.deepEqual(await readFile(Buffer.concat([Buffer.from(`${f.path}/`), encodePath(name)])), ours); assert.deepEqual(await f.git.unmerged(), []);
  // rename/rename conflicts expose base and both destinations as separate stage paths.
  await f.git.run(['reset', '--hard', 'HEAD']); await f.git.run(['switch', '-c', 'rename-topic']); await f.git.run(['mv', 'hello.txt', 'topic-name']); await f.commit('rename topic'); const topic = await f.git.value('rev-parse', 'HEAD');
  await f.git.run(['switch', 'main']); await f.git.run(['mv', 'hello.txt', 'main-name']); await f.commit('rename main'); await f.git.run(['merge', topic], { check: false });
  const entries = await conflictEntries(f.git); assert.equal(entries.length, 3);
  await resolveConflictFiles(new ScriptedConsole(['y']), f.git, { paths: ['hello.txt', 'topic-name'], resolution: 'delete' });
  await resolveConflictFiles(new ScriptedConsole(['y']), f.git, { paths: ['main-name'], resolution: 'ours' }); assert.deepEqual(await f.git.unmerged(), []); assert.equal(existsSync(join(f.path, 'main-name')), true);
});

test('rebase conflict roles, continue, skip and abort use real Git state', async t => {
  const f = await fixture(t); const { main } = await divergent(f); await f.git.run(['switch', 'topic']); const before = await f.git.value('rev-parse', 'HEAD');
  await startRebase(new ScriptedConsole(['y']), f.git, { upstream: main, interactive: false }); assert.equal((await operationState(f.git)).kind, 'rebase');
  const ui = new ScriptedConsole(['y']); await resolveConflictFiles(ui, f.git, { paths: ['hello.txt'], resolution: 'theirs' }); assert.match(ui.transcript, /ours 是新基准/);
  await controlOperation(new ScriptedConsole(['y']), f.git, 'continue'); assert.equal((await operationState(f.git)).kind, 'none');
  await f.git.run(['reset', '--hard', before]); await startRebase(new ScriptedConsole(['y']), f.git, { upstream: main, interactive: false }); await controlOperation(new ScriptedConsole(['y']), f.git, 'skip'); assert.equal(await f.git.value('rev-parse', 'HEAD'), main);
  await f.git.run(['reset', '--hard', before]); await startRebase(new ScriptedConsole(['y']), f.git, { upstream: main, interactive: false }); await controlOperation(new ScriptedConsole(['y']), f.git, 'abort'); assert.equal(await f.git.value('rev-parse', 'HEAD'), before);
});

test('real apply-backend rebase conflicts are rebase, never am, and abort restores the branch', async t => {
  const f = await fixture(t); const { main } = await divergent(f); await f.git.run(['switch', 'topic']); const before = await f.git.value('rev-parse', 'HEAD');
  const runner = f.git.configured({ 'rebase.backend': 'apply' });
  await startRebase(new ScriptedConsole(['y']), runner, { upstream: main, interactive: false });
  const state = await operationState(f.git); assert.equal(state.kind, 'rebase'); assert.ok(state.markers.includes('rebase-apply/rebasing')); assert.ok(state.markers.includes('rebase-apply')); assert.ok(!state.markers.includes('rebase-apply/applying'));
  await controlOperation(new ScriptedConsole(['y']), runner, 'abort'); assert.equal(await f.git.value('rev-parse', 'HEAD'), before); assert.equal(await f.git.branch(), 'topic');
});

test('orphan MERGE_AUTOSTASH offers resolution only, not invalid merge continue/abort', async t => {
  const f = await fixture(t, { committed: true }); await writeFile(await f.git.gitPath('MERGE_AUTOSTASH'), await f.git.value('rev-parse', 'HEAD'));
  assert.equal((await operationState(f.git)).kind, 'sequencer'); assert.deepEqual((await operationState(f.git)).actions, []);
  await assert.rejects(controlOperation(new ScriptedConsole(), f.git, 'abort'), /不支持/);
});

test('interactive rebase hands todo to native sequence editor; dirty or unborn starts reject', async t => {
  const f = await fixture(t, { committed: true }); const base = await f.git.value('rev-parse', 'HEAD'); await f.write('new.txt', 'new'); await f.commit('new');
  const editor = join(f.base, 'todo-editor.mjs'); const marker = join(f.base, 'todo-seen');
  await writeFile(editor, `import {readFileSync,writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],readFileSync(process.argv[3]));`);
  const runner = new Git(f.path, { env: { GIT_SEQUENCE_EDITOR: `"${process.execPath}" "${editor}" "${marker}"` } });
  await startRebase(new ScriptedConsole(['y']), runner, { upstream: base, interactive: true }); assert.match(await readFile(marker, 'utf8'), /pick /); assert.equal((await operationState(f.git)).kind, 'none');
  await f.write('new.txt', 'dirty'); await assert.rejects(startCommitOperation(new ScriptedConsole(), f.git, 'revert', { commit: base }), /未提交修改/);
});

test('cherry-pick conflicts can abort/skip and revert conflict can continue', async t => {
  const f = await fixture(t); const { topic, main } = await divergent(f);
  await startCommitOperation(new ScriptedConsole(['y']), f.git, 'cherry-pick', { commit: topic }); assert.equal((await operationState(f.git)).kind, 'cherry-pick');
  await controlOperation(new ScriptedConsole(['y']), f.git, 'abort'); assert.equal(await f.git.value('rev-parse', 'HEAD'), main);
  await startCommitOperation(new ScriptedConsole(['y']), f.git, 'cherry-pick', { commit: topic }); await controlOperation(new ScriptedConsole(['y']), f.git, 'skip'); assert.equal((await operationState(f.git)).kind, 'none');
  await startCommitOperation(new ScriptedConsole(['y']), f.git, 'revert', { commit: topic }); assert.equal((await operationState(f.git)).kind, 'revert');
  await f.write('hello.txt', 'resolved revert'); await resolveConflictFiles(new ScriptedConsole(['y']), f.git, { paths: ['hello.txt'], resolution: 'resolved' }); await controlOperation(new ScriptedConsole(['y']), f.git, 'continue'); assert.equal((await operationState(f.git)).kind, 'none');
});

test('am continue/skip/abort and apply-backend rebase are correctly classified', async t => {
  const f = await fixture(t); const { base, topic } = await divergent(f);
  const patch = (await f.git.run(['format-patch', '-1', '--stdout', topic])).stdout;
  await f.git.run(['am'], { inputData: patch, check: false }); assert.equal((await operationState(f.git)).kind, 'am');
  await controlOperation(new ScriptedConsole(['y']), f.git, 'abort');
  await f.git.run(['am'], { inputData: patch, check: false }); await controlOperation(new ScriptedConsole(['y']), f.git, 'skip'); assert.equal((await operationState(f.git)).kind, 'none');
  await f.git.run(['am'], { inputData: patch, check: false }); await f.write('hello.txt', 'resolved am'); await f.git.stagePaths(['hello.txt']); await controlOperation(new ScriptedConsole(['y']), f.git, 'continue'); assert.equal((await operationState(f.git)).kind, 'none');
  await f.git.run(['reset', '--hard', base]);
});

test('bisect good/bad/skip/reset support detached inspection and never run repository code', async t => {
  const f = await fixture(t); const base = await initial(f);
  for (let i = 0; i < 6; i++) { await f.write('v.txt', `v${i}`); await f.commit(`v${i}`); } const bad = await f.git.value('rev-parse', 'HEAD');
  await startBisect(new ScriptedConsole(['y']), f.git, { good: base, bad }); assert.equal((await operationState(f.git)).kind, 'bisect');
  await controlOperation(new ScriptedConsole(['y']), f.git, 'good'); await controlOperation(new ScriptedConsole(['y']), f.git, 'skip'); await controlOperation(new ScriptedConsole(['y']), f.git, 'bad'); await controlOperation(new ScriptedConsole(['y']), f.git, 'reset'); assert.equal((await operationState(f.git)).kind, 'none'); assert.equal(await f.git.branch(), 'main');
});

for (const quick of [false, true]) {
  test(`resolved-only and normal continue use routine confirmation in ${quick ? 'quick' : 'confirm'} mode without overwriting external edits`, async t => {
    const f = await fixture(t);
    const { topic } = await divergent(f);
    await f.git.run(['merge', '--no-commit', topic], { check: false });
    await f.write('hello.txt', 'external resolution\n');
    await f.write('unrelated.txt', 'must remain untracked\n');
    const ui = new ScriptedConsole(quick ? [] : ['y'], { quick });
    await resolveConflictFiles(ui, f.git, { paths: ['hello.txt'], resolution: 'resolved' });
    assert.deepEqual(ui.answers, []);
    assert.equal(ui.messages.filter(message => message.includes('[y/N]')).length, quick ? 0 : 1);
    assert.doesNotMatch(ui.transcript, /确认覆盖\/删除/);
    assert.match(ui.transcript, /仅暂存并标记 resolved，不覆盖或删除/);
    assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'external resolution\n');
    assert.equal(await f.git.value('show', ':hello.txt'), 'external resolution');
    const continuing = new ScriptedConsole(quick ? [] : ['y'], { quick });
    await controlOperation(continuing, f.git, 'continue');
    assert.deepEqual(continuing.answers, []);
    assert.equal(continuing.messages.filter(message => message.includes('[y/N]')).length, quick ? 0 : 1);
    assert.equal((await operationState(f.git)).kind, 'none');
    assert.equal(await f.git.value('show', 'HEAD:hello.txt'), 'external resolution');
    assert.deepEqual((await f.git.changes()).map(change => [change.path, change.index]), [['unrelated.txt', '?']]);
  });
  test(`bisect good/bad/skip use routine confirmation but reset keeps one hard confirmation in ${quick ? 'quick' : 'confirm'} mode`, async t => {
    const f = await fixture(t);
    const base = await initial(f);
    for (let i = 0; i < 6; i++) { await f.write('v.txt', `v${i}`); await f.commit(`v${i}`); }
    const bad = await f.git.value('rev-parse', 'HEAD');
    await startBisect(new ScriptedConsole(['y']), f.git, { good: base, bad });
    for (const action of ['good', 'skip', 'bad']) {
      const ui = new ScriptedConsole(quick ? [] : ['y'], { quick });
      await controlOperation(ui, f.git, action);
      assert.deepEqual(ui.answers, []);
      assert.equal(ui.messages.filter(message => message.includes('[y/N]')).length, quick ? 0 : 1);
      if (action === 'skip') assert.doesNotMatch(ui.transcript, /丢弃.*解决修改/);
    }
    const before = await f.git.value('rev-parse', 'HEAD');
    const declined = new ScriptedConsole(['n'], { quick });
    await controlOperation(declined, f.git, 'reset');
    assert.equal(declined.messages.filter(message => message.includes('[y/N]')).length, 1);
    assert.equal((await operationState(f.git)).kind, 'bisect');
    assert.equal(await f.git.value('rev-parse', 'HEAD'), before);
    const reset = new ScriptedConsole(['y'], { quick });
    await controlOperation(reset, f.git, 'reset');
    assert.equal(reset.messages.filter(message => message.includes('[y/N]')).length, 1);
    assert.equal(await f.git.branch(), 'main');
  });
}

for (const resolution of ['ours', 'theirs', 'delete']) {
  test(`${resolution} conflict resolution retains exactly one hard confirmation in quick mode`, async t => {
    const f = await fixture(t);
    const { topic } = await divergent(f);
    await f.git.run(['merge', '--no-commit', topic], { check: false });
    await f.write('hello.txt', 'external edit to preserve on decline\n');
    const index = (await f.git.run(['ls-files', '--stage', '-z'])).stdout;
    const declined = new ScriptedConsole(['n'], { quick: true });
    await resolveConflictFiles(declined, f.git, { paths: ['hello.txt'], resolution });
    assert.equal(declined.messages.filter(message => message.includes('[y/N]')).length, 1);
    assert.ok((await f.git.run(['ls-files', '--stage', '-z'])).stdout.equals(index));
    assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'external edit to preserve on decline\n');
    const accepted = new ScriptedConsole(['y'], { quick: true });
    await resolveConflictFiles(accepted, f.git, { paths: ['hello.txt'], resolution });
    assert.equal(accepted.messages.filter(message => message.includes('[y/N]')).length, 1);
    assert.deepEqual(await f.git.unmerged(), []);
    if (resolution === 'delete') assert.equal(existsSync(join(f.path, 'hello.txt')), false);
    else assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), resolution === 'ours' ? 'main\n' : 'topic\n');
  });
}

for (const action of ['abort', 'skip']) {
  test(`non-bisect ${action} retains exactly one hard confirmation in quick mode`, async t => {
    const f = await fixture(t);
    const { topic, main } = await divergent(f);
    await startCommitOperation(new ScriptedConsole(['y']), f.git, 'cherry-pick', { commit: topic });
    await f.write('hello.txt', 'external conflict edit\n');
    const index = (await f.git.run(['ls-files', '--stage', '-z'])).stdout;
    const declined = new ScriptedConsole(['n'], { quick: true });
    await controlOperation(declined, f.git, action);
    assert.equal(declined.messages.filter(message => message.includes('[y/N]')).length, 1);
    assert.equal((await operationState(f.git)).kind, 'cherry-pick');
    assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'external conflict edit\n');
    assert.ok((await f.git.run(['ls-files', '--stage', '-z'])).stdout.equals(index));
    const accepted = new ScriptedConsole(['y'], { quick: true });
    await controlOperation(accepted, f.git, action);
    assert.equal(accepted.messages.filter(message => message.includes('[y/N]')).length, 1);
    assert.equal((await operationState(f.git)).kind, 'none');
    assert.equal(await f.git.value('rev-parse', 'HEAD'), main);
  });
}

for (const action of ['resolved', 'continue']) {
  test(`${action} routine confirmation declines safely and rejects same-status byte races`, async t => {
    const f = await fixture(t);
    const { topic, main } = await divergent(f);
    await f.git.run(['merge', '--no-commit', topic], { check: false });
    await f.write('hello.txt', 'external resolution before preview\n');
    if (action === 'continue') await f.git.stagePaths(['hello.txt']);
    const apply = ui => action === 'resolved' ? resolveConflictFiles(ui, f.git, { paths: ['hello.txt'], resolution: 'resolved' }) : controlOperation(ui, f.git, 'continue');
    const index = (await f.git.run(['ls-files', '--stage', '-z'])).stdout;
    await apply(new ScriptedConsole(['n']));
    assert.ok((await f.git.run(['ls-files', '--stage', '-z'])).stdout.equals(index));
    assert.equal(await f.git.value('rev-parse', 'HEAD'), main);
    const status = (await f.git.run(['status', '--porcelain=v1', '-z'])).stdout;
    const ui = changing(async () => {
      await f.write('hello.txt', 'external resolution raced bytes\n');
      if (action === 'continue') await f.git.stagePaths(['hello.txt']);
      assert.ok((await f.git.run(['status', '--porcelain=v1', '-z'])).stdout.equals(status));
    });
    await assert.rejects(apply(ui), /发生变化/);
    assert.equal(await f.git.value('rev-parse', 'HEAD'), main);
    assert.equal((await operationState(f.git)).kind, 'merge');
    assert.equal(await readFile(join(f.path, 'hello.txt'), 'utf8'), 'external resolution raced bytes\n');
  });
}

test('detached HEAD is allowed per task prerequisites and confirm-time content races stop writes', async t => {
  const f = await fixture(t, { committed: true }); const head = await f.git.value('rev-parse', 'HEAD'); await f.git.run(['switch', '--detach']);
  await startRebase(new ScriptedConsole(['y']), f.git, { upstream: head, interactive: false }); assert.equal((await operationState(f.git)).kind, 'none');
  await assert.rejects(startCommitOperation(changing(() => f.write('new.txt', 'raced')), f.git, 'revert', { commit: head }), /发生变化/);
  await assert.rejects(controlOperation(new ScriptedConsole(), f.git, 'continue'), /不支持/);
});
