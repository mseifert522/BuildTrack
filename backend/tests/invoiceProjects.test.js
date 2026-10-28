'use strict';
// Mike's project rules (2026-10-28) on the real Grassquatch INV-2026-1028 lines and the
// real project list: what is certain is filed, what is not stays for a person.
const assert = require('assert');
const { buildIndex, decide, resolveInvoice, addressKeysIn } = require('../src/services/invoiceProjects');

const P = {
  blair: { id: 'blair', address: '1132 N Blair Ave, Royal Oak, MI 48067, USA', job_name: '1132 Blair ', status: 'active_rehab' },
  milverton: { id: 'milverton', address: '2153 Milverton Rd, Troy, MI 48083, USA', job_name: '2153 Milverton', status: 'active_rehab', quickbooks_class_name: '1253 Milverton' },
  wisconsin: { id: 'wisconsin', address: '2811 Wisconsin Rd, Troy, MI 48083, USA', job_name: '2811 Wisconsin', status: 'active_rehab' },
  robina: { id: 'robina', address: '3170 Robina Ave, Berkley, MI 48072, USA', job_name: '3170 Robina', status: 'active_rehab' },
  joel: { id: 'joel', address: '34641 Joel St, New Baltimore, MI 48047, USA', job_name: '34641 Joel ', status: 'active_rehab' },
  garner: { id: 'garner', address: '895 N Garner Rd, Milford, MI 48380, USA', job_name: '895 Garner', status: 'active_rehab' },
  davis: { id: 'davis', address: '171 Davis St, Wyandotte, MI 48192, USA', job_name: '171 Davis', status: 'long_term_holding' },
  chopin: { id: 'chopin', address: '160 Chopin Ave, Troy, MI 48083, USA', job_name: '160 Chopin ', status: 'rehab_completed' },
  phillips: { id: 'phillips', address: '3653 Phillips Ave, Berkley, MI 48072, USA', job_name: '3653 Phillips', status: 'rehab_completed' },
};
const projects = Object.values(P);
const aliases = [{ project_id: 'joel', alias: 'Chesterfield', alias_key: 'chesterfield' }];
const index = buildIndex(projects, aliases);
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };

// Quantities are not streets.
ok(addressKeysIn('Lawn Mowing (2 Cuts) 2 x $45').length === 0, 'quantities are not addresses');

// Rule 1: number + street, suffix and city ignored.
ok(decide(index, '2153 Milverton Dr, Troy', 'milverton').id === 'milverton', 'Dr vs Rd');
ok(decide(index, '34641 Joel St, Chesterfield', 'joel').id === 'joel', 'Chesterfield city on Joel');
ok(decide(index, '895 N Garner Rd, Milford', null).id === 'garner', 'number+street may stand without an AI pick');
ok(decide(index, '500 Robina Ave', 'robina').id === null, 'a different house number is a different property');
// Rule 2: street only, unique street.
ok(decide(index, 'Wisconsin Ave', 'wisconsin').id === 'wisconsin', 'street only, unique, AI agrees');
ok(decide(index, 'Wisconsin Ave', null).id === 'wisconsin', 'street only, unique: certain on its own (Mike 10-28)');
ok(decide(index, 'Wisconsin Ave', 'robina').id === null, 'AI and check disagree -> person');
// Rule 3: alias.
ok(decide(index, 'Chesterfield', 'joel').id === 'joel', 'alias Chesterfield = Joel');
ok(decide(index, 'Chesterfield', null).id === 'joel', 'a saved alias stands without an AI pick');
ok(decide(index, 'Chesterfield', 'robina').id === null, 'a saved alias the reading contradicts -> person');
ok(decide(index, 'Royal Oak', 'blair').id === null, 'a town that is no alias is not enough');
// Job name / QuickBooks class name.
ok(decide(index, '1253 Milverton', 'milverton').id === 'milverton', 'QuickBooks class typo name');

// The Grassquatch invoice, read with per-line job sites (as Fable 5.1 read it 10-28).
const line = (description, amount, job_site, project_ref_id) => ({ description, amount, job_site, project_ref_id });
const entry = {
  property_address: 'Various locations - see line items below', job_reference: '', project_ref_id: null, tax: 0,
  line_items: [
    line('Chesterfield - Lawn Care Service (1 service)', 75, 'Chesterfield', 'joel'),
    line('Wisconsin Ave - Lawn Care Service (1 service)', 150, 'Wisconsin Ave', 'wisconsin'),
    line('3170 Robina Ave, Berkley - Lawn Mowing (2 Cuts) 2 x $45', 90, '3170 Robina Ave, Berkley', 'robina'),
    line('3170 Robina Ave, Berkley - Front yard rocks, weed barrier & mulch (1 job)', 535, '3170 Robina Ave, Berkley', 'robina'),
    line('2153 Milverton Dr, Troy - Lawn Mowing (1 Cut)', 75, '2153 Milverton Dr, Troy', 'milverton'),
    line('895 N Garner Rd, Milford - Lawn Mowing (1 Cut)', 250, '895 N Garner Rd, Milford', 'garner'),
    line('34641 Joel St, Chesterfield - Lawn Mowing (1 Cut)', 75, '34641 Joel St, Chesterfield', 'joel'),
  ],
};
const r = resolveInvoice(index, entry, 1250);
ok(r.kind === 'split', `Grassquatch splits (${r.kind}: ${r.reason || ''})`);
const shares = Object.fromEntries(r.groups.map(g => [g.project.id, g.total]));
ok(shares.robina === 625 && shares.wisconsin === 150 && shares.joel === 150 && shares.garner === 250 && shares.milverton === 75, `shares ${JSON.stringify(shares)}`);
ok(r.groups.reduce((s, g) => s + g.total, 0) === 1250, 'shares add up to the invoice total');
// As Fable 5.1 read it on the preview: no pick on the Chesterfield and Wisconsin lines.
const unpicked = { ...entry, line_items: entry.line_items.map(l => (/^(Chesterfield|Wisconsin Ave)$/.test(l.job_site) ? { ...l, project_ref_id: null } : l)) };
const r2 = resolveInvoice(index, unpicked, 1250);
ok(r2.kind === 'split' && r2.groups.length === 5, `splits without the reading's pick on alias/street lines (${r2.kind}: ${r2.reason || ''})`);

// Without the alias the Chesterfield line waits for a person (never guessed).
const noAlias = resolveInvoice(buildIndex(projects, []), entry, 1250);
ok(noAlias.kind === 'none' && /Chesterfield/.test(noAlias.reason), 'no alias -> person');
ok(noAlias.suggestion.filter(s => s.project_id).length === 6, 'the six certain lines are pre-filled for the person');

// Lines that do not add up are never split.
ok(resolveInvoice(index, { ...entry, line_items: entry.line_items.slice(1) }, 1250).kind === 'none', 'lines short of the total');

// Tax shared by proportion, whole cents, exact total.
const taxed = resolveInvoice(index, { ...entry, tax: 87.5 }, 1337.5);
ok(taxed.kind === 'split' && Math.round(taxed.groups.reduce((s, g) => s + g.total, 0) * 100) === 133750, 'tax shared to the cent');

// Single-site invoice keeps working through the document address.
const single = resolveInvoice(index, { property_address: '2811 Wisconsin Rd, Troy', job_reference: '', project_ref_id: 'wisconsin', line_items: [line('Painting', 6000, '', null)], tax: 0 }, 6000);
ok(single.kind === 'single' && single.project.id === 'wisconsin', 'single site');

console.log(`invoiceProjects: ${n} checks passed`);
