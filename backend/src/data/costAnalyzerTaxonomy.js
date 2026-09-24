// Cost Analyzer taxonomy - the single list of cost categories every Cost Analyzer
// module shares (schema seeding, vendor classification, bill keyword rules, stats,
// the API and the frontend pickers).
//
// The category ids here are an independent namespace from contractor_categories.id
// (the user-extendable Vendors page list). The only bridge between the two lists is
// the exact category NAME; nothing may join them by id.
'use strict';

/**
 * Cost categories in display order. `aliases` are regex sources (no flags, no
 * anchors) that name this category in free text such as a QuickBooks bill memo, a
 * bill line description or a vendor's company name. They feed KEYWORD_RULES below.
 *
 * kind: 'trade' = labor crews (implied $/hr applies), 'supplier' = stores and
 * distributors, 'service' = fees/rentals/utilities, 'other' = Uncategorized only.
 *
 * NOTE: there is deliberately NO "management fee" alias anywhere - the owner's rule
 * is that a carpenter's "Management Fee" bill stays with the carpenter's category.
 * @type {Array<{id: string, name: string, kind: 'trade'|'supplier'|'service'|'other', sort_order: number, aliases: string[]}>}
 */
const CATEGORIES = [
  { id: 'carpentry', name: 'Carpenter', kind: 'trade', sort_order: 10,
    aliases: ['carpentry', 'carpenters?', 'framing', 'finish carpentry', 'rough carpentry', 'decks?', 'decking', 'cabinet install(?:ation)?', 'door install(?:ation)?', 'shoe molding', 'trim work'] },
  { id: 'general-contractor', name: 'General Contractor', kind: 'trade', sort_order: 20,
    aliases: ['general contractors?', 'gc', 'remodel(?:ing|er|ers)?', 'renovations?', 'construction'] },
  { id: 'handyman', name: 'Handymen', kind: 'trade', sort_order: 30,
    aliases: ['handym[ae]n', 'punch[- ]?list', 'odd jobs', 'small repairs?', 'repair invoice'] },
  { id: 'demolition', name: 'Demolition and Junk Removal', kind: 'trade', sort_order: 40,
    aliases: ['demo', 'demolition', 'junk removal', 'junk', 'tear[- ]?out', 'tear[- ]?down', 'gut(?:ting)?', 'abatement', 'clean[- ]?out', 'trash pickup', 'trash removal', 'remove trash'] },
  { id: 'dumpster-and-hauling', name: 'Dumpster and Hauling', kind: 'service', sort_order: 50,
    aliases: ['dumpsters?', 'hauling', 'haul[- ]?away', 'roll[- ]?off', 'debris removal', 'disposal'] },
  { id: 'cleaning', name: 'Cleaning', kind: 'service', sort_order: 60,
    aliases: ['cleaning', 'house cleaning', 'final clean', 'deep clean', 'power[- ]?wash(?:ing)?', 'pressure[- ]?wash(?:ing)?', 'janitorial', 'maid service'] },
  { id: 'concrete-and-masonry', name: 'Concrete, Masonry and Driveways', kind: 'trade', sort_order: 70,
    aliases: ['concrete', 'driveways?', 'masonry', 'footings?', 'foundation(?: walls?)?', 'flatwork', 'brick(?:work)?', 'block work', 'sidewalks?', 'cement', 'stamped concrete', 'porch steps?', 'pavers?'] },
  { id: 'excavation-and-site-work', name: 'Excavation and Site Work', kind: 'trade', sort_order: 80,
    aliases: ['excavat(?:ion|ing|e|or|ors)', 'grading', 'site work', 'dirt work', 'backfill', 'pea stone', 'groundcover', 'trenching', 'lot clearing', 'fill dirt'] },
  { id: 'waterproofing', name: 'Waterproofing', kind: 'trade', sort_order: 90,
    aliases: ['waterproof(?:ing)?', 'foundation seal(?:ing)?', 'drain tile'] },
  { id: 'drywall', name: 'Drywall', kind: 'trade', sort_order: 100,
    aliases: ['drywall', 'sheetrock', 'plaster(?:ing)?', 'gypsum', 'taping', 'skim coat'] },
  { id: 'painting', name: 'Painting', kind: 'trade', sort_order: 110,
    aliases: ['paint(?:ing|ed|er|ers)?', 'primer', 'priming', 'stain(?:ing)?'] },
  { id: 'electrical', name: 'Electrical', kind: 'trade', sort_order: 120,
    aliases: ['electric(?:al|ian|ians)?', 'wiring', 'rewire', 'panel upgrades?', 'meter (?:change|changes|upgrade|upgrades)', 'circuits?', 'outlets?', 'breakers?', 'light fixtures?', 'lighting'] },
  { id: 'plumbing', name: 'Plumbing', kind: 'trade', sort_order: 130,
    aliases: ['plumbing', 'plumbers?', 'sewer', 'drains?', 'drain cleaning', 'water heaters?', 'backflow', 'main line', 'gas line', 'faucets?', 'toilets?', 'rooter', 'pipes?', 'piping'] },
  { id: 'hvac', name: 'HVAC', kind: 'trade', sort_order: 140,
    aliases: ['hvac', 'furnaces?', 'a\\/c', 'ac units?', 'air condition(?:ing|er|ers)', 'ductwork', 'ducts?', 'venting', 'heating (?:and|&) cooling', 'mini[- ]?splits?', 'condensers?', 'heat pumps?', 'boilers?'] },
  { id: 'roofing', name: 'Roof', kind: 'trade', sort_order: 150,
    aliases: ['roofs?', 'roofing', 'shingles?', 're-?roof(?:ing)?', 'flat roof', 'roof repair', 'tear[- ]?off'] },
  { id: 'gutters', name: 'Gutters', kind: 'trade', sort_order: 160,
    aliases: ['gutters?', 'downspouts?', 'gutter guards?', 'eavestrough'] },
  { id: 'siding', name: 'Siding', kind: 'trade', sort_order: 170,
    aliases: ['siding', 'soffit', 'fascia', 'aluminum wrap', 'house wrap', 'hardie'] },
  { id: 'insulation', name: 'Insulation', kind: 'trade', sort_order: 180,
    aliases: ['insulation', 'insulate', 'insulating', 'spray foam', 'blown[- ]?in', 'batts?'] },
  { id: 'windows-and-doors', name: 'Windows and Doors', kind: 'trade', sort_order: 190,
    aliases: ['windows?', 'doors?', 'window install(?:ation)?', 'entry doors?', 'storm doors?', 'glass block', 'egress'] },
  { id: 'garage-doors', name: 'Garage Doors', kind: 'trade', sort_order: 200,
    aliases: ['garage doors?', 'overhead doors?', 'door openers?', 'garage door openers?', 'garage repair'] },
  { id: 'flooring', name: 'Floor', kind: 'trade', sort_order: 210,
    aliases: ['flooring', 'floors?', 'carpet(?:ing)?', 'hardwood', 'laminate floor(?:ing)?', 'vinyl plank', 'lvp', 'lvt', 'epoxy', 'floor coating', 'refinish(?:ing)?', 'sand and finish'] },
  { id: 'tile-and-stone', name: 'Tile and Stone', kind: 'trade', sort_order: 220,
    aliases: ['tiles?', 'tiling', 'tile setter', 'backsplash', 'grout(?:ing)?', 'marble', 'stone work'] },
  { id: 'cabinets-and-countertops', name: 'Cabinets and Countertops', kind: 'trade', sort_order: 230,
    aliases: ['cabinets?', 'cabinetry', 'countertops?', 'counter tops?', 'quartz', 'granite', 'formica', 'laminate (?:counter|counters|top|tops)', 'vanity tops?', 'butcher block'] },
  { id: 'landscaping', name: 'Landscaping', kind: 'trade', sort_order: 240,
    aliases: ['landscap(?:e|ing|er|ers)', 'lawn(?: care| maintenance| service)?', 'sod', 'mulch', 'tree (?:removal|service|trimming|clearing)', 'yard[- ]?clean[- ]?up', 'grass seed', 'irrigation', 'sprinklers?', 'snow removal', 'hydroseed(?:ing)?'] },
  { id: 'fencing', name: 'Fencing', kind: 'trade', sort_order: 250,
    aliases: ['fenc(?:e|es|ing)', 'fence install(?:ation)?', 'privacy fence', 'chain link'] },
  { id: 'engineering-and-inspection', name: 'Engineering and Inspection', kind: 'service', sort_order: 260,
    aliases: ['survey(?:or|ors|ing|s)?', 'engineering', 'engineers?', 'asbestos (?:survey|test|testing)', 'soil (?:test|boring)', 'inspections?', 'architect(?:ural|s)?', 'design invoice', 'structural', 'testing solutions'] },
  { id: 'permits-and-fees', name: 'Permits and Government Fees', kind: 'service', sort_order: 270,
    aliases: ['permits?', 'permit fees?', 'city of', 'township', 'county', 'building department', 'water (?:bill|fees?)', 'tap fees?', 'hookup fees?', 'certificate of occupancy', 'zoning', 'plan review'] },
  { id: 'building-materials', name: 'General Building Materials', kind: 'supplier', sort_order: 280,
    aliases: ['building materials?', 'lumber', 'plywood', 'osb', 'hardware', 'supply', 'supplies', 'home depot', 'lowe\'?s', 'menards?', 'materials?', 'fasteners?', 'screws', 'nails'] },
  { id: 'paint-supplies', name: 'Paint', kind: 'supplier', sort_order: 290,
    aliases: ['paint(?:s|ing)?', 'primer', 'stain', 'sherwin', 'benjamin moore', 'behr'] },
  { id: 'appliances', name: 'Appliances', kind: 'supplier', sort_order: 300,
    aliases: ['appliances?', 'refrigerators?', 'fridge', 'ranges?', 'stoves?', 'ovens?', 'dishwashers?', 'microwaves?', 'washers?', 'dryers?'] },
  { id: 'fixtures-and-furnishings', name: 'Fixtures and Furnishings', kind: 'supplier', sort_order: 310,
    aliases: ['fixtures?', 'lighting', 'light fixtures?', 'vanit(?:y|ies)', 'faucets?', 'furnishings?', 'furniture', 'decor', 'blinds', 'mirrors?', 'ceiling fans?', 'wayfair'] },
  { id: 'equipment-rentals', name: 'Equipment Rentals', kind: 'service', sort_order: 320,
    aliases: ['equipment rentals?', 'rentals?', 'scaffold(?:ing)?', 'lift rental', 'sunbelt', 'porta[- ]?potty', 'portable toilets?', 'tool rental'] },
  { id: 'utilities-and-services', name: 'Utilities and Services', kind: 'service', sort_order: 330,
    aliases: ['dte', 'consumers energy', 'gas bill', 'electric bill', 'utility', 'utilities', 'insurance', 'internet', 'software', 'subscription', 'storage unit'] },
  { id: 'uncategorized', name: 'Uncategorized', kind: 'other', sort_order: 999, aliases: [] },
];

/** Every category id, in display order. @type {string[]} */
const CATEGORY_IDS = CATEGORIES.map(category => category.id);

/** id -> category row. @type {Record<string, {id: string, name: string, kind: string, sort_order: number, aliases: string[]}>} */
const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map(category => [category.id, category]));

/** The fallback category id for vendors nobody has classified yet. */
const UNCATEGORIZED_ID = 'uncategorized';

/** Spend types derived from the QuickBooks expense account on a bill line. */
const SPEND_TYPES = ['rehab', 'new_construction', 'maintenance', 'other'];

/**
 * Map a QBO expense account name to a spend type.
 * Accounts seen in production: '1265 Projects:New Construction' -> new_construction;
 * '1240 Projects:Capital Improvements' and '5730 ... ST - Rehab Costs' -> rehab;
 * '6150 Repairs - Maintenance - HOA fees' and '1252 Projects:Carried - Maintenance /
 * Repairs' -> maintenance; anything else (or no account) -> other.
 * @param {string|null|undefined} accountName
 * @returns {'rehab'|'new_construction'|'maintenance'|'other'}
 */
function spendTypeForAccount(accountName) {
  const name = String(accountName || '').toLowerCase();
  if (!name) return 'other';
  if (name.includes('new construction')) return 'new_construction';
  if (name.includes('capital improvement') || name.includes('rehab')) return 'rehab';
  if (name.includes('maintenance') || name.includes('repair')) return 'maintenance';
  return 'other';
}

/** Material families an extracted invoice line can belong to (spec 2.1). */
const MATERIAL_FAMILIES = [
  'doors', 'windows', 'countertops', 'cabinets', 'flooring', 'tile', 'drywall', 'insulation',
  'roofing', 'siding', 'gutters', 'paint', 'lumber_and_framing', 'electrical', 'plumbing', 'hvac',
  'appliances', 'hardware_and_fasteners', 'concrete_and_masonry', 'landscaping',
  'fixtures_and_lighting', 'cleaning_and_consumables', 'demolition', 'other',
];

/** Work phases an extracted line can carry (spec 2.1). */
const PHASES = ['rough', 'final', 'service_call', 'repair', 'install', 'n_a'];

/** What an extracted line is (spec 2.1). */
const ITEM_KINDS = ['labor', 'material', 'labor_and_material', 'fee', 'credit', 'other'];

/** Units of measure an extracted line can be priced in (spec 2.1). */
const UNITS = ['each', 'sqft', 'lf', 'sheet', 'gal', 'hr', 'day', 'week', 'lot', 'ton', 'yard', 'other'];

/** Document types the extractor can recognise (spec 2.1). */
const DOC_TYPES = ['invoice', 'receipt', 'estimate', 'statement', 'work_completion_form', 'other'];

/**
 * Vendor kinds a labor-side keyword rule may fire for. 'other' is the Uncategorized
 * vendor, which has no kind of its own yet, so trade and service rules may classify it.
 * Supplier vendors never receive a trade or service category from a keyword (spec 4.1).
 */
const LABOR_KINDS = ['trade', 'service', 'other'];
const SUPPLIER_KINDS = ['supplier'];

/**
 * Ordered rule spec. First match wins, so specific rules (garage doors) sit before
 * generic ones (windows and doors) and trades sit before the catch-all general
 * contractor / handyman rules.
 *
 * `overrides` = the spec 4.1 (b) list: keywords that name a trade clearly different
 * from the vendor's own and therefore re-categorise a single bill even for a vendor
 * that already has a real category. Rules without it only apply when the vendor is
 * Uncategorized or a General Contractor (spec 4.1 (a)).
 */
const RULE_SPEC = [
  ['garage-doors', LABOR_KINDS, true],
  ['hvac', LABOR_KINDS, true],
  ['electrical', LABOR_KINDS, true],
  ['plumbing', LABOR_KINDS, true],
  ['roofing', LABOR_KINDS, true],
  ['siding', LABOR_KINDS, true],
  ['gutters', LABOR_KINDS, true],
  ['insulation', LABOR_KINDS, true],
  ['drywall', LABOR_KINDS, true],
  ['tile-and-stone', LABOR_KINDS, true],
  ['flooring', LABOR_KINDS, true],
  ['cabinets-and-countertops', LABOR_KINDS, false],
  ['windows-and-doors', LABOR_KINDS, true],
  ['concrete-and-masonry', LABOR_KINDS, true],
  ['waterproofing', LABOR_KINDS, false],
  ['excavation-and-site-work', LABOR_KINDS, false],
  ['demolition', LABOR_KINDS, true],
  ['dumpster-and-hauling', LABOR_KINDS, true],
  ['cleaning', LABOR_KINDS, true],
  ['painting', LABOR_KINDS, true],
  ['landscaping', LABOR_KINDS, false],
  ['fencing', LABOR_KINDS, false],
  ['engineering-and-inspection', LABOR_KINDS, false],
  ['permits-and-fees', LABOR_KINDS, false],
  ['carpentry', LABOR_KINDS, false],
  ['handyman', LABOR_KINDS, false],
  ['general-contractor', LABOR_KINDS, false],
  ['equipment-rentals', LABOR_KINDS, false],
  ['utilities-and-services', LABOR_KINDS, false],
  // Supplier-side rules: a supplier vendor may only move between supplier categories
  // (e.g. a General Building Materials store billing "Paint Materials" -> Paint).
  ['paint-supplies', SUPPLIER_KINDS, true],
  ['appliances', SUPPLIER_KINDS, true],
  ['fixtures-and-furnishings', SUPPLIER_KINDS, true],
  ['building-materials', SUPPLIER_KINDS, false],
];

/**
 * Keyword rules used both to classify a single bill on read (spec 4.1) and to guess
 * a category for vendors nobody has categorised (autoCategorizeVendors).
 * `pattern` is a word-bounded, case-insensitive RegExp without the global flag, so
 * `.test()` is stateless. `kinds` = vendor kinds the rule may fire for.
 * @type {Array<{pattern: RegExp, category_id: string, kinds: string[], overrides: boolean}>}
 */
const KEYWORD_RULES = RULE_SPEC.map(([categoryId, kinds, overrides]) => {
  const category = CATEGORY_BY_ID[categoryId];
  return {
    pattern: new RegExp(`\\b(?:${category.aliases.join('|')})\\b`, 'i'),
    category_id: categoryId,
    kinds: kinds.slice(),
    overrides,
  };
});

/**
 * Categories for which every keyword rule applies (spec 4.1 (a)): the vendor has no
 * real category, or is a general contractor whose bills span many trades.
 */
const OPEN_VENDOR_CATEGORIES = new Set([UNCATEGORIZED_ID, 'general-contractor']);

/**
 * Find the keyword rule that re-categorises `text` for a vendor of category
 * `vendorCategoryId`, with the match details (used for rationales).
 *
 * Rules (spec 4.1): a rule may fire only for the vendor's kind (supplier vendors
 * only get supplier categories, never a trade); if any matching rule names the
 * vendor's own category the bill is the vendor's own work and nothing overrides it;
 * otherwise the first matching rule wins when the vendor is Uncategorized / General
 * Contractor, or when the rule is in the "clearly another trade" list.
 * @param {string|null|undefined} text - bill memo + line descriptions (or a vendor name)
 * @param {string|null|undefined} vendorCategoryId - the vendor's current category id (null = uncategorized)
 * @returns {{ category_id: string, matched: string, rule: object } | null}
 */
function keywordMatchFor(text, vendorCategoryId) {
  const haystack = String(text || '');
  if (!haystack.trim()) return null;
  const vendorId = vendorCategoryId && CATEGORY_BY_ID[vendorCategoryId] ? vendorCategoryId : UNCATEGORIZED_ID;
  const vendorKind = CATEGORY_BY_ID[vendorId].kind;
  const open = OPEN_VENDOR_CATEGORIES.has(vendorId);

  let winner = null;
  for (const rule of KEYWORD_RULES) {
    if (!rule.kinds.includes(vendorKind)) continue;
    const match = rule.pattern.exec(haystack);
    if (!match) continue;
    // The bill names the vendor's own trade: it is their work, no override.
    if (rule.category_id === vendorId) return null;
    if (winner) continue;
    if (open || rule.overrides) {
      winner = { category_id: rule.category_id, matched: match[0], rule };
    }
  }
  return winner;
}

/**
 * Keyword category for a bill (or vendor name), or null when no rule applies.
 * Never returns 'uncategorized'.
 * @param {string|null|undefined} text
 * @param {string|null|undefined} vendorCategoryId
 * @returns {string|null}
 */
function keywordCategoryFor(text, vendorCategoryId) {
  const match = keywordMatchFor(text, vendorCategoryId);
  return match ? match.category_id : null;
}

module.exports = {
  CATEGORIES,
  CATEGORY_IDS,
  CATEGORY_BY_ID,
  UNCATEGORIZED_ID,
  SPEND_TYPES,
  spendTypeForAccount,
  MATERIAL_FAMILIES,
  PHASES,
  ITEM_KINDS,
  UNITS,
  DOC_TYPES,
  KEYWORD_RULES,
  keywordCategoryFor,
  keywordMatchFor,
};
