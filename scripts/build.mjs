import { lstat, readdir, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
try {
  const info = await lstat(output);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('dist 必须是普通生成目录，不能是链接。');
  const files = await readdir(output, { withFileTypes: true });
  if (files.some(file => !file.isFile() || !/^[a-z-]+\.js$/u.test(file.name))) throw new Error('dist 含非预期文件，停止自动清理；请检查生成目录。');
  await rm(output, { recursive: true });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const child = spawn(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit', shell: false });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
