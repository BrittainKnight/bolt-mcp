import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as bolt from '../src/index.mjs';
import { snapshot } from '../src/ledger.mjs';
import { run } from '../src/process.mjs';
import { checkSchema, validate } from '../src/templates/runtime.mjs';
const fixture = fileURLToPath(new URL('./fixtures/upstream', import.meta.url));
const inputSchema = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], examples: [{ value: 2 }] };
const outputSchema = { type: 'object', properties: { result: { type: 'number' } }, required: ['result'], examples: [{ result: 4 }] };
async function setup(t, sourceText, language = 'mjs', timeoutMs = 500) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-boundary-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'), root = path.join(dir, 'host'); fs.cpSync(fixture, source, { recursive: true }); fs.mkdirSync(root);
  if (sourceText) fs.writeFileSync(path.join(source, `slice.${language}`), sourceText);
  const options = { projectPath: root, slotId: 'math' };
  await bolt.initLedger({ projectPath: root, projectName: 'Example', plumbingSlots: ['math', 'other'], bannedPatterns: ['forbiddenCall('] });
  await bolt.surgicalHarvest({ ...options, sourceRepoOrPath: source, targetPaths: [`slice.${language}`, `helper.${language}`] });
  await bolt.scaffoldAdapter({ ...options, language, entryPoint: `slice.${language}`, inputSchema, outputSchema, timeoutMs });
  return { ...options, root, source, dir, component: path.join(root, 'src/bolted/math') };
}

test('all four checks and regression rules produce exact actionable tickets', async t => {
  const s = await setup(t);
  fs.mkdirSync(path.join(s.root, 'src/bolted/other'), { recursive: true });
  fs.writeFileSync(path.join(s.root, 'src/bolted/other/link.mjs'), "import '../math/adapter.mjs';\n");
  fs.appendFileSync(path.join(s.component, 'adapter.mjs'), '\n// TODO: unfinished\ntry {} catch {}\n// forbiddenCall(\n');
  fs.appendFileSync(path.join(s.component, 'vendor/helper.mjs'), '\n// tampered\n');
  fs.writeFileSync(path.join(s.root, 'host.ts'), "import x from '@/bolted/math/vendor/slice.mjs';\n");
  const result = await bolt.auditSeams(s); assert.equal(result.ok, false);
  for (const kind of ['hexagonal', 'cross-slot', 'unfinished', 'provenance', 'regression']) assert.ok(result.findings.some(f => f.check === kind && f.line > 0 && f.file), kind);
  assert.equal(snapshot(s.root).slots.find(x => x.slot_id === 'math').status, 'WIRED');
});

test('TypeScript path aliases and Python absolute imports cannot bypass vendor boundaries', async t => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@vendor/*': ['src/bolted/math/vendor/*'] } } }));
  fs.writeFileSync(path.join(s.root, 'host.ts'), "export { default } from '@vendor/slice.mjs';");
  fs.writeFileSync(path.join(s.root, 'host.py'), 'from src.bolted.math.vendor.slice import execute\n');
  const result = await bolt.auditSeams(s);
  assert.ok(result.findings.some(f => f.file === 'host.ts' && f.check === 'hexagonal'));
  assert.ok(result.findings.some(f => f.file === 'host.py' && f.check === 'hexagonal'));
});

test('missing, extra, and malformed provenance files fail closed', async t => {
  const s = await setup(t), provenance = path.join(s.component, 'provenance.json');
  fs.writeFileSync(path.join(s.component, 'vendor/extra.mjs'), 'export default 1;');
  assert.ok((await bolt.auditSeams(s)).findings.some(f => f.message.includes('Unrecorded')));
  fs.rmSync(provenance); assert.ok((await bolt.auditSeams(s)).findings.some(f => f.check === 'provenance'));
  fs.writeFileSync(provenance, '{'); assert.equal((await bolt.auditSeams(s)).ok, false);
});

test('missing sibling helpers are warned at harvest and block verification', async t => {
  const s = await setup(t); const root = path.join(s.dir, 'missing'); fs.mkdirSync(root); await bolt.initLedger({ projectPath: root, projectName: 'Missing', plumbingSlots: ['math'] });
  const options = { projectPath: root, slotId: 'math' };
  const harvest = await bolt.surgicalHarvest({ ...options, sourceRepoOrPath: fixture, targetPaths: ['slice.mjs'] }); assert.match(harvest.warnings.join(), /helper.mjs/);
  await bolt.scaffoldAdapter({ ...options, inputSchema, outputSchema }); const result = await bolt.verifySlot(options);
  assert.equal(result.verified, false); assert.ok(result.findings.some(f => f.message.includes('Missing sibling')));
});

test('path traversal, source symlinks, reinitialization, and overwrite attempts preserve data', async t => {
  const s = await setup(t);
  await assert.rejects(bolt.initLedger({ projectPath: s.root, projectName: 'Overwrite', plumbingSlots: [] }), /already initialized/);
  await assert.rejects(bolt.surgicalHarvest({ projectPath: s.root, slotId: '../escape', sourceRepoOrPath: fixture, targetPaths: ['slice.mjs'] }), /Invalid/);
  await assert.rejects(bolt.surgicalHarvest({ projectPath: s.root, slotId: 'other', sourceRepoOrPath: fixture, targetPaths: ['../slice.mjs'] }), /safe relative/);
  fs.symlinkSync(path.join(s.source, 'slice.mjs'), path.join(s.source, 'link.mjs'));
  await assert.rejects(bolt.surgicalHarvest({ projectPath: s.root, slotId: 'other', sourceRepoOrPath: s.source, targetPaths: ['link.mjs'] }), /Symlinks/);
  await assert.rejects(bolt.scaffoldAdapter({ ...s, inputSchema, outputSchema }), /HARVESTED/);
  assert.equal(snapshot(s.root).audit.project_name, 'Example');
});

for (const [name, code, expected] of [
  ['vendor exception', "export default () => { throw new Error('vendor failed'); };", 'VENDOR_ERROR'],
  ['incorrect output', 'export default () => ({result: "bad"});', 'OUTPUT_INVALID'],
  ['synchronous infinite loop', 'export default () => { while(true) {} };', 'TIMEOUT'],
]) test(`adapter handles ${name}`, async t => {
  const s = await setup(t, code, 'mjs', 150);
  const adapter = await import(pathToFileURL(path.join(s.component, 'adapter.mjs')));
  assert.equal((await adapter.executeVendor({ value: 2 })).error.code, expected);
  assert.equal((await adapter.executeVendor({ value: 2, extra: 3 })).error.code, 'INPUT_INVALID');
  const result = await bolt.verifySlot(s); assert.equal(result.verified, false); assert.notEqual(snapshot(s.root).runs[0].exit_code, 0);
});

test('Python vendor timeout becomes a structured boundary error', async t => {
  const s = await setup(t, 'def execute(payload):\n    while True:\n        pass\n', 'py', 150);
  const result = await run('python3', ['-B', '-c', 'from adapter import executeVendor; import json; print(json.dumps(executeVendor({"value":2})))'], { cwd: s.component });
  assert.equal(result.exitCode, 0, result.stderr); assert.equal(JSON.parse(result.stdout).error.code, 'TIMEOUT');
});

test('verification records nonzero exits, command errors, timeouts, and bounded output', async t => {
  const s = await setup(t);
  let result = await bolt.verifySlot({ ...s, testCommand: 'exit 7' }); assert.equal(result.verified, false); assert.equal(result.result.exitCode, 7);
  result = await bolt.verifySlot({ ...s, testCommand: 'bolt-nonexistent-command' }); assert.equal(result.verified, false); assert.ok(result.result.stderr);
  result = await bolt.verifySlot({ ...s, testCommand: 'node -e "setInterval(()=>{},1000)"', timeoutMs: 80 }); assert.equal(result.result.timedOut, true);
  result = await bolt.verifySlot({ ...s, testCommand: 'node -e "process.stdout.write(String.fromCharCode(65).repeat(2000000))"' }); assert.equal(result.result.truncated, true); assert.equal(result.verified, false);
  assert.equal(snapshot(s.root).runs.length, 4);
});

test('verification rejects mutations made by the test command', async t => {
  const s = await setup(t);
  const result = await bolt.verifySlot({ ...s, testCommand: "node -e \"require('fs').appendFileSync('src/bolted/math/adapter.mjs','\\n')\"" });
  assert.equal(result.result.exitCode, 0); assert.equal(result.verified, false); assert.equal(result.unchanged, false);
});

test('registry rejects tampered entries and ambiguous mounts', async t => {
  const s = await setup(t); process.env.BOLT_REGISTRY_DIR = path.join(s.dir, 'registry');
  await bolt.verifySlot(s); await bolt.promoteToRegistry({ ...s, slug: 'math-v1', tags: ['math'] }); await bolt.promoteToRegistry({ ...s, slug: 'math-v2', tags: ['math'] });
  await assert.rejects(bolt.searchAndMountRegistry({ projectPath: s.root, mountSlotId: 'other', query: 'math' }), /exactly one/);
  fs.appendFileSync(path.join(process.env.BOLT_REGISTRY_DIR, 'math-v1/adapter.mjs'), '\n');
  await assert.rejects(bolt.searchAndMountRegistry({ projectPath: s.root, mountSlotId: 'other', query: 'math-v1' }), /integrity/);
  await assert.rejects(bolt.promoteToRegistry({ ...s, slug: '../escape' }), /Invalid/);
});

test('a project lock prevents overlapping mutations', async t => {
  const s = await setup(t), lock = path.join(s.root, '.bolt/operation.lock'); fs.mkdirSync(lock);
  await assert.rejects(bolt.auditSeams(s), /already running/); fs.rmdirSync(lock);
  assert.equal((await bolt.auditSeams(s)).ok, true);
});

test('schema validation rejects unsupported contracts and enforces nested normalization', () => {
  assert.throws(() => checkSchema({ type: 'string', pattern: '.*' }), /Unsupported/);
  assert.throws(() => checkSchema({ type: 'object', properties: {}, required: ['missing'] }), /required/);
  assert.throws(() => checkSchema({ type: 'number', minimum: 5, maximum: 2 }), /range/);
  assert.throws(() => validate(Infinity, { type: 'number' }), /range/);
  assert.throws(() => validate(true, { type: 'integer' }), /integer/);
  const schema = { type: 'object', properties: { rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } }, required: ['rows'] };
  assert.deepEqual(validate({ rows: [{ id: 1, private: 2 }], extra: true }, schema, '$', true), { rows: [{ id: 1 }] });
});

test('repeated seam audits retain unresolved ticket identity and close repaired findings', async t => {
  const s = await setup(t), host = path.join(s.root, 'host.vue');
  fs.writeFileSync(host, '<script>import x from "./src/bolted/math/vendor/slice.mjs";</script>');
  await bolt.auditSeams(s); const first = snapshot(s.root).tickets;
  assert.ok(first.some(ticket => ticket.file === 'host.vue'));
  await bolt.auditSeams(s); assert.deepEqual(snapshot(s.root).tickets, first);
  fs.rmSync(host); await bolt.auditSeams(s); assert.ok(snapshot(s.root).tickets.every(ticket => ticket.resolved_at));
});

test('inherited Node test context cannot skip real child contracts', async () => {
  const result = await run(process.execPath, ['--input-type=module', '-e', "import test from 'node:test'; test('must fail', () => { throw new Error('executed'); });"], { env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' } });
  assert.notEqual(result.exitCode, 0); assert.match(result.stdout, /executed/); assert.doesNotMatch(result.stderr, /skipping running files/);
});

test('strip globs exclude selected files without removing the license', async t => {
  const s = await setup(t);
  const result = await bolt.surgicalHarvest({ projectPath: s.root, slotId: 'other', sourceRepoOrPath: fixture, targetPaths: ['slice.mjs', 'helper.mjs'], stripPatterns: ['helper.*', 'LICENSE*'] });
  assert.deepEqual(result.provenance.files.map(f => f.path), ['LICENSE', 'slice.mjs']);
  assert.ok(result.warnings.some(w => w.includes('helper.mjs')));
});

test('multiline JavaScript, file URLs, and comma-separated Python imports obey the hexagonal law', async t => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.root, 'multiline.ts'), 'import {\n  twice\n} from "./src/bolted/math/vendor/helper.mjs";\n');
  fs.writeFileSync(path.join(s.root, 'url.mjs'), `import ${JSON.stringify(pathToFileURL(path.join(s.component, 'vendor/slice.mjs')).href)};`);
  fs.writeFileSync(path.join(s.root, 'multi.py'), 'import os, src.bolted.math.vendor.slice as vendor\n');
  const result = await bolt.auditSeams(s);
  for (const file of ['multiline.ts', 'url.mjs', 'multi.py']) assert.ok(result.findings.some(f => f.file === file && f.check === 'hexagonal'), file);
});

test('scaffold rejects missing real examples and unknown schema keywords before writing files', async t => {
  const s = await setup(t);
  await bolt.surgicalHarvest({ projectPath: s.root, slotId: 'other', sourceRepoOrPath: fixture, targetPaths: ['slice.mjs', 'helper.mjs'] });
  await assert.rejects(bolt.scaffoldAdapter({ projectPath: s.root, slotId: 'other', inputSchema: { ...inputSchema, examples: [] }, outputSchema }), /examples/);
  await assert.rejects(bolt.scaffoldAdapter({ projectPath: s.root, slotId: 'other', inputSchema: { ...inputSchema, anyOf: [] }, outputSchema }), /Unsupported/);
  assert.equal(fs.existsSync(path.join(s.root, 'src/bolted/other/adapter.mjs')), false);
});
