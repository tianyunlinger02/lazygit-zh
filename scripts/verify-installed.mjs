import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createScratch } from './scratch.mjs';
import { productionPty } from '../tests-node/pty-driver.mjs';

// Explicit developer check. Operates on synthetic isolated data, never the user's Vault.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];
if (!command || process.argv.length !== 3) throw Error('Usage: node scripts/verify-installed.mjs /absolute/path/to/autogit');
const cli = await realpath(command), installedRoot = dirname(dirname(cli));
const release = JSON.parse(await readFile(join(root, 'artifacts/release-0.5.0.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const retiredModules = ['branches', 'destructive', 'operations', 'stash', 'worktrees', 'submodules', 'lfs'];
for (const name of retiredModules) {
  await assert.rejects(readFile(join(installedRoot, 'dist', `${name}.js`)), { code: 'ENOENT' }, `Retired installed module: ${name}`);
}
let matchedFiles = 0;
for (const file of release.package.files) {
  assert.equal(hash(await readFile(join(installedRoot, file))), hash(await readFile(join(root, file))), `Installed content mismatch: ${file}`);
  matchedFiles++;
}
const scratch = await createScratch('installed-standalone-'), cleanups = [];
const context = { after(callback) { cleanups.push(callback); } };
try {
  const home = join(scratch.directory, 'home'), project = join(scratch.directory, 'project'), app = join(home, 'personal credentials');
  await mkdir(home); await mkdir(project);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:GIT_|GH_|GITHUB_|AUTOGIT_)/iu.test(key) || ['NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'DEBUG', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'BROWSER'].includes(key.toUpperCase())) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'AppData'), GH_CONFIG_DIR: join(home, 'gh'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_ALLOW_PROTOCOL: 'file', TMPDIR: scratch.directory, TMP: scratch.directory, TEMP: scratch.directory });
  async function run(args, input) {
    return new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: project, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = [], errors = [];
      child.stdout.on('data', value => output.push(value)); child.stderr.on('data', value => errors.push(value));
      child.once('error', reject); child.once('close', status => resolveResult({ status, output: Buffer.concat(output).toString(), errors: Buffer.concat(errors).toString() }));
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); }); child.stdin.end(input);
    });
  }
  const version = await run(['--version']); assert.equal(version.status, 0); assert.match(version.output, /autogit 0\.5\.0/u);
  const help = await run(['--help']); assert.equal(help.status, 0); assert.match(help.output, /独立 AutoGit/u); assert.doesNotMatch(help.output, /PAM|Hello PIN/u);
  const piped = await run([], Buffer.from('synthetic-not-a-valid-password-input\n'));
  assert.equal(piped.status, 1); assert.doesNotMatch(piped.output, /选择 AutoGit 资料保存位置|你想做什么/u);
  const password = 'synthetic-installed-standalone-password';
  let productionPtyPassed = false;
  if (process.platform !== 'win32') {
    const first = await productionPty(context, cli, { cwd: project, env, steps: [
      ['AutoGit 资料文件夹（软件根目录）', `${app}\n`], ['新的 AutoGit 解锁密码：', `${password}\r`],
      ['再次输入新的 AutoGit 解锁密码：', `${password}\r`], ['[y/N]：', 'y\n'], ['请选择编号：', '1\n'],
      ['请选择编号：', '4\n'], ['请选择编号：', '0\n'], ['请选择编号：', '0\n'],
    ] });
    assert.equal(first.status, 0, first.output + first.errors); assert.equal(first.steps, first.expectedSteps, first.output);
    const mainMenus = [...first.output.matchAll(/你想做什么？([\s\S]*?)请选择编号：/gu)];
    assert.ok(mainMenus.length >= 2, 'Installed CLI must return from account submenu to the grouped main menu');
    const expectedMenu = ['日常项目', '远程传输', 'GitHub 协作', '账号与资料', '项目管理', '查看与诊断'].map((label, index) => [index + 1, label]);
    expectedMenu.push([0, '退出']);
    for (const [, menu] of mainMenus) {
      const entries = [...menu.matchAll(/^\s*(\d+)\. ([^\r\n]+)/gmu)].map(([, number, label]) => [Number(number), label]);
      assert.deepEqual(entries, expectedMenu, 'Installed main menu must have exactly six groups and exit');
    }
    assert.match(first.output, /使用设置（改密、锁定、资料位置与确认模式）/u);
    assert.doesNotMatch(first.output, /分支与合并|临时收起|撤销、还原和清理|进行中的操作|历史与恢复|worktree 多工作区|Git LFS/u);
    assert.doesNotMatch(first.output, /synthetic-installed-standalone-password|当前系统用户|PAM/u);
    const bytes = await readFile(join(app, 'data', 'vault.json')); assert.equal(bytes.includes(Buffer.from(password)), false);
    const second = await productionPty(context, cli, { cwd: project, env, steps: [
      ['AutoGit 解锁密码（忘记密码请直接回车）：', `${password}\r`], ['请选择编号：', '0\n'],
    ] });
    assert.equal(second.status, 0, second.output + second.errors); assert.equal(second.steps, second.expectedSteps, second.output);
    assert.doesNotMatch(second.output, /synthetic-installed-standalone-password|请离线保存恢复码|选择 AutoGit 资料保存位置/u);
    assert.deepEqual(await readFile(join(app, 'data', 'vault.json')), bytes);
    productionPtyPassed = true;
  }
  const { resolveNativeHelper } = await import(pathToFileURL(join(installedRoot, 'dist', 'auth.js')).href);
  const helper = await resolveNativeHelper();
  const report = { date: new Date().toISOString(), platform: process.platform, command, cli, installedRoot, matchedFiles, packageSha256: release.package.sha256, helper, helpAndVersion: true, pipedStartupRejectedBeforeLocation: true, productionPtyPassed, sixGroupMenuVerified: productionPtyPassed, retiredModulesAbsent: retiredModules, personalDataRead: false, osPasswordAuthentication: false, systemConfigurationModified: false, realRemoteOperations: false, notVerified: ['Windows TTY/ACL/named pipe/OpenSSH runtime', 'real remote Git/GitHub/Enterprise services'] };
  await writeFile(join(root, 'artifacts/login-security/installed-standalone.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await scratch.cleanup();
}
