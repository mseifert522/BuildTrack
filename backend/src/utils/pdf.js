const PDFDocument = require('pdfkit');

function generateInvoicePDF({ invoice, lineItems, project, contractor }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const buffers = [];

    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const companyName = process.env.COMPANY_NAME || 'New Urban Developments';
    const companyAddress = process.env.COMPANY_ADDRESS || '';
    const companyPhone = process.env.COMPANY_PHONE || '';

    // Header
    doc.fontSize(22).font('Helvetica-Bold').text(companyName, 50, 50);
    doc.fontSize(10).font('Helvetica');
    if (companyAddress) doc.text(companyAddress);
    if (companyPhone) doc.text(companyPhone);
    doc.text('invoices@newurbandev.com');

    // Invoice title
    doc.moveDown(1);
    doc.fontSize(18).font('Helvetica-Bold').text('INVOICE', { align: 'right' });
    doc.fontSize(10).font('Helvetica');
    doc.text(`Invoice #: ${invoice.invoice_number}`, { align: 'right' });
    doc.text(`Date: ${new Date(invoice.created_at).toLocaleDateString()}`, { align: 'right' });
    if (invoice.submitted_at) {
      doc.text(`Submitted: ${new Date(invoice.submitted_at).toLocaleDateString()}`, { align: 'right' });
    }

    // Divider
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.5);

    // Bill To / Project Info
    doc.fontSize(11).font('Helvetica-Bold').text('PROJECT DETAILS');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Address: ${project.address}`);
    doc.text(`Job Name: ${project.job_name}`);
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica-Bold').text('FROM');
    doc.fontSize(10).font('Helvetica');
    doc.text(contractor.name);
    if (contractor.email) doc.text(contractor.email);
    if (contractor.phone) doc.text(contractor.phone);
    if (contractor.company) doc.text(contractor.company);

    // Line items table
    doc.moveDown(1.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.5);

    // Table header
    const tableTop = doc.y;
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text('DESCRIPTION', 50, tableTop, { width: 380 });
    doc.text('AMOUNT', 430, tableTop, { width: 120, align: 'right' });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.3);

    // Line items
    doc.font('Helvetica');
    let total = 0;
    for (const item of lineItems) {
      const y = doc.y;
      doc.text(item.description, 50, y, { width: 380 });
      doc.text(`$${parseFloat(item.amount).toFixed(2)}`, 430, y, { width: 120, align: 'right' });
      doc.moveDown(0.3);
      total += parseFloat(item.amount) || 0;
    }

    // Total
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold');
    doc.text('TOTAL', 50, doc.y, { width: 380 });
    doc.text(`$${total.toFixed(2)}`, 430, doc.y - doc.currentLineHeight(), { width: 120, align: 'right' });

    // Notes
    if (invoice.notes) {
      doc.moveDown(2);
      doc.fontSize(10).font('Helvetica-Bold').text('NOTES:');
      doc.font('Helvetica').text(invoice.notes);
    }

    // Status
    doc.moveDown(2);
    doc.fontSize(9).fillColor('#888888').text(`Status: ${invoice.status.toUpperCase()}`, { align: 'center' });

    doc.end();
  });
}

module.exports = { generateInvoicePDF };
