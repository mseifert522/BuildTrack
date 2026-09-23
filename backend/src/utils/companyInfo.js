// New Urban Development's public contact block, as published on newurbandev.com
// (the street is Stephenson Hwy, often written "Stevenson"). Vendor emails and
// the public vendor setup portal both read it from here, so change it only here.
const NUD_COMPANY = Object.freeze({
  name: 'New Urban Development',
  street: '850 Stephenson Hwy, Suite 115',
  cityStateZip: 'Troy, MI 48083',
  phone: '(248) 621-4722',
  phoneHref: 'tel:+12486214722',
  email: 'info@newurbandev.com',
  hours: 'Monday - Friday, 9:00 AM - 4:30 PM',
  website: 'https://newurbandev.com',
});

// Mike's vendor payment policy (2026-09-23). Shown in the vendor setup email and on
// the portal, where the vendor must accept it before submitting.
const PAYMENT_POLICY = Object.freeze({
  title: 'Our Payment Policy',
  greeting: 'Dear Valued Vendor,',
  paragraphs: Object.freeze([
    'We are excited to work with you. Before any work begins, please take a moment to review our payment policy.',
    'New Urban Development pays its vendors on a bi-weekly schedule. Many construction companies pay on 30-day terms, and some take as long as 90 days; we pay our vendors sooner than that. Because our office processes a high volume of invoices each week, invoices are not paid in the same week they are submitted. For example, an invoice submitted on a Tuesday will be paid on Friday of the following week.',
    'If you are unable to work under this payment policy, please contact our office before any work begins. We are only able to hire vendors who can accept these payment terms.',
  ]),
  // One-sentence reminder for the vendor's confirmation email.
  summary: 'New Urban Development pays vendors on a bi-weekly schedule, and invoices are not paid in the same week they are submitted. For example, an invoice submitted on a Tuesday will be paid on Friday of the following week.',
  acceptance: 'I have read New Urban Development\'s payment policy and agree to its bi-weekly payment schedule.',
});

module.exports = { NUD_COMPANY, PAYMENT_POLICY };
