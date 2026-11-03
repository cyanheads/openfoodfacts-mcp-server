/**
 * @fileoverview The mirror's two `sync` generators. `exportLoad` is a full load: it downloads the
 * export beside the store (resuming with `Range` + `If-Range`), ingests it from a line cursor,
 * holding the checkpoint's as-of no later than the rows it rewrites, sweeps the rows the load did
 * not stamp, builds any sort index the store lacks, and only then sets the checkpoint to the
 * export's own as-of. `deltaPass` applies the daily deltas ending past the checkpoint, oldest
 * first. Both run one upstream request at a time and stop on any non-2xx; a full load also stops on
 * an export it cannot resume or decompress, and before its sweep when the export built no product.
 * A feed line that is not valid JSON or runs past 16 MiB is skipped, counted, and logged by line
 * number, never by content: fetching the feed again would bring the same line back.
 * @module services/mirror/mirror-ingester
 */

import { createReadStream } from 'node:fs';
import { open, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createGunzip } from 'node:zlib';
import { z } from '@cyanheads/mcp-ts-core';
import { type McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type {
  MirrorLogger,
  MirrorRow,
  SqliteHandle,
  SyncContext,
  SyncPage,
} from '@cyanheads/mcp-ts-core/mirror';
import { USER_AGENT } from '@/services/openfoodfacts/user-agent.js';
import {
  type DeltaFile,
  type OversizeLine,
  parseDeltaIndex,
  planDeltas,
  readLines,
} from './mirror-feeds.js';
import {
  decodeCheckpoint,
  encodeCheckpoint,
  ensureSortIndexes,
  fileSize,
  type MirrorLoad,
  writeMirrorLoad,
} from './mirror-store.js';
import type { MirrorRecord } from './record-builder.js';

/** Records per page: one write transaction each, about a second of blocked event loop at most. */
const PAGE_SIZE = 2_000;

/** Rowids a sweep page scans, bounding each sweep statement to well under a second. */
const SWEEP_WINDOW = 50_000;

/** Every this many pages: a TRUNCATE checkpoint (keeps the WAL bounded) and, under Bun, a full GC. */
const MAINTENANCE_EVERY_PAGES = 25;

/** A download that delivers no bytes for this long is abandoned; the next run resumes it. */
const STALL_TIMEOUT_MS = 60_000;

/** Tag-id cache entries kept before the cache restarts, so memory stays flat across the corpus. */
const TAG_CACHE_MAX = 100_000;

/** The record builder the ingester projects every line through (the `record-builder` module). */
export interface MirrorBuilder {
  buildMirrorRecord(line: unknown): MirrorRecord | null;
  MIRROR_RECORD_VERSION: number;
}

/** Where the export and deltas come from, and how requests identify themselves. */
export interface MirrorUpstream {
  /** Base of the delta files and their `index.txt`, ending in `/`. */
  deltaBaseUrl: string;
  /** The full export, `openfoodfacts-products.jsonl.gz`. */
  exportUrl: string;
  /** Pause before each delta request, so a catch-up never bursts the static host. */
  requestGapMs: number;
  userAgent: string;
}

/** Open Food Facts' published export and deltas. */
export const OFF_UPSTREAM: MirrorUpstream = {
  exportUrl: 'https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz',
  deltaBaseUrl: 'https://static.openfoodfacts.org/data/delta/',
  requestGapMs: 1_000,
  userAgent: USER_AGENT,
};

/** What both generators share. */
export interface IngestOptions {
  builder: MirrorBuilder;
  handle: SqliteHandle;
  log: MirrorLogger;
  tags: TagIds;
  upstream: MirrorUpstream;
}

const ExportCursorSchema = z.object({
  v: z.literal(1),
  generation: z.number().int().positive(),
  phase: z.enum(['download', 'ingest', 'sweep', 'done']),
  /** Strong ETag of the export being loaded; the identity every other position belongs to. */
  etag: z.string().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  /** Lines of the export consumed, servable or not. */
  line: z.number().int().nonnegative(),
  /** Newest `last_modified_t` among the rows this load stamped so far. */
  maxModifiedT: z.number().int().nonnegative(),
  /** Sweep position: rows at or below this rowid are swept. */
  rowid: z.number().int().nonnegative(),
  /**
   * Lines among the `line` consumed that were skipped as malformed or past 16 MiB. Absent from a
   * cursor written before lines were skipped, when a malformed line still failed the load.
   */
  skipped: z.number().int().nonnegative().default(0),
});

/** A full load's resume position, persisted as the framework sync cursor. */
export type ExportCursor = z.infer<typeof ExportCursorSchema>;

/**
 * Reads a persisted export cursor. `undefined` for none, and for a value no build of this module
 * wrote — a full load then starts over, which a resume could not do correctly anyway.
 */
export function parseExportCursor(raw: string | undefined): ExportCursor | undefined {
  if (raw === undefined) return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  const parsed = ExportCursorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Options for one full load. */
export interface ExportLoadOptions extends IngestOptions {
  /** Where the export is downloaded to; deleted once it is ingested. */
  downloadPath: string;
  /**
   * Generation a fresh load stamps. A resumed load keeps its cursor's, which moves to the next one
   * when the export changes after the ingest began.
   */
  generation: number;
  /** Called with the load once `mirror_load` records it. */
  onLoaded(load: MirrorLoad): void;
  /** The checkpoint before this load, kept in place until the load completes. */
  previousCheckpoint: string | undefined;
}

/**
 * Full load. Every page carries the cursor, so an interrupt anywhere resumes with no line skipped
 * or applied twice: the download from its byte offset, the ingest from its line count (and the
 * count of lines it skipped through it), the sweep from its rowid. While it ingests over a store
 * that already cites an as-of, that as-of is the older of the one the run began with and the newest
 * `last_modified_t` among the rows the load has stamped (see {@link asOfMoves}). The export's own
 * as-of is set on the last page, after the sweep and the sort index builds.
 *
 * @throws McpError `ServiceUnavailable` `export_no_products` before the sweep when the load, across
 *   every run it took, stamped no product: the store is left as it was, the download deleted, and
 *   the cursor sent back to the download.
 */
export async function* exportLoad(
  ctx: SyncContext,
  options: ExportLoadOptions,
): AsyncGenerator<SyncPage> {
  const { builder, downloadPath, handle, log, upstream } = options;
  let cursor: ExportCursor = parseExportCursor(ctx.cursor) ?? {
    v: 1,
    generation: options.generation,
    phase: 'download',
    line: 0,
    maxModifiedT: 0,
    rowid: 0,
    skipped: 0,
  };
  const begun = ctx.checkpoint ?? options.previousCheckpoint;
  /**
   * The runner clears the checkpoint when a load starts over a completed store; restoring it keeps
   * mirrorAsOf() truthful while the old data keeps serving.
   */
  if (ctx.checkpoint === undefined && begun !== undefined) {
    yield { records: [], cursor: JSON.stringify(cursor), checkpoint: begun };
  }
  let moveAsOf = asOfMoves(begun);
  /**
   * A resumed cursor lowers the as-of over the rows it already stamped before anything else, for a
   * run stopped by a release that kept citing the as-of it began with: the next ingest page can be
   * minutes of skipped lines away, and a resumed sweep has none. The run then begins from the
   * lowered as-of, as one whose checkpoint a stopped run already lowered does: those rows serve
   * until the load rewrites or sweeps them, under an export that can change before it does.
   */
  const resumed = moveAsOf([], cursor).ahead;
  if (resumed !== undefined) {
    yield resumed;
    moveAsOf = asOfMoves(resumed.checkpoint);
  }

  while (cursor.phase !== 'done') {
    if (cursor.phase === 'download') {
      const size = await fileSize(downloadPath);
      if (cursor.totalBytes === undefined || size !== cursor.totalBytes) {
        const resumeFrom =
          cursor.etag !== undefined && size > 0 && size < (cursor.totalBytes ?? 0) ? size : 0;
        const download = await requestExport(upstream, resumeFrom, cursor.etag, ctx.signal);
        try {
          if (download.response.status === 200) {
            const etag = strongEtag(download.response);
            const totalBytes = contentLength(download.response);
            if (etag !== cursor.etag) {
              /**
               * Rows the abandoned export already stamped carry this load's generation; a new one
               * leaves every row the new export does not stamp to the sweep.
               */
              const generation = cursor.line > 0 ? cursor.generation + 1 : cursor.generation;
              if (cursor.etag !== undefined) {
                log.notice?.('The export changed upstream; its download and ingest restart.', {
                  previousEtag: cursor.etag,
                  etag,
                  generation,
                });
              }
              cursor = {
                ...cursor,
                etag,
                generation,
                totalBytes,
                line: 0,
                maxModifiedT: 0,
                skipped: 0,
              };
            } else {
              cursor = { ...cursor, totalBytes };
            }
            /**
             * Empty the file before the identity is persisted: a crash in between must never leave
             * one export's bytes under another's ETag.
             */
            await writeFile(downloadPath, '');
            yield { records: [], cursor: JSON.stringify(cursor) };
          } else {
            assertContinues(download.response, resumeFrom, cursor.totalBytes);
          }
          log.info?.('Downloading the export.', {
            fromByte: download.response.status === 206 ? resumeFrom : 0,
            totalBytes: cursor.totalBytes,
          });
          await appendBody(download, downloadPath);
        } finally {
          await download.release();
        }
        const written = await fileSize(downloadPath);
        if (written !== cursor.totalBytes) {
          throw serviceUnavailable(
            `The export download ended at byte ${written} of ${cursor.totalBytes}; the next run resumes it.`,
            { reason: 'upstream_body_truncated' },
          );
        }
      }
      cursor = { ...cursor, phase: 'ingest' };
      yield { records: [], cursor: JSON.stringify(cursor) };
      continue;
    }

    if (cursor.phase === 'ingest') {
      if ((await fileSize(downloadPath)) !== cursor.totalBytes) {
        cursor = { ...cursor, phase: 'download' };
        continue;
      }
      const lines = gunzipLines(createReadStream(downloadPath));
      const skip = cursor.line;
      let line = 0;
      let { skipped } = cursor;
      const onSkip = (reason: SkippedLineReason, bytes?: number) => {
        skipped += 1;
        logSkippedLine(log, 'export', line, reason, bytes);
      };
      let pending: MirrorRecord[] = [];
      let pages = 0;
      try {
        for await (const bytes of lines.lines) {
          line += 1;
          if (line <= skip) {
            if (line % 10_000 === 0) ctx.signal.throwIfAborted();
            continue;
          }
          const record = buildLine(builder, bytes, onSkip);
          if (record !== null) pending.push(record);
          if (pending.length < PAGE_SIZE) continue;
          const move = moveAsOf(pending, cursor);
          if (move.ahead) yield move.ahead;
          cursor = {
            ...cursor,
            line,
            maxModifiedT: maxModified(cursor.maxModifiedT, pending),
            skipped,
          };
          const records = toRows(pending, cursor.generation, options);
          pending = [];
          yield { records, cursor: JSON.stringify(cursor), ...move.after };
          pages += 1;
          maintain(handle, pages, log, { phase: 'ingest', line });
        }
      } catch (err) {
        if (!ctx.signal.aborted && isZlibError(err)) {
          /**
           * A corrupt download: drop it and keep the line position, which stays valid for the same
           * ETag and is reset by the download if the export has changed since.
           */
          await rm(downloadPath, { force: true });
          yield { records: [], cursor: JSON.stringify({ ...cursor, phase: 'download' }) };
          throw serviceUnavailable(
            'The downloaded export failed to decompress and was deleted; the next run downloads it again.',
            { reason: 'export_corrupt' },
            { cause: err },
          );
        }
        throw err;
      } finally {
        lines.destroy();
      }
      const move = moveAsOf(pending, cursor);
      if (move.ahead) yield move.ahead;
      cursor = {
        ...cursor,
        phase: 'sweep',
        line,
        maxModifiedT: maxModified(cursor.maxModifiedT, pending),
        rowid: 0,
        skipped,
      };
      yield {
        records: toRows(pending, cursor.generation, options),
        cursor: JSON.stringify(cursor),
        ...move.after,
      };
      await rm(downloadPath, { force: true });
      log.info?.('Ingested the export; sweeping rows it no longer lists.', {
        lines: line,
        skippedLines: skipped,
      });
      continue;
    }

    const lastRowid =
      handle.prepare<{ last: number | null }>('SELECT MAX(rowid) AS last FROM products').get()
        ?.last ?? 0;
    /**
     * A sweep after a load that stamped no product would delete every row. The store, not the
     * cursor, says whether one was stamped, so a load stamped in an earlier run, or under a cursor
     * an earlier build wrote with no such count, is never refused. Checked on every entry to the
     * sweep, a resumed one included, one rowid window per statement as the sweep reads; a load
     * that stamped anything ends it at its first stamped row.
     */
    const stampedIn = handle.prepare<{ found: number }>(
      'SELECT 1 AS found FROM products WHERE rowid > ? AND rowid <= ? AND generation = ? LIMIT 1',
    );
    let stamped = false;
    for (let from = 0; !stamped && from < lastRowid; from += SWEEP_WINDOW) {
      stamped = stampedIn.get(from, from + SWEEP_WINDOW, cursor.generation) != null;
    }
    if (!stamped) {
      await rm(downloadPath, { force: true });
      yield { records: [], cursor: JSON.stringify({ ...cursor, phase: 'download' }) };
      throw serviceUnavailable(
        `The export built no product from its ${cursor.line} lines (${cursor.skipped} skipped as malformed or past 16 MiB), so the load stopped before its sweep would empty the store; the store is unchanged, the download was deleted, and the next run downloads the export again.`,
        { reason: 'export_no_products' },
      );
    }

    // Sweep: tombstone every row an earlier load stamped and this one did not.
    const stale = handle.prepare<{ code: string }>(
      'SELECT code FROM products WHERE rowid > ? AND rowid <= ? AND generation < ?',
    );
    while (cursor.rowid < lastRowid) {
      const to = cursor.rowid + SWEEP_WINDOW;
      const tombstones = stale.all(cursor.rowid, to, cursor.generation).map((row) => row.code);
      cursor = { ...cursor, rowid: to };
      yield { records: [], tombstones, cursor: JSON.stringify(cursor) };
    }
    cursor = { ...cursor, phase: 'done' };
  }

  /**
   * Built in one sorted pass each once the products are in, and before the load completes, so a
   * store is never served without them; maintained through the ingest, they slow it and come out
   * larger.
   */
  const built = await ensureSortIndexes(handle);
  if (built.length > 0) log.info?.('Built the sort indexes.', { indexes: built });

  yield {
    records: [],
    cursor: JSON.stringify(cursor),
    checkpoint: encodeCheckpoint({
      generation: cursor.generation,
      asOfSeconds: cursor.maxModifiedT,
    }),
  };
  const load: MirrorLoad = {
    generation: cursor.generation,
    loadedAt: new Date().toISOString(),
    recordVersion: builder.MIRROR_RECORD_VERSION,
    ...(cursor.etag !== undefined && { etag: cursor.etag }),
    skippedLines: cursor.skipped,
  };
  writeMirrorLoad(handle, load);
  options.onLoaded(load);
}

/** Options for one delta pass. */
export interface DeltaPassOptions extends IngestOptions {
  /** The delta index, parsed. */
  index: readonly DeltaFile[];
  /** Called with each delta's name, and the lines of it skipped, once its last page is applied. */
  onApplied(name: string, skippedLines: number): void;
}

/**
 * Applies each delta ending past the checkpoint, oldest first, stopping before a gap the listed
 * deltas cannot bridge. A delta's pages carry no checkpoint until its last, so an interrupted
 * delta is applied again whole (upserts are idempotent) and a completed one is never applied twice.
 */
export async function* deltaPass(
  ctx: SyncContext,
  options: DeltaPassOptions,
): AsyncGenerator<SyncPage> {
  if (ctx.checkpoint === undefined) {
    throw new Error('deltaPass needs the checkpoint of a completed full load.');
  }
  const { generation, asOfSeconds } = decodeCheckpoint(ctx.checkpoint);
  let pages = 0;
  for (const delta of planDeltas(options.index, asOfSeconds).deltas) {
    await delay(options.upstream.requestGapMs, undefined, { signal: ctx.signal });
    const download = await requestOk(
      new URL(delta.name, options.upstream.deltaBaseUrl).href,
      options.upstream.userAgent,
      ctx.signal,
    );
    let lines = 0;
    let skipped = 0;
    const onSkip = (reason: SkippedLineReason, bytes?: number) => {
      skipped += 1;
      logSkippedLine(options.log, delta.name, lines, reason, bytes);
    };
    let pending: MirrorRecord[] = [];
    const stream = gunzipLines(Readable.from(bodyChunks(download)));
    try {
      for await (const bytes of stream.lines) {
        lines += 1;
        const record = buildLine(options.builder, bytes, onSkip);
        if (record !== null) pending.push(record);
        if (pending.length < PAGE_SIZE) continue;
        const records = toRows(pending, generation, options);
        pending = [];
        yield { records };
        pages += 1;
        maintain(options.handle, pages, options.log, { phase: 'delta', delta: delta.name });
      }
    } finally {
      stream.destroy();
      await download.release();
    }
    yield {
      records: toRows(pending, generation, options),
      checkpoint: encodeCheckpoint({ generation, asOfSeconds: delta.endSeconds }),
    };
    options.onApplied(delta.name, skipped);
    options.log.info?.('Applied a delta.', { delta: delta.name, lines, skippedLines: skipped });
  }
}

/**
 * The export's current ETag, read with a HEAD request, or `undefined` when the response carries
 * none. Non-2xx throws `upstream_status`.
 */
export async function fetchExportEtag(
  upstream: MirrorUpstream,
  signal: AbortSignal,
): Promise<string | undefined> {
  const head = await requestOk(upstream.exportUrl, upstream.userAgent, signal, 'HEAD');
  try {
    return head.response.headers.get('etag') ?? undefined;
  } finally {
    await head.release();
  }
}

/** Fetches and parses the delta index. Non-2xx throws `upstream_status`. */
export async function fetchDeltaIndex(
  upstream: MirrorUpstream,
  signal: AbortSignal,
): Promise<DeltaFile[]> {
  const download = await requestOk(
    new URL('index.txt', upstream.deltaBaseUrl).href,
    upstream.userAgent,
    signal,
  );
  try {
    const parts: Buffer[] = [];
    for await (const chunk of bodyChunks(download)) parts.push(Buffer.from(chunk));
    return parseDeltaIndex(Buffer.concat(parts).toString('utf8'));
  } finally {
    await download.release();
  }
}

/** Resolves tag keys to `tags.id`, inserting new keys; caches up to `TAG_CACHE_MAX` of them. */
export class TagIds {
  private readonly cache = new Map<string, number>();

  /** Ids for `keys`, in one write transaction for any not cached. */
  resolve(handle: SqliteHandle, keys: ReadonlySet<string>): Map<string, number> {
    if (this.cache.size + keys.size > TAG_CACHE_MAX) this.cache.clear();
    const missing = [...keys].filter((key) => !this.cache.has(key));
    if (missing.length > 0) {
      const insert = handle.prepare('INSERT INTO tags(key) VALUES (?) ON CONFLICT(key) DO NOTHING');
      const select = handle.prepare<{ id: number }>('SELECT id FROM tags WHERE key = ?');
      handle.transaction(() => {
        for (const key of missing) {
          insert.run(key);
          const row = select.get(key);
          if (row == null) throw new Error(`Tag key "${key}" vanished after its insert.`);
          this.cache.set(key, row.id);
        }
      });
    }
    const ids = new Map<string, number>();
    for (const key of keys) {
      const id = this.cache.get(key);
      if (id === undefined) throw new Error(`Tag key "${key}" has no id.`);
      ids.set(key, id);
    }
    return ids;
  }
}

function toRows(records: MirrorRecord[], generation: number, options: IngestOptions): MirrorRow[] {
  const keys = new Set<string>();
  for (const record of records) for (const key of record.tags) keys.add(key);
  const ids = options.tags.resolve(options.handle, keys);
  return records.map((record) => ({
    code: record.code,
    popularity_key: record.popularityKey,
    unique_scans_n: record.uniqueScansN,
    created_t: record.createdT,
    last_modified_t: record.lastModifiedT,
    generation,
    record_version: options.builder.MIRROR_RECORD_VERSION,
    // Sorted and deduplicated, so an unchanged tag set compares equal and skips its trigger.
    tag_ids: JSON.stringify(
      [...new Set(record.tags.map((key) => ids.get(key) as number))].sort((a, b) => a - b),
    ),
    doc: JSON.stringify(record.doc),
  }));
}

/** Why a feed line was skipped rather than ingested. */
type SkippedLineReason = 'upstream_line_malformed' | 'upstream_line_too_long';

/**
 * The record a feed line builds, or `null` for a blank or unservable line. A line that is not
 * valid JSON, or that ran past 16 MiB, is handed to `onSkip` instead: it is a per-record failure
 * in otherwise valid upstream content, which fetching the feed again would bring back unchanged.
 */
function buildLine(
  builder: MirrorBuilder,
  bytes: Buffer | OversizeLine,
  onSkip: (reason: SkippedLineReason, bytes?: number) => void,
): MirrorRecord | null {
  if (!Buffer.isBuffer(bytes)) {
    onSkip('upstream_line_too_long', bytes.oversizeBytes);
    return null;
  }
  if (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 0x0d)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    // The parser's message quotes the line, so it never reaches the log.
    onSkip('upstream_line_malformed');
    return null;
  }
  return builder.buildMirrorRecord(parsed);
}

/** Logs one skipped line by feed, line number, reason, and length, never its content. */
function logSkippedLine(
  log: MirrorLogger,
  feed: string,
  line: number,
  reason: SkippedLineReason,
  bytes?: number,
): void {
  log.warning?.(
    reason === 'upstream_line_malformed'
      ? 'Skipped a feed line that is not valid JSON.'
      : 'Skipped a feed line longer than 16 MiB.',
    { feed, line, reason, ...(bytes !== undefined && { bytes }) },
  );
}

function maxModified(current: number, records: readonly MirrorRecord[]): number {
  let max = current;
  for (const record of records) {
    if (record.lastModifiedT !== null && record.lastModifiedT > max) max = record.lastModifiedT;
  }
  return max;
}

/** How the checkpoint moves with one ingest page: a page of its own ahead of the rows, or on theirs. */
interface AsOfMove {
  /** The checkpoint raising the as-of, committed with the rows' own page, after them. */
  after?: { checkpoint: string };
  /** A records-empty page lowering the as-of, committed before the rows it covers. */
  ahead?: SyncPage & { checkpoint: string };
}

/**
 * The as-of a full load cites while it ingests over a store whose checkpoint was `begun`: the older
 * of `begun`'s as-of and the newest `last_modified_t` the load will have stamped once a page lands,
 * encoded under the load's generation, whose higher prefix lets the runner accept it below `begun`.
 * A row rewritten to an export older than the deltas behind `begun` so never serves under a time
 * newer than itself. The runner commits a page's rows before its checkpoint, so a drop goes in a
 * page of its own ahead of the rows it covers and a rise rides the rows' own page. The returned
 * function takes each page's records and the cursor before that page advances it, or no records and
 * the cursor a run resumes from. A load with no `begun` (a first one, which serves nothing), and no
 * records over a cursor that has stamped none, move nothing.
 */
function asOfMoves(
  begun: string | undefined,
): (records: readonly MirrorRecord[], cursor: ExportCursor) => AsOfMove {
  if (begun === undefined) return () => ({});
  const begunAt = decodeCheckpoint(begun).asOfSeconds;
  let cited = begunAt;
  return (records, cursor) => {
    if (records.length === 0 && cursor.maxModifiedT === 0) return {};
    const asOfSeconds = Math.min(begunAt, maxModified(cursor.maxModifiedT, records));
    if (asOfSeconds === cited) return {};
    const checkpoint = encodeCheckpoint({ generation: cursor.generation, asOfSeconds });
    const lowered = asOfSeconds < cited;
    cited = asOfSeconds;
    return lowered
      ? { ahead: { records: [], cursor: JSON.stringify(cursor), checkpoint } }
      : { after: { checkpoint } };
  };
}

const bunRuntime = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;

function maintain(
  handle: SqliteHandle,
  pages: number,
  log: MirrorLogger,
  progress: Record<string, unknown>,
): void {
  if (pages % MAINTENANCE_EVERY_PAGES !== 0) return;
  handle.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  bunRuntime?.gc(true);
  log.info?.('Mirror sync progress.', { ...progress, pages });
}

/** An in-flight upstream response with its stall guard. */
interface Download {
  /** Clears the stall timer and cancels a body nothing has read. Idempotent. */
  release(): Promise<void>;
  /** Re-arms the stall timer; called per received chunk. */
  resetStall(): void;
  response: Response;
}

async function startRequest(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  method: 'GET' | 'HEAD' = 'GET',
): Promise<Download> {
  const stall = new AbortController();
  const arm = () =>
    setTimeout(
      () =>
        stall.abort(
          serviceUnavailable(
            `No bytes arrived from ${url} for ${STALL_TIMEOUT_MS / 1000} s; the sync stopped and resumes on the next run.`,
            { reason: 'upstream_stalled' },
          ),
        ),
      STALL_TIMEOUT_MS,
    );
  let timer = arm();
  const release = () => clearTimeout(timer);
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      method,
      signal: AbortSignal.any([signal, stall.signal]),
    });
  } catch (err) {
    release();
    throw stall.signal.aborted && !signal.aborted ? stall.signal.reason : err;
  }
  return {
    response,
    resetStall() {
      clearTimeout(timer);
      timer = arm();
    },
    async release() {
      release();
      // A body that was iterated is already closed or cancelled by its iterator.
      if (response.body !== null && !response.bodyUsed) await response.body.cancel();
    },
  };
}

/** Starts a GET (or HEAD) that must answer 2xx. */
async function requestOk(
  url: string,
  userAgent: string,
  signal: AbortSignal,
  method: 'GET' | 'HEAD' = 'GET',
): Promise<Download> {
  const download = await startRequest(url, { 'User-Agent': userAgent }, signal, method);
  if (!download.response.ok) {
    await download.release();
    throw upstreamStatus(url, download.response.status);
  }
  return download;
}

/** Starts the export GET: ranged from `fromByte` when resuming, answered 200 or 206. */
async function requestExport(
  upstream: MirrorUpstream,
  fromByte: number,
  etag: string | undefined,
  signal: AbortSignal,
): Promise<Download> {
  const headers: Record<string, string> = { 'User-Agent': upstream.userAgent };
  if (fromByte > 0 && etag !== undefined) {
    headers.Range = `bytes=${fromByte}-`;
    headers['If-Range'] = etag;
  }
  const download = await startRequest(upstream.exportUrl, headers, signal);
  const { status } = download.response;
  if (status !== 200 && !(status === 206 && fromByte > 0)) {
    await download.release();
    throw upstreamStatus(upstream.exportUrl, status);
  }
  return download;
}

const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+)$/;

/** A 206 must continue exactly where the file ends, within the export the cursor names. */
function assertContinues(
  response: Response,
  fromByte: number,
  totalBytes: number | undefined,
): void {
  const match = CONTENT_RANGE_PATTERN.exec(response.headers.get('content-range') ?? '');
  if (!match || Number(match[1]) !== fromByte || Number(match[3]) !== totalBytes) {
    throw serviceUnavailable(
      `The export answered a resume from byte ${fromByte} with Content-Range "${response.headers.get('content-range') ?? ''}"; the sync stopped.`,
      { reason: 'upstream_range_mismatch' },
    );
  }
}

function strongEtag(response: Response): string {
  const etag = response.headers.get('etag');
  if (etag === null || etag.startsWith('W/')) {
    throw serviceUnavailable(
      'The export response carries no strong ETag, so an interrupted download could not be resumed safely; the sync stopped.',
      { reason: 'export_unresumable' },
    );
  }
  return etag;
}

function contentLength(response: Response): number {
  const length = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw serviceUnavailable(
      'The export response carries no Content-Length, so a complete download cannot be told from a cut one; the sync stopped.',
      { reason: 'export_unresumable' },
    );
  }
  return length;
}

function upstreamStatus(url: string, status: number): McpError {
  return serviceUnavailable(
    `Open Food Facts answered HTTP ${status} for ${url}; the sync stopped with its checkpoint unchanged.`,
    { reason: 'upstream_status', status, url },
  );
}

/**
 * Gunzips `source` into lines. `pipe()` forwards no errors, so a failing source destroys the
 * gunzip with its error rather than leaving the line iterator waiting forever.
 */
function gunzipLines(source: Readable): {
  destroy(): void;
  lines: AsyncGenerator<Buffer | OversizeLine>;
} {
  const gunzip = createGunzip();
  source.on('error', (err) => gunzip.destroy(err));
  source.pipe(gunzip);
  return {
    lines: readLines(gunzip),
    destroy() {
      source.destroy();
      gunzip.destroy();
    },
  };
}

async function* bodyChunks(download: Download): AsyncGenerator<Uint8Array> {
  const { body } = download.response;
  if (body === null) return;
  for await (const chunk of body) {
    download.resetStall();
    yield chunk;
  }
}

async function appendBody(download: Download, path: string): Promise<void> {
  const file = await open(path, 'a');
  try {
    for await (const chunk of bodyChunks(download)) await file.write(chunk);
  } finally {
    await file.close();
  }
}

function isZlibError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code.startsWith('Z_');
}
