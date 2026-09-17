/**
 * @fileoverview Regression tests for OpenFoodFactsService — covers HTTP 404 not-found handling
 * (Bug #3), text search routing (Bug #2), score-filter query-param mapping (GH issue #3), the
 * declared error contract carried by every failure (GH issue #12), retry classification and
 * upstream-detail surfacing (GH issue #19), and User-Agent header verification.
 * @module tests/services/openfoodfacts/openfoodfacts-service.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({
    baseUrl: 'https://world.openfoodfacts.org',
    rateLimitProduct: 100,
    rateLimitSearch: 10,
    rateLimitTaxonomy: 100,
  })),
}));

import { offCompareProductsTool } from '@/mcp-server/tools/definitions/compare-products.tool.js';
import { offGetProductTool } from '@/mcp-server/tools/definitions/get-product.tool.js';
import { offSearchProductsTool } from '@/mcp-server/tools/definitions/search-products.tool.js';
import {
  initOpenFoodFactsService,
  OpenFoodFactsService,
} from '@/services/openfoodfacts/openfoodfacts-service.js';
import { getTaxonomyService, initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

/** Build a minimal service instance with default test config. */
function makeService(): OpenFoodFactsService {
  return new OpenFoodFactsService({
    baseUrl: 'https://world.openfoodfacts.org',
    rateLimitProduct: 100,
    rateLimitSearch: 100,
    rateLimitTaxonomy: 100,
  });
}

/** Wrap a plain object + status in a minimal Response-like mock. */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** The fields these tests assert on a thrown `McpError`, without casting through `any`. */
type McpErrorish = {
  code: number;
  message: string;
  data?: {
    reason?: string;
    status?: number;
    retryable?: boolean;
    retryAfter?: number;
    recovery?: { hint?: string };
  };
};

/** Capture an expected service rejection without widening it with the success type. */
async function captureError(value: Promise<unknown>): Promise<McpErrorish> {
  try {
    await value;
  } catch (error) {
    return error as McpErrorish;
  }
  throw new Error('Expected the service call to reject.');
}

describe('OpenFoodFactsService', () => {
  let svc: OpenFoodFactsService;
  const globalFetch = global.fetch;

  beforeEach(() => {
    svc = makeService();
  });

  afterEach(() => {
    global.fetch = globalFetch;
    vi.restoreAllMocks();
  });

  // ── Bug #3 regression: HTTP 404 = not found, not serviceUnavailable ────────

  describe('getProduct — HTTP 404 handling', () => {
    it('returns null for HTTP 404 (barcode not in OFF database)', async () => {
      // Bug #3: OFF returns HTTP 404 for barcodes not in the database.
      // Before the fix, the handler threw serviceUnavailable after 4 retries.
      // After the fix, HTTP 404 is treated as not-found and returns null immediately.
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(mockResponse({}, 404));

      const result = await svc.getProduct('7622210100146', ctx);

      expect(result).toBeNull();
      // Must NOT retry — 404 is deterministic, not transient
      expect(global.fetch).toHaveBeenCalledOnce();
    });

    it('returns null for HTTP 200 with status:0 (the other not-found shape)', async () => {
      // The OFF API also returns HTTP 200 with status:0 for some barcodes.
      // Both shapes must result in null — callers don't distinguish between them.
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ code: '00000000000001', status: 0, status_verbose: 'product not found' }),
        );

      const result = await svc.getProduct('00000000000001', ctx);

      expect(result).toBeNull();
    });

    it('returns product data for HTTP 200 with status:1', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          status: 1,
          product: {
            product_name: 'Nutella',
            nutriscore_grade: 'e',
          },
        }),
      );

      const result = await svc.getProduct('3017620422003', ctx);

      expect(result).not.toBeNull();
      expect(result?.product_name).toBe('Nutella');
    });
  });

  describe('getProductFields — HTTP 404 handling', () => {
    it('returns null for HTTP 404', async () => {
      // getProductFields uses the same handleProductResponse path — 404 must also return null.
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(mockResponse({}, 404));

      const result = await svc.getProductFields('7622210100146', 'product_name', ctx);

      expect(result).toBeNull();
      expect(global.fetch).toHaveBeenCalledOnce();
    });
  });

  // ── Search routing: text → search-a-licious, tags-only → /api/v2/search, both → combined ──

  describe('searchProducts — routing', () => {
    it('routes a text-only query to search.openfoodfacts.org', async () => {
      // Bug #2: /api/v2/search silently ignores search_terms and returns all products, so any
      // request carrying free text must route to search.openfoodfacts.org (search-a-licious).
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 3,
          page: 1,
          page_size: 20,
          page_count: 1,
          hits: [
            { code: '0009800800049', product_name: 'Nutella & go!', brands: ['Nutella'] },
            { code: '0098008952506', product_name: 'Nutella', brands: ['Ferrero'] },
          ],
        }),
      );

      await svc.searchProducts({ query: 'nutella', page: 1, page_size: 20 }, ctx);

      const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(fetchCall).toContain('search.openfoodfacts.org');
      // Must NOT use the /api/v2/search endpoint for text queries
      expect(fetchCall).not.toContain('api/v2/search');
    });

    it('routes to /api/v2/search when no query — tag-only search', async () => {
      // Tag-only search (no text) stays on /api/v2/search — this path is unchanged by the combined
      // feature, so it also guards the prior release's score-filter param fix (GH issue #3).
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 100,
          page: 1,
          page_count: 20,
          page_size: 20,
          products: [{ code: '3017620422003', product_name: 'Nutella', nutriscore_grade: 'e' }],
        }),
      );

      await svc.searchProducts({ categories_tag: 'en:spreads', page: 1, page_size: 20 }, ctx);

      const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(fetchCall).toContain('api/v2/search');
      expect(fetchCall).not.toContain('search.openfoodfacts.org');
    });

    it('combines a text query with tag filters into one search-a-licious Lucene q', async () => {
      // Combined case (issue #6): a query PLUS tag filters routes to search-a-licious with a single
      // Lucene q that ANDs the facet clauses with the free text — both text-relevant and filtered.
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 6070,
          page: 1,
          page_size: 20,
          page_count: 1,
          hits: [{ code: '0850013711000', product_name: 'Theo Dark Chocolate', brands: ['Theo'] }],
        }),
      );

      await svc.searchProducts(
        {
          query: 'chocolate',
          labels_tag: 'en:organic',
          countries_tag: 'en:france',
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(fetchCall).toContain('search.openfoodfacts.org');
      // Combined requests never fall back to the text-blind /api/v2/search endpoint.
      expect(fetchCall).not.toContain('api/v2/search');

      const q = new URL(fetchCall).searchParams.get('q') ?? '';
      expect(q).toContain('labels_tags:"en:organic"');
      expect(q).toContain('countries_tags:"en:france"');
      expect(q).toContain('chocolate');
    });

    it('maps score and NOVA filters to search-a-licious field names on the combined path', async () => {
      // search-a-licious uses different field names than /api/v2/search: nutriscore_grade (not
      // nutrition_grades_tags) and nova_group (no _tags suffix), both with bare values.
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 12, page: 1, page_size: 20, page_count: 1, hits: [] }),
        );

      await svc.searchProducts(
        { query: 'cereal', nutrition_grade: 'a', nova_group: '1', page: 1, page_size: 20 },
        ctx,
      );

      const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(fetchCall).toContain('search.openfoodfacts.org');

      const q = new URL(fetchCall).searchParams.get('q') ?? '';
      expect(q).toContain('nutriscore_grade:a');
      expect(q).toContain('nova_group:1');
      expect(q).toContain('cereal');
      // The legacy /api/v2/search score-filter field names must not leak onto this path.
      expect(q).not.toContain('nutrition_grades_tags');
      expect(q).not.toContain('nova_groups_tags');
    });

    it('escapes Lucene-reserved characters in free text so it cannot inject a field filter', async () => {
      // Live-verified against search-a-licious: an unescaped colon in free text is parsed as
      // Lucene field:value syntax — `query: "brands: nutella"` with no brands_tag set returns
      // only Nutella products, and `query: "nutriscore_grade: a"` silently hard-filters to grade
      // "a" even though nutriscore_grade isn't a facet this tool exposes. Escaping must neutralize
      // this without breaking ordinary free text (no reserved characters, e.g. "chocolate").
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 0, page: 1, page_size: 20, page_count: 1, hits: [] }),
        );

      await svc.searchProducts({ query: 'brands: nutella', page: 1, page_size: 20 }, ctx);

      const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      const q = new URL(fetchCall).searchParams.get('q') ?? '';
      expect(q).toContain('brands\\: nutella');
      expect(q).not.toMatch(/(?<!\\):/);
    });

    it('normalizes brands array from text search to a comma-joined string', async () => {
      // search.openfoodfacts.org returns brands as an array; the service must join it to match
      // the RawProduct.brands string shape that the tool layer expects.
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 1,
          page: 1,
          page_size: 20,
          page_count: 1,
          hits: [
            { code: '3017620422003', product_name: 'Nutella', brands: ['Ferrero', 'Nutella'] },
          ],
        }),
      );

      const result = await svc.searchProducts({ query: 'nutella', page: 1, page_size: 20 }, ctx);

      // brands array joined to string
      expect(result.products[0]?.brands).toBe('Ferrero, Nutella');
    });

    it('includes sort_by in the tag-filter URL when provided', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 10,
          page: 1,
          page_count: 10,
          page_size: 20,
          products: [],
        }),
      );

      await svc.searchProducts(
        { categories_tag: 'en:cheeses', sort_by: 'unique_scans_n', page: 1, page_size: 20 },
        ctx,
      );

      const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(fetchCall).toContain('sort_by=unique_scans_n');
      expect(fetchCall).toContain('api/v2/search');
    });

    it('applies sort_by on the text-search URL with a descending prefix', async () => {
      // GH issue #33: search.openfoodfacts.org does sort — it accepts sort_by, orders descending
      // on a "-" prefix, and rejects an unknown field with HTTP 400. The prefix is what makes each
      // enum value mean the same thing here as the bare value means on /api/v2/search.
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 1,
          page: 1,
          page_size: 20,
          page_count: 1,
          hits: [],
        }),
      );

      await svc.searchProducts(
        { query: 'chocolate', sort_by: 'popularity_key', page: 1, page_size: 20 },
        ctx,
      );

      const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(fetchCall).toContain('search.openfoodfacts.org');
      expect(new URL(fetchCall).searchParams.get('sort_by')).toBe('-popularity_key');
    });

    it('sends every sort_by value on the text path, none skipped or special-cased', async () => {
      const values = ['last_modified_t', 'unique_scans_n', 'created_t', 'popularity_key'] as const;

      for (const value of values) {
        const ctx = createMockContext();
        global.fetch = vi
          .fn()
          .mockResolvedValue(
            mockResponse({ count: 1, page: 1, page_size: 20, page_count: 1, hits: [] }),
          );

        await svc.searchProducts(
          { query: 'chocolate', sort_by: value, page: 1, page_size: 20 },
          ctx,
        );

        const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
        expect(new URL(fetchCall).searchParams.get('sort_by')).toBe(`-${value}`);
      }
    });

    it('sends no sort parameter on either path when sort_by is omitted', async () => {
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 1, page: 1, page_size: 20, page_count: 1, hits: [] }),
        );
      await svc.searchProducts({ query: 'chocolate', page: 1, page_size: 20 }, ctx);
      expect(
        new URL(vi.mocked(global.fetch).mock.calls[0]?.[0] as string).searchParams.get('sort_by'),
      ).toBeNull();

      const tagCtx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 1, page: 1, page_count: 1, page_size: 20, products: [] }),
        );
      await svc.searchProducts({ categories_tag: 'en:cheeses', page: 1, page_size: 20 }, tagCtx);
      expect(
        new URL(vi.mocked(global.fetch).mock.calls[0]?.[0] as string).searchParams.get('sort_by'),
      ).toBeNull();
    });

    it('includes ecoscore_grade in SEARCH_FIELDS for tag-filter requests', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 1,
          page: 1,
          page_count: 1,
          page_size: 20,
          products: [{ code: '3017620422003', ecoscore_grade: 'c' }],
        }),
      );

      const result = await svc.searchProducts(
        { categories_tag: 'en:spreads', page: 1, page_size: 20 },
        ctx,
      );

      const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(fetchCall).toContain('ecoscore_grade');
      expect(result.products[0]?.ecoscore_grade).toBe('c');
    });

    it('normalizes ecoscore_grade from text search hits to RawProduct', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 1,
          page: 1,
          page_size: 20,
          page_count: 1,
          hits: [{ code: '3017620422003', product_name: 'Nutella', ecoscore_grade: 'c' }],
        }),
      );

      const result = await svc.searchProducts({ query: 'nutella', page: 1, page_size: 20 }, ctx);

      expect(result.products[0]?.ecoscore_grade).toBe('c');
    });

    it('text search result page_count reflects products-on-page, not total pages', async () => {
      // search.openfoodfacts.org page_count = total pages; /api/v2 page_count = products on page.
      // The service must normalize the text search response to use products-on-page.
      const ctx = createMockContext();
      const hits = [
        { code: '0000000000001', product_name: 'A' },
        { code: '0000000000002', product_name: 'B' },
      ];
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 40,
          page: 1,
          page_size: 2,
          page_count: 20, // 20 total pages in the text search response
          hits,
        }),
      );

      const result = await svc.searchProducts({ query: 'test', page: 1, page_size: 2 }, ctx);

      // page_count must be products-on-page (2), not total-pages (20)
      expect(result.page_count).toBe(2);
      expect(result.count).toBe(40);
    });
  });

  // ── allergen and additive filters (GH issue #10) ─────────────────────────

  describe('searchProducts — allergen and additive filters', () => {
    it('sends allergens_tags and additives_tags on the tag-filter path', async () => {
      // Both facets filter on /api/v2/search — live-verified returning hundreds of thousands of
      // matches each, and a smaller intersection when combined.
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 103_458, page: 1, page_count: 1, page_size: 20, products: [] }),
        );

      await svc.searchProducts(
        { allergens_tag: 'en:milk', additives_tag: 'en:e322', page: 1, page_size: 20 },
        ctx,
      );

      const url = new URL(vi.mocked(global.fetch).mock.calls[0]?.[0] as string);
      expect(url.pathname).toContain('api/v2/search');
      expect(url.searchParams.get('allergens_tags')).toBe('en:milk');
      expect(url.searchParams.get('additives_tags')).toBe('en:e322');
    });

    it('folds allergens_tag into the Lucene q on the combined path', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 12,
          is_count_exact: true,
          page: 1,
          page_size: 20,
          page_count: 1,
          hits: [],
        }),
      );

      await svc.searchProducts(
        { query: 'chocolate', allergens_tag: 'en:milk', page: 1, page_size: 20 },
        ctx,
      );

      const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      const q = new URL(fetchCall).searchParams.get('q') ?? '';
      expect(q).toContain('allergens_tags:"en:milk"');
      expect(q).toContain('chocolate');
    });

    it('never builds an additives clause for the text backend', async () => {
      // search-a-licious has no additives_tags field — the clause compiles to a phrase match on a
      // missing field and returns zero hits for every E-number. Building it would turn a filter
      // into a silent "no such product". The tool refuses the pairing; this pins the query builder
      // so a direct service call cannot construct it either.
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 0,
          is_count_exact: true,
          page: 1,
          page_size: 20,
          page_count: 0,
          hits: [],
        }),
      );

      await svc.searchProducts(
        { query: 'chocolate', additives_tag: 'en:e322', page: 1, page_size: 20 },
        ctx,
      );

      const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(fetchCall).toContain('search.openfoodfacts.org');
      expect(new URL(fetchCall).searchParams.get('q') ?? '').not.toContain('additives_tags');
    });
  });

  // ── numeric nutrient filters (GH issue #28) ──────────────────────────────

  describe('searchProducts — nutrient filters', () => {
    /** Stub a text-search response and return the Lucene `q` the service built. */
    async function queryFor(params: Record<string, unknown>): Promise<string> {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 1,
          is_count_exact: true,
          page: 1,
          page_size: 20,
          page_count: 1,
          hits: [],
        }),
      );
      await svc.searchProducts({ page: 1, page_size: 20, ...params }, ctx);
      const url = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      return new URL(url).searchParams.get('q') ?? '';
    }

    it('builds the bracket form the backend parses for each operator', async () => {
      // Live-verified against search-a-licious: square brackets parse to gte/lte, curly braces to
      // gt/lt, and `*` is an open bound. Every field reference needs the `nutriments.` prefix — a
      // bare `sugars_100g` clause answers HTTP 200 with zero hits and no error.
      const cases = [
        { operator: 'lte', expected: 'nutriments.sugars_100g:[* TO 2]' },
        { operator: 'lt', expected: 'nutriments.sugars_100g:{* TO 2}' },
        { operator: 'gte', expected: 'nutriments.sugars_100g:[2 TO *]' },
        { operator: 'gt', expected: 'nutriments.sugars_100g:{2 TO *}' },
      ] as const;

      for (const { operator, expected } of cases) {
        const q = await queryFor({
          nutrient_filters: [{ nutrient: 'sugars', operator, value: 2 }],
        });
        expect(q).toContain(expected);
      }
    });

    it('routes a nutrient-only search to the text backend', async () => {
      // /api/v2/search documents nutriment comparisons but ignores them — live-verified returning
      // the identical unfiltered count for two mutually exclusive thresholds. Only the text
      // backend applies them, so a nutrient constraint routes there with no free text.
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 1,
          is_count_exact: true,
          page: 1,
          page_size: 20,
          page_count: 1,
          hits: [],
        }),
      );

      await svc.searchProducts(
        {
          categories_tag: 'en:breakfast-cereals',
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      const fetchCall = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      expect(fetchCall).toContain('search.openfoodfacts.org');
      expect(fetchCall).not.toContain('api/v2/search');
    });

    it('ANDs two constraints on different nutrients into one q', async () => {
      const q = await queryFor({
        categories_tag: 'en:breakfast-cereals',
        nutrient_filters: [
          { nutrient: 'sugars', operator: 'lt', value: 8 },
          { nutrient: 'fiber', operator: 'gte', value: 6 },
        ],
      });

      expect(q).toContain('nutriments.sugars_100g:{* TO 8}');
      expect(q).toContain('nutriments.fiber_100g:[6 TO *]');
      expect(q).toContain('categories_tags:"en:breakfast-cereals"');
    });

    it('combines a constraint with free text without escaping the clause', async () => {
      const q = await queryFor({
        query: 'granola',
        nutrient_filters: [{ nutrient: 'saturated-fat', operator: 'lte', value: 2 }],
      });

      // Hyphenated field names need no escaping on this index — live-verified.
      expect(q).toContain('nutriments.saturated-fat_100g:[* TO 2]');
      expect(q).toContain('granola');
    });

    it('combines a constraint with tag filters', async () => {
      const q = await queryFor({
        labels_tag: 'en:organic',
        countries_tag: 'en:france',
        nutrient_filters: [{ nutrient: 'salt', operator: 'lt', value: 1 }],
      });

      expect(q).toContain('labels_tags:"en:organic"');
      expect(q).toContain('countries_tags:"en:france"');
      expect(q).toContain('nutriments.salt_100g:{* TO 1}');
    });

    it('carries every supported nutrient under its indexed field name', async () => {
      const nutrients = [
        'energy-kcal',
        'fat',
        'saturated-fat',
        'carbohydrates',
        'sugars',
        'fiber',
        'proteins',
        'salt',
        'sodium',
      ] as const;

      for (const nutrient of nutrients) {
        const q = await queryFor({
          nutrient_filters: [{ nutrient, operator: 'lte', value: 5 }],
        });
        expect(q).toContain(`nutriments.${nutrient}_100g:[* TO 5]`);
      }
    });

    it('keeps a tag-only search with no nutrient constraint on /api/v2/search', async () => {
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 1, page: 1, page_count: 1, page_size: 20, products: [] }),
        );

      await svc.searchProducts({ categories_tag: 'en:spreads', page: 1, page_size: 20 }, ctx);

      expect(vi.mocked(global.fetch).mock.calls[0]?.[0] as string).toContain('api/v2/search');
    });

    it('applies sort_by with the text prefix on a nutrient-only search', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 1,
          is_count_exact: true,
          page: 1,
          page_size: 20,
          page_count: 1,
          hits: [],
        }),
      );

      await svc.searchProducts(
        {
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
          sort_by: 'unique_scans_n',
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      const url = new URL(vi.mocked(global.fetch).mock.calls[0]?.[0] as string);
      expect(url.searchParams.get('sort_by')).toBe('-unique_scans_n');
    });
  });

  // ── clipped hit counts (GH issue #18) ────────────────────────────────────

  describe('searchProducts — count exactness', () => {
    it('reports a clipped text-search count as inexact', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 10_000,
          is_count_exact: false,
          page: 1,
          page_size: 2,
          page_count: 5000,
          hits: [{ code: '1234567890001' }],
        }),
      );

      const result = await svc.searchProducts({ query: 'chocolate', page: 1, page_size: 2 }, ctx);

      expect(result.count).toBe(10_000);
      expect(result.count_is_exact).toBe(false);
    });

    it('reports a counted text-search total as exact', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 3464,
          is_count_exact: true,
          page: 1,
          page_size: 2,
          page_count: 1732,
          hits: [{ code: '1234567890001' }],
        }),
      );

      const result = await svc.searchProducts({ query: 'kombucha', page: 1, page_size: 2 }, ctx);

      expect(result.count_is_exact).toBe(true);
    });

    it('reads exactness from the backend flag, not from the count reaching a threshold', async () => {
      // The page-depth window and the hit-counting ceiling are separate limits that sit at the
      // same number today. A count of exactly 10,000 that the backend says it finished counting
      // is exact; a small count it says it did not finish is not. Comparing the count against
      // TEXT_SEARCH_RESULT_WINDOW would get both of these backwards.
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 10_000,
          is_count_exact: true,
          page: 1,
          page_size: 2,
          page_count: 5000,
          hits: [],
        }),
      );
      expect(
        (await svc.searchProducts({ query: 'a', page: 1, page_size: 2 }, ctx)).count_is_exact,
      ).toBe(true);

      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 42,
          is_count_exact: false,
          page: 1,
          page_size: 2,
          page_count: 21,
          hits: [],
        }),
      );
      expect(
        (await svc.searchProducts({ query: 'b', page: 1, page_size: 2 }, ctx)).count_is_exact,
      ).toBe(false);
    });

    it('reports tag-search counts as exact past the text backend ceiling', async () => {
      // /api/v2/search counts every match — live-verified at 230,860 for a filter that clips to
      // 10,000 on the text path.
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 230_860,
          page: 1,
          page_count: 20,
          page_size: 20,
          products: [{ code: '1234567890001' }],
        }),
      );

      const result = await svc.searchProducts(
        { categories_tag: 'en:beverages', page: 1, page_size: 20 },
        ctx,
      );

      expect(result.count).toBe(230_860);
      expect(result.count_is_exact).toBe(true);
    });
  });

  // ── GH issue #3: score filters must use the *_tags query params ────────────

  describe('searchProducts — score filter query params', () => {
    /** Stub a tag-search response and return the URL the service fetched. */
    async function urlForTagSearch(params: Record<string, unknown>): Promise<string> {
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 1, page: 1, page_count: 1, page_size: 20, products: [] }),
        );
      await svc.searchProducts({ page: 1, page_size: 20, ...params }, ctx);
      return vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
    }

    it('maps nutrition_grade to nutrition_grades_tags (not the ignored nutrition_grades key)', async () => {
      // GH issue #3: the API silently ignores nutrition_grades= and returns unfiltered rows.
      // The tag-style nutrition_grades_tags= key is the one that actually filters.
      const url = await urlForTagSearch({
        categories_tag: 'en:breakfast-cereals',
        nutrition_grade: 'a',
      });

      expect(url).toContain('nutrition_grades_tags=a');
      expect(url).not.toContain('nutrition_grades=');
    });

    it('maps nova_group to nova_groups_tags (not the ignored nova_groups key)', async () => {
      const url = await urlForTagSearch({
        categories_tag: 'en:breakfast-cereals',
        nova_group: '1',
      });

      expect(url).toContain('nova_groups_tags=1');
      expect(url).not.toContain('nova_groups=');
    });

    it('passes the score value through bare — no en: prefix added', async () => {
      // Live-verified: nutrition_grades_tags accepts only the bare grade letter
      // (nutrition_grades_tags=en:a returns 0 matches). Value must not be prefixed.
      const url = await urlForTagSearch({ nutrition_grade: 'a', nova_group: '1' });

      expect(url).toContain('nutrition_grades_tags=a');
      expect(url).not.toContain('nutrition_grades_tags=en');
      expect(url).toContain('nova_groups_tags=1');
    });
  });

  // ── declared error contract on every failure (GH issue #12) ──────────────
  //
  // These drive the real classification path: global fetch is stubbed, so the framework's
  // fetchWithTimeout does the status → code mapping the service then maps onto a contract reason.

  describe('error contract', () => {
    it('carries reason and recovery for an unreachable upstream', async () => {
      // The reported repro (OFF_BASE_URL pointed at a dead port) surfaced a bare -32603 with no
      // reason and no recovery hint on either client surface.
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn().mockRejectedValue(new TypeError('Unable to connect.'));

      const error = await captureError(svc.getProduct('3017620422003', ctx));

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBe('upstream_error');
      expect(error.data?.recovery?.hint).toBe(
        offGetProductTool.errors?.find((e) => e.reason === 'upstream_error')?.recovery,
      );
    });

    it('classifies an upstream 5xx as a retryable upstream_error', async () => {
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Internal Server Error', 503));

      const error = await captureError(svc.getProduct('3017620422003', ctx));

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBe('upstream_error');
      expect(error.data?.status).toBe(503);
      // Retryability is stated on every reason, not left absent for the client to infer from
      // the code — the non-retryable case asserts the same field in the 4xx suite below.
      expect(error.data?.retryable).toBe(true);
      // Transient — the framework retried the full budget before giving up.
      expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    /**
     * A 200 response whose body is not served as JSON — the high-load shape OFF sometimes returns.
     * The body is single-consumption, like a real `Response`, so reading it twice fails here the
     * same way it would in production.
     */
    function nonJsonResponse(body: string): Response {
      let consumed = false;
      const read = (): string => {
        if (consumed) throw new TypeError('Body already read');
        consumed = true;
        return body;
      };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        json: async () => JSON.parse(read()),
        text: async () => read(),
      } as unknown as Response;
    }

    it('classifies an HTML page served with a 200 as upstream_error', async () => {
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      // A fresh Response per attempt — a real fetch never hands the same body to two retries.
      global.fetch = vi.fn(async () =>
        nonJsonResponse('<!doctype html><html><body>busy</body></html>'),
      );

      const error = await captureError(svc.getProduct('3017620422003', ctx));

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBe('upstream_error');
    });

    it('still parses a 200 whose JSON was served under a non-JSON content type', async () => {
      // The body is read exactly once — sniffing it as text and then calling response.json()
      // would fail on the consumed stream.
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn(async () =>
        nonJsonResponse(JSON.stringify({ status: 1, product: { product_name: 'Nutella' } })),
      );

      const result = await svc.getProduct('3017620422003', ctx);

      expect(result?.product_name).toBe('Nutella');
    });

    it('classifies a blown request deadline as upstream_timeout, not upstream_error', async () => {
      // Reject with the abort signal's own reason — the TimeoutError DOMException the framework
      // raises — rather than a hand-built AbortError the real abort path never produces. Timeouts
      // resolve to a distinct wire code, so folding them into upstream_error would lose it.
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );

      vi.useFakeTimers();
      try {
        const pending = captureError(svc.getProduct('3017620422003', ctx));
        await vi.runAllTimersAsync();
        const error = await pending;

        expect(error.code).toBe(JsonRpcErrorCode.Timeout);
        expect(error.data?.reason).toBe('upstream_timeout');
        expect(error.data?.recovery?.hint).toBe(
          offGetProductTool.errors?.find((e) => e.reason === 'upstream_timeout')?.recovery,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    // ── #26: the public failure publishes selected fields, not the fetch error's whole data ──

    /** The load-shed page Open Food Facts serves instead of JSON when it is refusing traffic. */
    const loadShedHtml =
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n<style>body { font-family: sans-serif; }</style>\n' +
      '<title>Open Food Facts</title>\n</head>\n<body><h1>Service temporarily unavailable</h1></body>\n</html>';

    it('publishes no upstream markup on an error whose body is a rendered page', async () => {
      // #26: the fetch error's whole `data` was spread into the contract failure, so the captured
      // page rode along twice — as `body` and its legacy alias `responseBody` — and made up more
      // than half the bytes the caller received, while content[] carried one summary sentence.
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse(loadShedHtml, 503) as Response & Record<string, unknown>);

      const error = await captureError(svc.getProduct('3017620422003', ctx));
      const data = (error.data ?? {}) as Record<string, unknown>;

      expect(data).not.toHaveProperty('body');
      expect(data).not.toHaveProperty('responseBody');
      expect(data).not.toHaveProperty('statusCode');
      expect(data).not.toHaveProperty('errorSource');
      for (const value of Object.values(data)) {
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        expect(rendered).not.toMatch(/<!DOCTYPE|<html|<style/i);
      }
      expect(error.message).not.toMatch(/<!DOCTYPE|<html|<style/i);
    });

    it('keeps the diagnostics the recovery hint refers to', async () => {
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse(loadShedHtml, 503));

      const error = await captureError(svc.getProduct('3017620422003', ctx));
      const data = (error.data ?? {}) as Record<string, unknown>;

      expect(data.status).toBe(503);
      expect(data.reason).toBe('upstream_error');
      expect(data.retryable).toBe(true);
      expect(data.barcode).toBe('3017620422003');
      expect(data.retryAttempts).toBe(4);
      expect((data.recovery as { hint?: string }).hint).toBe(
        offGetProductTool.errors?.find((e) => e.reason === 'upstream_error')?.recovery,
      );
    });

    it('keeps the per-call context of the search and taxonomy paths', async () => {
      const searchCtx = createMockContext({ errors: offSearchProductsTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse(loadShedHtml, 400));

      const searchError = await captureError(
        svc.searchProducts({ query: 'chocolate', page: 3, page_size: 25 }, searchCtx),
      );
      const searchData = (searchError.data ?? {}) as Record<string, unknown>;
      expect(searchData.page).toBe(3);
      expect(searchData.page_size).toBe(25);
      expect(searchData).not.toHaveProperty('body');

      const taxonomyCtx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(mockResponse(loadShedHtml, 400));
      const taxonomyError = await captureError(
        svc.suggestTaxonomy('category', 'hummus', 10, taxonomyCtx),
      );
      const taxonomyData = (taxonomyError.data ?? {}) as Record<string, unknown>;
      expect(taxonomyData.taxonomy_name).toBe('category');
      expect(taxonomyData.term).toBe('hummus');
      expect(taxonomyData).not.toHaveProperty('body');
    });

    it('bounds a non-JSON, non-HTML error body and strips its markup from the message', async () => {
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      const body = `<b>upstream said</b> ${'nope '.repeat(100)}`;
      global.fetch = vi.fn().mockResolvedValue(mockResponse(body, 400));

      const error = await captureError(svc.getProduct('3017620422003', ctx));

      expect(error.message).toContain('upstream said');
      expect(error.message).not.toContain('<');
      expect(error.message).not.toContain('>');
      expect(error.message.length).toBeLessThan(300);
    });

    it('bounds a JSON detail string and strips its markup from the message', async () => {
      // The JSON branch is the one search-a-licious actually answers with; a detail string is
      // still upstream-authored text and lands in the taxonomy fallback notice unescaped.
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      const detail = `<b>rejected</b> ${'because '.repeat(60)}`;
      global.fetch = vi.fn().mockResolvedValue(mockResponse({ detail }, 400));

      const error = await captureError(svc.getProduct('3017620422003', ctx));

      expect(error.message).toContain('rejected');
      expect(error.message).not.toContain('<');
      expect(error.message).not.toContain('>');
      expect(error.message.length).toBeLessThan(300);
    });

    it('carries the cleaned message into the compare tool and the taxonomy fallback notice', async () => {
      // Both surfaces interpolate the error message: off_compare_products into failed[].error and
      // the taxonomy fallback into its notice. Neither may end up holding provider markup.
      initOpenFoodFactsService();
      const compareCtx = createMockContext({ errors: offCompareProductsTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse(loadShedHtml, 400));

      const compared = await offCompareProductsTool.handler(
        { barcodes: ['3017620422003', '7622210100146'] },
        compareCtx,
      );
      expect(compared.failed).toHaveLength(2);
      for (const entry of compared.failed ?? []) {
        expect(entry.error).not.toMatch(/<!DOCTYPE|<html|<style|</i);
      }

      initTaxonomyService();
      const taxonomyCtx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(mockResponse(loadShedHtml, 400));
      const resolved = await getTaxonomyService().search('labels', 'organic', 10, taxonomyCtx);
      expect(resolved.notice).toContain('could not be reached');
      expect(resolved.notice).not.toMatch(/<!DOCTYPE|<html|<style|</i);
    });

    it('refuses locally with rate_limited without contacting Open Food Facts', async () => {
      // The refusal is this server's own; the message must not attribute it to Open Food Facts.
      const limited = new OpenFoodFactsService({
        baseUrl: 'https://world.openfoodfacts.org',
        rateLimitProduct: 1,
        rateLimitSearch: 1,
        rateLimitTaxonomy: 1,
      });
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ status: 1, product: { product_name: 'Nutella' } }));

      await limited.getProduct('3017620422003', ctx);
      const error = await captureError(limited.getProduct('7622210100146', ctx));

      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data?.reason).toBe('rate_limited');
      expect(error.data?.retryAfter).toBeGreaterThan(0);
      expect(error.message).toContain('openfoodfacts-mcp-server declined');
      expect(error.message).not.toMatch(/Open Food Facts rate limit/);
      // Only the first call reached the network.
      expect(global.fetch).toHaveBeenCalledOnce();
    });
  });

  // ── #25: budgets are counted in upstream requests, retries included ──────

  describe('rate limiting', () => {
    /** A service whose product budget is the only one that matters for the test. */
    function withProductBudget(rateLimitProduct: number): OpenFoodFactsService {
      return new OpenFoodFactsService({
        baseUrl: 'https://world.openfoodfacts.org',
        rateLimitProduct,
        rateLimitSearch: 100,
        rateLimitTaxonomy: 100,
      });
    }

    it('charges one slot per upstream request, retries included', async () => {
      // #25: the check sat outside the retry boundary, so one charged slot funded four requests —
      // a ten-barcode comparison sent 40 product reads against a published ceiling of 15/min.
      const limited = withProductBudget(4);
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Service Unavailable', 503));

      await captureError(limited.getProduct('3017620422003', ctx));
      expect(global.fetch).toHaveBeenCalledTimes(4);

      // The budget is now spent, so the next call is refused without sending anything.
      const refused = await captureError(limited.getProduct('7622210100146', ctx));
      expect(refused.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    it('stops retrying when the budget runs out mid-sequence', async () => {
      const limited = withProductBudget(2);
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Service Unavailable', 503));

      const error = await captureError(limited.getProduct('3017620422003', ctx));

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data?.reason).toBe('rate_limited');
      // Waiting and retrying is the right move for the caller, so the refusal stays retryable on
      // the wire even though the retry boundary inside this server must not act on it.
      expect(error.data?.retryable).toBe(true);
      expect(error.data?.retryAfter).toBeGreaterThan(0);
    });

    it('returns the mid-sequence refusal without a further backoff sleep', async () => {
      // A local refusal carrying retryAfter and retryable:true would otherwise be treated as a
      // transient failure by withRetry, which honors data.retryAfter as its delay — the handler
      // would sleep the full window and try again instead of returning.
      const limited = withProductBudget(1);
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Service Unavailable', 503));

      const startedAt = Date.now();
      const error = await captureError(limited.getProduct('3017620422003', ctx));
      const elapsedMs = Date.now() - startedAt;

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      // One backoff, from the 503 that spent the budget — a retried refusal would add a second.
      expect(elapsedMs).toBeLessThan(1_000);
    });

    it('refuses a spent budget with no delay at all', async () => {
      const limited = withProductBudget(1);
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ status: 1, product: { product_name: 'Nutella' } }));

      await limited.getProduct('3017620422003', ctx);

      const startedAt = Date.now();
      await captureError(limited.getProduct('7622210100146', ctx));
      expect(Date.now() - startedAt).toBeLessThan(100);
    });

    it('charges exactly one slot for a call that succeeds on its first attempt', async () => {
      const limited = withProductBudget(2);
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ status: 1, product: { product_name: 'Nutella' } }));

      await limited.getProduct('3017620422003', ctx);
      await limited.getProduct('7622210100146', ctx);
      const refused = await captureError(limited.getProduct('0028400157827', ctx));

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(refused.code).toBe(JsonRpcErrorCode.RateLimited);
    });

    it('derives retryAfter from the oldest request still in the window', async () => {
      // Two slots charged a second apart: the wait is measured from the older one, so it is
      // already below the 60-second window a constant would report.
      const limited = withProductBudget(2);
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ status: 1, product: { product_name: 'Nutella' } }));

      await limited.getProduct('3017620422003', ctx);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await limited.getProduct('7622210100146', ctx);

      const error = await captureError(limited.getProduct('0028400157827', ctx));

      expect(error.data?.retryAfter).toBeLessThan(60);
      expect(error.data?.retryAfter).toBeGreaterThan(55);
    });

    it('charges the search budget per attempt', async () => {
      const limited = new OpenFoodFactsService({
        baseUrl: 'https://world.openfoodfacts.org',
        rateLimitProduct: 100,
        rateLimitSearch: 2,
        rateLimitTaxonomy: 100,
      });
      const ctx = createMockContext({ errors: offSearchProductsTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Service Unavailable', 503));

      const error = await captureError(
        limited.searchProducts({ query: 'chocolate', page: 1, page_size: 20 }, ctx),
      );

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    });

    it('charges the taxonomy budget per attempt', async () => {
      const limited = new OpenFoodFactsService({
        baseUrl: 'https://world.openfoodfacts.org',
        rateLimitProduct: 100,
        rateLimitSearch: 100,
        rateLimitTaxonomy: 2,
      });
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Service Unavailable', 503));

      const error = await captureError(limited.suggestTaxonomy('category', 'hummus', 10, ctx));

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    });

    it('keeps a ten-barcode comparison inside the product budget', async () => {
      // The whole batch runs in parallel, so the budget is what bounds the traffic Open Food Facts
      // sees; the barcodes it could not fund come back in failed[] rather than silently unsent.
      vi.doMock('@/config/server-config.js', () => ({
        getServerConfig: vi.fn(() => ({
          baseUrl: 'https://world.openfoodfacts.org',
          rateLimitProduct: 4,
          rateLimitSearch: 100,
          rateLimitTaxonomy: 100,
        })),
      }));
      vi.resetModules();
      const { initOpenFoodFactsService: init } = await import(
        '@/services/openfoodfacts/openfoodfacts-service.js'
      );
      const { offCompareProductsTool: compare } = await import(
        '@/mcp-server/tools/definitions/compare-products.tool.js'
      );
      init();

      const ctx = createMockContext({ errors: offCompareProductsTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Service Unavailable', 503));

      const barcodes = Array.from({ length: 10 }, (_, i) => `000000000000${i}`.slice(-13));
      const result = await compare.handler({ barcodes }, ctx as never);

      expect(vi.mocked(global.fetch).mock.calls.length).toBeLessThanOrEqual(4);
      expect(result.failed).toHaveLength(10);
      expect(
        result.failed?.filter((f) => f.reason === 'rate_limited').length,
      ).toBeGreaterThanOrEqual(6);

      vi.doUnmock('@/config/server-config.js');
      vi.resetModules();
    });
  });

  // ── retry classification and upstream detail (GH issue #19) ──────────────

  describe('4xx handling', () => {
    /** The body search-a-licious returns when page * page_size exceeds its result window. */
    const windowRejection = {
      detail:
        '1 validation error for SearchParameters\n  Value error, Maximum number of returned results is 10 000 (here: page * page_size = 10002)',
    };

    it('does not retry a text-search 400 and surfaces the upstream explanation', async () => {
      const ctx = createMockContext({ errors: offSearchProductsTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse(windowRejection, 400));

      const startedAt = Date.now();
      const error = await captureError(
        svc.searchProducts({ query: 'chocolate', page: 5001, page_size: 2 }, ctx),
      );
      const elapsedMs = Date.now() - startedAt;

      expect(global.fetch).toHaveBeenCalledOnce();
      // No backoff sequence — the first retry alone would cost about a second.
      expect(elapsedMs).toBeLessThan(500);
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('upstream_rejected');
      expect(error.data?.retryable).toBe(false);
      expect(error.message).toContain('Maximum number of returned results is 10 000');
    });

    it('does not retry a tag-search 4xx, and summarizes the rendered error page', async () => {
      // Deep tag pages are refused with a 401 whose body is the site's rendered error page. Its
      // markup carries no signal, and — as observed live — it opens with a template comment rather
      // than the doctype, so detection must not anchor at the start of the body.
      const errorPage =
        '<!-- start templates/web/common/site_layout.tt.html -->\n\n<!doctype html>\n<html lang="en"><head><title>Error</title></head></html>';
      const ctx = createMockContext({ errors: offSearchProductsTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse(errorPage, 401));

      const error = await captureError(
        svc.searchProducts({ categories_tag: 'en:pizzas', page: 50, page_size: 5 }, ctx),
      );

      expect(global.fetch).toHaveBeenCalledOnce();
      expect(error.data?.reason).toBe('upstream_rejected');
      expect(error.data?.status).toBe(401);
      expect(error.message).toContain('rendered error page');
      expect(error.message).not.toContain('<!doctype');
    });
  });

  // ── User-Agent header verification ───────────────────────────────────────

  describe('User-Agent header', () => {
    it('sends the identifying User-Agent on product requests', async () => {
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ status: 1, product: { product_name: 'Test' } }));

      await svc.getProduct('3017620422003', ctx);

      const init = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit | undefined;
      const ua = (init?.headers as Record<string, string>)?.['User-Agent'];
      expect(ua).toMatch(/openfoodfacts-mcp-server\/\d+\.\d+\.\d+/);
      expect(ua).toContain('caseyjhand.com');
    });

    it('carries the package.json version so the User-Agent cannot drift (GH issue #8)', async () => {
      // The version segment is derived from package.json, not a hand-maintained constant — this
      // pins them together so a release bump can never leave the User-Agent behind.
      const { version } = JSON.parse(
        readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ status: 1, product: { product_name: 'Test' } }));

      await svc.getProduct('3017620422003', ctx);

      const init = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit | undefined;
      const ua = (init?.headers as Record<string, string>)?.['User-Agent'];
      expect(ua).toContain(`openfoodfacts-mcp-server/${version}`);
    });
  });

  // ── requested product fields ──────────────────────────────────────────────

  describe('PRODUCT_FIELDS', () => {
    it('asks Open Food Facts for the serving fields (GH issue #16)', async () => {
      // #16 starts at the request, not the output shape: the default field list never named
      // serving_size or serving_quantity, so per-serving nutrition arrived with no denominator no
      // matter what the output schema declared. serving_quantity_unit is requested with them —
      // the parsed number alone is ambiguous, since it is millilitres for liquids, not grams.
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ status: 1, product: { product_name: 'Test' } }));

      await svc.getProduct('0028400157827', ctx);

      const url = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      const requested = new URL(url).searchParams.get('fields')?.split(',') ?? [];
      expect(requested).toContain('serving_size');
      expect(requested).toContain('serving_quantity');
      expect(requested).toContain('serving_quantity_unit');
      // The whole nutriments object is still requested, so the open nutrient map costs no extra
      // upstream fields.
      expect(requested).toContain('nutriments');
    });

    it('asks for traces, ingredient analysis, and countries of sale (GH issue #32)', async () => {
      // The default field list is what a full product fetch returns, so a field missing from it
      // is invisible to every caller no matter what the output schema declares.
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(mockResponse({ status: 1, product: { product_name: 'Test' } }));

      await svc.getProduct('3046920022651', ctx);

      const url = vi.mocked(global.fetch).mock.calls[0]?.[0] as string;
      const requested = new URL(url).searchParams.get('fields')?.split(',') ?? [];
      expect(requested).toContain('traces_tags');
      expect(requested).toContain('ingredients_analysis_tags');
      expect(requested).toContain('countries_tags');
      // The declared-allergen field keeps its place alongside them.
      expect(requested).toContain('allergens_tags');
    });
  });
});
