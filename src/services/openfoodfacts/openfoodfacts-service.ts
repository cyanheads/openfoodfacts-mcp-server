/**
 * @fileoverview Open Food Facts API v2 client with retry, rate limiting, and error normalization.
 * Requires the identifying User-Agent per OFF terms of service.
 * @module services/openfoodfacts/openfoodfacts-service
 */

import { readFileSync } from 'node:fs';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import type { RequestContext, RequestContextLike } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import type {
  RawProduct,
  RawProductResponse,
  RawSearchResponse,
  RawTextSearchHit,
  RawTextSearchResponse,
  SearchParams,
  SearchResult,
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

/** Headers sent on every upstream request. The identifying User-Agent is required by OFF terms. */
const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json',
};

/**
 * search.openfoodfacts.org (search-a-licious) refuses any request whose `page * page_size` exceeds
 * this many results, with an HTTP 400 naming the window. Exported so the search tool can reject
 * those requests before they are sent. The tag-only backend (`/api/v2/search`) publishes no
 * equivalent ceiling, so this bound is scoped to the text path.
 *
 * This bounds how deep a request may page — it is deliberately not reused to detect a clipped hit
 * count. That ceiling is a separate limit in the same backend that happens to sit at the same
 * number today, and the response reports it directly via `is_count_exact`, so reading the flag
 * survives either limit moving independently.
 */
export const TEXT_SEARCH_RESULT_WINDOW = 10_000;

/**
 * Failure reasons this service raises, mapped to the wire code each tool declares for them in its
 * `errors: [...]` contract. Errors leave the service already carrying `reason` + `recovery.hint`,
 * so both client surfaces satisfy the contract without any handler-side try/catch.
 */
const REASON_CODES = {
  upstream_error: JsonRpcErrorCode.ServiceUnavailable,
  upstream_timeout: JsonRpcErrorCode.Timeout,
  upstream_rejected: JsonRpcErrorCode.InvalidParams,
  rate_limited: JsonRpcErrorCode.RateLimited,
} as const;

type UpstreamReason = keyof typeof REASON_CODES;

/** Message stem per reason. The upstream status and its own explanation are appended when present. */
const REASON_MESSAGES: Record<UpstreamReason, string> = {
  upstream_error: 'Open Food Facts is unavailable',
  upstream_timeout: 'Open Food Facts did not respond within the request deadline',
  upstream_rejected: 'Open Food Facts refused the request',
  rate_limited: 'Open Food Facts is rate-limiting this client',
};

/**
 * Classifies a framework fetch error onto a declared reason. Deliberately code-driven, never
 * message-driven: `fetchWithTimeout` maps HTTP status to a `JsonRpcErrorCode` and raises `Timeout`
 * for a blown deadline, so the code already carries the authoritative classification.
 *
 * Every 4xx becomes `upstream_rejected` — the request as formed will be refused again, so it is
 * flagged non-retryable and the upstream's own `detail` is surfaced instead of being retried away.
 * `InternalError` here is an upstream 500/501 (the caller-abort case is filtered out before this).
 */
function reasonForCode(code: JsonRpcErrorCode): UpstreamReason {
  if (code === JsonRpcErrorCode.Timeout) return 'upstream_timeout';
  if (code === JsonRpcErrorCode.RateLimited) return 'rate_limited';
  if (code === JsonRpcErrorCode.ServiceUnavailable || code === JsonRpcErrorCode.InternalError) {
    return 'upstream_error';
  }
  return 'upstream_rejected';
}

/**
 * True when a body is an HTML document rather than JSON. Open Food Facts serves a rendered error
 * page under load and on refused requests, and those pages open with a template comment, so the
 * doctype is matched wherever it appears rather than only at the very start of the body.
 */
function looksLikeHtml(body: string): boolean {
  return /<(!doctype\s+html|html[\s>])/i.test(body);
}

/**
 * Extracts the upstream's own explanation from a captured error body. search-a-licious answers a
 * rejected request with `{"detail": "..."}` naming the exact constraint that was violated; anything
 * else falls back to a short snippet so the caller still learns why the request was refused.
 * `error.data.body` is head-truncated by the framework, so this reads whatever survived — and a
 * rendered error page is summarized rather than pasted, since its markup carries no signal.
 */
function upstreamDetail(body: unknown): string | undefined {
  if (typeof body !== 'string' || body.trim() === '') return;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    /* Not JSON (HTML error page, plain text) — fall through to the snippet. */
  }
  if (looksLikeHtml(body)) {
    return 'the upstream served a rendered error page rather than JSON, which usually means it is shedding load or refusing this client';
  }
  return body.slice(0, 200);
}

/**
 * Parses a 2xx body as JSON, catching the rendered error page Open Food Facts serves with a 200
 * under load. The body is read exactly once — reading it as text to sniff for markup and then
 * calling `response.json()` would fail on the already-consumed stream.
 */
async function parseJsonBody<T>(
  response: Response,
  ctx: Context,
  data: Record<string, unknown>,
): Promise<T> {
  if ((response.headers.get('content-type') ?? '').includes('application/json')) {
    return (await response.json()) as T;
  }
  const body = await response.text();
  if (looksLikeHtml(body)) {
    throw contractError(
      'upstream_error',
      'Open Food Facts served an HTML page instead of JSON — the service is rate-limiting or temporarily down.',
      ctx,
      data,
    );
  }
  return JSON.parse(body) as T;
}

/**
 * Log bindings for the framework fetch helper. `RequestContext` is an open context bag and the
 * handler `Context` is not structurally assignable to it, so the correlation fields are projected
 * explicitly rather than cast through `unknown`.
 */
function fetchLogContext(ctx: Context, operation: string): RequestContext {
  return {
    requestId: ctx.requestId,
    tenantId: ctx.tenantId,
    timestamp: new Date().toISOString(),
    operation,
  };
}

/**
 * Builds a failure carrying the reason, retryability, and recovery hint declared by the calling
 * tool. `retryable` is emitted for every reason, not just the non-retryable one, so a client reading
 * `data.retryable` gets an answer rather than an absence it has to interpret. Only an upstream
 * rejection is non-retryable — the request as formed will be refused again.
 */
function contractError(
  reason: UpstreamReason,
  message: string,
  ctx: Context,
  data: Record<string, unknown>,
  cause?: unknown,
): McpError {
  return new McpError(
    REASON_CODES[reason],
    message,
    {
      ...data,
      reason,
      retryable: reason !== 'upstream_rejected',
      ...ctx.recoveryFor(reason),
    },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Re-raises a framework fetch error as the declared contract failure. Called inside the retry
 * boundary so the mapped code — not the raw one — drives `withRetry`'s transient classification:
 * 5xx, timeouts, and 429s stay retryable while a 4xx fails immediately.
 */
function toContractError(error: unknown, ctx: Context, data: Record<string, unknown>): unknown {
  if (!(error instanceof McpError)) return error;
  // A caller-cancelled request is not an upstream failure — leave it untouched.
  if (error.data?.errorSource === 'FetchAborted') return error;

  const reason = reasonForCode(error.code);
  const status = error.data?.status;
  const detail = upstreamDetail(error.data?.body);
  const message =
    `${REASON_MESSAGES[reason]}${typeof status === 'number' ? ` (HTTP ${status})` : ''}` +
    `${detail ? `: ${detail}` : '.'}`;

  return contractError(reason, message, ctx, { ...error.data, ...data }, error);
}

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

  /**
   * Checks and records a request. Throws the declared `rate_limited` failure when this server's own
   * per-minute budget is spent. The refusal is local — nothing was sent upstream — so the message
   * names this server rather than Open Food Facts, and carries the wait until a slot frees.
   */
  check(endpoint: string, ctx: Context): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    // Evict timestamps outside the window
    while (this.timestamps.length > 0 && (this.timestamps[0] ?? 0) < windowStart) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxRequests) {
      const retryAfter = Math.max(
        1,
        Math.ceil(((this.timestamps[0] ?? now) + this.windowMs - now) / 1000),
      );
      throw rateLimited(
        `openfoodfacts-mcp-server declined this ${endpoint} request: its own client-side budget of ` +
          `${this.maxRequests} ${endpoint} requests/min is spent, so nothing was sent to Open Food ` +
          `Facts. A slot frees in about ${retryAfter}s.`,
        {
          endpoint,
          limit: this.maxRequests,
          retryAfter,
          reason: 'rate_limited',
          retryable: true,
          ...ctx.recoveryFor('rate_limited'),
        },
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
    this.productLimiter.check('product', ctx);

    return await withRetry(
      () => {
        const url = `${this.baseUrl}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${PRODUCT_FIELDS}`;
        ctx.log.debug('Fetching product', { barcode, url });
        return this.fetchProduct(url, barcode, ctx);
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
    this.productLimiter.check('product', ctx);

    return await withRetry(
      () => {
        const url = `${this.baseUrl}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;
        ctx.log.debug('Fetching product fields', { barcode, fields });
        return this.fetchProduct(url, barcode, ctx);
      },
      {
        operation: `OFF:getProductFields:${barcode}`,
        context: ctx as RequestContextLike,
        baseDelayMs: 500,
        signal: ctx.signal,
      },
    );
  }

  /**
   * Fetch and normalize a single product. HTTP 404 — which OFF returns for barcodes no contributor
   * has entered, alongside the HTTP 200 + `status:0` form of the same condition — resolves to
   * `null`; every other failure is re-raised as a declared contract failure. Returning `null` only
   * for a genuine not-found is what lets callers distinguish "no record" from "the fetch failed".
   */
  private async fetchProduct(
    url: string,
    barcode: string,
    ctx: Context,
  ): Promise<RawProduct | null> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        REQUEST_TIMEOUT_MS,
        fetchLogContext(ctx, 'OFF:product'),
        { signal: ctx.signal, headers: REQUEST_HEADERS, expectedStatuses: [404] },
      );
    } catch (error) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) {
        ctx.log.debug('Product not found (HTTP 404)', { barcode });
        return null;
      }
      throw toContractError(error, ctx, { barcode });
    }

    const data = await parseJsonBody<RawProductResponse>(response, ctx, { barcode });
    ctx.log.debug('Product response received', { barcode, status: data.status });

    // status:0 = barcode not found in any contributor record (still HTTP 200)
    if (data.status === 0) {
      return null;
    }

    return data.product ?? null;
  }

  /**
   * Fetch a search endpoint, re-raising every failure as a declared contract failure. Runs inside
   * the caller's retry boundary so the mapped code drives retry classification.
   */
  private async fetchSearch(
    url: string,
    ctx: Context,
    operation: string,
    data: Record<string, unknown>,
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(url, REQUEST_TIMEOUT_MS, fetchLogContext(ctx, operation), {
        signal: ctx.signal,
        headers: REQUEST_HEADERS,
      });
    } catch (error) {
      throw toContractError(error, ctx, data);
    }
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
  searchProducts(params: SearchParams, ctx: Context): Promise<SearchResult> {
    this.searchLimiter.check('search', ctx);

    return params.query
      ? this.searchProductsByText(params, ctx)
      : this.searchProductsByTags(params, ctx);
  }

  /**
   * Text search via search.openfoodfacts.org (search-a-licious). Handles both text-only queries and
   * combined text + tag filtering: recognized tag facets are ANDed into the Lucene `q` as hard
   * filters while the free-text terms drive relevance scoring.
   */
  private async searchProductsByText(params: SearchParams, ctx: Context): Promise<SearchResult> {
    return await withRetry(
      async () => {
        const url = new URL(`${TEXT_SEARCH_BASE_URL}/search`);
        url.searchParams.set('q', this.buildTextSearchQuery(params));
        url.searchParams.set('fields', SEARCH_FIELDS);
        url.searchParams.set('page', String(params.page ?? 1));
        url.searchParams.set('page_size', String(params.page_size ?? 20));

        ctx.log.debug('Text-searching products', { query: params.query, url: url.toString() });

        const response = await this.fetchSearch(url.toString(), ctx, 'OFF:searchProductsByText', {
          page: params.page ?? 1,
          page_size: params.page_size ?? 20,
        });

        const data = await parseJsonBody<RawTextSearchResponse>(response, ctx, {
          page: params.page ?? 1,
        });
        const pageSize = params.page_size ?? 20;

        ctx.log.debug('Text search response received', {
          count: data.count,
          count_is_exact: data.is_count_exact,
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
          // The backend stops counting hits at a ceiling and reports which side of it this count
          // fell on. Read the flag rather than comparing the count against a local constant: the
          // two are different limits, and only the backend knows when it stopped counting. A
          // response that omits the flag makes no clipping claim, so none is manufactured here.
          count_is_exact: data.is_count_exact ?? true,
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
  private async searchProductsByTags(params: SearchParams, ctx: Context): Promise<SearchResult> {
    return await withRetry(
      async () => {
        const url = this.buildSearchUrl(params);
        ctx.log.debug('Searching products by tags', { params, url });

        const response = await this.fetchSearch(url, ctx, 'OFF:searchProductsByTags', {
          page: params.page ?? 1,
          page_size: params.page_size ?? 20,
        });

        const data = await parseJsonBody<RawSearchResponse>(response, ctx, {
          page: params.page ?? 1,
        });

        ctx.log.debug('Tag search response received', {
          count: data.count,
          page: data.page,
          returned: data.products?.length ?? 0,
        });

        return {
          count: data.count ?? 0,
          // This endpoint counts every match — live-verified returning totals more than twenty
          // times the ceiling the text backend stops counting at — so its count is never a floor.
          count_is_exact: true,
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
   *
   * `additives_tag` has no clause here on purpose. The search-a-licious index carries no
   * `additives_tags` field, so a clause naming it is parsed as a phrase match against a field that
   * does not exist and returns zero hits with no error — live-verified across several E-numbers
   * that match hundreds of thousands of products on the tag path. The tool rejects that
   * combination up front rather than sending a filter that silently empties the result set.
   */
  private buildTextSearchQuery(params: SearchParams): string {
    const clauses: string[] = [];
    if (params.categories_tag) clauses.push(`categories_tags:"${params.categories_tag}"`);
    if (params.brands_tag) clauses.push(`brands_tags:"${params.brands_tag}"`);
    if (params.labels_tag) clauses.push(`labels_tags:"${params.labels_tag}"`);
    if (params.allergens_tag) clauses.push(`allergens_tags:"${params.allergens_tag}"`);
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
    if (params.allergens_tag) url.searchParams.set('allergens_tags', params.allergens_tag);
    if (params.additives_tag) url.searchParams.set('additives_tags', params.additives_tag);
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
