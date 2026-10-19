const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { NUD_COMPANY } = require('./companyInfo');

// The Scope of Work entered in BuildTrack, as a printable PDF (Mike, 2026-10-19).
// Shown at the top of the project's Scope of Work tab until an official PDF is
// uploaded, and always available to download beside it.

const LOGO_CANDIDATES = [
  '/app/frontend/dist/nud-logo.jpg',
  path.join(__dirname, '..', '..', '..', 'frontend', 'dist', 'nud-logo.jpg'),
  path.join(__dirname, '..', '..', '..', 'frontend', 'public', 'nud-logo.jpg'),
];

const INK = '#111827';
const MUTED = '#5b6472';
const RULE = '#d5dae1';
const ACCENT = '#1f3b63';

const STATUS_LABELS = {
  draft: 'Draft',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  not_started: 'Not started',
  in_progress: 'In progress',
  waiting_materials: 'Waiting on materials',
  needs_review: 'Needs review',
};

// The standard PDF fonts only cover WinAnsi; anything else would print as garbage.
function pdfText(value) {
  return String(value ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/•/g, '-')
    .replace(/[^\x09\x0a\x0d\x20-\x7e -ÿ]/g, '')
    .trim();
}

function easternDate(value, withTime = false) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(date);
}

function dateOnly(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return '';
  return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], 12)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

function scopeLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:\d+[.)-]?|[-*•])\s*/, '').trim())
    .filter(Boolean);
}

// Line items in the scope: a section's own line items when it has any, else the lines
// of its scope text; plus line items not assigned to a section. The PDF and the tab's
// caption both count with this.
function scopeLineTotal(scopes, items) {
  const scopeIds = new Set(scopes.map(scope => String(scope.id)));
  const linked = new Map();
  let loose = 0;
  for (const item of items) {
    const key = String(item.project_scope_id || '');
    if (scopeIds.has(key)) linked.set(key, (linked.get(key) || 0) + 1);
    else loose += 1;
  }
  return scopes.reduce((sum, scope) => sum + (linked.get(String(scope.id)) || scopeLines(scope.scope_of_work).length), 0) + loose;
}

function generateScopeOfWorkPDF({ project, scopes, items, generatedAt = new Date() }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, bottom: 64, left: 58, right: 58 }, bufferPages: true, info: {
      Title: pdfText(`Scope of Work - ${project.address || project.job_name || 'Project'}`),
      Author: NUD_COMPANY.name,
      Creator: 'BuildTrack',
    } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottomLimit = () => doc.page.height - doc.page.margins.bottom;
    const ensureRoom = (height) => { if (doc.y + height > bottomLimit()) doc.addPage(); };
    const rule = (color = RULE) => {
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).lineWidth(0.75).strokeColor(color).stroke();
    };

    // Letterhead
    const logo = LOGO_CANDIDATES.find(candidate => { try { return fs.existsSync(candidate); } catch { return false; } });
    const top = doc.y;
    if (logo) {
      try { doc.image(logo, left, top, { fit: [150, 48] }); } catch { /* a bad logo never blocks the document */ }
    } else {
      doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(NUD_COMPANY.name, left, top + 12);
    }
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
      .text(NUD_COMPANY.name, left, top + 2, { width, align: 'right' })
      .text(NUD_COMPANY.street, { width, align: 'right' })
      .text(NUD_COMPANY.cityStateZip, { width, align: 'right' })
      .text(`${NUD_COMPANY.phone}  |  ${NUD_COMPANY.email}`, { width, align: 'right' });
    doc.y = Math.max(doc.y, top + 52) + 14;
    rule(ACCENT);
    doc.moveDown(1.1);

    // Title block
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text('SCOPE OF WORK', left, doc.y, { characterSpacing: 1.6 });
    doc.moveDown(0.35);
    doc.font('Helvetica-Bold').fontSize(19).fillColor(INK).text(pdfText(project.address || project.job_name || 'Project'), { width });
    if (project.job_name && project.job_name.trim() !== String(project.address || '').trim()) {
      doc.moveDown(0.15);
      doc.font('Helvetica').fontSize(10.5).fillColor(MUTED).text(pdfText(`Job: ${project.job_name.trim()}`), { width });
    }
    const scopeIds = new Set(scopes.map(scope => String(scope.id)));
    const looseItems = items.filter(item => !scopeIds.has(String(item.project_scope_id || '')));
    const lineTotal = scopeLineTotal(scopes, items);
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
      `Prepared ${easternDate(generatedAt, true)} (New York time)  |  ${scopes.length} scope section${scopes.length === 1 ? '' : 's'}  |  ${lineTotal} line item${lineTotal === 1 ? '' : 's'}`,
      { width }
    );
    doc.moveDown(0.9);
    rule();
    doc.moveDown(1);

    const lineItem = (number, title, detail) => {
      const text = pdfText(title) || 'Line item';
      const sub = pdfText(detail);
      const textWidth = width - 30;
      doc.font('Helvetica').fontSize(10.5);
      const needed = doc.heightOfString(text, { width: textWidth }) + (sub ? 14 : 0) + 8;
      ensureRoom(needed);
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(ACCENT).text(`${number}.`, left + 4, y + 0.5, { width: 22, align: 'right' });
      doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(text, left + 30, y, { width: textWidth });
      if (sub) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(sub, left + 30, doc.y + 1.5, { width: textWidth });
      doc.y += 6;
    };

    const heading = (label, title, meta) => {
      ensureRoom(70);
      doc.x = left;
      if (label) doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(pdfText(label).toUpperCase(), { width, characterSpacing: 1 });
      doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(pdfText(title), { width });
      if (meta) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(pdfText(meta), { width });
      doc.moveDown(0.55);
    };

    if (!scopes.length && !items.length) {
      const legacy = String(project.scope_of_work || '').trim();
      if (legacy) {
        heading('Project scope', 'Scope of work');
        const lines = scopeLines(legacy);
        lines.forEach((line, index) => lineItem(index + 1, line, ''));
      } else {
        doc.font('Helvetica').fontSize(11).fillColor(MUTED).text('No scope of work has been entered in BuildTrack for this project yet.', { width });
      }
    }

    scopes.forEach((scope, index) => {
      const linked = items.filter(item => String(item.project_scope_id || '') === String(scope.id));
      const timeline = [dateOnly(scope.timeline_start), dateOnly(scope.timeline_end)].filter(Boolean).join(' to ');
      const meta = [
        `Status: ${STATUS_LABELS[scope.status] || 'Active'}`,
        timeline ? `Timeline: ${timeline}` : '',
        scope.created_by_agent ? `Entered by ${scope.created_by_agent} (AI agent)${scope.source ? ` via ${scope.source}` : ''}` : '',
      ].filter(Boolean).join('  |  ');
      if (index > 0) doc.moveDown(0.6);
      heading(scope.section_name && scope.section_name !== 'General' ? scope.section_name : `Section ${index + 1}`, scope.scope_title || 'Scope of Work', meta);
      if (linked.length) {
        linked.forEach((item, n) => {
          const detail = [
            item.category && item.category !== 'General' ? item.category : '',
            item.location || '',
            STATUS_LABELS[item.status] || '',
          ].filter(Boolean).join('  -  ');
          const description = String(item.description || '').trim();
          lineItem(n + 1, item.title, [description && description !== item.title ? description : '', detail].filter(Boolean).join('\n'));
        });
      } else {
        const lines = scopeLines(scope.scope_of_work);
        if (lines.length) lines.forEach((line, n) => lineItem(n + 1, line, ''));
        else doc.font('Helvetica-Oblique').fontSize(10).fillColor(MUTED).text('No line items entered for this scope yet.', left + 30, doc.y, { width: width - 30 });
      }
    });

    if (looseItems.length) {
      doc.moveDown(0.6);
      heading('Additional work', 'Line items not assigned to a scope section', '');
      looseItems.forEach((item, n) => lineItem(n + 1, item.title, [item.category && item.category !== 'General' ? item.category : '', STATUS_LABELS[item.status] || ''].filter(Boolean).join('  -  ')));
    }

    // Footer on every page
    const range = doc.bufferedPageRange();
    const footerText = pdfText(`${NUD_COMPANY.name}  |  Scope of Work  |  ${project.address || project.job_name || ''}`);
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      const y = doc.page.height - doc.page.margins.bottom + 22;
      // Writing inside the bottom margin must not trigger an automatic page break.
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.moveTo(left, y - 8).lineTo(left + width, y - 8).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(footerText, left, y, { width: width - 80, lineBreak: false });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + width - 80, y, { width: 80, align: 'right', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }
    doc.end();
  });
}

module.exports = { generateScopeOfWorkPDF, pdfText, scopeLines, scopeLineTotal };
