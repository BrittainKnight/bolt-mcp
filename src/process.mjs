import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { cleanEnvironment } from './templates/isolation.mjs';

export function run(command, args = [], { cwd, timeoutMs = 30000, shell = false, maxBytes = 1024 * 1024, env = process.env, allowedEnvKeys = [] } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('timeoutMs must be between 1 and 600000');
  return new Promise(resolve => {
    const start = performance.now();
    const childEnv = cleanEnvironment(allowedEnvKeys, env);
    const child = spawn(command, args, { cwd, shell, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, truncated = false;
    const kill = () => {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') stderr += error.message; }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { truncated = true; kill(); return; }
      if (key === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    });
    child.on('error', error => { stderr += error.message; });
    child.once('exit', kill); // Descendants may still hold the output pipes open.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      kill(); // Also stop descendants that outlive their parent.
      resolve({ exitCode: code ?? -1, signal, durationMs: Math.round(performance.now() - start), stdout, stderr, timedOut, truncated });
    });
  });
}
export async function git(args, cwd) {
  const result = await run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, timeoutMs: 120000, env: { ...cleanEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }, allowedEnvKeys: ['GIT_TERMINAL_PROMPT', 'GIT_CONFIG_NOSYSTEM'] });
  if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new Error(`Git failed: ${result.stderr.trim() || result.exitCode}`);
  return result.stdout.trim();
}
