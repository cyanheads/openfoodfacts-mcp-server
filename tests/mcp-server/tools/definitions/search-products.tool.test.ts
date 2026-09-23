/**
 * @fileoverview Tests for off_search_products tool.
 * @module tests/mcp-server/tools/definitions/search-products.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Partial mock: only the service accessor is stubbed. TEXT_SEARCH_RESULT_WINDOW comes through from
// the real module so the handler's page bound and these assertions can never drift apart.
vi.mock('@/services/openfoodfacts/openfoodfacts-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/openfoodfacts/openfoodfacts-service.js')>()),
  getOpenFoodFactsService: vi.fn(),
}));

import { offSearchProductsTool } from '@/mcp-server/tools/definitions/search-products.tool.js';
import {
  getOpenFoodFactsService,
  TEXT_SEARCH_RESULT_WINDOW,
} from '@/services/openfoodfacts/openfoodfacts-service.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

const mockSearchProducts = vi.fn();
/**
 * The live taxonomy lookup under the real taxonomy service. Answers no suggestions by default, so
 * a tag value the offline sample does not hold reaches the search normalized.
 */
const mockSuggestTaxonomy = vi.fn();

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
 * `dropped` defaults to 0, the service's answer for a page whose codes are all servable.
 */
function mockSearch(
  result: { count: number; products: unknown[] } & Record<string, unknown>,
): void {
  mockSearchProducts.mockResolvedValue({ count_is_exact: true, dropped: 0, ...result });
}

/** Concatenates every text block of a `runToolContract` result — format() output plus trailer. */
function contractText(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
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
    vi.mocked(getOpenFoodFactsService).mockReturnValue({
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
      page_count: 1,
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
    const output = { total: 0, total_is_lower_bound: false, page: 1, page_count: 0, products: [] };
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
    // The text backend answers page * page_size > 10,000 with an HTTP 400 that no retry can clear.
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

    const guidance = String(getEnrichment(ctx).notice ?? '');
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

    expect(String(getEnrichment(ctx).notice ?? '')).toContain('as deep as text search paginates');
  });

  it('says no further pages exist when a text result set ends inside the window', async () => {
    mockSearch({
      count: 12,
      page: 3,
      page_count: 2,
      page_size: 5,
      products: [{ code: '1234567890001' }],
    });

    await offSearchProductsTool.handler({ query: 'kombucha', page: 3, page_size: 5 }, ctx);

    const guidance = String(getEnrichment(ctx).notice ?? '');
    expect(guidance).toBe('Page 3 of 3. No further pages of matches exist.');
  });

  it('says no further pages exist when the text window ends exactly at the last match', async () => {
    mockSearch({
      count: TEXT_SEARCH_RESULT_WINDOW,
      page: 5000,
      page_count: 2,
      page_size: 2,
      products: [{ code: '1234567890001' }],
    });

    await offSearchProductsTool.handler({ query: 'chocolate', page: 5000, page_size: 2 }, ctx);

    const guidance = String(getEnrichment(ctx).notice ?? '');
    expect(guidance).toContain('No further pages of matches exist.');
    expect(guidance).not.toMatch(/as deep as/);
  });

  it('says no further pages exist on the last page of a tag search', async () => {
    mockSearch({
      count: 25,
      page: 5,
      page_count: 5,
      page_size: 5,
      products: [{ code: '1234567890001' }],
    });

    await offSearchProductsTool.handler(
      { categories_tag: 'en:pizzas', page: 5, page_size: 5 },
      ctx,
    );

    const guidance = String(getEnrichment(ctx).notice ?? '');
    expect(guidance).toContain('No further pages of matches exist.');
    expect(guidance).not.toContain('fetch subsequent pages');
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
      page_count: 1,
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
      const error = (await captureError(
        offSearchProductsTool.handler(
          {
            additives_tag: 'en:e322',
            nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
            page: 1,
            page_size: 20,
          },
          ctx,
        ),
      )) as { data?: { recovery?: { hint?: string } } };

      expect(error.data?.recovery?.hint ?? '').toContain('nutrient_filters');
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

    it('leaves a partially filled last page unchanged', async () => {
      mockSearch({
        count: 25,
        page: 5,
        page_count: 3,
        page_size: 5,
        products: [{ code: '1234567890001' }],
      });

      await offSearchProductsTool.handler(
        { categories_tag: 'en:pizzas', page: 5, page_size: 5 },
        ctx,
      );

      const notice = String(getEnrichment(ctx).notice ?? '');
      expect(notice).toContain('No further pages of matches exist.');
      expect(notice).not.toMatch(/past the end/i);
    });

    it('renders the zero-match formatter text unchanged', () => {
      const text = firstText(
        offSearchProductsTool.format!({
          total: 0,
          total_is_lower_bound: false,
          page: 1,
          page_count: 0,
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
          page_count: 0,
          last_page: 1,
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
          page_count: 0,
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
      page_count: 1,
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
      page_count: 1,
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
      const error = (await captureError(
        offSearchProductsTool.handler(
          { query: 'chocolate', additives_tag: 'en:e322', page: 1, page_size: 20 },
          ctx,
        ),
      )) as { data?: { recovery?: { hint?: string } } };

      const hint = error.data?.recovery?.hint ?? '';
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
        page_count: 1,
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
        page_count: 1,
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
        page_count: 1,
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
        page_count: 1,
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
        page_count: 1,
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
      expect(text).toContain('a\\_b');
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
          page_count: 1,
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
      expect(notice).toMatch(/could not be (checked|reached)/i);
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

      expect(String(getEnrichment(ctx).text_index_snapshot ?? '')).toMatch(
        /same tag filters without query/i,
      );
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
      expect(text).toContain('**Page 1 lists no products** (40 total products)');
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
});
