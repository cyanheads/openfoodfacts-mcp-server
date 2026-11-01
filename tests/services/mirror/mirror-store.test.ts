/**
 * @fileoverview Tests for the mirror store: the tag postings the triggers keep in step with
 * `products.tag_ids`, their index-backed plans, readiness (a completed sync AND products), the
 * as-of time, the checkpoint encoding, the status report and `mirror:verify`'s exit code, that an
 * unset `OFF_MIRROR_PATH`, or one naming no file, builds no store, and how long the serving store
 * waits on a sync's write lock.
 * @module tests/services/mirror/mirror-store.test
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorRow, MirrorStore, SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('are maintained through primary-key seeks, never a scan', async () => {
    const handle = await store.raw();
    const plan = (sql: string, ...params: (string | number)[]) =>
      handle
        .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params)
        .map((r) => r.detail);
    const remove = plan(
      'DELETE FROM product_tags WHERE code = ? AND tag_id IN (SELECT value FROM json_each(?))',
      'A',
      '[1,2]',
    );
    expect(remove.join(' | ')).toMatch(/SEARCH product_tags USING PRIMARY KEY/);
    expect(remove.some((d) => /^SCAN product_tags/.test(d))).toBe(false);
    const sweep = plan(
      'SELECT code FROM products WHERE rowid > ? AND rowid <= ? AND generation < ?',
      0,
      50_000,
      2,
    );
    expect(sweep.join(' | ')).toMatch(
      /SEARCH products USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/,
    );
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
});
