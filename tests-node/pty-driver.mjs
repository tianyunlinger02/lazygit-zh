import { spawn } from 'node:child_process';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

/** Real POSIX terminal, production CLI, prompt-driven input; never a login/unlock substitute. */
export async function productionPty(t, cli, { cwd, env, args = [], steps, timeout = 20000 }) {
  const command = [process.execPath, cli, ...args].map(quote).join(' ');
  const child = spawn('script', ['-q', '-e', '-c', command, '/dev/null'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '', offset = 0, index = 0;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') errors += error.code ?? 'stdin-error'; });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdout.on('data', chunk => {
    output += chunk;
    if (index >= steps.length) return;
    const [marker, input] = steps[index];
    const start = output.indexOf(marker, offset);
    if (start < 0) return;
    offset = start + marker.length;
    index++;
    child.stdin.write(input);
  });
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { status, output, errors, steps: index, expectedSteps: steps.length };
  } finally { clearTimeout(timer); child.stdin.end(); }
}
