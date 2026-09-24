// Cost Analyzer canonical material types - collapses the free-text "material type"
// the invoice extractor returns ("Formica top", "HPL laminate", "laminate countertop")
// onto one id per thing the owner wants priced, so unit prices group correctly.
'use strict';

/**
 * Canonical material / job types. The owner's own targets come first (doors,
 * countertops Formica vs quartz, flooring, drywall, roofs, painting, electrical
 * rough & final, plumbing, HVAC).
 *
 * - `synonyms`: phrases that identify this type on their own, in any family.
 * - `weak`: phrases that identify this type only when the extractor already put the
 *   line in this type's family ("final" means electrical_final for an electrical
 *   line and plumbing_final for a plumbing line, so it is never matched globally).
 * Matching is case-insensitive and word-bounded; the longest matching phrase wins.
 * @type {Array<{id: string, family: string, label: string, synonyms: string[], weak: string[]}>}
 */
const MATERIAL_TYPES = [
  // Doors
  { id: 'interior_door', family: 'doors', label: 'Interior door',
    synonyms: ['interior door', 'interior doors', 'prehung door', 'pre-hung door', 'slab door', 'bedroom door', 'closet door', 'bifold door', 'bi-fold door', 'pocket door', 'hollow core door', 'solid core door', 'interior prehung'],
    weak: ['door', 'doors', 'prehung', 'pre-hung', 'slab', 'bifold', 'bi-fold', 'hollow core', 'solid core'] },
  { id: 'exterior_door', family: 'doors', label: 'Exterior door',
    synonyms: ['exterior door', 'exterior doors', 'entry door', 'front door', 'back door', 'side door', 'steel door', 'fiberglass door', 'storm door', 'patio door', 'sliding door', 'slider door', 'french door', 'screen door', 'exterior prehung'],
    weak: ['entry', 'exterior', 'steel', 'fiberglass', 'storm', 'patio', 'sliding', 'slider'] },
  { id: 'garage_door', family: 'doors', label: 'Garage door',
    synonyms: ['garage door', 'garage doors', 'overhead door', 'garage door opener', 'door opener', 'garage door install', 'garage door installation'],
    weak: ['garage', 'opener', 'overhead'] },
  // Windows
  { id: 'window', family: 'windows', label: 'Window',
    synonyms: ['window', 'windows', 'replacement window', 'vinyl window', 'double hung', 'double-hung', 'casement', 'slider window', 'egress window', 'glass block', 'skylight', 'picture window', 'bay window', 'window install', 'window installation'],
    weak: ['vinyl', 'slider', 'egress', 'install'] },
  // Countertops
  { id: 'laminate_countertop', family: 'countertops', label: 'Laminate (Formica) countertop',
    synonyms: ['formica', 'laminate', 'hpl', 'laminate countertop', 'laminate countertops', 'laminate top', 'laminate tops', 'wilsonart', 'post form', 'postform', 'post-form'],
    weak: [] },
  { id: 'quartz_countertop', family: 'countertops', label: 'Quartz countertop',
    synonyms: ['quartz', 'quartz countertop', 'quartz countertops', 'quartz top', 'quartz tops', 'silestone', 'caesarstone', 'cambria', 'engineered stone'],
    weak: [] },
  { id: 'granite_countertop', family: 'countertops', label: 'Granite countertop',
    synonyms: ['granite', 'granite countertop', 'granite countertops', 'granite top', 'granite tops', 'marble countertop', 'marble top'],
    weak: ['marble'] },
  { id: 'butcher_block_countertop', family: 'countertops', label: 'Butcher block countertop',
    synonyms: ['butcher block', 'butcher-block', 'butcherblock', 'wood countertop', 'wood top', 'maple top'],
    weak: ['wood'] },
  // Cabinets
  { id: 'cabinet', family: 'cabinets', label: 'Cabinet',
    synonyms: ['cabinet', 'cabinets', 'cabinetry', 'kitchen cabinets', 'kitchen cabinet', 'vanity cabinet', 'base cabinet', 'wall cabinet', 'cabinet install', 'cabinet installation', 'kraftmaid', 'shaker cabinets', 'shaker cabinet', 'rta cabinets'],
    weak: ['shaker', 'base', 'wall', 'vanity', 'install'] },
  // Flooring
  { id: 'lvp_flooring', family: 'flooring', label: 'Luxury vinyl plank (LVP)',
    synonyms: ['lvp', 'lvt', 'luxury vinyl plank', 'luxury vinyl', 'vinyl plank', 'vinyl planks', 'vinyl flooring', 'vinyl floor', 'vinyl tile', 'plank flooring', 'coretec', 'lifeproof', 'smartcore', 'nucore', 'waterproof plank', 'spc flooring', 'wpc flooring', 'click flooring', 'laminate flooring', 'laminate floor'],
    weak: ['vinyl', 'plank', 'planks', 'laminate', 'spc', 'wpc'] },
  { id: 'carpet', family: 'flooring', label: 'Carpet',
    synonyms: ['carpet', 'carpeting', 'carpet pad', 'carpet install', 'carpet installation', 'carpet and pad', 'carpet & pad'],
    weak: ['pad', 'padding'] },
  { id: 'hardwood_flooring', family: 'flooring', label: 'Hardwood flooring',
    synonyms: ['hardwood', 'hardwood floor', 'hardwood floors', 'hardwood flooring', 'wood floor', 'wood floors', 'wood flooring', 'oak floor', 'oak flooring', 'engineered wood', 'engineered hardwood', 'floor refinish', 'floor refinishing', 'refinish floors', 'sand and finish', 'sand & finish'],
    weak: ['oak', 'refinish', 'refinishing', 'sand', 'maple', 'engineered'] },
  { id: 'tile_flooring', family: 'flooring', label: 'Tile flooring',
    synonyms: ['tile floor', 'tile floors', 'floor tile', 'floor tiles', 'tile flooring', 'porcelain tile', 'ceramic tile', 'porcelain floor', 'ceramic floor', 'tile install', 'tile installation'],
    weak: ['tile', 'tiles', 'porcelain', 'ceramic'] },
  { id: 'floor_coating', family: 'flooring', label: 'Floor coating (epoxy)',
    synonyms: ['epoxy', 'epoxy floor', 'epoxy flooring', 'floor coating', 'floor coatings', 'polyaspartic', 'garage floor coating', 'basement floor coating', 'concrete floor coating'],
    weak: ['coating', 'coatings', 'sealer'] },
  // Drywall
  { id: 'drywall_sheet', family: 'drywall', label: 'Drywall sheet',
    synonyms: ['drywall sheet', 'drywall sheets', 'drywall board', 'drywall boards', 'sheetrock', 'gypsum board', 'gypsum', '1/2 in drywall', '5/8 in drywall', '1/2" drywall', '5/8" drywall', 'moisture resistant drywall', 'green board', 'greenboard', 'cement board', 'durock', 'hardibacker', 'backer board'],
    weak: ['sheet', 'sheets', 'board', 'boards', '1/2 in', '5/8 in', '1/2"', '5/8"', '4x8', '4x12', 'type x'] },
  { id: 'drywall_finish', family: 'drywall', label: 'Drywall hang / tape / finish',
    synonyms: ['hang tape finish', 'hang, tape and finish', 'hang tape and finish', 'tape and finish', 'tape & finish', 'drywall finish', 'drywall finishing', 'drywall labor', 'drywall install', 'drywall installation', 'drywall repair', 'drywall patch', 'skim coat', 'joint compound', 'drywall mud', 'taping and mudding', 'texture', 'knockdown', 'plaster repair'],
    weak: ['finish', 'finishing', 'mud', 'mudding', 'tape', 'taping', 'hang', 'hanging', 'patch', 'labor', 'level 4', 'level 5', 'sanding'] },
  // Insulation
  { id: 'batt_insulation', family: 'insulation', label: 'Batt insulation',
    synonyms: ['batt insulation', 'batt', 'batts', 'fiberglass insulation', 'fiberglass batt', 'fiberglass batts', 'r-13', 'r-15', 'r-19', 'r-21', 'r-30', 'r-38', 'r13', 'r15', 'r19', 'r21', 'r30', 'r38', 'rockwool', 'mineral wool', 'faced insulation', 'unfaced insulation', 'insulation roll'],
    weak: ['fiberglass', 'roll', 'rolls', 'faced', 'unfaced', 'kraft'] },
  { id: 'blown_insulation', family: 'insulation', label: 'Blown-in insulation',
    synonyms: ['blown insulation', 'blown-in insulation', 'blown in insulation', 'blown-in', 'blown in', 'cellulose', 'loose fill', 'loose-fill', 'attic insulation', 'blow in'],
    weak: ['blown', 'attic'] },
  { id: 'spray_foam', family: 'insulation', label: 'Spray foam insulation',
    synonyms: ['spray foam', 'sprayfoam', 'spray-foam', 'closed cell', 'closed-cell', 'open cell', 'open-cell', 'foam insulation', 'rim joist foam'],
    weak: ['foam'] },
  // Roofing
  { id: 'shingle_roof', family: 'roofing', label: 'Shingle roof',
    synonyms: ['shingle', 'shingles', 'asphalt shingle', 'asphalt shingles', 'architectural shingle', 'architectural shingles', 'shingle roof', 'roof replacement', 'new roof', 'reroof', 're-roof', 'roofing', 'roof install', 'roof installation', 'owens corning', 'gaf', 'timberline'],
    weak: ['roof', 'roofs', 'square', 'squares', 'underlayment', 'ice and water', 'ice & water', 'drip edge', 'ridge vent', 'ridge cap'] },
  { id: 'metal_roof', family: 'roofing', label: 'Metal roof',
    synonyms: ['metal roof', 'metal roofing', 'standing seam', 'steel roof', 'steel roofing', 'metal panels', 'metal roof panels'],
    weak: ['metal', 'steel', 'panels'] },
  { id: 'roof_tear_off', family: 'roofing', label: 'Roof tear-off',
    synonyms: ['tear off', 'tear-off', 'tearoff', 'roof tear off', 'roof tear-off', 'roof removal', 'remove old roof', 'remove existing roof', 'roof demo'],
    weak: ['removal', 'remove', 'demo'] },
  // Siding
  { id: 'siding_vinyl', family: 'siding', label: 'Vinyl siding',
    synonyms: ['vinyl siding', 'vinyl'],
    weak: [] },
  { id: 'siding_other', family: 'siding', label: 'Siding (other)',
    synonyms: ['siding', 'hardie', 'hardie board', 'hardieplank', 'fiber cement', 'fiber cement siding', 'aluminum siding', 'aluminum wrap', 'aluminum trim', 'wood siding', 'cedar siding', 'lp smartside', 'smartside', 'board and batten', 'board & batten', 'soffit', 'fascia', 'house wrap', 'tyvek', 'siding install', 'siding installation'],
    weak: ['aluminum', 'cedar', 'wrap', 'trim'] },
  // Gutters
  { id: 'gutters', family: 'gutters', label: 'Gutters',
    synonyms: ['gutter', 'gutters', 'downspout', 'downspouts', 'gutter guard', 'gutter guards', 'seamless gutter', 'seamless gutters', 'new gutters', 'gutter install', 'gutter installation', 'eavestrough'],
    weak: ['seamless', 'guards', 'leaf guard', 'aluminum'] },
  // Paint
  { id: 'interior_paint', family: 'paint', label: 'Interior paint',
    synonyms: ['interior paint', 'interior painting', 'interior paint job', 'paint interior', 'painting interior', 'wall paint', 'ceiling paint', 'trim paint', 'paint walls', 'paint ceilings', 'paint trim', 'interior walls'],
    weak: ['interior', 'walls', 'ceilings', 'ceiling', 'trim', 'paint', 'painting', 'painted', 'eggshell', 'satin', 'semi-gloss', 'flat'] },
  { id: 'exterior_paint', family: 'paint', label: 'Exterior paint',
    synonyms: ['exterior paint', 'exterior painting', 'outside paint', 'outside painting', 'paint exterior', 'painting exterior', 'exterior paint job', 'paint siding', 'paint trim exterior', 'deck stain', 'fence stain', 'exterior stain'],
    weak: ['exterior', 'outside', 'stain', 'staining'] },
  { id: 'primer', family: 'paint', label: 'Primer',
    synonyms: ['primer', 'priming', 'prime coat', 'primer coat', 'kilz', 'zinsser', 'prime walls', 'prime and paint'],
    weak: ['prime'] },
  // Electrical
  { id: 'electrical_rough', family: 'electrical', label: 'Electrical rough-in',
    synonyms: ['electrical rough', 'electrical rough-in', 'electrical rough in', 'rough electrical', 'rough-in electrical', 'rough in electrical', 'rough wiring', 'electric rough'],
    weak: ['rough', 'rough-in', 'rough in', 'wiring', 'wire', 'romex'] },
  { id: 'electrical_final', family: 'electrical', label: 'Electrical final / finish',
    synonyms: ['electrical final', 'electrical finish', 'electrical finishes', 'final electrical', 'finish electrical', 'electrical trim', 'electrical trim out', 'electrical trim-out', 'electric final', 'electric finish'],
    weak: ['final', 'finish', 'finishes', 'trim out', 'trim-out', 'trim', 'devices', 'device install', 'plates', 'cover plates'] },
  { id: 'electrical_panel', family: 'electrical', label: 'Electrical panel / service',
    synonyms: ['electrical panel', 'panel upgrade', 'panel change', 'panel replacement', 'service upgrade', 'service change', 'meter change', 'meter changes', 'meter upgrade', 'meter upgrades', 'meter base', 'meter socket', '200 amp', '100 amp', '200a', '100a', 'breaker panel', 'sub panel', 'subpanel', 'sub-panel', 'main breaker', 'electrical service', 'service entrance', 'mast'],
    weak: ['panel', 'meter', 'breaker', 'breakers', 'amp', 'service'] },
  { id: 'electrical_fixture', family: 'electrical', label: 'Electrical fixture / device',
    synonyms: ['light fixture', 'light fixtures', 'ceiling fan', 'ceiling fans', 'recessed light', 'recessed lights', 'recessed lighting', 'can light', 'can lights', 'chandelier', 'pendant light', 'vanity light', 'gfci', 'smoke detector', 'smoke detectors', 'co detector', 'exhaust fan', 'bath fan', 'outlet install', 'switch install', 'dimmer', 'led light', 'led lights', 'led fixture', 'flood light', 'flood lights', 'porch light', 'doorbell'],
    weak: ['fixture', 'fixtures', 'fan', 'fans', 'outlet', 'outlets', 'switch', 'switches', 'light', 'lights', 'lighting', 'receptacle', 'receptacles', 'circuit', 'circuits'] },
  // Plumbing
  { id: 'plumbing_rough', family: 'plumbing', label: 'Plumbing rough-in',
    synonyms: ['plumbing rough', 'plumbing rough-in', 'plumbing rough in', 'rough plumbing', 'rough-in plumbing', 'rough in plumbing', 'underground plumbing', 'underground rough', 'drain waste vent', 'dwv', 'water lines rough', 'pex rough'],
    weak: ['rough', 'rough-in', 'rough in', 'underground', 'stack', 'pex', 'pvc', 'water lines', 'supply lines', 'gas line', 'gas lines', 'gas piping'] },
  { id: 'plumbing_final', family: 'plumbing', label: 'Plumbing final / finish',
    synonyms: ['plumbing final', 'plumbing finish', 'plumbing finishes', 'final plumbing', 'finish plumbing', 'plumbing trim', 'plumbing trim out', 'plumbing trim-out', 'set fixtures', 'fixture set', 'fixture install'],
    weak: ['final', 'finish', 'finishes', 'trim out', 'trim-out', 'trim', 'set'] },
  { id: 'water_heater', family: 'plumbing', label: 'Water heater',
    synonyms: ['water heater', 'water heaters', 'hot water heater', 'hot water tank', 'tankless', 'tankless water heater', 'hwt', '40 gallon water heater', '50 gallon water heater', 'power vent water heater', 'water heater install', 'water heater replacement'],
    weak: ['heater', 'tank', '40 gallon', '50 gallon', 'power vent', 'bradford white', 'rheem', 'ao smith', 'a.o. smith'] },
  { id: 'plumbing_fixture', family: 'plumbing', label: 'Plumbing fixture',
    synonyms: ['faucet', 'faucets', 'toilet', 'toilets', 'kitchen sink', 'bathroom sink', 'vanity sink', 'vanity', 'vanities', 'bathtub', 'tub', 'tub and shower', 'tub/shower', 'shower', 'shower valve', 'shower base', 'shower pan', 'shower door', 'garbage disposal', 'disposal', 'sump pump', 'ejector pump', 'laundry tub', 'utility sink', 'hose bib', 'hose bibb', 'water softener', 'dishwasher hookup', 'ice maker line', 'fixture'],
    weak: ['sink', 'sinks', 'fixtures', 'valve', 'valves', 'trap', 'p-trap', 'supply', 'drain assembly', 'moen', 'delta', 'kohler'] },
  { id: 'sewer_line', family: 'plumbing', label: 'Sewer / drain line',
    synonyms: ['sewer', 'sewer line', 'sewer repair', 'sewer replacement', 'main line', 'main line sewer', 'main sewer', 'drain line', 'drain cleaning', 'drain snake', 'snake drain', 'sewer camera', 'camera inspection', 'hydro jet', 'hydrojet', 'jetting', 'rooter', 'clean out', 'cleanout', 'sewer lateral', 'lateral', 'trenchless', 'pipe lining', 'sewer tap', 'water main', 'water service line'],
    weak: ['drain', 'drains', 'snake', 'camera', 'line', 'excavate', 'excavation', 'dig'] },
  // HVAC
  { id: 'furnace', family: 'hvac', label: 'Furnace',
    synonyms: ['furnace', 'furnaces', 'gas furnace', 'furnace install', 'furnace installation', 'furnace replacement', 'furnace hook-up', 'furnace hookup', 'air handler', 'high efficiency furnace', '80% furnace', '96% furnace', 'goodman furnace', 'carrier furnace', 'lennox furnace', 'trane furnace', 'boiler'],
    weak: ['heater', 'heating', 'goodman', 'carrier', 'lennox', 'trane', 'rheem', 'btu', 'blower', 'ignitor', 'igniter'] },
  { id: 'ac_condenser', family: 'hvac', label: 'A/C condenser',
    synonyms: ['a/c', 'a/c unit', 'ac unit', 'ac units', 'air conditioner', 'air conditioners', 'air conditioning', 'condenser', 'condensers', 'condensing unit', 'heat pump', 'heat pumps', 'mini split', 'mini-split', 'minisplit', 'ductless', 'evaporator coil', 'a coil', 'a-coil', 'ac install', 'ac installation', 'central air', 'central air conditioning', 'ac replacement', 'a/c replacement', 'ac line set', 'line set', 'lineset'],
    weak: ['ac', 'cooling', 'coil', 'ton', 'tons', 'seer', 'refrigerant', 'freon', 'r410a', 'r-410a', 'pad'] },
  { id: 'ductwork', family: 'hvac', label: 'Ductwork',
    synonyms: ['duct', 'ducts', 'ductwork', 'duct work', 'new ductwork', 'duct install', 'venting', 'vent extension', 'venting extension', 'basement venting', 'dryer vent', 'bath vent', 'exhaust vent', 'flex duct', 'trunk line', 'plenum', 'register', 'registers', 'returns', 'return air', 'supply runs', 'duct runs'],
    weak: ['vent', 'vents', 'run', 'runs', 'grille', 'grilles', 'diffuser', 'boot', 'boots', 'damper', 'sheet metal'] },
  { id: 'hvac_full_system', family: 'hvac', label: 'HVAC full system (furnace + A/C)',
    synonyms: ['hvac system', 'full hvac', 'full system', 'complete system', 'complete hvac', 'hvac install', 'hvac installation', 'hvac replacement', 'new hvac', 'furnace and a/c', 'furnace and ac', 'furnace & a/c', 'furnace & ac', 'furnace and air', 'furnace and air conditioning', 'furnace a/c and ducts', 'furnace, a/c and ducts', 'furnace - a/c & ducts', 'heating and cooling system', 'heating and cooling', 'heating & cooling', 'hvac'],
    weak: ['system', 'systems', 'furnace and', 'furnace &', 'hvac unit', 'unit'] },
  // Concrete and masonry
  { id: 'concrete_flatwork', family: 'concrete_and_masonry', label: 'Concrete flatwork',
    synonyms: ['flatwork', 'flat work', 'concrete flatwork', 'sidewalk', 'sidewalks', 'walkway', 'walkways', 'patio', 'patios', 'concrete patio', 'concrete slab', 'slab', 'garage slab', 'garage floor', 'basement floor', 'basement slab', 'porch', 'front porch', 'porch steps', 'front steps', 'concrete steps', 'steps', 'stoop', 'approach', 'concrete approach', 'concrete pour', 'pour', 'stamped concrete', 'concrete pad', 'ac pad', 'curb', 'curbs', 'concrete work', 'concrete'],
    weak: ['yard', 'yards', 'cubic yard', 'cubic yards', 'cy', 'rebar', 'mesh', 'wire mesh', 'finish', 'broom finish', 'saw cut', 'sawcut'] },
  { id: 'driveway', family: 'concrete_and_masonry', label: 'Driveway',
    synonyms: ['driveway', 'driveways', 'concrete driveway', 'asphalt driveway', 'asphalt', 'paving', 'pavers', 'paver driveway', 'gravel driveway', 'driveway replacement', 'drive way', 'apron', 'driveway apron'],
    weak: ['drive', 'gravel', 'blacktop', 'sealcoat', 'seal coat'] },
  { id: 'foundation', family: 'concrete_and_masonry', label: 'Foundation / footings',
    synonyms: ['foundation', 'foundations', 'foundation wall', 'foundation walls', 'footing', 'footings', 'footings for garage', 'basement wall', 'basement walls', 'poured wall', 'poured walls', 'block wall', 'block walls', 'block foundation', 'crawl space wall', 'pier', 'piers', 'frost wall', 'frost walls', 'stem wall', 'grade beam', 'foundation repair', 'foundation crack', 'underpinning', 'retaining wall', 'retaining walls', 'brick', 'brick work', 'brickwork', 'masonry', 'tuckpoint', 'tuckpointing', 'tuck point', 'chimney', 'chimney repair', 'cmu', 'block'],
    weak: ['wall', 'walls', 'pinning', 'forms', 'form work', 'formwork', 'anchor bolts', 'waterproofing', 'damp proofing', 'dampproofing'] },
  // Demolition
  { id: 'demolition_job', family: 'demolition', label: 'Demolition / clean-out',
    synonyms: ['demo', 'demolition', 'interior demo', 'interior demolition', 'demo and cleanup', 'demo & cleanup', 'tear out', 'tear-out', 'tearout', 'gut', 'gutting', 'gut out', 'abatement', 'asbestos abatement', 'demo abatement', 'clean out', 'cleanout', 'clean-out', 'junk removal', 'junk', 'trash removal', 'trash pickup', 'trash pick up', 'debris removal', 'haul away', 'haul-away', 'hauling', 'remove trash', 'house demolition', 'garage demolition', 'tree removal', 'tree clearing', 'lot clearing'],
    weak: ['removal', 'remove', 'haul', 'debris', 'trash', 'labor'] },
  { id: 'dumpster', family: 'demolition', label: 'Dumpster',
    synonyms: ['dumpster', 'dumpsters', 'dumpster rental', 'roll off', 'roll-off', 'rolloff', 'roll off dumpster', 'roll-off dumpster', '10 yard dumpster', '20 yard dumpster', '30 yard dumpster', '40 yard dumpster', 'dumpster swap', 'dumpster pickup', 'container rental', 'bin rental', 'overage', 'tonnage'],
    weak: ['container', 'containers', 'bin', 'bins', 'swap', 'pull', 'pulls', 'yard', 'yd', '10 yard', '20 yard', '30 yard', '40 yard', 'ton', 'tons'] },
  // Lumber and framing
  { id: 'lumber', family: 'lumber_and_framing', label: 'Lumber / framing material',
    synonyms: ['lumber', 'framing lumber', 'framing material', 'framing materials', '2x4', '2x6', '2x8', '2x10', '2x12', '2 x 4', '2 x 6', '2 x 8', '2 x 10', '2 x 12', '4x4', '6x6', 'osb', 'plywood', 'sheathing', 'roof sheathing', 'wall sheathing', 'subfloor', 'sub floor', 'sub-floor', 'advantech', 'stud', 'studs', 'lvl', 'lvl beam', 'beam', 'beams', 'joist', 'joists', 'floor joists', 'i-joist', 'i-joists', 'tji', 'truss', 'trusses', 'roof trusses', 'rafter', 'rafters', 'treated lumber', 'pressure treated', 'treated', 'cdx', 'zip system', 'zip sheathing', 'header', 'headers', 'top plate', 'sill plate', 'post', 'posts', 'deck boards', 'decking'],
    weak: ['board', 'boards', 'framing', 'frame', 'sheet', 'sheets', 'pine', 'spf', 'fir', 'douglas fir', 'bf', 'board feet', 'lf', 'linear feet', 'lineal feet'] },
  { id: 'trim_and_millwork', family: 'lumber_and_framing', label: 'Trim and millwork',
    synonyms: ['trim', 'interior trim', 'exterior trim', 'millwork', 'baseboard', 'baseboards', 'base board', 'casing', 'door casing', 'window casing', 'crown', 'crown molding', 'crown moulding', 'shoe molding', 'shoe moulding', 'shoe mold', 'molding', 'moulding', 'quarter round', 'quarter-round', 'chair rail', 'wainscoting', 'wainscot', 'stair', 'stairs', 'staircase', 'stair riser', 'stair risers', 'riser', 'risers', 'stair tread', 'stair treads', 'tread', 'treads', 'railing', 'railings', 'handrail', 'handrails', 'hand rail', 'spindle', 'spindles', 'baluster', 'balusters', 'newel', 'newel post', 'stair parts', 'window sill', 'window sills', 'sill', 'sills', 'jamb', 'jambs', 'door jamb', 'mdf trim', 'pvc trim', 'primed trim', 'finger joint', 'finger-joint', 'fj pine', 'brick mould', 'brick mold', 'closet shelving', 'shelving', 'mantel', 'mantle'],
    weak: ['mdf', 'primed', 'pine', 'poplar', 'oak', 'lf', 'linear feet', 'lineal feet', 'pieces', 'pcs'] },
  // Appliances
  { id: 'appliance', family: 'appliances', label: 'Appliance',
    synonyms: ['appliance', 'appliances', 'appliance package', 'appliance set', 'refrigerator', 'refrigerators', 'fridge', 'range', 'ranges', 'gas range', 'electric range', 'stove', 'stoves', 'oven', 'ovens', 'wall oven', 'cooktop', 'dishwasher', 'dishwashers', 'microwave', 'microwaves', 'over the range microwave', 'otr microwave', 'washer', 'dryer', 'washer and dryer', 'washer & dryer', 'washer/dryer', 'laundry pair', 'range hood', 'hood', 'vent hood', 'freezer', 'wine cooler', 'ice maker', 'garbage disposal'],
    weak: ['whirlpool', 'ge', 'frigidaire', 'samsung', 'lg', 'bosch', 'maytag', 'kitchenaid', 'stainless', 'stainless steel', 'delivery', 'haul away', 'install'] },
  // Other
  { id: 'other', family: 'other', label: 'Other', synonyms: [], weak: [] },
];

/** id -> MATERIAL_TYPES row. */
const MATERIAL_TYPE_BY_ID = Object.fromEntries(MATERIAL_TYPES.map(type => [type.id, type]));

/**
 * Normalise free text for synonym matching: lower case, unify hyphen/underscore
 * spacing, collapse whitespace. Keeps '/', '"', '.', '-' so "1/2"", "a/c" and
 * "r-21" still match their synonyms.
 * @param {*} value
 * @returns {string}
 */
function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[^a-z0-9"'.\/\-&%, ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape a literal for use inside a RegExp source. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

const phraseRegExpCache = new Map();

/**
 * Word-bounded RegExp for a synonym phrase. Real \b does not work next to
 * characters like '"' or '/', so the boundary is "start/end or a non-alphanumeric
 * character" on both sides; inner spaces also accept a hyphen.
 * @param {string} phrase - already lower case
 * @returns {RegExp}
 */
function phraseRegExp(phrase) {
  let regExp = phraseRegExpCache.get(phrase);
  if (!regExp) {
    const body = escapeRegExp(phrase).replace(/ /g, '[ \\-]?');
    regExp = new RegExp(`(?:^|[^a-z0-9])${body}(?:$|[^a-z0-9])`);
    phraseRegExpCache.set(phrase, regExp);
  }
  return regExp;
}

/**
 * Map an extractor's raw material type (+ spec) onto a canonical MATERIAL_TYPES id.
 *
 * Search order: (1) the raw type is already a canonical id (with '-', ' ' or '_');
 * (2) strong synonyms of types in the given family; (3) weak synonyms of types in the
 * given family; (4) strong synonyms of every type (the extractor sometimes picks the
 * wrong family - a "quartz" line filed under cabinets is still a quartz countertop).
 * Within a step the longest matching phrase wins, ties go to the earlier type. Both
 * `rawType` and `spec` are searched, raw type first so "laminate top / quartz look"
 * resolves to laminate.
 * @param {string|null|undefined} family - one of MATERIAL_FAMILIES (or anything; unknown = no family filter)
 * @param {string|null|undefined} rawType - free-text material type from the document
 * @param {string|null|undefined} [spec] - brand / grade / material text from the document
 * @returns {string|null} canonical id, or null when nothing matches (never 'other')
 */
function canonicalMaterialType(family, rawType, spec) {
  const rawNormalized = normalizeText(rawType);
  const specNormalized = normalizeText(spec);
  if (!rawNormalized && !specNormalized) return null;

  const asId = rawNormalized.replace(/[\s-]+/g, '_');
  if (asId && asId !== 'other' && MATERIAL_TYPE_BY_ID[asId]) return asId;

  const familyKey = normalizeText(family).replace(/[\s-]+/g, '_');
  const inFamily = familyKey ? MATERIAL_TYPES.filter(type => type.family === familyKey && type.id !== 'other') : [];
  const all = MATERIAL_TYPES.filter(type => type.id !== 'other');

  const passes = [
    { types: inFamily, key: 'synonyms' },
    { types: inFamily, key: 'weak' },
    { types: all, key: 'synonyms' },
  ];
  for (const haystack of [rawNormalized, specNormalized]) {
    if (!haystack) continue;
    for (const pass of passes) {
      let best = null;
      for (const type of pass.types) {
        for (const phrase of type[pass.key]) {
          if (phrase.length <= (best ? best.length : 0)) continue;
          if (phraseRegExp(phrase).test(haystack)) best = { id: type.id, length: phrase.length };
        }
      }
      if (best) return best.id;
    }
  }
  return null;
}

/**
 * The owner's 12 pricing targets ("cost per material" list in spec 0.5). Each maps
 * to a family plus an optional phase and/or type list. An extracted item counts
 * toward a target when its material_family matches AND (no phase/types given, OR its
 * material_type is in `types`, OR its phase equals `phase`). Both unit-priced and
 * job-cost items count (see itemMatchesTarget).
 * @type {Array<{id: string, label: string, match: {family: string, phase?: string, types?: string[]}}>}
 */
const COVERAGE_TARGETS = [
  { id: 'doors', label: 'Doors (interior, exterior, garage)', match: { family: 'doors' } },
  { id: 'countertops_laminate', label: 'Countertops - laminate / Formica', match: { family: 'countertops', types: ['laminate_countertop'] } },
  { id: 'countertops_quartz', label: 'Countertops - quartz', match: { family: 'countertops', types: ['quartz_countertop'] } },
  { id: 'flooring', label: 'Flooring (LVP, carpet, hardwood, tile, coatings)', match: { family: 'flooring' } },
  { id: 'drywall', label: 'Drywall (sheets and hang/tape/finish)', match: { family: 'drywall' } },
  { id: 'roofing', label: 'Roofs (shingle, metal, tear-off)', match: { family: 'roofing' } },
  { id: 'painting', label: 'Painting (interior, exterior, primer)', match: { family: 'paint' } },
  { id: 'electrical_rough', label: 'Electrical rough-in', match: { family: 'electrical', phase: 'rough', types: ['electrical_rough'] } },
  { id: 'electrical_final', label: 'Electrical final', match: { family: 'electrical', phase: 'final', types: ['electrical_final', 'electrical_fixture'] } },
  { id: 'plumbing_rough', label: 'Plumbing rough-in', match: { family: 'plumbing', phase: 'rough', types: ['plumbing_rough'] } },
  { id: 'plumbing_final', label: 'Plumbing final', match: { family: 'plumbing', phase: 'final', types: ['plumbing_final', 'plumbing_fixture'] } },
  { id: 'hvac', label: 'HVAC (furnace, A/C, ductwork, full system)', match: { family: 'hvac' } },
];

/** id -> COVERAGE_TARGETS row. */
const COVERAGE_TARGET_BY_ID = Object.fromEntries(COVERAGE_TARGETS.map(target => [target.id, target]));

/**
 * Does an extracted item count toward a coverage target? Family must match; then the
 * item's canonical type must be in `types` or its phase must equal `phase`; a target
 * with neither matches the whole family. Unit-priced and job-cost items both count.
 * @param {{material_family?: string|null, material_type?: string|null, phase?: string|null}} item
 * @param {{match: {family: string, phase?: string, types?: string[]}}} target
 * @returns {boolean}
 */
function itemMatchesTarget(item, target) {
  if (!item || !target || !target.match) return false;
  const { family, phase, types } = target.match;
  if ((item.material_family || null) !== family) return false;
  const hasTypes = Array.isArray(types) && types.length > 0;
  if (!hasTypes && !phase) return true;
  if (hasTypes && item.material_type && types.includes(item.material_type)) return true;
  if (phase && item.phase === phase) return true;
  return false;
}

module.exports = {
  MATERIAL_TYPES,
  MATERIAL_TYPE_BY_ID,
  canonicalMaterialType,
  COVERAGE_TARGETS,
  COVERAGE_TARGET_BY_ID,
  itemMatchesTarget,
  normalizeText,
};
