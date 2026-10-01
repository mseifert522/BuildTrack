'use strict';
// One place that decides "is this vendor already in the directory?" and "is this a
// name we can file a vendor under?". Used by the vendor setup portal, the quick
// Add Vendor dialog, and quote intake (Mike, 2026-10-01: every quote added to
// BuildTrack puts its vendor in Contractors / Suppliers; a quote whose vendor
// cannot be read emails the office for clarification instead).
const { v4: uuidv4 } = require('uuid');
const { normalizeEmail } = require('./contractorAccess');

function normalizeVendorName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function cleanVendorName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s\-–—_,.;:|/\\*#'"]+|[\s\-–—_,;:|/\\*#'"]+$/g, '')
    .trim()
    .slice(0, 150);
}

// The same name without its legal form, so "Oak Roofing" finds "Oak Roofing LLC".
const LEGAL_SUFFIXES = /\b(l\.?\s?l\.?\s?c|p\.?\s?l\.?\s?l\.?\s?c|l\.?\s?l\.?\s?p|l\.?\s?p|inc(orporated)?|corp(oration)?|co(mpany)?|ltd|limited)\b\.?/gi;
function looseVendorKey(value) {
  const stripped = String(value || '').replace(/^\s*the\s+/i, '').replace(/&/g, ' and ').replace(LEGAL_SUFFIXES, ' ');
  return normalizeVendorName(stripped);
}

// Exact (letters + digits) name match on the name we file the vendor under or on
// its QuickBooks names - the same identity the directory already merges rows on.
// When nothing matches exactly, the same names compared without their legal form
// (LLC, Inc, Co...). Linked-to-QuickBooks profiles win ties, then the most
// recently updated.
function findVendorByName(db, name) {
  const key = normalizeVendorName(name);
  if (key.length < 3) return null;
  const rows = db.prepare(`
    SELECT id, vendor_name, quickbooks_display_name, quickbooks_company_name, quickbooks_print_on_check_name,
           quickbooks_vendor_id, updated_at
    FROM contractor_profiles
  `).all();
  const namesOf = row => [row.vendor_name, row.quickbooks_display_name, row.quickbooks_company_name, row.quickbooks_print_on_check_name];
  let candidates = rows.filter(row => namesOf(row).some(candidate => candidate && normalizeVendorName(candidate) === key));
  if (!candidates.length) {
    const loose = looseVendorKey(name);
    if (loose.length >= 4) {
      candidates = rows.filter(row => namesOf(row).some(candidate => candidate && looseVendorKey(candidate) === loose));
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(Boolean(b.quickbooks_vendor_id)) - Number(Boolean(a.quickbooks_vendor_id))
    || String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  const best = candidates[0];
  return { id: best.id, vendor_name: best.vendor_name, quickbooks_vendor_id: best.quickbooks_vendor_id, match_kind: 'name' };
}

function findVendorByEmail(db, email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  const row = db.prepare(`
    SELECT id, vendor_name, quickbooks_vendor_id
    FROM contractor_profiles
    WHERE lower(trim(COALESCE(email, ''))) = ? OR lower(trim(COALESCE(quickbooks_primary_email, ''))) = ?
    ORDER BY quickbooks_vendor_id IS NOT NULL DESC, julianday(updated_at) DESC
    LIMIT 1
  `).get(normalizedEmail, normalizedEmail);
  return row ? { ...row, match_kind: 'email' } : null;
}

// Vendor setup portal rule: an email match on the profile or its QuickBooks record
// is decisive; otherwise an exact name match.
function findMatchingVendor(db, { email, companyName }) {
  return findVendorByEmail(db, email) || findVendorByName(db, companyName);
}

// Words that are a label or a placeholder, never a business name.
const PLACEHOLDER_NAMES = new Set([
  'unknown', 'unknownvendor', 'unknowncontractor', 'unknowncompany', 'na', 'nslasha', 'none', 'null', 'undefined',
  'nil', 'tbd', 'tba', 'vendor', 'vendorname', 'contractor', 'contractorname', 'company', 'companyname', 'name',
  'customer', 'client', 'owner', 'quote', 'estimate', 'proposal', 'invoice', 'bid', 'bill', 'billto', 'soldto',
  'notlisted', 'notprovided', 'notfound', 'notavailable', 'notapplicable', 'unreadable', 'illegible', 'blank',
  'seeattached', 'unnamed', 'unnamedprovider', 'unnamedvendor', 'nocompany', 'novendor', 'nocontractor', 'nonameprovided',
]);

// Our own names appear on every quote as the customer ("Bill to: New Urban
// Development") - reading one of them as the vendor is the classic misread.
const OWN_COMPANY_KEYS = ['newurbandevelopment', 'newurbandev', 'seifertcapital'];

// Can this name be filed as a vendor? Returns { readable, name, reason, ours }.
// `context.projectAddress` rejects the property address read as the vendor;
// `context.staffKeys` (normalized names of our own team) rejects a staff member.
// `ours` marks a name that is OUR side of the quote (company, address, staff):
// the contact name next to it is then ours too, so it is no fallback.
function assessVendorName(rawName, context = {}) {
  const name = cleanVendorName(rawName);
  const key = normalizeVendorName(name);
  if (!name || !key) return { readable: false, name: '', reason: 'No vendor name was found on the quote.' };
  if (name.includes('�')) return { readable: false, name, reason: `The vendor name came through garbled ("${name}").` };
  const letters = (name.match(/[a-z]/gi) || []).length;
  if (letters < 2) return { readable: false, name, reason: `"${name}" is not a business name.` };
  if (key.length < 3) return { readable: false, name, reason: `"${name}" is too short to identify a vendor.` };
  const symbols = (name.match(/[^a-z0-9\s&.,'()\-/#@+]/gi) || []).length;
  if (symbols > 0 && symbols / name.length > 0.25) {
    return { readable: false, name, reason: `The vendor name came through garbled ("${name}").` };
  }
  if (PLACEHOLDER_NAMES.has(key)) return { readable: false, name, reason: `"${name}" is a placeholder, not the vendor's name.` };
  if (OWN_COMPANY_KEYS.some(own => key.includes(own)) || key === 'nud') {
    return { readable: false, ours: true, name, reason: `"${name}" is our own company (the customer on the quote), not the vendor.` };
  }
  const address = String(context.projectAddress || '');
  if (address) {
    const addressKey = normalizeVendorName(address);
    const streetKey = normalizeVendorName(address.split(',')[0]);
    if (key === addressKey || (streetKey.length >= 6 && key === streetKey)) {
      return { readable: false, ours: true, name, reason: `"${name}" is the property address, not the vendor.` };
    }
  }
  if (context.staffKeys && context.staffKeys.has(key)) {
    return { readable: false, ours: true, name, reason: `"${name}" is a member of our own team, not the vendor.` };
  }
  return { readable: true, name, reason: null };
}

// Normalized names of everyone on our side (non-contractor logins).
function staffNameKeys(db) {
  try {
    return new Set(db.prepare("SELECT name FROM users WHERE role <> 'contractor' AND name IS NOT NULL").all()
      .map(row => normalizeVendorName(row.name))
      .filter(key => key.length >= 3));
  } catch (_) {
    return new Set();
  }
}

// Best-effort trade for a vendor created from a quote: the quote's own category
// mapped onto the directory's contractor categories ("Roofing" -> "Roof").
function contractorCategoryForQuote(db, quoteCategory) {
  const quoteKey = normalizeVendorName(quoteCategory);
  if (!quoteKey) return null;
  let names = [];
  try {
    names = db.prepare('SELECT name FROM contractor_categories').all().map(row => row.name);
  } catch (_) {
    names = [];
  }
  const exact = names.find(item => normalizeVendorName(item) === quoteKey);
  if (exact) return exact;
  const prefix = names
    .filter(item => {
      const itemKey = normalizeVendorName(item);
      return itemKey.length >= 4 && quoteKey.startsWith(itemKey);
    })
    .sort((a, b) => normalizeVendorName(b).length - normalizeVendorName(a).length);
  return prefix[0] || null;
}

function parseFlags(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) {
    return [];
  }
}

// Adds one vendor (contractor) record from a document. No mobile login is made.
// Callers check findVendorByName/Email first; source records where it came from.
function insertVendorProfile(db, { name, contact = null, email = null, phone = null, address = null, category = null, source = 'quote' }) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO contractor_profiles (
      id, vendor_name, contact_name, email, phone, billing_address, contractor_status,
      contractor_category, contractor_categories_json, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    cleanVendorName(name),
    String(contact || '').trim().slice(0, 150) || null,
    normalizeEmail(email) || null,
    String(phone || '').trim().slice(0, 40) || null,
    String(address || '').trim().slice(0, 300) || null,
    category || null,
    JSON.stringify(category ? [category] : []),
    source
  );
  return id;
}

const NEEDS_VENDOR_FLAG = 'vendor_needs_clarification';

// Put the vendor of a just-saved quote into the directory. Never throws for a data
// problem: the quote is already saved; the outcome says what happened.
//   linked              - matched a vendor already in the system
//   created             - a new vendor was added from the quote
//   needs_clarification - the vendor's name could not be read; nothing was added
//   unchanged           - the quote was already tied to a vendor
// Runs inside its own transaction (better-sqlite3 is synchronous, so two quotes
// from the same new vendor cannot both create it).
function ensureQuoteVendor(db, quoteId, { actorId = null } = {}) {
  return db.transaction(() => {
    const quote = db.prepare(`
      SELECT q.*, p.address AS project_address_live
      FROM contractor_quotes q
      LEFT JOIN projects p ON p.id = q.project_id
      WHERE q.id = ?
    `).get(quoteId);
    if (!quote) return { status: 'missing' };

    const flags = parseFlags(quote.data_quality_flags);
    const setFlag = (present) => {
      const next = flags.filter(flag => flag !== NEEDS_VENDOR_FLAG);
      if (present) next.push(NEEDS_VENDOR_FLAG);
      if (next.length !== flags.length || next.some((flag, i) => flag !== flags[i])) {
        db.prepare("UPDATE contractor_quotes SET data_quality_flags = ?, updated_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(next), quote.id);
      }
    };
    const link = (profile) => {
      db.prepare("UPDATE contractor_quotes SET contractor_profile_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(profile.id, quote.id);
    };

    if (quote.contractor_profile_id) {
      const existing = db.prepare('SELECT id, vendor_name FROM contractor_profiles WHERE id = ?').get(quote.contractor_profile_id);
      if (existing) {
        setFlag(false);
        return { status: 'unchanged', contractor_id: existing.id, vendor_name: existing.vendor_name };
      }
    }

    const context = { projectAddress: quote.project_address_live || quote.property_address, staffKeys: staffNameKeys(db) };
    const company = assessVendorName(quote.contractor_company, context);
    // When the "company" read is our own side, the contact beside it is ours too.
    const person = company.ours
      ? { readable: false, name: cleanVendorName(quote.contractor_name), reason: company.reason }
      : assessVendorName(quote.contractor_name, context);

    // 1. A contractor login already tied to a directory record.
    if (quote.contractor_id) {
      const byUser = db.prepare('SELECT id, vendor_name FROM contractor_profiles WHERE linked_user_id = ? ORDER BY julianday(updated_at) DESC LIMIT 1')
        .get(quote.contractor_id);
      if (byUser) {
        link(byUser);
        setFlag(false);
        return { status: 'linked', contractor_id: byUser.id, vendor_name: byUser.vendor_name, match_kind: 'login' };
      }
    }
    // 2. The business name, then the contact name, then the email on the quote.
    const byName = (company.readable && findVendorByName(db, company.name))
      || (person.readable && findVendorByName(db, person.name))
      || (!company.ours && findVendorByEmail(db, quote.contractor_email));
    if (byName) {
      link(byName);
      setFlag(false);
      return { status: 'linked', contractor_id: byName.id, vendor_name: byName.vendor_name, match_kind: byName.match_kind };
    }

    // 3. Nothing matched: add the vendor, filed under its business name when the
    //    quote has one, otherwise under the person who signed it.
    const filing = company.readable ? company : person.readable ? person : null;
    if (!filing) {
      setFlag(true);
      const reason = (quote.contractor_company || '').trim() || !(quote.contractor_name || '').trim()
        ? company.reason
        : person.reason;
      return {
        status: 'needs_clarification',
        read_name: (company.name || person.name || '').slice(0, 150),
        reason: reason || 'The vendor name on the quote could not be read.',
      };
    }

    const topCategory = db.prepare(`
      SELECT category, COUNT(*) AS n FROM quote_line_items WHERE quote_id = ? AND category IS NOT NULL AND category <> ''
      GROUP BY category ORDER BY n DESC LIMIT 1
    `).get(quote.id);
    const category = contractorCategoryForQuote(db, topCategory?.category);
    const contactName = person.readable && normalizeVendorName(person.name) !== normalizeVendorName(filing.name)
      ? person.name
      : null;
    const email = normalizeEmail(quote.contractor_email) || null;
    const id = insertVendorProfile(db, {
      name: filing.name,
      contact: contactName,
      email,
      phone: quote.contractor_phone,
      address: quote.contractor_address,
      category,
      source: 'quote',
    });
    link({ id });
    setFlag(false);
    return { status: 'created', contractor_id: id, vendor_name: filing.name, category, created_by: actorId };
  })();
}

module.exports = {
  NEEDS_VENDOR_FLAG,
  normalizeVendorName,
  looseVendorKey,
  parseFlags,
  contractorCategoryForQuote,
  insertVendorProfile,
  staffNameKeys,
  cleanVendorName,
  findVendorByName,
  findVendorByEmail,
  findMatchingVendor,
  assessVendorName,
  ensureQuoteVendor,
};
