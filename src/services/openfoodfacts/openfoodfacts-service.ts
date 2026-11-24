/**
 * @fileoverview Open Food Facts API client with retry, rate limiting, and error normalization: API v2
 * reads, plus the API v3.5 read of a record's stored nutrition sets that supplies the as-sold
 * figures a prepared-only v2 read leaves out. Barcode reads and searches by tag filters alone are
 * served from the local export mirror when one is configured (`OFF_MIRROR_PATH`) and ready, and
 * read live otherwise; every result names the source that answered it. Requires the identifying
 * User-Agent per OFF terms of service.
 * @module services/openfoodfacts/openfoodfacts-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import {
  defaultIsTransient,
  fetchWithTimeout,
  logger,
  type RetryAttempt,
  withExtra,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig, type ServerConfig } from '@/config/server-config.js';
import {
  getByCodes,
  heldTags,
  type MirrorDoc,
  type MirrorTagFilter,
  type MirrorTagSearch,
  searchByTags,
} from '@/services/mirror/mirror-queries.js';
import {
  getMirrorStore,
  indexesBrandKeys,
  indexesGreenScore,
  isMirrorReady,
  mirrorAsOf,
} from '@/services/mirror/mirror-store.js';
import { fieldsNewerThan } from '@/services/mirror/record-builder.js';
import { untilCancelled } from '@/utils/until-cancelled.js';
import {
  type AsSoldSelection,
  type NutritionInputSet,
  readInputSets,
  selectAsSoldSet,
} from './nutrition-sets.js';
import {
  BARCODE_PATTERN,
  type IndexedNutriments,
  indexedNutrientKey,
  type NutrientField,
  type NutrientFilter,
  type NutrientOperator,
  PRODUCT_FIELD_NAMES,
  type RawAutocompleteResponse,
  type RawNutriments,
  type RawProduct,
  type RawProductResponse,
  type RawSearchProduct,
  type RawSearchResponse,
  type RawTaxonomyOption,
  type RawTextSearchHit,
  type RawTextSearchResponse,
  type SearchParams,
  type SearchResult,
  type SearchRow,
  type TagValue,
} from './types.js';
import { USER_AGENT } from './user-agent.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Total budget of one autocomplete lookup, every attempt and backoff included. `REQUEST_TIMEOUT_MS`
 * bounds one attempt only, and left alone a hung upstream holds a read for over 60 s, the default
 * request timeout of MCP SDK clients, so the caller gives up before a typed failure reaches it.
 * A search runs its lookups in parallel and then one search read, so one caller's longest chain
 * is this plus `READ_RETRY_DEADLINE_MS`: 55 s. The taxonomy service counts it from each caller's
 * own call: a search that joined a lookup whose first caller cancelled restarts it with what is
 * left of its 20 s, so the restart stays inside that chain too.
 */
export const TAXONOMY_RETRY_DEADLINE_MS = 20_000;

/** Total budget of one product or search read. See `TAXONOMY_RETRY_DEADLINE_MS`. */
const READ_RETRY_DEADLINE_MS = 35_000;

/**
 * Total budget of the stored as-sold read that follows a product read returning only prepared
 * figures. It starts once that read has settled, so a call's longest chain is
 * `READ_RETRY_DEADLINE_MS` plus this: 55 s, the bound a search with tag lookups already keeps.
 */
const AS_SOLD_RETRY_DEADLINE_MS = 20_000;

/** Headers sent on every upstream request. The identifying User-Agent is required by OFF terms. */
const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json',
};

/**
 * search.openfoodfacts.org (search-a-licious) refuses any request whose `page * page_size` exceeds
 * this many results, with an HTTP 422 naming the window. Exported so the search tool can reject
 * those requests before they are sent. Scoped to the text path; the tag-only backend has its own,
 * page-based bound (`TAG_SEARCH_MAX_PAGE`), and the mirror its own window
 * (`MIRROR_SEARCH_RESULT_WINDOW`).
 *
 * This bounds how deep a request may page — it is deliberately not reused to detect a clipped hit
 * count. That ceiling is a separate limit in the same backend that happens to sit at the same
 * number today, and the response reports it directly via `is_count_exact`, so reading the flag
 * survives either limit moving independently.
 */
export const TEXT_SEARCH_RESULT_WINDOW = 10_000;

/**
 * Most results a search served from the mirror reaches: a page whose `page * page_size` exceeds it
 * is refused before the store runs the search. Mirror reads are synchronous SQLite calls on the
 * serving process, so the work one page costs is time every other caller of that process waits,
 * and this bounds it. It matches `TEXT_SEARCH_RESULT_WINDOW`, so a caller pages to the same depth
 * whichever of the two answers, but it is this server's own bound, not an upstream one, and the
 * two can move apart. Exported so the search tool can refuse such a page before calling.
 */
export const MIRROR_SEARCH_RESULT_WINDOW = 10_000;

/**
 * Deepest page `/api/v2/search` serves a client that is not logged in. Product Opener answers any
 * page past it with HTTP 401 and a rendered `robots_not_served_here` page before running the query
 * (`search_and_display_products` in `lib/ProductOpener/Display.pm`), whatever the `page_size` and
 * however few products match — live, page 11 was refused at `page_size` 1 and on a filter matching
 * nothing, while page 10 at `page_size` 50 was served. Exported so the search tool can reject a
 * deeper page before it is sent and report the reachable depth. The mirror serves deeper pages, up
 * to `MIRROR_SEARCH_RESULT_WINDOW`, so `searchProducts` refuses a deeper `tags_confirmed` page by
 * this bound only once the mirror cannot serve it.
 */
export const TAG_SEARCH_MAX_PAGE = 10;

/**
 * Failure reasons this service raises, mapped to the wire code each tool declares for them in its
 * `errors: [...]` contract. Errors leave the service carrying `reason`, and the framework fills the
 * calling tool's declared `recovery.hint` from it, so both client surfaces satisfy the contract
 * without any handler-side try/catch.
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
 * request it refuses before searching with a `detail` naming the exact constraint that was
 * violated — a string on a GET, and on a POST whose JSON body fails validation a list of objects
 * whose `msg` says why (each also echoes the whole request under `input`, which is noise here, so
 * only the messages are kept). A search it refuses or fails while querying (2.x) carries an
 * `errors` list instead, read by `searchErrorsDetail`. Anything else falls back to a short snippet
 * so the caller still learns why the request was refused.
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
    const parsed = JSON.parse(body) as { detail?: unknown; errors?: unknown };
    if (typeof parsed.detail === 'string') return plainTextDetail(parsed.detail);
    if (Array.isArray(parsed.detail)) {
      const messages = parsed.detail.flatMap((entry: { msg?: unknown }) =>
        typeof entry?.msg === 'string' ? [entry.msg] : [],
      );
      if (messages.length > 0) return plainTextDetail(messages.join('; '));
    }
    const explained = searchErrorsDetail(parsed.errors);
    if (explained) return explained;
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
 * would land there as syntax. A tag spans no other `<`, which keeps every pass linear in the
 * body's length, as the text path's larger capture (`TEXT_SEARCH_ERROR_BODY_LIMIT`) needs.
 * Returns `undefined` when nothing readable survives. Exported for its timing test.
 */
export function plainTextDetail(body: string): string | undefined {
  const text = body
    .replace(/<[^<>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PLAIN_TEXT_DETAIL_LIMIT)
    .trim();
  return text === '' ? undefined : text;
}

/**
 * The explanation a search-a-licious `errors` list carries (`RawTextSearchResponse.errors`): each
 * entry's `description`, or its `title` when it has none, joined. A `QueryCheckError` lists every
 * field the query named that the index lacks, one per line. `undefined` for anything that is not
 * such a list or explains nothing.
 */
function searchErrorsDetail(errors: unknown): string | undefined {
  if (!Array.isArray(errors)) return;
  const messages = errors.flatMap((entry: { description?: unknown; title?: unknown }) => {
    const text = [entry?.description, entry?.title].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    );
    return text === undefined ? [] : [text];
  });
  return messages.length > 0 ? plainTextDetail(messages.join('; ')) : undefined;
}

/**
 * Fields of a framework fetch error this service republishes on the public failure. An allowlist,
 * not a filter: `fetchWithTimeout` is free to attach whatever diagnostics it needs — including the
 * captured response body, twice — and the contract is what this server chooses to publish, not
 * whatever happened to be on the error. Everything else the caller needs (`reason`, `retryable`,
 * the per-call context) is added at the throw site.
 */
const PUBLISHED_ERROR_FIELDS = ['status', 'retryAfter', 'retryAttempts', 'operation'] as const;

/**
 * The published subset of a fetch error's data. `retryAfter` is published in whole seconds, the
 * unit this server's own budget refusals carry, so a caller reads one type on every failure: the
 * framework captures the raw header, and one it cannot read is dropped rather than passed on.
 */
function publishedErrorData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  const published: Record<string, unknown> = {};
  for (const field of PUBLISHED_ERROR_FIELDS) {
    if (data?.[field] !== undefined) published[field] = data[field];
  }
  if (published.retryAfter !== undefined) {
    const seconds = retryAfterSeconds(published.retryAfter);
    if (seconds === undefined) delete published.retryAfter;
    else published.retryAfter = seconds;
  }
  return published;
}

/** An HTTP-date opens with its day name in each of RFC 9110's three formats. */
const HTTP_DATE_DAY = /^(?:mon|tue|wed|thu|fri|sat|sun)/i;

/**
 * A `Retry-After` value as whole seconds from now: delta-seconds as given, an HTTP-date as the
 * seconds left (rounded up, never below 0). Anything else is unreadable. The day-name check keeps a
 * numeric value that is not delta-seconds (`1.5`) from being read as a calendar date.
 */
function retryAfterSeconds(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? Math.ceil(raw) : undefined;
  if (typeof raw !== 'string') return;
  const value = raw.trim();
  if (/^\d+$/.test(value)) return Number(value);
  if (!HTTP_DATE_DAY.test(value)) return;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * Parses a 2xx body as JSON, catching the rendered error page Open Food Facts serves with a 200
 * under load. The body is read exactly once — reading it as text to sniff for markup and then
 * calling `response.json()` would fail on the already-consumed stream. A body that does not parse
 * is the same retryable `upstream_error`: left as a bare `SyntaxError`, it reached the caller as a
 * `ValidationError` naming no reason, as though the caller's input were at fault.
 *
 * `fetchWithTimeout` returns at the headers and hands its deadline to the body, so a body that
 * stalls or drops fails here, outside the `toContractError` around the fetch, and is mapped here
 * instead (see `bodyReadFailure`).
 */
async function parseJsonBody<T>(response: Response, data: Record<string, unknown>): Promise<T> {
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const body = isJson
    ? undefined
    : await response.text().catch((error: unknown) => {
        throw bodyReadFailure(error, data);
      });
  if (body !== undefined && looksLikeHtml(body)) {
    throw contractError(
      'upstream_error',
      'Open Food Facts served an HTML page instead of JSON — the service is rate-limiting or temporarily down.',
      data,
    );
  }
  try {
    return (body === undefined ? await response.json() : JSON.parse(body)) as T;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw bodyReadFailure(error, data);
    throw contractError(
      'upstream_error',
      'Open Food Facts answered with a body that is not valid JSON — the service is likely degraded.',
      data,
      error,
    );
  }
}

/**
 * The failure for a rejected body read. `fetchWithTimeout` classifies every failure of a 2xx body
 * stream: a stall or a caller abort keeps its own path and a cancellation stays one, while a
 * connection closed part-way through the body, with neither signal behind it, is its
 * `ServiceUnavailable` network error (`errorSource: 'FetchNetworkErrorWrapper'`). That one is named
 * as the dropped connection it is: a retryable `upstream_error` whose message names Open Food Facts,
 * the wrapper and the runtime's own error kept to `cause`, since that text names this runtime and
 * can carry advice meant for fetch's caller.
 *
 * Mapped here, not in `toContractError`, which also catches around the fetch: the same network
 * error raised there, before the headers, is no dropped answer, and what it passes through is a
 * programming error (in `JSON.stringify` of a request body, say) that must not read as one either.
 */
function bodyReadFailure(error: unknown, data: Record<string, unknown>): unknown {
  if (error instanceof McpError && error.data?.errorSource === 'FetchNetworkErrorWrapper') {
    return contractError(
      'upstream_error',
      'Open Food Facts closed the connection before finishing its answer.',
      data,
      error,
    );
  }
  return toContractError(error, data);
}

/** A JSON object — not `null`, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The failure for a 2xx body that parses as JSON but fails its read's envelope rule — the result
 * fields every genuine answer carries are missing or mistyped. Read as an answer, such a body
 * becomes a factual absence: a product "not found", a search with zero matches, a term with no
 * tag. Product Opener sends exactly that shape when its database query fails (its search response
 * gains `count` only after the query succeeds), so it is the retryable `upstream_error`, raised
 * inside the retry boundary like an HTML page served with a 200.
 */
function malformedEnvelope(
  read: string,
  expected: string,
  data: Record<string, unknown>,
): McpError {
  return contractError(
    'upstream_error',
    `Open Food Facts answered the ${read} with a malformed response (expected ${expected}) — the service is likely degraded.`,
    data,
  );
}

/**
 * The failure for a search-a-licious answer flagged `timed_out`. Elasticsearch stopped collecting
 * early, so the 200 carries the whole success shape over a partial or empty result, and a page or
 * count read from it would be wrong however complete it looks. It is the retryable
 * `upstream_timeout`, raised inside the retry boundary like an `errors` envelope.
 */
function timedOutAnswer(read: string, data: Record<string, unknown>): McpError {
  return contractError(
    'upstream_timeout',
    `Open Food Facts timed out inside its search engine while answering the ${read}, so the answer is incomplete.`,
    data,
  );
}

/**
 * A product lookup's answer: not found (`status: 0`), or found (`status: 1`) with a product
 * object — `{}` included, which is a found product with nothing entered for the requested fields.
 */
function isProductEnvelope(
  body: unknown,
): body is RawProductResponse & ({ status: 0 } | { status: 1; product: RawProduct }) {
  return isRecord(body) && (body.status === 0 || (body.status === 1 && isRecord(body.product)));
}

/**
 * A v3.5 product read's found answer: `status` `success` or `success_with_warnings`, `result.id`
 * `product_found`, and a product object whose `nutrition`, when present, is an object. Whether
 * `nutrition.input_sets` is a list is `readInputSets`'s to say.
 */
function isInputSetsEnvelope(
  body: unknown,
): body is { product: { nutrition?: Record<string, unknown> } } {
  return (
    isRecord(body) &&
    (body.status === 'success' || body.status === 'success_with_warnings') &&
    isRecord(body.result) &&
    body.result.id === 'product_found' &&
    isRecord(body.product) &&
    (body.product.nutrition === undefined || isRecord(body.product.nutrition))
  );
}

/**
 * How the stored as-sold read settled: the chosen set, `none` when no stored set qualifies, or
 * `unread` with the failure. An unread set is a supplement that could not be read, never a failed
 * call, so the failure is handed back rather than thrown.
 */
export type StoredAsSoldRead = AsSoldSelection | { status: 'unread'; error: McpError };

/**
 * Where a read was answered: the live Open Food Facts API, or the local export mirror, whose data
 * reflects every product contributed or edited up to `mirrorAsOf` (ISO 8601: the end of the last
 * applied delta, or the newest change in the export the last full load read; while a full load
 * runs, no later than the newest change among the rows it has written).
 */
export type ReadSource = { source: 'off_api' } | { source: 'off_mirror'; mirrorAsOf: string };

/**
 * Requested fields a mirror row predates, which a read answered from that row lacks: the live read
 * that tries them first either failed with `error` or found no product under the barcode, or, for
 * a read that serves such a row as it is (`PredatedFields` `serve_row`), was `skipped`.
 */
export type UnreadFields = { fields: readonly string[] } & (
  | { outcome: 'failed'; error: McpError }
  | { outcome: 'not_found' }
  | { outcome: 'skipped' }
);

/**
 * What a product read does with requested fields the mirror row it finds predates. `read_live`
 * reads the product live for them, and serves the row without them only when that read fails or
 * finds nothing. `serve_row` serves the row without them and sends nothing, for a read that must
 * not spend a request on fields the copy will hold once a reload rewrites the row.
 */
export type PredatedFields = 'read_live' | 'serve_row';

/**
 * A found product and where it was read. `product` holds only the v2 fields the read asked for,
 * as the live API returns them. A mirror read also carries `storedSets`, the record's stored
 * nutrition sets from the same stored revision as `product` (`undefined` when it stores none),
 * which `readStoredAsSold` selects the as-sold figures from without a request, and `unread` when
 * its row predates requested fields the read did not supply.
 */
export type ProductRead =
  | { source: 'off_api'; product: RawProduct }
  | {
      source: 'off_mirror';
      mirrorAsOf: string;
      product: RawProduct;
      storedSets: readonly NutritionInputSet[] | undefined;
      unread?: UnreadFields;
    };

/** A product the mirror holds, and which requested fields its row predates (none to serve it as is). */
type MirroredProduct = {
  read: Extract<ProductRead, { source: 'off_mirror' }>;
  predates: string[];
};

/**
 * A search as the search tool hands it over. `tags_confirmed` marks a search by tag filters alone
 * whose every value is canonical and confirmed: each tag value is the `value` the taxonomy
 * service's `canonicalizeTag` returned with `resolution: 'vocabulary'`, and a brand is the ones of
 * its keys (`brandKeys`: its spellings and its Open Food Facts synonyms) the mirror holds products
 * under (`mirrorHeldBrand`), any of which matches; exclusions are confirmed before they are sent at
 * all; `nutrition_grade`, `nova_group`, `ecoscore_grade`, and `ingredients_analysis_tag` are closed
 * vocabularies the tool's input schema enforces. Only such a search is served from the mirror,
 * which matches stored tags exactly, one carrying `ecoscore_grade` only once the mirror indexes
 * Green-Score (`mirrorIndexesGreenScore`), and one carrying `brands_tag` only once it keys every
 * brand (`mirrorIndexesBrandKeys`). Without it a search by tag filters alone reads
 * `/api/v2/search`, which canonicalizes what it is given.
 */
export type ProductSearch = SearchParams & { tags_confirmed?: boolean };

/**
 * A search's answer, and where it was read. `textIndexAsOf`, set only on an answer the text index
 * served and only while this service holds it, is the newest `last_modified_t` in that index as
 * an ISO 8601 time: a product contributed or edited since is missing from the answer or matched
 * as it was then.
 */
type SearchRead = SearchResult & ReadSource & { textIndexAsOf?: string };

/**
 * What the service holds of the text index's date: nothing yet, the one probe in flight, the date
 * and when it was read, or when the last probe failed.
 */
type TextIndexDate =
  | { status: 'unprobed' }
  | { status: 'probing'; probe: Promise<string | undefined> }
  | { status: 'known'; asOf: string; readAt: number }
  | { status: 'failed'; failedAt: number };

/**
 * How a search settled: served, or refused with nothing sent and no search run, naming the bound
 * the page passed. `live_max_page`: a `tags_confirmed` search the mirror could not serve after all
 * (not ready, not yet indexing a Green-Score filter it carries, or a store error) asks for a page
 * past `TAG_SEARCH_MAX_PAGE`, which the live API refuses; the search tool lets such a page through
 * its own check only when the mirror is ready and every value confirmed. `mirror_window`: the
 * mirror is ready to serve the search, and its
 * `page * page_size` exceeds `MIRROR_SEARCH_RESULT_WINDOW`.
 */
export type SearchOutcome =
  | ({ status: 'served' } & SearchRead)
  | { status: 'page_out_of_range'; bound: 'live_max_page' | 'mirror_window' };

/** A tag search's answer: a `products` list and a numeric `count`, zero for no matches. */
function isTagSearchEnvelope(
  body: unknown,
): body is RawSearchResponse & { count: number; products: RawSearchProduct[] } {
  return isRecord(body) && Array.isArray(body.products) && Number.isFinite(body.count);
}

/**
 * A text search's answer: a `hits` list, a numeric `count`, and the boolean `is_count_exact` —
 * all three required by search-a-licious's success schema and present in every live answer.
 */
function isTextSearchEnvelope(body: RawTextSearchResponse): body is RawTextSearchResponse & {
  count: number;
  hits: RawTextSearchHit[];
  is_count_exact: boolean;
} {
  return (
    Array.isArray(body.hits) &&
    Number.isFinite(body.count) &&
    typeof body.is_count_exact === 'boolean'
  );
}

/** An autocomplete answer: an `options` list, empty when nothing matched. */
function isAutocompleteEnvelope(
  body: unknown,
): body is RawAutocompleteResponse & { options: RawTaxonomyOption[] } {
  return isRecord(body) && Array.isArray(body.options);
}

/**
 * Builds a failure carrying the reason and retryability the calling tool declares; the framework
 * fills that tool's recovery hint from the reason. `retryable` is emitted for every reason, not just
 * the non-retryable one, so a client reading `data.retryable` gets an answer rather than an absence
 * it has to interpret. Only an upstream rejection is non-retryable — the request as formed will be
 * refused again.
 */
function contractError(
  reason: UpstreamReason,
  message: string,
  data: Record<string, unknown>,
  cause?: unknown,
): McpError {
  return new McpError(
    REASON_CODES[reason],
    message,
    { ...data, reason, retryable: reason !== 'upstream_rejected' },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Re-raises a framework fetch error as the declared contract failure. Called inside the retry
 * boundary so the mapped reason — not the raw code — drives `withRetry`'s transient
 * classification: 5xx other than 501, timeouts, and 429s stay retryable while a 4xx or a 501 fails
 * immediately.
 */
function toContractError(error: unknown, data: Record<string, unknown>): unknown {
  if (!(error instanceof McpError)) return error;
  // A caller-cancelled request is not an upstream failure — leave it untouched.
  if (error.data?.errorSource === 'FetchAborted') return error;

  const reason = reasonFor(error);
  const status = error.data?.status;
  const detail = upstreamDetail(error.data?.body, reason);
  const message =
    `${REASON_MESSAGES[reason]}${typeof status === 'number' ? ` (HTTP ${status})` : ''}` +
    `${detail ? `: ${detail}` : '.'}`;

  return contractError(reason, message, { ...publishedErrorData(error.data), ...data }, error);
}

/** Fields to request on every product fetch — scopes the ~200-key object to what we handle. */
const PRODUCT_FIELDS = PRODUCT_FIELD_NAMES.join(',');

/**
 * The fields a mirror read answers a product read with: every field `PRODUCT_FIELDS` requests, the
 * doc's and the dates its row's columns hold, and no other. A field read naming anything else is
 * read live, and so, first, is one naming a field the row's record version predates
 * (`fieldsNewerThan`, which no date is), unless it serves such a row as it is (`serve_row`).
 */
const MIRROR_PRODUCT_FIELDS: ReadonlySet<string> = new Set(PRODUCT_FIELD_NAMES);

/**
 * Fields to request on search results — summary rows for triage — as a v2 read names them: the
 * tag path's `fields`, the mirror's projection, and the keys of every search row. The text path asks
 * for the same fields under the index's names (`TEXT_SEARCH_RESULT_FIELDS`).
 */
const SEARCH_FIELDS = [
  'code',
  'product_name',
  'brands',
  'quantity',
  'nutriscore_grade',
  'nova_group',
  'ecoscore_grade',
  'categories_tags',
  'completeness',
  'last_modified_t',
  'created_t',
];

/** `SEARCH_FIELDS`, as the mirror projects a stored doc, dated from its row, to a search row. */
const SEARCH_FIELD_SET: ReadonlySet<string> = new Set(SEARCH_FIELDS);

/**
 * `SEARCH_FIELDS` as the text index names them, in the same order: `categories` for
 * `categories_tags` and `environmental_score_grade` for `ecoscore_grade`. The index leaves a field
 * it does not know out of every hit without an error, so asking under the v2 names returns rows
 * missing both. `searchProductsByText` maps each hit back to the row keys.
 */
const TEXT_SEARCH_RESULT_FIELDS = [
  'code',
  'product_name',
  'brands',
  'quantity',
  'nutriscore_grade',
  'nova_group',
  'environmental_score_grade',
  'categories',
  'completeness',
  'last_modified_t',
  'created_t',
];

/**
 * Text search endpoint — search.openfoodfacts.org runs search-a-licious 2.x over Elasticsearch and
 * actually filters by the query text. The /api/v2/search endpoint silently ignores search_terms
 * and returns all products. The same host serves the taxonomy autocomplete used to resolve tag IDs.
 *
 * Its index lags the live database (live 2026-11-24: its newest record was 14 hours old and did
 * not move in 12 minutes), so this path and the tag-only path can answer the same filters
 * differently, and a product contributed since that record is absent here. Its API names no index
 * date, so the service dates the lag itself: the newest `last_modified_t` the index holds, read by
 * a cached probe sent beside a text search (`textIndexDate`).
 */
const TEXT_SEARCH_BASE_URL = 'https://search.openfoodfacts.org';

/**
 * Bytes of a failed text search's body kept for its message, against the framework's default
 * 500. search-a-licious 2.x explains a refused or failed search in an `errors` list that follows a
 * `debug` object, and a `QueryCheckError` names every field it rejects on a line of its own, so
 * such a body outgrows the default, whose head-and-tail cut leaves JSON that no longer parses.
 * 16 KiB is what the framework reads of an error body at most, so any body it reads whole is kept
 * whole.
 */
const TEXT_SEARCH_ERROR_BODY_LIMIT = 16_384;

/**
 * The text index date probe's request: no `q`, which matches the whole index (`q=*` matches
 * nothing), newest edit first, one hit carrying `last_modified_t` alone.
 */
const TEXT_INDEX_PROBE_BODY = {
  sort_by: '-last_modified_t',
  page_size: 1,
  fields: ['last_modified_t'],
};

/**
 * The probe's whole budget, request and body read together, on its own timer rather than any
 * caller's signal. A text search waits on the probe only once its own answer is in, so this is the
 * most that wait can add; live, the probe answered in about 0.5 s, inside the 0.6–0.7 s of a
 * typical text search it runs beside.
 */
const TEXT_INDEX_PROBE_TIMEOUT_MS = 3_000;

/** How long a probed index date is reused before a text search probes again. */
const TEXT_INDEX_DATE_TTL_MS = 6 * 60 * 60 * 1000;

/** How long after a failed probe no text search sends another. */
const TEXT_INDEX_PROBE_BACKOFF_MS = 15 * 60 * 1000;

/**
 * The languages whose name fields a text query searches, sent as `langs` on each text search.
 * search-a-licious 2.x searches `product_name.<lang>` and `generic_name.<lang>` only for the
 * languages it is sent, English alone by default, so a product named only in French, Russian, or
 * Portuguese is invisible to a query that sends nothing. Its index holds those fields for 181
 * languages plus `main`, the name in the product's own main language, whatever that is (live
 * 2026-11-24: `czekolada` 108 on the 31 codes here, 370 with `main` added). The 31 codes are the
 * languages the 1.x index analyzed, so every name a search reached on that index stays reachable,
 * and `main` reaches a product by its own name in any other. Each code costs two fields per query
 * word, so the other 150 stay unsent, and the list is a constant rather than a caller input.
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
  'main',
] as const;

/**
 * Most words a text query may carry: this server's bound on what one query costs the backend, not
 * the backend's own ceiling. search-a-licious 2.x matches each word against every name field of
 * every language sent (64 for `TEXT_SEARCH_LANGS`) and its other full-text fields; live
 * 2026-11-24, 60 words still answered normally. Words are counted as runs of letters and digits,
 * the most terms the analyzers can split a query into, so a hyphenated word counts each part.
 */
export const MAX_QUERY_WORDS = 24;

/** Runs of letters and digits in a query — the upper bound `MAX_QUERY_WORDS` is checked against. */
export function countQueryWords(query: string): number {
  return query.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

/**
 * A word as the backend's analyzers split text: a run of letters, marks, digits, and `_`,
 * continuing across a single `'`, `’`, or `.` between two such characters, or a single `,` between
 * two digits; every other character separates words. Probed live: `milk<sep>xyzzyqq` as one term
 * matched the `milk` products when `<sep>` was `-`, `/`, `+`, `&`, `,`, or `:` — the analyzer split
 * it — and none when it was `.` or `_`, which stay inside one token (2026-10-13, and on 2.x
 * 2026-11-24 for `-`, `,`, and `.`). A decimal comma stays inside its number (live: `lait 1,5%`
 * requiring `1` and `5` matched 27 products, only names spelling it `1, 5%`; requiring `1,5`, 324).
 * The scan is linear in the query's length, which nothing bounds before it: the joiners and the
 * word characters are disjoint and a started match always succeeds, so nothing is retried.
 */
const ANALYZER_WORD = /[\p{L}\p{M}\p{N}_]+(?:(?:['’.]|(?<=\p{N}),(?=\p{N}))[\p{L}\p{M}\p{N}_]+)*/gu;

/**
 * The query's part of `q`: its words (`ANALYZER_WORD`), lowercased and space-separated, escaped.
 * search-a-licious 2.x requires every space-separated bare word, and its analyzers leave stop
 * words out of that requirement (live 2026-11-24: `confiture de fraise` and `confiture fraise` both
 * 1,956). A word joined to another by punctuation is one term to it, though, matched by any one of
 * the parts its analyzers split it into (`coca-cola` 10,000+ against `coca cola` 2,969), so the
 * words are sent apart, each required. Lowercasing turns a caller's `AND`/`OR`/`NOT`/`TO` into
 * plain words, since the parser reserves only the uppercase forms, and costs nothing because every
 * analyzer lowercases. A query holding no word is sent as typed: the backend matches it against no
 * product (live: `%%%` 0), where sending nothing would match every one. Escaping keeps whatever
 * reaches `q` from parsing as query syntax (see `LUCENE_RESERVED_CHARS`).
 */
function textQueryTerms(query: string): string {
  const lowercased = query.toLowerCase();
  const words = lowercased.match(ANALYZER_WORD);
  return escapeLuceneQueryText(words ? words.join(' ') : lowercased);
}

/**
 * Most suggestions one autocomplete lookup asks for. The endpoint honors any `size` and answers
 * everything it matched below that (live, 2026-10-30: `a` on categories is 249 at every size from
 * 500 to 20,000, and `size=201` answers 201). This sits above the largest answer measured, 1,313
 * for `c` on categories, so a lookup reads a term's whole answer in one request and a count taken
 * from it is exact. An answer that reached this size would be cut here with nothing flagging it.
 */
const MAX_AUTOCOMPLETE_SIZE = 2000;

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
 * The clause a nutrient constraint sends, its bound as given: the index compares every nutrient
 * as a decimal (see `NUTRIENT_FIELDS`), so the range it answers is the constraint itself.
 */
function nutrientClause({ nutrient, operator, value }: NutrientFilter): string {
  return `nutriments.${nutrient}_100g:${NUTRIENT_RANGE_FORMS[operator](value)}`;
}

/**
 * A tag ID as one exact term: double-quoted, any `\` or `"` in it escaped, so the parser reads the
 * whole value as the term and nothing in it as query syntax (live 2026-11-24:
 * `brands:"xx:zzq\" OR categories:\"en:hummus"` matched nothing — one term, not two clauses).
 */
function quotedTerm(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}

/**
 * Build the search-a-licious Lucene `q` from a text query plus tag filters, in this order: tag
 * clauses, exclusion clauses, nutrient range clauses, then the query's words. Recognized
 * `field:"value"` facet clauses become hard AND filters — one clause per value, so several labels
 * or ingredients all apply — and a top-level `-field:"value"` clause excludes (live 2026-11-24:
 * `allergens:"en:sesame-seeds"` and its exclusion partition the `en:hummus` products exactly). An
 * exclusion value must be canonical: a value the field does not hold excludes nothing, so the tool
 * refuses unconfirmed ones before they reach here.
 *
 * Field names are search-a-licious 2.x's for Open Food Facts, which differ from /api/v2/search: the
 * tag facets drop the `_tags` suffix (`categories`, `brands`, `labels`, `allergens`, `traces`,
 * `additives`, `countries`) while `ingredients_tags` and `ingredients_analysis_tags` keep it,
 * nutrition grade is `nutriscore_grade`, NOVA `nova_group`, and Green-Score
 * `environmental_score_grade`, the grade each row shows. 2.x refuses a field it does not know with
 * HTTP 400. Tag values go as exact terms (`quotedTerm`), otherwise verbatim — the fields are
 * exact-match keywords, so the caller hands in the forms the index stores (the tool runs each
 * value through the taxonomy service's canonicalizer first). A grade stays unquoted unless it
 * carries punctuation (`a-plus`), and several grades of one input form an `(a OR b)` group, since
 * a product carries one grade (live: `nutriscore_grade:(a OR b)` counts `a` and `b` summed). The
 * several IDs one tag value can be stored under (`TagValue`) form a quoted group the same way, in
 * every tag field, and each member of a list that must all apply is its own clause.
 *
 * The query's words come last, bare (`textQueryTerms`): 2.x requires each of them and ranks the
 * results by them. They reach product and generic names only — the category, label, and brand
 * fields it also searches hold tag IDs no word equals (live 2026-11-24: `hummus` matched 2,643 of
 * the 4,616 `en:hummus` products) — so that intent goes through the tag filters.
 *
 * Nutrient constraints become nested range clauses under the `nutriments.` prefix
 * (`nutrientClause`). Exported for its timing test.
 */
export function buildTextSearchQuery(params: SearchParams): string {
  const clauses: string[] = [];
  /** Adds `field:term`, or `field:(a OR b)` for several terms any of which matches; none adds nothing. */
  const addClause = (field: string, terms: readonly string[]) => {
    if (terms.length === 0) return;
    clauses.push(`${field}:${terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`}`);
  };
  /** One tag value's IDs, each an exact term, an empty one left out. */
  const tagTerms = (value: TagValue | undefined) =>
    [value ?? []].flat().filter(Boolean).map(quotedTerm);
  /** One grade input's grades, bare unless punctuated (`a-plus`). */
  const gradeTerms = (value: string | string[] | undefined) =>
    [value ?? []].flat().map((grade) => (/^[a-z0-9]+$/.test(grade) ? grade : quotedTerm(grade)));
  addClause('categories', tagTerms(params.categories_tag));
  addClause('brands', tagTerms(params.brands_tag));
  for (const label of [params.labels_tag ?? []].flat()) addClause('labels', tagTerms(label));
  addClause('allergens', tagTerms(params.allergens_tag));
  addClause('traces', tagTerms(params.traces_tag));
  addClause('ingredients_analysis_tags', tagTerms(params.ingredients_analysis_tag));
  for (const ingredient of [params.ingredients_tag ?? []].flat()) {
    addClause('ingredients_tags', tagTerms(ingredient));
  }
  addClause('additives', tagTerms(params.additives_tag));
  addClause('nutriscore_grade', gradeTerms(params.nutrition_grade));
  addClause('nova_group', gradeTerms(params.nova_group));
  addClause('environmental_score_grade', gradeTerms(params.ecoscore_grade));
  addClause('countries', tagTerms(params.countries_tag));
  for (const allergen of params.exclude_allergens ?? []) {
    clauses.push(`-allergens:${quotedTerm(allergen)}`);
  }
  for (const trace of params.exclude_traces ?? []) clauses.push(`-traces:${quotedTerm(trace)}`);
  clauses.push(...(params.nutrient_filters ?? []).map(nutrientClause));
  if (params.query) clauses.push(textQueryTerms(params.query));
  return clauses.join(' ');
}

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
 * A stored doc cut to `fields`, as a v2 read returns only the fields it asks for, in the doc's key
 * order (Product Opener's canonical order, which the record builder keeps, then the dates its row
 * adds). The doc is the builder's projection of a live v2 read, dated from its row's columns, so the
 * fields are already in the shape the live path hands on; its `code` and `_input_sets` leave unless
 * `fields` names them.
 */
function projectDoc(doc: MirrorDoc, fields: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([field]) => fields.has(field)));
}

/**
 * A search by tag filters alone as the mirror matches it. Every value is canonical
 * (`ProductSearch.tags_confirmed`), a brand the keys the mirror holds it under; the query module
 * turns each into the key the store indexes. Labels are one filter each, all required; a grade
 * input's values, like a tag value's IDs and a brand's keys, form one any-of filter.
 */
function mirrorTagSearch(params: SearchParams): MirrorTagSearch {
  const include: MirrorTagFilter[] = [];
  const add = (facet: MirrorTagFilter['facet'], value: TagValue | undefined) => {
    if (value?.length) include.push({ facet, value });
  };
  add('categories', params.categories_tag);
  add('brands', params.brands_tag);
  for (const label of [params.labels_tag ?? []].flat()) add('labels', label);
  add('allergens', params.allergens_tag);
  add('traces', params.traces_tag);
  add('ingredients_analysis', params.ingredients_analysis_tag);
  add('additives', params.additives_tag);
  add('nutrition_grades', params.nutrition_grade);
  add('nova_groups', params.nova_group);
  add('environmental_score', params.ecoscore_grade);
  add('countries', params.countries_tag);
  return {
    include,
    exclude: [
      ...(params.exclude_allergens ?? []).map((value) => ({ facet: 'allergens' as const, value })),
      ...(params.exclude_traces ?? []).map((value) => ({ facet: 'traces' as const, value })),
    ],
    page: params.page ?? 1,
    pageSize: params.page_size ?? 20,
    sortBy: params.sort_by,
  };
}

/**
 * A failed mirror read as the log records it: the error's name, code, and message, except a JSON
 * parse error's message, which quotes the stored document it failed on.
 */
function mirrorFailure(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: typeof error };
  const code = 'code' in error ? error.code : undefined;
  return {
    error: error.name,
    ...((typeof code === 'string' || typeof code === 'number') && { code }),
    ...(!(error instanceof SyntaxError) && { message: error.message }),
  };
}

/**
 * The index's value for each constrained nutrient, keyed as `off_get_product` keys it: the 32-bit
 * float the index stores, widened to a double (`0.20000000298023224` for 0.2), which is the value
 * the constraint was matched against and can differ from the live record's figure. Only a JSON
 * number is a value: a key the hit lacks, or holds as anything else, is left out rather than
 * zero-filled.
 */
function pickIndexedNutriments(
  nutriments: RawNutriments | undefined,
  constrained: readonly NutrientField[],
): IndexedNutriments {
  const picked: IndexedNutriments = {};
  for (const nutrient of constrained) {
    const value = nutriments?.[`${nutrient}_100g`];
    if (typeof value === 'number') picked[indexedNutrientKey(nutrient)] = value;
  }
  return picked;
}

/**
 * A text hit's brand tag IDs as a row's `brands`, comma-separated like a v2 read's, each without
 * the `xx:` prefix Product Opener gives a brand, which belongs to no language
 * (`["xx:heinz", "xx:Member's Mark"]` → `heinz, Member's Mark`). The index holds no display name,
 * so a row carries the stored form: a slug, or the brand as a contributor typed it. Hits are not
 * schema-checked, so anything but a list of strings leaves the row without brands.
 */
function brandsText(ids: RawTextSearchHit['brands']): string | undefined {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return;
  return ids.map((id) => id.replace(/^xx:/, '')).join(', ');
}

/**
 * This server's own budget refusal, raised before anything is sent. It is an ordinary
 * `rate_limited` failure on the wire — retryable, carrying `retryAfter` — and a distinct type so
 * the retry boundary it is thrown inside can tell it apart from an upstream 429 and stop, and so
 * the taxonomy service can report a lookup it refused as a spent budget rather than a rate limit
 * Open Food Facts imposed.
 */
export class BudgetExhaustedError extends McpError {
  /** Whole seconds until the budget frees a slot, as `data.retryAfter` publishes it. */
  readonly retryAfter: number;

  constructor(message: string, data: { endpoint: string; limit: number; retryAfter: number }) {
    super(JsonRpcErrorCode.RateLimited, message, {
      ...data,
      reason: 'rate_limited',
      retryable: true,
    });
    this.retryAfter = data.retryAfter;
  }
}

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

/** How one read retries, and the per-call fields its failures carry. */
type ReadRetry = {
  operation: string;
  baseDelayMs: number;
  deadlineMs: number;
  data: Record<string, unknown>;
};

/**
 * Runs one upstream read under `withRetry`, bounded by `deadlineMs` across every attempt and
 * backoff. `attempt` threads the `signal` it receives into its request, so an expiry cuts off the
 * request in flight rather than overshooting by it.
 *
 * No tool declares the framework's `retry_deadline_exceeded`, so an expiry leaves as
 * `upstream_timeout`, shaped like a ladder that exhausted on timeouts. The exception is a read whose
 * last finished attempt answered 429: that is a limit to wait out, not an outage, so its own failure
 * is raised, `retryAfter` included. An attempt the expiry cut off finished nothing, so it leaves the
 * 429 standing, and any attempt that did finish replaces it, its own 15 s timeout included. A caller
 * abort never gets here: `withRetry` ranks it above the deadline on the attempt and backoff paths.
 */
async function retryRead<T>(
  attempt: (retry: RetryAttempt) => Promise<T>,
  { operation, baseDelayMs, deadlineMs, data }: ReadRetry,
  ctx: Context,
): Promise<T> {
  let lastRateLimit: McpError | undefined;
  try {
    return await withRetry(
      async (retry) => {
        try {
          return await attempt(retry);
        } catch (error) {
          if (!retry.signal.aborted) {
            lastRateLimit =
              error instanceof McpError && error.data?.reason === 'rate_limited'
                ? error
                : undefined;
          }
          throw error;
        }
      },
      {
        operation,
        context: ctx,
        baseDelayMs,
        deadlineMs,
        signal: ctx.signal,
        isTransient: isRetryableUpstreamFailure,
      },
    );
  } catch (error) {
    if (!(error instanceof McpError) || error.data?.reason !== 'retry_deadline_exceeded') {
      throw error;
    }
    throw (
      lastRateLimit ??
      contractError(
        'upstream_timeout',
        `Open Food Facts did not respond within the ${deadlineMs / 1000} s retry deadline.`,
        { ...data, ...publishedErrorData(error.data), operation },
        error,
      )
    );
  }
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
  check(endpoint: string): void {
    const now = Date.now();
    this.evict(now);
    if (this.timestamps.length >= this.maxRequests) {
      const retryAfter = Math.max(
        1,
        Math.ceil(((this.timestamps[0] ?? now) + this.windowMs - now) / 1000),
      );
      throw new BudgetExhaustedError(
        `openfoodfacts-mcp-server declined this ${endpoint} request: its own client-side budget of ` +
          `${this.maxRequests} ${endpoint} requests/min is spent, so nothing was sent to Open Food ` +
          `Facts. A slot frees in about ${retryAfter}s.`,
        { endpoint, limit: this.maxRequests, retryAfter },
      );
    }
    this.timestamps.push(now);
  }

  /**
   * Records one best-effort request only while two or more slots are free, so it never takes the
   * last one and a caller's own request can still follow it. Returns whether it took a slot; a
   * request that finds none spare is simply not sent, so nothing is thrown.
   */
  tryAcquireSpare(): boolean {
    const now = Date.now();
    this.evict(now);
    if (this.maxRequests - this.timestamps.length < 2) return false;
    this.timestamps.push(now);
    return true;
  }

  /** Drops the timestamps that have left the window. */
  private evict(now: number): void {
    const windowStart = now - this.windowMs;
    while (this.timestamps.length > 0 && (this.timestamps[0] ?? 0) < windowStart) {
      this.timestamps.shift();
    }
  }
}

export class OpenFoodFactsService {
  private readonly baseUrl: string;
  private readonly productLimiter: RateLimiter;
  private readonly searchLimiter: RateLimiter;
  private readonly taxonomyLimiter: RateLimiter;
  private textIndex: TextIndexDate = { status: 'unprobed' };

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
   * Whether the local mirror is configured and ready to serve. The search tool asks before it
   * canonicalizes a search by tag filters alone, since only the mirror serves pages past
   * `TAG_SEARCH_MAX_PAGE` and only canonical values reach it; with `OFF_MIRROR_PATH` unset this
   * answers false without building a store. A store error is logged and reads as not ready. The
   * caller's cancellation is rethrown.
   */
  async mirrorReady(ctx: Context): Promise<boolean> {
    return (await this.readMirror('readiness check', async () => true, ctx)) !== undefined;
  }

  /**
   * Whether the local mirror is ready and serves a Green-Score filter: its last completed full load
   * was built at a record version carrying the facet (`indexesGreenScore`). Until then some rows
   * lack their Green-Score tag, so the search tool reads a tag-only search carrying
   * `ecoscore_grade` live. False with no mirror, a store not ready, or a store error (logged); the
   * caller's cancellation is rethrown.
   */
  async mirrorIndexesGreenScore(ctx: Context): Promise<boolean> {
    const indexed = await this.readMirror(
      'Green-Score check',
      async (store) => ((await indexesGreenScore(store)) ? true : undefined),
      ctx,
    );
    return indexed !== undefined;
  }

  /**
   * Whether the local mirror is ready and serves a brand filter: its last completed full load was
   * built at a record version that keys every brand (`indexesBrandKeys`). Until then some rows hold
   * a brand under the spelling their record carries rather than its key, so a brand matched there
   * would count part of its products, and the search tool reads a tag-only search carrying
   * `brands_tag` live. False with no mirror, a store not ready, or a store error (logged); the
   * caller's cancellation is rethrown.
   */
  async mirrorIndexesBrandKeys(ctx: Context): Promise<boolean> {
    const indexed = await this.readMirror(
      'brand-key check',
      async (store) => ((await indexesBrandKeys(store)) ? true : undefined),
      ctx,
    );
    return indexed !== undefined;
  }

  /**
   * The ones of a brand's `keys` (`brandKeys`, in order) that some product the ready mirror holds
   * carries, which a search by tag filters alone then sends to it as one any-of filter: a brand is
   * held when any of its keys is. `undefined` when none is held, with no mirror, a store not ready,
   * or a store error (logged), so the search reads live. Ask only once `mirrorIndexesBrandKeys`
   * holds, since before it a key's postings are part of its brand's. The caller's cancellation is
   * rethrown.
   */
  async mirrorHeldBrand(
    keys: readonly string[],
    ctx: Context,
  ): Promise<[string, ...string[]] | undefined> {
    const held = await this.readMirror(
      'brand check',
      async (store): Promise<[string, ...string[]] | undefined> => {
        const [first, ...rest] = await heldTags(store, 'brands', keys);
        return first === undefined ? undefined : [first, ...rest];
      },
      ctx,
    );
    return held?.value;
  }

  /**
   * Fetch a product by barcode: from the mirror when it is ready and holds the barcode, sending no
   * request and spending no budget slot, otherwise live (see `readLiveOver` for a row that
   * predates requested fields).
   * Returns `null` when status:0 (barcode not found in any contributor record).
   * The caller is responsible for surfacing the not-found condition via ctx.fail.
   */
  async getProduct(barcode: string, ctx: Context): Promise<ProductRead | null> {
    const mirrored = await this.readProductFromMirror(barcode, MIRROR_PRODUCT_FIELDS, ctx);
    if (mirrored?.predates.length === 0) return mirrored.read;
    return this.readLiveOver(mirrored, ctx, () =>
      retryRead(
        ({ signal }) => {
          this.productLimiter.check('product');
          const url = `${this.baseUrl}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${PRODUCT_FIELDS}`;
          ctx.log.debug('Fetching product', { barcode });
          return this.fetchProduct(url, barcode, ctx, signal);
        },
        {
          operation: `OFF:getProduct:${barcode}`,
          baseDelayMs: 500,
          deadlineMs: READ_RETRY_DEADLINE_MS,
          data: { barcode },
        },
        ctx,
      ),
    );
  }

  /**
   * Fetch a product by barcode with a specific field subset.
   * Used when the caller only needs a subset of fields (e.g., off_compare_products). Served from the
   * mirror as `getProduct` is, when every field is one the mirror holds. A row that predates
   * requested fields is read live for them (`read_live`, as `getProduct` reads it), or served as it
   * is with `unread` naming them `skipped` (`serve_row`), sending nothing.
   */
  async getProductFields(
    barcode: string,
    fields: string,
    ctx: Context,
    predated: PredatedFields = 'read_live',
  ): Promise<ProductRead | null> {
    const requested = new Set(fields.split(','));
    const mirrored = [...requested].every((field) => MIRROR_PRODUCT_FIELDS.has(field))
      ? await this.readProductFromMirror(barcode, requested, ctx)
      : undefined;
    if (mirrored?.predates.length === 0) return mirrored.read;
    if (mirrored && predated === 'serve_row') {
      return { ...mirrored.read, unread: { fields: mirrored.predates, outcome: 'skipped' } };
    }
    return this.readLiveOver(mirrored, ctx, () =>
      retryRead(
        ({ signal }) => {
          this.productLimiter.check('product');
          const url = `${this.baseUrl}/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;
          ctx.log.debug('Fetching product fields', { barcode, fields });
          return this.fetchProduct(url, barcode, ctx, signal);
        },
        {
          operation: `OFF:getProductFields:${barcode}`,
          baseDelayMs: 500,
          deadlineMs: READ_RETRY_DEADLINE_MS,
          data: { barcode },
        },
        ctx,
      ),
    );
  }

  /**
   * A product read live, falling back to `mirrored` when the mirror holds the barcode in a row that
   * predates requested fields: the live read supplies those fields, and should it fail or find no
   * product, the row answers without them, with `unread` saying which and why. A live failure
   * there is never the call's failure, since the mirror can answer it, as it did before the row's
   * record version fell behind the builder. The caller's cancellation is rethrown, and so is
   * anything that is not a declared failure, since that is a bug rather than an upstream answer.
   */
  private async readLiveOver(
    mirrored: MirroredProduct | undefined,
    ctx: Context,
    live: () => Promise<RawProduct | null>,
  ): Promise<ProductRead | null> {
    if (mirrored === undefined) {
      const product = await live();
      return product && { source: 'off_api', product };
    }
    const fields = mirrored.predates;
    let product: RawProduct | null;
    try {
      product = await live();
    } catch (error) {
      if (ctx.signal.aborted || !(error instanceof McpError)) throw error;
      ctx.log.warning('Live read for fields the mirror row predates failed — serving the row', {
        fields,
        reason: error.data?.reason,
      });
      return { ...mirrored.read, unread: { fields, outcome: 'failed', error } };
    }
    if (product) return { source: 'off_api', product };
    ctx.log.warning('Live read for fields the mirror row predates found nothing — serving it', {
      fields,
    });
    return { ...mirrored.read, unread: { fields, outcome: 'not_found' } };
  }

  /**
   * One product from the mirror, cut to `fields`, with the record's stored nutrition sets and the
   * requested fields its row predates — built at a record version before they were projected —
   * or `undefined` to read it live: no mirror, a barcode it lacks, or a store error. The version
   * is checked per read, so a reload rewriting rows to a newer version leaves reads that name only
   * older fields on the mirror throughout. The barcode is looked up as Product Opener normalizes
   * it, so `030000010402` finds `0030000010402`. A record whose stored nutrition sets are not a
   * list is a store error too, so its product and its as-sold figures are both read live.
   */
  private async readProductFromMirror(
    barcode: string,
    fields: ReadonlySet<string>,
    ctx: Context,
  ): Promise<MirroredProduct | undefined> {
    const served = await this.readMirror(
      'product read',
      async (store) => {
        const stored = (await getByCodes(store, [barcode])).get(barcode);
        if (stored === undefined) return;
        const { doc } = stored;
        const storedSets = readInputSets({ input_sets: doc._input_sets });
        if (storedSets === 'malformed') {
          throw new Error('The stored nutrition sets of this record are not a list.');
        }
        return { doc, storedSets, predates: fieldsNewerThan(stored.recordVersion, fields) };
      },
      ctx,
    );
    if (!served) return;
    const { doc, storedSets, predates } = served.value;
    ctx.log.debug(
      predates.length === 0
        ? 'Product served from the mirror'
        : 'Mirror row predates a requested field',
      { barcode, ...(predates.length > 0 && { predates }) },
    );
    return {
      read: {
        source: 'off_mirror',
        mirrorAsOf: served.mirrorAsOf,
        // A builder projection of the live v2 read's fields: the shape fetchProduct hands on.
        product: projectDoc(doc, fields) as RawProduct,
        storedSets,
      },
      predates,
    };
  }

  /**
   * Runs `read` against the mirror when one is configured and ready, and resolves `undefined` —
   * read live — when none is configured, the store is not ready, `read` finds nothing, or the store
   * throws. A throw is logged without the stored document. The as-of time is read before and after
   * the data and the older one cited, so neither a delta raising it nor a full load lowering it
   * ahead of the rows it rewrites leaves the data older than the time it cites. The caller's
   * cancellation is rethrown whatever the read did, never served or read live.
   */
  private async readMirror<T>(
    operation: string,
    read: (store: MirrorStore) => Promise<T | undefined>,
    ctx: Context,
  ): Promise<{ value: T; mirrorAsOf: string } | undefined> {
    const store = getMirrorStore();
    if (store === undefined) return;
    const readAsOf = async () => {
      const asOf = await mirrorAsOf(store);
      if (asOf === undefined) throw new Error('The mirror is ready but records no as-of time.');
      return asOf;
    };
    let served: { value: T; mirrorAsOf: string } | undefined;
    try {
      if (await isMirrorReady(store)) {
        const before = await readAsOf();
        const value = await read(store);
        if (value !== undefined) {
          const after = await readAsOf();
          served = { value, mirrorAsOf: Date.parse(after) < Date.parse(before) ? after : before };
        }
      }
    } catch (error) {
      ctx.signal.throwIfAborted();
      ctx.log.warning('Mirror read failed — reading Open Food Facts live instead', {
        operation,
        ...mirrorFailure(error),
      });
      return;
    }
    ctx.signal.throwIfAborted();
    return served;
  }

  /**
   * The as-sold figures a record stores, for a product read whose `nutriments` held only prepared
   * ones, taken from the same source as `read`, the read `getProduct` or `getProductFields`
   * returned for `barcode`. A mirror read's come from its `storedSets`, with no request and no
   * budget slot; a live one's from the live API, never the mirror, whose record can be a different
   * revision. Its `source` decides, so a product read live is never paired with the mirror's sets,
   * nor a mirror read with the live ones.
   *
   * Live, it is `GET /api/v3.5/product/{barcode}?fields=nutrition.input_sets`, then
   * `selectAsSoldSet`. API v2 and v3.4 both serve the aggregated set, where prepared wins, so only
   * v3.5's input sets carry the as-sold figures. Each attempt spends a product-budget slot, as Open
   * Food Facts counts the route in its product bucket, and every attempt and backoff share a 20 s
   * deadline. A 404 after the v2 read found the barcode means the route, not the record, is missing,
   * so it is `unread` (`upstream_error`) at once, never `none`. Every other failure is `unread` with
   * its declared reason. The caller's cancellation is rethrown, and so is anything that is not a
   * declared failure, since that is a bug rather than an upstream answer.
   */
  async readStoredAsSold(
    barcode: string,
    ctx: Context,
    read: ProductRead,
  ): Promise<StoredAsSoldRead> {
    if (read.source === 'off_mirror') {
      return read.storedSets === undefined ? { status: 'none' } : selectAsSoldSet(read.storedSets);
    }
    let selection: AsSoldSelection | null;
    try {
      selection = await retryRead(
        ({ signal }) => {
          this.productLimiter.check('product');
          const url = `${this.baseUrl}/api/v3.5/product/${encodeURIComponent(barcode)}?fields=nutrition.input_sets`;
          ctx.log.debug('Fetching stored nutrition sets', { barcode });
          return this.fetchInputSets(url, barcode, ctx, signal);
        },
        {
          operation: `OFF:readStoredAsSold:${barcode}`,
          baseDelayMs: 500,
          deadlineMs: AS_SOLD_RETRY_DEADLINE_MS,
          data: { barcode },
        },
        ctx,
      );
    } catch (error) {
      if (ctx.signal.aborted || !(error instanceof McpError)) throw error;
      return { status: 'unread', error };
    }
    return (
      selection ?? {
        status: 'unread',
        error: contractError(
          'upstream_error',
          'Open Food Facts answered HTTP 404 on its API v3.5 product route for a barcode its v2 read found, so the stored nutrition sets were not read.',
          { barcode, status: 404 },
        ),
      }
    );
  }

  /**
   * Fetch and normalize a single product. HTTP 404 — which OFF returns for barcodes no contributor
   * has entered, alongside the HTTP 200 + `status:0` form of the same condition — resolves to
   * `null`; a 2xx body that is neither form nor `status: 1` with a product object is a malformed
   * envelope, and it and every other failure are re-raised as declared contract failures.
   * Returning `null` only for a genuine not-found is what lets callers distinguish "no record" from
   * "the fetch failed". A found product with nothing entered for the requested fields is `{}`.
   */
  private async fetchProduct(
    url: string,
    barcode: string,
    ctx: Context,
    signal: AbortSignal,
  ): Promise<RawProduct | null> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        REQUEST_TIMEOUT_MS,
        withExtra(ctx, { upstreamOperation: 'OFF:product' }),
        {
          signal,
          headers: REQUEST_HEADERS,
          expectedStatuses: [404],
        },
      );
    } catch (error) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) {
        ctx.log.debug('Product not found (HTTP 404)', { barcode });
        return null;
      }
      throw toContractError(error, { barcode });
    }

    const data = await parseJsonBody<unknown>(response, { barcode });
    ctx.log.debug('Product response received', {
      barcode,
      status: isRecord(data) ? data.status : undefined,
    });

    if (isProductEnvelope(data)) {
      // status:0 = barcode not found in any contributor record, the HTTP 200 form of the 404.
      return data.status === 0 ? null : data.product;
    }
    throw malformedEnvelope('product lookup', 'status 1 with a product object, or status 0', {
      barcode,
    });
  }

  /**
   * Fetch one record's stored nutrition sets and select its as-sold figures. HTTP 404 resolves to
   * `null` without a retry, which nothing can change; a 2xx body that fails the envelope rule, or
   * whose `nutrition.input_sets` is not a list, is a malformed envelope, raised inside the retry
   * boundary like any other. No sets stored is `none`.
   */
  private async fetchInputSets(
    url: string,
    barcode: string,
    ctx: Context,
    signal: AbortSignal,
  ): Promise<AsSoldSelection | null> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        REQUEST_TIMEOUT_MS,
        withExtra(ctx, { upstreamOperation: 'OFF:productInputSets' }),
        { signal, headers: REQUEST_HEADERS, expectedStatuses: [404] },
      );
    } catch (error) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) return null;
      throw toContractError(error, { barcode });
    }

    const body = await parseJsonBody<unknown>(response, { barcode });
    const sets = isInputSetsEnvelope(body) ? readInputSets(body.product.nutrition) : 'malformed';
    if (sets === 'malformed') {
      throw malformedEnvelope(
        'stored nutrition sets read',
        'status success with a found product whose nutrition.input_sets is a list',
        { barcode },
      );
    }
    return sets === undefined ? { status: 'none' } : selectAsSoldSet(sets);
  }

  /**
   * Fetch a search endpoint, re-raising every failure as a declared contract failure. Runs inside
   * the caller's retry boundary so the mapped code drives retry classification. A `jsonBody` makes
   * the request a POST carrying it as JSON — the text search, whose failed body is kept to
   * `TEXT_SEARCH_ERROR_BODY_LIMIT` — and without one it is a GET.
   */
  private async fetchSearch(
    url: string,
    ctx: Context,
    signal: AbortSignal,
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
          ? { signal, headers: REQUEST_HEADERS }
          : {
              signal,
              method: 'POST',
              headers: { ...REQUEST_HEADERS, 'Content-Type': 'application/json' },
              body: JSON.stringify(jsonBody),
              errorBodyLimit: TEXT_SEARCH_ERROR_BODY_LIMIT,
            },
      );
    } catch (error) {
      throw toContractError(error, data);
    }
  }

  /**
   * Search products by text query, tag filters, or both together.
   * Returns pagination envelope + product summary rows.
   *
   * Routing:
   * - `query` present (with or without tag filters): search.openfoodfacts.org (search-a-licious
   *   2.x). Any tag filters are folded into the Lucene `q` alongside the free text, so combined
   *   results are both text-relevant and filtered. The /api/v2/search endpoint silently ignores
   *   free text, so it cannot serve a text query.
   * - `nutrient_filters` present: search.openfoodfacts.org, with or without free text. The
   *   comparisons compile to Lucene range clauses only this backend applies — /api/v2/search
   *   documents the equivalent parameters and ignores them, live-verified returning an identical
   *   unfiltered count for two mutually exclusive thresholds, so honoring them there would report
   *   an unfiltered result set under a nutrient constraint.
   * - `ingredients_tag` present: search.openfoodfacts.org, with or without free text, whatever
   *   `tags_confirmed` says. The mirror indexes no ingredients, and /api/v2/search, which filters
   *   on them, serves a tag-only search through `TAG_SEARCH_MAX_PAGE` only.
   * - Tag filters only, every value confirmed (`tags_confirmed`): the local mirror, when it is
   *   ready — filters ANDed, a grade input's values as any of them, exclusions as absence, an exact
   *   total, and pages through its first `MIRROR_SEARCH_RESULT_WINDOW` results, a page past them the
   *   `page_out_of_range` outcome with no search run. A search carrying `ecoscore_grade` counts the
   *   mirror ready only once its last full load indexed Green-Score, and one carrying `brands_tag`
   *   only once its last full load keyed every brand. With no ready mirror, or on a
   *   store error (logged), it reads /api/v2/search as below, except that a page past
   *   `TAG_SEARCH_MAX_PAGE` is that outcome, with nothing sent.
   * - Tag filters only: /api/v2/search (structured facet filtering).
   *
   * The backends differ in freshness as well as in envelope: the text index lags the live
   * database, dated by `textIndexAsOf` when the service holds its date,
   * /api/v2/search reads the database directly, and the mirror reflects it as of its `mirrorAsOf`.
   * Every answer carries its `source` so the tool discloses which one answered rather than
   * presenting them as interchangeable.
   */
  async searchProducts(params: ProductSearch, ctx: Context): Promise<SearchOutcome> {
    // `ingredients_tag` is a string or an array; either one empty is no filter.
    if (params.query || params.nutrient_filters?.length || params.ingredients_tag?.length) {
      return {
        status: 'served',
        source: 'off_api',
        ...(await this.searchProductsByText(params, ctx)),
      };
    }
    if (params.tags_confirmed) {
      const mirrored = await this.searchProductsOnMirror(params, ctx);
      if (mirrored) return mirrored;
      if ((params.page ?? 1) > TAG_SEARCH_MAX_PAGE) {
        return { status: 'page_out_of_range', bound: 'live_max_page' };
      }
    }
    return {
      status: 'served',
      source: 'off_api',
      ...(await this.searchProductsByTags(params, ctx)),
    };
  }

  /**
   * A search by tag filters alone from the mirror, or `undefined` to read it live. Rows are cut to
   * `SEARCH_FIELDS` and pass the barcode check the live rows do, so a mirror page lists what the
   * same page read live lists, at the mirror's revision. The store counts every match, so the total
   * is exact on every page, a page past the last included. A page past
   * `MIRROR_SEARCH_RESULT_WINDOW` is refused once the mirror is known to be ready, before the store
   * runs any search; with no ready mirror it is `undefined`, so the live path's own bound applies.
   * A search filtering on Green-Score, or on a brand, treats a mirror whose last full load predates
   * the facet, or brand keys, as not ready, in both places: rows built before Green-Score carry no
   * Green-Score tag, and rows built before brand keys hold a brand under the spelling their record
   * carries, so its key matches part of its products.
   */
  private async searchProductsOnMirror(
    params: SearchParams,
    ctx: Context,
  ): Promise<SearchOutcome | undefined> {
    const search = mirrorTagSearch(params);
    const greenScore = search.include.some(({ facet }) => facet === 'environmental_score');
    const brand = search.include.some(({ facet }) => facet === 'brands');
    /** Whether the store's last full load indexes each facet the search needs a record version for. */
    const indexes = async (store: MirrorStore) =>
      (!greenScore || (await indexesGreenScore(store))) &&
      (!brand || (await indexesBrandKeys(store)));
    if (search.page * search.pageSize > MIRROR_SEARCH_RESULT_WINDOW) {
      const ready = await this.readMirror(
        'readiness check',
        async (store) => ((await indexes(store)) ? true : undefined),
        ctx,
      );
      return ready ? { status: 'page_out_of_range', bound: 'mirror_window' } : undefined;
    }
    const served = await this.readMirror(
      'tag search',
      async (store) => ((await indexes(store)) ? searchByTags(store, search) : undefined),
      ctx,
    );
    if (!served) return;
    // A builder projection of the live v2 fields, as a live search row is.
    const rows = served.value.docs.map(
      (doc) => projectDoc(doc, SEARCH_FIELD_SET) as RawSearchProduct,
    );
    const products = withBarcodes(rows, ctx);
    ctx.log.debug('Tag search served from the mirror', {
      count: served.value.total,
      page: search.page,
      returned: products.length,
    });
    return {
      status: 'served',
      count: served.value.total,
      count_is_exact: true,
      page: search.page,
      page_count: products.length,
      page_size: search.pageSize,
      products,
      dropped: rows.length - products.length,
      source: 'off_mirror',
      mirrorAsOf: served.mirrorAsOf,
    };
  }

  /**
   * Text search via search.openfoodfacts.org (search-a-licious 2.x). Serves every search carrying a
   * query, nutrient constraints, or an ingredient filter, with or without tag filters: the filters
   * are ANDed into the Lucene `q` as hard clauses, and the query's words both filter and rank the
   * results (see `buildTextSearchQuery`). Every row the index returns is a match, so the page holds
   * them all and `count`, `count_is_exact`, and paging are the backend's.
   *
   * Sent as a POST with the parameters in a JSON body, the form search-a-licious offers so a query
   * stays out of URLs. The GET form takes the same parameters and answers identically (live: the
   * same hits for the same `sort_by`, `page`, `page_size`, and `fields`).
   *
   * Hits name two fields differently from the rows (`TEXT_SEARCH_RESULT_FIELDS`), and carry brand
   * tag IDs, which each row shows as text (`brandsText`).
   *
   * The answer carries `textIndexAsOf` when the service holds the index's date or reads it beside
   * this search (`textIndexDate`), asked on the first attempt only: a probe ends within its 3 s of
   * that attempt's start, so waiting on it never carries the call past the read's own deadline.
   * That read is awaited only once the search has answered, so a failed or cancelled search ends
   * without it, and a caller cancelled while waiting on it ends at once while the read runs on for
   * the others.
   */
  private async searchProductsByText(
    params: SearchParams,
    ctx: Context,
  ): Promise<SearchResult & { textIndexAsOf?: string }> {
    // The nutrients a filter constrains, once each: a range pair names its nutrient twice.
    const constrained = [...new Set((params.nutrient_filters ?? []).map((f) => f.nutrient))];
    const page = params.page ?? 1;
    const pageSize = params.page_size ?? 20;
    const pageData = { page, page_size: pageSize };
    let asked = false;
    let indexDate: Promise<string | undefined> | undefined;
    const result = await retryRead(
      async ({ signal }) => {
        this.searchLimiter.check('search');
        const body = {
          q: buildTextSearchQuery(params),
          langs: TEXT_SEARCH_LANGS,
          // A constrained search also asks for the index's nutrient map, so each row can show the
          // values the constraint matched; the constrained keys are picked from it below.
          fields:
            constrained.length > 0
              ? [...TEXT_SEARCH_RESULT_FIELDS, 'nutriments']
              : TEXT_SEARCH_RESULT_FIELDS,
          page,
          page_size: pageSize,
          // search-a-licious sorts on a bare field name ascending and on a `-` prefix descending,
          // and rejects an unknown field with HTTP 422. /api/v2/search reads the same bare value
          // as descending, so the prefix keeps one enum value meaning one thing on both paths.
          ...(params.sort_by && { sort_by: `-${params.sort_by}` }),
        };

        ctx.log.debug('Text-searching products', { query: params.query, q: body.q });

        const searching = this.fetchSearch(
          `${TEXT_SEARCH_BASE_URL}/search`,
          ctx,
          signal,
          'OFF:searchProductsByText',
          pageData,
          body,
        );
        // Beside the search and after it: the search holds its own slot and sends first.
        if (!asked) {
          asked = true;
          indexDate = this.textIndexDate(ctx);
        }
        const response = await searching;

        const parsed = await parseJsonBody<unknown>(response, pageData);
        // Every field is still checked below; the cast only names the keys to read.
        const data = (isRecord(parsed) ? parsed : {}) as RawTextSearchResponse;

        if (Array.isArray(data.errors) && data.errors.length > 0) {
          const detail = searchErrorsDetail(data.errors);
          throw contractError(
            'upstream_error',
            `Open Food Facts text search failed inside its search engine${detail ? `: ${detail}` : '.'}`,
            pageData,
          );
        }

        if (data.timed_out === true) throw timedOutAnswer('text search', pageData);

        if (!isTextSearchEnvelope(data)) {
          throw malformedEnvelope(
            'text search',
            'a hits list, a numeric count, and a boolean is_count_exact',
            pageData,
          );
        }

        ctx.log.debug('Text search response received', {
          count: data.count,
          count_is_exact: data.is_count_exact,
          page: data.page,
          returned: data.hits.length,
        });

        // Normalize text search hits to the row shape, under the row's keys.
        // Use spread of defined-only fields to satisfy exactOptionalPropertyTypes.
        const { hits } = data;
        const products: SearchRow[] = withBarcodes(hits, ctx).map((hit) => {
          const brands = brandsText(hit.brands);
          return {
            code: hit.code,
            ...(hit.product_name !== undefined && { product_name: hit.product_name }),
            ...(brands !== undefined && { brands }),
            ...(hit.quantity !== undefined && { quantity: hit.quantity }),
            ...(hit.nutriscore_grade !== undefined && { nutriscore_grade: hit.nutriscore_grade }),
            ...(hit.nova_group !== undefined && { nova_group: hit.nova_group }),
            ...(hit.environmental_score_grade !== undefined && {
              ecoscore_grade: hit.environmental_score_grade,
            }),
            ...(hit.categories !== undefined && { categories_tags: hit.categories }),
            ...(hit.completeness !== undefined && { completeness: hit.completeness }),
            ...(hit.last_modified_t !== undefined && { last_modified_t: hit.last_modified_t }),
            ...(hit.created_t !== undefined && { created_t: hit.created_t }),
            ...(constrained.length > 0 && {
              indexed_nutriments: pickIndexedNutriments(hit.nutriments, constrained),
            }),
          };
        });

        return {
          count: data.count,
          // The backend stops counting hits at a ceiling and reports which side of it this count
          // fell on. Read the flag rather than comparing the count against a local constant: the
          // two are different limits, and only the backend knows when it stopped counting.
          count_is_exact: data.is_count_exact,
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
        baseDelayMs: 1_000,
        deadlineMs: READ_RETRY_DEADLINE_MS,
        data: pageData,
      },
      ctx,
    );
    const textIndexAsOf = indexDate && (await untilCancelled(indexDate, ctx.signal));
    return textIndexAsOf === undefined ? result : { ...result, textIndexAsOf };
  }

  /**
   * The text index's date as one text search reads it, asked once that search's request is sent:
   * the date this service holds while it is under `TEXT_INDEX_DATE_TTL_MS` old, the probe in
   * flight, or a probe this search starts. `undefined`, so the answer goes out undated, within
   * `TEXT_INDEX_PROBE_BACKOFF_MS` of a failed probe, or when the search budget has fewer than two
   * slots free, since the probe never takes the last one. One probe runs at a time, however many
   * searches wait on it.
   */
  private textIndexDate(ctx: Context): Promise<string | undefined> | undefined {
    const held = this.textIndex;
    switch (held.status) {
      case 'probing':
        return held.probe;
      case 'known':
        if (Date.now() - held.readAt < TEXT_INDEX_DATE_TTL_MS) return Promise.resolve(held.asOf);
        break;
      case 'failed':
        if (Date.now() - held.failedAt < TEXT_INDEX_PROBE_BACKOFF_MS) return undefined;
        break;
      case 'unprobed':
        break;
    }
    return this.searchLimiter.tryAcquireSpare() ? this.startTextIndexProbe(ctx) : undefined;
  }

  /**
   * Starts the one probe of the text index's date and records how it ended: the date and when it
   * was read, or when it failed (logged). The promise never rejects — a failed probe resolves
   * `undefined` — since every text search waiting on it is served either way.
   */
  private startTextIndexProbe(ctx: Context): Promise<string | undefined> {
    const probe = this.readTextIndexDate(ctx).then(
      (asOf) => {
        this.textIndex = { status: 'known', asOf, readAt: Date.now() };
        return asOf;
      },
      (error: unknown): undefined => {
        this.textIndex = { status: 'failed', failedAt: Date.now() };
        logger.warning(
          'Could not read the text index date; text search answers go undated until a later probe reads it.',
          withExtra(ctx, {
            upstreamOperation: 'OFF:textIndexDate',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    );
    this.textIndex = { status: 'probing', probe };
    return probe;
  }

  /**
   * One read of the newest `last_modified_t` the text index holds, as an ISO 8601 time. Bounded by
   * `TEXT_INDEX_PROBE_TIMEOUT_MS` across the request and its body, and by no caller's signal, since
   * every text search waiting on it shares it. Throws on any failure: an HTTP error, a body that is
   * not JSON, the timeout, an answer flagged `timed_out`, no hit, or a `last_modified_t` that is
   * not a number.
   */
  private async readTextIndexDate(ctx: Context): Promise<string> {
    const response = await fetchWithTimeout(
      `${TEXT_SEARCH_BASE_URL}/search`,
      TEXT_INDEX_PROBE_TIMEOUT_MS,
      withExtra(ctx, { upstreamOperation: 'OFF:textIndexDate' }),
      {
        method: 'POST',
        headers: { ...REQUEST_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(TEXT_INDEX_PROBE_BODY),
      },
    );
    const body = await parseJsonBody<unknown>(response, {});
    const hit =
      isRecord(body) && body.timed_out !== true && Array.isArray(body.hits)
        ? body.hits[0]
        : undefined;
    const modified = isRecord(hit) ? hit.last_modified_t : undefined;
    if (typeof modified !== 'number' || !Number.isFinite(modified)) {
      throw malformedEnvelope('text index date read', 'a hit with a numeric last_modified_t', {});
    }
    return new Date(modified * 1000).toISOString();
  }

  /**
   * Tag-only search via /api/v2/search — structured facet filtering for requests carrying neither a
   * text query nor nutrient constraints. Those route through searchProductsByText instead, which
   * folds the tag facets into the Lucene `q`.
   */
  private async searchProductsByTags(params: SearchParams, ctx: Context): Promise<SearchResult> {
    const pageData = { page: params.page ?? 1, page_size: params.page_size ?? 20 };
    return await retryRead(
      async ({ signal }) => {
        this.searchLimiter.check('search');
        const url = this.buildSearchUrl(params);
        ctx.log.debug('Searching products by tags', { params });

        const response = await this.fetchSearch(
          url,
          ctx,
          signal,
          'OFF:searchProductsByTags',
          pageData,
        );

        const data = await parseJsonBody<unknown>(response, pageData);
        if (!isTagSearchEnvelope(data)) {
          throw malformedEnvelope('tag search', 'a products list and a numeric count', pageData);
        }

        ctx.log.debug('Tag search response received', {
          count: data.count,
          page: data.page,
          returned: data.products.length,
        });

        const rows = data.products;
        const products = withBarcodes(rows, ctx);
        return {
          count: data.count,
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
        baseDelayMs: 1_000,
        deadlineMs: READ_RETRY_DEADLINE_MS,
        data: pageData,
      },
      ctx,
    );
  }

  /**
   * Resolve a term against a live Open Food Facts taxonomy through the search-a-licious
   * autocomplete endpoint, returning its suggestions in upstream order. Ranking, filtering, and
   * what to do when the call fails are the caller's to decide — this method only fetches.
   *
   * Always asks for `MAX_AUTOCOMPLETE_SIZE`, the endpoint's only paging knob: it accepts no offset
   * or cursor, and passing one is ignored rather than rejected, so a `size` above the term's whole
   * answer is the only way to read all of it. The endpoint is a suggester over display names, not
   * an enumerator — it reports no match total and answers an empty list for an empty term.
   *
   * `deadlineMs` bounds every attempt and backoff together; a caller that has already spent part
   * of its lookup budget passes what is left of it.
   */
  async suggestTaxonomy(
    taxonomyName: string,
    term: string,
    ctx: Context,
    deadlineMs = TAXONOMY_RETRY_DEADLINE_MS,
  ): Promise<{ id: string; name: string }[]> {
    const lookup = { taxonomy_name: taxonomyName, term };
    return await retryRead(
      async ({ signal }) => {
        this.taxonomyLimiter.check('taxonomy');
        const url = new URL(`${TEXT_SEARCH_BASE_URL}/autocomplete`);
        url.searchParams.set('q', term);
        url.searchParams.set('taxonomy_names', taxonomyName);
        url.searchParams.set('size', String(MAX_AUTOCOMPLETE_SIZE));

        ctx.log.debug('Resolving taxonomy term', { taxonomyName, term });

        const data = await parseJsonBody<unknown>(
          await this.fetchSearch(url.toString(), ctx, signal, 'OFF:suggestTaxonomy', lookup),
          lookup,
        );
        if (isRecord(data) && data.timed_out === true) {
          throw timedOutAnswer('taxonomy autocomplete', lookup);
        }
        if (!isAutocompleteEnvelope(data)) {
          throw malformedEnvelope('taxonomy autocomplete', 'an options list', lookup);
        }

        // An option missing either half is unusable as a filter value or a display name, so it is
        // dropped rather than passed on with an invented placeholder.
        return data.options.flatMap((option) =>
          option.id && option.text ? [{ id: option.id, name: option.text }] : [],
        );
      },
      {
        operation: `OFF:suggestTaxonomy:${taxonomyName}`,
        baseDelayMs: 500,
        deadlineMs,
        data: lookup,
      },
      ctx,
    );
  }

  /**
   * Build the `/api/v2/search` URL. Product Opener reads a `*_tags` value as a comma-separated AND
   * list in which a `-` prefix negates, and a `|`-separated one as any of its values
   * (`add_params_to_query` in `lib/ProductOpener/Display.pm`), so several labels, an allergen or
   * trace inclusion with its exclusions, several grades, and a tag value's several IDs each travel
   * as one parameter (live: `allergens_tags=en:nuts,-en:milk` narrows `en:nuts` to the products
   * without milk). A brand's IDs are the caller's: the brand as given, which Product Opener
   * canonicalizes, then a key as `xx:<key>!`, which it matches as that exact stored tag. A parameter
   * is set only when a value for it is, so a request without the newer filters is the one this path
   * always sent.
   */
  private buildSearchUrl(params: SearchParams): string {
    const url = new URL(`${this.baseUrl}/api/v2/search`);
    /** One `*_tags` value: the inclusions, then each exclusion negated. */
    const tagList = (include: (string | undefined)[], exclude: string[] = []) =>
      [...include.filter(Boolean), ...exclude.map((value) => `-${value}`)].join(',');
    /** One `*_tags` value matching any of several: a tag value's IDs, a grade input's grades. */
    const anyOf = (value: TagValue | undefined) => [value ?? []].flat().join('|');
    const setTags = (param: string, value: string) => {
      if (value) url.searchParams.set(param, value);
    };

    url.searchParams.set('fields', SEARCH_FIELDS.join(','));
    setTags('categories_tags', anyOf(params.categories_tag));
    setTags('brands_tags', anyOf(params.brands_tag));
    setTags('labels_tags', tagList([params.labels_tag ?? []].flat().map(anyOf)));
    setTags('allergens_tags', tagList([anyOf(params.allergens_tag)], params.exclude_allergens));
    setTags('traces_tags', tagList([anyOf(params.traces_tag)], params.exclude_traces));
    if (params.ingredients_analysis_tag) {
      url.searchParams.set('ingredients_analysis_tags', params.ingredients_analysis_tag);
    }
    if (params.additives_tag) url.searchParams.set('additives_tags', params.additives_tag);
    // Score filters use the *_tags param keys — the bare nutrition_grades / nova_groups keys are
    // silently ignored by /api/v2/search and return unfiltered rows. Values pass through bare:
    // nutrition_grades_tags accepts only the plain grade letter ("a", not "en:a").
    // Several grades travel as one `|` list, which Product Opener reads as any of them (live:
    // `nutrition_grades_tags=a|b` counts the `a` and `b` matches summed). Green-Score filters on
    // environmental_score_tags, the field Product Opener computes; ecoscore_tags is a transition copy.
    setTags('nutrition_grades_tags', anyOf(params.nutrition_grade));
    setTags('nova_groups_tags', anyOf(params.nova_group));
    setTags('environmental_score_tags', anyOf(params.ecoscore_grade));
    setTags('countries_tags', anyOf(params.countries_tag));
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
