import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit developer/release command only. This script does not download Go,
// install system packages, authenticate OS accounts, or hook npm test/prepack.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = join(root, 'native');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--test') || args.length > 1) throw new Error('Usage: node scripts/build-native.mjs [--test]');
const goos = process.env.GOOS ?? ({ linux: 'linux', win32: 'windows' }[process.platform]);
const goarch = process.env.GOARCH ?? ({ x64: 'amd64', arm64: 'arm64' }[process.arch]);
const platform = { linux: 'linux', windows: 'win32' }[goos];
const arch = { amd64: 'x64', arm64: 'arm64' }[goarch];
if (!platform || !arch) throw new Error('Supported targets: GOOS=linux|windows GOARCH=amd64|arm64.');
if (args.includes('--test') && (platform !== process.platform || arch !== process.arch)) throw new Error('--test requires a native host target; Windows cross-builds are not Windows runtime tests.');

async function plainDirectory(path, { privateMode = false } = {}) {
  // Check existing ancestors too; mkdir(recursive) must not traverse a planted
  // symlink or junction in cache/output directories.
  const parent = dirname(path);
  if (parent !== path) await plainExisting(parent);
  try { await mkdir(path, { mode: privateMode ? 0o700 : 0o755 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Native build directory must not be a link.');
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Native build directory must belong to the current user.');
  if (privateMode) await chmod(path, 0o700);
}
async function plainExisting(path) {
  const parent = dirname(path);
  if (parent !== path) await plainExisting(parent);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Native build ancestors must be ordinary directories.');
}
async function regularOrMissing(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Native output must be a single regular file.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const temporaryRoot = join(root, '.claude-tmp');
await plainDirectory(temporaryRoot, { privateMode: true });
const cache = join(temporaryRoot, 'native-build');
await plainDirectory(cache, { privateMode: true });
for (const name of ['gopath', 'modules', 'build-cache', 'tmp', 'xdg', 'config', 'telemetry']) await plainDirectory(join(cache, name), { privateMode: true });
const session = await mkdtemp(join(cache, 'run-'));
await chmod(session, 0o700);
const configuredGo = process.env.GO_BINARY;
const go = configuredGo ? (isAbsolute(configuredGo) || configuredGo.includes('/') ? resolve(root, configuredGo) : configuredGo) : 'go';
const env = {
  ...process.env,
  GOOS: goos, GOARCH: goarch,
  // All supported helpers are pure Go; no C compiler or OS-auth library is required.
  CGO_ENABLED: '0',
  // Fail rather than implicitly download a toolchain newer than PATH Go.
  GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOFLAGS: '',
  // Dependencies must already be in the local cache; builds never contact services.
  GOPROXY: 'off', GOSUMDB: 'off',
  GOTELEMETRY: 'off',
  GOPATH: join(cache, 'gopath'), GOMODCACHE: join(cache, 'modules'),
  GOCACHE: join(cache, 'build-cache'), GOTMPDIR: join(cache, 'tmp'),
  TMPDIR: join(cache, 'tmp'), TMP: join(cache, 'tmp'), TEMP: join(cache, 'tmp'),
  XDG_CACHE_HOME: join(cache, 'xdg'), XDG_CONFIG_HOME: join(cache, 'config'),
  GOTELEMETRYDIR: join(cache, 'telemetry'),
};
function execute(arguments_) {
  return new Promise((resolve_, reject) => {
    const child = spawn(go, arguments_, { cwd: native, env, stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', () => reject(new Error('Go could not start; set GO_BINARY to a verified local Go 1.26+ toolchain or install Go on PATH. No toolchain was downloaded.')));
    child.once('exit', (code, signal) => code === 0 && !signal ? resolve_() : reject(new Error('Native Go command failed; no new deliverable was published.')));
  });
}
try {
  await plainExisting(native);
  if (args.includes('--test')) await execute(['test', '-mod=readonly', '-count=1', './...']);
  const binary = `autogit-auth${goos === 'windows' ? '.exe' : ''}`;
  const built = join(session, binary);
  await execute(['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', built, '.']);
  const info = await lstat(built);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1) throw new Error('Go did not produce a regular executable.');
  if (process.platform !== 'win32') await chmod(built, 0o755);
  const sha256 = createHash('sha256').update(await readFile(built)).digest('hex');
  const manifest = join(session, 'manifest.json');
  await writeFile(manifest, `${JSON.stringify({ protocol: 1, platform, arch, sha256 }, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  await plainDirectory(join(native, 'bin'));
  const output = join(native, 'bin', `${platform}-${arch}`);
  await plainDirectory(output);
  await regularOrMissing(join(output, binary));
  await regularOrMissing(join(output, 'manifest.json'));
  // The manifest is replaced last. If interrupted between renames, checksum
  // verification fails closed instead of selecting an unverified binary.
  await rename(built, join(output, binary));
  await rename(manifest, join(output, 'manifest.json'));
  console.log(`Built native/bin/${platform}-${arch}/${binary} (protocol 1, SHA256 ${sha256}).`);
} finally {
  await rm(session, { recursive: true, force: true });
}
