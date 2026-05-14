const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

function createTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || process.env.SMTP_PASS === 'REPLACE_WITH_RESEND_API_KEY') {
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
  });
}

const BRAND = {
  name: 'New Urban Development',
  color: '#D99D26',
  url: process.env.APP_URL || 'https://buildtrack.newurbandev.com',
};

function emailWrapper(content) {
  return `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 560px; margin: 0 auto; background: #ffffff;">
      <div style="background: linear-gradient(135deg, #0D1117, #181D25); padding: 32px 24px; text-align: center; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; font-size: 22px; font-weight: 800; margin: 0;">${BRAND.name}</h1>
        <p style="color: ${BRAND.color}; font-size: 12px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; margin: 6px 0 0;">BuildTrack Platform</p>
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

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `BuildTrack <noreply@newurbandev.com>`,
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

async function sendInviteEmail({ name, email, tempPassword, role, invitedBy, pin }) {
  const transporter = createTransporter();
  const roleLabel = role.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  const html = emailWrapper(`
    <h2 style="color: #111827; font-size: 20px; font-weight: 700; margin: 0 0 8px;">Welcome to BuildTrack, ${name}!</h2>
    <p style="color: #6B7280; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
      You've been invited by <strong>${invitedBy}</strong> to join the BuildTrack platform as a <strong>${roleLabel}</strong>.
    </p>
    <div style="background: #F9FAFB; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
      <p style="font-size: 12px; color: #6B7280; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 12px;">Your Login Credentials</p>
      <table style="width: 100%;">
        <tr><td style="padding: 6px 0; font-size: 13px; color: #6B7280;">Email</td><td style="padding: 6px 0; font-size: 13px; color: #111827; font-weight: 600;">${email}</td></tr>
        <tr><td style="padding: 6px 0; font-size: 13px; color: #6B7280;">Temporary Password</td><td style="padding: 6px 0; font-size: 13px; color: #111827; font-weight: 600; font-family: monospace;">${tempPassword}</td></tr>
        ${pin ? `<tr><td style="padding: 6px 0; font-size: 13px; color: #6B7280;">Quick Access PIN</td><td style="padding: 6px 0; font-size: 13px; color: #111827; font-weight: 600; font-family: monospace; font-size: 18px; letter-spacing: 4px;">${pin}</td></tr>` : ''}
      </table>
    </div>
    ${pin ? `<a href="https://invoices.newurbandev.com/app" style="display: block; text-align: center; background: #181D25; color: white; padding: 14px 24px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; margin-bottom: 8px;">Open Mobile App (PIN Login)</a>` : ''}
    <a href="${BRAND.url}" style="display: block; text-align: center; background: ${BRAND.color}; color: white; padding: 14px 24px; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 14px; margin-bottom: 16px;">
      Sign In to BuildTrack
    </a>
    <p style="color: #9CA3AF; font-size: 12px; text-align: center; margin: 0;">
      You'll be asked to change your password on first login.
    </p>
  `);

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `BuildTrack <noreply@newurbandev.com>`,
    to: email,
    subject: `You're invited to BuildTrack — ${BRAND.name}`,
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

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `BuildTrack <noreply@newurbandev.com>`,
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

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `BuildTrack <noreply@newurbandev.com>`,
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

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `BuildTrack <noreply@newurbandev.com>`,
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

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || `BuildTrack <noreply@newurbandev.com>`,
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

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@newurbandev.com',
    to: invoiceEmail,
    subject,
    html,
    attachments,
  });

  if (contractor.email) {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'noreply@newurbandev.com',
      to: contractor.email,
      subject: `[Your Copy] ${subject}`,
      html,
      attachments,
    });
  }
}

module.exports = {
  sendInvoiceEmail,
  sendInviteEmail,
  sendPasswordResetEmail,
  send2FACodeEmail,
  sendContractorSetupEmail,
  sendContractorSetupCodeEmail,
  sendContractorSubmissionPdfEmail,
};
