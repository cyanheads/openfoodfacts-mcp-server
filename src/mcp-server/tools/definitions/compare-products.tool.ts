/**
 * @fileoverview Tool definition for side-by-side nutrition comparison of multiple food products.
 * @module mcp-server/tools/definitions/compare-products
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import type { RawNutriments, RawProduct } from '@/services/openfoodfacts/types.js';

/** Fields needed for comparison — narrower than full product fetch. */
const COMPARE_FIELDS =
  'product_name,brands,nutriscore_grade,nova_group,ecoscore_grade,nutriments,completeness';

/** Extract a numeric value from the raw nutriments map. */
function n(raw: RawNutriments, key: string): number | undefined {
  const v = raw[key];
  return typeof v === 'number' ? v : undefined;
}

/** Build a comparison row from a raw product. */
function buildCompareRow(
  barcode: string,
  raw: RawProduct | null,
): {
  barcode: string;
  product_name?: string;
  brands?: string;
  found: boolean;
  nutriscore_grade?: string;
  nova_group?: number;
  ecoscore_grade?: string;
  energy_kcal_100g?: number;
  fat_100g?: number;
  saturated_fat_100g?: number;
  sugars_100g?: number;
  salt_100g?: number;
  proteins_100g?: number;
  fiber_100g?: number;
  completeness?: number;
} {
  if (!raw) {
    return { barcode, found: false };
  }

  const row: ReturnType<typeof buildCompareRow> = { barcode, found: true };

  if (raw.product_name) row.product_name = raw.product_name;
  if (raw.brands) row.brands = raw.brands;
  if (raw.nutriscore_grade) row.nutriscore_grade = raw.nutriscore_grade;
  if (typeof raw.nova_group === 'number') row.nova_group = raw.nova_group;
  if (raw.ecoscore_grade) row.ecoscore_grade = raw.ecoscore_grade;
  if (typeof raw.completeness === 'number') row.completeness = raw.completeness;

  if (raw.nutriments) {
    const nm = raw.nutriments;
    const energy = n(nm, 'energy-kcal_100g');
    if (energy !== undefined) row.energy_kcal_100g = energy;
    const fat = n(nm, 'fat_100g');
    if (fat !== undefined) row.fat_100g = fat;
    const satFat = n(nm, 'saturated-fat_100g');
    if (satFat !== undefined) row.saturated_fat_100g = satFat;
    const sugars = n(nm, 'sugars_100g');
    if (sugars !== undefined) row.sugars_100g = sugars;
    const salt = n(nm, 'salt_100g');
    if (salt !== undefined) row.salt_100g = salt;
    const proteins = n(nm, 'proteins_100g');
    if (proteins !== undefined) row.proteins_100g = proteins;
    const fiber = n(nm, 'fiber_100g');
    if (fiber !== undefined) row.fiber_100g = fiber;
  }

  return row;
}

export const offCompareProductsTool = tool('off_compare_products', {
  title: 'Compare Food Products Side-by-Side',
  description:
    'Side-by-side nutrition and scoring comparison for 2–10 products by barcode. Fetches all products in parallel and returns a normalized table of energy (kcal/100g), fat, saturated fat, sugars, salt, protein, fiber, Nutri-Score, NOVA group, and Green-Score. Designed for "which of these cereals is healthiest?" or "compare these pasta brands" workflows. Missing nutrition data for any product is preserved as absent — comparisons are not imputed. Scores carry regional formula caveats. Data under ODbL 1.0 — cite Open Food Facts in downstream use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    barcodes: z
      .array(
        z
          .string()
          .regex(/^\d{8,14}$/)
          .describe('EAN-13 or UPC barcode (8–14 digits).'),
      )
      .min(2)
      .max(10)
      .describe(
        '2–10 barcodes to compare. All products are fetched in parallel. Example: ["3017620422003", "7622210100146"].',
      ),
  }),

  output: z.object({
    products: z
      .array(
        z
          .object({
            barcode: z.string().describe('EAN-13 or UPC barcode (same as provided input).'),
            product_name: z
              .string()
              .optional()
              .describe('Product name. Absent when not yet entered by contributors.'),
            brands: z
              .string()
              .optional()
              .describe('Brand name(s), comma-separated. Absent when not yet entered.'),
            found: z.boolean().describe('False if the barcode has no contributor record.'),
            nutriscore_grade: z
              .string()
              .optional()
              .describe('Nutri-Score letter (a–e). Absent when not computed.'),
            nova_group: z
              .number()
              .optional()
              .describe('NOVA processing class (1–4). Absent when not assigned.'),
            ecoscore_grade: z
              .string()
              .optional()
              .describe('Green-Score/Eco-Score (a–e or "unknown"). Often absent.'),
            energy_kcal_100g: z
              .number()
              .optional()
              .describe('Energy per 100g in kcal. Absent when not entered.'),
            fat_100g: z
              .number()
              .optional()
              .describe('Total fat per 100g in grams. Absent when not entered.'),
            saturated_fat_100g: z
              .number()
              .optional()
              .describe('Saturated fat per 100g in grams. Absent when not entered.'),
            sugars_100g: z
              .number()
              .optional()
              .describe('Total sugars per 100g in grams. Absent when not entered.'),
            salt_100g: z
              .number()
              .optional()
              .describe('Salt per 100g in grams. Absent when not entered.'),
            proteins_100g: z
              .number()
              .optional()
              .describe('Protein per 100g in grams. Absent when not entered.'),
            fiber_100g: z
              .number()
              .optional()
              .describe('Dietary fiber per 100g in grams. Often absent.'),
            completeness: z
              .number()
              .optional()
              .describe('Data completeness 0–1. Low values mean many fields are missing.'),
          })
          .describe('A single product comparison row.'),
      )
      .describe('Comparison rows, one per barcode in input order.'),
    succeeded: z.number().describe('Number of barcodes that resolved to a found product.'),
    not_found: z
      .array(z.string().describe('EAN-13 or UPC barcode with no contributor record.'))
      .describe(
        'Barcodes with no contributor record. Not an error — the product may exist but not yet entered in Open Food Facts.',
      ),
  }),

  errors: [
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Open Food Facts API returns 5xx or is unreachable for one or more barcodes',
      retryable: true,
      recovery:
        'Retry after a brief pause. Partial failures surface individual barcodes in not_found — verify those barcodes with off_get_product.',
    },
  ],

  async handler(input, ctx) {
    const svc = getOpenFoodFactsService();

    // Fetch all products in parallel
    const settlements = await Promise.allSettled(
      input.barcodes.map((barcode) => svc.getProductFields(barcode, COMPARE_FIELDS, ctx)),
    );

    const products: ReturnType<typeof buildCompareRow>[] = [];
    const not_found: string[] = [];
    let succeeded = 0;

    for (let i = 0; i < input.barcodes.length; i++) {
      const barcode = input.barcodes[i] as string;
      const result = settlements[i];

      if (result === undefined || result.status === 'rejected') {
        // If it was an explicit service error (not just not-found), propagate it
        if (result?.status === 'rejected') {
          const err = result.reason as Error;
          // If it looks like an upstream error, throw it
          if (err.message?.includes('Open Food Facts')) {
            throw serviceUnavailable(
              `Failed to fetch barcode ${barcode}: ${err.message}`,
              { barcode },
              { cause: err },
            );
          }
        }
        products.push({ barcode, found: false });
        not_found.push(barcode);
        continue;
      }

      const raw = result.value;
      if (!raw) {
        products.push({ barcode, found: false });
        not_found.push(barcode);
      } else {
        products.push(buildCompareRow(barcode, raw));
        succeeded++;
      }
    }

    ctx.log.info('Product comparison completed', {
      total: input.barcodes.length,
      succeeded,
      not_found: not_found.length,
    });

    return { products, succeeded, not_found };
  },

  format: (result) => {
    const lines: string[] = [
      `## Product Comparison (${result.succeeded}/${result.products.length} found)\n`,
    ];

    if (result.not_found.length > 0) {
      lines.push(
        `**Not found:** ${result.not_found.join(', ')} (not yet entered in Open Food Facts)\n`,
      );
    }

    const found = result.products.filter((p) => p.found);
    if (found.length === 0) {
      lines.push('No products found. Try off_get_product on individual barcodes to verify.');
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

    // Scores table — includes all products with found status
    lines.push('### Scores');
    lines.push('| Product | Barcode | Found | Nutri-Score | NOVA | Eco-Score | Completeness |');
    lines.push('|:--------|:--------|:------|:------------|:-----|:----------|:-------------|');
    for (const p of result.products) {
      const name = p.product_name
        ? `${p.product_name}${p.brands ? ` (${p.brands})` : ''}`
        : `Barcode ${p.barcode}`;
      const completeness =
        p.completeness !== undefined ? `${Math.round(p.completeness * 100)}%` : 'N/A';
      lines.push(
        `| ${name} | ${p.barcode} | ${p.found} | ${p.nutriscore_grade ?? 'N/A'} | ${p.nova_group ?? 'N/A'} | ${p.ecoscore_grade ?? 'N/A'} | ${completeness} |`,
      );
    }

    // Nutrition table
    lines.push('\n### Nutrition per 100g');
    lines.push(
      '| Product | Energy (kcal) | Fat (g) | Sat. Fat (g) | Sugars (g) | Salt (g) | Protein (g) | Fiber (g) |',
    );
    lines.push(
      '|:--------|:-------------|:--------|:-------------|:-----------|:---------|:------------|:----------|',
    );
    for (const p of found) {
      const name = p.product_name ?? `Barcode ${p.barcode}`;
      const fmt = (v: number | undefined) => (v !== undefined ? String(v) : 'N/A');
      lines.push(
        `| ${name} | ${fmt(p.energy_kcal_100g)} | ${fmt(p.fat_100g)} | ${fmt(p.saturated_fat_100g)} | ${fmt(p.sugars_100g)} | ${fmt(p.salt_100g)} | ${fmt(p.proteins_100g)} | ${fmt(p.fiber_100g)} |`,
      );
    }

    // Completeness notices
    const lowCompleteness = found.filter(
      (p) => p.completeness !== undefined && p.completeness < 0.5,
    );
    if (lowCompleteness.length > 0) {
      lines.push(
        `\n*Low completeness (< 50%): ${lowCompleteness.map((p) => p.product_name ?? p.barcode).join(', ')} — many fields may be missing.*`,
      );
    }

    lines.push('\n*Data: Open Food Facts (ODbL 1.0) — crowd-sourced. "N/A" = not yet entered.*');

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
