import path from 'node:path';
import os from 'node:os';

const systemKeys = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP'];
export function cleanEnvironment(allowedEnvKeys = [], source = process.env) {
  if (!Array.isArray(allowedEnvKeys) || allowedEnvKeys.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error('allowedEnvKeys must be environment variable names');
  const env = Object.fromEntries([...new Set([...systemKeys, ...allowedEnvKeys])].filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
  // Node's nested test context can silently skip contracts, even when explicitly allowed.
  delete env.NODE_TEST_CONTEXT;
  return { ...env, NODE_ENV: 'test', PYTHONDONTWRITEBYTECODE: '1' };
}
export function permissionArgs(projectPath, { sandboxMode = 'clean-env', allowChildProcess = false } = {}) {
  if (!['clean-env', 'node-permission'].includes(sandboxMode)) throw new Error('Invalid sandboxMode');
  if (sandboxMode === 'clean-env') return [];
  const flag = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : process.allowedNodeEnvironmentFlags.has('--experimental-permission') ? '--experimental-permission' : null;
  if (!flag) throw new Error('This Node runtime does not support node-permission mode');
  const roots = [...new Set([path.resolve(projectPath), path.resolve(os.tmpdir())])];
  if (roots.some(root => /[*?,]/.test(root))) throw new Error('Permission roots cannot contain wildcard or comma characters');
  return [flag, ...roots.flatMap(root => [`--allow-fs-read=${root}`, `--allow-fs-write=${root}`]), ...(allowChildProcess ? ['--allow-child-process'] : [])];
}
export function executionContext() {
  const arg = process.argv.find(value => value.startsWith('--bolt-context='));
  return arg ? JSON.parse(arg.slice('--bolt-context='.length)) : {};
}
