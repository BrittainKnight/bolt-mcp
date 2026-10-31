import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLedger, surgicalHarvest, scaffoldAdapter, auditSeams } from '../src/index.mjs';
import { snapshot, openLedger } from '../src/ledger.mjs';
import { imports } from '../src/imports.mjs';

async function setup(t, code = 'export default () => true;') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-polyglot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'host'), source = path.join(dir, 'source'); fs.mkdirSync(root); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'entry.mjs'), code);
  const options = { projectPath: root, slotId: 'sample' };
  await initLedger({ projectPath: root, projectName: 'Polyglot', plumbingSlots: ['sample', 'other'] });
  await surgicalHarvest({ ...options, sourceRepoOrPath: source, targetPaths: ['entry.mjs'] });
  await scaffoldAdapter({ ...options, inputSchema: { type: 'null', examples: [null] }, outputSchema: { type: 'boolean', examples: [true] } });
  return options;
}
const jsVariants = [
  "import x from './src/bolted/sample/vendor/entry.mjs';",
  "import './src/bolted/sample/vendor/entry.mjs';",
  "await import('./src/bolted/sample/vendor/entry.mjs');",
  "export * from './src/bolted/sample/vendor/entry.mjs';",
  "export { default as x } from './src/bolted/sample/vendor/entry.mjs';",
  "const x = require('./src/bolted/sample/vendor/entry.mjs');",
  "import x from '@/bolted/sample/vendor/entry.mjs';",
  "import x from '~/bolted/sample/vendor/entry.mjs';",
  "const x = import /* multiline loader */ (\n './src/bolted/sample/vendor/entry.mjs'\n);",
  "import x = require('./src/bolted/sample/vendor/entry.mjs');",
  "type X = import('./src/bolted/sample/vendor/entry.mjs');",
  'const x = import(`./src/bolted/sample/vendor/entry.mjs`);',
];
const pyVariants = [
  'import bolted.sample.vendor.entry',
  'from bolted.sample.vendor import entry',
  "x = __import__('bolted.sample.vendor.entry')",
  "import importlib\nx = importlib.import_module('bolted.sample.vendor.entry')",
  "import importlib as loader\nx = loader.import_module('bolted.sample.vendor.entry')",
  "from importlib import import_module as load\nx = load('bolted.sample.vendor.entry')",
  "from bolted.sample import vendor",
  "from bolted import sample",
  "import importlib\nx = importlib.import_module('.vendor.entry', 'bolted.sample')",
];

test('all JS/TS import, require, barrel, dynamic, and alias forms are detected', async t => {
  const options = await setup(t);
  for (const [i, code] of jsVariants.entries()) fs.writeFileSync(path.join(options.projectPath, `host-${i}.ts`), '// line one\n' + code);
  const result = await auditSeams(options);
  for (const [i] of jsVariants.entries()) assert.ok(result.findings.some(f => f.check === 'hexagonal' && f.file === `host-${i}.ts` && f.line >= 2), `Missing JavaScript form ${i}`);
});

test('Python static, aliased dynamic, relative imports, and package members are detected', async t => {
  const options = await setup(t), root = options.projectPath;
  for (const [i, code] of pyVariants.entries()) fs.writeFileSync(path.join(root, `host-${i}.py`), '# line one\n' + code);
  fs.mkdirSync(path.join(root, 'src/bolted/other'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/bolted/other/relative.py'), 'from ..sample.vendor import entry\nfrom ..sample import adapter\n');
  fs.writeFileSync(path.join(root, 'src/bolted/sample/relative.py'), 'from .vendor import entry\nfrom ..other import adapter\n');
  const result = await auditSeams(options);
  for (let i = 0; i < pyVariants.length; i++) if (i !== 7) assert.ok(result.findings.some(f => f.check === 'hexagonal' && f.file === `host-${i}.py` && f.line >= 2), `Missing Python form ${i}`);
  assert.ok(result.findings.some(f => f.check === 'cross-slot' && f.file.endsWith('other/relative.py')));
  assert.ok(result.findings.some(f => f.check === 'cross-slot' && f.file.endsWith('sample/relative.py')));
});

test('JSONC and inherited path mappings resolve to the declared vendor directory', async t => {
  const options = await setup(t), root = options.projectPath;
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config/base.json'), '{"compilerOptions":{"baseUrl":"..","paths":{"@slice/*":["src/bolted/sample/vendor/*"]}}}');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{\n// Shared configuration\n"extends":"./config/base.json",\n}');
  fs.writeFileSync(path.join(root, 'host.ts'), "import entry from '@slice/entry.mjs';");
  const result = await auditSeams(options);
  assert.ok(result.findings.some(f => f.check === 'hexagonal' && f.file === 'host.ts'));
  assert.equal(result.findings.some(f => f.check === 'boundary'), false, JSON.stringify(result));
  fs.writeFileSync(path.join(root, 'config/base.json'), '{"extends":"../tsconfig.json"}');
  assert.ok((await auditSeams(options)).findings.some(f => f.check === 'boundary' && /Cyclic/.test(f.message)));
});

test('syntax parsing ignores import-looking comments and strings, and blocks unresolved loaders', async t => {
  const options = await setup(t), root = options.projectPath;
  fs.writeFileSync(path.join(root, 'comments.ts'), '// import "./src/bolted/sample/vendor/entry.mjs"\nconst text = "require(\'./src/bolted/sample/vendor/entry.mjs\')";');
  fs.writeFileSync(path.join(root, 'comments.py'), '# import bolted.sample.vendor.entry\ntext = "importlib.import_module(\'bolted.sample.vendor.entry\')"');
  assert.equal((await auditSeams(options)).ok, true);
  fs.writeFileSync(path.join(root, 'computed.ts'), 'const name = "./module.mjs"; import(name);');
  fs.writeFileSync(path.join(root, 'computed.py'), 'import importlib\nimportlib.import_module(name)');
  fs.writeFileSync(path.join(root, 'broken.py'), 'from ( bad syntax');
  const result = await auditSeams(options);
  for (const file of ['computed.ts', 'computed.py', 'broken.py']) assert.ok(result.findings.some(f => f.file === file && f.check === 'boundary'), file);
});

test('a renamed runtime bridge cannot bypass dynamic-import auditing', async t => {
  const options = await setup(t), file = path.join(options.projectPath, 'src/bolted/sample/adapter.runtime.mjs');
  fs.appendFileSync(file, '\nconst arbitrary = "some-module"; import(arbitrary);\n');
  const result = await auditSeams(options);
  assert.ok(result.findings.some(f => f.check === 'boundary' && f.file.endsWith('adapter.runtime.mjs')));
});

test('vendor security notices are structured, nonblocking, persisted, and rendered in Markdown', async t => {
  const code = "import {spawn} from 'node:child_process';\nexport default () => true;\nfunction dangerous() {\n eval('1'); new Function('return 1');\n return process.env;\n}\n// subprocess.Popen([])\n// os.environ\n";
  const options = await setup(t, code);
  const result = await auditSeams(options); assert.equal(result.ok, true, JSON.stringify(result));
  const notices = result.security_notices; assert.equal(notices.length, 6);
  for (const rule of ['eval', 'new-function', 'child-process', 'python-subprocess', 'python-environment', 'node-environment']) assert.ok(notices.some(n => n.rule === rule && n.severity === 'warning' && n.file.endsWith('vendor/entry.mjs') && n.line > 0));
  const md = fs.readFileSync(path.join(options.projectPath, '.bolt/BOLT_LEDGER.md'), 'utf8'); assert.match(md, /Security notices/); assert.match(md, /vendor\/entry.mjs:4/);
  const stored = snapshot(options.projectPath).security_notices; assert.equal(stored.length, 6);
  await auditSeams(options); assert.deepEqual(snapshot(options.projectPath).security_notices, stored);
});

test('opening a v0.1 ledger adds the notice table without losing existing data', async t => {
  const options = await setup(t);
  const db = openLedger(options.projectPath); db.exec('DROP TABLE security_notices'); db.close();
  assert.equal(snapshot(options.projectPath).slots.length, 2);
  assert.equal((await auditSeams(options)).ok, true);
});

test('parser reports real source line numbers for embedded scripts and escaped module strings', () => {
  const result = imports('<template>text</template>\n<script>\nimport x from "./vendor/\\u0065ntry.mjs";\n</script>', 'widget.vue');
  assert.equal(result[0].specifier, './vendor/entry.mjs'); assert.equal(result[0].line, 3);
});
