import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slotRoot, within, projectRoot, withProject, atomicWrite } from './paths.mjs';
import { openLedger, getSlot, updateSlot } from './ledger.mjs';
import { checkSchema, validate } from './templates/runtime.mjs';

export async function scaffoldAdapter({ projectPath = process.cwd(), slotId, language = 'mjs', inputSchema, outputSchema, timeoutMs = 5000, entryPoint, exportName }) {
  const root = projectRoot(projectPath), directory = slotRoot(root, slotId);
  if (!['ts', 'mjs', 'js', 'py'].includes(language)) throw new Error('Unsupported adapter language');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid timeoutMs');
  for (const schema of [inputSchema, outputSchema]) {
    checkSchema(schema);
    if (!schema.examples?.length) throw new Error('Both schemas require examples for live contract tests');
    for (const example of schema.examples) validate(example, schema);
  }
  if (inputSchema.examples.length !== outputSchema.examples.length) throw new Error('Input/output examples must be paired');
  return withProject(root, () => {
    const db = openLedger(root);
    try { if (getSlot(db, slotId).status !== 'HARVESTED') throw new Error('Scaffold requires a HARVESTED slot'); } finally { db.close(); }
    const provenance = JSON.parse(fs.readFileSync(within(directory, 'provenance.json'), 'utf8'));
    const candidates = provenance.target_paths.filter(p => language === 'py' ? p.endsWith('.py') : /\.[cm]?[jt]s$/.test(p));
    entryPoint ??= candidates.length === 1 ? candidates[0] : undefined;
    if (!entryPoint) throw new Error('entryPoint is required when targets do not identify exactly one source module');
    if (!provenance.files.some(f => f.path === entryPoint)) throw new Error('entryPoint must be a harvested file');
    within(directory, 'vendor/' + entryPoint);
    exportName ??= language === 'py' ? 'execute' : 'default';
    if (!/^[a-zA-Z_$][\w$]*$/.test(exportName)) throw new Error('Invalid exportName');
    const ext = language === 'js' ? 'mjs' : language;
    const adapterName = `adapter.${ext}`, testName = language === 'py' ? 'contract.test.py' : 'contract.test.mjs';
    const runtimeName = language === 'py' ? 'adapter.runtime.py' : 'adapter.runtime.mjs';
    for (const name of [adapterName, testName, runtimeName, ...(language === 'py' ? [] : ['adapter.isolation.mjs'])]) if (fs.existsSync(within(directory, name))) throw new Error('Scaffold files already exist');
    const json = value => `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
    let adapter, contract;
    if (language === 'py') {
      adapter = `import importlib.util\nimport json\nfrom pathlib import Path\nimport subprocess\n\nROOT = Path(__file__).resolve().parent\n_spec = importlib.util.spec_from_file_location('bolt_runtime', ROOT / '${runtimeName}')\n_runtime = importlib.util.module_from_spec(_spec)\n_spec.loader.exec_module(_runtime)\nINPUT_SCHEMA = json.loads(${JSON.stringify(JSON.stringify(inputSchema))})\nOUTPUT_SCHEMA = json.loads(${JSON.stringify(JSON.stringify(outputSchema))})\n\ndef validateInput(payload):\n    return _runtime.validate(payload, INPUT_SCHEMA)\n\ndef normalizeOutput(value):\n    return _runtime.validate(value, OUTPUT_SCHEMA, normalize=True)\n\ndef executeVendor(payload, options=None):\n    try:\n        clean = validateInput(payload)\n    except Exception as error:\n        return {'ok': False, 'error': {'code': 'INPUT_INVALID', 'message': str(error)}}\n    try:\n        value = _runtime.invoke(ROOT / 'vendor' / ${JSON.stringify(entryPoint)}, ${JSON.stringify(exportName)}, clean, ${timeoutMs}, ROOT / 'vendor', options)\n    except subprocess.TimeoutExpired:\n        return {'ok': False, 'error': {'code': 'TIMEOUT', 'message': 'Vendor execution timed out'}}\n    except Exception as error:\n        return {'ok': False, 'error': {'code': 'VENDOR_ERROR', 'message': str(error)}}\n    try:\n        return {'ok': True, 'value': normalizeOutput(value)}\n    except Exception as error:\n        return {'ok': False, 'error': {'code': 'OUTPUT_INVALID', 'message': str(error)}}\n`;
      contract = `import json\nimport unittest\nfrom adapter import executeVendor, INPUT_SCHEMA, OUTPUT_SCHEMA\n\nclass Contract(unittest.TestCase):\n    def test_live_vendor(self):\n        for payload, expected in zip(INPUT_SCHEMA['examples'], OUTPUT_SCHEMA['examples']):\n            result = executeVendor(payload)\n            self.assertTrue(result['ok'], result)\n            self.assertEqual(result['value'], expected)\n\n    def test_invalid_input(self):\n        invalid = {} if INPUT_SCHEMA['type'] == 'null' else None\n        result = executeVendor(invalid)\n        self.assertFalse(result['ok'])\n        self.assertEqual(result['error']['code'], 'INPUT_INVALID')\n\nif __name__ == '__main__':\n    unittest.main(argv=[__file__])\n`;
    } else {
      adapter = `import { fileURLToPath } from 'node:url';\nimport { validate, invoke } from './${runtimeName}';\nexport const inputSchema = ${json(inputSchema)};\nexport const outputSchema = ${json(outputSchema)};\nexport const validateInput = payload => validate(payload, inputSchema);\nexport const normalizeOutput = value => validate(value, outputSchema, '$', true);\nexport async function executeVendor(payload, options = {}) {\n  let clean;\n  try { clean = validateInput(payload); }\n  catch (error) { return { ok: false, error: { code: 'INPUT_INVALID', message: error.message } }; }\n  let value;\n  try { value = await invoke(fileURLToPath(new URL(${JSON.stringify('./vendor/' + entryPoint.split('/').map(encodeURIComponent).join('/'))}, import.meta.url)), ${JSON.stringify(exportName)}, clean, ${timeoutMs}, options); }\n  catch (error) { return { ok: false, error: { code: error.code === 'TIMEOUT' ? 'TIMEOUT' : 'VENDOR_ERROR', message: error.message } }; }\n  try { return { ok: true, value: normalizeOutput(value) }; }\n  catch (error) { return { ok: false, error: { code: 'OUTPUT_INVALID', message: error.message } }; }\n}\n`;
      contract = `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { executeVendor, inputSchema, outputSchema } from './${adapterName}';\ntest('live vendor obeys the canonical contract', async () => {\n  for (const [i, payload] of inputSchema.examples.entries()) {\n    const result = await executeVendor(payload);\n    assert.equal(result.ok, true, JSON.stringify(result));\n    assert.deepEqual(result.value, outputSchema.examples[i]);\n  }\n});\ntest('invalid input is rejected at the boundary', async () => {\n  const result = await executeVendor(inputSchema.type === 'null' ? {} : null);\n  assert.equal(result.ok, false);\n  assert.equal(result.error.code, 'INPUT_INVALID');\n});\n`;
    }
    const runtime = fs.readFileSync(fileURLToPath(new URL(`./templates/runtime.${language === 'py' ? 'py' : 'mjs'}`, import.meta.url)), 'utf8');
    atomicWrite(within(directory, runtimeName), runtime.replace("'./isolation.mjs'", "'./adapter.isolation.mjs'"));
    if (language !== 'py') atomicWrite(within(directory, 'adapter.isolation.mjs'), fs.readFileSync(new URL('./templates/isolation.mjs', import.meta.url)));
    atomicWrite(within(directory, adapterName), adapter);
    atomicWrite(within(directory, testName), contract);
    const testCmd = language === 'py' ? `python3 -B src/bolted/${slotId}/${testName}` : `node --test src/bolted/${slotId}/${testName}`;
    updateSlot(root, slotId, { status: 'WIRED', adapter_path: `src/bolted/${slotId}/${adapterName}`, test_cmd: testCmd, verified_hash: null, last_verified_at: null });
    return { slotId, status: 'WIRED', adapterPath: `src/bolted/${slotId}/${adapterName}`, testCommand: testCmd };
  });
}
