import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { initLedger, surgicalHarvest, scaffoldAdapter, verifySlot } from '../src/index.mjs';
import { run } from '../src/process.mjs';
import { cleanEnvironment, permissionArgs } from '../src/templates/isolation.mjs';

async function setup(t, code, { language = 'mjs', inputSchema = { type: 'null', examples: [null] }, outputSchema = { type: 'boolean', examples: [true] }, timeoutMs = 1000 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-isolation-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), source = path.join(base, 'source'); fs.mkdirSync(root); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, `entry.${language}`), code);
  const options = { projectPath: root, slotId: 'sample' };
  await initLedger({ projectPath: root, projectName: 'Sandbox tests', plumbingSlots: ['sample'] });
  await surgicalHarvest({ ...options, sourceRepoOrPath: source, targetPaths: [`entry.${language}`] });
  await scaffoldAdapter({ ...options, language, inputSchema, outputSchema, timeoutMs });
  return { ...options, component: path.join(root, 'src/bolted/sample') };
}
function environment(t, values) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z';
    return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; }
}
async function stopped(pid) {
  for (let i = 0; i < 30 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(pid), false, `Descendant ${pid} must stop`);
}

test('strict child environment drops secrets, startup injection, and inherited test-runner context', () => {
  const result = cleanEnvironment(['APP_CONFIG', 'NODE_TEST_CONTEXT'], { PATH: '/bin', HOME: '/example', OPENAI_API_KEY: 'dummy', NODE_OPTIONS: '--require unwanted', PYTHONPATH: '/unwanted', NODE_TEST_CONTEXT: 'child-v8', APP_CONFIG: 'public' });
  assert.deepEqual(result, { PATH: '/bin', HOME: '/example', APP_CONFIG: 'public', NODE_ENV: 'test', PYTHONDONTWRITEBYTECODE: '1' });
  assert.throws(() => cleanEnvironment('OPENAI_API_KEY'), /allowedEnvKeys/);
  assert.throws(() => permissionArgs('/example', { sandboxMode: 'unknown' }), /sandboxMode/);
  assert.throws(() => permissionArgs('/example/*', { sandboxMode: 'node-permission' }), /wildcard/);
});

test('contract subprocess cannot see a parent API key; explicit application keys can be allowed', async t => {
  environment(t, { OPENAI_API_KEY: 'sk-secret-leak-test', APP_PUBLIC_SETTING: 'expected' });
  const s = await setup(t, 'export default () => process.env.OPENAI_API_KEY === undefined;');
  fs.appendFileSync(path.join(s.component, 'contract.test.mjs'), "\nassert.equal(process.env.OPENAI_API_KEY, undefined);\nassert.equal(process.env.NODE_OPTIONS, undefined);\nassert.equal(process.env.NODE_ENV, 'test');\nassert.equal(process.env.PYTHONDONTWRITEBYTECODE, '1');\n");
  let result = await verifySlot(s); assert.equal(result.verified, true, JSON.stringify(result));
  fs.appendFileSync(path.join(s.component, 'contract.test.mjs'), "assert.equal(process.env.APP_PUBLIC_SETTING, 'expected');\n");
  result = await verifySlot({ ...s, allowedEnvKeys: ['APP_PUBLIC_SETTING'] }); assert.equal(result.verified, true, JSON.stringify(result));
  const custom = await verifySlot({ ...s, testCommand: 'node -e "if (process.env.OPENAI_API_KEY !== undefined) process.exit(9)"' }); assert.equal(custom.verified, true);
});

test('standalone JS adapters scrub secrets and only forward explicitly allowed keys', async t => {
  environment(t, { OPENAI_API_KEY: 'sk-secret-leak-test', APP_PUBLIC_SETTING: 'expected' });
  const s = await setup(t, "export default () => ({secretMissing: process.env.OPENAI_API_KEY === undefined, allowed: process.env.APP_PUBLIC_SETTING ?? 'missing'});", { outputSchema: { type: 'object', properties: { secretMissing: { type: 'boolean' }, allowed: { type: 'string' } }, required: ['secretMissing', 'allowed'], examples: [{ secretMissing: true, allowed: 'missing' }] } });
  const { executeVendor } = await import(pathToFileURL(path.join(s.component, 'adapter.mjs')));
  assert.deepEqual(await executeVendor(null), { ok: true, value: { secretMissing: true, allowed: 'missing' } });
  assert.deepEqual(await executeVendor(null, { allowedEnvKeys: ['APP_PUBLIC_SETTING'] }), { ok: true, value: { secretMissing: true, allowed: 'expected' } });
});

test('Python adapters and contracts scrub secrets and forward only approved application keys', async t => {
  environment(t, { OPENAI_API_KEY: 'sk-secret-leak-test', APP_PUBLIC_SETTING: 'expected' });
  const s = await setup(t, "import os\ndef execute(payload):\n    return 'OPENAI_API_KEY' not in os.environ\n", { language: 'py' });
  const result = await verifySlot(s); assert.equal(result.verified, true, JSON.stringify(result));
  const standalone = await run('python3', ['-B', '-c', "import os; os.environ['OPENAI_API_KEY']='sk-secret-leak-test'; from adapter import executeVendor; assert executeVendor(None) == {'ok': True, 'value': True}"], { cwd: s.component }); assert.equal(standalone.exitCode, 0, standalone.stderr);
  await assert.rejects(verifySlot({ ...s, sandboxMode: 'node-permission' }), /Python/);
});

test('Node permission mode blocks contract and vendor filesystem access outside project/temp', async t => {
  const outside = fs.mkdtempSync(path.join(os.homedir(), '.bolt-permission-test-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const secret = path.join(outside, 'secret.txt'), output = path.join(outside, 'output.txt'); fs.writeFileSync(secret, 'private fixture');
  const code = `import fs from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nexport default () => {\n for (const action of [() => fs.readFileSync(${JSON.stringify(secret)}), () => fs.writeFileSync(${JSON.stringify(output)}, 'bad'), () => spawnSync(process.execPath, ['-e', '0'])]) {\n  try { action(); return false; } catch (error) { if (error.code !== 'ERR_ACCESS_DENIED') throw error; }\n }\n return true;\n};`;
  const s = await setup(t, code);
  fs.appendFileSync(path.join(s.component, 'contract.test.mjs'), `\nimport fs from 'node:fs';\nassert.throws(() => fs.readFileSync(${JSON.stringify(secret)}), {code: 'ERR_ACCESS_DENIED'});\nassert.throws(() => fs.writeFileSync(${JSON.stringify(output)}, 'bad'), {code: 'ERR_ACCESS_DENIED'});\nfs.writeFileSync(${JSON.stringify(path.join(s.projectPath, 'allowed.txt'))}, 'allowed');\n`);
  const result = await verifySlot({ ...s, sandboxMode: 'node-permission' }); assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(s.projectPath, 'allowed.txt'), 'utf8'), 'allowed'); assert.equal(fs.existsSync(output), false);
  await assert.rejects(verifySlot({ ...s, sandboxMode: 'node-permission', testCommand: 'true' }), /custom shell/);
});

for (const timeout of [false, true]) test(`contract process groups remove grandchildren on ${timeout ? 'timeout' : 'normal exit'}`, async t => {
  const result = await run(process.execPath, ['-e', `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);c.unref();${timeout ? 'setInterval(()=>{},1000)' : ''}`], { timeoutMs: 300 });
  const pid = Number(result.stdout.trim()); assert.ok(pid > 0, JSON.stringify(result));
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  assert.equal(result.timedOut, timeout); await stopped(pid);
});

test('outer verification timeout also kills an adapter worker and its grandchild', async t => {
  const s = await setup(t, "import fs from 'node:fs'; import {spawn} from 'node:child_process'; export default () => { const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync('descendant.pid',String(c.pid)); return new Promise(()=>{}); };", { timeoutMs: 10000 });
  const result = await verifySlot({ ...s, timeoutMs: 500 }); assert.equal(result.result.timedOut, true, JSON.stringify(result));
  const pid = Number(fs.readFileSync(path.join(s.projectPath, 'descendant.pid'), 'utf8'));
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); }); await stopped(pid);
});

test('normal completion closes inherited output pipes by terminating surviving descendants', async t => {
  const result = await run(process.execPath, ['-e', "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(c.pid);c.unref();"], { timeoutMs: 1500 });
  const pid = Number(result.stdout.trim()); assert.ok(pid > 0, JSON.stringify(result));
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  assert.equal(result.timedOut, false); assert.equal(result.exitCode, 0); await stopped(pid);
});

for (const language of ['mjs', 'py']) test(`${language} standalone worker group stops when its caller is killed`, async t => {
  const code = language === 'py'
    ? "import subprocess\nimport sys\nimport time\nfrom pathlib import Path\ndef execute(payload):\n    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n    Path('descendant.pid').write_text(str(child.pid))\n    time.sleep(60)\n    return True\n"
    : "import fs from 'node:fs'; import {spawn} from 'node:child_process'; export default () => { const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync('descendant.pid',String(c.pid)); return new Promise(()=>{}); };";
  const s = await setup(t, code, { language, timeoutMs: 10000 });
  const result = language === 'py'
    ? await run('python3', ['-B', '-c', 'from adapter import executeVendor; executeVendor(None)'], { cwd: s.component, timeoutMs: 700 })
    : await run(process.execPath, ['--input-type=module', '-e', "import {executeVendor} from './adapter.mjs'; await executeVendor(null);"], { cwd: s.component, timeoutMs: 700 });
  assert.equal(result.timedOut, true, JSON.stringify(result));
  const pid = Number(fs.readFileSync(path.join(s.component, 'descendant.pid'), 'utf8'));
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); }); await stopped(pid);
});

test('approved variables reach Node and Python vendor workers during verification', async t => {
  environment(t, { APP_PUBLIC_SETTING: 'expected', OPENAI_API_KEY: 'sk-secret-leak-test' });
  for (const language of ['mjs', 'py']) {
    const code = language === 'py' ? "import os\ndef execute(payload):\n    return os.environ.get('APP_PUBLIC_SETTING') == 'expected' and 'OPENAI_API_KEY' not in os.environ\n" : "export default () => process.env.APP_PUBLIC_SETTING === 'expected' && process.env.OPENAI_API_KEY === undefined;";
    const s = await setup(t, code, { language });
    const result = await verifySlot({ ...s, allowedEnvKeys: ['APP_PUBLIC_SETTING'] }); assert.equal(result.verified, true, JSON.stringify(result));
  }
});
