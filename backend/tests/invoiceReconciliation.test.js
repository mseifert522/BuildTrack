// Tests for the invoice <-> QuickBooks monitor (services/invoiceReconciliation.js).
// Node's built-in assert against a temp DB. QuickBooks bills are written straight into
// BuildTrack's QuickBooks mirror the way the sync stores them (the monitor never calls
// Intuit); the office email goes to a tiny SMTP sink on localhost.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildtrack-invoice-monitor-'));
process.env.DB_PATH = path.join(tempDir, 'buildtrack-test.db');
process.env.JWT_SECRET = 'invoice-monitor-test-secret';
process.env.UPLOADS_PATH = path.join(tempDir, 'uploads');
process.env.INVOICE_MONITOR_SINCE = '2026-08-01';
process.env.INVOICE_MONITOR_GRACE_DAYS = '3';
process.env.INVOICE_INBOX_NOTIFY_EMAIL = 'office@example.test';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'sink';
process.env.SMTP_PASS = 'sink';
process.env.EMAIL_FROM = 'New Urban Development <info@example.test>';
delete process.env.INVOICE_INBOX_SYSTEM_USER_ID;

const { simpleParser } = require('mailparser');
const { initializeSchema, getDb } = require('../src/db/schema');
const monitor = require('../src/services/invoiceReconciliation');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const mails = [];
function startSink() {
  return new Promise(resolve => {
    const server = net.createServer(socket => {
      let buffer = '';
      let inData = false;
      let data = '';
      let authStep = 0;
      const rcpt = [];
      socket.write('220 sink ESMTP\r\n');
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (inData) {
            if (line === '.') { inData = false; mails.push({ rcpt: [...rcpt], data }); rcpt.length = 0; data = ''; socket.write('250 queued\r\n'); }
            else data += `${line}\n`;
            continue;
          }
          if (authStep === 1) { authStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); continue; }
          if (authStep === 2) { authStep = 0; socket.write('235 ok\r\n'); continue; }
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') socket.write('250-sink\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (line.toUpperCase().startsWith('AUTH PLAIN')) socket.write('235 ok\r\n');
          else if (line.toUpperCase().startsWith('AUTH LOGIN')) { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
          else if (verb === 'RCPT') { rcpt.push(line.replace(/^RCPT TO:\s*/i, '').replace(/[<>]/g, '')); socket.write('250 ok\r\n'); }
          else if (verb === 'DATA') { inData = true; socket.write('354 go\r\n'); }
          else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
          else socket.write('250 ok\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => { process.env.SMTP_PORT = String(server.address().port); resolve(server); });
  });
}

const ADMIN = 'monitor-admin';
// Bill dates relative to today, so the grace-day and date-window rules hold on any day.
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const P = { W: 'p-wisconsin', J: 'p-joel', R: 'p-robina', B: 'p-blair' };
const V = {
  oak: ['vp-oak', 'Oak Roofing LLC', '101'],
  fatmir: ['vp-fatmir', 'Fatmir Pashaj', '102'],
  bardhyl: ['vp-bardhyl', 'Bardhyl Shehu', '103'],
  snyders: ['vp-snyders', 'Snyders Services LLC', '104'],
  larmon: ['vp-larmon', 'Larmon Lighting and Electrical', '105'],
  elt: ['vp-elt', 'ELT Marble & Granite LLC', '106'],
  ben: ['vp-ben', 'Ben Vonrusten', '107'],
  sterling: ['vp-sterling', 'Sterling Painting', '108'],
  forever: ['vp-forever', 'Forever Watertite Waterproofing, LLC', '109'],
};

let invoiceSeq = 1500;
function addInvoice(db, { id, vendor, number, total, project, daysAgo = 10, invoiceDate = null }) {
  invoiceSeq += 1;
  db.prepare(`
    INSERT INTO invoices (id, invoice_number, project_id, contractor_id, status, total, source, vendor_name, vendor_profile_id,
      external_invoice_number, vendor_invoice_date, ai_filed, category, created_at, submitted_at)
    VALUES (?, ?, ?, ?, 'submitted', ?, 'email', ?, ?, ?, ?, 1, 'Roofing', datetime('now', ?), datetime('now', ?))
  `).run(id, `NUD-${invoiceSeq}`, project, ADMIN, total, V[vendor][1], V[vendor][0], number || null, invoiceDate, `-${daysAgo} days`, `-${daysAgo} days`);
  return id;
}

function addBill(db, { id, vendor, total, date, note = '', lines = null, paid = false, deleted = false, project = null }) {
  db.prepare(`
    INSERT INTO quickbooks_bills (qbo_id, realm_id, vendor_id, vendor_name, txn_date, total_amt, balance, payment_status,
      payment_approval_status, private_note, project_id, sync_token)
    VALUES (?, 'realm', ?, ?, ?, ?, ?, ?, ?, ?, ?, '0')
  `).run(id, V[vendor][2], V[vendor][1], date, total, paid ? 0 : total, paid ? 'paid' : 'unpaid',
    deleted ? 'deleted_from_buildtrack' : 'not_approved', note, project);
  (lines || [{ project, amount: total }]).forEach((line, index) => {
    db.prepare(`
      INSERT INTO quickbooks_bill_lines (id, qbo_bill_id, realm_id, qbo_line_id, line_num, description, amount, class_name, project_id)
      VALUES (?, ?, 'realm', ?, ?, ?, ?, ?, ?)
    `).run(`${id}-l${index}`, id, String(index + 1), index + 1, note, line.amount, line.project ? `class ${line.project}` : null, line.project);
  });
}

function addIntakeItem(db, { id, vendor, total, status, number = null, kind = 'invoice', sha = null, receivedDaysAgo = 10, invoiceDate = null }) {
  db.prepare(`
    INSERT INTO invoice_email_intake (id, provider, provider_message_id, message_hash, from_email, subject, status, agent_status, received_at)
    VALUES (?, 'gmail-imap', ?, ?, 'vendor@example.test', ?, ?, 'needs_review', datetime('now', ?))
  `).run(`intake-${id}`, `msg-${id}`, `hash-${id}`, `Invoice ${id}`, status === 'not_invoice' ? 'ignored' : 'new', `-${receivedDaysAgo} days`);
  const entry = {
    document_kind: kind, invoice_number: number || '', invoice_date: '', due_date: '', category: 'Countertops', invoice_type: 'labor_and_materials',
    billing_stage: 'full', summary: `${V[vendor][1]} work`, line_items: [], tax: null, amount_due: total, total, payment_terms: '',
    project_evidence: '', vendor: { email: '' }, source_attachment_id: null, source_attachment_name: null,
  };
  db.prepare(`
    INSERT INTO invoice_inbox_items (id, intake_id, item_index, status, reason, vendor_profile_id, vendor_name, invoice_number,
      category, invoice_type, total, read_json, document_kind, document_sha256, invoice_date)
    VALUES (?, ?, 0, ?, 'No job printed.', ?, ?, ?, 'Countertops', 'labor_and_materials', ?, ?, ?, ?, ?)
  `).run(id, `intake-${id}`, status, V[vendor][0], V[vendor][1], number, total, JSON.stringify(entry), kind, sha, invoiceDate);
}

const issue = (db, key) => db.prepare('SELECT * FROM invoice_monitor_issues WHERE issue_key = ?').get(key);
const recon = (db, invoiceId) => db.prepare('SELECT * FROM invoice_reconciliation WHERE invoice_id = ?').get(invoiceId);
const links = (db, invoiceId) => db.prepare('SELECT * FROM invoice_qbo_links WHERE invoice_id = ? ORDER BY qbo_bill_id').all(invoiceId);

async function main() {
  const sink = await startSink();
  initializeSchema();
  const db = getDb();
  db.prepare("INSERT INTO users (id, name, email, password_hash, role, is_active) VALUES (?, 'Monitor Admin', 'monitor@example.test', 'hash', 'super_admin', 1)").run(ADMIN);
  const addProject = db.prepare("INSERT INTO projects (id, address, job_name, status, created_by) VALUES (?, ?, ?, 'active_rehab', ?)");
  addProject.run(P.W, '2811 Wisconsin Rd, Troy, MI 48083, USA', '2811 Wisconsin', ADMIN);
  addProject.run(P.J, '34641 Joel St, New Baltimore, MI 48047, USA', '34641 Joel', ADMIN);
  addProject.run(P.R, '3170 Robina Ave, Berkley, MI 48072, USA', '3170 Robina', ADMIN);
  addProject.run(P.B, '1132 N Blair Ave, Royal Oak, MI 48067, USA', '1132 Blair', ADMIN);
  for (const [id, name, qboId] of Object.values(V)) {
    db.prepare("INSERT INTO contractor_profiles (id, vendor_name, quickbooks_vendor_id, contractor_status, source) VALUES (?, ?, ?, 'active', 'test')").run(id, name, qboId);
  }

  // Emailed invoices already in BuildTrack.
  addInvoice(db, { id: 'i-oak', vendor: 'oak', number: '1858', total: 14256, project: P.W, daysAgo: 12 });
  addInvoice(db, { id: 'i-fatmir', vendor: 'fatmir', total: 9060, project: P.W, daysAgo: 8 });
  addInvoice(db, { id: 'i-bardhyl', vendor: 'bardhyl', total: 2860, project: P.W, daysAgo: 20 });
  addInvoice(db, { id: 'i-snyders', vendor: 'snyders', number: '2053', total: 1500, project: P.W, daysAgo: 16 });
  addInvoice(db, { id: 'i-larmon', vendor: 'larmon', number: 'L-77', total: 3100, project: P.R, daysAgo: 9 });
  addInvoice(db, { id: 'i-late', vendor: 'oak', number: '1900', total: 500, project: P.W, daysAgo: 5 });
  addInvoice(db, { id: 'i-new', vendor: 'oak', number: '1901', total: 700, project: P.W, daysAgo: 0 });
  addInvoice(db, { id: 'i-paid', vendor: 'snyders', number: '2060', total: 300, project: P.B, daysAgo: 6 });
  // A $0 record from the old intake: nothing to match, not counted.
  addInvoice(db, { id: 'i-zero', vendor: 'snyders', total: 0, project: P.B, daysAgo: 30 });
  // The Larmon invoice's document, as the inbox stored it.
  addIntakeItem(db, { id: 'larmon-doc', vendor: 'larmon', total: 3100, status: 'filed', sha: 'a'.repeat(64) });
  db.prepare("UPDATE invoice_inbox_items SET invoice_id = 'i-larmon' WHERE id = 'larmon-doc'").run();

  // What the office entered in QuickBooks.
  addBill(db, { id: 'Q1', vendor: 'oak', total: 14256, date: day(12), note: '2811 Wisconsin Roof Invoice', project: P.W });
  addBill(db, { id: 'Q2', vendor: 'fatmir', total: 4530, date: day(8), note: '2811 Wisconsin First Half of Invoice', project: P.W, paid: true });
  addBill(db, { id: 'Q3', vendor: 'fatmir', total: 4530, date: day(8), note: '2811 Wisconsin Second Half of Invoice', project: P.W });
  addBill(db, { id: 'Q4', vendor: 'bardhyl', total: 1430, date: day(20), note: '2811 Wisconsin First Half of Flooring Invoice', project: P.W });
  addBill(db, { id: 'Q5', vendor: 'snyders', total: 1500, date: day(17), note: '1132 N Blair Junk Removal Invoice', project: P.B });
  addBill(db, { id: 'Q6', vendor: 'larmon', total: 3000, date: day(9), note: '3170 Robina Electrical', project: P.R });
  db.prepare("INSERT INTO quickbooks_bill_attachments (id, qbo_bill_id, filename, original_name, mime_type, uploaded_by) VALUES ('att-q6', 'Q6', 'q6.pdf', 'q6.pdf', 'application/pdf', ?)").run(ADMIN);
  db.prepare("INSERT INTO cost_analyzer_documents (attachment_id, qbo_bill_id, status, content_hash) VALUES ('att-q6', 'Q6', 'extracted', ?)").run('a'.repeat(64));
  addBill(db, { id: 'Q7', vendor: 'snyders', total: 300, date: day(6), note: '1132 N Blair cleanup', project: P.B, paid: true });
  // Emailed invoices the AI could not place - QuickBooks has the office's answer.
  addIntakeItem(db, { id: 'elt', vendor: 'elt', total: 5350, status: 'needs_project', number: '1021' });
  addBill(db, { id: 'Q8', vendor: 'elt', total: 2675, date: day(10), note: '34641 Joel Quartz First Half of Invoice', project: P.J });
  addBill(db, { id: 'Q9', vendor: 'elt', total: 2675, date: day(10), note: '34641 Joel Quartz Second Half of Invoice', project: P.J });
  addIntakeItem(db, { id: 'ben', vendor: 'ben', total: 665, status: 'needs_project', number: 'INV-2026-09-001' });
  addBill(db, { id: 'Q10', vendor: 'ben', total: 665, date: day(11), note: 'Lawn care September', lines: [{ project: P.W, amount: 400 }, { project: P.J, amount: 265 }] });
  // An estimate the office entered as a bill.
  addIntakeItem(db, { id: 'sterling', vendor: 'sterling', total: 6000, status: 'not_invoice', kind: 'estimate_or_quote' });
  addBill(db, { id: 'Q11', vendor: 'sterling', total: 6000, date: day(10), note: '2811 Wisconsin Painting Invoice', project: P.W });
  // A recurring $250 vendor: today's invoice must not grab an older, paid $250 bill.
  addIntakeItem(db, { id: 'snyders-today', vendor: 'snyders', total: 250, status: 'needs_project', number: '2059', receivedDaysAgo: 0, invoiceDate: day(0) });
  addBill(db, { id: 'Q15', vendor: 'snyders', total: 250, date: day(40), note: '3170 Robina Junk Removal Invoice', project: P.R, paid: true });
  // ...and today the office entered two $250 Snyders bills: the monitor cannot choose,
  // the review queue offers both projects.
  addBill(db, { id: 'Q18', vendor: 'snyders', total: 250, date: day(0), note: '2811 Wisconsin junk removal', project: P.W });
  addBill(db, { id: 'Q19', vendor: 'snyders', total: 250, date: day(0), note: '34641 Joel junk removal', project: P.J });
  // The Snyders invoice filed to Wisconsin carries its document (QuickBooks has it under Blair).
  const docDir = path.join(process.env.UPLOADS_PATH, 'invoice-attachments', P.W, 'i-snyders');
  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, 'doc-snyders.pdf'), 'snyders invoice');
  db.prepare("INSERT INTO invoice_attachments (id, invoice_id, project_id, filename, original_name, mime_type, size, uploaded_by) VALUES ('att-snyders', 'i-snyders', ?, 'doc-snyders.pdf', 'Invoice_2053.pdf', 'application/pdf', 15, ?)").run(P.W, ADMIN);
  // The Larmon invoice as one line; QuickBooks has it for less.
  db.prepare("INSERT INTO invoice_line_items (id, invoice_id, description, amount, sort_order) VALUES ('li-larmon', 'i-larmon', 'Electrical', 3100, 0)").run();
  // QuickBooks has this one under another class, but it is tied to a scope task: not moved.
  addInvoice(db, { id: 'i-tasks', vendor: 'forever', number: 'F-12', total: 900, project: P.W, daysAgo: 5 });
  addBill(db, { id: 'Q20', vendor: 'forever', total: 900, date: day(5), note: '34641 Joel gutters', project: P.J });
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO invoice_work_items (id, invoice_id, project_id, construction_plan_item_id, linked_by) VALUES ('iwi-1', 'i-tasks', ?, 'task-1', ?)").run(P.W, ADMIN);
  db.pragma('foreign_keys = ON');
  // Two equally plausible bills for the same amount: nothing is linked.
  addInvoice(db, { id: 'i-amb', vendor: 'larmon', number: 'L-90', total: 600, project: P.R, daysAgo: 4 });
  addBill(db, { id: 'Q16', vendor: 'larmon', total: 600, date: day(4), note: '3170 Robina outlets', project: P.R });
  addBill(db, { id: 'Q17', vendor: 'larmon', total: 600, date: day(3), note: '3170 Robina lights', project: P.R });
  // The emailed PDF attached to a bill entered under a differently named vendor.
  addInvoice(db, { id: 'i-docx', vendor: 'oak', number: '1950', total: 777, project: P.W, daysAgo: 3 });
  addIntakeItem(db, { id: 'docx-doc', vendor: 'oak', total: 777, status: 'filed', sha: 'b'.repeat(64), receivedDaysAgo: 3 });
  db.prepare("UPDATE invoice_inbox_items SET invoice_id = 'i-docx' WHERE id = 'docx-doc'").run();
  addBill(db, { id: 'Q30', vendor: 'sterling', total: 777, date: day(2), note: 'Wisconsin roof repair', project: P.W });
  db.prepare("INSERT INTO quickbooks_bill_attachments (id, qbo_bill_id, filename, original_name, mime_type, uploaded_by) VALUES ('att-q30', 'Q30', 'q30.pdf', 'q30.pdf', 'application/pdf', ?)").run(ADMIN);
  db.prepare("INSERT INTO cost_analyzer_documents (attachment_id, qbo_bill_id, status, content_hash) VALUES ('att-q30', 'Q30', 'extracted', ?)").run('b'.repeat(64));
  // The same "second half" entered twice.
  addBill(db, { id: 'Q12', vendor: 'forever', total: 3800, date: day(19), note: '3170 Robina Second Half of Waterproofing Invoice', project: P.R });
  addBill(db, { id: 'Q13', vendor: 'forever', total: 3800, date: day(16), note: '3170 Robina Second Half of Waterproofing Invoice', project: P.R });

  console.log('invoiceReconciliation');

  await check('choosing bills: halves by wording, parts that add up, whole invoice numbers only', () => {
    const bill = (id, total, note, extra = {}) => ({ id, total, note, noteKey: note.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), half: monitor.halfOf(note), docs: [], shares: new Map(), date: '2026-10-10', ...extra });
    const halves = monitor.chooseBills([bill('a', 500, 'misc'), bill('b', 450, 'Job First Half of Invoice'), bill('c', 450, 'Job Second Half of Invoice')], { total: 900, docHashes: new Set(), refDate: '2026-10-10' });
    assert.deepStrictEqual(halves.bills.map(b => b.id).sort(), ['b', 'c']);
    const parts = monitor.chooseBills([bill('d', 300, 'deposit'), bill('e', 450, 'progress draw'), bill('f', 250, 'final')], { total: 1000, docHashes: new Set(), refDate: '2026-10-10' });
    assert.deepStrictEqual(parts.bills.map(b => b.id).sort(), ['d', 'e', 'f']);
    const byNumber = monitor.chooseBills([bill('g', 10, 'Vendor invoice 1004 roof'), bill('h', 20, 'Vendor invoice 100 gutters')], { total: 999, docHashes: new Set(), invoiceNumber: '100', refDate: '2026-10-10' });
    assert.deepStrictEqual(byNumber.bills.map(b => b.id), ['h']);
  });

  const first = await monitor.runOnce();
  assert.ok(!first.error, first.error);

  await check('first run: a started event, bills recorded without a flood of "new bill" events', () => {
    assert.ok(db.prepare("SELECT 1 FROM invoice_monitor_events WHERE kind = 'started'").get());
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoice_monitor_events WHERE kind = 'bill_entered'").get().n, 0);
  });

  await check('a whole bill for the whole invoice: matched, and QuickBooks shows the BuildTrack invoice', () => {
    assert.strictEqual(recon(db, 'i-oak').status, 'matched');
    assert.deepStrictEqual(links(db, 'i-oak').map(l => [l.qbo_bill_id, l.part]), [['Q1', 'full']]);
    assert.strictEqual(db.prepare("SELECT matched_invoice_id FROM quickbooks_bills WHERE qbo_id = 'Q1'").get().matched_invoice_id, 'i-oak');
  });

  await check('an invoice entered in two halves: both bills linked as 1st / 2nd half, paid amount mirrored', () => {
    const r = recon(db, 'i-fatmir');
    assert.strictEqual(r.status, 'matched_split');
    assert.deepStrictEqual(links(db, 'i-fatmir').map(l => [l.qbo_bill_id, l.part, l.amount]), [['Q2', 'first_half', 4530], ['Q3', 'second_half', 4530]]);
    assert.strictEqual(r.paid_amount, 4530);
    assert.strictEqual(db.prepare("SELECT status FROM invoices WHERE id = 'i-fatmir'").get().status, 'submitted');
  });

  await check('only the first half entered: partly in QuickBooks, flagged after the grace days', () => {
    assert.strictEqual(recon(db, 'i-bardhyl').status, 'partially_entered');
    const open = issue(db, 'partial:i-bardhyl');
    assert.ok(open && open.status === 'open' && open.severity === 'warning');
    assert.match(open.message, /\$1,430\.00 is not entered yet/);
  });

  const docAt = project => path.join(process.env.UPLOADS_PATH, 'invoice-attachments', project, 'i-snyders', 'doc-snyders.pdf');

  await check('QuickBooks has it under another class: the invoice moves there with its document', () => {
    assert.strictEqual(recon(db, 'i-snyders').status, 'matched');
    const inv = db.prepare("SELECT project_id, notes FROM invoices WHERE id = 'i-snyders'").get();
    assert.strictEqual(inv.project_id, P.B);
    assert.match(inv.notes, /to match QuickBooks \(class class p-blair\)/);
    assert.ok(!issue(db, 'project:i-snyders'));
    assert.strictEqual(db.prepare("SELECT project_id FROM invoice_attachments WHERE id = 'att-snyders'").get().project_id, P.B);
    assert.ok(fs.existsSync(docAt(P.B)), 'document copied to the new project');
    assert.ok(!fs.existsSync(path.dirname(docAt(P.W))), 'old project folder removed after commit');
    assert.ok(db.prepare("SELECT 1 FROM invoice_monitor_events WHERE kind = 'moved_to_quickbooks_project' AND invoice_id = 'i-snyders'").get());
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'invoice_moved_to_match_quickbooks' AND entity_id = 'i-snyders' AND project_id = ?").get(P.B));
  });

  await check('tied to a scope task of its project: not moved, flagged for a person', () => {
    assert.strictEqual(db.prepare("SELECT project_id FROM invoices WHERE id = 'i-tasks'").get().project_id, P.W);
    const open = issue(db, 'project:i-tasks');
    assert.ok(open && open.severity === 'alert');
    assert.match(open.message, /scope tasks .* move it by hand/);
  });

  await check('QuickBooks has another amount for the whole invoice: BuildTrack takes the QuickBooks amount', () => {
    assert.deepStrictEqual(links(db, 'i-larmon').map(l => [l.qbo_bill_id, l.method]), [['Q6', 'document']]);
    const inv = db.prepare("SELECT total, notes FROM invoices WHERE id = 'i-larmon'").get();
    assert.strictEqual(inv.total, 3000);
    assert.match(inv.notes, /Amount changed from \$3,100\.00 to \$3,000\.00 to match QuickBooks \(bill Q6\)/);
    assert.strictEqual(db.prepare("SELECT amount FROM invoice_line_items WHERE id = 'li-larmon'").get().amount, 3000);
    assert.strictEqual(recon(db, 'i-larmon').status, 'matched');
    assert.ok(!issue(db, 'amount:i-larmon'));
  });

  await check('the emailed document attached to a bill links it, whatever the vendor is called there', () => {
    assert.deepStrictEqual(links(db, 'i-docx').map(l => [l.qbo_bill_id, l.method]), [['Q30', 'document']]);
    assert.strictEqual(recon(db, 'i-docx').status, 'matched');
  });

  await check('not entered after the grace days: flagged; a brand-new one just waits', () => {
    assert.strictEqual(recon(db, 'i-late').status, 'not_in_quickbooks');
    assert.ok(issue(db, 'not_in_qb:i-late'));
    assert.strictEqual(recon(db, 'i-new').status, 'waiting_for_quickbooks');
    assert.ok(!issue(db, 'not_in_qb:i-new'));
  });

  await check('a $0 record is not reconciled or counted', () => {
    assert.strictEqual(recon(db, 'i-zero'), undefined);
    assert.ok(!issue(db, 'not_in_qb:i-zero'));
  });

  await check('paid in full in QuickBooks: the BuildTrack invoice shows paid', () => {
    assert.strictEqual(recon(db, 'i-paid').status, 'matched');
    assert.strictEqual(db.prepare("SELECT status FROM invoices WHERE id = 'i-paid'").get().status, 'paid');
  });

  await check('no job on the invoice: filed under the project the office chose in QuickBooks, halves linked', () => {
    const item = db.prepare("SELECT * FROM invoice_inbox_items WHERE id = 'elt'").get();
    assert.strictEqual(item.status, 'filed');
    assert.strictEqual(item.project_id, P.J);
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(item.invoice_id);
    assert.strictEqual(inv.total, 5350);
    assert.strictEqual(inv.vendor_name, 'ELT Marble & Granite LLC');
    assert.match(inv.notes, /Project taken from QuickBooks/);
    assert.deepStrictEqual(links(db, inv.id).map(l => [l.qbo_bill_id, l.part]), [['Q8', 'first_half'], ['Q9', 'second_half']]);
    assert.strictEqual(recon(db, inv.id).status, 'matched_split');
    assert.strictEqual(db.prepare("SELECT status FROM invoice_email_intake WHERE id = 'intake-elt'").get().status, 'filed');
    assert.ok(db.prepare("SELECT 1 FROM invoice_monitor_events WHERE kind = 'filed_from_quickbooks' AND intake_id = 'intake-elt'").get());
  });

  await check('one bill split across projects: one BuildTrack invoice per project share', () => {
    const rows = db.prepare("SELECT i.project_id, i.total FROM invoice_qbo_links l JOIN invoices i ON i.id = l.invoice_id WHERE l.qbo_bill_id = 'Q10' ORDER BY i.total DESC").all();
    assert.deepStrictEqual(rows, [{ project_id: P.W, total: 400 }, { project_id: P.J, total: 265 }]);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM invoice_qbo_links WHERE qbo_bill_id = 'Q10' AND part = 'project_share'").get().n === 2);
    assert.strictEqual(db.prepare("SELECT status FROM invoice_inbox_items WHERE id = 'ben'").get().status, 'filed');
  });

  await check('never a guess: an older bill dated before the invoice is not taken; two equal candidates link nothing', () => {
    const item = db.prepare("SELECT * FROM invoice_inbox_items WHERE id = 'snyders-today'").get();
    assert.strictEqual(item.status, 'needs_project');
    assert.strictEqual(item.invoice_id, null);
    assert.ok(!db.prepare("SELECT 1 FROM invoice_qbo_links WHERE qbo_bill_id = 'Q15'").get());
    assert.strictEqual(links(db, 'i-amb').length, 0);
    assert.ok(!db.prepare("SELECT 1 FROM invoice_qbo_links WHERE qbo_bill_id IN ('Q16','Q17')").get());
  });

  await check('a bill for a document the AI read as an estimate is flagged', () => {
    const open = issue(db, 'estimate_billed:Q11');
    assert.ok(open && open.severity === 'alert');
    assert.match(open.message, /ESTIMATE/);
  });

  await check('the same "second half" entered twice is flagged as a possible double entry', () => {
    const open = issue(db, 'double:Q12:Q13');
    assert.ok(open && open.severity === 'alert');
  });

  await check('the office gets one email listing what needs attention', async () => {
    assert.strictEqual(mails.length, 1);
    const parsed = await simpleParser(mails[0].data);
    assert.deepStrictEqual(mails[0].rcpt, ['office@example.test']);
    assert.match(parsed.subject, /^Invoice monitor: \d+ items need attention \(\d+ alerts\)$/);
    assert.match(parsed.html, /Possible double entry in QuickBooks/);
    assert.match(parsed.html, /Estimate entered as a bill/);
  });

  await check('project invoice list: covered invoices hide, a partly entered one shows only the rest', () => {
    const coverage = monitor.quickBooksCoverage(db, ['i-oak', 'i-bardhyl', 'i-new']);
    assert.strictEqual(coverage.get('i-oak').covered, 14256);
    assert.strictEqual(coverage.get('i-bardhyl').covered, 1430);
    assert.ok(!coverage.has('i-new'));
    const byBill = monitor.emailInvoicesForBills(db, ['Q2', 'Q3', 'Q11']);
    assert.strictEqual(byBill.get('Q2').part, 'first_half');
    assert.strictEqual(byBill.get('Q3').invoice_id, 'i-fatmir');
    assert.ok(!byBill.has('Q11'));
  });

  await check('the QuickBooks sync keeps the monitor\'s link for a half', () => {
    const findInvoiceForBill = require('../src/routes/quickbooks').findInvoiceForBill;
    const found = findInvoiceForBill(db, { Id: 'Q3', TotalAmt: 4530, VendorRef: { value: '102', name: 'Fatmir Pashaj' } });
    assert.strictEqual(found && found.id, 'i-fatmir');
  });

  await check('review queue: QuickBooks bills entered for the invoice first, then the vendor\'s recent classes', () => {
    const item = db.prepare("SELECT a.*, e.received_at FROM invoice_inbox_items a JOIN invoice_email_intake e ON e.id = a.intake_id WHERE a.id = 'snyders-today'").get();
    const list = monitor.projectSuggestions(db, [item]).get('snyders-today');
    assert.deepStrictEqual(list.slice(0, 2).map(s => s.source), ['quickbooks_bill', 'quickbooks_bill']);
    assert.deepStrictEqual(list.slice(0, 2).map(s => s.project_id).sort(), [P.J, P.W].sort());
    assert.ok(list.some(s => s.project_id === P.B && s.source === 'vendor_history'));
    assert.ok(!list.some(s => s.qbo_bill_id === 'Q15'), 'an old paid bill is not offered as this invoice');
  });

  const agent = require('../src/services/invoiceInboxAgent');

  await check('one click: a person files it under the chosen project, as the AI would', () => {
    const result = agent.assignItem(db, { intakeId: 'intake-snyders-today', itemId: 'snyders-today', projectId: P.W, actorId: ADMIN, actorName: 'Monitor Admin' });
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(result.invoiceId);
    assert.strictEqual(inv.project_id, P.W);
    assert.strictEqual(inv.total, 250);
    assert.strictEqual(inv.ai_filed, 0);
    assert.strictEqual(inv.vendor_profile_id, 'vp-snyders');
    assert.strictEqual(inv.external_invoice_number, '2059');
    assert.strictEqual(inv.source, 'email');
    assert.match(inv.notes, /Project chosen by Monitor Admin/);
    const item = db.prepare("SELECT status, invoice_id FROM invoice_inbox_items WHERE id = 'snyders-today'").get();
    assert.deepStrictEqual([item.status, item.invoice_id], ['filed_by_office', result.invoiceId]);
    assert.strictEqual(db.prepare("SELECT status FROM invoice_email_intake WHERE id = 'intake-snyders-today'").get().status, 'filed');
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'invoice_email_filed' AND entity_id = ?").get(result.invoiceId));
    assert.throws(() => agent.assignItem(db, { intakeId: 'intake-snyders-today', itemId: 'snyders-today', projectId: P.J, actorId: ADMIN }), /already filed/);
  });

  await check('the QuickBooks sync never matches an old $250 bill to today\'s $250 invoice', () => {
    const findInvoiceForBill = require('../src/routes/quickbooks').findInvoiceForBill;
    const invoiceId = db.prepare("SELECT invoice_id FROM invoice_inbox_items WHERE id = 'snyders-today'").get().invoice_id;
    const vendor = { value: '104', name: 'Snyders Services LLC' };
    const ago = n => new Date(Date.now() - n * 86400000).toISOString();
    assert.strictEqual(findInvoiceForBill(db, { Id: 'Q90', TotalAmt: 250, TxnDate: day(64), VendorRef: vendor, MetaData: { CreateTime: ago(46) } }), null);
    const today = findInvoiceForBill(db, { Id: 'Q91', TotalAmt: 250, TxnDate: day(0), VendorRef: vendor, MetaData: { CreateTime: ago(0) } });
    assert.strictEqual(today && today.id, invoiceId);
  });

  await check('one click when the AI could not read it: vendor and amount typed in, vendor added', () => {
    db.prepare(`
      INSERT INTO invoice_email_intake (id, provider, provider_message_id, message_hash, from_email, subject, status, agent_status, received_at)
      VALUES ('intake-unread', 'gmail-imap', 'msg-unread', 'hash-unread', 'billing@example.test', 'Invoice attached', 'new', 'needs_review', datetime('now'))
    `).run();
    db.prepare("INSERT INTO invoice_inbox_items (id, intake_id, item_index, status, reason) VALUES ('unread', 'intake-unread', 0, 'needs_review', 'The AI could not read this email.')").run();
    const base = { intakeId: 'intake-unread', itemId: 'unread', projectId: P.R, actorId: ADMIN, actorName: 'Monitor Admin' };
    assert.throws(() => agent.assignItem(db, { ...base, vendorName: 'Brand New Plumbing LLC' }), /Enter the invoice amount/);
    assert.throws(() => agent.assignItem(db, { ...base, total: '120' }), /Enter the vendor/);
    const result = agent.assignItem(db, { ...base, vendorName: 'Brand New Plumbing LLC', total: '$1,234.50', invoiceNumber: 'BN-9' });
    assert.ok(result.vendor.created);
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(result.invoiceId);
    assert.deepStrictEqual([inv.total, inv.project_id, inv.external_invoice_number, inv.ai_filed], [1234.5, P.R, 'BN-9', 0]);
    assert.match(inv.vendor_name, /^Brand New Plumbing/);
    assert.strictEqual(inv.vendor_profile_id, result.vendor.id);
    assert.ok(db.prepare("SELECT 1 FROM contractor_profiles WHERE id = ? AND source = 'invoice_email'").get(result.vendor.id));
  });

  // QuickBooks changes: the second half is paid, the Oak bill is deleted, a new bill comes in,
  // and the office edits the Snyders bill (new amount, other class).
  db.prepare("UPDATE quickbooks_bills SET balance = 0, payment_status = 'paid', sync_token = '1' WHERE qbo_id = 'Q3'").run();
  db.prepare("UPDATE quickbooks_bills SET payment_approval_status = 'deleted_from_buildtrack' WHERE qbo_id = 'Q1'").run();
  addBill(db, { id: 'Q14', vendor: 'bardhyl', total: 1430, date: day(18), note: '2811 Wisconsin Second Half of Flooring Invoice', project: P.W });
  db.prepare("UPDATE quickbooks_bills SET total_amt = 1450, balance = 1450, project_id = ?, sync_token = '1' WHERE qbo_id = 'Q5'").run(P.R);
  db.prepare("UPDATE quickbooks_bill_lines SET amount = 1450, project_id = ?, class_name = 'class p-robina' WHERE qbo_bill_id = 'Q5'").run(P.R);
  const second = await monitor.runOnce();
  assert.ok(!second.error, second.error);

  await check('a bill edited in QuickBooks: the invoice takes its new amount and class', () => {
    const inv = db.prepare("SELECT project_id, total FROM invoices WHERE id = 'i-snyders'").get();
    assert.deepStrictEqual([inv.project_id, inv.total], [P.R, 1450]);
    assert.strictEqual(links(db, 'i-snyders')[0].amount, 1450);
    assert.strictEqual(recon(db, 'i-snyders').status, 'matched');
    assert.ok(fs.existsSync(docAt(P.R)));
    assert.ok(!fs.existsSync(path.dirname(docAt(P.B))));
    assert.ok(db.prepare("SELECT 1 FROM invoice_monitor_events WHERE kind = 'link_amount_updated' AND qbo_bill_id = 'Q5'").get());
  });

  await check('the invoice filed by a person links to the bill entered under its project', () => {
    const invoiceId = db.prepare("SELECT invoice_id FROM invoice_inbox_items WHERE id = 'snyders-today'").get().invoice_id;
    assert.deepStrictEqual(links(db, invoiceId).map(l => l.qbo_bill_id), ['Q18']);
    assert.strictEqual(recon(db, invoiceId).status, 'matched');
  });

  await check('next week\'s $250 bill does not take (or pay) the invoice another bill stands for', () => {
    const findInvoiceForBill = require('../src/routes/quickbooks').findInvoiceForBill;
    const vendor = { value: '104', name: 'Snyders Services LLC' };
    const bill = { Id: 'Q92', TotalAmt: 250, TxnDate: day(0), VendorRef: vendor, MetaData: { CreateTime: new Date().toISOString() } };
    assert.strictEqual(findInvoiceForBill(db, bill), null);
    const invoiceId = db.prepare("SELECT invoice_id FROM invoice_inbox_items WHERE id = 'snyders-today'").get().invoice_id;
    assert.strictEqual(findInvoiceForBill(db, { ...bill, Id: 'Q18' }).id, invoiceId, 'its own bill still finds it');
  });

  await check('QuickBooks changes show in the feed: paid, gone, new', () => {
    const kinds = new Set(db.prepare('SELECT kind FROM invoice_monitor_events').all().map(row => row.kind));
    for (const kind of ['bill_paid', 'bill_deleted', 'bill_entered', 'linked', 'issue_resolved']) assert.ok(kinds.has(kind), `no ${kind} event`);
  });

  await check('both halves paid: the BuildTrack invoice shows paid', () => {
    assert.strictEqual(recon(db, 'i-fatmir').paid_amount, 9060);
    assert.strictEqual(db.prepare("SELECT status FROM invoices WHERE id = 'i-fatmir'").get().status, 'paid');
  });

  await check('the second half arrives: linked, the warning resolves', () => {
    assert.strictEqual(recon(db, 'i-bardhyl').status, 'matched_split');
    assert.strictEqual(issue(db, 'partial:i-bardhyl').status, 'resolved');
  });

  await check('a linked bill deleted in QuickBooks is flagged', () => {
    const open = issue(db, 'deleted:i-oak:Q1');
    assert.ok(open && open.status === 'open' && open.severity === 'alert');
    assert.notStrictEqual(recon(db, 'i-oak').status, 'matched');
  });

  await check('nothing is emailed twice; new alerts wait for the next batch window', () => {
    assert.strictEqual(mails.length, 1);
  });

  sink.close();
  console.log(`invoiceReconciliation: ${passed} checks passed`);
}

main().then(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
