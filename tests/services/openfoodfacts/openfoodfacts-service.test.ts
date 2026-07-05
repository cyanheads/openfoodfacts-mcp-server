/**
 * @fileoverview Regression tests for OpenFoodFactsService — covers HTTP 404 not-found handling
 * (Bug #3), text search routing (Bug #2), score-filter query-param mapping (GH issue #3), and
 * User-Agent header verification.
 * @module tests/services/openfoodfacts/openfoodfacts-service.test
 */

import { readFileSync } from 'node:fs';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({
    baseUrl: 'https://world.openfoodfacts.org',
    rateLimitProduct: 100,
    rateLimitSearch: 10,
  })),
}));

import { OpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';

/** Build a minimal service instance with default test config. */
function makeService(): OpenFoodFactsService {
  return new OpenFoodFactsService({
    baseUrl: 'https://world.openfoodfacts.org',
    rateLimitProduct: 100,
    rateLimitSearch: 100,
  });
}

/** Wrap a plain object + status in a minimal Response-like mock. */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
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

    it('throws serviceUnavailable for HTTP 500 (retryable upstream error)', async () => {
      // 5xx is a transient server error — should throw, not return null.
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Internal Server Error', 500));

      await expect(svc.getProduct('3017620422003', ctx)).rejects.toThrow();
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

    it('does not include sort_by in the text-search URL (endpoint ignores it)', async () => {
      // search.openfoodfacts.org does not support server-side sort — verify it is not sent.
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
      expect(fetchCall).not.toContain('sort_by');
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
});
