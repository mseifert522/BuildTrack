'use strict';
// Which project an invoice (or one line of it) is for - Mike's rules, 2026-10-28:
// "BuildTrack must first be absolutely sure and confirm from the invoice what project
// it is." Evidence, strongest first:
//   1. street number + a close variation of the street name ("2153 Milverton Dr" =
//      2153 Milverton Rd; city and suffix ignored),
//   2. the street name alone when exactly one live project is on that street
//      ("Wisconsin Ave" = 2811 Wisconsin Rd: "the project already says Wisconsin"),
//   3. a known name for a project (project_location_aliases: "Chesterfield" = 34641
//      Joel St, whose real address says New Baltimore), or the exact job name /
//      QuickBooks class name.
// Anything else - no evidence, or evidence for two projects - is left for a person.
// The AI reads the invoice; this code re-checks every pick and both must agree.
//
// One invoice that covers several job sites is split per project (one BuildTrack
// invoice per project, each with its own lines, tied by split_group_id and holding
// the vendor invoice's full total in split_group_total). It stays ONE vendor invoice:
// one Waiting-for-Approval row, one duplicate key, matched to the QuickBooks bill's
// classes by the invoice monitor.
const { v4: uuidv4 } = require('uuid');

const DIRECTION_WORDS = new Set(['n', 's', 'e', 'w', 'north', 'south', 'east', 'west']);
// Words that can follow a number on an invoice line without being a street ("2 Cuts").
const NOT_STREETS = new Set([
  'cut', 'cuts', 'service', 'services', 'job', 'jobs', 'hr', 'hrs', 'hour', 'hours', 'day', 'days', 'visit', 'visits',
  'yard', 'yards', 'ton', 'tons', 'bag', 'bags', 'sq', 'sqft', 'ft', 'feet', 'ea', 'each', 'unit', 'units', 'x',
  'week', 'weeks', 'month', 'months', 'load', 'loads', 'trip', 'trips', 'room', 'rooms', 'window', 'windows',
]);

// Same keys as documentReview.addressKey / vendorDirectory.normalizeVendorName (kept
// here so this module loads without the AI client): "2153 Milverton Rd, Troy" ->
// { number: '2153', street: 'milverton' }.
function addressKey(address) {
  const first = String(address || '').split(',')[0].toLowerCase();
  const match = first.match(/^\s*(\d+[a-z]?)\s+(.*)$/);
  if (!match) return null;
  const parts = match[2].replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(word => word && !DIRECTION_WORDS.has(word));
  return parts.length ? { number: match[1], street: parts[0] } : null;
}

function normalizeVendorName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Additive and idempotent (blue and green share one DB); once per connection.
const schemaReady = new WeakSet();
function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  schemaReady.add(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_location_aliases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      alias_key TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'office',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(alias_key, project_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_project_location_aliases_key ON project_location_aliases(alias_key);
  `);
  for (const sql of [
    'ALTER TABLE invoices ADD COLUMN split_group_id TEXT',
    'ALTER TABLE invoices ADD COLUMN split_group_total REAL',
  ]) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_invoices_split_group ON invoices(split_group_id)'); } catch (_) { /* best-effort */ }
}

function words(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function phraseKey(value) {
  return words(value).join(' ');
}

// "<number> <street>" pairs in free text, skipping quantities ("2 Cuts", "1 service").
function addressKeysIn(value) {
  const keys = [];
  const pattern = /(\d+[a-z]?)\s+((?:[nsew]\.?\s+|north\s+|south\s+|east\s+|west\s+)?[a-z][a-z'.-]+)/gi;
  for (const match of String(value || '').matchAll(pattern)) {
    const key = addressKey(`${match[1]} ${match[2]}`);
    if (key && !NOT_STREETS.has(key.street)) keys.push(key);
  }
  return keys;
}

// Street names of 5+ letters that differ by one insert, delete or substitution.
function withinOneEdit(a, b) {
  if (!a || !b || a === b || Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// Everything the rules match against, built once per read.
function loadProjects(db) {
  ensureSchema(db);
  const projects = db.prepare(`
    SELECT id, address, job_name, status, quickbooks_class_name FROM projects
    WHERE trim(COALESCE(address, '')) <> ''
  `).all();
  const aliases = db.prepare('SELECT project_id, alias, alias_key FROM project_location_aliases').all();
  return buildIndex(projects, aliases);
}

function buildIndex(projects, aliases = []) {
  const live = projects.filter(p => p.status !== 'archived');
  const byStreet = new Map();
  for (const p of live) {
    const key = addressKey(p.address);
    if (!key) continue;
    if (!byStreet.has(key.street)) byStreet.set(key.street, []);
    byStreet.get(key.street).push(p);
  }
  return {
    projects,
    byId: new Map(projects.map(p => [p.id, p])),
    keys: new Map(projects.map(p => [p.id, [addressKey(p.address), ...addressKeysIn(p.job_name), ...addressKeysIn(p.quickbooks_class_name)].filter(Boolean)])),
    names: new Map(projects.map(p => [p.id, [p.job_name, p.quickbooks_class_name].map(normalizeVendorName).filter(n => n.length >= 5)])),
    byStreet,
    aliases: aliases.map(a => ({ ...a, alias_key: a.alias_key || phraseKey(a.alias) })),
    aliasesFor: id => aliases.filter(a => a.project_id === id).map(a => a.alias),
  };
}

// Projects that the text points at, by the strongest rule that finds any.
// -> { ids: Set, rule } ; rule is 'number_street' | 'street_only' | 'alias' | 'job_name' | null
function evidenceFor(index, value, { aiProjectId = null } = {}) {
  const textValue = String(value || '');
  if (!textValue.trim()) return { ids: new Set(), rule: null };
  const keys = addressKeysIn(textValue);
  if (keys.length) {
    const ids = new Set();
    for (const [id, projectKeys] of index.keys) {
      const exact = keys.some(k => projectKeys.some(pk => pk.number === k.number && pk.street === k.street));
      // A one-letter slip in the street ("2811 Wisconson") counts only with the exact
      // house number AND the AI naming the same project.
      const slip = !exact && aiProjectId === id
        && keys.some(k => projectKeys.some(pk => pk.number === k.number && withinOneEdit(pk.street, k.street)));
      if (exact || slip) ids.add(id);
    }
    // A printed number + street that is NOT ours is a different property: no fallback.
    return { ids, rule: ids.size ? 'number_street' : null };
  }
  const normalized = normalizeVendorName(textValue);
  const byName = new Set();
  for (const [id, names] of index.names) if (names.some(n => normalized === n)) byName.add(id);
  if (byName.size) return { ids: byName, rule: 'job_name' };
  const tokens = new Set(words(textValue).filter(w => !DIRECTION_WORDS.has(w)));
  const byStreet = new Set();
  for (const [street, projects] of index.byStreet) {
    if (street.length >= 4 && tokens.has(street)) projects.forEach(p => byStreet.add(p.id));
  }
  if (byStreet.size) return { ids: byStreet, rule: 'street_only' };
  const phrase = ` ${phraseKey(textValue)} `;
  const byAlias = new Set(index.aliases.filter(a => a.alias_key && phrase.includes(` ${a.alias_key} `)).map(a => a.project_id));
  if (byAlias.size) return { ids: byAlias, rule: 'alias' };
  return { ids: new Set(), rule: null };
}

const RULE_WORDS = {
  number_street: 'street number and street',
  street_only: 'the street name (only project on that street)',
  alias: 'a known name for the project',
  job_name: 'the job name',
};

// One place on the invoice -> one project, or null with the reason. The AI must agree
// (it may leave a street-number match unpicked; it may never pick a different project).
function decide(index, value, aiProjectId) {
  const label = String(value || '').trim();
  const found = evidenceFor(index, value, { aiProjectId });
  if (!found.ids.size) {
    return { id: null, reason: label ? `"${label}" does not match any project in BuildTrack.` : 'No job site is printed for it.' };
  }
  if (found.ids.size > 1) return { id: null, reason: `"${label}" matches more than one project in BuildTrack.` };
  const id = [...found.ids][0];
  if (aiProjectId && aiProjectId !== id) return { id: null, reason: `"${label}" is unclear - the reading and the address check point at different projects.` };
  // The street name of the only project on that street, and a name a person saved for a
  // project, are certain on their own (Mike 2026-10-28: "Wisconsin" is 2811 Wisconsin,
  // "Chesterfield" is 34641 Joel); a job-name match alone still needs the reading's pick.
  // A reading that names a DIFFERENT project always stops it (above).
  if (!aiProjectId && found.rule === 'job_name') {
    return { id: null, reason: `"${label}" was not confirmed by the AI reading, so it was not assigned without a person.` };
  }
  const project = index.byId.get(id);
  return { id, address: project.address, rule: found.rule, why: `${RULE_WORDS[found.rule]} on the invoice ("${label}")` };
}

const cents = n => Math.round(Number(n || 0) * 100);

// Tax printed once for the whole invoice, shared by each project's share of the lines
// (whole cents; the remainder goes to the smallest share so the sum is exact).
// groups: [{ lines, cents }] - mutated.
function addTaxShares(groups, taxCents) {
  const lineSum = groups.reduce((acc, g) => acc + g.cents, 0);
  if (!(taxCents > 0) || !lineSum) return groups;
  const list = [...groups].sort((a, b) => b.cents - a.cents);
  let left = taxCents;
  list.forEach((g, i) => {
    const share = i === list.length - 1 ? left : Math.floor((taxCents * g.cents) / lineSum);
    left -= share;
    if (share) { g.lines.push({ description: 'Sales tax (share)', amount: share / 100, tax: true }); g.cents += share; }
  });
  return groups;
}

// Every priced line placed on a project (or not) and the per-project totals. Tax that
// the lines do not carry is shared out in proportion (whole cents, remainder to the
// largest share). -> { lines, groups, unassigned, sumMatches }
function allocate(index, entry, total) {
  const docSite = [entry.property_address, entry.job_reference].filter(Boolean).join(' ');
  const lines = (entry.line_items || []).filter(line => line.amount !== null).map((line, i) => {
    const site = line.job_site || '';
    const result = site ? decide(index, site, line.project_ref_id || null) : null;
    return { index: i, description: line.description, amount: line.amount, job_site: site, project_id: result ? result.id : null, result };
  });
  const lineSum = lines.reduce((acc, line) => acc + cents(line.amount), 0);
  const taxCents = cents(entry.tax);
  const totalCents = cents(total);
  const sumMatches = lines.length > 0 && (lineSum === totalCents || (taxCents > 0 && lineSum + taxCents === totalCents));
  const groups = new Map();
  for (const line of lines) {
    if (!line.project_id) continue;
    const g = groups.get(line.project_id) || { project: index.byId.get(line.project_id), lines: [], cents: 0 };
    g.lines.push(line);
    g.cents += cents(line.amount);
    groups.set(line.project_id, g);
  }
  const unassigned = lines.filter(line => !line.project_id);
  if (sumMatches && taxCents > 0 && lineSum + taxCents === totalCents && !unassigned.length && groups.size) {
    addTaxShares([...groups.values()], taxCents);
  }
  return {
    docSite,
    lines,
    groups: [...groups.values()].map(g => ({ ...g, total: g.cents / 100 })),
    unassigned,
    sumMatches,
  };
}

// The shape every filing path sees: one project, a split, or nothing certain.
// -> { kind: 'single', project } | { kind: 'split', groups } | { kind: 'none', reason, suggestion }
function resolveInvoice(index, entry, total) {
  const hasLineSites = (entry.line_items || []).some(line => line.job_site);
  if (hasLineSites) {
    const plan = allocate(index, entry, total);
    const suggestion = plan.lines.map(line => ({ index: line.index, description: line.description, amount: line.amount, job_site: line.job_site, project_id: line.project_id }));
    if (!plan.sumMatches) {
      return { kind: 'none', suggestion, reason: 'The invoice lists several job sites, but its lines do not add up to the total, so it was not split automatically.' };
    }
    if (plan.unassigned.length) {
      const list = plan.unassigned.map(line => `${line.job_site || line.description} ($${Number(line.amount).toFixed(2)}): ${line.result ? line.result.reason : 'no job site printed on the line.'}`).join(' ');
      return { kind: 'none', suggestion, reason: `Not every line could be placed on a project. ${list}` };
    }
    if (plan.groups.length === 1) {
      const g = plan.groups[0];
      return { kind: 'single', project: { id: g.project.id, address: g.project.address }, why: 'every line names the same project', suggestion };
    }
    return { kind: 'split', groups: plan.groups, suggestion };
  }
  // The printed job address and the job reference are each checked on their own; when
  // both name a project they must name the same one.
  const printed = [entry.property_address, entry.job_reference].filter(Boolean);
  if (!printed.length) return { kind: 'none', reason: 'No job address or job number is printed on the invoice, so the project could not be identified.' };
  const results = printed.map(value => decide(index, value, entry.project_ref_id || null));
  const placed = results.filter(r => r.id);
  if (!placed.length) return { kind: 'none', reason: results[0].reason };
  if (new Set(placed.map(r => r.id)).size > 1) {
    return { kind: 'none', reason: `The job address and the job reference on the invoice name different projects ("${printed.join('" / "')}").` };
  }
  return { kind: 'single', project: { id: placed[0].id, address: placed[0].address }, why: placed[0].why };
}

// A person taught BuildTrack a name for a project (e.g. "Chesterfield" -> 34641 Joel).
function rememberAlias(db, { projectId, alias, userId = null, source = 'office' }) {
  ensureSchema(db);
  const key = phraseKey(alias);
  if (key.length < 3 || /^\d+$/.test(key)) return false;
  // A name that already means another project is never reused for this one.
  const other = db.prepare('SELECT 1 FROM project_location_aliases WHERE alias_key = ? AND project_id <> ?').get(key, projectId);
  if (other) return false;
  db.prepare(`INSERT OR IGNORE INTO project_location_aliases (id, project_id, alias, alias_key, source, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(uuidv4(), projectId, String(alias).trim().slice(0, 120), key, source, userId);
  return true;
}

module.exports = {
  ensureSchema, loadProjects, buildIndex, evidenceFor, decide, allocate, resolveInvoice, rememberAlias, addressKeysIn, phraseKey, addTaxShares, cents,
};
