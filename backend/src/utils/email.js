const nodemailer = require('nodemailer');

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

module.exports = { sendInvoiceEmail, sendInviteEmail, sendPasswordResetEmail, send2FACodeEmail };
