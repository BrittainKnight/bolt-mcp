import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectRoot, slotRoot, within, identifier, walk, fingerprint, writeJson, withLock, withProject } from './paths.mjs';
import { openLedger, getSlot, updateSlot, syncMarkdown } from './ledger.mjs';
import { inspectSeams } from './auditor.mjs';
import { verifyUnlocked } from './verifier.mjs';

export function registryRoot() {
  const root = path.resolve(process.env.BOLT_REGISTRY_DIR || path.join(os.homedir(), '.bolt-mcp', 'registry'));
  within(root, 'index.json');
  return root;
}
export function catalog() {
  const file = within(registryRoot(), 'index.json');
  if (!fs.existsSync(file)) return [];
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error('Invalid registry index');
  for (const entry of entries) {
    identifier(entry.slug, 'slug');
    if (!Array.isArray(entry.tags) || entry.tags.some(t => typeof t !== 'string') || typeof entry.description !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid registry entry');
  }
  return entries;
}
function copyComponent(source, destination) {
  fs.mkdirSync(destination, { recursive: false });
  for (const file of walk(source)) {
    const relative = path.relative(source, file);
    const target = within(destination, relative.split(path.sep).join('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target);
  }
}
export async function promoteToRegistry({ projectPath = process.cwd(), slotId, slug, tags = [], description = '' }) {
  identifier(slug, 'slug');
  if (!Array.isArray(tags) || tags.some(t => typeof t !== 'string') || typeof description !== 'string') throw new Error('Invalid registry metadata');
  const root = projectRoot(projectPath), registry = registryRoot();
  return withProject(root, () => withLock(registry, () => {
    const db = openLedger(root); let slot;
    try { slot = getSlot(db, slotId); } finally { db.close(); }
    const directory = slotRoot(root, slotId);
    if (slot.status !== 'VERIFIED' || slot.verified_hash !== fingerprint(directory)) throw new Error('Promotion requires an unchanged VERIFIED slot');
    const { findings } = inspectSeams({ projectPath: root, slotId });
    if (findings.length) throw new Error('Seams changed since verification; audit and verify again');
    const index = catalog(), destination = within(registry, slug), staging = within(registry, `.promote-${randomUUID()}`);
    if (index.some(e => e.slug === slug) || fs.existsSync(destination)) throw new Error('Registry slug already exists; use a new versioned slug');
    try {
      copyComponent(directory, staging);
      if (fingerprint(staging) !== slot.verified_hash) throw new Error('Component changed during promotion');
      const entry = { slug, tags: [...new Set(tags)].sort(), description, capability: slot.capability, sha256: slot.verified_hash, license: slot.license, promoted_at: new Date().toISOString() };
      fs.renameSync(staging, destination);
      try { writeJson(within(registry, 'index.json'), [...index, entry].sort((a, b) => a.slug.localeCompare(b.slug, 'en'))); }
      catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
      return entry;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }));
}
export async function searchAndMountRegistry({ query = '', mountSlotId, projectPath = process.cwd() }) {
  if (typeof query !== 'string') throw new Error('query must be a string');
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = catalog().filter(entry => words.every(word => `${entry.slug} ${entry.description} ${entry.tags.join(' ')}`.toLowerCase().includes(word)));
  if (!mountSlotId) return { matches };
  identifier(mountSlotId, 'mountSlotId');
  const entry = matches.find(e => e.slug === query) ?? (matches.length === 1 ? matches[0] : null);
  if (!entry) throw new Error('Mount requires exactly one match or an exact slug');
  const root = projectRoot(projectPath);
  return withProject(root, async () => {
    const db = openLedger(root);
    try { if (getSlot(db, mountSlotId).status !== 'PENDING') throw new Error('Mount requires a PENDING slot declared in the project audit'); } finally { db.close(); }
    const source = within(registryRoot(), entry.slug), destination = slotRoot(root, mountSlotId);
    if (fingerprint(source) !== entry.sha256) throw new Error('Registry component integrity check failed');
    if (fs.existsSync(destination)) throw new Error('Mount destination already exists');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staging = within(root, `src/bolted/.mount-${randomUUID()}`);
    try {
      copyComponent(source, staging);
      if (fingerprint(staging) !== entry.sha256) throw new Error('Registry changed during mount');
      const provenance = JSON.parse(fs.readFileSync(within(staging, 'provenance.json'), 'utf8'));
      const adapter = fs.readdirSync(staging).find(name => /^adapter\.(mjs|ts|py)$/.test(name));
      if (!adapter) throw new Error('Registry component has no adapter');
      fs.renameSync(staging, destination);
      updateSlot(root, mountSlotId, { status: 'WIRED', source_repo: provenance.source, commit_sha: provenance.commit_sha, license: provenance.license, adapter_path: `src/bolted/${mountSlotId}/${adapter}`, verified_hash: null, last_verified_at: null });
      const verification = await verifyUnlocked({ projectPath: root, slotId: mountSlotId });
      syncMarkdown(root);
      return { matches, mounted: entry.slug, ...verification };
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  });
}
