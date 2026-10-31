import { fork } from 'node:child_process';
import path from 'node:path';
import { cleanEnvironment, permissionArgs, executionContext } from './isolation.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const keys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'description', 'title', 'examples']);
export function checkSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Schema must be an object');
  for (const key of Object.keys(schema)) if (!keys.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) throw new Error('Schema requires a supported type');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Error('enum must be nonempty');
  if (schema.examples !== undefined && !Array.isArray(schema.examples)) throw new Error('examples must be an array');
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (schema[k] !== undefined && (typeof schema[k] !== 'number' || !Number.isFinite(schema[k]) || (!['minimum', 'maximum'].includes(k) && (!Number.isInteger(schema[k]) || schema[k] < 0)))) throw new Error(`Invalid ${k}`);
  for (const [min, max] of [['minimum', 'maximum'], ['minLength', 'maxLength'], ['minItems', 'maxItems']]) if (schema[min] !== undefined && schema[max] !== undefined && schema[min] > schema[max]) throw new Error(`Invalid ${min}/${max} range`);
  if (schema.type === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) throw new Error('Objects require properties');
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error('Only additionalProperties:false is supported');
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string' || !Object.hasOwn(schema.properties, k)))) throw new Error('required must name declared properties');
    Object.values(schema.properties).forEach(checkSchema);
  }
  if (schema.type === 'array') checkSchema(schema.items);
  return schema;
}
const equal = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a).sort(), bKeys = Object.keys(b).sort();
  return JSON.stringify(aKeys) === JSON.stringify(bKeys) && aKeys.every(k => equal(a[k], b[k]));
};
export function validate(value, schema, location = '$', normalize = false) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type === 'integer' ? !Number.isInteger(value) : type !== schema.type) throw new Error(`${location}: expected ${schema.type}`);
  if (schema.enum && !schema.enum.some(item => equal(item, value))) throw new Error(`${location}: outside enum`);
  if (type === 'number' && (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw new Error(`${location}: outside numeric range`);
  if (type === 'string' && ((schema.minLength !== undefined && [...value].length < schema.minLength) || (schema.maxLength !== undefined && [...value].length > schema.maxLength))) throw new Error(`${location}: outside string length`);
  if (type === 'array') {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) throw new Error(`${location}: outside array length`);
    return value.map((item, i) => validate(item, schema.items, `${location}[${i}]`, normalize));
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${location}.${key}: required`);
    if (!normalize) for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`${location}.${key}: unexpected property`);
    return Object.fromEntries(Object.entries(schema.properties).filter(([key]) => Object.hasOwn(value, key)).map(([key, sub]) => [key, validate(value[key], sub, `${location}.${key}`, normalize)]));
  }
  return value;
}
export async function invoke(entry, exportName, input, timeoutMs, options = {}) {
  const context = executionContext();
  const allowedEnvKeys = options.allowedEnvKeys ?? context.allowedEnvKeys ?? [];
  const sandboxMode = context.sandboxMode === 'node-permission' ? context.sandboxMode : options.sandboxMode ?? context.sandboxMode ?? 'clean-env';
  const projectPath = context.projectPath ?? path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
  const env = cleanEnvironment(allowedEnvKeys);
  const execArgv = permissionArgs(projectPath, { sandboxMode });
  const detached = !context.managedGroup && process.platform !== 'win32';
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['--bolt-worker', ...(detached ? ['--bolt-own-group'] : [])], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv, detached });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      try { if (child.pid) { if (detached) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } } catch (killError) { if (killError.code !== 'ESRCH') error ??= killError; }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Vendor execution timed out'), { code: 'TIMEOUT' })), timeoutMs);
    child.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('Vendor process exited without a result')));
    child.on('message', message => message.ok ? finish(null, message.value) : finish(new Error(message.error)));
    child.send({ entry, exportName, input });
  });
}
if (process.argv[2] === '--bolt-worker') {
  process.once('disconnect', () => {
    if (process.argv.includes('--bolt-own-group')) process.kill(-process.pid, 'SIGKILL');
    else process.exit(1);
  });
  process.once('message', async ({ entry, exportName, input }) => {
    try {
      const vendor = await import(pathToFileURL(entry));
      const fn = vendor[exportName];
      if (typeof fn !== 'function') throw new Error(`Vendor export ${exportName} is not callable`);
      const value = await fn(input);
      process.send({ ok: true, value: JSON.parse(JSON.stringify(value)) });
    } catch (error) { process.send({ ok: false, error: error.message }); }
  });
}
