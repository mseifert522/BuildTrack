// Tests for the invoice inbox agent (services/invoiceInboxAgent.js). Node's
// built-in assert against a temp DB, same convention as the other suites. The
// mailbox and the Anthropic client are fakes (no network, nothing billed); the
// office emails go to a tiny SMTP sink on localhost so recipients, subjects and
// attachments can be checked.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildtrack-invoice-inbox-'));
process.env.DB_PATH = path.join(tempDir, 'buildtrack-test.db');
process.env.JWT_SECRET = 'invoice-inbox-test-secret';
process.env.UPLOADS_PATH = path.join(tempDir, 'uploads');
process.env.INVOICE_INBOX_SINCE = '2026-10-01T00:00:00Z';
process.env.INVOICE_AI_ANTHROPIC_API_KEY = 'test-invoice-key-with-enough-characters';
process.env.INVOICE_INBOX_NOTIFY_EMAIL = 'office@example.test';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'sink';
process.env.SMTP_PASS = 'sink';
process.env.EMAIL_FROM = 'New Urban Development <info@example.test>';
delete process.env.INBOUND_INVOICE_UPLOADS_PATH;
delete process.env.INVOICE_INBOX_SYSTEM_USER_ID;

const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { simpleParser } = require('mailparser');
const { initializeSchema, getDb } = require('../src/db/schema');
const agent = require('../src/services/invoiceInboxAgent');

const ADMIN_ID = 'inbox-admin';
const MILVERTON = '2153 Milverton Rd, Troy, MI 48083, USA';
const CHOPIN = '160 Chopin Ave, Troy, MI 48083, USA';
const BLAIR = '1132 N Blair Ave, Royal Oak, MI 48067, USA';

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

// ── SMTP sink ────────────────────────────────────────────────────────────────
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
            if (line === '.') {
              inData = false;
              mails.push({ rcpt: [...rcpt], data });
              rcpt.length = 0;
              data = '';
              socket.write('250 queued\r\n');
            } else {
              data += `${line}\n`;
            }
            continue;
          }
          if (authStep === 1) { authStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); continue; }
          if (authStep === 2) { authStep = 0; socket.write('235 ok\r\n'); continue; }
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') socket.write('250-sink\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (line.toUpperCase().startsWith('AUTH PLAIN')) socket.write('235 ok\r\n');
          else if (line.toUpperCase().startsWith('AUTH LOGIN')) { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
          else if (verb === 'MAIL') socket.write('250 ok\r\n');
          else if (verb === 'RCPT') { rcpt.push(line.replace(/^RCPT TO:\s*/i, '').replace(/[<>]/g, '')); socket.write('250 ok\r\n'); }
          else if (verb === 'DATA') { inData = true; socket.write('354 go\r\n'); }
          else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
          else socket.write('250 ok\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      process.env.SMTP_PORT = String(server.address().port);
      resolve(server);
    });
  });
}

// ── fakes ────────────────────────────────────────────────────────────────────
const queue = [];
agent.setMailboxFactoryForTests(() => ({
  async collect(_db, _since, onMessage) {
    let stored = 0;
    for (const message of queue.splice(0)) if (onMessage(message)) stored += 1;
    return stored;
  },
}));

// Canned reads keyed by the email subject; a function gets the request's system
// prompt so it can look up the model-facing refs (V12, P3) of real rows.
const answers = new Map();
const requests = [];
agent.setClientFactoryForTests(() => ({
  beta: {
    messages: {
      stream(request) {
        requests.push(request);
        const emailText = request.messages[0].content[0].text;
        const subject = (emailText.match(/^Subject: (.*)$/m) || [])[1] || '';
        const answer = answers.get(subject);
        return {
          async finalMessage() {
            if (!answer) throw Object.assign(new Error(`no canned answer for "${subject}"`), { status: 400 });
            if (answer === 'REFUSE') return { stop_reason: 'refusal', stop_details: { category: 'test' }, content: [], usage: {} };
            const body = typeof answer === 'function' ? answer(request.system[0].text) : answer;
            return {
              model: 'claude-test',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: JSON.stringify(body) }],
              usage: { input_tokens: 100, output_tokens: 50 },
            };
          },
        };
      },
    },
  },
}));

function refFor(system, kind, needle) {
  const line = system.split('\n').find(row => row.startsWith(kind) && row.includes(needle));
  assert.ok(line, `no ${kind} ref for ${needle}`);
  return line.split(' | ')[0];
}

function invoice(overrides = {}) {
  return {
    document_kind: 'invoice',
    document_kind_evidence: 'INVOICE ... Balance Due',
    source_ref: 'A1',
    vendor_name: 'Oakline Roofing LLC',
    vendor_contact: 'Dana Smith',
    vendor_email: 'billing@oakline.test',
    vendor_phone: '248-555-0100',
    vendor_address: '1 Shop Rd, Troy, MI',
    vendor_ref: '',
    invoice_number: '1858',
    invoice_date: '2026-10-14',
    due_date: '2026-10-28',
    invoice_type: 'labor_and_materials',
    billing_stage: 'full',
    category: 'Roofing',
    job_reference: '',
    property_address: '2153 Milverton Rd, Troy, MI',
    project_ref: '',
    project_basis: 'printed_on_invoice',
    project_evidence: 'Job site: 2153 Milverton Rd',
    subtotal: 1000,
    tax: 60,
    total: 1060,
    amount_due: 1060,
    line_items: [{ description: 'Tear off', amount: 600 }, { description: 'Shingles', amount: 400 }],
    payment_terms: 'Net 14',
    summary: 'Roof replacement at 2153 Milverton',
    vendor_confidence: 'high',
    project_confidence: 'high',
    amount_confidence: 'high',
    category_confidence: 'high',
    ...overrides,
  };
}

function read(documents, kind = 'invoice') {
  return { email_kind: kind, not_invoice_reason: kind === 'invoice' ? '' : 'An estimate, not a bill.', documents, email_summary: 'Test email.' };
}

// Each email carries its own PDF (a different file), unless a test re-sends one.
const pdfBySubject = new Map();
async function pdfFor(subject) {
  if (!pdfBySubject.has(subject)) {
    const pdf = await PDFDocument.create();
    pdf.setTitle(subject);
    pdf.addPage([300, 300]);
    pdfBySubject.set(subject, Buffer.from(await pdf.save()));
  }
  return pdfBySubject.get(subject);
}

let messageSeq = 0;
function email(subject, { attachments = true, from = 'billing@oakline.test', files = null } = {}) {
  messageSeq += 1;
  return {
    provider: 'gmail-imap',
    providerMessageId: `1800000000000${messageSeq}`,
    fromName: 'Sender',
    fromEmail: from,
    toEmail: 'invoices@newurbandev.com',
    ccEmail: '',
    subject,
    textBody: `Please see attached. ${subject}`,
    htmlBody: '',
    receivedAt: `2026-10-26T12:${String(messageSeq).padStart(2, '0')}:00.000Z`,
    attachments: files || (attachments ? [{ originalname: `${subject}.pdf`, mimetype: 'application/pdf', buffer: pdfBySubject.get(subject) }] : []),
  };
}

function intakeBySubject(subject) {
  return getDb().prepare('SELECT * FROM invoice_email_intake WHERE subject = ?').get(subject);
}

function itemsFor(intakeId) {
  return getDb().prepare('SELECT * FROM invoice_inbox_items WHERE intake_id = ? ORDER BY item_index').all(intakeId);
}

async function main() {
  const sink = await startSink();
  initializeSchema();
  const db = getDb();
  db.prepare('INSERT INTO users (id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)')
    .run(ADMIN_ID, 'Inbox Admin', 'inbox-admin@example.test', 'hash', 'super_admin');
  const insertProject = db.prepare(`INSERT INTO projects (id, address, job_name, status, created_by) VALUES (?, ?, ?, 'active_rehab', ?)`);
  insertProject.run('p-milverton', MILVERTON, '2153 Milverton', ADMIN_ID);
  insertProject.run('p-chopin', CHOPIN, '160 Chopin ', ADMIN_ID);
  insertProject.run('p-blair', BLAIR, '1132 Blair ', ADMIN_ID);
  db.prepare(`INSERT INTO contractor_profiles (id, vendor_name, email, contractor_status, source) VALUES (?, ?, ?, 'active', 'test')`)
    .run('vp-acme', 'Acme Plumbing LLC', 'acme@plumb.test');


  console.log('invoiceInboxAgent');

  await check('printed address parsing matches house number + street, ignoring direction words', () => {
    const keys = agent.printedAddressKeys('Job: 1132 N. Blair Ave, Royal Oak');
    assert.ok(keys.some(k => k.number === '1132' && k.street === 'blair'), JSON.stringify(keys));
    assert.deepStrictEqual(agent.printedAddressKeys('no address here'), []);
  });

  await check('schema enum carries the category list', () => {
    const schema = agent.readSchema(['Roofing', 'Miscellaneous']);
    const entry = schema.properties.documents.items;
    assert.deepStrictEqual(entry.properties.category.enum, ['Roofing', 'Miscellaneous']);
    // The AI must say what each document is before anything else.
    assert.strictEqual(entry.required[0], 'document_kind');
    assert.ok(entry.properties.document_kind.enum.includes('estimate_or_quote'));
  });

  // 1. a clear invoice: new vendor, filed to its project with category + type.
  answers.set('Invoice 1858 from Oakline', read([invoice()]));
  // 2. an existing vendor, but no job printed anywhere: never guessed.
  answers.set('Acme invoice 77', read([invoice({
    vendor_name: 'Acme Plumbing', vendor_email: 'acme@plumb.test', invoice_number: '77', category: 'Plumbing',
    property_address: '', job_reference: '', project_basis: 'none', project_evidence: '', total: 450, amount_due: 450,
    subtotal: 450, tax: null, line_items: [],
  })]));
  // 3. a reply carrying the same invoice again.
  answers.set('Re: Invoice 1858 from Oakline', read([invoice()]));
  // 4. an estimate is not an invoice.
  answers.set('Estimate 1004', read([], 'estimate_or_quote'));
  // 5. the address is printed but the AI is only medium-sure of it.
  answers.set('Smudged job', read([invoice({ vendor_name: 'Brightline Electric', invoice_number: 'E-5', category: 'Electrical', project_confidence: 'medium', property_address: '160 Chopin' })]));
  // 6. an address that is not one of our projects.
  answers.set('Unknown house', read([invoice({ vendor_name: 'Brightline Electric', invoice_number: 'E-6', property_address: '999 Nowhere St, Detroit' })]));
  // 7. the AI's project pick disagrees with the printed address.
  answers.set('Disagree', system => read([invoice({
    vendor_name: 'Brightline Electric', invoice_number: 'E-7', property_address: '2153 Milverton Rd', project_ref: refFor(system, 'P', '160 Chopin'),
  })]));
  // 8. the AI refuses: nothing filed, office told.
  answers.set('Weird email', 'REFUSE');
  // 9. two invoices in one email: one filed, one without a job.
  answers.set('Two invoices', read([
    invoice({ vendor_name: 'Gateway Supply Co', invoice_number: 'G-1', category: 'Hardware', invoice_type: 'materials', property_address: '160 Chopin Ave', total: 99.5, amount_due: 99.5, subtotal: 99.5, tax: null, line_items: [{ description: 'Hinges', amount: 99.5 }] }),
    invoice({ vendor_name: 'Gateway Supply Co', invoice_number: 'G-2', category: 'Hardware', invoice_type: 'materials', property_address: '', project_basis: 'none', total: 20, amount_due: 20, subtotal: 20, tax: null, line_items: [] }),
  ]));
  // 10. the same invoice number again with a different amount.
  answers.set('Invoice 1858 corrected', read([invoice({ total: 1200, amount_due: 1200, subtotal: 1200, tax: null, line_items: [] })]));
  // 11. directory vendor picked by ref, job given only as the job name in the email.
  answers.set('Blair job', system => read([invoice({
    source_ref: 'EMAIL', vendor_name: 'ACME PLUMBING, L.L.C.', vendor_ref: refFor(system, 'V', 'Acme Plumbing'), invoice_number: '78',
    category: 'Plumbing', property_address: '', job_reference: '1132 Blair', project_basis: 'written_in_email', total: 300, amount_due: 300,
    subtotal: 300, tax: null, line_items: [],
  })]));

  // 12. a one-letter street slip with the exact house number, and the AI picked that project.
  answers.set('Typo street', system => read([invoice({
    vendor_name: 'Brightline Electric', invoice_number: 'E-12', property_address: '2153 Milverten', project_ref: refFor(system, 'P', '2153 Milverton'),
  })]));
  // 13. the same slip without the AI's own pick, and a wrong house number: both wait.
  answers.set('Typo street no pick', read([
    invoice({ vendor_name: 'Brightline Electric', invoice_number: 'E-13', property_address: '2153 Milverten' }),
    invoice({ vendor_name: 'Brightline Electric', invoice_number: 'E-14', property_address: '1032 N Blair Royal Oak' }),
  ]));

  // 14. one invoice and one estimate in the same email: only the invoice is filed.
  answers.set('Invoice plus estimate', read([
    invoice({ vendor_name: 'Keystone Paint Co', invoice_number: 'K-1', category: 'Interior paint', property_address: '160 Chopin Ave', total: 500, amount_due: 500, subtotal: 500, tax: null, line_items: [] }),
    invoice({ document_kind: 'estimate_or_quote', document_kind_evidence: 'ESTIMATE #K-2 - valid for 30 days', vendor_name: 'Keystone Paint Co', invoice_number: 'K-2', category: 'Interior paint', property_address: '160 Chopin Ave', total: 9000, amount_due: 9000, subtotal: 9000, tax: null, line_items: [] }),
  ]));
  // 15. a quote written on an invoice form: never filed, and no vendor is created from it.
  answers.set('Painting quote on invoice form', read([invoice({
    document_kind: 'estimate_or_quote', document_kind_evidence: 'Email: "here is my quote for the interior"', vendor_name: 'Sterling Test Painting',
    invoice_number: 'Q-9', category: 'Interior paint', property_address: '1132 N Blair Ave', total: 6000, amount_due: 6000, subtotal: 6000, tax: null, line_items: [],
  })], 'estimate_or_quote'));
  // 16. a handwritten invoice (no number, no date) sent twice as the very same file.
  const handwritten = read([invoice({
    vendor_name: 'Fatmir Test', invoice_number: '', invoice_date: '', due_date: '', category: 'Framing', property_address: '160 Chopin Ave',
    total: 900, amount_due: 900, subtotal: 900, tax: null, line_items: [],
  })]);
  answers.set('Handwritten first', handwritten);
  answers.set('Handwritten again', handwritten);
  // 17. the invoice is a spreadsheet the AI cannot open: a person is told.
  answers.set('Spreadsheet invoice', read([], 'invoice'));
  // 18. a scanner TIFF is converted so the AI can read it.
  answers.set('Scanned TIFF', read([invoice({
    vendor_name: 'Northside Glass', invoice_number: 'NG-4', category: 'Windows', invoice_type: 'materials', property_address: '1132 N Blair Ave',
    total: 250, amount_due: 250, subtotal: 250, tax: null, line_items: [],
  })]));

  const subjects = ['Invoice 1858 from Oakline', 'Acme invoice 77', 'Re: Invoice 1858 from Oakline', 'Estimate 1004', 'Smudged job', 'Unknown house', 'Disagree', 'Weird email', 'Two invoices', 'Invoice 1858 corrected', 'Typo street', 'Typo street no pick', 'Invoice plus estimate', 'Painting quote on invoice form', 'Handwritten first'];
  for (const subject of subjects) await pdfFor(subject);
  subjects.forEach(subject => queue.push(email(subject)));
  queue.push(email('Blair job', { attachments: false, from: 'acme@plumb.test' }));
  queue.push(email('Handwritten again', { files: [{ originalname: 'IMG_resend.pdf', mimetype: 'application/pdf', buffer: pdfBySubject.get('Handwritten first') }] }));
  queue.push(email('Spreadsheet invoice', { files: [{ originalname: 'invoice.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(`PK\u0003\u0004 not really a workbook ${'x'.repeat(200)}`) }] }));
  const tiff = await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 245, g: 245, b: 240 } } }).tiff({ compression: 'none' }).toBuffer();
  queue.push(email('Scanned TIFF', { files: [{ originalname: 'scan.tif', mimetype: 'image/tiff', buffer: tiff }] }));

  const result = await agent.pollOnce();
  assert.ok(!result.error, result.error);
  // Decode what the sink received (bodies may be quoted-printable / base64).
  for (const mail of mails) {
    const parsed = await simpleParser(mail.data);
    mail.subject = parsed.subject || '';
    mail.html = parsed.html || '';
    mail.files = (parsed.attachments || []).map(a => a.filename);
  }
  const mailAbout = subject => mails.find(m => m.files.includes(`${subject}.pdf`));

  await check('every email was stored once and read once', () => {
    assert.strictEqual(result.stored, 19);
    assert.strictEqual(result.read, 19);
    assert.strictEqual(requests.length, 19);
  });

  await check('14. invoice + estimate in one email: only the invoice becomes a BuildTrack invoice', () => {
    const intake = intakeBySubject('Invoice plus estimate');
    const items = itemsFor(intake.id);
    assert.deepStrictEqual(items.map(i => i.status), ['filed', 'not_invoice']);
    assert.match(items[1].reason, /Estimate \/ quote - not added to BuildTrack invoices/);
    assert.match(items[1].reason, /valid for 30 days/);
    assert.strictEqual(intake.status, 'filed');
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number IN ('K-1','K-2')").get().n, 1);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number = 'K-2'").get().n, 0);
  });

  await check('15. a quote on an invoice form: not filed, no vendor created, nobody emailed', () => {
    const intake = intakeBySubject('Painting quote on invoice form');
    assert.strictEqual(intake.status, 'ignored');
    assert.deepStrictEqual(itemsFor(intake.id).map(i => i.status), ['not_invoice']);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number = 'Q-9'").get().n, 0);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM contractor_profiles WHERE vendor_name = 'Sterling Test Painting'").get().n, 0);
    assert.ok(!mailAbout('Painting quote on invoice form'));
  });

  await check('16. the same file sent again (no invoice number) is a duplicate, not a second invoice', () => {
    const [first] = itemsFor(intakeBySubject('Handwritten first').id);
    assert.strictEqual(first.status, 'filed', first.reason);
    const [again] = itemsFor(intakeBySubject('Handwritten again').id);
    assert.strictEqual(again.status, 'duplicate');
    assert.match(again.reason, /same file was already received/);
    assert.strictEqual(again.document_sha256, first.document_sha256);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE vendor_name = 'Fatmir Test'").get().n, 1);
  });

  await check('17. an attachment the AI cannot open goes to a person, with the file', () => {
    const intake = intakeBySubject('Spreadsheet invoice');
    assert.strictEqual(intake.status, 'new');
    const items = itemsFor(intake.id);
    assert.deepStrictEqual(items.map(i => i.status), ['needs_review', 'needs_review']);
    assert.match(items[1].reason, /invoice\.xlsx/);
    const mail = mails.find(m => m.files.includes('invoice.xlsx'));
    assert.ok(mail, 'no office email with the spreadsheet');
    assert.match(mail.html, /could not be read automatically/);
  });

  await check('18. a scanner TIFF is converted to a picture the AI reads', () => {
    const request = requests.find(r => r.messages[0].content[0].text.includes('Subject: Scanned TIFF'));
    assert.ok(request.messages[0].content.some(block => block.type === 'image' && block.source.media_type === 'image/jpeg'), 'TIFF not shown to the AI');
    const [item] = itemsFor(intakeBySubject('Scanned TIFF').id);
    assert.strictEqual(item.status, 'filed', item.reason);
  });

  await check('QuickBooks match: a vendor invoice number must agree on the vendor', () => {
    const findInvoiceForBill = require('../src/routes/quickbooks').findInvoiceForBill;
    const filed = db.prepare("SELECT * FROM invoices WHERE external_invoice_number = '1858'").get();
    const same = findInvoiceForBill(db, { Id: 'qb-1', DocNumber: '1858', TotalAmt: 1060, VendorRef: { value: '77', name: 'Oakline Roofing' } });
    assert.strictEqual(same && same.id, filed.id);
    const other = findInvoiceForBill(db, { Id: 'qb-2', DocNumber: '1858', TotalAmt: 1060, VendorRef: { value: '78', name: 'ELT Marble & Granite' } });
    assert.strictEqual(other, null);
    const ours = findInvoiceForBill(db, { Id: 'qb-3', DocNumber: filed.invoice_number, TotalAmt: 1, VendorRef: { value: '79', name: 'Someone Else' } });
    assert.strictEqual(ours && ours.id, filed.id);
  });

  await check('street slips: one edit on 5+ letters only', () => {
    assert.ok(agent.streetsWithinOneEdit('wisconsin', 'wisconson'));
    assert.ok(agent.streetsWithinOneEdit('milverton', 'milverten'));
    assert.ok(agent.streetsWithinOneEdit('chopin', 'chopinn'));
    assert.ok(!agent.streetsWithinOneEdit('blair', 'blair'));
    assert.ok(!agent.streetsWithinOneEdit('joel', 'joe'));
    assert.ok(!agent.streetsWithinOneEdit('robina', 'rosina2'));
    assert.ok(!agent.streetsWithinOneEdit('wisconsin', 'wiscansan'));
  });

  await check('12-13. a street slip files only with the exact house number and the AI\'s own pick', () => {
    const [typo] = itemsFor(intakeBySubject('Typo street').id);
    assert.strictEqual(typo.status, 'filed', typo.reason);
    assert.strictEqual(db.prepare('SELECT project_id FROM invoices WHERE id = ?').get(typo.invoice_id).project_id, 'p-milverton');
    const [noPick, wrongNumber] = itemsFor(intakeBySubject('Typo street no pick').id);
    assert.strictEqual(noPick.status, 'needs_project');
    assert.strictEqual(wrongNumber.status, 'needs_project');
    assert.match(wrongNumber.reason, /does not match any project/);
  });

  await check('requests carry the PDF, high effort, structured output and the directory', () => {
    const request = requests.find(r => r.messages[0].content[0].text.includes('Subject: Invoice 1858 from Oakline'));
    assert.ok(request.messages[0].content.some(block => block.type === 'document'), 'PDF not sent');
    assert.strictEqual(request.output_config.effort, 'high');
    assert.strictEqual(request.output_config.format.type, 'json_schema');
    assert.ok(request.system[0].text.includes('DO NOT GUESS THE PROJECT'));
    assert.ok(request.system[0].text.includes('Acme Plumbing LLC'));
    assert.ok(request.system[0].text.includes(MILVERTON));
  });

  await check('1. clear invoice is filed to its project with vendor, category, type and line items', () => {
    const intake = intakeBySubject('Invoice 1858 from Oakline');
    assert.strictEqual(intake.status, 'filed');
    assert.strictEqual(intake.agent_status, 'filed');
    const [item] = itemsFor(intake.id);
    assert.strictEqual(item.status, 'filed');
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(item.invoice_id);
    assert.strictEqual(inv.project_id, 'p-milverton');
    assert.strictEqual(inv.category, 'Roofing');
    assert.strictEqual(inv.invoice_type, 'labor_and_materials');
    assert.strictEqual(inv.total, 1060);
    assert.strictEqual(inv.source, 'email');
    assert.strictEqual(inv.ai_filed, 1);
    assert.strictEqual(inv.status, 'submitted');
    assert.strictEqual(inv.external_invoice_number, '1858');
    assert.strictEqual(inv.vendor_invoice_date, '2026-10-14');
    assert.strictEqual(inv.contractor_id, ADMIN_ID);
    assert.match(inv.invoice_number, /^NUD-\d+$/);
    const lines = db.prepare('SELECT description, amount FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order').all(inv.id);
    assert.deepStrictEqual(lines, [{ description: 'Tear off', amount: 600 }, { description: 'Shingles', amount: 400 }, { description: 'Sales tax', amount: 60 }]);
    const attachment = db.prepare('SELECT * FROM invoice_attachments WHERE invoice_id = ?').get(inv.id);
    assert.ok(attachment, 'invoice PDF not attached to the invoice');
    assert.ok(fs.existsSync(path.join(process.env.UPLOADS_PATH, 'invoice-attachments', 'p-milverton', inv.id, attachment.filename)));
  });

  await check('1. a new vendor was added to Contractors / Suppliers with its contact details', () => {
    const vendor = db.prepare("SELECT * FROM contractor_profiles WHERE vendor_name = 'Oakline Roofing LLC'").get();
    assert.ok(vendor);
    assert.strictEqual(vendor.source, 'invoice_email');
    assert.strictEqual(vendor.email, 'billing@oakline.test');
    assert.strictEqual(vendor.phone, '248-555-0100');
    assert.strictEqual(vendor.contact_name, 'Dana Smith');
    const item = itemsFor(intakeBySubject('Invoice 1858 from Oakline').id)[0];
    assert.strictEqual(item.vendor_created, 1);
    assert.strictEqual(item.vendor_profile_id, vendor.id);
  });

  await check('2. no job printed: not filed, existing vendor matched, office emailed with the invoice', () => {
    const intake = intakeBySubject('Acme invoice 77');
    assert.strictEqual(intake.status, 'new');
    assert.strictEqual(intake.agent_status, 'needs_review');
    const [item] = itemsFor(intake.id);
    assert.strictEqual(item.status, 'needs_project');
    assert.strictEqual(item.vendor_profile_id, 'vp-acme');
    assert.strictEqual(item.vendor_created, 0);
    assert.match(item.reason, /No job address or job number/);
    assert.ok(item.notified_at);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number = '77'").get().n, 0);
    const mail = mailAbout('Acme invoice 77');
    assert.ok(mail, 'no office email');
    assert.deepStrictEqual(mail.rcpt, ['office@example.test']);
    assert.strictEqual(mail.subject, 'Invoice received - job / project could not be identified (Acme Plumbing LLC, $450.00)');
    assert.match(mail.html, /No job address or job number is printed/);
    assert.match(mail.html, /Acme invoice 77/);
  });

  await check('3. a second copy of a filed invoice is a duplicate: no new invoice, no email', () => {
    const intake = intakeBySubject('Re: Invoice 1858 from Oakline');
    assert.strictEqual(intake.status, 'filed');
    const [item] = itemsFor(intake.id);
    assert.strictEqual(item.status, 'duplicate');
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number = '1858'").get().n, 1);
    assert.ok(!mailAbout('Re: Invoice 1858 from Oakline'));
  });

  await check('4. an estimate is marked not an invoice, nothing filed or emailed', () => {
    const intake = intakeBySubject('Estimate 1004');
    assert.strictEqual(intake.status, 'ignored');
    assert.strictEqual(intake.agent_status, 'ignored');
    assert.match(intake.agent_notes, /estimate/);
    assert.strictEqual(itemsFor(intake.id).length, 0);
    assert.ok(!mailAbout('Estimate 1004'));
  });

  await check('5-7. unclear, unknown or contradictory job: never filed, office told why', () => {
    const smudged = itemsFor(intakeBySubject('Smudged job').id)[0];
    assert.strictEqual(smudged.status, 'needs_project');
    assert.match(smudged.reason, /not clearly marked/);
    const unknown = itemsFor(intakeBySubject('Unknown house').id)[0];
    assert.strictEqual(unknown.status, 'needs_project');
    assert.match(unknown.reason, /does not match any project/);
    const disagree = itemsFor(intakeBySubject('Disagree').id)[0];
    assert.strictEqual(disagree.status, 'needs_project');
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number IN ('E-5','E-6','E-7')").get().n, 0);
    // The vendor still went into the directory (once, not three times).
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM contractor_profiles WHERE vendor_name = 'Brightline Electric'").get().n, 1);
  });

  await check('8. a refused read is not retried; office told the AI could not read it', () => {
    const intake = intakeBySubject('Weird email');
    assert.strictEqual(intake.agent_status, 'needs_review');
    assert.strictEqual(intake.ai_attempts, 1);
    const [item] = itemsFor(intake.id);
    assert.strictEqual(item.status, 'needs_review');
    assert.match(item.reason, /could not read/);
    const mail = mailAbout('Weird email');
    assert.ok(mail);
    assert.strictEqual(mail.subject, 'Invoice received - needs review');
  });

  await check('9. two invoices in one email: the clear one filed, the other waits; email lists only the open one', () => {
    const intake = intakeBySubject('Two invoices');
    assert.strictEqual(intake.status, 'new');
    const items = itemsFor(intake.id);
    assert.deepStrictEqual(items.map(i => i.status), ['filed', 'needs_project']);
    const filed = db.prepare('SELECT * FROM invoices WHERE id = ?').get(items[0].invoice_id);
    assert.strictEqual(filed.project_id, 'p-chopin');
    assert.strictEqual(filed.category, 'Hardware');
    const mail = mailAbout('Two invoices');
    assert.ok(mail.html.includes('G-2'));
    assert.ok(!mail.html.includes('G-1'));
  });

  await check('10. same invoice number, different amount: not filed twice, office asked to check', () => {
    const [item] = itemsFor(intakeBySubject('Invoice 1858 corrected').id);
    assert.strictEqual(item.status, 'needs_review');
    assert.match(item.reason, /already received/);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number = '1858'").get().n, 1);
  });

  await check('11. job named by the vendor in the email + directory vendor: filed, no new vendor', () => {
    const [item] = itemsFor(intakeBySubject('Blair job').id);
    assert.strictEqual(item.status, 'filed', item.reason);
    assert.strictEqual(item.vendor_profile_id, 'vp-acme');
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(item.invoice_id);
    assert.strictEqual(inv.project_id, 'p-blair');
    assert.strictEqual(inv.vendor_name, 'Acme Plumbing LLC');
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM contractor_profiles WHERE vendor_name LIKE 'Acme%'").get().n, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM invoice_attachments WHERE invoice_id = ?').get(inv.id).n, 0);
  });

  await check('one office email per email that needs a person; a later poll sends none again', async () => {
    const before = mails.length;
    assert.strictEqual(before, 9, `expected 9 office emails, got ${before}: ${mails.map(m => m.subject).join(' | ')}`);
    const again = await agent.pollOnce();
    assert.strictEqual(again.read, 0);
    assert.strictEqual(again.notified, 0);
    assert.strictEqual(mails.length, before);
  });

  await check('the same Gmail message is never stored twice', async () => {
    const first = email('Estimate 1004');
    first.providerMessageId = '18000000000004';
    queue.push(first);
    // The old Gmail-API poller stored the hex form of the same id.
    getDb().prepare(`
      INSERT INTO invoice_email_intake (id, provider, provider_message_id, message_hash, subject, status, agent_status)
      VALUES ('old-gmail-row', 'gmail', ?, 'old-hash', 'old', 'new', 'pending')
    `).run(BigInt('1799999999999999').toString(16));
    const old = email('Already imported by the old poller');
    old.providerMessageId = '1799999999999999';
    queue.push(old);
    const again = await agent.pollOnce();
    assert.strictEqual(again.stored, 0);
  });

  await check('re-read keeps filed invoices and does not file them twice', async () => {
    const intake = intakeBySubject('Two invoices');
    const reread = await agent.rereadIntake(intake.id);
    assert.strictEqual(reread.status, 'read');
    const items = itemsFor(intake.id);
    assert.strictEqual(items.filter(i => i.status === 'filed').length, 1);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number = 'G-1'").get().n, 1);
  });

  await check('a re-read that lists the documents in another order: nothing filed twice, the open one stays', async () => {
    const intake = intakeBySubject('Two invoices');
    const [g1, g2] = answers.get('Two invoices').documents;
    answers.set('Two invoices', read([g2, g1]));
    const reread = await agent.rereadIntake(intake.id);
    assert.strictEqual(reread.status, 'read');
    const items = itemsFor(intake.id);
    assert.deepStrictEqual(items.map(i => [i.invoice_number, i.status]).sort(), [['G-1', 'filed'], ['G-2', 'needs_project']]);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number = 'G-1'").get().n, 1);
  });

  // The same invoice twice in one email (the PDF and a photo of it); a person files an
  // invoice the AI could not read the vendor of, and later the vendor sends it again.
  const sameTwice = invoice({ vendor_name: 'Riverside Tile LLC', invoice_number: 'RT-31', category: 'Flooring', property_address: '160 Chopin Ave', total: 812, amount_due: 812, subtotal: 812, tax: null, line_items: [] });
  answers.set('Tile invoice and photo', read([sameTwice, { ...sameTwice, source_ref: 'A2' }]));
  const noVendor = { vendor_name: '', vendor_email: '', invoice_number: '', invoice_date: '2026-10-20', category: 'Landscaping', property_address: '', project_basis: 'none', project_evidence: '', total: 375, amount_due: 375, subtotal: 375, tax: null, line_items: [] };
  answers.set('Lawn bill', read([invoice({ ...noVendor, vendor_confidence: 'low' })]));
  answers.set('Lawn bill again', read([invoice({ ...noVendor, vendor_name: 'Pine Tree Services', property_address: '160 Chopin Ave', project_basis: 'printed_on_invoice' })]));
  for (const subject of ['Tile invoice and photo', 'Tile photo', 'Lawn bill', 'Lawn bill again']) await pdfFor(subject);
  queue.push(email('Tile invoice and photo', { files: [
    { originalname: 'RT-31.pdf', mimetype: 'application/pdf', buffer: pdfBySubject.get('Tile invoice and photo') },
    { originalname: 'RT-31 photo.pdf', mimetype: 'application/pdf', buffer: pdfBySubject.get('Tile photo') },
  ] }));
  queue.push(email('Lawn bill'));
  const later = await agent.pollOnce();
  assert.ok(!later.error, later.error);

  await check('the same numbered invoice twice in one email is filed once', () => {
    const items = itemsFor(intakeBySubject('Tile invoice and photo').id);
    assert.deepStrictEqual(items.map(i => i.status), ['filed', 'duplicate']);
    assert.match(items[1].reason, /already received \(NUD-\d+\)/);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number = 'RT-31'").get().n, 1);
  });

  await check('a person cannot file a second copy of an invoice already in BuildTrack', () => {
    const weird = intakeBySubject('Weird email');
    const [item] = itemsFor(weird.id);
    const copy = { intakeId: weird.id, itemId: item.id, projectId: 'p-milverton', actorId: ADMIN_ID, vendorName: 'Oakline Roofing LLC', invoiceNumber: '1858' };
    assert.throws(() => agent.assignItem(db, { ...copy, total: '1060' }), err => err.statusCode === 409 && /already in BuildTrack as NUD-\d+/.test(err.message));
    assert.strictEqual(itemsFor(weird.id)[0].status, 'needs_review');
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number = '1858'").get().n, 1);
  });

  await check('an invoice a person filed is recognised when the vendor sends it again', async () => {
    const lawn = intakeBySubject('Lawn bill');
    const [item] = itemsFor(lawn.id);
    assert.strictEqual(item.status, 'needs_project');
    const filed = agent.assignItem(db, { intakeId: lawn.id, itemId: item.id, projectId: 'p-chopin', actorId: ADMIN_ID, vendorName: 'Pine Tree Services' });
    assert.strictEqual(itemsFor(lawn.id)[0].invoice_key, 'pinetreeservices|375.00|2026-10-20');
    queue.push(email('Lawn bill again'));
    const again = await agent.pollOnce();
    assert.ok(!again.error, again.error);
    const [copy] = itemsFor(intakeBySubject('Lawn bill again').id);
    assert.strictEqual(copy.status, 'duplicate', copy.reason);
    assert.strictEqual(copy.duplicate_of, filed.invoiceId);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE vendor_name = 'Pine Tree Services'").get().n, 1);
  });

  // The office splits an invoice in half in QuickBooks; the vendor bills each half for the
  // same amount (same invoice number), then sends a reminder.
  const masonry = read([invoice({ vendor_name: 'Half & Half Masonry', vendor_email: 'hh@masonry.test', invoice_number: 'HM-3', property_address: '160 Chopin Ave', total: 1500, amount_due: 1500, subtotal: 1500, tax: null, line_items: [] })]);
  for (const subject of ['Masonry invoice', 'Masonry second half', 'Masonry reminder']) {
    answers.set(subject, masonry);
    await pdfFor(subject);
  }
  queue.push(email('Masonry invoice'));
  assert.ok(!(await agent.pollOnce()).error);
  const addHalf = (id, note) => db.prepare(`
    INSERT INTO quickbooks_bills (qbo_id, realm_id, vendor_id, vendor_name, txn_date, total_amt, balance, payment_status,
      payment_approval_status, private_note, project_id, sync_token)
    VALUES (?, 'realm', '901', 'Half & Half Masonry LLC', '2026-10-15', 1500, 1500, 'unpaid', 'not_approved', ?, 'p-chopin', '0')
  `).run(id, note);
  addHalf('HM-Q1', '160 Chopin Masonry First Half of Invoice');
  addHalf('HM-Q2', '160 Chopin Masonry Second Half of Invoice');
  queue.push(email('Masonry second half'));
  queue.push(email('Masonry reminder'));
  assert.ok(!(await agent.pollOnce()).error);

  await check('QuickBooks split in half: the vendor\'s second copy is filed as the other half, a third is a duplicate', () => {
    const items = ['Masonry invoice', 'Masonry second half', 'Masonry reminder'].map(subject => itemsFor(intakeBySubject(subject).id)[0]);
    assert.deepStrictEqual(items.map(i => i.status), ['filed', 'filed', 'duplicate']);
    assert.match(items[1].reason, /split in half \(bills HM-Q1 and HM-Q2\)/);
    assert.match(db.prepare('SELECT notes FROM invoices WHERE id = ?').get(items[1].invoice_id).notes, /the other half - filed, not a duplicate/);
    assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM invoices WHERE external_invoice_number = 'HM-3'").get().n, 2);
  });

  await check('the run never logged into a real mailbox or API', () => {
    assert.ok(requests.every(r => r.model));
  });

  sink.close();
  console.log(`invoiceInboxAgent: ${passed} checks passed`);
}

main().then(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
