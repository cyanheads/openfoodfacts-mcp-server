/**
 * @fileoverview Regression tests for OpenFoodFactsService — covers HTTP 404 not-found handling
 * (Bug #3), text search routing (Bug #2), score-filter query-param mapping (GH issue #3), the
 * declared error contract carried by every failure (GH issue #12), retry classification and
 * upstream-detail surfacing (GH issue #19), status-decided retryability (GH issue #37), and
 * User-Agent header verification.
 * @module tests/services/openfoodfacts/openfoodfacts-service.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  ANALYZER_STOP_WORDS,
  STOP_WORD_LANGS,
} from '@/services/openfoodfacts/analyzer-stop-words.js';
import {
  initOpenFoodFactsService,
  OpenFoodFactsService,
} from '@/services/openfoodfacts/openfoodfacts-service.js';
import { getTaxonomyService, initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';
import {
  UPSTREAM_MULTI_MATCH_FIELDS,
  UPSTREAM_TEXT_LANGS,
} from '../../fixtures/text-search-fields.js';

/** The text search endpoint, which takes its parameters as a JSON body. */
const TEXT_SEARCH_URL = 'https://search.openfoodfacts.org/search';

/** The summary fields both search paths request, in request order. */
const SEARCH_FIELD_LIST = [
  'code',
  'product_name',
  'brands',
  'nutriscore_grade',
  'nova_group',
  'ecoscore_grade',
  'categories_tags',
];

/**
 * The per-word group the text path must build: the word, as it will appear in `q`, against every
 * field the backend's own relevance match searches. Built from the captured upstream field list,
 * not from the service's constant, so a derivation error in the service fails here.
 */
function wordGroup(word: string): string {
  return `(${UPSTREAM_MULTI_MATCH_FIELDS.map((field) => `${field}:${word}`).join(' OR ')})`;
}

/** The request the stubbed fetch received on a given call: URL, method, JSON body, and headers. */
function sentRequest(call = 0): {
  url: string;
  method: string | undefined;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
} {
  const [url, init] = (vi.mocked(global.fetch).mock.calls[call] ?? []) as [
    unknown,
    RequestInit | undefined,
  ];
  return {
    url: String(url),
    method: init?.method,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
}

/** The Lucene `q` the text path sent on a given call, read from the JSON body. */
function sentQ(call = 0): string {
  return String(sentRequest(call).body?.q ?? '');
}

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

      const q = sentQ();
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

      const q = sentQ();
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

      // The per-word groups name their own fields; strip them, and what remains — the caller's
      // text — carries no unescaped colon.
      const q = sentQ();
      const callerText = q.replace(/\([^()]*\)/g, '').trim();
      expect(callerText).toBe('brands\\: nutella');
      expect(callerText).not.toMatch(/(?<!\\):/);
      // Inside a group the caller's colon is escaped too, so it stays part of the word.
      expect(q).toContain('brands:brands\\:');
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
      expect(sentRequest().body?.sort_by).toBe('-popularity_key');
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

        expect(sentRequest().body?.sort_by).toBe(`-${value}`);
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
      expect(sentRequest().body).toBeDefined();
      expect(sentRequest().body).not.toHaveProperty('sort_by');

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
        { code: '0000000001001', product_name: 'A' },
        { code: '0000000001002', product_name: 'B' },
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

      const q = sentQ();
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
      expect(sentQ()).toContain('chocolate');
      expect(sentQ()).not.toContain('additives_tags');
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
      return sentQ();
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

      expect(sentRequest().body?.sort_by).toBe('-unique_scans_n');
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

  // ── #37: the HTTP status decides retryability; the body only shapes the message ──
  //
  // Driven through the real withRetry + fetchWithTimeout against a stubbed global fetch, so the
  // attempt count is the number of requests Open Food Facts would see. Fake timers skip the
  // backoff sleeps without skipping the retries themselves.

  describe('status decides retryability', () => {
    /** The rendered page Product Opener serves on a refused request (seen live on search page 11). */
    const refusalPage =
      '<!-- start templates/web/common/site_layout.tt.html -->\n\n<!doctype html>\n<html lang="en"><head><title>Error</title></head><body>Error</body></html>';

    /** Run a service call to settlement with the retry backoff collapsed onto fake timers. */
    async function settle(run: () => Promise<unknown>): Promise<McpErrorish> {
      vi.useFakeTimers();
      try {
        const pending = captureError(run());
        await vi.runAllTimersAsync();
        return await pending;
      } finally {
        vi.useRealTimers();
      }
    }

    it('rejects a 501 once as upstream_rejected, not a retried upstream_error', async () => {
      // fetchWithTimeout flags a 501 data.retryable: false; the published-field allowlist used to
      // drop the flag and upstream_error set retryable: true again, so it was sent four times.
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Not Implemented', 501));

      const error = await settle(() => svc.getProduct('3017620422003', ctx));

      expect(global.fetch).toHaveBeenCalledOnce();
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data?.reason).toBe('upstream_rejected');
      expect(error.data?.retryable).toBe(false);
      expect(error.data?.status).toBe(501);
      expect(error.message).toContain('HTTP 501');
      expect(error.message).not.toContain('failed after');
      expect(error.data?.recovery?.hint).toBe(
        offGetProductTool.errors?.find((e) => e.reason === 'upstream_rejected')?.recovery,
      );
    });

    it('rejects a 501 once on the search and taxonomy paths too', async () => {
      const searchCtx = createMockContext({ errors: offSearchProductsTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Not Implemented', 501));
      const searchError = await settle(() =>
        svc.searchProducts({ categories_tag: 'en:pizzas', page: 1, page_size: 20 }, searchCtx),
      );
      expect(global.fetch).toHaveBeenCalledOnce();
      expect(searchError.data?.reason).toBe('upstream_rejected');

      global.fetch = vi.fn().mockResolvedValue(mockResponse('Not Implemented', 501));
      const taxonomyError = await settle(() =>
        svc.suggestTaxonomy('category', 'hummus', 10, createMockContext()),
      );
      expect(global.fetch).toHaveBeenCalledOnce();
      expect(taxonomyError.data?.reason).toBe('upstream_rejected');
    });

    it.each([401, 403])(
      'describes an HTML-bodied %i as a refusal, sent once, without blaming load',
      async (status) => {
        // Product Opener answers anonymous clients 401 with a rendered page for every search page
        // past 10. The retry flag was already right (#19); the message still blamed load shedding.
        const ctx = createMockContext({ errors: offSearchProductsTool.errors });
        global.fetch = vi.fn().mockResolvedValue(mockResponse(refusalPage, status));

        const error = await settle(() =>
          svc.searchProducts({ categories_tag: 'en:pizzas', page: 11, page_size: 50 }, ctx),
        );

        expect(global.fetch).toHaveBeenCalledOnce();
        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data?.reason).toBe('upstream_rejected');
        expect(error.data?.retryable).toBe(false);
        expect(error.data?.status).toBe(status);
        expect(error.message).toContain(`refused the request (HTTP ${status})`);
        expect(error.message).toContain('rendered error page');
        expect(error.message).not.toMatch(/shedding load|load/i);
        expect(error.message).not.toMatch(/<!doctype|<html/i);
      },
    );

    it.each([500, 502, 503])(
      'keeps a %i an upstream_error, retryable, retried for the full budget',
      async (status) => {
        const ctx = createMockContext({ errors: offGetProductTool.errors });
        global.fetch = vi.fn().mockResolvedValue(mockResponse('Upstream failure', status));

        const error = await settle(() => svc.getProduct('3017620422003', ctx));

        expect(global.fetch).toHaveBeenCalledTimes(4);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data?.reason).toBe('upstream_error');
        expect(error.data?.retryable).toBe(true);
        expect(error.data?.status).toBe(status);
      },
    );

    it('keeps an HTML-bodied 503 an upstream_error that names load, retried for the full budget', async () => {
      const ctx = createMockContext({ errors: offSearchProductsTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse(refusalPage, 503));

      const error = await settle(() =>
        svc.searchProducts({ categories_tag: 'en:pizzas', page: 2, page_size: 50 }, ctx),
      );

      expect(global.fetch).toHaveBeenCalledTimes(4);
      expect(error.data?.reason).toBe('upstream_error');
      expect(error.data?.retryable).toBe(true);
      expect(error.message).toContain('rendered error page');
      expect(error.message).toContain('shedding load');
    });

    it('keeps an HTML page served with a 200 an upstream_error, retried for the full budget', async () => {
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
            json: async () => JSON.parse(refusalPage),
            text: async () => refusalPage,
          }) as unknown as Response,
      );

      const error = await settle(() => svc.getProduct('3017620422003', ctx));

      expect(global.fetch).toHaveBeenCalledTimes(4);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBe('upstream_error');
      expect(error.data?.retryable).toBe(true);
    });

    it('keeps a 504 an upstream_timeout, retried for the full budget', async () => {
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Gateway Timeout', 504));

      const error = await settle(() => svc.getProduct('3017620422003', ctx));

      expect(global.fetch).toHaveBeenCalledTimes(4);
      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data?.reason).toBe('upstream_timeout');
      expect(error.data?.retryable).toBe(true);
    });

    it('keeps a 429 rate_limited, retried for the full budget', async () => {
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Too Many Requests', 429));

      const error = await settle(() => svc.getProduct('3017620422003', ctx));

      expect(global.fetch).toHaveBeenCalledTimes(4);
      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data?.reason).toBe('rate_limited');
      expect(error.data?.retryable).toBe(true);
    });

    it('surfaces a 501 from off_get_product as upstream_rejected after one request', async () => {
      // The issue's second repro, end to end through the tool handler and the real service.
      initOpenFoodFactsService();
      const ctx = createMockContext({ errors: offGetProductTool.errors });
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Not Implemented', 501));

      const error = await settle(async () =>
        offGetProductTool.handler({ barcode: '3017620422003' }, ctx),
      );

      expect(global.fetch).toHaveBeenCalledOnce();
      expect(error.data?.reason).toBe('upstream_rejected');
      expect(error.data?.retryable).toBe(false);
      expect(error.data?.status).toBe(501);
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

  // ── #47: the text path sends every indexed language, by POST ─────────────

  /** A text-search success envelope carrying the given hits. */
  function textHits(hits: Record<string, unknown>[], count = hits.length): Response {
    return mockResponse({
      count,
      is_count_exact: true,
      page: 1,
      page_size: 20,
      page_count: 1,
      hits,
    });
  }

  describe('text search request (#47)', () => {
    it('sends the search as a POST with every parameter in a JSON body', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(textHits([]));

      await svc.searchProducts(
        { query: 'dark chocolate', sort_by: 'popularity_key', page: 2, page_size: 5 },
        ctx,
      );

      const request = sentRequest();
      expect(request.url).toBe(TEXT_SEARCH_URL);
      expect(request.method).toBe('POST');
      expect(request.headers['Content-Type']).toBe('application/json');
      expect(request.headers['User-Agent']).toMatch(/^openfoodfacts-mcp-server\//);
      expect(request.body).toEqual({
        q: `${wordGroup('dark')} ${wordGroup('chocolate')} dark chocolate`,
        langs: [...UPSTREAM_TEXT_LANGS],
        fields: SEARCH_FIELD_LIST,
        page: 2,
        page_size: 5,
        sort_by: '-popularity_key',
      });
    });

    it('sends the 31 analyzed languages on a nutrient-only search too', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(textHits([]));

      await svc.searchProducts(
        {
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lte', value: 5 }],
          page: 1,
          page_size: 20,
        },
        ctx,
      );

      expect(sentRequest().method).toBe('POST');
      expect(sentRequest().body).toEqual({
        q: 'nutriments.sugars_100g:[* TO 5]',
        langs: [...UPSTREAM_TEXT_LANGS],
        fields: SEARCH_FIELD_LIST,
        page: 1,
        page_size: 20,
      });
    });

    it('keeps the tag-only path a GET on /api/v2/search carrying no body', async () => {
      // Characterization: the tag path is untouched by the text-path transport change.
      const ctx = createMockContext();
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 1, page: 1, page_count: 1, page_size: 20, products: [] }),
        );

      await svc.searchProducts({ categories_tag: 'en:spreads', page: 1, page_size: 20 }, ctx);

      const request = sentRequest();
      expect(request.method ?? 'GET').toBe('GET');
      expect(request.body).toBeUndefined();
      expect(request.url).toBe(
        'https://world.openfoodfacts.org/api/v2/search?fields=code%2Cproduct_name%2Cbrands%2Cnutriscore_grade%2Cnova_group%2Cecoscore_grade%2Ccategories_tags&categories_tags=en%3Aspreads&page=1&page_size=20',
      );
    });

    it('surfaces the message of a JSON-body validation error, not the request it echoes', async () => {
      // A POST that fails validation answers 422 with `detail` as a list of objects, each echoing
      // the whole request body under `input`, where a GET answered 400 with a `detail` string.
      const ctx = createMockContext({ errors: offSearchProductsTool.errors });
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse(
          {
            detail: [
              {
                type: 'value_error',
                loc: ['body'],
                msg: 'Value error, Maximum number of returned results is 10 000 (here: page * page_size = 500000)',
                input: { q: 'chocolate', langs: [...UPSTREAM_TEXT_LANGS], page: 10000 },
                ctx: { error: {} },
              },
            ],
          },
          422,
        ),
      );

      const error = await captureError(
        svc.searchProducts({ query: 'chocolate', page: 10_000, page_size: 50 }, ctx),
      );

      expect(global.fetch).toHaveBeenCalledOnce();
      expect(error.data?.reason).toBe('upstream_rejected');
      expect(error.message).toContain('Maximum number of returned results is 10 000');
      expect(error.message).not.toContain('"loc"');
      expect(error.message).not.toContain('langs');
    });

    it('still finds the message when the echoed request pushes the body past the capture limit', async () => {
      // A real Response streams, so the framework keeps only a bounded head and tail of it and the
      // JSON no longer parses; the message leads each entry, so it survives in the head.
      const ctx = createMockContext({ errors: offSearchProductsTool.errors });
      const detail = [
        {
          type: 'value_error',
          loc: ['body'],
          msg: 'Value error, Maximum number of returned results is 10 000 (here: page * page_size = 500000)',
          input: { q: 'chocolate '.repeat(3_000), langs: [...UPSTREAM_TEXT_LANGS] },
        },
      ];
      global.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ detail }), {
            status: 422,
            headers: { 'content-type': 'application/json' },
          }),
      );

      const error = await captureError(
        svc.searchProducts({ query: 'chocolate', page: 10_000, page_size: 50 }, ctx),
      );

      expect(error.data?.reason).toBe('upstream_rejected');
      expect(error.message).toContain('Maximum number of returned results is 10 000');
      expect(error.message).not.toContain('"loc"');
    });

    it('reports an error envelope served with HTTP 200 as a failure, never as zero matches', async () => {
      // search-a-licious answers an Elasticsearch failure with HTTP 200 and an `errors` list in
      // place of `hits` and `count`. Read as a success, that is an exact "no products".
      const ctx = createMockContext({ errors: offSearchProductsTool.errors });
      global.fetch = vi.fn(async () =>
        mockResponse({
          debug: { query: {} },
          errors: [
            {
              title: 'es_api_error',
              description:
                "ApiError(500, 'search_phase_execution_exception', 'too_many_nested_clauses: Query contains too many nested clauses; maxClauseCount is set to 4228')",
            },
          ],
        }),
      );

      vi.useFakeTimers();
      try {
        const pending = captureError(
          svc.searchProducts({ query: 'chocolate', page: 1, page_size: 20 }, ctx),
        );
        await vi.runAllTimersAsync();
        const error = await pending;

        expect(error.data?.reason).toBe('upstream_error');
        expect(error.data?.retryable).toBe(true);
        expect(error.message).toContain('too_many_nested_clauses');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── #38: every word of the query constrains the result ───────────────────

  describe('per-word groups (#38)', () => {
    /** Run a text search with the given parameters and return the `q` it sent. */
    async function qFor(params: Record<string, unknown>): Promise<string> {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(textHits([]));
      await svc.searchProducts({ page: 1, page_size: 20, ...params }, ctx);
      return sentQ();
    }

    it('groups each word over exactly the fields the backend searches for the 31 languages', async () => {
      const q = await qFor({ query: 'milk chocolate' });

      expect(q).toBe(`${wordGroup('milk')} ${wordGroup('chocolate')} milk chocolate`);
      for (const word of ['milk', 'chocolate']) {
        const fields = [...q.matchAll(new RegExp(`([a-z_]+(?:\\.[a-z]{2})?):${word}\\b`, 'g'))].map(
          (m) => m[1],
        );
        expect(new Set(fields)).toEqual(new Set(UPSTREAM_MULTI_MATCH_FIELDS));
        expect(fields).toHaveLength(75);
      }
    });

    it('sends a one-word query with no group, which the relevance match already requires', async () => {
      // Live: `milk` in Mongolia matches the same 6 products with or without its group, and the
      // group costs about 200 ms a search.
      await expect(qFor({ query: 'Milk' })).resolves.toBe('milk');
      await expect(qFor({ query: 'dark-chocolate', labels_tag: 'en:organic' })).resolves.toBe(
        'labels_tags:"en:organic" dark\\-chocolate',
      );
    });

    it('still groups the one required word of a query that also carries a stop word', async () => {
      await expect(qFor({ query: 'the chocolate' })).resolves.toBe(
        `${wordGroup('chocolate')} the chocolate`,
      );
    });

    it('orders tag clauses, nutrient clauses, one group per word, then the bare words', async () => {
      const q = await qFor({
        query: 'Milk chocolate',
        countries_tag: 'en:mongolia',
        nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 50 }],
      });

      expect(q).toBe(
        `countries_tags:"en:mongolia" nutriments.sugars_100g:{* TO 50} ${wordGroup('milk')} ${wordGroup('chocolate')} milk chocolate`,
      );
    });

    it('reads uppercase AND, OR and NOT as words, never as operators', async () => {
      const q = await qFor({ query: 'milk AND chocolate OR NOT cocoa' });

      expect(q).toBe(
        `${wordGroup('milk')} ${wordGroup('chocolate')} ${wordGroup('cocoa')} milk and chocolate or not cocoa`,
      );
      expect(q).not.toMatch(/\b(AND|NOT)\b/);
      expect(q.replaceAll(' OR ', ' ')).not.toMatch(/\bOR\b/);
    });

    it('forms no group for a token with no letter or digit', async () => {
      // A group over a punctuation-only token analyzes to nothing in every field and matches no
      // product (live: `milk -` with a group for `-` → 0; without it → 6, Mongolia).
      const q = await qFor({ query: 'milk - & chocolate' });

      expect(q).toBe(`${wordGroup('milk')} ${wordGroup('chocolate')} milk \\- \\& chocolate`);
    });

    it('forms no group for a word the English analyzer drops as a stop word', async () => {
      // `with` never reaches the English name index, so its group could match only through other
      // fields (live: chocolate with hazelnuts → 84 with a `with` group, 5,840 without).
      const q = await qFor({ query: 'chocolate with hazelnuts, and the' });

      expect(q).toBe(
        `${wordGroup('chocolate')} ${wordGroup('hazelnuts,')} chocolate with hazelnuts, and the`,
      );
    });

    it.each([
      // French: `de` is dropped from product_name.fr and categories.fr (live: a group for it over
      // those fields alone matched 0), so requiring it cut confiture de fraise to 237 from 3,251.
      ['confiture de fraise', ['confiture', 'fraise']],
      ['galletas con chocolate', ['galletas', 'chocolate']],
      ['schokolade mit nüssen', ['schokolade', 'nüssen']],
      // Portuguese `de` is also a French and Spanish stop word, so it stays optional.
      ['doce de leite', ['doce', 'leite']],
      ['latte e cacao', ['latte', 'cacao']],
    ])(
      'forms no group for a stop word of a language holding 1%+ of named products: %s',
      async (query, grouped) => {
        const q = await qFor({ query });

        expect(q).toBe(`${grouped.map(wordGroup).join(' ')} ${query}`);
      },
    );

    it.each([
      // Below the threshold: Portuguese `com` (0.75% of named products), Dutch `met` (0.83%),
      // Russian `и` (0.38%), Hindi `इसका` (0.004%). Each still forms a group.
      ['pão com queijo', ['pão', 'com', 'queijo']],
      ['soep met balletjes', ['soep', 'met', 'balletjes']],
      ['chleb и масло', ['chleb', 'и', 'масло']],
      ['इसका चाय', ['इसका', 'चाय']],
    ])('still groups a stop word of a language below the threshold: %s', async (query, grouped) => {
      const q = await qFor({ query });

      expect(q).toBe(`${grouped.map(wordGroup).join(' ')} ${query}`);
    });

    it('exempts the stop words of English, French, Spanish, German, and Italian only, 949 in all', () => {
      expect([...STOP_WORD_LANGS]).toEqual(['en', 'fr', 'es', 'de', 'it']);
      const selected = new Set(
        STOP_WORD_LANGS.flatMap((lang) => ANALYZER_STOP_WORDS[lang].split(/\s+/).filter(Boolean)),
      );
      expect(selected.size).toBe(949);
      expect(selected.has('door')).toBe(false);
      expect(selected.has('soy')).toBe(true);
    });

    it('treats a word that is a stop word only in another language as optional too', async () => {
      // The chosen trade-off: Spanish `soy` ("I am") is a stop word, so `soy milk` requires only
      // `milk`, and `soy` still ranks the soy milks first through the bare words.
      await expect(qFor({ query: 'soy milk' })).resolves.toBe(`${wordGroup('milk')} soy milk`);
    });

    it('keeps a stop list for every indexed language, 5,928 words in all', () => {
      const lists = Object.entries(ANALYZER_STOP_WORDS).map(
        ([lang, words]) => [lang, words.split(/\s+/).filter(Boolean)] as const,
      );

      expect(lists.map(([lang]) => lang)).toEqual([...UPSTREAM_TEXT_LANGS]);
      for (const [, words] of lists) expect(words.length).toBeGreaterThan(0);
      expect(new Set(lists.flatMap(([, words]) => words)).size).toBe(5928);
      const byLang = Object.fromEntries(lists);
      expect(byLang.fr).toContain('de');
      expect(byLang.de).toContain('mit');
      expect(byLang.nl).toContain('door');
      expect(byLang.en).toHaveLength(33);
    });

    it('keeps a field:value-shaped query as words rather than a field clause', async () => {
      const q = await qFor({ query: 'brands: nutella' });

      expect(q).toBe(`${wordGroup('brands\\:')} ${wordGroup('nutella')} brands\\: nutella`);
    });

    it('escapes reserved characters inside a group and groups a repeated word once', async () => {
      const q = await qFor({ query: 'dark-chocolate 70% dark-chocolate' });

      expect(q).toBe(
        `${wordGroup('dark\\-chocolate')} ${wordGroup('70%')} dark\\-chocolate 70% dark\\-chocolate`,
      );
    });

    it('sends only the tag clauses when there is no query', async () => {
      const q = await qFor({
        labels_tag: 'en:organic',
        nutrient_filters: [{ nutrient: 'salt', operator: 'lt', value: 1 }],
      });

      expect(q).toBe('labels_tags:"en:organic" nutriments.salt_100g:{* TO 1}');
    });
  });

  // ── #35: a search row without a barcode is dropped, not carried as "" ─────

  describe('rows without a barcode (#35)', () => {
    const rows = [
      { code: '3017620422003', product_name: 'Nutella', brands: ['Ferrero'] },
      { product_name: 'No code at all' },
      { code: '', product_name: 'Empty code' },
      { code: '   ', product_name: 'Whitespace code' },
      { code: '7622210449283', product_name: 'Prince', nutriscore_grade: 'd' },
    ];

    it('drops them on the text path and counts only the kept rows', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(textHits(rows, 40));

      const result = await svc.searchProducts({ query: 'x', page: 1, page_size: 5 }, ctx);

      expect(result.products.map((p) => p.code)).toEqual(['3017620422003', '7622210449283']);
      expect(result.page_count).toBe(2);
      expect(result.count).toBe(40);
      // Rows with a code are carried unchanged.
      expect(result.products[0]).toEqual({
        code: '3017620422003',
        product_name: 'Nutella',
        brands: 'Ferrero',
      });
      expect(result.products[1]?.nutriscore_grade).toBe('d');
    });

    it('drops them on the tag path and counts only the kept rows', async () => {
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 40,
          page: 1,
          page_count: 5,
          page_size: 5,
          products: rows.map((row) =>
            'brands' in row ? { ...row, brands: (row.brands as string[]).join(', ') } : row,
          ),
        }),
      );

      const result = await svc.searchProducts(
        { categories_tag: 'en:spreads', page: 1, page_size: 5 },
        ctx,
      );

      expect(result.products.map((p) => p.code)).toEqual(['3017620422003', '7622210449283']);
      expect(result.page_count).toBe(2);
      expect(result.products[1]).toEqual({
        code: '7622210449283',
        product_name: 'Prince',
        nutriscore_grade: 'd',
      });
    });

    it('never hands off_search_products a row whose barcode is empty', async () => {
      initOpenFoodFactsService();
      initTaxonomyService();
      global.fetch = vi.fn().mockResolvedValue(textHits(rows, 40));

      const result = await offSearchProductsTool.handler(
        { query: 'x', page: 1, page_size: 5 },
        createMockContext({ errors: offSearchProductsTool.errors }),
      );

      expect(result.products.map((p) => p.barcode)).toEqual(['3017620422003', '7622210449283']);
      expect(result.page_count).toBe(2);
    });
  });

  // ── #46: a search row carries only a barcode off_get_product accepts ──────

  describe('rows whose code no product lookup can serve (#46)', () => {
    /**
     * Codes the text index holds that Product Opener answers "no code or invalid code" for, live
     * 2026-09-23 (`00000636`, `0000000000291`), beside two it serves and one it does not accept.
     */
    const rows = [
      { code: '00000636', product_name: 'Flocons quatre graines' },
      { code: '3017620422003', product_name: 'Nutella' },
      { code: '0000000000291', product_name: 'Mendiants' },
      { code: '00097', product_name: 'Five characters, two significant digits' },
      { code: '6035215', product_name: 'Short code' },
      { code: '3017620422003 ', product_name: 'Trailing space' },
    ];

    it('drops them on the text path before page_count is set', async () => {
      global.fetch = vi.fn().mockResolvedValue(textHits(rows, 6));

      const result = await svc.searchProducts(
        { query: 'x', page: 1, page_size: 6 },
        createMockContext(),
      );

      expect(result.products.map((p) => p.code)).toEqual(['3017620422003', '6035215']);
      expect(result.page_count).toBe(2);
      expect(result.count).toBe(6);
      expect(result.dropped).toBe(4);
    });

    it('reports no drop on a page whose codes are all servable', async () => {
      global.fetch = vi.fn().mockResolvedValue(textHits([{ code: '3017620422003' }], 1));

      const result = await svc.searchProducts(
        { query: 'x', page: 1, page_size: 1 },
        createMockContext(),
      );

      expect(result.dropped).toBe(0);
    });

    it('drops them on the tag path before page_count is set', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 6, page: 1, page_count: 6, page_size: 6, products: rows }),
        );

      const result = await svc.searchProducts(
        { categories_tag: 'en:honeys', page: 1, page_size: 6 },
        createMockContext(),
      );

      expect(result.products.map((p) => p.code)).toEqual(['3017620422003', '6035215']);
      expect(result.page_count).toBe(2);
      expect(result.dropped).toBe(4);
    });

    it('emits only barcodes off_get_product accepts', async () => {
      initOpenFoodFactsService();
      initTaxonomyService();
      global.fetch = vi.fn().mockResolvedValue(textHits(rows, 6));

      const result = await offSearchProductsTool.handler(
        { query: 'x', page: 1, page_size: 6 },
        createMockContext({ errors: offSearchProductsTool.errors }),
      );

      expect(result.products).toHaveLength(2);
      for (const { barcode } of result.products) {
        expect(offGetProductTool.input.safeParse({ barcode }).success).toBe(true);
      }
      expect(result.omitted).toBe(4);
    });

    it('does not call a page of only unservable codes past the end, on either surface', async () => {
      initOpenFoodFactsService();
      initTaxonomyService();
      global.fetch = vi.fn().mockResolvedValue(textHits([{ code: '00000636' }], 3));

      const result = await runToolContract(offSearchProductsTool, {
        query: 'flocons quatre graines',
        page: 1,
        page_size: 1,
      });

      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ total: 3, page_count: 0, omitted: 1, products: [] });
      const notice = String(structured.notice ?? '');
      expect(notice).not.toMatch(/past the end/i);
      expect(notice).toContain('Request page 2');
      const text = (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      expect(text).not.toMatch(/past the end|No products found/i);
      expect(text).toMatch(/1 match on this page .*left off/i);
    });
  });

  // ── #39: tag values reach the text path in canonical form ────────────────

  describe('tag canonicalization on the text path (#39)', () => {
    /**
     * Routes the stubbed fetch: autocomplete calls answer from `options` keyed by taxonomy name
     * (the live responses captured 2026-09-22 for `US` and `peanut`), and the search answers one
     * hit. Every request is recorded in call order.
     */
    function routeFetch(options: Record<string, { id: string; text: string }[]>): void {
      global.fetch = vi.fn(async (input: unknown) => {
        const url = new URL(String(input));
        if (url.pathname === '/autocomplete') {
          const taxonomy = url.searchParams.get('taxonomy_names') ?? '';
          return mockResponse({ took: 1, timed_out: false, options: options[taxonomy] ?? [] });
        }
        return textHits([{ code: '3017620422003' }], 1);
      });
    }

    beforeEach(() => {
      initOpenFoodFactsService();
      initTaxonomyService();
    });

    /** Requests the stubbed fetch received, as `pathname?taxonomy_names&q` or `search`. */
    function requestLog(): string[] {
      return vi.mocked(global.fetch).mock.calls.map(([input]) => {
        const url = new URL(String(input));
        return url.pathname === '/autocomplete'
          ? `autocomplete:${url.searchParams.get('taxonomy_names')}:${url.searchParams.get('q')}`
          : url.pathname;
      });
    }

    it('quotes the canonical value for a brand, a country synonym, a singular, and a case variant', async () => {
      routeFetch({
        country: [
          { id: 'en:united-states', text: 'US' },
          { id: 'en:soviet-union', text: 'USSR' },
        ],
        allergen: [{ id: 'en:peanuts', text: 'peanut' }],
      });

      await offSearchProductsTool.handler(
        {
          query: 'butter',
          brands_tag: 'Nutella',
          countries_tag: 'US',
          allergens_tag: 'en:peanut',
          labels_tag: 'EN:Organic',
          page: 1,
          page_size: 20,
        },
        createMockContext({ errors: offSearchProductsTool.errors }),
      );

      const searchCall = requestLog().indexOf('/search');
      const q = sentQ(searchCall);
      expect(q).toContain('brands_tags:"nutella"');
      expect(q).toContain('countries_tags:"en:united-states"');
      expect(q).toContain('allergens_tags:"en:peanuts"');
      expect(q).toContain('labels_tags:"en:organic"');
      // The brand is slugged locally and the label resolves from the offline sample; only the two
      // values the sample cannot confirm cost a live lookup.
      expect(requestLog().sort()).toEqual(
        ['/search', 'autocomplete:allergen:peanut', 'autocomplete:country:US'].sort(),
      );
    });

    it('sends an unconfirmable value normalized and still runs the search', async () => {
      global.fetch = vi.fn(async (input: unknown) =>
        new URL(String(input)).pathname === '/autocomplete'
          ? mockResponse({ detail: 'refused' }, 400)
          : textHits([], 0),
      );

      const result = await offSearchProductsTool.handler(
        { query: 'oat milk', countries_tag: 'Never Land', page: 1, page_size: 20 },
        createMockContext({ errors: offSearchProductsTool.errors }),
      );

      expect(result.total).toBe(0);
      expect(sentQ(requestLog().indexOf('/search'))).toContain('countries_tags:"en:never-land"');
    });

    it('leaves the tag-only request byte-identical and makes no lookup', async () => {
      // Characterization: Product Opener canonicalizes tag parameters itself.
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 1, page: 1, page_count: 1, page_size: 20, products: [] }),
        );

      await offSearchProductsTool.handler(
        { brands_tag: 'Nutella', countries_tag: 'US', page: 1, page_size: 20 },
        createMockContext({ errors: offSearchProductsTool.errors }),
      );

      expect(global.fetch).toHaveBeenCalledOnce();
      const url = new URL(sentRequest().url);
      expect(url.pathname).toBe('/api/v2/search');
      expect(url.searchParams.get('brands_tags')).toBe('Nutella');
      expect(url.searchParams.get('countries_tags')).toBe('US');
    });
  });

  // ── #41: exclusion, trace, verdict, and multi-label filters ──────────────

  describe('exclusion, trace, verdict, and multi-label filters (#41)', () => {
    /** The tag-path URL prefix every search carries: endpoint plus the summary field list. */
    const TAG_SEARCH_PREFIX =
      'https://world.openfoodfacts.org/api/v2/search?fields=code%2Cproduct_name%2Cbrands%2Cnutriscore_grade%2Cnova_group%2Cecoscore_grade%2Ccategories_tags';

    /** Run a tag-only search with the given parameters and return the URL it fetched. */
    async function tagUrlFor(params: Record<string, unknown>): Promise<string> {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 1, page: 1, page_count: 1, page_size: 20, products: [] }),
        );
      await svc.searchProducts({ page: 1, page_size: 20, ...params }, createMockContext());
      expect(global.fetch).toHaveBeenCalledOnce();
      return sentRequest().url;
    }

    /** Run a text search with the given parameters and return the `q` it sent. */
    async function textQFor(params: Record<string, unknown>): Promise<string> {
      global.fetch = vi.fn().mockResolvedValue(textHits([]));
      await svc.searchProducts({ page: 1, page_size: 20, ...params }, createMockContext());
      return sentQ();
    }

    it('sends single-string labels_tag and allergens_tag byte-identically', async () => {
      // Characterization: the request a single-value call produced before these filters existed.
      await expect(tagUrlFor({ labels_tag: 'en:organic', allergens_tag: 'en:nuts' })).resolves.toBe(
        `${TAG_SEARCH_PREFIX}&labels_tags=en%3Aorganic&allergens_tags=en%3Anuts&page=1&page_size=20`,
      );
    });

    it('joins an inclusion and its exclusions into one allergens_tags value', async () => {
      // Product Opener ANDs comma-separated values and negates a `-` prefix within one parameter
      // (live: en:chocolates with allergens_tags=en:nuts,-en:milk → 1,302 of en:nuts' 6,603).
      await expect(
        tagUrlFor({ allergens_tag: 'en:nuts', exclude_allergens: ['en:milk', 'en:soybeans'] }),
      ).resolves.toBe(
        `${TAG_SEARCH_PREFIX}&allergens_tags=en%3Anuts%2C-en%3Amilk%2C-en%3Asoybeans&page=1&page_size=20`,
      );
    });

    it('sends an exclusion alone as a negated value', async () => {
      await expect(tagUrlFor({ exclude_allergens: ['en:nuts'] })).resolves.toBe(
        `${TAG_SEARCH_PREFIX}&allergens_tags=-en%3Anuts&page=1&page_size=20`,
      );
    });

    it('sends traces, the ingredient verdict, and several labels on the tag path', async () => {
      await expect(
        tagUrlFor({
          categories_tag: 'en:chocolates',
          labels_tag: ['en:organic', 'en:fair-trade'],
          traces_tag: 'en:nuts',
          exclude_traces: ['en:milk'],
          ingredients_analysis_tag: 'en:vegan',
        }),
      ).resolves.toBe(
        `${TAG_SEARCH_PREFIX}&categories_tags=en%3Achocolates&labels_tags=en%3Aorganic%2Cen%3Afair-trade&traces_tags=en%3Anuts%2C-en%3Amilk&ingredients_analysis_tags=en%3Avegan&page=1&page_size=20`,
      );
    });

    it('sends a one-element labels array exactly as the single string', async () => {
      await expect(tagUrlFor({ labels_tag: ['en:organic'] })).resolves.toBe(
        `${TAG_SEARCH_PREFIX}&labels_tags=en%3Aorganic&page=1&page_size=20`,
      );
    });

    it('orders inclusions, then exclusions, then nutrients, groups, and words on the text path', async () => {
      const q = await textQFor({
        query: 'milk chocolate',
        countries_tag: 'en:mongolia',
        labels_tag: ['en:organic', 'en:fair-trade'],
        allergens_tag: 'en:nuts',
        traces_tag: 'en:milk',
        ingredients_analysis_tag: 'en:vegan',
        exclude_allergens: ['en:gluten', 'en:eggs'],
        exclude_traces: ['en:peanuts'],
        nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 50 }],
      });

      expect(q).toBe(
        'labels_tags:"en:organic" labels_tags:"en:fair-trade" allergens_tags:"en:nuts" ' +
          'traces_tags:"en:milk" ingredients_analysis_tags:"en:vegan" countries_tags:"en:mongolia" ' +
          '-allergens_tags:"en:gluten" -allergens_tags:"en:eggs" -traces_tags:"en:peanuts" ' +
          `nutriments.sugars_100g:{* TO 50} ${wordGroup('milk')} ${wordGroup('chocolate')} milk chocolate`,
      );
    });

    it('sends a single-string labels_tag on the text path as one clause', async () => {
      // Characterization: unchanged from before labels_tag took an array.
      await expect(textQFor({ query: 'chocolate', labels_tag: 'en:organic' })).resolves.toBe(
        'labels_tags:"en:organic" chocolate',
      );
    });

    describe('through off_search_products', () => {
      beforeEach(() => {
        initOpenFoodFactsService();
        initTaxonomyService();
      });

      /**
       * Routes the stubbed fetch: autocomplete calls answer from `options` keyed by taxonomy name
       * (or with `lookupStatus` when set), and both search endpoints answer one row.
       */
      function routeFetch(
        options: Record<string, { id: string; text: string }[]> = {},
        lookupStatus?: number,
      ): void {
        global.fetch = vi.fn(async (input: unknown) => {
          const url = new URL(String(input));
          if (url.pathname === '/autocomplete') {
            if (lookupStatus !== undefined)
              return mockResponse({ detail: 'refused' }, lookupStatus);
            const taxonomy = url.searchParams.get('taxonomy_names') ?? '';
            return mockResponse({ took: 1, timed_out: false, options: options[taxonomy] ?? [] });
          }
          if (url.pathname === '/search') return textHits([{ code: '3017620422003' }], 1);
          return mockResponse({
            count: 1,
            page: 1,
            page_count: 1,
            page_size: 20,
            products: [{ code: '3017620422003' }],
          });
        });
      }

      /** Every request the stubbed fetch received, as `autocomplete:<taxonomy>:<q>` or a path. */
      function requestLog(): string[] {
        return vi.mocked(global.fetch).mock.calls.map(([input]) => {
          const url = new URL(String(input));
          return url.pathname === '/autocomplete'
            ? `autocomplete:${url.searchParams.get('taxonomy_names')}:${url.searchParams.get('q')}`
            : url.pathname;
        });
      }

      /** Run the tool handler and return its rejection, failing the test if it resolves. */
      async function rejectionOf(input: Record<string, unknown>): Promise<McpErrorish> {
        try {
          await offSearchProductsTool.handler(
            { page: 1, page_size: 20, ...input } as never,
            createMockContext({ errors: offSearchProductsTool.errors }),
          );
        } catch (error) {
          return error as McpErrorish;
        }
        throw new Error('Expected the handler to reject.');
      }

      it('refuses an exclusion no vocabulary confirms before any search request, on the tag path', async () => {
        routeFetch();

        const error = await rejectionOf({ exclude_allergens: ['en:nutz'] });

        expect(error.data?.reason).toBe('unrecognized_exclusion');
        expect(error.data?.retryable).toBe(false);
        expect(error.data?.recovery?.hint).toContain('off_browse_taxonomy');
        expect(error.message).toContain('en:nutz');
        expect(requestLog()).toEqual(['autocomplete:allergen:nutz']);
      });

      it('refuses it on the text path too', async () => {
        routeFetch();

        const error = await rejectionOf({ query: 'chocolate', exclude_traces: ['Nutz'] });

        expect(error.data?.reason).toBe('unrecognized_exclusion');
        expect(requestLog()).toEqual(['autocomplete:allergen:Nutz']);
      });

      it('refuses an exclusion the vocabulary could not be reached to check, as retryable', async () => {
        routeFetch({}, 400);

        const error = await rejectionOf({ exclude_allergens: ['Lupine'] });

        expect(error.data?.reason).toBe('unrecognized_exclusion');
        expect(error.data?.retryable).toBe(true);
        expect(error.message).toMatch(/could not be checked/i);
        expect(requestLog()).toEqual(['autocomplete:allergen:Lupine']);
      });

      it('sends an offline-confirmed exclusion canonical, with no lookup, on both paths', async () => {
        routeFetch();

        await offSearchProductsTool.handler(
          { exclude_allergens: ['Milk'], page: 1, page_size: 20 },
          createMockContext({ errors: offSearchProductsTool.errors }),
        );
        expect(requestLog()).toEqual(['/api/v2/search']);
        expect(sentRequest().url).toBe(
          `${TAG_SEARCH_PREFIX}&allergens_tags=-en%3Amilk&page=1&page_size=20`,
        );

        routeFetch();
        await offSearchProductsTool.handler(
          { query: 'chocolate', exclude_allergens: ['Milk'], page: 1, page_size: 20 },
          createMockContext({ errors: offSearchProductsTool.errors }),
        );
        expect(requestLog()).toEqual(['/search']);
        expect(sentQ()).toBe('-allergens_tags:"en:milk" chocolate');
      });

      it('resolves trace values against the allergen vocabulary', async () => {
        routeFetch({ allergen: [{ id: 'en:peanuts', text: 'peanut' }] });

        await offSearchProductsTool.handler(
          {
            query: 'butter',
            traces_tag: 'peanut',
            exclude_traces: ['en:milk'],
            page: 1,
            page_size: 20,
          },
          createMockContext({ errors: offSearchProductsTool.errors }),
        );

        expect(requestLog()).toEqual(['autocomplete:allergen:peanut', '/search']);
        expect(sentQ(1)).toBe('traces_tags:"en:peanuts" -traces_tags:"en:milk" butter');
      });

      it('accepts a singular exclusion whose plural is the tag (live response for "nut")', async () => {
        routeFetch({ allergen: [{ id: 'en:nuts', text: 'Nuts' }] });

        await offSearchProductsTool.handler(
          { exclude_allergens: ['en:nut'], page: 1, page_size: 20 },
          createMockContext({ errors: offSearchProductsTool.errors }),
        );

        expect(requestLog()).toEqual(['autocomplete:allergen:nut', '/api/v2/search']);
        expect(sentRequest(1).url).toBe(
          `${TAG_SEARCH_PREFIX}&allergens_tags=-en%3Anuts&page=1&page_size=20`,
        );
      });

      it('shares one lookup between an inclusion and an exclusion of the same value', async () => {
        routeFetch({ allergen: [{ id: 'en:peanuts', text: 'peanut' }] });

        await offSearchProductsTool.handler(
          {
            query: 'butter',
            traces_tag: 'peanut',
            exclude_allergens: ['peanut'],
            page: 1,
            page_size: 20,
          },
          createMockContext({ errors: offSearchProductsTool.errors }),
        );

        expect(requestLog()).toEqual(['autocomplete:allergen:peanut', '/search']);
        expect(sentQ(1)).toBe('traces_tags:"en:peanuts" -allergens_tags:"en:peanuts" butter');
      });

      it('passes tag-path inclusions through untouched, labels array included', async () => {
        routeFetch();

        await offSearchProductsTool.handler(
          {
            labels_tag: ['EN:Organic', 'en:fair-trade'],
            traces_tag: 'Nuts',
            ingredients_analysis_tag: 'en:palm-oil-free',
            page: 1,
            page_size: 20,
          },
          createMockContext({ errors: offSearchProductsTool.errors }),
        );

        expect(requestLog()).toEqual(['/api/v2/search']);
        expect(sentRequest().url).toBe(
          `${TAG_SEARCH_PREFIX}&labels_tags=EN%3AOrganic%2Cen%3Afair-trade&traces_tags=Nuts&ingredients_analysis_tags=en%3Apalm-oil-free&page=1&page_size=20`,
        );
      });

      // ── #44: the tag path serves pages 1–10 only ───────────────────────────

      it('sends a tag-only page 10', async () => {
        // Characterization: page 10 is the deepest page Product Opener serves an anonymous client.
        routeFetch();

        await offSearchProductsTool.handler(
          { categories_tag: 'en:pizzas', page: 10, page_size: 50 },
          createMockContext({ errors: offSearchProductsTool.errors }),
        );

        expect(requestLog()).toEqual(['/api/v2/search']);
        expect(sentRequest().url).toBe(
          `${TAG_SEARCH_PREFIX}&categories_tags=en%3Apizzas&page=10&page_size=50`,
        );
      });

      it('rejects a tag-only page past 10 before any request', async () => {
        // Product Opener answers every anonymous page past 10 with a 401 and a rendered page,
        // whatever the page_size (Display.pm `search_and_display_products`).
        global.fetch = vi.fn().mockResolvedValue(mockResponse('<!doctype html><html></html>', 401));

        const error = await rejectionOf({ categories_tag: 'en:pizzas', page: 11, page_size: 1 });

        expect(global.fetch).not.toHaveBeenCalled();
        expect(error.data).toMatchObject({
          reason: 'page_out_of_range',
          page: 11,
          page_size: 1,
          max_page: 10,
        });
        expect(error.data?.recovery?.hint).toContain('page 10');
      });

      it('keeps text-path paging unchanged: a text page 11 is sent', async () => {
        routeFetch();

        await offSearchProductsTool.handler(
          { query: 'pizza', page: 11, page_size: 50 },
          createMockContext({ errors: offSearchProductsTool.errors }),
        );

        expect(requestLog()).toEqual(['/search']);
        expect(sentRequest().body).toMatchObject({ page: 11, page_size: 50 });
      });

      it('reports the reachable tag-path depth as last_page', async () => {
        global.fetch = vi.fn().mockResolvedValue(
          mockResponse({
            count: 13_435,
            page: 1,
            page_count: 50,
            page_size: 50,
            products: [{ code: '4260414153068' }],
          }),
        );

        const result = await offSearchProductsTool.handler(
          { categories_tag: 'en:pizzas', page: 1, page_size: 50 },
          createMockContext({ errors: offSearchProductsTool.errors }),
        );

        expect(result.last_page).toBe(10);
      });
    });
  });
});
