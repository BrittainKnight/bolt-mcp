import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { git } from './process.mjs';
import { openLedger, getSlot, updateSlot } from './ledger.mjs';
import { within, projectRoot, slotRoot, walk, slash, sha256, writeJson, withProject, ignored } from './paths.mjs';
import { imports, importBase, resolveImport, sourceExtensions } from './imports.mjs';

export async function surgicalHarvest({ projectPath = process.cwd(), slotId, sourceRepoOrPath, targetPaths, stripPatterns = [] }) {
  const root = projectRoot(projectPath), destination = slotRoot(root, slotId);
  if (!Array.isArray(targetPaths) || !targetPaths.length) throw new Error('targetPaths must contain explicit paths');
  if (!Array.isArray(stripPatterns) || stripPatterns.some(p => typeof p !== 'string' || !p)) throw new Error('stripPatterns must be nonempty glob strings');
  if (typeof sourceRepoOrPath !== 'string' || !sourceRepoOrPath) throw new Error('Source is required');
  // Patterns exclude files; never silently rewrite third-party source or license text.
  const stripped = relative => stripPatterns.some(pattern => path.matchesGlob(relative, pattern));
  return withProject(root, async () => {
    const db = openLedger(root);
    try { if (getSlot(db, slotId).status !== 'PENDING') throw new Error('Harvest requires a PENDING slot'); } finally { db.close(); }
    if (fs.existsSync(destination)) throw new Error('Slot directory already exists; refusing overwrite');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bolt-harvest-'));
    const staging = within(root, `src/bolted/.harvest-${randomUUID()}`);
    try {
      let source, commit = null;
      const remote = /^(?:https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(sourceRepoOrPath);
      if (remote) {
        if (!sourceRepoOrPath.startsWith('git@')) { const url = new URL(sourceRepoOrPath); if (url.password || (url.username && url.protocol !== 'ssh:')) throw new Error('Credential-bearing Git URLs are refused'); }
        source = path.join(temp, 'repo');
        for (const target of targetPaths) within(source, target);
        await git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--', sourceRepoOrPath, source]);
        await git(['sparse-checkout', 'init', '--no-cone'], source);
        await git(['sparse-checkout', 'set', '--no-cone', '--', ...targetPaths.map(p => '/' + p), '/LICENSE*', '/LICENCE*', '/COPYING*'], source);
        await git(['checkout', '--detach'], source);
        commit = await git(['rev-parse', 'HEAD'], source);
      } else {
        source = projectRoot(sourceRepoOrPath);
        try { commit = await git(['rev-parse', 'HEAD'], source); } catch { commit = null; }
      }
      const vendor = path.join(staging, 'vendor');
      fs.mkdirSync(vendor, { recursive: true });
      const selected = new Set(), warnings = [];
      for (const target of targetPaths) {
        const full = within(source, target);
        if (!fs.existsSync(full)) throw new Error(`Target not found: ${target}`);
        const files = fs.statSync(full).isDirectory() ? walk(full) : [full];
        for (const file of files) {
          const relative = slash(path.relative(source, file));
          within(source, relative);
          if (relative.split('/').some(p => ignored.has(p) || p === '.env' || p.startsWith('.env.'))) throw new Error(`Excluded source path: ${relative}`);
          if (!stripped(relative)) selected.add(relative);
        }
      }
      if (!selected.size) throw new Error('No source files selected');
      for (const relative of [...selected].sort()) {
        if (!sourceExtensions.test(relative)) continue;
        const file = within(source, relative);
        for (const item of imports(fs.readFileSync(file, 'utf8'), file)) {
          if (item.error) { warnings.push(`${relative}:${item.line}: ${item.error}`); continue; }
          if (!item.python && !item.specifier.startsWith('.')) continue;
          const base = importBase(source, file, item);
          const resolved = resolveImport(base, item.python);
          // shortcut: unresolved sparse siblings are reported, explicitly harvest them before wiring.
          if (!resolved) { if (!item.member && item.specifier.startsWith('.')) warnings.push(`${relative}:${item.line}: unresolved local import ${item.specifier}; include its source path`); continue; }
          const sibling = slash(path.relative(source, resolved));
          within(source, sibling);
          if (!selected.has(sibling)) warnings.push(`${relative}:${item.line}: missing sibling ${sibling}; add it to targetPaths`);
        }
      }
      const licenses = fs.readdirSync(source).filter(name => /^(LICENSE|LICENCE|COPYING)([.-].*)?$/i.test(name)).sort();
      for (const name of licenses) { const file = within(source, name); if (fs.statSync(file).isFile()) selected.add(name); }
      let license = 'UNKNOWN';
      if (licenses.length) {
        const text = licenses.filter(n => selected.has(n)).map(n => fs.readFileSync(within(source, n), 'utf8')).join('\n');
        license = /MIT License|Permission is hereby granted, free of charge/.test(text) ? 'MIT' : /Apache License[\s\S]*Version 2\.0/.test(text) ? 'Apache-2.0' : 'SEE LICENSE';
      }
      const files = [...selected].sort().map(relative => {
        const input = within(source, relative), output = within(vendor, relative);
        fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(input, output);
        return { path: relative, sha256: sha256(fs.readFileSync(output)) };
      });
      const provenance = { source: remote ? sourceRepoOrPath : source, commit_sha: commit, harvested_at: new Date().toISOString(), license, target_paths: targetPaths, warnings, files };
      writeJson(path.join(staging, 'provenance.json'), provenance);
      fs.renameSync(staging, destination);
      updateSlot(root, slotId, { status: 'HARVESTED', source_repo: provenance.source, commit_sha: commit, license, verified_hash: null, last_verified_at: null });
      return { slotId, status: 'HARVESTED', provenance, warnings };
    } finally { fs.rmSync(temp, { recursive: true, force: true }); fs.rmSync(staging, { recursive: true, force: true }); }
  });
}
