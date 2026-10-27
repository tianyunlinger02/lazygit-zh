import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { IGNORE_TEMPLATES, licenseText, readmeText, writeTemplate, ignoredTracked, stopTrackingIgnored, templatesMenu } from '../dist/templates.js';
import { GitError } from '../dist/git.js';
import { fixture, ScriptedConsole } from './support.mjs';

test('built-in ignores cover Node/Python/Windows/Linux and complete real license texts are embedded', async t => {
  await fixture(t); for (const name of ['Node', 'Python', 'Windows', 'Linux']) assert.ok(IGNORE_TEMPLATES[name].length > 20);
  const mit = licenseText('MIT', 'Fixture Holder', '2026'); assert.match(mit, /Permission is hereby granted/u); assert.match(mit, /NONINFRINGEMENT/u);
  const apache = licenseText('Apache-2.0', 'Fixture Holder', '2026'); assert.match(apache, /Grant of Patent License/u); assert.match(apache, /9\. Accepting Warranty/u); assert.ok(apache.length > 10_000);
  const bsd = licenseText('BSD-3-Clause', 'Fixture Holder', '2026'); assert.match(bsd, /3\. Neither the name/u); assert.match(bsd, /FITNESS FOR A PARTICULAR PURPOSE/u);
  assert.throws(() => licenseText('MIT', 'bad\nname'), GitError); assert.match(readmeText('Fixture', 'Description'), /# Fixture\n\nDescription/u);
});

test('existing templates append or ask exactly once before overwrite and never stage or commit', async t => {
  const f = await fixture(t, { committed: true }); const before = await f.git.value('rev-parse', 'HEAD');
  await writeTemplate(new ScriptedConsole([]), f.path, 'README.md', 'old\n');
  assert.equal(await writeTemplate(new ScriptedConsole(['n']), f.path, 'README.md', 'new\n'), false); assert.equal(await fs.readFile(join(f.path, 'README.md'), 'utf8'), 'old\n');
  const ui = new ScriptedConsole(['y']); assert.equal(await writeTemplate(ui, f.path, 'README.md', 'new\n'), true); assert.equal(ui.messages.filter(line => /覆盖.*全部现有内容/u.test(line)).length, 1);
  await writeTemplate(new ScriptedConsole([]), f.path, '.gitignore', 'custom\n'); await writeTemplate(new ScriptedConsole([]), f.path, '.gitignore', IGNORE_TEMPLATES.Node, { append: true }); assert.match(await fs.readFile(join(f.path, '.gitignore'), 'utf8'), /^custom\n\n# Node/u);
  assert.equal(await f.git.value('diff', '--cached', '--name-only'), ''); assert.equal(await f.git.value('rev-parse', 'HEAD'), before);
});

test('stop tracking ignored files changes only index using NUL byte paths, preserving disk and HEAD', async t => {
  const f = await fixture(t, { committed: true }); const rawName = process.platform === 'win32' ? Buffer.from('ignored ordinary.bin') : Buffer.from([105, 103, 110, 111, 114, 101, 100, 45, 255, 46, 98, 105, 110]);
  const full = Buffer.concat([Buffer.from(f.path + '/'), rawName]); await fs.writeFile(full, 'keep disk'); await f.git.run(['add', '--all']); await f.git.run(['commit', '-m', 'fixture ignored']); const before = await f.git.value('rev-parse', 'HEAD');
  await fs.writeFile(join(f.path, '.gitignore'), '*.bin\n'); const files = await ignoredTracked(f.path); assert.equal(files.length, 1); assert.ok(files[0].equals(rawName));
  assert.equal(await stopTrackingIgnored(new ScriptedConsole(['n']), f.path), 0); assert.equal(await stopTrackingIgnored(new ScriptedConsole(['y']), f.path), 1);
  assert.equal(await fs.readFile(full, 'utf8'), 'keep disk'); assert.equal(await f.git.value('rev-parse', 'HEAD'), before); assert.equal((await ignoredTracked(f.path)).length, 0); assert.match(await f.git.value('diff', '--cached', '--name-status'), /^D/u);
});

test('template UI generates README and license locally without hidden confirmation', async t => {
  const f = await fixture(t); const ui = new ScriptedConsole(['4', 'Project fixture', 'Local only', '5', '1', 'Fixture', '2026', '0'], { quick: true }); await templatesMenu(ui, f.path);
  assert.match(await fs.readFile(join(f.path, 'README.md'), 'utf8'), /Local only/u); assert.match(await fs.readFile(join(f.path, 'LICENSE'), 'utf8'), /MIT License/u); assert.equal(await f.git.hasCommits(), false);
});

test('template destinations refuse links and hardlinks instead of overwriting', async t => {
  const f = await fixture(t); const source = join(f.base, 'outside'); await fs.writeFile(source, 'outside'); const dest = join(f.path, 'LICENSE');
  await fs.link(source, dest); await assert.rejects(writeTemplate(new ScriptedConsole(['y']), f.path, 'LICENSE', 'new'), GitError); assert.equal(await fs.readFile(source, 'utf8'), 'outside'); await fs.unlink(dest);
  if (process.platform !== 'win32') { await fs.symlink(source, dest); await assert.rejects(writeTemplate(new ScriptedConsole(['y']), f.path, 'LICENSE', 'new'), GitError); }
});
