/**
 * @fileoverview Tool definition for side-by-side nutrition comparison of multiple food products.
 * @module mcp-server/tools/definitions/compare-products
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import {
  BARCODE_PATTERN,
  BARCODE_PATTERN_MESSAGE,
  type RawNutriments,
  type RawProduct,
} from '@/services/openfoodfacts/types.js';
import { mdInline } from '@/utils/markdown.js';

/** Fields needed for comparison — narrower than full product fetch. */
const COMPARE_FIELDS =
  'product_name,brands,nutriscore_grade,nova_group,ecoscore_grade,nutriments,completeness';

/**
 * Most distinct barcodes one call fetches. More, up to the input's hard ceiling, are listed in
 * `unprocessed` without being fetched, so one compare never spends more of the per-minute product
 * budget than this.
 */
const COMPARE_BARCODE_CAP = 10;

/** The next step for barcodes left unprocessed, sized to the 2-barcode minimum of a compare. */
function unprocessedNextStep(count: number): string {
  return count === 1
    ? 'look it up with off_get_product, or compare it with barcodes from this call in another off_compare_products call.'
    : `compare them in another off_compare_products call, up to ${COMPARE_BARCODE_CAP} barcodes at a time.`;
}

/**
 * The nutrition columns of a comparison, in table order. This one list drives the row type, the
 * figures read from the raw map, the output schema, and the text tables. `raw` is the Open Food
 * Facts nutrient name, which a suffix turns into a key of its nutriments map.
 */
const NUTRITION_COLUMNS = [
  {
    key: 'energy_kcal_100g',
    raw: 'energy-kcal',
    header: 'Energy (kcal)',
    measure: 'Energy in kcal',
  },
  { key: 'fat_100g', raw: 'fat', header: 'Fat (g)', measure: 'Total fat in grams' },
  {
    key: 'saturated_fat_100g',
    raw: 'saturated-fat',
    header: 'Sat. Fat (g)',
    measure: 'Saturated fat in grams',
  },
  {
    key: 'carbohydrates_100g',
    raw: 'carbohydrates',
    header: 'Carbohydrates (g)',
    measure: 'Total carbohydrates in grams',
  },
  { key: 'sugars_100g', raw: 'sugars', header: 'Sugars (g)', measure: 'Total sugars in grams' },
  { key: 'salt_100g', raw: 'salt', header: 'Salt (g)', measure: 'Salt in grams' },
  { key: 'proteins_100g', raw: 'proteins', header: 'Protein (g)', measure: 'Protein in grams' },
  { key: 'fiber_100g', raw: 'fiber', header: 'Fiber (g)', measure: 'Dietary fiber in grams' },
] as const;

type NutritionKey = (typeof NUTRITION_COLUMNS)[number]['key'];

/** Figures keyed by column. A key is absent when the read carried no number for that column. */
type NutritionFigures = Partial<Record<NutritionKey, number>>;

/**
 * Figures as `format()` receives them. Differs from `NutritionFigures` in allowing `undefined`,
 * since `format()` is typed from the output schema and the project runs
 * `exactOptionalPropertyTypes`.
 */
type RenderedFigures = Partial<Record<NutritionKey, number | undefined>>;

type CompareRow = NutritionFigures & {
  barcode: string;
  product_name?: string;
  brands?: string;
  found: boolean;
  nutriscore_grade?: string;
  nova_group?: number;
  ecoscore_grade?: string;
  prepared?: NutritionFigures;
  completeness?: number;
};

/** Extract a numeric value from the raw nutriments map. */
function n(raw: Record<string, number | string | undefined>, key: string): number | undefined {
  const v = raw[key];
  return typeof v === 'number' ? v : undefined;
}

/** Read every column under `suffix`. One raw key per column, so nothing is derived or converted. */
function readFigures(raw: RawNutriments, suffix: string): NutritionFigures {
  const figures: NutritionFigures = {};
  for (const { key, raw: nutrient } of NUTRITION_COLUMNS) {
    const value = n(raw, `${nutrient}${suffix}`);
    if (value !== undefined) figures[key] = value;
  }
  return figures;
}

/**
 * Output fields for a set of figures, one per column. A factory so each use gets its own schema
 * instances. `Object.fromEntries` widens its keys to `string`, so the cast restores the columns.
 */
const nutritionFields = (describe: (measure: string) => string) =>
  Object.fromEntries(
    NUTRITION_COLUMNS.map(({ key, measure }) => [
      key,
      z.number().optional().describe(describe(measure)),
    ]),
  ) as Record<NutritionKey, z.ZodOptional<z.ZodNumber>>;

/** Whether any column holds a figure. */
function hasFigure(figures: RenderedFigures): boolean {
  return NUTRITION_COLUMNS.some(({ key }) => figures[key] !== undefined);
}

/** A nutrition table with one row per entry, `N/A` where an entry has no figure for a column. */
function nutritionTable(
  heading: string,
  rows: readonly { label: string; figures: RenderedFigures }[],
): string[] {
  const headers = NUTRITION_COLUMNS.map((column) => column.header);
  return [
    heading,
    `| Product | ${headers.join(' | ')} |`,
    `|:--------|${headers.map((header) => `:${'-'.repeat(header.length + 1)}|`).join('')}`,
    ...rows.map(({ label, figures }) => {
      const cells = NUTRITION_COLUMNS.map(({ key }) => figures[key] ?? 'N/A');
      return `| ${label} | ${cells.join(' | ')} |`;
    }),
  ];
}

/** The failure reasons this tool declares — the four the service raises for a product fetch. */
const FAILURE_REASONS = [
  'upstream_error',
  'upstream_timeout',
  'upstream_rejected',
  'rate_limited',
] as const;

type FailureReason = (typeof FAILURE_REASONS)[number];

type FailedFetch = {
  barcode: string;
  reason: FailureReason;
  error: string;
};

/**
 * Describe a rejected fetch for the `failed` array. The service raises declared contract failures,
 * so the reason is read off the error rather than re-derived from its text, and the hint is this
 * tool's own contract entry for it — the framework fills a declared hint only on an error that
 * leaves the handler, and these are caught per barcode. The upstream's own explanation is appended
 * raw and rarely ends in punctuation, so the hint is joined as its own sentence instead of running
 * on from the message.
 */
function describeFailure(
  barcode: string,
  error: unknown,
  hintFor: (reason: FailureReason) => string,
): FailedFetch {
  const raised = error instanceof McpError ? error.data?.reason : undefined;
  const reason = FAILURE_REASONS.find((known) => known === raised) ?? 'upstream_error';
  const text = error instanceof Error ? error.message : String(error);
  const message = /[.!?]$/.test(text) ? text : `${text}.`;
  return { barcode, reason, error: `${message} ${hintFor(reason)}` };
}

/**
 * Reasons whose declared contract says a repeat of the same request can succeed. `upstream_rejected`
 * is the one that cannot — the tool's own contract for it says the request will be refused again —
 * so an all-rejected batch is never told to wait and retry.
 */
const RETRYABLE_REASONS: ReadonlySet<string> = new Set<FailureReason>([
  'upstream_error',
  'upstream_timeout',
  'rate_limited',
]);

/**
 * The closing line of a batch in which no barcode resolved to a product. The structured result
 * already separates the two settlements — a fetch that failed taught nothing about its barcode,
 * while a `not_found` barcode was answered for — so the text reads them off rather than flattening
 * both into one "no products found" that fits neither.
 */
function zeroFoundSummary(notFound: string[], failed: readonly { reason: string }[]): string {
  const uncheckable = failed.length > 0;
  const missing = notFound.length > 0;

  if (uncheckable && missing) {
    return (
      `No barcode resolved to a product: Open Food Facts holds no contributor record for ${notFound.length} ` +
      `of them, and ${failed.length} could not be checked at all because the fetch failed.`
    );
  }

  if (uncheckable) {
    const recovery = failed.some((f) => RETRYABLE_REASONS.has(f.reason))
      ? 'Retry them once Open Food Facts is answering again.'
      : 'Open Food Facts refused every request as formed, so check the barcode digits before sending them again.';
    return `No barcode could be checked — every fetch failed, so nothing was learned about these products. ${recovery}`;
  }

  return (
    'Open Food Facts answered for every barcode compared and holds no contributor record for any of them. ' +
    'The products may exist without being entered yet — check the digits, or find them by name with off_search_products.'
  );
}

/**
 * A row's text label: `name (brand)`, else `Barcode N (brand)`, else `Barcode N`. Names and brands
 * are contributor-edited, so each is escaped for both table cells and inline notes.
 * One helper for every label keeps a brand-only row, or two same-name rows, from
 * reading differently from one table to the next.
 */
function rowLabel(row: {
  barcode: string;
  product_name?: string | undefined;
  brands?: string | undefined;
}): string {
  const label = row.product_name ? mdInline(row.product_name) : `Barcode ${row.barcode}`;
  return row.brands ? `${label} (${mdInline(row.brands)})` : label;
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
    Object.assign(row, readFigures(raw.nutriments, '_100g'));
    const prepared = readFigures(raw.nutriments, '_prepared_100g');
    if (Object.keys(prepared).length > 0) row.prepared = prepared;
  }

  return row;
}

export const offCompareProductsTool = tool('off_compare_products', {
  title: 'Compare Food Products Side-by-Side',
  description:
    'Side-by-side nutrition and scoring comparison for 2–10 products per call by barcode; a repeated barcode is compared once, so two identical barcodes yield one row, and barcodes past the 10th distinct one are listed in unprocessed rather than fetched. Returns a normalized table of energy (kcal), fat, saturated fat, carbohydrates, sugars, salt, protein, and fiber per 100 g, or per 100 ml for liquids, plus Nutri-Score, NOVA group, and Green-Score. Open Food Facts returns one preparation state per read, so figures for the prepared product arrive in a prepared object on the row, with the same columns and basis, and never fill an as-sold field. Designed for "which of these cereals is healthiest?" or "compare these pasta brands" workflows. Missing nutrition data for any product is preserved as absent — comparisons are not imputed. A batch is not all-or-nothing: barcodes that resolve are returned even when others fail, with confirmed-missing barcodes listed in not_found and failed fetches listed separately in failed. Scores carry regional formula caveats. Data under ODbL 1.0 — cite Open Food Facts in downstream use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    barcodes: z
      .array(
        z
          .string()
          .regex(BARCODE_PATTERN, BARCODE_PATTERN_MESSAGE)
          .describe('Product barcode, digits only: 4–40 digits after any leading zeros.'),
      )
      .min(2)
      .max(100)
      .describe(
        `Barcodes to compare, returned as one row each in input order; a repeated barcode is compared once, so two identical barcodes yield one row. One call compares at most ${COMPARE_BARCODE_CAP} distinct barcodes: up to 100 are accepted, and those past the ${COMPARE_BARCODE_CAP}th distinct one are returned in unprocessed without being fetched. Example: ["3017620422003", "7622210100146"].`,
      ),
  }),

  output: z.object({
    products: z
      .array(
        z
          .object({
            barcode: z.string().describe('Barcode, echoed exactly as provided in input.'),
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
              .describe(
                'Nutri-Score grade: "a" through "e", "unknown" when the nutrition data entered is not enough to compute it, or "not-applicable" for product categories the score does not cover. Absent when Open Food Facts sent none.',
              ),
            nova_group: z
              .number()
              .optional()
              .describe('NOVA processing class (1–4). Absent when not assigned.'),
            ecoscore_grade: z
              .string()
              .optional()
              .describe(
                'Green-Score (formerly Eco-Score) environmental impact grade: "a-plus" (lowest impact), then "a" through "f"; "unknown" when the data it needs is missing, or "not-applicable" for product categories the score does not cover. Often absent.',
              ),
            ...nutritionFields(
              (measure) =>
                `${measure} per 100 g, or per 100 ml for liquids, as sold. Absent when not entered, or when this read returned only prepared figures (see prepared).`,
            ),
            prepared: z
              .object(
                nutritionFields(
                  (measure) =>
                    `${measure} per 100 g, or per 100 ml for liquids, as prepared. Absent when this read returned no such figure.`,
                ),
              )
              .optional()
              .describe(
                "Figures for the prepared product, on the same columns and basis as the as-sold fields, read from Open Food Facts' *_prepared_100g keys and never derived or substituted for an as-sold figure. Open Food Facts returns one preparation state per read, so as-sold fields absent beside this object mean this read returned none, not that the record holds none. Absent when the read carried none of these figures.",
              ),
            completeness: z
              .number()
              .optional()
              .describe('Data completeness 0–1. Low values mean many fields are missing.'),
          })
          .describe('A single product comparison row.'),
      )
      .describe(
        'Comparison rows in input order — one per distinct barcode whose fetch completed, whether or not a record exists. Barcodes whose fetch failed have no row here; they appear in failed. Barcodes past the cap appear in unprocessed.',
      ),
    succeeded: z.number().describe('Number of barcodes that resolved to a found product.'),
    not_found: z
      .array(z.string().describe('Barcode with no contributor record, as provided in input.'))
      .describe(
        'Barcodes Open Food Facts answered for, confirming no contributor record exists. Not an error — the product may exist but not yet be entered. Never used for a fetch that failed.',
      ),
    failed: z
      .array(
        z
          .object({
            barcode: z.string().describe('Barcode whose fetch failed, as provided in input.'),
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
    unprocessed: z
      .array(z.string().describe('Barcode left unprocessed, as provided in input.'))
      .optional()
      .describe(
        `Distinct barcodes past the ${COMPARE_BARCODE_CAP}th, in input order — never fetched, so nothing is known about them. Absent when the batch held ${COMPARE_BARCODE_CAP} or fewer distinct barcodes. Compare them in another off_compare_products call (2–${COMPARE_BARCODE_CAP} barcodes), or look a single one up with off_get_product.`,
      ),
  }),

  errors: [
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: "Open Food Facts returns a 5xx other than 501 or 504, serves an HTML error page with a 2xx or 5xx status, answers 2xx with a malformed envelope, closes the connection before finishing its answer, or is unreachable for a barcode — reported in that barcode's failed entry rather than failing the call",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry the barcodes listed in failed after a brief pause. Rows that already resolved are kept, so only the failures need repeating.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: "Open Food Facts did not answer a barcode within the request or retry deadline, or answered 408, 425, or 504 — reported in that barcode's failed entry rather than failing the call",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry the barcodes listed in failed, or fetch them one at a time with off_get_product to reduce the load per request.',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: "Open Food Facts refuses a barcode with a 4xx other than 404, 408, 425, or 429, or with 501 Not Implemented — reported in that barcode's failed entry rather than failing the call",
      retryable: false,
      thrownBy: 'service',
      recovery:
        'Do not retry unchanged. Check the digits of the barcodes listed in failed, then look them up individually with off_get_product.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own per-minute product budget is spent, or Open Food Facts answers 429 — reported in that barcode's failed entry rather than failing the call",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Wait the seconds the failed entry names, or about a minute when it names none, then retry only those barcodes. Compare fewer barcodes per call to stay inside the budget.',
    },
  ],

  async handler(input, ctx) {
    const svc = getOpenFoodFactsService();

    // A repeated barcode takes one slot and one fetch. Past the cap, distinct barcodes are listed
    // rather than fetched, so the product budget is spent only on the barcodes compared.
    const distinct = [...new Set(input.barcodes)];
    const compared = distinct.slice(0, COMPARE_BARCODE_CAP);
    const unprocessed = distinct.slice(COMPARE_BARCODE_CAP);

    const settlements = await Promise.allSettled(
      compared.map((barcode) => svc.getProductFields(barcode, COMPARE_FIELDS, ctx)),
    );

    const products: CompareRow[] = [];
    const not_found: string[] = [];
    const failed: FailedFetch[] = [];
    let succeeded = 0;

    // Classify by how the fetch settled, never by error text. The service resolves null only for a
    // barcode Open Food Facts confirmed it has no record of, so a rejection is always a failure to
    // learn anything about that barcode — reporting it as not_found would assert the opposite.
    // Failures stay per-barcode so a mixed batch keeps the rows that did resolve.
    for (let i = 0; i < compared.length; i++) {
      const barcode = compared[i] as string;
      const result = settlements[i] as PromiseSettledResult<RawProduct | null>;

      if (result.status === 'rejected') {
        failed.push(
          describeFailure(
            barcode,
            result.reason,
            (reason) => ctx.recoveryFor(reason).recovery.hint,
          ),
        );
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
      total: compared.length,
      succeeded,
      not_found: not_found.length,
      failed: failed.length,
      unprocessed: unprocessed.length,
    });

    return {
      products,
      succeeded,
      not_found,
      ...(failed.length > 0 && { failed }),
      ...(unprocessed.length > 0 && { unprocessed }),
    };
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
        // The upstream's own explanation rides in `error`, so it is escaped like any other value
        // this server did not author.
        lines.push(`- ${f.barcode} (${f.reason}): ${mdInline(f.error)}`);
      }
      lines.push('');
    }

    if (result.unprocessed && result.unprocessed.length > 0) {
      lines.push(
        `**Not compared (over the ${COMPARE_BARCODE_CAP}-barcode cap):** ${result.unprocessed.join(', ')} — ${unprocessedNextStep(result.unprocessed.length)}\n`,
      );
    }

    const found = result.products.filter((p) => p.found);
    if (found.length === 0) {
      lines.push(zeroFoundSummary(result.not_found, result.failed ?? []));
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

    // Scores table — includes all products with found status
    lines.push('### Scores');
    lines.push('| Product | Barcode | Found | Nutri-Score | NOVA | Eco-Score | Completeness |');
    lines.push('|:--------|:--------|:------|:------------|:-----|:----------|:-------------|');
    for (const p of result.products) {
      const name = rowLabel(p);
      // The exact scalar rides alongside the rounded percentage: 0.7875 and 0.79 both render as
      // "79%", and a text-only client has no second call that would recover the difference.
      const completeness =
        p.completeness !== undefined
          ? `${Math.round(p.completeness * 100)}% (${p.completeness})`
          : 'N/A';
      const grade = (value: string | undefined) => (value === undefined ? 'N/A' : mdInline(value));
      lines.push(
        `| ${name} | ${p.barcode} | ${p.found} | ${grade(p.nutriscore_grade)} | ${p.nova_group ?? 'N/A'} | ${grade(p.ecoscore_grade)} | ${completeness} |`,
      );
    }

    // Nutrition tables. Each block stands alone, since a batch can fall entirely to one side. A row
    // with prepared figures and no as-sold one leaves the as-sold table: its N/As would sit under a
    // footer reading "not yet entered", which is false of a record that holds those figures on a
    // preparation state this read did not return.
    const asSold = found.filter((p) => !p.prepared || hasFigure(p));
    const asPrepared = found.flatMap((p) =>
      p.prepared ? [{ label: rowLabel(p), figures: p.prepared }] : [],
    );
    const preparedOnly = found.filter((p) => p.prepared && !hasFigure(p));

    if (asSold.length > 0) {
      lines.push(
        ...nutritionTable(
          '\n### Nutrition per 100 g / 100 ml',
          asSold.map((p) => ({ label: rowLabel(p), figures: p })),
        ),
      );
    }

    if (asPrepared.length > 0) {
      lines.push(...nutritionTable('\n### Nutrition per 100 g / 100 ml, as prepared', asPrepared));
      lines.push('\n*In this table, "N/A" = no prepared figure in this read.*');
    }

    if (preparedOnly.length > 0) {
      lines.push(
        `*This read returned no as-sold figures for ${preparedOnly.map(rowLabel).join(', ')}. Open Food Facts returns one preparation state per read, so the record can still hold them.*`,
      );
    }

    // Completeness notices
    const lowCompleteness = found.filter(
      (p) => p.completeness !== undefined && p.completeness < 0.5,
    );
    if (lowCompleteness.length > 0) {
      lines.push(
        `\n*Low completeness (< 50%): ${lowCompleteness.map(rowLabel).join(', ')} — many fields may be missing.*`,
      );
    }

    // Scoped rather than dropped when an "as prepared" table prints: Scores keeps its N/As even
    // when no as-sold table does.
    const naScope = asPrepared.length > 0 ? ' outside the "as prepared" table' : '';
    lines.push(
      `\n*Data: Open Food Facts (ODbL 1.0) — crowd-sourced. "N/A"${naScope} = not yet entered.*`,
    );

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
