const $ = id => document.getElementById(id);
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const empty = text => element('p', text, 'empty');
async function refresh() {
  $('refresh').disabled = true;
  try {
    const response = await fetch('/api/status');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load ledger');
    $('notice').className = '';
    $('notice').textContent = `${data.audit.project_name} · Updated ${new Date().toLocaleTimeString()}`;
    $('count').textContent = `${data.slots.filter(s => s.status === 'VERIFIED').length} / ${data.slots.length} verified`;
    $('slots').replaceChildren();
    for (const slot of data.slots) {
      const row = element('tr'), name = element('td', slot.slot_id), status = element('td'), source = element('td', slot.license || 'No license recorded');
      name.append(element('small', slot.capability));
      const badge = element('span', slot.status, 'badge'); badge.dataset.status = slot.status; status.append(badge);
      source.append(element('small', slot.source_repo || 'Awaiting harvest'));
      row.append(name, status, source, element('td', slot.last_verified_at ? new Date(slot.last_verified_at).toLocaleString() : '—')); $('slots').append(row);
    }
    if (!data.slots.length) { const row = element('tr'), cell = element('td', 'No plumbing slots declared. Initialize a project audit to begin.'); cell.colSpan = 4; row.append(cell); $('slots').append(row); }
    $('audit').replaceChildren();
    for (const [title, key] of [['Custom Brains', 'custom_brains'], ['OSS Plumbing', 'plumbing_slots'], ['Regression Traps', 'banned_patterns']]) {
      const items = JSON.parse(data.audit[key]), list = element('ul');
      for (const item of items) list.append(element('li', typeof item === 'string' ? item : `${item.slotId}: ${item.capability}`));
      $('audit').append(element('h3', title), items.length ? list : empty('None declared.'));
    }
    const tickets = data.tickets.filter(t => !t.resolved_at);
    $('tickets').replaceChildren(...(tickets.length ? tickets.map(t => element('li', `${t.file}:${t.line} · ${t.message}`)) : [element('li', 'No open seam tickets.')]));
    $('notices').replaceChildren(...(data.security_notices?.length ? data.security_notices.map(n => element('li', `${n.file}:${n.line} · ${n.rule} · ${n.message}`)) : [element('li', 'No vendor security patterns detected.')]));
    $('runs').replaceChildren();
    for (const run of data.runs) {
      const details = element('details'); details.append(element('summary', `${run.slot_id} · exit ${run.exit_code} · ${run.duration_ms} ms${run.timed_out ? ' · timed out' : ''}`), element('pre', `${run.command}\n${run.stdout}\n${run.stderr}`)); $('runs').append(details);
    }
    if (!data.runs.length) $('runs').append(empty('No contract runs yet.'));
    $('registry').replaceChildren(...(data.registry.length ? data.registry.map(entry => element('li', `${entry.slug} · ${entry.description || entry.tags.join(', ') || entry.license}`)) : [element('li', 'No promoted components yet.')]));
  } catch (error) { $('notice').className = 'error'; $('notice').textContent = error.message; }
  finally { $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', refresh);
await refresh();
