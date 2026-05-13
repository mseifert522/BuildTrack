const { v4: uuidv4 } = require('uuid');
const AnthropicModule = require('@anthropic-ai/sdk');

const { getDb } = require('../db/schema');

const Anthropic = AnthropicModule.default || AnthropicModule;
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
const SCAN_PATHS = ['/', '/dashboard', '/projects', '/invoices', '/documents', '/contractors', '/suppliers', '/invoice-agent'];
let timer = null;

function portalAgentEnabled() {
  return String(process.env.PORTAL_AGENT_ENABLED || '').toLowerCase() === 'true';
}

function hasAnthropicConfig() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function baseUrl() {
  return (process.env.APP_URL || process.env.FRONTEND_URL || 'https://buildtrack.newurbandev.com').replace(/\/$/, '');
}

function nowIso() {
  return new Date().toISOString();
}

async function probePath(path) {
  const target = `${baseUrl()}${path}`;
  const started = Date.now();
  try {
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': 'BuildTrackPortalAgent/1.0' },
    });
    return {
      path,
      status: response.status,
      ms: Date.now() - started,
      content_type: response.headers.get('content-type') || '',
      location: response.headers.get('location') || '',
      security_headers: {
        strict_transport_security: response.headers.get('strict-transport-security') || '',
        x_frame_options: response.headers.get('x-frame-options') || '',
        x_content_type_options: response.headers.get('x-content-type-options') || '',
        content_security_policy: response.headers.get('content-security-policy') || '',
        referrer_policy: response.headers.get('referrer-policy') || '',
      },
    };
  } catch (err) {
    return { path, status: 0, ms: Date.now() - started, error: err.message };
  }
}

function localSignals(db) {
  const invoiceStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
      SUM(CASE WHEN status = 'filed' THEN 1 ELSE 0 END) as filed_count,
      SUM(CASE WHEN agent_status = 'needs_review' THEN 1 ELSE 0 END) as needs_review_count,
      SUM(CASE WHEN agent_status = 'error' THEN 1 ELSE 0 END) as error_count
    FROM invoice_email_intake
  `).get();
  const projectStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'active_rehab' THEN 1 ELSE 0 END) as active_count,
      SUM(CASE WHEN status = 'rehab_completed' THEN 1 ELSE 0 END) as completed_count
    FROM projects
  `).get();
  const userStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_count,
      SUM(CASE WHEN role = 'contractor' THEN 1 ELSE 0 END) as contractor_count
    FROM users
  `).get();
  return { invoiceStats, projectStats, userStats };
}

function heuristicFindings(probes) {
  const findings = [];
  for (const probe of probes) {
    if (probe.status === 0) {
      findings.push({ severity: 'high', area: 'availability', title: `${probe.path} did not respond`, detail: probe.error || 'Request failed' });
      continue;
    }
    if (probe.status >= 500) {
      findings.push({ severity: 'critical', area: 'availability', title: `${probe.path} returned ${probe.status}`, detail: 'Portal route is failing.' });
    }
    if (probe.status === 200 && !probe.security_headers?.x_content_type_options) {
      findings.push({ severity: 'medium', area: 'security', title: 'Missing nosniff header', detail: `${probe.path} did not include X-Content-Type-Options.` });
    }
    if (probe.status === 200 && !probe.security_headers?.x_frame_options && !probe.security_headers?.content_security_policy) {
      findings.push({ severity: 'medium', area: 'security', title: 'Missing clickjacking protection', detail: `${probe.path} did not include X-Frame-Options or CSP.` });
    }
    if (probe.ms > 2500) {
      findings.push({ severity: 'medium', area: 'performance', title: `${probe.path} responded slowly`, detail: `${probe.ms}ms response time.` });
    }
  }
  return findings;
}

async function askAnthropicForPortalReview(payload) {
  if (!hasAnthropicConfig()) throw new Error('ANTHROPIC_API_KEY is not configured');
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: 1800,
    temperature: 0,
    system: [
      'You are BuildTrack portal operations intelligence.',
      'Review health, security, organization, and invoice workflow signals.',
      'Return only valid JSON with score, summary, and findings. Do not claim you changed code.',
      'Recommend controlled improvements; destructive actions require human approval.',
    ].join(' '),
    messages: [{
      role: 'user',
      content: JSON.stringify({
        required_json_schema: {
          score: '0-100 integer',
          summary: 'short operations summary',
          findings: [{
            severity: 'critical|high|medium|low|info',
            area: 'security|organization|invoice_intake|performance|availability',
            title: 'short title',
            detail: 'specific observation',
            recommended_action: 'specific next action',
          }],
        },
        scan_payload: payload,
      }),
    }],
  });
  const text = response.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const parsed = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
  return { model, parsed };
}

async function runPortalAgentScan() {
  const db = getDb();
  const probes = [];
  for (const path of SCAN_PATHS) {
    probes.push(await probePath(path));
  }
  const signals = localSignals(db);
  const heuristic = heuristicFindings(probes);
  const payload = { scanned_at: nowIso(), base_url: baseUrl(), probes, signals, heuristic_findings: heuristic };
  let model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  try {
    const ai = await askAnthropicForPortalReview(payload);
    model = ai.model;
    const findings = Array.isArray(ai.parsed.findings) ? ai.parsed.findings : heuristic;
    const score = Number.isFinite(Number(ai.parsed.score)) ? Math.max(0, Math.min(100, Number(ai.parsed.score))) : null;
    db.prepare(`
      INSERT INTO portal_agent_runs (id, status, model, score, scan_summary, findings_json)
      VALUES (?, 'completed', ?, ?, ?, ?)
    `).run(uuidv4(), model, score, String(ai.parsed.summary || '').slice(0, 1000), JSON.stringify(findings).slice(0, 16000));
    return { ok: true, status: 'completed', model, score, summary: ai.parsed.summary, findings, probes };
  } catch (err) {
    const summary = heuristic.length ? `${heuristic.length} issue(s) detected without AI review.` : 'Basic portal scan completed without AI review.';
    db.prepare(`
      INSERT INTO portal_agent_runs (id, status, model, score, scan_summary, findings_json, error)
      VALUES (?, 'error', ?, NULL, ?, ?, ?)
    `).run(uuidv4(), model, summary, JSON.stringify(heuristic).slice(0, 16000), String(err.message || err).slice(0, 2000));
    return { ok: false, status: 'error', model, summary, findings: heuristic, probes, error: err.message };
  }
}

function nextDailyDelayMs() {
  const scheduledHour = Math.min(Math.max(Number.parseInt(process.env.PORTAL_AGENT_DAILY_HOUR || '3', 10), 0), 23);
  const scheduledMinute = Math.min(Math.max(Number.parseInt(process.env.PORTAL_AGENT_DAILY_MINUTE || '15', 10), 0), 59);
  const now = new Date();
  const next = new Date(now);
  next.setHours(scheduledHour, scheduledMinute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleNextPortalScan() {
  const delay = nextDailyDelayMs();
  timer = setTimeout(async () => {
    try {
      await runPortalAgentScan();
    } catch (err) {
      console.error('[PORTAL AGENT] Daily scan failed:', err.message);
    } finally {
      scheduleNextPortalScan();
    }
  }, delay);
}

function startPortalAgent() {
  if (!portalAgentEnabled()) return;
  scheduleNextPortalScan();
  console.log('[PORTAL AGENT] Daily portal scan enabled');
}

function stopPortalAgent() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  portalAgentEnabled,
  runPortalAgentScan,
  startPortalAgent,
  stopPortalAgent,
};
