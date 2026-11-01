/**
 * @fileoverview One mirror sync run, the unit `mirror:init`, `mirror:refresh`, and the scheduled job
 * all execute: take the cross-process lock, build any sort index a loaded store lacks, decide between
 * resuming a full load, starting one, and applying deltas, run it through the framework runner,
 * then a delta pass, `ANALYZE` once, and a WAL truncate. Runs only out of the serving process: its
 * write transactions and index builds block the event loop.
 * @module services/mirror/mirror-sync
 */

import { conflict } from '@cyanheads/mcp-ts-core/errors';
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
 * `age`, `record_version`, `gap`: a refresh found the last load 30 days old, built by an older
 * record builder, or no longer bridgeable by the listed deltas.
 */
export type FullLoadReason = 'age' | 'gap' | 'record_version' | 'requested' | 'resume';

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
  fullLoad?: { generation: number; reason: FullLoadReason; result: SyncResult };
}

/**
 * Runs one sync under the cross-process lock. Pages and sync state are written only while the lease
 * is this run's (see {@link leased}).
 *
 * @throws McpError `Conflict` `mirror_lock_held` when another run holds the lock, `mirror_lock_lost`
 *   when one reclaims it mid-run, and `mirror_not_initialized` for a refresh before any full load.
 * @throws McpError `ServiceUnavailable` for an upstream failure (`upstream_status` on any non-2xx),
 *   with the checkpoint unchanged.
 */
export async function runMirrorSync(options: MirrorSyncOptions): Promise<MirrorSyncReport> {
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
    throw conflict(
      pending === undefined
        ? 'The mirror store has never completed a full load, so there is nothing to refresh. Run `bun run mirror:init` first.'
        : 'The mirror store’s first full load was interrupted. Run `bun run mirror:init` to resume it.',
      { reason: 'mirror_not_initialized' },
    );
  }
  if (pending !== undefined) reason = 'resume';
  else if (options.mode === 'init') reason = 'requested';
  else if (load !== undefined) {
    index = await fetchDeltaIndex(upstream, signal);
    reason = reloadReason(load, state.checkpoint, index, builder.MIRROR_RECORD_VERSION);
  }

  let fullLoad: MirrorSyncReport['fullLoad'];
  if (reason !== undefined) {
    const generation = pending?.generation ?? (load?.generation ?? 0) + 1;
    log.info?.('Starting a full load of the export.', { reason, generation });
    let loaded = generation;
    const result = await run(
      (ctx) =>
        exportLoad(ctx, {
          ...ingest,
          downloadPath: `${options.path}.export.jsonl.gz`,
          generation,
          onLoaded: (completed) => {
            loaded = completed;
          },
          previousCheckpoint: state.checkpoint,
        }),
      'init',
    );
    fullLoad = { generation: loaded, reason, result };
    index = undefined; // the load can take an hour; read a current index for the deltas after it
  }

  index ??= await fetchDeltaIndex(upstream, signal);
  const deltasApplied: string[] = [];
  const checkpoint = (await store.readState()).checkpoint;
  const bridgeable =
    checkpoint !== undefined &&
    planDeltas(index, decodeCheckpoint(checkpoint).asOfSeconds).kind === 'apply';
  if (!bridgeable) {
    log.warning?.(
      'No listed delta continues from the loaded export; the mirror stays at the export until the next run.',
      { checkpoint },
    );
  }
  const deltaResult = await run(
    bridgeable
      ? (ctx) => deltaPass(ctx, { ...ingest, index, onApplied: (name) => deltasApplied.push(name) })
      : async function* () {},
    'refresh',
  );
  return { deltasApplied, deltaResult, ...(fullLoad !== undefined && { fullLoad }) };
}

/** Why the store needs a full load before deltas, if it does. */
function reloadReason(
  load: MirrorLoad,
  checkpoint: string | undefined,
  index: readonly DeltaFile[],
  recordVersion: number,
): FullLoadReason | undefined {
  if (Date.now() - Date.parse(load.loadedAt) >= FULL_RELOAD_INTERVAL_MS) return 'age';
  if (load.recordVersion < recordVersion) return 'record_version';
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
