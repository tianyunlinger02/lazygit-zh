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

// Exact titles make renamed or removed evidence fail visibly instead of disappearing from the report.
const evidence = [
  ['public/private creation-link-upload via fake gh and local bare Git', ['public CLI creates a private fixture repository, links and uploads offline', 'public CLI creates a public fixture repository, links and uploads offline']],
  ['native Ctrl+C unknown-creation recovery (offline POSIX PTY test)', ['Ctrl+C during a GitHub create reports unknown result and restores the menu without retry']],
  ['public CLI unstage/reset/clean with actual local Git and cancellation', ['public CLI menu 15 unstage, reset and clean honor hard cancellation and mutate only confirmed targets']],
  ['public CLI lease and unconditional force against divergent local bare histories', ['public CLI menu 16 performs real lease and unconditional force against a local bare remote']],
  ['actual push URL lease pinning and concurrent peer update rejection', ['lease protects the actual push URL OID, not the fetch URL or stale tracking ref', 'server-side lease rejects a peer update after the final query without a force retry']],
  ['multi-URL configuration management and partial-failure reporting (offline)', ['remote URL list add, remove and inherited push reset preserve the other list', 'remote URL partial failure reports completed fetch without retrying or claiming atomic success']],
  ['real local rebase/conflict/sequencer and detached bisect recovery', ['rebase conflict roles, continue, skip and abort use real Git state', 'bisect good/bad/skip/reset support detached inspection and never run repository code']],
  ['multi-commit/range cherry-pick and revert with pinned OIDs and real batch sequencer recovery', ['multi-commit sequencer conflict can continue, skip or abort the entire already-started batch', 'range execution pins expanded commits even if its source ref moves during the one confirmation']],
  ['public GitHub collaboration CLI via strict fake gh and four local bare PR checkout transport modes', ['real public CLI new GitHub menu creates an Issue and collaborator invitation using only fake gh', ...['default-managed', 'managed-ssh', 'native-ssh', 'https'].map(mode => `PR checkout uses ${mode} transport and mapped local bare repo without remotes/upstream`)]],
  ['explicit Enterprise host via real fake-gh subprocess (not a real server)', ['real runProcess fake-gh CLI validates explicit host, argv, shell:false and no token use']],
  ['byte-verified isolated data backup/restore/relocation and path remapping', ['restore requires explicit replacement, supports exact remap, and preserves existing data aside', 'relocation copies and verifies before context switch, retaining or explicitly deleting the source']],
  ['real local linked worktrees and independently scoped submodules', ['move from a linked root returns the replacement project directory', 'recursive update discovers each nested URL in its own repository and never updates parent recursively']],
  ['LFS endpoint and scope tests via dedicated fake runner only', ['push uploads only current HEAD objects on actual push URL without pushing Git refs']],
  ['isolated global install/reinstall/uninstall and offline npm exec; fixture data preserved byte-for-byte', ['packed release allowlist and isolated npm install lifecycle']],
  ['quick CLI carries staged/unstaged work into a new branch and configures HTTPS without irrelevant SSH prompts', ['public CLI carries staged and unstaged work into a new branch without confirmation or stash', 'public CLI HTTPS setup does not ask irrelevant SSH fields in quick mode']],
  ['clone reuses selected empty directories and manual remote association avoids redundant browser confirmation', ['clone reuses an existing empty directory with real local Git and no extra quick confirmation', 'quick manual remote association asks only URL and name after selecting the existing workflow']],
  ['explicit unrelated-history merge and routine conflict/bisect progression retain destructive confirmation boundaries', ['unrelated histories require explicit selection and exactly one hard confirmation in quick mode', 'unrelated history conflicts retain the merge and require a separate continue choice', 'resolved-only and normal continue use routine confirmation in quick mode without overwriting external edits', 'bisect good/bad/skip use routine confirmation but reset keeps one hard confirmation in quick mode']],
  ['label-only profile changes preserve bindings and HTTPS keeps inactive native SSH configuration', ['label-only profile edit preserves schema 2 binding with zero quick-mode confirmation', 'label-only edit synchronizes display-only stale labels even when the old binding label equals the new label', 'HTTPS accepts an inactive native SSH endpoint alias and switching back preserves it']],
  ['external SSH runs directly after selection but still requires actual success verification (offline POSIX fake SSH)', ['external SSH selection executes directly in quick mode; status 1, manual y', 'external SSH selection executes directly in quick mode; status 1, manual n', 'external SSH selection executes directly in quick mode; status 255, manual not asked']],
  ['PR duplicate-name choices and local Tag creation keep routine and destructive actions separate (offline POSIX fixtures)', ['PR checkout duplicate-name choices preserve dirty, do not update switch-only branches and reject unsafe rebuilds', 'new local Tag is routine and has no additional GitHub actor request; deletion stays hard', 'routine GitHub downloads/local work skip only quick confirmation and always check profile']],
  ['Release downloads support local rename and explicit atomic replacement while retaining original files on failure or races', ['release download installs new files exclusively and replaces only an unchanged hashed file', 'release overwrite failure retains original bytes', 'release overwrite detects same-size same-mtime bytes, identity changes and new-file races', 'release download guided rename/return are local and only overwrite asks a hard confirmation']],
  ['default 50 MiB automatic gitignore with byte-preserving exact rules and unchanged tracked/index content; no LFS dependency', ['automatic large-file ignore uses strict 50 MiB threshold; offset 0', 'automatic large-file ignore uses strict 50 MiB threshold; offset 1', 'automatic large-file ignore is idempotent and does not stage its new rules', 'automatic large-file ignore respects staged deletions and renamed original paths', 'automatic large-file ignore preserves a partially staged gitignore blob', 'subdirectory negations cannot silently include oversized files or duplicate root rules']],
  ['actual CLI local save and local-bare upload exclude oversized new files without additional confirmation', ['public CLI automatically ignores oversized new files before local commit with no LFS or extra confirmation', 'public CLI save and push excludes oversized new files from a real local bare remote', 'public CLI auto ignore preserves partial staging of gitignore and only commits its existing index version', 'first local upload automatically ignores oversized files using the common save workflow', 'cancelling file selection keeps automatic large-file ignore rules without staging or committing']],
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
  async function sourceSnapshot() {
    const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'docs/capabilities.md'];
    for (const directory of ['src', 'scripts', 'tests-node']) for (const file of (await readdir(join(root, directory))).sort()) if (/\.(?:ts|mjs)$/u.test(file)) files.push(`${directory}/${file}`);
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
  const allowed = new Set(['README.md', 'docs/capabilities.md', 'package.json', ...(await readdir(join(root, 'dist'))).map(file => `dist/${file}`)]);
  assert.deepEqual(info.files.map(file => file.path).sort(), [...allowed].sort());
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
    const smoke = await command(process.execPath, [join(root, 'dist/cli.js'), '--path', project], { cwd: project, env, input: Buffer.from('6\n1\n13\n2\n0\n') });
    assert.equal(smoke.status, 0); assert.match(smoke.stdout.toString(), /工作区干净/); assert.match(smoke.stdout.toString(), /已启用详细确认模式/); assert.match(smoke.stdout.toString(), /已退出/);
    const expectedTranscripts = [
      ['public CLI creates a private fixture repository, links and uploads offline', `cli-creation-private-${version}.txt`],
      ['public CLI creates a public fixture repository, links and uploads offline', `cli-creation-public-${version}.txt`],
      ['real public CLI new GitHub menu creates an Issue and collaborator invitation using only fake gh', `github-cli-collaboration-${version}.txt`],
    ].filter(([name]) => results.get(name)).map(([, file]) => file).sort();
    assert.deepEqual((await readdir(cliEvidence)).sort(), expectedTranscripts, 'Passed CLI tests must provide their expected transcripts.');
    const sections = ['Public CLI smoke (isolated local fixture)\n', smoke.stdout, smoke.stderr];
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
    verified: ['offline npm ci', 'strict typecheck', 'Node regression suite', 'public CLI smoke', ...evidence.filter(([, names]) => passed(names)).map(([description]) => description), 'npm tarball allowlist'],
    notVerified: ['Windows actual runtime and native OpenSSH/TTY', 'Node 24 actual runtime', 'real GitHub/Enterprise authentication, organization SSO/permissions, repository management, force push and PR/Issue/Review/Release APIs', 'real LFS server and native SSH alias/proxy/jump connections', 'public npm package name availability', ...evidence.filter(([, names]) => !passed(names)).map(([description]) => `${description} (fixture tests skipped in this environment)`)],
    testEnvironment: 'Isolated fixture HOME/data/Git/gh/npm configuration; inherited credential, Node injection, proxy and askpass environment cleared; file-only Git protocols except explicit fake-SSH fixtures.',
    existingGlobalInstallationModified: false,
    publicRegistryPublished: false,
  };
  await writeFile(join(output, `release-${version}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(output, `verification-${version}.txt`), `AutoGit ${version} TypeScript / Node.js verification\n${report.date}\n${report.platform} ${report.release}\nNode ${report.node}; npm ${report.npm}; ${report.git}; ${report.ssh}\n\n${summary.join('\n')}\n\nVerified:\n${report.verified.map(item => `- ${item}`).join('\n')}\n\nNot verified:\n${report.notVerified.map(item => `- ${item}`).join('\n')}\n\nNo public npm publication. Runtime requires no Python.\nPackage: ${info.filename}\nSize: ${bytes.length} bytes\nSHA256: ${sha256}\nFiles: ${info.files.length} (compiled JS, README, capability ledger, package.json only)\n`);
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
