import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import { createScratch } from './scratch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'artifacts');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const npm = process.env.npm_execpath;
if (!npm) throw new Error('请通过 npm run verify 执行，以使用当前 npm-cli.js。');
const { resolveNativeHelper } = await import('../dist/auth.js');
await resolveNativeHelper(); // Refuse incomplete releases before replacing any previous verification evidence.

// Exact titles make renamed or removed evidence fail visibly instead of disappearing from the report.
const evidence = [
  ['public/private creation-link-upload via fake gh and local bare Git', ['legacy workflow CLI (code-only unlock stub) creates a private fixture repository, links and uploads offline', 'legacy workflow CLI (code-only unlock stub) creates a public fixture repository, links and uploads offline']],
  ['native Ctrl+C unknown-creation recovery (offline POSIX PTY test)', ['Ctrl+C during a GitHub create reports unknown result and restores the menu without retry']],
  ['six grouped menus preserve retained tasks without advanced local routes', ['version follows the package and main menu exposes exactly six task groups', 'six-group submenus retain daily, remote, account, project and read-only actions without retired local tools', 'PR submenu keeps remote collaboration actions without local checkout', 'history exposes only read-only APIs and its menu has no recovery action', 'inspect retains its first four read-only choices and adds history as the fifth']],
  ['legacy workflow CLI (code-only unlock stub) lease and unconditional force against divergent local bare histories', ['legacy workflow CLI (code-only unlock stub) remote group performs real lease and unconditional force against a local bare remote']],
  ['basic upload-only and interrupted-operation refusal preserve local work and conflict state', ['legacy workflow CLI (code-only unlock stub) daily upload-only action does not save dirty worktree files', 'legacy workflow CLI (code-only unlock stub) pushes local bare repo and refuses unfinished local operations without changing conflict state']],
  ['actual push URL lease pinning and concurrent peer update rejection', ['lease protects the actual push URL OID, not the fetch URL or stale tracking ref', 'server-side lease rejects a peer update after the final query without a force retry']],
  ['multi-URL configuration management and partial-failure reporting (offline)', ['remote URL list add, remove and inherited push reset preserve the other list', 'remote URL partial failure reports completed fetch without retrying or claiming atomic success']],
  ['fetch and upstream survive local branch-manager removal without creating branches or recursing into submodules', ['upstream uses cache without fetch or local branch creation', 'fetch to local bare remote disables prune/pruneTags and never moves HEAD', 'fetch and upstream preserve staged, unstaged and untracked bytes without local branch changes', 'upstream rechecks the selected cached OID after routine confirmation']],
  ['read-only state fingerprints preserve pull/template confirmation-time protection after mutation-tool removal', ['repository stamps detect index-only changes with identical porcelain and working bytes', 'repository stamps reject same porcelain M with same-size changed worktree bytes', 'repository stamps fingerprint every operation marker including recursive sequencer state', 'repository stamps stop at parent symlinks, file blockers and missing parents', 'repository stamps exclude protected account data under ignored ancestors but still hash siblings', 'pull rechecks repository fingerprints after confirmation before any network command', 'template stop-tracking rejects same-status byte changes during confirmation']],
  ['PR checkout API removed while all server-side merge strategies remain available', ['PR checkout API is absent while server collaboration APIs remain available', 'merge enforces chosen strategy and checks GitHub merged:true']],
  ['retained commit history is offline and read-only', ['commit pages, fixed-text search, selection pagination and graph stay offline', 'commit details separate metadata/stat from sensitive patch confirmation', 'unborn read-only history and cancellation are nonmutating']],
  ['GitHub collaboration CLI via strict fake gh without local PR checkout', ['legacy workflow CLI (code-only unlock stub) new GitHub menu creates an Issue and collaborator invitation using only fake gh']],
  ['explicit Enterprise host via real fake-gh subprocess (not a real server)', ['real runProcess fake-gh CLI validates explicit host, argv, shell:false and no token use']],
  ['byte-verified isolated data backup/restore/relocation and path remapping', ['restore requires explicit replacement, supports exact remap, and preserves existing data aside', 'relocation copies and verifies before context switch, retaining or explicitly deleting the source']],
  ['isolated global install/reinstall/uninstall and offline npm exec; fixture data preserved byte-for-byte', ['packed release allowlist and isolated npm install lifecycle']],
  ['quick grouped CLI configures HTTPS without irrelevant SSH prompts', ['legacy workflow CLI (code-only unlock stub) HTTPS setup does not ask irrelevant SSH fields in quick mode']],
  ['clone reuses selected empty directories and manual remote association avoids redundant browser confirmation', ['clone reuses an existing empty directory with real local Git and no extra quick confirmation', 'quick manual remote association asks only URL and name after selecting the existing workflow']],
  ['label-only profile changes preserve bindings and HTTPS keeps inactive native SSH configuration', ['label-only profile edit preserves schema 2 binding with zero quick-mode confirmation', 'label-only edit synchronizes display-only stale labels even when the old binding label equals the new label', 'HTTPS accepts an inactive native SSH endpoint alias and switching back preserves it']],
  ['external SSH runs directly after selection but still requires actual success verification (offline POSIX fake SSH)', ['external SSH selection executes directly in quick mode; status 1, manual y', 'external SSH selection executes directly in quick mode; status 1, manual n', 'external SSH selection executes directly in quick mode; status 255, manual not asked']],
  ['server-side GitHub collaboration and local Tag creation keep remote and local scopes separate (offline POSIX fixtures)', ['new local Tag is routine and has no additional GitHub actor request; deletion stays hard', 'routine GitHub downloads/local work skip only quick confirmation and always check profile']],
  ['Release downloads support local rename and explicit atomic replacement while retaining original files on failure or races', ['release download installs new files exclusively and replaces only an unchanged hashed file', 'release overwrite failure retains original bytes', 'release overwrite detects same-size same-mtime bytes, identity changes and new-file races', 'release download guided rename/return are local and only overwrite asks a hard confirmation']],
  ['default 50 MiB automatic gitignore with byte-preserving exact rules and unchanged tracked/index content; no LFS dependency', ['automatic large-file ignore uses strict 50 MiB threshold; offset 0', 'automatic large-file ignore uses strict 50 MiB threshold; offset 1', 'automatic large-file ignore is idempotent and does not stage its new rules', 'automatic large-file ignore respects staged deletions and renamed original paths', 'automatic large-file ignore preserves a partially staged gitignore blob', 'subdirectory negations cannot silently include oversized files or duplicate root rules']],
  ['actual CLI local save and local-bare upload exclude oversized new files without additional confirmation', ['legacy workflow CLI (code-only unlock stub) automatically ignores oversized new files before local commit with no LFS or extra confirmation', 'legacy workflow CLI (code-only unlock stub) save and push excludes oversized new files from a real local bare remote', 'legacy workflow CLI (code-only unlock stub) auto ignore preserves partial staging of gitignore and only commits its existing index version', 'first local upload automatically ignores oversized files using the common save workflow', 'cancelling file selection keeps automatic large-file ignore rules without staging or committing']],
  ['bounded native transport and retired OS-login rejection (synthetic helper)', ['native transport no longer exposes OS-login APIs', 'nativeRequest uses command-only argv and protocol-tagged JSON stdin ending at EOF', 'retired identity/authenticate and unknown operations never reach even a permissive old helper', 'environment variables cannot replace a missing packaged helper or bypass integrity']],
  ['production standalone-password startup, mismatch retry, repeated unlock and password change in a real offline PTY', ['production CLI PTY sets and confirms a standalone password, unlocks again and changes only its wrapping password', 'production CLI PTY cancellation before password confirmation creates no directory or location pointer']],
  ['non-echo secret entry and terminal restoration using an actual offline PTY', ['secret input stays in Buffers, accepts literal :q/spaces, erases UTF-8 code points and never echoes', 'Ctrl+C, Ctrl+D and stream EOF cancel partial secrets and restore terminal state', 'real PTY secret input does not echo and restores ordinary prompts after success and cancellation']],
  ['encrypted Vault integrity, fixed KDF bounds, recovery rotation and strict POSIX permissions', ['vault create, binary CRUD, independent nonces, no plaintext on disk, and close', 'recovery rewraps the existing DEK, rotates the code, and invalidates old wrapping credentials', 'strict schema, canonical base64, sizes and fixed KDF costs fail before attempting a KDF', 'manifest rejects ciphertext, metadata, record removal and wrapper tampering for every open-session operation', 'each record GCM AAD independently binds id, metadata, vault identity and purpose', 'POSIX modes and ownership are strict and never silently repaired on existing paths']],
  ['synthetic encrypted SSH profiles with real single-key native agents, concurrent reuse, quoted paths and close cleanup (no remote connection)', ['encrypted profiles use single-key native agents, deduplicate starts, quote spaces and lock without fallback']],
  ['synthetic legacy SSH migration verifies encrypted copies and preserves originals on cancellation or wrong passphrases', ['legacy plain/encrypted migration verifies ciphertext and changes only the managed private copy', 'cancelled migration preserves external and managed originals and leaves the vault unchanged', 'wrong legacy passphrase clears input and preserves all originals without writing a vault record']],
  ['managed HTTPS helper scope and IPC shutdown with real local Git, no external fallback or remote connection', ['token enrollment asks host/account before secret, encrypts and clears input without a real API', 'HTTPS helper resets inherited helpers, scopes protocol/host/path/account and never changes remote/config', 'HTTPS missing credentials or ambiguous targets fail instead of falling back', 'IPC rejects invalid capabilities/protocol and session close destroys idle sockets promptly']],
  ['managed gh host/actor Token injection and environment cleanup using a synthetic subprocess runner', ['gh injects only selected host/actor tokens into child env and clears env on success or failure', 'managed gh refuses missing actor/token, external login/switch, session replacement and credential environment', 'managed authentication enrolls tokens explicitly, verifies actor, and never runs gh auth login/switch']],
  ['HTTPS release repository scope and explicit Git 2.34 transport pinning (offline)', ['release tag push scopes both profile contexts to selected release repository rather than origin', 'explicit command-scoped push target works on Git 2.34 and cannot follow pushInsteadOf', 'explicit command-scoped targets reject insteadOf rewrites without any network request']],
  ['protected restore/switch staging with distinct standalone passwords, failed-commit rollback and live-session password change', ['restore decrypts staging with its standalone password before replacement and activates without a second password', 'three real staging password failures followed by exit never replace target or close the protected session', 'a managed-key marker without a decryptable vault record cannot replace a restore target', 'a location commit failure rolls installed restore data back and never drops the old protected session', 'switching to an independently encrypted target asks its distinct password, commits it and closes the old session', 'explicit lock closes the vault and removes the current session', 'standalone password change verifies old/new/new and keeps the same live session, records and recovery wrapper', 'encrypted backup with no live session requires UI verification and rejects three real wrong passwords before installation', 'an independent encrypted backup cannot be installed without UI or a matching live DEK']],
  ['bare-command location/standalone-password/project guidance with a real encrypted Vault and code-only secret input', ['startup help/version bypass terminal preflight, input and credential storage', 'bare startup chooses location, confirms a real standalone password, selects a project and unlocks again next time', 'cancelling the bare startup chooser preserves last project and recent records and locks the vault', 'bare startup can create a local project folder without Git initialization or another creation confirmation', 'declining first recovery-code acknowledgement retains the encrypted library but never commits its startup pointer', 'explicit project path skips only project selection, while cancelled new passwords create no location or library directories']],
  ['standalone password creation, three-attempt limit, explicit offline recovery and missing-library protection', ['missing vaults are never created unless initialization is explicitly allowed', 'new-password validation and mismatched confirmation loop locally, clear rejected Buffers and create nothing on cancellation', 'three failed passwords allow only explicit recovery or exit, never a fourth password or any store mutation', 'explicit offline recovery confirms a new password, preserves secrets and rotates the recovery code', 'nonempty token-only or legacy data requires one explicit new-library confirmation, while empty data is silent', 'managed markers, including wrong IDs, malformed suffixes and orphaned profiles, prevent empty replacement vault creation']],
  ['password-only rewrapping preserves DEK, record ciphertext, original recovery wrapper and short legacy compatibility', ['password changes authenticate the latest old wrapper while preserving DEK, recovery, records, identity and open sessions', 'short legacy schema-1 passwords remain unlockable and change to exact Unicode passwords without normalization', 'wrong recovery preflight never creates a lock, alters directory metadata or repairs existing permissions', 'password-change failures preserve encrypted bytes and reject a replaced vault identity']],
  ['startup location recovery, deferred pointer commits and concurrent-location protection (isolated libraries)', ['startup location retries invalid input, expands home and commits only after encrypted directory creation', 'missing remembered location requires an explicit choice and never initializes an empty replacement', 'a moved encrypted library is selected without changing its remembered pointer before unlock', 'a deleted vault is not silently recreated even when its data directory remains', 'a concurrent pointer change cannot be overwritten by a staged first startup', 'a concurrent pointer change is detected while reusing an unlocked remembered location too', 'failed unlock of a located library preserves its pointer and bytes and never reaches the project guide']],
  ['startup local/new/recent project choices and clone/account preparation using isolated fixtures and a local bare repository', ['startup project chooser always prompts even with a valid remembered project', 'startup creates a new nested local folder without .git, account writes or additional confirmations', 'startup recent projects keep favorite and recency ordering without touching any registry or preferences', 'startup download uses the existing clone workflow with a real isolated local bare repository', 'startup failed downloads are not retried and partial clone data remains intact', 'startup download submenu exposes first-account setup and encrypted token enrollment without a project']],
];

const workspace = await createScratch(`verify-${version.replaceAll('.', '-')}-`);
const scratch = workspace.directory;
const output = join(scratch, 'output'), cliEvidence = join(scratch, 'cli-evidence');
let completed = false;
try {
  await mkdir(output); await mkdir(cliEvidence);
  const userNpmConfig = join(scratch, 'user.npmrc'), globalNpmConfig = join(scratch, 'global.npmrc');
  await writeFile(userNpmConfig, ''); await writeFile(globalNpmConfig, '');
  const environment = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
  for (const key of Object.keys(environment)) if (/^(?:GIT_|GH_|GITHUB_|npm_config_)/iu.test(key) || ['DEBUG', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'BROWSER'].includes(key.toUpperCase())) delete environment[key];
  Object.assign(environment, { npm_config_userconfig: userNpmConfig, npm_config_globalconfig: globalNpmConfig, npm_config_update_notifier: 'false', npm_config_fetch_retries: '0', AUTOGIT_VERIFICATION_DIR: cliEvidence, GIT_ALLOW_PROTOCOL: 'file' });

  async function command(program, args, { input, cwd = root, env = environment } = {}) {
    return new Promise((resolveResult, reject) => {
      const child = spawn(program, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const out = [], err = [];
      child.stdout.on('data', data => out.push(data)); child.stderr.on('data', data => err.push(data));
      child.once('error', reject); child.once('close', status => resolveResult({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); }); child.stdin.end(input);
    });
  }
  async function checked(args, log, { json = false } = {}) {
    const result = await command(process.execPath, [npm, ...args]);
    if (log) await writeFile(join(output, log), json && result.status === 0 ? `${JSON.stringify(JSON.parse(result.stdout.toString('utf8')), null, 2)}\n` : Buffer.concat([result.stdout, result.stderr]));
    assert.equal(result.status, 0, `npm ${args.join(' ')} failed\n${result.stderr}\n${result.stdout}`);
    return result;
  }
  async function filesUnder(directory) {
    const files = [];
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) files.push(...await filesUnder(child));
      else if (entry.isFile()) files.push(child);
      else throw new Error(`Unexpected non-regular release input: ${child}`);
    }
    return files;
  }
  async function sourceSnapshot() {
    const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'docs/capabilities.md', 'start.sh', 'start.bat', '.github/workflows/tests.yml'];
    for (const directory of ['src', 'scripts', 'tests-node']) files.push(...(await filesUnder(directory)).filter(file => /\.(?:ts|mjs)$/u.test(file)));
    files.push(...(await filesUnder('native')).filter(file => !file.startsWith('native/bin/')));
    return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])));
  }

  const sources = await sourceSnapshot();
  await checked(['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], `npm-ci-${version}.txt`);
  await checked(['run', 'typecheck'], `typecheck-${version}.txt`);
  const tests = await checked(['test'], `test-results-${version}.txt`);
  const testLines = tests.stdout.toString('utf8').split(/\r?\n/u);
  const summary = testLines.filter(line => /^# (?:tests|pass|fail|cancelled|skipped|todo|duration_ms) /u.test(line));
  const results = new Map();
  for (const line of testLines) {
    const match = /^\s*(ok|not ok) \d+ - (.+?)(?: # (SKIP|TODO)\b.*)?$/u.exec(line);
    if (match) { assert.ok(!results.has(match[2]), `Duplicate test title: ${match[2]}`); results.set(match[2], match[1] === 'ok' && !match[3]); }
  }
  for (const [, names] of evidence) for (const name of names) assert.ok(results.has(name), `验收引用的测试名称不存在，请同步测试与证据清单：${name}`);
  const passed = names => names.every(name => results.get(name));
  const packed = await checked(['pack', '--json', '--pack-destination', output], `npm-pack-${version}.json`, { json: true });
  const info = JSON.parse(packed.stdout.toString('utf8'))[0];
  const archive = join(output, info.filename);
  const nativeRuntime = [];
  try {
    for (const directory of await readdir(join(root, 'native', 'bin'))) nativeRuntime.push(...(await filesUnder(`native/bin/${directory}`)));
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const file of nativeRuntime) assert.match(file, /^native\/bin\/(?:linux|win32)-(?:x64|arm64)\/(?:manifest\.json|autogit-auth(?:\.exe)?)$/u, `Unexpected native runtime file: ${file}`);
  const allowed = new Set([
    'README.md', 'docs/capabilities.md', 'package.json',
    ...await filesUnder('dist'),
    ...nativeRuntime,
  ]);
  assert.deepEqual(info.files.map(file => file.path).sort(), [...allowed].sort());
  for (const name of ['branches', 'destructive', 'operations', 'stash', 'worktrees', 'submodules', 'lfs']) {
    assert.ok(!allowed.has(`dist/${name}.js`), `Retired module remained in release: ${name}`);
  }
  const raw = gunzipSync(await readFile(archive)); const entries = [];
  for (let offset = 0; offset + 512 <= raw.length;) {
    const header = raw.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim(), 8) || 0;
    entries.push(prefix ? `${prefix}/${name}` : name); offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.deepEqual(entries.sort(), [...allowed].map(file => `package/${file}`).sort());

  const base = await mkdtemp(join(scratch, 'cli-'));
  try {
    const home = join(base, 'home'), project = join(base, '项目'), appRoot = join(base, 'AutoGit');
    await mkdir(home); await mkdir(project);
    const env = { ...environment, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'AppData'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), AUTOGIT_DATA_DIR: join(appRoot, 'data') };
    const init = await command('git', ['init', '--initial-branch=main'], { cwd: project, env }); assert.equal(init.status, 0);
    const rejected = await command(process.execPath, [join(root, 'dist/cli.js'), '--path', project], { cwd: project, env, input: Buffer.from('0\n') });
    assert.equal(rejected.status, 1, 'Production CLI must reject piped, unauthenticated startup');
    assert.doesNotMatch(rejected.stdout.toString(), /你想做什么/);
    const smoke = await command(process.execPath, [join(root, 'tests-node/cli-driver.mjs'), '--path', project], { cwd: project, env, input: Buffer.from('6\n1\n1\n4\n4\n2\n0\n') });
    assert.equal(smoke.status, 0); assert.match(smoke.stdout.toString(), /工作区干净/); assert.match(smoke.stdout.toString(), /已启用详细确认模式/); assert.match(smoke.stdout.toString(), /已退出/);
    const expectedTranscripts = [
      ['legacy workflow CLI (code-only unlock stub) creates a private fixture repository, links and uploads offline', `cli-creation-private-${version}.txt`],
      ['legacy workflow CLI (code-only unlock stub) creates a public fixture repository, links and uploads offline', `cli-creation-public-${version}.txt`],
      ['legacy workflow CLI (code-only unlock stub) new GitHub menu creates an Issue and collaborator invitation using only fake gh', `github-cli-collaboration-${version}.txt`],
    ].filter(([name]) => results.get(name)).map(([, file]) => file).sort();
    assert.deepEqual((await readdir(cliEvidence)).sort(), expectedTranscripts, 'Passed CLI tests must provide their expected transcripts.');
    const sections = ['Production CLI fails closed without a secure terminal (no standalone-password attempt)\n', rejected.stdout, rejected.stderr, '\nWorkflow smoke: legacy code-only unlock stub; fixture workflows, not production Vault password or encrypted SSH verification\n', smoke.stdout, smoke.stderr];
    for (const file of expectedTranscripts) sections.push(`\n\n── ${file} ──\n`, await readFile(join(cliEvidence, file)));
    await writeFile(join(output, `cli-smoke-${version}.txt`), Buffer.concat(sections.map(section => typeof section === 'string' ? Buffer.from(section) : section)));
  } finally { await rm(base, { recursive: true, force: true }); }

  assert.deepEqual(await sourceSnapshot(), sources, 'Source, tests or documentation changed during release verification; run again on a frozen snapshot.');
  const bytes = await readFile(archive); const sha256 = createHash('sha256').update(bytes).digest('hex');
  const report = {
    version, date: new Date().toISOString(), platform: os.platform(), release: os.release(), node: process.version,
    npm: (await command(process.execPath, [npm, '--version'])).stdout.toString().trim(),
    git: (await command('git', ['--version'])).stdout.toString().trim(),
    ssh: Buffer.concat(Object.values(await command('ssh', ['-V'])).filter(Buffer.isBuffer)).toString().trim(),
    tests: summary, sourceSha256: sources, package: { filename: info.filename, size: bytes.length, sha256, files: info.files.map(file => file.path), integrity: info.integrity },
    verified: ['offline npm ci', 'strict typecheck', 'Node regression suite', 'production CLI fails closed without a secure terminal', 'legacy workflow smoke via code-only unlock stub; standalone Vault/PTY evidence is listed separately', ...evidence.filter(([, names]) => passed(names)).map(([description]) => description), 'npm tarball allowlist including native runtime artifacts'],
    notVerified: ['Windows actual runtime and native OpenSSH/TTY; Linux native helper tests/builds are reported separately under artifacts/login-security', 'Node 24 actual runtime', 'real GitHub/Enterprise authentication, organization SSO/permissions, repository management, force push and PR/Issue/Review/Release APIs', 'native SSH alias/proxy/jump connections', 'public npm package name availability', ...evidence.filter(([, names]) => !passed(names)).map(([description]) => `${description} (fixture tests skipped in this environment)`)],
    testEnvironment: 'Isolated fixture HOME/data/Git/gh/npm configuration; inherited credential, Node injection, proxy and askpass environment cleared; file-only Git protocols except explicit fake-SSH fixtures.',
    existingGlobalInstallationModified: false,
    publicRegistryPublished: false,
  };
  await writeFile(join(output, `release-${version}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(output, `verification-${version}.txt`), `AutoGit ${version} TypeScript / Node.js verification\n${report.date}\n${report.platform} ${report.release}\nNode ${report.node}; npm ${report.npm}; ${report.git}; ${report.ssh}\n\n${summary.join('\n')}\n\nVerified:\n${report.verified.map(item => `- ${item}`).join('\n')}\n\nNot verified:\n${report.notVerified.map(item => `- ${item}`).join('\n')}\n\nNo public npm publication. Runtime requires no Python.\nPackage: ${info.filename}\nSize: ${bytes.length} bytes\nSHA256: ${sha256}\nFiles: ${info.files.length} (compiled JS, native key/permission helper artifacts, README, capability ledger, package.json)\n`);
  const expected = [info.filename, `release-${version}.json`, `verification-${version}.txt`, `test-results-${version}.txt`, `typecheck-${version}.txt`, `npm-ci-${version}.txt`, `npm-pack-${version}.json`, `cli-smoke-${version}.txt`];
  assert.deepEqual((await readdir(output)).sort(), [...expected].sort());
  await mkdir(artifacts, { recursive: true });
  for (const file of expected.filter(file => file !== `release-${version}.json`)) await copyFile(join(output, file), join(artifacts, file));
  await copyFile(join(output, `release-${version}.json`), join(artifacts, `release-${version}.json`));
  completed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (completed) await workspace.cleanup();
  else console.error(`验收未完成，请勿将本次输出视为正式通过；诊断文件保留在：${scratch}`);
}
