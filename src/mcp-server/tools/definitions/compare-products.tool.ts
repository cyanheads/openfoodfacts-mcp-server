/**
 * @fileoverview Tool definition for side-by-side nutrition comparison of multiple food products.
 * @module mcp-server/tools/definitions/compare-products
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import type { RawProduct } from '@/services/openfoodfacts/types.js';

/** Fields needed for comparison — narrower than full product fetch. */
const COMPARE_FIELDS =
  'product_name,brands,nutriscore_grade,nova_group,ecoscore_grade,nutriments,completeness';

type CompareRow = {
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
};

/** Extract a numeric value from the raw nutriments map. */
function n(raw: Record<string, number | string | undefined>, key: string): number | undefined {
  const v = raw[key];
  return typeof v === 'number' ? v : undefined;
}

type FailedFetch = {
  barcode: string;
  reason: string;
  error: string;
};

/**
 * Describe a rejected fetch for the `failed` array. The service raises declared contract failures,
 * so the reason and the recovery hint are read off the error rather than re-derived from its text.
 * The upstream's own explanation is appended raw and rarely ends in punctuation, so the hint is
 * joined as its own sentence instead of running on from the message.
 */
function describeFailure(barcode: string, error: unknown): FailedFetch {
  if (error instanceof McpError) {
    const reason = typeof error.data?.reason === 'string' ? error.data.reason : 'upstream_error';
    const hint = (error.data?.recovery as { hint?: string } | undefined)?.hint;
    const message = /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
    return { barcode, reason, error: hint ? `${message} ${hint}` : message };
  }
  return {
    barcode,
    reason: 'upstream_error',
    error: error instanceof Error ? error.message : String(error),
  };
}

/** Build a comparison row from a raw product. */
function buildCompareRow(barcode: string, raw: RawProduct | null): CompareRow {
  if (!raw) return { barcode, found: false };

  const row: CompareRow = { barcode, found: true };

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
    'Side-by-side nutrition and scoring comparison for 2–10 products by barcode. Returns a normalized table of energy (kcal/100g), fat, saturated fat, sugars, salt, protein, fiber, Nutri-Score, NOVA group, and Green-Score. Designed for "which of these cereals is healthiest?" or "compare these pasta brands" workflows. Missing nutrition data for any product is preserved as absent — comparisons are not imputed. A batch is not all-or-nothing: barcodes that resolve are returned even when others fail, with confirmed-missing barcodes listed in not_found and failed fetches listed separately in failed. Scores carry regional formula caveats. Data under ODbL 1.0 — cite Open Food Facts in downstream use.',
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
        '2–10 barcodes to compare, returned as one row each in input order. Example: ["3017620422003", "7622210100146"].',
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
      .describe(
        'Comparison rows in input order — one per barcode whose fetch completed, whether or not a record exists. Barcodes whose fetch failed have no row here; they appear in failed.',
      ),
    succeeded: z.number().describe('Number of barcodes that resolved to a found product.'),
    not_found: z
      .array(z.string().describe('EAN-13 or UPC barcode with no contributor record.'))
      .describe(
        'Barcodes Open Food Facts answered for, confirming no contributor record exists. Not an error — the product may exist but not yet be entered. Never used for a fetch that failed.',
      ),
    failed: z
      .array(
        z
          .object({
            barcode: z.string().describe('EAN-13 or UPC barcode whose fetch failed.'),
            reason: z
              .string()
              .describe(
                'Declared failure reason — one of upstream_error, upstream_timeout, upstream_rejected, rate_limited.',
              ),
            error: z.string().describe('What went wrong for this barcode and what to do about it.'),
          })
          .describe('A single barcode whose fetch failed.'),
      )
      .optional()
      .describe(
        'Barcodes whose fetch failed, with the per-barcode reason. Absent when every fetch completed. A barcode listed here is unknown, not absent from Open Food Facts — retry it with off_get_product before concluding anything about the product.',
      ),
  }),

  errors: [
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Open Food Facts returns 5xx, serves an HTML error page, or is unreachable — surfaced per barcode in failed[]',
      retryable: true,
      recovery:
        'Retry the barcodes listed in failed after a brief pause. Rows that already resolved are kept, so only the failures need repeating.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Open Food Facts did not answer within the request deadline — surfaced per barcode in failed[]',
      retryable: true,
      recovery:
        'Retry the barcodes listed in failed, or fetch them one at a time with off_get_product to reduce the load per request.',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Open Food Facts answers 4xx for a barcode — surfaced per barcode in failed[]',
      retryable: false,
      recovery:
        'Do not retry unchanged. Check the digits of the barcodes listed in failed, then look them up individually with off_get_product.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own per-minute request budget is spent, or Open Food Facts answers 429 — surfaced per barcode in failed[]",
      retryable: true,
      recovery:
        'Wait the seconds given in the failed entry, then retry only those barcodes. Compare fewer barcodes per call to stay inside the budget.',
    },
  ],

  async handler(input, ctx) {
    const svc = getOpenFoodFactsService();

    // Fetch all products in parallel
    const settlements = await Promise.allSettled(
      input.barcodes.map((barcode) => svc.getProductFields(barcode, COMPARE_FIELDS, ctx)),
    );

    const products: CompareRow[] = [];
    const not_found: string[] = [];
    const failed: FailedFetch[] = [];
    let succeeded = 0;

    // Classify by how the fetch settled, never by error text. The service resolves null only for a
    // barcode Open Food Facts confirmed it has no record of, so a rejection is always a failure to
    // learn anything about that barcode — reporting it as not_found would assert the opposite.
    // Failures stay per-barcode so a mixed batch keeps the rows that did resolve.
    for (let i = 0; i < input.barcodes.length; i++) {
      const barcode = input.barcodes[i] as string;
      const result = settlements[i] as PromiseSettledResult<RawProduct | null>;

      if (result.status === 'rejected') {
        failed.push(describeFailure(barcode, result.reason));
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
      failed: failed.length,
    });

    return { products, succeeded, not_found, ...(failed.length > 0 && { failed }) };
  },

  format: (result) => {
    const attempted = result.products.length + (result.failed?.length ?? 0);
    const lines: string[] = [`## Product Comparison (${result.succeeded}/${attempted} found)\n`];

    if (result.not_found.length > 0) {
      lines.push(
        `**Not found:** ${result.not_found.join(', ')} (not yet entered in Open Food Facts)\n`,
      );
    }

    if (result.failed && result.failed.length > 0) {
      lines.push('**Fetch failed** — these barcodes were not checked, not confirmed missing:');
      for (const f of result.failed) {
        lines.push(`- ${f.barcode} (${f.reason}): ${f.error}`);
      }
      lines.push('');
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
      // The exact scalar rides alongside the rounded percentage: 0.7875 and 0.79 both render as
      // "79%", and a text-only client has no second call that would recover the difference.
      const completeness =
        p.completeness !== undefined
          ? `${Math.round(p.completeness * 100)}% (${p.completeness})`
          : 'N/A';
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
