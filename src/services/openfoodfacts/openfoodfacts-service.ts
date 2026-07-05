/**
 * @fileoverview Open Food Facts API v2 client with retry, rate limiting, and error normalization.
 * Requires the identifying User-Agent per OFF terms of service.
 * @module services/openfoodfacts/openfoodfacts-service
 */

import { readFileSync } from 'node:fs';
import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContextLike } from '@cyanheads/mcp-ts-core/utils';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import type {
  RawProduct,
  RawProductResponse,
  RawSearchResponse,
  RawTextSearchHit,
  RawTextSearchResponse,
  SearchParams,
} from './types.js';

/**
 * Package version, read from package.json at load so the identifying User-Agent always matches the
 * shipped release rather than a hand-maintained constant that silently drifts between versions.
 */
const { version: PACKAGE_VERSION } = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * Identifying User-Agent required by OFF terms — identifies the client and provides a contact email.
 * Format per OFF docs: <client>/<version> (<contact>)
 */
const USER_AGENT = `openfoodfacts-mcp-server/${PACKAGE_VERSION} (casey@caseyjhand.com)`;

const REQUEST_TIMEOUT_MS = 15_000;

/** Fields to request on every product fetch — scopes the ~200-key object to what we handle. */
const PRODUCT_FIELDS =
  'product_name,brands,quantity,ingredients_text,ingredients,allergens_tags,additives_tags,' +
  'nutriscore_grade,nova_group,ecoscore_grade,nutriments,categories_tags,labels_tags,' +
  'packaging_tags,origins_tags,image_url,completeness,data_quality_tags';

/** Fields to request on search results — summary rows for triage. Shared by both search paths. */
const SEARCH_FIELDS =
  'code,product_name,brands,nutriscore_grade,nova_group,ecoscore_grade,categories_tags';

/**
 * Text search endpoint — search.openfoodfacts.org uses Elasticsearch and actually filters by the
 * query text. The /api/v2/search endpoint silently ignores search_terms and returns all products.
 */
const TEXT_SEARCH_BASE_URL = 'https://search.openfoodfacts.org';

/**
 * Reserved characters in search-a-licious's Lucene-style `q` syntax (field:value clauses, boolean
 * operators, wildcards, ranges, grouping). Live-verified: an unescaped colon in free text is
 * parsed as a field filter rather than literal text — e.g. `query: "brands: nutella"` with no
 * `brands_tag` set returns only Nutella products, and `query: "nutriscore_grade: a"` silently
 * hard-filters to grade "a" even though nutriscore_grade isn't a facet this tool exposes as a
 * free-text-injectable filter.
 */
const LUCENE_RESERVED_CHARS = /[+\-=&|><!(){}[\]^"~*?:\\/]/g;

/** Escapes Lucene reserved characters so free text is matched as literal terms, never as query syntax. */
function escapeLuceneQueryText(text: string): string {
  return text.replace(LUCENE_RESERVED_CHARS, '\\$&');
}

/** Token bucket rate limiter — tracks request timestamps to enforce per-minute limits. */
class RateLimiter {
  private readonly windowMs = 60_000;
  private readonly maxRequests: number;
  private readonly timestamps: number[] = [];

  constructor(maxRequestsPerMin: number) {
    this.maxRequests = maxRequestsPerMin;
  }

  /** Checks and records a request. Throws `ServiceUnavailable` if the limit is exceeded. */
  check(endpoint: string): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    // Evict timestamps outside the window
    while (this.timestamps.length > 0 && (this.timestamps[0] ?? 0) < windowStart) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxRequests) {
      throw serviceUnavailable(
        `Open Food Facts rate limit reached for ${endpoint} (${this.maxRequests} req/min). ` +
          'Retry after a brief pause.',
        { endpoint, limit: this.maxRequests },
      );
    }
    this.timestamps.push(now);
  }
}

export class OpenFoodFactsService {
  private readonly baseUrl: string;
  private readonly productLimiter: RateLimiter;
  private readonly searchLimiter: RateLimiter;

  constructor(config: ServerConfig) {
    this.baseUrl = config.baseUrl;
    this.productLimiter = new RateLimiter(config.rateLimitProduct);
    this.searchLimiter = new RateLimiter(config.rateLimitSearch);
  }

  /**
   * Fetch a product by barcode.
   * Returns `null` when status:0 (barcode not found in any contributor record).
   * The caller is responsible for surfacing the not-found condition via ctx.fail.
   */
  async getProduct(barcode: string, ctx: Context): Promise<RawProduct | null> {
    this.productLimiter.check('product');

    return await withRetry(
      async () => {
        const fields = PRODUCT_FIELDS;
        const url = `${this.baseUrl}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;
        ctx.log.debug('Fetching product', { barcode, url });

        const response = await fetch(url, {
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
        });

        return this.handleProductResponse(response, barcode, ctx);
      },
      {
        operation: `OFF:getProduct:${barcode}`,
        context: ctx as RequestContextLike,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Fetch a product by barcode with a specific field subset.
   * Used when the caller only needs a subset of fields (e.g., off_compare_products).
   */
  async getProductFields(
    barcode: string,
    fields: string,
    ctx: Context,
  ): Promise<RawProduct | null> {
    this.productLimiter.check('product');

    return await withRetry(
      async () => {
        const url = `${this.baseUrl}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;
        ctx.log.debug('Fetching product fields', { barcode, fields });

        const response = await fetch(url, {
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
        });

        return this.handleProductResponse(response, barcode, ctx);
      },
      {
        operation: `OFF:getProductFields:${barcode}`,
        context: ctx as RequestContextLike,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    );
  }

  /** Handle a product fetch response — normalizes status:0 and HTTP 404 to null, throws on 5xx. */
  private async handleProductResponse(
    response: Response,
    barcode: string,
    ctx: Context,
  ): Promise<RawProduct | null> {
    const contentType = response.headers.get('content-type') ?? '';

    if (!response.ok) {
      if (response.status >= 500) {
        // Check for HTML error pages (common during high load)
        const body = await response.text();
        if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(body)) {
          throw serviceUnavailable(
            'Open Food Facts returned an HTML error page — likely rate-limited or temporarily down.',
            { barcode, status: response.status },
          );
        }
        throw serviceUnavailable(`Open Food Facts API error: HTTP ${response.status}`, {
          barcode,
          status: response.status,
        });
      }
      // HTTP 404: OFF returns this for barcodes not in the database (alongside status:0 in body).
      // Treat as not-found (null) rather than an upstream error — the JSON body confirms status:0.
      if (response.status === 404) {
        ctx.log.debug('Product not found (HTTP 404)', { barcode });
        return null;
      }
      throw serviceUnavailable(`Open Food Facts returned HTTP ${response.status}`, {
        barcode,
        status: response.status,
      });
    }

    // Detect HTML error pages masquerading as 200 responses (happens during high OFF load)
    if (!contentType.includes('application/json')) {
      const body = await response.text();
      if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(body)) {
        throw serviceUnavailable(
          'Open Food Facts returned an HTML page instead of JSON — likely rate-limited.',
          { barcode },
        );
      }
    }

    const data = (await response.json()) as RawProductResponse;
    ctx.log.debug('Product response received', { barcode, status: data.status });

    // status:0 = barcode not found in any contributor record (still HTTP 200)
    if (data.status === 0) {
      return null;
    }

    return data.product ?? null;
  }

  /**
   * Search products by text query, tag filters, or both together.
   * Returns pagination envelope + product summary rows.
   *
   * Routing:
   * - `query` present (with or without tag filters): search.openfoodfacts.org (search-a-licious).
   *   Any tag filters are folded into the Lucene `q` alongside the free text, so combined results
   *   are both text-relevant and filtered. The /api/v2/search endpoint silently ignores free text,
   *   so it cannot serve a text query.
   * - Tag filters only (no query): /api/v2/search (structured facet filtering).
   */
  searchProducts(
    params: SearchParams,
    ctx: Context,
  ): Promise<{
    count: number;
    page: number;
    page_count: number;
    page_size: number;
    products: RawProduct[];
  }> {
    this.searchLimiter.check('search');

    return params.query
      ? this.searchProductsByText(params, ctx)
      : this.searchProductsByTags(params, ctx);
  }

  /**
   * Text search via search.openfoodfacts.org (search-a-licious). Handles both text-only queries and
   * combined text + tag filtering: recognized tag facets are ANDed into the Lucene `q` as hard
   * filters while the free-text terms drive relevance scoring.
   */
  private async searchProductsByText(
    params: SearchParams,
    ctx: Context,
  ): Promise<{
    count: number;
    page: number;
    page_count: number;
    page_size: number;
    products: RawProduct[];
  }> {
    return await withRetry(
      async () => {
        const url = new URL(`${TEXT_SEARCH_BASE_URL}/search`);
        url.searchParams.set('q', this.buildTextSearchQuery(params));
        url.searchParams.set('fields', SEARCH_FIELDS);
        url.searchParams.set('page', String(params.page ?? 1));
        url.searchParams.set('page_size', String(params.page_size ?? 20));

        ctx.log.debug('Text-searching products', { query: params.query, url: url.toString() });

        const response = await fetch(url.toString(), {
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          throw serviceUnavailable(`Open Food Facts text search returned HTTP ${response.status}`, {
            status: response.status,
          });
        }

        const data = (await response.json()) as RawTextSearchResponse;
        const pageSize = params.page_size ?? 20;

        ctx.log.debug('Text search response received', {
          count: data.count,
          page: data.page,
          returned: data.hits?.length ?? 0,
        });

        // Normalize text search hits to RawProduct shape (brands is array → join to string).
        // Use spread of defined-only fields to satisfy exactOptionalPropertyTypes.
        const products: RawProduct[] = (data.hits ?? []).map((hit: RawTextSearchHit) => {
          const brands = Array.isArray(hit.brands) ? hit.brands.join(', ') : hit.brands;
          return {
            ...(hit.product_name !== undefined && { product_name: hit.product_name }),
            ...(brands !== undefined && { brands }),
            ...(hit.nutriscore_grade !== undefined && { nutriscore_grade: hit.nutriscore_grade }),
            ...(hit.nova_group !== undefined && { nova_group: hit.nova_group }),
            ...(hit.ecoscore_grade !== undefined && { ecoscore_grade: hit.ecoscore_grade }),
            ...(hit.categories_tags !== undefined && { categories_tags: hit.categories_tags }),
            // code is the barcode — stored as a synthetic field for the search handler to read
            ...({ code: hit.code } as unknown as Partial<RawProduct>),
          };
        });

        return {
          count: data.count ?? 0,
          page: data.page ?? 1,
          // page_count in text search response is TOTAL PAGES; normalize to products-on-page
          page_count: products.length,
          page_size: pageSize,
          products,
        };
      },
      {
        operation: 'OFF:searchProductsByText',
        context: ctx as RequestContextLike,
        baseDelayMs: 1_000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Tag-only search via /api/v2/search — structured facet filtering for requests with no text query.
   * Combined text + tag requests route through searchProductsByText instead, which folds the tag
   * facets into the Lucene `q`.
   */
  private async searchProductsByTags(
    params: SearchParams,
    ctx: Context,
  ): Promise<{
    count: number;
    page: number;
    page_count: number;
    page_size: number;
    products: RawProduct[];
  }> {
    return await withRetry(
      async () => {
        const url = this.buildSearchUrl(params);
        ctx.log.debug('Searching products by tags', { params, url });

        const response = await fetch(url, {
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
        });

        const contentType = response.headers.get('content-type') ?? '';

        if (!response.ok) {
          if (response.status >= 500) {
            const body = await response.text();
            if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(body)) {
              throw serviceUnavailable(
                'Open Food Facts returned an HTML error page — likely rate-limited or temporarily down.',
                { status: response.status },
              );
            }
            throw serviceUnavailable(`Open Food Facts API error: HTTP ${response.status}`, {
              status: response.status,
            });
          }
          throw serviceUnavailable(`Open Food Facts search returned HTTP ${response.status}`, {
            status: response.status,
          });
        }

        if (!contentType.includes('application/json')) {
          const body = await response.text();
          if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(body)) {
            throw serviceUnavailable(
              'Open Food Facts returned HTML instead of JSON — likely rate-limited.',
              {},
            );
          }
        }

        const data = (await response.json()) as RawSearchResponse;

        ctx.log.debug('Tag search response received', {
          count: data.count,
          page: data.page,
          returned: data.products?.length ?? 0,
        });

        return {
          count: data.count ?? 0,
          page: data.page ?? 1,
          page_count: data.page_count ?? data.products?.length ?? 0,
          page_size: data.page_size ?? params.page_size ?? 20,
          products: data.products ?? [],
        };
      },
      {
        operation: 'OFF:searchProductsByTags',
        context: ctx as RequestContextLike,
        baseDelayMs: 1_000,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Build the search-a-licious Lucene `q` from a text query plus tag filters. Recognized
   * `field:"value"` facet clauses become hard AND filters; the free-text query adds relevance
   * scoring. Facet field names differ from /api/v2/search: nutrition grade → `nutriscore_grade`,
   * NOVA → `nova_group` (no `_tags` suffix); the tag facets keep their names and `en:`-prefixed
   * values. `en:`-prefixed tag IDs and brand slugs are quoted so their `:` and spaces aren't parsed
   * as query syntax; the bare score/nova tokens carry no such characters and stay unquoted. The
   * free-text query is escaped (not quoted) so it keeps multi-term relevance-ranked matching but
   * can't smuggle in its own field:value clauses — an unescaped colon would otherwise let caller
   * text override facets, including ones this tool never exposes as filters (see
   * LUCENE_RESERVED_CHARS).
   */
  private buildTextSearchQuery(params: SearchParams): string {
    const clauses: string[] = [];
    if (params.categories_tag) clauses.push(`categories_tags:"${params.categories_tag}"`);
    if (params.brands_tag) clauses.push(`brands_tags:"${params.brands_tag}"`);
    if (params.labels_tag) clauses.push(`labels_tags:"${params.labels_tag}"`);
    if (params.nutrition_grade) clauses.push(`nutriscore_grade:${params.nutrition_grade}`);
    if (params.nova_group) clauses.push(`nova_group:${params.nova_group}`);
    if (params.countries_tag) clauses.push(`countries_tags:"${params.countries_tag}"`);
    if (params.query) clauses.push(escapeLuceneQueryText(params.query));
    return clauses.join(' ');
  }

  private buildSearchUrl(params: SearchParams): string {
    const url = new URL(`${this.baseUrl}/api/v2/search`);
    url.searchParams.set('fields', SEARCH_FIELDS);
    if (params.categories_tag) url.searchParams.set('categories_tags', params.categories_tag);
    if (params.brands_tag) url.searchParams.set('brands_tags', params.brands_tag);
    if (params.labels_tag) url.searchParams.set('labels_tags', params.labels_tag);
    // Score filters use the *_tags param keys — the bare nutrition_grades / nova_groups keys are
    // silently ignored by /api/v2/search and return unfiltered rows. Values pass through bare:
    // nutrition_grades_tags accepts only the plain grade letter ("a", not "en:a").
    if (params.nutrition_grade)
      url.searchParams.set('nutrition_grades_tags', params.nutrition_grade);
    if (params.nova_group) url.searchParams.set('nova_groups_tags', params.nova_group);
    if (params.countries_tag) url.searchParams.set('countries_tags', params.countries_tag);
    if (params.sort_by) url.searchParams.set('sort_by', params.sort_by);
    url.searchParams.set('page', String(params.page ?? 1));
    url.searchParams.set('page_size', String(params.page_size ?? 20));
    return url.toString();
  }
}

/* --- Init/accessor pattern --- */

let _service: OpenFoodFactsService | undefined;

export function initOpenFoodFactsService(): void {
  _service = new OpenFoodFactsService(getServerConfig());
}

export function getOpenFoodFactsService(): OpenFoodFactsService {
  if (!_service) {
    throw new Error(
      'OpenFoodFactsService not initialized — call initOpenFoodFactsService() in setup()',
    );
  }
  return _service;
}
