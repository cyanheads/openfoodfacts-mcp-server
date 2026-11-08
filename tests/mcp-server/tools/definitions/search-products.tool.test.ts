/**
 * @fileoverview Tests for off_search_products tool.
 * @module tests/mcp-server/tools/definitions/search-products.tool.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Partial mock: only the service accessor is stubbed. TEXT_SEARCH_RESULT_WINDOW comes through from
// the real module so the handler's page bound and these assertions can never drift apart.
vi.mock('@/services/openfoodfacts/openfoodfacts-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/openfoodfacts/openfoodfacts-service.js')>()),
  getOpenFoodFactsService: vi.fn(),
}));

import { offSearchProductsTool } from '@/mcp-server/tools/definitions/search-products.tool.js';
import { TagIds } from '@/services/mirror/mirror-ingester.js';
import {
  encodeCheckpoint,
  openMirrorStore,
  writeMirrorLoad,
} from '@/services/mirror/mirror-store.js';
import { buildMirrorRecord } from '@/services/mirror/record-builder.js';
import {
  BudgetExhaustedError,
  getOpenFoodFactsService,
  OpenFoodFactsService,
  TEXT_SEARCH_RESULT_WINDOW,
} from '@/services/openfoodfacts/openfoodfacts-service.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';
import {
  TAG_SEARCH_EMPTY,
  TAG_SEARCH_HITS,
  TEXT_SEARCH_EMPTY,
  TEXT_SEARCH_HITS,
} from '../../../fixtures/upstream-envelopes.js';

const mockSearchProducts = vi.fn();
/**
 * The live taxonomy lookup under the real taxonomy service. Answers no suggestions by default, so
 * a tag value the offline sample does not hold reaches the search normalized.
 */
const mockSuggestTaxonomy = vi.fn();
/** Whether the local mirror is ready. False by default, the answer with `OFF_MIRROR_PATH` unset. */
const mockMirrorReady = vi.fn();
/** Whether the ready mirror's last full load indexed Green-Score. False by default. */
const mockMirrorIndexesGreenScore = vi.fn();

/** Create the contract-bearing context wired by the production handler factory. */
function createToolContext() {
  return createMockContext({ errors: offSearchProductsTool.errors });
}

/** Return the first text block produced by the tool formatter. */
function firstText(blocks: ReturnType<NonNullable<typeof offSearchProductsTool.format>>): string {
  const block = blocks[0];
  if (block?.type !== 'text') throw new Error('Expected the formatter to return text.');
  return block.text;
}

/** Capture an expected handler rejection without widening it with the success type. */
async function captureError(value: unknown | Promise<unknown>): Promise<unknown> {
  try {
    await value;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the handler to reject.');
}

/**
 * Stubs one service response, filling the envelope fields a case doesn't set. `count_is_exact`
 * defaults to true because leaving it out reaches the handler as `undefined`, which reads as a
 * clipped count and flips `total_is_lower_bound` in cases that never meant to exercise it.
 * `dropped` defaults to 0, the service's answer for a page whose codes are all servable, and
 * `outside_constraints` stays unset, its answer for a page no row left. A served live answer is
 * the default outcome.
 */
function mockSearch(
  result: { count: number; products: unknown[] } & Record<string, unknown>,
): void {
  mockSearchProducts.mockResolvedValue({
    status: 'served',
    source: 'off_api',
    count_is_exact: true,
    dropped: 0,
    ...result,
  });
}

/** Concatenates every text block of a `runToolContract` result — format() output plus trailer. */
function contractText(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

/**
 * The recovery hint on a `runToolContract` error envelope. A declared hint reaches the wire through
 * the framework's fill, which a direct `handler(...)` call skips, so hint assertions go through
 * the contract runner.
 */
function contractHint(result: { structuredContent?: unknown }): string {
  const { error } = (result.structuredContent ?? {}) as {
    error?: { data?: { recovery?: { hint?: string } } };
  };
  return error?.data?.recovery?.hint ?? '';
}

/** Reads a field's rendered `.describe()` text off the tool's advertised input schema. */
function inputDescription(field: string): string {
  const { shape } = offSearchProductsTool.input as unknown as {
    shape: Record<string, { description?: string }>;
  };
  return shape[field]?.description ?? '';
}

describe('off_search_products', () => {
  let ctx: ReturnType<typeof createToolContext>;

  beforeEach(() => {
    mockSearchProducts.mockReset();
    mockSuggestTaxonomy.mockReset();
    mockSuggestTaxonomy.mockResolvedValue([]);
    mockMirrorReady.mockReset();
    mockMirrorReady.mockResolvedValue(false);
    mockMirrorIndexesGreenScore.mockReset();
    mockMirrorIndexesGreenScore.mockResolvedValue(false);
    vi.mocked(getOpenFoodFactsService).mockReturnValue({
      mirrorReady: mockMirrorReady,
      mirrorIndexesGreenScore: mockMirrorIndexesGreenScore,
      searchProducts: mockSearchProducts,
      suggestTaxonomy: mockSuggestTaxonomy,
    } as never);
    // A fresh taxonomy service per test, so its in-process resolution cache never carries over.
    initTaxonomyService();
    ctx = createToolContext();
  });

  it('returns paginated results for a text query', async () => {
    mockSearch({
      count: 42,
      page: 1,
      page_count: 20,
      page_size: 20,
      products: [
        {
          code: '3017620422003',
          product_name: 'Nutella',
          brands: 'Ferrero',
          nutriscore_grade: 'e',
          nova_group: 4,
          categories_tags: ['en:spreads'],
        },
      ],
    });

    const result = await offSearchProductsTool.handler(
      { query: 'nutella', page: 1, page_size: 20 },
      ctx,
    );

    expect(result.total).toBe(42);
    expect(result.page).toBe(1);
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.barcode).toBe('3017620422003');
    expect(result.products[0]?.nutriscore_grade).toBe('e');
  });

  it('throws ctx.fail("no_filters") when no filter is provided', async () => {
    await expect(
      offSearchProductsTool.handler({ page: 1, page_size: 20 }, ctx),
    ).rejects.toMatchObject({
      data: { reason: 'no_filters' },
    });
  });

  it('sets enrichment.notice when results are empty', async () => {
    mockSearch({
      count: 0,
      page: 1,
      page_count: 0,
      page_size: 20,
      products: [],
    });

    await offSearchProductsTool.handler(
      { query: 'xyzzy-nonexistent', page: 1, page_size: 20 },
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(typeof enrichment.notice).toBe('string');
  });

  it('echoes the caller query as sent in structuredContent and escaped in content[]', async () => {
    mockSearch({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

    const result = await runToolContract(offSearchProductsTool, {
      query: 'dark *choc* [x]',
      page: 1,
      page_size: 20,
    });

    const notice = String((result.structuredContent as Record<string, unknown>).notice ?? '');
    expect(notice).toContain('query="dark *choc* [x]"');
    // The rendered notice escapes the query's emphasis and link syntax, so it reads back as sent.
    expect(contractText(result)).toContain(
      '> No products found for query="dark \\*choc\\* \\[x\\]"',
    );
  });

  it('renders the prose enrichment fields as labelled sentences, not code spans', () => {
    const trailer = offSearchProductsTool.enrichmentTrailer;
    const sentence = 'page_size 150 is above the 100 results one call returns.';

    expect(trailer?.page_size_capped?.render?.(sentence)).toBe(`**Page size:** ${sentence}`);
    expect(trailer?.exclusion_coverage?.render?.(sentence)).toBe(`**Exclusions:** ${sentence}`);
    expect(trailer?.text_index_snapshot?.render?.(sentence)).toBe(
      `**Index freshness:** ${sentence}`,
    );
  });

  it('passes tag filter parameters to the service', async () => {
    mockSearch({
      count: 5,
      page: 1,
      page_count: 5,
      page_size: 20,
      products: [],
    });

    await offSearchProductsTool.handler(
      { categories_tag: 'en:cheeses', labels_tag: 'en:organic', page: 1, page_size: 20 },
      ctx,
    );

    expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
      categories_tag: 'en:cheeses',
      labels_tag: 'en:organic',
    });
  });

  it('passes both a text query and tag filters to the service (combined search)', async () => {
    // Combined case (issue #6): query + tag filters travel together in one service call so the
    // service can build a merged search-a-licious query — the tool drops neither side.
    mockSearch({
      count: 6,
      page: 1,
      page_count: 6,
      page_size: 20,
      products: [
        {
          code: '0850013711000',
          product_name: 'Theo Dark Chocolate',
          brands: 'Theo',
          labels_tags: ['en:organic'],
        },
      ],
    });

    const result = await offSearchProductsTool.handler(
      {
        query: 'dark chocolate',
        labels_tag: 'en:organic',
        countries_tag: 'en:france',
        page: 1,
        page_size: 20,
      },
      ctx,
    );

    expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
      query: 'dark chocolate',
      labels_tag: 'en:organic',
      countries_tag: 'en:france',
    });
    expect(result.products[0]?.barcode).toBe('0850013711000');
  });

  it('formats results with nutriscore_grade and barcode visible', () => {
    const output = {
      total: 10,
      total_is_lower_bound: false,
      page: 1,
      page_size: 20,
      page_count: 1,
      source: 'off_api' as const,
      products: [
        {
          barcode: '3017620422003',
          product_name: 'Nutella',
          brands: 'Ferrero',
          nutriscore_grade: 'e',
          nova_group: 4,
          categories_tags: ['en:spreads'],
        },
      ],
    };
    const blocks = offSearchProductsTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = firstText(blocks);
    expect(text).toContain('3017620422003');
    expect(text).toContain('Nutella');
    expect(text).toContain('e'); // nutriscore_grade value (not uppercased)
  });

  it('formats empty results with guidance', () => {
    const output = {
      total: 0,
      total_is_lower_bound: false,
      page: 1,
      page_size: 20,
      page_count: 0,
      source: 'off_api' as const,
      products: [],
    };
    const blocks = offSearchProductsTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = firstText(blocks);
    expect(text.toLowerCase()).toContain('no products');
  });

  // ── error contract assertions ──────────────────────────────────────────────

  it('throws ctx.fail("no_filters") with the declared reason when all filter fields are empty strings', async () => {
    // Design guard: form-based clients may send "" instead of undefined for optional fields.
    // All-empty-string inputs must also be treated as no filter provided.
    await expect(
      offSearchProductsTool.handler(
        {
          query: '   ',
          categories_tag: '',
          brands_tag: '  ',
          labels_tag: '',
          page: 1,
          page_size: 20,
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      data: { reason: 'no_filters' },
    });
  });

  it('propagates upstream_error from the service layer', async () => {
    // Design: upstream 5xx → serviceUnavailable() from the service layer propagates.
    mockSearchProducts.mockRejectedValue(new Error('Open Food Facts search returned HTTP 503'));

    await expect(
      offSearchProductsTool.handler({ query: 'test', page: 1, page_size: 20 }, ctx),
    ).rejects.toThrow('HTTP 503');
  });

  // ── text-search result window (GH issue #19) ──────────────────────────────

  it('rejects a text search past the result window before sending a request', async () => {
    // The text backend answers page * page_size > 10,000 with an HTTP 422 that no retry can clear.
    // Pre-flight rejection replaces four retries and a ServiceUnavailable with an actionable limit.
    await expect(
      offSearchProductsTool.handler({ query: 'chocolate', page: 5001, page_size: 2 }, ctx),
    ).rejects.toMatchObject({
      data: {
        reason: 'page_out_of_range',
        max_page: TEXT_SEARCH_RESULT_WINDOW / 2,
        result_window: TEXT_SEARCH_RESULT_WINDOW,
      },
    });

    expect(mockSearchProducts).not.toHaveBeenCalled();
  });

  it('carries a recovery hint naming the highest page this page_size can reach', async () => {
    const error = (await captureError(
      offSearchProductsTool.handler({ query: 'chocolate', page: 900, page_size: 50 }, ctx),
    )) as { data?: { recovery?: { hint?: string } } };

    expect(error.data?.recovery?.hint).toContain('page 200');
  });

  it('serves the last page inside the window', async () => {
    // page * page_size === 10,000 exactly is the boundary the backend still answers.
    mockSearch({
      count: 20_000,
      page: 5000,
      page_count: 2,
      page_size: 2,
      products: [{ code: '1234567890001' }],
    });

    const result = await offSearchProductsTool.handler(
      { query: 'chocolate', page: 5000, page_size: 2 },
      ctx,
    );

    expect(result.page).toBe(5000);
    expect(mockSearchProducts).toHaveBeenCalledOnce();
  });

  it('bounds a tag-only search by its page limit, not the text window', async () => {
    // The 10,000-result cap belongs to search.openfoodfacts.org; /api/v2/search serves pages 1–10
    // to an anonymous client whatever the page_size, so its rejection names page 10.
    await expect(
      offSearchProductsTool.handler({ categories_tag: 'en:pizzas', page: 5001, page_size: 2 }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'page_out_of_range', max_page: 10 } });

    expect(mockSearchProducts).not.toHaveBeenCalled();
  });

  it('caps text-search truncation guidance at the pages the backend will serve', async () => {
    // The match total implies 6,633 pages; only the first 500 are reachable at page_size 20.
    mockSearch({
      count: 132_650,
      page: 1,
      page_count: 20,
      page_size: 20,
      products: [{ code: '1234567890001' }],
    });

    await offSearchProductsTool.handler({ query: 'chocolate', page: 1, page_size: 20 }, ctx);

    const guidance = String(getEnrichment(ctx).notice ?? '');
    expect(guidance).toContain('500 reachable pages');
    expect(guidance).not.toMatch(/of 6633\b/);
  });

  it('caps tag-search truncation guidance at the 10 pages the backend will serve', async () => {
    mockSearch({
      count: 13_265,
      page: 1,
      page_count: 5,
      page_size: 5,
      products: [{ code: '1234567890001' }],
    });

    await offSearchProductsTool.handler(
      { categories_tag: 'en:pizzas', page: 1, page_size: 5 },
      ctx,
    );

    const guidance = String(getEnrichment(ctx).notice ?? '');
    expect(guidance).toContain('Page 1 of 10 reachable pages');
    expect(guidance).toContain('2653 pages of matches exist');
  });

  it('does not point at the page parameter from the last page text search will serve', async () => {
    // page 5000 at page_size 2 is the deepest request inside the window; page 5001 is rejected by
    // the pre-flight check. Guidance that still said "fetch subsequent pages" here would send the
    // caller straight into that rejection.
    mockSearch({
      count: 12_000,
      page: 5000,
      page_count: 2,
      page_size: 2,
      products: [{ code: '1234567890001' }],
    });

    await offSearchProductsTool.handler({ query: 'chocolate', page: 5000, page_size: 2 }, ctx);

    const enrichment = getEnrichment(ctx);
    // Matches lie beyond the window, so the page is still truncated.
    expect(enrichment.truncated).toBe(true);
    const guidance = String(enrichment.notice ?? '');
    expect(guidance).toContain('as deep as text search paginates');
    expect(guidance).not.toContain('fetch subsequent pages');
  });

  it('says the search goes no deeper on the last page of a clipped text total', async () => {
    mockSearch({
      count: TEXT_SEARCH_RESULT_WINDOW,
      count_is_exact: false,
      page: 500,
      page_count: 20,
      page_size: 20,
      products: [{ code: '1234567890001' }],
    });

    await offSearchProductsTool.handler({ query: 'chocolate', page: 500, page_size: 20 }, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    const guidance = String(enrichment.notice ?? '');
    expect(guidance).toContain('as deep as text search paginates');
    expect(guidance).toContain('the backend stopped counting');
  });

  // ── sparse upstream products in search results ─────────────────────────────

  it('handles sparse search result rows without fabricating values', async () => {
    // Search returns rows with only the code field — everything else omitted (crowd-sourced data).
    mockSearch({
      count: 3,
      page: 1,
      page_count: 3,
      page_size: 20,
      products: [
        { code: '1234567890001' },
        { code: '1234567890002', product_name: 'Has Name Only' },
        { code: '1234567890003', nutriscore_grade: 'b' },
      ],
    });

    const result = await offSearchProductsTool.handler(
      { query: 'sparse test', page: 1, page_size: 20 },
      ctx,
    );

    expect(result.products).toHaveLength(3);

    const row0 = result.products[0];
    expect(row0?.barcode).toBe('1234567890001');
    expect(row0?.product_name).toBeUndefined();
    expect(row0?.nutriscore_grade).toBeUndefined();
    expect(row0?.nova_group).toBeUndefined();

    const row1 = result.products[1];
    expect(row1?.product_name).toBe('Has Name Only');
    expect(row1?.nutriscore_grade).toBeUndefined();

    const row2 = result.products[2];
    expect(row2?.nutriscore_grade).toBe('b');
    expect(row2?.product_name).toBeUndefined();
  });

  it('formats sparse search rows without rendering "undefined"', () => {
    const output = {
      total: 1,
      total_is_lower_bound: false,
      page: 1,
      page_size: 20,
      page_count: 1,
      source: 'off_api' as const,
      products: [
        {
          barcode: '1234567890001',
          // no product_name, brands, scores, categories
        },
      ],
    };
    const blocks = offSearchProductsTool.format!(output);
    const text = firstText(blocks);
    expect(text).toContain('1234567890001');
    expect(text).not.toContain('undefined');
  });

  // ── sort_by parameter ─────────────────────────────────────────────────────

  it('passes sort_by to the service on tag-filter path', async () => {
    mockSearch({
      count: 5,
      page: 1,
      page_count: 5,
      page_size: 20,
      products: [],
    });

    await offSearchProductsTool.handler(
      { categories_tag: 'en:cheeses', sort_by: 'unique_scans_n', page: 1, page_size: 20 },
      ctx,
    );

    expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
      categories_tag: 'en:cheeses',
      sort_by: 'unique_scans_n',
    });
  });

  it('does not set sort_by when omitted', async () => {
    mockSearch({
      count: 1,
      page: 1,
      page_count: 1,
      page_size: 20,
      products: [],
    });

    await offSearchProductsTool.handler(
      { categories_tag: 'en:spreads', page: 1, page_size: 20 },
      ctx,
    );

    const params = mockSearchProducts.mock.calls[0]?.[0];
    expect(params?.sort_by).toBeUndefined();
  });

  it('passes sort_by on the text-query path, where the service now applies it', async () => {
    // GH issue #33: the text backend sorts. The tool forwards the enum value unchanged on both
    // paths; the service is what translates it to each backend's spelling.
    mockSearch({
      count: 2,
      page: 1,
      page_count: 2,
      page_size: 20,
      products: [],
    });

    await offSearchProductsTool.handler(
      { query: 'chocolate', sort_by: 'popularity_key', page: 1, page_size: 20 },
      ctx,
    );

    const params = mockSearchProducts.mock.calls[0]?.[0];
    expect(params?.sort_by).toBe('popularity_key');
  });

  it('describes sort_by as ordering both search paths', () => {
    // The stale wording told callers text searches ignore the option, which is what #33 fixed.
    // Reading the advertised schema keeps the description from drifting back.
    const description = inputDescription('sort_by');

    expect(description).not.toMatch(/ignore this option/i);
    expect(description).not.toMatch(/without a text query/i);
    expect(description).toMatch(/newest|highest/i);
  });

  // ── numeric nutrient filters (GH issue #28) ───────────────────────────────

  describe('nutrient filters', () => {
    it('accepts a nutrient constraint as the only filter', async () => {
      mockSearch({
        count: 12,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      await offSearchProductsTool.handler(
        {
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      expect(mockSearchProducts).toHaveBeenCalledOnce();
      expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
        nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
      });
    });

    it('lists nutrient_filters in the no_filters recovery text', () => {
      const recovery =
        offSearchProductsTool.errors?.find((e) => e.reason === 'no_filters')?.recovery ?? '';

      expect(recovery).toContain('nutrient_filters');
    });

    it('still refuses a request with no filter at all', async () => {
      await expect(
        offSearchProductsTool.handler({ nutrient_filters: [], page: 1, page_size: 20 }, ctx),
      ).rejects.toMatchObject({ data: { reason: 'no_filters' } });
    });

    it('refuses additives_tag on a nutrient-only search, keyed on the routing decision', async () => {
      // A nutrient constraint moves the search to the backend that has no additives_tags field,
      // so the pairing matches nothing there just as it would alongside free text.
      await expect(
        offSearchProductsTool.handler(
          {
            additives_tag: 'en:e322',
            nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
            page: 1,
            page_size: 20,
          },
          ctx,
        ),
      ).rejects.toMatchObject({
        data: { reason: 'additives_filter_needs_tag_search', additives_tag: 'en:e322' },
      });

      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it('names the nutrient filter as a cause in the additives rejection hint', async () => {
      const result = await runToolContract(offSearchProductsTool, {
        additives_tag: 'en:e322',
        nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
        page: 1,
        page_size: 20,
      });

      expect(result.isError).toBe(true);
      expect(contractHint(result)).toContain('nutrient_filters');
    });

    it('applies the text-search page window to a nutrient-only search', async () => {
      await expect(
        offSearchProductsTool.handler(
          {
            nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
            page: 5001,
            page_size: 2,
          },
          ctx,
        ),
      ).rejects.toMatchObject({
        data: { reason: 'page_out_of_range', result_window: TEXT_SEARCH_RESULT_WINDOW },
      });

      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it('echoes the nutrient constraints in the empty-result notice', async () => {
      mockSearch({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

      await offSearchProductsTool.handler(
        {
          categories_tag: 'en:breakfast-cereals',
          nutrient_filters: [
            { nutrient: 'sugars', operator: 'lt', value: 8 },
            { nutrient: 'fiber', operator: 'gte', value: 6 },
          ],
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toContain('category="en:breakfast-cereals"');
      expect(notice).toContain('nutrient="sugars<8"');
      expect(notice).toContain('nutrient="fiber>=6"');
    });

    it('inherits the text-index freshness disclosure on a nutrient-only search', async () => {
      mockSearch({
        count: 12,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      await offSearchProductsTool.handler(
        {
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      expect(String(getEnrichment(ctx).text_index_snapshot ?? '')).toMatch(/snapshot/i);
    });

    it('reports an exhausted page on a nutrient-filtered search', async () => {
      mockSearch({ count: 163, page: 5, page_count: 0, page_size: 50, products: [] });

      await offSearchProductsTool.handler(
        {
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
          page: 5,
          page_size: 50,
        },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toMatch(/past the end/i);
      expect(notice).toContain('163');
    });

    it('rejects a nutrient outside the verified per-100 g set at the schema', () => {
      const parsed = offSearchProductsTool.input.safeParse({
        nutrient_filters: [{ nutrient: 'cholesterol', operator: 'lt', value: 8 }],
        page: 1,
        page_size: 20,
      });

      expect(parsed.success).toBe(false);
    });

    it('rejects an unsupported operator at the schema', () => {
      const parsed = offSearchProductsTool.input.safeParse({
        nutrient_filters: [{ nutrient: 'sugars', operator: 'between', value: 8 }],
        page: 1,
        page_size: 20,
      });

      expect(parsed.success).toBe(false);
    });

    it('rejects a non-numeric constraint value, so no caller text reaches the query', () => {
      const parsed = offSearchProductsTool.input.safeParse({
        nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: '8 TO *] OR sugars:[0' }],
        page: 1,
        page_size: 20,
      });

      expect(parsed.success).toBe(false);
    });

    it('describes the nutrient filter as per-100 g and text-backend served', () => {
      const description = inputDescription('nutrient_filters');

      expect(description).toMatch(/100\s?g/i);
      expect(description).toMatch(/text/i);
    });

    /** The advertised field schemas of one nutrient_filters entry. */
    function nutrientFilterEntry(): Record<string, { description?: string }> {
      return (
        offSearchProductsTool.input.shape.nutrient_filters.unwrap().element as unknown as {
          shape: Record<string, { description?: string }>;
        }
      ).shape;
    }

    it('keeps kcal for energy and grams for every other nutrient in the filter descriptions', () => {
      const entry = nutrientFilterEntry();

      // The threshold names its unit rather than pointing at the nutrient's.
      for (const field of ['nutrient', 'value']) {
        expect(entry[field]?.description, field).toMatch(/kilocalories/);
        expect(entry[field]?.description, field).toMatch(/grams/);
      }
    });

    it('states the basis as per 100 g, or per 100 ml for liquids (#51)', () => {
      const basis = 'per 100 g, or per 100 ml for liquids';
      const entry = nutrientFilterEntry();
      const descriptions = [
        offSearchProductsTool.description,
        inputDescription('nutrient_filters'),
        entry.nutrient?.description ?? '',
        entry.value?.description ?? '',
      ];

      for (const text of descriptions) {
        expect(text).toContain(basis);
        // Any spelling of the unit — "100g", "100 g", "100-g", "100 grams" — needs the ml clause.
        expect(text).not.toMatch(/(?<![_\d])100[ -]?g(?:rams?)?\b(?!, or per 100 ml for liquids)/i);
      }
    });
  });

  // ── exhausted pages vs zero matches (GH issue #24) ────────────────────────

  describe('exhausted pages', () => {
    // Characterization — the two neighbouring cases this fix must leave alone.

    it('keeps the broaden-and-check guidance when nothing matched at all', async () => {
      mockSearch({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

      await offSearchProductsTool.handler(
        { categories_tag: 'en:xyzzy', page: 1, page_size: 20 },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toContain('No products found');
      expect(notice).toContain('off_browse_taxonomy');
      expect(notice).toContain('Try broader terms');
    });

    it('treats a partially filled last page as final, neither exhausted nor truncated', async () => {
      mockSearch({
        count: 23,
        page: 5,
        page_count: 3,
        page_size: 5,
        products: [{ code: '1234567890001' }],
      });

      const result = await offSearchProductsTool.handler(
        { categories_tag: 'en:pizzas', page: 5, page_size: 5 },
        ctx,
      );

      expect(result.last_page).toBe(5);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toBeUndefined();
      expect(enrichment.truncated).toBeUndefined();
    });

    it('renders the zero-match formatter text unchanged', () => {
      const text = firstText(
        offSearchProductsTool.format!({
          total: 0,
          total_is_lower_bound: false,
          page: 1,
          page_size: 20,
          page_count: 0,
          source: 'off_api',
          products: [],
        }),
      );

      expect(text).toContain('**No products found**');
      expect(text).toContain('off_browse_taxonomy');
    });

    // The defect: a page past the end of a large result set reported as a zero-match search.

    it('describes an empty page past the end of a text result set as exhausted', async () => {
      // page 1900 at page_size 3 asks for result 5,700 — inside the 10,000-result window, so the
      // request is sent, answered HTTP 200 with an empty hit list, and must not read as no match.
      mockSearch({ count: 5519, page: 1900, page_count: 0, page_size: 3, products: [] });

      await offSearchProductsTool.handler({ query: 'hummus', page: 1900, page_size: 3 }, ctx);

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toMatch(/past the end/i);
      expect(notice).toContain('1900');
      expect(notice).toContain('5519');
      // ceil(5519 / 3) = 1840, under the 3,333-page window bound at this page_size.
      expect(notice).toContain('1840');
      expect(notice).not.toContain('No products found');
      expect(notice).not.toContain('Try broader terms');
      expect(notice).not.toContain('off_browse_taxonomy');
    });

    it('describes an empty page past the end of a tag result set as exhausted', async () => {
      mockSearch({ count: 163, page: 5, page_count: 0, page_size: 50, products: [] });

      await offSearchProductsTool.handler(
        { categories_tag: 'en:hummus', countries_tag: 'en:netherlands', page: 5, page_size: 50 },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toMatch(/past the end/i);
      expect(notice).toContain('163');
      expect(notice).toContain('4'); // ceil(163 / 50)
      expect(notice).not.toContain('Try broader terms');
    });

    it('never names a page the page_out_of_range pre-check would refuse', async () => {
      // A huge text total implies far more pages than the window serves. Page 500 at page_size 20
      // is the deepest request the pre-check lets through, so the page named must be that bound,
      // not the 6,633 the match total implies — naming the latter sends the caller into the
      // rejection the pre-check exists to prevent.
      mockSearch({ count: 132_650, page: 500, page_count: 0, page_size: 20, products: [] });

      await offSearchProductsTool.handler({ query: 'chocolate', page: 500, page_size: 20 }, ctx);

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toContain('500'); // floor(10000 / 20), not ceil(132650 / 20) = 6633
      expect(notice).not.toContain('6633');
    });

    it('states that a clipped total yields no exact last page', async () => {
      mockSearch({
        count: 10_000,
        count_is_exact: false,
        page: 400,
        page_count: 0,
        page_size: 25,
        products: [],
      });

      await offSearchProductsTool.handler({ query: 'chocolate', page: 400, page_size: 25 }, ctx);

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toMatch(/no exact last page/i);
      expect(notice).toContain('stopped counting');
    });

    it('returns the reachable last page as an output field on a counted search', async () => {
      mockSearch({
        count: 163,
        page: 1,
        page_count: 50,
        page_size: 50,
        products: [{ code: '1234567890001' }],
      });

      const result = await offSearchProductsTool.handler(
        { categories_tag: 'en:hummus', page: 1, page_size: 50 },
        ctx,
      );

      expect(result.last_page).toBe(4);
    });

    it('omits the last page when the total is a lower bound', async () => {
      mockSearch({
        count: 10_000,
        count_is_exact: false,
        page: 1,
        page_count: 20,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      const result = await offSearchProductsTool.handler(
        { query: 'chocolate', page: 1, page_size: 20 },
        ctx,
      );

      expect(result.last_page).toBeUndefined();
    });

    it('formats an exhausted page as exhausted, preserving the total', () => {
      const text = firstText(
        offSearchProductsTool.format!({
          total: 3,
          total_is_lower_bound: false,
          page: 2,
          page_size: 20,
          page_count: 0,
          last_page: 1,
          source: 'off_api',
          products: [],
        }),
      );

      expect(text).toMatch(/past the end/i);
      expect(text).toContain('3');
      expect(text).toContain('page 1');
      expect(text).not.toContain('No products found');
      expect(text).not.toContain('off_browse_taxonomy');
      expect(text).not.toMatch(/broaden/i);
    });

    it('formats an exhausted page with a clipped total using the lower-bound marker', () => {
      const text = firstText(
        offSearchProductsTool.format!({
          total: 10_000,
          total_is_lower_bound: true,
          page: 400,
          page_size: 20,
          page_count: 0,
          source: 'off_api',
          products: [],
        }),
      );

      expect(text).toContain('10000+');
      expect(text).toContain('At least 10000');
      expect(text).toMatch(/no exact last page/i);
    });

    it('carries the exhausted-page case on both client surfaces', async () => {
      mockSearch({ count: 163, page: 5, page_count: 0, page_size: 50, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page: 5,
        page_size: 50,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.total).toBe(163);
      expect(String(structured.notice ?? '')).toMatch(/past the end/i);

      const text = contractText(result);
      expect(text).toMatch(/past the end/i);
      expect(text).toContain('163');
      expect(text).not.toContain('No products found');
    });
  });

  // ── text-index freshness disclosure (GH issue #31) ────────────────────────

  describe('text-index freshness', () => {
    it('declares the snapshot property on a text search', async () => {
      mockSearch({
        count: 42,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      await offSearchProductsTool.handler({ query: 'hummus', page: 1, page_size: 20 }, ctx);

      const disclosure = String(getEnrichment(ctx).text_index_snapshot ?? '');
      expect(disclosure).toMatch(/snapshot/i);
      expect(disclosure).toMatch(/lags/i);
      // No hard-coded index date: the endpoint publishes no index timestamp, so a literal date
      // in a runtime string would be a claim nothing re-checks.
      expect(disclosure).not.toMatch(/20\d\d/);
    });

    it('declares nothing of the kind on a tag-only search', async () => {
      mockSearch({
        count: 42,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      await offSearchProductsTool.handler(
        { categories_tag: 'en:hummus', page: 1, page_size: 20 },
        ctx,
      );

      expect(getEnrichment(ctx).text_index_snapshot).toBeUndefined();
    });

    it('carries the disclosure on both client surfaces', async () => {
      mockSearch({
        count: 42,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001', product_name: 'Hummus' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'hummus',
        page: 1,
        page_size: 20,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(String(structured.text_index_snapshot ?? '')).toMatch(/snapshot/i);
      expect(contractText(result)).toMatch(/snapshot/i);
    });

    it('leaves a tag-only response free of the disclosure on both surfaces', async () => {
      mockSearch({
        count: 42,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001', product_name: 'Hummus' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page: 1,
        page_size: 20,
      });

      expect(
        (result.structuredContent as Record<string, unknown>).text_index_snapshot,
      ).toBeUndefined();
      expect(contractText(result)).not.toMatch(/snapshot/i);
    });

    it('does not claim nonexistence when a text search returns nothing', async () => {
      mockSearch({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

      await offSearchProductsTool.handler(
        { query: 'zwarte knoflook hummus', page: 1, page_size: 20 },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toMatch(/recently contributed/i);
      // Names what does reach a product the index has not caught up to.
      expect(notice).toMatch(/without query/i);
      expect(notice).toContain('off_get_product');
      expect(notice).not.toMatch(/no such product|does not exist|is not in the database/i);
    });

    it('keeps the recently-contributed caveat off a tag-only empty result', async () => {
      mockSearch({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

      await offSearchProductsTool.handler(
        { categories_tag: 'en:nonexistent-category', page: 1, page_size: 20 },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).not.toMatch(/recently contributed/i);
      expect(notice).toMatch(/off_browse_taxonomy/);
    });

    it('states the freshness split in the tool and query descriptions', () => {
      expect(offSearchProductsTool.description).toMatch(/snapshot/i);
      expect(inputDescription('query')).toMatch(/snapshot/i);
      expect(inputDescription('query')).toMatch(/lags/i);
    });

    it('does not overload total_is_lower_bound to signal staleness', async () => {
      // #18 gave the flag one meaning — the backend stopped counting at its ceiling. A fresh,
      // fully counted text search must leave it false even though the index lags.
      mockSearch({
        count: 42,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      const result = await offSearchProductsTool.handler(
        { query: 'hummus', page: 1, page_size: 20 },
        ctx,
      );

      expect(result.total_is_lower_bound).toBe(false);
    });
  });

  // ── ecoscore_grade in search results ──────────────────────────────────────

  it('surfaces ecoscore_grade in search result rows', async () => {
    mockSearch({
      count: 1,
      page: 1,
      page_count: 1,
      page_size: 20,
      products: [
        {
          code: '3017620422003',
          product_name: 'Nutella',
          brands: 'Ferrero',
          nutriscore_grade: 'e',
          nova_group: 4,
          ecoscore_grade: 'c',
          categories_tags: ['en:spreads'],
        },
      ],
    });

    const result = await offSearchProductsTool.handler(
      { query: 'nutella', page: 1, page_size: 20 },
      ctx,
    );

    expect(result.products[0]?.ecoscore_grade).toBe('c');
  });

  it('omits ecoscore_grade from rows when absent (no fabrication)', async () => {
    mockSearch({
      count: 1,
      page: 1,
      page_count: 1,
      page_size: 20,
      products: [
        {
          code: '1234567890001',
          product_name: 'Sparse Product',
        },
      ],
    });

    const result = await offSearchProductsTool.handler(
      { query: 'sparse', page: 1, page_size: 20 },
      ctx,
    );

    expect(result.products[0]?.ecoscore_grade).toBeUndefined();
  });

  it('formats ecoscore_grade in the scores line', () => {
    const output = {
      total: 1,
      total_is_lower_bound: false,
      page: 1,
      page_size: 20,
      page_count: 1,
      source: 'off_api' as const,
      products: [
        {
          barcode: '3017620422003',
          product_name: 'Nutella',
          brands: 'Ferrero',
          nutriscore_grade: 'e',
          nova_group: 4,
          ecoscore_grade: 'c',
          categories_tags: ['en:spreads'],
        },
      ],
    };
    const blocks = offSearchProductsTool.format!(output);
    const text = firstText(blocks);
    expect(text).toContain('Green-Score: c');
  });

  it('omits Green-Score line when ecoscore_grade is absent', () => {
    const output = {
      total: 1,
      total_is_lower_bound: false,
      page: 1,
      page_size: 20,
      page_count: 1,
      source: 'off_api' as const,
      products: [
        {
          barcode: '3017620422003',
          product_name: 'Nutella',
          nutriscore_grade: 'e',
          // no ecoscore_grade
        },
      ],
    };
    const blocks = offSearchProductsTool.format!(output);
    const text = firstText(blocks);
    expect(text).not.toContain('Green-Score');
  });

  // ── brands_tag matching semantics (GH issue #13) ──────────────────────────

  describe('brands_tag description', () => {
    it('describes the slug as exactly matched, with no fuzzy claim', () => {
      // Live-verified on both routing paths: brands_tags=nutella matches while brands_tags=nutell
      // returns zero. A description promising partial matches sends callers into guaranteed-empty
      // searches, so it must state exact matching and point open-ended wording at query.
      const description = inputDescription('brands_tag');

      expect(description).toMatch(/exactly/i);
      expect(description).toMatch(/\bquery\b/);
      expect(description).not.toMatch(/fuzzy/i);
      expect(description).not.toMatch(/partial matches may work/i);
    });
  });

  // ── allergen and additive filters (GH issue #10) ──────────────────────────

  describe('allergens_tag and additives_tag', () => {
    it('passes both filters to the service on a tag-only search', async () => {
      mockSearch({
        count: 5,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      await offSearchProductsTool.handler(
        { allergens_tag: 'en:milk', additives_tag: 'en:e322', page: 1, page_size: 20 },
        ctx,
      );

      expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
        allergens_tag: 'en:milk',
        additives_tag: 'en:e322',
      });
    });

    it('accepts allergens_tag on its own as a filter', async () => {
      mockSearch({ count: 1, page: 1, page_count: 1, page_size: 20, products: [] });

      await offSearchProductsTool.handler(
        { allergens_tag: 'en:gluten', page: 1, page_size: 20 },
        ctx,
      );

      expect(mockSearchProducts).toHaveBeenCalledOnce();
    });

    it('accepts additives_tag on its own as a filter', async () => {
      mockSearch({ count: 1, page: 1, page_count: 1, page_size: 20, products: [] });

      await offSearchProductsTool.handler(
        { additives_tag: 'en:e330', page: 1, page_size: 20 },
        ctx,
      );

      expect(mockSearchProducts).toHaveBeenCalledOnce();
    });

    it('combines allergens_tag with a text query', async () => {
      // allergens_tags is a real keyword field on the text backend, so this pairing filters.
      mockSearch({
        count: 12,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      await offSearchProductsTool.handler(
        { query: 'chocolate', allergens_tag: 'en:milk', page: 1, page_size: 20 },
        ctx,
      );

      expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
        query: 'chocolate',
        allergens_tag: 'en:milk',
      });
    });

    it('rejects additives_tag alongside a text query without contacting the service', async () => {
      // The text backend has no additives_tags field, so the clause matches nothing for every
      // E-number. Answering "zero products" would claim the additive is in no product at all.
      await expect(
        offSearchProductsTool.handler(
          { query: 'chocolate', additives_tag: 'en:e322', page: 1, page_size: 20 },
          ctx,
        ),
      ).rejects.toMatchObject({
        data: { reason: 'additives_filter_needs_tag_search', additives_tag: 'en:e322' },
      });

      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it('names both working combinations in the additives rejection hint', async () => {
      const result = await runToolContract(offSearchProductsTool, {
        query: 'chocolate',
        additives_tag: 'en:e322',
        page: 1,
        page_size: 20,
      });

      expect(result.isError).toBe(true);
      const hint = contractHint(result);
      expect(hint).toContain('Drop query');
      expect(hint).toContain('drop additives_tag');
    });

    it('echoes the allergen and additive filters in the empty-result notice', async () => {
      mockSearch({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

      await offSearchProductsTool.handler(
        { allergens_tag: 'en:milk', additives_tag: 'en:e322', page: 1, page_size: 20 },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toContain('allergen="en:milk"');
      expect(notice).toContain('additive="en:e322"');
    });

    it('lists the new filters in the no_filters recovery text', () => {
      // A caller who exhausted the listed filters is told what else exists; an outdated list
      // hides the two filters that might still narrow the search.
      const recovery =
        offSearchProductsTool.errors?.find((e) => e.reason === 'no_filters')?.recovery ?? '';

      expect(recovery).toContain('allergens_tag');
      expect(recovery).toContain('additives_tag');
    });
  });

  // ── clipped text-search total (GH issue #18) ──────────────────────────────

  describe('clipped result totals', () => {
    it('marks a total the backend stopped counting at as a lower bound', async () => {
      mockSearch({
        count: 10_000,
        count_is_exact: false,
        page: 1,
        page_count: 20,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      const result = await offSearchProductsTool.handler(
        { query: 'chocolate', page: 1, page_size: 20 },
        ctx,
      );

      expect(result.total).toBe(10_000);
      expect(result.total_is_lower_bound).toBe(true);
    });

    it('leaves a counted total unmarked', async () => {
      mockSearch({
        count: 3464,
        page: 1,
        page_count: 20,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      const result = await offSearchProductsTool.handler(
        { query: 'kombucha', page: 1, page_size: 20 },
        ctx,
      );

      expect(result.total_is_lower_bound).toBe(false);
    });

    it('does not state a page count derived from a clipped total', async () => {
      // 10,000 / 20 gives 500 pages, but the count it divides is the ceiling the backend stopped
      // at — so "Page 1 of 500." presents a bound as a measurement. Only the reachable page count
      // is knowable, and the guidance has to say why the rest is not.
      mockSearch({
        count: 10_000,
        count_is_exact: false,
        page: 1,
        page_count: 20,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      await offSearchProductsTool.handler({ query: 'chocolate', page: 1, page_size: 20 }, ctx);

      const guidance = String(getEnrichment(ctx).notice ?? '');
      expect(guidance).toContain('stopped counting');
      expect(guidance).toContain('500 reachable pages');
      expect(guidance).not.toContain('Page 1 of 500.');
    });

    it('still names the exact page total when the count is exact', async () => {
      mockSearch({
        count: 200,
        page: 1,
        page_count: 20,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      await offSearchProductsTool.handler({ query: 'kombucha', page: 1, page_size: 20 }, ctx);

      const guidance = String(getEnrichment(ctx).notice ?? '');
      expect(guidance).toContain('Page 1 of 10.');
      expect(guidance).not.toContain('stopped counting');
    });

    it('renders a clipped total with a plus marker and a caveat', () => {
      const output = {
        total: 10_000,
        total_is_lower_bound: true,
        page: 1,
        page_size: 20,
        page_count: 1,
        source: 'off_api' as const,
        products: [{ barcode: '1234567890001' }],
      };

      const text = firstText(offSearchProductsTool.format!(output));

      expect(text).toContain('**10000+ total products**');
      expect(text).toContain('At least 10000 products match');
    });

    it('renders an exact total without the plus marker', () => {
      const output = {
        total: 42,
        total_is_lower_bound: false,
        page: 1,
        page_size: 20,
        page_count: 1,
        source: 'off_api' as const,
        products: [{ barcode: '1234567890001' }],
      };

      const text = firstText(offSearchProductsTool.format!(output));

      expect(text).toContain('**42 total products**');
      expect(text).not.toContain('+ total products');
      expect(text).not.toContain('At least');
    });

    it('renders every category tag per row, not the first 3', () => {
      // #9 regression: format() sliced categories_tags to 3 while structuredContent carried the
      // full array, so text-only clients saw a silently short list with no way to complete it.
      const categories_tags = [
        'en:frozen-foods',
        'en:meals',
        'en:pizzas-pies-and-quiches',
        'en:pizzas',
        'en:frozen-pizzas',
        'en:cheese-pizzas',
        'en:margherita-pizzas',
      ];
      const output = {
        total: 1,
        total_is_lower_bound: false,
        page: 1,
        page_size: 20,
        page_count: 1,
        source: 'off_api' as const,
        products: [{ barcode: '1234567890001', product_name: 'Frozen Pizza', categories_tags }],
      };

      const text = firstText(offSearchProductsTool.format!(output));

      for (const tag of categories_tags) expect(text).toContain(tag);
    });

    // ── #27: crowd-sourced row values render as data, not as structure ──────

    it('renders a product_name carrying a fence and a heading as one heading line', () => {
      const product_name = '```\n# INJECTED';
      const output = {
        total: 1,
        total_is_lower_bound: false,
        page: 1,
        page_size: 20,
        page_count: 1,
        source: 'off_api' as const,
        products: [{ barcode: '1234567890001', product_name }],
      };

      const text = firstText(offSearchProductsTool.format!(output));

      expect(text.split('\n').filter((line) => line.startsWith('#'))).toHaveLength(1);
      expect(output.products[0]?.product_name).toBe(product_name);
    });

    it('escapes the row values that come from the upstream record', () => {
      // The barcode on this surface is the upstream record's `code`, not caller input.
      const output = {
        total: 1,
        total_is_lower_bound: false,
        page: 1,
        page_size: 20,
        page_count: 1,
        source: 'off_api' as const,
        products: [
          {
            barcode: '1234\n# not a heading',
            product_name: 'Row',
            brands: '*bold*',
            nutriscore_grade: 'a_b',
            categories_tags: ['en:x`y`'],
          },
        ],
      };

      const text = firstText(offSearchProductsTool.format!(output));

      expect(text).toContain('\\*bold\\*');
      expect(text).toContain('a_b');
      expect(text).toContain('en:x\\`y\\`');
      expect(text.split('\n').filter((line) => line.startsWith('#'))).toHaveLength(1);
      expect(output.products[0]?.brands).toBe('*bold*');
    });

    it('adds no backslashes to ordinary rows', () => {
      const text = firstText(
        offSearchProductsTool.format!({
          total: 1,
          total_is_lower_bound: false,
          page: 1,
          page_size: 20,
          page_count: 1,
          source: 'off_api',
          products: [
            {
              barcode: '3017620422003',
              product_name: 'Nutella',
              brands: 'Ferrero',
              nutriscore_grade: 'e',
              categories_tags: ['en:organic'],
            },
          ],
        }),
      );

      expect(text).not.toContain('\\');
    });
  });

  // ── #38 / #47: what a text query matches ──────────────────────────────────

  describe('query matching (#38, #47)', () => {
    it('says every word must match, names the searched fields, and drops the ingredients claim', () => {
      const query = inputDescription('query');

      expect(query).toMatch(/every word/i);
      for (const field of ['name', 'generic name', 'categor', 'label', 'brand']) {
        expect(query.toLowerCase()).toContain(field);
      }
      expect(query).toMatch(/ingredients and quantity are not searched/i);
      expect(query).not.toMatch(/across product names, brands, and ingredients/i);
      expect(offSearchProductsTool.description).toMatch(/every word/i);
      expect(offSearchProductsTool.description).not.toMatch(/results match the query text/i);
    });

    it('says names are matched across languages', () => {
      expect(inputDescription('query')).toMatch(/31 languages/);
      expect(inputDescription('query')).toMatch(/French/);
    });

    /** A query of `n` distinct words. */
    const wordsOf = (n: number): string =>
      Array.from({ length: n }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${i}`).join(
        ' ',
      );

    it('rejects a query past the word bound before any request, on both surfaces', async () => {
      const result = await runToolContract(offSearchProductsTool, {
        query: wordsOf(25),
        page: 1,
        page_size: 20,
      });

      expect(result.isError).toBe(true);
      const text = contractText(result);
      expect(text).toContain('25');
      expect(text).toMatch(/at most 24/i);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'query_too_long', word_count: 25, max_words: 24 } },
      });
      expect(mockSearchProducts).not.toHaveBeenCalled();
      expect(mockSuggestTaxonomy).not.toHaveBeenCalled();

      const error = (await captureError(
        offSearchProductsTool.handler({ query: wordsOf(25), page: 1, page_size: 20 }, ctx),
      )) as { data?: { reason?: string; word_count?: number; max_words?: number } };
      expect(error.data).toMatchObject({ reason: 'query_too_long', word_count: 25, max_words: 24 });
    });

    it('sends a query at the word bound', async () => {
      mockSearch({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

      await offSearchProductsTool.handler({ query: wordsOf(24), page: 1, page_size: 20 }, ctx);

      expect(mockSearchProducts).toHaveBeenCalledOnce();
    });

    it('counts each part of a hyphenated word toward the bound', async () => {
      const hyphenated = Array.from({ length: 13 }, (_, i) => `dark-choc${i}`).join(' ');

      await expect(
        offSearchProductsTool.handler({ query: hyphenated, page: 1, page_size: 20 }, ctx),
      ).rejects.toMatchObject({ data: { reason: 'query_too_long', word_count: 26 } });
    });

    it('declares the word-bound rejection in the error contract with a recovery', () => {
      const entry = offSearchProductsTool.errors?.find((e) => e.reason === 'query_too_long');

      expect(entry?.recovery).toMatch(/24/);
      // Every word is required, so a 24-word query that survives the bound almost always matches
      // nothing — the recovery points at a few distinctive words, not at the bound.
      expect(entry?.recovery).toMatch(/every one must match/);
      expect(entry?.retryable).toBe(false);
    });
  });

  // ── #39: tag values on the text path are canonicalized ────────────────────

  describe('tag canonicalization (#39)', () => {
    const oneRow = { count: 1, page: 1, page_count: 1, page_size: 20 };

    it('hands the text search the canonical value the vocabulary resolves', async () => {
      mockSuggestTaxonomy.mockImplementation(async (taxonomy: string, term: string) =>
        taxonomy === 'country' && term === 'US'
          ? [
              { id: 'en:united-states', name: 'US' },
              { id: 'en:soviet-union', name: 'USSR' },
            ]
          : [],
      );
      mockSearch({ ...oneRow, products: [{ code: '1234567890001' }] });

      await offSearchProductsTool.handler(
        {
          query: 'oat milk',
          countries_tag: 'US',
          brands_tag: ' Oatly ',
          nutrition_grade: 'a',
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
        query: 'oat milk',
        countries_tag: 'en:united-states',
        brands_tag: 'oatly',
        nutrition_grade: 'a',
      });
    });

    it('canonicalizes a nutrient-only search the same way', async () => {
      mockSuggestTaxonomy.mockResolvedValue([{ id: 'en:united-states', name: 'US' }]);
      mockSearch({ ...oneRow, products: [{ code: '1234567890001' }] });

      await offSearchProductsTool.handler(
        {
          countries_tag: 'US',
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lte', value: 5 }],
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
        countries_tag: 'en:united-states',
      });
    });

    it('sends the value normalized when the lookup fails, and never fails the search', async () => {
      mockSuggestTaxonomy.mockRejectedValue(
        new Error('Open Food Facts is unavailable (HTTP 503).'),
      );
      mockSearch({ ...oneRow, products: [{ code: '1234567890001' }] });

      const result = await offSearchProductsTool.handler(
        { query: 'peanut butter', allergens_tag: 'Peanut', page: 1, page_size: 20 },
        ctx,
      );

      expect(result.products).toHaveLength(1);
      expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({ allergens_tag: 'en:peanut' });
    });

    it('passes tag-only values through untouched and makes no lookup', async () => {
      // Characterization: Product Opener canonicalizes tag parameters on this path itself.
      mockSearch({ ...oneRow, products: [{ code: '1234567890001' }] });

      await offSearchProductsTool.handler(
        { brands_tag: 'Nutella', countries_tag: 'US', page: 1, page_size: 20 },
        ctx,
      );

      expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
        brands_tag: 'Nutella',
        countries_tag: 'US',
      });
      expect(mockSuggestTaxonomy).not.toHaveBeenCalled();
    });
  });

  // ── #39: the empty and freshness notices name the real causes ─────────────

  describe('text-path notices (#39)', () => {
    const empty = { count: 0, page: 1, page_count: 0, page_size: 20, products: [] };
    const found = {
      count: 1,
      page: 1,
      page_count: 1,
      page_size: 20,
      products: [{ code: '1234567890001' }],
    };

    it('names exact tag matching and the unconfirmed value on a zero with tag filters', async () => {
      mockSearch(empty);

      await offSearchProductsTool.handler(
        { query: 'hazelnut', brands_tag: 'Nutell', page: 1, page_size: 20 },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toContain('No products found');
      expect(notice).toMatch(/every word of query must match/i);
      expect(notice).toMatch(/matched exactly/i);
      expect(notice).toContain('brand="Nutell" was sent as "nutell"');
      expect(notice).toContain('off_browse_taxonomy');
      expect(notice).toMatch(/same tag filters without query/i);
      expect(notice).toMatch(/recently contributed/i);
    });

    it('names a taxonomy value no tag confirmed, and one the vocabulary could not check', async () => {
      mockSuggestTaxonomy.mockImplementation(async (taxonomy: string) => {
        if (taxonomy === 'country') return [];
        throw new Error('budget spent');
      });
      mockSearch(empty);

      await offSearchProductsTool.handler(
        {
          query: 'chocolate',
          countries_tag: 'Never Land',
          allergens_tag: 'Peanut',
          labels_tag: 'en:organic',
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toContain('country="Never Land" was sent as "en:never-land"');
      expect(notice).toMatch(/no matching .*tag/i);
      expect(notice).toContain('allergen="Peanut" was sent as "en:peanut"');
      expect(notice).toContain(
        'allergen="Peanut" was sent as "en:peanut" (the tag vocabulary could not be reached or gave no usable answer, so it went unchecked)',
      );
      // A value the vocabulary confirmed is not blamed.
      expect(notice).not.toContain('label="en:organic" was sent');
    });

    it('gives no drop-query advice and no every-word cause on a nutrient-only zero', async () => {
      mockSearch(empty);

      await offSearchProductsTool.handler(
        {
          countries_tag: 'en:united-states',
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lte', value: 5 }],
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).not.toMatch(/without query/i);
      expect(notice).not.toMatch(/drop query/i);
      expect(notice).not.toMatch(/every word/i);
      expect(notice).toMatch(/matched exactly/i);
      expect(notice).toMatch(/nutrient_filters are served only by/i);
      expect(notice).toContain('off_get_product');
    });

    it('names the every-word cause and no tag cause on a query-only zero', async () => {
      mockSearch(empty);

      await offSearchProductsTool.handler({ query: 'xyzzyqq milk', page: 1, page_size: 20 }, ctx);

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toMatch(/every word of query must match/i);
      expect(notice).not.toMatch(/matched exactly/i);
      expect(notice).toMatch(/tag filters/i);
    });

    it('names a field:value-shaped word as the likely cause of a zero, on both surfaces', async () => {
      // `brands: nutella` is matched as the words `brands` and `nutella`, and no product carries
      // the word `brands`; the caller needs to hear that the field syntax is what emptied it.
      mockSearch(empty);

      const result = await runToolContract(offSearchProductsTool, {
        query: 'Brands: nutella',
        page: 1,
        page_size: 20,
      });

      const notice = String((result.structuredContent as Record<string, unknown>).notice ?? '');
      expect(notice).toContain('"Brands" had to match as a word');
      expect(notice).toContain('brands_tag');
      expect(contractText(result)).toContain('"Brands" had to match as a word');
    });

    it('names the first field:value-shaped word of several', async () => {
      mockSearch(empty);

      await offSearchProductsTool.handler(
        { query: 'nutriscore_grade:a labels:organic', page: 1, page_size: 20 },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toContain('"nutriscore_grade" had to match as a word');
      expect(notice).not.toContain('"labels" had to match');
    });

    it('adds no field-syntax cause to a zero without a field:value-shaped word', async () => {
      mockSearch(empty);

      await offSearchProductsTool.handler(
        { query: 'xyzzyqq 12:30 milk', page: 1, page_size: 20 },
        ctx,
      );

      expect(String(getEnrichment(ctx).notice ?? '')).not.toMatch(/had to match as a word/);
    });

    it('keeps the tag-only zero notice as it was', async () => {
      // Characterization: the tag path answers from the live database with canonicalized values.
      mockSearch(empty);

      await offSearchProductsTool.handler({ brands_tag: 'nutell', page: 1, page_size: 20 }, ctx);

      expect(String(getEnrichment(ctx).notice ?? '')).toBe(
        'No products found for brand="nutell". Try broader terms, check tag IDs via off_browse_taxonomy, or remove some filters.',
      );
    });

    it('does not tell a nutrient-only search that dropping query reads the live database', async () => {
      mockSearch(found);

      await offSearchProductsTool.handler(
        {
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lte', value: 5 }],
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      const note = String(getEnrichment(ctx).text_index_snapshot ?? '');
      expect(note).toMatch(/snapshot/i);
      expect(note).not.toMatch(/without query/i);
      expect(note).toMatch(/nutrient/i);
    });

    it('points a query-and-tags search at the same tag filters without query', async () => {
      mockSearch(found);

      await offSearchProductsTool.handler(
        { query: 'hummus', categories_tag: 'en:hummus', page: 1, page_size: 20 },
        ctx,
      );

      const note = String(getEnrichment(ctx).text_index_snapshot ?? '');
      expect(note).toMatch(/same tag filters without query/i);
      // A deployment with a ready mirror answers that re-run from its local copy, not live.
      expect(note).toContain("this server's local copy of the export");
    });

    it('carries the text-path zero notice on both client surfaces', async () => {
      mockSearch(empty);

      const result = await runToolContract(offSearchProductsTool, {
        query: 'hazelnut',
        brands_tag: 'Nutell',
        page: 1,
        page_size: 20,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.total).toBe(0);
      expect(String(structured.notice ?? '')).toContain('brand="Nutell" was sent as "nutell"');
      const text = contractText(result);
      expect(text).toContain('No products found');
      expect(text).toContain('brand="Nutell" was sent as "nutell"');
      expect(text).toMatch(/every word of query must match/i);
    });
  });

  // ── #41: exclusion, trace, verdict, and multi-label filters ────────────────

  describe('exclusion, trace, verdict, and multi-label filters (#41)', () => {
    const oneRow = {
      count: 1,
      page: 1,
      page_count: 1,
      page_size: 20,
      products: [{ code: '1234567890001' }],
    };
    const empty = { count: 0, page: 1, page_count: 0, page_size: 20, products: [] };

    /** The 12 verdicts of the Open Food Facts `ingredients_analysis` taxonomy. */
    const VERDICTS = [
      'en:palm-oil',
      'en:palm-oil-free',
      'en:may-contain-palm-oil',
      'en:palm-oil-content-unknown',
      'en:vegan',
      'en:maybe-vegan',
      'en:non-vegan',
      'en:vegan-status-unknown',
      'en:vegetarian',
      'en:maybe-vegetarian',
      'en:non-vegetarian',
      'en:vegetarian-status-unknown',
    ];

    it.each([
      ['exclude_allergens', { exclude_allergens: ['en:nuts'] }],
      ['exclude_traces', { exclude_traces: ['en:nuts'] }],
      ['traces_tag', { traces_tag: 'en:nuts' }],
      ['ingredients_analysis_tag', { ingredients_analysis_tag: 'en:vegan' }],
      ['labels_tag array', { labels_tag: ['en:organic', 'en:fair-trade'] }],
    ])('counts %s alone as a filter', async (_name, filter) => {
      mockSearch(oneRow);

      await offSearchProductsTool.handler({ ...filter, page: 1, page_size: 20 } as never, ctx);

      expect(mockSearchProducts).toHaveBeenCalledOnce();
    });

    it('still refuses the new inputs when they carry only blanks', async () => {
      await expect(
        offSearchProductsTool.handler(
          {
            labels_tag: [' ', ''],
            traces_tag: ' ',
            exclude_allergens: [''],
            exclude_traces: [],
            page: 1,
            page_size: 20,
          },
          ctx,
        ),
      ).rejects.toMatchObject({ data: { reason: 'no_filters' } });
      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it('lists every new input in the no_filters recovery', () => {
      const recovery =
        offSearchProductsTool.errors?.find((e) => e.reason === 'no_filters')?.recovery ?? '';

      for (const field of [
        'traces_tag',
        'ingredients_analysis_tag',
        'exclude_allergens',
        'exclude_traces',
      ]) {
        expect(recovery).toContain(field);
      }
    });

    it('hands the service the canonical exclusions and each label as given', async () => {
      mockSearch(oneRow);

      await offSearchProductsTool.handler(
        {
          allergens_tag: 'en:nuts',
          exclude_allergens: ['Milk', ' en:gluten '],
          exclude_traces: ['en:soybeans'],
          labels_tag: ['en:organic', ' en:fair-trade '],
          traces_tag: 'en:nuts',
          ingredients_analysis_tag: 'en:vegan',
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      expect(mockSearchProducts.mock.calls[0]?.[0]).toEqual({
        page: 1,
        page_size: 20,
        allergens_tag: 'en:nuts',
        labels_tag: ['en:organic', 'en:fair-trade'],
        traces_tag: 'en:nuts',
        ingredients_analysis_tag: 'en:vegan',
        exclude_allergens: ['en:milk', 'en:gluten'],
        exclude_traces: ['en:soybeans'],
      });
    });

    it('keeps a single-string labels_tag a string for the service', async () => {
      // Characterization: the pre-#41 call shape.
      mockSearch(oneRow);

      await offSearchProductsTool.handler(
        { labels_tag: 'en:organic', page: 1, page_size: 20 },
        ctx,
      );

      expect(mockSearchProducts.mock.calls[0]?.[0]).toEqual({
        page: 1,
        page_size: 20,
        labels_tag: 'en:organic',
      });
    });

    it('refuses an unconfirmed exclusion without searching, on both surfaces', async () => {
      const result = await runToolContract(offSearchProductsTool, {
        exclude_allergens: ['en:nutz'],
        page: 1,
        page_size: 20,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'unrecognized_exclusion',
            retryable: false,
            unrecognized: [{ field: 'exclude_allergens', value: 'en:nutz' }],
          },
        },
      });
      const text = contractText(result);
      expect(text).toContain('en:nutz');
      expect(text).toContain('off_browse_taxonomy');
      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it('declares the exclusion refusal with a recovery naming off_browse_taxonomy', () => {
      const entry = offSearchProductsTool.errors?.find(
        (e) => e.reason === 'unrecognized_exclusion',
      );

      expect(entry?.recovery).toContain('off_browse_taxonomy');
      expect(entry?.retryable).toBe(false);
    });

    it('discloses on both surfaces that products with no data entered pass an exclusion', async () => {
      mockSearch(oneRow);

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:chocolates',
        exclude_allergens: ['en:nuts'],
        exclude_traces: ['en:nuts'],
        page: 1,
        page_size: 20,
      });

      const note = String(
        (result.structuredContent as Record<string, unknown>).exclusion_coverage ?? '',
      );
      expect(note).toMatch(/no allergen or trace data/i);
      expect(note).toContain('off_get_product');
      expect(contractText(result)).toContain(note);
    });

    it('names only the excluded kind of data in the disclosure', async () => {
      mockSearch(oneRow);

      await offSearchProductsTool.handler(
        { exclude_traces: ['en:nuts'], page: 1, page_size: 20 },
        ctx,
      );

      const note = String(getEnrichment(ctx).exclusion_coverage ?? '');
      expect(note).toMatch(/no trace data/i);
      expect(note).not.toMatch(/allergen or trace/i);
    });

    it('discloses the exclusion caveat on an empty result too', async () => {
      mockSearch(empty);

      const result = await runToolContract(offSearchProductsTool, {
        query: 'chocolate',
        exclude_allergens: ['en:milk'],
        page: 1,
        page_size: 20,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(String(structured.exclusion_coverage ?? '')).toMatch(/no allergen data/i);
      expect(contractText(result)).toMatch(/no allergen data/i);
    });

    it('adds no disclosure to a search carrying no exclusion', async () => {
      mockSearch(oneRow);

      const result = await runToolContract(offSearchProductsTool, {
        allergens_tag: 'en:nuts',
        traces_tag: 'en:nuts',
        page: 1,
        page_size: 20,
      });

      expect((result.structuredContent as Record<string, unknown>).exclusion_coverage).toBe(
        undefined,
      );
      expect(contractText(result)).not.toMatch(/no allergen/i);
    });

    it('echoes every new input in the empty-result notice', async () => {
      mockSearch(empty);

      await offSearchProductsTool.handler(
        {
          labels_tag: ['en:organic', 'en:fair-trade'],
          traces_tag: 'en:nuts',
          ingredients_analysis_tag: 'en:vegan',
          exclude_allergens: ['en:milk'],
          exclude_traces: ['en:peanuts'],
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      expect(String(getEnrichment(ctx).notice ?? '')).toBe(
        'No products found for label="en:organic", label="en:fair-trade", trace="en:nuts", ' +
          'ingredients_analysis="en:vegan", excluded_allergen="en:milk", excluded_trace="en:peanuts". ' +
          'Try broader terms, check tag IDs via off_browse_taxonomy, or remove some filters.',
      );
    });

    it('echoes only the filter values that were sent, trimmed', async () => {
      // A blank value is never sent — tagValues drops it and a blank query routes nowhere — so
      // echoing it tells the caller a filter was applied that was not.
      mockSearch(empty);

      await offSearchProductsTool.handler(
        {
          query: '   ',
          categories_tag: ' en:cheeses ',
          brands_tag: '  ',
          allergens_tag: ' en:milk',
          traces_tag: '',
          additives_tag: ' ',
          countries_tag: 'en:france ',
          labels_tag: ['en:organic ', '  '],
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      const sent = mockSearchProducts.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sent).toMatchObject({
        categories_tag: 'en:cheeses',
        allergens_tag: 'en:milk',
        countries_tag: 'en:france',
        labels_tag: ['en:organic'],
      });
      expect(sent).not.toHaveProperty('query');
      expect(sent).not.toHaveProperty('brands_tag');
      expect(sent).not.toHaveProperty('additives_tag');
      expect(String(getEnrichment(ctx).notice ?? '')).toBe(
        'No products found for category="en:cheeses", label="en:organic", allergen="en:milk", ' +
          'country="en:france". Try broader terms, check tag IDs via off_browse_taxonomy, or remove some filters.',
      );
    });

    it('echoes a padded query trimmed, on both surfaces', async () => {
      mockSearch(empty);

      const result = await runToolContract(offSearchProductsTool, {
        query: '  xyzzyqq milk ',
        additives_tag: '',
        page: 1,
        page_size: 20,
      });

      expect(String((result.structuredContent as Record<string, unknown>).notice ?? '')).toMatch(
        /^No products found for query="xyzzyqq milk"\. /,
      );
      expect(contractText(result)).toContain('No products found for query="xyzzyqq milk".');
    });

    it('names an unconfirmed label value in a text-path zero notice', async () => {
      mockSearch(empty);

      await offSearchProductsTool.handler(
        {
          query: 'chocolate',
          labels_tag: ['en:organic', 'Fairtrade Plus'],
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toContain('label="en:organic", label="Fairtrade Plus"');
      expect(notice).toContain('label="Fairtrade Plus" was sent as "en:fairtrade-plus"');
      expect(notice).not.toContain('label="en:organic" was sent');
    });

    it('offers exactly the 12 ingredient-analysis verdicts', () => {
      for (const verdict of VERDICTS) {
        expect(
          offSearchProductsTool.input.safeParse({ ingredients_analysis_tag: verdict }).success,
        ).toBe(true);
      }
      for (const other of ['vegan', 'en:Vegan', 'en:gluten-free', '']) {
        expect(
          offSearchProductsTool.input.safeParse({ ingredients_analysis_tag: other }).success,
        ).toBe(false);
      }
      const { shape } = offSearchProductsTool.input as unknown as {
        shape: Record<string, { unwrap: () => { options: string[] } }>;
      };
      expect(shape.ingredients_analysis_tag?.unwrap().options).toEqual(VERDICTS);
    });

    it('takes labels_tag as a string or an array', () => {
      for (const labels_tag of ['en:organic', ['en:organic', 'en:fair-trade']]) {
        expect(offSearchProductsTool.input.safeParse({ labels_tag }).success).toBe(true);
      }
    });

    it('points allergen-free intent at the exclusions from allergens_tag', () => {
      expect(inputDescription('allergens_tag')).toContain('exclude_allergens');
      expect(inputDescription('exclude_allergens')).toContain('off_get_product');
      expect(inputDescription('exclude_traces')).toContain('off_get_product');
    });
  });

  // ── #77: a lookup that went unchecked names why, and the wait ────────────

  describe('unchecked lookups (#77)', () => {
    const globalFetch = global.fetch;
    const PREFIX =
      'Exclusions are sent only as allergen tags Open Food Facts confirms, because an unrecognized one excludes nothing: ';

    /**
     * Serves the tool from a real Open Food Facts client with the given taxonomy budget, so the
     * limiter and the retry classification on the lookup path run — the module-wide stub bypasses
     * both. The autocomplete confirms every term it is asked for unless `autocomplete` answers it;
     * a search answers empty.
     */
    function useRealService(rateLimitTaxonomy: number, autocomplete?: () => Response): void {
      vi.mocked(getOpenFoodFactsService).mockReturnValue(
        new OpenFoodFactsService({
          baseUrl: 'https://world.openfoodfacts.org',
          rateLimitProduct: 100,
          rateLimitSearch: 100,
          rateLimitTaxonomy,
        }),
      );
      // The taxonomy service holds the client it was built with, so it is rebuilt over this one.
      initTaxonomyService();
      global.fetch = vi.fn(async (input: unknown) => {
        const url = new URL(String(input));
        if (url.pathname === '/autocomplete') {
          if (autocomplete) return autocomplete();
          const q = url.searchParams.get('q') ?? '';
          return Response.json({
            took: 1,
            timed_out: false,
            options: [{ id: `en:${q}`, text: q }],
          });
        }
        return Response.json(
          url.hostname === 'search.openfoodfacts.org' ? TEXT_SEARCH_EMPTY : TAG_SEARCH_EMPTY,
        );
      }) as typeof fetch;
    }

    /** The pathname of every request the stubbed fetch received, in order. */
    function requestedPaths(): string[] {
      return vi.mocked(global.fetch).mock.calls.map(([input]) => new URL(String(input)).pathname);
    }

    /** Runs a tool call to settlement with the retry backoff collapsed onto fake timers. */
    async function onFakeTimers<T>(run: () => Promise<T>): Promise<T> {
      vi.useFakeTimers();
      try {
        const pending = run();
        await vi.runAllTimersAsync();
        return await pending;
      } finally {
        vi.useRealTimers();
      }
    }

    afterEach(() => {
      global.fetch = globalFetch;
      vi.useRealTimers();
    });

    it('names the spent taxonomy budget and its wait for the exclusion it refused', async () => {
      useRealService(10);
      // Frozen, so the budget's wait is its whole 60 s window.
      vi.useFakeTimers({ toFake: ['Date'] });
      const values = Array.from({ length: 11 }, (_, i) => `en:fruit${String.fromCharCode(97 + i)}`);

      const result = await runToolContract(offSearchProductsTool, {
        exclude_allergens: values,
        page: 1,
        page_size: 20,
      });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { message: string; data: Record<string, unknown> };
      };
      expect(error.data).toMatchObject({
        reason: 'unrecognized_exclusion',
        retryable: true,
        // #76: the longest wait among the unchecked values.
        retryAfter: 60,
        unrecognized: [
          {
            field: 'exclude_allergens',
            value: 'en:fruitk',
            reason: 'lookup_failed',
            cause: 'budget_spent',
          },
        ],
      });
      expect(error.message).toBe(
        `${PREFIX}exclude_allergens "en:fruitk" could not be checked, because this server's own per-minute taxonomy budget is spent, so no lookup was sent; a slot frees in about 60 s.`,
      );
      expect(contractHint(result)).toBe(
        'Retry after 60 s — this server\'s own per-minute taxonomy budget is spent and no lookup was sent, so the value went unconfirmed. The canonical IDs of the 14 major allergens, such as "en:nuts" or "en:milk", are confirmed without a lookup.',
      );
      expect(JSON.stringify(result)).not.toContain('could not be reached');
      // Ten values were checked; the eleventh was refused before anything was sent.
      expect(requestedPaths()).toEqual(Array(10).fill('/autocomplete'));
    });

    it('names the upstream rate limit for an exclusion whose lookup Open Food Facts refused with 429', async () => {
      useRealService(100, () => Response.json({ detail: 'slow down' }, { status: 429 }));

      const result = await onFakeTimers(() =>
        runToolContract(offSearchProductsTool, {
          exclude_allergens: ['en:kiwi'],
          page: 1,
          page_size: 20,
        }),
      );

      const { error } = result.structuredContent as {
        error: { message: string; data: Record<string, unknown> };
      };
      expect(error.data).toMatchObject({
        reason: 'unrecognized_exclusion',
        retryable: true,
        unrecognized: [
          {
            field: 'exclude_allergens',
            value: 'en:kiwi',
            reason: 'lookup_failed',
            cause: 'rate_limited',
          },
        ],
      });
      expect(error.message).toBe(
        `${PREFIX}exclude_allergens "en:kiwi" could not be checked, because Open Food Facts is rate-limiting this server's taxonomy lookups (HTTP 429).`,
      );
      expect(contractHint(result)).toBe(
        'Retry in about a minute — Open Food Facts is rate-limiting this server\'s taxonomy lookups, so the value went unconfirmed. The canonical IDs of the 14 major allergens, such as "en:nuts" or "en:milk", are confirmed without a lookup.',
      );
      expect(JSON.stringify(result)).not.toContain('could not be reached');
    });

    it("carries Open Food Facts' Retry-After as data.retryAfter and names it (#76)", async () => {
      useRealService(100, () =>
        Response.json({ detail: 'slow down' }, { status: 429, headers: { 'retry-after': '60' } }),
      );

      const result = await runToolContract(offSearchProductsTool, {
        exclude_allergens: ['en:kiwi'],
        page: 1,
        page_size: 20,
      });

      const { error } = result.structuredContent as {
        error: { message: string; data: Record<string, unknown> };
      };
      expect(error.data).toMatchObject({
        reason: 'unrecognized_exclusion',
        retryable: true,
        retryAfter: 60,
      });
      expect(error.message).toBe(
        `${PREFIX}exclude_allergens "en:kiwi" could not be checked, because Open Food Facts is rate-limiting this server's taxonomy lookups (HTTP 429) and asked for a wait of 60 s.`,
      );
      expect(contractHint(result)).toMatch(/^Retry after 60 s — /);
      // A wait past withRetry's 30 s ceiling fails fast: one request.
      expect(requestedPaths()).toEqual(['/autocomplete']);
    });

    it('carries retryAfter only on a refusal a retry can clear', async () => {
      // The first lookup is answered with no match and spends the one-slot budget; the second is
      // refused by it. A no_match makes the refusal non-retryable, so no wait is offered.
      useRealService(1, () => Response.json({ took: 1, timed_out: false, options: [] }));
      vi.useFakeTimers({ toFake: ['Date'] });

      const mixed = await runToolContract(offSearchProductsTool, {
        exclude_allergens: ['en:nutz', 'en:fruitk'],
        page: 1,
        page_size: 20,
      });

      const { error } = mixed.structuredContent as { error: { data: Record<string, unknown> } };
      expect(error.data).toMatchObject({ reason: 'unrecognized_exclusion', retryable: false });
      expect(error.data.unrecognized).toEqual([
        { field: 'exclude_allergens', value: 'en:nutz', reason: 'no_match' },
        {
          field: 'exclude_allergens',
          value: 'en:fruitk',
          reason: 'lookup_failed',
          cause: 'budget_spent',
        },
      ]);
      expect(error.data).not.toHaveProperty('retryAfter');

      // The budget-refused value alone, against the same spent budget, can clear on a retry and
      // carries the wait, so the no_match beside it is what withheld the wait above.
      const alone = await runToolContract(offSearchProductsTool, {
        exclude_allergens: ['en:fruitk'],
        page: 1,
        page_size: 20,
      });

      const aloneData = (alone.structuredContent as { error: { data: Record<string, unknown> } })
        .error.data;
      expect(aloneData).toMatchObject({ retryable: true, retryAfter: 60 });
    });

    it('keeps the unreachable-vocabulary message and hint for an outage', async () => {
      // Characterization: the wording an unavailable vocabulary has always had.
      useRealService(100, () => new Response('unavailable', { status: 503 }));

      const result = await onFakeTimers(() =>
        runToolContract(offSearchProductsTool, {
          exclude_allergens: ['en:kiwi', 'en:fruita'],
          page: 1,
          page_size: 20,
        }),
      );

      const { error } = result.structuredContent as {
        error: { message: string; data: Record<string, unknown> };
      };
      expect(error.data).toMatchObject({ reason: 'unrecognized_exclusion', retryable: true });
      expect(error.message).toBe(
        `${PREFIX}exclude_allergens "en:kiwi" could not be checked, because the allergen vocabulary could not be reached or gave no usable answer; exclude_allergens "en:fruita" could not be checked, because the allergen vocabulary could not be reached or gave no usable answer.`,
      );
      expect(contractHint(result)).toBe(
        'Retry shortly — the allergen vocabulary could not be reached or gave no usable answer, so the value went unconfirmed. The canonical IDs of the 14 major allergens, such as "en:nuts" or "en:milk", are confirmed without it.',
      );
    });

    it('stays non-retryable when the vocabulary answered without a match', async () => {
      useRealService(100, () => Response.json({ took: 1, timed_out: false, options: [] }));

      const result = await runToolContract(offSearchProductsTool, {
        exclude_allergens: ['en:nutz'],
        page: 1,
        page_size: 20,
      });

      const { error } = result.structuredContent as { error: { data: Record<string, unknown> } };
      expect(error.data).toMatchObject({ reason: 'unrecognized_exclusion', retryable: false });
      expect(error.data.unrecognized).toEqual([
        { field: 'exclude_allergens', value: 'en:nutz', reason: 'no_match' },
      ]);
    });

    it('names the spent budget and its wait for a tag value the zero-result notice lists', async () => {
      useRealService(1);
      vi.useFakeTimers({ toFake: ['Date'] });
      // One confirmed exclusion spends the one-lookup budget.
      await runToolContract(offSearchProductsTool, {
        exclude_allergens: ['en:fruita'],
        page: 1,
        page_size: 20,
      });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'tea',
        categories_tag: 'en:kombuchas',
        page: 1,
        page_size: 20,
      });

      const notice = String((result.structuredContent as { notice?: string }).notice);
      expect(notice).toContain(
        'category="en:kombuchas" (this server\'s own per-minute taxonomy budget was spent, so it went unchecked; a lookup slot frees in about 60 s)',
      );
      expect(notice).not.toContain('could not be reached');
    });

    it("names Open Food Facts' rate limit, and its wait when it sent one, for a tag value the zero-result notice lists", async () => {
      const cases = [
        {
          headers: { 'retry-after': '60' },
          reason:
            "Open Food Facts was rate-limiting this server's taxonomy lookups, so it went unchecked; it asked for a wait of 60 s",
        },
        {
          headers: undefined,
          reason:
            "Open Food Facts was rate-limiting this server's taxonomy lookups, so it went unchecked",
        },
      ];
      for (const { headers, reason } of cases) {
        useRealService(100, () =>
          Response.json({ detail: 'slow down' }, { status: 429, ...(headers && { headers }) }),
        );

        const result = await onFakeTimers(() =>
          runToolContract(offSearchProductsTool, {
            query: 'tea',
            categories_tag: 'en:kombuchas',
            page: 1,
            page_size: 20,
          }),
        );

        const notice = String((result.structuredContent as { notice?: string }).notice);
        // The closing parenthesis pins the end of the reason, so a wait added where none was sent fails.
        expect(notice, String(headers)).toContain(`category="en:kombuchas" (${reason})`);
        expect(notice).not.toContain('could not be reached');
        expect(contractText(result)).toContain(
          headers ? 'it asked for a wait of 60 s' : 'taxonomy lookups, so it went unchecked',
        );
      }
    });

    it('names the longest wait and every cause when the unchecked exclusions failed for different reasons', async () => {
      // The one-slot budget sends the first lookup, which Open Food Facts answers 429 with a
      // 120 s Retry-After (past the retry ceiling, so it fails at once); the second is refused by
      // the spent budget, whose wait is its 60 s window.
      useRealService(1, () =>
        Response.json({ detail: 'slow down' }, { status: 429, headers: { 'retry-after': '120' } }),
      );
      vi.useFakeTimers({ toFake: ['Date'] });

      const result = await runToolContract(offSearchProductsTool, {
        exclude_allergens: ['en:kiwi', 'en:fruitk'],
        page: 1,
        page_size: 20,
      });

      const { error } = result.structuredContent as {
        error: { message: string; data: Record<string, unknown> };
      };
      expect(error.data).toMatchObject({
        reason: 'unrecognized_exclusion',
        retryable: true,
        retryAfter: 120,
      });
      expect(error.data.unrecognized).toEqual([
        {
          field: 'exclude_allergens',
          value: 'en:kiwi',
          reason: 'lookup_failed',
          cause: 'rate_limited',
        },
        {
          field: 'exclude_allergens',
          value: 'en:fruitk',
          reason: 'lookup_failed',
          cause: 'budget_spent',
        },
      ]);
      expect(error.message).toBe(
        `${PREFIX}exclude_allergens "en:kiwi" could not be checked, because Open Food Facts is rate-limiting this server's taxonomy lookups (HTTP 429) and asked for a wait of 120 s; exclude_allergens "en:fruitk" could not be checked, because this server's own per-minute taxonomy budget is spent, so no lookup was sent; a slot frees in about 60 s.`,
      );
      expect(contractHint(result)).toBe(
        'Retry after 120 s — Open Food Facts is rate-limiting this server\'s taxonomy lookups; this server\'s own per-minute taxonomy budget is spent and no lookup was sent, so the values went unconfirmed. The canonical IDs of the 14 major allergens, such as "en:nuts" or "en:milk", are confirmed without a lookup.',
      );
      expect(contractText(result)).toContain('Retry after 120 s');
      expect(requestedPaths()).toEqual(['/autocomplete']);
    });
  });

  // ── #44: a tag-only search serves pages 1–10 ─────────────────────────────

  describe('tag-only page bound (#44)', () => {
    it('rejects a tag-only page past 10 before the service, naming the bound', async () => {
      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:pizzas',
        page: 11,
        page_size: 50,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'page_out_of_range', page: 11, page_size: 50, max_page: 10 } },
      });
      expect(contractText(result)).toContain('page 10');
      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it('still sends page 10', async () => {
      mockSearch({
        count: 13_435,
        page: 10,
        page_count: 50,
        page_size: 50,
        products: [{ code: '1234567890001' }],
      });

      const result = await offSearchProductsTool.handler(
        { categories_tag: 'en:pizzas', page: 10, page_size: 50 },
        ctx,
      );

      expect(mockSearchProducts).toHaveBeenCalledOnce();
      expect(result.last_page).toBe(10);
      const guidance = String(getEnrichment(ctx).notice ?? '');
      expect(guidance).toContain('Page 10 of 10 reachable pages');
      expect(guidance).toContain('269 pages of matches exist');
      expect(guidance).toMatch(/as deep as a tag-only search paginates/);
      expect(guidance).not.toContain('fetch subsequent pages');
    });

    it('reports min(10, page count) as last_page and in the guidance', async () => {
      mockSearch({
        count: 13_435,
        page: 1,
        page_count: 50,
        page_size: 50,
        products: [{ code: '1234567890001' }],
      });

      const result = await offSearchProductsTool.handler(
        { categories_tag: 'en:pizzas', page: 1, page_size: 50 },
        ctx,
      );

      expect(result.last_page).toBe(10);
      const guidance = String(getEnrichment(ctx).notice ?? '');
      expect(guidance).toContain('Page 1 of 10 reachable pages');
      expect(guidance).toContain('fetch subsequent pages');
      expect(guidance).not.toMatch(/unpredictab/i);
    });

    it('keeps a short tag result set at its own page count', async () => {
      mockSearch({
        count: 163,
        page: 1,
        page_count: 50,
        page_size: 50,
        products: [{ code: '1234567890001' }],
      });

      const result = await offSearchProductsTool.handler(
        { categories_tag: 'en:hummus', page: 1, page_size: 50 },
        ctx,
      );

      expect(result.last_page).toBe(4);
      expect(String(getEnrichment(ctx).notice ?? '')).toContain('Page 1 of 4.');
    });

    it('names page 10 as the last page on an exhausted deep tag page', async () => {
      mockSearch({ count: 13_435, page: 10, page_count: 0, page_size: 50, products: [] });

      await offSearchProductsTool.handler(
        { categories_tag: 'en:pizzas', page: 10, page_size: 50 },
        ctx,
      );

      expect(String(getEnrichment(ctx).notice ?? '')).toContain('Request page 10 or lower');
    });

    it('calls the limit neither unpredictable nor unpublished in any description', () => {
      const descriptions = [
        offSearchProductsTool.description,
        inputDescription('page'),
        offSearchProductsTool.output.shape.last_page.description ?? '',
        ...(offSearchProductsTool.errors ?? []).flatMap((e) => [e.when, e.recovery]),
      ];
      for (const text of descriptions) {
        expect(text).not.toMatch(/unpredictab|no published window|deep page/i);
      }
      expect(inputDescription('page')).toMatch(/page 10/);
    });
  });

  // ── #79: tag-only searches the local mirror serves ───────────────────────

  describe('tag-only searches on the local mirror (#79)', () => {
    const AS_OF = '2026-10-31T23:59:59.000Z';
    /** The page-11 refusal a tag-only search gets wherever the live database would answer it. */
    const PAGE_11_REFUSAL = {
      message:
        'A search by tag filters alone is served through page 10 only, and page 11 was requested.',
      data: {
        reason: 'page_out_of_range',
        page: 11,
        page_size: 50,
        max_page: 10,
        recovery: {
          hint: 'Request page 10 or lower — at page_size 50 that reaches the first 500 matches — or narrow the filters or change sort_by to bring the products you need forward.',
        },
        retryable: false,
      },
    };
    const MIRROR_NOTE = `These results come from this server's local copy of the Open Food Facts export, current as of ${AS_OF}, not the live database, so a product contributed or edited since then is missing or shown as it was.`;

    /** Stubs one page the mirror served. */
    function mockMirrorPage(
      result: { count: number; products: unknown[] } & Record<string, unknown>,
    ): void {
      mockSearch({ source: 'off_mirror', mirrorAsOf: AS_OF, ...result });
    }

    async function refusal(input: Record<string, unknown>): Promise<{
      message: string;
      data: unknown;
    }> {
      const error = (await captureError(
        offSearchProductsTool.handler(offSearchProductsTool.input.parse(input), ctx),
      )) as { message: string; data: unknown };
      return { message: error.message, data: error.data };
    }

    it('refuses a page past 10 before any lookup when no mirror is ready, as before', async () => {
      // Characterization: the cheap refusal the live path has always given.
      expect(
        await refusal({
          categories_tag: 'en:not-in-the-offline-sample',
          labels_tag: 'Bio',
          page: 11,
          page_size: 50,
        }),
      ).toEqual(PAGE_11_REFUSAL);
      expect(mockSuggestTaxonomy).not.toHaveBeenCalled();
      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it('sends tag-only values as given, unflagged and unlooked-up, when no mirror is ready', async () => {
      // Characterization: Product Opener canonicalizes these itself.
      mockSearch({ count: 1, page: 1, page_count: 1, page_size: 20, products: [] });

      await offSearchProductsTool.handler(
        {
          brands_tag: 'Nutella',
          countries_tag: 'US',
          additives_tag: ' E322 ',
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      expect(mockSearchProducts.mock.calls[0]?.[0]).toEqual({
        page: 1,
        page_size: 20,
        brands_tag: 'Nutella',
        countries_tag: 'US',
        additives_tag: 'E322',
      });
      expect(mockSuggestTaxonomy).not.toHaveBeenCalled();
    });

    it('never asks for the mirror on a search the text backend answers', async () => {
      // Characterization: the text path reads neither the mirror nor its readiness.
      mockMirrorReady.mockResolvedValue(true);
      mockSearch({ count: 1, page: 1, page_count: 1, page_size: 20, products: [] });

      await offSearchProductsTool.handler(
        { query: 'hummus', categories_tag: 'en:hummus', page: 1, page_size: 20 },
        ctx,
      );

      expect(mockMirrorReady).not.toHaveBeenCalled();
      expect(mockSearchProducts.mock.calls[0]?.[0]).not.toHaveProperty('tags_confirmed');
    });

    it('canonicalizes every tag-path value and flags the search confirmed when the mirror is ready', async () => {
      mockMirrorReady.mockResolvedValue(true);
      mockSuggestTaxonomy.mockImplementation(async (taxonomy: string, term: string) =>
        taxonomy === 'category' && term === 'Hazelnut spreads'
          ? [{ id: 'en:hazelnut-spreads', name: 'Hazelnut spreads' }]
          : [],
      );
      mockMirrorPage({
        count: 600,
        page: 11,
        page_count: 1,
        page_size: 50,
        products: [{ code: '1234567890001' }],
      });

      const result = await offSearchProductsTool.handler(
        offSearchProductsTool.input.parse({
          categories_tag: 'Hazelnut spreads',
          brands_tag: ' Nutella ',
          labels_tag: ['Organic', 'en:fair-trade'],
          allergens_tag: 'Milk',
          traces_tag: 'en:nuts',
          countries_tag: 'France',
          additives_tag: 'E322',
          exclude_allergens: ['Peanuts'],
          ingredients_analysis_tag: 'en:vegan',
          nutrition_grade: 'e',
          nova_group: '4',
          page: 11,
          page_size: 50,
        }),
        ctx,
      );

      expect(mockSearchProducts.mock.calls[0]?.[0]).toEqual({
        page: 11,
        page_size: 50,
        categories_tag: 'en:hazelnut-spreads',
        brands_tag: 'nutella',
        labels_tag: ['en:organic', 'en:fair-trade'],
        allergens_tag: 'en:milk',
        traces_tag: 'en:nuts',
        countries_tag: 'en:france',
        additives_tag: 'en:e322',
        exclude_allergens: ['en:peanuts'],
        ingredients_analysis_tag: 'en:vegan',
        nutrition_grade: 'e',
        nova_group: '4',
        tags_confirmed: true,
      });
      // Only the value the offline sample lacks costs a lookup.
      expect(mockSuggestTaxonomy).toHaveBeenCalledOnce();
      expect(mockMirrorReady).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        page: 11,
        source: 'off_mirror',
        mirror_as_of: AS_OF,
        last_page: 12,
      });
    });

    it('flags a search of closed vocabularies alone confirmed', async () => {
      mockMirrorReady.mockResolvedValue(true);
      mockMirrorPage({ count: 1, page: 1, page_count: 1, page_size: 20, products: [] });

      await offSearchProductsTool.handler({ nova_group: '4', page: 1, page_size: 20 }, ctx);

      expect(mockSearchProducts.mock.calls[0]?.[0]).toEqual({
        page: 1,
        page_size: 20,
        nova_group: '4',
        tags_confirmed: true,
      });
      expect(mockSuggestTaxonomy).not.toHaveBeenCalled();
    });

    describe('a value the mirror cannot match', () => {
      const LEAD =
        "A search by tag filters alone is served through page 10 only when it reads the live database, and page 11 was requested: this server's local copy of the export serves deeper pages only when it confirms every value, and ";
      const REPLACE_HINT =
        "Replace the value with a canonical tag ID from off_browse_taxonomy, or a brand slug, so this server's local copy of the export can serve page 11, or request page 10 or lower — at page_size 50 that reaches the first 500 matches.";
      /** The page-11 refusal naming one unconfirmed value. */
      const unconfirmedRefusal = (
        listed: string,
        entry: Record<string, unknown>,
        hint = REPLACE_HINT,
        retry: { retryable: boolean; retryAfter?: number } = { retryable: false },
      ) => ({
        message: `${LEAD}${listed}.`,
        data: {
          reason: 'page_out_of_range',
          page: 11,
          page_size: 50,
          max_page: 10,
          unconfirmed: [entry],
          ...retry,
          recovery: { hint },
        },
      });
      const cases: {
        name: string;
        input: Record<string, unknown>;
        arrange?: () => void;
        refusal: ReturnType<typeof unconfirmedRefusal>;
      }[] = [
        {
          name: 'a country nothing confirms',
          input: { countries_tag: 'Narnia' },
          refusal: unconfirmedRefusal(
            'countries_tag "Narnia" went unconfirmed (no matching Open Food Facts tag was found)',
            { field: 'countries_tag', value: 'Narnia', reason: 'no_match' },
          ),
        },
        {
          name: 'a country whose lookup failed',
          input: { countries_tag: 'Narnia' },
          arrange: () =>
            mockSuggestTaxonomy.mockRejectedValue(
              new Error('Open Food Facts is unavailable (HTTP 503).'),
            ),
          refusal: unconfirmedRefusal(
            'countries_tag "Narnia" went unconfirmed (the tag vocabulary could not be reached or gave no usable answer, so it went unchecked)',
            {
              field: 'countries_tag',
              value: 'Narnia',
              reason: 'lookup_failed',
              cause: 'unavailable',
            },
            "Retry shortly — once the value can be confirmed, this server's local copy of the export serves page 11. Request page 10 or lower to read the live database now.",
            { retryable: true },
          ),
        },
        {
          name: 'a country whose lookup the taxonomy budget refused',
          input: { countries_tag: 'Narnia' },
          arrange: () =>
            mockSuggestTaxonomy.mockRejectedValue(
              new BudgetExhaustedError('budget spent', {
                endpoint: 'taxonomy',
                limit: 10,
                retryAfter: 42,
              }),
            ),
          refusal: unconfirmedRefusal(
            'countries_tag "Narnia" went unconfirmed (this server\'s own per-minute taxonomy budget was spent, so it went unchecked; a lookup slot frees in about 42 s)',
            {
              field: 'countries_tag',
              value: 'Narnia',
              reason: 'lookup_failed',
              cause: 'budget_spent',
            },
            "Retry after 42 s — once the value can be confirmed, this server's local copy of the export serves page 11. Request page 10 or lower to read the live database now.",
            { retryable: true, retryAfter: 42 },
          ),
        },
        {
          name: 'an additive nothing confirms',
          input: { additives_tag: 'E9999' },
          refusal: unconfirmedRefusal(
            'additives_tag "E9999" went unconfirmed (no matching Open Food Facts tag was found)',
            { field: 'additives_tag', value: 'E9999', reason: 'no_match' },
          ),
        },
        {
          name: 'a brand whose slug is empty',
          input: { brands_tag: '™' },
          refusal: unconfirmedRefusal(
            'brands_tag "™" went unconfirmed (it slugs to no brand tag)',
            { field: 'brands_tag', value: '™', reason: 'no_vocabulary' },
          ),
        },
      ];

      for (const { name, input, arrange, refusal: expected } of cases) {
        it(`reads live with the values as given for ${name}`, async () => {
          mockMirrorReady.mockResolvedValue(true);
          arrange?.();
          mockSearch({
            count: 1,
            page: 1,
            page_count: 1,
            page_size: 20,
            products: [{ code: '1234567890001' }],
          });

          const result = await offSearchProductsTool.handler(
            offSearchProductsTool.input.parse({
              brands_tag: 'Nutella',
              ...input,
              page: 1,
              page_size: 20,
            }),
            ctx,
          );

          expect(mockSearchProducts.mock.calls[0]?.[0]).toEqual({
            page: 1,
            page_size: 20,
            brands_tag: 'Nutella',
            ...input,
          });
          expect(result.source).toBe('off_api');
          expect(result).not.toHaveProperty('mirror_as_of');
          expect(getEnrichment(ctx).mirror_snapshot).toBeUndefined();
        });

        it(`refuses page 11 naming ${name}, sending nothing`, async () => {
          mockMirrorReady.mockResolvedValue(true);
          arrange?.();

          expect(
            await refusal({ brands_tag: 'Nutella', ...input, page: 11, page_size: 50 }),
          ).toEqual(expected);
          expect(mockSearchProducts).not.toHaveBeenCalled();
        });
      }

      it('carries the refusal on both surfaces, its hint as the recovery', async () => {
        mockMirrorReady.mockResolvedValue(true);
        mockSuggestTaxonomy.mockRejectedValue(
          new BudgetExhaustedError('budget spent', {
            endpoint: 'taxonomy',
            limit: 10,
            retryAfter: 42,
          }),
        );
        const expected = cases.find(({ name }) => name.includes('budget'))?.refusal;

        const result = await runToolContract(offSearchProductsTool, {
          countries_tag: 'Narnia',
          brands_tag: 'Nutella',
          page: 11,
          page_size: 50,
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { message: expected?.message, data: expected?.data },
        });
        expect(contractHint(result)).toBe(expected?.data.recovery.hint);
        expect(contractText(result)).toContain(String(expected?.message));
      });
    });

    it('refuses with the live refusal when the service could not serve a confirmed page past 10', async () => {
      // The mirror went unready after the check, or its store failed: the service answers this
      // outcome rather than sending a page the live API refuses.
      mockMirrorReady.mockResolvedValue(true);
      mockSearchProducts.mockResolvedValue({ status: 'page_out_of_range', bound: 'live_max_page' });

      expect(await refusal({ categories_tag: 'en:spreads', page: 11, page_size: 50 })).toEqual(
        PAGE_11_REFUSAL,
      );
      expect(mockSearchProducts).toHaveBeenCalledOnce();
      expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
        tags_confirmed: true,
        page: 11,
      });
    });

    it('serves a deep page on both surfaces with last_page and paging guidance inside the window', async () => {
      mockMirrorReady.mockResolvedValue(true);
      mockMirrorPage({
        count: 9_950,
        page: 11,
        page_count: 1,
        page_size: 50,
        products: [{ code: '1234567890001', product_name: 'Spread' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:spreads',
        page: 11,
        page_size: 50,
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        total: 9_950,
        total_is_lower_bound: false,
        page: 11,
        last_page: 199,
        source: 'off_mirror',
        mirror_as_of: AS_OF,
        truncated: true,
        notice: 'Page 11 of 199. Use the page parameter to fetch subsequent pages.',
      });
      const text = contractText(result);
      expect(text).toContain('(page 11 of 199, 50 per page, showing 1)');
      expect(text).toContain(
        `**Source:** off_mirror (this server's local copy of the Open Food Facts export, as of ${AS_OF})`,
      );
      expect(text).not.toMatch(/reachable pages|served through page 10/);
    });

    it('caps last_page and the paging guidance at the window on a larger result set', async () => {
      mockMirrorReady.mockResolvedValue(true);
      mockMirrorPage({
        count: 13_435,
        page: 11,
        page_count: 1,
        page_size: 50,
        products: [{ code: '1234567890001', product_name: 'Spread' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:spreads',
        page: 11,
        page_size: 50,
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        total: 13_435,
        total_is_lower_bound: false,
        page: 11,
        last_page: 200,
        source: 'off_mirror',
        truncated: true,
        notice:
          "Page 11 of 200 reachable pages — 269 pages of matches exist, but this server's local copy of the export serves only the first 10000 results. Use the page parameter to fetch subsequent pages.",
      });
      const text = contractText(result);
      expect(text).toContain('(page 11 of 200, 50 per page, showing 1)');
      expect(text).not.toMatch(/served through page 10/);
    });

    it('names the window as the end of paging on the last page it serves', async () => {
      mockMirrorReady.mockResolvedValue(true);
      mockMirrorPage({
        count: 13_435,
        page: 200,
        page_count: 50,
        page_size: 50,
        products: [{ code: '1234567890001' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:spreads',
        page: 200,
        page_size: 50,
      });

      expect(result.structuredContent).toMatchObject({
        page: 200,
        last_page: 200,
        truncated: true,
        notice:
          "Page 200 of 200 reachable pages — 269 pages of matches exist, but this server's local copy of the export serves only the first 10000 results. That is as deep as a tag-only search paginates — narrow the filters or change sort_by to reach other products.",
      });
      expect(contractText(result)).toContain('(page 200 of 200, 50 per page, showing 50)');
    });

    describe('the result window', () => {
      /** The refusal of a confirmed page past the window, at `pageSize` served. */
      function windowRefusal(page: number, pageSize: number, served = `page_size ${pageSize}`) {
        const maxPage = Math.floor(10_000 / pageSize);
        return {
          message: `This server's local copy of the export serves only the first 10000 results of a search, and page ${page} at ${served} asks for result ${page * pageSize}.`,
          data: {
            reason: 'page_out_of_range',
            page,
            page_size: pageSize,
            max_page: maxPage,
            result_window: 10_000,
            recovery: {
              hint: `Request page ${maxPage} or lower at page_size ${pageSize}, or narrow the filters or change sort_by so the products you need fall inside the first 10000 results.`,
            },
            retryable: false,
          },
        };
      }

      // page * page_size at exactly 10,000 is served, and the next page is not; page_size 3
      // reaches 9,999 at page 3,333, so the bound is on the product, never a rounded page count.
      const BOUNDARIES = [
        { pageSize: 100, lastServed: 100 },
        { pageSize: 50, lastServed: 200 },
        { pageSize: 1, lastServed: 10_000 },
        { pageSize: 3, lastServed: 3_333 },
      ];

      for (const { pageSize, lastServed } of BOUNDARIES) {
        it(`serves page ${lastServed} at page_size ${pageSize}, the last inside the window`, async () => {
          mockMirrorReady.mockResolvedValue(true);
          mockMirrorPage({
            count: 20_000,
            page: lastServed,
            page_count: 1,
            page_size: pageSize,
            products: [{ code: '1234567890001' }],
          });

          const result = await offSearchProductsTool.handler(
            offSearchProductsTool.input.parse({
              categories_tag: 'en:spreads',
              page: lastServed,
              page_size: pageSize,
            }),
            ctx,
          );

          expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
            page: lastServed,
            page_size: pageSize,
            tags_confirmed: true,
          });
          expect(result).toMatchObject({
            page: lastServed,
            last_page: lastServed,
            source: 'off_mirror',
          });
        });

        it(`refuses page ${lastServed + 1} at page_size ${pageSize} before calling the service`, async () => {
          mockMirrorReady.mockResolvedValue(true);

          expect(
            await refusal({
              categories_tag: 'en:spreads',
              page: lastServed + 1,
              page_size: pageSize,
            }),
          ).toEqual(windowRefusal(lastServed + 1, pageSize));
          expect(mockSearchProducts).not.toHaveBeenCalled();
        });
      }

      it('refuses past the window on both surfaces, naming the window, the page, and the reachable page', async () => {
        mockMirrorReady.mockResolvedValue(true);
        const expected = windowRefusal(101, 100, 'page_size 150 served at 100');

        const result = await runToolContract(offSearchProductsTool, {
          categories_tag: 'en:spreads',
          page: 101,
          page_size: 150,
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { message: expected.message, data: expected.data },
        });
        expect(contractHint(result)).toBe(expected.data.recovery.hint);
        const text = contractText(result);
        expect(text).toContain(expected.message);
        expect(text).toContain(expected.data.recovery.hint);
        expect(mockSearchProducts).not.toHaveBeenCalled();
      });

      it('refuses with the page-10 bound, not the window, naming a value the mirror cannot match', async () => {
        mockMirrorReady.mockResolvedValue(true);

        expect(
          await refusal({
            categories_tag: 'en:spreads',
            countries_tag: 'Narnia',
            page: 201,
            page_size: 50,
          }),
        ).toEqual({
          message:
            'A search by tag filters alone is served through page 10 only when it reads the live database, and page 201 was requested: this server\'s local copy of the export serves deeper pages only when it confirms every value, and countries_tag "Narnia" went unconfirmed (no matching Open Food Facts tag was found).',
          data: {
            reason: 'page_out_of_range',
            page: 201,
            page_size: 50,
            max_page: 10,
            unconfirmed: [{ field: 'countries_tag', value: 'Narnia', reason: 'no_match' }],
            retryable: false,
            recovery: {
              hint: "Replace the value with a canonical tag ID from off_browse_taxonomy, or a brand slug, so this server's local copy of the export can serve page 201, or request page 10 or lower — at page_size 50 that reaches the first 500 matches.",
            },
          },
        });
        expect(mockSearchProducts).not.toHaveBeenCalled();
      });

      it('refuses with the live page-10 refusal when the service read live after a store error', async () => {
        // The tool checked the mirror ready, then the service's mirror read failed and it read live,
        // where the page-10 bound holds even inside the window.
        mockMirrorReady.mockResolvedValue(true);
        mockSearchProducts.mockResolvedValue({
          status: 'page_out_of_range',
          bound: 'live_max_page',
        });

        expect(await refusal({ categories_tag: 'en:spreads', page: 200, page_size: 50 })).toEqual({
          message:
            'A search by tag filters alone is served through page 10 only, and page 200 was requested.',
          data: { ...PAGE_11_REFUSAL.data, page: 200 },
        });
        expect(mockSearchProducts.mock.calls[0]?.[0]).toMatchObject({
          tags_confirmed: true,
          page: 200,
        });
      });

      it('keeps the text-window refusal as it was', async () => {
        // Characterization: the mirror's window leaves the text path's refusal untouched.
        expect(await refusal({ query: 'spread', page: 101, page_size: 150 })).toEqual({
          message:
            'The text backend serves only the first 10000 results, and page 101 at page_size 150 served at 100 asks for result 10100.',
          data: {
            reason: 'page_out_of_range',
            page: 101,
            page_size: 100,
            max_page: 100,
            result_window: 10_000,
            recovery: {
              hint: 'Request page 100 or lower at page_size 100, or add filters so the products you need rank inside the first 10000 results.',
            },
            retryable: false,
          },
        });
        expect(await refusal({ query: 'spread', page: 10_001, page_size: 1 })).toEqual({
          message:
            'The text backend serves only the first 10000 results, and page 10001 at page_size 1 asks for result 10001.',
          data: {
            reason: 'page_out_of_range',
            page: 10_001,
            page_size: 1,
            max_page: 10_000,
            result_window: 10_000,
            recovery: {
              hint: 'Request page 10000 or lower at page_size 1, or add filters so the products you need rank inside the first 10000 results.',
            },
            retryable: false,
          },
        });
        expect(mockMirrorReady).not.toHaveBeenCalled();
        expect(mockSearchProducts).not.toHaveBeenCalled();
      });
    });

    it('names the next page past 10 when a capped page_size reaches it', async () => {
      mockMirrorReady.mockResolvedValue(true);
      mockMirrorPage({
        count: 1200,
        page: 10,
        page_count: 100,
        page_size: 100,
        products: [{ code: '1234567890001' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:spreads',
        page: 10,
        page_size: 150,
      });

      expect(result.structuredContent).toMatchObject({ last_page: 12, truncated: true });
      expect((result.structuredContent as Record<string, unknown>).page_size_capped).toBe(
        'page_size 150 is above the 100 results one call returns; this page was served at page_size 100. Pages are counted at that size: request page 11 for results 1001–1100.',
      );
    });

    it('reports a page past the exact last page as exhausted, naming that page', async () => {
      mockMirrorReady.mockResolvedValue(true);
      mockMirrorPage({ count: 600, page: 15, page_count: 0, page_size: 50, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:spreads',
        page: 15,
        page_size: 50,
      });

      expect(result.structuredContent).toMatchObject({
        total: 600,
        last_page: 12,
        source: 'off_mirror',
        notice:
          'Page 15 is past the end of this result set — 600 matching products exist, but no page this deep holds any. Request page 12 or lower to reach them.',
      });
      const text = contractText(result);
      expect(text).toContain('Request page 12 or lower to reach the matching products.');
      expect(text).toContain(`as of ${AS_OF})`);
    });

    it('keeps the tag-only zero notice on an empty mirror answer, beside the freshness note', async () => {
      mockMirrorReady.mockResolvedValue(true);
      mockMirrorPage({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        brands_tag: 'nutell',
        page: 1,
        page_size: 20,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.notice).toBe(
        'No products found for brand="nutell". Try broader terms, check tag IDs via off_browse_taxonomy, or remove some filters.',
      );
      expect(structured).not.toHaveProperty('last_page');
      expect(String(structured.mirror_snapshot)).toContain(MIRROR_NOTE);
      const text = contractText(result);
      expect(text).toContain('**No products found** (total: 0)');
      expect(text).toContain(
        `**Source:** off_mirror (this server's local copy of the Open Food Facts export, as of ${AS_OF})`,
      );
      expect(text).toContain(`current as of ${AS_OF}`);
    });

    it('discloses the mirror order for each sort, and says nothing of order for a timestamp sort', async () => {
      const orderOf = {
        default:
          ' The default order follows the popularity_key value stored with each record as of then, which can differ page for page from a live search, where Open Food Facts orders it by its current scan counts.',
        popularity_key:
          ' The order follows the popularity_key value stored with each record as of then, which can differ page for page from a live search, where Open Food Facts orders it by its current scan counts.',
        unique_scans_n:
          ' The order follows the unique_scans_n value stored with each record as of then, which can differ page for page from a live search, where Open Food Facts orders it by its current scan counts.',
        created_t: '',
        last_modified_t: '',
      } as const;
      mockMirrorReady.mockResolvedValue(true);

      for (const [sort, order] of Object.entries(orderOf)) {
        mockMirrorPage({
          count: 1,
          page: 1,
          page_count: 1,
          page_size: 20,
          products: [{ code: '1234567890001' }],
        });
        const sortCtx = createToolContext();
        await offSearchProductsTool.handler(
          offSearchProductsTool.input.parse({
            categories_tag: 'en:spreads',
            ...(sort !== 'default' && { sort_by: sort }),
          }),
          sortCtx,
        );
        expect(getEnrichment(sortCtx).mirror_snapshot, sort).toBe(`${MIRROR_NOTE}${order}`);
      }
    });

    it('carries the freshness note on both surfaces and never says the mirror reads the live database', async () => {
      mockMirrorReady.mockResolvedValue(true);
      mockMirrorPage({
        count: 1,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:spreads',
        sort_by: 'created_t',
        page: 1,
        page_size: 20,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.mirror_snapshot).toBe(MIRROR_NOTE);
      const text = contractText(result);
      expect(text).toContain(
        `**Mirror freshness:** These results come from this server's local copy of the Open Food Facts export, current as of ${AS_OF}`,
      );
      expect(text).not.toMatch(/reads? the live database/);
      expect(structured).not.toHaveProperty('text_index_snapshot');
    });

    it('marks a live answer off_api on both surfaces, with no as-of time or freshness note', async () => {
      mockSearch({
        count: 1,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:spreads',
        page: 1,
        page_size: 20,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.source).toBe('off_api');
      expect(structured).not.toHaveProperty('mirror_as_of');
      expect(structured).not.toHaveProperty('mirror_snapshot');
      const text = contractText(result);
      expect(text).toContain('**Source:** off_api (Open Food Facts)');
      expect(text).not.toMatch(/off_mirror|local copy/);
    });

    it('renders the source on every text branch', () => {
      const base = {
        total_is_lower_bound: false,
        page: 1,
        page_size: 20,
        source: 'off_mirror' as const,
        mirror_as_of: AS_OF,
      };
      const line = `**Source:** off_mirror (this server's local copy of the Open Food Facts export, as of ${AS_OF})`;
      const branches = {
        'zero matches': { ...base, total: 0, page_count: 0, products: [] },
        'every row left off': {
          ...base,
          total: 3,
          page_count: 0,
          last_page: 1,
          omitted: 3,
          products: [],
        },
        'past the end': { ...base, page: 2, total: 3, page_count: 0, last_page: 1, products: [] },
        rows: {
          ...base,
          total: 1,
          page_count: 1,
          last_page: 1,
          products: [{ barcode: '1234567890001' }],
        },
      };
      for (const [name, output] of Object.entries(branches)) {
        expect(firstText(offSearchProductsTool.format!(output)), name).toContain(line);
      }
      expect(
        firstText(
          offSearchProductsTool.format!({
            ...branches.rows,
            source: 'off_api',
            mirror_as_of: undefined,
          }),
        ),
      ).toContain('**Source:** off_api (Open Food Facts)\n*Data: Open Food Facts (ODbL 1.0)*');
    });

    it('states which deployments the page-10 bound applies to, and what source reports', () => {
      expect(inputDescription('page')).toContain(
        'A search by tag filters alone that reads the live database is served through page 10 only',
      );
      expect(inputDescription('page')).toContain(
        'is served from that copy through its first 10000 results, so page * page_size (as served) must stay at or below 10000 there.',
      );
      expect(inputDescription('page')).toContain('A request past any of these bounds is rejected');
      expect(inputDescription('page')).not.toMatch(/no page limit/);
      expect(offSearchProductsTool.output.shape.last_page.description).toContain(
        'capped at page 10 on a search by tag filters alone that read the live database',
      );
      expect(offSearchProductsTool.output.shape.last_page.description).toContain(
        'and by the local copy\'s 10000-result window when source is "off_mirror"',
      );
      const pageBound = (offSearchProductsTool.errors ?? []).find(
        (e) => e.reason === 'page_out_of_range',
      );
      expect(pageBound?.when).toContain(
        'asks for a page past 10 and would read the live database — this server keeps no ready local copy of the export, a tag value is one it cannot confirm, or the search carries ecoscore_grade before a full reload of that copy has indexed Green-Score',
      );
      expect(pageBound?.when).toContain(
        'or one the local copy serves beyond its 10000-result window',
      );
      expect(offSearchProductsTool.description).toContain(
        'which source and mirror_as_of then report',
      );
      expect(offSearchProductsTool.output.shape.source.description).toContain('"off_mirror"');
      expect(offSearchProductsTool.output.shape.mirror_as_of.description).toContain('ISO 8601');
    });
  });

  describe('matches left off for an unservable code', () => {
    it('discloses them on both surfaces beside the rows that were kept', async () => {
      mockSearch({
        count: 40,
        page: 1,
        page_count: 3,
        page_size: 5,
        dropped: 2,
        products: [{ code: '3017620422003' }, { code: '6035215' }, { code: '1212' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'miel',
        page: 1,
        page_size: 5,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ page_count: 3, omitted: 2 });
      expect(contractText(result)).toContain('2 matches on this page were left off');
    });

    it('adds nothing when every code was servable', async () => {
      mockSearch({ count: 1, page: 1, page_count: 1, page_size: 5, products: [{ code: '1212' }] });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'miel',
        page: 1,
        page_size: 5,
      });

      expect((result.structuredContent as Record<string, unknown>).omitted).toBeUndefined();
      expect(contractText(result)).not.toMatch(/left off/);
    });

    it('reports a page whose every match was left off, and points at the next page', async () => {
      // Neither a zero-match search nor a page past the end: the filters match 40 products and
      // this page's 3 were all stored under unservable codes.
      mockSearch({ count: 40, page: 1, page_count: 0, page_size: 5, dropped: 3, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:honeys',
        page: 1,
        page_size: 5,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        total: 40,
        page_count: 0,
        last_page: 8,
        omitted: 3,
        products: [],
      });
      expect(String(structured.notice ?? '')).toBe(
        'Page 1 lists no products: 3 matches on this page were left off: Open Food Facts stores them under codes it cannot serve, so off_get_product could not look them up either. Request page 2 for further matches.',
      );
      const text = contractText(result);
      expect(text).toContain('**Page 1 of 8 lists no products** (40 total products, 5 per page)');
      expect(text).toContain('3 matches on this page were left off');
      expect(text).not.toMatch(/No products found|past the end/);
    });

    it('says no further page exists when the all-omitted page is the last one', async () => {
      mockSearch({ count: 1, page: 1, page_count: 0, page_size: 5, dropped: 1, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'miel',
        page: 1,
        page_size: 5,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ total: 1, last_page: 1, omitted: 1 });
      expect(String(structured.notice ?? '')).toMatch(
        /^Page 1 lists no products: 1 match on this page was left off: .* No further page of matches can be requested\.$/,
      );
      expect(contractText(result)).not.toContain('Request page 2');
    });

    it('marks an all-omitted middle page truncated, since matches lie beyond it (#55)', async () => {
      mockSearch({ count: 40, page: 2, page_count: 0, page_size: 5, dropped: 5, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:honeys',
        page: 2,
        page_size: 5,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        truncated: true,
        shown: 0,
        cap: 5,
        last_page: 8,
        omitted: 5,
        notice:
          'Page 2 lists no products: 5 matches on this page were left off: Open Food Facts stores them under codes it cannot serve, so off_get_product could not look them up either. Request page 3 for further matches.',
      });
      const text = contractText(result);
      expect(text).toContain('**Page 2 of 8 lists no products** (40 total products, 5 per page)');
      expect(text).toContain('Request page 3 for further matches.');
    });

    it('marks an all-omitted page cut by the tag page bound truncated, naming no next page', async () => {
      mockSearch({ count: 315, page: 10, page_count: 0, page_size: 5, dropped: 5, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        countries_tag: 'en:mongolia',
        page: 10,
        page_size: 5,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ truncated: true, shown: 0, cap: 5, last_page: 10 });
      expect(String(structured.notice)).toMatch(/No further page of matches can be requested\.$/);
    });

    it('carries no truncation on an all-omitted final page', async () => {
      mockSearch({ count: 13, page: 3, page_count: 0, page_size: 5, dropped: 3, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:honeys',
        page: 3,
        page_size: 5,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ last_page: 3, omitted: 3 });
      for (const key of ['truncated', 'shown', 'cap'] as const) {
        expect(structured).not.toHaveProperty(key);
      }
      expect(String(structured.notice)).toMatch(/No further page of matches can be requested\.$/);
    });

    it('names the next page in the body of a lower-bound all-omitted page, as the notice does', async () => {
      // last_page is withheld when the backend stopped counting, yet page 2 can still be
      // requested: the format() body and the notice must agree on it.
      mockSearch({
        count: 10_000,
        count_is_exact: false,
        page: 1,
        page_count: 0,
        page_size: 5,
        dropped: 5,
        products: [],
      });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'chocolate',
        page: 1,
        page_size: 5,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ total_is_lower_bound: true, truncated: true, omitted: 5 });
      expect(structured).not.toHaveProperty('last_page');
      expect(String(structured.notice)).toMatch(/Request page 2 for further matches\.$/);
      const body = result.content?.[0];
      expect(body?.type === 'text' ? body.text : '').toContain(
        'Request page 2 for further matches.',
      );
    });

    it('names no next page at the deepest reachable page of a lower-bound result set', async () => {
      mockSearch({
        count: 10_000,
        count_is_exact: false,
        page: 2000,
        page_count: 0,
        page_size: 5,
        dropped: 5,
        products: [],
      });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'chocolate',
        page: 2000,
        page_size: 5,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(String(structured.notice)).toMatch(/No further page of matches can be requested\.$/);
      expect(contractText(result)).not.toContain('Request page 2001');
    });
  });

  // ── #55: truncation means more results beyond this page ───────────────────

  describe('truncation on the final page (#55)', () => {
    /** The truncation and paging-notice keys a final page must not carry. */
    const PAGING_KEYS = ['truncated', 'shown', 'cap', 'notice'] as const;

    it.each([
      {
        label: 'a nutrient-filtered text search on its last page',
        args: {
          query: 'dark chocolate',
          nutrient_filters: [{ nutrient: 'sugars' as const, operator: 'lt' as const, value: 8 }],
          page_size: 2,
          page: 907,
        },
        response: { count: 1813, page: 907, page_count: 1, page_size: 2 },
      },
      {
        label: 'a tag-filtered text search ending on a full page',
        args: { query: 'milk', countries_tag: 'en:mongolia', page_size: 3, page: 2 },
        response: { count: 6, page: 2, page_count: 3, page_size: 3 },
      },
      {
        label: 'a text search whose window ends exactly at its last match',
        args: { query: 'chocolate', page_size: 2, page: 5000 },
        response: { count: TEXT_SEARCH_RESULT_WINDOW, page: 5000, page_count: 2, page_size: 2 },
      },
      {
        label: 'a tag-only search ending on a full page',
        args: { countries_tag: 'en:mongolia', page_size: 45, page: 7 },
        response: { count: 315, page: 7, page_count: 45, page_size: 45 },
      },
    ])('carries no truncation or paging notice on $label', async ({ args, response }) => {
      mockSearch({ ...response, products: [{ code: '1234567890001' }] });

      const result = await runToolContract(offSearchProductsTool, args);

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.last_page).toBe(args.page);
      for (const key of PAGING_KEYS) expect(structured).not.toHaveProperty(key);
      const text = contractText(result);
      expect(text).not.toMatch(/No further pages|reachable pages|Page \d+ of \d+\./);
      expect(text).toContain(`(page ${args.page} of ${args.page},`);
    });

    it('keeps the omitted disclosure, without truncation, on a one-page result missing a row', async () => {
      // 20 matches at page_size 20 is one page; the 20th was left off for an unservable code. The
      // 19 rows delivered are fewer than the total, yet nothing lies beyond this page — a rule that
      // compared the total against rows delivered would report truncation here.
      mockSearch({
        count: 20,
        page: 1,
        page_count: 19,
        page_size: 20,
        dropped: 1,
        products: [{ code: '1234567890001' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:honeys',
        page: 1,
        page_size: 20,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ last_page: 1, omitted: 1, page_count: 19 });
      for (const key of PAGING_KEYS) expect(structured).not.toHaveProperty(key);
      expect(contractText(result)).toContain('1 match on this page was left off');
    });

    it('keeps truncation on a short page that has further pages beyond it', async () => {
      // 19 rows delivered at page_size 20 out of 100: the short page is a drop, not the end.
      mockSearch({
        count: 100,
        page: 1,
        page_count: 19,
        page_size: 20,
        dropped: 1,
        products: [{ code: '1234567890001' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:honeys',
        page: 1,
        page_size: 20,
      });

      expect(result.structuredContent).toMatchObject({
        truncated: true,
        shown: 19,
        cap: 20,
        last_page: 5,
        notice: 'Page 1 of 5. Use the page parameter to fetch subsequent pages.',
      });
    });

    // Characterization — the bound-cut and first-page cases keep their truncation and guidance.

    it('keeps truncation and guidance on page 1 of a multi-page set', async () => {
      mockSearch({
        count: 315,
        page: 1,
        page_count: 45,
        page_size: 45,
        products: [{ code: '1234567890001' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        countries_tag: 'en:mongolia',
        page: 1,
        page_size: 45,
      });

      expect(result.structuredContent).toMatchObject({
        truncated: true,
        shown: 45,
        cap: 45,
        last_page: 7,
        notice: 'Page 1 of 7. Use the page parameter to fetch subsequent pages.',
      });
      expect(contractText(result)).toContain('Page 1 of 7.');
    });

    it('keeps truncation on the last reachable page of a tag search cut by the page bound', async () => {
      mockSearch({
        count: 315,
        page: 10,
        page_count: 5,
        page_size: 5,
        products: [{ code: '1234567890001' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        countries_tag: 'en:mongolia',
        page: 10,
        page_size: 5,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ truncated: true, shown: 5, cap: 5, last_page: 10 });
      expect(String(structured.notice)).toContain('63 pages of matches exist');
      expect(String(structured.notice)).toContain('as deep as a tag-only search paginates');
    });
  });

  // ── #57, #86: an over-cap page_size is served at 100 ──────────────────────

  describe('page_size above the per-call cap (#57, #86)', () => {
    /** One page of a counted search at the served 100, filled to `page_count` placeholder rows. */
    function mockTagPage(
      count: number,
      page: number,
      pageCount: number,
      extra: Record<string, unknown> = {},
    ): void {
      mockSearch({
        count,
        page,
        page_count: pageCount,
        page_size: 100,
        products: Array.from({ length: pageCount }, (_, i) => ({
          code: String(1_000_000_000_000 + (page - 1) * 100 + i),
        })),
        ...extra,
      });
    }

    it.each([10_001, 1e21])('serves page_size %d at 100 with its notice', async (size) => {
      mockTagPage(163, 1, 100);

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page_size: size,
      });

      expect(result.isError).toBeFalsy();
      expect(mockSearchProducts).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, page_size: 100 }),
        expect.anything(),
      );
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ page_size: 100, last_page: 2 });
      expect(structured.page_size_capped).toBe(
        `page_size ${size} is above the 100 results one call returns; this page was served at page_size 100. Pages are counted at that size: request page 2 for results 101–163.`,
      );
    });

    it('rejects a text page past the window at the served size for a huge page_size', async () => {
      const result = await runToolContract(offSearchProductsTool, {
        query: 'chocolate',
        page: 101,
        page_size: 1_000_000,
      });

      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'page_out_of_range', page_size: 100, max_page: 100 } },
      });
      expect(contractHint(result)).toBe(
        'Request page 100 or lower at page_size 100, or add filters so the products you need rank inside the first 10000 results.',
      );
      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it('advertises page_size with no upper bound, and keeps it whole and at least 1', () => {
      const { page_size } = z.toJSONSchema(offSearchProductsTool.input, { io: 'input' })
        .properties as Record<string, Record<string, unknown>>;

      expect(page_size).toMatchObject({ type: 'number', minimum: 1, multipleOf: 1 });
      expect(page_size).not.toHaveProperty('maximum');
    });

    it.each([
      [0.5, 'Send page_size as a whole number, not a fractional one.'],
      [2.5, 'Send page_size as a whole number, not a fractional one.'],
      // Inside multipleOf's float tolerance, which alone would pass it through to the POST body.
      [20.000000000000004, 'Send page_size as a whole number, not a fractional one.'],
      [0, 'Too small'],
    ])('rejects page_size %d before any work', async (size, message) => {
      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page_size: size,
      });

      expect(result.isError).toBe(true);
      expect(contractText(result)).toContain(message);
      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it.each([2.5, 20.000000000000004])('reports fractional page_size %d once', async (size) => {
      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page_size: size,
      });

      const { error } = result.structuredContent as {
        error: { message: string; data?: { issues?: unknown[] } };
      };
      expect(error.data?.issues).toHaveLength(1);
      expect(error.message.match(/whole number/g)).toHaveLength(1);
    });

    it('sends page_size 100 for page_size 101 and discloses it on both surfaces', async () => {
      mockTagPage(163, 1, 100);

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page_size: 101,
      });

      expect(mockSearchProducts).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, page_size: 100 }),
        expect.anything(),
      );
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ page_size: 100, last_page: 2, cap: 100, shown: 100 });
      expect(structured.page_size_capped).toBe(
        'page_size 101 is above the 100 results one call returns; this page was served at page_size 100. Pages are counted at that size: request page 2 for results 101–163.',
      );
      const text = contractText(result);
      expect(text).toContain('page_size 101 is above the 100 results one call returns');
      expect(text).toContain('(page 1 of 2, 100 per page, showing 100)');
    });

    it.each([20, 50])('echoes page_size %i without a page_size_capped disclosure', async (size) => {
      mockTagPage(163, 1, size);

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page_size: size,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.page_size).toBe(size);
      expect(structured).not.toHaveProperty('page_size_capped');
      expect(structured.cap).toBe(size);
      expect(contractText(result)).not.toMatch(/results one call returns/);
    });

    it.each<[string, boolean, Record<string, unknown>, Record<string, unknown>]>([
      ['the live tag path', false, { categories_tag: 'en:spreads' }, {}],
      [
        "this server's local copy of the export",
        true,
        { categories_tag: 'en:spreads' },
        { tags_confirmed: true },
      ],
      ['the text path', false, { query: 'spread' }, {}],
    ])(
      'sends page_size 100 on %s with no page_size_capped disclosure',
      async (_label, ready, search, confirmed) => {
        mockMirrorReady.mockResolvedValue(ready);
        mockTagPage(
          163,
          1,
          100,
          ready ? { source: 'off_mirror', mirrorAsOf: '2026-10-31T23:59:59.000Z' } : {},
        );

        const result = await runToolContract(offSearchProductsTool, { ...search, page_size: 100 });

        expect(mockSearchProducts).toHaveBeenCalledWith(
          { ...search, page: 1, page_size: 100, ...confirmed },
          expect.anything(),
        );
        const structured = result.structuredContent as Record<string, unknown>;
        expect(structured).toMatchObject({ page_size: 100, last_page: 2, cap: 100, shown: 100 });
        expect(structured).not.toHaveProperty('page_size_capped');
        const text = contractText(result);
        expect(text).toContain('(page 1 of 2, 100 per page, showing 100)');
        expect(text).not.toMatch(/results one call returns/);
      },
    );

    it('pages an over-cap page_size contiguously at 100, ending on a short page', async () => {
      // 140 matches at page_size 150: page 1 is results 1–100 and page 2 is results 101–140. A
      // rule keyed on the size asked for (150) would put every match on page 1; one keyed on the
      // size served (100) leaves a short page 2.
      mockTagPage(140, 1, 100);
      const first = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page: 1,
        page_size: 150,
      });
      mockTagPage(140, 2, 40);
      const second = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page: 2,
        page_size: 150,
      });

      expect(
        mockSearchProducts.mock.calls.map(([params]) => [params.page, params.page_size]),
      ).toEqual([
        [1, 100],
        [2, 100],
      ]);
      expect(first.structuredContent).toMatchObject({ last_page: 2, truncated: true, cap: 100 });
      expect(
        String((first.structuredContent as Record<string, unknown>).page_size_capped),
      ).toContain('request page 2 for results 101–140');
      const secondOut = second.structuredContent as Record<string, unknown>;
      expect(secondOut).toMatchObject({ page: 2, last_page: 2, page_size: 100, page_count: 40 });
      expect(secondOut).not.toHaveProperty('truncated');
      expect(secondOut.page_size_capped).toBe(
        'page_size 150 is above the 100 results one call returns; this page was served at page_size 100.',
      );
    });

    it('rejects a text page past the window at the served size, hinting page_size 100', async () => {
      const result = await runToolContract(offSearchProductsTool, {
        query: 'chocolate',
        page: 101,
        page_size: 150,
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'page_out_of_range', page: 101, page_size: 100, max_page: 100 } },
      });
      expect(contractHint(result)).toBe(
        'Request page 100 or lower at page_size 100, or add filters so the products you need rank inside the first 10000 results.',
      );
      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it('sends text page 100 at page_size 100 and refuses page 101 with max_page 100', async () => {
      mockSearch({
        count: 12_000,
        page: 100,
        page_count: 100,
        page_size: 100,
        products: [{ code: '1234567890001' }],
      });

      const inside = await runToolContract(offSearchProductsTool, {
        query: 'chocolate',
        page: 100,
        page_size: 100,
      });
      const past = await runToolContract(offSearchProductsTool, {
        query: 'chocolate',
        page: 101,
        page_size: 100,
      });

      expect(inside.isError).toBeFalsy();
      expect(mockSearchProducts).toHaveBeenCalledOnce();
      expect(mockSearchProducts).toHaveBeenCalledWith(
        expect.objectContaining({ page: 100, page_size: 100 }),
        expect.anything(),
      );
      expect(inside.structuredContent).toMatchObject({ last_page: 100, truncated: true });
      expect(past.structuredContent).toMatchObject({
        error: { data: { reason: 'page_out_of_range', page: 101, page_size: 100, max_page: 100 } },
      });
    });

    it('sends page 100 of a text search at page_size 100 for page_size 150', async () => {
      mockSearch({
        count: 12_000,
        page: 100,
        page_count: 100,
        page_size: 100,
        products: [{ code: '1234567890001' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'chocolate',
        page: 100,
        page_size: 150,
      });

      expect(mockSearchProducts).toHaveBeenCalledWith(
        expect.objectContaining({ page: 100, page_size: 100 }),
        expect.anything(),
      );
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ last_page: 100, cap: 100, truncated: true });
      // Page 101 is past the window, so the disclosure names no next page.
      expect(structured.page_size_capped).toBe(
        'page_size 150 is above the 100 results one call returns; this page was served at page_size 100.',
      );
    });

    it.each([100, 150])(
      'names the tag-path reach at page_size 100 for page_size %i past page 10',
      async (size) => {
        const result = await runToolContract(offSearchProductsTool, {
          categories_tag: 'en:pizzas',
          page: 11,
          page_size: size,
        });

        expect(result.structuredContent).toMatchObject({
          error: { data: { reason: 'page_out_of_range', page_size: 100, max_page: 10 } },
        });
        expect(contractHint(result)).toBe(
          'Request page 10 or lower — at page_size 100 that reaches the first 1000 matches — or narrow the filters or change sort_by to bring the products you need forward.',
        );
        expect(mockSearchProducts).not.toHaveBeenCalled();
      },
    );

    it('still rejects predicate lists past their bounds, since dropping entries changes the query', async () => {
      const over = {
        exclude_allergens: Array.from({ length: 15 }, () => 'en:milk'),
        exclude_traces: Array.from({ length: 15 }, () => 'en:nuts'),
        labels_tag: Array.from({ length: 11 }, () => 'en:organic'),
        nutrient_filters: Array.from({ length: 19 }, () => ({
          nutrient: 'sugars',
          operator: 'lt',
          value: 8,
        })),
      };
      for (const [key, value] of Object.entries(over)) {
        expect(offSearchProductsTool.input.safeParse({ [key]: value }).success, key).toBe(false);
      }

      const words = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ');
      const result = await runToolContract(offSearchProductsTool, { query: words });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'query_too_long' } },
      });
      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it('names no next page on a capped page cut by the tag page bound, as its description says', async () => {
      mockTagPage(1001, 10, 100);

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page: 10,
        page_size: 150,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ truncated: true, last_page: 10 });
      expect(structured.page_size_capped).toBe(
        'page_size 150 is above the 100 results one call returns; this page was served at page_size 100.',
      );
      const { page_size_capped } = offSearchProductsTool.enrichment as unknown as Record<
        string,
        { description?: string }
      >;
      expect(page_size_capped?.description).toContain(
        'when a further page holds matches and can be requested',
      );
    });

    it('says what happens above the cap in the page_size description', () => {
      expect(inputDescription('page_size')).toMatch(/served at 100/);
      expect(inputDescription('page_size')).not.toContain('10000');
      expect(inputDescription('page')).toContain(
        'which is at most 100, so repeating one larger page_size pages contiguously (page 2 at page_size 200 is results 101–200)',
      );
      expect(inputDescription('page')).toContain(
        'at page_size 100 it reaches the first 1000 matches',
      );
    });
  });

  // ── #64: rows the whole-number index returned outside the constraints ─────

  describe('rows outside the nutrient constraints (#64)', () => {
    const SUGARS_LTE_3 = [{ nutrient: 'sugars' as const, operator: 'lte' as const, value: 3 }];
    const ONE_ROW = [{ code: '3017620422003', indexed_nutriments: { sugars_100g: 2.5 } }];
    const left = (count: number) =>
      `${count} rows on this page were left off: their indexed values fall outside nutrient_filters. The text index compares some nutrients as whole numbers, so it returns such rows, and total still counts them.`;

    it('reports them on both surfaces beside the rows that stayed, keeping the totals', async () => {
      mockSearch({
        count: 5126,
        page: 1,
        page_count: 13,
        page_size: 30,
        outside_constraints: 17,
        products: ONE_ROW,
      });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'yogurt',
        nutrient_filters: SUGARS_LTE_3,
        page_size: 30,
      });

      expect(result.structuredContent).toMatchObject({
        total: 5126,
        total_is_lower_bound: false,
        last_page: 171,
        page_count: 13,
        outside_constraints: 17,
      });
      expect(result.structuredContent).not.toHaveProperty('omitted');
      const text = contractText(result);
      expect(text).toContain(left(17));
      expect(text).toContain(
        '**5126 whole-number matches** (page 1 of 171, 30 per page, showing 13)',
      );
    });

    it('says 1 row, singular', async () => {
      mockSearch({
        count: 40,
        page: 1,
        page_count: 1,
        page_size: 2,
        outside_constraints: 1,
        products: ONE_ROW,
      });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page_size: 2,
      });

      expect(contractText(result)).toContain(
        '1 row on this page was left off: its indexed value falls outside nutrient_filters. The text index compares some nutrients as whole numbers, so it returns such rows, and total still counts them.',
      );
    });

    it('never claims a lower-bound count of matches on a page that lost rows', async () => {
      mockSearch({
        count: 10_000,
        count_is_exact: false,
        page: 1,
        page_count: 6,
        page_size: 10,
        outside_constraints: 4,
        products: ONE_ROW,
      });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page_size: 10,
      });

      const text = contractText(result);
      expect(text).not.toContain('At least');
      expect(text).toContain('**10000+ whole-number matches**');
      expect(text).toContain(
        '*Open Food Facts stops counting its whole-number answer at 10000 and does not report how many products meet these constraints. Add query or tag filters for an exact count of that answer.*',
      );
    });

    it('names the whole-number answer on a page that lost none, clipped count included', async () => {
      mockSearch({
        count: 10_000,
        count_is_exact: false,
        page: 1,
        page_count: 1,
        page_size: 1,
        products: ONE_ROW,
      });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page_size: 1,
      });

      expect(result.structuredContent).not.toHaveProperty('outside_constraints');
      const text = contractText(result);
      expect(text).toContain('**10000+ whole-number matches**');
      expect(text).toContain(
        '*Open Food Facts stops counting its whole-number answer at 10000 and does not report how many products meet these constraints. Add query or tag filters for an exact count of that answer.*',
      );
      expect(text).not.toContain('At least');
      expect(text).not.toContain('total products');
    });

    it('renders the omitted and outside-constraints lines side by side', async () => {
      mockSearch({
        count: 40,
        page: 1,
        page_count: 1,
        page_size: 5,
        dropped: 2,
        outside_constraints: 2,
        products: ONE_ROW,
      });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page_size: 5,
      });

      expect(result.structuredContent).toMatchObject({ omitted: 2, outside_constraints: 2 });
      const text = contractText(result);
      expect(text).toContain('2 matches on this page were left off');
      expect(text).toContain(left(2));
    });

    it('sends a page that loses every row to the next one, with narrowing advice', async () => {
      mockSearch({
        count: 40,
        page: 2,
        page_count: 0,
        page_size: 5,
        outside_constraints: 5,
        products: [],
      });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page: 2,
        page_size: 5,
      });

      const next =
        'Request page 3 for the next rows, or add query or tag filters to narrow what the index returns.';
      expect(result.structuredContent).toMatchObject({
        products: [],
        page_count: 0,
        last_page: 8,
        outside_constraints: 5,
        truncated: true,
        shown: 0,
        cap: 5,
        notice: `Page 2 lists no products: ${left(5)} ${next}`,
      });
      const body = firstText(
        offSearchProductsTool.format!(
          result.structuredContent as Parameters<
            NonNullable<typeof offSearchProductsTool.format>
          >[0],
        ),
      );
      expect(body).toContain(
        '**Page 2 of 8 lists no products** (40 whole-number matches, 5 per page)',
      );
      expect(body).toContain(left(5));
      expect(body).toContain(next);
      expect(contractText(result)).not.toMatch(/No products found|past the end/);
    });

    it('names no next page on the last page of a counted answer', async () => {
      mockSearch({
        count: 13,
        page: 3,
        page_count: 0,
        page_size: 5,
        outside_constraints: 3,
        products: [],
      });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page: 3,
        page_size: 5,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ last_page: 3, outside_constraints: 3 });
      for (const key of ['truncated', 'shown', 'cap'] as const) {
        expect(structured).not.toHaveProperty(key);
      }
      expect(structured.notice).toBe(
        `Page 3 lists no products: ${left(3)} No further page of matches can be requested.`,
      );
      const text = contractText(result);
      expect(text).not.toContain('Request page 4');
      expect(text).not.toContain('add query or tag filters');
      expect(text).not.toMatch(/No products found|past the end/);
    });

    it('stops at the window on a clipped count, naming filters and no next page', async () => {
      mockSearch({
        count: 10_000,
        count_is_exact: false,
        page: 500,
        page_count: 0,
        page_size: 20,
        outside_constraints: 20,
        products: [],
      });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page: 500,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ truncated: true, outside_constraints: 20 });
      expect(structured).not.toHaveProperty('last_page');
      const stop =
        'No further page of matches can be requested: text search serves only the first 10000 results, so add query or tag filters to bring other rows into them.';
      expect(structured.notice).toBe(`Page 500 lists no products: ${left(20)} ${stop}`);
      // The body, apart from the notice trailer, rebuilds this from the output alone.
      const body = result.content?.[0];
      expect(body?.type === 'text' ? body.text : '').toContain(stop);
      const text = contractText(result);
      expect(text).not.toContain('Request page 501');
      expect(text).not.toContain('At least');
      expect(text).not.toMatch(/No products found|past the end/);
    });

    it('stops at the window where the page size leaves results past it', async () => {
      // 10,000 results at 30 a page fill 334 pages, but only 333 fit the window, so the page a
      // bare division calls next is one the pre-flight check rejects.
      mockSearch({
        count: 10_000,
        count_is_exact: false,
        page: 333,
        page_count: 0,
        page_size: 30,
        outside_constraints: 30,
        products: [],
      });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page: 333,
        page_size: 30,
      });

      const text = contractText(result);
      expect(text).not.toContain('Request page 334');
      expect(text).toContain('text search serves only the first 10000 results');
    });

    it('names a next page the window still allows, on both surfaces', async () => {
      mockSearch({
        count: 10_000,
        count_is_exact: false,
        page: 199,
        page_count: 0,
        page_size: 50,
        outside_constraints: 50,
        products: [],
      });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page: 199,
        page_size: 50,
      });

      const next =
        'Request page 200 for the next rows, or add query or tag filters to narrow what the index returns.';
      expect(String((result.structuredContent as Record<string, unknown>).notice)).toContain(next);
      const body = result.content?.[0];
      expect(body?.type === 'text' ? body.text : '').toContain(next);
    });

    it('reports both counts on a page left empty by unservable and failing rows alike', async () => {
      mockSearch({
        count: 40,
        page: 1,
        page_count: 0,
        page_size: 5,
        dropped: 2,
        outside_constraints: 3,
        products: [],
      });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page_size: 5,
      });

      expect(result.structuredContent).toMatchObject({ omitted: 2, outside_constraints: 3 });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(String(structured.notice)).toMatch(
        /^Page 1 lists no products: 2 matches on this page were left off: .* 3 rows on this page were left off: .* Request page 2 for the next rows, or add query or tag filters/,
      );
      const text = contractText(result);
      expect(text).toContain('**Page 1 of 8 lists no products**');
      expect(text).not.toMatch(/No products found|past the end/);
    });

    it('leaves a page past the end of the answer reading as one', async () => {
      // Characterization: a page beyond the band returns no hits, so nothing left it.
      mockSearch({ count: 163, page: 5, page_count: 0, page_size: 50, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page: 5,
        page_size: 50,
      });

      expect(result.structuredContent).not.toHaveProperty('outside_constraints');
      expect(contractText(result)).toContain('past the end');
    });

    it('does not claim matching products exist past the end of a whole-number answer', async () => {
      mockSearch({ count: 163, page: 5, page_count: 0, page_size: 50, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: SUGARS_LTE_3,
        page: 5,
        page_size: 50,
      });

      const { notice } = result.structuredContent as { notice?: string };
      expect(notice).toBe(
        'Page 5 is past the end of this result set — 163 whole-number matches exist, but no page this deep holds any. Request page 4 or lower to reach them.',
      );
      const text = contractText(result);
      expect(text).toContain(`> ${notice}`);
      expect(text).not.toContain('matching products exist');
      // No row names the constrained nutrient here, so format() keeps its label.
      expect(text).toContain('**Page 5 is past the end of this result set** (163 total products)');
    });

    it('keeps the matching-products claim past the end of a search on a float nutrient', async () => {
      mockSearch({ count: 163, page: 5, page_count: 0, page_size: 50, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: [{ nutrient: 'salt', operator: 'lte', value: 0.1 }],
        page: 5,
        page_size: 50,
      });

      expect((result.structuredContent as { notice?: string }).notice).toBe(
        'Page 5 is past the end of this result set — 163 matching products exist, but no page this deep holds any. Request page 4 or lower to reach them.',
      );
    });

    it('states the row check and its limit in the nutrient_filters description', () => {
      const description = inputDescription('nutrient_filters');

      expect(description).toContain(
        'The text index compares energy-kcal, fat, saturated-fat, carbohydrates, sugars as whole numbers',
      );
      expect(description).toContain('outside_constraints');
      expect(description).toContain('add query or tag filters');
    });

    it('lists the field in the output schema with what total keeps counting', () => {
      const { outside_constraints, total, last_page, total_is_lower_bound } = offSearchProductsTool
        .output.shape as unknown as Record<string, { description?: string }>;

      expect(outside_constraints?.description).toContain('Separate from omitted');
      for (const field of [total, last_page, total_is_lower_bound]) {
        expect(field?.description).toContain('whole-number answer');
      }
    });
  });

  // ── #65: every notice renders as a blockquote in the content[] trailer ────

  describe('notice trailer rendering (#65)', () => {
    /** The blockquote lines of a rendered content[] text. */
    function quoteLines(text: string): string[] {
      return text.split('\n').filter((line) => line.startsWith('> '));
    }

    // Characterization — the truncated path already writes its notice through the kind-tagged
    // helper, so it renders as a blockquote; the fix brings the other notices into line with it.
    it('renders the truncation notice as a blockquote', async () => {
      mockSearch({
        count: 42,
        page: 1,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001', product_name: 'Hummus' }],
      });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page: 1,
        page_size: 20,
      });

      const notice = (result.structuredContent as Record<string, unknown>).notice;
      expect(notice).toBe('Page 1 of 3. Use the page parameter to fetch subsequent pages.');
      const text = contractText(result);
      expect(quoteLines(text)).toEqual([`> ${notice}`]);
      expect(text).not.toContain('**notice:**');
    });

    it('renders the text-path zero-match notice as a blockquote with the query escaped', async () => {
      mockSearch({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'zz`y_*q',
        page: 1,
        page_size: 20,
      });

      // structuredContent echoes the query as sent; the blockquote escapes it.
      const notice = String((result.structuredContent as Record<string, unknown>).notice ?? '');
      expect(notice.startsWith('No products found for query="zz`y_*q". ')).toBe(true);
      expect(notice).toContain('Every word of query must match');

      const text = contractText(result);
      const quoted = quoteLines(text);
      expect(quoted).toHaveLength(1);
      expect(quoted[0]?.startsWith('> No products found for query="zz\\`y\\_\\*q". ')).toBe(true);
      expect(quoted[0]).toContain('Every word of query must match');
      expect(text).not.toContain('**notice:**');
      expect(text).not.toMatch(/`+No products found/);
    });

    it('renders the tag-only zero-match notice as a blockquote with the tag escaped', async () => {
      mockSearch({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:x_*y',
        page: 1,
        page_size: 20,
      });

      const notice = (result.structuredContent as Record<string, unknown>).notice;
      expect(notice).toBe(
        'No products found for category="en:x_*y". Try broader terms, check tag IDs via off_browse_taxonomy, or remove some filters.',
      );
      const text = contractText(result);
      expect(quoteLines(text)).toEqual([
        '> No products found for category="en:x\\_\\*y". Try broader terms, check tag IDs via off_browse_taxonomy, or remove some filters.',
      ]);
      expect(text).not.toContain('**notice:**');
    });

    it('renders the past-the-end notice as a blockquote', async () => {
      mockSearch({ count: 163, page: 5, page_count: 0, page_size: 50, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:hummus',
        page: 5,
        page_size: 50,
      });

      const notice = (result.structuredContent as Record<string, unknown>).notice;
      expect(notice).toBe(
        'Page 5 is past the end of this result set — 163 matching products exist, but no page this deep holds any. Request page 4 or lower to reach them.',
      );
      const text = contractText(result);
      expect(quoteLines(text)).toEqual([`> ${notice}`]);
      expect(text).not.toContain('**notice:**');
    });

    it('renders the past-the-end notice of a clipped count as a blockquote', async () => {
      mockSearch({
        count: 10000,
        count_is_exact: false,
        page: 500,
        page_count: 0,
        page_size: 20,
        products: [],
      });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'chocolate',
        page: 500,
        page_size: 20,
      });

      const notice = String((result.structuredContent as Record<string, unknown>).notice ?? '');
      expect(notice).toMatch(/^Page 500 is past the end .* no exact last page/);
      const text = contractText(result);
      expect(quoteLines(text)).toEqual([`> ${notice}`]);
      expect(text).not.toContain('**notice:**');
    });

    it('renders the all-omitted final-page notice as a blockquote', async () => {
      mockSearch({ count: 1, page: 1, page_count: 0, page_size: 5, dropped: 1, products: [] });

      const result = await runToolContract(offSearchProductsTool, {
        query: 'miel',
        page: 1,
        page_size: 5,
      });

      const notice = String((result.structuredContent as Record<string, unknown>).notice ?? '');
      expect(notice).toMatch(
        /^Page 1 lists no products: .* No further page of matches can be requested\.$/,
      );
      const text = contractText(result);
      expect(quoteLines(text)).toEqual([`> ${notice}`]);
      expect(text).not.toContain('**notice:**');
    });
  });

  it('describes the full Nutri-Score and Green-Score vocabularies (#43)', () => {
    const row = offSearchProductsTool.output.shape.products.element.shape;
    for (const term of ['"unknown"', '"not-applicable"']) {
      expect(row.nutriscore_grade.description).toContain(term);
    }
    for (const term of ['"a-plus"', '"f"', '"unknown"', '"not-applicable"']) {
      expect(row.ecoscore_grade.description).toContain(term);
    }
  });

  // ── #85: any-of grade filters and the Green-Score filter ─────────────────

  describe('grade filters (#85)', () => {
    const AS_OF = '2026-10-31T23:59:59.000Z';
    const TAG_ONLY_EMPTY_NOTICE =
      'No products found for category="en:breakfast-cereals", nutriscore="b", nova="3". Try broader terms, check tag IDs via off_browse_taxonomy, or remove some filters.';
    const TEXT_EMPTY_NOTICE =
      'No products found for query="muesli", nutriscore="b", nova="3". Every word of query must match — in a product name, generic name, category, label, or brand — so one word no product carries empties the result; drop or change words the product may not carry. The text index may not hold recently contributed products, so an empty result here does not settle whether a matching product has been contributed: re-run the same tag filters without query to read the live database or this server\'s local copy of the export, or call off_get_product when the barcode is known.';
    const INDEX_NOTE =
      'These results come from the text-search index, a snapshot that lags the live Open Food Facts database, so a recently contributed product can be missing from them.';
    const SNAPSHOT_LEAD = `${INDEX_NOTE} The same tag filters without query read the live database or this server's local copy of the export where it keeps one (source and mirror_as_of say which).`;
    /** The grade sentence of a text search's snapshot note, after its "The … filter was" subject. */
    const GRADES_MATCHED =
      'matched against the grades this index holds, which each row shows; off_get_product returns the current record, whose grades can differ.';
    const EMPTY = { count: 0, page: 1, page_count: 0, page_size: 20, products: [] };

    /** One run through the contract runner: what the service was handed and both surfaces. */
    async function run(input: Record<string, unknown>) {
      mockSearchProducts.mockClear();
      const result = await runToolContract(offSearchProductsTool, input);
      return {
        params: mockSearchProducts.mock.calls[0]?.[0],
        structured: result.structuredContent as Record<string, unknown>,
        text: contractText(result),
        isError: result.isError,
      };
    }

    describe('a single grade, as before', () => {
      it('sends a tag-only search to the live database with each grade as given and echoes each', async () => {
        mockSearch({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

        const { params, structured, text } = await run({
          categories_tag: 'en:breakfast-cereals',
          nutrition_grade: 'b',
          nova_group: '3',
          page: 1,
          page_size: 20,
        });

        expect(params).toEqual({
          page: 1,
          page_size: 20,
          categories_tag: 'en:breakfast-cereals',
          nutrition_grade: 'b',
          nova_group: '3',
        });
        expect(structured).toEqual({
          total: 0,
          total_is_lower_bound: false,
          page: 1,
          page_size: 20,
          page_count: 0,
          source: 'off_api',
          products: [],
          notice: TAG_ONLY_EMPTY_NOTICE,
        });
        expect(text).toBe(
          `**No products found** (total: 0)\n\nTry broadening the search terms or checking tag IDs via off_browse_taxonomy.\n\n**Source:** off_api (Open Food Facts)\n\n\n> ${TAG_ONLY_EMPTY_NOTICE}`,
        );
      });

      it('flags a tag-only grade search confirmed for a ready mirror and serves it from there', async () => {
        mockMirrorReady.mockResolvedValue(true);
        mockSearch({
          source: 'off_mirror',
          mirrorAsOf: AS_OF,
          count: 2,
          page: 1,
          page_count: 1,
          page_size: 20,
          products: [{ code: '1234567890001', nutriscore_grade: 'b', nova_group: 3 }],
        });

        const { params, structured } = await run({
          nutrition_grade: 'b',
          nova_group: '3',
          page: 1,
          page_size: 20,
        });

        expect(params).toEqual({
          page: 1,
          page_size: 20,
          nutrition_grade: 'b',
          nova_group: '3',
          tags_confirmed: true,
        });
        expect(structured).toMatchObject({
          total: 2,
          source: 'off_mirror',
          mirror_as_of: AS_OF,
          products: [{ barcode: '1234567890001', nutriscore_grade: 'b', nova_group: 3 }],
        });
        expect(mockSuggestTaxonomy).not.toHaveBeenCalled();
      });

      it('sends a text search with each grade as given and echoes each among the text-path causes', async () => {
        mockSearch({ count: 0, page: 1, page_count: 0, page_size: 20, products: [] });

        const { params, structured } = await run({
          query: 'muesli',
          nutrition_grade: 'b',
          nova_group: '3',
          page: 1,
          page_size: 20,
        });

        expect(params).toEqual({
          page: 1,
          page_size: 20,
          query: 'muesli',
          nutrition_grade: 'b',
          nova_group: '3',
        });
        expect(structured.notice).toBe(TEXT_EMPTY_NOTICE);
        expect(structured.text_index_snapshot).toBe(
          `${SNAPSHOT_LEAD} The nutrition_grade and nova_group filters were ${GRADES_MATCHED}`,
        );
      });
    });

    describe('several grades, any of them', () => {
      it.each([
        ['read live', false, {}],
        ['served from a ready mirror', true, {}],
        ['on the text path', false, { query: 'muesli' }],
      ])(
        'sends a one-element or repeated array as the scalar and answers alike, %s',
        async (_label, ready, extra) => {
          mockMirrorReady.mockResolvedValue(ready);
          mockMirrorIndexesGreenScore.mockResolvedValue(true);
          mockSearch(ready ? { ...EMPTY, source: 'off_mirror', mirrorAsOf: AS_OF } : EMPTY);

          const runs = [];
          for (const grades of [
            { nutrition_grade: 'b', nova_group: '3', ecoscore_grade: 'a-plus' },
            { nutrition_grade: ['b'], nova_group: ['3'], ecoscore_grade: ['a-plus'] },
            {
              nutrition_grade: ['b', 'b'],
              nova_group: ['3', '3'],
              ecoscore_grade: ['a-plus', 'a-plus'],
            },
          ]) {
            runs.push(await run({ ...extra, ...grades, page: 1, page_size: 20 }));
          }
          const [scalar, ...arrays] = runs;

          expect(scalar?.params).toMatchObject({
            nutrition_grade: 'b',
            nova_group: '3',
            ecoscore_grade: 'a-plus',
          });
          for (const array of arrays) expect(array).toEqual(scalar);
        },
      );

      it.each([
        ['read live', false, {}],
        ['served from a ready mirror that indexes Green-Score', true, { tags_confirmed: true }],
      ])(
        'hands several grades to the service as arrays in caller order, each once, %s',
        async (_label, ready, confirmed) => {
          mockMirrorReady.mockResolvedValue(ready);
          mockMirrorIndexesGreenScore.mockResolvedValue(true);
          mockSearch(EMPTY);

          const { params } = await run({
            nutrition_grade: ['b', 'a', 'b'],
            nova_group: ['2', '1'],
            ecoscore_grade: ['a-plus', 'a'],
            page: 1,
            page_size: 20,
          });

          expect(params).toEqual({
            page: 1,
            page_size: 20,
            nutrition_grade: ['b', 'a'],
            nova_group: ['2', '1'],
            ecoscore_grade: ['a-plus', 'a'],
            ...confirmed,
          });
        },
      );

      it.each([
        { nutrition_grade: [] },
        { nova_group: [] },
        { ecoscore_grade: [] },
        { nutrition_grade: [], nova_group: [], ecoscore_grade: [] },
      ])('refuses %j alone as no_filters, sending nothing', async (grades) => {
        const result = await runToolContract(offSearchProductsTool, {
          ...grades,
          page: 1,
          page_size: 20,
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { data: { reason: 'no_filters' } },
        });
        expect(mockSearchProducts).not.toHaveBeenCalled();
      });

      it('names ecoscore_grade in the no_filters recovery on both surfaces', async () => {
        const result = await runToolContract(offSearchProductsTool, { page: 1, page_size: 20 });

        expect(contractHint(result)).toContain('nutrition_grade, nova_group, ecoscore_grade, or');
        expect(contractText(result)).toContain('ecoscore_grade');
      });

      it('treats empty grade arrays beside a query as no grade filter', async () => {
        mockSearch(EMPTY);

        const { params, structured } = await run({
          query: 'muesli',
          nutrition_grade: [],
          ecoscore_grade: [],
          page: 1,
          page_size: 20,
        });

        expect(params).toEqual({ page: 1, page_size: 20, query: 'muesli' });
        expect(structured.text_index_snapshot).toBe(
          `${INDEX_NOTE} A search by tag filters alone, without query, reads the live database or this server's local copy of the export where it keeps one (source and mirror_as_of say which).`,
        );
        expect(String(structured.notice)).toMatch(/^No products found for query="muesli"\. /);
        expect(String(structured.notice)).toContain('try expressing the product as tag filters');
      });

      it('echoes several grades as any of them on both surfaces, a single grade as before', async () => {
        mockSearch(EMPTY);

        const { structured, text } = await run({
          nutrition_grade: ['a', 'b'],
          nova_group: '1',
          ecoscore_grade: ['a-plus', 'a'],
          page: 1,
          page_size: 20,
        });

        const notice =
          'No products found for nutriscore="a" or "b", nova="1", ecoscore="a-plus" or "a". Try broader terms, check tag IDs via off_browse_taxonomy, or remove some filters.';
        expect(structured.notice).toBe(notice);
        expect(text).toContain(`> ${notice}`);
      });

      it('echoes several grades as any of them among the text-path causes', async () => {
        mockSearch(EMPTY);

        const { structured } = await run({
          query: 'muesli',
          nutrition_grade: ['a', 'b'],
          page: 1,
          page_size: 20,
        });

        expect(String(structured.notice)).toMatch(
          /^No products found for query="muesli", nutriscore="a" or "b"\. Every word/,
        );
      });

      it.each<[Record<string, unknown>, string]>([
        [{ nutrition_grade: ['a', 'b'] }, 'The nutrition_grade filter was'],
        [
          { nutrition_grade: 'a', ecoscore_grade: ['a', 'a-plus'] },
          'The nutrition_grade and ecoscore_grade filters were',
        ],
        [
          { nutrition_grade: 'a', nova_group: '1', ecoscore_grade: 'a' },
          'The nutrition_grade, nova_group, and ecoscore_grade filters were',
        ],
      ])(
        "says on a text search carrying %j that the grades matched and shown are the index's",
        async (grades, lead) => {
          mockSearch(EMPTY);

          const { structured, text } = await run({
            query: 'muesli',
            ...grades,
            page: 1,
            page_size: 20,
          });

          expect(structured.text_index_snapshot).toBe(`${SNAPSHOT_LEAD} ${lead} ${GRADES_MATCHED}`);
          expect(text).toContain('matched against the grades this index holds');
        },
      );

      it('puts the grade sentence before the nutrient constraints it sits beside', async () => {
        mockSearch(EMPTY);

        const { structured } = await run({
          nutrient_filters: [{ nutrient: 'proteins', operator: 'gte', value: 5 }],
          ecoscore_grade: 'a',
          page: 1,
          page_size: 20,
        });

        expect(structured.text_index_snapshot).toBe(
          `${INDEX_NOTE} Nutrient constraints are served only by this index, so no form of this search reads the live database. The ecoscore_grade filter was ${GRADES_MATCHED} The nutrient constraints (proteins >= 5) were checked against these index values, shown on each row as indexed_nutriments; off_get_product returns the current record, whose values can differ.`,
        );
      });

      it('accepts one grade or an array of them and rejects any other value', () => {
        const accepts = (grades: Record<string, unknown>) =>
          offSearchProductsTool.input.safeParse({ ...grades, page: 1, page_size: 20 }).success;

        for (const good of [
          { ecoscore_grade: 'a-plus' },
          { ecoscore_grade: ['a-plus', 'a', 'b', 'c', 'd', 'e', 'f'] },
          { nutrition_grade: ['a', 'b', 'c', 'd', 'e'] },
          { nova_group: ['1', '2', '3', '4'] },
        ]) {
          expect(accepts(good), JSON.stringify(good)).toBe(true);
        }
        for (const bad of [
          { ecoscore_grade: 'unknown' },
          { ecoscore_grade: 'A' },
          { ecoscore_grade: '' },
          { ecoscore_grade: ['a', 'g'] },
          { ecoscore_grade: ['a-plus', 'a', 'b', 'c', 'd', 'e', 'f', 'a'] },
          { nutrition_grade: 'f' },
          { nutrition_grade: ['a', 'b', 'c', 'd', 'e', 'a'] },
          { nova_group: '5' },
          { nova_group: 4 },
        ]) {
          expect(accepts(bad), JSON.stringify(bad)).toBe(false);
        }
      });

      it('describes each grade input as any-of against labels_tag, and the Green-Score scale and filed grade', () => {
        for (const field of ['nutrition_grade', 'nova_group', 'ecoscore_grade']) {
          expect(inputDescription(field), field).toContain('unlike labels_tag');
        }
        expect(inputDescription('ecoscore_grade')).toContain('"a" does not include "a-plus"');
        expect(inputDescription('ecoscore_grade')).toContain('France');
      });
    });

    describe('the Green-Score gate', () => {
      it('serves a Green-Score search from a ready mirror whose last full load indexed it', async () => {
        mockMirrorReady.mockResolvedValue(true);
        mockMirrorIndexesGreenScore.mockResolvedValue(true);
        mockSearch({
          source: 'off_mirror',
          mirrorAsOf: AS_OF,
          count: 56,
          page: 1,
          page_count: 1,
          page_size: 20,
          products: [{ code: '1234567890001', ecoscore_grade: 'a' }],
        });

        const { params, structured } = await run({
          ecoscore_grade: ['a', 'a-plus'],
          page: 11,
          page_size: 1,
        });

        expect(params).toEqual({
          page: 11,
          page_size: 1,
          ecoscore_grade: ['a', 'a-plus'],
          tags_confirmed: true,
        });
        expect(structured).toMatchObject({ total: 56, source: 'off_mirror', mirror_as_of: AS_OF });
        expect(mockMirrorIndexesGreenScore).toHaveBeenCalledOnce();
      });

      it('reads a Green-Score search live, as with no mirror, until the mirror indexes it', async () => {
        mockSearch(EMPTY);
        const input = { nutrition_grade: 'a', ecoscore_grade: 'a', page: 1, page_size: 20 };

        const noMirror = await run(input);
        mockMirrorReady.mockResolvedValue(true);
        const unindexed = await run(input);

        expect(unindexed.params).toEqual({
          page: 1,
          page_size: 20,
          nutrition_grade: 'a',
          ecoscore_grade: 'a',
        });
        expect(unindexed).toEqual(noMirror);
        expect(mockMirrorIndexesGreenScore).toHaveBeenCalledOnce();
      });

      it('looks nothing up for a Green-Score search the mirror cannot serve yet', async () => {
        mockMirrorReady.mockResolvedValue(true);
        mockSearch(EMPTY);

        const { params } = await run({
          categories_tag: 'Dark chocolates',
          ecoscore_grade: 'a',
          page: 1,
          page_size: 20,
        });

        expect(params).toEqual({
          page: 1,
          page_size: 20,
          categories_tag: 'Dark chocolates',
          ecoscore_grade: 'a',
        });
        expect(mockSuggestTaxonomy).not.toHaveBeenCalled();
      });

      it('refuses page 11 of a Green-Score search the mirror cannot serve yet, naming ecoscore_grade on both surfaces', async () => {
        mockMirrorReady.mockResolvedValue(true);

        const result = await runToolContract(offSearchProductsTool, {
          categories_tag: 'Dark chocolates',
          ecoscore_grade: ['a', 'a-plus'],
          page: 11,
          page_size: 20,
        });

        const message =
          "A search by tag filters alone is served through page 10 only when it reads the live database, and page 11 was requested: this server's local copy of the export serves a search carrying ecoscore_grade only once a full reload has indexed Green-Score, and that reload has not completed.";
        const hint =
          "Request page 10 or lower — at page_size 20 that reaches the first 200 matches — or retry once this server's local copy of the export completes the full reload that indexes Green-Score. Without ecoscore_grade, the copy serves pages past 10 of a search whose every value it confirms.";
        const { error } = result.structuredContent as { error: { message: string; data: unknown } };
        expect(result.isError).toBe(true);
        expect(error.message).toBe(message);
        expect(error.data).toEqual({
          reason: 'page_out_of_range',
          page: 11,
          page_size: 20,
          max_page: 10,
          recovery: { hint },
          retryable: false,
        });
        expect(contractText(result)).toContain(message);
        expect(contractText(result)).toContain(hint);
        expect(mockSearchProducts).not.toHaveBeenCalled();
        expect(mockSuggestTaxonomy).not.toHaveBeenCalled();
      });

      it('refuses page 11 of a Green-Score search with no ready mirror by the live bound alone', async () => {
        const result = await runToolContract(offSearchProductsTool, {
          ecoscore_grade: 'a',
          page: 11,
          page_size: 20,
        });

        expect(result.structuredContent).toMatchObject({
          error: {
            message:
              'A search by tag filters alone is served through page 10 only, and page 11 was requested.',
          },
        });
        expect(mockMirrorIndexesGreenScore).not.toHaveBeenCalled();
      });

      it('asks about Green-Score only for a tag-only search carrying ecoscore_grade', async () => {
        mockMirrorReady.mockResolvedValue(true);
        mockSearch(EMPTY);

        await run({ nutrition_grade: 'a', page: 1, page_size: 20 });
        await run({ query: 'muesli', ecoscore_grade: 'a', page: 1, page_size: 20 });
        await run({ ecoscore_grade: [], nova_group: '1', page: 1, page_size: 20 });

        expect(mockMirrorIndexesGreenScore).not.toHaveBeenCalled();
        expect(mockMirrorReady).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ── #88: the ingredient filter, served by the text index ─────────────────

  describe('ingredient filter (#88)', () => {
    const INDEX_NOTE =
      'These results come from the text-search index, a snapshot that lags the live Open Food Facts database, so a recently contributed product can be missing from them.';
    const ONLY_HERE = 'This server answers ingredients_tag only from this index.';
    const LIVE_COPY =
      "the live database or this server's local copy of the export where it keeps one (source and mirror_as_of say which).";
    const EMPTY = { count: 0, page: 1, page_count: 0, page_size: 20, products: [] };
    /** The live ingredient taxonomy's answer per term (taxonomy_names=ingredient, 2026-11-08). */
    const INGREDIENT_OPTIONS = new Map([
      ['inulin', [{ id: 'en:inulin', name: 'inulin' }]],
      [
        'oat',
        [
          { id: 'en:oat', name: 'Oat' },
          { id: 'en:oat-fibre', name: 'Oat fibre' },
        ],
      ],
    ]);

    beforeEach(() => {
      mockSuggestTaxonomy.mockImplementation(async (taxonomy: string, term: string) =>
        taxonomy === 'ingredient' ? (INGREDIENT_OPTIONS.get(term) ?? []) : [],
      );
    });

    /** One run through the contract runner: what the service was handed and both surfaces. */
    async function run(input: Record<string, unknown>) {
      mockSearchProducts.mockClear();
      const result = await runToolContract(offSearchProductsTool, {
        page: 1,
        page_size: 20,
        ...input,
      });
      return {
        params: mockSearchProducts.mock.calls[0]?.[0],
        structured: result.structuredContent as Record<string, unknown>,
        text: contractText(result),
        hint: contractHint(result),
        isError: result.isError,
      };
    }

    it('resolves a value against the ingredient taxonomy and hands it over canonical, never asking about the mirror', async () => {
      mockMirrorReady.mockResolvedValue(true);
      mockSearch(EMPTY);

      const { params } = await run({ ingredients_tag: 'inulin' });

      expect(params).toEqual({ page: 1, page_size: 20, ingredients_tag: 'en:inulin' });
      expect(mockSuggestTaxonomy).toHaveBeenCalledWith(
        'ingredient',
        'inulin',
        expect.anything(),
        expect.any(Number),
      );
      expect(mockMirrorReady).not.toHaveBeenCalled();
      expect(mockMirrorIndexesGreenScore).not.toHaveBeenCalled();
    });

    it('hands an array over as an array in caller order, even of one, as labels_tag does', async () => {
      mockSearch(EMPTY);

      const both = await run({ ingredients_tag: ['inulin', 'en:oat'] });
      const one = await run({ ingredients_tag: ['inulin'] });

      expect(both.params).toEqual({
        page: 1,
        page_size: 20,
        ingredients_tag: ['en:inulin', 'en:oat'],
      });
      expect(one.params).toEqual({ page: 1, page_size: 20, ingredients_tag: ['en:inulin'] });
    });

    it('sends a page past 10 of a search without query, which the text index serves', async () => {
      mockSearch({
        count: 232,
        page: 11,
        page_count: 1,
        page_size: 20,
        products: [{ code: '1234567890001' }],
      });

      const { params, structured, isError } = await run({
        categories_tag: 'en:breakfast-cereals',
        ingredients_tag: 'en:inulin',
        page: 11,
      });

      expect(isError).toBeFalsy();
      expect(params).toEqual({
        page: 11,
        page_size: 20,
        categories_tag: 'en:breakfast-cereals',
        ingredients_tag: 'en:inulin',
      });
      expect(structured).toMatchObject({ source: 'off_api', last_page: 12, truncated: true });
    });

    it('refuses a page past the text window, before any lookup or search', async () => {
      const { structured } = await run({ ingredients_tag: 'en:inulin', page: 101, page_size: 100 });

      expect(structured).toMatchObject({
        error: {
          data: {
            reason: 'page_out_of_range',
            page: 101,
            page_size: 100,
            max_page: 100,
            result_window: 10_000,
          },
        },
      });
      expect(mockSuggestTaxonomy).not.toHaveBeenCalled();
      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it('refuses additives_tag beside it, naming ingredients_tag on both surfaces, sending nothing', async () => {
      const message =
        'additives_tag filters only on searches the tag backend answers — a query, a nutrient constraint, or an ingredient filter moves the search to a backend with no additives field, so pairing them would match nothing regardless of the additive.';
      const hint =
        'Drop query, nutrient_filters, and ingredients_tag to search by tags alone and keep the additive filter, or drop additives_tag to keep them. Every other filter combines freely.';

      const {
        structured,
        text,
        hint: sentHint,
      } = await run({
        ingredients_tag: 'en:inulin',
        additives_tag: 'en:e322',
      });

      expect(structured).toMatchObject({
        error: {
          message,
          data: { reason: 'additives_filter_needs_tag_search', additives_tag: 'en:e322' },
        },
      });
      expect(sentHint).toBe(hint);
      expect(text).toContain(message);
      expect(text).toContain(hint);
      expect(mockSuggestTaxonomy).not.toHaveBeenCalled();
      expect(mockSearchProducts).not.toHaveBeenCalled();
    });

    it.each<[string, Record<string, unknown>, string]>([
      [
        'other tag filters',
        { categories_tag: 'en:breakfast-cereals' },
        `The same tag filters without ingredients_tag read ${LIVE_COPY}`,
      ],
      [
        'other tag filters and query',
        { query: 'muesli', labels_tag: 'en:organic' },
        `The same tag filters without ingredients_tag and query read ${LIVE_COPY}`,
      ],
      [
        'no other tag filter',
        {},
        `A search by tag filters alone, without ingredients_tag, reads ${LIVE_COPY}`,
      ],
      [
        'query and no other tag filter',
        { query: 'muesli' },
        `A search by tag filters alone, without ingredients_tag and query, reads ${LIVE_COPY}`,
      ],
    ])(
      'says on a search carrying %s that dropping ingredients_tag reaches the live database',
      async (_label, search, route) => {
        mockSearch(EMPTY);

        const { structured, text } = await run({ ...search, ingredients_tag: 'en:inulin' });

        expect(structured.text_index_snapshot).toBe(`${INDEX_NOTE} ${ONLY_HERE} ${route}`);
        expect(text).toContain(
          '**Index freshness:** These results come from the text-search index',
        );
        expect(text).toContain('This server answers ingredients');
      },
    );

    it('keeps the nutrient wording on a search carrying nutrient_filters too', async () => {
      mockSearch(EMPTY);

      const { structured } = await run({
        ingredients_tag: 'en:inulin',
        nutrient_filters: [{ nutrient: 'proteins', operator: 'gte', value: 5 }],
      });

      expect(structured.text_index_snapshot).toBe(
        `${INDEX_NOTE} Nutrient constraints are served only by this index, so no form of this search reads the live database. The nutrient constraints (proteins >= 5) were checked against these index values, shown on each row as indexed_nutriments; off_get_product returns the current record, whose values can differ.`,
      );
    });

    it('sends grade arrays beside it to the text index, with the grade sentence and no Green-Score check', async () => {
      mockMirrorReady.mockResolvedValue(true);
      mockSearch(EMPTY);

      const { params, structured } = await run({
        ingredients_tag: 'en:inulin',
        nutrition_grade: ['a', 'b'],
        ecoscore_grade: 'a',
      });

      expect(params).toEqual({
        page: 1,
        page_size: 20,
        ingredients_tag: 'en:inulin',
        nutrition_grade: ['a', 'b'],
        ecoscore_grade: 'a',
      });
      expect(structured.text_index_snapshot).toBe(
        `${INDEX_NOTE} ${ONLY_HERE} The same tag filters without ingredients_tag read ${LIVE_COPY} The nutrition_grade and ecoscore_grade filters were matched against the grades this index holds, which each row shows; off_get_product returns the current record, whose grades can differ.`,
      );
      expect(mockMirrorReady).not.toHaveBeenCalled();
      expect(mockMirrorIndexesGreenScore).not.toHaveBeenCalled();
    });

    it('echoes each value on an empty result, naming the one sent unconfirmed, on both surfaces', async () => {
      mockSearch(EMPTY);

      const { structured, text } = await run({
        categories_tag: 'en:breakfast-cereals',
        ingredients_tag: ['inulin', 'oats'],
      });

      const notice =
        'No products found for category="en:breakfast-cereals", ingredient="inulin", ingredient="oats". Tag values are matched exactly on this path: ingredient="oats" was sent as "en:oats" (no matching Open Food Facts tag was found). Check tag IDs via off_browse_taxonomy. The text index may not hold recently contributed products, so an empty result here does not settle whether a matching product has been contributed: re-run the same tag filters without ingredients_tag to read the live database or this server\'s local copy of the export, or call off_get_product when the barcode is known.';
      expect(structured.notice).toBe(notice);
      expect(text).toContain('> No products found for category="en:breakfast-cereals"');
      expect(text).toContain('was sent as "en:oats"');
    });

    it('advises tag filters on an empty result with no other tag filter', async () => {
      mockSearch(EMPTY);

      const { structured } = await run({ query: 'muesli', ingredients_tag: 'en:inulin' });

      expect(String(structured.notice)).toMatch(
        /^No products found for query="muesli", ingredient="en:inulin"\. /,
      );
      expect(String(structured.notice)).toContain(
        ": a search without ingredients_tag and query reads the live database or this server's local copy of the export, so try expressing the product as tag filters instead (off_browse_taxonomy resolves them), or call off_get_product when the barcode is known.",
      );
    });

    it.each([{ ingredients_tag: [] }, { ingredients_tag: ['  ', ''] }, { ingredients_tag: '' }])(
      'refuses %j alone as no_filters, sending nothing',
      async (input) => {
        const { structured } = await run(input);

        expect(structured).toMatchObject({ error: { data: { reason: 'no_filters' } } });
        expect(mockSuggestTaxonomy).not.toHaveBeenCalled();
        expect(mockSearchProducts).not.toHaveBeenCalled();
      },
    );

    it('names ingredients_tag in the no_filters recovery on both surfaces', async () => {
      const { hint, text } = await run({});

      expect(hint).toContain('ingredients_analysis_tag, ingredients_tag, additives_tag');
      expect(text).toContain('ingredients_tag');
    });

    it('takes one ID or up to 10, and rejects 11', () => {
      const accepts = (ingredients_tag: unknown) =>
        offSearchProductsTool.input.safeParse({ ingredients_tag }).success;

      expect(accepts('en:inulin')).toBe(true);
      expect(accepts(Array.from({ length: 10 }, (_, i) => `en:x${i}`))).toBe(true);
      expect(accepts(Array.from({ length: 11 }, (_, i) => `en:x${i}`))).toBe(false);
      expect(accepts(3)).toBe(false);
    });

    it('points at the ingredients facet, and at ingredients_analysis_tag for verdicts', () => {
      const description = inputDescription('ingredients_tag');

      expect(description).toContain('off_browse_taxonomy with facet="ingredients"');
      expect(description).toContain('use ingredients_analysis_tag');
      expect(description).toContain('singular');
      expect(inputDescription('additives_tag')).toContain('ingredients_tag');
      expect(offSearchProductsTool.description).toContain('ingredients_tag');
    });
  });
});

// ── #79: the local mirror end to end ─────────────────────────────────────────

/**
 * The tool over the real Open Food Facts client, taxonomy service, and mirror store, against a
 * store at `OFF_MIRROR_PATH` written through the real write path (record builder, tag ids, the
 * store's batch upsert), with every upstream request answered by a stubbed fetch and recorded.
 * Modules are re-imported per test so the store path and the serving store's handle are fresh.
 */
describe('off_search_products on a local mirror, end to end (#79)', () => {
  const AS_OF = '2026-10-31T23:59:59.000Z';
  const globalFetch = global.fetch;
  const NOVA_4 = ['en:4-ultra-processed-food-and-drink-products'];
  const NOVA_3 = ['en:3-processed-foods'];

  /** A schema 1004 export line of a Nutella jar sold in France; `n` makes its 13-digit code. */
  function jar(n: number, fields: Record<string, unknown>): Record<string, unknown> {
    return {
      code: `50000000000${String(n).padStart(2, '0')}`,
      schema_version: 1004,
      lc: 'en',
      product_name: `Jar ${n}`,
      brands: 'Nutella',
      brands_tags: ['xx:nutella'],
      countries_tags: ['en:france'],
      categories_tags: ['en:spreads'],
      ...fields,
    };
  }

  /**
   * Twelve Nutella jars and one other brand. popularity_key ties at 100 (jars 3 and 4), and jar 12
   * has none; jars 1, 3, and 5 carry both labels, jars 1 and 2 declare milk, and jars 1–6 plus
   * the other brand are NOVA 4.
   */
  const LINES = [
    jar(1, {
      popularity_key: 120,
      labels_tags: ['en:organic', 'en:fair-trade'],
      allergens_tags: ['en:milk'],
      nova_groups_tags: NOVA_4,
    }),
    jar(2, {
      popularity_key: 110,
      labels_tags: ['en:organic'],
      allergens_tags: ['en:milk'],
      nova_groups_tags: NOVA_4,
    }),
    jar(3, {
      popularity_key: 100,
      labels_tags: ['en:organic', 'en:fair-trade'],
      nova_groups_tags: NOVA_4,
    }),
    jar(4, { popularity_key: 100, nova_groups_tags: NOVA_4 }),
    jar(5, {
      popularity_key: 90,
      labels_tags: ['en:fair-trade', 'en:organic'],
      nova_groups_tags: NOVA_4,
    }),
    jar(6, {
      popularity_key: 80,
      categories_tags: ['en:spreads', 'en:hazelnut-spreads'],
      nova_groups_tags: NOVA_4,
    }),
    jar(7, { popularity_key: 70, nova_groups_tags: NOVA_3 }),
    jar(8, { popularity_key: 60, nova_groups_tags: NOVA_3 }),
    jar(9, { popularity_key: 50, nova_groups_tags: NOVA_3 }),
    jar(10, { popularity_key: 40, nova_groups_tags: NOVA_3 }),
    jar(11, { popularity_key: 30, nova_groups_tags: NOVA_3 }),
    jar(12, { nova_groups_tags: NOVA_3 }),
    jar(13, {
      popularity_key: 200,
      brands: 'Ferrero',
      brands_tags: ['xx:ferrero'],
      nova_groups_tags: NOVA_4,
    }),
  ];
  const code = (n: number) => `50000000000${String(n).padStart(2, '0')}`;

  let dir: string;
  /** Host and path of every upstream request, in order. */
  let requests: string[];
  let tool: typeof import('@/mcp-server/tools/definitions/search-products.tool.js')['offSearchProductsTool'];
  let closeStore: (() => Promise<void>) | undefined;

  /**
   * Writes `lines` into a store at `path` as a sync page does; `completed` marks the sync done.
   * `load` stamps the rows at `rowVersion` and records a full load built at `loadVersion`; without
   * it rows are version 1 and no full load is recorded.
   */
  async function writeStore(
    path: string,
    lines: Record<string, unknown>[],
    completed: boolean,
    load?: { loadVersion: number; rowVersion: number },
  ) {
    const writer = openMirrorStore(path);
    try {
      const handle = await writer.raw();
      const records = lines.map((line) => {
        const record = buildMirrorRecord(line);
        if (!record) throw new Error(`Line ${String(line.code)} is not servable`);
        return record;
      });
      const ids = new TagIds().resolve(handle, new Set(records.flatMap((record) => record.tags)));
      await writer.applyBatch(
        records.map((record) => ({
          code: record.code,
          popularity_key: record.popularityKey,
          unique_scans_n: record.uniqueScansN,
          created_t: record.createdT,
          last_modified_t: record.lastModifiedT,
          generation: 1,
          record_version: load?.rowVersion ?? 1,
          tag_ids: JSON.stringify(
            [...new Set(record.tags.map((key) => ids.get(key) as number))].sort((a, b) => a - b),
          ),
          doc: JSON.stringify(record.doc),
        })),
        [],
      );
      if (load) {
        writeMirrorLoad(handle, {
          generation: 1,
          loadedAt: AS_OF,
          recordVersion: load.loadVersion,
          skippedLines: 0,
        });
      }
      if (completed) {
        await writer.writeState({
          status: 'complete',
          completedAt: AS_OF,
          total: lines.length,
          checkpoint: encodeCheckpoint({ generation: 1, asOfSeconds: Date.parse(AS_OF) / 1000 }),
        });
      }
    } finally {
      await writer.close();
    }
  }

  /**
   * Loads the tool fresh over `mirrorPath` (unset when undefined), on the real service and its own
   * config, store handle, and budgets. The autocomplete confirms only "Hazelnut spreads"; a tag
   * search and a text search answer with their recorded live envelopes.
   */
  async function serve(mirrorPath: string | undefined): Promise<void> {
    vi.stubEnv('OFF_MIRROR_PATH', mirrorPath);
    vi.resetModules();
    const service = await import('@/services/openfoodfacts/openfoodfacts-service.js');
    const taxonomy = await import('@/services/taxonomy/taxonomy-service.js');
    const store = await import('@/services/mirror/mirror-store.js');
    ({ offSearchProductsTool: tool } = await import(
      '@/mcp-server/tools/definitions/search-products.tool.js'
    ));
    closeStore = store.closeMirrorStore;
    service.initOpenFoodFactsService();
    taxonomy.initTaxonomyService();
    requests = [];
    global.fetch = vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      requests.push(`${url.hostname}${url.pathname}`);
      if (url.pathname === '/autocomplete') {
        const q = url.searchParams.get('q');
        const options =
          q === 'Hazelnut spreads' ? [{ id: 'en:hazelnut-spreads', text: 'Hazelnut spreads' }] : [];
        return Response.json({ took: 1, timed_out: false, options });
      }
      return Response.json(
        url.hostname === 'search.openfoodfacts.org' ? TEXT_SEARCH_HITS : TAG_SEARCH_HITS,
      );
    }) as typeof fetch;
  }

  /** The pathnames of the recorded requests. */
  const paths = () => requests.map((request) => request.slice(request.indexOf('/')));

  /** One call through the contract runner: schema, handler, format, enrichment, error envelope. */
  async function call(input: Record<string, unknown>) {
    const result = await runToolContract(tool, input);
    const structured = result.structuredContent as Record<string, unknown> & {
      products?: { barcode: string }[];
    };
    return {
      result,
      structured,
      barcodes: (structured.products ?? []).map((product) => product.barcode),
      text: contractText(result),
    };
  }

  /** The handler's own refusal, as thrown. */
  async function refusalOf(input: Record<string, unknown>) {
    const error = (await captureError(
      tool.handler(tool.input.parse(input), createMockContext({ errors: tool.errors })),
    )) as { message: string; data: unknown };
    return { message: error.message, data: error.data };
  }

  const PAGE_11_REFUSAL = {
    message:
      'A search by tag filters alone is served through page 10 only, and page 11 was requested.',
    data: {
      reason: 'page_out_of_range',
      page: 11,
      page_size: 1,
      max_page: 10,
      recovery: {
        hint: 'Request page 10 or lower — at page_size 1 that reaches the first 10 matches — or narrow the filters or change sort_by to bring the products you need forward.',
      },
      retryable: false,
    },
  };

  // A mocked module is not re-evaluated after resetModules, so the service mock would keep the
  // first store and config it saw. The modules this group loads are the real ones; the static
  // bindings the rest of the file uses stay mocked.
  beforeAll(() => {
    vi.doUnmock('@/services/openfoodfacts/openfoodfacts-service.js');
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'off-search-mirror-'));
  });

  afterEach(async () => {
    await closeStore?.();
    closeStore = undefined;
    global.fetch = globalFetch;
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(dir, { recursive: true, force: true });
  });

  describe('with a ready store', () => {
    beforeEach(async () => {
      const path = join(dir, 'store.sqlite');
      await writeStore(path, LINES, true);
      await serve(path);
    });

    it('serves page 11 of a brand search with an exact total and last_page, sending nothing upstream', async () => {
      const { structured, barcodes, text } = await call({
        brands_tag: 'Nutella',
        page: 11,
        page_size: 1,
      });

      expect(structured).toMatchObject({
        total: 12,
        total_is_lower_bound: false,
        page: 11,
        page_size: 1,
        page_count: 1,
        last_page: 12,
        source: 'off_mirror',
        mirror_as_of: AS_OF,
        notice: 'Page 11 of 12. Use the page parameter to fetch subsequent pages.',
      });
      expect(barcodes).toEqual([code(11)]);
      expect(requests).toEqual([]);
      expect(text).toContain(`current as of ${AS_OF}`);
      expect(text).toContain(`as of ${AS_OF})`);
      expect(text).not.toMatch(/reads? the live database/);
    });

    it('serves the last page inside the result window and refuses the next on both surfaces, sending nothing upstream', async () => {
      const inside = await call({ brands_tag: 'Nutella', page: 10_000, page_size: 1 });

      expect(inside.result.isError).toBeFalsy();
      expect(inside.structured).toMatchObject({
        total: 12,
        page: 10_000,
        page_count: 0,
        last_page: 12,
        source: 'off_mirror',
        notice:
          'Page 10000 is past the end of this result set — 12 matching products exist, but no page this deep holds any. Request page 12 or lower to reach them.',
      });

      const past = await call({ brands_tag: 'Nutella', page: 10_001, page_size: 1 });
      const message =
        "This server's local copy of the export serves only the first 10000 results of a search, and page 10001 at page_size 1 asks for result 10001.";
      const hint =
        'Request page 10000 or lower at page_size 1, or narrow the filters or change sort_by so the products you need fall inside the first 10000 results.';

      expect(past.result.isError).toBe(true);
      expect(past.structured).toMatchObject({
        error: {
          message,
          data: {
            reason: 'page_out_of_range',
            page: 10_001,
            page_size: 1,
            max_page: 10_000,
            result_window: 10_000,
            recovery: { hint },
            retryable: false,
          },
        },
      });
      expect(past.text).toContain(message);
      expect(past.text).toContain(hint);
      expect(requests).toEqual([]);
    });

    it('orders by the stored popularity_key by default, code breaking a tie and a missing value last', async () => {
      const { structured, barcodes } = await call({
        brands_tag: 'Nutella',
        page: 1,
        page_size: 50,
      });

      expect(barcodes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(code));
      expect(structured).toMatchObject({ total: 12, last_page: 1, source: 'off_mirror' });
      expect(String(structured.mirror_snapshot)).toContain(
        'The default order follows the popularity_key value stored with each record',
      );
      expect(requests).toEqual([]);
    });

    it.each(['xx:nutella', 'en:nutella'])(
      'matches brands_tag %j as the brand stored under xx:nutella, as a live search does',
      async (brand) => {
        const { structured, barcodes } = await call({ brands_tag: brand, page: 1, page_size: 50 });

        expect(barcodes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(code));
        expect(structured).toMatchObject({ total: 12, source: 'off_mirror' });
        expect(requests).toEqual([]);
      },
    );

    it('drops products that declare an excluded allergen', async () => {
      const { structured, barcodes } = await call({
        brands_tag: 'Nutella',
        exclude_allergens: ['Milk'],
        page: 1,
        page_size: 50,
      });

      expect(barcodes).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(code));
      expect(structured).toMatchObject({ total: 10, source: 'off_mirror' });
      expect(structured.exclusion_coverage).toBeDefined();
      expect(requests).toEqual([]);
    });

    it('ANDs two labels_tag values', async () => {
      const { structured, barcodes } = await call({
        labels_tag: ['Organic', 'en:fair-trade'],
        page: 1,
        page_size: 50,
      });

      expect(barcodes).toEqual([1, 3, 5].map(code));
      expect(structured).toMatchObject({ total: 3, source: 'off_mirror' });
      expect(requests).toEqual([]);
    });

    it('matches nova_group "4" by the tag the export stores it under', async () => {
      const { structured, barcodes } = await call({ nova_group: '4', page: 1, page_size: 50 });

      expect(barcodes).toEqual([13, 1, 2, 3, 4, 5, 6].map(code));
      expect(structured).toMatchObject({ total: 7, source: 'off_mirror' });
      expect(requests).toEqual([]);
    });

    it('confirms a value through the live vocabulary, that lookup its only request', async () => {
      const { structured, barcodes } = await call({
        categories_tag: 'Hazelnut spreads',
        page: 1,
        page_size: 50,
      });

      expect(barcodes).toEqual([code(6)]);
      expect(structured).toMatchObject({ total: 1, source: 'off_mirror', mirror_as_of: AS_OF });
      expect(paths()).toEqual(['/autocomplete']);
    });

    it('searches live, as off_api and capped at page 10, for a value nothing confirms', async () => {
      const { structured, text } = await call({
        categories_tag: 'en:not-a-category',
        page: 1,
        page_size: 2,
      });

      expect(structured).toMatchObject({ total: 4581, last_page: 10, source: 'off_api' });
      expect(structured).not.toHaveProperty('mirror_as_of');
      expect(structured).not.toHaveProperty('mirror_snapshot');
      expect(text).toContain('**Source:** off_api (Open Food Facts)');
      expect(paths()).toEqual(['/autocomplete', '/api/v2/search']);
      const searchUrl = new URL(String(vi.mocked(global.fetch).mock.calls[1]?.[0]));
      expect(searchUrl.searchParams.get('categories_tags')).toBe('en:not-a-category');
    });

    it('refuses page 11 of a search a value sends live, naming the value, sending no search', async () => {
      expect(
        await refusalOf({ categories_tag: 'en:not-a-category', page: 11, page_size: 1 }),
      ).toEqual({
        message:
          'A search by tag filters alone is served through page 10 only when it reads the live database, and page 11 was requested: this server\'s local copy of the export serves deeper pages only when it confirms every value, and categories_tag "en:not-a-category" went unconfirmed (no matching Open Food Facts tag was found).',
        data: {
          ...PAGE_11_REFUSAL.data,
          unconfirmed: [
            { field: 'categories_tag', value: 'en:not-a-category', reason: 'no_match' },
          ],
          recovery: {
            hint: "Replace the value with a canonical tag ID from off_browse_taxonomy, or a brand slug, so this server's local copy of the export can serve page 11, or request page 10 or lower — at page_size 1 that reaches the first 10 matches.",
          },
        },
      });
      expect(paths()).toEqual(['/autocomplete']);
    });

    it('serves a query search and a nutrient_filters search live, never from the store', async () => {
      const byQuery = await call({ query: 'nutella', page: 1, page_size: 2 });
      const byNutrient = await call({
        nutrient_filters: [{ nutrient: 'sugars', operator: 'lte', value: 60 }],
        page: 1,
        page_size: 2,
      });

      expect(byQuery.structured.source).toBe('off_api');
      expect(byNutrient.structured.source).toBe('off_api');
      expect(byQuery.structured).not.toHaveProperty('mirror_as_of');
      expect(byNutrient.structured).not.toHaveProperty('mirror_snapshot');
      expect(paths()).toEqual(['/search', '/search']);
      expect(requests.every((request) => request.startsWith('search.openfoodfacts.org/'))).toBe(
        true,
      );
    });

    it('serves an ingredient search from the text index, never the store, past page 10 too (#88)', async () => {
      const { result, structured } = await call({
        ingredients_tag: 'en:inulin',
        page: 11,
        page_size: 2,
      });

      expect(result.isError).toBeFalsy();
      expect(structured.source).toBe('off_api');
      expect(structured).not.toHaveProperty('mirror_as_of');
      expect(String(structured.text_index_snapshot)).toContain(
        'This server answers ingredients_tag only from this index.',
      );
      expect(paths()).toEqual(['/autocomplete', '/search']);
      const [, init] = vi.mocked(global.fetch).mock.calls[1] ?? [];
      expect(JSON.parse(String(init?.body))).toMatchObject({
        q: 'ingredients_tags:"en:inulin"',
        page: 11,
        page_size: 2,
      });
    });
  });

  describe('without a ready store', () => {
    it('refuses page 11 before any lookup when the store holds no completed sync', async () => {
      const path = join(dir, 'store.sqlite');
      await writeStore(path, LINES, false);
      await serve(path);

      expect(
        await refusalOf({ categories_tag: 'Hazelnut spreads', page: 11, page_size: 1 }),
      ).toEqual(PAGE_11_REFUSAL);
      expect(requests).toEqual([]);
    });

    it('refuses page 11 before any lookup with OFF_MIRROR_PATH unset', async () => {
      await serve(undefined);

      expect(
        await refusalOf({ categories_tag: 'Hazelnut spreads', page: 11, page_size: 1 }),
      ).toEqual(PAGE_11_REFUSAL);
      expect(requests).toEqual([]);
    });

    it('reads a tag-only search live, values as given, when the store holds no completed sync', async () => {
      const path = join(dir, 'store.sqlite');
      await writeStore(path, LINES, false);
      await serve(path);

      const { structured } = await call({ brands_tag: 'Nutella', page: 1, page_size: 2 });

      expect(structured.source).toBe('off_api');
      expect(paths()).toEqual(['/api/v2/search']);
      const searchUrl = new URL(String(vi.mocked(global.fetch).mock.calls[0]?.[0]));
      expect(searchUrl.searchParams.get('brands_tags')).toBe('Nutella');
    });
  });

  describe('grade filters (#85)', () => {
    /**
     * Five jars: Nutri-Score a, a, b, c, and none; Green-Score as filed for France a-plus, a, a, f,
     * and none, jar 3 showing its world grade b.
     */
    const GRADED = [
      jar(1, {
        popularity_key: 50,
        nutrition_grades_tags: ['a'],
        environmental_score_tags: ['a-plus'],
        environmental_score_grade: 'a-plus',
      }),
      jar(2, {
        popularity_key: 40,
        nutrition_grades_tags: ['a'],
        environmental_score_tags: ['a'],
        environmental_score_grade: 'a',
      }),
      jar(3, {
        popularity_key: 30,
        nutrition_grades_tags: ['b'],
        environmental_score_tags: ['a'],
        environmental_score_grade: 'b',
      }),
      jar(4, {
        popularity_key: 20,
        nutrition_grades_tags: ['c'],
        environmental_score_tags: ['f'],
        environmental_score_grade: 'f',
      }),
      jar(5, { popularity_key: 10 }),
    ];

    /** Serves a completed store of `GRADED`, its rows and full load as `load` gives them. */
    async function serveGraded(load?: { loadVersion: number; rowVersion: number }) {
      const path = join(dir, 'store.sqlite');
      await writeStore(path, GRADED, true, load);
      await serve(path);
    }

    it('serves any-of Nutri-Score from the store, its total the single grades summed, sending nothing', async () => {
      await serveGraded();

      const a = await call({ nutrition_grade: 'a', page: 1, page_size: 50 });
      const b = await call({ nutrition_grade: 'b', page: 1, page_size: 50 });
      const either = await call({ nutrition_grade: ['b', 'a'], page: 1, page_size: 50 });

      expect([a.structured.total, b.structured.total]).toEqual([2, 1]);
      expect(either.structured).toMatchObject({
        total: 3,
        total_is_lower_bound: false,
        source: 'off_mirror',
      });
      expect(either.barcodes).toEqual([1, 2, 3].map(code));
      expect(requests).toEqual([]);
    });

    it('serves a Green-Score search from a store whose last full load indexed it, past the live page bound', async () => {
      await serveGraded({ loadVersion: 2, rowVersion: 2 });

      const first = await call({ ecoscore_grade: ['a-plus', 'a'], page: 1, page_size: 50 });
      const deep = await call({ ecoscore_grade: ['a-plus', 'a'], page: 11, page_size: 1 });

      expect(first.barcodes).toEqual([1, 2, 3].map(code));
      expect(first.structured.products?.[2]).toMatchObject({ ecoscore_grade: 'b' });
      expect(first.structured).toMatchObject({
        total: 3,
        source: 'off_mirror',
        mirror_as_of: AS_OF,
      });
      expect(deep.structured).toMatchObject({
        total: 3,
        page: 11,
        page_count: 0,
        last_page: 3,
        source: 'off_mirror',
      });
      expect(requests).toEqual([]);
    });

    it.each<[string, { loadVersion: number; rowVersion: number } | undefined]>([
      ['no full load recorded', undefined],
      ['a load built at record version 1', { loadVersion: 1, rowVersion: 1 }],
      ['a version-1 load a reload has rewritten part-way', { loadVersion: 1, rowVersion: 2 }],
    ])(
      'reads a Green-Score search live with %s, and refuses its page 11 naming ecoscore_grade',
      async (_label, load) => {
        await serveGraded(load);

        const { structured } = await call({ ecoscore_grade: 'a', page: 1, page_size: 2 });
        const refusal = await refusalOf({ ecoscore_grade: 'a', page: 11, page_size: 1 });

        expect(structured.source).toBe('off_api');
        expect(paths()).toEqual(['/api/v2/search']);
        const searchUrl = new URL(String(vi.mocked(global.fetch).mock.calls[0]?.[0]));
        expect(searchUrl.searchParams.get('environmental_score_tags')).toBe('a');
        expect(refusal.message).toContain(
          'serves a search carrying ecoscore_grade only once a full reload has indexed Green-Score',
        );
      },
    );

    it('serves a search without Green-Score from an older load, as before', async () => {
      await serveGraded({ loadVersion: 1, rowVersion: 1 });

      const { structured } = await call({ nutrition_grade: 'a', page: 11, page_size: 1 });

      expect(structured).toMatchObject({ total: 2, page: 11, source: 'off_mirror' });
      expect(requests).toEqual([]);
    });
  });
});
