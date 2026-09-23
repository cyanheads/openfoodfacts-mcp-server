/**
 * @fileoverview Tool definition for fetching a food product by barcode from Open Food Facts.
 * @module mcp-server/tools/definitions/get-product
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import {
  BARCODE_PATTERN,
  BARCODE_PATTERN_MESSAGE,
  type RawIngredient,
  type RawNutriments,
  type RawProduct,
} from '@/services/openfoodfacts/types.js';
import { mdCodeFence, mdInline, mdUrl } from '@/utils/markdown.js';

/**
 * Fields a requested field needs to be readable, fetched alongside it. Open Food Facts returns
 * exactly the `fields=` list it is given, so a subset that names a value without its denominator
 * gets figures nothing can interpret — per-serving nutrition with no serving size, a serving unit
 * with no quantity to describe. Expanding the request is what keeps the response's own claim about
 * why something is missing true: an absent value is absent upstream, never merely unasked-for.
 */
const FIELD_DEPENDENCIES: Record<string, readonly string[]> = {
  nutriments: ['serving_size', 'serving_quantity', 'serving_quantity_unit'],
  serving_quantity_unit: ['serving_quantity', 'serving_size'],
  serving_quantity: ['serving_size'],
};

/**
 * The caller's field subset plus every field those depend on, in request order with the additions
 * appended. Deduplicated, so naming a dependency explicitly costs nothing.
 */
function expandFields(fields: readonly string[]): string[] {
  const expanded = new Set(fields);
  for (const field of fields) {
    for (const dependency of FIELD_DEPENDENCIES[field] ?? []) expanded.add(dependency);
  }
  return [...expanded];
}

/** One nutrient from the open map: the figure plus the unit Open Food Facts reported it in. */
type NutrimentEntry = { value: number; unit?: string };

type NamedNutriments = {
  energy_kcal_100g?: number;
  fat_100g?: number;
  saturated_fat_100g?: number;
  carbohydrates_100g?: number;
  sugars_100g?: number;
  fiber_100g?: number;
  proteins_100g?: number;
  salt_100g?: number;
  sodium_100g?: number;
  energy_kcal_serving?: number;
  fat_serving?: number;
  sugars_serving?: number;
};

type NormalizedNutriments = NamedNutriments & {
  additional_100g?: Record<string, NutrimentEntry>;
  additional_serving?: Record<string, NutrimentEntry>;
};

/** Maps raw hyphenated nutriment keys → named output schema keys. */
const NUTRIMENT_MAP: [string, keyof NamedNutriments][] = [
  ['energy-kcal_100g', 'energy_kcal_100g'],
  ['fat_100g', 'fat_100g'],
  ['saturated-fat_100g', 'saturated_fat_100g'],
  ['carbohydrates_100g', 'carbohydrates_100g'],
  ['sugars_100g', 'sugars_100g'],
  ['fiber_100g', 'fiber_100g'],
  ['proteins_100g', 'proteins_100g'],
  ['salt_100g', 'salt_100g'],
  ['sodium_100g', 'sodium_100g'],
  ['energy-kcal_serving', 'energy_kcal_serving'],
  ['fat_serving', 'fat_serving'],
  ['sugars_serving', 'sugars_serving'],
];

/**
 * Raw keys already surfaced as named fields, derived from the map rather than restated, so the two
 * cannot drift apart. Exclusion is per exact key — not per base nutrient — because the named set is
 * asymmetric across suffixes: `saturated-fat_100g` is named while `saturated-fat_serving` is not,
 * so excluding by base name would drop the per-serving figure from both surfaces.
 */
const NAMED_RAW_KEYS = new Set(NUTRIMENT_MAP.map(([rawKey]) => rawKey));

/**
 * Base keys that live in the nutriments map but are not nutrients. Open Food Facts stores the NOVA
 * processing class there alongside real nutrients (live-verified: `nova-group`, `nova-group_100g`,
 * `nova-group_serving`, with an empty `nova-group_unit`). It is already surfaced as the typed
 * `nova_group` field, so passing it through the open map would report the same classification twice
 * — once as a product score and once as a unitless "nutrient".
 */
const NON_NUTRIMENT_BASE_KEYS = new Set(['nova-group']);

/** Reads a `{base}_unit` sibling, ignoring the empty strings Open Food Facts stores for some keys. */
function nutrimentUnit(raw: RawNutriments, base: string): string | undefined {
  const unit = raw[`${base}_unit`];
  return typeof unit === 'string' && unit !== '' ? unit : undefined;
}

/**
 * Collects every numeric nutrient carrying `suffix` that is not already a named field, keyed by the
 * hyphen-free base name. The per-key unit is carried rather than assumed: Open Food Facts reports
 * most nutrients in grams but not all — `energy` is kJ and `energy-kcal` is kcal on the same
 * product — so normalizing everything to "grams" would mislabel them.
 */
function collectAdditional(
  raw: RawNutriments,
  suffix: '_100g' | '_serving',
): Record<string, NutrimentEntry> | undefined {
  const result: Record<string, NutrimentEntry> = {};
  for (const [rawKey, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !rawKey.endsWith(suffix) || NAMED_RAW_KEYS.has(rawKey)) {
      continue;
    }
    const base = rawKey.slice(0, -suffix.length);
    if (NON_NUTRIMENT_BASE_KEYS.has(base)) continue;
    const unit = nutrimentUnit(raw, base);
    result[base.replace(/-/g, '_')] = { value, ...(unit !== undefined && { unit }) };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Normalize the raw hyphenated nutriments map to the output schema shape. */
function normalizeNutriments(raw: RawNutriments | undefined): NormalizedNutriments | undefined {
  if (!raw) return;
  const result: NormalizedNutriments = {};
  for (const [rawKey, outKey] of NUTRIMENT_MAP) {
    const v = raw[rawKey];
    if (typeof v === 'number') result[outKey] = v;
  }
  const additional_100g = collectAdditional(raw, '_100g');
  if (additional_100g) result.additional_100g = additional_100g;
  const additional_serving = collectAdditional(raw, '_serving');
  if (additional_serving) result.additional_serving = additional_serving;

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Format a completeness score with its exact value and a human-readable label. The rounded
 * percentage alone is lossy and unrecoverable — a text-only client reading "79%" cannot get back to
 * 0.7875, and re-calling returns the same rounded string — so the scalar is rendered alongside it.
 */
function completenessLabel(score: number): string {
  const pct = Math.round(score * 100);
  if (score >= 0.8) return `${pct}% (exact ${score}, high)`;
  if (score >= 0.5) return `${pct}% (exact ${score}, moderate)`;
  return `${pct}% (exact ${score}, low — many fields missing)`;
}

/**
 * Render one open-map nutrient as a markdown bullet, carrying its upstream unit. Takes the Zod
 * inferred shape (`unit?: string | undefined`) rather than `NutrimentEntry`, since `format()` is
 * typed from the output schema and the project runs `exactOptionalPropertyTypes`.
 */
function additionalLines(
  entries: Record<string, { value: number; unit?: string | undefined }>,
): string[] {
  return Object.entries(entries).map(
    ([key, { value, unit }]) => `  - ${mdInline(key)}: ${value}${unit ? ` ${mdInline(unit)}` : ''}`,
  );
}

/** Join a canonical tag list for display, escaping each value for the line it lands on. */
function tagList(tags: string[]): string {
  return tags.map(mdInline).join(', ');
}

/**
 * Fields every parsed-ingredient entry carries, at every level of the tree. A factory rather than
 * a shared object so each level gets its own schema instances.
 */
const ingredientEntryFields = () => ({
  id: z.string().optional().describe('Canonical ingredient ID (e.g. "en:sugar", "en:salt").'),
  text: z.string().describe('Ingredient name as it appears in the list.'),
  percent_estimate: z
    .number()
    .optional()
    .describe(
      "Estimated share of the whole product, in percent. On a sub-ingredient it is still a share of the whole product, not of its parent — a parent's estimate already includes its sub-ingredients, so summing across levels double-counts.",
    ),
  vegan: z.string().optional().describe('"yes", "no", or "maybe" — absent when unknown.'),
  vegetarian: z.string().optional().describe('"yes", "no", or "maybe" — absent when unknown.'),
});

/**
 * Deepest level of the parsed-ingredient tree the output schema declares. The schema is written
 * out level by level rather than as a self-referential one: a recursive schema overflows the
 * definition linter's stack and emits `$defs`/`$ref`, which some clients reject. Three is the
 * deepest Open Food Facts has been observed to nest (616 products surveyed); upstream permits more,
 * so a deeper entry is folded in at this level rather than dropped (see `buildIngredients`).
 */
const INGREDIENT_TREE_DEPTH = 3;

/** A third-level entry — the deepest the schema declares, so it carries no `ingredients` of its own. */
const thirdLevelIngredient = z
  .object(ingredientEntryFields())
  .describe(
    'A sub-ingredient at the third level. An entry nested deeper upstream is listed at this level too, directly after the entry it belongs under.',
  );

/** A second-level entry, whose own sub-ingredients are the third level. */
const secondLevelIngredient = z
  .object({
    ...ingredientEntryFields(),
    ingredients: z
      .array(thirdLevelIngredient)
      .optional()
      .describe(
        'Sub-ingredients of this entry. Anything nested deeper upstream is listed here as well, right after the entry it belongs under, so no entry is dropped. Absent when the entry has none.',
      ),
  })
  .describe('A sub-ingredient of a top-level entry.');

/** One parsed-ingredient entry and its sub-ingredients, as the output carries them. */
type IngredientOutput = {
  id?: string;
  text: string;
  percent_estimate?: number;
  vegan?: string;
  vegetarian?: string;
  ingredients?: IngredientOutput[];
};

/**
 * Normalize a parsed-ingredient list, keeping each entry's sub-ingredients nested under it down to
 * `INGREDIENT_TREE_DEPTH`. At that level an entry cannot carry `ingredients`, so its descendants
 * are folded in after it in pre-order: only the parentage below the third level is flattened, and
 * nothing is dropped. An empty upstream `ingredients` array is not carried — it means no children.
 */
function buildIngredients(raw: RawIngredient[], level = 1): IngredientOutput[] {
  return raw.flatMap((ing) => {
    const entry: IngredientOutput = {
      ...(ing.id && { id: ing.id }),
      text: ing.text ?? '',
      ...(typeof ing.percent_estimate === 'number' && {
        percent_estimate: ing.percent_estimate,
      }),
      ...(ing.vegan && { vegan: ing.vegan }),
      ...(ing.vegetarian && { vegetarian: ing.vegetarian }),
    };
    const children = ing.ingredients ?? [];
    if (children.length === 0) return [entry];
    if (level < INGREDIENT_TREE_DEPTH) {
      return [{ ...entry, ingredients: buildIngredients(children, level + 1) }];
    }
    return [entry, ...buildIngredients(children, level)];
  });
}

/**
 * A parsed-ingredient entry as `format()` receives it. Structural rather than the output type,
 * since the Zod-inferred shape differs per level and the project runs `exactOptionalPropertyTypes`.
 */
type RenderedIngredient = {
  id?: string | undefined;
  text: string;
  percent_estimate?: number | undefined;
  vegan?: string | undefined;
  vegetarian?: string | undefined;
  ingredients?: RenderedIngredient[] | undefined;
};

/**
 * Render a parsed-ingredient tree as a nested Markdown list, each sub-ingredient indented under
 * its parent. The estimate is rendered at full precision — rounding to one decimal turned 56.85
 * into "56.9", an unrecoverable loss since re-calling returns the same text — and "maybe" is kept,
 * since it is a real Open Food Facts verdict (the status depends on sourcing), not an unknown.
 */
function ingredientLines(entries: RenderedIngredient[], depth = 0): string[] {
  return entries.flatMap((ing) => {
    const attrs: string[] = [];
    if (ing.id) attrs.push(`id: ${mdInline(ing.id)}`);
    if (ing.percent_estimate !== undefined) attrs.push(`~${ing.percent_estimate}%`);
    if (ing.vegan) attrs.push(`vegan: ${mdInline(ing.vegan)}`);
    if (ing.vegetarian) attrs.push(`vegetarian: ${mdInline(ing.vegetarian)}`);
    const line = `${'  '.repeat(depth)}- ${mdInline(ing.text)}${attrs.length > 0 ? ` (${attrs.join(', ')})` : ''}`;
    return [line, ...ingredientLines(ing.ingredients ?? [], depth + 1)];
  });
}

/**
 * Render the serving denominator: the printed label plus the parsed quantity when OFF has one.
 * Only called when at least one of the two exists — a product with neither gets the disclosure in
 * the per-serving section instead, where the missing denominator is what the reader needs to know.
 */
function servingSizeLine(
  servingSize: string | undefined,
  quantity: number | undefined,
  unit: string | undefined,
): string {
  const parsed =
    quantity !== undefined
      ? ` (parsed: ${quantity}${unit ? ` ${mdInline(unit)}` : ' — unit not recorded'})`
      : '';
  const printed = servingSize === undefined ? 'Not printed on the label' : mdInline(servingSize);
  return `**Serving size:** ${printed}${parsed}`;
}

export const offGetProductTool = tool('off_get_product', {
  title: 'Get Food Product by Barcode',
  description:
    'Fetch a packaged food product by barcode (4–40 digits: EAN-13, EAN-8, UPC, and the shorter and longer codes Open Food Facts also holds) from Open Food Facts. Returns the product name, brand, quantity, ingredients (raw text and parsed list), declared allergens, trace allergens the label warns about, additives, the product-level vegan/vegetarian/palm-oil analysis, computed scores (Nutri-Score a–e, NOVA 1–4, Green-Score), nutrition per 100g and per serving, categories, labels, packaging, origins, countries of sale, image URL, and data completeness. Open Food Facts is a crowd-sourced database — a missing field means "not yet entered by contributors," not that the attribute is absent from the actual product. Computed scores carry regional formula caveats and are indicators, not absolute rankings. Data is under ODbL 1.0 — cite Open Food Facts in downstream use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    barcode: z
      .string()
      .regex(BARCODE_PATTERN, BARCODE_PATTERN_MESSAGE)
      .describe(
        'Product barcode, digits only: 4–40 digits after any leading zeros. The primary key for Open Food Facts — the barcode of an off_search_products row works as is. Example: "3017620422003" (Nutella FR).',
      ),
    fields: z
      .array(
        z
          .enum([
            'product_name',
            'brands',
            'quantity',
            'ingredients_text',
            'ingredients',
            'allergens_tags',
            'traces_tags',
            'additives_tags',
            'ingredients_analysis_tags',
            'nutriscore_grade',
            'nova_group',
            'ecoscore_grade',
            'nutriments',
            'serving_size',
            'serving_quantity',
            'serving_quantity_unit',
            'categories_tags',
            'labels_tags',
            'packaging_tags',
            'origins_tags',
            'countries_tags',
            'image_url',
            'completeness',
            'data_quality_tags',
          ])
          .describe('A specific product field to include in the response.'),
      )
      .optional()
      .describe(
        'Subset of fields to return. Omitting returns all standard fields. Use to reduce payload when only scores or ingredients are needed. A field that cannot be read on its own arrives with what it depends on: nutriments brings serving_size, serving_quantity, and serving_quantity_unit so per-serving figures carry their denominator, and serving_quantity_unit brings the quantity it describes. requested_fields echoes the full set that was fetched.',
      ),
  }),

  output: z.object({
    barcode: z
      .string()
      .describe(
        'The input barcode, echoed back unchanged. Open Food Facts can hold the record under another form of the same code (030000010402 resolves to the record stored as 0030000010402); that stored form is not reported.',
      ),
    product: z
      .object({
        product_name: z
          .string()
          .optional()
          .describe('Product name. May be absent if not yet entered by contributors.'),
        brands: z.string().optional().describe('Brand name(s), comma-separated.'),
        quantity: z
          .string()
          .optional()
          .describe('Net quantity as printed on packaging (e.g. "400g").'),
        ingredients_text: z
          .string()
          .optional()
          .describe('Raw ingredients text from the label, in the source language.'),
        ingredients: z
          .array(
            z
              .object({
                ...ingredientEntryFields(),
                ingredients: z
                  .array(secondLevelIngredient)
                  .optional()
                  .describe(
                    'Sub-ingredients of this entry (e.g. the flours under "cereal"), in the same entry shape and nested up to two more levels. Absent when the entry has none.',
                  ),
              })
              .describe('A single top-level parsed ingredient entry.'),
          )
          .optional()
          .describe(
            'Parsed ingredient list, top level in label order, each entry carrying its sub-ingredients. Absent when not yet parsed by contributors.',
          ),
        allergens_tags: z
          .array(z.string().describe('Canonical allergen tag ID (e.g. "en:milk", "en:gluten").'))
          .optional()
          .describe(
            'Canonical allergen tag IDs. Absence means not yet entered — not that the product is allergen-free.',
          ),
        traces_tags: z
          .array(z.string().describe('Canonical allergen tag ID (e.g. "en:nuts").'))
          .optional()
          .describe(
            'Allergens the label says the product may contain as traces, from cross-contamination warnings. Distinct from allergens_tags, which carries allergens declared in the ingredients. ["en:none"] means the label states no traces; an empty array or an absent field means not yet entered, not trace-free. Values resolve through off_browse_taxonomy\'s allergens facet.',
          ),
        additives_tags: z
          .array(z.string().describe('E-number additive tag ID (e.g. "en:e322", "en:e322i").'))
          .optional()
          .describe('E-number additive tag IDs. Absence means not yet entered.'),
        ingredients_analysis_tags: z
          .array(
            z.string().describe('Analysis verdict tag (e.g. "en:non-vegan", "en:palm-oil-free").'),
          )
          .optional()
          .describe(
            'Product-level vegan, vegetarian, and palm-oil verdicts computed by Open Food Facts from the parsed ingredients. "maybe-" and "-status-unknown" values mean the ingredients could not settle it (e.g. "en:maybe-vegan").',
          ),
        nutriscore_grade: z
          .string()
          .optional()
          .describe(
            'Nutri-Score grade, lowercase: "a" (highest nutritional quality) through "e", "unknown" when the nutrition data entered is not enough to compute it, or "not-applicable" for product categories the score does not cover. Absent when Open Food Facts sent none. Regional formula variants exist.',
          ),
        nova_group: z
          .number()
          .optional()
          .describe(
            'NOVA food processing class (1=unprocessed, 2=culinary ingredients, 3=processed, 4=ultra-processed). Absent when not enough data.',
          ),
        ecoscore_grade: z
          .string()
          .optional()
          .describe(
            'Green-Score (formerly Eco-Score) environmental impact grade: "a-plus" (lowest impact), then "a" through "f"; "unknown" when the data it needs is missing, or "not-applicable" for product categories the score does not cover. Highly variable — depends on packaging, origins, and transport data completeness.',
          ),
        nutriments: z
          .object({
            energy_kcal_100g: z.number().optional().describe('Energy per 100g in kcal.'),
            fat_100g: z.number().optional().describe('Total fat per 100g in grams.'),
            saturated_fat_100g: z.number().optional().describe('Saturated fat per 100g in grams.'),
            carbohydrates_100g: z
              .number()
              .optional()
              .describe('Total carbohydrates per 100g in grams.'),
            sugars_100g: z.number().optional().describe('Total sugars per 100g in grams.'),
            fiber_100g: z
              .number()
              .optional()
              .describe('Dietary fiber per 100g in grams. Often absent.'),
            proteins_100g: z.number().optional().describe('Protein per 100g in grams.'),
            salt_100g: z.number().optional().describe('Salt per 100g in grams.'),
            sodium_100g: z.number().optional().describe('Sodium per 100g in grams.'),
            energy_kcal_serving: z
              .number()
              .optional()
              .describe('Energy per serving in kcal. Absent when serving size not defined.'),
            fat_serving: z
              .number()
              .optional()
              .describe('Total fat per serving in grams. Absent when serving size not defined.'),
            sugars_serving: z
              .number()
              .optional()
              .describe('Sugars per serving in grams. Absent when serving size not defined.'),
            additional_100g: z
              .record(
                z.string().describe('Nutrient name, hyphens normalized to underscores.'),
                z
                  .object({
                    value: z.number().describe('The figure Open Food Facts reported per 100g.'),
                    unit: z
                      .string()
                      .optional()
                      .describe(
                        'Unit the figure is expressed in ("g", "kcal", "kJ"). Absent when Open Food Facts records no unit for this nutrient.',
                      ),
                  })
                  .describe('One nutrient figure with the unit it is expressed in.'),
              )
              .optional()
              .describe(
                'Every other per-100g nutrient Open Food Facts holds, keyed by normalized name (calcium, iron, vitamin_c, trans_fat, added_sugars, cholesterol, energy in kJ, …). Excludes the named fields above, so a nutrient appears in exactly one place. Micronutrients are usually reported in grams, so calcium 0.071 g is 71 mg — read the unit rather than assuming.',
              ),
            additional_serving: z
              .record(
                z.string().describe('Nutrient name, hyphens normalized to underscores.'),
                z
                  .object({
                    value: z.number().describe('The figure Open Food Facts reported per serving.'),
                    unit: z
                      .string()
                      .optional()
                      .describe(
                        'Unit the figure is expressed in ("g", "kcal", "kJ"). Absent when Open Food Facts records no unit for this nutrient.',
                      ),
                  })
                  .describe('One nutrient figure with the unit it is expressed in.'),
              )
              .optional()
              .describe(
                'The same nutrients per serving. Also carries the per-serving figures for macros that have a named per-100g field but no named per-serving one (saturated_fat, carbohydrates, fiber, proteins, salt, sodium). Check serving_size for the denominator these figures are measured against.',
              ),
          })
          .optional()
          .describe(
            'Nutrition figures normalized to underscore keys. All values may be absent when nutrition data not yet entered.',
          ),
        serving_size: z
          .string()
          .optional()
          .describe(
            'Serving size as printed on the label (e.g. "28 g", "1 can (12 fl oz)"). The denominator for every per-serving figure. Absent when contributors have not entered one, in which case per-serving values cannot be converted to or from the per-100g values.',
          ),
        serving_quantity: z
          .number()
          .optional()
          .describe(
            'Serving size parsed to a number, in serving_quantity_unit. Absent when Open Food Facts could not parse the printed serving size.',
          ),
        serving_quantity_unit: z
          .string()
          .optional()
          .describe(
            'Unit of serving_quantity — usually "g" but "ml" for liquids, so it is not safe to assume grams. Absent when serving_quantity is absent or Open Food Facts records no unit.',
          ),
        categories_tags: z
          .array(z.string().describe('Canonical category tag ID (e.g. "en:spreads").'))
          .optional()
          .describe(
            'Category tag IDs in canonical form. Use as filter values for off_search_products.',
          ),
        labels_tags: z
          .array(z.string().describe('Canonical label/certification tag ID (e.g. "en:organic").'))
          .optional()
          .describe('Label/certification tag IDs. Absence means not yet entered.'),
        packaging_tags: z
          .array(z.string().describe('Packaging material tag ID (e.g. "en:cardboard").'))
          .optional()
          .describe('Packaging material tag IDs. Often absent.'),
        origins_tags: z
          .array(z.string().describe('Ingredient origin tag ID (e.g. "en:france").'))
          .optional()
          .describe('Ingredient origin tag IDs. Frequently empty.'),
        countries_tags: z
          .array(z.string().describe('Canonical country tag ID (e.g. "en:france").'))
          .optional()
          .describe(
            'Countries where the product is sold — the same values off_search_products accepts as countries_tag. Distinct from origins_tags, which is where the ingredients come from.',
          ),
        image_url: z.string().optional().describe('Front image URL (CDN-hosted JPEG).'),
        completeness: z
          .number()
          .optional()
          .describe(
            'Data completeness score from 0–1. Below 0.5 indicates many fields are missing.',
          ),
        data_quality_tags: z
          .array(
            z
              .string()
              .describe(
                'Crowd-sourced data quality flag (e.g. "en:nutrition-completed", "en:ingredients-completed-at-least-for-one-language").',
              ),
          )
          .optional()
          .describe('Crowd-sourced data quality flags. Absence means not yet checked.'),
      })
      .describe(
        'Product data. Always present on a successful call — a barcode with no contributor record raises the not_found error instead of returning an empty result.',
      ),
    requested_fields: z
      .array(z.string().describe('A field name from the requested subset.'))
      .optional()
      .describe(
        'The field subset that was fetched, when the caller passed `fields` — the requested fields plus the ones they depend on, so every field that can appear in `product` is named here. Absent means all standard fields were requested. Sections outside this subset are omitted because they were not requested — not because Open Food Facts lacks the data.',
      ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Barcode status:0 — not present in any contributor record',
      severity: 'notice',
      recovery:
        'Try off_search_products with the product name or brand to find the correct barcode, or check that the barcode digits are correct.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Open Food Facts returns a 5xx other than 501, serves an HTML error page with a 2xx or 5xx status, or is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry after a brief pause. If it keeps failing, Open Food Facts is degraded — check the barcode again later.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Open Food Facts did not answer within the request deadline',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry once. If it times out again, pass a narrower fields subset so Open Food Facts assembles less per request.',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Open Food Facts answers 4xx for something other than a missing barcode, or 501 Not Implemented',
      retryable: false,
      thrownBy: 'service',
      recovery:
        'Do not retry — the request will be refused again. Read data.status and the upstream explanation in the message, then correct the request.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own per-minute request budget is spent, or Open Food Facts answers 429",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Wait the seconds given in data.retryAfter, then retry. Spread lookups out rather than issuing them in a burst.',
    },
  ],

  async handler(input, ctx) {
    const svc = getOpenFoodFactsService();
    // When the caller requests a specific field subset, pass it to the service to scope the API
    // request. The service has a default full-field set; using getProductFields() overrides it.
    // The subset is expanded first, so a requested field arrives with whatever it needs to be read.
    const fields = input.fields && input.fields.length > 0 ? expandFields(input.fields) : undefined;
    const product = fields
      ? await svc.getProductFields(input.barcode, fields.join(','), ctx)
      : await svc.getProduct(input.barcode, ctx);

    if (!product) {
      throw ctx.fail('not_found', `Barcode ${input.barcode} not found in Open Food Facts`, {
        barcode: input.barcode,
        ...ctx.recoveryFor('not_found'),
      });
    }

    ctx.log.info('Product fetched', {
      barcode: input.barcode,
      product_name: product.product_name,
      completeness: product.completeness,
    });

    // Thread the requested subset through so format() can distinguish "not requested" from
    // "missing upstream data". The expanded list is what was asked of Open Food Facts, so it is
    // what the caller is told: every field that can appear in `product` is named in it. A full
    // request (no fields) leaves requested_fields absent.
    const result = buildProductOutput(input.barcode, product, fields);
    return result;
  },

  format: (result) => {
    const p = result.product;
    const lines: string[] = [];

    // When a field subset was requested, a section absent from `product` means "not requested",
    // not "missing upstream." Distinguish the two so the text never implies OFF lacks the data.
    const requested = result.requested_fields;
    const notRequested = (field: string): boolean =>
      requested !== undefined && !requested.includes(field);

    // A name that was never fetched is not an unknown name. Saying so here is the same
    // distinction the section lines below draw, applied to the one line that leads the response.
    const missingName = notRequested('product_name')
      ? 'Product name not requested'
      : 'Unknown product';
    lines.push(`## ${p.product_name === undefined ? missingName : mdInline(p.product_name)}`);
    lines.push(`**Barcode:** ${result.barcode}`);
    if (requested && requested.length > 0) {
      lines.push(
        `**Requested fields:** ${requested.join(', ')} — sections outside this subset were not requested (not missing from Open Food Facts).`,
      );
    }
    if (p.brands) lines.push(`**Brand:** ${mdInline(p.brands)}`);
    if (p.quantity) lines.push(`**Quantity:** ${mdInline(p.quantity)}`);
    if (p.serving_size !== undefined || p.serving_quantity !== undefined) {
      lines.push(servingSizeLine(p.serving_size, p.serving_quantity, p.serving_quantity_unit));
    }

    // Scores
    const scores: string[] = [];
    if (p.nutriscore_grade) scores.push(`Nutri-Score: ${mdInline(p.nutriscore_grade)}`);
    if (p.nova_group !== undefined) scores.push(`NOVA: ${p.nova_group}`);
    if (p.ecoscore_grade) scores.push(`Eco-Score: ${mdInline(p.ecoscore_grade)}`);
    if (scores.length > 0) lines.push(`**Scores:** ${scores.join(' | ')}`);

    // Nutrition
    if (p.nutriments) {
      const n = p.nutriments;
      lines.push('\n### Nutrition per 100g');
      if (n.energy_kcal_100g !== undefined) lines.push(`**Energy:** ${n.energy_kcal_100g} kcal`);
      if (n.fat_100g !== undefined) lines.push(`**Fat:** ${n.fat_100g}g`);
      if (n.saturated_fat_100g !== undefined)
        lines.push(`  - Saturated fat: ${n.saturated_fat_100g}g`);
      if (n.carbohydrates_100g !== undefined)
        lines.push(`**Carbohydrates:** ${n.carbohydrates_100g}g`);
      if (n.sugars_100g !== undefined) lines.push(`  - Sugars: ${n.sugars_100g}g`);
      if (n.fiber_100g !== undefined) lines.push(`**Fiber:** ${n.fiber_100g}g`);
      if (n.proteins_100g !== undefined) lines.push(`**Protein:** ${n.proteins_100g}g`);
      if (n.salt_100g !== undefined) lines.push(`**Salt:** ${n.salt_100g}g`);
      if (n.sodium_100g !== undefined) lines.push(`**Sodium:** ${n.sodium_100g}g`);
      if (n.additional_100g) {
        lines.push('**Other nutrients per 100g:**');
        lines.push(...additionalLines(n.additional_100g));
      }

      if (
        n.energy_kcal_serving !== undefined ||
        n.fat_serving !== undefined ||
        n.sugars_serving !== undefined ||
        n.additional_serving
      ) {
        // The serving size is the denominator for everything in this section, so it is restated
        // here rather than left to the header line — bare per-serving numbers are unusable without
        // it, and its absence is stated outright instead of being silently omitted.
        lines.push(
          `\n### Nutrition per serving${p.serving_size ? ` (per ${mdInline(p.serving_size)})` : ''}`,
        );
        if (p.serving_size === undefined) {
          lines.push(
            '*Serving size not recorded by Open Food Facts — the figures below have no stated denominator.*',
          );
        }
        if (n.energy_kcal_serving !== undefined)
          lines.push(`**Energy:** ${n.energy_kcal_serving} kcal`);
        if (n.fat_serving !== undefined) lines.push(`**Fat:** ${n.fat_serving}g`);
        if (n.sugars_serving !== undefined) lines.push(`**Sugars:** ${n.sugars_serving}g`);
        if (n.additional_serving) {
          lines.push('**Other nutrients per serving:**');
          lines.push(...additionalLines(n.additional_serving));
        }
      }
    } else if (notRequested('nutriments')) {
      lines.push('\n**Nutrition:** Not requested');
    } else {
      lines.push('\n**Nutrition:** Not available');
    }

    // Ingredients — fenced so contributor text cannot be read as markdown or as instructions. The
    // fence is sized past the longest backtick run in the value, which a fixed ``` was not: a
    // three-backtick run in the text closed the block and returned the rest to ordinary markdown.
    if (p.ingredients_text) {
      lines.push(`\n### Ingredients\n${mdCodeFence(p.ingredients_text)}`);
    } else if (notRequested('ingredients_text')) {
      lines.push('\n**Ingredients:** Not requested');
    } else {
      lines.push('\n**Ingredients:** Not available');
    }

    if (p.ingredients && p.ingredients.length > 0) {
      /**
       * Rendered in full, sub-ingredients indented under their parent. The whole tree is already
       * in structuredContent, so slicing here saved nothing on the wire and only left text-only
       * clients with a silently short list.
       */
      lines.push('\n**Parsed ingredients:**');
      lines.push(...ingredientLines(p.ingredients));
    }

    // Allergens
    if (p.allergens_tags && p.allergens_tags.length > 0) {
      lines.push(`\n**Allergens:** ${tagList(p.allergens_tags)}`);
    } else if (notRequested('allergens_tags')) {
      lines.push('\n**Allergens:** Not requested');
    } else {
      lines.push('\n**Allergens:** Not entered (absence does not mean allergen-free)');
    }

    // Traces — the "may contain" half of the label, kept separate from the declared allergens
    // above. The three upstream states carry three different claims and never collapse into one.
    if (p.traces_tags?.length === 1 && p.traces_tags[0] === 'en:none') {
      lines.push('**Traces:** Label states no traces');
    } else if (p.traces_tags && p.traces_tags.length > 0) {
      lines.push(`**Traces (may contain):** ${tagList(p.traces_tags)}`);
    } else if (notRequested('traces_tags')) {
      lines.push('**Traces:** Not requested');
    } else {
      lines.push('**Traces:** Not entered (absence does not mean trace-free)');
    }

    // Additives
    if (p.additives_tags && p.additives_tags.length > 0) {
      lines.push(`**Additives:** ${tagList(p.additives_tags)}`);
    }

    // Data quality
    if (p.data_quality_tags && p.data_quality_tags.length > 0) {
      lines.push(`**Data quality tags:** ${tagList(p.data_quality_tags)}`);
    }

    // Categories / labels
    if (p.categories_tags && p.categories_tags.length > 0) {
      lines.push(`\n**Categories:** ${tagList(p.categories_tags)}`);
    }
    if (p.labels_tags && p.labels_tags.length > 0) {
      lines.push(`**Labels:** ${tagList(p.labels_tags)}`);
    }
    if (p.packaging_tags && p.packaging_tags.length > 0) {
      lines.push(`**Packaging:** ${tagList(p.packaging_tags)}`);
    }
    if (p.origins_tags && p.origins_tags.length > 0) {
      lines.push(`**Origins:** ${tagList(p.origins_tags)}`);
    }
    if (p.countries_tags && p.countries_tags.length > 0) {
      lines.push(`**Countries sold in:** ${tagList(p.countries_tags)}`);
    }
    if (p.ingredients_analysis_tags && p.ingredients_analysis_tags.length > 0) {
      lines.push(`**Ingredients analysis:** ${tagList(p.ingredients_analysis_tags)}`);
    }

    // Image
    if (p.image_url) lines.push(`\n**Image:** ${mdUrl(p.image_url)}`);

    // Completeness
    if (p.completeness !== undefined) {
      lines.push(`\n**Data completeness:** ${completenessLabel(p.completeness)}`);
    }

    lines.push(
      '\n*Data: Open Food Facts (ODbL 1.0) — crowd-sourced. Missing fields = not yet entered.*',
    );

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});

/** The normalized `product` payload. Mirrors the `product` field of the output schema. */
type ProductOutput = {
  product_name?: string;
  brands?: string;
  quantity?: string;
  ingredients_text?: string;
  ingredients?: IngredientOutput[];
  allergens_tags?: string[];
  traces_tags?: string[];
  additives_tags?: string[];
  ingredients_analysis_tags?: string[];
  nutriscore_grade?: string;
  nova_group?: number;
  ecoscore_grade?: string;
  nutriments?: NormalizedNutriments;
  serving_size?: string;
  serving_quantity?: number;
  serving_quantity_unit?: string;
  categories_tags?: string[];
  labels_tags?: string[];
  packaging_tags?: string[];
  origins_tags?: string[];
  countries_tags?: string[];
  image_url?: string;
  completeness?: number;
  data_quality_tags?: string[];
};

/**
 * Coerce the parsed serving quantity to a number. Open Food Facts returns it as a JSON number for
 * most products and as a numeric string for others, so a plain `typeof === 'number'` test drops the
 * value for every product on the string side.
 */
function servingQuantity(raw: number | string | undefined): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Build the normalized output object from a raw product. */
function buildProductOutput(
  barcode: string,
  raw: RawProduct,
  requestedFields?: string[],
): {
  barcode: string;
  requested_fields?: string[];
  product: ProductOutput;
} {
  const product: ProductOutput = {};

  if (raw.product_name) product.product_name = raw.product_name;
  if (raw.brands) product.brands = raw.brands;
  if (raw.quantity) product.quantity = raw.quantity;
  if (raw.ingredients_text) product.ingredients_text = raw.ingredients_text;
  if (raw.ingredients && raw.ingredients.length > 0) {
    product.ingredients = buildIngredients(raw.ingredients);
  }
  if (raw.allergens_tags) product.allergens_tags = raw.allergens_tags;
  // An empty array is carried through rather than dropped: for traces it is Open Food Facts
  // saying nothing has been entered, which is not the same claim as the ["en:none"] the label
  // makes, and collapsing the two would turn "unknown" into "trace-free".
  if (raw.traces_tags) product.traces_tags = raw.traces_tags;
  if (raw.additives_tags) product.additives_tags = raw.additives_tags;
  if (raw.ingredients_analysis_tags) {
    product.ingredients_analysis_tags = raw.ingredients_analysis_tags;
  }
  if (raw.nutriscore_grade) product.nutriscore_grade = raw.nutriscore_grade;
  if (typeof raw.nova_group === 'number') product.nova_group = raw.nova_group;
  if (raw.ecoscore_grade) product.ecoscore_grade = raw.ecoscore_grade;

  const nutriments = normalizeNutriments(raw.nutriments);
  if (nutriments) product.nutriments = nutriments;

  if (raw.serving_size) product.serving_size = raw.serving_size;
  const quantity = servingQuantity(raw.serving_quantity);
  if (quantity !== undefined) {
    product.serving_quantity = quantity;
    // The unit describes serving_quantity and carries no meaning without it. Open Food Facts does
    // return a bare serving_quantity_unit on products that have no parsed quantity at all
    // (live-verified on barcode 3017620422003), and passing that through would put a value in
    // structuredContent that format() has nothing to say about.
    if (raw.serving_quantity_unit) product.serving_quantity_unit = raw.serving_quantity_unit;
  }

  if (raw.categories_tags) product.categories_tags = raw.categories_tags;
  if (raw.labels_tags) product.labels_tags = raw.labels_tags;
  if (raw.packaging_tags) product.packaging_tags = raw.packaging_tags;
  if (raw.origins_tags) product.origins_tags = raw.origins_tags;
  if (raw.countries_tags) product.countries_tags = raw.countries_tags;
  if (raw.image_url) product.image_url = raw.image_url;
  if (typeof raw.completeness === 'number') product.completeness = raw.completeness;
  if (raw.data_quality_tags) product.data_quality_tags = raw.data_quality_tags;

  return {
    barcode,
    product,
    ...(requestedFields && requestedFields.length > 0 && { requested_fields: requestedFields }),
  };
}
