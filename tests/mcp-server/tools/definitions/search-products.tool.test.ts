/**
 * @fileoverview Tests for off_search_products tool.
 * @module tests/mcp-server/tools/definitions/search-products.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

const mockSearchProducts = vi.fn();

describe('off_search_products', () => {
  let ctx: Context;

  beforeEach(() => {
    mockSearchProducts.mockReset();
    vi.mocked(getOpenFoodFactsService).mockReturnValue({
      searchProducts: mockSearchProducts,
    } as never);
    ctx = createMockContext({ errors: offSearchProductsTool.errors });
  });

  it('returns paginated results for a text query', async () => {
    mockSearchProducts.mockResolvedValue({
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
    mockSearchProducts.mockResolvedValue({
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
    mockSearchProducts.mockResolvedValue({
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

    expect(mockSearchProducts.mock.calls[0][0]).toMatchObject({
      categories_tag: 'en:cheeses',
      labels_tag: 'en:organic',
    });
  });

  it('passes both a text query and tag filters to the service (combined search)', async () => {
    // Combined case (issue #6): query + tag filters travel together in one service call so the
    // service can build a merged search-a-licious query — the tool drops neither side.
    mockSearchProducts.mockResolvedValue({
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

    expect(mockSearchProducts.mock.calls[0][0]).toMatchObject({
      query: 'dark chocolate',
      labels_tag: 'en:organic',
      countries_tag: 'en:france',
    });
    expect(result.products[0]?.barcode).toBe('0850013711000');
  });

  it('formats results with nutriscore_grade and barcode visible', () => {
    const output = {
      total: 10,
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
    const text = blocks[0].text;
    expect(text).toContain('3017620422003');
    expect(text).toContain('Nutella');
    expect(text).toContain('e'); // nutriscore_grade value (not uppercased)
  });

  it('formats empty results with guidance', () => {
    const output = { total: 0, page: 1, page_count: 0, products: [] };
    const blocks = offSearchProductsTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks[0].text;
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
    const error = await offSearchProductsTool
      .handler({ query: 'chocolate', page: 900, page_size: 50 }, ctx)
      .catch((e: unknown) => e as { data?: { recovery?: { hint?: string } } });

    expect(error.data?.recovery?.hint).toContain('page 200');
  });

  it('serves the last page inside the window', async () => {
    // page * page_size === 10,000 exactly is the boundary the backend still answers.
    mockSearchProducts.mockResolvedValue({
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

  it('does not apply the text window to a tag-only search', async () => {
    // The 10,000-result cap belongs to search.openfoodfacts.org; /api/v2/search publishes none.
    mockSearchProducts.mockResolvedValue({
      count: 50_000,
      page: 5001,
      page_count: 2,
      page_size: 2,
      products: [{ code: '1234567890001' }],
    });

    await offSearchProductsTool.handler(
      { categories_tag: 'en:pizzas', page: 5001, page_size: 2 },
      ctx,
    );

    expect(mockSearchProducts).toHaveBeenCalledOnce();
  });

  it('caps text-search truncation guidance at the pages the backend will serve', async () => {
    // The match total implies 6,633 pages; only the first 500 are reachable at page_size 20.
    mockSearchProducts.mockResolvedValue({
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

  it('warns that deep tag-search pages may be refused rather than promising them', async () => {
    mockSearchProducts.mockResolvedValue({
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
    expect(guidance).toContain('refuses deep pages');
  });

  it('does not point at the page parameter from the last page text search will serve', async () => {
    // page 5000 at page_size 2 is the deepest request inside the window; page 5001 is rejected by
    // the pre-flight check. Guidance that still said "fetch subsequent pages" here would send the
    // caller straight into that rejection.
    mockSearchProducts.mockResolvedValue({
      count: TEXT_SEARCH_RESULT_WINDOW,
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

  it('says no further pages exist on the last page of a tag search', async () => {
    mockSearchProducts.mockResolvedValue({
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
    mockSearchProducts.mockResolvedValue({
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
    const text = blocks[0].text;
    expect(text).toContain('1234567890001');
    expect(text).not.toContain('undefined');
  });

  // ── sort_by parameter ─────────────────────────────────────────────────────

  it('passes sort_by to the service on tag-filter path', async () => {
    mockSearchProducts.mockResolvedValue({
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

    expect(mockSearchProducts.mock.calls[0][0]).toMatchObject({
      categories_tag: 'en:cheeses',
      sort_by: 'unique_scans_n',
    });
  });

  it('does not set sort_by when omitted', async () => {
    mockSearchProducts.mockResolvedValue({
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

    const params = mockSearchProducts.mock.calls[0][0];
    expect(params.sort_by).toBeUndefined();
  });

  it('passes sort_by even on text-query path (service ignores it)', async () => {
    // The tool passes sort_by to the service regardless of path — the service is responsible
    // for ignoring it on the text-search path. This keeps the tool layer simple.
    mockSearchProducts.mockResolvedValue({
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

    const params = mockSearchProducts.mock.calls[0][0];
    expect(params.sort_by).toBe('popularity_key');
  });

  // ── ecoscore_grade in search results ──────────────────────────────────────

  it('surfaces ecoscore_grade in search result rows', async () => {
    mockSearchProducts.mockResolvedValue({
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
    mockSearchProducts.mockResolvedValue({
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
    const text = blocks[0].text;
    expect(text).toContain('Green-Score: c');
  });

  it('omits Green-Score line when ecoscore_grade is absent', () => {
    const output = {
      total: 1,
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
    const text = blocks[0].text;
    expect(text).not.toContain('Green-Score');
  });
});
