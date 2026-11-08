/**
 * @fileoverview The local export mirror's SQLite store: schema, the serving process's lazy handle,
 * readiness, and the as-of time mirror-served answers cite.
 *
 * Schema (one file at `OFF_MIRROR_PATH`, WAL beside it):
 *
 * | Object | Shape | Maintained by |
 * |---|---|---|
 * | `products` | `code TEXT PRIMARY KEY` (normalized barcode); `popularity_key`, `unique_scans_n`, `created_t`, `last_modified_t` INTEGER (the `sort_by` keys, null when the record lacks one); `generation` INTEGER (full load that last stamped the row); `record_version` INTEGER (`MIRROR_RECORD_VERSION` the row was built with); `tag_ids` TEXT (sorted JSON array of `tags.id`); `doc` TEXT (the builder's projected v2 JSON) | the framework's per-page upsert and tombstone delete |
 * | `tags` | `id INTEGER PRIMARY KEY`, `key TEXT UNIQUE` (a `mirrorTagKey(facet, storedTag)`) | the ingester, before each page |
 * | `product_tags` | `PRIMARY KEY (tag_id, code) WITHOUT ROWID` — one posting per product per tag | triggers on `products` insert, `tag_ids` change, and delete |
 * | `mirror_load` | one row: `generation`, `loaded_at` (ISO), `record_version`, `etag` (the strong ETag of the export it read; null in a row written before migration 2 added it), and `skipped_lines` (export lines it skipped as malformed or past 16 MiB) of the last completed full load | the ingester, after a full load's sweep |
 * | `mirror_sync_lock` | one row while a sync runs: holder token, `pid`, `host`, `acquired_at`, `heartbeat_at` (epoch ms) | `mirror-lock.ts` |
 * | `mirror_sync_state`, `schema_version` | the framework's sync state and schema stamp | the framework |
 * | `products_<column>_sort`, one per `SORT_COLUMNS` entry | index `(<column> DESC, code)`: every product in a tag search's order for that sort key | `ensureSortIndexes` in the sync process, then SQLite with `products` |
 * | `products_code_sort_keys` (`SORT_KEYS_INDEX`) | index `(code, popularity_key, unique_scans_n, created_t, last_modified_t)`: a code's sort keys without its product row | the same |
 *
 * Every auxiliary table and trigger is created by migration 1, which runs on an empty file before
 * any data, and migration 2 adds `mirror_load`'s `etag` and `skipped_lines` columns. No migration
 * builds an index: one built over a populated table when a process opens the store blocks the
 * serving process for minutes. The indexes above come from the sync
 * process instead, which a reader keeps reading through under WAL: a full load builds them after
 * its sweep and before it completes, one sorted pass each, and any run on a loaded store first
 * builds one it lacks. Maintained through the ingest instead, they slow it and come out larger.
 *
 * The sync checkpoint is `<generation:6>:<as-of epoch seconds:12>`. Its as-of half is a time up to
 * which the data reflects every product contributed or edited: the end of the last applied delta,
 * or the newest `last_modified_t` in the export a full load read. While a full load runs over a
 * loaded store it is the older of the as-of the run began with and the newest `last_modified_t`
 * among the rows the load has stamped, so a row rewritten to an export older than the deltas it
 * replaces never serves under a newer time. The generation prefix keeps the value
 * lexicographically monotonic across a full reload, whose as-of can drop below the deltas it
 * replaces.
 * @module services/mirror/mirror-store
 */

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import type { MirrorStore, SqliteHandle, SyncState } from '@cyanheads/mcp-ts-core/mirror';
import { sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig } from '@/config/server-config.js';
import { type MirrorLockHolder, readMirrorLock } from './mirror-lock.js';
import { GREEN_SCORE_RECORD_VERSION } from './record-builder.js';

/** Schema version the store's migrations reach. */
const STORE_SCHEMA_VERSION = 2;

/** The auxiliary tables and the triggers that keep `product_tags` in step with `products.tag_ids`. */
const AUXILIARY_DDL = [
  'CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE)',
  'CREATE TABLE IF NOT EXISTS product_tags (tag_id INTEGER NOT NULL, code TEXT NOT NULL, PRIMARY KEY (tag_id, code)) WITHOUT ROWID',
  `CREATE TRIGGER IF NOT EXISTS products_tags_ai AFTER INSERT ON products BEGIN
    INSERT INTO product_tags(tag_id, code) SELECT value, new.code FROM json_each(new.tag_ids);
  END`,
  /**
   * The framework's upsert rewrites every column, so the WHEN clause is what spares an unchanged
   * tag set (most delta lines, every unchanged product on a reload) its posting churn.
   */
  `CREATE TRIGGER IF NOT EXISTS products_tags_au AFTER UPDATE OF tag_ids ON products WHEN old.tag_ids IS NOT new.tag_ids BEGIN
    DELETE FROM product_tags WHERE code = old.code AND tag_id IN (SELECT value FROM json_each(old.tag_ids));
    INSERT INTO product_tags(tag_id, code) SELECT value, new.code FROM json_each(new.tag_ids);
  END`,
  `CREATE TRIGGER IF NOT EXISTS products_tags_ad AFTER DELETE ON products BEGIN
    DELETE FROM product_tags WHERE code = old.code AND tag_id IN (SELECT value FROM json_each(old.tag_ids));
  END`,
  'CREATE TABLE IF NOT EXISTS mirror_load (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, loaded_at TEXT NOT NULL, record_version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS mirror_sync_lock (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, acquired_at TEXT NOT NULL, heartbeat_at INTEGER NOT NULL)',
] as const;

/** The `products` columns a tag search sorts by, one sort index each. */
export const SORT_COLUMNS = [
  'popularity_key',
  'unique_scans_n',
  'created_t',
  'last_modified_t',
] as const;

/** A `products` column a sort index orders. */
export type SortColumn = (typeof SORT_COLUMNS)[number];

/** The index listing every product in search order for `column`: `column` descending, then `code`. */
export function sortIndexName(column: SortColumn): string {
  return `products_${column}_sort`;
}

/** The index giving a code's sort keys without its product row: `code`, then every sort column. */
export const SORT_KEYS_INDEX = 'products_code_sort_keys';

/** Each index `ensureSortIndexes` builds, by name, with its column list. */
const SORT_INDEXES: ReadonlyMap<string, string> = new Map([
  ...SORT_COLUMNS.map((column): [string, string] => [
    sortIndexName(column),
    `${column} DESC, code`,
  ]),
  [SORT_KEYS_INDEX, `code, ${SORT_COLUMNS.join(', ')}`],
]);

/**
 * Builds each sort index the store lacks, `SORT_KEYS_INDEX` included, one at a time, and returns
 * the names it built. A build reads every product and holds the write lock while it runs, so only
 * the sync process calls this (readers keep reading under WAL). Between builds it yields to the
 * event loop, which lets the sync lock's heartbeat renew.
 */
export async function ensureSortIndexes(handle: SqliteHandle): Promise<string[]> {
  const exists = handle.prepare<{ found: number }>(
    "SELECT 1 AS found FROM sqlite_schema WHERE type = 'index' AND name = ?",
  );
  const built: string[] = [];
  for (const [name, columns] of SORT_INDEXES) {
    if (exists.get(name) != null) continue;
    if (built.length > 0) await setTimeout(0);
    handle.exec(`CREATE INDEX ${name} ON products(${columns})`);
    built.push(name);
  }
  return built;
}

/**
 * How long the serving store's open, and each statement it runs, waits on another connection's
 * lock. The open writes (the framework's schema statements end in an `INSERT OR IGNORE` of the
 * sync-state row), so it queues behind a sync's write transaction, and SQLite waits synchronously:
 * every caller of the serving process waits with it, on every call until an open succeeds. Under
 * the framework's 5 s, an open that met a long hold, such as the sort index builds (4 min for all
 * five on the full export), held the process 5.2 s per call before reading live. A page
 * transaction held the lock 0.32–0.54 s on a store of records twice the export's average size, so
 * 250 ms lets most opens that meet one still succeed and gives up on the rest in about 0.29 s; a
 * call that gives up reads live, and the next call opens again. Reads through an open store never
 * wait on a writer under WAL. The sync processes and scripts keep the framework's 5 s: one started
 * while a sync runs must wait out its page transaction to reach the lease row and be refused by
 * name (`mirror_lock_held`), not by a lock error. A script that meets a longer hold names the sync
 * holding it instead (`scripts/_mirror-context.ts`).
 */
export const SERVING_BUSY_TIMEOUT_MS = 250;

/**
 * Builds the store at `path`, created with its parent directory on first use if absent. Nothing
 * opens until the first call on it, and each call made before an open succeeds tries again, so a
 * caller that must not create the store checks the path first. `busyTimeoutMs` bounds how long the
 * open and each statement wait on another connection's lock; the framework's 5 s when omitted.
 */
export function openMirrorStore(path: string, busyTimeoutMs?: number): MirrorStore {
  return sqliteMirrorStore({
    path,
    ...(busyTimeoutMs !== undefined && { busyTimeoutMs }),
    table: 'products',
    primaryKey: 'code',
    columns: {
      code: 'TEXT',
      popularity_key: 'INTEGER',
      unique_scans_n: 'INTEGER',
      created_t: 'INTEGER',
      last_modified_t: 'INTEGER',
      generation: 'INTEGER',
      record_version: 'INTEGER',
      tag_ids: 'TEXT',
      doc: 'TEXT',
    },
    version: STORE_SCHEMA_VERSION,
    migrations: [
      {
        version: 1,
        up(handle) {
          for (const statement of AUXILIARY_DDL) handle.exec(statement);
        },
      },
      {
        version: 2,
        up(handle) {
          handle.exec('ALTER TABLE mirror_load ADD COLUMN etag TEXT');
          // Before migration 2 any malformed line failed the load, so a recorded load skipped none.
          handle.exec(
            'ALTER TABLE mirror_load ADD COLUMN skipped_lines INTEGER NOT NULL DEFAULT 0',
          );
        },
      },
    ],
  });
}

let servingStore: MirrorStore | undefined;

/**
 * The serving process's store, built once from `OFF_MIRROR_PATH`, its open bounded by
 * {@link SERVING_BUSY_TIMEOUT_MS}. `undefined` when the variable is unset, and on any call while
 * the file it names does not exist (a store not yet built, a mistyped path, an unmounted volume).
 * The file is checked on every call, not only before the store is built: an open that gave up on a
 * sync's lock is retried by the next call, and that retry would create the file and its directories
 * if they had gone in between. The serving process therefore never creates a store. Its open runs
 * the framework's schema statements and any migration the store has not reached (on a store built
 * before migration 2, its two `ALTER`s); every other write runs in `mirror:*` scripts or the
 * scheduled job's child process.
 */
export function getMirrorStore(): MirrorStore | undefined {
  const { mirrorPath } = getServerConfig();
  if (mirrorPath === undefined || !existsSync(mirrorPath)) return;
  servingStore ??= openMirrorStore(mirrorPath, SERVING_BUSY_TIMEOUT_MS);
  return servingStore;
}

/** Closes the serving process's store, if one was built. */
export async function closeMirrorStore(): Promise<void> {
  const store = servingStore;
  servingStore = undefined;
  await store?.close();
}

/**
 * True once a sync has completed and the store holds at least one product. A failed or running
 * refresh on top of a completed load stays ready; a completed load of zero products never is.
 */
export async function isMirrorReady(store: MirrorStore): Promise<boolean> {
  const state = await store.readState();
  if (state.completedAt === undefined) return false;
  const handle = await store.raw();
  return hasProducts(handle);
}

/** Whether `products` holds any row. O(1), unlike `COUNT(*)`. */
export function hasProducts(handle: SqliteHandle): boolean {
  return (
    handle.prepare<{ found: number }>('SELECT EXISTS (SELECT 1 FROM products) AS found').get()
      ?.found === 1
  );
}

/**
 * ISO time up to which the mirrored data reflects every product contributed or edited — the end of
 * the last applied delta, or the newest `last_modified_t` of the export the last full load read;
 * while a full load runs, no later than the newest `last_modified_t` among the rows it has stamped.
 * `undefined` before any load completes, and while a reload starts, between the runner clearing the
 * checkpoint and the load's first page restoring it.
 */
export async function mirrorAsOf(store: MirrorStore): Promise<string | undefined> {
  const { checkpoint } = await store.readState();
  if (checkpoint === undefined) return;
  return new Date(decodeCheckpoint(checkpoint).asOfSeconds * 1000).toISOString();
}

/** A decoded sync checkpoint. */
export interface MirrorCheckpoint {
  /** Epoch seconds up to which the data reflects every product contributed or edited. */
  asOfSeconds: number;
  /** Full-load generation the data descends from. */
  generation: number;
}

const CHECKPOINT_PATTERN = /^(\d{6}):(\d{12})$/;

/** Encodes a checkpoint so that string order matches (generation, as-of) order. */
export function encodeCheckpoint({ generation, asOfSeconds }: MirrorCheckpoint): string {
  return `${String(generation).padStart(6, '0')}:${String(asOfSeconds).padStart(12, '0')}`;
}

/** Decodes a checkpoint this module encoded. Throws on any other value: the store is not ours. */
export function decodeCheckpoint(checkpoint: string): MirrorCheckpoint {
  const match = CHECKPOINT_PATTERN.exec(checkpoint);
  if (!match) throw new Error(`Mirror checkpoint "${checkpoint}" is not <generation>:<epoch>.`);
  return { generation: Number(match[1]), asOfSeconds: Number(match[2]) };
}

/** The last completed full load, as `mirror_load` records it. */
export interface MirrorLoad {
  /**
   * Strong ETag of the export the load read. Absent in a row recorded before the store kept it,
   * which a refresh treats as an export it cannot compare.
   */
  etag?: string;
  generation: number;
  /** ISO time the load's sweep finished. */
  loadedAt: string;
  recordVersion: number;
  /** Export lines the load skipped because they were not valid JSON or ran past 16 MiB. */
  skippedLines: number;
}

/** Reads the last completed full load, or `undefined` before the first one completes. */
export function readMirrorLoad(handle: SqliteHandle): MirrorLoad | undefined {
  const row = handle
    .prepare<{
      etag: string | null;
      generation: number;
      loaded_at: string;
      record_version: number;
      skipped_lines: number;
    }>(
      'SELECT generation, loaded_at, record_version, etag, skipped_lines FROM mirror_load WHERE id = 1',
    )
    .get();
  if (row == null) return;
  return {
    generation: row.generation,
    loadedAt: row.loaded_at,
    recordVersion: row.record_version,
    ...(row.etag !== null && { etag: row.etag }),
    skippedLines: row.skipped_lines,
  };
}

/**
 * Whether the store serves a search filtering on Green-Score: its last completed full load was
 * built at `GREEN_SCORE_RECORD_VERSION` or later. Until such a load completes some rows lack their
 * Green-Score tag (every row of an older load, and the rows a reload part-way through has not
 * rewritten yet), so a search on it would miss products.
 */
export async function indexesGreenScore(store: MirrorStore): Promise<boolean> {
  const load = readMirrorLoad(await store.raw());
  return load !== undefined && load.recordVersion >= GREEN_SCORE_RECORD_VERSION;
}

/** What `mirror:status` and `mirror:verify` print. */
export interface MirrorReport {
  /** {@link mirrorAsOf}. */
  asOf?: string;
  /** Message of the last failed sync, while its failure is the latest state. */
  error?: string;
  /** When the last sync of either kind completed. */
  lastSyncAt?: string;
  load?: MirrorLoad;
  /** The live holder of the sync lock, if a sync is running. */
  lock?: MirrorLockHolder;
  products: number;
  ready: boolean;
  status: SyncState['status'];
  /** Bytes on disk: the store file plus its `-wal` and `-shm`. */
  storeBytes: number;
}

/** Bytes in the file at `path`, 0 when it does not exist. */
export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** Gathers the store's health. `path` is the file `store` was opened on. */
export async function readMirrorReport(store: MirrorStore, path: string): Promise<MirrorReport> {
  const state = await store.readState();
  const handle = await store.raw();
  const load = readMirrorLoad(handle);
  const lock = readMirrorLock(handle);
  const asOf = await mirrorAsOf(store);
  const sizes = await Promise.all(
    ['', '-wal', '-shm'].map((suffix) => fileSize(`${path}${suffix}`)),
  );
  return {
    status: state.status,
    ready: await isMirrorReady(store),
    products: await store.count(),
    storeBytes: sizes.reduce((sum, size) => sum + size, 0),
    ...(state.completedAt !== undefined && { lastSyncAt: state.completedAt }),
    ...(asOf !== undefined && { asOf }),
    ...(state.status === 'error' && state.error !== undefined && { error: state.error }),
    ...(load !== undefined && { load }),
    ...(lock !== undefined && { lock }),
  };
}

/** Records a completed full load. */
export function writeMirrorLoad(handle: SqliteHandle, load: MirrorLoad): void {
  handle
    .prepare(
      `INSERT INTO mirror_load(id, generation, loaded_at, record_version, etag, skipped_lines)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, loaded_at = excluded.loaded_at,
         record_version = excluded.record_version, etag = excluded.etag,
         skipped_lines = excluded.skipped_lines`,
    )
    .run(load.generation, load.loadedAt, load.recordVersion, load.etag ?? null, load.skippedLines);
}
