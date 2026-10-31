import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectRoot, within, identifier, atomicWrite, withProject } from './paths.mjs';

export function openLedger(projectPath) {
  const file = within(projectRoot(projectPath), '.bolt/ledger.db');
  if (!fs.existsSync(file)) throw new Error('Initialize the project ledger first');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS security_notices (slot_id TEXT NOT NULL REFERENCES bolt_slots(slot_id), rule TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, message TEXT NOT NULL, PRIMARY KEY(slot_id,rule,file,line));`);
  return db;
}
export function getSlot(db, slotId) {
  const row = db.prepare('SELECT * FROM bolt_slots WHERE slot_id=?').get(identifier(slotId, 'slotId'));
  if (!row) throw new Error(`Unknown slot: ${slotId}`);
  return row;
}
export function snapshot(projectPath) {
  const db = openLedger(projectPath);
  try { return { audit: db.prepare('SELECT * FROM project_audit').get(), slots: db.prepare('SELECT * FROM bolt_slots ORDER BY slot_id').all(), tickets: db.prepare('SELECT * FROM seam_tickets ORDER BY id').all(), security_notices: db.prepare('SELECT *, \'warning\' AS severity FROM security_notices ORDER BY slot_id,file,line,rule').all(), runs: db.prepare('SELECT * FROM verification_runs ORDER BY id DESC LIMIT 50').all() }; }
  finally { db.close(); }
}
const cell = value => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('<', '&lt;');
export function syncMarkdown(projectPath) {
  const { audit, slots, tickets, security_notices } = snapshot(projectPath);
  const lines = [`# ${cell(audit.project_name)} — Bolt Ledger`, '', 'Audit → Surgical Harvest → Hexagonal Adapter Scaffold → Seam Audit → Live-Fire Contract Verification → Local Registry Promotion', ''];
  for (const [title, field] of [['Custom Brains', 'custom_brains'], ['OSS Plumbing', 'plumbing_slots'], ['Regression Traps', 'banned_patterns']]) lines.push(`## ${title}`, '', ...JSON.parse(audit[field]).map(item => `- ${cell(typeof item === 'string' ? item : JSON.stringify(item))}`), '');
  lines.push('## Slots', '', '| Slot | Capability | Status | Source | Commit | License | Adapter | Test | Last verified |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...slots.map(s => `| ${[s.slot_id, s.capability, s.status, s.source_repo, s.commit_sha, s.license, s.adapter_path, s.test_cmd, s.last_verified_at].map(cell).join(' | ')} |`), '', '## Seam tickets', '', ...tickets.map(t => `- [${t.resolved_at ? 'x' : ' '}] ${cell(t.slot_id)} ${cell(t.check_name)}: ${cell(t.file)}:${t.line} — ${cell(t.message)}`), '');
  lines.push('## Security notices', '', ...(security_notices.length ? security_notices.map(n => `- **Warning** ${cell(n.slot_id)} / ${cell(n.rule)}: ${cell(n.file)}:${n.line} — ${cell(n.message)}`) : ['No vendor security patterns detected.']), '');
  atomicWrite(within(projectRoot(projectPath), '.bolt/BOLT_LEDGER.md'), lines.join('\n'));
}
export async function initLedger({ projectPath = process.cwd(), projectName, customBrains = [], plumbingSlots = [], bannedPatterns = [] }) {
  const root = projectRoot(projectPath);
  if (typeof projectName !== 'string' || !projectName.trim()) throw new Error('projectName is required');
  for (const list of [customBrains, bannedPatterns]) if (!Array.isArray(list) || list.some(s => typeof s !== 'string' || !s.trim())) throw new Error('Audit rules must be arrays of nonempty strings');
  if (!Array.isArray(plumbingSlots)) throw new Error('plumbingSlots must be an array');
  const slots = plumbingSlots.map(s => typeof s === 'string' ? { slotId: s, capability: s } : s);
  for (const s of slots) { identifier(s.slotId); if (typeof s.capability !== 'string' || !s.capability.trim()) throw new Error('Slot capability is required'); }
  if (new Set(slots.map(s => s.slotId)).size !== slots.length) throw new Error('Duplicate slot IDs');
  return withProject(root, () => {
    const db = new DatabaseSync(within(root, '.bolt/ledger.db'));
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS project_audit (id INTEGER PRIMARY KEY CHECK(id=1), project_name TEXT NOT NULL, custom_brains TEXT NOT NULL, plumbing_slots TEXT NOT NULL, banned_patterns TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS bolt_slots (slot_id TEXT PRIMARY KEY, capability TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','HARVESTED','WIRED','POLISHED','VERIFIED')), source_repo TEXT, commit_sha TEXT, license TEXT, adapter_path TEXT, test_cmd TEXT, last_verified_at TEXT, verified_hash TEXT);
        CREATE TABLE IF NOT EXISTS seam_tickets (id INTEGER PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES bolt_slots(slot_id), check_name TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT);
        CREATE TABLE IF NOT EXISTS verification_runs (id INTEGER PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES bolt_slots(slot_id), command TEXT NOT NULL, exit_code INTEGER NOT NULL, duration_ms INTEGER NOT NULL, stdout TEXT NOT NULL, stderr TEXT NOT NULL, timed_out INTEGER NOT NULL, truncated INTEGER NOT NULL, created_at TEXT NOT NULL);
        BEGIN IMMEDIATE;`);
      const existing = db.prepare('SELECT * FROM project_audit').get();
      if (existing) throw new Error('Ledger already initialized; existing rules and slots are preserved');
      db.prepare('INSERT INTO project_audit VALUES (1,?,?,?,?)').run(projectName, JSON.stringify(customBrains), JSON.stringify(slots), JSON.stringify(bannedPatterns));
      for (const s of slots) db.prepare('INSERT INTO bolt_slots(slot_id,capability) VALUES (?,?)').run(s.slotId, s.capability);
      db.exec('COMMIT');
    } finally { db.close(); }
    syncMarkdown(root);
    return snapshot(root);
  });
}
export function updateSlot(projectPath, slotId, fields) {
  const allowed = new Set(['status', 'source_repo', 'commit_sha', 'license', 'adapter_path', 'test_cmd', 'last_verified_at', 'verified_hash']);
  const entries = Object.entries(fields);
  if (!entries.length || entries.some(([key]) => !allowed.has(key))) throw new Error('Invalid slot fields');
  const db = openLedger(projectPath);
  try { getSlot(db, slotId); db.prepare(`UPDATE bolt_slots SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE slot_id=?`).run(...entries.map(([, value]) => value), slotId); }
  finally { db.close(); }
  syncMarkdown(projectPath);
}
