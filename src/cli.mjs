import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as engine from './index.mjs';
import { serveMcp } from './mcp-server.mjs';
import { serveInspector } from './inspector.mjs';
import { atomicWrite } from './paths.mjs';

const commands = { init: 'initLedger', harvest: 'surgicalHarvest', scaffold: 'scaffoldAdapter', audit: 'auditSeams', verify: 'verifySlot', promote: 'promoteToRegistry', registry: 'searchAndMountRegistry' };
const help = `bolt-mcp 0.2.0 — surgical code harvesting\n\nbolt-mcp [serve] [--project PATH] [--ui]    MCP over stdio\nbolt-mcp <init|harvest|scaffold|audit|verify|promote|registry> --json FILE\nbolt-mcp <command> --json '{"slotId":"example",...}' [--project PATH]\nbolt-mcp serve-ui [--project PATH] [--port 5390]\nbolt-mcp install-client <cursor|windsurf>  Merge local MCP configuration\n\nJSON keys match MCP tool arguments. --json - reads stdin. Errors exit nonzero.\n`;
function installClient(client) {
  const entry = { command: process.execPath, args: [fileURLToPath(new URL('../bin/bolt-mcp.mjs', import.meta.url)), 'serve', '--project', process.cwd()] };
  const file = client === 'cursor' ? path.join(process.cwd(), '.cursor', 'mcp.json') : client === 'windsurf' ? path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json') : null;
  if (!file) throw new Error('Supported config clients: cursor, windsurf');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.mcpServers && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) throw new Error('Invalid existing client configuration');
  config.mcpServers ??= {};
  if (config.mcpServers['bolt-mcp']) throw new Error('bolt-mcp already configured; existing configuration preserved');
  config.mcpServers['bolt-mcp'] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(config, null, 2) + '\n');
  return { configured: client, file };
}
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'string' }, project: { type: 'string' }, ui: { type: 'boolean' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } } });
  if (values.help) { console.log(help); return; }
  if (values.version) { console.log('0.2.0'); return; }
  const command = positionals[0] ?? (values.ui ? 'serve-ui' : 'serve');
  const projectPath = path.resolve(values.project ?? process.cwd());
  if (command === 'install-client') { console.log(JSON.stringify(installClient(positionals[1]), null, 2)); return; }
  if (positionals.length > 1) throw new Error('Unexpected positional arguments');
  if (command === 'serve' || command === 'serve-ui') {
    let inspector;
    if (values.ui || command === 'serve-ui') {
      inspector = await serveInspector({ projectPath, port: Number(values.port ?? 5390) });
      console.error(`Bolt Inspector: http://localhost:${inspector.address().port}`);
    }
    if (command === 'serve') {
      const server = await serveMcp({ projectPath });
      server.server.onclose = () => inspector?.close();
    }
    return;
  }
  const operation = commands[command];
  if (!operation) throw new Error(`Unknown command: ${command}. Use --help.`);
  let options = {};
  if (values.json) {
    const raw = values.json === '-' ? fs.readFileSync(0, 'utf8') : values.json.trimStart().startsWith('{') ? values.json : fs.readFileSync(values.json, 'utf8');
    options = JSON.parse(raw);
    if (!options || Array.isArray(options) || typeof options !== 'object') throw new Error('Expected a JSON object');
  }
  const result = await engine[operation]({ ...options, projectPath: values.project ? projectPath : options.projectPath ?? projectPath });
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exitCode = 1;
}
