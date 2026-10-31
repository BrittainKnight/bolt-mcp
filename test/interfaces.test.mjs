import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { run } from '../src/process.mjs';
import { initLedger } from '../src/ledger.mjs';
import { serveInspector } from '../src/inspector.mjs';
const cli = fileURLToPath(new URL('../bin/bolt-mcp.mjs', import.meta.url));
function workspace(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-interface-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('CLI supports JSON file, inline JSON, help, version, and failing exit status', async t => {
  const root = workspace(t), file = path.join(root, 'init.json');
  fs.writeFileSync(file, JSON.stringify({ projectName: 'CLI project', plumbingSlots: ['math'] }));
  let result = await run(process.execPath, [cli, 'init', '--json', file], { cwd: root }); assert.equal(result.exitCode, 0, result.stderr); assert.equal(JSON.parse(result.stdout).slots[0].status, 'PENDING');
  result = await run(process.execPath, [cli, 'audit', '--json', '{"slotId":"math"}'], { cwd: root }); assert.equal(result.exitCode, 1); assert.equal(JSON.parse(result.stdout).ok, false);
  result = await run(process.execPath, [cli, '--version']); assert.equal(result.stdout.trim(), '0.2.0');
  result = await run(process.execPath, [cli, '--help']); assert.match(result.stdout, /serve-ui/);
  result = await run(process.execPath, [cli, 'unknown']); assert.notEqual(result.exitCode, 0); assert.match(result.stderr, /Unknown command/);
  result = await run(process.execPath, [cli, 'init', '--json', '{bad}']); assert.notEqual(result.exitCode, 0);
});

test('client installers merge configuration and refuse overwriting existing entries', async t => {
  const root = workspace(t), directory = path.join(root, '.cursor'); fs.mkdirSync(directory);
  const file = path.join(directory, 'mcp.json'); fs.writeFileSync(file, JSON.stringify({ mcpServers: { existing: { command: 'example' } }, other: true }));
  let result = await run(process.execPath, [cli, 'install-client', 'cursor'], { cwd: root }); assert.equal(result.exitCode, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(config.other, true); assert.equal(config.mcpServers.existing.command, 'example'); assert.equal(config.mcpServers['bolt-mcp'].command, process.execPath);
  result = await run(process.execPath, [cli, 'install-client', 'cursor'], { cwd: root }); assert.notEqual(result.exitCode, 0); assert.match(result.stderr, /already configured/);
  result = await run(process.execPath, [cli, 'install-client', 'windsurf'], { cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root } }); assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(root, '.codeium/windsurf/mcp_config.json')));
});

test('inspector serves accessible static UI and rejects foreign hosts, origins, writes, and traversal', async t => {
  const root = workspace(t); process.env.BOLT_REGISTRY_DIR = path.join(root, 'registry');
  await initLedger({ projectPath: root, projectName: '<script>alert(1)</script>', plumbingSlots: ['math'] });
  const server = await serveInspector({ projectPath: root, port: 0 }); t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, url = `http://127.0.0.1:${port}`;
  let response = await fetch(url); assert.equal(response.status, 200); assert.match(await response.text(), /aria-live="polite"/); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  response = await fetch(url + '/api/status'); assert.equal((await response.json()).audit.project_name, '<script>alert(1)</script>');
  response = await fetch(url + '/inspector.mjs'); const script = await response.text(); assert.match(script, /textContent/); assert.doesNotMatch(script, /innerHTML/);
  response = await fetch(url + '/api/status', { method: 'POST' }); assert.equal(response.status, 405);
  response = await fetch(url + '/api/status', { headers: { Origin: 'https://example.org' } }); assert.equal(response.status, 403);
  const status = await new Promise((resolve, reject) => { const request = http.get(url + '/api/status', { headers: { Host: 'example.org' } }, res => { res.resume(); resolve(res.statusCode); }); request.on('error', reject); }); assert.equal(status, 403);
  response = await fetch(url + '/%2e%2e/package.json'); assert.equal(response.status, 404);
});
