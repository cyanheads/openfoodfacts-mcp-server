/**
 * @fileoverview Regression tests for OpenFoodFactsService — covers HTTP 404 not-found handling
 * (Bug #3), text search routing (Bug #2), score-filter query-param mapping (GH issue #3), the
 * declared error contract carried by every failure (GH issue #12), retry classification and
 * upstream-detail surfacing (GH issue #19), status-decided retryability (GH issue #37), malformed
 * success envelopes (GH issue #54), answers flagged timed_out (GH issue #68), the total retry
 * deadline (GH issue #72), the nutrient row check (GH issue #64), reads and tag-only searches
 * served from the local export mirror (GH issue #79), and User-Agent header verification.
 * @module tests/services/openfoodfacts/openfoodfacts-service.test
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** `OFF_MIRROR_PATH` as the mocked config reads it: unset unless a mirror test points it at a store. */
const mirrorConfig = vi.hoisted(() => ({ mirrorPath: undefined as string | undefined }));

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({
    baseUrl: 'https://world.openfoodfacts.org',
    rateLimitProduct: 100,
    rateLimitSearch: 10,
    rateLimitTaxonomy: 100,
    mirrorPath: mirrorConfig.mirrorPath,
  })),
}));

// A pass-through spy, so a case can tell whether the store ran a tag search at all.
vi.mock('@/services/mirror/mirror-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/mirror/mirror-queries.js')>();
  return { ...actual, searchByTags: vi.fn(actual.searchByTags) };
});

import { offBrowseTaxonomyTool } from '@/mcp-server/tools/definitions/browse-taxonomy.tool.js';
import { offCompareProductsTool } from '@/mcp-server/tools/definitions/compare-products.tool.js';
import { offGetProductTool } from '@/mcp-server/tools/definitions/get-product.tool.js';
import { offSearchProductsTool } from '@/mcp-server/tools/definitions/search-products.tool.js';
import { TagIds } from '@/services/mirror/mirror-ingester.js';
import { searchByTags } from '@/services/mirror/mirror-queries.js';
import {
  closeMirrorStore,
  encodeCheckpoint,
  getMirrorStore,
  openMirrorStore,
} from '@/services/mirror/mirror-store.js';
import { buildMirrorRecord, normalizeCodeZeroes } from '@/services/mirror/record-builder.js';
import {
  ANALYZER_STOP_WORDS,
  STOP_WORD_LANGS,
} from '@/services/openfoodfacts/analyzer-stop-words.js';
import {
  initOpenFoodFactsService,
  OpenFoodFactsService,
  type ProductRead,
  type ProductSearch,
  requiredWords,
  type SearchOutcome,
} from '@/services/openfoodfacts/openfoodfacts-service.js';
import { NUTRIENT_FIELDS } from '@/services/openfoodfacts/types.js';
import { getTaxonomyService, initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';
import { v2Capture, v35Capture } from '../../fixtures/as-sold-captures.js';
import {
  UPSTREAM_MULTI_MATCH_FIELDS,
  UPSTREAM_TEXT_LANGS,
} from '../../fixtures/text-search-fields.js';
import {
  AUTOCOMPLETE_EMPTY,
  AUTOCOMPLETE_HITS,
  AUTOCOMPLETE_TIMED_OUT,
  PRODUCT_FOUND,
  PRODUCT_FOUND_EMPTY,
  PRODUCT_NOT_FOUND_404,
  TAG_SEARCH_EMPTY,
  TAG_SEARCH_HITS,
  TEXT_SEARCH_EMPTY,
  TEXT_SEARCH_HITS,
  TEXT_SEARCH_TIMED_OUT,
} from '../../fixtures/upstream-envelopes.js';

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

/** Run a call to settlement with the retry backoff collapsed onto fake timers. */
async function onFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = run();
    // Attach a handler now so a rejection is not reported as unhandled while timers run.
    pending.catch(() => undefined);
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

/** Run a service call that must reject to settlement on fake timers, returning its error. */
function settle(run: () => Promise<unknown>): Promise<McpErrorish> {
  return onFakeTimers(() => captureError(run()));
}

/** A search outcome the case expects served, narrowed to its answer. */
function served(outcome: SearchOutcome): Extract<SearchOutcome, { status: 'served' }> {
  if (outcome.status !== 'served') throw new Error(`The search was not served: ${outcome.status}`);
  return outcome;
}

/** A live product read, as the as-sold read takes the read it follows. */
const LIVE_READ: ProductRead = { source: 'off_api', product: {} };

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
      expect(result?.product.product_name).toBe('Nutella');
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
          is_count_exact: true,
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
          is_count_exact: true,
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
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 12,
          page: 1,
          page_size: 20,
          page_count: 1,
          is_count_exact: true,
          hits: [],
        }),
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
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 0,
          page: 1,
          page_size: 20,
          page_count: 1,
          is_count_exact: true,
          hits: [],
        }),
      );

      await svc.searchProducts({ query: 'brands: nutella', page: 1, page_size: 20 }, ctx);

      // The per-word groups name their own fields; strip them, and what remains — the caller's
      // text — carries no unescaped colon.
      const q = sentQ();
      const callerText = q.replace(/\([^()]*\)/g, '').trim();
      expect(callerText).toBe('brands\\: nutella');
      expect(callerText).not.toMatch(/(?<!\\):/);
      // The colon separates words, so it never reaches a group: each group holds a bare word.
      const groupWords = [...q.matchAll(/\(([^()]*)\)/g)].map(
        (group) =>
          new Set(group[1]?.split(' OR ').map((clause) => clause.slice(clause.indexOf(':') + 1))),
      );
      expect(groupWords).toEqual([new Set(['brands']), new Set(['nutella'])]);
    });

    it('normalizes brands array from text search to a comma-joined string', async () => {
      // search.openfoodfacts.org returns brands as an array; the service must join it to match
      // the RawProduct.brands string shape that the tool layer expects.
      const ctx = createMockContext();
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 1,
          is_count_exact: true,
          page: 1,
          page_size: 20,
          page_count: 1,
          hits: [
            { code: '3017620422003', product_name: 'Nutella', brands: ['Ferrero', 'Nutella'] },
          ],
        }),
      );

      const result = served(
        await svc.searchProducts({ query: 'nutella', page: 1, page_size: 20 }, ctx),
      );

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
      // on a "-" prefix, and rejects an unknown field with HTTP 422. The prefix is what makes each
      // enum value mean the same thing here as the bare value means on /api/v2/search.
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
        global.fetch = vi.fn().mockResolvedValue(
          mockResponse({
            count: 1,
            page: 1,
            page_size: 20,
            page_count: 1,
            is_count_exact: true,
            hits: [],
          }),
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
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 1,
          page: 1,
          page_size: 20,
          page_count: 1,
          is_count_exact: true,
          hits: [],
        }),
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

      const result = served(
        await svc.searchProducts({ categories_tag: 'en:spreads', page: 1, page_size: 20 }, ctx),
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
          is_count_exact: true,
          page: 1,
          page_size: 20,
          page_count: 1,
          hits: [{ code: '3017620422003', product_name: 'Nutella', ecoscore_grade: 'c' }],
        }),
      );

      const result = served(
        await svc.searchProducts({ query: 'nutella', page: 1, page_size: 20 }, ctx),
      );

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
          is_count_exact: true,
          page: 1,
          page_size: 2,
          page_count: 20, // 20 total pages in the text search response
          hits,
        }),
      );

      const result = served(
        await svc.searchProducts({ query: 'test', page: 1, page_size: 2 }, ctx),
      );

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

    /**
     * The clause for each bound, on a nutrient the index stores truncated and on one it stores as a
     * float. Live-verified against search-a-licious: square brackets parse to gte/lte, curly braces
     * to gt/lt, and `*` is an open bound. On the five truncated nutrients `gt` and `gte` widen to
     * `[floor(value) TO *]`, since the index rounds a fractional lower bound up (sugars `gte 3.5`
     * lost 173 of 821 skyr rows) and `gt 3` excludes every row truncated to 3 (lost 290 of 938).
     * `lt` and `lte` already return a superset. Bounds from the validated table in the #64 evidence.
     */
    const RANGE_FORMS = [
      ['lt', 3, '{* TO 3}', '{* TO 3}'],
      ['lt', 3.5, '{* TO 3.5}', '{* TO 3.5}'],
      ['lte', 3, '[* TO 3]', '[* TO 3]'],
      ['lte', 3.5, '[* TO 3.5]', '[* TO 3.5]'],
      ['lte', 0, '[* TO 0]', '[* TO 0]'],
      ['gt', 3, '[3 TO *]', '{3 TO *}'],
      ['gt', 3.5, '[3 TO *]', '{3.5 TO *}'],
      ['gt', 0, '[0 TO *]', '{0 TO *}'],
      ['gte', 3, '[3 TO *]', '[3 TO *]'],
      ['gte', 3.5, '[3 TO *]', '[3.5 TO *]'],
      ['gte', 0.5, '[0 TO *]', '[0.5 TO *]'],
    ] as const;

    it.each(RANGE_FORMS)(
      'sends %s %d as %s on the five whole-number nutrients and %s on the rest',
      async (operator, value, wholeNumberForm, floatForm) => {
        // A bare `sugars_100g` clause answers HTTP 200 with zero hits and no error, so the exact `q`
        // pins the `nutriments.` prefix too.
        for (const nutrient of ['energy-kcal', 'fat', 'saturated-fat', 'carbohydrates', 'sugars']) {
          const q = await queryFor({ nutrient_filters: [{ nutrient, operator, value }] });
          expect(q).toBe(`nutriments.${nutrient}_100g:${wholeNumberForm}`);
        }
        for (const nutrient of ['fiber', 'proteins', 'salt', 'sodium']) {
          const q = await queryFor({ nutrient_filters: [{ nutrient, operator, value }] });
          expect(q).toBe(`nutriments.${nutrient}_100g:${floatForm}`);
        }
      },
    );

    it('sends energy-kcal gte 100.5 as [100 TO *]', async () => {
      const q = await queryFor({
        nutrient_filters: [{ nutrient: 'energy-kcal', operator: 'gte', value: 100.5 }],
      });

      expect(q).toBe('nutriments.energy-kcal_100g:[100 TO *]');
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

    describe('the row check (#64)', () => {
      /** One constrained search whose page holds these hits, at the service seam. */
      async function searchHits(
        nutrient_filters: unknown[],
        hits: Record<string, unknown>[],
        params: Record<string, unknown> = {},
      ) {
        global.fetch = vi.fn().mockResolvedValue(textHits(hits));
        return served(
          await svc.searchProducts(
            { page: 1, page_size: 20, nutrient_filters, ...params } as never,
            createMockContext(),
          ),
        );
      }

      /** A hit per value of one nutrient, each under its own servable code. */
      function hitsAt(key: string, values: readonly number[]): Record<string, unknown>[] {
        return values.map((value, i) => ({
          code: String(3_017_620_422_003 + i),
          nutriments: { [key]: value },
        }));
      }

      /** The values of one key on the rows the search kept. */
      function keptValues(result: Awaited<ReturnType<typeof searchHits>>, key: string): unknown[] {
        return result.products.map(
          (row) => (row.indexed_nutriments as Record<string, unknown>)[key],
        );
      }

      /** Rows on both sides of every bound below, as the index returns them, full value intact. */
      const SUGARS = [0, 0.4, 0.5, 0.6, 2.9, 3, 3.4, 3.5, 3.53, 3.6, 3.9, 4];

      const ROW_CHECKS = [
        ['lte', 3, [0, 0.4, 0.5, 0.6, 2.9, 3], 6],
        ['lte', 3.5, [0, 0.4, 0.5, 0.6, 2.9, 3, 3.4, 3.5], 4],
        ['lte', 0, [0], 11],
        ['lt', 3, [0, 0.4, 0.5, 0.6, 2.9], 7],
        ['lt', 3.5, [0, 0.4, 0.5, 0.6, 2.9, 3, 3.4], 5],
        ['gt', 3, [3.4, 3.5, 3.53, 3.6, 3.9, 4], 6],
        ['gt', 3.5, [3.53, 3.6, 3.9, 4], 8],
        ['gt', 0, [0.4, 0.5, 0.6, 2.9, 3, 3.4, 3.5, 3.53, 3.6, 3.9, 4], 1],
        ['gte', 3, [3, 3.4, 3.5, 3.53, 3.6, 3.9, 4], 5],
        ['gte', 3.5, [3.5, 3.53, 3.6, 3.9, 4], 7],
        ['gte', 0.5, [0.5, 0.6, 2.9, 3, 3.4, 3.5, 3.53, 3.6, 3.9, 4], 2],
      ] as const;

      it.each(ROW_CHECKS)(
        'keeps only the rows sugars %s %d passes',
        async (operator, value, kept, outside) => {
          const result = await searchHits(
            [{ nutrient: 'sugars', operator, value }],
            hitsAt('sugars_100g', SUGARS),
          );

          expect(keptValues(result, 'sugars_100g')).toEqual(kept);
          expect(result.outside_constraints).toBe(outside);
          expect(result.page_count).toBe(kept.length);
          expect(result.dropped).toBe(0);
        },
      );

      it.each([
        ['energy-kcal', 'energy-kcal_100g', 'energy_kcal_100g'],
        ['fat', 'fat_100g', 'fat_100g'],
        ['saturated-fat', 'saturated-fat_100g', 'saturated_fat_100g'],
        ['carbohydrates', 'carbohydrates_100g', 'carbohydrates_100g'],
        ['sugars', 'sugars_100g', 'sugars_100g'],
        ['fiber', 'fiber_100g', 'fiber_100g'],
        ['proteins', 'proteins_100g', 'proteins_100g'],
        ['salt', 'salt_100g', 'salt_100g'],
        ['sodium', 'sodium_100g', 'sodium_100g'],
      ])('checks %s, not only the whole-number nutrients', async (nutrient, rawKey, key) => {
        const result = await searchHits(
          [{ nutrient, operator: 'lte', value: 3 }],
          hitsAt(rawKey, [2.5, 3, 3.5]),
        );

        expect(keptValues(result, key)).toEqual([2.5, 3]);
        expect(result.outside_constraints).toBe(1);
      });

      it.each([
        // Floats the index holds widened to double, equal to the bound at its 32-bit precision and
        // on the wrong side of it as doubles (`salt lte 0.1` live 577, double 569, 2026-10-30).
        ['salt', 'lte', 0.1, 'salt_100g', 0.10000000149012, true],
        ['salt', 'gte', 0.1, 'salt_100g', 0.10000000149012, true],
        ['salt', 'gt', 0.1, 'salt_100g', 0.10000000149012, false],
        ['salt', 'lt', 0.1, 'salt_100g', 0.10000000149012, false],
        ['sugars', 'lte', 9.6, 'sugars_100g', 9.60000038146973, true],
        ['sugars', 'gte', 3.3, 'sugars_100g', 3.29999995231628, true],
        ['sugars', 'lt', 3.3, 'sugars_100g', 3.29999995231628, false],
        ['sugars', 'gt', 9.6, 'sugars_100g', 9.60000038146973, false],
        // A difference 32-bit precision still sees.
        ['salt', 'lte', 0.1, 'salt_100g', 0.1000001, false],
      ] as const)(
        'compares %s %s %d at the index precision against a row at %s %d',
        async (nutrient, operator, value, key, held, stays) => {
          const result = await searchHits([{ nutrient, operator, value }], hitsAt(key, [held]));

          expect(keptValues(result, key)).toEqual(stays ? [held] : []);
          expect(result.outside_constraints).toBe(stays ? undefined : 1);
        },
      );

      it('leaves rows it cannot judge on the page: no key, no map, no number', async () => {
        const result = await searchHits(
          [{ nutrient: 'sugars', operator: 'lte', value: 3 }],
          [
            { code: '7771711000483', nutriments: { fat_100g: 30 } },
            { code: '3017620422003' },
            { code: '5413121361342', nutriments: { sugars_100g: '9' } },
            { code: '8003288339765', nutriments: null },
            { code: '8901262070676', nutriments: { sugars_100g: null } },
          ],
        );

        expect(result.products.map((row) => row.code)).toEqual([
          '7771711000483',
          '3017620422003',
          '5413121361342',
          '8003288339765',
          '8901262070676',
        ]);
        expect(result).not.toHaveProperty('outside_constraints');
      });

      it('counts a row that is unservable and failing once, in dropped', async () => {
        const result = await searchHits(
          [{ nutrient: 'sugars', operator: 'lte', value: 3 }],
          [
            { code: '00000636', nutriments: { sugars_100g: 9 } },
            { code: '3017620422003', nutriments: { sugars_100g: 9 } },
            { code: '7771711000483', nutriments: { sugars_100g: 2 } },
          ],
        );

        expect(result.dropped).toBe(1);
        expect(result.outside_constraints).toBe(1);
        expect(result.products.map((row) => row.code)).toEqual(['7771711000483']);
      });

      it('holds a range pair inside one whole number to both bounds, sending the wide band', async () => {
        const result = await searchHits(
          [
            { nutrient: 'sugars', operator: 'gte', value: 3.5 },
            { nutrient: 'sugars', operator: 'lte', value: 3.9 },
          ],
          hitsAt('sugars_100g', [3, 3.4, 3.5, 3.7, 3.9, 3.95]),
        );

        expect(sentQ()).toBe('nutriments.sugars_100g:[3 TO *] nutriments.sugars_100g:[* TO 3.9]');
        expect(keptValues(result, 'sugars_100g')).toEqual([3.5, 3.7, 3.9]);
        expect(result.outside_constraints).toBe(3);
      });

      it('holds a row to every constraint on two nutrients, counting it once', async () => {
        const result = await searchHits(
          [
            { nutrient: 'sugars', operator: 'lte', value: 3 },
            { nutrient: 'proteins', operator: 'gte', value: 5 },
          ],
          [
            { code: '1000000000001', nutriments: { sugars_100g: 2, proteins_100g: 6 } },
            { code: '1000000000002', nutriments: { sugars_100g: 3.5, proteins_100g: 6 } },
            { code: '1000000000003', nutriments: { sugars_100g: 2, proteins_100g: 4 } },
            { code: '1000000000004', nutriments: { sugars_100g: 3.5, proteins_100g: 4 } },
            { code: '1000000000005', nutriments: { sugars_100g: 2 } },
            { code: '1000000000006', nutriments: { sugars_100g: 3.5 } },
          ],
        );

        expect(sentQ()).toBe('nutriments.sugars_100g:[* TO 3] nutriments.proteins_100g:[5 TO *]');
        expect(result.products.map((row) => row.code)).toEqual(['1000000000001', '1000000000005']);
        expect(result.outside_constraints).toBe(4);
      });

      it('applies alongside a tag filter, leaving the tag clause alone', async () => {
        const result = await searchHits(
          [{ nutrient: 'sugars', operator: 'gt', value: 3 }],
          hitsAt('sugars_100g', [3, 3.2]),
          { categories_tag: 'en:skyrs' },
        );

        expect(sentQ()).toBe('categories_tags:"en:skyrs" nutriments.sugars_100g:[3 TO *]');
        expect(keptValues(result, 'sugars_100g')).toEqual([3.2]);
        expect(result.outside_constraints).toBe(1);
      });

      it('keeps the backend count, exactness, and full row values', async () => {
        global.fetch = vi.fn().mockResolvedValue(
          mockResponse({
            count: 10_000,
            is_count_exact: false,
            page: 2,
            page_size: 20,
            page_count: 500,
            hits: hitsAt('salt_100g', [0.10000000149012, 0.2]),
          }),
        );

        const result = served(
          await svc.searchProducts(
            {
              nutrient_filters: [{ nutrient: 'salt', operator: 'lte', value: 0.1 }],
              page: 2,
              page_size: 20,
            },
            createMockContext(),
          ),
        );

        expect(result).toMatchObject({
          count: 10_000,
          count_is_exact: false,
          page: 2,
          page_size: 20,
          page_count: 1,
          dropped: 0,
          outside_constraints: 1,
        });
        // The row shows the value the index holds, not the value the check compared.
        expect(keptValues(result, 'salt_100g')).toEqual([0.10000000149012]);
      });

      it('takes every row off a page none passes, keeping dropped at zero', async () => {
        const result = await searchHits(
          [{ nutrient: 'sugars', operator: 'gt', value: 3.9 }],
          hitsAt('sugars_100g', [3, 3.5, 3.9]),
        );

        expect(result).toMatchObject({ products: [], page_count: 0, dropped: 0 });
        expect(result.outside_constraints).toBe(3);
      });

      it('makes no check on a text search without nutrient filters', async () => {
        // Characterization: the rows a query-only search returned before the check existed.
        global.fetch = vi.fn().mockResolvedValue(textHits(hitsAt('sugars_100g', [3, 3.5])));

        const result = served(
          await svc.searchProducts({ query: 'skyr', page: 1, page_size: 20 }, createMockContext()),
        );

        expect(result.products).toHaveLength(2);
        expect(result).not.toHaveProperty('outside_constraints');
        expect(sentRequest().body?.fields).toEqual(SEARCH_FIELD_LIST);
      });
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

      const result = served(
        await svc.searchProducts({ query: 'chocolate', page: 1, page_size: 2 }, ctx),
      );

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

      const result = served(
        await svc.searchProducts({ query: 'kombucha', page: 1, page_size: 2 }, ctx),
      );

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
        served(await svc.searchProducts({ query: 'a', page: 1, page_size: 2 }, ctx)).count_is_exact,
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
        served(await svc.searchProducts({ query: 'b', page: 1, page_size: 2 }, ctx)).count_is_exact,
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

      const result = served(
        await svc.searchProducts({ categories_tag: 'en:beverages', page: 1, page_size: 20 }, ctx),
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
    /**
     * The failure off_get_product puts on the wire for a barcode, through the contract runner —
     * the path that fills the tool's declared recovery hint from the reason the service raised.
     */
    async function getProductWireError(barcode = '3017620422003'): Promise<McpErrorish> {
      initOpenFoodFactsService();
      const result = await runToolContract(offGetProductTool, { barcode });
      expect(result.isError).toBe(true);
      return (result.structuredContent as { error: McpErrorish }).error;
    }

    /** The recovery off_get_product declares for a reason. */
    const declaredRecovery = (reason: string) =>
      offGetProductTool.errors?.find((e) => e.reason === reason)?.recovery;

    it('carries reason and recovery for an unreachable upstream', async () => {
      // The reported repro (OFF_BASE_URL pointed at a dead port) surfaced a bare -32603 with no
      // reason and no recovery hint on either client surface.
      global.fetch = vi.fn().mockRejectedValue(new TypeError('Unable to connect.'));

      const error = await getProductWireError();

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBe('upstream_error');
      expect(error.data?.recovery?.hint).toBe(declaredRecovery('upstream_error'));
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

      expect(result?.product.product_name).toBe('Nutella');
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
      global.fetch = vi.fn().mockResolvedValue(mockResponse(loadShedHtml, 503));

      const error = await getProductWireError();
      const data = (error.data ?? {}) as Record<string, unknown>;

      expect(data.status).toBe(503);
      expect(data.reason).toBe('upstream_error');
      expect(data.retryable).toBe(true);
      expect(data.barcode).toBe('3017620422003');
      expect(data.retryAttempts).toBe(4);
      expect((data.recovery as { hint?: string }).hint).toBe(declaredRecovery('upstream_error'));
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
        svc.suggestTaxonomy('category', 'hummus', taxonomyCtx),
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
      // still upstream-authored text and lands in the taxonomy fallback notice.
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

      const error = await captureError(limited.suggestTaxonomy('category', 'hummus', ctx));

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

      // The tool's declared hint for the reason reaches the wire, filled by the framework.
      initOpenFoodFactsService();
      const wire = await runToolContract(offGetProductTool, { barcode: '3017620422003' });
      expect((wire.structuredContent as { error: McpErrorish }).error.data?.recovery?.hint).toBe(
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
        svc.suggestTaxonomy('category', 'hummus', createMockContext()),
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

    it.each([
      ['a plain-text 200', 'text/plain', 'Service degraded'],
      ['a JSON 200 cut short', 'application/json', '{"status":1,"product":{"product_na'],
    ])(
      'reads %s as upstream_error, never a caller validation error',
      async (_label, type, body) => {
        const ctx = createMockContext({ errors: offGetProductTool.errors });
        global.fetch = vi.fn(
          async () =>
            ({
              ok: true,
              status: 200,
              headers: new Headers({ 'content-type': type }),
              json: async () => JSON.parse(body),
              text: async () => body,
            }) as unknown as Response,
        );

        const error = await settle(() => svc.getProduct('3017620422003', ctx));

        expect(global.fetch).toHaveBeenCalledTimes(4);
        expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
        expect(error.data?.reason).toBe('upstream_error');
        expect(error.data?.retryable).toBe(true);
      },
    );

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

  // ── #54: a 2xx body missing its result fields is a failure, not an answer ──

  describe('malformed success envelopes (#54)', () => {
    /** Stub every request with the same JSON body; the request log says where each one went. */
    function answerAll(body: unknown, status = 200): void {
      global.fetch = vi.fn(async () => mockResponse(body, status));
    }

    /** The pathname of every request the stubbed fetch received, in order. */
    function requestedPaths(): string[] {
      return vi.mocked(global.fetch).mock.calls.map(([input]) => new URL(String(input)).pathname);
    }

    /** Assert the declared retryable upstream failure, raised for a malformed body, after a full retry budget. */
    function expectMalformedFailure(error: McpErrorish, path: string): void {
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBe('upstream_error');
      expect(error.data?.retryable).toBe(true);
      expect(error.message).toContain('malformed');
      // Raised inside the retry boundary, like an HTML page served with a 200: retried in full.
      expect(requestedPaths()).toEqual([path, path, path, path]);
    }

    describe('genuine envelopes keep their meaning', () => {
      it('returns a found product, and an empty product object as found with nothing entered', async () => {
        const ctx = createMockContext();
        answerAll(PRODUCT_FOUND);
        await expect(svc.getProduct('3017620422003', ctx)).resolves.toMatchObject({
          source: 'off_api',
          product: { product_name: 'Nutella', nutriscore_grade: 'e' },
        });

        answerAll(PRODUCT_FOUND_EMPTY);
        await expect(svc.getProductFields('3017620422003', 'zz', ctx)).resolves.toEqual({
          source: 'off_api',
          product: {},
        });
        expect(requestedPaths()).toEqual(['/api/v2/product/3017620422003.json']);
      });

      it.each([
        ['HTTP 404 with status 0', 404],
        ['HTTP 200 with status 0', 200],
      ])('returns null for %s, after one request', async (_label, status) => {
        answerAll(PRODUCT_NOT_FOUND_404, status);

        await expect(svc.getProduct('2961836540127', createMockContext())).resolves.toBeNull();
        expect(global.fetch).toHaveBeenCalledOnce();
      });

      it('reads tag-search hits and a zero-hit page as counted answers', async () => {
        const ctx = createMockContext();
        answerAll(TAG_SEARCH_HITS);
        const hits = served(
          await svc.searchProducts({ categories_tag: 'en:hummus', page: 1, page_size: 2 }, ctx),
        );
        expect(hits).toMatchObject({ count: 4581, count_is_exact: true, page_count: 2 });
        expect(hits.products.map((row) => row.code)).toEqual(['3292070005161', '3292070001576']);

        answerAll(TAG_SEARCH_EMPTY);
        const empty = await svc.searchProducts(
          { categories_tag: 'en:zz', page: 1, page_size: 2 },
          ctx,
        );
        expect(empty).toMatchObject({
          count: 0,
          count_is_exact: true,
          page_count: 0,
          products: [],
        });
      });

      it('reads text-search hits and a zero-hit page as counted answers', async () => {
        const ctx = createMockContext();
        answerAll(TEXT_SEARCH_HITS);
        const hits = await svc.searchProducts({ query: 'nutella', page: 1, page_size: 2 }, ctx);
        expect(hits).toMatchObject({ count: 631, count_is_exact: true, page_count: 2 });

        answerAll(TEXT_SEARCH_EMPTY);
        const empty = await svc.searchProducts({ query: 'zzqxwvplmk', page: 1, page_size: 2 }, ctx);
        expect(empty).toMatchObject({ count: 0, count_is_exact: true, products: [] });
      });

      it('reads autocomplete hits and an empty option list as answers', async () => {
        const ctx = createMockContext();
        answerAll(AUTOCOMPLETE_HITS);
        await expect(svc.suggestTaxonomy('category', 'hummus', ctx)).resolves.toEqual([
          { id: 'en:hummus', name: 'Hummus' },
        ]);

        answerAll(AUTOCOMPLETE_EMPTY);
        await expect(svc.suggestTaxonomy('category', 'zzqxwvplmk', ctx)).resolves.toEqual([]);
      });

      it('asks for the whole answer, a lookup size of 2000 (#70)', async () => {
        answerAll(AUTOCOMPLETE_EMPTY);

        await svc.suggestTaxonomy('category', 'hummus', createMockContext());

        const [input] = vi.mocked(global.fetch).mock.calls[0] ?? [];
        expect(new URL(String(input)).searchParams.get('size')).toBe('2000');
      });
    });

    it.each([
      ['an empty object', {}],
      ['status 1 with no product', { status: 1, status_verbose: 'product found' }],
      ['a non-numeric status', { code: '1002', status: 'success', product: { product_name: 'x' } }],
      ['status 1 with a null product', { status: 1, product: null }],
      ['status 1 with an array for a product', { status: 1, product: [] }],
      ['a JSON null', null],
    ])('raises upstream_error for a product body that is %s', async (_label, body) => {
      answerAll(body);

      const error = await settle(() =>
        svc.getProduct('1000', createMockContext({ errors: offGetProductTool.errors })),
      );

      expectMalformedFailure(error, '/api/v2/product/1000.json');
    });

    it.each([
      // Product Opener's skeleton when its MongoDB query fails: `count` is set only on success.
      ['no count', { page: 1, page_size: 24, skip: 0, products: [] }],
      [
        'a null count',
        { count: null, page: 1, page_count: 0, page_size: 24, skip: 0, products: [] },
      ],
      ['no products', { count: 5, page: 1, page_size: 24, skip: 0 }],
    ])('raises upstream_error for a tag-search body with %s', async (_label, body) => {
      answerAll(body);

      const error = await settle(() =>
        svc.searchProducts(
          { categories_tag: 'en:broken', page: 1, page_size: 24 },
          createMockContext({ errors: offSearchProductsTool.errors }),
        ),
      );

      expectMalformedFailure(error, '/api/v2/search');
    });

    it.each([
      ['no hits or count', { page: 1, page_size: 20 }],
      ['hits but no count', { hits: [], page: 1, page_size: 20, page_count: 0 }],
      ['no is_count_exact', { hits: [], count: 0, page: 1, page_size: 20 }],
      ['a string is_count_exact', { hits: [], count: 0, is_count_exact: 'true', page: 1 }],
    ])('raises upstream_error for a text-search body with %s', async (_label, body) => {
      answerAll(body);

      const error = await settle(() =>
        svc.searchProducts(
          { query: 'brokenhits', page: 1, page_size: 20 },
          createMockContext({ errors: offSearchProductsTool.errors }),
        ),
      );

      expectMalformedFailure(error, '/search');
    });

    it('raises upstream_error for an autocomplete body with no options', async () => {
      answerAll({ took: 1, timed_out: false });

      const error = await settle(() =>
        svc.suggestTaxonomy('category', 'brokenac', createMockContext()),
      );

      expectMalformedFailure(error, '/autocomplete');
    });

    it('reports a malformed tag-search page through the tool as upstream_error, never zero matches', async () => {
      initOpenFoodFactsService();
      answerAll({ page: 1, page_size: 24, skip: 0, products: [] });

      const result = await onFakeTimers(() =>
        runToolContract(offSearchProductsTool, { categories_tag: 'en:broken' }),
      );

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: McpErrorish }).error;
      expect(error.data?.reason).toBe('upstream_error');
      expect(error.data?.retryable).toBe(true);
      expect(JSON.stringify(result.content)).not.toContain('No products found');
    });

    it('reports a malformed product body through off_get_product as upstream_error, not not_found', async () => {
      initOpenFoodFactsService();
      answerAll({});

      const result = await onFakeTimers(() =>
        runToolContract(offGetProductTool, { barcode: '1000' }),
      );

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: McpErrorish }).error;
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBe('upstream_error');
    });

    describe('malformed autocomplete', () => {
      beforeEach(() => {
        initOpenFoodFactsService();
        initTaxonomyService();
        answerAll({ took: 1, timed_out: false });
      });

      it('makes canonicalizeTag return lookup_failed and keeps it out of the cache', async () => {
        const taxonomy = getTaxonomyService();
        const ctx = createMockContext();

        const first = await onFakeTimers(() =>
          taxonomy.canonicalizeTag('allergens', 'en:brokenac', ctx),
        );
        expect(first).toEqual({
          value: 'en:brokenac',
          resolution: 'normalized',
          reason: 'lookup_failed',
          cause: 'unavailable',
        });
        const afterFirst = requestedPaths().length;

        const second = await onFakeTimers(() =>
          taxonomy.canonicalizeTag('allergens', 'en:brokenac', ctx),
        );
        expect(second).toEqual(first);
        // Not cached: the second call asks the vocabulary again.
        expect(requestedPaths().length).toBeGreaterThan(afterFirst);
        expect(new Set(requestedPaths())).toEqual(new Set(['/autocomplete']));
      });

      it('falls back to the offline sample with a notice that the vocabulary gave no usable answer', async () => {
        const result = await onFakeTimers(() =>
          runToolContract(offBrowseTaxonomyTool, { facet: 'categories', search: 'brokenac' }),
        );

        expect(result.isError).toBeFalsy();
        const output = result.structuredContent as { tags: unknown[]; notice?: string };
        expect(output.tags).toEqual([]);
        expect(output.notice).toContain('could not be reached or gave no usable answer');
        expect(output.notice).toContain('malformed');
        expect(output.notice).not.toContain('No categories tag matched');
      });

      it('refuses an exclusion it could not check as retryable, and checks again on the next call', async () => {
        const call = () =>
          onFakeTimers(() =>
            runToolContract(offSearchProductsTool, {
              categories_tag: 'en:hummus',
              exclude_allergens: ['en:brokenac'],
            }),
          );

        for (const attempt of [1, 2]) {
          const result = await call();
          expect(result.isError).toBe(true);
          const error = (result.structuredContent as { error: McpErrorish }).error;
          expect(error.data?.reason).toBe('unrecognized_exclusion');
          expect(error.data?.retryable).toBe(true);
          // An unusable answer is named alongside an unreachable vocabulary, on every surface.
          expect(error.message).toContain('could not be reached or gave no usable answer');
          expect(error.data?.recovery?.hint).toContain(
            'could not be reached or gave no usable answer',
          );
          // Each call re-queries the vocabulary: four attempts each, nothing sent to search.
          expect(requestedPaths()).toEqual(Array(4 * attempt).fill('/autocomplete'));
        }
      });

      it('names an unusable answer in the declared unrecognized_exclusion condition', () => {
        const entry = offSearchProductsTool.errors?.find(
          ({ reason }) => reason === 'unrecognized_exclusion',
        );
        expect(entry?.when).toContain('could not be reached or gave no usable answer');
      });
    });

    describe('answers flagged timed_out (#68)', () => {
      /** Assert the declared retryable timeout, raised for a flagged body, after a full retry budget. */
      function expectTimedOutFailure(error: McpErrorish, path: string): void {
        expect(error.code).toBe(JsonRpcErrorCode.Timeout);
        expect(error.data?.reason).toBe('upstream_timeout');
        expect(error.data?.retryable).toBe(true);
        expect(error.message).toContain('timed out inside its search engine');
        expect(requestedPaths()).toEqual([path, path, path, path]);
      }

      it.each([
        ['an empty page', TEXT_SEARCH_TIMED_OUT],
        // A partial page is the dangerous one: its count and is_count_exact look complete.
        ['hits and an exact count', { ...TEXT_SEARCH_HITS, timed_out: true }],
        // The flag is read ahead of the shape, so it is not reported as a malformed body.
        ['no result fields at all', { took: 15000, timed_out: true }],
      ])('raises upstream_timeout for a text search carrying %s', async (_label, body) => {
        answerAll(body);

        const error = await settle(() =>
          svc.searchProducts(
            { query: 'pasta', page: 1, page_size: 20 },
            createMockContext({ errors: offSearchProductsTool.errors }),
          ),
        );

        expectTimedOutFailure(error, '/search');
      });

      it.each([
        ['no options', AUTOCOMPLETE_TIMED_OUT],
        ['partial options', { ...AUTOCOMPLETE_HITS, timed_out: true }],
        ['no options key', { took: 15000, timed_out: true }],
      ])('raises upstream_timeout for an autocomplete carrying %s', async (_label, body) => {
        answerAll(body);

        const error = await settle(() =>
          svc.suggestTaxonomy('category', 'hummus', createMockContext()),
        );

        expectTimedOutFailure(error, '/autocomplete');
      });

      it('reports the search-engine failure, not the timeout, when a body carries both', async () => {
        answerAll({ errors: [{ title: 'Too many clauses' }], timed_out: true });

        const error = await settle(() =>
          svc.searchProducts({ query: 'pasta', page: 1, page_size: 20 }, createMockContext()),
        );

        expect(error.data?.reason).toBe('upstream_error');
        expect(error.message).toContain('Too many clauses');
      });

      it('returns the page a retry brings back once the search stops timing out', async () => {
        global.fetch = vi
          .fn()
          .mockResolvedValueOnce(mockResponse(TEXT_SEARCH_TIMED_OUT))
          .mockResolvedValue(mockResponse(TEXT_SEARCH_HITS));

        const result = await onFakeTimers(() =>
          svc.searchProducts({ query: 'nutella', page: 1, page_size: 2 }, createMockContext()),
        );

        expect(result).toMatchObject({ count: 631, count_is_exact: true, page_count: 2 });
        expect(requestedPaths()).toEqual(['/search', '/search']);
      });

      it.each([
        ['false', false],
        ['absent', undefined],
        ['the string "true"', 'true'],
        ['1', 1],
        ['null', null],
      ])('reads an answer whose flag is %s as it always has', async (_label, timed_out) => {
        const ctx = createMockContext();
        answerAll({ ...TEXT_SEARCH_EMPTY, timed_out });
        await expect(
          svc.searchProducts({ query: 'zzqxwvplmk', page: 1, page_size: 2 }, ctx),
        ).resolves.toMatchObject({ count: 0, count_is_exact: true, products: [] });

        answerAll({ ...AUTOCOMPLETE_HITS, timed_out });
        await expect(svc.suggestTaxonomy('category', 'hummus', ctx)).resolves.toEqual([
          { id: 'en:hummus', name: 'Hummus' },
        ]);
        expect(requestedPaths()).toEqual(['/autocomplete']);
      });

      describe('through the tools', () => {
        beforeEach(() => {
          initOpenFoodFactsService();
          initTaxonomyService();
        });

        it('fails off_search_products as upstream_timeout, with no rows and no zero-match claim', async () => {
          answerAll({ ...TEXT_SEARCH_HITS, timed_out: true });

          const result = await onFakeTimers(() =>
            runToolContract(offSearchProductsTool, { query: 'nutella' }),
          );

          expect(result.isError).toBe(true);
          const error = (result.structuredContent as { error: McpErrorish }).error;
          expect(error.code).toBe(JsonRpcErrorCode.Timeout);
          expect(error.data?.reason).toBe('upstream_timeout');
          expect(error.data?.retryable).toBe(true);
          const text = JSON.stringify(result.content);
          expect(text).toContain('timed out inside its search engine');
          expect(text).not.toContain('No products found');
          expect(text).not.toContain('Nutella');
        });

        it('answers off_browse_taxonomy from the offline sample, never as no match', async () => {
          answerAll(AUTOCOMPLETE_TIMED_OUT);

          const result = await onFakeTimers(() =>
            runToolContract(offBrowseTaxonomyTool, { facet: 'categories', search: 'cheese' }),
          );

          expect(result.isError).toBeFalsy();
          const output = result.structuredContent as { tags: { id: string }[]; notice?: string };
          expect(output.tags.map((tag) => tag.id)).toEqual(['en:cheeses', 'en:fresh-cheeses']);
          expect(output.notice).toContain('could not be reached or gave no usable answer');
          expect(output.notice).toContain('timed out inside its search engine');
          expect(JSON.stringify(result.content)).toContain('offline sample');
          expect(JSON.stringify(result)).not.toContain('tag matched');
        });

        it('reads a timed-out lookup of a term the sample lacks as unreachable, not as no match', async () => {
          answerAll(AUTOCOMPLETE_TIMED_OUT);

          const result = await onFakeTimers(() =>
            runToolContract(offBrowseTaxonomyTool, { facet: 'categories', search: 'kombucha' }),
          );

          const output = result.structuredContent as { tags: unknown[]; notice?: string };
          expect(output.tags).toEqual([]);
          expect(output.notice).toContain('could not be reached or gave no usable answer');
          expect(output.notice).not.toContain('tag matched');
        });

        it('refuses an exclusion it could not confirm as retryable, then confirms it on the next call', async () => {
          const input = { categories_tag: 'en:yogurts', exclude_allergens: ['en:kiwi'] };
          answerAll(AUTOCOMPLETE_TIMED_OUT);

          const refused = await onFakeTimers(() => runToolContract(offSearchProductsTool, input));

          expect(refused.isError).toBe(true);
          const error = (refused.structuredContent as { error: McpErrorish }).error;
          expect(error.data?.reason).toBe('unrecognized_exclusion');
          expect(error.data?.retryable).toBe(true);
          expect(requestedPaths()).toEqual(Array(4).fill('/autocomplete'));

          global.fetch = vi.fn(async (input_: unknown) =>
            mockResponse(
              new URL(String(input_)).pathname === '/autocomplete'
                ? { ...AUTOCOMPLETE_EMPTY, options: [{ id: 'en:kiwi', text: 'Kiwi' }] }
                : TAG_SEARCH_HITS,
            ),
          );

          const confirmed = await runToolContract(offSearchProductsTool, input);

          expect(confirmed.isError).toBeFalsy();
          expect(requestedPaths()).toEqual(['/autocomplete', '/api/v2/search']);
        });
      });
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
        // A nutrient constraint also asks for the index's nutrient map (#58).
        fields: [...SEARCH_FIELD_LIST, 'nutriments'],
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
      // One word under the analyzer's grammar, however it is punctuated.
      await expect(qFor({ query: "L'eau", labels_tag: 'en:organic' })).resolves.toBe(
        'labels_tags:"en:organic" l\'eau',
      );
      await expect(qFor({ query: 'milk!' })).resolves.toBe('milk\\!');
    });

    it('groups each part of a hyphen-joined query, which is two words to the analyzer', async () => {
      // Live, Mongolia: `milk-chocolate` counted 9 (milk OR chocolate) with no group, and 1 — the
      // intersection — with a group per part, the same as `milk chocolate`.
      await expect(qFor({ query: 'dark-chocolate', labels_tag: 'en:organic' })).resolves.toBe(
        `labels_tags:"en:organic" ${wordGroup('dark')} ${wordGroup('chocolate')} dark\\-chocolate`,
      );
    });

    it.each([
      ['-', '\\-'],
      ['/', '\\/'],
      ['+', '\\+'],
      ['&', '\\&'],
      [',', ','],
      [':', '\\:'],
    ])('requires both words joined by %s, which separates words', async (separator, escaped) => {
      // Live, Mongolia: a single group for `milk<sep>xyzzyqq` matched the 6 `milk` products, so
      // the analyzer split it; one group per part matches nothing, as `milk xyzzyqq` does.
      await expect(qFor({ query: `milk${separator}xyzzyqq` })).resolves.toBe(
        `${wordGroup('milk')} ${wordGroup('xyzzyqq')} milk${escaped}xyzzyqq`,
      );
    });

    it.each(["'", '’', '.', '_'])(
      'keeps a word joined by %s whole, which the analyzer keeps as one token',
      async (joiner) => {
        // Live, Mongolia: a group for `milk<joiner>xyzzyqq` matched 0 — one token, not two.
        const word = `milk${joiner}xyzzyqq`;

        await expect(qFor({ query: word })).resolves.toBe(word);
        await expect(qFor({ query: `${word} cocoa` })).resolves.toBe(
          `${wordGroup(word)} ${wordGroup('cocoa')} ${word} cocoa`,
        );
      },
    );

    it('joins across only a single apostrophe or period between word characters', async () => {
      // A doubled joiner, or one at a word's edge, separates.
      await expect(qFor({ query: "milk..cocoa 'oat' rice' u.s." })).resolves.toBe(
        `${wordGroup('milk')} ${wordGroup('cocoa')} ${wordGroup('oat')} ${wordGroup('rice')} ${wordGroup('u.s')} milk..cocoa 'oat' rice' u.s.`,
      );
    });

    it('keeps a decimal comma inside its number, and separates at a comma elsewhere', async () => {
      // Live: `lait 1,5%` with groups for `1` and `5` matched 27 products, only names spelling it
      // `1, 5%`; one `1,5` group matched 324, the products named `Lait 1,5%`.
      await expect(qFor({ query: 'lait 1,5%' })).resolves.toBe(
        `${wordGroup('lait')} ${wordGroup('1,5')} lait 1,5%`,
      );
      await expect(qFor({ query: 'milk,cocoa 1,cocoa' })).resolves.toBe(
        `${wordGroup('milk')} ${wordGroup('cocoa')} ${wordGroup('1')} milk,cocoa 1,cocoa`,
      );
    });

    it('keeps accents and combining marks inside a word', async () => {
      const decomposed = 'café';
      await expect(qFor({ query: `crème-brûlée ${decomposed}` })).resolves.toBe(
        `${wordGroup('crème')} ${wordGroup('brûlée')} ${wordGroup(decomposed)} crème\\-brûlée ${decomposed}`,
      );
    });

    it.each([
      ['a long run of word characters', (n: number) => 'a'.repeat(n)],
      ['joiners between single characters', (n: number) => 'a.'.repeat(n / 2)],
      ['doubled joiners', (n: number) => "a''".repeat(n / 3)],
      ['decimal commas between single digits', (n: number) => '1,'.repeat(n / 2)],
      ['separators only', (n: number) => '-/+&,:'.repeat(n / 6)],
      ['combining marks only', (n: number) => '́'.repeat(n)],
      [
        'many short distinct words',
        (n: number) => Array.from({ length: n / 6 }, (_, i) => `w${i}`).join(' '),
      ],
    ])('extracts words in linear time from %s', (_label, make) => {
      // The query reaches the word scan with no length bound — only its word count is capped.
      /** Five CPU-time samples; short batches leave room for scheduling within the test deadline. */
      const cpuMsPerRun = (input: string): number => {
        let fastest = Number.POSITIVE_INFINITY;
        for (let sample = 0; sample < 5; sample++) {
          const start = process.threadCpuUsage();
          let runs = 0;
          let usedMs = 0;
          do {
            requiredWords(input);
            runs++;
            const used = process.threadCpuUsage(start);
            usedMs = (used.user + used.system) / 1000;
          } while (usedMs < 5);
          fastest = Math.min(fastest, usedMs / runs);
        }
        return fastest;
      };

      const small = cpuMsPerRun(make(5_000));
      const large = cpuMsPerRun(make(320_000));

      // 64× the input: linear stays near 64×, quadratic would reach 4,096×.
      expect(large / small).toBeLessThan(256);
      expect(large).toBeLessThan(250);
    });

    it('dedupes a word repeated inside a joined token, and still requires the new one', async () => {
      // Live, Mongolia: `milk milk-xyzzyqq` counted 6 with whitespace groups, 0 with these.
      await expect(qFor({ query: 'milk milk-xyzzyqq' })).resolves.toBe(
        `${wordGroup('milk')} ${wordGroup('xyzzyqq')} milk milk\\-xyzzyqq`,
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
        `${wordGroup('chocolate')} ${wordGroup('hazelnuts')} chocolate with hazelnuts, and the`,
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

      // The colon separates words, so the field name is an ordinary word with its own group.
      expect(q).toBe(`${wordGroup('brands')} ${wordGroup('nutella')} brands\\: nutella`);
    });

    it('groups the words of joined tokens once each, leaving the escaped bare query for ranking', async () => {
      const q = await qFor({ query: 'dark-chocolate 70% dark-chocolate' });

      expect(q).toBe(
        `${wordGroup('dark')} ${wordGroup('chocolate')} ${wordGroup('70')} dark\\-chocolate 70% dark\\-chocolate`,
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

      const result = served(await svc.searchProducts({ query: 'x', page: 1, page_size: 5 }, ctx));

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

      const result = served(
        await svc.searchProducts({ categories_tag: 'en:spreads', page: 1, page_size: 5 }, ctx),
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

      const result = served(
        await svc.searchProducts({ query: 'x', page: 1, page_size: 6 }, createMockContext()),
      );

      expect(result.products.map((p) => p.code)).toEqual(['3017620422003', '6035215']);
      expect(result.page_count).toBe(2);
      expect(result.count).toBe(6);
      expect(result.dropped).toBe(4);
    });

    it('reports no drop on a page whose codes are all servable', async () => {
      global.fetch = vi.fn().mockResolvedValue(textHits([{ code: '3017620422003' }], 1));

      const result = served(
        await svc.searchProducts({ query: 'x', page: 1, page_size: 1 }, createMockContext()),
      );

      expect(result.dropped).toBe(0);
    });

    it('drops them on the tag path before page_count is set', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ count: 6, page: 1, page_count: 6, page_size: 6, products: rows }),
        );

      const result = served(
        await svc.searchProducts(
          { categories_tag: 'en:honeys', page: 1, page_size: 6 },
          createMockContext(),
        ),
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

      /**
       * Run the tool through the contract runner and return the failure it puts on the wire —
       * declared recovery hint filled — failing the test if the call succeeds.
       */
      async function rejectionOf(input: Record<string, unknown>): Promise<McpErrorish> {
        const result = await runToolContract(offSearchProductsTool, {
          page: 1,
          page_size: 20,
          ...input,
        } as never);
        expect(result.isError).toBe(true);
        return (result.structuredContent as { error: McpErrorish }).error;
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

  // ── #58: rows of a nutrient-filtered search carry the values the filter matched ──

  describe('indexed nutrient values (#58)', () => {
    beforeEach(() => {
      initOpenFoodFactsService();
      initTaxonomyService();
    });

    /** The index's per-100 g map as the live text index returns it for one hit (2026-10-13). */
    const INDEXED_MAP = {
      carbohydrates_100g: 46.15,
      'energy-kcal_100g': 538,
      'energy-kj_100g': 2251,
      fat_100g: 34.62,
      fiber_100g: 11.5,
      proteins_100g: 7.69,
      salt_100g: 0.04,
      'saturated-fat_100g': 21.15,
      sodium_100g: 0.016,
      sugars_100g: 3.85,
    };

    /** Every text block of a contract result — format() output plus the enrichment trailer. */
    function allText(result: { content?: { type: string; text?: string }[] }): string {
      return (result.content ?? []).map((block) => block.text ?? '').join('\n');
    }

    it('leaves a search without nutrient filters exactly as it was, even when hits carry nutriments', async () => {
      // Characterization: the request body and the rows a query-only search produced before #58.
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          textHits([{ code: '7771711000483', product_name: 'Dark', nutriments: INDEXED_MAP }], 1),
        );

      const result = await runToolContract(offSearchProductsTool, { query: 'dark chocolate' });

      expect(global.fetch).toHaveBeenCalledOnce();
      expect(JSON.stringify(sentRequest().body)).toBe(
        JSON.stringify({
          q: `${wordGroup('dark')} ${wordGroup('chocolate')} dark chocolate`,
          langs: [...UPSTREAM_TEXT_LANGS],
          fields: SEARCH_FIELD_LIST,
          page: 1,
          page_size: 20,
        }),
      );
      const structured = result.structuredContent as {
        products: Record<string, unknown>[];
        text_index_snapshot?: string;
      };
      expect(structured.products).toEqual([{ barcode: '7771711000483', product_name: 'Dark' }]);
      expect(allText(result)).not.toMatch(/indexed/i);
      expect(String(structured.text_index_snapshot)).not.toMatch(/indexed_nutriments/);
    });

    it('never adds the field on a tag-only search', async () => {
      // Characterization: the tag path requests and returns the summary fields alone.
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 1,
          page: 1,
          page_count: 1,
          page_size: 20,
          products: [{ code: '7771711000483', nutriments: INDEXED_MAP }],
        }),
      );

      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:dark-chocolates',
      });

      expect(sentRequest().url).toContain(
        'fields=code%2Cproduct_name%2Cbrands%2Cnutriscore_grade%2Cnova_group%2Cecoscore_grade%2Ccategories_tags&',
      );
      expect((result.structuredContent as { products: unknown[] }).products).toEqual([
        { barcode: '7771711000483' },
      ]);
    });

    it('asks for the whole nutriments map on a nutrient-filtered search, in its one request', async () => {
      global.fetch = vi.fn().mockResolvedValue(textHits([]));

      await runToolContract(offSearchProductsTool, {
        query: 'dark chocolate',
        nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
      });

      expect(global.fetch).toHaveBeenCalledOnce();
      expect(sentRequest().body?.fields).toEqual([...SEARCH_FIELD_LIST, 'nutriments']);
    });

    it('carries exactly the constrained keys each hit holds, omitting the rest, on both surfaces', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        textHits(
          [
            // Every indexed key: only the constrained one reaches the row.
            { code: '7771711000483', product_name: 'Dark 70', nutriments: INDEXED_MAP },
            // The constrained key absent: omitted, never zero-filled.
            { code: '8901262070676', nutriments: { fat_100g: 30 } },
            // No map at all.
            { code: '3017620422003' },
            // A value that is not a number is not a measurement.
            { code: '5413121361342', nutriments: { sugars_100g: '1' } },
            // A real zero stays a zero.
            { code: '8003288339765', nutriments: { sugars_100g: 0 } },
          ],
          1813,
        ),
      );

      const result = await runToolContract(offSearchProductsTool, {
        query: 'dark chocolate',
        nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 8 }],
      });

      expect(result.isError).toBeFalsy();
      const rows = (
        result.structuredContent as {
          products: { barcode: string; indexed_nutriments?: Record<string, number> }[];
        }
      ).products;
      expect(rows.map(({ barcode, indexed_nutriments }) => [barcode, indexed_nutriments])).toEqual([
        ['7771711000483', { sugars_100g: 3.85 }],
        ['8901262070676', {}],
        ['3017620422003', {}],
        ['5413121361342', {}],
        ['8003288339765', { sugars_100g: 0 }],
      ]);

      const text = allText(result);
      expect(text).toContain(
        '**Indexed per 100 g, or per 100 ml for liquids:** sugars_100g 3.85 g',
      );
      expect(text).toContain('**Indexed per 100 g, or per 100 ml for liquids:** sugars_100g 0 g');
      // A row without the value says so rather than showing a number.
      expect(text).toContain('**Indexed per 100 g, or per 100 ml for liquids:** none returned');
    });

    it('keys every filterable nutrient as off_get_product does, deduplicating a range pair', async () => {
      // The same raw map through both tools: each search key must name the value off_get_product
      // reports under that key.
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse({ code: '7771711000483', status: 1, product: { nutriments: INDEXED_MAP } }),
        );
      const product = await runToolContract(offGetProductTool, { barcode: '7771711000483' });
      const productNutriments = (
        product.structuredContent as { product: { nutriments: Record<string, unknown> } }
      ).product.nutriments;

      global.fetch = vi
        .fn()
        .mockResolvedValue(textHits([{ code: '7771711000483', nutriments: INDEXED_MAP }], 1));
      const search = await runToolContract(offSearchProductsTool, {
        nutrient_filters: [
          ...NUTRIENT_FIELDS.map((nutrient) => ({ nutrient, operator: 'gte' as const, value: 0 })),
          { nutrient: 'sugars', operator: 'lte', value: 8 },
        ],
      });
      const indexed = (
        search.structuredContent as { products: { indexed_nutriments: Record<string, number> }[] }
      ).products[0]?.indexed_nutriments;

      expect(Object.keys(indexed ?? {})).toHaveLength(NUTRIENT_FIELDS.length);
      for (const [key, value] of Object.entries(indexed ?? {})) {
        expect(productNutriments[key]).toBe(value);
      }
      // energy-kj is indexed but filterable by nothing, so no row carries it.
      expect(JSON.stringify(indexed)).not.toContain('kj');
    });

    it('carries only the constrained nutrients, not every indexed one', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(textHits([{ code: '7771711000483', nutriments: INDEXED_MAP }], 1));

      // A category the offline sample confirms, so the only request is the search.
      const result = await runToolContract(offSearchProductsTool, {
        categories_tag: 'en:chocolates',
        nutrient_filters: [
          { nutrient: 'energy-kcal', operator: 'lte', value: 600 },
          { nutrient: 'saturated-fat', operator: 'gt', value: 2 },
        ],
      });

      expect(
        (result.structuredContent as { products: { indexed_nutriments: unknown }[] }).products[0]
          ?.indexed_nutriments,
      ).toEqual({ energy_kcal_100g: 538, saturated_fat_100g: 21.15 });
      expect(allText(result)).toContain('energy_kcal_100g 538 kcal, saturated_fat_100g 21.15 g');
    });

    it('echoes the constraints in the snapshot note on both surfaces, never in notice', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(textHits([{ code: '7771711000483', nutriments: INDEXED_MAP }], 1));

      const result = await runToolContract(offSearchProductsTool, {
        query: 'dark chocolate',
        nutrient_filters: [
          { nutrient: 'sugars', operator: 'lt', value: 8 },
          { nutrient: 'proteins', operator: 'gte', value: 5 },
        ],
      });

      const structured = result.structuredContent as {
        text_index_snapshot?: string;
        notice?: string;
      };
      const sentence =
        'The nutrient constraints (sugars < 8, proteins >= 5) were checked against these index values, shown on each row as indexed_nutriments; off_get_product returns the current record, whose values can differ.';
      expect(structured.text_index_snapshot).toContain(sentence);
      expect(allText(result)).toContain(sentence);
      expect(structured.notice ?? '').not.toContain('indexed_nutriments');
    });

    it('answers a zero-hit page with the echo and no rows', async () => {
      global.fetch = vi.fn().mockResolvedValue(textHits([], 0));

      const result = await runToolContract(offSearchProductsTool, {
        query: 'dark chocolate',
        nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 0.01 }],
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        total: number;
        products: unknown[];
        text_index_snapshot?: string;
        notice?: string;
      };
      expect(structured.total).toBe(0);
      expect(structured.products).toEqual([]);
      expect(structured.text_index_snapshot).toContain('(sugars < 0.01)');
      expect(structured.notice).toContain('nutrient="sugars<0.01"');
      expect(allText(result)).not.toContain('**Indexed');
    });

    it('answers a page past the end with no rows and the echo kept', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        mockResponse({
          count: 30,
          is_count_exact: true,
          page: 3,
          page_size: 20,
          page_count: 2,
          hits: [],
        }),
      );

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: [{ nutrient: 'salt', operator: 'lt', value: 1 }],
        page: 3,
      });

      const structured = result.structuredContent as {
        products: unknown[];
        notice?: string;
        text_index_snapshot?: string;
      };
      expect(structured.products).toEqual([]);
      expect(structured.notice).toMatch(/past the end/);
      expect(structured.text_index_snapshot).toContain('(salt < 1)');
    });

    it('carries the field on every row of a full 50-row page', async () => {
      const hits = Array.from({ length: 50 }, (_, i) => ({
        code: String(3_017_620_422_003 + i),
        nutriments: i % 2 === 0 ? { fiber_100g: i } : {},
      }));
      global.fetch = vi.fn().mockResolvedValue(textHits(hits, 1813));

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: [{ nutrient: 'fiber', operator: 'gte', value: 0 }],
        page_size: 50,
      });

      const { products: rows, truncated } = result.structuredContent as {
        products: { indexed_nutriments?: Record<string, number> }[];
        truncated?: boolean;
      };
      expect(rows).toHaveLength(50);
      expect(rows.every((row) => row.indexed_nutriments !== undefined)).toBe(true);
      expect(rows[2]?.indexed_nutriments).toEqual({ fiber_100g: 2 });
      expect(rows[1]?.indexed_nutriments).toEqual({});
      expect(truncated).toBe(true);
    });

    it('rejects an unknown nutrient before any request', async () => {
      global.fetch = vi.fn();

      const result = await runToolContract(offSearchProductsTool, {
        nutrient_filters: [{ nutrient: 'energy-kj', operator: 'lt', value: 1 }],
      } as never);

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: McpErrorish }).error.code).toBe(
        JsonRpcErrorCode.InvalidParams,
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    describe('rows outside the constraints, through the tool (#64)', () => {
      /** Hits from one live capture, as `[code, sugars_100g]`. */
      function sugarHits(rows: readonly (readonly [string, number])[]): Record<string, unknown>[] {
        return rows.map(([code, sugars_100g]) => ({ code, nutriments: { sugars_100g } }));
      }

      /** Page 1 of `yogurt` with `sugars lte 3` at page_size 30, live 2026-10-30: count 5126. */
      const YOGURT_LTE_3 = [
        ['0894700010137', 3.53],
        ['5202234145877', 3.4],
        ['4056489055952', 3.5],
        ['8012666051236', 3.9],
        ['5201054015124', 3],
        ['0056800828917', 2.86],
        ['0851463005053', 3.08],
        ['7613196008656', 3.7000000476837],
        ['7702001146208', 3.33],
        ['0851463005015', 3.52],
        ['0851463005022', 2.64],
        ['7802930005352', 1.4],
        ['00957328', 2.94],
        ['0851463005329', 2.2],
        ['7702001155439', 3.33],
        ['5201054015452', 3],
        ['7707799412009', 2],
        ['0816284020067', 3.53],
        ['0096619483556', 1.76],
        ['15565754', 3.5],
        ['7613404845844', 3.9],
        ['4099936000273', 3.7],
        ['0894700010014', 3.33],
        ['5201083425130', 3.5],
        ['4056489056201', 3.9],
        ['5201054016503', 3],
        ['7709468612017', 1.4],
        ['7862126490676', 2.8],
        ['0193968024680', 3.53],
        ['1014015040639', 2.5],
      ] as const;

      /** Page 1 of the `[3,4)` control at page_size 10, live 2026-10-30: count 10000, inexact. */
      const SUGARS_3_TO_4 = [
        ['3338310018864', 3.7],
        ['20534585', 3.6],
        ['5201310003230', 3.1],
        ['3263859715410', 3.9],
        ['3263859715311', 3.9],
        ['3061432116063', 3.9],
        ['3021690011111', 3.2],
        ['8888339005123', 3.4],
        ['3350030163297', 3.5],
        ['3171939907825', 3],
      ] as const;

      /** The band page, clipped the way the live control answered. */
      function clippedBand(page: number, hits: Record<string, unknown>[]): Response {
        return mockResponse({
          count: 10_000,
          is_count_exact: false,
          page,
          page_size: 10,
          page_count: 1000,
          hits,
        });
      }

      type SearchOutput = {
        total: number;
        total_is_lower_bound: boolean;
        last_page?: number;
        page_count: number;
        omitted?: number;
        outside_constraints?: number;
        products: { barcode: string; indexed_nutriments?: { sugars_100g?: number } }[];
        notice?: string;
        text_index_snapshot?: string;
        truncated?: boolean;
      };

      /** Every sugars value a result lists. */
      function listedSugars(output: SearchOutput): (number | undefined)[] {
        return output.products.map((row) => row.indexed_nutriments?.sugars_100g);
      }

      it('filed repro 3: no row above 3, the rows at exactly 3 kept, and the rest counted', async () => {
        global.fetch = vi.fn().mockResolvedValue(textHits(sugarHits(YOGURT_LTE_3), 5126));

        const result = await runToolContract(offSearchProductsTool, {
          query: 'yogurt',
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lte', value: 3 }],
          page_size: 30,
        });

        expect(result.isError).toBeFalsy();
        const output = result.structuredContent as SearchOutput;
        expect(listedSugars(output).every((value) => value !== undefined && value <= 3)).toBe(true);
        expect(output.products.map((row) => row.barcode)).toEqual(
          expect.arrayContaining(['5201054015124', '5201054015452', '5201054016503']),
        );
        expect(output.products.map((row) => row.barcode)).not.toContain('0894700010137');
        expect(output).toMatchObject({
          total: 5126,
          total_is_lower_bound: false,
          last_page: 171,
          page_count: 13,
          outside_constraints: 17,
        });
        expect(output).not.toHaveProperty('omitted');
        expect(allText(result)).toContain('17 rows on this page were left off');
        // The row keeps the value the index holds, unrounded.
        expect(allText(result)).toContain('sugars_100g 2.86 g');
      });

      it('filed repro 2: a band the old clause emptied now returns its rows', async () => {
        global.fetch = vi.fn().mockResolvedValue(clippedBand(1, sugarHits(SUGARS_3_TO_4)));

        const result = await runToolContract(offSearchProductsTool, {
          nutrient_filters: [
            { nutrient: 'sugars', operator: 'gte', value: 3.5 },
            { nutrient: 'sugars', operator: 'lte', value: 3.9 },
          ],
          page_size: 10,
        });

        expect(sentQ()).toBe('nutriments.sugars_100g:[3 TO *] nutriments.sugars_100g:[* TO 3.9]');
        const output = result.structuredContent as SearchOutput;
        expect(listedSugars(output)).toEqual([3.7, 3.6, 3.9, 3.9, 3.9, 3.5]);
        expect(output).toMatchObject({ total: 10_000, outside_constraints: 4 });
        expect(allText(result)).not.toContain('At least 10000 products match');
      });

      it('sugars gt 3 returns the 3.x rows above 3 and none at or below it', async () => {
        global.fetch = vi.fn().mockResolvedValue(clippedBand(1, sugarHits(SUGARS_3_TO_4)));

        const result = await runToolContract(offSearchProductsTool, {
          nutrient_filters: [{ nutrient: 'sugars', operator: 'gt', value: 3 }],
          page_size: 10,
        });

        expect(sentQ()).toBe('nutriments.sugars_100g:[3 TO *]');
        expect(listedSugars(result.structuredContent as SearchOutput)).toEqual([
          3.7, 3.6, 3.1, 3.9, 3.9, 3.9, 3.2, 3.4, 3.5,
        ]);
      });

      it('agrees on outside_constraints across both surfaces on a partly failing page', async () => {
        global.fetch = vi.fn().mockResolvedValue(
          textHits(
            sugarHits([
              ['3338310018864', 3.7],
              ['3171939907825', 3],
            ]),
            40,
          ),
        );

        const result = await runToolContract(offSearchProductsTool, {
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lte', value: 3 }],
        });

        const output = result.structuredContent as SearchOutput;
        expect(output.outside_constraints).toBe(1);
        expect(allText(result)).toContain('1 row on this page was left off');
        expect(listedSugars(output)).toEqual([3]);
      });

      it('agrees on outside_constraints across both surfaces on an all-fail page', async () => {
        global.fetch = vi.fn().mockResolvedValue(clippedBand(1, sugarHits(SUGARS_3_TO_4)));

        const result = await runToolContract(offSearchProductsTool, {
          nutrient_filters: [
            { nutrient: 'sugars', operator: 'gt', value: 3.9 },
            { nutrient: 'sugars', operator: 'lt', value: 4 },
          ],
          page_size: 10,
        });

        const output = result.structuredContent as SearchOutput;
        expect(output).toMatchObject({ products: [], page_count: 0, outside_constraints: 10 });
        const text = allText(result);
        expect(text).toContain('**Page 1 lists no products**');
        expect(text).toContain('10 rows on this page were left off');
        expect(output.notice).toContain('Request page 2');
        expect(text).not.toMatch(/No products found|past the end/);
      });

      it('pages contiguously past a page that lost rows, keeping offset and total', async () => {
        const page = (number: number, rows: readonly (readonly [string, number])[]) =>
          mockResponse({
            count: 40,
            is_count_exact: true,
            page: number,
            page_size: 20,
            page_count: 2,
            hits: sugarHits(rows),
          });
        global.fetch = vi
          .fn()
          .mockResolvedValueOnce(
            page(1, [
              ['3338310018864', 3.7],
              ['3171939907825', 3],
            ]),
          )
          .mockResolvedValueOnce(
            page(2, [
              ['20534585', 2],
              ['5201310003230', 3.1],
            ]),
          );

        const nutrient_filters = [
          { nutrient: 'sugars' as const, operator: 'lte' as const, value: 3 },
        ];
        const first = await runToolContract(offSearchProductsTool, { nutrient_filters });
        const second = await runToolContract(offSearchProductsTool, { nutrient_filters, page: 2 });

        expect([sentRequest(0).body?.page, sentRequest(1).body?.page]).toEqual([1, 2]);
        expect([sentRequest(0).body?.page_size, sentRequest(1).body?.page_size]).toEqual([20, 20]);
        const outputs = [first, second].map(({ structuredContent }) => structuredContent);
        expect(outputs).toMatchObject([
          { total: 40, last_page: 2, outside_constraints: 1, truncated: true },
          { total: 40, last_page: 2, outside_constraints: 1 },
        ]);
        expect(outputs[1]).not.toHaveProperty('truncated');
        expect(listedSugars(outputs[0] as SearchOutput)).toEqual([3]);
        expect(listedSugars(outputs[1] as SearchOutput)).toEqual([2]);
      });

      it('fills a capped 50-row page from an over-cap page_size, then reports what it lost', async () => {
        const hits = Array.from({ length: 50 }, (_, i) => ({
          code: String(3_017_620_422_003 + i),
          nutriments: { sugars_100g: i % 2 === 0 ? 2 : 3.5 },
        }));
        global.fetch = vi.fn().mockResolvedValue(textHits(hits, 1813));

        const result = await runToolContract(offSearchProductsTool, {
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lte', value: 3 }],
          page_size: 80,
        });

        expect(sentRequest().body?.page_size).toBe(50);
        expect(result.structuredContent).toMatchObject({
          page_size: 50,
          page_count: 25,
          outside_constraints: 25,
          last_page: 37,
          truncated: true,
          shown: 25,
          cap: 50,
        });
        expect((result.structuredContent as { page_size_capped?: string }).page_size_capped).toBe(
          'page_size 80 is above the 50 results one call returns; this page was served at page_size 50. Pages are counted at that size: request page 2 for results 51–100.',
        );
        expect(allText(result)).toContain('showing 25)');
      });

      it('adds neither the field nor its line on a clean constrained page', async () => {
        global.fetch = vi.fn().mockResolvedValue(
          textHits(
            sugarHits([
              ['3338310018864', 2.7],
              ['3171939907825', 3],
            ]),
            2,
          ),
        );

        const result = await runToolContract(offSearchProductsTool, {
          nutrient_filters: [{ nutrient: 'sugars', operator: 'lte', value: 3 }],
        });

        const output = result.structuredContent as SearchOutput;
        expect(output).not.toHaveProperty('outside_constraints');
        expect(listedSugars(output)).toEqual([2.7, 3]);
        const text = allText(result);
        expect(text).not.toMatch(/on this page (was|were) left off/);
        expect(text).toContain('**2 whole-number matches**');
        expect(text).not.toContain('total products');
      });

      /** A clipped page of one row at 2, under `nutrient`'s upstream key. */
      function cleanClippedPage(nutrient: string): Response {
        return clippedBand(1, [{ code: '3338310018864', nutriments: { [`${nutrient}_100g`]: 2 } }]);
      }

      it.each(['energy-kcal', 'fat', 'saturated-fat', 'carbohydrates', 'sugars'] as const)(
        'reads a clean page constrained on %s as the whole-number answer',
        async (nutrient) => {
          global.fetch = vi.fn().mockResolvedValue(cleanClippedPage(nutrient));

          const result = await runToolContract(offSearchProductsTool, {
            nutrient_filters: [{ nutrient, operator: 'lte', value: 3 }],
          });

          expect(result.structuredContent).not.toHaveProperty('outside_constraints');
          const text = allText(result);
          expect(text).toContain('**10000+ whole-number matches**');
          expect(text).toContain(
            '*Open Food Facts stops counting its whole-number answer at 10000',
          );
          expect(text).not.toContain('At least 10000 products match');
        },
      );

      it.each(['fiber', 'proteins', 'salt', 'sodium'] as const)(
        'keeps the product count on a clean page constrained only on %s',
        async (nutrient) => {
          global.fetch = vi.fn().mockResolvedValue(cleanClippedPage(nutrient));

          const result = await runToolContract(offSearchProductsTool, {
            nutrient_filters: [{ nutrient, operator: 'lte', value: 3 }],
          });

          const text = allText(result);
          expect(text).toContain('**10000+ total products**');
          expect(text).toContain('*At least 10000 products match');
          expect(text).not.toContain('whole-number');
        },
      );

      it('reads a page constrained on both kinds of nutrient as the whole-number answer', async () => {
        global.fetch = vi
          .fn()
          .mockResolvedValue(
            textHits(
              [{ code: '3338310018864', nutriments: { salt_100g: 0.1, sugars_100g: 2 } }],
              7,
            ),
          );

        const result = await runToolContract(offSearchProductsTool, {
          nutrient_filters: [
            { nutrient: 'salt', operator: 'lte', value: 1 },
            { nutrient: 'sugars', operator: 'lte', value: 3 },
          ],
        });

        expect(allText(result)).toContain('**7 whole-number matches**');
      });

      it('keeps the product count on an unconstrained page', async () => {
        global.fetch = vi.fn().mockResolvedValue(textHits([{ code: '3338310018864' }], 7));

        const result = await runToolContract(offSearchProductsTool, { query: 'yogurt' });

        const text = allText(result);
        expect(text).toContain('**7 total products**');
        expect(text).not.toContain('whole-number');
      });

      it('states what the totals describe in the snapshot note, naming the nutrients once', async () => {
        global.fetch = vi.fn().mockResolvedValue(textHits(sugarHits(SUGARS_3_TO_4), 40));

        const result = await runToolContract(offSearchProductsTool, {
          nutrient_filters: [
            { nutrient: 'sugars', operator: 'gte', value: 3.5 },
            { nutrient: 'sugars', operator: 'lte', value: 3.9 },
          ],
        });

        const sentence =
          'The index compares sugars as whole numbers, so total, total_is_lower_bound, and last_page describe its whole-number answer, and rows of that answer outside these constraints are left off each page and counted in outside_constraints.';
        expect((result.structuredContent as SearchOutput).text_index_snapshot).toContain(sentence);
        expect(allText(result)).toContain(sentence);
      });

      it('names each whole-number nutrient in the snapshot note, and skips the float ones', async () => {
        global.fetch = vi.fn().mockResolvedValue(textHits([], 0));

        const result = await runToolContract(offSearchProductsTool, {
          nutrient_filters: [
            { nutrient: 'fat', operator: 'gte', value: 1 },
            { nutrient: 'sugars', operator: 'lt', value: 8 },
            { nutrient: 'fiber', operator: 'gte', value: 6 },
          ],
        });

        expect((result.structuredContent as SearchOutput).text_index_snapshot).toContain(
          'The index compares fat, sugars as whole numbers,',
        );
      });

      it('says nothing of whole numbers on a search constraining only float nutrients', async () => {
        global.fetch = vi.fn().mockResolvedValue(textHits(sugarHits([['3338310018864', 7]]), 1));

        const result = await runToolContract(offSearchProductsTool, {
          nutrient_filters: [{ nutrient: 'fiber', operator: 'gte', value: 6 }],
        });

        expect((result.structuredContent as SearchOutput).text_index_snapshot).not.toContain(
          'whole numbers',
        );
      });

      it('sends what it always sent, and adds nothing, on a search without nutrient filters', async () => {
        global.fetch = vi.fn().mockResolvedValue(textHits(sugarHits(SUGARS_3_TO_4), 10));

        const result = await runToolContract(offSearchProductsTool, { query: 'skyr' });

        const output = result.structuredContent as SearchOutput;
        expect(sentRequest().body?.fields).toEqual(SEARCH_FIELD_LIST);
        expect(output.products).toHaveLength(10);
        expect(output).not.toHaveProperty('outside_constraints');
        expect(output.text_index_snapshot).not.toContain('whole numbers');
      });
    });
  });

  // ── #60: a cancellation during tag resolution ends the search ─────────────

  describe('caller cancellation during tag resolution (#60)', () => {
    beforeEach(() => {
      initOpenFoodFactsService();
      initTaxonomyService();
    });

    it('ends off_search_products as cancelled and sends no search', async () => {
      let entered: () => void = () => undefined;
      const fetchEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      global.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
        entered();
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (init?.signal?.aborted) abort();
          init?.signal?.addEventListener('abort', abort);
        });
      }) as typeof fetch;
      const controller = new AbortController();

      // The search request would itself end cancelled, so the error code alone cannot tell the
      // fix apart from a cancellation absorbed as lookup_failed; the request log can.
      const pending = runToolContract(
        offSearchProductsTool,
        { query: 'soup', categories_tag: 'lentil soups' },
        { context: { signal: controller.signal, errors: offSearchProductsTool.errors } },
      );
      await fetchEntered;
      controller.abort();
      const result = await pending;

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: McpErrorish }).error.code).toBe(
        JsonRpcErrorCode.RequestCancelled,
      );
      // Only the autocomplete was ever sent: no unconfirmed value went on to the search.
      expect(
        vi.mocked(global.fetch).mock.calls.map(([input]) => new URL(String(input)).pathname),
      ).toEqual(['/autocomplete']);
    });

    it('ends a call that joined a shared lookup when its own caller cancels, not when the lookup ends (#75)', async () => {
      // Lookups hang until their signal aborts; a search answers at once.
      const paths: string[] = [];
      global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
        const { pathname } = new URL(String(input));
        paths.push(pathname);
        if (pathname === '/search') return Promise.resolve(mockResponse(TEXT_SEARCH_EMPTY));
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason));
        });
      }) as typeof fetch;
      const input = { query: 'soup', categories_tag: 'lentil soups' };
      const cancelled = new DOMException(
        'The joining call was cancelled by its caller.',
        'AbortError',
      );

      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const start = Date.now();
        const timed = <T>(run: Promise<T>) =>
          run.then((result) => ({ afterMs: Date.now() - start, result }));
        const owner = timed(
          runToolContract(offSearchProductsTool, input, {
            context: { errors: offSearchProductsTool.errors },
          }),
        );
        await vi.advanceTimersByTimeAsync(1);
        const controller = new AbortController();
        const joiner = timed(
          runToolContract(offSearchProductsTool, input, {
            context: { signal: controller.signal, errors: offSearchProductsTool.errors },
          }),
        );
        await vi.advanceTimersByTimeAsync(99);
        // One lookup in flight, the first call's: the second joined it rather than sending its own.
        expect(paths).toEqual(['/autocomplete']);
        controller.abort(cancelled);
        await vi.advanceTimersByTimeAsync(120_000);

        const joined = await joiner;
        expect(joined.afterMs).toBe(100);
        expect(joined.result.isError).toBe(true);
        const { error } = joined.result.structuredContent as { error: McpErrorish };
        expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(error.message).toBe(cancelled.message);
        expect(JSON.stringify(joined.result.content)).toContain(cancelled.message);

        // The first call's lookup runs its 20 s on, two attempts, then its search: nothing restarts it.
        const first = await owner;
        expect(first.afterMs).toBe(20_000);
        expect(first.result.isError).toBeFalsy();
        expect(paths).toEqual(['/autocomplete', '/autocomplete', '/search']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── #72: every read is bounded by one total deadline ──────────────────────

  describe('retry deadline (#72)', () => {
    const BARCODE = '3017620422003';

    /** One attempt: `hang` holds the request until a signal aborts it; otherwise an HTTP answer. */
    type Step =
      | 'hang'
      | { status: number; body?: unknown; retryAfter?: string; afterMs?: number }
      | { stalledBody: 'application/json' | 'text/plain' }
      | { droppedBody: 'application/json' | 'text/plain' };

    /** What Bun raises for a socket closed mid-body, runtime advice included. */
    const RUNTIME_SOCKET_ERROR =
      'ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()';

    /** Scripts fetch attempt by attempt, repeating the last step, and logs each abort reason seen. */
    function scriptFetch(...steps: Step[]): { abortReasons: unknown[] } {
      const abortReasons: unknown[] = [];
      let call = 0;
      global.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
        const step = steps[Math.min(call, steps.length - 1)] as Step;
        call += 1;
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          let stalled: ReadableStreamDefaultController<Uint8Array> | undefined;
          signal.addEventListener('abort', () => {
            abortReasons.push(signal.reason);
            stalled?.error(signal.reason);
            reject(signal.reason);
          });
          if (step === 'hang') return;
          if ('stalledBody' in step) {
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                stalled = controller;
                controller.enqueue(new TextEncoder().encode('{"status":1,'));
              },
            });
            resolve(new Response(body, { headers: { 'content-type': step.stalledBody } }));
            return;
          }
          if ('droppedBody' in step) {
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"status":1,'));
              },
              pull(controller) {
                controller.error(new Error(RUNTIME_SOCKET_ERROR));
              },
            });
            resolve(new Response(body, { headers: { 'content-type': step.droppedBody } }));
            return;
          }
          const answer = () => {
            const response = mockResponse(step.body ?? { detail: 'refused' }, step.status);
            if (step.retryAfter !== undefined) response.headers.set('retry-after', step.retryAfter);
            resolve(response);
          };
          // A zero timer costs a fake millisecond, which the exact-time assertions would see.
          if (step.afterMs === undefined) answer();
          else setTimeout(answer, step.afterMs);
        });
      }) as typeof fetch;
      return { abortReasons };
    }

    /** Drives `run` on fake timers with jitter off, reporting how it settled and when. */
    async function clocked<T>(
      run: () => Promise<T>,
    ): Promise<{ settledAtMs: number; value?: T; error?: McpErrorish }> {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const start = Date.now();
        const settled = run().then(
          (value) => ({ settledAtMs: Date.now() - start, value }),
          (error: McpErrorish) => ({ settledAtMs: Date.now() - start, error }),
        );
        await vi.advanceTimersByTimeAsync(200_000);
        return await settled;
      } finally {
        vi.useRealTimers();
      }
    }

    /** `clocked` for a tool call, which resolves with a result even when the call failed. */
    async function clockedTool<T>(
      run: () => Promise<T>,
    ): Promise<{ settledAtMs: number; result: T }> {
      const { settledAtMs, value } = await clocked(run);
      if (value === undefined) throw new Error('Expected the tool call to resolve.');
      return { settledAtMs, result: value };
    }

    /** The pathname of every request the stubbed fetch received, in order. */
    function requestedPaths(): string[] {
      return vi.mocked(global.fetch).mock.calls.map(([input]) => new URL(String(input)).pathname);
    }

    /** Every read, its budget, and the per-call fields its failures carry. */
    const READS = [
      {
        label: 'getProduct',
        deadlineMs: 35_000,
        attempts: 3,
        operation: `OFF:getProduct:${BARCODE}`,
        carried: { barcode: BARCODE },
        read: (ctx: ReturnType<typeof createMockContext>, off: OpenFoodFactsService) =>
          off.getProduct(BARCODE, ctx),
      },
      {
        label: 'getProductFields',
        deadlineMs: 35_000,
        attempts: 3,
        operation: `OFF:getProductFields:${BARCODE}`,
        carried: { barcode: BARCODE },
        read: (ctx: ReturnType<typeof createMockContext>, off: OpenFoodFactsService) =>
          off.getProductFields(BARCODE, 'product_name', ctx),
      },
      {
        label: 'a text search',
        deadlineMs: 35_000,
        attempts: 3,
        operation: 'OFF:searchProductsByText',
        carried: { page: 2, page_size: 5 },
        read: (ctx: ReturnType<typeof createMockContext>, off: OpenFoodFactsService) =>
          off.searchProducts({ query: 'pasta', page: 2, page_size: 5 }, ctx),
      },
      {
        label: 'a tag search',
        deadlineMs: 35_000,
        attempts: 3,
        operation: 'OFF:searchProductsByTags',
        carried: { page: 3, page_size: 5 },
        read: (ctx: ReturnType<typeof createMockContext>, off: OpenFoodFactsService) =>
          off.searchProducts({ categories_tag: 'en:pastas', page: 3, page_size: 5 }, ctx),
      },
      {
        label: 'suggestTaxonomy',
        deadlineMs: 20_000,
        attempts: 2,
        operation: 'OFF:suggestTaxonomy:category',
        carried: { taxonomy_name: 'category', term: 'pasta' },
        read: (ctx: ReturnType<typeof createMockContext>, off: OpenFoodFactsService) =>
          off.suggestTaxonomy('category', 'pasta', ctx),
      },
    ];

    describe('expiry', () => {
      it.each(READS)(
        'fails $label at its $deadlineMs ms deadline, as the declared upstream_timeout',
        async ({ deadlineMs, attempts, operation, carried, read }) => {
          const { abortReasons } = scriptFetch('hang');

          const { settledAtMs, error } = await clocked<unknown>(() =>
            read(createMockContext(), svc),
          );

          expect(settledAtMs).toBe(deadlineMs);
          expect(error?.code).toBe(JsonRpcErrorCode.Timeout);
          expect(error?.message).toBe(
            `Open Food Facts did not respond within the ${deadlineMs / 1000} s retry deadline.`,
          );
          expect(error?.data).toMatchObject({
            ...carried,
            reason: 'upstream_timeout',
            retryable: true,
            retryAttempts: attempts,
            operation,
          });
          // Every attempt but the last hit its own 15 s stall; the clock cut the last one off.
          expect(global.fetch).toHaveBeenCalledTimes(attempts);
          expect(abortReasons.at(-1)).toMatchObject({
            name: 'TimeoutError',
            message: `${operation} exceeded its ${deadlineMs}ms retry deadline.`,
          });
        },
      );

      it('bounds a ladder of timed-out answers too (#68), each one slow to arrive', async () => {
        scriptFetch({ status: 200, body: TEXT_SEARCH_TIMED_OUT, afterMs: 14_000 });

        const { settledAtMs, error } = await clocked(() =>
          svc.searchProducts({ query: 'pasta', page: 1, page_size: 20 }, createMockContext()),
        );

        expect(settledAtMs).toBe(35_000);
        expect(error?.data?.reason).toBe('upstream_timeout');
        expect(global.fetch).toHaveBeenCalledTimes(3);
      });

      it('bounds a response body that stalls after its headers arrive', async () => {
        scriptFetch({ stalledBody: 'application/json' });

        const { settledAtMs, error } = await clocked(() =>
          svc.getProduct(BARCODE, createMockContext()),
        );

        expect(settledAtMs).toBe(35_000);
        expect(error?.code).toBe(JsonRpcErrorCode.Timeout);
        expect(error?.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
      });
    });

    describe('the ladder under the deadline', () => {
      it('retries a per-attempt timeout, so the attempt signal does not cut the ladder to one', async () => {
        scriptFetch('hang', { status: 200, body: PRODUCT_FOUND });

        const { settledAtMs, value } = await clocked(() =>
          svc.getProduct(BARCODE, createMockContext()),
        );

        expect(value).toMatchObject({ source: 'off_api', product: { product_name: 'Nutella' } });
        expect(settledAtMs).toBe(15_500);
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('still recovers from a 503, then answers', async () => {
        scriptFetch({ status: 503 }, { status: 200, body: PRODUCT_FOUND });

        const { value } = await clocked(() => svc.getProduct(BARCODE, createMockContext()));

        expect(value).toMatchObject({ source: 'off_api', product: { product_name: 'Nutella' } });
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('leaves a ladder that exhausts inside the deadline as it was', async () => {
        scriptFetch({ status: 503 });

        const { settledAtMs, error } = await clocked(() =>
          svc.getProduct(BARCODE, createMockContext()),
        );

        expect(settledAtMs).toBe(3_500);
        expect(error?.data?.reason).toBe('upstream_error');
        expect(error?.message).toContain('(failed after 4 attempts)');
        expect(global.fetch).toHaveBeenCalledTimes(4);
      });

      it.each(['application/json', 'text/plain'] as const)(
        'declares the failure of a last attempt whose %s body stalled',
        async (type) => {
          scriptFetch({ status: 503 }, { status: 503 }, { status: 503 }, { stalledBody: type });

          const { settledAtMs, error } = await clocked(() =>
            svc.getProduct(BARCODE, createMockContext()),
          );

          expect(settledAtMs).toBe(18_500);
          expect(error?.code).toBe(JsonRpcErrorCode.Timeout);
          expect(error?.data).toMatchObject({
            barcode: BARCODE,
            reason: 'upstream_timeout',
            retryable: true,
            retryAttempts: 4,
          });
          expect(error?.message).toBe(
            'Open Food Facts did not respond within the request deadline. (failed after 4 attempts)',
          );
        },
      );
    });

    describe('a 429 the deadline outlives', () => {
      /** A text search: backoffs of 1, 2, and 4 s with jitter off. */
      const textSearch = () =>
        svc.searchProducts({ query: 'pasta', page: 1, page_size: 20 }, createMockContext());

      it.each([
        {
          label: 'the next attempt is in flight at expiry',
          steps: [{ status: 429, retryAfter: '30' }, 'hang'] as Step[],
          settledAtMs: 35_000,
          attempts: 2,
        },
        {
          label: 'the backoff would outlast what is left',
          steps: [
            { status: 429, afterMs: 14_000 },
            { status: 429, afterMs: 14_000 },
            { status: 429, afterMs: 3_500 },
          ] as Step[],
          settledAtMs: 34_500,
          attempts: 3,
        },
        {
          // The third 429 lands at 31 s, and its 4 s backoff ends exactly on the deadline.
          label: 'the expiry lands during the backoff',
          steps: [
            { status: 429, afterMs: 14_000 },
            { status: 429, afterMs: 14_000 },
            { status: 429 },
          ] as Step[],
          settledAtMs: 35_000,
          attempts: 3,
        },
      ])(
        'reports the 429, not an outage, when $label',
        async ({ steps, settledAtMs, attempts }) => {
          scriptFetch(...steps);

          const result = await clocked(textSearch);

          expect(result.settledAtMs).toBe(settledAtMs);
          expect(result.error?.code).toBe(JsonRpcErrorCode.RateLimited);
          expect(result.error?.data).toMatchObject({
            reason: 'rate_limited',
            retryable: true,
            status: 429,
          });
          expect(result.error?.message).toContain('is rate-limiting this client (HTTP 429)');
          expect(global.fetch).toHaveBeenCalledTimes(attempts);
        },
      );

      it('carries the Retry-After the upstream sent, in whole seconds (#76)', async () => {
        scriptFetch({ status: 429, retryAfter: '30' }, 'hang');

        const { error } = await clocked(textSearch);

        expect(error?.data).toMatchObject({ retryAfter: 30 });
      });

      it.each([
        // 44.75 s left, rounded up; past withRetry's 30 s ceiling, so it fails fast.
        ['ahead', '2026-11-01T12:00:00.250Z', 'Sun, 01 Nov 2026 12:00:45 GMT', 45, 1],
        // 44.25 s left: rounded up too, where rounding to the nearest would say 44.
        [
          'ahead by a fraction under the half second',
          '2026-11-01T12:00:00.750Z',
          'Sun, 01 Nov 2026 12:00:45 GMT',
          45,
          1,
        ],
        // Nothing left, so the wait is 0 and every attempt is spent at once.
        ['already past', '2026-11-01T12:00:00.250Z', 'Sun, 01 Nov 2026 11:59:00 GMT', 0, 4],
      ])(
        'converts an HTTP-date Retry-After %s into the seconds left (#76)',
        async (_label, now, retryAfter, seconds, attempts) => {
          vi.useFakeTimers({ now: Date.parse(now) });
          let error: McpErrorish;
          try {
            scriptFetch({ status: 429, retryAfter });
            const pending = captureError(svc.getProduct(BARCODE, createMockContext()));
            await vi.runAllTimersAsync();
            error = await pending;
          } finally {
            vi.useRealTimers();
          }

          expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: seconds });
          expect(global.fetch).toHaveBeenCalledTimes(attempts);
        },
      );

      it.each([
        ['no Retry-After', undefined],
        ['an unreadable Retry-After', 'soon'],
        ['a Retry-After that is neither form', '1.5'],
      ])('publishes no retryAfter for a 429 with %s (#76)', async (_label, retryAfter) => {
        // Every attempt answers alike, so the failure raised is one that carried the header.
        scriptFetch(retryAfter === undefined ? { status: 429 } : { status: 429, retryAfter });

        const { error } = await clocked(() => svc.getProduct(BARCODE, createMockContext()));

        expect(error?.data?.reason).toBe('rate_limited');
        expect(error?.data).not.toHaveProperty('retryAfter');
      });

      it('reports the outage when a later attempt answered something else', async () => {
        // 429 at 14 s, waits 5 s; 503 at 20 s, waits 2 s; in flight from 22 s until the clock.
        scriptFetch(
          { status: 429, retryAfter: '5', afterMs: 14_000 },
          { status: 503, afterMs: 1_000 },
          'hang',
        );

        const { settledAtMs, error } = await clocked(textSearch);

        expect(settledAtMs).toBe(35_000);
        expect(error?.code).toBe(JsonRpcErrorCode.Timeout);
        expect(error?.data?.reason).toBe('upstream_timeout');
      });

      it('reports the outage when a later attempt went silent for its whole 15 s', async () => {
        // 429 at once; then two 15 s stalls end at 33 s, and the 4 s backoff outlasts the rest.
        scriptFetch({ status: 429 }, 'hang');

        const { settledAtMs, error } = await clocked(textSearch);

        expect(settledAtMs).toBe(33_000);
        expect(error?.data?.reason).toBe('upstream_timeout');
        expect(global.fetch).toHaveBeenCalledTimes(3);
      });

      it('fails at once on a Retry-After longer than what is left', async () => {
        scriptFetch('hang', { status: 429, retryAfter: '25' });

        const { settledAtMs, error } = await clocked(() =>
          svc.getProduct(BARCODE, createMockContext()),
        );

        expect(settledAtMs).toBe(15_500);
        expect(error?.data).toMatchObject({ reason: 'rate_limited', retryAfter: 25 });
      });

      it('leaves the client-side budget refusal to fail at once, whatever came before it', async () => {
        const budgeted = new OpenFoodFactsService({
          baseUrl: 'https://world.openfoodfacts.org',
          rateLimitProduct: 1,
          rateLimitSearch: 100,
          rateLimitTaxonomy: 100,
        });
        scriptFetch({ status: 429 });

        const { settledAtMs, error } = await clocked(() =>
          budgeted.getProduct(BARCODE, createMockContext()),
        );

        expect(settledAtMs).toBe(500);
        expect(error?.message).toContain('its own client-side budget');
        expect(global.fetch).toHaveBeenCalledOnce();
      });
    });

    describe('through the tools', () => {
      beforeEach(() => {
        initOpenFoodFactsService();
        initTaxonomyService();
      });

      it('fails off_get_product at 35 s with the declared reason and its recovery hint', async () => {
        scriptFetch('hang');

        const { settledAtMs, result } = await clockedTool(() =>
          runToolContract(offGetProductTool, { barcode: BARCODE }),
        );

        expect(settledAtMs).toBe(35_000);
        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as { error: McpErrorish };
        expect(error.code).toBe(JsonRpcErrorCode.Timeout);
        expect(error.data?.reason).toBe('upstream_timeout');
        expect(error.data?.retryable).toBe(true);
        const hint = offGetProductTool.errors?.find(
          (e) => e.reason === 'upstream_timeout',
        )?.recovery;
        expect(error.data?.recovery?.hint).toBe(hint);
        const text = JSON.stringify(result.content);
        expect(text).toContain('did not respond within the 35 s retry deadline');
        expect(text).toContain(String(hint));
        expect(text).not.toContain('retry_deadline_exceeded');
      });

      it.each([
        ['off_get_product', () => runToolContract(offGetProductTool, { barcode: BARCODE })],
        ['the search read', () => runToolContract(offSearchProductsTool, { query: 'pasta' })],
      ])('carries a 429 wait on %s as a number of seconds (#76)', async (_label, call) => {
        scriptFetch({ status: 429, retryAfter: '60' });

        const { result } = await clockedTool(call);

        const { error } = result.structuredContent as { error: McpErrorish };
        expect(error.data).toMatchObject({ reason: 'rate_limited', retryAfter: 60 });
      });

      it('lists a hung barcode in off_compare_products under its declared reason', async () => {
        scriptFetch('hang');

        const { settledAtMs, result } = await clockedTool(() =>
          runToolContract(offCompareProductsTool, { barcodes: [BARCODE, '5449000000996'] }),
        );

        expect(settledAtMs).toBe(35_000);
        const { failed } = result.structuredContent as { failed: { reason: string }[] };
        expect(failed.map(({ reason }) => reason)).toEqual([
          'upstream_timeout',
          'upstream_timeout',
        ]);
      });

      it('settles a search with tag filters at 55 s: parallel lookups, then one search', async () => {
        scriptFetch('hang');

        const { settledAtMs, result } = await clockedTool(() =>
          runToolContract(offSearchProductsTool, {
            query: 'soup',
            categories_tag: 'lentil soups',
            brands_tag: 'en:nowhere',
            labels_tag: 'never heard of it',
          }),
        );

        expect(settledAtMs).toBe(55_000);
        const { error } = result.structuredContent as { error: McpErrorish };
        expect(error.data?.reason).toBe('upstream_timeout');
        const paths = requestedPaths();
        expect(paths.filter((path) => path === '/autocomplete')).toHaveLength(4);
        expect(paths.filter((path) => path === '/search')).toHaveLength(3);
      });

      it('settles a search that joined a lookup its starter cancelled within 55 s of its own start (#75)', async () => {
        scriptFetch('hang');
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const input = { query: 'tea', categories_tag: 'en:kombuchas' };
        const controller = new AbortController();
        try {
          const starter = runToolContract(offSearchProductsTool, input, {
            context: { signal: controller.signal },
          });
          await vi.advanceTimersByTimeAsync(1);
          const startedAt = Date.now();
          const joiner = runToolContract(offSearchProductsTool, input).then((result) => ({
            afterMs: Date.now() - startedAt,
            result,
          }));
          // The starter cancels 1 ms before its lookup's own 20 s deadline.
          await vi.advanceTimersByTimeAsync(19_998);
          controller.abort();
          await vi.advanceTimersByTimeAsync(200_000);

          const cancelled = (await starter).structuredContent as { error: McpErrorish };
          expect(cancelled.error.code).toBe(JsonRpcErrorCode.RequestCancelled);
          const { afterMs, result } = await joiner;
          expect(afterMs).toBe(55_000);
          const { error } = result.structuredContent as { error: McpErrorish };
          expect(error.data?.reason).toBe('upstream_timeout');
        } finally {
          vi.useRealTimers();
        }
      });

      it('refuses an unconfirmed exclusion at 20 s as retryable, sending no search', async () => {
        scriptFetch('hang');

        const { settledAtMs, result } = await clockedTool(() =>
          runToolContract(offSearchProductsTool, {
            categories_tag: 'en:yogurts',
            exclude_allergens: ['en:kiwi'],
          }),
        );

        expect(settledAtMs).toBe(20_000);
        const { error } = result.structuredContent as { error: McpErrorish };
        expect(error.data?.reason).toBe('unrecognized_exclusion');
        expect(error.data?.retryable).toBe(true);
        expect(requestedPaths()).toEqual(['/autocomplete', '/autocomplete']);
      });

      it('answers off_browse_taxonomy from the offline sample at 20 s', async () => {
        scriptFetch('hang');

        const { settledAtMs, result } = await clockedTool(() =>
          runToolContract(offBrowseTaxonomyTool, { facet: 'categories', search: 'cheese' }),
        );

        expect(settledAtMs).toBe(20_000);
        expect(result.isError).toBeFalsy();
        const output = result.structuredContent as { tags: { id: string }[]; notice?: string };
        expect(output.tags.map((tag) => tag.id)).toEqual(['en:cheeses', 'en:fresh-cheeses']);
        expect(output.notice).toContain('could not be reached or gave no usable answer');
        expect(output.notice).toContain('did not respond within the 20 s retry deadline');
        expect(JSON.stringify(result)).not.toContain('tag matched');
      });
    });

    describe('a connection dropped mid-body (#74)', () => {
      const DROPPED_MESSAGE = 'Open Food Facts closed the connection before finishing its answer.';
      /** Fragments of the runtime's error, none of which belongs on either surface. */
      const RUNTIME_TEXT = /ECONNRESET|socket|verbose|second argument/;

      describe.each(['application/json', 'text/plain'] as const)('on a %s body', (type) => {
        it.each(READS)(
          'fails $label as the retryable upstream_error after four attempts',
          async ({ operation, carried, read }) => {
            scriptFetch({ droppedBody: type });

            const { error } = await clocked<unknown>(() => read(createMockContext(), svc));

            expect(error?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
            expect(error?.message).toBe(`${DROPPED_MESSAGE} (failed after 4 attempts)`);
            expect(error?.data).toMatchObject({
              ...carried,
              reason: 'upstream_error',
              retryable: true,
              retryAttempts: 4,
              operation,
            });
            expect(global.fetch).toHaveBeenCalledTimes(4);
            expect(JSON.stringify(error?.data)).not.toMatch(RUNTIME_TEXT);
          },
        );

        it('keeps the runtime error as the cause, off the message and data', async () => {
          scriptFetch({ droppedBody: type });

          const { error } = await clocked(() => svc.getProduct(BARCODE, createMockContext()));

          const chain: unknown[] = [];
          for (let link: unknown = error; link instanceof Error; link = link.cause) {
            chain.push(link);
          }
          expect(chain.at(-1)).toMatchObject({ message: RUNTIME_SOCKET_ERROR });
        });

        it('serves the answer of an attempt after the drop', async () => {
          scriptFetch({ droppedBody: type }, { status: 200, body: PRODUCT_FOUND });

          const { value } = await clocked(() => svc.getProduct(BARCODE, createMockContext()));

          expect(value).toEqual({ source: 'off_api', product: PRODUCT_FOUND.product });
          expect(global.fetch).toHaveBeenCalledTimes(2);
        });
      });

      describe('through the tools', () => {
        beforeEach(() => {
          initOpenFoodFactsService();
          initTaxonomyService();
        });

        it('fails off_get_product with the declared reason and its recovery hint', async () => {
          scriptFetch({ droppedBody: 'application/json' });

          const { result } = await clockedTool(() =>
            runToolContract(offGetProductTool, { barcode: BARCODE }),
          );

          expect(result.isError).toBe(true);
          const { error } = result.structuredContent as { error: McpErrorish };
          expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
          expect(error.data).toMatchObject({
            reason: 'upstream_error',
            retryable: true,
            retryAttempts: 4,
          });
          const hint = offGetProductTool.errors?.find(
            (e) => e.reason === 'upstream_error',
          )?.recovery;
          expect(error.data?.recovery?.hint).toBe(hint);
          const text = JSON.stringify(result.content);
          expect(text).toContain(DROPPED_MESSAGE);
          expect(text).toContain(String(hint));
          expect(JSON.stringify(result)).not.toMatch(RUNTIME_TEXT);
        });

        it.each([
          ['the text backend', { query: 'soup' }, '/search'],
          ['the tag backend', { categories_tag: 'en:soups' }, '/api/v2/search'],
        ])('fails off_search_products on %s the same way', async (_label, input, path) => {
          scriptFetch({ droppedBody: 'application/json' });

          const { result } = await clockedTool(() => runToolContract(offSearchProductsTool, input));

          expect(result.isError).toBe(true);
          const { error } = result.structuredContent as { error: McpErrorish };
          expect(error.data).toMatchObject({ reason: 'upstream_error', retryable: true });
          expect(JSON.stringify(result.content)).toContain(DROPPED_MESSAGE);
          expect(JSON.stringify(result)).not.toMatch(RUNTIME_TEXT);
          expect(requestedPaths()).toEqual(Array(4).fill(path));
        });

        it('lists the barcode in off_compare_products failed, without the runtime text', async () => {
          scriptFetch({ droppedBody: 'application/json' });

          const { result } = await clockedTool(() =>
            runToolContract(offCompareProductsTool, { barcodes: [BARCODE, '5449000000996'] }),
          );

          const { failed } = result.structuredContent as {
            failed: { barcode: string; reason: string; error: string }[];
          };
          expect(failed.map(({ reason }) => reason)).toEqual(['upstream_error', 'upstream_error']);
          expect(failed[0]?.error).toContain(DROPPED_MESSAGE);
          expect(JSON.stringify(result)).not.toMatch(RUNTIME_TEXT);
        });

        it('answers off_browse_taxonomy from the offline sample, naming the dropped connection', async () => {
          scriptFetch({ droppedBody: 'application/json' });

          const { result } = await clockedTool(() =>
            runToolContract(offBrowseTaxonomyTool, { facet: 'categories', search: 'cheese' }),
          );

          expect(result.isError).toBeFalsy();
          const output = result.structuredContent as { tags: { id: string }[]; notice?: string };
          expect(output.tags.map((tag) => tag.id)).toEqual(['en:cheeses', 'en:fresh-cheeses']);
          expect(output.notice).toContain(DROPPED_MESSAGE);
          expect(JSON.stringify(result)).not.toMatch(RUNTIME_TEXT);
        });

        it('sends a tag whose lookup dropped as unconfirmed, and the search still answers', async () => {
          scriptFetch(...Array<Step>(4).fill({ droppedBody: 'application/json' }), {
            status: 200,
            body: { ...TEXT_SEARCH_HITS, hits: [], count: 0 },
          });

          const { result } = await clockedTool(() =>
            runToolContract(offSearchProductsTool, {
              query: 'soup',
              categories_tag: 'lentil soups',
            }),
          );

          expect(result.isError).toBeFalsy();
          expect((result.structuredContent as { notice?: string }).notice).toContain(
            'could not be reached or gave no usable answer, so it went unchecked',
          );
          expect(JSON.stringify(result)).not.toMatch(RUNTIME_TEXT);
          expect(requestedPaths()).toEqual([...Array(4).fill('/autocomplete'), '/search']);
        });

        it('refuses an exclusion whose lookup dropped as retryable, sending no search', async () => {
          scriptFetch({ droppedBody: 'application/json' });

          const { result } = await clockedTool(() =>
            runToolContract(offSearchProductsTool, {
              categories_tag: 'en:yogurts',
              exclude_allergens: ['en:kiwi'],
            }),
          );

          const { error } = result.structuredContent as { error: McpErrorish };
          expect(error.data).toMatchObject({ reason: 'unrecognized_exclusion', retryable: true });
          expect(JSON.stringify(result)).not.toMatch(RUNTIME_TEXT);
          expect(requestedPaths()).toEqual(Array(4).fill('/autocomplete'));
        });
      });
    });

    describe('caller cancellation keeps precedence (#60)', () => {
      beforeEach(() => {
        initOpenFoodFactsService();
      });

      describe('mid-body', () => {
        beforeEach(() => {
          initTaxonomyService();
        });

        /** Answers with a body that errors as a real fetch does once `controller` aborts in its read. */
        function abortMidBody(controller: AbortController, type: string): void {
          global.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
            const signal = init?.signal as AbortSignal;
            const body = new ReadableStream<Uint8Array>({
              start(stream) {
                signal.addEventListener('abort', () => stream.error(signal.reason));
                stream.enqueue(new TextEncoder().encode('{"status":1,'));
              },
              pull() {
                controller.abort();
              },
            });
            return Promise.resolve(new Response(body, { headers: { 'content-type': type } }));
          }) as typeof fetch;
        }

        const JSON_BODY = 'application/json';

        it.each([
          { tool: offGetProductTool, input: { barcode: BARCODE }, type: JSON_BODY },
          { tool: offGetProductTool, input: { barcode: BARCODE }, type: 'text/plain' },
          { tool: offSearchProductsTool, input: { query: 'soup' }, type: JSON_BODY },
          {
            tool: offCompareProductsTool,
            input: { barcodes: [BARCODE, '5449000000996'] },
            type: JSON_BODY,
          },
          {
            tool: offBrowseTaxonomyTool,
            input: { facet: 'categories', search: 'cheese' },
            type: JSON_BODY,
          },
        ])('ends $tool.name as cancelled on a $type body', async ({ tool, input, type }) => {
          const controller = new AbortController();
          abortMidBody(controller, type);

          const { settledAtMs, result } = await clockedTool(() =>
            runToolContract(tool as never, input as never, {
              context: { signal: controller.signal },
            }),
          );

          expect(settledAtMs).toBe(0);
          const { error } = result.structuredContent as { error: McpErrorish };
          expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
          expect(error.message).toContain('aborted');
          expect(JSON.stringify(result.content)).toContain('aborted');
          expect(JSON.stringify(result)).not.toMatch(/closed the connection|upstream_error/);
        });
      });

      it('ends as cancelled when the abort lands in a retried attempt', async () => {
        const controller = new AbortController();
        let calls = 0;
        global.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
          calls += 1;
          if (calls === 1) return Promise.resolve(mockResponse('unavailable', 503));
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
            controller.abort();
          });
        }) as typeof fetch;

        const { settledAtMs, result } = await clockedTool(() =>
          runToolContract(
            offGetProductTool,
            { barcode: BARCODE },
            { context: { signal: controller.signal, errors: offGetProductTool.errors } },
          ),
        );

        expect(settledAtMs).toBe(500);
        const { error } = result.structuredContent as { error: McpErrorish };
        expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(error.message).toContain('was aborted');
        expect(JSON.stringify(result.content)).toContain('was aborted');
        expect(JSON.stringify(result)).not.toContain('retry deadline');
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('ends as cancelled when the abort lands in a backoff', async () => {
        const controller = new AbortController();
        global.fetch = vi.fn(async () => mockResponse('unavailable', 503));

        vi.useFakeTimers();
        try {
          const pending = runToolContract(
            offGetProductTool,
            { barcode: BARCODE },
            { context: { signal: controller.signal, errors: offGetProductTool.errors } },
          );
          await vi.advanceTimersByTimeAsync(100);
          controller.abort();
          await vi.advanceTimersByTimeAsync(0);
          const result = await pending;

          const { error } = result.structuredContent as { error: McpErrorish };
          expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
          expect(JSON.stringify(result.content)).toContain('aborted');
          expect(JSON.stringify(result)).not.toContain('retry deadline');
          expect(global.fetch).toHaveBeenCalledOnce();
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  // ── #73: a prepared-only read's as-sold figures, from the stored input sets ─

  describe('stored as-sold sets (#73)', () => {
    const NESQUIK = '7613035530799';

    /** The v3.5 request the follow-up must send for a barcode. */
    const v35Url = (code: string) =>
      `https://world.openfoodfacts.org/api/v3.5/product/${code}?fields=nutrition.input_sets`;

    /** One answer: held until its signal aborts, or a body with a status, optionally late. */
    type Answer = 'hang' | { status: number; body: unknown; afterMs?: number; html?: boolean };

    /**
     * Every request the fake saw: when (ms after the first request), which API version, and the
     * full URL.
     */
    type Sent = { atMs: number; api: 'v2' | 'v3.5'; code: string; url: string };

    /**
     * Routes each request by API version and barcode, serving its answers in order and repeating
     * the last. `onSend` runs as a request goes out, so a test can abort once one is in flight.
     * Times count from the first request, on whichever clock is installed by then: a test routes
     * before it fakes the timers, and a start read here would be real time, off by however long
     * that took.
     */
    function routeFetch(
      answers: Partial<Record<'v2' | 'v3.5', Record<string, Answer[]>>>,
      onSend?: (sent: Sent) => void,
    ): Sent[] {
      const sent: Sent[] = [];
      const served = new Map<string, number>();
      let firstAt: number | undefined;
      global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        const api = url.pathname.startsWith('/api/v3.5/') ? 'v3.5' : 'v2';
        const code = (url.pathname.split('/').at(-1) ?? '').replace(/\.json$/, '');
        firstAt ??= Date.now();
        const request: Sent = { atMs: Date.now() - firstAt, api, code, url: url.toString() };
        sent.push(request);
        const queue = answers[api]?.[code];
        if (!queue) throw new Error(`Unrouted ${api} request for ${code}`);
        const key = `${api} ${code}`;
        const n = served.get(key) ?? 0;
        served.set(key, n + 1);
        const answer = queue[Math.min(n, queue.length - 1)] as Answer;
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason));
          onSend?.(request);
          if (answer === 'hang') return;
          const respond = () =>
            resolve(
              new Response(
                typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
                {
                  status: answer.status,
                  headers: { 'content-type': answer.html ? 'text/html' : 'application/json' },
                },
              ),
            );
          if (answer.afterMs === undefined) respond();
          else setTimeout(respond, answer.afterMs);
        });
      }) as typeof fetch;
      return sent;
    }

    /** Settle `run` on fake timers with jitter off, reporting when it settled. */
    async function clockedRun<T>(
      run: () => Promise<T>,
    ): Promise<{ settledAtMs: number; value?: T; error?: McpErrorish }> {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const start = Date.now();
        const settled = run().then(
          (value) => ({ settledAtMs: Date.now() - start, value }),
          (error: McpErrorish) => ({ settledAtMs: Date.now() - start, error }),
        );
        await vi.advanceTimersByTimeAsync(200_000);
        return await settled;
      } finally {
        vi.useRealTimers();
      }
    }

    /** A found v3.5 envelope carrying the given product. */
    const found = (product: unknown) => ({
      status: 'success',
      result: { id: 'product_found' },
      product,
    });

    describe('the read', () => {
      it('sends one v3.5 request for the input sets, with the identifying User-Agent', async () => {
        const sent = routeFetch({
          'v3.5': { [NESQUIK]: [{ status: 200, body: v35Capture(NESQUIK) }] },
        });

        const read = await svc.readStoredAsSold(NESQUIK, createMockContext(), LIVE_READ);

        expect(read.status).toBe('read');
        expect(read.status === 'read' && read.nutriments['energy-kcal_100g']).toBe(327);
        expect(sent.map(({ url }) => url)).toEqual([v35Url(NESQUIK)]);
        const [, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
        expect(new Headers(init?.headers).get('User-Agent')).toMatch(
          /^openfoodfacts-mcp-server\/\d+\.\d+\.\d+ /,
        );
      });

      it('reads a success_with_warnings answer as found', async () => {
        routeFetch({
          'v3.5': {
            [NESQUIK]: [
              { status: 200, body: { ...v35Capture(NESQUIK), status: 'success_with_warnings' } },
            ],
          },
        });

        const read = await svc.readStoredAsSold(NESQUIK, createMockContext(), LIVE_READ);

        expect(read.status).toBe('read');
      });

      it.each<[string, unknown]>([
        ['no nutrition object', found({})],
        ['no input_sets', found({ nutrition: {} })],
        ['an empty input_sets list', found({ nutrition: { input_sets: [] } })],
        [
          'prepared and estimate sets only',
          found({
            nutrition: {
              input_sets: v35Capture(NESQUIK).product.nutrition.input_sets.filter(
                (set) => set.preparation !== 'as_sold' || set.source === 'estimate',
              ),
            },
          }),
        ],
      ])('settles %s as none, in one request', async (_label, body) => {
        routeFetch({ 'v3.5': { [NESQUIK]: [{ status: 200, body }] } });

        const read = await svc.readStoredAsSold(NESQUIK, createMockContext(), LIVE_READ);

        expect(read).toEqual({ status: 'none' });
        expect(global.fetch).toHaveBeenCalledOnce();
      });
    });

    describe('unread, never thrown', () => {
      it('reads a 404 after a v2 hit as upstream_error at once, never as none', async () => {
        routeFetch({
          'v3.5': { [NESQUIK]: [{ status: 404, body: v35Capture('99999999999994') }] },
        });

        const { settledAtMs, value } = await clockedRun(() =>
          svc.readStoredAsSold(NESQUIK, createMockContext(), LIVE_READ),
        );

        expect(settledAtMs).toBe(0);
        expect(value?.status).toBe('unread');
        const error = value?.status === 'unread' ? value.error : undefined;
        expect(error?.data).toMatchObject({
          reason: 'upstream_error',
          status: 404,
          barcode: NESQUIK,
        });
        expect(error?.message).toBe(
          'Open Food Facts answered HTTP 404 on its API v3.5 product route for a barcode its v2 read found, so the stored nutrition sets were not read.',
        );
        expect(global.fetch).toHaveBeenCalledOnce();
      });

      it.each<[string, Answer]>([
        [
          'input_sets that is not a list',
          { status: 200, body: found({ nutrition: { input_sets: {} } }) },
        ],
        [
          'a nutrition field that is not an object',
          { status: 200, body: found({ nutrition: 'n/a' }) },
        ],
        [
          'no product object',
          { status: 200, body: { status: 'success', result: { id: 'product_found' } } },
        ],
        [
          'a failure envelope served with a 200',
          { status: 200, body: { ...v35Capture('99999999999994'), product: {} } },
        ],
        [
          'a result other than product_found',
          { status: 200, body: { ...found({}), result: { id: 'x' } } },
        ],
        [
          'a status other than success beside a found result',
          { status: 200, body: { ...v35Capture(NESQUIK), status: 'failure' } },
        ],
        [
          'an HTML page served with a 200',
          { status: 200, body: '<!doctype html><p>busy</p>', html: true },
        ],
        ['a 503', { status: 503, body: { detail: 'down' } }],
        [
          'a bot-check page served with a 503',
          { status: 503, body: '<!doctype html><p>Please verify you are a human</p>', html: true },
        ],
      ])('leaves %s unread as upstream_error after the retry ladder', async (_label, answer) => {
        routeFetch({ 'v3.5': { [NESQUIK]: [answer] } });

        const { settledAtMs, value } = await clockedRun(() =>
          svc.readStoredAsSold(NESQUIK, createMockContext(), LIVE_READ),
        );

        expect(value?.status).toBe('unread');
        expect(value?.status === 'unread' && value.error.data?.reason).toBe('upstream_error');
        // Four attempts, backing off 0.5, 1, and 2 s with jitter off.
        expect(global.fetch).toHaveBeenCalledTimes(4);
        expect(settledAtMs).toBe(3_500);
      });

      it.each<[string, Answer]>([
        ['a 403', { status: 403, body: { detail: 'forbidden' } }],
        ['a 422', { status: 422, body: { detail: 'unprocessable' } }],
        [
          'a bot-check page served with a 403',
          { status: 403, body: '<!doctype html><p>Please verify you are a human</p>', html: true },
        ],
      ])('leaves %s unread as upstream_rejected after one attempt', async (_label, answer) => {
        routeFetch({ 'v3.5': { [NESQUIK]: [answer] } });

        const { settledAtMs, value } = await clockedRun(() =>
          svc.readStoredAsSold(NESQUIK, createMockContext(), LIVE_READ),
        );

        expect(value?.status).toBe('unread');
        expect(value?.status === 'unread' && value.error.data).toMatchObject({
          reason: 'upstream_rejected',
          status: answer === 'hang' ? undefined : answer.status,
        });
        expect(global.fetch).toHaveBeenCalledOnce();
        expect(settledAtMs).toBe(0);
      });

      /** The rendered page Product Opener serves with a refused request. */
      const REFUSAL_PAGE = '<!doctype html><html><body>Forbidden</body></html>';

      it.each<{
        answer: Exclude<Answer, 'hang'>;
        reason: 'upstream_rejected' | 'upstream_error' | 'upstream_timeout';
        code: number;
        requests: number;
        settledAtMs: number;
        message: string;
      }>([
        {
          answer: { status: 401, body: { detail: 'login required' } },
          reason: 'upstream_rejected',
          code: JsonRpcErrorCode.InvalidParams,
          requests: 1,
          settledAtMs: 0,
          message: 'Open Food Facts refused the request (HTTP 401): login required',
        },
        {
          answer: { status: 403, body: { detail: 'forbidden' } },
          reason: 'upstream_rejected',
          code: JsonRpcErrorCode.InvalidParams,
          requests: 1,
          settledAtMs: 0,
          message: 'Open Food Facts refused the request (HTTP 403): forbidden',
        },
        {
          answer: { status: 403, body: REFUSAL_PAGE, html: true },
          reason: 'upstream_rejected',
          code: JsonRpcErrorCode.InvalidParams,
          requests: 1,
          settledAtMs: 0,
          message:
            'Open Food Facts refused the request (HTTP 403): it answered with a rendered error page rather than a JSON explanation of the refusal',
        },
        {
          answer: { status: 422, body: { detail: 'unknown field' } },
          reason: 'upstream_rejected',
          code: JsonRpcErrorCode.InvalidParams,
          requests: 1,
          settledAtMs: 0,
          message: 'Open Food Facts refused the request (HTTP 422): unknown field',
        },
        {
          answer: { status: 501, body: { detail: 'not implemented' } },
          reason: 'upstream_rejected',
          code: JsonRpcErrorCode.InvalidParams,
          requests: 1,
          settledAtMs: 0,
          message: 'Open Food Facts refused the request (HTTP 501): not implemented',
        },
        {
          answer: { status: 500, body: { detail: 'server error' } },
          reason: 'upstream_error',
          code: JsonRpcErrorCode.ServiceUnavailable,
          requests: 4,
          settledAtMs: 3_500,
          message:
            'Open Food Facts is unavailable (HTTP 500): server error (failed after 4 attempts)',
        },
        {
          answer: { status: 502, body: { detail: 'bad gateway' } },
          reason: 'upstream_error',
          code: JsonRpcErrorCode.ServiceUnavailable,
          requests: 4,
          settledAtMs: 3_500,
          message:
            'Open Food Facts is unavailable (HTTP 502): bad gateway (failed after 4 attempts)',
        },
        {
          answer: { status: 504, body: { detail: 'gateway timeout' } },
          reason: 'upstream_timeout',
          code: JsonRpcErrorCode.Timeout,
          requests: 4,
          settledAtMs: 3_500,
          message:
            'Open Food Facts did not respond within the request deadline (HTTP 504): gateway timeout (failed after 4 attempts)',
        },
      ])(
        'leaves an HTTP $answer.status unread as $reason after $requests request(s) (%#)',
        async ({ answer, reason, code, requests, settledAtMs, message }) => {
          const sent = routeFetch({ 'v3.5': { [NESQUIK]: [answer] } });

          const run = await clockedRun(() =>
            svc.readStoredAsSold(NESQUIK, createMockContext(), LIVE_READ),
          );

          expect(run.value?.status).toBe('unread');
          const error = run.value?.status === 'unread' ? run.value.error : undefined;
          expect(error?.code).toBe(code);
          expect(error?.message).toBe(message);
          expect(error?.data).toMatchObject({
            reason,
            retryable: reason !== 'upstream_rejected',
            status: answer.status,
            barcode: NESQUIK,
          });
          // A refusal is sent once; the rest back off 0.5, 1, and 2 s with jitter off.
          expect(sent.map(({ url }) => url)).toEqual(Array(requests).fill(v35Url(NESQUIK)));
          expect(run.settledAtMs).toBe(settledAtMs);
        },
      );

      it('leaves a v3.5 route that never answers unread as upstream_timeout at the 20 s deadline', async () => {
        routeFetch({ 'v3.5': { [NESQUIK]: ['hang'] } });

        const { settledAtMs, value } = await clockedRun(() =>
          svc.readStoredAsSold(NESQUIK, createMockContext(), LIVE_READ),
        );

        expect(settledAtMs).toBe(20_000);
        expect(value?.status).toBe('unread');
        const error = value?.status === 'unread' ? value.error : undefined;
        expect(error?.code).toBe(JsonRpcErrorCode.Timeout);
        expect(error?.data).toMatchObject({
          reason: 'upstream_timeout',
          operation: `OFF:readStoredAsSold:${NESQUIK}`,
        });
        expect(error?.message).toBe(
          'Open Food Facts did not respond within the 20 s retry deadline.',
        );
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('carries a 429 wait in whole seconds as rate_limited', async () => {
        global.fetch = vi.fn(async () => {
          const response = mockResponse({ detail: 'slow down' }, 429);
          response.headers.set('retry-after', '30');
          return response;
        }) as typeof fetch;

        const { value } = await clockedRun(() =>
          svc.readStoredAsSold(NESQUIK, createMockContext(), LIVE_READ),
        );

        expect(value?.status === 'unread' && value.error.data).toMatchObject({
          reason: 'rate_limited',
          retryAfter: 30,
        });
      });

      it('spends the product budget: a spent one refuses the read locally, sending nothing', async () => {
        const budgeted = new OpenFoodFactsService({
          baseUrl: 'https://world.openfoodfacts.org',
          rateLimitProduct: 1,
          rateLimitSearch: 100,
          rateLimitTaxonomy: 100,
        });
        const sent = routeFetch({ v2: { [NESQUIK]: [{ status: 200, body: v2Capture(NESQUIK) }] } });
        const ctx = createMockContext();

        // Both reads on one frozen clock, so the wait is the slot's whole 60 s window.
        const { settledAtMs, value: read } = await clockedRun(async () => {
          await budgeted.getProduct(NESQUIK, ctx);
          return budgeted.readStoredAsSold(NESQUIK, ctx, LIVE_READ);
        });

        expect(settledAtMs).toBe(0);
        expect(read?.status).toBe('unread');
        const error = read?.status === 'unread' ? read.error : undefined;
        expect(error?.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(error?.data).toMatchObject({
          reason: 'rate_limited',
          retryable: true,
          endpoint: 'product',
          limit: 1,
          retryAfter: 60,
        });
        expect(error?.message).toBe(
          'openfoodfacts-mcp-server declined this product request: its own client-side budget of 1 product requests/min is spent, so nothing was sent to Open Food Facts. A slot frees in about 60s.',
        );
        expect(sent.map(({ api }) => api)).toEqual(['v2']);
      });
    });

    describe('cancellation', () => {
      it('rethrows a caller abort raised while the v3.5 request is in flight', async () => {
        const controller = new AbortController();
        routeFetch({ 'v3.5': { [NESQUIK]: ['hang'] } }, () => controller.abort());

        const error = await captureError(
          svc.readStoredAsSold(
            NESQUIK,
            createMockContext({ signal: controller.signal }),
            LIVE_READ,
          ),
        );

        expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(global.fetch).toHaveBeenCalledOnce();
      });
    });

    describe('through off_get_product', () => {
      beforeEach(() => {
        initOpenFoodFactsService();
      });

      it('keeps the prepared figures and the product when the v3.5 route answers 403 or 404', async () => {
        for (const [status, reason] of [
          [403, 'upstream_rejected'],
          [404, 'upstream_error'],
        ] as const) {
          routeFetch({
            v2: { [NESQUIK]: [{ status: 200, body: v2Capture(NESQUIK) }] },
            'v3.5': {
              [NESQUIK]: [
                { status, body: '<!doctype html><p>Please verify you are a human</p>', html: true },
              ],
            },
          });

          const result = await runToolContract(offGetProductTool, { barcode: NESQUIK });

          expect(result.isError, `HTTP ${status}`).toBeFalsy();
          const { nutriments } = (
            result.structuredContent as {
              product: {
                nutriments: Record<string, unknown> & {
                  additional_100g: Record<string, { value: number }>;
                };
              };
            }
          ).product;
          expect(nutriments.stored_as_sold).toMatchObject({ status: 'unread', reason });
          expect(nutriments).not.toHaveProperty('energy_kcal_100g');
          expect(nutriments.additional_100g.energy_kcal_prepared?.value).toBe(68);
          expect(JSON.stringify(result)).not.toContain('not_found');
        }
      });

      it('serves the stored as-sold set of 7613035530799 beside its prepared figures', async () => {
        const sent = routeFetch({
          v2: { [NESQUIK]: [{ status: 200, body: v2Capture(NESQUIK) }] },
          'v3.5': { [NESQUIK]: [{ status: 200, body: v35Capture(NESQUIK) }] },
        });

        const result = await runToolContract(offGetProductTool, { barcode: NESQUIK });

        expect(result.isError).toBeFalsy();
        const { nutriments } = (
          result.structuredContent as {
            product: {
              nutriments: Record<string, unknown> & {
                additional_100g: Record<string, { value: number }>;
                additional_serving: Record<string, unknown>;
              };
            };
          }
        ).product;
        expect(nutriments).toMatchObject({
          energy_kcal_100g: 327,
          fat_100g: 5.4,
          saturated_fat_100g: 2.2,
          stored_as_sold: { status: 'read' },
        });
        expect(nutriments).not.toHaveProperty('sugars_100g');
        for (const key of ['energy_kcal_serving', 'fat_serving', 'sugars_serving']) {
          expect(nutriments).not.toHaveProperty(key);
        }
        const servingKeys = Object.keys(nutriments.additional_serving);
        expect(servingKeys.length).toBeGreaterThan(0);
        expect(servingKeys.every((key) => key.endsWith('_prepared'))).toBe(true);
        expect(nutriments.additional_100g.energy_kcal_prepared?.value).toBe(68);
        expect(nutriments.additional_100g.alcohol?.value).toBe(0);

        const text = JSON.stringify(result.content);
        expect(text).toContain('**Energy:** 327 kcal');
        expect(text).toContain('**Fat:** 5.4g');
        expect(text).toContain('  - Saturated fat: 2.2g');
        expect(text).toContain(
          '**As-sold nutrition (stored set: read):** The product read returned only prepared figures, so the as-sold figures above come from the as-sold set the record stores.',
        );
        expect(sent.map(({ api, code }) => `${api} ${code}`)).toEqual([
          `v2 ${NESQUIK}`,
          `v3.5 ${NESQUIK}`,
        ]);
        expect(sent[1]?.url).toBe(v35Url(NESQUIK));
      });

      it.each([
        ['an as-sold read', { barcode: '3017620422003' }, v2Capture('3017620422003')],
        [
          'a subset without nutriments',
          { barcode: NESQUIK, fields: ['product_name' as const] },
          // Open Food Facts answers a fields subset with exactly those fields.
          { status: 1, product: { product_name: v2Capture(NESQUIK).product.product_name } },
        ],
      ])('sends no v3.5 request for %s', async (_label, input, body) => {
        const sent = routeFetch({ v2: { [input.barcode]: [{ status: 200, body }] } });

        const result = await runToolContract(offGetProductTool, input);

        expect(result.isError).toBeFalsy();
        expect(sent.map(({ api }) => api)).toEqual(['v2']);
        expect(JSON.stringify(result.structuredContent)).not.toContain('stored_as_sold');
      });

      it('settles inside 55 s when a slow v2 read is followed by a v3.5 route that never answers', async () => {
        // The v2 read answers at 34.999 s: 15 s stall, 0.5 s backoff, 15 s stall, 1 s backoff, 3.499 s.
        const sent = routeFetch({
          v2: {
            [NESQUIK]: ['hang', 'hang', { status: 200, body: v2Capture(NESQUIK), afterMs: 3_499 }],
          },
          'v3.5': { [NESQUIK]: ['hang'] },
        });

        const { settledAtMs, value } = await clockedRun(() =>
          runToolContract(offGetProductTool, { barcode: NESQUIK }),
        );

        expect(settledAtMs).toBe(54_999);
        expect(value?.isError).toBeFalsy();
        const output = value?.structuredContent as
          | { product: { nutriments: { stored_as_sold: object } } }
          | undefined;
        expect(output?.product.nutriments.stored_as_sold).toMatchObject({
          status: 'unread',
          reason: 'upstream_timeout',
        });
        expect(sent.filter(({ api }) => api === 'v3.5').map(({ atMs }) => atMs)).toEqual([
          34_999, 50_499,
        ]);
      });

      it('ends as RequestCancelled when the caller aborts during the v3.5 request', async () => {
        const controller = new AbortController();
        routeFetch(
          {
            v2: { [NESQUIK]: [{ status: 200, body: v2Capture(NESQUIK) }] },
            'v3.5': { [NESQUIK]: ['hang'] },
          },
          ({ api }) => {
            if (api === 'v3.5') controller.abort();
          },
        );

        const result = await runToolContract(
          offGetProductTool,
          { barcode: NESQUIK },
          { context: { signal: controller.signal, errors: offGetProductTool.errors } },
        );

        expect(result.isError).toBe(true);
        const { error } = result.structuredContent as { error: McpErrorish };
        expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
        // The v3.5 request's own abort. A handler that settled the abort as unread and returned
        // would end on the bare signal's "This operation was aborted" instead.
        const aborted = 'fetch GET https://world.openfoodfacts.org/…?… was aborted.';
        expect(error.message).toBe(aborted);
        expect(JSON.stringify(result.content)).toContain(aborted);
        expect(JSON.stringify(result)).not.toContain('stored_as_sold');
        expect(JSON.stringify(result)).not.toContain('unread');
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ── #79: barcode reads and tag-only searches from the local export mirror ──

  describe('local export mirror (#79)', () => {
    type Line = Record<string, unknown>;
    type StoredSet = {
      preparation?: string;
      source?: string;
      nutrients: Record<string, { value?: number }>;
    };
    /** A `tests/fixtures/mirror/` capture: the export line and the live reads of the same record. */
    type MirrorFixture = {
      code: string;
      line: Line;
      live: { product: Record<string, unknown> };
      liveInputSets?: { body: { product: { nutrition: { input_sets: StoredSet[] } } } };
    };
    type ToolRun = {
      isError?: boolean | undefined;
      structuredContent?: unknown;
      content?: unknown;
    };

    const FIXTURE_DIR = new URL('../../fixtures/mirror/', import.meta.url);
    const FIXTURE_FILES = readdirSync(FIXTURE_DIR);

    function mirrorFixture(code: string): MirrorFixture {
      const file = FIXTURE_FILES.find((name) => name.endsWith(`-${code}.json`));
      if (!file) throw new Error(`No mirror fixture for ${code}`);
      return JSON.parse(readFileSync(new URL(file, FIXTURE_DIR), 'utf8')) as MirrorFixture;
    }

    /** Prepared figures only; the record stores its as-sold set (327 kcal per 100 g). */
    const NESQUIK = '7613035530799';
    /** As-sold figures; Product Opener stores it as 0030000010402, read as 030000010402 too. */
    const OATS = '0030000010402';
    /** As-sold and prepared figures. */
    const BOTH = '0016000289994';

    /** The as-of time the store's checkpoint encodes, as a mirror read cites it. */
    const AS_OF = '2026-11-01T06:25:32.000Z';

    /** Every field a product read asks Open Food Facts for. */
    const PRODUCT_FIELD_LIST = [
      'product_name',
      'brands',
      'quantity',
      'ingredients_text',
      'ingredients',
      'allergens_tags',
      'traces_tags',
      'additives_tags',
      'ingredients_analysis_tags',
      'nutriscore_grade',
      'nova_group',
      'ecoscore_grade',
      'nutriments',
      'serving_size',
      'serving_quantity',
      'serving_quantity_unit',
      'categories_tags',
      'labels_tags',
      'packaging_tags',
      'origins_tags',
      'countries_tags',
      'image_url',
      'completeness',
      'data_quality_tags',
    ];

    const FAILED_READ = 'Mirror read failed — reading Open Food Facts live instead';

    let dir: string;
    const storePath = () => join(dir, 'store.sqlite');

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'off-mirror-routing-'));
      initOpenFoodFactsService();
    });

    afterEach(async () => {
      await closeMirrorStore();
      mirrorConfig.mirrorPath = undefined;
      await rm(dir, { recursive: true, force: true });
    });

    /**
     * Builds a completed store from export lines as a sync page writes them (builder, tag ids, one
     * batch upsert), runs `sql` on it, and points `OFF_MIRROR_PATH` at it. The checkpoint encodes
     * `AS_OF` unless `checkpoint` is false. `firstLoadRunning` writes the state the sync runner
     * holds while a store's first full load is still ingesting instead: in progress, with no
     * completion time and no checkpoint, over rows already stored.
     */
    async function writeMirror(
      lines: Line[],
      options: { checkpoint?: boolean; sql?: string[]; firstLoadRunning?: boolean } = {},
    ): Promise<void> {
      const writer = openMirrorStore(storePath());
      try {
        const handle = await writer.raw();
        const records = lines.map((line) => {
          const record = buildMirrorRecord(line);
          if (!record) throw new Error(`Line ${String(line.code)} is not servable`);
          return record;
        });
        if (records.length > 0) {
          const ids = new TagIds().resolve(handle, new Set(records.flatMap((r) => r.tags)));
          await writer.applyBatch(
            records.map((record) => ({
              code: record.code,
              popularity_key: record.popularityKey,
              unique_scans_n: record.uniqueScansN,
              created_t: record.createdT,
              last_modified_t: record.lastModifiedT,
              generation: 1,
              record_version: 1,
              tag_ids: JSON.stringify(
                [...new Set(record.tags.map((key) => ids.get(key) as number))].sort(
                  (a, b) => a - b,
                ),
              ),
              doc: JSON.stringify(record.doc),
            })),
            [],
          );
        }
        for (const statement of options.sql ?? []) handle.exec(statement);
        await writer.writeState(
          options.firstLoadRunning
            ? { status: 'in_progress', startedAt: '2026-11-01T06:30:00.000Z' }
            : {
                status: 'complete',
                completedAt: '2026-11-01T07:00:00.000Z',
                total: records.length,
                ...(options.checkpoint !== false && {
                  checkpoint: encodeCheckpoint({ generation: 1, asOfSeconds: 1_793_514_332 }),
                }),
              },
        );
      } finally {
        await writer.close();
      }
      mirrorConfig.mirrorPath = storePath();
    }

    /** Points `OFF_MIRROR_PATH` at a file that is not a SQLite database. */
    async function writeGarbageStore(): Promise<void> {
      await writeFile(storePath(), 'not a database '.repeat(512));
      mirrorConfig.mirrorPath = storePath();
    }

    /**
     * Answers as Open Food Facts answered each fixture's captures: the v2 product read cut to the
     * `fields` it names, and the v3.5 input-sets read; a barcode matches as Product Opener stores
     * it. Anything else is an HTTP 400, which no retry absorbs. Returns the paths requested.
     */
    function stubLive(fixtures: readonly MirrorFixture[]): string[] {
      const requests: string[] = [];
      global.fetch = vi.fn(async (input: unknown) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        const [, api, code] =
          /^\/api\/(v2|v3\.5)\/product\/(\d+)(?:\.json)?$/.exec(url.pathname) ?? [];
        const fixture = fixtures.find(
          (f) => code !== undefined && normalizeCodeZeroes(f.code) === normalizeCodeZeroes(code),
        );
        if (fixture && api === 'v2') {
          const fields = new Set(url.searchParams.get('fields')?.split(','));
          const product = Object.fromEntries(
            Object.entries(fixture.live.product).filter(([field]) => fields.has(field)),
          );
          return mockResponse({ ...fixture.live, product });
        }
        if (fixture?.liveInputSets && api === 'v3.5') {
          return mockResponse(fixture.liveInputSets.body);
        }
        return mockResponse({ status: 0 }, 400);
      }) as typeof fetch;
      return requests;
    }

    /** A fetch that fails the test if anything is requested. */
    function forbidFetch(): void {
      global.fetch = vi.fn(async () => {
        throw new Error('Unexpected request');
      }) as typeof fetch;
    }

    /** The warnings `ctx` logged. */
    function warnings(ctx: ReturnType<typeof createMockContext>) {
      return (ctx.log as MockContextLogger).calls.filter((call) => call.level === 'warning');
    }

    /**
     * `run` with no mirror configured, then from a store built from `mirrored`, both against the
     * captures of `fixtures`.
     */
    async function liveThenMirror(
      fixtures: readonly MirrorFixture[],
      mirrored: readonly MirrorFixture[],
      run: () => Promise<ToolRun>,
    ) {
      const liveRequests = stubLive(fixtures);
      const live = await run();
      await writeMirror(mirrored.map((f) => f.line));
      const mirrorRequests = stubLive(fixtures);
      const mirror = await run();
      return { live, liveRequests, mirror, mirrorRequests };
    }

    /**
     * Where a run says its answer was read: the top-level `source`, `mirror_as_of`, and
     * `mirror_snapshot` fields present, each compare row's `source` and `mirror_as_of` in row
     * order, and the text that says it — the `**Source:**` line of the format() block, then every
     * block after it (the enrichment trailer) verbatim.
     */
    type Provenance = {
      structured: Record<string, unknown>;
      rows?: Record<string, unknown>[];
      text: string[];
    };

    const PROVENANCE_FIELDS = new Set(['source', 'mirror_as_of', 'mirror_snapshot']);

    /** `run` cut into its provenance and everything else, on both surfaces. */
    function splitProvenance(run: ToolRun) {
      const { products, ...top } = run.structuredContent as {
        products?: Record<string, unknown>[];
        [field: string]: unknown;
      };
      const pick = (fields: Record<string, unknown>, keep: boolean) =>
        Object.fromEntries(
          Object.entries(fields).filter(([field]) => PROVENANCE_FIELDS.has(field) === keep),
        );
      const [formatted = '', ...trailer] = (run.content as { type: string; text?: string }[]).map(
        (block) => (block.type === 'text' ? (block.text ?? '') : block.type),
      );
      const lines = formatted.split('\n');
      const isSourceLine = (line: string) => line.startsWith('**Source:**');
      const provenance: Provenance = {
        structured: pick(top, true),
        ...(products && { rows: products.map((row) => pick(row, true)) }),
        text: [...lines.filter(isSourceLine), ...trailer],
      };
      return {
        provenance,
        rest: {
          structured: {
            ...pick(top, false),
            ...(products && { products: products.map((row) => pick(row, false)) }),
          },
          text: lines.filter((line) => !isSourceLine(line)),
        },
      };
    }

    /**
     * The mirror run answers exactly as the live run does, on both surfaces, apart from where each
     * says it was read: `expected.live` and `expected.mirror` name that.
     */
    function expectSameAnswer(
      live: ToolRun,
      mirror: ToolRun,
      expected: { live: Provenance; mirror: Provenance },
    ): void {
      expect(live.isError).toBeFalsy();
      const liveRun = splitProvenance(live);
      const mirrorRun = splitProvenance(mirror);
      expect(liveRun.provenance).toEqual(expected.live);
      expect(mirrorRun.provenance).toEqual(expected.mirror);
      expect(mirrorRun.rest).toEqual(liveRun.rest);
    }

    const LIVE_SOURCE = '**Source:** off_api (Open Food Facts)';
    const MIRROR_LABEL = `off_mirror (this server's local copy of the Open Food Facts export, as of ${AS_OF})`;
    const PRODUCT_NOTE = `This product comes from this server's local copy of the Open Food Facts export, current as of ${AS_OF}, not the live database, so an edit made to it since then is not reflected.`;
    const ROWS_NOTE = `The rows whose source is off_mirror come from this server's local copy of the Open Food Facts export, current as of ${AS_OF}, not the live database, so an edit made to them since then is not reflected.`;

    /** Where an off_get_product answer read live, and then from the mirror, says it was read. */
    const PRODUCT_PROVENANCE = {
      live: { structured: { source: 'off_api' }, text: [LIVE_SOURCE] },
      mirror: {
        structured: { source: 'off_mirror', mirror_as_of: AS_OF, mirror_snapshot: PRODUCT_NOTE },
        text: [`**Source:** ${MIRROR_LABEL}`, `\n\n**Mirror freshness:** ${PRODUCT_NOTE}`],
      },
    };

    describe('product reads', () => {
      it('opens no store and reads live when OFF_MIRROR_PATH is unset', async () => {
        const requests = stubLive([mirrorFixture(OATS)]);
        const ctx = createMockContext();

        await expect(svc.mirrorReady(ctx)).resolves.toBe(false);
        const read = await svc.getProduct(OATS, ctx);

        expect(read?.source).toBe('off_api');
        expect(getMirrorStore()).toBeUndefined();
        expect(requests).toEqual([`/api/v2/product/${OATS}.json`]);
      });

      it('serves a mirrored barcode with no request and no budget slot, its provenance beside the product', async () => {
        await writeMirror([mirrorFixture(NESQUIK).line]);
        const budgeted = new OpenFoodFactsService({
          baseUrl: 'https://world.openfoodfacts.org',
          rateLimitProduct: 1,
          rateLimitSearch: 100,
          rateLimitTaxonomy: 100,
        });
        forbidFetch();
        const ctx = createMockContext();

        await expect(budgeted.mirrorReady(ctx)).resolves.toBe(true);
        const read = await budgeted.getProduct(NESQUIK, ctx);
        const subset = await budgeted.getProductFields(NESQUIK, 'brands,product_name', ctx);
        if (read?.source !== 'off_mirror') throw new Error('Expected a mirror read');
        const asSold = await budgeted.readStoredAsSold(NESQUIK, ctx, read);

        expect(read.mirrorAsOf).toBe(AS_OF);
        // The doc stores `code` and `_input_sets`; neither, nor any provenance, is a product field.
        expect(Object.keys(read.product).filter((f) => !PRODUCT_FIELD_LIST.includes(f))).toEqual(
          [],
        );
        expect(read.product.product_name).toBe('NESQUIK Moins de Sucres');
        expect(read.storedSets).toHaveLength(3);
        expect(subset).toMatchObject({ source: 'off_mirror', mirrorAsOf: AS_OF });
        expect(Object.keys(subset?.product ?? {}).sort()).toEqual(['brands', 'product_name']);
        expect(asSold.status === 'read' && asSold.nutriments).toMatchObject({
          'energy-kcal_100g': 327,
          fat_100g: 5.4,
          'saturated-fat_100g': 2.2,
        });
        expect(global.fetch).not.toHaveBeenCalled();
        expect(warnings(ctx)).toEqual([]);

        // The one slot is still free: a barcode the mirror lacks is read live.
        const requests = stubLive([mirrorFixture(BOTH)]);
        await expect(budgeted.getProduct(BOTH, ctx)).resolves.toMatchObject({ source: 'off_api' });
        expect(requests).toEqual([`/api/v2/product/${BOTH}.json`]);
      });

      it.each([
        [
          'an as-sold record, asked for without a leading zero',
          OATS,
          '030000010402',
          ['/api/v2/product/030000010402.json'],
        ],
        [
          'an as-sold record per 100 ml',
          '0008017310112',
          '0008017310112',
          ['/api/v2/product/0008017310112.json'],
        ],
        [
          'a record storing as-sold and prepared sets, whose read serves the prepared',
          BOTH,
          BOTH,
          [`/api/v2/product/${BOTH}.json`, `/api/v3.5/product/${BOTH}`],
        ],
        [
          'a prepared-only record, with its stored as-sold set',
          NESQUIK,
          NESQUIK,
          [`/api/v2/product/${NESQUIK}.json`, `/api/v3.5/product/${NESQUIK}`],
        ],
      ])(
        'off_get_product answers %s from the mirror as it does live, sending nothing',
        async (_label, code, barcode, livePaths) => {
          const fixture = mirrorFixture(code);

          const runs = await liveThenMirror([fixture], [fixture], () =>
            runToolContract(offGetProductTool, { barcode }),
          );

          expect(runs.liveRequests).toEqual(livePaths);
          expect(runs.mirrorRequests).toEqual([]);
          expect(runs.mirror.structuredContent).toMatchObject({
            barcode,
            product: { product_name: fixture.live.product.product_name },
          });
          expectSameAnswer(runs.live, runs.mirror, PRODUCT_PROVENANCE);
        },
      );

      it('off_get_product serves the stored as-sold set of a mirrored prepared-only record', async () => {
        await writeMirror([mirrorFixture(NESQUIK).line]);
        forbidFetch();

        const result = await runToolContract(offGetProductTool, { barcode: NESQUIK });

        expect(result.structuredContent).toMatchObject({
          product: {
            nutriments: {
              energy_kcal_100g: 327,
              fat_100g: 5.4,
              stored_as_sold: { status: 'read' },
            },
          },
          source: 'off_mirror',
          mirror_as_of: AS_OF,
          mirror_snapshot: PRODUCT_NOTE,
        });
        const text = JSON.stringify(result.content);
        expect(text).toContain('**As-sold nutrition (stored set: read):**');
        expect(text).toContain(`**Source:** ${MIRROR_LABEL}`);
        expect(text).toContain(`**Mirror freshness:** ${PRODUCT_NOTE}`);
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it('off_compare_products answers mirrored rows as it does live, reading only the barcode the mirror lacks', async () => {
        const fixtures = [OATS, NESQUIK, BOTH].map(mirrorFixture);

        const runs = await liveThenMirror(fixtures, fixtures.slice(0, 2), () =>
          runToolContract(offCompareProductsTool, { barcodes: ['030000010402', NESQUIK, BOTH] }),
        );

        expect([...runs.liveRequests].sort()).toEqual(
          [
            '/api/v2/product/030000010402.json',
            `/api/v2/product/${NESQUIK}.json`,
            `/api/v2/product/${BOTH}.json`,
            `/api/v3.5/product/${NESQUIK}`,
            `/api/v3.5/product/${BOTH}`,
          ].sort(),
        );
        expect(runs.mirrorRequests).toEqual([
          `/api/v2/product/${BOTH}.json`,
          `/api/v3.5/product/${BOTH}`,
        ]);
        // Each row names its own read: the two the mirror holds, and the one it lacks read live.
        const live = { source: 'off_api' };
        const mirrored = { source: 'off_mirror', mirror_as_of: AS_OF };
        expectSameAnswer(runs.live, runs.mirror, {
          live: { structured: {}, rows: [live, live, live], text: [LIVE_SOURCE] },
          mirror: {
            structured: { mirror_snapshot: ROWS_NOTE },
            rows: [mirrored, mirrored, live],
            text: [
              `**Source:** ${MIRROR_LABEL} for 030000010402, ${NESQUIK}; off_api (Open Food Facts) for ${BOTH}`,
              `\n\n**Mirror freshness:** ${ROWS_NOTE}`,
            ],
          },
        });
      });

      it('reads a barcode the mirror lacks live, without a warning', async () => {
        await writeMirror([mirrorFixture(OATS).line]);
        const requests = stubLive([mirrorFixture(BOTH)]);
        const ctx = createMockContext();

        await expect(svc.getProduct(BOTH, ctx)).resolves.toMatchObject({ source: 'off_api' });
        expect(requests).toEqual([`/api/v2/product/${BOTH}.json`]);
        expect(warnings(ctx)).toEqual([]);
      });

      it('reads a field subset the mirror does not hold live, even for a mirrored barcode', async () => {
        await writeMirror([mirrorFixture(OATS).line]);
        const requests = stubLive([mirrorFixture(OATS)]);

        const read = await svc.getProductFields(
          OATS,
          'product_name,last_modified_t',
          createMockContext(),
        );

        expect(read).toEqual({
          source: 'off_api',
          product: {
            product_name: 'Old Fashioned Oats',
            last_modified_t: mirrorFixture(OATS).live.product.last_modified_t,
          },
        });
        expect(requests).toEqual([`/api/v2/product/${OATS}.json`]);
      });

      it.each<[string, () => Promise<void>, Record<string, unknown>]>([
        ['a file that is not a SQLite database', writeGarbageStore, {}],
        [
          'a store whose products table lost its doc column',
          () =>
            writeMirror([mirrorFixture(OATS).line], {
              sql: ['ALTER TABLE products RENAME COLUMN doc TO doc_gone'],
            }),
          {},
        ],
        [
          'a ready store that records no as-of time',
          () => writeMirror([mirrorFixture(OATS).line], { checkpoint: false }),
          { message: 'The mirror is ready but records no as-of time.' },
        ],
      ])('reads live past %s, logging the store error', async (_label, build, logged) => {
        await build();
        const requests = stubLive([mirrorFixture(OATS)]);
        const ctx = createMockContext();

        await expect(svc.getProduct(OATS, ctx)).resolves.toMatchObject({ source: 'off_api' });

        expect(requests).toEqual([`/api/v2/product/${OATS}.json`]);
        expect(warnings(ctx)).toEqual([
          {
            level: 'warning',
            msg: FAILED_READ,
            data: expect.objectContaining({ operation: 'product read', ...logged }),
          },
        ]);
      });

      it('logs a stored document that is not JSON by its error name alone, never its text', async () => {
        await writeMirror([mirrorFixture(OATS).line], {
          sql: [`UPDATE products SET doc = '{"product_name": Leaked-label-text}'`],
        });
        const requests = stubLive([mirrorFixture(OATS)]);
        const ctx = createMockContext();

        await expect(svc.getProduct(OATS, ctx)).resolves.toMatchObject({ source: 'off_api' });

        expect(requests).toEqual([`/api/v2/product/${OATS}.json`]);
        // Node's JSON.parse message quotes the text it failed on ("Leaked-lab"…).
        expect(warnings(ctx)).toEqual([
          {
            level: 'warning',
            msg: FAILED_READ,
            data: { operation: 'product read', error: 'SyntaxError' },
          },
        ]);
      });

      it('reads live from a completed load of zero products, which is not ready', async () => {
        await writeMirror([]);
        const requests = stubLive([mirrorFixture(OATS)]);
        const ctx = createMockContext();

        await expect(svc.mirrorReady(ctx)).resolves.toBe(false);
        await expect(svc.getProduct(OATS, ctx)).resolves.toMatchObject({ source: 'off_api' });
        expect(requests).toEqual([`/api/v2/product/${OATS}.json`]);
        expect(warnings(ctx)).toEqual([]);
      });

      it('reads live while the first full load is still running, over rows it has stored', async () => {
        await writeMirror([mirrorFixture(OATS).line], { firstLoadRunning: true });
        const requests = stubLive([mirrorFixture(OATS)]);
        const ctx = createMockContext();

        // The barcode is stored: only the unfinished load keeps it from being served.
        await expect(getMirrorStore()?.count()).resolves.toBe(1);
        await expect(svc.mirrorReady(ctx)).resolves.toBe(false);
        await expect(svc.getProduct(OATS, ctx)).resolves.toMatchObject({ source: 'off_api' });
        expect(requests).toEqual([`/api/v2/product/${OATS}.json`]);
        expect(warnings(ctx)).toEqual([]);
      });

      it('answers mirrorReady false on a store error, logging it', async () => {
        await writeGarbageStore();
        const ctx = createMockContext();

        await expect(svc.mirrorReady(ctx)).resolves.toBe(false);
        expect(warnings(ctx)).toEqual([
          {
            level: 'warning',
            msg: FAILED_READ,
            data: expect.objectContaining({ operation: 'readiness check' }),
          },
        ]);
      });

      it('reads live past a sync write lock its store open meets, logging it, and opens the store on the next read', async () => {
        await writeMirror([mirrorFixture(OATS).line]);
        // A sync process mid-transaction, as a page upsert or a sort index build holds it.
        const sync = openMirrorStore(storePath());
        const syncHandle = await sync.raw();
        syncHandle.exec('BEGIN IMMEDIATE');
        const requests = stubLive([mirrorFixture(OATS)]);
        const ctx = createMockContext();

        try {
          await expect(svc.getProduct(OATS, ctx)).resolves.toMatchObject({ source: 'off_api' });
        } finally {
          syncHandle.exec('ROLLBACK');
          await sync.close();
        }

        expect(requests).toEqual([`/api/v2/product/${OATS}.json`]);
        expect(warnings(ctx)).toEqual([
          {
            level: 'warning',
            msg: FAILED_READ,
            data: {
              operation: 'product read',
              error: 'McpError',
              code: JsonRpcErrorCode.DatabaseError,
              message: 'Failed to initialize mirror store "store.sqlite".',
            },
          },
        ]);
        forbidFetch();
        await expect(svc.getProduct(OATS, createMockContext())).resolves.toMatchObject({
          source: 'off_mirror',
          mirrorAsOf: AS_OF,
        });
      });

      it('reads live, creating no store or directory, once the store disappears after its open gave up on a sync write lock', async () => {
        await writeMirror([mirrorFixture(OATS).line]);
        const sync = openMirrorStore(storePath());
        const syncHandle = await sync.raw();
        syncHandle.exec('BEGIN IMMEDIATE');
        const requests = stubLive([mirrorFixture(OATS)]);
        try {
          await expect(svc.getProduct(OATS, createMockContext())).resolves.toMatchObject({
            source: 'off_api',
          });
        } finally {
          syncHandle.exec('ROLLBACK');
          await sync.close();
        }
        // The store's directory goes away before any open succeeded, as an unmount leaves it.
        await rm(dir, { recursive: true, force: true });
        const ctx = createMockContext();

        await expect(svc.getProduct(OATS, ctx)).resolves.toMatchObject({ source: 'off_api' });

        expect(existsSync(dir)).toBe(false);
        expect(requests).toEqual([`/api/v2/product/${OATS}.json`, `/api/v2/product/${OATS}.json`]);
        expect(warnings(ctx)).toEqual([]);
      });

      it('reads live, creating no store or directory, while OFF_MIRROR_PATH names no file, and serves the store once one is built there', async () => {
        const unmounted = join(dir, 'unmounted');
        mirrorConfig.mirrorPath = join(unmounted, 'store.sqlite');
        const requests = stubLive([mirrorFixture(OATS)]);
        const ctx = createMockContext();

        await expect(svc.mirrorReady(ctx)).resolves.toBe(false);
        await expect(svc.getProduct(OATS, ctx)).resolves.toMatchObject({ source: 'off_api' });
        expect(existsSync(unmounted)).toBe(false);

        mirrorConfig.mirrorPath = storePath();
        await expect(svc.getProduct(OATS, ctx)).resolves.toMatchObject({ source: 'off_api' });
        expect(existsSync(storePath())).toBe(false);
        expect(requests).toEqual([`/api/v2/product/${OATS}.json`, `/api/v2/product/${OATS}.json`]);
        expect(warnings(ctx)).toEqual([]);

        await writeMirror([mirrorFixture(OATS).line]);
        forbidFetch();
        await expect(svc.getProduct(OATS, ctx)).resolves.toMatchObject({
          source: 'off_mirror',
          mirrorAsOf: AS_OF,
        });
      });
    });

    describe('stored as-sold sets', () => {
      it('settles a mirrored prepared-only record that stores no sets as none, with no request', async () => {
        await writeMirror([mirrorFixture(NESQUIK).line], {
          sql: [`UPDATE products SET doc = json_remove(doc, '$._input_sets')`],
        });
        forbidFetch();
        const ctx = createMockContext();

        const read = await svc.getProduct(NESQUIK, ctx);
        if (read?.source !== 'off_mirror') throw new Error('Expected a mirror read');

        expect(read.storedSets).toBeUndefined();
        await expect(svc.readStoredAsSold(NESQUIK, ctx, read)).resolves.toEqual({ status: 'none' });
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it('reads a live read of a mirrored barcode from API v3.5, never from the stored sets', async () => {
        const fixture = mirrorFixture(NESQUIK);
        await writeMirror([fixture.line]);
        // The live record has moved on: its as-sold set now says 999 kcal, the mirror's 327.
        const moved = structuredClone(fixture);
        for (const set of moved.liveInputSets?.body.product.nutrition.input_sets ?? []) {
          const kcal = set.nutrients['energy-kcal'];
          if (set.preparation === 'as_sold' && set.source !== 'estimate' && kcal) kcal.value = 999;
        }
        const requests = stubLive([moved]);
        const ctx = createMockContext();

        // A field the mirror does not hold sends the read of this mirrored barcode live.
        const read = await svc.getProductFields(NESQUIK, 'nutriments,last_modified_t', ctx);
        if (read?.source !== 'off_api') throw new Error('Expected a live read');
        const asSold = await svc.readStoredAsSold(NESQUIK, ctx, read);

        expect(asSold.status === 'read' && asSold.nutriments['energy-kcal_100g']).toBe(999);
        expect(requests).toEqual([
          `/api/v2/product/${NESQUIK}.json`,
          `/api/v3.5/product/${NESQUIK}`,
        ]);
      });

      it('reads a record whose stored sets are not a list live, product and as-sold set alike', async () => {
        await writeMirror([mirrorFixture(NESQUIK).line], {
          sql: [`UPDATE products SET doc = json_set(doc, '$._input_sets', json('{}'))`],
        });
        const requests = stubLive([mirrorFixture(NESQUIK)]);
        const ctx = createMockContext();

        const read = await svc.getProduct(NESQUIK, ctx);
        if (read?.source !== 'off_api') throw new Error('Expected a live read');
        const asSold = await svc.readStoredAsSold(NESQUIK, ctx, read);

        expect(asSold.status === 'read' && asSold.nutriments['energy-kcal_100g']).toBe(327);
        expect(requests).toEqual([
          `/api/v2/product/${NESQUIK}.json`,
          `/api/v3.5/product/${NESQUIK}`,
        ]);
        expect(warnings(ctx)).toEqual([
          {
            level: 'warning',
            msg: FAILED_READ,
            data: expect.objectContaining({
              operation: 'product read',
              message: 'The stored nutrition sets of this record are not a list.',
            }),
          },
        ]);
      });
    });

    describe('tag-only searches', () => {
      const NOVA_4 = 'en:4-ultra-processed-food-and-drink-products';

      /** A synthetic schema 1004 export line; a popularity left out is one the record lacks. */
      function taggedLine(
        code: string,
        popularity: number | null,
        tags: Record<string, string[]>,
      ): Line {
        return {
          code,
          schema_version: 1004,
          lc: 'en',
          product_name: `Product ${code}`,
          quantity: '100 g',
          ...(popularity !== null && { popularity_key: popularity }),
          ...Object.fromEntries(
            Object.entries(tags).map(([facet, values]) => [`${facet}_tags`, values]),
          ),
        };
      }

      const organic = (
        code: string,
        popularity: number | null,
        tags: Record<string, string[]> = {},
      ) =>
        taggedLine(code, popularity, { ...tags, labels: ['en:organic', ...(tags.labels ?? [])] });

      /** Twelve organic products and one other; nulls and a tie exercise the default order. */
      const CORPUS: Line[] = [
        organic('20000001', 50, { nova_groups: [NOVA_4] }),
        organic('20000002', 90, { allergens: ['en:milk'] }),
        organic('20000003', null, { labels: ['en:fair-trade'] }),
        organic('20000004', 70, { labels: ['en:fair-trade'] }),
        organic('20000005', 70),
        organic('20000006', 10),
        organic('20000007', 80, { allergens: ['en:milk', 'en:nuts'] }),
        organic('20000008', null),
        organic('20000009', 60, { labels: ['en:fair-trade'] }),
        organic('20000010', 40, { nova_groups: [NOVA_4] }),
        organic('20000011', 30, { brands: ['xx:nutella'] }),
        organic('20000012', 20, { brands: ['xx:nutella'] }),
        taggedLine('30000001', 100, { brands: ['xx:nutella'], labels: ['en:vegan'] }),
      ];

      /** The organic products by popularity, highest first, missing last, then by barcode. */
      const ORGANIC_ORDER = [
        '20000002',
        '20000007',
        '20000004',
        '20000005',
        '20000009',
        '20000001',
        '20000010',
        '20000011',
        '20000012',
        '20000006',
        '20000003',
        '20000008',
      ];

      const codes = (outcome: SearchOutcome) => served(outcome).products.map((row) => row.code);

      beforeEach(async () => {
        await writeMirror(CORPUS);
        forbidFetch();
      });

      it('serves page 11 with the exact total and the stored rows cut to the summary fields', async () => {
        const outcome = await svc.searchProducts(
          { labels_tag: 'en:organic', page: 11, page_size: 1, tags_confirmed: true },
          createMockContext(),
        );

        expect(outcome).toEqual({
          status: 'served',
          count: 12,
          count_is_exact: true,
          page: 11,
          page_count: 1,
          page_size: 1,
          products: [{ code: '20000003', product_name: 'Product 20000003' }],
          dropped: 0,
          source: 'off_mirror',
          mirrorAsOf: AS_OF,
        });
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it('orders by popularity, missing values last and ties by barcode, across pages', async () => {
        const ctx = createMockContext();
        const page = (n: number) =>
          svc.searchProducts(
            { labels_tag: 'en:organic', page: n, page_size: 5, tags_confirmed: true },
            ctx,
          );

        expect([...codes(await page(1)), ...codes(await page(2)), ...codes(await page(3))]).toEqual(
          ORGANIC_ORDER,
        );
      });

      it('answers a page past the last, and a tag nothing carries, with no rows and their totals', async () => {
        const ctx = createMockContext();

        const past = served(
          await svc.searchProducts(
            { labels_tag: 'en:organic', page: 13, page_size: 1, tags_confirmed: true },
            ctx,
          ),
        );
        const none = served(
          await svc.searchProducts({ labels_tag: 'en:kosher', tags_confirmed: true }, ctx),
        );

        expect(past).toMatchObject({ count: 12, page: 13, page_count: 0, products: [] });
        expect(none).toMatchObject({ count: 0, count_is_exact: true, page: 1, products: [] });
      });

      describe('the result window', () => {
        beforeEach(() => {
          vi.mocked(searchByTags).mockClear();
        });

        // page * page_size at exactly 10,000 is served and the next page is not, at the default
        // page_size of 20 too; page_size 3 reaches 9,999 at page 3,333, so the bound is on the
        // product, never a rounded page count.
        const BOUNDARIES: [string, ProductSearch, ProductSearch][] = [
          ['page_size 50', { page: 200, page_size: 50 }, { page: 201, page_size: 50 }],
          ['page_size 1', { page: 10_000, page_size: 1 }, { page: 10_001, page_size: 1 }],
          ['page_size 3', { page: 3_333, page_size: 3 }, { page: 3_334, page_size: 3 }],
          ['the default page_size', { page: 500 }, { page: 501 }],
        ];

        it.each(BOUNDARIES)(
          'serves the last page inside the window at %s from the store',
          async (_label, inside) => {
            const outcome = served(
              await svc.searchProducts(
                { labels_tag: 'en:organic', ...inside, tags_confirmed: true },
                createMockContext(),
              ),
            );

            expect(outcome).toMatchObject({
              count: 12,
              page: inside.page,
              products: [],
              source: 'off_mirror',
            });
            expect(searchByTags).toHaveBeenCalledOnce();
            expect(global.fetch).not.toHaveBeenCalled();
          },
        );

        it.each(BOUNDARIES)(
          'refuses the next page at %s without running the search',
          async (_label, _inside, past) => {
            const ctx = createMockContext();

            const outcome = await svc.searchProducts(
              { labels_tag: 'en:organic', ...past, tags_confirmed: true },
              ctx,
            );

            expect(outcome).toEqual({ status: 'page_out_of_range', bound: 'mirror_window' });
            expect(searchByTags).not.toHaveBeenCalled();
            expect(global.fetch).not.toHaveBeenCalled();
            expect(warnings(ctx)).toEqual([]);
          },
        );
      });

      it.each<[string, ProductSearch, string[], number]>([
        [
          'an allergen exclusion',
          { labels_tag: 'en:organic', exclude_allergens: ['en:milk'], page_size: 3 },
          ['20000004', '20000005', '20000009'],
          10,
        ],
        [
          'two labels, both required',
          { labels_tag: ['en:organic', 'en:fair-trade'] },
          ['20000004', '20000009', '20000003'],
          3,
        ],
        [
          'NOVA group 4, as its stored taxonomy id',
          { nova_group: '4' },
          ['20000001', '20000010'],
          2,
        ],
      ])('filters on %s', async (_label, params, expected, total) => {
        const outcome = served(
          await svc.searchProducts({ ...params, tags_confirmed: true }, createMockContext()),
        );

        expect(outcome.products.map((row) => row.code)).toEqual(expected);
        expect(outcome.count).toBe(total);
        expect(outcome.source).toBe('off_mirror');
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it('finds a brand by the value off_search_products canonicalizes "Nutella" to', async () => {
        initTaxonomyService();
        const brand = await getTaxonomyService().canonicalizeTag(
          'brands',
          'Nutella',
          createMockContext(),
        );

        const outcome = await svc.searchProducts(
          { brands_tag: brand.value, tags_confirmed: true },
          createMockContext(),
        );

        expect(codes(outcome)).toEqual(['30000001', '20000011', '20000012']);
      });
    });

    describe('searches read live', () => {
      it('reads a tag-only search without tags_confirmed live, beside a ready mirror', async () => {
        await writeMirror([mirrorFixture(OATS).line]);
        global.fetch = vi.fn().mockResolvedValue(mockResponse(TAG_SEARCH_HITS));

        const outcome = served(
          await svc.searchProducts({ labels_tag: 'en:organic', page: 11 }, createMockContext()),
        );

        expect(outcome.source).toBe('off_api');
        expect(new URL(String(vi.mocked(global.fetch).mock.calls[0]?.[0])).pathname).toBe(
          '/api/v2/search',
        );
      });

      it.each<[string, ProductSearch]>([
        ['a query', { query: 'oats', labels_tag: 'en:organic' }],
        [
          'nutrient filters',
          {
            labels_tag: 'en:organic',
            nutrient_filters: [{ nutrient: 'sugars', operator: 'lt', value: 5 }],
          },
        ],
      ])(
        'reads a search carrying %s from the text index, whatever tags_confirmed says',
        async (_label, params) => {
          await writeMirror([mirrorFixture(OATS).line]);
          global.fetch = vi.fn().mockResolvedValue(mockResponse(TEXT_SEARCH_HITS));

          const outcome = served(
            await svc.searchProducts({ ...params, tags_confirmed: true }, createMockContext()),
          );

          expect(outcome.source).toBe('off_api');
          expect(sentRequest().url).toBe(TEXT_SEARCH_URL);
        },
      );

      /** A store whose first full load has stored rows and is still running. */
      const writeRunningFirstLoad = () =>
        writeMirror([mirrorFixture(OATS).line], { firstLoadRunning: true });

      it.each<[string, () => Promise<void>, number, ProductSearch]>([
        ['no mirror configured', async () => undefined, 0, { page: 11 }],
        ['a store error', writeGarbageStore, 1, { page: 11 }],
        ['a first load still running', writeRunningFirstLoad, 0, { page: 11 }],
        // Past the mirror's window too: with no mirror to serve it, the live bound decides.
        ['no mirror configured', async () => undefined, 0, { page: 201, page_size: 50 }],
        ['a store error', writeGarbageStore, 1, { page: 201, page_size: 50 }],
        ['a first load still running', writeRunningFirstLoad, 0, { page: 201, page_size: 50 }],
      ])(
        'refuses a tags_confirmed page past 10 with %s by the live bound, sending nothing (%#)',
        async (_label, build, logged, paging) => {
          await build();
          forbidFetch();
          const ctx = createMockContext();

          const outcome = await svc.searchProducts(
            { labels_tag: 'en:organic', ...paging, tags_confirmed: true },
            ctx,
          );

          expect(outcome).toEqual({ status: 'page_out_of_range', bound: 'live_max_page' });
          expect(global.fetch).not.toHaveBeenCalled();
          expect(warnings(ctx)).toHaveLength(logged);
        },
      );

      it('refuses a tags_confirmed page past the window by the live bound when the store holds no completed sync', async () => {
        const writer = openMirrorStore(storePath());
        await writer.raw();
        await writer.close();
        mirrorConfig.mirrorPath = storePath();
        forbidFetch();
        const ctx = createMockContext();

        const outcome = await svc.searchProducts(
          { labels_tag: 'en:organic', page: 201, page_size: 50, tags_confirmed: true },
          ctx,
        );

        expect(outcome).toEqual({ status: 'page_out_of_range', bound: 'live_max_page' });
        expect(global.fetch).not.toHaveBeenCalled();
        expect(warnings(ctx)).toEqual([]);
      });

      it('reads a tags_confirmed search within the live ceiling live on a store error', async () => {
        await writeGarbageStore();
        global.fetch = vi.fn().mockResolvedValue(mockResponse(TAG_SEARCH_HITS));
        const ctx = createMockContext();

        const outcome = served(
          await svc.searchProducts(
            { labels_tag: 'en:organic', page: 3, tags_confirmed: true },
            ctx,
          ),
        );

        expect(outcome.source).toBe('off_api');
        expect(global.fetch).toHaveBeenCalledOnce();
        expect(warnings(ctx)).toEqual([
          {
            level: 'warning',
            msg: FAILED_READ,
            data: expect.objectContaining({ operation: 'tag search' }),
          },
        ]);
      });

      it('reads a tags_confirmed search within the live ceiling live while the first full load runs', async () => {
        await writeRunningFirstLoad();
        global.fetch = vi.fn().mockResolvedValue(mockResponse(TAG_SEARCH_HITS));
        const ctx = createMockContext();

        const outcome = served(
          await svc.searchProducts(
            { labels_tag: 'en:organic', page: 3, tags_confirmed: true },
            ctx,
          ),
        );

        expect(outcome.source).toBe('off_api');
        expect(global.fetch).toHaveBeenCalledOnce();
        expect(new URL(sentRequest().url).pathname).toBe('/api/v2/search');
        expect(warnings(ctx)).toEqual([]);
      });
    });

    describe('cancellation', () => {
      /** Aborts `controller` the first time the serving store reads its sync state. */
      function abortOnReadState(controller: AbortController, failToo: boolean): void {
        const store = getMirrorStore();
        if (!store) throw new Error('Expected a configured mirror');
        const readState = store.readState.bind(store);
        vi.spyOn(store, 'readState').mockImplementation(async () => {
          controller.abort();
          if (failToo) throw new Error('disk gone');
          return readState();
        });
      }

      it.each([
        ['while it serves', false],
        ['as it fails', true],
      ])(
        'rethrows a caller abort raised during the mirror read %s, reading nothing live',
        async (_label, failToo) => {
          await writeMirror([mirrorFixture(OATS).line]);
          forbidFetch();
          const controller = new AbortController();
          abortOnReadState(controller, failToo);
          const ctx = createMockContext({ signal: controller.signal });

          await expect(svc.getProduct(OATS, ctx)).rejects.toBe(controller.signal.reason);
          expect(global.fetch).not.toHaveBeenCalled();
          expect(warnings(ctx)).toEqual([]);
        },
      );

      it('rethrows a caller abort raised during the readiness check', async () => {
        await writeMirror([mirrorFixture(OATS).line]);
        const controller = new AbortController();
        abortOnReadState(controller, false);

        await expect(
          svc.mirrorReady(createMockContext({ signal: controller.signal })),
        ).rejects.toBe(controller.signal.reason);
      });

      it('ends a read the mirror lacks as RequestCancelled when the caller aborts it live', async () => {
        await writeMirror([mirrorFixture(OATS).line]);
        const controller = new AbortController();
        global.fetch = vi.fn(
          (_input: unknown, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal as AbortSignal;
              signal.addEventListener('abort', () => reject(signal.reason));
              controller.abort();
            }),
        ) as typeof fetch;

        const error = await captureError(
          svc.getProduct(BOTH, createMockContext({ signal: controller.signal })),
        );

        expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
        expect(global.fetch).toHaveBeenCalledOnce();
      });
    });
  });
});
