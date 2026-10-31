import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as bolt from '../src/index.mjs';
import { snapshot, openLedger } from '../src/ledger.mjs';
import { git, run } from '../src/process.mjs';

const fixture = fileURLToPath(new URL('./fixtures/upstream', import.meta.url));
const inputSchema = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], examples: [{ value: 3 }, { value: -2 }] };
const outputSchema = { type: 'object', properties: { result: { type: 'number' } }, required: ['result'], examples: [{ result: 6 }, { result: -4 }] };
function workspace(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

for (const language of ['mjs', 'js', 'ts', 'py']) test(`complete local workflow: ${language}`, async t => {
  const dir = workspace(t), root = path.join(dir, 'host'); fs.mkdirSync(root);
  process.env.BOLT_REGISTRY_DIR = path.join(dir, 'registry');
  const options = { projectPath: root, slotId: 'math' };
  const initialized = await bolt.initLedger({ projectPath: root, projectName: 'Example', customBrains: ['Canonical model'], plumbingSlots: [{ slotId: 'math', capability: 'Double numbers' }], bannedPatterns: ['legacyWire('] });
  assert.equal(initialized.slots[0].status, 'PENDING');
  const db = openLedger(root); assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal'); db.close();
  const ext = language === 'py' ? 'py' : 'mjs';
  const harvested = await bolt.surgicalHarvest({ ...options, sourceRepoOrPath: fixture, targetPaths: [`slice.${ext}`, `helper.${ext}`] });
  assert.equal(harvested.status, 'HARVESTED'); assert.equal(harvested.provenance.license, 'MIT'); assert.equal(harvested.provenance.files.length, 3); assert.equal(harvested.warnings.length, 0);
  await bolt.scaffoldAdapter({ ...options, language, entryPoint: `slice.${ext}`, inputSchema, outputSchema });
  assert.equal(snapshot(root).slots[0].status, 'WIRED');
  fs.writeFileSync(path.join(root, 'bad.mjs'), "// Host code\nimport './src/bolted/math/vendor/helper.mjs';\n");
  const blocked = await bolt.auditSeams(options); assert.equal(blocked.ok, false); assert.ok(blocked.findings.some(f => f.check === 'hexagonal' && f.file === 'bad.mjs' && f.line === 2));
  assert.equal((await bolt.verifySlot(options)).verified, false);
  await assert.rejects(bolt.promoteToRegistry({ ...options, slug: 'math-v1' }), /VERIFIED/);
  fs.rmSync(path.join(root, 'bad.mjs'));
  const polished = await bolt.auditSeams(options); assert.equal(polished.status, 'POLISHED', JSON.stringify(polished));
  assert.ok(snapshot(root).tickets.every(ticket => ticket.resolved_at));
  const verified = await bolt.verifySlot(options); assert.equal(verified.verified, true, JSON.stringify(verified));
  const state = snapshot(root); assert.equal(state.runs[0].exit_code, 0); assert.ok(state.slots[0].last_verified_at); assert.match(fs.readFileSync(path.join(root, '.bolt/BOLT_LEDGER.md'), 'utf8'), /VERIFIED/);
  await bolt.promoteToRegistry({ ...options, slug: 'math-v1', tags: ['math'], description: 'Doubles a number' });
  await assert.rejects(bolt.promoteToRegistry({ ...options, slug: 'math-v1' }), /already exists/);
  assert.equal((await bolt.searchAndMountRegistry({ query: 'number math' })).matches.length, 1);
  const second = path.join(dir, 'second'); fs.mkdirSync(second); await bolt.initLedger({ projectPath: second, projectName: 'Second', plumbingSlots: ['double'] });
  const mounted = await bolt.searchAndMountRegistry({ query: 'math-v1', mountSlotId: 'double', projectPath: second }); assert.equal(mounted.verified, true, JSON.stringify(mounted));
  assert.equal(snapshot(second).slots[0].status, 'VERIFIED');
  fs.appendFileSync(path.join(root, 'src/bolted/math', language === 'py' ? 'adapter.py' : language === 'ts' ? 'adapter.ts' : 'adapter.mjs'), '\n');
  await assert.rejects(bolt.promoteToRegistry({ ...options, slug: 'math-v2' }), /unchanged VERIFIED/);
});

test('Git sparse clone selects only requested source and license; records HEAD', async t => {
  const dir = workspace(t), source = path.join(dir, 'source'), root = path.join(dir, 'host'); fs.cpSync(fixture, source, { recursive: true }); fs.mkdirSync(root);
  fs.mkdirSync(path.join(source, 'unrelated')); fs.writeFileSync(path.join(source, 'unrelated/noise.txt'), 'not selected');
  await git(['init', '-b', 'main'], source); await git(['add', '.'], source); await git(['-c', 'user.name=Example', '-c', 'user.email=example@example.org', 'commit', '-m', 'Fixture'], source);
  const sha = await git(['rev-parse', 'HEAD'], source);
  await bolt.initLedger({ projectPath: root, projectName: 'Sparse', plumbingSlots: ['math'] });
  const result = await bolt.surgicalHarvest({ projectPath: root, slotId: 'math', sourceRepoOrPath: pathToFileURL(source).href, targetPaths: ['slice.mjs', 'helper.mjs'] });
  assert.equal(result.provenance.commit_sha, sha); assert.deepEqual(result.provenance.files.map(f => f.path), ['LICENSE', 'helper.mjs', 'slice.mjs']);
});

test('all seven MCP tools complete the workflow over actual stdio transport', async t => {
  const dir = workspace(t), root = path.join(dir, 'host'), second = path.join(dir, 'second'); fs.mkdirSync(root); fs.mkdirSync(second);
  const client = new Client({ name: 'integration', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/bolt-mcp.mjs', import.meta.url)), '--project', root], env: { ...process.env, BOLT_REGISTRY_DIR: path.join(dir, 'registry') }, stderr: 'pipe' });
  t.after(() => client.close()); await client.connect(transport);
  const call = async (name, args, failure = false) => { const result = await client.callTool({ name, arguments: args }); assert.equal(Boolean(result.isError), failure, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  assert.equal((await client.listTools()).tools.length, 7); assert.equal((await client.listResources()).resources.length, 2);
  assert.equal((await client.listPrompts()).prompts[0].name, 'bolt-and-build');
  assert.match((await client.getPrompt({ name: 'bolt-and-build' })).messages[0].content.text, /six-stage/);
  await call('bolt_init_ledger', { projectName: 'MCP project', plumbingSlots: ['math'] });
  await call('bolt_surgical_harvest', { slotId: 'math', sourceRepoOrPath: fixture, targetPaths: ['slice.mjs', 'helper.mjs'] });
  await call('bolt_scaffold_adapter', { slotId: 'math', entryPoint: 'slice.mjs', inputSchema, outputSchema });
  fs.writeFileSync(path.join(root, 'violation.mjs'), "import './src/bolted/math/vendor/slice.mjs';");
  await call('bolt_audit_seams', { slotId: 'math' }, true); fs.rmSync(path.join(root, 'violation.mjs'));
  await call('bolt_audit_seams', { slotId: 'math' }); await call('bolt_verify_slot', { slotId: 'math' });
  await call('bolt_registry_promote', { slotId: 'math', slug: 'math-v1', tags: ['math'] });
  await call('bolt_init_ledger', { projectPath: second, projectName: 'Second', plumbingSlots: ['math2'] });
  const mounted = await call('bolt_registry_search_mount', { projectPath: second, query: 'math-v1', mountSlotId: 'math2' }); assert.equal(mounted.verified, true);
  assert.equal(JSON.parse((await client.readResource({ uri: 'bolt://registry/catalog' })).contents[0].text).length, 1);
  assert.equal(JSON.parse((await client.readResource({ uri: 'bolt://ledger/current' })).contents[0].text).audit.project_name, 'Second');
  const error = await client.callTool({ name: 'bolt_audit_seams', arguments: { slotId: '../escape' } }); assert.equal(error.isError, true);
});
