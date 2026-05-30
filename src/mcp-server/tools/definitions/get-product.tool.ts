/**
 * @fileoverview Tool definition for fetching a food product by barcode from Open Food Facts.
 * @module mcp-server/tools/definitions/get-product
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import type { RawNutriments, RawProduct } from '@/services/openfoodfacts/types.js';

type NormalizedNutriments = {
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

/** Maps raw hyphenated nutriment keys → output schema keys. */
const NUTRIMENT_MAP: [string, keyof NormalizedNutriments][] = [
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

/** Normalize the raw hyphenated nutriments map to the output schema shape. */
function normalizeNutriments(raw: RawNutriments | undefined): NormalizedNutriments | undefined {
  if (!raw) return;
  const result: NormalizedNutriments = {};
  for (const [rawKey, outKey] of NUTRIMENT_MAP) {
    const v = raw[rawKey];
    if (typeof v === 'number') result[outKey] = v;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Format a completeness score with a human-readable label. */
function completenessLabel(score: number): string {
  if (score >= 0.8) return `${Math.round(score * 100)}% (high)`;
  if (score >= 0.5) return `${Math.round(score * 100)}% (moderate)`;
  return `${Math.round(score * 100)}% (low — many fields missing)`;
}

export const offGetProductTool = tool('off_get_product', {
  title: 'Get Food Product by Barcode',
  description:
    'Fetch a packaged food product by barcode (EAN-13 or UPC) from Open Food Facts. Returns the product name, brand, quantity, ingredients (raw text and parsed list), allergens, additives, computed scores (Nutri-Score a–e, NOVA 1–4, Green-Score), nutrition per 100g and per serving, categories, labels, packaging, origins, image URL, and data completeness. Open Food Facts is a crowd-sourced database — a missing field means "not yet entered by contributors," not that the attribute is absent from the actual product. Computed scores carry regional formula caveats and are indicators, not absolute rankings. Data is under ODbL 1.0 — cite Open Food Facts in downstream use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    barcode: z
      .string()
      .regex(/^\d{8,14}$/)
      .describe(
        'EAN-13 or UPC barcode (8–14 digits). The primary key for Open Food Facts. Example: "3017620422003" (Nutella FR).',
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
            'additives_tags',
            'nutriscore_grade',
            'nova_group',
            'ecoscore_grade',
            'nutriments',
            'categories_tags',
            'labels_tags',
            'packaging_tags',
            'origins_tags',
            'image_url',
            'completeness',
            'data_quality_tags',
          ])
          .describe('A specific product field to include in the response.'),
      )
      .optional()
      .describe(
        'Subset of fields to return. Omitting returns all standard fields. Use to reduce payload when only scores or ingredients are needed.',
      ),
  }),

  output: z.object({
    barcode: z.string().describe('Barcode as returned by the API.'),
    found: z
      .boolean()
      .describe(
        'False when the barcode exists in no contributor record (status:0). A false result means no contributor has entered this product yet — not that the product does not exist.',
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
                id: z
                  .string()
                  .optional()
                  .describe('Canonical ingredient ID (e.g. "en:sugar", "en:salt").'),
                text: z.string().describe('Ingredient name as it appears in the list.'),
                percent_estimate: z
                  .number()
                  .optional()
                  .describe('Estimated percentage of this ingredient.'),
                vegan: z
                  .string()
                  .optional()
                  .describe('"yes", "no", or "maybe" — absent when unknown.'),
                vegetarian: z
                  .string()
                  .optional()
                  .describe('"yes", "no", or "maybe" — absent when unknown.'),
              })
              .describe('A single parsed ingredient entry.'),
          )
          .optional()
          .describe('Parsed ingredient list. Absent when not yet parsed by contributors.'),
        allergens_tags: z
          .array(z.string().describe('Canonical allergen tag ID (e.g. "en:milk", "en:gluten").'))
          .optional()
          .describe(
            'Canonical allergen tag IDs. Absence means not yet entered — not that the product is allergen-free.',
          ),
        additives_tags: z
          .array(z.string().describe('E-number additive tag ID (e.g. "en:e322", "en:e322i").'))
          .optional()
          .describe('E-number additive tag IDs. Absence means not yet entered.'),
        nutriscore_grade: z
          .string()
          .optional()
          .describe(
            'Nutri-Score letter (a–e, lowercase). "a" is highest nutritional quality. Absent when not enough nutrition data to compute. Regional formula variants exist.',
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
            'Green-Score/Eco-Score environmental impact letter (a–e, or "unknown"). Highly variable — depends on packaging, origins, and transport data completeness.',
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
          })
          .optional()
          .describe(
            'Nutrition figures normalized to underscore keys. All values may be absent when nutrition data not yet entered.',
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
      .optional()
      .describe('Product data. Absent when found is false.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Barcode status:0 — not present in any contributor record',
      recovery:
        'Try off_search_products with the product name or brand to find the correct barcode, or check that the barcode digits are correct.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Open Food Facts API returns 5xx or is unreachable',
      retryable: true,
      recovery:
        'Retry after a brief pause. If persistent, the Open Food Facts service may be experiencing high load.',
    },
  ],

  async handler(input, ctx) {
    const svc = getOpenFoodFactsService();
    // When the caller requests a specific field subset, pass it to the service to scope the API
    // request. The service has a default full-field set; using getProductFields() overrides it.
    const product =
      input.fields && input.fields.length > 0
        ? await svc.getProductFields(input.barcode, input.fields.join(','), ctx)
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

    const result = buildProductOutput(input.barcode, product);
    return result;
  },

  format: (result) => {
    if (!result.found || !result.product) {
      return [
        {
          type: 'text' as const,
          text: `**Barcode ${result.barcode}** — Not found in Open Food Facts. No contributor has entered this product yet. Try off_search_products with the product name or brand.`,
        },
      ];
    }

    const p = result.product;
    const lines: string[] = [];

    lines.push(`## ${p.product_name ?? 'Unknown product'}`);
    lines.push(`**Barcode:** ${result.barcode} | **Found:** ${result.found}`);
    if (p.brands) lines.push(`**Brand:** ${p.brands}`);
    if (p.quantity) lines.push(`**Quantity:** ${p.quantity}`);

    // Scores
    const scores: string[] = [];
    if (p.nutriscore_grade) scores.push(`Nutri-Score: ${p.nutriscore_grade}`);
    if (p.nova_group !== undefined) scores.push(`NOVA: ${p.nova_group}`);
    if (p.ecoscore_grade) scores.push(`Eco-Score: ${p.ecoscore_grade}`);
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

      if (
        n.energy_kcal_serving !== undefined ||
        n.fat_serving !== undefined ||
        n.sugars_serving !== undefined
      ) {
        lines.push('\n### Nutrition per serving');
        if (n.energy_kcal_serving !== undefined)
          lines.push(`**Energy:** ${n.energy_kcal_serving} kcal`);
        if (n.fat_serving !== undefined) lines.push(`**Fat:** ${n.fat_serving}g`);
        if (n.sugars_serving !== undefined) lines.push(`**Sugars:** ${n.sugars_serving}g`);
      }
    } else {
      lines.push('\n**Nutrition:** Not available');
    }

    // Ingredients — fenced to prevent crowd-sourced text from being interpreted as markdown/instructions
    if (p.ingredients_text) {
      lines.push(`\n### Ingredients\n\`\`\`\n${p.ingredients_text}\n\`\`\``);
    } else {
      lines.push('\n**Ingredients:** Not available');
    }

    if (p.ingredients && p.ingredients.length > 0) {
      lines.push('\n**Parsed ingredients:**');
      for (const ing of p.ingredients.slice(0, 20)) {
        const attrs: string[] = [];
        if (ing.id) attrs.push(`id: ${ing.id}`);
        if (ing.percent_estimate !== undefined) attrs.push(`~${ing.percent_estimate.toFixed(1)}%`);
        if (ing.vegan && ing.vegan !== 'maybe') attrs.push(`vegan: ${ing.vegan}`);
        if (ing.vegetarian && ing.vegetarian !== 'maybe')
          attrs.push(`vegetarian: ${ing.vegetarian}`);
        lines.push(`- ${ing.text}${attrs.length > 0 ? ` (${attrs.join(', ')})` : ''}`);
      }
      if (p.ingredients.length > 20) {
        lines.push(`- *(${p.ingredients.length - 20} more ingredients)*`);
      }
    }

    // Allergens
    if (p.allergens_tags && p.allergens_tags.length > 0) {
      lines.push(`\n**Allergens:** ${p.allergens_tags.join(', ')}`);
    } else {
      lines.push('\n**Allergens:** Not entered (absence does not mean allergen-free)');
    }

    // Additives
    if (p.additives_tags && p.additives_tags.length > 0) {
      lines.push(`**Additives:** ${p.additives_tags.join(', ')}`);
    }

    // Data quality
    if (p.data_quality_tags && p.data_quality_tags.length > 0) {
      lines.push(`**Data quality tags:** ${p.data_quality_tags.join(', ')}`);
    }

    // Categories / labels
    if (p.categories_tags && p.categories_tags.length > 0) {
      lines.push(`\n**Categories:** ${p.categories_tags.slice(0, 5).join(', ')}`);
    }
    if (p.labels_tags && p.labels_tags.length > 0) {
      lines.push(`**Labels:** ${p.labels_tags.join(', ')}`);
    }
    if (p.packaging_tags && p.packaging_tags.length > 0) {
      lines.push(`**Packaging:** ${p.packaging_tags.join(', ')}`);
    }
    if (p.origins_tags && p.origins_tags.length > 0) {
      lines.push(`**Origins:** ${p.origins_tags.join(', ')}`);
    }

    // Image
    if (p.image_url) lines.push(`\n**Image:** ${p.image_url}`);

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

/** Build the normalized output object from a raw product. */
function buildProductOutput(
  barcode: string,
  raw: RawProduct,
): {
  barcode: string;
  found: boolean;
  product?: {
    product_name?: string;
    brands?: string;
    quantity?: string;
    ingredients_text?: string;
    ingredients?: Array<{
      id?: string;
      text: string;
      percent_estimate?: number;
      vegan?: string;
      vegetarian?: string;
    }>;
    allergens_tags?: string[];
    additives_tags?: string[];
    nutriscore_grade?: string;
    nova_group?: number;
    ecoscore_grade?: string;
    nutriments?: {
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
    categories_tags?: string[];
    labels_tags?: string[];
    packaging_tags?: string[];
    origins_tags?: string[];
    image_url?: string;
    completeness?: number;
    data_quality_tags?: string[];
  };
} {
  const product: NonNullable<ReturnType<typeof buildProductOutput>['product']> = {};

  if (raw.product_name) product.product_name = raw.product_name;
  if (raw.brands) product.brands = raw.brands;
  if (raw.quantity) product.quantity = raw.quantity;
  if (raw.ingredients_text) product.ingredients_text = raw.ingredients_text;
  if (raw.ingredients && raw.ingredients.length > 0) {
    product.ingredients = raw.ingredients.map((ing) => ({
      ...(ing.id && { id: ing.id }),
      text: ing.text ?? '',
      ...(typeof ing.percent_estimate === 'number' && {
        percent_estimate: ing.percent_estimate,
      }),
      ...(ing.vegan && { vegan: ing.vegan }),
      ...(ing.vegetarian && { vegetarian: ing.vegetarian }),
    }));
  }
  if (raw.allergens_tags) product.allergens_tags = raw.allergens_tags;
  if (raw.additives_tags) product.additives_tags = raw.additives_tags;
  if (raw.nutriscore_grade) product.nutriscore_grade = raw.nutriscore_grade;
  if (typeof raw.nova_group === 'number') product.nova_group = raw.nova_group;
  if (raw.ecoscore_grade) product.ecoscore_grade = raw.ecoscore_grade;

  const nutriments = normalizeNutriments(raw.nutriments);
  if (nutriments) product.nutriments = nutriments;

  if (raw.categories_tags) product.categories_tags = raw.categories_tags;
  if (raw.labels_tags) product.labels_tags = raw.labels_tags;
  if (raw.packaging_tags) product.packaging_tags = raw.packaging_tags;
  if (raw.origins_tags) product.origins_tags = raw.origins_tags;
  if (raw.image_url) product.image_url = raw.image_url;
  if (typeof raw.completeness === 'number') product.completeness = raw.completeness;
  if (raw.data_quality_tags) product.data_quality_tags = raw.data_quality_tags;

  return { barcode, found: true, product };
}
