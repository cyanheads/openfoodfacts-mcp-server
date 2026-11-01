/**
 * @fileoverview Turns one Open Food Facts export or delta JSONL line — the product document as
 * Product Opener stores it, at whatever schema version it was last saved — into the mirror's
 * stored record: the barcode key, sort keys, indexed tag keys, and `doc`, the projection a live
 * `GET /api/v2/product/{code}` read returns for the fields this server requests.
 *
 * A v2 read is not the stored document. Product Opener (openfoodfacts-server bd90d81) upgrades the
 * record to schema 1004 (`retrieve_product` → `convert_product_schema`), builds `image_url`
 * (`add_images_urls_to_product`), copies the requested fields (`customize_response_for_product`),
 * and downgrades the copy to schema 998 (API v2). Each step this module ports names its upstream
 * sub; the nutrients and units taxonomies it needs are carried as tables. Two steps consult larger
 * taxonomies an export line does not carry and are approximated from the stored document: the tag
 * regeneration a pre-1004 record gets (`convert_schema_1003_to_1004_refactor_tags`, which
 * re-expands `*_hierarchy` with the current taxonomy's parents and display names) and synonym
 * renames of legacy nutrient keys (`filter_out_nutrients_not_in_taxonomy` keeps only taxonomy ids
 * here).
 *
 * Known limitation: the mirror serves the tags stored with the record. A live read of a pre-1004
 * record adds the parents today's taxonomy gives its categories, labels, origins, allergens,
 * traces, and countries, and shows a brand the brands taxonomy knows under that taxonomy's name
 * (`Betty Crocker` for a record that stores `Betty crocker`); the mirror's `doc` carries neither.
 * @module services/mirror/record-builder
 */

import {
  defaultUnitForNid,
  holdsOnlyPreparedFigures,
  isQuantityIndependent,
  NUTRIENT_TAXONOMY_UNITS,
  perlNumber,
  printfSignificant,
} from '@/services/openfoodfacts/nutrition-sets.js';
import { BARCODE_PATTERN } from '@/services/openfoodfacts/types.js';

/** Bumped whenever the projection or tag set changes; the store re-ingests every row stamped with an older version. */
export const MIRROR_RECORD_VERSION = 1;

export interface MirrorRecord {
  /** Barcode normalized as Product Opener's normalize_code_zeroes does. The primary key. */
  code: string;
  createdT: number | null;
  /**
   * What GET /api/v2/product/{code}?fields=<every field the service requests> returns under `product`,
   * covering the union of the product-read, compare, and v2-search `fields` lists the service sends.
   * Plus `_input_sets` (the record's nutrition.input_sets, upgraded for pre-1003 records) only when the
   * projected `nutriments` hold `_prepared` figures and no as-sold one. JSON-serializable.
   */
  doc: Record<string, unknown>;
  lastModifiedT: number | null;
  popularityKey: number | null;
  /** Indexed tag keys, each built with `mirrorTagKey(facet, storedTag)`. Deduplicated. */
  tags: string[];
  uniqueScansN: number | null;
}

/**
 * The facets the store indexes: every tag filter the search tool's tag-only path accepts at HEAD
 * 0c50ace, and nothing else. Each names the stored `<facet>_tags` field it reads, so `traces`
 * (filtered through the allergen vocabulary) is its own facet, and NOVA and Nutri-Score are the
 * `nova_groups` and `nutrition_grades` tag fields the tag path filters on.
 */
export const MIRROR_TAG_FACETS = [
  'categories',
  'brands',
  'labels',
  'allergens',
  'traces',
  'ingredients_analysis',
  'additives',
  'nutrition_grades',
  'nova_groups',
  'countries',
] as const;

const TAG_FACETS: ReadonlySet<string> = new Set(MIRROR_TAG_FACETS);

/**
 * The one place the tag key format lives. `facet` is the search tool's tag-filter facet name, and
 * `storedTag` the value exactly as the export stores it in `<facet>_tags`, brands included: a
 * schema 1004 record keeps a brand the taxonomy does not know as entered (`xx:Slimfast`), and the
 * key keeps that form. Product Opener's tag search compares the stored value exactly, so live
 * `/api/v2/search?brands_tags=slimfast` (queried as `xx:slimfast`) does not find `0008346800025`,
 * which stores `xx:Slimfast`; keying the stored form makes a mirror search find what live finds.
 */
export function mirrorTagKey(facet: string, storedTag: string): string {
  return `${facet}:${storedTag}`;
}

/**
 * The stored NOVA tag for each NOVA group the search tool accepts (`nova_groups_tags` taxonomy
 * ids). A `Map`, since the value it is keyed by comes from the caller.
 */
const NOVA_GROUP_TAGS: ReadonlyMap<string, string> = new Map([
  ['1', 'en:1-unprocessed-or-minimally-processed-foods'],
  ['2', 'en:2-processed-culinary-ingredients'],
  ['3', 'en:3-processed-foods'],
  ['4', 'en:4-ultra-processed-food-and-drink-products'],
]);

/**
 * Maps a canonical tag value as the taxonomy service confirms it (e.g. `en:nutella`, `4`) to the
 * form the export stores (`xx:nutella`, the NOVA taxonomy id), per facet — the value Product
 * Opener's tag search matches (`add_params_to_query` in `lib/ProductOpener/Display.pm`): brands
 * carry the language-less `xx:` prefix, a NOVA digit is its taxonomy id, and an additive id is cut
 * at its first hyphen. Every other facet stores the canonical id as given. The result is matched
 * against the stored form `mirrorTagKey` indexes, never re-slugged: Product Opener's own search
 * misses a brand stored in another case, and the mirror misses it the same way. Throws for a facet
 * outside `MIRROR_TAG_FACETS`, a programmer error at the query seam.
 */
export function toStoredTag(facet: string, canonicalValue: string): string {
  if (!TAG_FACETS.has(facet)) throw new Error(`Unknown mirror tag facet: ${facet}`);
  switch (facet) {
    case 'brands':
      return `xx:${canonicalValue.replace(/^[a-z]{2}:/i, '')}`;
    case 'nova_groups':
      return NOVA_GROUP_TAGS.get(canonicalValue) ?? canonicalValue;
    case 'additives':
      return canonicalValue.replace(/-.*/, '');
    default:
      return canonicalValue;
  }
}

/**
 * A barcode as Product Opener stores it (`normalize_code_zeroes` in `lib/ProductOpener/Products.pm`):
 * leading zeros stripped, padded to 13 digits, and a 13-digit code starting `00000` cut to its
 * last 8 (EAN-8), so `030000010402` is `0030000010402`. A code with a non-digit is returned as is.
 */
export function normalizeCodeZeroes(code: string): string {
  if (!/^\d+$/.test(code)) return code;
  const padded = code.replace(/^0+/, '').padStart(13, '0');
  return padded.length === 13 && padded.startsWith('00000') ? padded.slice(5) : padded;
}

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A Perl-defined value: JSON `null` reads back as `undef`. */
function defined<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

/** A finite JSON number, or `null` — the sort-key columns. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Perl numification after Product Opener strips a comparison prefix (`s/^(<|environ|max|…)( )?//; += 0.0`). */
function perlNumify(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const match = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i.exec(
    value.replace(/^(<|environ|max|maximum|min|minimum)( )?/, ''),
  );
  return match ? Number(match[0]) : 0;
}

/** The language a request to world.openfoodfacts.org reads in. */
const TARGET_LC = 'en';

/**
 * A language-specific field (`%language_fields`): the first non-empty `<field>_<lc>` among the
 * request language and the product's, then the main-language value wherever it is defined, even
 * empty (`customize_response_for_product` copies it last).
 */
function languageField(p: Raw, field: string, lc: string): unknown {
  let value: unknown;
  for (const language of [TARGET_LC, lc]) {
    const candidate = p[`${field}_${language}`];
    if (defined(candidate) && candidate !== '') {
      value = candidate;
      break;
    }
  }
  return defined(p[field]) ? p[field] : value;
}

/** Product Opener's `split_code`: the code padded to 13 digits and cut 3/3/3/rest for the image path. */
function splitCode(code: string): string {
  const padded = code.replace(/^0+/, '').padStart(13, '0');
  return `${padded.slice(0, 3)}/${padded.slice(3, 6)}/${padded.slice(6, 9)}/${padded.slice(9)}`;
}

/**
 * The front image URL (`add_images_urls_to_product` → `get_image_in_best_language` →
 * `get_image_url`, display size 400). Schema ≤1001 records keep selected images as top-level
 * `front_<lc>` keys, which `convert_schema_1001_to_1002_refactor_images_object` moves under
 * `images.selected`. The language is the request's, the product's, English, then the first in
 * alphabetical order; a selected image without a `rev` yields no URL rather than another language.
 */
function frontImageUrl(p: Raw, from: number, lc: string, code: string): string | undefined {
  const images = p.images;
  if (!isRecord(images)) return;
  let front: Raw | undefined;
  if (from <= 1001) {
    for (const [key, image] of Object.entries(images)) {
      const match = /^(\w+)_(\w\w)$/.exec(key);
      if (match?.[1] === 'front' && match[2]) {
        front ??= {};
        front[match[2]] = image;
      }
    }
  } else if (isRecord(images.selected) && isRecord(images.selected.front)) {
    front = images.selected.front;
  }
  if (!front) return;
  let imageLc = [TARGET_LC, lc, 'en'].find(
    (language) => Object.hasOwn(front, language) && defined(front[language]),
  );
  imageLc ??= Object.keys(front).sort()[0];
  if (imageLc === undefined) return;
  const image = front[imageLc];
  const rev = isRecord(image) ? image.rev : undefined;
  if (!defined(rev)) return;
  return `https://images.openfoodfacts.org/images/products/${splitCode(code)}/front_${imageLc}.${String(rev)}.400.jpg`;
}

/** Display name of a brand tag with no taxonomy entry: the text after its `xx:` (or request-language) prefix. */
function brandDisplay(tag: string): string {
  const trimmed = tag.replace(/^ /, '').replace(/ $/, '');
  const match = /^(\w\w):/.exec(trimmed);
  return match && (match[1] === 'xx' || match[1] === TARGET_LC)
    ? trimmed.slice(match[0].length)
    : trimmed;
}

/**
 * The `brands` string a v2 read returns. Schema 1004 stores it as the display join of `brands_tags`
 * that the read regenerates. An older record's read rebuilds it: `brands` split on commas into
 * `xx:` tags for schema ≤1000 (`convert_schema_1000_to_1001_…`, `gen_tags_hierarchy_taxonomy`),
 * `brands_hierarchy` (or `brands_tags`) otherwise, then deduplicated, sorted, and joined by display
 * name (`generate_field_tags_from_all_sources`). Brands the brands taxonomy knows display under its
 * name there, which this falls back to the tag text for.
 */
function v2Brands(p: Raw, from: number): unknown {
  if (from >= 1004) return p.brands;
  let input: unknown;
  if (from <= 1000 && defined(p.brands)) {
    input =
      typeof p.brands === 'string' && !/^\s*$/.test(p.brands) ? p.brands.split(/\s*,\s*/) : [];
  } else {
    input = p.brands_hierarchy ?? p.brands_tags;
  }
  if (!Array.isArray(input)) return p.brands;
  const tags = [
    ...new Set(input.filter((tag): tag is string => typeof tag === 'string' && tag !== '')),
  ];
  return tags.sort().map(brandDisplay).join(', ');
}

/** Writable tag fields `convert_schema_1003_to_1004_refactor_tags` regenerates that the tools read. */
const REGENERATED_TAG_FIELDS = new Set([
  'categories_tags',
  'labels_tags',
  'origins_tags',
  'allergens_tags',
  'traces_tags',
  'countries_tags',
]);

/**
 * A `*_tags` field as a v2 read returns it. Schema 1004 tags pass through. An older record's
 * writable tags are regenerated from `*_hierarchy` (else `*_tags`) with the current taxonomy, which
 * keeps an unrecognized entry as entered (`en:Groceries`, where the stored id is `en:groceries`) and
 * adds parents introduced since the record was saved; the stored hierarchy is the first half.
 */
function v2Tags(p: Raw, field: string, from: number): unknown {
  if (from >= 1004 || !REGENERATED_TAG_FIELDS.has(field)) return p[field];
  const hierarchy = p[`${field.slice(0, -'_tags'.length)}_hierarchy`];
  return Array.isArray(hierarchy) && hierarchy.length > 0 ? hierarchy : p[field];
}

/** `environmental_score_grade` after the read's upgrade and its localization to the request country. */
function v2EcoscoreGrade(p: Raw, from: number): unknown {
  // convert_schema_999_to_1000_rename_ecoscore_fields_to_environmental_score: environmental wins.
  const data =
    from < 1000 ? (p.environmental_score_data ?? p.ecoscore_data) : p.environmental_score_data;
  const grade =
    from < 1000 ? (p.environmental_score_grade ?? p.ecoscore_grade) : p.environmental_score_grade;
  // localize_environmental_score: world.openfoodfacts.org requests carry cc "world".
  if (isRecord(data) && isRecord(data.scores) && defined(data.scores.world)) {
    return isRecord(data.grades) ? data.grades.world : undefined;
  }
  return grade;
}

/** Ingredient keys the tools read. */
const INGREDIENT_KEYS = ['id', 'text', 'percent_estimate', 'vegan', 'vegetarian'] as const;

/** The parsed-ingredient tree, cut to the keys the tools read, sub-ingredients projected alike. */
function projectIngredients(list: unknown[]): unknown[] {
  return list.map((ingredient) => {
    if (!isRecord(ingredient)) return ingredient;
    const out: Raw = {};
    for (const key of INGREDIENT_KEYS) {
      const value = ingredient[key];
      if (defined(value)) out[key] = typeof value === 'number' ? perlNumber(value) : value;
    }
    const children = ingredient.ingredients;
    if (defined(children))
      out.ingredients = Array.isArray(children) ? projectIngredients(children) : children;
    return out;
  });
}

/* --- Nutrition --------------------------------------------------------------------------- */

type InputSet = {
  preparation: string;
  source: string;
  per: string;
  per_quantity: unknown;
  per_unit?: string;
  nutrients: Record<string, Raw>;
  unspecified_nutrients?: string[];
};

/** The base nutrient id of a legacy `nutriments` key; ids with a digit (`vitamin-b1`) never match upstream either. */
const LEGACY_NUTRIENT_KEY = /^([a-z][a-z-]*[a-z]?)(?:_\w+)?$/;

/** Legacy set types in the order the 1002→1003 upgrade lists them. */
const LEGACY_SET_TYPES = ['prepared_100g', 'prepared_serving', '100g', 'serving'] as const;
type LegacySetType = (typeof LEGACY_SET_TYPES)[number];

/** `sort_sets_by_priority` ranks, as `Map`s: `per` derives from the record's quantity unit. */
const PREPARATION_PRIORITY: ReadonlyMap<string, number> = new Map([
  ['prepared', 0],
  ['as_sold', 1],
]);
const SOURCE_PRIORITY: ReadonlyMap<string, number> = new Map([
  ['manufacturer', 0],
  ['packaging', 1],
  ['usda', 2],
  ['estimate', 3],
]);
const PER_PRIORITY: ReadonlyMap<string, number> = new Map([
  ['100g', 0],
  ['100ml', 1],
  ['1l', 2],
  ['1kg', 3],
  ['serving', 4],
]);

/** `sort_sets_by_priority`: preparation, then source, then reference quantity; stable. */
function sortSetsByPriority<T extends { preparation?: unknown; source?: unknown; per?: unknown }>(
  sets: T[],
): T[] {
  const rank = (table: ReadonlyMap<string, number>, value: unknown, fallback: number) =>
    (typeof value === 'string' ? table.get(value) : undefined) ?? fallback;
  return sets.sort(
    (a, b) =>
      rank(PREPARATION_PRIORITY, a.preparation, 2) - rank(PREPARATION_PRIORITY, b.preparation, 2) ||
      rank(SOURCE_PRIORITY, a.source, 4) - rank(SOURCE_PRIORITY, b.source, 4) ||
      rank(PER_PRIORITY, a.per, 5) - rank(PER_PRIORITY, b.per, 5),
  );
}

/**
 * The aggregated set Product Opener builds from input sets (`generate_nutrient_aggregated_set_from_sets`):
 * sets ranked by priority, those whose per quantity is unknown or under 5 g / 5 ml dropped, the
 * first one's preparation and reference kept, and each nutrient taken once from the highest-ranked
 * set of that preparation, in its default unit and scaled to the aggregated reference
 * (`set_nutrient_values`). Run only on sets the legacy upgrade built, whose units are already the
 * default ones, so unit conversion reduces to the energy copy.
 */
function aggregateSets(sets: InputSet[]): Raw {
  const usable = sortSetsByPriority(sets).filter(
    (set) =>
      defined(set.per_quantity) &&
      set.per_quantity !== '' &&
      unitToG(set.per_quantity, set.per_unit) >= 5,
  );
  const [first] = usable;
  if (!first) return {};
  const standard = UNIT_NAMES.get((first.per_unit ?? '').toLowerCase())?.standard;
  const per = standard === 'ml' ? '100ml' : '100g';
  const nutrients: Record<string, Raw> = {};
  for (const set of usable) {
    if (set.preparation !== first.preparation) continue;
    // Nids here passed the nutrients-taxonomy filter, so none names an Object.prototype property.
    for (const nid of Object.keys(set.nutrients).sort()) {
      if (nid === 'energy' || Object.hasOwn(nutrients, nid)) continue;
      const entry: Raw = { ...set.nutrients[nid] };
      delete entry.value_string;
      if (!defined(entry.value) && defined(entry.value_computed)) {
        entry.value = entry.value_computed;
        delete entry.value_computed;
        entry.modifier ??= '~';
      }
      const unit = entry.unit;
      if (
        set.per !== per &&
        !(
          unit === undefined ||
          unit === '' ||
          unit === '%' ||
          unit === '% vol' ||
          unit === 'mmol/l'
        )
      ) {
        /**
         * convert_nutrient_to_100g: value × 100 / g_to_unit(unit_to_g(per quantity), g or ml), where
         * g_to_unit stringifies its argument as unit_to_g does and divides by 1.
         */
        const factor = perlNumber(unitToG(set.per_quantity, set.per_unit));
        entry.value = (perlNumify(entry.value) * 100) / factor;
      }
      nutrients[nid] = { ...entry, source: set.source, source_per: set.per };
    }
    const kj = nutrients['energy-kj'];
    const kcal = nutrients['energy-kcal'];
    if (kj && 'value' in kj) nutrients.energy = { ...kj };
    else if (kcal && 'value' in kcal) {
      // convert_nutrient_to_standard_unit → unit_to_kj truncates kcal × 4.184 to an integer.
      nutrients.energy = {
        ...kcal,
        value: defined(kcal.value) ? Math.trunc(perlNumify(kcal.value) * 4.184) : kcal.value,
        unit: 'kJ',
      };
    }
  }
  return { preparation: first.preparation, per, nutrients };
}

/**
 * `convert_schema_1002_to_1003_refactor_product_nutrition_schema` for a record saved before the
 * nutrition-set schema: one input set per preparation state the legacy `nutriments` map holds
 * figures for (per serving when `nutrition_data[_prepared]_per` says so, else per 100 g or the
 * product's unit), each nutrient taken from its `_100g`/`_serving` figure in its default unit,
 * after nutrients outside the taxonomy and the legacy `energy` field are dropped. Returns the sets
 * in the priority order the aggregation leaves them in, and the aggregated set.
 */
function upgradeLegacyNutrition(p: Raw): { inputSets: InputSet[]; aggregated: Raw } {
  const legacy = isRecord(p.nutriments) ? { ...p.nutriments } : undefined;
  if (p.no_nutrition_data === 'on' || !legacy) return { inputSets: [], aggregated: {} };

  const hasFigures = (prepared: boolean) =>
    Object.keys(legacy).some(
      (key) => key.includes('_prepared') === prepared && /_(serving|100g)$/.test(key),
    );
  const types: LegacySetType[] = [];
  if (p.nutrition_data_prepared === 'on' || hasFigures(true)) {
    types.push(p.nutrition_data_prepared_per === 'serving' ? 'prepared_serving' : 'prepared_100g');
  }
  if (p.nutrition_data === 'on' || hasFigures(false)) {
    types.push(p.nutrition_data_per === 'serving' ? 'serving' : '100g');
  }

  // filter_out_nutrients_not_in_taxonomy (synonym renames are taxonomy lookups, not ported).
  const baseIds = () => [
    ...new Set(Object.keys(legacy).flatMap((key) => LEGACY_NUTRIENT_KEY.exec(key)?.[1] ?? [])),
  ];
  for (const nid of baseIds()) {
    if (NUTRIENT_TAXONOMY_UNITS.has(nid)) continue;
    for (const suffix of ['', '_100g', '_serving', '_label', '_unit', '_value']) {
      delete legacy[nid + suffix];
    }
  }
  for (const type of types) {
    const state = type.startsWith('prepared') ? '_prepared' : '';
    if (!defined(legacy[`energy-kj_${type}`]) && !defined(legacy[`energy-kcal_${type}`])) {
      const energy = legacy[`energy_${type}`];
      if (defined(energy)) {
        const target =
          (legacy[`energy${state}_unit`] ?? 'kJ') === 'kJ' ? 'energy-kj' : 'energy-kcal';
        legacy[`${target}_${type}`] = energy;
        const modifier = legacy[`energy${state}_modifier`];
        if (defined(modifier)) legacy[`${target}${state}_modifier`] = modifier;
      }
    }
    delete legacy[`energy_${type}`];
    delete legacy[`energy${state}_unit`];
    delete legacy[`energy${state}_modifier`];
  }

  const nids = baseIds();
  const sets = new Map<LegacySetType, InputSet>();
  for (const type of types) {
    const state = type.startsWith('prepared') ? '_prepared' : '';
    const serving = type.endsWith('serving');
    // set_per_unit: the product's unit, else the serving's, else grams for a per-100 set.
    const perUnit =
      [p.product_quantity_unit, p.serving_quantity_unit].find(defined) ??
      (serving ? undefined : 'g');
    const set: InputSet = {
      preparation: state ? 'prepared' : 'as_sold',
      source: 'packaging',
      per: serving ? 'serving' : `100${typeof perUnit === 'string' ? perUnit : ''}`,
      per_quantity: serving ? p.serving_quantity : 100,
      ...(typeof perUnit === 'string' && { per_unit: perUnit }),
      nutrients: {},
    };
    for (const nid of nids) {
      const value = legacy[`${nid}_${type}`];
      const modifier = legacy[`${nid}${state}_modifier`];
      if (!defined(value) && !defined(modifier)) continue;
      if (modifier === '-') {
        set.unspecified_nutrients ??= [];
        set.unspecified_nutrients.push(nid);
        continue;
      }
      set.nutrients[nid] = {
        ...(defined(modifier) && { modifier }),
        value,
        unit: defaultUnitForNid(nid),
        value_string: String(value ?? ''),
      };
    }
    sets.set(type, set);
  }
  const inputSets = LEGACY_SET_TYPES.flatMap((type) => {
    const set = sets.get(type);
    return set && Object.keys(set.nutrients).length > 0 ? [set] : [];
  });
  const aggregated = aggregateSets(inputSets);
  return { inputSets, aggregated };
}

/**
 * The v2 `nutriments` map, cut to the numeric `*_100g` / `*_serving` figures the tools read
 * (`convert_schema_1003_to_1002_refactor_product_nutrition_schema` +
 * `_compute_nutrition_data_per_100g_and_per_serving_for_old_nutrition_schema`). Built from the
 * aggregated set alone, so it carries one preparation state; a per-100 ml set reads as `_100g`;
 * estimated nutrients stay out except `added-sugars` and the fruit and vegetable estimates; and
 * each per-serving figure is the per-100 figure × the serving quantity, rounded to three
 * significant digits as `sprintf("%.2e")` rounds, except for unitless and percentage nutrients,
 * which are copied.
 */
function v2Nutriments(
  aggregated: Raw,
  servingQuantity: number | undefined,
): Record<string, number> | undefined {
  const prepared = aggregated.preparation === 'prepared' || aggregated.preparation === '_prepared';
  const state = prepared ? '_prepared' : '';
  const per =
    !defined(aggregated.per) || aggregated.per === '100ml' ? '_100g' : `_${String(aggregated.per)}`;
  const out: Record<string, number> = {};
  const put = (key: string, value: unknown) => {
    if (typeof value === 'number') out[key] = perlNumber(value);
  };
  for (const [nid, raw] of Object.entries(
    isRecord(aggregated.nutrients) ? aggregated.nutrients : {},
  )) {
    const entry = isRecord(raw) ? raw : {};
    if ((entry.source ?? 'unknown') !== 'estimate' || nid === 'added-sugars') {
      const value = perlNumify(entry.value);
      put(`${nid}${state}_100g`, value);
      if (isQuantityIndependent(nid)) put(`${nid}${state}_serving`, value);
      else if (servingQuantity !== undefined && servingQuantity > 0) {
        put(`${nid}${state}_serving`, printfSignificant((value / 100) * servingQuantity, 3));
      }
    } else if (nid === 'fruits-vegetables-nuts' || nid === 'fruits-vegetables-legumes') {
      put(`${nid}-estimate-from-ingredients${state}${per}`, entry.value);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/* --- Serving size ------------------------------------------------------------------------ */

/**
 * The units taxonomy (`taxonomies/units.txt` at openfoodfacts-server bd90d81) as `init_units_names`
 * in `lib/ProductOpener/Units.pm` reads it: per entry, its `standard_unit:en`, its
 * `conversion_factor:en`, and its names (the `symbol:en` and every synonym in every language,
 * lowercased, `|`-separated). No name belongs to two entries.
 */
const UNIT_ENTRIES: readonly (readonly [standard: string, factor: number, names: string])[] = [
  [
    'g',
    1,
    'g|gr|grs|grm|gram|grams|جرام|جرامات|г|грам|грама|গ্রাম|গ্রামগুলি|grama|gramů|gramm|γραμμάριο|γραμμάρια|gramo|gramos|grammi|گرم|گرم‌ها|gramma|grammaa|gramme|grammes|גרם|גרמים|ग्राम|grammo|グラム|გრამი|გრამები|грамм|граммдар|ក្រាម|그램|gramas|gramai|grami|грамови|ഗ്രാം|ഗ്രാമങ്ങൾ|ဂရမ်|ဂရမ်များ|ग्रामहरू|gramy|gm|grame|граммы|gramov|gramë|gramu|கிராமம்|கிராமங்கள்|గ్రామం|గ్రామాలు|กรัม|грами|گرام|gam|克|公克',
  ],
  [
    'g',
    1000,
    'kg|kgs|kgr|kilo|kilos|kilogram|kilograms|كيلوغرام|كيلوغرامات|кг|килограм|килограма|কেজি|kilograma|quilograms|kilogramů|kilogramm|κιλό|κιλά|kilogramo|kilogramos|kilogrammi|کیلوگرم|کیلوگرم‌ها|kilogramma|kilogrammaa|kilogramme|kilogrammes|קילוגרם|קילוגרמים|किलोग्राम|chilogrammo|chilogrammi|キログラム|კილოგრამი|კილოგრამები|килограмм|килограммдар|គីឡូក្រាម|킬로그램|kilogramas|kilogramai|kilogrami|килограми|കിലോഗ്രാം|കിലോഗ്രാമുകൾ|ကီလိုဂရမ်|ကီလိုဂရမ်များ|किलोग्रामहरू|kilogramy|quilograma|quilogramas|kilograme|килограммы|kilogramov|kilogramë|kilogramu|கிலோகிராம்|கிலோகிராம்கள்|కిలోగ్రాం|కిలోగ్రాములు|กิโลกรัม|кілограм|кілограми|کلوگرام|kilôgam|千克|公斤',
  ],
  [
    'g',
    0.001,
    'mg|mgs|milligram|milligrams|ملغ|мг|милиграм|милиграма|মিলিগ্রাম|miligram|miligrama|mil·ligram|mil·ligrams|miligramů|milligramm|χιλιοστόγραμμο|χιλιοστόγραμμα|miligramo|miligramos|milligrammi|میلی‌گرم|میلی‌گرم‌ها|milligramma|milligrammaa|milligramme|milligrammes|מיליגרם|מיליגרמים|मिलीग्राम|milligrammo|ミリグラム|მილიგრამი|მილიგრამები|миллиграмм|миллиграммдар|មិល្លីក្រាម|밀리그램|miligramas|miligramai|miligrami|милиграми|മില്ലിഗ്രാം|മില്ലിഗ്രാമുകൾ|मिलिग्राम|မီလီဂရမ်|မီလီဂရမ်များ|मिलिग्रामहरू|miligramy|miligrame|миллиграммы|miligramov|miligramë|miligramu|மிகிராம்|மிகிராம்கள்|మిల్లీగ్రాము|మిల్లీగ్రాములు|มิลลิกรัม|міліграм|міліграми|ملی گرام|miligam|毫克',
  ],
  [
    'g',
    0.000001,
    'µg|mcg|mcgs|microgram|micrograms|ميكروغرام|микрограм|микрограма|মাইক্রোগ্রাম|mikrogram|mikrograma|micrògram|micrògrams|mikrogramů|mikrogramm|μικρογραμμάριο|μικρογραμμάρια|microgramo|microgramos|mikrogrammi|میکروگرم|میکروگرم‌ها|mikrogramma|mikrogrammaa|microgramme|microgrammes|מיקרוגרם|מיקרוגרמים|माइक्रोग्राम|microgrammo|microgrammi|マイクログラム|მიკროგრამი|მიკროგრამები|микрограмм|микрограммдар|ម៉ាយក្រូក្រាម|마이크로그램|mikrogramas|mikrogramai|mikrogrami|микрограми|മൈക്രോഗ്രാം|മൈക്രോഗ്രാംകൾ|मायक्रोग्राम|မိုက်ကွဲကိုဂရမ်|မိုက်ကွဲကိုဂရမ်များ|माइक्रोग्रामहरू|micogram|mikrogramy|micrograma|microgramas|micrograme|микрограммы|mikrogramov|mikrogramë|mikrogramu|மைக்ரோகிராம்|மைக்ரோகிராம்கள்|మైక్రోగ్రాము|మైక్రోగ్రాములు|ไมโครกรัม|мікрограм|мікрограми|مائیکرو گرام|microgam|微克',
  ],
  [
    'g',
    453.59237,
    'lb|lbs|pound|pounds|رطل|паунд|паунда|পাউন্ড|libra|liber|punt|pwysau|pund|pfund|λίβρα|λίβρες|libras|nael|naela|پوند|punti|paunat|mga pound|livre|livres|פאונד|פאונדים|पाउंड|funt|funte|font|fontok|libbra|libbre|ポンド|ფუნტი|ფუნტები|фунт|фунттар|ផោន|파운드|svaras|svarai|mārciņa|mārciņas|фунта|фунти|പൗണ്ട്|പൗണ്ടുകൾ|पाऊंड|paun|ပေါင်|ပေါင်များ|पाउन्ड|पाउन्डहरू|ponden|funty|liră|lire|фунты|libry|funti|paundë|фунте|pauni|பவுண்டு|பவுண்டுகள்|పౌండు|పౌండులు|ปอนด์|پاؤنڈ|پاؤنڈز|磅',
  ],
  ['g', 500, 'metric-pound|metric pound|metric pounds|livre métrique|livres métriques|斤'],
  [
    'g',
    28.349523125,
    'oz|ozs|onz|أونصة|أونصات|унция|унции|ঔঞ্জ|unce|owns|ownsiau|ounce|ounces|unze|unzen|ουγγιά|ουγγιές|onza|onzas|unts|untsid|انس|انس‌ها|unssi|unssia|mga ounce|once|onces|אונקייה|אונקיות|औंस|unca|uncia|ons|únsa|únsur|oncia|オンス|უნცია|უნცები|унциялар|អ៊ុនស្ករ|온스|uncijos|unces|унца|унција|ഓൺസ്|ഓൺസുകൾ|အောင်စီး|အောင်စီးများ|औंसहरू|uncja|uncje|onça|onças|uncie|unții|uncë|унце|uns|unsar|ownsi|ஆன்ஸ்|ஆன்ஸ்கள்|ఆన్స్|ఆన్సులు|ออนซ์|унція|унції|اونس|اونسز|盎司',
  ],
  [
    'ml',
    1000,
    'l|ls|liter|liters|لتر|لترات|л|литър|литра|লিটার|litar|litara|litre|litres|litr|litrů|λίτρο|λίτρα|litro|litros|liiter|liitrit|لیتر|لیترها|litra|litraa|ליטר|ליטרים|लीटर|litri|リットル|ლიტრი|ლიტრები|литр|литрлер|លីត្រ|리터|litras|litrai|литар|литри|ലീറ്റർ|ലീറ്റർകൾ|लिटर|လီတာ|လီတာများ|लिटरहरू|litry|litru|литры|litrov|lita|லிட்டர்|லிட்டர்கள்|లీటర్|లీటర్లు|ลิตร|літр|літри|لیٹر|lít|升|公升',
  ],
  [
    'ml',
    100,
    'dl|dls|deciliter|deciliters|ديسيلتر|ديسيلترات|децилитър|децилитри|децилитра|ডেসিলিটার|decilitr|decilitry|decilitrau|decilitre|deziliter|δεκατόλιτρο|δεκατόλιτρα|decilitro|decilitros|deciliiter|deciliitrit|دسی لیتر|دسی لیترها|desilitra|desilitraa|décilitre|décilitres|דציליטר|דציליטרים|डेसीलीटर|decilitra|decilitri|desiliter|desilítill|デシリットル|დეცილიტრი|დეცილიტრები|десилитр|десилитрлер|ដែលសីល្លីត្រ|데시리터|decilitras|decilitrai|decilitrs|десилитар|десилитри|ഡെസിലീറ്റർ|ഡെസിലീറ്റർകൾ|ဒီလီလီတာ|ဒီလီလီတာများ|डेसिलिटर|डेसिलिटरहरू|decylitr|decylitrów|decilitru|децилитр|децилитры|дл|децилитар|டெசிலிட்டர்|டெசிலிட்டர்கள்|డెసిలిటర్|డెసిలిటర్లు|เดซิลิตร์|分升',
  ],
  [
    'ml',
    10,
    'cl|cls|centiliter|centiliters|سنتيلتر|سنتيلترات|центилитър|центилитри|центилитра|সেন্টিলিটার|centilitr|centilitry|centilitrau|centilitre|zentiliter|εκατοστόλιτρο|εκατοστόλιτρα|centilitro|centilitros|tsentiliiter|tsentiliitrit|سانتی لیتر|سانتی لیترها|senttilitra|senttilitraa|centilitres|סנטיליטר|סנטיליטרים|सेंटीलीटर|centilitra|centilitri|sentilítill|センチリットル|ცენტილიტრი|ცენტილიტრები|сантилитр|сантилитрлер|សីល្លីត្រក្រឡាប់|센티리터|centilitras|centilitrai|centilitrs|центилитар|സെന്റിലീറ്റർ|സെന്റിലീറ്റർകൾ|စင်တီလီလီတာ|စင်တီလီလီတာများ|सेन्टिलिटर|सेन्टिलिटरहरू|centylitr|centylitrów|centilitru|центилитр|центилитры|кл|sentilita|சென்டிலிட்டர்|சென்டிலிட்டர்கள்|సెంటిలిటర్|సెంటిలిటర్లు|เซนติลิตร์|santilitre|santilitreler|центилітр|центилітри|سینٹی لیٹر|سینٹی لیٹرز|centilit|厘升',
  ],
  [
    'ml',
    1,
    'ml|mls|milliliter|milliliters|ملليلتر|ملليلترات|мл|милилитър|милилитри|милилитра|মিলিলিটার|mililitr|mililitry|millilitrau|millilitre|χιλιοστόλιτρο|χιλιοστόλιτρα|millilitro|millilitros|milliliiter|milliliitrit|میلی لیتر|میلی لیترها|millilitra|millilitraa|millilitres|מיליליטר|מיליליטרים|मिलीलीटर|mililitra|mililitri|millilítill|millilitri|ミリリットル|მილილიტრი|მილილიტრები|миллилитр|миллилитрлер|មិល្លីឡីត្រ|밀리리터|millilitras|millilitrai|mililitrs|миллилитар|миллилитри|മില്ലിലീറ്റർ|മില്ലിലീറ്റർകൾ|မီလီလီတာ|မီလီလီတာများ|मिलिलिटर|मिलिलिटरहरू|mililitrów|mililitru|миллилитры|милилитар|millilita|மில்லிலிட்டர்|மில்லிலிட்டர்கள்|మిల్లీలిటర్|మిల్లీలిటర్లు|มิลลิลิตร์|mililitre|mililitreler|мілілітр|мілілітри|ملی لیٹر|ملی لیٹرز|millilit|毫升',
  ],
  ['ml', 5, 'metric teaspoon|cucchiaino metrico'],
  ['ml', 240, 'cup|cups|kop|kopper|taza|tazas|tasse|tasses|tazza|tazze|kopp|koppar'],
  ['g', 10, 'bit|beetje'],
  ['ml', 1, 'pinch|pinches|drys|pincée|pincées|kryddmått|krm'],
  ['ml', 30, 'splash|dash|scheutje'],
  [
    'ml',
    29.5735,
    'fl oz|floz|fl.oz|fl. oz|fl. oz.|fl.oz.|oza|fluid ounce|fluid ounces|أونصة سائلة|أونصات سائلة|у. унция|у. унции|ফ্লুইড আউঞ্জ|unce tekutá|uncí tekutých|owns lliw|ownsiau lliw|fluidunze|fluidunzen|υγρού ουγγιάς|υγρές ουγγιές|onza líquida|onzas líquidas|vedelikuunts|vedelikuuntse|انس برابر|nestetuumaa|once liquide|onces liquides|אונקיית נוזל|אונקיות נוזל|फ्लूड औंस|tekuća unca|tekuće unce|fluid uncia|vökvaúnsa|vökvaúnsur|oncia liquida|液量オンス|ცივი უნცი|ცივი უნცები|сұйық унция|сұйық унциялар|អ៊ុនស្ករទឹក|액량 온스|skystasis uncijas|skystųjų uncijų|šķidrā unce|šķidrās uncijas|течна унца|течни унци|ഫ്ലൂഡ് ഓൺസ്|ഫ്ലൂഡ് ഓൺസുകൾ|फ्लुइड औंस|အရောင်အသွေး|အရောင်အသွေးများ|फ्लुड औंस|फ्लुड औंसहरू|uncja płynna|uncje płynne|onça líquida|onças líquidas|uncie lichide|unții lichide|жидкая унция|жидкие унции|fluidová unca|fluidové unce|tekoča unča|tekoče unče|uncë e lëngshme|unca e lëngshme|течне унце|ownsi ya maji|ownsi za maji|நீரின் ஆன்ஸ்|நீரின் ஆன்ஸ்கள்|ఫ్లూడ్ ఆన్స్|ఫ్లూడ్ ఆన్సులు|ออนซ์ของของเหลว|sıvı ons|рідка унція|рідкі унції|فلوڈ آنس|فلوڈ آنسز|ounce lỏng|液盎司',
  ],
  [
    'ml',
    3785.41,
    'gal|gals|gallon|gallons|غالون|غالونات|галон|галони|галона|গ্যালন|galon|galony|galwyn|gallone|gallonen|γαλόνι|γαλόνια|galón|galones|galloni|galloneid|گالن|گالن‌ها|gallona|gallonia|mga gallon|גלון|גלונים|गैलन|galoni|gallonok|gallónur|ガロン|გალონი|გალონები|галлон|галлондар|ហ្គាឡូន|갤런|galonas|galonai|ഗാലൺ|ഗാലൺകൾ|गॅलन|ဂါလန်|ဂါလန်များ|ग्यालन|ग्यालनहरू|galões|галлоны|galóny|gallonë|காலன்|காலன்கள்|గాలన్|గాలన్లు|แกลลอน|گیلن|گیلنز|加仑',
  ],
  [
    'kj',
    4.184,
    'kcal|kcals|kilocalories|cal|cals|calories|kilocalorie|calorie|سعرة حرارية، سعرة حرارية، سعرة حرارية، سعرة حرارية|ккал|килокалория|килокалории|калория|калории|কিলোক্যালোরি|ক্যালোরি|kilokalorie|kalorie|cilcalori|cilcaloriau|calori|caloriau|kilokalorier|kalorier|kilokalorien|kalorien|χιλιοθερμίδα|χιλιοθερμίδες|θερμίδα|θερμίδες|kilocaloría|kilocalorías|caloría|calorías|kilokalor|kilokalorid|kalor|kalorid|کیلوکالری|کیلوکالری‌ها|کالری|کالری‌ها|kilokalori|kilokalorit|kalori|kalorit|kilokaloriya|mga kilokaloriya|kaloriya|mga kaloriya|קילוקלורייה|קילוקלוריות|קלוריה|קלוריות|किलोकैलोरी|कैलोरी|kilokalorija|kilokalorije|kalorija|kalorije|kilokalória|kilokalóriák|kalória|kalóriák|kílókaloría|kílókaloríur|kaloría|kaloríur|chilocaloria|chilocalorie|caloria|キロカロリー|カロリー|კილოკალორია|კილოკალორიები|კალორია|კალორიები|килокалориялар|калориялар|គីឡូកាឡូរី|កាឡូរី|킬로칼로리|칼로리|kilokalorijos|kalorijos|kilokalorijas|kalorijas|килокалорија|калорија|കിലോകാലറി|കിലോകാലറികൾ|കലോറി|കലോറികൾ|किलोकॅलरी|कॅलोरी|ကီလိုက်ကယ်လိုက်|ကီလိုက်ကယ်လိုက်များ|ကယ်လိုက်|ကယ်လိုက်များ|किलोक्यालोरी|किलोक्यालोरीहरू|क्यालोरी|क्यालोरीहरू|kilocalorieën|calorieën|kilokaloria|kaloria|kilocaloria|kilocalorias|calorias|kilocalorii|calorii|kilokalórie|kalórie|килокалорије|калорије|கிலோகலோரி|கிலோகலோரிகள்|கலோரி|கலோரிகள்|కిలోకేలోరీ|కిలోకేలోరీలు|కేలరీ|కేలరీలు|กิโลแคลอรี่|แคลอรี่|килокалорія|кілокалорії|калорія|калорії|کلوکیلوری|کلوکیلوریز|کیلوری|کیلوریز|kilôcalo|calo|千卡|卡',
  ],
  [
    'kj',
    1,
    "kj|kjs|kilojoule|kilojoules|كيلوجول|كيلوجولات|килоджаул|килоджаула|কিলোজুল|kilojouly|ciljouls|ciljoulo|κιλοτζούλ|kilojulio|kilojulios|kilojouli|کیلوژول|kilojoulea|mga kilojoule|קילוג'ול|קילוג'ולים|किलोजूल|kilojoula|kílójúll|kílójúlar|chilojoule|キロジュール|კილოჯული|კილოჯულები|килоджоуль|килоджоульдер|គីឡូជូល|킬로쥴|kilojaulis|kilojauliai|kilojouls|килоџул|килоџули|കിലോജൂൾ|കിലോജൂൾസ്|ကီလိုဂျူး|ကီလိုဂျူးများ|किलोजुल|किलोजुलहरू|kilodżule|килоюл|килоюлей|kilodžul|கிலோஜூல்|கிலோஜூல்கள்|కిలోజూల్|కిలోజూల్స్|กิโลจูล|кілоджоуль|кілоджоулі|کلوجول|کلوجولز|kilôjoule|千焦",
  ],
  [
    'mmol/l',
    1,
    'mmol/l|مليمول/لتر|ммол/л|মিমি/লি|millimol/liter|millimol pro liter|χιλιοστόμολ ανά λίτρο|میلی مول بر لیتر|מילימול לליטר|मिलीमोल प्रति लीटर|მილიმოლი/ლიტრი|ммоль/л|មិល្លីមក្លូលីត្រ/លីត្រ|മില്ലിമോൾ/ലിറ്റർ|मिलीमोल प्रति लिटर|မီလီမိုး/လီတာ|मिलिमोल प्रति लिटर|மில்லிமோல்/லிட்டர்|మిల్లీమోల్/లీటరు|ملی مول فی لیٹر|毫摩尔/升',
  ],
  [
    'mol/l',
    1000,
    'mol/l|مول/لتر|мол/л|মোল/লিটার|mol/liter|mol pro liter|μολ ανά λίτρο|مول بر لیتر|מול לליטר|मोल प्रति लीटर|mól/l|モル/リットル|მოლი/ლიტრი|моль/л|ម៉ូល/លីត្រ|몰/리터|മോൾ/ലിറ്റർ|मोल प्रति लिटर|မိုလ်/လီတာ|மோல்/லிட்டர்|మోల్/లీటరు|มอล/ลิตร|مول فی لیٹر|摩尔/升',
  ],
  [
    'mmol/l',
    0.01,
    'ppm|parts per million|جزء في المليون|части на милион|পার্টস পার মিলিয়ন|částic na milion|rhanau fesul miliwn|dele pr. million|teile pro million|μέρη ανά εκατομμύριο|partes por millón|osakest miljoni kohta|قسمت در میلیون|osaa miljoonasta|mga bahagi kada milyon|parties par million|חלקים למיליון|प्रति मिलियन भाग|dijelovi na milijun|rész millióra|bagian per juta|hlutar á milljón|parti per milione|百万分率|bagéan saben juta|ნაწილები მილიონზე|миллион бөлшектеріне|ផ្ដាច់ក្នុងមួយលាន|백만 분율|dalių milijono dalimi|daļas uz miljonu|делови на милион|ഒരു മില്ലിയൺ ഭാഗം|bahagian setiap juta|delen per miljoen|deler per million|części na milion|partes por milhão|părți la milion|частей на миллион|častí na milión|delov na milijon|pjesë për milion|delova na milion|delar per miljon|vipande kwa milioni|ஒரு மில்லியன் பகுதிகள்|ఒక మిలియన్ భాగం|ส่วนต่อล้าน|milyonda bir kısım|часток на мільйон|فی ملین حصہ|phần triệu|百万分之',
  ],
  [
    'mmol/l',
    0.00001,
    'ppb|parts per billion|جزء في البليون|части на милиард|প্রতি বিলিয়ন অংশ|miliarda dílů|rhanau fesul biliwn|dele pr. miaard|teile pro milliarde|μέρη ανά δισεκατομμύριο|partes por mil millones|osakest miljardist|قسمت در میلیارد|osaa miljardista|parties par milliard|חלקים למיליארד|प्रति बिलियन भाग|dijelovi po milijardi|milliárdodrész|bagian per miliar|hlutar á milljarði|parti per miliardo|10億分の1|bagéyan saben miliyar|ნაწილები მილიარდში|миллиард бөлшектеріне|ផ្ដល់ចំនួនក្រាមមួយចំនួនប៉ុណ្ណោះ|10억분의 1|dalių milijardyje|daļas uz miljardu|делови на милијарда|ബില്യൺ ഭാഗങ്ങൾ|bahagian setiap bilion|စာမျက်နှာတစ်ခုတည်းစီမံပါ|deeltjes per miljard|del per milliard|części na miliard|partes por bilhão|părți la miliard|частей на миллиард|častí na miliardu|delov na milijardo|pjesë për miliard|делови на милијарду|delar per miljard|sehemu kwa bilioni|பில்லியன் பகுதிகள்|ప్రతి బిలియన్ భాగాలు|ส่วนต่อพันล้าน|milyarda bir kısım|часток на мільярд|پر بلین حصہ|phần trên một tỷ|十亿分之一',
  ],
  [
    'mmol/l',
    0.5,
    'mval/l|milivals per liter|مليفولت/لتر|милливал на литър|মিলিভাল প্রতি লিটার|milivalů na litr|millifoltdyddiau y llif|milival pr. liter|millival pro liter|χιλιοστά βαλ/λίτρο|milivales por litro|milivali liitri kohta|میلی ولت بر لیتر|milivaleja litrassa|mga milivals kada litro|milivals par litre|מילי וולט לליטר|प्रति लीटर मिलिवाल|milivali po litri|milival literenként|milival per liter|millival á lítra|milivali per litro|ミリバル毎リットル|milivals saben juta|მილივალები ლიტრზე|милливаль бөлшектеріне|មិនទាន់មាន|밀리발/리터|milivalų milijono dalimi|milivali uz litru|милливали по литар|ഒരു മില്ലിവാൽസ് പ്രതിലിറ്റർ|प्रति मिलिलीटर मिलिवाल|milival setiap liter|प्रति लिटर मिलिभाल|milivale na litr|milivali pe litru|милливалов на литр|milivalov na milión|milivalov na liter|milival për litër|milivali po litru|milival per miljon|milivals kwa milioni|ஒரு மில்லிவால் ஒரு லிட்டரின் முன்னணி|ఒక లీటరు మిలివాల్స్‌లు|มิลลิวอลต์ต่อลิตร|milival/litre|міліваль на літр|فی لیٹر ملی وال|milival trên mỗi lít|毫伏每升',
  ],
  [
    'mmol/l',
    0.171,
    'gpg|grams of calcium carbonate per gallon|جرام كربونات الكالسيوم في الجالون|грама въглеродатен калций на галон|প্রতি গ্যালনে ক্যালসিয়াম কার্বোনেটের গ্রাম|gramů uhličitanu vápenatého na galon|gramau carbonad calchfwrdd ym mhob galwyn|gram kalciumkarbonat pr. gallon|gramm calciumcarbonat pro gallone|γραμμάρια ανθρακικού ασβεστίου ανά γαλόνι|gramos de carbonato de calcio por galón|grammi kaltsiumkarbonaati galloni kohta|گرم کربنات کلسیم در گالن|grammaa kalsiumkarbonaattia per gallona|gram ng calcium carbonate kada galon|grammes de carbonate de calcium par gallon|גרמים של קרבונט סידן לגלון|प्रति गैलन कैल्शियम कार्बोनेट के ग्राम|grama kalcijevog karbonata po galonu|gramm kalcium-karbonát literenként|gram kalsium karbonat per galon|grömm kalsíumkarbónats á galloni|grammi di carbonato di calcio per gallone|ガロンあたりの炭酸カルシウムのグラム数|gram kalsium karbonat saben galon|გრამი კალციუმ-კარბონატი გალონზე|галлон бойынша кальций карбонаттың граммы|ក្រាមកាល្យស៊ីដ្រាមក្នុងមួយហាង|갤런당 탄산 칼슘 그램|gramų kalcio karbonato viename galone|grami kalcija karbonāta uz galonu|грама калциум карбонат на галон|ഗാലൺ കാൽസിയം കാർബോണേറ്റിന്റെ ഗ്രാം|प्रति गॅलन कॅल्शियम कार्बोनेटचे ग्राम|gram kalsium karbonat setiap galon|ဂယ်လိုရီကိုဘယ်လိုရောက်လဲ|प्रति ग्यालन क्याल्सियम कार्बोनेटको ग्राम|gram calciumcarbonaat per gallon|gram kalsiumkarbonat per gallon|gram węglanu wapnia na galon|gramas de carbonato de cálcio por galão|grame de carbonat de calciu pe galon|грамм кальция карбоната на галлон|gramov uhličitanu vápenatého na galón|gramov kalcijevega karbonata na galon|gram kalcium karbonati për gallon|грама калцијум карбоната по галону|gram kalciumkarbonat per gallon|gramu la kaboneti ya kalsiamu kwa galoni|கால்சியம் கார்போனேடு ஒரு கலனில் கிராமங்கள்|గ్యాలన్‌లో కార్బనేట్ కాల్సియం గ్రామాలు|กรัมของแคลเซียมคาร์บอเนตต่อแกลลอน|gallon başına kalsiyum karbonat gramı|грам кальцію карбонату на галон|گیلن فی کیلشیم کاربونیٹ کے گرام|gram canxi cacbonat trên mỗi galon|每加仑碳酸钙的克数',
  ],
  ['mmol/l', 0.1783, 'dgh|°dh|°d'],
  ['mmol/l', 0.1424, '°e|°clark'],
  ['mmol/l', 0.09991, '°fh|°f|°hf'],
  ['mmol/l', 0.025, '°rh'],
  ['% vol', 1, '% vol|percent vol|%vol'],
  ['% vol (alcohol)', 1, '% vol (alcohol)|percent vol (alcohol)'],
  ['%', 1, '%|percent'],
  ['pH', 1, 'ph'],
  ['% dv', 1, '% dv|percent dv|%dv'],
  [
    'mg',
    1,
    'mg/kg|mg / kg|mg per kg|milligrams per kilogram|milligram per kilogram|milligramm pro kilogramm|miligramos por kilogramo|milligrammes par kilogramme|milligramme par kilogramme',
  ],
  [
    'mcg',
    1,
    'mcg/kg|µg/kg|ug/kg|mcg / kg|µg / kg|ug / kg|micrograms per kilogram|microgram per kilogram|microgrammes par kilogramme',
  ],
  [
    'iu',
    1,
    'iu/kg|ui/kg|i.u/kg|u.i/kg|iu / kg|ui / kg|international units per kilogram|unités internationales par kilogramme',
  ],
  [
    'iu',
    1,
    'iu|i.u|ui|u.i|ie|i.e|international unit|وحدة دولية|международна единица|আন্তর্জাতিক একক|mezinárodní jednotka|uned ryngwladol|international enhed|internationale einheit|διεθνής μονάδα|unidad internacional|rahvusvaheline ühik|واحد بین‌المللی|kansainvälinen yksikkö|unité internationale|יחידה בינלאומית|अंतर्राष्ट्रीय इकाई|međunarodna jedinica|nemzetközi egység|unit internasional|alþjóðleg eining|unità internazionale|国際単位|საერთაშორისო ერთეული|әлемдік бірлік|ឯកតាអន្តរជាតិ|국제 단위|tarpinė vienetai|starptautiskā vienība|меѓународна единица|അന്താരാഷ്ട്ര യൂണിറ്റ്|अंतरराष्ट्रीय एकक|unit antarabangsa|အပြည်ပြည်ဆိုင်းအခြေအနေ|अन्तर्राष्ट्रिय इकाई|internationale eenheid|internasjonal enhet|jednostka międzynarodowa|unidade internacional|unitate internațională|международная единица|medzinárodná jednotka|mednarodna enota|njësia ndërkombëtare|међународна јединица|internationell enhet|kiwango cha kimataifa|சர்வதேச அலகு|అంతర్జాతీయ యూనిట్|หน่วยนานาชาติ|uluslararası birim|міжнародна одиниця|بین الاقوامی اکائی|đơn vị quốc tế|国际单位',
  ],
  [
    'ufc',
    1,
    'ufc|cfu|colony forming unit|colony forming units|colony-forming unit|colony-forming units|unidad formadora de colonias|unidades formadoras de colonias|unité formant colonie|unités formant colonie',
  ],
];

/** A unit name's entry: the unit it standardizes to and the factor to it. */
type UnitEntry = { readonly name: string; readonly standard: string; readonly factor: number };

/** Every unit name, lowercased, to its entry (`%units_names`). */
const UNIT_NAMES: ReadonlyMap<string, UnitEntry> = new Map(
  UNIT_ENTRIES.flatMap(([standard, factor, names]) =>
    names.split('|').map((name) => [name, { name, standard, factor }] as const),
  ),
);

/** The longest unit name, in UTF-16 code units: the regexp alternation tries longer names first. */
const LONGEST_UNIT_NAME = Math.max(...[...UNIT_NAMES.keys()].map((name) => name.length));

/** The first character of each unit name, a cheap test before the length-by-length lookup. */
const UNIT_FIRST_CHARACTERS: ReadonlySet<string> = new Set(
  [...UNIT_NAMES.keys()].map((name) => name.charAt(0)),
);

/* Perl's Unicode character classes, one character at a time; an index past either end is none of them. */
const DIGIT = /\p{Nd}/u;
const LETTER = /\p{L}/u;
const SPACE = /\s/u;
const WORD = /[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]/u;
const isDigit = (text: string, at: number) => DIGIT.test(text.charAt(at));
const isSpace = (text: string, at: number) => SPACE.test(text.charAt(at));
const isWord = (text: string, at: number) => WORD.test(text.charAt(at));
/** Perl's `\b` between `at - 1` and `at`. */
const isBoundary = (text: string, at: number) => isWord(text, at - 1) !== isWord(text, at);
/** Whether `at` holds the first digit of a digit run. */
const startsDigitRun = (text: string, at: number) => isDigit(text, at) && !isDigit(text, at - 1);
/** Where the digit run starting at `at` ends. */
const digitRunEnd = (text: string, at: number) => {
  let end = at;
  while (isDigit(text, end)) end++;
  return end;
};
/** Where a regexp `( )?` after `at` may resume, greedy first: past the space `space` accepts, then at `at`. */
const afterOptionalSpace = (
  text: string,
  at: number,
  space: (text: string, at: number) => boolean = isSpace,
) => (space(text, at) ? [at + 1, at] : [at]);

/**
 * Where `$number_regexp` (`\.\d+|\d+(?:[,.]\d+)?`, `lib/ProductOpener/Numbers.pm`) matched at
 * `start` ends, or `undefined`. Its digit runs are taken whole: giving digits back helps only a
 * unit name that starts with a digit, and the two that do (ja and ko "parts per billion") are not
 * retried.
 */
function numberEnd(text: string, start: number): number | undefined {
  if (text.charAt(start) === '.') {
    const end = digitRunEnd(text, start + 1);
    return end > start + 1 ? end : undefined;
  }
  const end = digitRunEnd(text, start);
  if (end === start) return;
  const separator = text.charAt(end);
  if (separator !== ',' && separator !== '.') return end;
  const fraction = digitRunEnd(text, end + 1);
  return fraction > end + 1 ? fraction : end;
}

/**
 * The unit `$units_regexp` matches at `start` in lowercased `text`: the longest name there for
 * which `accepts` holds where it ends, as the alternation backtracks from longer names to shorter.
 */
function unitAt(
  text: string,
  start: number,
  accepts: (end: number) => boolean,
): UnitEntry | undefined {
  if (!UNIT_FIRST_CHARACTERS.has(text.charAt(start))) return;
  for (let length = Math.min(LONGEST_UNIT_NAME, text.length - start); length > 0; length--) {
    const entry = UNIT_NAMES.get(text.slice(start, start + length));
    if (entry && accepts(start + length)) return entry;
  }
  return undefined;
}

/** `(NUMBER)<one optional space>(UNIT)` at `start`; `space` is the class the optional character is in. */
function numberAndUnitAt(
  text: string,
  start: number,
  space: (text: string, at: number) => boolean,
  accepts: (end: number) => boolean,
): { quantity: string; unit: UnitEntry } | undefined {
  const end = numberEnd(text, start);
  if (end === undefined) return;
  for (const unitStart of afterOptionalSpace(text, end, space)) {
    const unit = unitAt(text, unitStart, accepts);
    if (unit) return { quantity: text.slice(start, end), unit };
  }
  return undefined;
}

/**
 * `normalize_serving_size`'s match, `/^(.*[ (])?(NUMBER)( )?(UNIT)\b/i`: the last number and unit
 * on the first line that follow a space or an opening parenthesis, else the ones at its start.
 */
function servingNumberAndUnit(text: string): { quantity: string; unit: UnitEntry } | undefined {
  const accepts = (end: number) => isBoundary(text, end);
  const literalSpace = (value: string, at: number) => value.charAt(at) === ' ';
  const lineBreak = text.indexOf('\n');
  for (let at = (lineBreak === -1 ? text.length : lineBreak) - 1; at >= 0; at--) {
    const character = text.charAt(at);
    if (character !== ' ' && character !== '(') continue;
    const match = numberAndUnitAt(text, at + 1, literalSpace, accepts);
    if (match) return match;
  }
  return numberAndUnitAt(text, 0, literalSpace, accepts);
}

/** The separators of `parse_quantity_unit`'s multiplier form, in alternation order. */
const MULTIPLIER_SEPARATORS = [' de ', ' of ', 'x', '*'] as const;

/**
 * The unit `parse_quantity_unit` finds (`lib/ProductOpener/Units.pm`): the multiplier form,
 * `/(\d+)(\s(\p{Letter}| )+)?(\s)?( de | of |x|\*)(\s)?(NUMBER)(\s)?(UNIT)\b/i` (`6 x 33 cl`), at its
 * leftmost match, else `/(NUMBER)(\s)?(UNIT)\s*\b/i` at its leftmost. Linear: an attempt starts
 * only at a digit run's first digit, since one inside the run ends where the run's own does, and
 * each letter run is retried only by the digit run before it.
 */
function quantityUnit(text: string): UnitEntry | undefined {
  const atBoundary = (end: number) => isBoundary(text, end);
  for (let start = 0; start < text.length; start++) {
    if (!startsDigitRun(text, start)) continue;
    const digitsEnd = digitRunEnd(text, start);
    // (\s(\p{Letter}| )+)? is greedy: its longest extent first, then each shorter one, then none.
    const groupEnds: number[] = [];
    if (isSpace(text, digitsEnd)) {
      let end = digitsEnd + 1;
      while (end < text.length && (LETTER.test(text.charAt(end)) || text.charAt(end) === ' '))
        end++;
      for (let groupEnd = end; groupEnd >= digitsEnd + 2; groupEnd--) groupEnds.push(groupEnd);
    }
    groupEnds.push(digitsEnd);
    for (const groupEnd of groupEnds) {
      for (const separatorStart of afterOptionalSpace(text, groupEnd)) {
        for (const separator of MULTIPLIER_SEPARATORS) {
          if (!text.startsWith(separator, separatorStart)) continue;
          const after = separatorStart + separator.length;
          for (const numberStart of afterOptionalSpace(text, after)) {
            const match = numberAndUnitAt(text, numberStart, isSpace, atBoundary);
            if (match) return match.unit;
          }
        }
      }
    }
  }
  const spacesThenBoundary = (end: number) => {
    let spaces = end;
    while (isSpace(text, spaces)) spaces++;
    for (let at = spaces; at >= end; at--) if (isBoundary(text, at)) return true;
    return false;
  };
  for (let start = 0; start < text.length; start++) {
    if (isDigit(text, start) && !startsDigitRun(text, start)) continue;
    const match = numberAndUnitAt(text, start, isSpace, spacesThenBoundary);
    if (match) return match.unit;
  }
  return undefined;
}

/** The code points of zero in the scripts whose digits `convert_string_to_number` reads as ASCII. */
const CONVERTED_DIGIT_ZEROS = [0x0660, 0x06f0, 0x09e6] as const;

/**
 * `convert_string_to_number` (`lib/ProductOpener/Numbers.pm`) for a matched number: Arabic-Indic,
 * Persian, and Bengali digits read as ASCII, a lone decimal comma read as a point, then Perl
 * numification, under which any other script's digits read as 0.
 */
function convertStringToNumber(quantity: string): number {
  const ascii = quantity.replace(/\p{Nd}/gu, (digit) => {
    const code = digit.charCodeAt(0);
    const zero = CONVERTED_DIGIT_ZEROS.find((first) => code >= first && code <= first + 9);
    return zero === undefined ? digit : String(code - zero);
  });
  return perlNumify(ascii.includes('.') ? ascii : ascii.replace(',', '.'));
}

/**
 * `serving_quantity` and `serving_quantity_unit` as the downgrade to API v2 rewrites them from a
 * non-empty `serving_size` (`normalize_product_quantity_and_serving_size`). The quantity is the
 * serving in its unit's standard unit (`normalize_serving_size` → `unit_to_g`, a `kcal` serving
 * rounded to whole kJ), `null` when no number and unit parse. The unit is the standard unit of the
 * first number and unit `parse_quantity_unit` finds, `undefined` when it finds none, which keeps
 * the stored one: `1/2 cup (60 g)` stored as `g` reads back as `ml`, from the cup.
 */
function normalizedServing(servingSize: string): {
  quantity: number | null;
  unit: string | undefined;
} {
  const text = servingSize.toLowerCase();
  const match = servingNumberAndUnit(text);
  return {
    quantity: match ? unitToG(convertStringToNumber(match.quantity), match.unit.name) : null,
    unit: quantityUnit(text)?.standard,
  };
}

/**
 * `unit_to_g` (`lib/ProductOpener/Units.pm`): `value` in its unit's standard unit, a `kcal` value
 * rounded to whole kJ, and a unit outside the units taxonomy leaving it as it is. Its first step
 * is a substitution on `value`, which stringifies a number to 15 significant digits: a serving of
 * `14.000000000000002g` is 14.
 */
function unitToG(value: unknown, unit: string | undefined): number {
  const number =
    typeof value === 'number'
      ? perlNumber(value)
      : perlNumify(typeof value === 'string' ? value.replace(',', '.') : value);
  const name = (unit ?? '').toLowerCase();
  if (name === 'kcal') return Math.trunc(number * 4.184 + 0.5);
  const entry = UNIT_NAMES.get(name);
  return entry ? number * entry.factor : number;
}

/**
 * A JSON value with every number as Product Opener's JSON writes it (`perlNumber`): the stored
 * input sets as a v3.5 read prints them, `0.95` where the export holds `0.9500000000000001`.
 */
function withPerlNumbers(value: unknown): unknown {
  if (typeof value === 'number') return perlNumber(value);
  if (Array.isArray(value)) return value.map(withPerlNumbers);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, withPerlNumbers(entry)]),
  );
}

/**
 * A JSON value with every object's keys sorted, the order Product Opener's API writes them in
 * (`JSON::MaybeXS->canonical` in `lib/ProductOpener/API.pm`). A reader that walks an object sees
 * that order: `off_get_product` lists a product's other nutrients in `nutriments` key order.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/* --- Builder ----------------------------------------------------------------------------- */

/** One export or delta JSONL line, already JSON.parsed. Returns null for a line that is not a servable product (no code, a non-object). Throws only on programmer error. */
export function buildMirrorRecord(p: unknown): MirrorRecord | null {
  if (!isRecord(p)) return null;
  const code = p.code;
  if (typeof code !== 'string' || !BARCODE_PATTERN.test(code)) return null;

  /**
   * convert_product_schema: an unversioned record is read as 999, or 1000 once it carries an
   * environmental score; normalize_product_data then settles the main language.
   */
  let from = typeof p.schema_version === 'number' ? p.schema_version : 999;
  if (from < 1000 && 'environmental_score_grade' in p) from = 1000;
  const lc =
    [p.lc, p.lang].find((value): value is string => typeof value === 'string' && value !== '') ??
    'en';

  const nutrition = from <= 1002 ? upgradeLegacyNutrition(p) : undefined;
  const stored = isRecord(p.nutrition) ? p.nutrition : undefined;
  const aggregated = nutrition ? nutrition.aggregated : stored?.aggregated_set;
  const downgraded = isRecord(aggregated) && Object.keys(aggregated).length > 0;
  /**
   * The downgrade re-derives the serving from serving_size, and drops it when serving_size is
   * empty; without an aggregated set nothing is downgraded and the stored fields pass through.
   * Perl stringifies a non-scalar serving_size into text no number parses from.
   */
  const servingSize = p.serving_size;
  const servingText =
    typeof servingSize === 'string' || typeof servingSize === 'number' ? String(servingSize) : '';
  const serving =
    downgraded && defined(servingSize) && servingSize !== ''
      ? normalizedServing(servingText)
      : undefined;
  const nutriments = downgraded
    ? v2Nutriments(aggregated, serving?.quantity ?? undefined)
    : undefined;

  const doc: Raw = {};
  const set = (key: string, value: unknown) => {
    if (defined(value)) doc[key] = value;
  };
  set('code', code);
  set('product_name', languageField(p, 'product_name', lc));
  set('brands', v2Brands(p, from));
  set('quantity', p.quantity);
  set('ingredients_text', languageField(p, 'ingredients_text', lc));
  set(
    'ingredients',
    Array.isArray(p.ingredients) ? projectIngredients(p.ingredients) : p.ingredients,
  );
  for (const field of [
    'allergens_tags',
    'traces_tags',
    'additives_tags',
    'ingredients_analysis_tags',
  ]) {
    set(field, v2Tags(p, field, from));
  }
  set('nutriscore_grade', p.nutriscore_grade);
  set('nova_group', p.nova_group);
  set('ecoscore_grade', v2EcoscoreGrade(p, from));
  set('nutriments', nutriments);
  set('serving_size', downgraded && servingSize === '' ? undefined : servingSize);
  if (!downgraded) {
    const servingQuantity = p.serving_quantity;
    set(
      'serving_quantity',
      typeof servingQuantity === 'number' ? perlNumber(servingQuantity) : servingQuantity,
    );
  } else if (serving) {
    // An unparseable serving_size leaves serving_quantity undef, which the v2 JSON writes as null.
    doc.serving_quantity = serving.quantity === null ? null : perlNumber(serving.quantity);
  }
  set('serving_quantity_unit', serving?.unit ?? p.serving_quantity_unit);
  for (const field of [
    'categories_tags',
    'labels_tags',
    'packaging_tags',
    'origins_tags',
    'countries_tags',
  ]) {
    set(field, v2Tags(p, field, from));
  }
  set('image_url', frontImageUrl(p, from, lc, code));
  set(
    'completeness',
    typeof p.completeness === 'number' ? perlNumber(p.completeness) : p.completeness,
  );
  set('data_quality_tags', p.data_quality_tags);
  if (holdsOnlyPreparedFigures(nutriments)) {
    set('_input_sets', withPerlNumbers(nutrition ? nutrition.inputSets : stored?.input_sets));
  }

  const tags = new Set<string>();
  for (const facet of MIRROR_TAG_FACETS) {
    const values = p[`${facet}_tags`];
    if (!Array.isArray(values)) continue;
    for (const tag of values)
      if (typeof tag === 'string' && tag !== '') tags.add(mirrorTagKey(facet, tag));
  }

  return {
    code: normalizeCodeZeroes(code),
    popularityKey: numberOrNull(p.popularity_key),
    uniqueScansN: numberOrNull(p.unique_scans_n),
    createdT: numberOrNull(p.created_t),
    lastModifiedT: numberOrNull(p.last_modified_t),
    tags: [...tags],
    doc: canonical(doc) as Raw,
  };
}
