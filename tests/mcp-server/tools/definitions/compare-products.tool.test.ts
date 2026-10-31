/**
 * @fileoverview Tests for off_compare_products tool.
 * @module tests/mcp-server/tools/definitions/compare-products.tool.test
 */

import { rateLimited, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfoodfacts/openfoodfacts-service.js', () => ({
  getOpenFoodFactsService: vi.fn(),
}));

import { offCompareProductsTool } from '@/mcp-server/tools/definitions/compare-products.tool.js';
import { getOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import { ACCEPTED_BARCODES, REJECTED_BARCODES } from '../../../fixtures/barcode-cases.js';
import { PRODUCT_FOUND, PRODUCT_NOT_FOUND_404 } from '../../../fixtures/upstream-envelopes.js';

const mockGetProductFields = vi.fn();

/** Create the contract-bearing context wired by the production handler factory. */
function createToolContext() {
  return createMockContext({ errors: offCompareProductsTool.errors });
}

/** The recovery this tool's contract declares for a reason — what a failed entry closes with. */
function declaredRecovery(reason: string): string {
  const recovery = offCompareProductsTool.errors?.find((e) => e.reason === reason)?.recovery;
  if (!recovery) throw new Error(`off_compare_products declares no reason ${reason}.`);
  return recovery;
}

/** Return the first text block produced by the tool formatter. */
function firstText(blocks: ReturnType<NonNullable<typeof offCompareProductsTool.format>>): string {
  const block = blocks[0];
  if (block?.type !== 'text') throw new Error('Expected the formatter to return text.');
  return block.text;
}

/** Concatenates every text block of a `runToolContract` result — format() output plus trailer. */
function contractText(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .join('\n');
}

/**
 * The table printed under `heading`, one record per row keyed by column header, in column order.
 * Undefined when the heading is not printed, so "no such table" and "an empty one" stay distinct.
 */
function tableUnder(text: string, heading: string): Record<string, string>[] | undefined {
  const lines = text.split('\n');
  const at = lines.indexOf(heading);
  if (at === -1) return;
  const cells = (line: string): string[] =>
    line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
  const end = lines.findIndex((line, i) => i > at && !line.startsWith('|'));
  const [header = '', , ...rows] = lines.slice(at + 1, end === -1 ? undefined : end);
  const columns = cells(header);
  return rows.map((row) => {
    const values = cells(row);
    return Object.fromEntries(columns.map((column, i) => [column, values[i] ?? '']));
  });
}

/** The per-100 keys of 7310100605412, as sold, from the v2 product route. */
const LINGUINE = {
  product_name: 'Gluten-Free Linguine Pasta',
  nutriments: {
    'added-sugars_100g': 0,
    carbohydrates_100g: 75,
    'energy-kcal_100g': 359.5,
    'energy-kj_100g': 1524,
    energy_100g: 1524,
    fat_100g: 2.5,
    fiber_100g: 2.5,
    proteins_100g: 8,
    salt_100g: 0.03,
    'saturated-fat_100g': 1,
    sodium_100g: 0.012,
    sugars_100g: 1,
  },
};

/** The per-100 keys of 8076809545440, as sold, from the v2 product route. */
const SPAGHETTI = {
  product_name: 'Spaghetti senza glutine mais riso',
  nutriments: {
    carbohydrates_100g: 79,
    'energy-kcal_100g': 358,
    'energy-kj_100g': 1517.8,
    energy_100g: 1517.8,
    fat_100g: 1.5,
    fiber_100g: 1.1,
    proteins_100g: 6.5,
    salt_100g: 0.01,
    'saturated-fat_100g': 0.3,
    sodium_100g: 0.004,
    starch_100g: 0,
    sugars_100g: 0.5,
  },
};

/**
 * The per-100 and per-serving keys of 7613035530799 from the v2 product route. The read carries the
 * prepared set alone: the record stores as-sold figures too, 327 kcal among them, and API v2 returns
 * one preparation state per record.
 */
const NESQUIK = {
  product_name: 'NESQUIK Moins de Sucres',
  brands: 'Société des Produits Nestlé S.A.',
  nutriments: {
    calcium_prepared_100g: 0.12,
    calcium_prepared_serving: 0.252,
    carbohydrates_prepared_100g: 7.6,
    carbohydrates_prepared_serving: 16,
    'energy-kcal_prepared_100g': 68,
    'energy-kcal_prepared_serving': 143,
    'energy-kj_prepared_100g': 287,
    'energy-kj_prepared_serving': 603,
    energy_prepared_100g: 287,
    energy_prepared_serving: 603,
    fat_prepared_100g: 1.9,
    fat_prepared_serving: 3.99,
    fiber_prepared_100g: 1.9,
    fiber_prepared_serving: 3.99,
    proteins_prepared_100g: 3.8,
    proteins_prepared_serving: 7.98,
    salt_prepared_100g: 0.12,
    salt_prepared_serving: 0.252,
    'saturated-fat_prepared_100g': 1.1,
    'saturated-fat_prepared_serving': 2.31,
    sodium_prepared_100g: 0.048,
    sodium_prepared_serving: 0.101,
    sugars_prepared_100g: 6.3,
    sugars_prepared_serving: 13.2,
  },
};

/** Wrap a JSON body + status in a minimal Response-like mock, as a real fetch would resolve. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Serve the tool from the real service, so a test can run checks that live in its fetch path —
 * the module-wide stub above bypasses them. Pair it with a stubbed global fetch.
 */
async function useRealService(rateLimitProduct = 100): Promise<void> {
  const { OpenFoodFactsService } = await vi.importActual<
    typeof import('@/services/openfoodfacts/openfoodfacts-service.js')
  >('@/services/openfoodfacts/openfoodfacts-service.js');
  vi.mocked(getOpenFoodFactsService).mockReturnValue(
    new OpenFoodFactsService({
      baseUrl: 'https://world.openfoodfacts.org',
      rateLimitProduct,
      rateLimitSearch: 100,
      rateLimitTaxonomy: 100,
    }),
  );
}

describe('off_compare_products', () => {
  const globalFetch = global.fetch;
  let ctx: ReturnType<typeof createToolContext>;

  beforeEach(() => {
    mockGetProductFields.mockReset();
    vi.mocked(getOpenFoodFactsService).mockReturnValue({
      getProductFields: mockGetProductFields,
    } as never);
    ctx = createToolContext();
  });

  afterEach(() => {
    global.fetch = globalFetch;
  });

  it('returns comparison rows for two found products', async () => {
    mockGetProductFields
      .mockResolvedValueOnce({
        product_name: 'Nutella',
        brands: 'Ferrero',
        nutriscore_grade: 'e',
        nova_group: 4,
        ecoscore_grade: 'c',
        completeness: 0.85,
        nutriments: { 'energy-kcal_100g': 539, fat_100g: 30.9, sugars_100g: 56.3 },
      })
      .mockResolvedValueOnce({
        product_name: 'Peanut Butter',
        brands: 'Skippy',
        nutriscore_grade: 'c',
        nova_group: 3,
        ecoscore_grade: 'b',
        completeness: 0.72,
        nutriments: { 'energy-kcal_100g': 580, fat_100g: 50, sugars_100g: 8 },
      });

    const result = await offCompareProductsTool.handler(
      { barcodes: ['3017620422003', '7622210100146'] },
      ctx,
    );

    expect(result.succeeded).toBe(2);
    expect(result.not_found).toHaveLength(0);
    expect(result.products).toHaveLength(2);

    const nutella = result.products[0];
    expect(nutella?.product_name).toBe('Nutella');
    expect(nutella?.nutriscore_grade).toBe('e');
    expect(nutella?.ecoscore_grade).toBe('c');
    expect(nutella?.completeness).toBe(0.85);
    expect(nutella?.energy_kcal_100g).toBe(539);
  });

  it('marks missing barcodes as not_found without throwing', async () => {
    mockGetProductFields
      .mockResolvedValueOnce({
        product_name: 'Nutella',
        nutriscore_grade: 'e',
        ecoscore_grade: 'c',
        completeness: 0.85,
        nutriments: { 'energy-kcal_100g': 539 },
      })
      .mockResolvedValueOnce(null); // not found

    const result = await offCompareProductsTool.handler(
      { barcodes: ['3017620422003', '0000000000000'] },
      ctx,
    );

    expect(result.succeeded).toBe(1);
    expect(result.not_found).toContain('0000000000000');
    expect(result.products.find((p) => p.barcode === '0000000000000')?.found).toBe(false);
  });

  it('handles sparse upstream payload per product', async () => {
    // Product with no nutriments or scores
    mockGetProductFields
      .mockResolvedValueOnce({ product_name: 'Sparse A' })
      .mockResolvedValueOnce({ product_name: 'Sparse B', nutriscore_grade: 'b' });

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '2222222222222'] },
      ctx,
    );

    expect(result.succeeded).toBe(2);
    expect(result.products[0]?.nutriscore_grade).toBeUndefined();
    expect(result.products[1]?.nutriscore_grade).toBe('b');
  });

  it('formats comparison table with nutriscore, ecoscore, and completeness columns', () => {
    const output = {
      products: [
        {
          barcode: '3017620422003',
          product_name: 'Nutella',
          brands: 'Ferrero',
          found: true,
          nutriscore_grade: 'e',
          nova_group: 4,
          ecoscore_grade: 'c',
          completeness: 0.85,
          energy_kcal_100g: 539,
          fat_100g: 30.9,
          sugars_100g: 56.3,
        },
        {
          barcode: '7622210100146',
          product_name: 'Peanut Butter',
          found: true,
          nutriscore_grade: 'c',
          ecoscore_grade: 'b',
          completeness: 0.72,
          energy_kcal_100g: 580,
        },
      ],
      succeeded: 2,
      not_found: [],
    };
    const blocks = offCompareProductsTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = firstText(blocks);
    expect(text).toContain('Nutella');
    expect(text).toContain('Peanut Butter');
    // nutriscore_grade values (not uppercased)
    expect(text).toContain('e');
    expect(text).toContain('c');
    // ecoscore_grade values
    expect(text).toContain('b');
    // completeness column present
    expect(text).toContain('85%');
    // nutrition values
    expect(text).toContain('539');
  });

  it('renders the exact completeness scalar alongside the rounded percentage', () => {
    // #9 regression: the table rendered only Math.round(completeness * 100), so 0.7875 and 0.79
    // both read as "79%" while structuredContent carried the exact value. Re-calling returns the
    // same rounded string, so a text-only client had no path to the scalar.
    const output = {
      products: [
        { barcode: '3017620422003', product_name: 'Nutella', found: true, completeness: 0.7875 },
      ],
      succeeded: 1,
      not_found: [],
    };
    const text = firstText(offCompareProductsTool.format!(output));

    expect(text).toContain('79%');
    expect(text).toContain('0.7875');
  });

  it('formats result with not_found barcodes listed', () => {
    const output = {
      products: [
        { barcode: '0000000000000', found: false },
        { barcode: '1111111111111', found: false },
      ],
      succeeded: 0,
      not_found: ['0000000000000', '1111111111111'],
    };
    const blocks = offCompareProductsTool.format!(output);
    const text = firstText(blocks);
    expect(text).toContain('0000000000000');
    expect(text.toLowerCase()).toContain('not found');
  });

  // ── mixed found + not-found barcodes ──────────────────────────────────────

  it('correctly separates found and not_found in a mixed batch', async () => {
    // Design: "When 3 of 5 barcodes resolve and 2 are not found, the caller gets a comparison
    // table for the 3 found products plus a not_found list."
    mockGetProductFields
      .mockResolvedValueOnce({ product_name: 'Product A', nutriscore_grade: 'a', nutriments: {} })
      .mockResolvedValueOnce(null) // not found
      .mockResolvedValueOnce({ product_name: 'Product C', nutriscore_grade: 'c', nutriments: {} })
      .mockResolvedValueOnce(null) // not found
      .mockResolvedValueOnce({ product_name: 'Product E', nutriscore_grade: 'b', nutriments: {} });

    const result = await offCompareProductsTool.handler(
      {
        barcodes: [
          '1111111111111',
          '2222222222222',
          '3333333333333',
          '4444444444444',
          '5555555555555',
        ],
      },
      ctx,
    );

    expect(result.succeeded).toBe(3);
    expect(result.not_found).toHaveLength(2);
    expect(result.not_found).toContain('2222222222222');
    expect(result.not_found).toContain('4444444444444');
    expect(result.products).toHaveLength(5); // all rows present, found or not

    // Products preserve input order
    expect(result.products[0]?.product_name).toBe('Product A');
    expect(result.products[0]?.found).toBe(true);
    expect(result.products[1]?.found).toBe(false);
    expect(result.products[2]?.product_name).toBe('Product C');
    expect(result.products[3]?.found).toBe(false);
    expect(result.products[4]?.product_name).toBe('Product E');
  });

  it('not_found barcodes in the output have found=false and no nutrition fields', async () => {
    // Design: comparison rows for not-found products have {barcode, found: false} — no fabricated
    // nutrition zeros or undefined scores.
    mockGetProductFields
      .mockResolvedValueOnce({
        product_name: 'Found Product',
        nutriscore_grade: 'b',
        nutriments: { 'energy-kcal_100g': 300 },
      })
      .mockResolvedValueOnce(null);

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '9999999999999'] },
      ctx,
    );

    const notFoundRow = result.products.find((p) => p.barcode === '9999999999999');
    expect(notFoundRow?.found).toBe(false);
    expect(notFoundRow?.product_name).toBeUndefined();
    expect(notFoundRow?.nutriscore_grade).toBeUndefined();
    expect(notFoundRow?.energy_kcal_100g).toBeUndefined();
    expect(notFoundRow?.fat_100g).toBeUndefined();
  });

  // ── rejected fetches are failures, never not_found (GH issue #11) ─────────

  it('reports a rejected fetch in failed and keeps the rows that resolved', async () => {
    // Only a resolved null means "no contributor record". A rejection means the barcode was never
    // checked, so it must not enter not_found — and the barcode that did resolve must survive.
    mockGetProductFields
      .mockResolvedValueOnce({ product_name: 'Good Product', nutriments: {} })
      .mockRejectedValueOnce(
        serviceUnavailable('Open Food Facts is unavailable (HTTP 503).', {
          reason: 'upstream_error',
        }),
      );

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '2222222222222'] },
      ctx,
    );

    expect(result.succeeded).toBe(1);
    expect(result.products[0]?.product_name).toBe('Good Product');
    expect(result.not_found).toHaveLength(0);
    // The service raises only the reason; the hint is this tool's own declared recovery for it.
    expect(result.failed).toEqual([
      {
        barcode: '2222222222222',
        reason: 'upstream_error',
        error: `Open Food Facts is unavailable (HTTP 503). ${declaredRecovery('upstream_error')}`,
      },
    ]);
  });

  it('separates the recovery hint from a message that does not end in punctuation', async () => {
    // The upstream's own explanation is appended raw and rarely ends in a period; without a
    // separator the hint runs on from it as a single sentence.
    mockGetProductFields
      .mockResolvedValueOnce({ product_name: 'Good Product', nutriments: {} })
      .mockRejectedValueOnce(
        serviceUnavailable('Open Food Facts refused the request (HTTP 400): page too deep', {
          reason: 'upstream_rejected',
        }),
      );

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '2222222222222'] },
      ctx,
    );

    expect(result.failed?.[0]?.error).toBe(
      `Open Food Facts refused the request (HTTP 400): page too deep. ${declaredRecovery('upstream_rejected')}`,
    );
  });

  it('keeps a rate-limited barcode out of not_found and out of the comparison rows', async () => {
    // The local limiter refuses the second barcode outright. The already-fetched row is kept.
    mockGetProductFields
      .mockResolvedValueOnce({ product_name: 'Good Product', nutriments: {} })
      .mockRejectedValueOnce(
        rateLimited('openfoodfacts-mcp-server declined this product request.', {
          reason: 'rate_limited',
          retryAfter: 47,
        }),
      );

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '2222222222222'] },
      ctx,
    );

    expect(result.succeeded).toBe(1);
    expect(result.not_found).toHaveLength(0);
    expect(result.failed?.[0]?.reason).toBe('rate_limited');
    expect(result.products.map((p) => p.barcode)).toEqual(['1111111111111']);
  });

  it('describes a plain rejection without a contract reason as an upstream failure', async () => {
    mockGetProductFields
      .mockResolvedValueOnce({ product_name: 'Good Product', nutriments: {} })
      .mockRejectedValueOnce(new Error('Network timeout'));

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '2222222222222'] },
      ctx,
    );

    expect(result.succeeded).toBe(1);
    expect(result.not_found).toHaveLength(0);
    expect(result.failed).toEqual([
      {
        barcode: '2222222222222',
        reason: 'upstream_error',
        error: `Network timeout. ${declaredRecovery('upstream_error')}`,
      },
    ]);
  });

  it('lists a malformed product envelope in failed, never in not_found (#54)', async () => {
    // The malformed-envelope check lives in the service's fetch path.
    await useRealService();
    const responses: Record<string, Response> = {
      '1000': jsonResponse({}),
      '1001': jsonResponse({ status: 1, status_verbose: 'product found' }),
      '3017620422003': jsonResponse(PRODUCT_FOUND),
      '2961836540127': jsonResponse(PRODUCT_NOT_FOUND_404, 404),
    };
    global.fetch = vi.fn(async (input: unknown) => {
      const barcode = /\/api\/v2\/product\/(\d+)\.json/.exec(String(input))?.[1] ?? '';
      const response = responses[barcode];
      if (!response) throw new Error(`Unrouted request: ${String(input)}`);
      return response;
    });

    vi.useFakeTimers();
    try {
      const pending = runToolContract(offCompareProductsTool, {
        barcodes: ['1000', '1001', '3017620422003', '2961836540127'],
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.isError).toBeFalsy();
      const output = result.structuredContent as {
        products: { barcode: string; found: boolean }[];
        not_found: string[];
        failed?: { barcode: string; reason: string; error: string }[];
      };
      expect(output.not_found).toEqual(['2961836540127']);
      expect(output.failed?.map((f) => [f.barcode, f.reason])).toEqual([
        ['1000', 'upstream_error'],
        ['1001', 'upstream_error'],
      ]);
      expect(output.failed?.[0]?.error).toContain('malformed');
      expect(output.products.map((p) => [p.barcode, p.found])).toEqual([
        ['3017620422003', true],
        ['2961836540127', false],
      ]);
      const text = contractText(result);
      expect(text).toContain('**Not found:** 2961836540127');
      expect(text).toMatch(/Fetch failed[\s\S]*1000[\s\S]*1001/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('omits failed entirely when every fetch completes', async () => {
    mockGetProductFields
      .mockResolvedValueOnce({ product_name: 'Found', nutriments: {} })
      .mockResolvedValueOnce(null);

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '2222222222222'] },
      ctx,
    );

    expect(result.failed).toBeUndefined();
    expect(result.not_found).toEqual(['2222222222222']);
  });

  it('renders failed barcodes distinctly from not_found', () => {
    const blocks = offCompareProductsTool.format!({
      products: [
        { barcode: '1111111111111', product_name: 'Found', found: true },
        { barcode: '2222222222222', found: false },
      ],
      succeeded: 1,
      not_found: ['2222222222222'],
      failed: [
        { barcode: '3333333333333', reason: 'upstream_error', error: 'Open Food Facts is down.' },
      ],
    });
    const text = firstText(blocks);

    expect(text).toContain('not yet entered in Open Food Facts');
    expect(text).toContain('not checked, not confirmed missing');
    expect(text).toContain('3333333333333 (upstream_error)');
    // The header counts every barcode attempted, including the ones that failed.
    expect(text).toContain('(1/3 found)');
  });

  // ── #29: a zero-found batch reads off its settlement categories ───────────

  it('says no barcode was checked when every fetch failed', () => {
    // #29: the zero-found branch appended "No products found. Try off_get_product on individual
    // barcodes to verify." after saying the barcodes were not checked — three settlements
    // collapsed into one line that fits none of them.
    const text = firstText(
      offCompareProductsTool.format!({
        products: [],
        succeeded: 0,
        not_found: [],
        failed: [
          {
            barcode: '3017620422003',
            reason: 'upstream_error',
            error: 'Open Food Facts is unavailable. (failed after 4 attempts).',
          },
          {
            barcode: '7622210100146',
            reason: 'upstream_error',
            error: 'Open Food Facts is unavailable. (failed after 4 attempts).',
          },
        ],
      }),
    );

    expect(text).not.toContain('No products found');
    expect(text).not.toContain('off_get_product');
    expect(text).toContain('No barcode could be checked');
    // Retryable reasons — the recovery says to retry, and never that the products are missing.
    expect(text).toContain('Retry');
    expect(text).not.toMatch(/not yet entered|no contributor record/);
  });

  it('does not tell the caller to retry a batch Open Food Facts refused outright', () => {
    // upstream_rejected is declared non-retryable — the request as formed is refused again.
    const text = firstText(
      offCompareProductsTool.format!({
        products: [],
        succeeded: 0,
        not_found: [],
        failed: [
          { barcode: '3017620422003', reason: 'upstream_rejected', error: 'Refused (HTTP 400).' },
          { barcode: '7622210100146', reason: 'upstream_rejected', error: 'Refused (HTTP 400).' },
        ],
      }),
    );

    expect(text).not.toContain('No products found');
    expect(text).not.toMatch(/\bRetry\b/i);
    expect(text).toContain('No barcode could be checked');
  });

  it('states the absence of a contributor record when every barcode is not_found', () => {
    const text = firstText(
      offCompareProductsTool.format!({
        products: [
          { barcode: '00000000000001', found: false },
          { barcode: '00000000000002', found: false },
        ],
        succeeded: 0,
        not_found: ['00000000000001', '00000000000002'],
      }),
    );

    expect(text).not.toContain('No products found');
    expect(text).toContain('no contributor record');
    // Nothing may imply a fetch failed — Open Food Facts answered for every barcode.
    expect(text).not.toMatch(/could not be checked|not checked|failed/i);
  });

  it('states both settlements separately when a zero-found batch mixes them', () => {
    const text = firstText(
      offCompareProductsTool.format!({
        products: [{ barcode: '00000000000001', found: false }],
        succeeded: 0,
        not_found: ['00000000000001'],
        failed: [{ barcode: '3017620422003', reason: 'upstream_timeout', error: 'Timed out.' }],
      }),
    );

    expect(text).not.toContain('No products found');
    expect(text).toContain('no contributor record');
    expect(text).toContain('could not be checked');
  });

  it('leaves a batch with at least one found row unchanged', () => {
    const text = firstText(
      offCompareProductsTool.format!({
        products: [
          {
            barcode: '3017620422003',
            product_name: 'Nutella',
            found: true,
            nutriscore_grade: 'e',
            completeness: 0.4,
            energy_kcal_100g: 539,
          },
          { barcode: '00000000000001', found: false },
        ],
        succeeded: 1,
        not_found: ['00000000000001'],
        failed: [{ barcode: '7622210100146', reason: 'upstream_error', error: 'Down.' }],
      }),
    );

    expect(text).toContain('### Scores');
    expect(text).toContain('### Nutrition per 100 g / 100 ml');
    expect(text).toContain('Low completeness (< 50%)');
    expect(text).toContain('**Not found:** 00000000000001');
    expect(text).toContain('not checked, not confirmed missing');
    expect(text).not.toContain('No barcode could be checked');
  });

  // ── #27: table cells cannot add columns or end their row ──────────────────

  it('keeps a row whose values carry pipes and newlines inside its own columns', () => {
    const output = {
      products: [
        {
          barcode: '12345678',
          product_name: 'A | B',
          brands: 'C | D',
          found: true,
          nutriscore_grade: 'e|x',
          energy_kcal_100g: 539,
        },
        {
          barcode: '87654321',
          product_name: 'Line\nBreak',
          found: true,
          energy_kcal_100g: 100,
        },
      ],
      succeeded: 2,
      not_found: [],
    };
    const lines = firstText(offCompareProductsTool.format!(output)).split('\n');
    const pipes = (line: string): number => (line.match(/(?<!\\)\|/g) ?? []).length;

    const scoresHeader = lines.findIndex((line) => line.startsWith('| Product | Barcode |'));
    for (const row of lines.slice(scoresHeader, scoresHeader + 4)) {
      expect(pipes(row)).toBe(pipes(lines[scoresHeader] as string));
    }

    const nutritionHeader = lines.findIndex((line) => line.startsWith('| Product | Energy'));
    for (const row of lines.slice(nutritionHeader, nutritionHeader + 4)) {
      expect(pipes(row)).toBe(pipes(lines[nutritionHeader] as string));
    }

    // structuredContent keeps the raw values.
    expect(output.products[0]?.product_name).toBe('A | B');
    expect(output.products[1]?.product_name).toBe('Line\nBreak');
  });

  it('escapes the failed bullet and the low-completeness line', () => {
    const text = firstText(
      offCompareProductsTool.format!({
        products: [
          {
            barcode: '12345678',
            product_name: '*Low*',
            found: true,
            completeness: 0.2,
            energy_kcal_100g: 1,
          },
        ],
        succeeded: 1,
        not_found: [],
        failed: [{ barcode: '87654321', reason: 'upstream_rejected', error: 'Refused: <b>no</b>' }],
      }),
    );

    expect(text).toContain('Refused: \\<b>no\\</b>');
    expect(text).toContain('Low completeness (< 50%): \\*Low\\*');
  });

  it('adds no backslashes to ordinary rows', () => {
    const text = firstText(
      offCompareProductsTool.format!({
        products: [
          {
            barcode: '3017620422003',
            product_name: 'Nutella',
            brands: 'Ferrero',
            found: true,
            nutriscore_grade: 'e',
            energy_kcal_100g: 539,
          },
        ],
        succeeded: 1,
        not_found: [],
      }),
    );

    expect(text).not.toContain('\\');
  });

  // ── sparsity: missing nutrition fields ≠ zero ────────────────────────────

  it('preserves null nutrition fields without fabricating zeros for found products', async () => {
    // Design: "Missing nutrition data for any product is preserved as absent — comparisons are
    // not imputed."
    mockGetProductFields
      .mockResolvedValueOnce({
        product_name: 'No Nutrition',
        nutriscore_grade: 'c',
        // nutriments omitted — contributor hasn't entered them
      })
      .mockResolvedValueOnce({
        product_name: 'Has Nutrition',
        nutriscore_grade: 'a',
        nutriments: { 'energy-kcal_100g': 50, proteins_100g: 5 },
      });

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '2222222222222'] },
      ctx,
    );

    const noNutrition = result.products[0];
    expect(noNutrition?.found).toBe(true);
    expect(noNutrition?.energy_kcal_100g).toBeUndefined();
    expect(noNutrition?.fat_100g).toBeUndefined();
    expect(noNutrition?.proteins_100g).toBeUndefined();

    const hasNutrition = result.products[1];
    expect(hasNutrition?.energy_kcal_100g).toBe(50);
    expect(hasNutrition?.proteins_100g).toBe(5);
  });

  it('formats mixed found/not-found comparison with "N/A" for absent nutrition', () => {
    // format() must render "N/A" for absent nutrition values, not "undefined" or zero
    const output = {
      products: [
        {
          barcode: '1111111111111',
          product_name: 'Found, No Nutrition',
          found: true,
          nutriscore_grade: 'c',
          // all nutrition fields absent
        },
        {
          barcode: '2222222222222',
          found: false,
        },
      ],
      succeeded: 1,
      not_found: ['2222222222222'],
    };
    const blocks = offCompareProductsTool.format!(output);
    const text = firstText(blocks);
    expect(text).toContain('N/A'); // absent nutrition rendered as N/A
    expect(text).not.toContain('undefined');
    expect(text).toContain('2222222222222'); // not_found barcode surfaced
  });

  it('describes the full Nutri-Score and Green-Score vocabularies (#43)', () => {
    // Upstream sends "unknown" and "not-applicable" for both grades, and the Green-Score runs
    // a-plus through f — all passed through as-is, so the descriptions have to name them.
    const row = offCompareProductsTool.output.shape.products.element.shape;
    for (const term of ['"unknown"', '"not-applicable"']) {
      expect(row.nutriscore_grade.description).toContain(term);
    }
    for (const term of ['"a-plus"', '"f"', '"unknown"', '"not-applicable"']) {
      expect(row.ecoscore_grade.description).toContain(term);
    }
  });

  // ── #46: barcodes Open Food Facts serves are accepted ─────────────────────

  describe('barcode input (#46)', () => {
    it.each(ACCEPTED_BARCODES)('accepts %s in a batch', (barcode) => {
      expect(
        offCompareProductsTool.input.safeParse({ barcodes: [barcode, '3017620422003'] }).success,
      ).toBe(true);
    });

    it.each(REJECTED_BARCODES)('rejects a batch carrying %j', (barcode) => {
      expect(
        offCompareProductsTool.input.safeParse({ barcodes: [barcode, '3017620422003'] }).success,
      ).toBe(false);
    });

    it('fetches a 7-digit barcode beside an EAN-13, in input order', async () => {
      mockGetProductFields
        .mockResolvedValueOnce({ product_name: 'Short-code product' })
        .mockResolvedValueOnce({ product_name: 'Nutella' });

      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['6035215', '3017620422003'],
      });

      expect(result.isError).toBeFalsy();
      expect(mockGetProductFields.mock.calls.map((call) => call[0])).toEqual([
        '6035215',
        '3017620422003',
      ]);
      expect(
        (result.structuredContent as { products: { barcode: string }[] }).products.map(
          (row) => row.barcode,
        ),
      ).toEqual(['6035215', '3017620422003']);
    });

    it('describes every barcode field by the range Open Food Facts accepts', () => {
      const barcodes = offCompareProductsTool.input.shape.barcodes;
      const output = offCompareProductsTool.output.shape;
      const descriptions = [
        barcodes.element.description,
        output.products.element.shape.barcode.description,
        output.not_found.element.description,
        output.failed.unwrap().element.shape.barcode.description,
      ];
      expect(barcodes.element.description).toContain('4–40 digits');
      for (const description of descriptions) {
        expect(description).not.toMatch(/EAN-13 or UPC|8–14/);
      }
    });
  });

  // ── #57: barcodes past the 10th distinct one are listed, not fetched ─────

  describe('batches above the 10-barcode cap (#57)', () => {
    /** `count` distinct 13-digit barcodes, in order. */
    function barcodes(count: number): string[] {
      return Array.from({ length: count }, (_, i) => String(3_000_000_000_001 + i));
    }

    type CompareOutput = {
      products: { barcode: string; found: boolean }[];
      succeeded: number;
      not_found: string[];
      failed?: { barcode: string }[];
      unprocessed?: string[];
    };

    it('accepts up to 100 barcodes and rejects 101 before any fetch', async () => {
      expect(offCompareProductsTool.input.safeParse({ barcodes: barcodes(100) }).success).toBe(
        true,
      );
      const result = await runToolContract(offCompareProductsTool, { barcodes: barcodes(101) });
      expect(result.isError).toBe(true);
      expect(mockGetProductFields).not.toHaveBeenCalled();
    });

    it('fetches the first 10 of 11 barcodes and lists the 11th as unprocessed on both surfaces', async () => {
      mockGetProductFields.mockResolvedValue({ product_name: 'Found', nutriments: {} });
      const input = barcodes(11);

      const result = await runToolContract(offCompareProductsTool, { barcodes: input });

      expect(result.isError).toBeFalsy();
      expect(mockGetProductFields.mock.calls.map((call) => call[0])).toEqual(input.slice(0, 10));
      const output = result.structuredContent as CompareOutput;
      expect(output.unprocessed).toEqual([input[10]]);
      expect(output.products).toHaveLength(10);
      expect(output.succeeded).toBe(10);
      const text = contractText(result);
      expect(text).toContain('## Product Comparison (10/10 found)');
      expect(text).toContain(
        `**Not compared (over the 10-barcode cap):** ${input[10]} — look it up with off_get_product, or compare it with barcodes from this call in another off_compare_products call.`,
      );
    });

    it('names a follow-up compare call when several barcodes go unprocessed', () => {
      const text = firstText(
        offCompareProductsTool.format!({
          products: [{ barcode: '1111111111111', product_name: 'Found', found: true }],
          succeeded: 1,
          not_found: [],
          unprocessed: ['3000000000011', '3000000000012'],
        }),
      );

      expect(text).toContain(
        '**Not compared (over the 10-barcode cap):** 3000000000011, 3000000000012 — compare them in another off_compare_products call, up to 10 barcodes at a time.',
      );
    });

    it('adds no unprocessed key for a batch of exactly 10', async () => {
      mockGetProductFields.mockResolvedValue({ product_name: 'Found', nutriments: {} });

      const result = await runToolContract(offCompareProductsTool, { barcodes: barcodes(10) });

      expect(mockGetProductFields).toHaveBeenCalledTimes(10);
      expect(result.structuredContent).not.toHaveProperty('unprocessed');
      expect(contractText(result)).not.toContain('Not compared');
    });

    it('fetches a repeated barcode once, in one row, as the description says', async () => {
      mockGetProductFields.mockResolvedValue({ product_name: 'Found', nutriments: {} });
      const [a, b] = barcodes(2) as [string, string];

      const result = await runToolContract(offCompareProductsTool, { barcodes: [a, b, a] });

      expect(mockGetProductFields.mock.calls.map((call) => call[0])).toEqual([a, b]);
      const output = result.structuredContent as CompareOutput;
      expect(output.products.map((p) => p.barcode)).toEqual([a, b]);
      expect(output).not.toHaveProperty('unprocessed');
      expect(contractText(result)).toContain('## Product Comparison (2/2 found)');
      expect(offCompareProductsTool.description).toContain('two identical barcodes yield one row');
      expect(offCompareProductsTool.input.shape.barcodes.description).toContain(
        'two identical barcodes yield one row',
      );
    });

    it('keeps every distinct barcode in exactly one bucket when a repeat and the cap meet', async () => {
      // 12 entries, 11 distinct: the repeat takes no second slot, so the 10 fetched are the first
      // 10 distinct and only the 11th distinct barcode is left over.
      const distinct = barcodes(11);
      const input = [distinct[0], distinct[1], distinct[0], ...distinct.slice(2)] as string[];
      mockGetProductFields
        .mockRejectedValueOnce(serviceUnavailable('Open Food Facts is unavailable.'))
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ product_name: 'Found', nutriments: {} });

      const result = await runToolContract(offCompareProductsTool, { barcodes: input });

      expect(mockGetProductFields.mock.calls.map((call) => call[0])).toEqual(distinct.slice(0, 10));
      const output = result.structuredContent as CompareOutput;
      expect(output.failed?.map((f) => f.barcode)).toEqual([distinct[0]]);
      expect(output.not_found).toEqual([distinct[1]]);
      expect(output.unprocessed).toEqual([distinct[10]]);
      expect(
        output.products.length + (output.failed?.length ?? 0) + (output.unprocessed?.length ?? 0),
      ).toBe(distinct.length);
      const buckets = [
        ...output.products.map((p) => p.barcode),
        ...(output.failed ?? []).map((f) => f.barcode),
        ...(output.unprocessed ?? []),
      ];
      expect(new Set(buckets).size).toBe(buckets.length);
      // The header counts the 10 compared — 8 found, 1 not found, 1 failed — never the unprocessed.
      expect(contractText(result)).toContain('## Product Comparison (8/10 found)');
    });

    it('spends no product-budget request on unprocessed barcodes', async () => {
      // A product budget of exactly 10 per minute: an 11th fetch would be refused by the local
      // limiter and land in failed.
      await useRealService(10);
      global.fetch = vi.fn(async () => jsonResponse(PRODUCT_FOUND));
      const input = barcodes(12);

      const result = await runToolContract(offCompareProductsTool, { barcodes: input });

      expect(global.fetch).toHaveBeenCalledTimes(10);
      const output = result.structuredContent as CompareOutput;
      expect(output.failed).toBeUndefined();
      expect(output.succeeded).toBe(10);
      expect(output.unprocessed).toEqual(input.slice(10));
    });

    it('scopes the zero-found summary to the barcodes compared', () => {
      const text = firstText(
        offCompareProductsTool.format!({
          products: [
            { barcode: '00000000000001', found: false },
            { barcode: '00000000000002', found: false },
          ],
          succeeded: 0,
          not_found: ['00000000000001', '00000000000002'],
          unprocessed: ['00000000000003'],
        }),
      );

      expect(text).toContain('## Product Comparison (0/2 found)');
      expect(text).toContain('answered for every barcode compared');
      expect(text).toContain('Not compared (over the 10-barcode cap)');
    });

    it('says what happens above the cap in the barcodes description', () => {
      expect(offCompareProductsTool.input.shape.barcodes.description).toMatch(
        /up to 100[^.]*unprocessed/,
      );
    });
  });

  // ── #51: per-100 figures are per 100 g, or per 100 ml for liquids ─────────

  describe('per-100 basis (#51)', () => {
    const BASIS = 'per 100 g, or per 100 ml for liquids';

    it('states the basis on the tool description and every per-100 field description', () => {
      const row = offCompareProductsTool.output.shape.products.element.shape;
      expect(offCompareProductsTool.description).toContain(BASIS);
      expect(offCompareProductsTool.description).not.toMatch(/kcal\/100 ?g/);
      for (const key of [
        'energy_kcal_100g',
        'fat_100g',
        'saturated_fat_100g',
        'carbohydrates_100g',
        'sugars_100g',
        'salt_100g',
        'proteins_100g',
        'fiber_100g',
      ] as const) {
        expect(row[key].description, key).toContain(BASIS);
        expect(row[key].description, key).not.toMatch(/per 100g/);
      }
    });

    it('puts a drink and a solid under one per 100 g / 100 ml table, values unchanged', async () => {
      mockGetProductFields
        .mockResolvedValueOnce({
          product_name: 'Coca-Cola Zero Sugar',
          brands: 'Coca-Cola',
          nutriments: { 'energy-kcal_100g': 0, salt_100g: 0.0246 },
        })
        .mockResolvedValueOnce({
          product_name: 'Old Fashioned Oats',
          brands: 'Quaker',
          nutriments: { 'energy-kcal_100g': 375, salt_100g: 0 },
        });

      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['0049000042566', '0030000010402'],
      });

      const rows = (result.structuredContent as { products: Record<string, unknown>[] }).products;
      expect(rows[0]).toEqual({
        barcode: '0049000042566',
        product_name: 'Coca-Cola Zero Sugar',
        brands: 'Coca-Cola',
        found: true,
        energy_kcal_100g: 0,
        salt_100g: 0.0246,
      });
      const text = contractText(result);
      expect(text).toContain('### Nutrition per 100 g / 100 ml');
      expect(text).not.toMatch(/per 100g/);
    });
  });

  // ── #56: every text row label carries the brand ───────────────────────────

  describe('row labels (#56)', () => {
    /** The table row whose first cell is `label`. */
    function rowsStartingWith(lines: string[], label: string): string[] {
      return lines.filter((line) => line.startsWith(`| ${label} |`));
    }

    it('labels a brand-only row "Barcode N (Brand)" in both tables and the note', async () => {
      // 0945666605636 as Open Food Facts returns it: a brand, no product name, low completeness.
      mockGetProductFields
        .mockResolvedValueOnce({ brands: 'Nutella', completeness: 0.2 })
        .mockResolvedValueOnce({
          product_name: 'Old Fashioned Oats',
          brands: 'Quaker',
          completeness: 0.9,
          nutriments: { 'energy-kcal_100g': 375 },
        });

      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['0945666605636', '0030000010402'],
      });

      // structuredContent is unchanged: the brand rides in brands, and no name is invented.
      const rows = (result.structuredContent as { products: Record<string, unknown>[] }).products;
      expect(rows[0]).toEqual({
        barcode: '0945666605636',
        brands: 'Nutella',
        found: true,
        completeness: 0.2,
      });
      const lines = contractText(result).split('\n');
      expect(rowsStartingWith(lines, 'Barcode 0945666605636 (Nutella)')).toHaveLength(2);
      expect(rowsStartingWith(lines, 'Old Fashioned Oats (Quaker)')).toHaveLength(2);
      expect(lines).toContain(
        '*Low completeness (< 50%): Barcode 0945666605636 (Nutella) — many fields may be missing.*',
      );
    });

    it('tells apart two rows that share a name but not a brand', () => {
      const lines = firstText(
        offCompareProductsTool.format!({
          products: [
            { barcode: '2003', product_name: 'Cola', brands: 'Brand A', found: true },
            { barcode: '2004', product_name: 'Cola', brands: 'Brand B', found: true },
          ],
          succeeded: 2,
          not_found: [],
        }),
      ).split('\n');

      const nutritionHeader = lines.findIndex((line) => line.startsWith('| Product | Energy'));
      const nutritionRows = lines.slice(nutritionHeader + 2, nutritionHeader + 4);
      expect(nutritionRows[0]).toMatch(/^\| Cola \(Brand A\) \|/);
      expect(nutritionRows[1]).toMatch(/^\| Cola \(Brand B\) \|/);
    });

    it('labels a row with neither name nor brand "Barcode N" everywhere', () => {
      const text = firstText(
        offCompareProductsTool.format!({
          products: [
            { barcode: '12345678', found: true, completeness: 0.1 },
            { barcode: '87654321', product_name: 'Named', found: true },
          ],
          succeeded: 2,
          not_found: [],
        }),
      );
      const lines = text.split('\n');

      expect(rowsStartingWith(lines, 'Barcode 12345678')).toHaveLength(2);
      expect(rowsStartingWith(lines, 'Named')).toHaveLength(2);
      expect(text).toContain('Low completeness (< 50%): Barcode 12345678 — many fields');
      expect(text).not.toContain('Barcode 12345678 (');
    });

    // Escaped backslash-first, a pipe after backslashes keeps an odd run ahead of it and stays
    // escaped; escaped pipe-first, the backslash escapes would pair off and leave a bare delimiter.
    it.each([
      ['a pipe or a newline', 'Acme | Co\nBrands', 'Acme \\| Co Brands', 'Acme \\| Co Brands'],
      [
        'a backslash before a pipe and one at its end',
        'Acme \\| Co\\',
        'Acme \\\\\\| Co\\\\',
        'Acme \\\\\\| Co\\\\',
      ],
    ])(
      'keeps a brand carrying %s inside its cell and on the note line',
      (_label, brands, cell, note) => {
        const output = {
          products: [
            { barcode: '12345678', brands, found: true, completeness: 0.1, energy_kcal_100g: 1 },
            { barcode: '87654321', product_name: 'Plain', found: true, energy_kcal_100g: 2 },
          ],
          succeeded: 2,
          not_found: [],
        };
        const lines = firstText(offCompareProductsTool.format!(output)).split('\n');
        /** Cell delimiters: pipes behind an even run of backslashes, none included. */
        const delimiters = (line: string): number =>
          (line.match(/(?<!\\)(?:\\\\)*\|/g) ?? []).length;

        for (const header of ['| Product | Barcode |', '| Product | Energy']) {
          const at = lines.findIndex((line) => line.startsWith(header));
          for (const row of lines.slice(at, at + 4)) {
            expect(delimiters(row)).toBe(delimiters(lines[at] as string));
          }
        }
        expect(rowsStartingWith(lines, `Barcode 12345678 (${cell})`)).toHaveLength(2);
        expect(lines).toContain(
          `*Low completeness (< 50%): Barcode 12345678 (${note}) — many fields may be missing.*`,
        );
        expect(output.products[0]?.brands).toBe(brands);
      },
    );
  });

  // ── the nutrition columns: one figure, one header, nothing derived ────────

  describe('nutrition columns', () => {
    const TABLE = '### Nutrition per 100 g / 100 ml';

    it('keeps every figure under its own header, and N/A where one is absent', () => {
      const text = firstText(
        offCompareProductsTool.format!({
          products: [
            {
              barcode: '12345678',
              product_name: 'Full',
              found: true,
              energy_kcal_100g: 1,
              fat_100g: 2,
              saturated_fat_100g: 3,
              sugars_100g: 4,
              salt_100g: 5,
              proteins_100g: 6,
              fiber_100g: 7,
            },
            { barcode: '87654321', product_name: 'Sparse', found: true, sugars_100g: 0 },
          ],
          succeeded: 2,
          not_found: [],
        }),
      );

      expect(tableUnder(text, TABLE)).toMatchObject([
        {
          Product: 'Full',
          'Energy (kcal)': '1',
          'Fat (g)': '2',
          'Sat. Fat (g)': '3',
          'Sugars (g)': '4',
          'Salt (g)': '5',
          'Protein (g)': '6',
          'Fiber (g)': '7',
        },
        {
          Product: 'Sparse',
          'Energy (kcal)': 'N/A',
          'Fat (g)': 'N/A',
          'Sat. Fat (g)': 'N/A',
          'Sugars (g)': '0',
          'Salt (g)': 'N/A',
          'Protein (g)': 'N/A',
          'Fiber (g)': 'N/A',
        },
      ]);
    });

    it('leaves a non-numeric upstream figure absent rather than coercing it', async () => {
      mockGetProductFields.mockResolvedValue({
        product_name: 'Strings',
        nutriments: { 'energy-kcal_100g': 10, fat_100g: '3.2', sugars_100g: '' },
      });

      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['12345678', '87654321'],
      });

      const rows = (result.structuredContent as { products: Record<string, unknown>[] }).products;
      expect(rows[0]).toEqual({
        barcode: '12345678',
        product_name: 'Strings',
        found: true,
        energy_kcal_100g: 10,
      });
    });

    it('closes a batch with no prepared figures on the crowd-sourced footer', () => {
      const text = firstText(
        offCompareProductsTool.format!({
          products: [{ barcode: '12345678', found: true, energy_kcal_100g: 1 }],
          succeeded: 1,
          not_found: [],
        }),
      );

      expect(text.split('\n').at(-1)).toBe(
        '*Data: Open Food Facts (ODbL 1.0) — crowd-sourced. "N/A" = not yet entered.*',
      );
    });

    // ── #71: total carbohydrates ────────────────────────────────────────────

    it('carries both live carbohydrate figures on both surfaces, one fetch each (#71)', async () => {
      mockGetProductFields.mockResolvedValueOnce(LINGUINE).mockResolvedValueOnce(SPAGHETTI);

      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['7310100605412', '8076809545440'],
      });

      const rows = (result.structuredContent as { products: Record<string, unknown>[] }).products;
      expect(rows.map((row) => row.carbohydrates_100g)).toEqual([75, 79]);
      expect(rows.map((row) => row.sugars_100g)).toEqual([1, 0.5]);
      const table = tableUnder(contractText(result), TABLE);
      expect(table?.map((row) => row['Carbohydrates (g)'])).toEqual(['75', '79']);
      expect(mockGetProductFields).toHaveBeenCalledTimes(2);
    });

    it('prints the Carbohydrates column between Sat. Fat and Sugars (#71)', () => {
      const text = firstText(
        offCompareProductsTool.format!({
          products: [{ barcode: '12345678', found: true, carbohydrates_100g: 75 }],
          succeeded: 1,
          not_found: [],
        }),
      );

      expect(Object.keys(tableUnder(text, TABLE)?.[0] ?? {})).toEqual([
        'Product',
        'Energy (kcal)',
        'Fat (g)',
        'Sat. Fat (g)',
        'Carbohydrates (g)',
        'Sugars (g)',
        'Salt (g)',
        'Protein (g)',
        'Fiber (g)',
      ]);
    });

    it('never derives carbohydrates: no key leaves the field absent and the text N/A (#71)', async () => {
      mockGetProductFields.mockResolvedValue({
        product_name: 'Sugars only',
        nutriments: { sugars_100g: 12, fiber_100g: 3 },
      });

      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['12345678', '87654321'],
      });

      const rows = (result.structuredContent as { products: Record<string, unknown>[] }).products;
      expect(rows[0]).not.toHaveProperty('carbohydrates_100g');
      const table = tableUnder(contractText(result), TABLE);
      expect(table?.[0]?.['Carbohydrates (g)']).toBe('N/A');
    });

    it('leaves a non-numeric carbohydrate figure absent, like the other columns (#71)', async () => {
      mockGetProductFields
        .mockResolvedValueOnce({
          product_name: 'String carbs',
          nutriments: { carbohydrates_100g: '75', sugars_100g: 1 },
        })
        .mockResolvedValueOnce(LINGUINE);

      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['12345678', '7310100605412'],
      });

      const rows = (result.structuredContent as { products: Record<string, unknown>[] }).products;
      expect(rows[0]).not.toHaveProperty('carbohydrates_100g');
      expect(rows[0]?.sugars_100g).toBe(1);
      expect(rows[1]?.carbohydrates_100g).toBe(75);
    });

    it('never fills as-sold carbohydrates from a prepared figure (#71)', async () => {
      mockGetProductFields.mockResolvedValueOnce(NESQUIK).mockResolvedValueOnce(SPAGHETTI);

      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['7613035530799', '8076809545440'],
      });

      const rows = (result.structuredContent as { products: Record<string, unknown>[] }).products;
      expect(rows[0]).not.toHaveProperty('carbohydrates_100g');
      expect(rows[1]?.carbohydrates_100g).toBe(79);
    });

    it('names carbohydrates in the tool description (#71)', () => {
      expect(offCompareProductsTool.description).toContain(
        'saturated fat, carbohydrates, sugars, salt, protein, and fiber',
      );
    });
  });

  // ── #59: prepared figures keep to their own object and table ──────────────

  describe('prepared figures (#59)', () => {
    const AS_SOLD = '### Nutrition per 100 g / 100 ml';
    const AS_PREPARED = '### Nutrition per 100 g / 100 ml, as prepared';
    const ROW = offCompareProductsTool.output.shape.products.element.shape;

    /** The footer as printed when an "as prepared" table sits above it. */
    const SCOPED_FOOTER =
      '*Data: Open Food Facts (ODbL 1.0) — crowd-sourced. "N/A" outside the "as prepared" table = not yet entered.*';

    /** Run two records through the tool and return both surfaces. */
    async function compareTwo(first: object, second: object) {
      mockGetProductFields.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['7613035530799', '8076809545440'],
      });
      const { products } = result.structuredContent as { products: Record<string, unknown>[] };
      return { rows: products, text: contractText(result) };
    }

    it('splits a prepared-only row from an as-sold row across the two tables', async () => {
      const { rows, text } = await compareTwo(NESQUIK, SPAGHETTI);

      expect(rows[0]).toEqual({
        barcode: '7613035530799',
        product_name: NESQUIK.product_name,
        brands: NESQUIK.brands,
        found: true,
        prepared: {
          energy_kcal_100g: 68,
          fat_100g: 1.9,
          saturated_fat_100g: 1.1,
          carbohydrates_100g: 7.6,
          sugars_100g: 6.3,
          salt_100g: 0.12,
          proteins_100g: 3.8,
          fiber_100g: 1.9,
        },
      });
      expect(rows[1]).not.toHaveProperty('prepared');
      expect(rows[1]?.energy_kcal_100g).toBe(358);

      const nesquik = 'NESQUIK Moins de Sucres (Société des Produits Nestlé S.A.)';
      expect(tableUnder(text, AS_SOLD)?.map((row) => row.Product)).toEqual([
        SPAGHETTI.product_name,
      ]);
      expect(tableUnder(text, AS_PREPARED)).toEqual([
        {
          Product: nesquik,
          'Energy (kcal)': '68',
          'Fat (g)': '1.9',
          'Sat. Fat (g)': '1.1',
          'Carbohydrates (g)': '7.6',
          'Sugars (g)': '6.3',
          'Salt (g)': '0.12',
          'Protein (g)': '3.8',
          'Fiber (g)': '1.9',
        },
      ]);
      // The Scores table still lists both.
      expect(tableUnder(text, '### Scores')).toHaveLength(2);
      expect(mockGetProductFields).toHaveBeenCalledTimes(2);
    });

    it('says the read returned no as-sold figures, never that the record has none', async () => {
      const { text } = await compareTwo(NESQUIK, SPAGHETTI);

      expect(text).toContain(
        '*This read returned no as-sold figures for NESQUIK Moins de Sucres (Société des Produits Nestlé S.A.). Open Food Facts returns one preparation state per read, so the record can still hold them.*',
      );
      expect(text).not.toMatch(/(record|product) (has|holds|carries) no/i);
    });

    it('gives the "as prepared" table N/A wording true of it, scoping the footer', async () => {
      const { text } = await compareTwo(
        { product_name: 'One figure', nutriments: { fat_prepared_100g: 1.9 } },
        SPAGHETTI,
      );
      const lines = text.split('\n');

      expect(lines).toContain('*In this table, "N/A" = no prepared figure in this read.*');
      expect(lines.at(-1)).toBe(SCOPED_FOOTER);
      expect(lines).not.toContain(
        '*Data: Open Food Facts (ODbL 1.0) — crowd-sourced. "N/A" = not yet entered.*',
      );
    });

    it('renders a row with one prepared figure, N/A in every other column', async () => {
      const { rows, text } = await compareTwo(
        { product_name: 'One figure', nutriments: { fat_prepared_100g: 1.9 } },
        SPAGHETTI,
      );

      expect(rows[0]?.prepared).toEqual({ fat_100g: 1.9 });
      expect(tableUnder(text, AS_PREPARED)).toEqual([
        {
          Product: 'One figure',
          'Energy (kcal)': 'N/A',
          'Fat (g)': '1.9',
          'Sat. Fat (g)': 'N/A',
          'Carbohydrates (g)': 'N/A',
          'Sugars (g)': 'N/A',
          'Salt (g)': 'N/A',
          'Protein (g)': 'N/A',
          'Fiber (g)': 'N/A',
        },
      ]);
    });

    it('prints no as-sold table when every found row is prepared-only', async () => {
      const { text } = await compareTwo(NESQUIK, {
        product_name: 'Cacao',
        nutriments: { 'energy-kcal_prepared_100g': 72 },
      });

      expect(tableUnder(text, AS_SOLD)).toBeUndefined();
      expect(tableUnder(text, AS_PREPARED)).toHaveLength(2);
      expect(tableUnder(text, '### Scores')).toHaveLength(2);
      expect(text.split('\n').at(-1)).toBe(SCOPED_FOOTER);
      expect(text).toContain(
        '*This read returned no as-sold figures for NESQUIK Moins de Sucres (Société des Produits Nestlé S.A.), Cacao.',
      );
    });

    it('prints no "as prepared" table or wording when no row carries prepared figures', async () => {
      mockGetProductFields.mockResolvedValueOnce(LINGUINE).mockResolvedValueOnce(SPAGHETTI);

      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['7310100605412', '8076809545440'],
      });

      const rows = (result.structuredContent as { products: Record<string, unknown>[] }).products;
      expect(rows[0]).not.toHaveProperty('prepared');
      expect(rows[1]).not.toHaveProperty('prepared');
      const text = contractText(result);
      expect(tableUnder(text, AS_SOLD)).toHaveLength(2);
      expect(text).not.toMatch(/prepared/i);
      expect(text.split('\n').at(-1)).toBe(
        '*Data: Open Food Facts (ODbL 1.0) — crowd-sourced. "N/A" = not yet entered.*',
      );
    });

    it('keeps a row holding both states in both tables, with no read-only claim', async () => {
      const { rows, text } = await compareTwo(
        {
          product_name: 'Both states',
          nutriments: { fat_100g: 30, fat_prepared_100g: 2, sugars_prepared_100g: 1 },
        },
        NESQUIK,
      );

      expect(rows[0]?.fat_100g).toBe(30);
      expect(rows[0]?.prepared).toEqual({ fat_100g: 2, sugars_100g: 1 });
      expect(tableUnder(text, AS_SOLD)?.map((row) => [row.Product, row['Fat (g)']])).toEqual([
        ['Both states', '30'],
      ]);
      expect(tableUnder(text, AS_PREPARED)?.[0]).toMatchObject({
        Product: 'Both states',
        'Fat (g)': '2',
        'Sugars (g)': '1',
      });
      // Only the prepared-only row is named as having no as-sold figures.
      expect(text).toContain('no as-sold figures for NESQUIK');
      expect(text).not.toContain('no as-sold figures for Both states');
    });

    it('reads no figure the prepared columns do not name', async () => {
      const { rows } = await compareTwo(
        { product_name: 'kJ only', nutriments: { 'energy-kj_prepared_100g': 287 } },
        {
          product_name: 'kJ and fat',
          nutriments: { 'energy-kj_prepared_100g': 287, fat_prepared_100g: 2 },
        },
      );

      expect(rows[0]).not.toHaveProperty('prepared');
      expect(rows[1]?.prepared).toEqual({ fat_100g: 2 });
    });

    it('builds no prepared object from per-serving figures alone', async () => {
      const { rows, text } = await compareTwo(
        {
          product_name: 'Serving only',
          nutriments: { 'energy-kcal_prepared_serving': 143, fat_prepared_serving: 3.99 },
        },
        SPAGHETTI,
      );

      expect(rows[0]).not.toHaveProperty('prepared');
      expect(tableUnder(text, AS_PREPARED)).toBeUndefined();
    });

    it('leaves a non-numeric prepared figure absent', async () => {
      const { rows } = await compareTwo(
        {
          product_name: 'Strings',
          nutriments: { fat_prepared_100g: '1.9', sugars_prepared_100g: 6.3 },
        },
        SPAGHETTI,
      );

      expect(rows[0]?.prepared).toEqual({ sugars_100g: 6.3 });
    });

    it('keeps the settlement fields beside a prepared row', async () => {
      mockGetProductFields.mockImplementation(async (barcode: string) => {
        if (barcode === '7613035530799') return NESQUIK;
        if (barcode === '8076809545440') return null;
        throw serviceUnavailable('Open Food Facts is down.');
      });
      const failing = Array.from({ length: 10 }, (_, i) => String(1000000000001 + i));

      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['7613035530799', '7613035530799', '8076809545440', ...failing],
      });

      const output = result.structuredContent as {
        products: { barcode: string; prepared?: object }[];
        not_found: string[];
        failed?: { barcode: string; reason: string }[];
        unprocessed?: string[];
      };
      expect(output.products.map((row) => row.barcode)).toEqual(['7613035530799', '8076809545440']);
      expect(output.products[0]?.prepared).toMatchObject({ energy_kcal_100g: 68 });
      expect(output.not_found).toEqual(['8076809545440']);
      expect(output.failed?.map((entry) => entry.barcode)).toEqual(failing.slice(0, 8));
      expect(output.unprocessed).toEqual(failing.slice(8));
      // One fetch per distinct barcode compared: the repeat and the unprocessed two cost none.
      expect(mockGetProductFields).toHaveBeenCalledTimes(10);
    });

    it('adds nothing to a batch in which no barcode resolved', async () => {
      mockGetProductFields.mockResolvedValue(null);

      const result = await runToolContract(offCompareProductsTool, {
        barcodes: ['12345678', '87654321'],
      });

      expect(result.isError).toBeFalsy();
      const { products } = result.structuredContent as { products: object[] };
      expect(products).toEqual([
        { barcode: '12345678', found: false },
        { barcode: '87654321', found: false },
      ]);
      expect(contractText(result)).toContain('holds no contributor record for any of them.');
    });

    it('escapes a prepared row label in its table and its note', async () => {
      const { text } = await compareTwo(
        { product_name: 'A | B', nutriments: { fat_prepared_100g: 1 } },
        SPAGHETTI,
      );

      expect(tableUnder(text, AS_PREPARED)?.[0]?.Product).toBe('A \\| B');
      expect(text).toContain('no as-sold figures for A \\| B.');
    });

    it('holds exactly the as-sold column keys, each on the stated basis', () => {
      const prepared = ROW.prepared.unwrap().shape;
      const columns = [
        'energy_kcal_100g',
        'fat_100g',
        'saturated_fat_100g',
        'carbohydrates_100g',
        'sugars_100g',
        'salt_100g',
        'proteins_100g',
        'fiber_100g',
      ] as const;

      expect(Object.keys(ROW).filter((key) => key.endsWith('_100g'))).toEqual(columns);
      expect(Object.keys(prepared)).toEqual(columns);
      for (const key of columns) {
        expect(prepared[key].description, key).toContain('per 100 g, or per 100 ml for liquids');
        expect(prepared[key].description, key).toMatch(/prepared/);
      }
    });

    it('states on the schema and the tool that an as-sold absence is about the read', () => {
      for (const key of ['energy_kcal_100g', 'carbohydrates_100g', 'fiber_100g'] as const) {
        expect(ROW[key].description, key).toContain('this read returned only prepared figures');
      }
      expect(ROW.prepared.description).toContain('*_prepared_100g');
      expect(ROW.prepared.description).toContain('one preparation state per read');
      expect(offCompareProductsTool.description).toContain('prepared object');
    });
  });
});
