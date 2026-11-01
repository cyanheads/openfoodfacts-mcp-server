/**
 * @fileoverview Tests for the mirror store: the tag postings the triggers keep in step with
 * `products.tag_ids` and the plans of the statements those triggers and a full load's sweep run,
 * readiness (a completed sync AND products), the as-of time, the checkpoint encoding, the status
 * report and `mirror:verify`'s exit code, that an unset `OFF_MIRROR_PATH`, or one naming no file
 * (one that disappears after an open gave up included), builds no store, and how long the serving
 * store waits on a sync's write lock.
 * @module tests/services/mirror/mirror-store.test
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorRow, MirrorStore, SqliteHandle, SqlValue } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportLoad,
  type MirrorUpstream,
  parseExportCursor,
  TagIds,
} from '@/services/mirror/mirror-ingester.js';
import {
  decodeCheckpoint,
  encodeCheckpoint,
  ensureSortIndexes,
  isMirrorReady,
  mirrorAsOf,
  openMirrorStore,
  readMirrorReport,
  SORT_COLUMNS,
  SORT_KEYS_INDEX,
  sortIndexName,
  writeMirrorLoad,
} from '@/services/mirror/mirror-store.js';

let dir: string;
let path: string;
let store: MirrorStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'off-mirror-store-'));
  path = join(dir, 'store.sqlite');
  store = openMirrorStore(path);
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

function row(code: string, tagIds: number[], extra: Partial<MirrorRow> = {}): MirrorRow {
  return {
    code,
    popularity_key: 1,
    unique_scans_n: null,
    created_t: 1,
    last_modified_t: 1,
    generation: 1,
    record_version: 1,
    tag_ids: JSON.stringify(tagIds),
    doc: '{}',
    ...extra,
  };
}

/** The plan SQLite picks for `sql`, one detail line per step. */
function queryPlan(handle: SqliteHandle, sql: string, params: SqlValue[] = []): string[] {
  return handle
    .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((r) => r.detail);
}

/** A value to plan a trigger statement with, for each `products` column it reads as `old.`/`new.`. */
const TRIGGER_COLUMN_VALUES: ReadonlyMap<string, SqlValue> = new Map([
  ['code', 'A'],
  ['tag_ids', '[1,2]'],
]);

/**
 * Every statement of every trigger on `products`, as the store holds it, with its plan: each
 * `old.`/`new.` column is bound as a parameter, which is how a trigger program sees it.
 */
function triggerPlans(handle: SqliteHandle): { name: string; plan: string[]; statement: string }[] {
  return handle
    .prepare<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'products' ORDER BY name",
    )
    .all()
    .flatMap(({ name, sql }) => {
      const body = /\bBEGIN\b([\s\S]*)\bEND$/.exec(sql.trim())?.[1];
      if (body === undefined) throw new Error(`Trigger ${name} has no BEGIN … END body.`);
      return body
        .split(';')
        .map((text) => text.trim())
        .filter((text) => text !== '')
        .map((text) => {
          const params: SqlValue[] = [];
          const statement = text.replace(/\b(?:old|new)\.(\w+)/g, (_, column: string) => {
            const value = TRIGGER_COLUMN_VALUES.get(column);
            if (value === undefined)
              throw new Error(`No value to plan ${name} with for ${column}.`);
            params.push(value);
            return '?';
          });
          return { name, statement, plan: queryPlan(handle, statement, params) };
        });
    });
}

async function postings(): Promise<[number, string][]> {
  const handle = await store.raw();
  return handle
    .prepare<{ tag_id: number; code: string }>(
      'SELECT tag_id, code FROM product_tags ORDER BY tag_id, code',
    )
    .all()
    .map((r) => [r.tag_id, r.code]);
}

describe('tag postings', () => {
  it('follow each product through insert, a changed tag set, an unchanged one, and delete', async () => {
    await store.applyBatch([row('A', [1, 2]), row('B', [2])], []);
    expect(await postings()).toEqual([
      [1, 'A'],
      [2, 'A'],
      [2, 'B'],
    ]);

    await store.applyBatch([row('A', [2, 3]), row('B', [2], { doc: '{"x":1}' })], []);
    expect(await postings()).toEqual([
      [2, 'A'],
      [2, 'B'],
      [3, 'A'],
    ]);

    await store.applyBatch([], ['A']);
    expect(await postings()).toEqual([[2, 'B']]);
  });

  it('are maintained through primary-key seeks, never a scan, by every statement the triggers run', async () => {
    const plans = triggerPlans(await store.raw());

    const deletes = plans.filter(({ statement }) => /^DELETE\b/.test(statement));
    expect(deletes.map(({ name }) => name)).toEqual(['products_tags_ad', 'products_tags_au']);
    for (const { plan } of deletes) {
      expect(plan.join(' | ')).toMatch(/SEARCH product_tags USING PRIMARY KEY/);
    }
    for (const { name, plan } of plans) {
      expect({
        name,
        scans: plan.filter((d) => /^SCAN (products|product_tags)\b/.test(d)),
      }).toEqual({ name, scans: [] });
    }
  });
});

describe("a full load's sweep", () => {
  /** Port 9 on loopback: a sweep sends no request, and one that tried would fail, never go out. */
  const UNREACHABLE: MirrorUpstream = {
    exportUrl: 'http://127.0.0.1:9/data/openfoodfacts-products.jsonl.gz',
    deltaBaseUrl: 'http://127.0.0.1:9/data/delta/',
    requestGapMs: 0,
    userAgent: 'openfoodfacts-mcp-server/test',
  };

  it('reads products only through seeks, never a scan, in every statement it runs', async () => {
    await store.applyBatch([row('A', [1]), row('B', [1], { generation: 2 })], []);
    const handle = await store.raw();
    const prepared: string[] = [];
    const recording: SqliteHandle = {
      ...handle,
      prepare: <TRow>(sql: string) => {
        prepared.push(sql);
        return handle.prepare<TRow>(sql);
      },
    };
    const cursor = JSON.stringify({
      v: 1,
      generation: 2,
      phase: 'sweep',
      line: 0,
      maxModifiedT: 0,
      rowid: 0,
    });
    expect(parseExportCursor(cursor)).toMatchObject({ phase: 'sweep', generation: 2 });

    const pages = exportLoad(
      { mode: 'init', cursor, signal: new AbortController().signal },
      {
        builder: { MIRROR_RECORD_VERSION: 1, buildMirrorRecord: () => null },
        downloadPath: join(dir, 'export.jsonl.gz'),
        generation: 2,
        handle: recording,
        log: {},
        onLoaded: () => {},
        previousCheckpoint: undefined,
        tags: new TagIds(),
        upstream: UNREACHABLE,
      },
    );
    const first = await pages.next();
    await pages.return(undefined);

    // The sweep ran: the row an earlier load stamped is its first page's tombstone.
    expect(first.value).toMatchObject({ tombstones: ['A'] });
    const reads = prepared.filter((sql) => /\bproducts\b/.test(sql));
    expect(reads).not.toEqual([]);
    for (const sql of reads) {
      const plan = queryPlan(
        handle,
        sql,
        Array.from(sql.matchAll(/\?/g), () => 0),
      );
      expect({ sql, notSeeks: plan.filter((d) => !d.startsWith('SEARCH ')) }).toEqual({
        sql,
        notSeeks: [],
      });
    }
  });
});

describe('sort indexes', () => {
  const ALL = [...SORT_COLUMNS.map(sortIndexName), SORT_KEYS_INDEX];

  /** The indexes on `products` the store holds beyond its primary key, by name. */
  function productIndexes(handle: SqliteHandle): string[] {
    return handle
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'products' AND sql IS NOT NULL ORDER BY name",
      )
      .all()
      .map((r) => r.name);
  }

  it('are never built by opening a store, a populated one included', async () => {
    await store.applyBatch([row('A', [1]), row('B', [])], []);
    await store.close();
    store = openMirrorStore(path);
    expect(productIndexes(await store.raw())).toEqual([]);
  });

  it('are built once each by ensureSortIndexes, which builds only the ones missing', async () => {
    await store.applyBatch([row('A', [1]), row('B', [], { popularity_key: 9 })], []);
    const handle = await store.raw();
    expect(await ensureSortIndexes(handle)).toEqual(ALL);
    expect(productIndexes(handle)).toEqual([...ALL].sort());
    expect(await ensureSortIndexes(handle)).toEqual([]);
    handle.exec(`DROP INDEX products_created_t_sort`);
    handle.exec(`DROP INDEX ${SORT_KEYS_INDEX}`);
    expect(await ensureSortIndexes(handle)).toEqual(['products_created_t_sort', SORT_KEYS_INDEX]);
  });

  it('list products in search order, so a walk of one reads no product row and sorts nothing', async () => {
    const handle = await store.raw();
    await ensureSortIndexes(handle);
    for (const column of SORT_COLUMNS) {
      for (const order of [
        `${column} DESC NULLS LAST, code`,
        `${column} ASC NULLS FIRST, code DESC`,
      ]) {
        const plan = handle
          .prepare<{ detail: string }>(
            `EXPLAIN QUERY PLAN SELECT rowid, ${column}, code FROM products INDEXED BY ${sortIndexName(column)} ORDER BY ${order} LIMIT 10`,
          )
          .all()
          .map((r) => r.detail);
        expect(plan).toEqual([`SCAN products USING COVERING INDEX ${sortIndexName(column)}`]);
      }
    }
  });

  it('give a code every sort key without its product row', async () => {
    const handle = await store.raw();
    await ensureSortIndexes(handle);
    const plan = handle
      .prepare<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT rowid, ${SORT_COLUMNS.join(', ')} FROM products INDEXED BY ${SORT_KEYS_INDEX} WHERE code = ?`,
      )
      .all('A')
      .map((r) => r.detail);
    expect(plan).toEqual([`SEARCH products USING COVERING INDEX ${SORT_KEYS_INDEX} (code=?)`]);
  });
});

describe('isMirrorReady', () => {
  it('is false until a sync completes, and false for a completed sync with no products', async () => {
    expect(await isMirrorReady(store)).toBe(false);
    await store.writeState({
      status: 'complete',
      completedAt: '2026-11-01T00:00:00.000Z',
      total: 0,
    });
    expect(await isMirrorReady(store)).toBe(false);
  });

  it('is true for a completed sync with products, and stays true through a failed refresh', async () => {
    await store.applyBatch([row('A', [])], []);
    expect(await isMirrorReady(store)).toBe(false);
    await store.writeState({
      status: 'complete',
      completedAt: '2026-11-01T00:00:00.000Z',
      total: 1,
    });
    expect(await isMirrorReady(store)).toBe(true);
    await store.writeState({ status: 'error', error: 'HTTP 503' });
    expect(await isMirrorReady(store)).toBe(true);
  });
});

describe('checkpoint', () => {
  it('orders by generation first, so a reload can move the as-of time back', () => {
    const older = encodeCheckpoint({ generation: 1, asOfSeconds: 1_793_514_332 });
    const reloaded = encodeCheckpoint({ generation: 2, asOfSeconds: 1_793_500_000 });
    expect(older).toBe('000001:001793514332');
    expect(reloaded > older).toBe(true);
    expect(decodeCheckpoint(reloaded)).toEqual({ generation: 2, asOfSeconds: 1_793_500_000 });
  });

  it('rejects a value this module did not write', () => {
    expect(() => decodeCheckpoint('2026-11-01T00:00:00Z')).toThrow('not <generation>:<epoch>');
  });

  it('gives mirrorAsOf the ISO time of its as-of half, or nothing before a load', async () => {
    expect(await mirrorAsOf(store)).toBeUndefined();
    await store.writeState({
      status: 'complete',
      checkpoint: encodeCheckpoint({ generation: 3, asOfSeconds: 1_793_514_332 }),
    });
    expect(await mirrorAsOf(store)).toBe('2026-11-01T06:25:32.000Z');
  });
});

describe('readMirrorReport', () => {
  it('reports rows, readiness, the as-of time, the last sync, and the bytes on disk', async () => {
    await store.applyBatch([row('A', [1]), row('B', [])], []);
    await store.writeState({
      status: 'complete',
      completedAt: '2026-11-01T07:00:00.000Z',
      total: 2,
      checkpoint: encodeCheckpoint({ generation: 1, asOfSeconds: 1_793_514_332 }),
    });
    const report = await readMirrorReport(store, path);
    expect(report).toMatchObject({
      status: 'complete',
      ready: true,
      products: 2,
      lastSyncAt: '2026-11-01T07:00:00.000Z',
      asOf: '2026-11-01T06:25:32.000Z',
    });
    expect(report.storeBytes).toBeGreaterThan(0);
    expect(report.lock).toBeUndefined();
    expect(report.load).toBeUndefined();
  });
});

describe('mirror:verify', () => {
  async function verify(): Promise<{ code: number | null; stderr: string; stdout: string }> {
    const bun = process.versions.bun ? process.execPath : 'bun';
    const child = spawn(bun, ['run', 'scripts/mirror-status.ts', '--verify'], {
      env: { ...process.env, OFF_MIRROR_PATH: path },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const [code] = (await once(child, 'close')) as [number | null];
    return { code, stdout, stderr };
  }

  it('fails on a completed store that holds no products', { timeout: 60_000 }, async () => {
    await store.writeState({
      status: 'complete',
      completedAt: '2026-11-01T07:00:00.000Z',
      total: 0,
    });

    const result = await verify();

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^ready {10}no$/m);
    expect(result.stdout).toMatch(/^integrity {6}ok$/m);
    expect(result.stderr).toContain(
      'Not ready: the last sync completed but the store holds no products.',
    );
  });

  it('passes once that store holds a product', { timeout: 60_000 }, async () => {
    await store.applyBatch([row('A', [])], []);
    await store.writeState({
      status: 'complete',
      completedAt: '2026-11-01T07:00:00.000Z',
      total: 1,
    });

    const result = await verify();

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^ready {10}yes$/m);
    expect(result.stdout).toMatch(/^integrity {6}ok$/m);
  });

  it('prints the last full load with the export lines it skipped', {
    timeout: 60_000,
  }, async () => {
    await store.applyBatch([row('A', [])], []);
    await store.writeState({ status: 'complete', completedAt: '2026-11-01T07:00:00.000Z' });
    writeMirrorLoad(await store.raw(), {
      generation: 3,
      loadedAt: '2026-11-01T06:00:00.000Z',
      recordVersion: 1,
      etag: '"e3"',
      skippedLines: 2,
    });

    const result = await verify();

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /^last full load 2026-11-01T06:00:00\.000Z \(generation 3, record version 1, 2 export lines skipped\)$/m,
    );
  });
});

describe('getMirrorStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('builds nothing when OFF_MIRROR_PATH is unset', async () => {
    vi.stubEnv('OFF_MIRROR_PATH', undefined);
    vi.resetModules();
    const { getMirrorStore } = await import('@/services/mirror/mirror-store.js');
    expect(getMirrorStore()).toBeUndefined();
  });

  it('builds nothing and creates no file or directory while OFF_MIRROR_PATH names no file', async () => {
    const volume = join(dir, 'unmounted');
    const served = join(volume, 'served.sqlite');
    vi.stubEnv('OFF_MIRROR_PATH', served);
    vi.resetModules();
    const { getMirrorStore } = await import('@/services/mirror/mirror-store.js');

    expect(getMirrorStore()).toBeUndefined();
    expect(getMirrorStore()).toBeUndefined();
    expect(existsSync(volume)).toBe(false);
  });

  it('builds one lazy store once the file exists, as mirror:init leaves it, and keeps it', async () => {
    const served = join(dir, 'served.sqlite');
    vi.stubEnv('OFF_MIRROR_PATH', served);
    vi.resetModules();
    const {
      closeMirrorStore,
      getMirrorStore,
      isMirrorReady: ready,
    } = await import('@/services/mirror/mirror-store.js');
    expect(getMirrorStore()).toBeUndefined();
    const built = openMirrorStore(served);
    await built.raw();
    await built.close();

    const first = getMirrorStore();
    expect(first).toBeDefined();
    expect(getMirrorStore()).toBe(first);
    expect(await ready(first as MirrorStore)).toBe(false);
    await closeMirrorStore();
    expect(getMirrorStore()).not.toBe(first);
    await closeMirrorStore();
  });

  const busyTimeout = (handle: SqliteHandle) =>
    handle.prepare<{ timeout: number }>('PRAGMA busy_timeout').get()?.timeout;

  it("opens a sync's store to wait out another connection's lock for the framework's 5 s", async () => {
    expect(busyTimeout(await store.raw())).toBe(5_000);
  });

  it('waits at most 250 ms on a sync write lock, retrying the open on the next call', async () => {
    const writer = await store.raw();
    vi.stubEnv('OFF_MIRROR_PATH', path);
    vi.resetModules();
    const {
      closeMirrorStore,
      getMirrorStore,
      isMirrorReady: ready,
      SERVING_BUSY_TIMEOUT_MS,
    } = await import('@/services/mirror/mirror-store.js');

    expect(SERVING_BUSY_TIMEOUT_MS).toBe(250);
    expect(busyTimeout(await (getMirrorStore() as MirrorStore).raw())).toBe(250);
    await closeMirrorStore();

    // A sync's page transaction, held: the serving open gives up on it rather than waiting it out.
    writer.exec('BEGIN IMMEDIATE');
    const serving = getMirrorStore() as MirrorStore;
    try {
      await expect(ready(serving)).rejects.toMatchObject({
        code: JsonRpcErrorCode.DatabaseError,
        message: 'Failed to initialize mirror store "store.sqlite".',
      });
    } finally {
      writer.exec('ROLLBACK');
    }
    expect(getMirrorStore()).toBe(serving);
    await expect(ready(serving)).resolves.toBe(false);
    await closeMirrorStore();
  });

  it('builds nothing and creates no file or directory once its file disappears after an open gave up', async () => {
    const volume = join(dir, 'volume');
    const served = join(volume, 'served.sqlite');
    const built = openMirrorStore(served);
    const writer = await built.raw();
    vi.stubEnv('OFF_MIRROR_PATH', served);
    vi.resetModules();
    const {
      closeMirrorStore,
      getMirrorStore,
      isMirrorReady: ready,
    } = await import('@/services/mirror/mirror-store.js');

    // The first serving open gives up on a sync's held write lock, so the store never opens.
    writer.exec('BEGIN IMMEDIATE');
    const serving = getMirrorStore() as MirrorStore;
    try {
      await expect(ready(serving)).rejects.toMatchObject({ code: JsonRpcErrorCode.DatabaseError });
    } finally {
      writer.exec('ROLLBACK');
    }
    await built.close();
    // The volume goes away, as an unmount or an operator's rm leaves it.
    await rm(volume, { recursive: true, force: true });

    expect(getMirrorStore()).toBeUndefined();
    expect(getMirrorStore()).toBeUndefined();
    expect(existsSync(volume)).toBe(false);
    await closeMirrorStore();
  });
});
