const nodemailer = require('nodemailer');

function createTransporter() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    // Return a test transporter that logs instead of sending
    return {
      sendMail: async (opts) => {
        console.log('[EMAIL MOCK] Would send email:');
        console.log('  To:', opts.to);
        console.log('  Subject:', opts.subject);
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

async function sendInvoiceEmail({ invoice, project, contractor, pdfBuffer }) {
  const transporter = createTransporter();
  const companyName = process.env.COMPANY_NAME || 'New Urban Developments';
  const invoiceEmail = process.env.INVOICE_EMAIL || 'invoices@newurbandev.com';

  const subject = `Invoice #${invoice.invoice_number} - ${project.address}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>${companyName}</h2>
      <p>A new invoice has been submitted.</p>
      <table style="width:100%; border-collapse: collapse;">
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Invoice #</strong></td><td style="padding:8px; border:1px solid #ddd;">${invoice.invoice_number}</td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Project</strong></td><td style="padding:8px; border:1px solid #ddd;">${project.address}</td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Contractor</strong></td><td style="padding:8px; border:1px solid #ddd;">${contractor.name}</td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Total</strong></td><td style="padding:8px; border:1px solid #ddd;">$${invoice.total.toFixed(2)}</td></tr>
        <tr><td style="padding:8px; border:1px solid #ddd;"><strong>Submitted</strong></td><td style="padding:8px; border:1px solid #ddd;">${new Date().toLocaleString()}</td></tr>
      </table>
      ${pdfBuffer ? '<p>See attached PDF for full invoice details.</p>' : ''}
    </div>
  `;

  const attachments = pdfBuffer ? [{
    filename: `invoice-${invoice.invoice_number}.pdf`,
    content: pdfBuffer,
    contentType: 'application/pdf',
  }] : [];

  // Send to invoice email
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@newurbandev.com',
    to: invoiceEmail,
    subject,
    html,
    attachments,
  });

  // Send copy to contractor
  if (contractor.email) {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'noreply@newurbandev.com',
      to: contractor.email,
      subject: `[Your Copy] ${subject}`,
      html: `<p>This is your copy of the submitted invoice.</p>${html}`,
      attachments,
    });
  }
}

module.exports = { sendInvoiceEmail };
