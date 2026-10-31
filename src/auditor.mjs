import fs from 'node:fs';
import path from 'node:path';
import { projectRoot, slotRoot, within, walk, slash, sha256, fingerprint, withProject } from './paths.mjs';
import { openLedger, getSlot, syncMarkdown } from './ledger.mjs';
import { imports, importBase, resolveImport, sourceExtensions, pathAliases } from './imports.mjs';

export function inspectSeams({ projectPath = process.cwd(), slotId }) {
  const root = projectRoot(projectPath), directory = slotRoot(root, slotId), findings = [], security_notices = [];
  const add = (check, file, line, message) => findings.push({ check, file: slash(path.relative(root, file)), line, message });
  const prefix = `src/bolted/${slotId}/`;
  const db = openLedger(root);
  let rules;
  try { getSlot(db, slotId); rules = JSON.parse(db.prepare('SELECT banned_patterns FROM project_audit').get().banned_patterns); } finally { db.close(); }
  let files;
  try { files = walk(root); } catch (error) { add('boundary', root, 1, error.message); files = []; }
  let aliases = [];
  try { aliases = pathAliases(root); }
  catch (error) { add('boundary', path.join(root, 'tsconfig.json'), 1, `Cannot resolve path aliases: ${error.message}`); }
  const risks = [
    ['eval', /\beval\s*\(/g, 'Dynamic code evaluation; review the source of executed text'],
    ['new-function', /\bnew\s+Function\s*\(/g, 'Dynamic function construction; review the source of executed text'],
    ['child-process', /\bchild_process\b/g, 'Child process access; review executable arguments and cleanup'],
    ['python-subprocess', /\bsubprocess\s*\.\s*Popen\s*\(/g, 'Child process access; review executable arguments and cleanup'],
    ['python-environment', /\bos\s*\.\s*environ\b/g, 'Environment access; review which variables may be consumed or transmitted'],
    ['node-environment', /\bprocess\s*(?:\.\s*env\b|\[\s*['"]env['"]\s*\])/g, 'Environment access; review which variables may be consumed or transmitted'],
  ];
  try {
    for (const file of walk(path.join(directory, 'vendor'), new Set())) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [rule, pattern, message] of risks) for (const match of text.matchAll(pattern)) security_notices.push({ severity: 'warning', rule, file: slash(path.relative(root, file)), line: text.slice(0, match.index).split('\n').length, message });
    }
  } catch (error) { add('provenance', path.join(directory, 'vendor'), 1, error.message); }
  for (const file of files) {
    if (!sourceExtensions.test(file) && !/\.(?:vue|svelte|html|astro)$/.test(file)) continue;
    const relative = slash(path.relative(root, file)), text = fs.readFileSync(file, 'utf8');
    const bridge = /(?:^|\/)adapter\.runtime\.(mjs|py)$/.exec(relative);
    const trustedBridge = bridge && text === fs.readFileSync(new URL(`./templates/runtime.${bridge[1]}`, import.meta.url), 'utf8').replace("'./isolation.mjs'", "'./adapter.isolation.mjs'");
    const ownSlot = relative.match(/^src\/bolted\/([^/]+)\//)?.[1];
    for (const item of imports(text, file)) {
      if (item.error) { if (!trustedBridge) add('boundary', file, item.line, item.error); continue; }
      let bases;
      try { bases = [importBase(root, file, item)]; }
      catch (error) { add('boundary', file, item.line, error.message); continue; }
      const aliased = [];
      for (const { key, value, base } of item.python || item.specifier.startsWith('.') ? [] : aliases) {
        const [before, after = ''] = key.split('*');
        if (key.includes('*') ? item.specifier.startsWith(before) && item.specifier.endsWith(after) : item.specifier === key) {
          const replacement = key.includes('*') ? item.specifier.slice(before.length, after ? -after.length : undefined) : '';
          aliased.push(path.resolve(root, base, value.replace('*', replacement)));
        }
      }
      if (aliased.length) bases = aliased;
      // Python absolute imports may start from the repository's src search root.
      if (item.python && !item.specifier.startsWith('.')) bases.push(path.resolve(root, 'src', item.specifier.replaceAll('.', '/')));
      for (const base of bases.filter(Boolean)) {
        const target = slash(path.relative(root, base));
        const targetSlot = target.match(/^src\/bolted\/([^/]+)(?:\/|$)/)?.[1];
        if (!relative.startsWith(prefix) && (target === `src/bolted/${slotId}/vendor` || target.startsWith(prefix + 'vendor/'))) add('hexagonal', file, item.line, `Import slot ${slotId} through adapter only: ${item.specifier}`);
        if (ownSlot && targetSlot && ownSlot !== targetSlot) add('cross-slot', file, item.line, `Route ${ownSlot} → ${targetSlot} through the host spine`);
      }
      if (relative.startsWith(prefix + 'vendor/') && !item.member && item.specifier.startsWith('.')) {
        const base = importBase(root, file, item), resolved = resolveImport(base, item.python);
        if (!resolved && !(item.python && ( /^\.+$/.test(item.specifier) || (fs.existsSync(base) && fs.statSync(base).isDirectory()) ))) add('provenance', file, item.line, `Missing sibling dependency: ${item.specifier}`);
        if (resolved && !resolved.startsWith(path.join(directory, 'vendor') + path.sep)) add('hexagonal', file, item.line, 'Vendor relative import escapes its harvested slice');
      }
    }
    if (relative.startsWith(prefix) && /\/(adapter(?:\.(?:runtime|isolation))?\.(?:ts|mjs|py)|contract\.test\.(?:mjs|py))$/.test(relative)) {
      const markers = /\b(?:TODO|FIXME|NotImplemented(?:Error)?)\b|throw\s+new\s+Error\s*\(\s*['"]not implemented['"]\s*\)|catch\s*(?:\([^)]*\))?\s*\{(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*\}|except[^\n]*:\s*pass\b/gi;
      for (const match of text.matchAll(markers)) add('unfinished', file, text.slice(0, match.index).split('\n').length, 'Replace unfinished marker or empty error handler with working behavior');
    }
    for (const rule of rules) {
      let offset = text.indexOf(rule);
      while (offset !== -1) { add('regression', file, text.slice(0, offset).split('\n').length, `Banned literal pattern: ${rule}`); offset = text.indexOf(rule, offset + rule.length); }
    }
  }
  const adapters = files.filter(f => path.dirname(f) === directory && /^adapter\.(ts|mjs|py)$/.test(path.basename(f)));
  const contracts = files.filter(f => path.dirname(f) === directory && /^contract\.test\.(mjs|py)$/.test(path.basename(f)));
  if (adapters.length !== 1) add('unfinished', path.join(directory, 'adapter.mjs'), 1, 'Exactly one runnable adapter is required');
  if (contracts.length !== 1) add('unfinished', path.join(directory, 'contract.test.mjs'), 1, 'Exactly one runnable contract test is required');
  const provenanceFile = path.join(directory, 'provenance.json');
  try {
    const provenance = JSON.parse(fs.readFileSync(within(directory, 'provenance.json'), 'utf8'));
    if (!Array.isArray(provenance.files) || !provenance.files.length) throw new Error('Provenance files must be nonempty');
    const expected = new Set();
    for (const entry of provenance.files) {
      if (expected.has(entry.path)) throw new Error('Duplicate provenance path');
      expected.add(entry.path);
      const file = within(directory, 'vendor/' + entry.path);
      if (!/^[a-f0-9]{64}$/.test(entry.sha256) || !fs.existsSync(file) || sha256(fs.readFileSync(file)) !== entry.sha256) add('provenance', file, 1, 'Vendor file is missing or differs from the harvested SHA-256');
    }
    for (const file of walk(within(directory, 'vendor'), new Set())) if (!expected.has(slash(path.relative(path.join(directory, 'vendor'), file)))) add('provenance', file, 1, 'Unrecorded vendor file; reharvest from a reviewed source');
  } catch (error) { add('provenance', provenanceFile, 1, `Invalid provenance: ${error.message}`); }
  const ordered = rows => [...new Map(rows.map(row => [JSON.stringify(row), row])).values()].sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line || (a.check ?? a.rule).localeCompare(b.check ?? b.rule, 'en'));
  return { findings: ordered(findings), security_notices: ordered(security_notices) };
}
export function auditUnlocked(options) {
  const root = projectRoot(options.projectPath), { findings, security_notices } = inspectSeams(options), now = new Date().toISOString();
  const db = openLedger(root);
  let status;
  try {
    const slot = getSlot(db, options.slotId);
    status = findings.length ? (slot.adapter_path ? 'WIRED' : slot.status === 'PENDING' ? 'PENDING' : 'HARVESTED') : 'POLISHED';
    if (!findings.length && slot.status === 'VERIFIED' && slot.verified_hash === fingerprint(slotRoot(root, options.slotId))) status = 'VERIFIED';
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM security_notices WHERE slot_id=?').run(options.slotId);
    for (const notice of security_notices) db.prepare('INSERT INTO security_notices(slot_id,rule,file,line,message) VALUES (?,?,?,?,?)').run(options.slotId, notice.rule, notice.file, notice.line, notice.message);
    const pending = db.prepare('SELECT * FROM seam_tickets WHERE slot_id=? AND resolved_at IS NULL').all(options.slotId);
    const matches = (ticket, finding) => ticket.check_name === finding.check && ticket.file === finding.file && ticket.line === finding.line && ticket.message === finding.message;
    for (const ticket of pending) if (!findings.some(f => matches(ticket, f))) db.prepare('UPDATE seam_tickets SET resolved_at=? WHERE id=?').run(now, ticket.id);
    for (const finding of findings) if (!pending.some(ticket => matches(ticket, finding))) db.prepare('INSERT INTO seam_tickets(slot_id,check_name,file,line,message,created_at) VALUES (?,?,?,?,?,?)').run(options.slotId, finding.check, finding.file, finding.line, finding.message, now);
    db.prepare('UPDATE bolt_slots SET status=?, verified_hash=CASE WHEN ?=\'VERIFIED\' THEN verified_hash ELSE NULL END, last_verified_at=CASE WHEN ?=\'VERIFIED\' THEN last_verified_at ELSE NULL END WHERE slot_id=?').run(status, status, status, options.slotId);
    db.exec('COMMIT');
  } finally { db.close(); }
  syncMarkdown(root);
  return { slotId: options.slotId, ok: !findings.length, status, findings, security_notices };
}
export const auditSeams = options => withProject(options.projectPath, () => auditUnlocked(options));
