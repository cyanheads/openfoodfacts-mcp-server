/**
 * @fileoverview Reading primitives for Open Food Facts nutrition input sets — the
 * `nutrition.input_sets` array schema 1003+ records store and API v3.5 returns: one set per
 * preparation state, source, and reference quantity, each with its nutrients as entered. Also the
 * unit facts Product Opener's nutrients and units taxonomies supply (each nutrient's default unit,
 * which units scale with quantity, mass and volume conversion factors), shared by the export
 * mirror's record builder and the as-sold set selection.
 * @module services/openfoodfacts/nutrition-sets
 */

/** One nutrient of an input set as stored: the value as entered, in the unit as entered. */
type InputSetNutrient = {
  value?: number;
  /** Set when Product Opener derived the value (sodium from salt, energy from macronutrients). */
  value_computed?: number;
  unit?: string;
  /** `<`, `~`, or another qualifier the label printed; `-` marks the nutrient unspecified. */
  modifier?: string;
};

/**
 * One `nutrition.input_sets[]` element. Upstream schema: `docs/api/ref/schemas/product_nutrition_v3.yaml`
 * in openfoodfacts-server. Fields other than these (`source_description`, `last_updated_t`,
 * `unspecified_nutrients`, per-nutrient `value_string`) are not read.
 */
export type NutritionInputSet = {
  preparation: 'as_sold' | 'prepared';
  /** Open string: `manufacturer`, `packaging`, `usda`, `estimate`, and others. */
  source?: string;
  /** `100g`, `100ml`, `serving`, or `1kg` for pet food. */
  per?: string;
  /** The quantity the values are for: 100 for a 100 g / 100 ml set, the serving size for a serving set. */
  per_quantity?: number;
  /** `g` or `ml` for the sets Open Food Facts can convert. */
  per_unit?: string;
  /** Keyed by the hyphenated nutrient id v2 nutriment keys use (`energy-kcal`, `saturated-fat`). */
  nutrients: Record<string, InputSetNutrient>;
};

/** Plain-object test for upstream JSON. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite JSON number, or `undefined`. */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Read one stored input set. Product Opener's own reader (`get_nutrition_input_sets_in_a_hash` in
 * `lib/ProductOpener/Nutrition.pm`) normalizes the legacy `_prepared` preparation to `prepared`.
 * Returns `undefined` for an element that is not a set: not an object, a preparation other than
 * the two states, or no nutrients object. A numeric-string `per_quantity` (the schema upgrade
 * copies `serving_quantity` as stored) is read as its number.
 */
function readInputSet(raw: unknown): NutritionInputSet | undefined {
  if (!isRecord(raw) || !isRecord(raw.nutrients)) return;
  const preparation =
    raw.preparation === 'as_sold'
      ? 'as_sold'
      : raw.preparation === 'prepared' || raw.preparation === '_prepared'
        ? 'prepared'
        : undefined;
  if (!preparation) return;
  const nutrients: Record<string, InputSetNutrient> = {};
  for (const [nid, entry] of Object.entries(raw.nutrients)) {
    if (!isRecord(entry)) continue;
    const value = finite(entry.value);
    const computed = finite(entry.value_computed);
    nutrients[nid] = {
      ...(value !== undefined && { value }),
      ...(computed !== undefined && { value_computed: computed }),
      ...(typeof entry.unit === 'string' && { unit: entry.unit }),
      ...(typeof entry.modifier === 'string' && { modifier: entry.modifier }),
    };
  }
  const perQuantity =
    typeof raw.per_quantity === 'string' ? Number(raw.per_quantity) : raw.per_quantity;
  return {
    preparation,
    nutrients,
    ...(typeof raw.source === 'string' && { source: raw.source }),
    ...(typeof raw.per === 'string' && { per: raw.per }),
    ...(finite(perQuantity) !== undefined && { per_quantity: perQuantity as number }),
    ...(typeof raw.per_unit === 'string' && { per_unit: raw.per_unit }),
  };
}

/**
 * Read a record's `nutrition.input_sets`. `undefined` when the record stores none (absent, or an
 * empty array); `'malformed'` when the field is present but not an array. Elements that are not
 * sets are skipped, so the result can be empty.
 */
export function readInputSets(nutrition: unknown): NutritionInputSet[] | 'malformed' | undefined {
  if (!isRecord(nutrition) || nutrition.input_sets === undefined) return;
  const sets = nutrition.input_sets;
  if (!Array.isArray(sets)) return 'malformed';
  if (sets.length === 0) return;
  return sets.flatMap((raw) => readInputSet(raw) ?? []);
}

/**
 * A nutrient's number: `value` when numeric, else `value_computed` — the rule Product Opener's
 * aggregated set applies (`set_nutrient_values`), so v2 already serves Nutella's sodium, stored
 * only as `value_computed`. `value_string` is never parsed.
 */
function nutrientNumber(nutrient: InputSetNutrient): number | undefined {
  return nutrient.value ?? nutrient.value_computed;
}

/**
 * `unit:en` of every entry in Product Opener's nutrients taxonomy (`taxonomies/nutrients.txt` at
 * openfoodfacts-server bd90d81), keyed by its `zz:` id. Membership is what the taxonomy filter
 * tests; `undefined` marks the three entries that declare no unit. An empty string is a unitless
 * nutrient (pH, glycemic index, NOVA group). Units are as the taxonomy spells them (`kj`).
 */
export const NUTRIENT_TAXONOMY_UNITS: ReadonlyMap<string, string | undefined> = new Map<
  string,
  string | undefined
>([
  ['energy-kj', 'kj'],
  ['energy-kcal', 'kcal'],
  ['energy', 'kj'],
  ['energy-from-fat', 'kj'],
  ['fat', 'g'],
  ['saturated-fat', 'g'],
  ['butyric-acid', 'g'],
  ['caproic-acid', 'g'],
  ['caprylic-acid', 'g'],
  ['capric-acid', 'g'],
  ['lauric-acid', 'g'],
  ['myristic-acid', 'g'],
  ['palmitic-acid', 'g'],
  ['psicose', 'g'],
  ['stearic-acid', 'g'],
  ['arachidic-acid', 'g'],
  ['behenic-acid', 'g'],
  ['lignoceric-acid', 'g'],
  ['cerotic-acid', 'g'],
  ['montanic-acid', 'g'],
  ['melissic-acid', 'g'],
  ['unsaturated-fat', 'g'],
  ['monounsaturated-fat', 'g'],
  ['polyunsaturated-fat', 'g'],
  ['omega-3-fat', 'mg'],
  ['alpha-linolenic-acid', 'g'],
  ['eicosapentaenoic-acid', 'g'],
  ['docosahexaenoic-acid', 'g'],
  ['omega-6-fat', 'mg'],
  ['linoleic-acid', 'g'],
  ['arachidonic-acid', 'g'],
  ['gamma-linolenic-acid', 'g'],
  ['dihomo-gamma-linolenic-acid', 'g'],
  ['omega-9-fat', 'mg'],
  ['oleic-acid', 'g'],
  ['elaidic-acid', 'g'],
  ['gondoic-acid', 'g'],
  ['mead-acid', 'g'],
  ['erucic-acid', 'g'],
  ['nervonic-acid', 'g'],
  ['trans-fat', 'g'],
  ['cholesterol', 'mg'],
  ['gamma-oryzanol', 'mg'],
  ['carbohydrates-total', 'g'],
  ['carbohydrates', 'g'],
  ['sugars', 'g'],
  ['added-sugars', 'g'],
  ['sucrose', 'g'],
  ['glucose', 'g'],
  ['fructose', 'g'],
  ['oligosaccharide', 'g'],
  ['lactose', 'g'],
  ['galactose', 'g'],
  ['maltose', 'g'],
  ['maltodextrins', 'g'],
  ['starch', 'g'],
  ['polydextrose', 'g'],
  ['polyols', 'g'],
  ['erythritol', 'g'],
  ['isomalt', 'g'],
  ['maltitol', 'g'],
  ['sorbitol', 'g'],
  ['fiber', 'g'],
  ['soluble-fiber', 'g'],
  ['insoluble-fiber', 'g'],
  ['proteins', 'g'],
  ['casein', 'g'],
  ['serum-proteins', 'g'],
  ['nucleotides', 'g'],
  ['salt', 'g'],
  ['added-salt', 'g'],
  ['sodium', 'g'],
  ['alcohol', '% vol'],
  ['vitamin-a', 'µg'],
  ['beta-carotene', 'g'],
  ['vitamin-d', 'µg'],
  ['vitamin-d2', 'µg'],
  ['vitamin-d3', 'µg'],
  ['vitamin-e', 'mg'],
  ['vitamin-k', 'µg'],
  ['vitamin-c', 'mg'],
  ['vitamin-b1', 'mg'],
  ['vitamin-b2', 'mg'],
  ['vitamin-pp', 'mg'],
  ['vitamin-b6', 'mg'],
  ['vitamin-b9', 'µg'],
  ['folates', 'µg'],
  ['vitamin-b12', 'µg'],
  ['biotin', 'µg'],
  ['pantothenic-acid', 'mg'],
  ['silica', 'mg'],
  ['bicarbonate', 'mg'],
  ['sulphate', 'mg'],
  ['nitrate', 'mg'],
  ['hydrogencarbonate', undefined],
  ['nitrite', undefined],
  ['potassium', 'mg'],
  ['chloride', 'mg'],
  ['calcium', 'mg'],
  ['phosphorus', 'mg'],
  ['iron', 'mg'],
  ['magnesium', 'mg'],
  ['zinc', 'mg'],
  ['copper', 'mg'],
  ['manganese', 'mg'],
  ['fluoride', 'mg'],
  ['selenium', 'µg'],
  ['chromium', 'µg'],
  ['molybdenum', 'µg'],
  ['iodine', 'µg'],
  ['caffeine', 'mg'],
  ['taurine', 'g'],
  ['ph', ''],
  ['fruits-vegetables-nuts', '%'],
  ['fruits-vegetables-nuts-dried', '%'],
  ['fruits-vegetables-legumes', '%'],
  ['whole-grain', '%'],
  ['collagen-meat-protein-ratio', '%'],
  ['cocoa', '%'],
  ['chlorophyl', 'g'],
  ['carbon-footprint', 'g'],
  ['glycemic-index', ''],
  ['water-hardness', 'mmol/l'],
  ['choline', 'g'],
  ['phylloquinone', 'g'],
  ['beta-glucan', 'g'],
  ['inositol', 'g'],
  ['carnitine', 'g'],
  ['melatonin', 'µg'],
  ['methylsulfonylmethane', 'mg'],
  ['nova-group', ''],
  ['spermidine', undefined],
  ['water', 'g'],
  ['acidity', '% vol'],
  ['dry-residue', 'mg'],
  ['beta-alanine', 'g'],
  ['creatine', 'g'],
  ['l-citrulline', 'mg'],
  ['l-glutamine', 'mg'],
  ['bcaa', 'g'],
  ['l-valine', 'mg'],
  ['l-leucine', 'mg'],
  ['l-isoleucine', 'mg'],
  ['l-arginine', 'mg'],
  ['l-cysteine', 'mg'],
  ['l-glutathione', 'mg'],
  ['hydroxymethylbutyrate', 'mg'],
  ['crude-fat', '%'],
  ['crude-protein', '%'],
  ['crude-ash', '%'],
  ['crude-fibre', '%'],
  ['moisture', '%'],
  ['iron-ii-sulphate-monohydrate', 'mg'],
  ['potassium-iodide', 'mg'],
  ['copper-ii-sulphate-pentahydrate', 'mg'],
  ['manganous-sulphate-monohydrate', 'mg'],
  ['zinc-sulphate-monohydrate', 'mg'],
  ['sodium-selenite', 'mg'],
  ['calcium-iodate-anhydrous', 'mg'],
  ['cassia-gum', 'mg'],
  ['ammonium-chloride', 'mg'],
  ['choline-chloride', 'mg'],
  ['protein-value', 'g/kg'],
]);

/**
 * Fixed default units Product Opener declares ahead of the taxonomy (`%default_unit_for_nid_map`).
 * A `Map`, since the nid is an upstream string: `constructor` on an object literal is a function.
 */
const FIXED_DEFAULT_UNITS: ReadonlyMap<string, string> = new Map([
  ['energy-kj', 'kJ'],
  ['energy-kcal', 'kcal'],
  ['energy', 'kJ'],
  ['alcohol', '% vol'],
  ['water-hardness', 'mmol/l'],
  ['ph', ''],
]);

/**
 * The unit Product Opener normalizes a nutrient to in the aggregated set (`default_unit_for_nid` in
 * `lib/ProductOpener/Nutrition.pm`): the fixed energy, alcohol, water-hardness, and pH units, `%`
 * for the fruit and collagen ratios, the taxonomy unit when it is `%` or unitless, else grams. A
 * `_prepared` suffix is ignored.
 */
export function defaultUnitForNid(nid: string): string {
  const base = nid.replace('_prepared', '');
  const fixed = FIXED_DEFAULT_UNITS.get(base);
  if (fixed !== undefined) return fixed;
  if (base.startsWith('fruits') || base.startsWith('collagen')) return '%';
  if (NUTRIENT_TAXONOMY_UNITS.has(base)) {
    const unit = NUTRIENT_TAXONOMY_UNITS.get(base) ?? 'g';
    if (unit === '%' || unit === '') return unit;
  }
  return 'g';
}

/**
 * Whether a nutrient's figure is the same for every quantity of product: its taxonomy unit is
 * empty or a percentage (`%`, `% vol`). These are copied, not scaled, between per-100 g and
 * per-serving figures (`_compute_nutrition_data_per_100g_and_per_serving_for_old_nutrition_schema`
 * in `lib/ProductOpener/ProductSchemaChanges.pm`). A nutrient outside the taxonomy scales.
 */
export function isQuantityIndependent(nid: string): boolean {
  const unit = NUTRIENT_TAXONOMY_UNITS.get(nid);
  return unit !== undefined && (unit === '' || unit.startsWith('%'));
}

/**
 * Concentration and dimensionless units, which do not depend on the quantity a value is declared
 * for and are never scaled to 100 g (`convert_nutrient_to_100g`). Empty is a unitless value.
 */
const CONCENTRATION_UNITS: ReadonlySet<string> = new Set(['', '%', '% vol', 'mmol/l']);

/**
 * Quantity units the Open Food Facts units taxonomy (`taxonomies/units.txt`) converts, keyed by
 * lowercased symbol: the standard unit each converts to and its factor. Mass converts to grams and
 * volume to millilitres, which Product Opener treats as interchangeable for a per-100 reference.
 */
const QUANTITY_UNITS: ReadonlyMap<string, { standard: 'g' | 'ml'; factor: number }> = new Map([
  ['g', { standard: 'g', factor: 1 }],
  ['kg', { standard: 'g', factor: 1000 }],
  ['mg', { standard: 'g', factor: 0.001 }],
  ['µg', { standard: 'g', factor: 0.000001 }],
  ['mcg', { standard: 'g', factor: 0.000001 }],
  ['ml', { standard: 'ml', factor: 1 }],
  ['cl', { standard: 'ml', factor: 10 }],
  ['dl', { standard: 'ml', factor: 100 }],
  ['l', { standard: 'ml', factor: 1000 }],
]);

/**
 * `value` in its unit's standard unit (`unit_to_g` in `lib/ProductOpener/Units.pm`): multiplied by
 * the unit's conversion factor. A unit the table does not know leaves the value unchanged, as
 * Product Opener does.
 */
function toStandardQuantity(value: number, unit: string | undefined): number {
  const known = unit === undefined ? undefined : QUANTITY_UNITS.get(unit.toLowerCase());
  return known ? value * known.factor : value;
}

/** The standard unit (`g` or `ml`) a quantity unit converts to, or `undefined` (`get_standard_unit`). */
function standardQuantityUnit(unit: string | undefined): 'g' | 'ml' | undefined {
  return unit === undefined ? undefined : QUANTITY_UNITS.get(unit.toLowerCase())?.standard;
}

/** Mass units an entered nutrient value may carry, as grams per unit. A `Map`, keyed by an upstream string. */
const GRAMS_PER_MASS_UNIT: ReadonlyMap<string, number> = new Map([
  ['kg', 1000],
  ['g', 1],
  ['mg', 0.001],
  ['µg', 0.000001],
  ['mcg', 0.000001],
]);

/**
 * An entered nutrient value in the unit v2 figures use: kcal for `energy-kcal` and kJ for
 * `energy-kj` (any other unit there is refused rather than converted), concentrations and unitless
 * values unchanged, and mass converted to grams. Returns `undefined` for a unit it cannot place —
 * IU and % DV need per-nutrient taxonomy factors, so they are left out rather than guessed.
 */
export function nutrientValueInStandardUnit(
  nid: string,
  value: number,
  unit: string | undefined,
): number | undefined {
  if (nid === 'energy-kcal') return unit === 'kcal' ? value : undefined;
  if (nid === 'energy-kj') return unit === 'kJ' ? value : undefined;
  if (unit === undefined) return;
  if (CONCENTRATION_UNITS.has(unit)) return value;
  const grams = GRAMS_PER_MASS_UNIT.get(unit);
  return grams === undefined ? undefined : value * grams;
}

/** A nonzero finite number's magnitude as `count` correctly rounded significant digits and its decimal exponent. */
function decimalDigits(value: number, count: number): { digits: string; exponent: number } {
  const [mantissa = '', exponent = '0'] = Math.abs(value)
    .toExponential(count - 1)
    .split('e');
  return { digits: mantissa.replace('.', ''), exponent: Number(exponent) };
}

/**
 * `value` rounded to `digits` significant digits as C's printf rounds it (`%.<digits-1>e`,
 * `%.<digits>g`), which is what Perl's `sprintf` and JSON output use: to the nearest, and an exact
 * binary tie to the even digit. `toPrecision` sends a tie away from zero instead, so 5610 kJ per
 * 100 ml × 5 ml (exactly 280.5) is 281 there and 280 in a v2 read. A tie is confirmed at 60
 * digits, past where any double near it differs from it.
 */
export function printfSignificant(value: number, digits: number): number {
  const rounded = Number(value.toPrecision(digits));
  if (value === 0 || !Number.isFinite(value)) return rounded;
  const isTie = (count: number) => /^50*$/.test(decimalDigits(value, count).digits.slice(digits));
  if (!isTie(17) || !isTie(61)) return rounded;
  const exact = decimalDigits(value, 61);
  const kept = Number(exact.digits.slice(0, digits));
  if (kept % 2 === 1) return rounded;
  return Math.sign(value) * Number(`${kept}e${exact.exponent - digits + 1}`);
}

/**
 * A number as Product Opener's JSON writes it: a floating-point value to 15 significant digits,
 * the precision Perl prints a double with, rounded as `printfSignificant` rounds. Live v2 reads
 * carry `0.00867259598342685` where the stored double is `0.008672595983426845`, and
 * `10.2 × 100 / 20` arrives as `51`, not `50.99999999999999`.
 */
export function perlNumber(value: number): number {
  return Number.isInteger(value) && Math.abs(value) < 1e15 ? value : printfSignificant(value, 15);
}

/* --- Stored as-sold figures for a prepared-only read --------------------------------------- */

/**
 * Whether a v2 `nutriments` map holds prepared figures and no as-sold one: at least one numeric
 * `*_prepared_100g` or `*_prepared_serving` key, and no other numeric `*_100g` or `*_serving` key
 * once the NOVA class (`nova-group_100g`, `nova-group_serving`) is set aside. API v2 serves one
 * preparation state per record and prepared wins, so such a read says nothing about the as-sold
 * figures the record can still store. The same rule `off_get_product` applies to its normalized
 * output, so the two never disagree about a read.
 */
export function holdsOnlyPreparedFigures(nutriments: Record<string, unknown> | undefined): boolean {
  let prepared = false;
  for (const [key, value] of Object.entries(nutriments ?? {})) {
    if (typeof value !== 'number') continue;
    const suffix = key.endsWith('_100g') ? '_100g' : key.endsWith('_serving') ? '_serving' : '';
    const base = key.slice(0, key.length - suffix.length);
    if (suffix === '' || base === 'nova-group') continue;
    if (!base.endsWith('_prepared')) return false;
    prepared = true;
  }
  return prepared;
}

/**
 * The one stored set chosen to supply a prepared-only read's as-sold figures, as v2 nutriment keys
 * (`energy-kcal_100g`, `vitamin-c_100g`) per 100 g or per 100 ml, or `none` when no stored set
 * qualifies.
 */
export type AsSoldSelection =
  | { status: 'read'; nutriments: Record<string, number> }
  | { status: 'none' };

/**
 * Source rank, Product Opener's `%source_priority`; any other source ranks after these three. A
 * `Map`, since `source` is an open upstream string.
 */
const AS_SOLD_SOURCE_RANK: ReadonlyMap<string, number> = new Map([
  ['manufacturer', 0],
  ['packaging', 1],
  ['usda', 2],
]);

/**
 * Smallest serving, in grams or millilitres, a serving set is scaled to 100 from. Product Opener
 * drops smaller ones from the aggregated set (`generate_nutrient_aggregated_set_from_sets`) rather
 * than extrapolate a few grams to a hundred.
 */
const MIN_SCALED_SERVING = 5;

/**
 * An as-sold set's figures per 100 g / 100 ml under v2 keys, or `undefined` when the set is not
 * eligible or yields no figure. Eligible: as sold, not an estimate (v2 keeps estimates out of
 * `nutriments`), and per 100 g, per 100 ml, or per serving of at least 5 g or ml. Each nutrient
 * reads `value`, else `value_computed`, in the unit v2 figures use; IU, % DV, and other units are
 * left out. A serving set's values are scaled as `convert_nutrient_to_100g` scales them
 * (`value × 100 / serving`), concentrations and unitless values excepted, then written to 15
 * significant digits. NOVA is already `nova_group`, and `energy` is v2's copy of `energy-kj`, made
 * here the same way, never converted from kcal. Modifiers (`<`, `~`) are dropped as v2 drops them.
 */
function asSoldFigures(set: NutritionInputSet): Record<string, number> | undefined {
  if (set.preparation !== 'as_sold' || set.source === 'estimate') return;
  let serving: number | undefined;
  if (set.per === 'serving') {
    if (set.per_quantity === undefined || standardQuantityUnit(set.per_unit) === undefined) return;
    serving = toStandardQuantity(set.per_quantity, set.per_unit);
    if (!(serving >= MIN_SCALED_SERVING)) return;
  } else if (set.per !== '100g' && set.per !== '100ml') {
    return;
  }
  const figures: Record<string, number> = {};
  for (const [nid, nutrient] of Object.entries(set.nutrients)) {
    if (nid === 'nova-group' || nid === 'energy') continue;
    const entered = nutrientNumber(nutrient);
    const { unit } = nutrient;
    if (entered === undefined || unit === undefined) continue;
    const value = nutrientValueInStandardUnit(nid, entered, unit);
    if (value === undefined) continue;
    const scaled =
      serving === undefined || CONCENTRATION_UNITS.has(unit) ? value : (value * 100) / serving;
    figures[`${nid}_100g`] = perlNumber(scaled);
  }
  const energyKj = figures['energy-kj_100g'];
  if (energyKj !== undefined) figures.energy_100g = energyKj;
  return Object.keys(figures).length > 0 ? figures : undefined;
}

/**
 * Choose the stored as-sold figures for a read that returned only prepared ones: one set, never
 * merged, so every figure served has one source and one basis. Per 100 g / 100 ml sets rank before
 * serving sets (their figures need no scaling), then by source (manufacturer, packaging, usda, any
 * other), then 100 g before 100 ml, then stored order. A set that qualifies on its shape but yields
 * no figure (IU only, say) is passed over for the next, so `read` always carries a figure. Prepared
 * and estimate sets are never read. Request-free: a live v3.5 read and a mirror record feed it alike.
 */
export function selectAsSoldSet(sets: readonly NutritionInputSet[]): AsSoldSelection {
  const sourceRank = (set: NutritionInputSet) => AS_SOLD_SOURCE_RANK.get(set.source ?? '') ?? 3;
  const candidates = sets.flatMap((set) => {
    const figures = asSoldFigures(set);
    return figures ? [{ set, figures }] : [];
  });
  // Array sort is stable, so sets that tie on every rank keep their stored order.
  candidates.sort(
    ({ set: a }, { set: b }) =>
      Number(a.per === 'serving') - Number(b.per === 'serving') ||
      sourceRank(a) - sourceRank(b) ||
      Number(a.per === '100ml') - Number(b.per === '100ml'),
  );
  const chosen = candidates[0];
  return chosen ? { status: 'read', nutriments: chosen.figures } : { status: 'none' };
}

/**
 * Serve a selection on a raw v2 product: the chosen figures join its `nutriments` as `<nid>_100g`
 * keys beside the `_prepared` ones, which stay as they are, and the product's `stored_as_sold`
 * status is `read`; `none` leaves the product unchanged. No per-serving as-sold figure is
 * synthesized. Pure, so a mirror record's stored sets settle the same way a live read's do.
 */
export function applyAsSoldSelection<
  P extends { nutriments?: Record<string, number | string | undefined> },
>(
  product: P,
  selection: AsSoldSelection,
): { product: P; stored_as_sold: { status: 'read' } | { status: 'none' } } {
  if (selection.status === 'none') return { product, stored_as_sold: { status: 'none' } };
  return {
    product: { ...product, nutriments: { ...product.nutriments, ...selection.nutriments } },
    stored_as_sold: { status: 'read' },
  };
}
