import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { cleanEnvironment } from '../src/templates/isolation.mjs';

// Deliberately no MCP client SDK: this test validates newline-delimited JSON-RPC on the wire.
test('live MCP stdio initialize, discovery, resources, prompts, and tools/call lifecycle', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-wire-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/bolt-mcp.mjs', import.meta.url)), 'serve', '--project', root], {
    env: cleanEnvironment(['BOLT_REGISTRY_DIR'], { ...process.env, BOLT_REGISTRY_DIR: path.join(root, 'registry') }),
    stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  let buffer = '', stderr = '', nextId = 0, protocolError;
  const pending = new Map(), frames = [];
  const fail = error => { protocolError = error; for (const request of pending.values()) request.reject(error); pending.clear(); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', fail);
  child.on('exit', code => { if (pending.size) fail(new Error(`Server exited ${code}: ${stderr}`)); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const frame = JSON.parse(line); assert.equal(frame.jsonrpc, '2.0'); frames.push(frame);
        if (frame.id !== undefined) {
          assert.ok(pending.has(frame.id), 'Response must correlate to an outstanding request');
          const request = pending.get(frame.id); pending.delete(frame.id);
          if (frame.error) request.reject(new Error(JSON.stringify(frame.error))); else request.resolve(frame.result);
        }
      } catch (error) { fail(new Error(`Non-protocol stdout or malformed JSON-RPC: ${error.message}`)); }
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (protocolError) return reject(protocolError);
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}; ${stderr}`)); }, 5000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL');
      await closed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-wire-test', version: '1.0.0' } });
  assert.equal(initialized.protocolVersion, '2025-11-25'); assert.deepEqual(initialized.serverInfo, { name: 'bolt-mcp', version: '0.2.0' });
  for (const name of ['tools', 'resources', 'prompts']) assert.ok(initialized.capabilities[name]);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const { tools } = await rpc('tools/list');
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['bolt_init_ledger', 'bolt_surgical_harvest', 'bolt_scaffold_adapter', 'bolt_audit_seams', 'bolt_verify_slot', 'bolt_registry_promote', 'bolt_registry_search_mount'].sort());
  for (const tool of tools) { assert.equal(tool.inputSchema.type, 'object'); assert.ok(tool.inputSchema.properties.projectPath); assert.ok(tool.description); }
  const expectedFields = { bolt_init_ledger: ['projectName', 'customBrains', 'plumbingSlots', 'bannedPatterns'], bolt_surgical_harvest: ['slotId', 'sourceRepoOrPath', 'targetPaths', 'stripPatterns'], bolt_scaffold_adapter: ['slotId', 'language', 'inputSchema', 'outputSchema', 'timeoutMs'], bolt_audit_seams: ['slotId'], bolt_verify_slot: ['slotId', 'testCommand', 'timeoutMs', 'allowedEnvKeys', 'sandboxMode'], bolt_registry_promote: ['slotId', 'slug', 'tags', 'description'], bolt_registry_search_mount: ['query', 'mountSlotId'] };
  for (const tool of tools) for (const field of expectedFields[tool.name]) assert.ok(tool.inputSchema.properties[field], `${tool.name}.${field}`);
  const verificationSchema = tools.find(tool => tool.name === 'bolt_verify_slot').inputSchema;
  assert.equal(verificationSchema.properties.allowedEnvKeys.type, 'array'); assert.deepEqual(verificationSchema.properties.sandboxMode.enum, ['node-permission', 'clean-env']);
  const { resources } = await rpc('resources/list'); assert.deepEqual(resources.map(resource => resource.uri).sort(), ['bolt://ledger/current', 'bolt://registry/catalog']);
  const { prompts } = await rpc('prompts/list'); assert.equal(prompts[0].name, 'bolt-and-build');
  const created = await rpc('tools/call', { name: 'bolt_init_ledger', arguments: { projectName: 'Wire project', plumbingSlots: ['sample'] } });
  assert.equal(Boolean(created.isError), false); assert.equal(JSON.parse(created.content[0].text).slots[0].status, 'PENDING');
  const audited = await rpc('tools/call', { name: 'bolt_audit_seams', arguments: { slotId: 'sample' } });
  assert.equal(audited.isError, true); const audit = JSON.parse(audited.content[0].text); assert.equal(audit.ok, false); assert.ok(audit.findings.length); assert.deepEqual(audit.security_notices, []);
  const ledger = await rpc('resources/read', { uri: 'bolt://ledger/current' }); assert.equal(JSON.parse(ledger.contents[0].text).audit.project_name, 'Wire project');
  assert.equal(frames.length, 7); assert.equal(protocolError, undefined); assert.equal(buffer, '');
  const closed = once(child, 'close'); child.stdin.end(); await closed;
  assert.equal(child.exitCode, 0, stderr); assert.equal(protocolError, undefined); assert.equal(buffer, '');
});
