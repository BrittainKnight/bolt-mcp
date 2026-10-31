import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as engine from './index.mjs';
import { snapshot } from './ledger.mjs';
import { catalog } from './registry.mjs';

const projectPath = z.string().min(1).optional().describe('Project directory; defaults to the server project');
const slotId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const schema = z.record(z.string(), z.unknown());
const timeoutMs = z.number().int().min(1).max(600000).optional();
export const toolDefinitions = [
  { name: 'bolt_init_ledger', operation: 'initLedger', description: 'Audit: initialize the three-bucket rules and declared plumbing slots. Existing ledgers are preserved.', shape: { projectPath, projectName: z.string().min(1), customBrains: z.array(z.string().min(1)).default([]), plumbingSlots: z.array(z.union([slotId, z.object({ slotId, capability: z.string().min(1) }).strict()])).default([]), bannedPatterns: z.array(z.string().min(1)).default([]) } },
  { name: 'bolt_surgical_harvest', operation: 'surgicalHarvest', description: 'Harvest explicit paths from a local directory or sparse Git clone, preserving licenses and SHA-256 provenance.', shape: { projectPath, slotId, sourceRepoOrPath: z.string().min(1), targetPaths: z.array(z.string().min(1)).min(1), stripPatterns: z.array(z.string().min(1)).default([]) } },
  { name: 'bolt_scaffold_adapter', operation: 'scaffoldAdapter', description: 'Generate an isolated JS/TS/Python adapter and real contract tests. Both schemas need paired examples; select a callable vendor export.', shape: { projectPath, slotId, language: z.enum(['ts', 'mjs', 'js', 'py']).default('mjs'), inputSchema: schema, outputSchema: schema, timeoutMs, entryPoint: z.string().optional(), exportName: z.string().optional() } },
  { name: 'bolt_audit_seams', operation: 'auditSeams', description: 'Check vendor imports, cross-slot coupling, unfinished boundaries, provenance, and banned literal patterns. Record actionable seam tickets and vendor security_notices.', shape: { projectPath, slotId } },
  { name: 'bolt_verify_slot', operation: 'verifySlot', description: 'Audit then run the live contract with timeout and bounded logs. Secrets are scrubbed; node-permission restricts generated Node contracts to project/temp filesystem roots. Custom shell commands require clean-env.', shape: { projectPath, slotId, testCommand: z.string().min(1).optional(), timeoutMs, allowedEnvKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]), sandboxMode: z.enum(['node-permission', 'clean-env']).default('clean-env') } },
  { name: 'bolt_registry_promote', operation: 'promoteToRegistry', description: 'Copy an unchanged VERIFIED component to the local immutable registry under a new slug.', shape: { projectPath, slotId, slug: slotId, tags: z.array(z.string()).default([]), description: z.string().default('') } },
  { name: 'bolt_registry_search_mount', operation: 'searchAndMountRegistry', description: 'Search the local catalog; optionally mount one result into a declared PENDING slot and rerun its contract.', shape: { projectPath, query: z.string().default(''), mountSlotId: slotId.optional() } },
];
export function createServer({ projectPath: defaultProject = process.cwd() } = {}) {
  const server = new McpServer({ name: 'bolt-mcp', version: '0.2.0' });
  let currentProject = defaultProject;
  for (const tool of toolDefinitions) server.registerTool(tool.name, {
    description: tool.description, inputSchema: z.object(tool.shape).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async args => {
    try {
      const options = { ...args, projectPath: args.projectPath ?? defaultProject };
      const result = await engine[tool.operation](options);
      currentProject = options.projectPath;
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result.ok === false };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  server.registerResource('current-ledger', 'bolt://ledger/current', { description: 'The most recently used project ledger', mimeType: 'application/json' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(snapshot(currentProject), null, 2) }] }));
  server.registerResource('registry-catalog', 'bolt://registry/catalog', { description: 'Local component registry catalog', mimeType: 'application/json' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(catalog(), null, 2) }] }));
  server.registerPrompt('bolt-and-build', { description: 'The six-stage surgical bolt-in workflow', argsSchema: { capability: z.string().optional() } }, async ({ capability }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Apply the six-stage Bolt & Build workflow${capability ? ` for ${capability}` : ''}:\n1. Audit: preserve Custom Brains, declare OSS Plumbing slots, and ban Regression Traps with bolt_init_ledger.\n2. Surgical Harvest: select explicit upstream paths, inspect license and provenance, and resolve missing sibling warnings.\n3. Hexagonal Adapter Scaffold: select the real callable entry and paired input/output examples. Keep vendor data behind the canonical adapter contract.\n4. Seam Audit: use bolt_audit_seams; resolve every ticket. Host imports only adapters; slots never import each other.\n5. Live-Fire Contract Verification: use bolt_verify_slot. A failing or timed-out test cannot be promoted.\n6. Local Registry Promotion: promote only the unchanged VERIFIED component. Search and mount reruns contracts in the destination.\nKeep scope surgical. No stub implementation or untested success claims.` } }] }));
  return server;
}
export async function serveMcp(options) {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
