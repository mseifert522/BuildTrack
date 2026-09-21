const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

function isEmailConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_PASS !== 'REPLACE_WITH_RESEND_API_KEY');
}

function createTransporter() {
  if (!isEmailConfigured()) {
    return {
      sendMail: async (opts) => {
        console.log('[EMAIL MOCK] Would send email:');
        console.log('  To:', opts.to);
        console.log('  Subject:', opts.subject);
        console.log('  Body preview:', opts.html?.substring(0, 200));
        return { messageId: 'mock-' + Date.now() };
      }
    };
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

const BRAND = {
  name: 'New Urban Development',
  color: '#D99D26',
  url: process.env.APP_URL || 'https://buildtrack.newurbandev.com',
  mobileUrl: process.env.MOBILE_APP_URL || 'https://mobile.buildtrack.newurbandev.com',
  logoUrl: process.env.EMAIL_LOGO_URL || `${(process.env.APP_URL || 'https://buildtrack.newurbandev.com').replace(/\/+$/, '')}/nud-logo.jpg`,
  quoteInbox: process.env.QUOTE_REQUEST_VISIBLE_TO || process.env.COMPANY_EMAIL || process.env.SMTP_USER || 'info@newurbandev.com',
};

function brandedFrom() {
  const configured = String(process.env.EMAIL_FROM || '').trim();
  if (configured && !/buildtrack/i.test(configured)) return configured;
  return 'New Urban Development <info@newurbandev.com>';
}

function logoCid() {
  return 'nud-logo';
}

function logoAttachment() {
  const candidates = [
    process.env.EMAIL_LOGO_PATH,
    '/app/frontend/dist/nud-logo.jpg',
    path.join(__dirname, '..', '..', 'frontend', 'dist', 'nud-logo.jpg'),
    path.join(__dirname, '..', '..', 'frontend', 'public', 'nud-logo.jpg'),
  ].filter(Boolean);
  const file = candidates.find((candidate) => {
    try { return fs.existsSync(candidate); } catch (_) { return false; }
  });
  if (!file) return null;
  return {
    filename: 'nud-logo.jpg',
    path: file,
    cid: logoCid(),
    contentType: 'image/jpeg',
  };
}

function sendBrandedMail(transporter, opts = {}) {
  const logo = logoAttachment();
  const attachments = Array.isArray(opts.attachments) ? [...opts.attachments] : [];
  if (logo) attachments.push(logo);
  return transporter.sendMail({
    ...opts,
    from: opts.from && !/buildtrack/i.test(String(opts.from)) ? opts.from : brandedFrom(),
    replyTo: opts.replyTo || 'info@newurbandev.com',
    attachments,
  });
}

function emailWrapper(content) {
  return `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 560px; margin: 0 auto; background: #ffffff;">
      <div style="background: #0D1117; padding: 28px 24px 22px; text-align: center; border-radius: 12px 12px 0 0;">
        <img src="cid:${logoCid()}" alt="New Urban Development" width="132" style="display:block; width:132px; max-width:132px; height:auto; margin:0 auto; border:0;" />
      </div>
      <div style="padding: 32px 24px; border: 1px solid #E5E7EB; border-top: none; border-radius: 0 0 12px 12px;">
        ${content}
        <hr style="border: none; border-top: 1px solid #F3F4F6; margin: 28px 0 16px;" />
        <p style="font-size: 11px; color: #9CA3AF; text-align: center; margin: 0;">
          &copy; 2026 ${BRAND.name} &middot; This is an automated message
        </p>
      </div>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scopeLineItems(value) {
  const normalized = String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[•·]/g, '\n')
    .replace(/(?:^|\n)\s*(?:[-*]|\d+[.)])\s+/g, '\n')
    .replace(/([.!?])\s+(?=[A-Z0-9])/g, '$1\n')
    .split(/\n+/)
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return normalized.length ? normalized : [];
}

function absoluteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${String(BRAND.url || '').replace(/\/+$/, '')}/${raw.replace(/^\/+/, '')}`;
}

function safeFileName(value) {
  return String(value || 'contractor')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'contractor';
}

function pdfValue(value) {
  if (value === true || value === 1) return 'Yes';
  if (value === false || value === 0) return 'No';
  return value ? String(value) : 'Not provided';
}

function addPdfSection(doc, title, rows) {
  doc.moveDown(0.9);
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#111827')
    .text(title, { underline: false });
  doc.moveDown(0.25);

  rows.forEach(([label, value]) => {
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#6B7280')
      .text(label.toUpperCase(), { continued: true, width: 160 });
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#111827')
      .text(`  ${pdfValue(value)}`);
  });
}

function buildContractorSubmissionPdf({ contractorName, contactName, contractorEmail, payload, submittedAt, requestId }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor('#111827')
      .text('Contractor Information Intake');
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#6B7280')
      .text('New Urban Development - BuildTrack');
    doc.moveDown(0.6);
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#B91C1C')
      .text('Confidential: contains unredacted tax and ACH information. Handle according to company policy.');

    addPdfSection(doc, 'Contractor Record', [
      ['Contractor / Vendor', contractorName],
      ['Primary Contact', contactName],
      ['Contractor Email On File', contractorEmail],
      ['Submitted At', submittedAt],
      ['Request ID', requestId],
    ]);

    addPdfSection(doc, '1099 / Tax Information', [
      ['Legal Name', payload.legal_name],
      ['Business Name / DBA', payload.business_name],
      ['Tax Classification', payload.tax_classification],
      ['Tax ID Type', String(payload.tax_id_type || '').toUpperCase()],
      ['Tax ID', payload.tax_id_formatted || payload.tax_id],
      ['W-9 Certified', payload.w9_certified],
    ]);

    addPdfSection(doc, 'Address and Contact', [
      ['Address Line 1', payload.address_line1],
      ['Address Line 2', payload.address_line2],
      ['City', payload.city],
      ['State', payload.state],
      ['ZIP / Postal Code', payload.postal_code],
      ['Country', payload.country],
      ['Phone', payload.phone],
      ['Email', payload.email],
    ]);

    addPdfSection(doc, 'ACH Payment Details', [
      ['Bank Name', payload.bank_name],
      ['Routing Number', payload.routing_number],
      ['Account Number', payload.account_number],
      ['Account Type', payload.account_type],
      ['ACH Authorized', payload.ach_authorized],
    ]);

    addPdfSection(doc, 'Insurance and License', [
      ['Insurance Provider', payload.insurance_provider],
      ['Insurance Policy Number', payload.insurance_policy_number],
      ['Insurance Expiration', payload.insurance_expires_at],
      ['License Number', payload.license_number],
      ['License State', payload.license_state],
    ]);

    doc.end();
  });
}

async function sendContractorSubmissionPdfEmail({ contractorName, contactName, contractorEmail, payload, submittedAt, requestId }) {
  const transporter = createTransporter();
  const operationsEmail = process.env.CONTRACTOR_SETUP_NOTIFY_EMAIL || 'info@newurbandev.com';
  const displayName = contractorName || payload.business_name || payload.legal_name || 'Contractor';
  const pdfBuffer = await buildContractorSubmissionPdf({
    contractorName: displayName,
    contactName: contactName || payload.legal_name,
    contractorEmail,
    payload,
    submittedAt,
    requestId,
  });
  const submittedDate = new Date(submittedAt);
  const dateLabel = Number.isFinite(submittedDate.getTime())
    ? submittedDate.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    : submittedAt;
  const filenameDate = Number.isFinite(submittedDate.getTime())
    ? submittedDate.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const html = emailWrapper(`
    <h2 style="color: #111827; font-size: 20px; font-weight: 700; margin: 0 0 8px;">Contractor setup submitted</h2>
    <p style="color: #6B7280; font-size: 14px; line-height: 1.6; margin: 0 0 20px;">
      A contractor submitted secure onboarding information in BuildTrack. The attached PDF contains the unredacted tax and ACH details for operations review.
    </p>
    <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 18px; margin-bottom: 20px;">
      <p style="font-size: 13px; color: #374151; margin: 0 0 8px;"><strong>Contractor:</strong> ${escapeHtml(displayName)}</p>
      <p style="font-size: 13px; color: #374151; margin: 0 0 8px;"><strong>Contact:</strong> ${escapeHtml(contactName || payload.legal_name || '')}</p>
      <p style="font-size: 13px; color: #374151; margin: 0 0 8px;"><strong>Email:</strong> ${escapeHtml(payload.email || contractorEmail || '')}</p>
      <p style="font-size: 13px; color: #374151; margin: 0;"><strong>Submitted:</strong> ${escapeHtml(dateLabel)}</p>
    </div>
    <p style="color: #B91C1C; font-size: 12px; line-height: 1.6; margin: 0;">
      Confidential: this attachment includes unredacted SSN/EIN and ACH information. Store and forward only according to company policy.
    </p>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: operationsEmail,
    subject: `Contractor setup submitted - ${displayName}`,
    html,
    attachments: [{
      filename: `contractor-setup-${safeFileName(displayName)}-${filenameDate}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }],
  });
}

async function sendInviteEmail({ name, email, setupUrl, role, invitedBy, pin, isReinvite = false }) {
  const transporter = createTransporter();
  const roleLabel = role.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  const safeName = escapeHtml(name || 'there');
  const safeEmail = escapeHtml(email);
  const safeInvitedBy = escapeHtml(invitedBy || 'BuildTrack');
  const safeRoleLabel = escapeHtml(roleLabel);
  const safeSetupUrl = escapeHtml(setupUrl || BRAND.url);
  const safePin = pin ? escapeHtml(pin) : '';

  const html = emailWrapper(`
    <h2 style="color: #111827; font-size: 20px; font-weight: 700; margin: 0 0 8px;">${isReinvite ? 'Your BuildTrack access is ready' : `Welcome to BuildTrack, ${safeName}!`}</h2>
    <p style="color: #6B7280; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
      ${isReinvite ? `${safeInvitedBy} sent you a fresh BuildTrack access link.` : `You've been invited by <strong>${safeInvitedBy}</strong> to join the BuildTrack platform as a <strong>${safeRoleLabel}</strong>.`}
    </p>
    <div style="background: #F9FAFB; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
      <p style="font-size: 12px; color: #6B7280; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 12px;">Your BuildTrack Access</p>
      <table style="width: 100%;">
        <tr><td style="padding: 6px 0; font-size: 13px; color: #6B7280;">Email</td><td style="padding: 6px 0; font-size: 13px; color: #111827; font-weight: 600;">${safeEmail}</td></tr>
        <tr><td style="padding: 6px 0; font-size: 13px; color: #6B7280;">Role</td><td style="padding: 6px 0; font-size: 13px; color: #111827; font-weight: 600;">${safeRoleLabel}</td></tr>
        ${pin ? `<tr><td style="padding: 6px 0; font-size: 13px; color: #6B7280;">Personal PIN</td><td style="padding: 6px 0; font-size: 18px; color: #111827; font-weight: 800; font-family: monospace; letter-spacing: 4px;">${safePin}</td></tr>` : ''}
      </table>
    </div>
    <a href="${safeSetupUrl}" style="display: block; text-align: center; background: ${BRAND.color}; color: white; padding: 14px 24px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; margin-bottom: 14px;">
      Create Your Password
    </a>
    <p style="color: #6B7280; font-size: 12px; line-height: 1.6; margin: 0 0 14px;">
      If the button does not open, copy and paste this secure link into your browser:<br />
      <span style="word-break: break-all; color: #111827;">${safeSetupUrl}</span>
    </p>
    ${pin ? `<p style="color: #6B7280; font-size: 12px; line-height: 1.6; margin: 0 0 14px;">Keep your personal PIN private. Any active BuildTrack user with a PIN can use it for quick mobile access with email verification on first-time or untrusted devices.</p>` : ''}
    <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0;">
      This link opens BuildTrack directly and lets you choose your own password.
    </p>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: email,
    subject: isReinvite ? `Your BuildTrack welcome link` : `You're invited to BuildTrack - ${BRAND.name}`,
    html,
  });
}

async function sendContractorPinEmail({ name, email, pin }) {
  const transporter = createTransporter();
  const displayName = escapeHtml(name || 'there');

  const html = emailWrapper(`
    <h2 style="color: #111827; font-size: 20px; font-weight: 700; margin: 0 0 8px;">Your BuildTrack User PIN Number</h2>
    <p style="color: #6B7280; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
      Hi ${displayName}, use this 5-digit PIN number to sign in to the BuildTrack mobile app.
    </p>
    <div style="text-align: center; margin: 0 0 24px;">
      <span style="display: inline-block; background: #111827; border-radius: 16px; padding: 18px 34px; font-size: 34px; font-weight: 900; letter-spacing: 9px; color: #ffffff; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">
        ${pin}
      </span>
    </div>
    <a href="${BRAND.mobileUrl}" style="display: block; text-align: center; background: ${BRAND.color}; color: white; padding: 14px 24px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; margin-bottom: 14px;">
      Open BuildTrack Mobile
    </a>
    <p style="color: #6B7280; font-size: 12px; line-height: 1.6; text-align: center; margin: 0 0 14px;">
      Keep this PIN private. First-time and untrusted devices verify by email before the app opens.
    </p>
    <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0;">
      If you did not request this PIN, contact New Urban Development.
    </p>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: email,
    subject: `Your BuildTrack User PIN Number`,
    html,
  });
}

async function sendPasswordResetEmail({ name, email, resetUrl }) {
  const transporter = createTransporter();

  const html = emailWrapper(`
    <h2 style="color: #111827; font-size: 20px; font-weight: 700; margin: 0 0 8px;">Password Reset</h2>
    <p style="color: #6B7280; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
      Hi ${name}, we received a request to reset your password. Click the button below to set a new password. This link expires in 1 hour.
    </p>
    <a href="${resetUrl}" style="display: block; text-align: center; background: ${BRAND.color}; color: white; padding: 14px 24px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; margin-bottom: 16px;">
      Reset Password
    </a>
    <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0;">
      If you didn't request this, you can safely ignore this email.
    </p>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: email,
    subject: `Password Reset — BuildTrack`,
    html,
  });
}

async function send2FACodeEmail({ name, email, code }) {
  const transporter = createTransporter();

  const html = emailWrapper(`
    <h2 style="color: #111827; font-size: 20px; font-weight: 700; margin: 0 0 8px;">Verification Code</h2>
    <p style="color: #6B7280; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
      Hi ${name}, use the code below to complete your sign-in. This code expires in 10 minutes.
    </p>
    <div style="text-align: center; margin: 0 0 24px;">
      <span style="display: inline-block; background: #F9FAFB; border: 2px solid #E5E7EB; border-radius: 12px; padding: 16px 40px; font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #111827; font-family: monospace;">
        ${code}
      </span>
    </div>
    <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0;">
      If you didn't try to sign in, please change your password immediately.
    </p>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: email,
    subject: `${code} — Your BuildTrack Verification Code`,
    html,
  });
}

async function sendContractorSetupEmail({ contractorName, contactName, email, setupUrl, expiresAt, requestedBy }) {
  const transporter = createTransporter();
  const displayName = escapeHtml(contactName || contractorName || 'there');
  const safeSetupUrl = escapeHtml(setupUrl);
  const expirationLabel = expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }) : 'the date shown in the portal';

  const html = emailWrapper(`
    <h2 style="color: #111827; font-size: 20px; font-weight: 700; margin: 0 0 8px;">Welcome to New Urban Development</h2>
    <p style="color: #6B7280; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
      Hi ${displayName}, welcome to the New Urban Development team. We are glad to have you working with us.
    </p>
    <p style="color: #6B7280; font-size: 14px; line-height: 1.6; margin: 0 0 20px;">
      Our management team has requested that you complete your secure contractor setup in BuildTrack. This keeps our payment records, ACH setup, and year-end 1099 reporting accurate.
    </p>
    <div style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 12px; padding: 18px; margin-bottom: 22px;">
      <p style="font-size: 12px; color: #92400E; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px;">What to do next</p>
      <ol style="color: #374151; font-size: 13px; line-height: 1.7; margin: 0; padding-left: 18px;">
        <li>Click the secure setup link below.</li>
        <li>When the portal opens, BuildTrack will automatically email you a 6-digit 2FA verification code.</li>
        <li>Return to the setup screen, enter the code, and complete the contractor information form.</li>
      </ol>
    </div>
    <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 18px; margin-bottom: 22px;">
      <p style="font-size: 12px; color: #6B7280; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px;">Information requested</p>
      <ul style="color: #374151; font-size: 13px; line-height: 1.7; margin: 0; padding-left: 18px;">
        <li>1099 tax information</li>
        <li>Mailing address and contact information</li>
        <li>ACH payment information</li>
        <li>Insurance and license details, when applicable</li>
      </ul>
    </div>
    <a href="${safeSetupUrl}" style="display: block; text-align: center; background: ${BRAND.color}; color: white; padding: 14px 24px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; margin-bottom: 14px;">
      Complete Secure Contractor Setup
    </a>
    <p style="color: #6B7280; font-size: 12px; line-height: 1.5; margin: 0 0 12px;">
      If the button does not open, copy and paste this secure link into your browser:<br />
      <span style="word-break: break-all; color: #111827;">${safeSetupUrl}</span>
    </p>
    <p style="color: #9CA3AF; font-size: 12px; text-align: center; line-height: 1.5; margin: 0;">
      This secure link requires an email verification code before the form opens and expires on ${escapeHtml(expirationLabel)}.
    </p>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: email,
    subject: `Welcome to New Urban Development - secure contractor setup`,
    html,
  });
}

async function sendContractorSetupCodeEmail({ name, email, code }) {
  const transporter = createTransporter();
  const displayName = escapeHtml(name || 'there');

  const html = emailWrapper(`
    <div style="text-align: center; margin: 0 0 22px;">
      <div style="display: inline-block; background: #ECFDF5; color: #047857; border: 1px solid #A7F3D0; border-radius: 999px; padding: 6px 12px; font-size: 11px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase;">
        Secure verification
      </div>
    </div>
    <h2 style="color: #111827; font-size: 22px; font-weight: 800; text-align: center; margin: 0 0 10px;">Your contractor setup code</h2>
    <p style="color: #6B7280; font-size: 14px; line-height: 1.6; text-align: center; margin: 0 0 24px;">
      Hi ${displayName}, enter this code to open your New Urban Development contractor setup form. This code expires in 10 minutes.
    </p>
    <div style="text-align: center; margin: 0 0 18px;">
      <span style="display: inline-block; background: #111827; border-radius: 16px; padding: 18px 34px; font-size: 34px; font-weight: 900; letter-spacing: 9px; color: #ffffff; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;">
        ${code}
      </span>
    </div>
    <p style="color: #6B7280; font-size: 12px; line-height: 1.6; text-align: center; margin: 0 0 16px;">
      The setup portal works on iPhone, Android, tablets, and desktop browsers.
    </p>
    <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0;">
      If you did not request this code, you can safely ignore this email.
    </p>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: email,
    subject: `Your New Urban contractor setup code: ${code}`,
    html,
  });
}

async function sendInvoiceEmail({ invoice, project, contractor, pdfBuffer }) {
  const transporter = createTransporter();
  const invoiceEmail = process.env.INVOICE_EMAIL || 'invoices@newurbandev.com';
  const desktopUrl = invoice.desktop_url || invoice.desktopUrl || `${BRAND.url}/invoices`;
  const desktopInvoicesUrl = invoice.desktop_invoices_url || `${BRAND.url}/invoices`;

  const subject = `Invoice #${invoice.invoice_number} - ${project.address}`;
  const html = emailWrapper(`
    <h2 style="color: #111827; font-size: 20px; font-weight: 700; margin: 0 0 16px;">New Invoice Submitted</h2>
    <table style="width:100%; border-collapse: collapse; margin-bottom: 16px;">
      <tr><td style="padding:8px; border:1px solid #E5E7EB; font-size: 13px; color: #6B7280;"><strong>Invoice #</strong></td><td style="padding:8px; border:1px solid #E5E7EB; font-size: 13px;">${invoice.invoice_number}</td></tr>
      <tr><td style="padding:8px; border:1px solid #E5E7EB; font-size: 13px; color: #6B7280;"><strong>Project</strong></td><td style="padding:8px; border:1px solid #E5E7EB; font-size: 13px;">${project.address}</td></tr>
      <tr><td style="padding:8px; border:1px solid #E5E7EB; font-size: 13px; color: #6B7280;"><strong>Contractor</strong></td><td style="padding:8px; border:1px solid #E5E7EB; font-size: 13px;">${contractor.name}</td></tr>
      <tr><td style="padding:8px; border:1px solid #E5E7EB; font-size: 13px; color: #6B7280;"><strong>Total</strong></td><td style="padding:8px; border:1px solid #E5E7EB; font-size: 13px;">$${Number(invoice.total || 0).toFixed(2)}</td></tr>
    </table>
    <a href="${desktopUrl}" style="display: block; text-align: center; background: ${BRAND.color}; color: white; padding: 14px 24px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; margin-bottom: 12px;">
      View Invoice in BuildTrack
    </a>
    <p style="color: #6B7280; font-size: 12px; text-align: center; margin: 0 0 16px;">
      Main invoice dashboard: <a href="${desktopInvoicesUrl}" style="color: ${BRAND.color};">${desktopInvoicesUrl}</a>
    </p>
    ${pdfBuffer ? '<p style="color: #6B7280; font-size: 13px;">See attached PDF for full invoice details.</p>' : ''}
  `);

  const attachments = pdfBuffer ? [{
    filename: `invoice-${invoice.invoice_number}.pdf`,
    content: pdfBuffer,
    contentType: 'application/pdf',
  }] : [];

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || 'noreply@newurbandev.com',
    to: invoiceEmail,
    subject,
    html,
    attachments,
  });

  if (contractor.email) {
    await sendBrandedMail(transporter, {
      from: process.env.EMAIL_FROM || 'noreply@newurbandev.com',
      to: contractor.email,
      subject: `[Your Copy] ${subject}`,
      html,
      attachments,
    });
  }
}

async function sendApprovedPayNotificationEmail({ approvedInvoices, approvedInvoice, approvedBy, newlyApproved }) {
  const transporter = createTransporter();
  const operationsEmail = process.env.APPROVED_INVOICE_NOTIFY_EMAIL || 'info@newurbandev.com';
  const appUrl = (process.env.APP_URL || BRAND.url || 'https://buildtrack.newurbandev.com').replace(/\/$/, '');
  const rows = Array.isArray(approvedInvoices) ? approvedInvoices : [];
  const total = rows.reduce((sum, invoice) => sum + Number(invoice.quickbooks_balance ?? invoice.total ?? 0), 0);
  const approvedLabel = approvedInvoice
    ? `${approvedInvoice.external_invoice_number || approvedInvoice.invoice_number || approvedInvoice.id} - ${approvedInvoice.vendor_name || approvedInvoice.contractor_name || 'Contractor'}`
    : 'Approved invoice queue';

  // When an approval burst is digested, `newlyApproved` carries every bill approved
  // in that burst so the email names all of them, not just a single one.
  const justApproved = Array.isArray(newlyApproved) ? newlyApproved.filter(Boolean) : [];
  const justApprovedTotal = justApproved.reduce(
    (sum, item) => sum + Number(item.quickbooks_balance ?? item.total ?? 0),
    0
  );
  const approverName = escapeHtml(approvedBy || 'A BuildTrack user');
  const approvalIntro = justApproved.length
    ? `${approverName} approved ${justApproved.length} invoice${justApproved.length === 1 ? '' : 's'} for payment, totaling $${justApprovedTotal.toFixed(2)}.`
    : `${approverName} approved an invoice for payment.`;
  const newApprovalHeading = justApproved.length > 1 ? 'New approvals' : 'New approval';
  const newApprovalBody = justApproved.length
    ? justApproved.map(item => `
      <p style="font-size:14px; color:#111827; font-weight:700; margin:0 0 6px;">
        ${escapeHtml(item.vendor_name || item.contractor_name || 'Contractor')}
        &nbsp;&middot;&nbsp; ${escapeHtml(item.external_invoice_number || item.invoice_number || item.id || '')}
        &nbsp;&middot;&nbsp; <span style="font-weight:400; color:#6B7280;">${escapeHtml(item.address || item.job_name || 'Project not listed')}</span>
        &nbsp;&mdash;&nbsp; $${Number(item.quickbooks_balance ?? item.total ?? 0).toFixed(2)}
      </p>
    `).join('')
    : `<p style="font-size:14px; color:#111827; font-weight:700; margin:0;">${escapeHtml(approvedLabel)}</p>`;

  const invoiceRows = rows.length
    ? rows.map(invoice => `
      <tr>
        <td style="padding:10px; border:1px solid #E5E7EB; font-size:12px; color:#111827;">
          <strong>${escapeHtml(invoice.vendor_name || invoice.contractor_name || 'Unassigned contractor')}</strong><br />
          <span style="color:#6B7280;">${escapeHtml(invoice.vendor_email || invoice.contractor_email || '')}</span>
        </td>
        <td style="padding:10px; border:1px solid #E5E7EB; font-size:12px; color:#111827;">
          ${escapeHtml(invoice.external_invoice_number || invoice.invoice_number || invoice.id)}
        </td>
        <td style="padding:10px; border:1px solid #E5E7EB; font-size:12px; color:#111827;">
          ${escapeHtml(invoice.address || invoice.job_name || 'Project not listed')}
        </td>
        <td style="padding:10px; border:1px solid #E5E7EB; font-size:12px; color:#111827; text-align:right;">
          $${Number(invoice.quickbooks_balance ?? invoice.total ?? 0).toFixed(2)}
        </td>
      </tr>
    `).join('')
    : `<tr><td colspan="4" style="padding:12px; border:1px solid #E5E7EB; font-size:13px; color:#6B7280;">No approved invoices are currently queued.</td></tr>`;

  const html = emailWrapper(`
    <h2 style="color:#111827; font-size:20px; font-weight:800; margin:0 0 8px;">BuildTrack approved invoices ready for payment review</h2>
    <p style="color:#6B7280; font-size:14px; line-height:1.6; margin:0 0 18px;">
      ${approvalIntro} QuickBooks remains the accounting source of truth for final paid/unpaid balances.
    </p>
    <div style="background:#FFFBEB; border:1px solid #FDE68A; border-radius:12px; padding:16px; margin-bottom:18px;">
      <p style="font-size:12px; color:#92400E; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px;">${newApprovalHeading}</p>
      ${newApprovalBody}
    </div>
    <table style="width:100%; border-collapse:collapse; margin-bottom:18px;">
      <thead>
        <tr>
          <th style="padding:9px; border:1px solid #E5E7EB; background:#F9FAFB; color:#374151; font-size:11px; text-align:left; text-transform:uppercase;">Contractor</th>
          <th style="padding:9px; border:1px solid #E5E7EB; background:#F9FAFB; color:#374151; font-size:11px; text-align:left; text-transform:uppercase;">Invoice</th>
          <th style="padding:9px; border:1px solid #E5E7EB; background:#F9FAFB; color:#374151; font-size:11px; text-align:left; text-transform:uppercase;">Project</th>
          <th style="padding:9px; border:1px solid #E5E7EB; background:#F9FAFB; color:#374151; font-size:11px; text-align:right; text-transform:uppercase;">Amount Due</th>
        </tr>
      </thead>
      <tbody>${invoiceRows}</tbody>
    </table>
    <div style="background:#ECFDF5; border:1px solid #A7F3D0; border-radius:12px; padding:16px; margin-bottom:18px;">
      <p style="font-size:12px; color:#047857; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 6px;">Current approved-to-pay balance</p>
      <p style="font-size:24px; color:#065F46; font-weight:900; margin:0;">$${total.toFixed(2)}</p>
    </div>
    <a href="${appUrl}/invoices" style="display:block; text-align:center; background:${BRAND.color}; color:white; padding:14px 24px; border-radius:12px; text-decoration:none; font-weight:800; font-size:14px;">
      Open BuildTrack Invoices
    </a>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: operationsEmail,
    subject: `BuildTrack approved invoices ready to pay - $${total.toFixed(2)}`,
    html,
  });
}

function formatReminderDateTime(value) {
  if (!value) return 'Not scheduled';
  const parsed = new Date(String(value).includes('T') ? value : `${value}Z`);
  if (!Number.isFinite(parsed.getTime())) return String(value);
  return parsed.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

async function sendCalendarReminderEmail({ recipients, subject, message, event, project, createdBy, scheduleLabel }) {
  const transporter = createTransporter();
  const appUrl = (process.env.APP_URL || BRAND.url || 'https://buildtrack.newurbandev.com').replace(/\/$/, '');
  const projectUrl = event?.project_id ? `${appUrl}/projects/${event.project_id}` : appUrl;
  const recipientList = Array.isArray(recipients) ? recipients.filter(Boolean) : [];
  const eventTitle = event?.title || subject || 'BuildTrack calendar reminder';
  const projectLabel = project?.address || project?.job_name || event?.project_address || 'BuildTrack';
  const reminderMessage = message || event?.description || 'This is a scheduled BuildTrack reminder.';
  const html = emailWrapper(`
    <h2 style="color:#111827; font-size:20px; font-weight:800; margin:0 0 8px;">${escapeHtml(eventTitle)}</h2>
    <p style="color:#6B7280; font-size:14px; line-height:1.6; margin:0 0 18px;">
      ${escapeHtml(reminderMessage).replace(/\n/g, '<br />')}
    </p>
    <div style="background:#F9FAFB; border:1px solid #E5E7EB; border-radius:12px; padding:16px; margin-bottom:18px;">
      <p style="font-size:12px; color:#92400E; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px;">Calendar reminder</p>
      <p style="font-size:13px; color:#374151; margin:0 0 8px;"><strong>Project:</strong> ${escapeHtml(projectLabel)}</p>
      <p style="font-size:13px; color:#374151; margin:0 0 8px;"><strong>Calendar date:</strong> ${escapeHtml(formatReminderDateTime(event?.scheduled_for ? `${event.scheduled_for}T12:00:00` : null))}</p>
      ${event?.due_time ? `<p style="font-size:13px; color:#374151; margin:0 0 8px;"><strong>Calendar time:</strong> ${escapeHtml(event.due_time)}</p>` : ''}
      ${scheduleLabel ? `<p style="font-size:13px; color:#374151; margin:0;"><strong>Schedule:</strong> ${escapeHtml(scheduleLabel)}</p>` : ''}
    </div>
    <a href="${projectUrl}" style="display:block; text-align:center; background:${BRAND.color}; color:white; padding:14px 24px; border-radius:12px; text-decoration:none; font-weight:800; font-size:14px;">
      Open in BuildTrack
    </a>
    <p style="color:#9CA3AF; font-size:11px; text-align:center; margin:14px 0 0;">
      Sent by ${escapeHtml(createdBy || 'BuildTrack')} from info@newurbandev.com.
    </p>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.CALENDAR_REMINDER_EMAIL_FROM || 'New Urban Development <info@newurbandev.com>',
    to: recipientList.join(', '),
    subject: subject || `BuildTrack reminder: ${eventTitle}`,
    html,
  });
}

async function sendVendorQuoteRequestEmail({ vendorName, vendorEmail, project, requestUrl, expiresAt, message, scopes, includePhotos, requestedBy }) {
  const transporter = createTransporter();
  const safeUrl = escapeHtml(requestUrl);
  const displayName = escapeHtml(vendorName || 'there');
  const rawProjectLabel = project?.public_label || project?.city || 'BuildTrack project';
  const subjectProjectLabel = project?.job_name || project?.address || rawProjectLabel;
  const projectLabel = escapeHtml(rawProjectLabel);
  const scopedItems = Array.isArray(scopes) ? scopes : [];
  const scopeRows = scopedItems.map((scope, scopeIndex) => {
    const details = scopeLineItems(scope.scope_of_work);
    const executionItems = Array.isArray(scope.execution_items) ? scope.execution_items : [];
    const lines = details.length
      ? details
      : executionItems.map(item => [item.title, item.description].filter(Boolean).join(' - ')).filter(Boolean);
    const fallbackLines = lines.length ? lines : [scope.scope_title || 'Selected scope item'];
    return `
      <tr>
        <td style="padding:14px 0; border-top:${scopeIndex === 0 ? 'none' : '1px solid #E5E7EB'};">
          <p style="font-size:12px; color:#92400E; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 5px;">${escapeHtml(scope.section_name || 'Scope')}</p>
          <p style="font-size:15px; color:#111827; font-weight:800; margin:0 0 8px;">${scopeIndex + 1}. ${escapeHtml(scope.scope_title || 'Scope item')}</p>
          <ol style="margin:0; padding-left:22px; color:#374151; font-size:13px; line-height:1.55;">
            ${fallbackLines.map(item => `<li style="margin:0 0 6px;">${escapeHtml(item)}</li>`).join('')}
          </ol>
        </td>
      </tr>
    `;
  }).join('');
  const scopePhotos = scopedItems.flatMap(scope => (
    Array.isArray(scope.photos)
      ? scope.photos.map(photo => ({
          ...photo,
          scope_title: scope.scope_title,
          url: absoluteUrl(photo.url),
        }))
      : []
  )).filter(photo => photo.url);
  const photoRows = [];
  for (let index = 0; index < scopePhotos.length; index += 3) {
    const row = scopePhotos.slice(index, index + 3);
    photoRows.push(`
      <tr>
        ${row.map(photo => `
          <td style="width:33.333%; padding:4px; vertical-align:top;">
            <a href="${escapeHtml(photo.url)}" style="display:block; text-decoration:none;">
              <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.original_name || photo.scope_title || 'Scope photo')}" width="160" height="108" style="display:block; width:100%; height:108px; object-fit:cover; border-radius:10px; border:1px solid #E5E7EB;" />
            </a>
          </td>
        `).join('')}
        ${Array.from({ length: 3 - row.length }).map(() => '<td style="width:33.333%; padding:4px;"></td>').join('')}
      </tr>
    `);
  }
  const expirationLabel = expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }) : 'the date shown on the quote page';

  const html = emailWrapper(`
    <h2 style="color:#111827; font-size:20px; font-weight:800; margin:0 0 8px;">Quote requested for ${projectLabel}</h2>
    <p style="color:#6B7280; font-size:14px; line-height:1.6; margin:0 0 18px;">
      Hi ${displayName}, New Urban Development is requesting pricing for the selected scope of work in BuildTrack.
    </p>
    ${message ? `
      <div style="background:#F9FAFB; border:1px solid #E5E7EB; border-radius:12px; padding:16px; margin-bottom:18px;">
        <p style="font-size:12px; color:#92400E; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px;">Message</p>
        <p style="font-size:13px; color:#374151; line-height:1.6; margin:0;">${escapeHtml(message).replace(/\n/g, '<br />')}</p>
      </div>
    ` : ''}
    <div style="background:#F9FAFB; border:1px solid #E5E7EB; border-radius:12px; padding:16px; margin-bottom:18px;">
      <p style="font-size:12px; color:#6B7280; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 10px;">Scope included</p>
      <table role="presentation" style="width:100%; border-collapse:collapse;">
        <tbody>${scopeRows || '<tr><td style="font-size:13px; color:#374151;">Selected project scope of work</td></tr>'}</tbody>
      </table>
      <p style="font-size:12px; color:#6B7280; line-height:1.5; margin:12px 0 0;">
        Contractors can enter a price for each scope line item or enter one total amount at the bottom of the secure quote link.
      </p>
    </div>
    ${includePhotos ? `
      <div style="background:#FFFFFF; border:1px solid #E5E7EB; border-radius:12px; padding:12px; margin-bottom:18px;">
        <p style="font-size:12px; color:#6B7280; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px;">Scope photos</p>
        ${photoRows.length ? `
          <table role="presentation" style="width:100%; border-collapse:collapse;">
            <tbody>${photoRows.join('')}</tbody>
          </table>
        ` : '<p style="font-size:12px; color:#6B7280; line-height:1.5; margin:0;">No photos were attached to this request.</p>'}
      </div>
    ` : ''}
    <a href="${safeUrl}" style="display:block; text-align:center; background:${BRAND.color}; color:white; padding:14px 24px; border-radius:12px; text-decoration:none; font-weight:800; font-size:14px; margin-bottom:14px;">
      Review Scope And Submit Price
    </a>
    <p style="color:#6B7280; font-size:12px; line-height:1.5; margin:0 0 12px;">
      If the button does not open, copy and paste this link into your browser:<br />
      <span style="word-break:break-all; color:#111827;">${safeUrl}</span>
    </p>
    <p style="color:#9CA3AF; font-size:11px; text-align:center; line-height:1.5; margin:0;">
      Requested by ${escapeHtml(requestedBy || 'BuildTrack')}. This quote link expires on ${escapeHtml(expirationLabel)}.
    </p>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: BRAND.quoteInbox,
    bcc: vendorEmail,
    replyTo: process.env.EMAIL_REPLY_TO || 'info@newurbandev.com',
    subject: `Quote requested from New Urban Development - ${subjectProjectLabel}`,
    html,
  });
}

function formatPayDate(value) {
  if (!value) return null;
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

async function sendContractorInvoiceReceivedEmail({
  vendorName,
  vendorEmail,
  amount,
  payDate,
  receivedDate,
  invoiceNumber,
  projectLabel,
}) {
  if (!vendorEmail) throw new Error('Missing vendor email');
  if (!payDate) throw new Error('Missing pay date');
  const transporter = createTransporter();
  const questionsEmail = 'info@newurbandev.com';
  const amountLabel = `$${Number(amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const payDateLabel = formatPayDate(payDate);
  const receivedDateLabel = formatPayDate(receivedDate);
  const displayName = String(vendorName || '').trim();

  const html = emailWrapper(`
    <h2 style="color:#111827; font-size:20px; font-weight:800; margin:0 0 8px;">We've received your invoice</h2>
    <p style="color:#6B7280; font-size:14px; line-height:1.6; margin:0 0 18px;">
      ${displayName ? `Hi ${escapeHtml(displayName)},` : 'Hello,'}<br /><br />
      We've received your invoice for <strong style="color:#111827;">${escapeHtml(amountLabel)}</strong> and it has been entered into our payment system.
    </p>
    <div style="background:#ECFDF5; border:1px solid #A7F3D0; border-radius:12px; padding:16px; margin-bottom:18px;">
      <p style="font-size:12px; color:#047857; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 6px;">You will be paid on</p>
      <p style="font-size:22px; color:#065F46; font-weight:900; margin:0;">${escapeHtml(payDateLabel)}</p>
    </div>
    <div style="background:#F9FAFB; border:1px solid #E5E7EB; border-radius:12px; padding:16px; margin-bottom:18px;">
      <p style="font-size:12px; color:#374151; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px;">Invoice details</p>
      ${invoiceNumber ? `<p style="font-size:13px; color:#374151; margin:0 0 8px;"><strong>Invoice number:</strong> ${escapeHtml(invoiceNumber)}</p>` : ''}
      <p style="font-size:13px; color:#374151; margin:0 0 8px;"><strong>Amount:</strong> ${escapeHtml(amountLabel)}</p>
      ${receivedDateLabel ? `<p style="font-size:13px; color:#374151; margin:0 0 8px;"><strong>Invoice date:</strong> ${escapeHtml(receivedDateLabel)}</p>` : ''}
      <p style="font-size:13px; color:#374151; margin:0 0 8px;"><strong>Scheduled payment date:</strong> ${escapeHtml(payDateLabel)}</p>
      ${projectLabel ? `<p style="font-size:13px; color:#374151; margin:0;"><strong>Property:</strong> ${escapeHtml(projectLabel)}</p>` : ''}
    </div>
    <div style="background:#FFFBEB; border:1px solid #FDE68A; border-radius:12px; padding:16px; margin-bottom:4px;">
      <p style="font-size:12px; color:#92400E; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px;">Questions?</p>
      <p style="font-size:13px; color:#374151; line-height:1.6; margin:0 0 8px;">
        If you have any questions about your payment or our contractor payment process, reply or email
        <a href="mailto:${escapeHtml(questionsEmail)}" style="color:#065F46; font-weight:700;">${escapeHtml(questionsEmail)}</a>.
        This is the fastest way to get an answer.
      </p>
      <p style="font-size:13px; color:#374151; line-height:1.6; margin:0;">
        <strong>Please do not text or call Mike Seifert or Heather about invoices or payments.</strong>
        After an invoice is received, all payment inquiries are handled through email only.
      </p>
    </div>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: vendorEmail,
    replyTo: questionsEmail,
    subject: `Invoice received - payment scheduled for ${payDateLabel}${invoiceNumber ? ` (Invoice ${invoiceNumber})` : ''}`,
    html,
  });
}

async function sendQuoteApprovedEmail({
  vendorName,
  vendorEmail,
  ccEmail,
  quoteNumber,
  approvedAmount,
  projectLabel,
}) {
  if (!vendorEmail) throw new Error('Missing vendor email');
  const transporter = createTransporter();
  const questionsEmail = 'info@newurbandev.com';
  const amountLabel = approvedAmount === null || approvedAmount === undefined || approvedAmount === ''
    ? null
    : `$${Number(approvedAmount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const displayName = String(vendorName || '').trim();

  const html = emailWrapper(`
    <h2 style="color:#111827; font-size:20px; font-weight:800; margin:0 0 8px;">Your quote has been approved</h2>
    <p style="color:#6B7280; font-size:14px; line-height:1.6; margin:0 0 18px;">
      ${displayName ? `Hi ${escapeHtml(displayName)},` : 'Hello,'}<br /><br />
      Good news &mdash; your quote${quoteNumber ? ` <strong style="color:#111827;">${escapeHtml(quoteNumber)}</strong>` : ''}${amountLabel ? ` in the amount of <strong style="color:#111827;">${escapeHtml(amountLabel)}</strong>` : ''} has been approved by our office.
    </p>
    <div style="background:#ECFDF5; border:1px solid #A7F3D0; border-radius:12px; padding:16px; margin-bottom:18px;">
      <p style="font-size:12px; color:#047857; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 6px;">What happens next</p>
      <p style="font-size:15px; color:#065F46; font-weight:700; line-height:1.5; margin:0;">A member of our office will be contacting you shortly to schedule the job and coordinate the details.</p>
    </div>
    <div style="background:#F9FAFB; border:1px solid #E5E7EB; border-radius:12px; padding:16px; margin-bottom:18px;">
      <p style="font-size:12px; color:#374151; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px;">Approval details</p>
      ${quoteNumber ? `<p style="font-size:13px; color:#374151; margin:0 0 8px;"><strong>Quote number:</strong> ${escapeHtml(quoteNumber)}</p>` : ''}
      ${amountLabel ? `<p style="font-size:13px; color:#374151; margin:0 0 8px;"><strong>Approved amount:</strong> ${escapeHtml(amountLabel)}</p>` : ''}
      ${projectLabel ? `<p style="font-size:13px; color:#374151; margin:0;"><strong>Property:</strong> ${escapeHtml(projectLabel)}</p>` : ''}
    </div>
    <div style="background:#FFFBEB; border:1px solid #FDE68A; border-radius:12px; padding:16px; margin-bottom:4px;">
      <p style="font-size:12px; color:#92400E; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 8px;">Questions?</p>
      <p style="font-size:13px; color:#374151; line-height:1.6; margin:0;">
        No action is needed from you right now &mdash; our office will reach out to you. If you have any questions in the meantime, reply to this email or write to
        <a href="mailto:${escapeHtml(questionsEmail)}" style="color:#065F46; font-weight:700;">${escapeHtml(questionsEmail)}</a>.
      </p>
    </div>
  `);

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: vendorEmail,
    cc: ccEmail || undefined,
    replyTo: questionsEmail,
    subject: `Your quote has been approved${quoteNumber ? ` (${quoteNumber})` : ''}`,
    html,
  });
}

// Email / Send Punch List: one contractor's punch list for one property.
// `items` carry title/description/notes/priority/status/due_date and
// photos[{ url }] (signed, expiring /uploads links, at most a dozen per item).
async function sendPunchListEmail({ contractorName, contactName, email, ccEmail, project, items, message, sentByName }) {
  if (!email) throw new Error('Missing contractor email');
  const transporter = createTransporter();
  const questionsEmail = 'info@newurbandev.com';
  const address = String(project?.address || project?.job_name || 'the property').trim();
  const greetName = String(contactName || contractorName || '').trim();
  const list = Array.isArray(items) ? items : [];
  const priorityColor = { urgent: '#B91C1C', high: '#C2410C', medium: '#1D4ED8', low: '#6B7280' };
  const formatDue = (value) => {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const rows = list.map((item, index) => {
    const photos = Array.isArray(item.photos) ? item.photos.filter(photo => photo && photo.url) : [];
    const meta = [
      `<span style="color:${priorityColor[item.priority] || '#6B7280'}; font-weight:800; text-transform:uppercase; letter-spacing:0.5px;">${escapeHtml(item.priority || 'medium')}</span>`,
      escapeHtml(String(item.status || 'not_started').replace(/_/g, ' ')),
      item.due_date ? `due ${escapeHtml(formatDue(item.due_date))}` : '',
      photos.length ? photos.map((photo, photoIndex) => `<a href="${escapeHtml(photo.url)}" style="color:#1D4ED8; font-weight:700;">photo ${photoIndex + 1}</a>`).join(', ') : '',
    ].filter(Boolean).join(' &middot; ');
    return `
      <tr>
        <td style="padding:10px 8px 10px 0; border-top:1px solid #E5E7EB; vertical-align:top; width:26px; font-size:13px; font-weight:800; color:#9CA3AF;">${index + 1}.</td>
        <td style="padding:10px 0; border-top:1px solid #E5E7EB; vertical-align:top;">
          <p style="margin:0; font-size:14px; font-weight:800; color:#111827;">${escapeHtml(item.title)}</p>
          ${item.description ? `<p style="margin:4px 0 0; font-size:13px; color:#374151; line-height:1.5;">${escapeHtml(item.description)}</p>` : ''}
          ${item.notes ? `<p style="margin:4px 0 0; font-size:12px; color:#6B7280; line-height:1.5;">${escapeHtml(item.notes)}</p>` : ''}
          <p style="margin:6px 0 0; font-size:12px; color:#6B7280;">${meta}</p>
        </td>
      </tr>`;
  }).join('');

  const html = emailWrapper(`
    <h2 style="color:#111827; font-size:20px; font-weight:800; margin:0 0 8px;">Punch list: ${escapeHtml(address)}</h2>
    <p style="color:#6B7280; font-size:14px; line-height:1.6; margin:0 0 18px;">
      ${greetName ? `Hi ${escapeHtml(greetName)},` : 'Hello,'}<br /><br />
      Below ${list.length === 1 ? 'is the punch list item' : `are the ${list.length} punch list items`} we need you to complete at
      <strong style="color:#111827;">${escapeHtml(address)}</strong>.${sentByName ? ` Sent by ${escapeHtml(sentByName)}.` : ''}
    </p>
    ${message ? `
    <div style="background:#FFFBEB; border:1px solid #FDE68A; border-radius:12px; padding:14px 16px; margin-bottom:18px;">
      <p style="font-size:12px; color:#92400E; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 6px;">Note from our office</p>
      <p style="font-size:14px; color:#374151; line-height:1.6; margin:0;">${escapeHtml(message).replace(/\r?\n/g, '<br />')}</p>
    </div>` : ''}
    <div style="background:#F9FAFB; border:1px solid #E5E7EB; border-radius:12px; padding:4px 16px 8px; margin-bottom:18px;">
      <p style="font-size:12px; color:#374151; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:12px 0 4px;">Punch list items (${list.length})</p>
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>
    <div style="background:#ECFDF5; border:1px solid #A7F3D0; border-radius:12px; padding:14px 16px; margin-bottom:4px;">
      <p style="font-size:12px; color:#047857; font-weight:800; text-transform:uppercase; letter-spacing:1px; margin:0 0 6px;">Questions?</p>
      <p style="font-size:13px; color:#374151; line-height:1.6; margin:0;">
        Reply to this email or write to <a href="mailto:${escapeHtml(questionsEmail)}" style="color:#065F46; font-weight:700;">${escapeHtml(questionsEmail)}</a>. Please let us know when the items are complete.
      </p>
    </div>
  `);

  const text = [
    `Punch list: ${address}`,
    '',
    message ? `${message}\n` : '',
    ...list.map((item, index) => {
      const photos = Array.isArray(item.photos) ? item.photos.filter(photo => photo && photo.url) : [];
      return `${index + 1}. ${item.title}${item.description ? ` - ${item.description}` : ''} [${item.priority || 'medium'}${item.due_date ? `, due ${formatDue(item.due_date)}` : ''}]${photos.length ? ` photos: ${photos.map(photo => photo.url).join(' ')}` : ''}`;
    }),
    '',
    `Questions? ${questionsEmail}`,
  ].join('\n');

  await sendBrandedMail(transporter, {
    from: process.env.EMAIL_FROM || brandedFrom(),
    to: email,
    cc: ccEmail || undefined,
    replyTo: questionsEmail,
    subject: `Punch list for ${address} (${list.length} item${list.length === 1 ? '' : 's'})`,
    html,
    text,
  });
}

module.exports = {
  isEmailConfigured,
  sendPunchListEmail,
  sendInvoiceEmail,
  sendApprovedPayNotificationEmail,
  sendContractorInvoiceReceivedEmail,
  sendCalendarReminderEmail,
  sendVendorQuoteRequestEmail,
  sendInviteEmail,
  sendContractorPinEmail,
  sendPasswordResetEmail,
  send2FACodeEmail,
  sendContractorSetupEmail,
  sendContractorSetupCodeEmail,
  sendContractorSubmissionPdfEmail,
  sendQuoteApprovedEmail,
};
