const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildtrack-hr-resume-'));
const storageRoot = path.join(tempDir, 'hr-private');
fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
process.env.DB_PATH = path.join(tempDir, 'buildtrack-test.db');
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key-with-enough-characters';

const { initializeSchema, getDb } = require('../src/db/schema');
const {
  normalizeResumeSegments,
  processResumeBatch,
  setAnthropicFactoryForTests,
} = require('../src/services/hrResumeIntake');

const USER_ID = 'hr-test-admin';
const BATCH_ID = 'resume-batch-five-people';
const SOURCE_ITEM_ID = 'resume-source-packet';
const SOURCE_STORED_NAME = 'source-packet.pdf';
const EXPECTED = [
  { first_name: 'Mike', last_name: 'Siterlet', start_page: 1, end_page: 1, position: 'Reconstruction Project Manager' },
  { first_name: 'George', last_name: 'Boechler', start_page: 2, end_page: 3, position: 'Project Manager' },
  { first_name: 'Jake', last_name: 'Skrumbellos', start_page: 4, end_page: 4, position: 'Construction Manager' },
  { first_name: 'Kayelyn', last_name: 'Owens', start_page: 5, end_page: 6, position: 'Project Coordinator' },
  { first_name: 'Jon', last_name: 'Smodey', start_page: 7, end_page: 10, position: 'Project Manager' },
];

async function createSourcePacket() {
  const pdf = await PDFDocument.create();
  for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Scanned resume packet page ${pageNumber}`, { x: 48, y: 744, size: 14 });
  }
  const bytes = await pdf.save();
  fs.writeFileSync(path.join(storageRoot, SOURCE_STORED_NAME), bytes, { mode: 0o600 });
  return bytes.length;
}

function mockAnthropic() {
  let detailedCall = 0;
  setAnthropicFactoryForTests(() => ({
    messages: {
      create: async request => {
        const isPacketSegmentation = Boolean(
          request.output_config?.format?.schema?.properties?.resumes,
        );
        if (isPacketSegmentation) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                resumes: EXPECTED.map(candidate => ({
                  first_name: candidate.first_name,
                  last_name: candidate.last_name,
                  start_page: candidate.start_page,
                  end_page: candidate.end_page,
                  confidence: 0.99,
                  needs_review: false,
                  review_notes: '',
                })),
              }),
            }],
            usage: { input_tokens: 100, output_tokens: 25 },
          };
        }

        const candidate = EXPECTED[detailedCall];
        detailedCall += 1;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              first_name: candidate.first_name,
              last_name: candidate.last_name,
              email: `${candidate.first_name}.${candidate.last_name}@example.test`.toLowerCase(),
              phone: `555000000${detailedCall}`,
              position: candidate.position,
              location: 'Michigan',
              summary: `${candidate.first_name} resume summary`,
              skills: ['Construction'],
              years_experience: 5,
              needs_review: false,
              review_notes: '',
            }),
          }],
          usage: { input_tokens: 20, output_tokens: 10 },
        };
      },
    },
  }));
}

async function pageCount(filePath) {
  const pdf = await PDFDocument.load(fs.readFileSync(filePath));
  return pdf.getPageCount();
}

(async () => {
  try {
    assert.deepEqual(
      normalizeResumeSegments({
        resumes: [
          { first_name: 'One', last_name: 'Person', start_page: 2, end_page: 2, confidence: 1 },
          { first_name: 'Two', last_name: 'Person', start_page: 4, end_page: 4, confidence: 1 },
        ],
      }, 5).map(segment => [segment.start_page, segment.end_page]),
      [[1, 3], [4, 5]],
      'unassigned separator pages should remain inside adjacent candidate PDFs',
    );

    const sourceSize = await createSourcePacket();
    const db = initializeSchema();
    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, role, is_active)
      VALUES (?, ?, ?, ?, 'super_admin', 1)
    `).run(USER_ID, 'HR Test Admin', 'hr-admin@example.test', 'hash');
    db.prepare(`
      INSERT INTO hr_resume_import_batches (id, status, total_files, model, created_by)
      VALUES (?, 'queued', 1, 'test-model', ?)
    `).run(BATCH_ID, USER_ID);
    db.prepare(`
      INSERT INTO hr_resume_import_items (
        id, batch_id, status, original_name, stored_name, mime_type, size
      ) VALUES (?, ?, 'queued', 'DOC (71).pdf', ?, 'application/pdf', ?)
    `).run(SOURCE_ITEM_ID, BATCH_ID, SOURCE_STORED_NAME, sourceSize);

    mockAnthropic();
    await processResumeBatch(BATCH_ID, storageRoot);

    const batch = db.prepare('SELECT * FROM hr_resume_import_batches WHERE id = ?').get(BATCH_ID);
    assert.equal(batch.status, 'completed');
    assert.equal(batch.total_files, 5, 'one packet should expand to five candidate resume items');
    assert.equal(batch.processed_files, 5);
    assert.equal(batch.imported_files, 5);
    assert.equal(batch.failed_files, 0);

    const items = db.prepare(`
      SELECT * FROM hr_resume_import_items WHERE batch_id = ?
    `).all(BATCH_ID).sort((left, right) => (
      JSON.parse(left.extracted_json).source_packet.resume_number
      - JSON.parse(right.extracted_json).source_packet.resume_number
    ));
    assert.equal(items.length, 5);
    assert.deepEqual(
      items.map(item => {
        const metadata = JSON.parse(item.extracted_json).source_packet;
        return [metadata.start_page, metadata.end_page];
      }),
      [[1, 1], [2, 3], [4, 4], [5, 6], [7, 10]],
    );
    assert.ok(items.every(item => item.stored_name !== SOURCE_STORED_NAME));
    assert.ok(items.every(item => item.document_id));
    assert.ok(fs.existsSync(path.join(storageRoot, SOURCE_STORED_NAME)), 'private source packet should be preserved');

    const splitPageCounts = [];
    for (const item of items) {
      splitPageCounts.push(await pageCount(path.join(storageRoot, item.stored_name)));
    }
    assert.deepEqual(splitPageCounts, [1, 2, 1, 2, 4]);

    const candidates = db.prepare(`
      SELECT first_name, last_name FROM hr_candidates ORDER BY rowid
    `).all();
    assert.deepEqual(candidates, EXPECTED.map(({ first_name, last_name }) => ({ first_name, last_name })));

    const documents = db.prepare(`
      SELECT owner_id, stored_name, original_name FROM hr_documents ORDER BY rowid
    `).all();
    assert.equal(documents.length, 5);
    assert.ok(documents.every(document => document.stored_name !== SOURCE_STORED_NAME));
    assert.deepEqual(documents.map(document => document.original_name), EXPECTED.map(
      candidate => `${candidate.first_name} ${candidate.last_name} - Resume.pdf`,
    ));

    console.log('HR resume intake packet splitting tests passed');
  } finally {
    try {
      getDb().close();
    } catch (_error) {
      // Database may not have initialized if an earlier assertion failed.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
