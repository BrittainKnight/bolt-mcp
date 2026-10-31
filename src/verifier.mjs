import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './process.mjs';
import { cleanEnvironment, permissionArgs } from './templates/isolation.mjs';
import { auditUnlocked } from './auditor.mjs';
import { projectRoot, slotRoot, fingerprint, withProject } from './paths.mjs';
import { openLedger, updateSlot } from './ledger.mjs';

export async function verifyUnlocked({ projectPath = process.cwd(), slotId, testCommand, timeoutMs = 30000, allowedEnvKeys = [], sandboxMode = 'clean-env' }) {
  const root = projectRoot(projectPath);
  const env = cleanEnvironment(allowedEnvKeys);
  const flags = permissionArgs(root, { sandboxMode, allowChildProcess: true });
  const directory = slotRoot(root, slotId);
  const python = fs.existsSync(path.join(directory, 'contract.test.py'));
  if (sandboxMode === 'node-permission' && (python || testCommand !== undefined)) throw new Error('node-permission requires a generated Node contract; Python and custom shell commands require clean-env');
  const audit = auditUnlocked({ projectPath: root, slotId });
  if (!audit.ok) return { ...audit, verified: false };
  if (testCommand !== undefined && (typeof testCommand !== 'string' || !testCommand.trim())) throw new Error('testCommand must be nonempty');
  const before = fingerprint(directory);
  updateSlot(root, slotId, { status: 'POLISHED', verified_hash: null, last_verified_at: null });
  const relative = `src/bolted/${slotId}/contract.test.${python ? 'py' : 'mjs'}`;
  const context = `--bolt-context=${JSON.stringify({ projectPath: root, allowedEnvKeys, sandboxMode, managedGroup: true })}`;
  const args = python ? ['-B', relative, context] : [...flags, relative, context];
  const command = testCommand ?? `${python ? 'python3 -B' : ['node', ...flags].join(' ')} ${relative}`;
  const started = performance.now();
  const result = testCommand ? await run(testCommand, [], { cwd: root, shell: true, timeoutMs, env, allowedEnvKeys }) : await run(python ? 'python3' : process.execPath, args, { cwd: root, timeoutMs, env, allowedEnvKeys });
  const logs = openLedger(root);
  try { logs.prepare('INSERT INTO verification_runs(slot_id,command,exit_code,duration_ms,stdout,stderr,timed_out,truncated,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(slotId, command, result.exitCode, Math.round(performance.now() - started), result.stdout, result.stderr, Number(result.timedOut), Number(result.truncated), new Date().toISOString()); } finally { logs.close(); }
  const after = auditUnlocked({ projectPath: root, slotId });
  const unchanged = before === fingerprint(directory);
  const verified = result.exitCode === 0 && !result.timedOut && !result.truncated && after.ok && unchanged;
  if (verified) updateSlot(root, slotId, { status: 'VERIFIED', verified_hash: before, test_cmd: command, last_verified_at: new Date().toISOString() });
  return { slotId, ok: verified, verified, status: verified ? 'VERIFIED' : after.status, result, findings: after.findings, security_notices: after.security_notices, unchanged, sandboxMode };
}
export const verifySlot = options => withProject(options.projectPath, () => verifyUnlocked(options));
