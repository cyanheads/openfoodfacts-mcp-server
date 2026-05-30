/**
 * @fileoverview Open Food Facts API v2 client with retry, rate limiting, and error normalization.
 * Requires the identifying User-Agent per OFF terms of service.
 * @module services/openfoodfacts/openfoodfacts-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContextLike } from '@cyanheads/mcp-ts-core/utils';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import type { RawProduct, RawProductResponse, RawSearchResponse, SearchParams } from './types.js';

/**
 * Identifying User-Agent required by OFF terms — identifies the client and provides a contact email.
 * Format per OFF docs: <client>/<version> (<contact>)
 */
const USER_AGENT = 'openfoodfacts-mcp-server/0.1.0 (casey@caseyjhand.com)';

const REQUEST_TIMEOUT_MS = 15_000;

/** Fields to request on every product fetch — scopes the ~200-key object to what we handle. */
const PRODUCT_FIELDS =
  'product_name,brands,quantity,ingredients_text,ingredients,allergens_tags,additives_tags,' +
  'nutriscore_grade,nova_group,ecoscore_grade,nutriments,categories_tags,labels_tags,' +
  'packaging_tags,origins_tags,image_url,completeness,data_quality_tags';

/** Fields to request on search results — summary rows for triage. */
const SEARCH_FIELDS = 'code,product_name,brands,nutriscore_grade,nova_group,categories_tags';

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

  /** Handle a product fetch response — normalizes status:0 to null, throws on 5xx. */
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
   * Search products by text and/or tag filters.
   * Returns pagination envelope + product summary rows.
   */
  async searchProducts(
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

    return await withRetry(
      async () => {
        const url = this.buildSearchUrl(params);
        ctx.log.debug('Searching products', { params, url });

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

        ctx.log.debug('Search response received', {
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
        operation: 'OFF:searchProducts',
        context: ctx as RequestContextLike,
        baseDelayMs: 1_000,
        signal: ctx.signal,
      },
    );
  }

  private buildSearchUrl(params: SearchParams): string {
    const url = new URL(`${this.baseUrl}/api/v2/search`);
    url.searchParams.set('fields', SEARCH_FIELDS);
    if (params.query) url.searchParams.set('search_terms', params.query);
    if (params.categories_tag) url.searchParams.set('categories_tags', params.categories_tag);
    if (params.brands_tag) url.searchParams.set('brands_tags', params.brands_tag);
    if (params.labels_tag) url.searchParams.set('labels_tags', params.labels_tag);
    if (params.nutrition_grade) url.searchParams.set('nutrition_grades', params.nutrition_grade);
    if (params.nova_group) url.searchParams.set('nova_groups', params.nova_group);
    if (params.countries_tag) url.searchParams.set('countries_tags', params.countries_tag);
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
