import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readlink, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { runProcess, which } from '../dist/process.js';
import { VERSION } from '../dist/cli.js';
import { fixture } from './support.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageName = 'autogit-cn';
const version = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;
const retiredRuntime = ['branches', 'destructive', 'operations', 'stash', 'worktrees', 'submodules', 'lfs'].map(name => `dist/${name}.js`);

function npmCli() {
  const configured = process.env.npm_execpath;
  if (configured) return path.resolve(configured);
  const npmCommand = which('npm');
  assert.ok(npmCommand, 'npm_execpath is absent and npm was not found on PATH');
  let candidate = npmCommand;
  if (/\.(?:cmd|bat)$/iu.test(candidate)) candidate = path.join(path.dirname(candidate), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  else candidate = realpathSync(candidate);
  assert.ok(existsSync(candidate), `npm CLI not found at ${candidate}`);
  return path.resolve(candidate);
}

function npmEnvironment(f) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_config_/iu.test(key) || /^(?:NODE_OPTIONS|NODE_PATH)$/iu.test(key)) delete env[key];
  }
  return {
    ...env,
    HOME: f.home,
    USERPROFILE: f.home,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? env.Path ?? ''}`,
    npm_config_cache: path.join(f.base, 'npm-cache'),
    npm_config_userconfig: path.join(f.home, '.npmrc'),
    npm_config_globalconfig: path.join(f.home, 'global-npmrc'),
    npm_config_prefix: f.prefix,
    npm_config_offline: 'true',
    npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_fetch_retries: '0',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_progress: 'false',
    npm_config_color: 'false',
    NO_UPDATE_NOTIFIER: '1',
  };
}

async function npm(f, args) {
  // npm itself is JavaScript: never spawn npm.cmd or ask a Git subprocess to use a shell.
  return runProcess(process.execPath, [npmCli(), ...args], {
    cwd: f.base,
    env: npmEnvironment(f),
    inputData: Buffer.alloc(0),
  });
}

function text(result) {
  return `${result.stdout.toString('utf8')}\n${result.stderr.toString('utf8')}`;
}

function tarEntries(buffer) {
  const entries = [];
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    entries.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries.sort();
}

async function filesUnder(directory) {
  const output = [];
  async function visit(current, relative) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(absolute, child);
      else output.push(child);
    }
  }
  await visit(directory, '');
  return output.sort();
}

async function snapshot(directory) {
  const output = new Map();
  async function visit(current, relative) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const child = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(absolute, child);
      else if (entry.isFile()) output.set(child, await readFile(absolute));
      else if (entry.isSymbolicLink()) output.set(child, `symlink:${await readlink(absolute)}`);
    }
  }
  await visit(directory, '');
  return output;
}

async function assertSnapshotEqual(before, directory) {
  const after = await snapshot(directory);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [name, bytes] of before) {
    const actual = after.get(name);
    if (Buffer.isBuffer(bytes)) assert.deepEqual(actual, bytes, `data changed: ${name}`);
    else assert.equal(actual, bytes, `data changed: ${name}`);
  }
}

async function runInstalledBin(f, bin, args, inputData = Buffer.alloc(0)) {
  const env = npmEnvironment(f);
  if (process.platform === 'win32') {
    // A .cmd shim needs cmd.exe. This narrowly scoped launcher is not used by Git.
    env.AUTOGIT_PACKAGE_TEST_BIN = bin;
    const references = args.map((value, index) => {
      env[`AUTOGIT_PACKAGE_TEST_ARG_${index}`] = value;
      return `"%AUTOGIT_PACKAGE_TEST_ARG_${index}%"`;
    });
    const command = `""%AUTOGIT_PACKAGE_TEST_BIN%" ${references.join(' ')}"`;
    return new Promise((resolve, reject) => {
      const child = spawn(env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', command], {
        cwd: f.base, env, shell: false, windowsVerbatimArguments: true, stdio: 'pipe',
      });
      const stdout = [], stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
      child.stdin.end(inputData);
    });
  }
  // Execute the npm-created POSIX symlink itself, including its shebang and execute bit.
  return runProcess(bin, args, { cwd: f.base, env, inputData });
}

async function assertStatus(result, message) {
  assert.equal(result.status, 0, `${message}\n${await text(result)}`);
}

test('packed release allowlist and isolated npm install lifecycle', async (t) => {
  const f = await fixture(t);
  f.prefix = path.join(f.base, 'npm-prefix');
  const appRoot = path.join(f.base, 'independent AutoGit');
  const dataDir = path.join(appRoot, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'sentinel.bin'), Buffer.from([0, 1, 2, 127, 128, 255]));
  await writeFile(path.join(dataDir, 'nested.json'), Buffer.from('{"keep":true}\n'));
  const profileDirectory = path.join(dataDir, 'profiles', '00000000000000000000000000000000');
  await mkdir(profileDirectory, { recursive: true });
  await writeFile(path.join(profileDirectory, 'id_ed25519'), Buffer.from('TEST FIXTURE ONLY - NOT A REAL PRIVATE KEY\n\0\xff', 'latin1'));
  await writeFile(path.join(profileDirectory, 'id_ed25519.pub'), 'TEST FIXTURE ONLY - NOT A REAL PUBLIC KEY\n');
  const dataBeforeInstall = await snapshot(appRoot);
  await writeFile(path.join(f.home, '.npmrc'), '');
  await writeFile(path.join(f.home, 'global-npmrc'), '');
  // Keep npm's project-level config lookup within the fixture as well.
  await writeFile(path.join(f.base, '.npmrc'), '');
  await writeFile(path.join(f.base, 'package.json'), JSON.stringify({ name: 'autogit-package-test', version: '0.0.0', private: true }));

  const packDir = path.join(f.base, 'pack-output');
  await mkdir(packDir, { recursive: true });
  const packed = await npm(f, ['pack', repoRoot, '--ignore-scripts', '--json', '--pack-destination', packDir]);
  await assertStatus(packed, 'npm pack failed');
  const records = JSON.parse(packed.stdout.toString('utf8'));
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.name, packageName);
  assert.equal(record.version, version);
  assert.equal(VERSION, version, 'compiled CLI version must match the package being packed');
  assert.equal(record.filename, `${packageName}-${version}.tgz`);
  const tgz = path.join(packDir, record.filename);
  assert.equal((await stat(tgz)).isFile(), true);

  const distFiles = (await filesUnder(path.join(repoRoot, 'dist')))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `dist/${name.split(path.sep).join('/')}`);
  const nativeFiles = existsSync(path.join(repoRoot, 'native', 'bin')) ? (await filesUnder(path.join(repoRoot, 'native', 'bin'))).map(name => `native/bin/${name.split(path.sep).join('/')}`) : [];
  const expected = [...distFiles, ...nativeFiles, 'README.md', 'docs/capabilities.md', 'package.json'].sort();
  const packedFiles = record.files.map((entry) => entry.path).sort();
  for (const retired of retiredRuntime) {
    await assert.rejects(lstat(path.join(repoRoot, retired)), { code: 'ENOENT' }, `retired module must not remain in dist: ${retired}`);
    assert.equal(packedFiles.includes(retired), false, `retired module must not be packed: ${retired}`);
  }
  assert.deepEqual(packedFiles, expected, 'package contents must be an explicit runtime allowlist');
  const tarPaths = tarEntries(gunzipSync(await readFile(tgz)))
    .filter((name) => !name.endsWith('/'))
    .map((name) => name.startsWith('package/') ? name.slice('package/'.length) : name);
  for (const retired of retiredRuntime) assert.equal(tarPaths.includes(retired), false, `retired module must not be in the tarball: ${retired}`);
  assert.deepEqual(tarPaths, expected, 'tarball entries must match npm pack manifest exactly');
  for (const entry of record.files) {
    assert.doesNotMatch(entry.path, /(?:^|[/\\])data(?:[/\\]|$)/iu);
    assert.doesNotMatch(entry.path, /(?:^|[/\\])keys?(?:[/\\]|$)/iu);
    assert.doesNotMatch(entry.path, /\.py(?:c)?$/iu);
    assert.doesNotMatch(entry.path, /(?:^|[/\\])(?:tests?|node_modules|src)(?:[/\\]|$)/iu);
    assert.doesNotMatch(entry.path, /(?:^|[/\\])\.claude(?:[/\\]|$)/iu);
    assert.doesNotMatch(entry.path, /^native\/pam(?:\/|$)/iu, 'standalone unlocking must not ship a PAM policy');
  }
  assert.doesNotMatch(packedFiles.join('\n'), /data|id_ed25519|python|typescript/iu);

  const installed = await npm(f, ['install', '--global', '--ignore-scripts', '--offline', '--prefix', f.prefix, tgz]);
  await assertStatus(installed, 'isolated global install failed');
  const bin = process.platform === 'win32' ? path.join(f.prefix, 'autogit.cmd') : path.join(f.prefix, 'bin', 'autogit');
  const binInfo = await lstat(bin);
  if (process.platform === 'win32') assert.equal(binInfo.isFile(), true);
  else assert.equal(binInfo.isSymbolicLink(), true, 'POSIX global bin must be a symlink');
  const firstRun = await runInstalledBin(f, bin, ['--version']);
  await assertStatus(firstRun, 'installed autogit --version failed');
  assert.equal(firstRun.stdout.toString('utf8').trim(), `autogit ${version}`);

  const dataAfterInstall = await snapshot(appRoot);
  assert.deepEqual([...dataAfterInstall.keys()].sort(), [...dataBeforeInstall.keys()].sort());
  await assertSnapshotEqual(dataBeforeInstall, appRoot);

  const installedPackage = process.platform === 'win32'
    ? path.join(f.prefix, 'node_modules', packageName)
    : path.join(f.prefix, 'lib', 'node_modules', packageName);
  const installedCli = path.join(installedPackage, 'dist', 'cli.js');
  if (process.platform !== 'win32') assert.equal(await realpath(bin), await realpath(installedCli));
  assert.deepEqual(await filesUnder(installedPackage), expected.map((name) => name.split('/').join(path.sep)).sort());
  const installedManifest = JSON.parse(await readFile(path.join(installedPackage, 'package.json'), 'utf8'));
  assert.equal(installedManifest.name, packageName);
  assert.equal(installedManifest.version, version);
  assert.deepEqual(installedManifest.bin, { autogit: 'dist/cli.js' });
  assert.equal(installedManifest.engines.node, '>=22');
  assert.deepEqual(installedManifest.dependencies ?? {}, {}, 'runtime must not install third-party dependencies');
  assert.deepEqual(installedManifest.bundledDependencies ?? [], []);
  await assert.rejects(stat(path.join(installedPackage, 'node_modules')), { code: 'ENOENT' });

  const help = await runInstalledBin(f, bin, ['--help']);
  await assertStatus(help, 'installed autogit --help failed');
  assert.match(text(help), /不需要 Python/u);
  const configured = await runInstalledBin(f, bin, ['--app-dir', appRoot, '--path', f.path], Buffer.from('0\n'));
  assert.equal(configured.status, 1, 'installed CLI must reject piped input without a secure secret terminal');
  assert.match(text(configured), /交互式终端|安全终端/u);
  assert.doesNotMatch(text(configured), /你想做什么/u);
  assert.match(await readFile(path.join(installedPackage, 'docs', 'capabilities.md'), 'utf8'), /未实现|部分|不支持|未验证/u);
  for (const [name, bytes] of dataBeforeInstall) assert.deepEqual(await readFile(path.join(appRoot, name)), bytes);
  const dataAfterFirstRun = await snapshot(appRoot);
  await assertSnapshotEqual(dataBeforeInstall, appRoot);

  const originalCli = await readFile(installedCli);
  await writeFile(installedCli, '#!/usr/bin/env node\nprocess.stdout.write("corrupt\\n");\n');
  const reinstall = await npm(f, ['install', '--global', '--force', '--ignore-scripts', '--offline', '--prefix', f.prefix, tgz]);
  await assertStatus(reinstall, 'reinstall/upgrade simulation failed');
  assert.deepEqual(await readFile(installedCli), originalCli, 'reinstall must replace the installed runtime');
  await assertSnapshotEqual(dataAfterFirstRun, appRoot);
  const upgradedRun = await runInstalledBin(f, bin, ['--app-dir', appRoot, '--path', f.path], Buffer.from('0\n'));
  assert.equal(upgradedRun.status, 1, 'reinstalled CLI must still require secure standalone password input');
  assert.match(text(upgradedRun), /交互式终端|安全终端/u);
  assert.doesNotMatch(text(upgradedRun), /你想做什么/u);
  const dataAfterUpgradeRun = await snapshot(appRoot);
  assert.deepEqual([...dataAfterUpgradeRun.keys()].sort(), [...dataAfterFirstRun.keys()].sort());
  for (const [name, bytes] of dataAfterFirstRun) {
    assert.deepEqual(dataAfterUpgradeRun.get(name), bytes, 'locked startup must not update any account data');
  }

  const removed = await npm(f, ['uninstall', '--global', '--ignore-scripts', '--offline', '--prefix', f.prefix, packageName]);
  await assertStatus(removed, 'isolated global uninstall failed');
  await assert.rejects(lstat(bin), { code: 'ENOENT' });
  await assert.rejects(stat(installedPackage), { code: 'ENOENT' });
  await assertSnapshotEqual(dataAfterUpgradeRun, appRoot);

  // Run after uninstall so an accidentally reused global bin cannot make this pass.
  const execRun = await npm(f, ['exec', '--offline', '--yes', `--package=${tgz}`, '--', 'autogit', '--version']);
  await assertStatus(execRun, 'offline npm exec from local tgz failed');
  assert.match(text(execRun), new RegExp(`autogit ${version.replaceAll('.', '\\.')}\\b`, 'u'));
  await assertSnapshotEqual(dataAfterUpgradeRun, appRoot);
});
