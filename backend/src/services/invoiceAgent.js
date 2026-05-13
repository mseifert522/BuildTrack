const { v4: uuidv4 } = require('uuid');
const AnthropicModule = require('@anthropic-ai/sdk');

const { getDb } = require('../db/schema');

const Anthropic = AnthropicModule.default || AnthropicModule;
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
const DEFAULT_CONFIDENCE = 0.82;

let timer = null;
let running = false;

function hasAnthropicConfig() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function agentEnabled() {
  return String(process.env.INVOICE_AGENT_ENABLED || '').toLowerCase() === 'true';
}

function autoFileEnabled() {
  return String(process.env.INVOICE_AGENT_AUTO_FILE || '').toLowerCase() === 'true';
}

function confidenceThreshold() {
  const value = Number.parseFloat(process.env.INVOICE_AGENT_CONFIDENCE_THRESHOLD || '');
  return Number.isFinite(value) ? value : DEFAULT_CONFIDENCE;
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToText(html) {
  return cleanText(String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|li|br|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"'));
}

function intakeText(row) {
  const body = row.text_body && row.text_body.trim() ? row.text_body : htmlToText(row.html_body);
  return cleanText([
    `Subject: ${row.subject || ''}`,
    `From: ${row.from_name || ''} <${row.from_email || ''}>`,
    `To: ${row.to_email || ''}`,
    `Received: ${row.received_at || ''}`,
    '',
    body || '',
  ].join('\n')).slice(0, 24000);
}

function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number.parseFloat(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(num) ? num : null;
}

function extractAmount(text) {
  const source = cleanText(text);
  const labeled = [
    /(?:amount due|balance due|invoice total|total due|grand total|payment total|total)\s*[:\-]?\s*\$?\s*([\d,]+\.\d{2})/i,
    /\$\s*([\d,]+\.\d{2})\s*(?:total|paid|charged|payment)/i,
  ];
  for (const pattern of labeled) {
    const match = source.match(pattern);
    const parsed = parseMoney(match?.[1]);
    if (parsed !== null) return parsed;
  }

  const amounts = Array.from(source.matchAll(/\$\s*([\d,]+\.\d{2})/g))
    .map(match => parseMoney(match[1]))
    .filter(value => value !== null && value > 0);
  if (amounts.length === 0) return null;
  return Math.max(...amounts);
}

function extractAfterLabel(text, labels, maxLines = 2) {
  const lines = cleanText(text).split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const label of labels) {
      const pattern = new RegExp(`^${label}\\s*:?\\s*(.*)$`, 'i');
      const match = line.match(pattern);
      if (!match) continue;
      const values = [];
      if (match[1]) values.push(match[1]);
      for (let j = 1; j <= maxLines && lines[i + j]; j += 1) {
        if (/^[A-Za-z ]+\s*:/.test(lines[i + j])) break;
        values.push(lines[i + j]);
      }
      const result = cleanText(values.join(' '));
      if (result) return result.slice(0, 240);
    }
  }
  return null;
}

function extractFallback(row, text) {
  const fromName = row.from_name || '';
  const subject = row.subject || '';
  const vendorFromSubject = subject.match(/(?:from|charge from|receipt from)\s+(.+?)(?:\.|$)/i)?.[1];
  return {
    vendor_name: cleanText(vendorFromSubject || fromName || row.from_email || '').slice(0, 160) || null,
    invoice_number: extractAfterLabel(text, ['Invoice Number', 'Invoice #', 'Job Number'], 1),
    invoice_date: extractAfterLabel(text, ['Invoice Date', 'Service Date', 'Date'], 1),
    total_amount: extractAmount(text),
    service_address: extractAfterLabel(text, ['Service Address', 'Property Address', 'Job Address', 'Address'], 2),
    summary: cleanText(subject).slice(0, 300) || null,
  };
}

function normalizeAddress(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(street|st)\b/g, 'st')
    .replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(road|rd)\b/g, 'rd')
    .replace(/\b(drive|dr)\b/g, 'dr')
    .replace(/\b(lane|ln)\b/g, 'ln')
    .replace(/\b(court|ct)\b/g, 'ct')
    .replace(/\b(place|pl)\b/g, 'pl')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value) {
  return new Set(normalizeAddress(value).split(' ').filter(Boolean));
}

function deterministicProjectMatch(serviceAddress, projects) {
  const normalizedServiceAddress = normalizeAddress(serviceAddress);
  if (!normalizedServiceAddress) return null;

  const serviceTokens = tokenSet(serviceAddress);
  const serviceNumber = normalizedServiceAddress.match(/\b\d{2,6}\b/)?.[0] || '';
  let best = null;

  for (const project of projects) {
    const normalizedProjectAddress = normalizeAddress(project.address);
    if (!normalizedProjectAddress) continue;

    let confidence = 0;
    if (normalizedServiceAddress.includes(normalizedProjectAddress) || normalizedProjectAddress.includes(normalizedServiceAddress)) {
      confidence = 0.96;
    } else {
      const projectTokens = tokenSet(project.address);
      const projectNumber = normalizedProjectAddress.match(/\b\d{2,6}\b/)?.[0] || '';
      const shared = Array.from(projectTokens).filter(token => serviceTokens.has(token));
      const streetOverlap = shared.filter(token => !/^\d+$/.test(token)).length;
      if (serviceNumber && projectNumber && serviceNumber === projectNumber && streetOverlap > 0) {
        confidence = Math.min(0.94, 0.72 + streetOverlap * 0.08);
      } else if (streetOverlap >= 3) {
        confidence = Math.min(0.82, 0.45 + streetOverlap * 0.08);
      }
    }

    if (!best || confidence > best.confidence) {
      best = { project_id: project.id, address: project.address, confidence };
    }
  }

  return best && best.confidence > 0 ? best : null;
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error('AI response did not contain JSON');
  }
}

function projectPromptRows(projects) {
  return projects.slice(0, 250).map(project => ({
    id: project.id,
    address: project.address,
    job_name: project.job_name || '',
    status: project.status || '',
  }));
}

function loadProjects(db) {
  return db.prepare(`
    SELECT id, address, job_name, status, updated_at
    FROM projects
    WHERE status != 'archived'
    ORDER BY
      CASE status WHEN 'active_rehab' THEN 0 WHEN 'rehab_completed' THEN 1 ELSE 2 END,
      datetime(updated_at) DESC
    LIMIT 500
  `).all();
}

async function askAnthropic({ emailText, fallback, projects }) {
  if (!hasAnthropicConfig()) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: 1400,
    temperature: 0,
    system: [
      'You are BuildTrack invoice intake intelligence.',
      'Extract invoice or receipt facts from construction-related emails and match them to the correct project address.',
      'Return only valid JSON. Do not explain outside JSON.',
      'If the email is a payment receipt, charge receipt, invoice notice, or forwarded invoice body, treat it as invoice intake.',
      'Prefer exact address matches. If uncertain, set should_file false and explain the review reason.',
    ].join(' '),
    messages: [{
      role: 'user',
      content: JSON.stringify({
        required_json_schema: {
          vendor_name: 'string or null',
          invoice_number: 'string or null',
          invoice_date: 'YYYY-MM-DD or original string or null',
          total_amount: 'number or null',
          service_address: 'string or null',
          summary: 'one short operational summary',
          project_match: {
            project_id: 'matching project id or null',
            address: 'matching project address or null',
            confidence: '0 to 1',
            reasoning: 'short reason',
          },
          should_file: 'true only when total_amount and a high-confidence project match are present',
          needs_review_reason: 'string or null',
        },
        deterministic_extraction: fallback,
        available_projects: projectPromptRows(projects),
        email: emailText,
      }),
    }],
  });

  const text = response.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
  const parsed = parseJsonObject(text);
  return { parsed, model };
}

function recordRun(db, { intakeId, action, status, model, inputSummary, result, error }) {
  db.prepare(`
    INSERT INTO invoice_agent_runs (id, intake_id, action, status, model, input_summary, result_json, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    intakeId || null,
    action,
    status,
    model || null,
    inputSummary ? String(inputSummary).slice(0, 1000) : null,
    result ? JSON.stringify(result).slice(0, 12000) : null,
    error ? String(error).slice(0, 2000) : null
  );
}

function updateIntakeFromResult(db, row, result, model, projects) {
  const fallback = result.fallback || {};
  const ai = result.ai || {};
  const projectMatch = ai.project_match || {};
  const amount = parseMoney(ai.total_amount) ?? parseMoney(fallback.total_amount);
  const serviceAddress = cleanText(ai.service_address || fallback.service_address || '').slice(0, 240) || null;
  const deterministicMatch = deterministicProjectMatch(serviceAddress, projects);
  const matchedProjectId = projectMatch.project_id || deterministicMatch?.project_id || null;
  const matchedProject = matchedProjectId ? projects.find(project => project.id === matchedProjectId) : null;
  const confidence = Number.parseFloat(projectMatch.confidence);
  const matchConfidence = Number.isFinite(confidence)
    ? Math.max(0, Math.min(1, confidence))
    : deterministicMatch?.confidence || 0;
  const threshold = confidenceThreshold();
  const shouldFile = autoFileEnabled() && matchedProject && amount !== null && matchConfidence >= threshold && ai.should_file !== false;
  const agentStatus = shouldFile
    ? 'filed'
    : matchedProject && matchConfidence >= 0.55
      ? 'matched'
      : 'needs_review';
  const status = shouldFile ? 'filed' : row.status;
  const notes = cleanText(
    ai.needs_review_reason ||
    projectMatch.reasoning ||
    (shouldFile ? `Auto-filed to ${matchedProject.address}` : 'Needs office review before filing')
  ).slice(0, 1000);

  db.prepare(`
    UPDATE invoice_email_intake
    SET
      extracted_vendor = ?,
      extracted_invoice_number = ?,
      extracted_amount = ?,
      extracted_invoice_date = ?,
      extracted_service_address = ?,
      extracted_summary = ?,
      matched_project_id = ?,
      match_confidence = ?,
      status = ?,
      agent_status = ?,
      agent_notes = ?,
      agent_model = ?,
      agent_result_json = ?,
      agent_last_run_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    cleanText(ai.vendor_name || fallback.vendor_name || '').slice(0, 160) || null,
    cleanText(ai.invoice_number || fallback.invoice_number || '').slice(0, 120) || null,
    amount,
    cleanText(ai.invoice_date || fallback.invoice_date || '').slice(0, 80) || null,
    serviceAddress,
    cleanText(ai.summary || fallback.summary || row.subject || '').slice(0, 500) || null,
    matchedProject?.id || null,
    matchConfidence || null,
    status,
    agentStatus,
    notes || null,
    model || null,
    JSON.stringify(result).slice(0, 12000),
    row.id
  );

  return {
    id: row.id,
    status,
    agent_status: agentStatus,
    amount,
    matched_project_id: matchedProject?.id || null,
    matched_project_address: matchedProject?.address || null,
    match_confidence: matchConfidence,
  };
}

async function runInvoiceAgentForIntake(id, options = {}) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM invoice_email_intake WHERE id = ?').get(id);
  if (!row) throw new Error('Inbound invoice email not found');
  if (row.status === 'ignored' && !options.force) {
    return { id, skipped: true, reason: 'ignored' };
  }

  const projects = loadProjects(db);
  const emailText = intakeText(row);
  const fallback = extractFallback(row, emailText);
  let model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  try {
    const aiResponse = await askAnthropic({ emailText, fallback, projects });
    model = aiResponse.model;
    const result = { fallback, ai: aiResponse.parsed };
    const updated = updateIntakeFromResult(db, row, result, model, projects);
    recordRun(db, {
      intakeId: row.id,
      action: 'invoice_extract_match',
      status: updated.agent_status,
      model,
      inputSummary: `${row.subject || ''} ${row.from_email || ''}`,
      result,
    });
    return updated;
  } catch (err) {
    const fallbackOnly = {
      fallback,
      ai: {
        vendor_name: fallback.vendor_name,
        invoice_number: fallback.invoice_number,
        invoice_date: fallback.invoice_date,
        total_amount: fallback.total_amount,
        service_address: fallback.service_address,
        summary: fallback.summary,
        project_match: {},
        should_file: false,
        needs_review_reason: err.message,
      },
      error: err.message,
    };

    const updated = updateIntakeFromResult(db, row, fallbackOnly, model, projects);
    db.prepare(`
      UPDATE invoice_email_intake
      SET agent_status = CASE WHEN matched_project_id IS NULL THEN 'error' ELSE agent_status END,
          agent_notes = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(String(err.message || 'AI invoice scan failed').slice(0, 1000), row.id);
    recordRun(db, {
      intakeId: row.id,
      action: 'invoice_extract_match',
      status: 'error',
      model,
      inputSummary: `${row.subject || ''} ${row.from_email || ''}`,
      result: fallbackOnly,
      error: err.message,
    });
    return { ...updated, error: err.message };
  }
}

async function runPendingInvoiceAgent(options = {}) {
  if (running && !options.force) return { ok: true, skipped: true };
  running = true;
  try {
    const db = getDb();
    const limit = Math.min(Math.max(Number.parseInt(options.limit || process.env.INVOICE_AGENT_BATCH_SIZE || '10', 10), 1), 50);
    const rows = db.prepare(`
      SELECT id
      FROM invoice_email_intake
      WHERE status = 'new'
        AND COALESCE(agent_status, 'pending') IN ('pending','needs_review','error')
      ORDER BY
        CASE WHEN agent_last_run_at IS NULL THEN 0 ELSE 1 END,
        datetime(received_at) DESC
      LIMIT ?
    `).all(limit);

    const results = [];
    for (const row of rows) {
      results.push(await runInvoiceAgentForIntake(row.id, { force: options.force }));
    }
    return { ok: true, processed: results.length, results };
  } finally {
    running = false;
  }
}

function manualFileIntake(id, projectId) {
  const db = getDb();
  const project = db.prepare('SELECT id, address FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error('Project not found');
  const result = db.prepare(`
    UPDATE invoice_email_intake
    SET status = 'filed',
        agent_status = 'filed',
        matched_project_id = ?,
        match_confidence = COALESCE(match_confidence, 1),
        agent_notes = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(project.id, `Manually filed to ${project.address}`, id);
  if (result.changes === 0) throw new Error('Inbound invoice email not found');
  recordRun(db, {
    intakeId: id,
    action: 'manual_file',
    status: 'filed',
    inputSummary: project.address,
    result: { project_id: project.id, address: project.address },
  });
  return { id, project_id: project.id, project_address: project.address, status: 'filed' };
}

function startInvoiceAgent() {
  if (!agentEnabled()) return;
  const intervalMs = Math.max(Number.parseInt(process.env.INVOICE_AGENT_POLL_INTERVAL_MS || '300000', 10), 60000);
  const startupDelayMs = Math.max(Number.parseInt(process.env.INVOICE_AGENT_STARTUP_DELAY_MS || '20000', 10), 1000);
  const run = () => {
    runPendingInvoiceAgent().catch(err => {
      console.error('[INVOICE AGENT] Scan failed:', err.message);
    });
  };
  setTimeout(run, startupDelayMs);
  timer = setInterval(run, intervalMs);
  console.log(`[INVOICE AGENT] Enabled with model ${process.env.ANTHROPIC_MODEL || DEFAULT_MODEL}`);
}

function stopInvoiceAgent() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  hasAnthropicConfig,
  runInvoiceAgentForIntake,
  runPendingInvoiceAgent,
  manualFileIntake,
  startInvoiceAgent,
  stopInvoiceAgent,
};
