/**
 * @fileoverview One mirror sync run, the unit `mirror:init`, `mirror:refresh`, and the scheduled job
 * all execute: refuse a refresh at a path naming no file, take the cross-process lock, build any
 * sort index a loaded store lacks, decide between resuming a full load, starting one, and applying
 * deltas, run it through the framework runner, then a delta pass, `ANALYZE` once, and a WAL
 * truncate. A reload a refresh finds due for age or a gap is skipped while the export's ETag still
 * matches the one the last load read. Runs only out of the serving process: its write transactions
 * and index builds block the event loop.
 * @module services/mirror/mirror-sync
 */

import { existsSync } from 'node:fs';
import { conflict, type McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  defineMirror,
  type MirrorLogger,
  type MirrorStore,
  type SqliteHandle,
  type SyncGenerator,
  type SyncResult,
} from '@cyanheads/mcp-ts-core/mirror';
import { type DeltaFile, planDeltas } from './mirror-feeds.js';
import {
  deltaPass,
  exportLoad,
  fetchDeltaIndex,
  fetchExportEtag,
  type MirrorBuilder,
  type MirrorUpstream,
  OFF_UPSTREAM,
  parseExportCursor,
  TagIds,
} from './mirror-ingester.js';
import { acquireMirrorLock, type MirrorLock } from './mirror-lock.js';
import {
  decodeCheckpoint,
  ensureSortIndexes,
  hasProducts,
  type MirrorLoad,
  openMirrorStore,
  readMirrorLoad,
} from './mirror-store.js';

/** Full loads are repeated this often: deltas never report deleted products, only a reload does. */
const FULL_RELOAD_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/** WAL size SQLite truncates back to after each checkpoint. */
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

const MIRROR_NAME = 'openfoodfacts-products';

/**
 * Why a run did a full load. `requested`: `mirror:init`. `resume`: an interrupted load continued.
 * `record_version`, `age`, `gap`: a refresh found the last load built by an older record builder,
 * 30 days old, or no longer bridgeable by the listed deltas.
 */
export type FullLoadReason = 'age' | 'gap' | 'record_version' | 'requested' | 'resume';

/** The reload reasons an unchanged export cancels: reading the same export again changes nothing. */
type ExportBoundReason = Extract<FullLoadReason, 'age' | 'gap'>;

/** The warning a refresh logs when it skips a due reload because the export is unchanged. */
const UNCHANGED_EXPORT: Readonly<Record<ExportBoundReason, string>> = {
  age: 'The last full load is 30 days old, but the export is unchanged since that load, so reloading it would change nothing; the reload is skipped and the mirror keeps serving.',
  gap: 'The listed deltas no longer reach back to the mirror’s checkpoint, but the export is unchanged since the last full load, so reloading it would leave the gap in place; the reload is skipped and the mirror keeps serving.',
};

/** Options for {@link runMirrorSync}. */
export interface MirrorSyncOptions {
  builder: MirrorBuilder;
  log: MirrorLogger;
  /** `init` always runs a full load (resuming one in progress); `refresh` decides. */
  mode: 'init' | 'refresh';
  /** The store file; the export download sits beside it. */
  path: string;
  signal: AbortSignal;
  /** Defaults to Open Food Facts' published feeds. */
  upstream?: MirrorUpstream;
}

/** What a run did. */
export interface MirrorSyncReport {
  deltaResult: SyncResult;
  /** Delta files applied, oldest first. */
  deltasApplied: string[];
  fullLoad?: {
    generation: number;
    reason: FullLoadReason;
    result: SyncResult;
    /** Export lines the load skipped as malformed or past 16 MiB, across every run it took. */
    skippedLines: number;
  };
  /** A reload due for this reason, not run because the export's ETag matches the last load's. */
  reloadSkipped?: ExportBoundReason;
  /** Lines of the applied deltas skipped as malformed or past 16 MiB. */
  skippedDeltaLines: number;
}

/**
 * Runs one sync under the cross-process lock. Pages and sync state are written only while the lease
 * is this run's (see {@link leased}).
 *
 * @throws McpError `Conflict` `mirror_lock_held` when another run holds the lock, `mirror_lock_lost`
 *   when one reclaims it mid-run, and `mirror_not_initialized` for a refresh before any full load,
 *   at a path naming no file included.
 * @throws McpError `ServiceUnavailable` for an upstream failure (`upstream_status` on any non-2xx),
 *   with the checkpoint unchanged.
 */
export async function runMirrorSync(options: MirrorSyncOptions): Promise<MirrorSyncReport> {
  /**
   * Opening a store creates its file and directories, so a refresh at a path naming no file (a
   * mistyped `OFF_MIRROR_PATH`, an unmounted volume) is refused before anything opens; only an init
   * creates a store.
   */
  if (options.mode === 'refresh' && !existsSync(options.path)) throw notInitialized(false);
  const upstream = options.upstream ?? OFF_UPSTREAM;
  const store = openMirrorStore(options.path);
  try {
    const handle = await store.raw();
    handle.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
    const lock = acquireMirrorLock(handle);
    try {
      const signal = AbortSignal.any([options.signal, lock.lost]);
      /**
       * A loaded store lacking a sort index gets it before anything else; a first load builds them
       * as it ends, after its ingest.
       */
      if (readMirrorLoad(handle) !== undefined) {
        const built = await ensureSortIndexes(handle);
        if (built.length > 0) options.log.info?.('Built the sort indexes.', { indexes: built });
      }
      const report = await sync(leased(store, lock), handle, { ...options, signal, upstream });
      analyzeOnce(handle);
      handle.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      return report;
    } finally {
      lock.release();
    }
  } finally {
    await store.close();
  }
}

/**
 * `store` with its two writes made only while `lock` holds, checked against the lease row before
 * each. The framework runner writes its state from its own cursor and checkpoint after every page
 * and once more when its run fails, so a run another process reclaimed the lease from would
 * otherwise overwrite the state of the run that reclaimed it, moving a completed load's checkpoint
 * back and leaving a resumable cursor behind.
 */
function leased(store: MirrorStore, lock: MirrorLock): MirrorStore {
  return {
    ...store,
    async applyBatch(records, tombstones) {
      lock.assertHeld();
      await store.applyBatch(records, tombstones);
    },
    async writeState(state) {
      lock.assertHeld();
      await store.writeState(state);
    },
  };
}

async function sync(
  store: MirrorStore,
  handle: SqliteHandle,
  options: MirrorSyncOptions & { upstream: MirrorUpstream },
): Promise<MirrorSyncReport> {
  const { builder, log, signal, upstream } = options;
  const tags = new TagIds();
  const ingest = { builder, handle, log, tags, upstream };
  const run = (generator: SyncGenerator, mode: 'init' | 'refresh') =>
    defineMirror({ name: MIRROR_NAME, store, logger: log, sync: generator }).runSync({
      mode,
      signal,
    });

  const state = await store.readState();
  const load = readMirrorLoad(handle);
  const pending = state.status === 'complete' ? undefined : parseExportCursor(state.cursor);
  let index: DeltaFile[] | undefined;
  let reason: FullLoadReason | undefined;
  if (load === undefined && options.mode === 'refresh') {
    // The first load is the operator's to start and to resume; a refresh never downloads it.
    throw notInitialized(pending !== undefined);
  }
  let reloadSkipped: ExportBoundReason | undefined;
  if (pending !== undefined) reason = 'resume';
  else if (options.mode === 'init') reason = 'requested';
  else if (load !== undefined) {
    index = await fetchDeltaIndex(upstream, signal);
    reason = reloadReason(load, state.checkpoint, index, builder.MIRROR_RECORD_VERSION);
    /**
     * An export the last load already read leaves an age reload nothing to remove and a gap
     * where it is, while costing a 13 GB download; a store that recorded no ETag reloads.
     */
    if (
      (reason === 'age' || reason === 'gap') &&
      load.etag !== undefined &&
      (await fetchExportEtag(upstream, signal)) === load.etag
    ) {
      log.warning?.(UNCHANGED_EXPORT[reason], {
        reason,
        etag: load.etag,
        loadedAt: load.loadedAt,
        ...(reason === 'gap' &&
          state.checkpoint !== undefined && {
            asOf: isoTime(decodeCheckpoint(state.checkpoint).asOfSeconds),
          }),
      });
      reloadSkipped = reason;
      reason = undefined;
    }
  }

  let fullLoad: MirrorSyncReport['fullLoad'];
  if (reason !== undefined) {
    const generation = pending?.generation ?? (load?.generation ?? 0) + 1;
    log.info?.('Starting a full load of the export.', { reason, generation });
    let loaded = generation;
    let skippedLines = 0;
    const result = await run(
      (ctx) =>
        exportLoad(ctx, {
          ...ingest,
          downloadPath: `${options.path}.export.jsonl.gz`,
          generation,
          onLoaded: (completed) => {
            loaded = completed.generation;
            skippedLines = completed.skippedLines;
          },
          previousCheckpoint: state.checkpoint,
        }),
      'init',
    );
    fullLoad = { generation: loaded, reason, result, skippedLines };
    index = undefined; // the load can take an hour; read a current index for the deltas after it
  }

  index ??= await fetchDeltaIndex(upstream, signal);
  const deltasApplied: string[] = [];
  let skippedDeltaLines = 0;
  const checkpoint = (await store.readState()).checkpoint;
  const plan =
    checkpoint === undefined
      ? undefined
      : planDeltas(index, decodeCheckpoint(checkpoint).asOfSeconds);
  // A skipped gap reload has already named the gap.
  if (plan?.kind !== 'apply' && reloadSkipped !== 'gap') {
    log.warning?.(
      'The listed deltas leave a gap after the mirror’s checkpoint; the mirror applies those before it and waits for a full load to bridge it.',
      {
        checkpoint,
        ...(plan?.kind === 'gap' && { gapAfter: isoTime(plan.resumesAtSeconds) }),
      },
    );
  }
  const deltaResult = await run(
    plan === undefined
      ? async function* () {}
      : (ctx) =>
          deltaPass(ctx, {
            ...ingest,
            index,
            onApplied: (name, skipped) => {
              deltasApplied.push(name);
              skippedDeltaLines += skipped;
            },
          }),
    'refresh',
  );
  return {
    deltasApplied,
    deltaResult,
    skippedDeltaLines,
    ...(fullLoad !== undefined && { fullLoad }),
    ...(reloadSkipped !== undefined && { reloadSkipped }),
  };
}

/** A refresh refused because no full load has completed: `interrupted` when one is in progress. */
function notInitialized(interrupted: boolean): McpError {
  return conflict(
    interrupted
      ? 'The mirror store’s first full load was interrupted. Run `bun run mirror:init` to resume it.'
      : 'The mirror store has never completed a full load, so there is nothing to refresh. Run `bun run mirror:init` first.',
    { reason: 'mirror_not_initialized' },
  );
}

function isoTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Why the store needs a full load before deltas, if it does. An older record builder comes first:
 * it is the one reason an unchanged export does not cancel.
 */
function reloadReason(
  load: MirrorLoad,
  checkpoint: string | undefined,
  index: readonly DeltaFile[],
  recordVersion: number,
): FullLoadReason | undefined {
  if (load.recordVersion < recordVersion) return 'record_version';
  if (Date.now() - Date.parse(load.loadedAt) >= FULL_RELOAD_INTERVAL_MS) return 'age';
  if (
    checkpoint === undefined ||
    planDeltas(index, decodeCheckpoint(checkpoint).asOfSeconds).kind === 'gap'
  ) {
    return 'gap';
  }
  return;
}

/** `ANALYZE` the first time the store holds data, with sampling so it stays seconds long. */
function analyzeOnce(handle: SqliteHandle): void {
  const analyzed =
    handle
      .prepare<{ found: number }>(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'",
      )
      .get() != null;
  if (analyzed || !hasProducts(handle)) return;
  handle.exec('PRAGMA analysis_limit = 1000');
  handle.exec('ANALYZE');
}
