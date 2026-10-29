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
  let productionPtyPassed = false, diagnosticsColorVerified = false;
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
    const colorEnv = { ...env, TERM: 'xterm-256color' };
    delete colorEnv.NO_COLOR; delete colorEnv.FORCE_COLOR;
    const diagnosticSteps = () => [
      ['AutoGit 解锁密码（忘记密码请直接回车）：', `${password}\r`],
      ['请选择编号：', 'invalid-menu-choice\n'],
      ['请输入 0 到 6 之间的编号。', '6\n'],
      ['请选择编号：', '2\n'],
      ['你想做什么？', '0\n'],
    ];
    const colored = await productionPty(context, cli, { cwd: project, env: colorEnv, args: ['--path', project], steps: diagnosticSteps() });
    assert.equal(colored.status, 0, colored.output + colored.errors);
    assert.equal(colored.steps, colored.expectedSteps, colored.output);
    assert.ok(colored.output.includes('\x1b[31m[错误]\x1b[39m'), 'Installed terminal must color error labels red and immediately restore color');
    assert.ok(colored.output.includes('\x1b[33m[警告]\x1b[39m'), 'Installed diagnostic warnings must have yellow labels');
    const plain = await productionPty(context, cli, { cwd: project, env: { ...colorEnv, NO_COLOR: '1' }, args: ['--path', project], steps: diagnosticSteps() });
    assert.equal(plain.status, 0, plain.output + plain.errors);
    assert.equal(plain.steps, plain.expectedSteps, plain.output);
    assert.match(plain.output, /\[错误\]/u); assert.match(plain.output, /\[警告\]/u);
    assert.doesNotMatch(plain.output, /\x1b\[(?:31|32|33)m/u);
    assert.ok(!colored.output.includes(password) && !plain.output.includes(password));
    assert.deepEqual(await readFile(join(app, 'data', 'vault.json')), bytes);
    diagnosticsColorVerified = true;
  }
  const moduleDirectory = new URL('./dist/', pathToFileURL(join(installedRoot, 'package.json'))).href;
  const fixtureLogs = join(root, 'artifacts/native-personal');
  await mkdir(fixtureLogs, { recursive: true });
  async function installedFixture(name, file, requiredTitles, evidenceBoundary) {
    // The harness remains in this checkout; all production imports (including support.mjs)
    // resolve through the same installed module graph. This does not alter the public CLI.
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', join(root, 'tests-node', file)], {
        cwd: root, env: { ...env, AUTOGIT_GITHUB_TEST_MODULE_DIR: moduleDirectory },
        shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = [], err = [];
      const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
      child.stdout.on('data', value => out.push(value)); child.stderr.on('data', value => err.push(value));
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (status, signal) => {
        clearTimeout(timer);
        resolveResult({ status, signal, output: Buffer.concat(out).toString(), errors: Buffer.concat(err).toString() });
      });
    });
    const log = join(fixtureLogs, `installed-${name}-fixtures.txt`);
    await writeFile(log, result.output + result.errors);
    assert.equal(result.status, 0, `${file} (${result.signal ?? 'exit'}):\n${result.output}${result.errors}`);
    const count = key => {
      const matched = result.output.match(new RegExp(`^# ${key} ([0-9]+)$`, 'mu'));
      assert.ok(matched, `Installed ${file} is missing TAP count ${key}`);
      return Number(matched[1]);
    };
    const counts = { tests: count('tests'), passed: count('pass'), failed: count('fail'), cancelled: count('cancelled'), skipped: count('skipped'), todo: count('todo') };
    assert.ok(counts.tests > 0, `Installed ${file} must execute tests`);
    assert.equal(counts.failed, 0); assert.equal(counts.cancelled, 0);
    const results = new Map();
    for (const line of result.output.split('\n')) {
      const matched = line.match(/^(ok|not ok) [0-9]+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/u);
      if (matched) results.set(matched[2], matched[3] ? matched[3].toLowerCase() : matched[1] === 'ok' ? 'passed' : 'failed');
    }
    const proofs = requiredTitles.map(title => {
      assert.ok(results.has(title), `Installed ${file} required proof is missing: ${title}`);
      return { title, status: results.get(title) };
    });
    return {
      file, moduleDirectory, testHarnessFromSourceTree: true, log, counts, proofs, evidenceBoundary,
      complete: counts.passed === counts.tests && counts.skipped === 0 && counts.todo === 0 && proofs.every(proof => proof.status === 'passed'),
    };
  }
  // Deliberately sequential: suites share native helpers and synthetic fixture machinery.
  const nativeFixture = await installedFixture('http', 'github-personal.test.mjs', [
    'native fixed Node request maps only to loopback and projects full REST data through the unchanged pure validator',
    'verified enrollment uses the real encrypted Vault without storing plaintext or touching external credentials',
    'native GET retry is opt-in, reports a typed unavailable error and preserves the same actor/token without new enrollment',
    'prewrite actor GET total timeout retries only the read, retains authentication and runs the final beforeWrite guard after retry',
    '201 followed by a verification timeout permits only explicit GET retry and exactly one POST/creation callback',
    'POST failures and invalid 201 bodies never consult the read retry policy; unknown/created inspection is a separate pinned GET',
  ], 'Installed native API implementation; fixed HTTPS request options mapped to loopback HTTP or controlled stream adapters; synthetic sessions plus a real synthetic encrypted Vault case. No real GitHub or production TLS service.');
  const profileFixture = await installedFixture('https-profile', 'https-profiles.test.mjs', [
    'HTTPS-only creation saves strict schema 3 identity with real encrypted vault and no SSH artifacts or program probes',
    'HTTPS binding keeps envelope 2 and strict snapshot 3 across restart; default managed SSH refuses keyless before fallback',
    'schema 3 UI creation, display, auth help and deletion never claim keys or remove a shared host/account Token',
    'bound HTTPS-only public-key menu stops before gh, actor authentication or public-key input',
  ], 'Installed profile/session/vault/provenance and account UI modules with real synthetic encrypted stores and local Git; SSH/keygen/agent calls are failing sentinels, not interoperability tests.');
  const uploadFixture = await installedFixture('upload-experience', 'upload-experience.test.mjs', [
    'upload UX managed HTTPS private creation preserves returned URL case and uploads to local bare with a keyless synthetic account',
    'upload UX managed HTTPS public creation preserves returned URL case and uploads to local bare with a keyless synthetic account',
    'upload UX prewrite-read read retry retains repository visibility and alias with one final creation consent and one parsed POST',
    'upload UX verification-read read retry retains repository visibility and alias with one final creation consent and one parsed POST',
    'upload UX unknown parsed POST outcome uses GET inspection then explicit association only without replay or automatic upload',
    'upload UX managed HTTPS binding failure retains the actual added remote and reports partial association',
    'upload UX commit completion survives interrupted unknown push with one final summary and no automatic retry',
    'upload UX accepted upload and partial upstream write are separated and direct the user not to upload again',
  ], 'Installed workflows/native-client control flow/profiles/vault/session/task-progress modules with ScriptedConsole. requestJson is a parsed-response code adapter; Git push maps only transport to local bare. This is not HTTP, real GitHub, production CLI upload PTY, or helper credential-release evidence.');
  const pinFixture = await installedFixture('credential-pin', 'credential-pin.test.mjs', [
    'credential proof is opaque, ephemeral and issued without a second API GET only after explicit client authentication',
    'credential proof compares the exact provided buffer and never accepts replacement bytes for the same actor',
    'credential proof checks current-session identity before and after a pending vault read and clears fetched buffers on failure',
    'proof disposal, session close and client task disposal fail closed and never fetch credentials afterward',
    'proof disposal invalidates synchronously and awaits registered resource cleanups exactly once',
  ], 'Installed native client and credential-pin implementation with code-created in-memory session and request/stream adapters; no real vault or HTTP transport claim for this suite.');
  const helperFixture = await installedFixture('https-helper', 'credentials.test.mjs', [
    'HTTPS helper resets inherited helpers, scopes protocol/host/path/account and never changes remote/config',
    'IPC rejects invalid capabilities/protocol and session close destroys idle sockets promptly',
    'pinned HTTPS preserves the validated URL path case, isolates helper cache identities and rejects disposal or same-actor replacement',
    'helper validates the exact buffer fetched during IPC, not a separate preflight that could miss a mid-fetch token swap',
    'cached pinned and unpinned helpers reject a different current session, including a switch while getToken is pending',
    'task pin disposal closes its cached and direct helper sockets/directories without closing the credential session or unpinned helpers',
  ], 'Installed credential helper/configuration/pin/client/session/vault modules with real local Git credential fill and helper IPC, synthetic encrypted tokens, controlled API request adapters and fake gh process seam. No remote service or external credential access.');
  const progressFixture = await installedFixture('task-progress', 'task-progress.test.mjs', [
    'nested task progress prints one truthful summary and awaits reverse-order cleanup without replacing the original error',
    'task summary output failure still cleans resources and cannot mask a prior operation error',
    'task progress preserves completed upload and directs only upstream repair after a partial configuration write',
  ], 'Installed task-progress output/cleanup control flow with ScriptedConsole and controlled failures; no Git or network operation.');
  const recoveryFixture = await installedFixture('personal-recovery', 'personal-recovery.test.mjs', [
    'known 201 creation survives a failed separate inspection without downgrading its error or summary to unknown creation',
    'credential and terminal safety guards after 201 preserve created facts and never offer a recovery menu',
  ], 'Installed personal-repository controller, controlled error types and task-progress modules with code-only client stubs; no HTTP, token access, GitHub request or local Git write.');
  const installedModuleFixtures = [nativeFixture, profileFixture, uploadFixture, pinFixture, helperFixture, progressFixture, recoveryFixture];
  const { resolveNativeHelper } = await import(pathToFileURL(join(installedRoot, 'dist', 'auth.js')).href);
  const helper = await resolveNativeHelper();
  const report = {
    date: new Date().toISOString(), platform: process.platform, command, cli, installedRoot, matchedFiles,
    packageSha256: release.package.sha256, helper, helpAndVersion: true, pipedStartupRejectedBeforeLocation: true,
    productionPtyPassed, sixGroupMenuVerified: productionPtyPassed, diagnosticsColorVerified,
    installedNativePersonalHttpFixturesPassed: nativeFixture.complete,
    installedHttpsOnlyProfileFixturesPassed: profileFixture.complete,
    installedUploadExperienceAdapterFixturesPassed: uploadFixture.complete,
    installedCredentialPinAdapterFixturesPassed: pinFixture.complete,
    installedHttpsHelperIpcFixturesPassed: helperFixture.complete,
    installedTaskProgressFixturesPassed: progressFixture.complete,
    installedPersonalRecoveryControllerFixturesPassed: recoveryFixture.complete,
    installedModuleFixtures,
    retiredModulesAbsent: retiredModules, personalDataRead: false, osPasswordAuthentication: false,
    systemConfigurationModified: false, realRemoteOperations: false,
    notVerified: [
      'Windows TTY/ACL/named pipe/OpenSSH runtime', 'Node 24 actual runtime',
      'real remote Git/GitHub/Enterprise services or production GitHub TLS/permissions',
      'managed HTTPS upload/recovery through the production CLI PTY; workflow fixtures use ScriptedConsole and adapters',
      ...installedModuleFixtures.filter(fixture => !fixture.complete).map(fixture => `${fixture.file}: one or more tests were skipped or TODO; see counts and proof statuses`),
    ],
  };
  await mkdir(join(root, 'artifacts/login-security'), { recursive: true });
  await writeFile(join(root, 'artifacts/login-security/installed-standalone.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await scratch.cleanup();
}
