import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const ignored = new Set(['.git', '.bolt', 'node_modules', '__pycache__', '.venv', 'dist', 'build', 'coverage']);
export function identifier(value, label = 'identifier') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
export function within(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Expected a safe relative path');
  const base = path.resolve(root), target = path.resolve(base, relative);
  if (target === base || !target.startsWith(base + path.sep)) throw new Error('Path escapes root');
  // Reject symlinks in every existing ancestor, including the root.
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) || fs.lstatSync(current, { throwIfNoEntry: false })) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlinks are not supported');
    }
  }
  return target;
}
export function projectRoot(value = process.cwd()) {
  const root = path.resolve(value);
  if (!fs.statSync(root).isDirectory()) throw new Error('Project directory does not exist');
  within(root, '.bolt');
  return root;
}
export function slotRoot(projectPath, slotId) { return within(projectRoot(projectPath), `src/bolted/${identifier(slotId, 'slotId')}`); }
export function walk(root, exclusions = ignored) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const item of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (exclusions.has(item.name)) continue;
    if (item.isSymbolicLink()) throw new Error(`Symlink refused: ${item.name}`);
    const file = path.join(root, item.name);
    if (item.isDirectory()) files.push(...walk(file, exclusions));
    else if (item.isFile()) files.push(file);
    else throw new Error(`Special file refused: ${item.name}`);
  }
  return files;
}
export const slash = value => value.split(path.sep).join('/');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function atomicWrite(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, data, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export const writeJson = (file, data) => atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
export function fingerprint(root) {
  return sha256(JSON.stringify(walk(root).map(file => [slash(path.relative(root, file)), sha256(fs.readFileSync(file))])));
}
export async function withLock(directory, action) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'operation.lock');
  try { fs.mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('Operation already running; remove stale operation.lock only after confirming its process stopped'); throw error; }
  try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); return await action(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
export const withProject = (root, action) => withLock(within(projectRoot(root), '.bolt'), action);
