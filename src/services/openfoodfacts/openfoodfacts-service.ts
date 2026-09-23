/**
 * @fileoverview Open Food Facts API v2 client with retry, rate limiting, and error normalization.
 * Requires the identifying User-Agent per OFF terms of service.
 * @module services/openfoodfacts/openfoodfacts-service
 */

import { readFileSync } from 'node:fs';
import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  fetchWithTimeout,
  withExtra,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import { ANALYZER_STOP_WORDS, STOP_WORD_LANGS } from './analyzer-stop-words.js';
import {
  BARCODE_PATTERN,
  type NutrientOperator,
  type RawAutocompleteResponse,
  type RawProduct,
  type RawProductResponse,
  type RawSearchResponse,
  type RawTextSearchResponse,
  type SearchParams,
  type SearchResult,
  type SearchRow,
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
 * those requests before they are sent. Scoped to the text path; the tag-only backend has its own,
 * page-based bound (`TAG_SEARCH_MAX_PAGE`).
 *
 * This bounds how deep a request may page — it is deliberately not reused to detect a clipped hit
 * count. That ceiling is a separate limit in the same backend that happens to sit at the same
 * number today, and the response reports it directly via `is_count_exact`, so reading the flag
 * survives either limit moving independently.
 */
export const TEXT_SEARCH_RESULT_WINDOW = 10_000;

/**
 * Deepest page `/api/v2/search` serves a client that is not logged in. Product Opener answers any
 * page past it with HTTP 401 and a rendered `robots_not_served_here` page before running the query
 * (`search_and_display_products` in `lib/ProductOpener/Display.pm`), whatever the `page_size` and
 * however few products match — live, page 11 was refused at `page_size` 1 and on a filter matching
 * nothing, while page 10 at `page_size` 50 was served. Exported so the search tool can reject a
 * deeper page before it is sent and report the reachable depth.
 */
export const TAG_SEARCH_MAX_PAGE = 10;

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
 * Classifies a framework fetch error onto a declared reason. Deliberately status-driven, never
 * body- or message-driven: `fetchWithTimeout` maps the HTTP status to a `JsonRpcErrorCode`, raises
 * `Timeout` for a blown deadline, and flags a status no retry can change with
 * `data.retryable: false`, so the error already carries the authoritative classification. The body
 * only shapes the message (see `upstreamDetail`).
 *
 * A status the framework flags non-retryable is `upstream_rejected` whatever its code — today that
 * is 501 Not Implemented, which keeps the transient `ServiceUnavailable` code and would otherwise be
 * re-flagged retryable here and sent four times. Every other 4xx except 408/425 (`Timeout`) and 429
 * (`RateLimited`) is `upstream_rejected` too: the request as formed will be refused again, so it is
 * flagged non-retryable and the upstream's own `detail` is surfaced instead of being retried away.
 * The framework maps every other 5xx to `ServiceUnavailable` (504 to `Timeout`) and never raises
 * `InternalError` for an HTTP status; that code is read as an upstream failure rather than a
 * rejection because it names no request the caller could correct.
 */
function reasonFor(error: McpError): UpstreamReason {
  if (error.data?.retryable === false) return 'upstream_rejected';
  const { code } = error;
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
 * rejected request with a `detail` naming the exact constraint that was violated — a string on a
 * GET, and on a POST whose JSON body fails validation a list of objects whose `msg` says why (each
 * also echoes the whole request under `input`, which is noise here, so only the messages are
 * kept). Anything else falls back to a short snippet so the caller still learns why the request
 * was refused.
 * `error.data.body` is head-truncated by the framework, so this reads whatever survived — and a
 * rendered error page is summarized rather than pasted, since its markup carries no signal.
 *
 * The summary follows the reason the status already settled, never the other way round: a page
 * served with a refusal (a 4xx, or the non-retryable 501) is described as a refusal, and only a
 * page served with a retryable failure is attributed to load. Product Opener answers every
 * anonymous search page past 10 with a 401 and a rendered page, and blaming load there told the
 * caller to wait for a refusal that cannot change.
 */
function upstreamDetail(body: unknown, reason: UpstreamReason): string | undefined {
  if (typeof body !== 'string' || body.trim() === '') return;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === 'string') return plainTextDetail(parsed.detail);
    if (Array.isArray(parsed.detail)) {
      const messages = parsed.detail.flatMap((entry: { msg?: unknown }) =>
        typeof entry?.msg === 'string' ? [entry.msg] : [],
      );
      if (messages.length > 0) return plainTextDetail(messages.join('; '));
    }
  } catch {
    /*
     * Not JSON (HTML error page, plain text), or JSON the framework cut short: a validation list
     * echoes the request body, so a long query pushes it past the capture limit. Its messages lead
     * each entry, so they survive in the captured head.
     */
    const messages = [...body.matchAll(/"msg"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(
      (match) => match[1],
    );
    if (messages.length > 0) return plainTextDetail(messages.join('; '));
  }
  if (looksLikeHtml(body)) {
    return reason === 'upstream_rejected'
      ? 'it answered with a rendered error page rather than a JSON explanation of the refusal'
      : 'the upstream served a rendered error page rather than JSON, which usually means it is shedding load or refusing this client';
  }
  return plainTextDetail(body);
}

/** Longest plain-text upstream snippet carried into an error message. */
const PLAIN_TEXT_DETAIL_LIMIT = 200;

/**
 * Reduces a body that is neither JSON nor a recognized HTML document to a bounded plain-text
 * snippet. Markup is dropped rather than truncated into: the message is rendered as Markdown on
 * the text surface, and a body the HTML sniff did not match can still carry angle brackets that
 * would land there as syntax. Returns `undefined` when nothing readable survives.
 */
function plainTextDetail(body: string): string | undefined {
  const text = body
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PLAIN_TEXT_DETAIL_LIMIT)
    .trim();
  return text === '' ? undefined : text;
}

/**
 * Fields of a framework fetch error this service republishes on the public failure. An allowlist,
 * not a filter: `fetchWithTimeout` is free to attach whatever diagnostics it needs — including the
 * captured response body, twice — and the contract is what this server chooses to publish, not
 * whatever happened to be on the error. Everything else the caller needs (`reason`, `retryable`,
 * `recovery`, the per-call context) is added at the throw site.
 */
const PUBLISHED_ERROR_FIELDS = ['status', 'retryAfter', 'retryAttempts', 'operation'] as const;

/** The published subset of a fetch error's data. */
function publishedErrorData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const published: Record<string, unknown> = {};
  for (const field of PUBLISHED_ERROR_FIELDS) {
    if (data?.[field] !== undefined) published[field] = data[field];
  }
  return published;
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
 * boundary so the mapped reason — not the raw code — drives `withRetry`'s transient
 * classification: 5xx other than 501, timeouts, and 429s stay retryable while a 4xx or a 501 fails
 * immediately.
 */
function toContractError(error: unknown, ctx: Context, data: Record<string, unknown>): unknown {
  if (!(error instanceof McpError)) return error;
  // A caller-cancelled request is not an upstream failure — leave it untouched.
  if (error.data?.errorSource === 'FetchAborted') return error;

  const reason = reasonFor(error);
  const status = error.data?.status;
  const detail = upstreamDetail(error.data?.body, reason);
  const message =
    `${REASON_MESSAGES[reason]}${typeof status === 'number' ? ` (HTTP ${status})` : ''}` +
    `${detail ? `: ${detail}` : '.'}`;

  return contractError(reason, message, ctx, { ...publishedErrorData(error.data), ...data }, error);
}

/** Fields to request on every product fetch — scopes the ~200-key object to what we handle. */
const PRODUCT_FIELDS =
  'product_name,brands,quantity,ingredients_text,ingredients,allergens_tags,traces_tags,' +
  'additives_tags,ingredients_analysis_tags,nutriscore_grade,nova_group,ecoscore_grade,' +
  'nutriments,serving_size,serving_quantity,serving_quantity_unit,categories_tags,labels_tags,' +
  'packaging_tags,origins_tags,countries_tags,image_url,completeness,data_quality_tags';

/** Fields to request on search results — summary rows for triage. Shared by both search paths. */
const SEARCH_FIELDS = [
  'code',
  'product_name',
  'brands',
  'nutriscore_grade',
  'nova_group',
  'ecoscore_grade',
  'categories_tags',
];

/**
 * Text search endpoint — search.openfoodfacts.org uses Elasticsearch and actually filters by the
 * query text. The /api/v2/search endpoint silently ignores search_terms and returns all products.
 * The same host serves the taxonomy autocomplete used to resolve tag IDs.
 *
 * Its index is a snapshot that lags the live database, so this path and the tag-only path answer
 * the same filters differently — live-verified with a category filter counting more products on
 * /api/v2/search than here, and a barcode contributed after the cutoff absent from this index
 * entirely. The endpoint publishes no index timestamp (`/health` reports only Redis and
 * Elasticsearch connectivity), so the lag is disclosed to the caller rather than dated.
 */
const TEXT_SEARCH_BASE_URL = 'https://search.openfoodfacts.org';

/**
 * Every language the text index analyzes, sent as `langs` on each text search. The backend
 * searches `product_name.<lang>` and `generic_name.<lang>` only for the languages it is sent and
 * defaults to English alone, so a product named only in French, Russian, or Portuguese is
 * invisible to a text query that sends nothing (live, 2026-09-22: `шоколад` 359 hits on the
 * default against 870 with the first 30 of these). These are exactly the codes the index has name
 * subfields for — search-a-licious v1.4.0's `ANALYZER_LANG_MAPPING` intersected with the Open Food
 * Facts language list, which drops its `cz` and `pt-BR` entries. Live, 2026-09-23: offered 60 codes,
 * the backend compiled name fields for these 31 and no others, and `melkesjokolade` counts 42
 * without `no` against 52 with it. A code outside them drops every name field and leaves only
 * `brands` searched (`langs=pl` → `chocolate` 1,749 hits, against 10,000+), which is why this is a
 * constant rather than a caller input. Names entered in any other language are stored in fields
 * the query cannot reach at any `langs`.
 */
export const TEXT_SEARCH_LANGS = [
  'en',
  'fr',
  'it',
  'es',
  'de',
  'nl',
  'ar',
  'hy',
  'eu',
  'bn',
  'bg',
  'ca',
  'da',
  'et',
  'fi',
  'gl',
  'el',
  'hi',
  'hu',
  'id',
  'ga',
  'lv',
  'lt',
  'fa',
  'pt',
  'ro',
  'ru',
  'sv',
  'tr',
  'th',
  'no',
] as const;

/** A language code the text index analyzes. */
export type TextSearchLang = (typeof TEXT_SEARCH_LANGS)[number];

/**
 * The languages among `TEXT_SEARCH_LANGS` the taxonomy fields (`categories`, `labels`) carry
 * translated subfields for — the taxonomies' exported languages. The backend searches
 * `categories.<lang>` and `labels.<lang>` only for these.
 */
const TAXONOMY_FIELD_LANGS = [
  'en',
  'fr',
  'it',
  'es',
  'de',
  'nl',
] as const satisfies readonly TextSearchLang[];

/**
 * The fields the backend's own relevance match (`multi_match`) searches for the `langs` sent: the
 * two name fields per analyzed language, the two taxonomy fields per exported language, and
 * `brands`, which is not language-specific — 75 fields, live-verified against the backend's
 * compiled query. The per-word groups span exactly this list: a field it lacked would drop matches
 * the relevance part found, and a field it added could only narrow.
 */
const TEXT_SEARCH_FIELDS = [
  ...TEXT_SEARCH_LANGS.map((lang) => `product_name.${lang}`),
  ...TEXT_SEARCH_LANGS.map((lang) => `generic_name.${lang}`),
  ...TAXONOMY_FIELD_LANGS.map((lang) => `categories.${lang}`),
  ...TAXONOMY_FIELD_LANGS.map((lang) => `labels.${lang}`),
  'brands',
];

/**
 * Most words a text query may carry. Each word costs one clause per searched field twice over —
 * once in the backend's relevance match and once in its per-word group — against an Elasticsearch
 * ceiling of 4,228 clauses, which the backend reports as an error inside an HTTP 200. Live, 24
 * words answered normally and 45 hit the ceiling; words are counted as runs of letters and digits,
 * the most tokens the analyzers can split a query into, so a hyphenated word counts each part.
 */
export const MAX_QUERY_WORDS = 24;

/** Runs of letters and digits in a query — the upper bound `MAX_QUERY_WORDS` is checked against. */
export function countQueryWords(query: string): number {
  return query.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

/** How a word is compared against the stop lists: lowercased, keeping letters, marks, and digits. */
function stopWordKey(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

/**
 * The words exempt from the per-word groups: the stop words of the languages in `STOP_WORD_LANGS`
 * (English, French, Spanish, German, Italian — each holding at least 1% of named products), 949
 * words. Each language subfield (`product_name.fr`, `categories.fr`, …) runs that language's
 * analyzer, which removes its stop words before indexing, so a field can never match one: live, a
 * group for `de` over only `product_name.fr` or `categories.fr` matched no product, while
 * `product_name.en:de` matched 10,000+. A group requiring such a word keeps only products carrying
 * it in some other language's field, which guts ordinary queries (`chocolate with hazelnuts` 84
 * against 5,840, `confiture de fraise` 237 against 3,251). So these words form no group, whichever
 * language the caller meant: a required word fails toward zero, an optional one only toward
 * ranking. The cost is that a content word that is a stop word in one of these languages — `soy`
 * and `sea` (Spanish), `die`, `hat`, and `war` (German) — ranks results but no longer filters them.
 * Stop words of the other 26 languages still form groups; see `STOP_WORD_LANGS` for why.
 */
const STOP_WORDS = new Set(
  STOP_WORD_LANGS.flatMap((lang) =>
    ANALYZER_STOP_WORDS[lang].split(/\s+/).filter(Boolean).map(stopWordKey),
  ),
);

/**
 * The words of a lowercased query that each get a required group: whitespace-separated, holding a
 * letter or digit, not an exempt stop word (see `STOP_WORDS`), first occurrence only. A token with
 * no letter or digit analyzes to nothing in every field, and a fielded match on nothing matches no
 * product (live: `milk -` with a group for `-` → 0, without it → 6), so it forms no group.
 *
 * A query of one token gets none: the backend's relevance match already requires at least one of
 * its terms (it sets `minimum_should_match: 1` beside filters, and a should-only query needs one
 * anyway), so a lone word's group selects the same products (live: `milk` 6 with or without it)
 * while costing about 200 ms a search.
 */
function requiredWords(lowercasedQuery: string): string[] {
  const tokens = lowercasedQuery.split(/\s+/).filter((token) => token !== '');
  if (tokens.length < 2) return [];
  const words = tokens.filter(
    (word) => /[\p{L}\p{N}]/u.test(word) && !STOP_WORDS.has(stopWordKey(word)),
  );
  return [...new Set(words)];
}

/** One word required across every searched field: `(field1:word OR field2:word OR …)`. */
function wordGroup(word: string): string {
  const escaped = escapeLuceneQueryText(word);
  return `(${TEXT_SEARCH_FIELDS.map((field) => `${field}:${escaped}`).join(' OR ')})`;
}

/**
 * Largest `size` the autocomplete endpoint honors. Live-verified: it returns exactly the requested
 * option count up to 200 and caps below the request above that (500 answered 249), so a request is
 * clamped here rather than sent and silently under-served. Exported because the taxonomy service
 * asks for the whole pool to rank it.
 */
export const MAX_AUTOCOMPLETE_SIZE = 200;

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

/**
 * Lucene range form per nutrient comparison. Live-verified against search-a-licious: square
 * brackets parse to `gte`/`lte` and curly braces to `gt`/`lt`, with `*` as the open bound. The
 * bounds are numbers the schema already validated, so nothing caller-authored reaches the syntax.
 */
const NUTRIENT_RANGE_FORMS: Record<NutrientOperator, (value: number) => string> = {
  lt: (value) => `{* TO ${value}}`,
  lte: (value) => `[* TO ${value}]`,
  gt: (value) => `{${value} TO *}`,
  gte: (value) => `[${value} TO *]`,
};

/**
 * Keeps the search rows whose `code` a product lookup can serve — one matching `BARCODE_PATTERN`,
 * the rule `off_get_product` and `off_compare_products` enforce — and logs what was dropped. A row
 * without such a code has nothing to chain on, so it is omitted rather than handed on with a
 * barcode the next call refuses. No row without any `code` has been found (the text index holds
 * no document without one), but the text index does hold codes Product Opener refuses as "no code
 * or invalid code": 657 eight-character `00000###` codes and 7 thirteen-character
 * `0000000000###` ones (live 2026-09-23, `00000636` and `0000000000291` both answered `status: 0`).
 */
function withBarcodes<T extends { code?: string }>(
  rows: T[],
  ctx: Context,
): (T & { code: string })[] {
  const kept = rows.filter(
    (row): row is T & { code: string } =>
      typeof row.code === 'string' && BARCODE_PATTERN.test(row.code),
  );
  if (kept.length < rows.length) {
    ctx.log.info('Dropped search rows whose code no product lookup can serve', {
      dropped: rows.length - kept.length,
      codes: rows.flatMap((row) =>
        typeof row.code === 'string' && !BARCODE_PATTERN.test(row.code) ? [row.code] : [],
      ),
    });
  }
  return kept;
}

/**
 * This server's own budget refusal, raised before anything is sent. It is an ordinary
 * `rate_limited` failure on the wire — retryable, carrying `retryAfter` — and a distinct type only
 * so the retry boundary it is thrown inside can tell it apart from an upstream 429 and stop.
 */
class BudgetExhaustedError extends McpError {}

/**
 * Retry predicate for every upstream call. It is the framework default except that this server's
 * own budget refusal fails fast: the refusal must stay `retryable: true` on the wire — waiting and
 * retrying is exactly what the caller should do — and `withRetry` would otherwise read that flag
 * plus its `retryAfter` and sleep out the whole window inside the handler instead of returning.
 * Opting out by type keeps the two decisions independent.
 */
function isRetryableUpstreamFailure(error: unknown): boolean {
  return !(error instanceof BudgetExhaustedError) && defaultIsTransient(error);
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
   * Checks and records one upstream request. Called per attempt from inside the retry boundary, so
   * the configured per-minute number is the number of requests Open Food Facts can see from this
   * server rather than the number of logical operations it was asked for. Throws the declared
   * `rate_limited` failure when the budget is spent. The refusal is local — nothing was sent
   * upstream — so the message names this server rather than Open Food Facts, and carries the wait
   * until a slot frees.
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
      throw new BudgetExhaustedError(
        JsonRpcErrorCode.RateLimited,
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
  private readonly taxonomyLimiter: RateLimiter;

  constructor(config: ServerConfig) {
    this.baseUrl = config.baseUrl;
    this.productLimiter = new RateLimiter(config.rateLimitProduct);
    this.searchLimiter = new RateLimiter(config.rateLimitSearch);
    // Taxonomy resolution gets its own budget rather than sharing the search one: browsing the
    // vocabulary to build a filter would otherwise spend the budget for the search that filter is
    // for, and the two are answered by different endpoints with different costs upstream.
    this.taxonomyLimiter = new RateLimiter(config.rateLimitTaxonomy);
  }

  /**
   * Fetch a product by barcode.
   * Returns `null` when status:0 (barcode not found in any contributor record).
   * The caller is responsible for surfacing the not-found condition via ctx.fail.
   */
  async getProduct(barcode: string, ctx: Context): Promise<RawProduct | null> {
    return await withRetry(
      () => {
        this.productLimiter.check('product', ctx);
        const url = `${this.baseUrl}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${PRODUCT_FIELDS}`;
        ctx.log.debug('Fetching product', { barcode, url });
        return this.fetchProduct(url, barcode, ctx);
      },
      {
        operation: `OFF:getProduct:${barcode}`,
        context: ctx,
        baseDelayMs: 500,
        signal: ctx.signal,
        isTransient: isRetryableUpstreamFailure,
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
    return await withRetry(
      () => {
        this.productLimiter.check('product', ctx);
        const url = `${this.baseUrl}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;
        ctx.log.debug('Fetching product fields', { barcode, fields });
        return this.fetchProduct(url, barcode, ctx);
      },
      {
        operation: `OFF:getProductFields:${barcode}`,
        context: ctx,
        baseDelayMs: 500,
        signal: ctx.signal,
        isTransient: isRetryableUpstreamFailure,
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
        withExtra(ctx, { upstreamOperation: 'OFF:product' }),
        {
          signal: ctx.signal,
          headers: REQUEST_HEADERS,
          expectedStatuses: [404],
        },
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
   * the caller's retry boundary so the mapped code drives retry classification. A `jsonBody` makes
   * the request a POST carrying it as JSON; without one it is a GET.
   */
  private async fetchSearch(
    url: string,
    ctx: Context,
    operation: string,
    data: Record<string, unknown>,
    jsonBody?: Record<string, unknown>,
  ): Promise<Response> {
    try {
      return await fetchWithTimeout(
        url,
        REQUEST_TIMEOUT_MS,
        withExtra(ctx, { upstreamOperation: operation }),
        jsonBody === undefined
          ? { signal: ctx.signal, headers: REQUEST_HEADERS }
          : {
              signal: ctx.signal,
              method: 'POST',
              headers: { ...REQUEST_HEADERS, 'Content-Type': 'application/json' },
              body: JSON.stringify(jsonBody),
            },
      );
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
   * - `nutrient_filters` present: search.openfoodfacts.org, with or without free text. The
   *   comparisons compile to Lucene range clauses only this backend applies — /api/v2/search
   *   documents the equivalent parameters and ignores them, live-verified returning an identical
   *   unfiltered count for two mutually exclusive thresholds, so honoring them there would report
   *   an unfiltered result set under a nutrient constraint.
   * - Tag filters only: /api/v2/search (structured facet filtering).
   *
   * The two backends differ in freshness as well as in envelope: the text index is a snapshot that
   * lags the live database, while /api/v2/search reads it directly. The tool discloses which one
   * answered rather than presenting the two as interchangeable.
   */
  searchProducts(params: SearchParams, ctx: Context): Promise<SearchResult> {
    return params.query || params.nutrient_filters?.length
      ? this.searchProductsByText(params, ctx)
      : this.searchProductsByTags(params, ctx);
  }

  /**
   * Text search via search.openfoodfacts.org (search-a-licious). Serves every search carrying a
   * query or nutrient constraints, with or without tag filters: the filters are ANDed into the
   * Lucene `q` as hard clauses, and the query's words rank the results, each one `requiredWords`
   * selects also filtering them (see `buildTextSearchQuery`).
   *
   * Sent as a POST with the parameters in a JSON body. The GET form takes the same parameters and
   * answers identically (live: the same hits for the same `sort_by`, `page`, `page_size`, and
   * `fields`), but the per-word groups repeat every searched field for each word, and at 30
   * languages a 12-word query was already a 23.6 KB URL the host refused with HTTP 414.
   */
  private async searchProductsByText(params: SearchParams, ctx: Context): Promise<SearchResult> {
    return await withRetry(
      async () => {
        this.searchLimiter.check('search', ctx);
        const page = params.page ?? 1;
        const pageSize = params.page_size ?? 20;
        const body = {
          q: this.buildTextSearchQuery(params),
          langs: TEXT_SEARCH_LANGS,
          fields: SEARCH_FIELDS,
          page,
          page_size: pageSize,
          // search-a-licious sorts on a bare field name ascending and on a `-` prefix descending,
          // and rejects an unknown field with HTTP 400. /api/v2/search reads the same bare value
          // as descending, so the prefix keeps one enum value meaning one thing on both paths.
          ...(params.sort_by && { sort_by: `-${params.sort_by}` }),
        };

        ctx.log.debug('Text-searching products', { query: params.query, q: body.q });

        const response = await this.fetchSearch(
          `${TEXT_SEARCH_BASE_URL}/search`,
          ctx,
          'OFF:searchProductsByText',
          { page, page_size: pageSize },
          body,
        );

        const data = await parseJsonBody<RawTextSearchResponse>(response, ctx, { page });

        if (data.errors?.length) {
          const detail = plainTextDetail(
            data.errors.map((error) => error.description ?? error.title ?? '').join('; '),
          );
          throw contractError(
            'upstream_error',
            `Open Food Facts text search failed inside its search engine${detail ? `: ${detail}` : '.'}`,
            ctx,
            { page, page_size: pageSize },
          );
        }

        ctx.log.debug('Text search response received', {
          count: data.count,
          count_is_exact: data.is_count_exact,
          page: data.page,
          returned: data.hits?.length ?? 0,
        });

        // Normalize text search hits to the row shape (brands is array → join to string).
        // Use spread of defined-only fields to satisfy exactOptionalPropertyTypes.
        const hits = data.hits ?? [];
        const products: SearchRow[] = withBarcodes(hits, ctx).map((hit) => {
          const brands = Array.isArray(hit.brands) ? hit.brands.join(', ') : hit.brands;
          return {
            code: hit.code,
            ...(hit.product_name !== undefined && { product_name: hit.product_name }),
            ...(brands !== undefined && { brands }),
            ...(hit.nutriscore_grade !== undefined && { nutriscore_grade: hit.nutriscore_grade }),
            ...(hit.nova_group !== undefined && { nova_group: hit.nova_group }),
            ...(hit.ecoscore_grade !== undefined && { ecoscore_grade: hit.ecoscore_grade }),
            ...(hit.categories_tags !== undefined && { categories_tags: hit.categories_tags }),
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
          dropped: hits.length - products.length,
        };
      },
      {
        operation: 'OFF:searchProductsByText',
        context: ctx,
        baseDelayMs: 1_000,
        signal: ctx.signal,
        isTransient: isRetryableUpstreamFailure,
      },
    );
  }

  /**
   * Tag-only search via /api/v2/search — structured facet filtering for requests carrying neither a
   * text query nor nutrient constraints. Those route through searchProductsByText instead, which
   * folds the tag facets into the Lucene `q`.
   */
  private async searchProductsByTags(params: SearchParams, ctx: Context): Promise<SearchResult> {
    return await withRetry(
      async () => {
        this.searchLimiter.check('search', ctx);
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

        const rows = data.products ?? [];
        const products = withBarcodes(rows, ctx);
        return {
          count: data.count ?? 0,
          // This endpoint counts every match — live-verified returning totals more than twenty
          // times the ceiling the text backend stops counting at — so its count is never a floor.
          count_is_exact: true,
          page: data.page ?? 1,
          page_count: products.length,
          page_size: data.page_size ?? params.page_size ?? 20,
          products,
          dropped: rows.length - products.length,
        };
      },
      {
        operation: 'OFF:searchProductsByTags',
        context: ctx,
        baseDelayMs: 1_000,
        signal: ctx.signal,
        isTransient: isRetryableUpstreamFailure,
      },
    );
  }

  /**
   * Resolve a term against a live Open Food Facts taxonomy through the search-a-licious
   * autocomplete endpoint, returning its suggestions in upstream order. Ranking, filtering, and
   * what to do when the call fails are the caller's to decide — this method only fetches.
   *
   * `size` caps the options returned and is the endpoint's only paging knob: it accepts no offset
   * or cursor, and passing one is ignored rather than rejected, so there is no way to reach past
   * the first `size` suggestions. The endpoint is a suggester over display names, not an
   * enumerator — it reports no match total and answers an empty list for an empty term.
   */
  async suggestTaxonomy(
    taxonomyName: string,
    term: string,
    size: number,
    ctx: Context,
  ): Promise<{ id: string; name: string }[]> {
    return await withRetry(
      async () => {
        this.taxonomyLimiter.check('taxonomy', ctx);
        const url = new URL(`${TEXT_SEARCH_BASE_URL}/autocomplete`);
        url.searchParams.set('q', term);
        url.searchParams.set('taxonomy_names', taxonomyName);
        url.searchParams.set('size', String(Math.min(size, MAX_AUTOCOMPLETE_SIZE)));

        ctx.log.debug('Resolving taxonomy term', { taxonomyName, term, url: url.toString() });

        const data = await parseJsonBody<RawAutocompleteResponse>(
          await this.fetchSearch(url.toString(), ctx, 'OFF:suggestTaxonomy', {
            taxonomy_name: taxonomyName,
            term,
          }),
          ctx,
          { taxonomy_name: taxonomyName, term },
        );

        // An option missing either half is unusable as a filter value or a display name, so it is
        // dropped rather than passed on with an invented placeholder.
        return (data.options ?? []).flatMap((option) =>
          option.id && option.text ? [{ id: option.id, name: option.text }] : [],
        );
      },
      {
        operation: `OFF:suggestTaxonomy:${taxonomyName}`,
        context: ctx,
        baseDelayMs: 500,
        signal: ctx.signal,
        isTransient: isRetryableUpstreamFailure,
      },
    );
  }

  /**
   * Build the search-a-licious Lucene `q` from a text query plus tag filters, in this order: tag
   * clauses, exclusion clauses, nutrient range clauses, one required group per query word, then
   * the query's bare words. Recognized `field:"value"` facet clauses become hard AND filters — one
   * clause per value, so several labels all apply — and a top-level `-field:"value"` clause
   * excludes (live: `-allergens_tags:"en:milk"` and `allergens_tags:"en:milk"` partition a
   * country's products exactly). An exclusion value must be canonical: a value the field does not
   * hold excludes nothing, so the tool refuses unconfirmed ones before they reach here.
   *
   * Facet field names differ from /api/v2/search: nutrition grade → `nutriscore_grade`, NOVA →
   * `nova_group` (no `_tags` suffix); the tag facets keep their names. Tag values are quoted so
   * their `:` and spaces aren't parsed as query syntax, and are quoted verbatim — the `*_tags`
   * fields are exact-match keywords, so the caller hands in canonical values (the tool runs each
   * through the taxonomy service's canonicalizer first). The bare score/nova tokens carry no such
   * characters and stay unquoted.
   *
   * The deployed backend (search-a-licious v1.4.0) joins top-level bare words into one relevance
   * match that ORs them, so on their own they count products matching any word. Each required
   * word therefore also gets a parenthesized OR group over the fields that match searches (see
   * `requiredWords` for which words qualify), and top-level groups are ANDed as filters; the bare
   * words stay for ranking. Nothing else may sit beside them at top level: an explicit `AND`, a
   * quoted phrase, or `+word` there moves the words into a filter on field `*` that matches
   * nothing. So the query is lowercased — which turns a caller's `AND`/`OR`/`NOT`/`TO` into plain
   * words, since the parser reserves only the uppercase forms, and costs nothing because every
   * analyzer lowercases — and escaped rather than quoted, so it cannot smuggle in its own
   * field:value clauses (see LUCENE_RESERVED_CHARS).
   *
   * `additives_tag` has no clause here on purpose. The search-a-licious index carries no
   * `additives_tags` field, so a clause naming it is parsed as a phrase match against a field that
   * does not exist and returns zero hits with no error — live-verified across several E-numbers
   * that match hundreds of thousands of products on the tag path. The tool rejects that
   * combination up front rather than sending a filter that silently empties the result set.
   *
   * Nutrient constraints become nested range clauses under the `nutriments.` prefix, which is not
   * optional: a clause naming a bare `sugars_100g` answers HTTP 200 with zero hits and no error —
   * the same silent-empty failure `additives_tag` has to be refused for.
   */
  private buildTextSearchQuery(params: SearchParams): string {
    const clauses: string[] = [];
    if (params.categories_tag) clauses.push(`categories_tags:"${params.categories_tag}"`);
    if (params.brands_tag) clauses.push(`brands_tags:"${params.brands_tag}"`);
    for (const label of [params.labels_tag ?? []].flat()) clauses.push(`labels_tags:"${label}"`);
    if (params.allergens_tag) clauses.push(`allergens_tags:"${params.allergens_tag}"`);
    if (params.traces_tag) clauses.push(`traces_tags:"${params.traces_tag}"`);
    if (params.ingredients_analysis_tag) {
      clauses.push(`ingredients_analysis_tags:"${params.ingredients_analysis_tag}"`);
    }
    if (params.nutrition_grade) clauses.push(`nutriscore_grade:${params.nutrition_grade}`);
    if (params.nova_group) clauses.push(`nova_group:${params.nova_group}`);
    if (params.countries_tag) clauses.push(`countries_tags:"${params.countries_tag}"`);
    for (const allergen of params.exclude_allergens ?? []) {
      clauses.push(`-allergens_tags:"${allergen}"`);
    }
    for (const trace of params.exclude_traces ?? []) clauses.push(`-traces_tags:"${trace}"`);
    for (const filter of params.nutrient_filters ?? []) {
      clauses.push(
        `nutriments.${filter.nutrient}_100g:${NUTRIENT_RANGE_FORMS[filter.operator](filter.value)}`,
      );
    }
    if (params.query) {
      const query = params.query.toLowerCase();
      clauses.push(...requiredWords(query).map(wordGroup), escapeLuceneQueryText(query));
    }
    return clauses.join(' ');
  }

  /**
   * Build the `/api/v2/search` URL. Product Opener reads a `*_tags` value as a comma-separated AND
   * list in which a `-` prefix negates (`add_params_to_query` in `lib/ProductOpener/Display.pm`),
   * so several labels, and an allergen or trace inclusion with its exclusions, each travel as one
   * parameter (live: `allergens_tags=en:nuts,-en:milk` narrows `en:nuts` to the products without
   * milk). A parameter is set only when a value for it is, so a request without the newer filters
   * is the one this path always sent.
   */
  private buildSearchUrl(params: SearchParams): string {
    const url = new URL(`${this.baseUrl}/api/v2/search`);
    /** One `*_tags` value: the inclusions, then each exclusion negated. */
    const tagList = (include: (string | undefined)[], exclude: string[] = []) =>
      [...include.filter(Boolean), ...exclude.map((value) => `-${value}`)].join(',');
    const setTags = (param: string, value: string) => {
      if (value) url.searchParams.set(param, value);
    };

    url.searchParams.set('fields', SEARCH_FIELDS.join(','));
    if (params.categories_tag) url.searchParams.set('categories_tags', params.categories_tag);
    if (params.brands_tag) url.searchParams.set('brands_tags', params.brands_tag);
    setTags('labels_tags', tagList([params.labels_tag ?? []].flat()));
    setTags('allergens_tags', tagList([params.allergens_tag], params.exclude_allergens));
    setTags('traces_tags', tagList([params.traces_tag], params.exclude_traces));
    if (params.ingredients_analysis_tag) {
      url.searchParams.set('ingredients_analysis_tags', params.ingredients_analysis_tag);
    }
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
