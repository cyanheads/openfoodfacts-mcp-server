/**
 * @fileoverview Tests for the cross-process mirror sync lock: a second handle or process is refused
 * with the holder named, a holder whose heartbeat lapsed or whose process died is reclaimed, a
 * reclaimed holder learns it lost the lease from its heartbeat or, before its heartbeat has run,
 * from `assertHeld`, release never deletes another holder's row, and a `mirror:*` script that meets
 * a sync's held write lock reports the sync holding it rather than the lock error.
 * @module tests/services/mirror/mirror-lock.test
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MirrorStore, SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireMirrorLock, LOCK_TTL_MS, readMirrorLock } from '@/services/mirror/mirror-lock.js';
import { openMirrorStore } from '@/services/mirror/mirror-store.js';

let dir: string;
let path: string;
let stores: MirrorStore[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'off-mirror-lock-'));
  path = join(dir, 'store.sqlite');
  stores = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stores.map((store) => store.close()));
  await rm(dir, { recursive: true, force: true });
});

/** A fresh connection to the test store, as a separate process would open it. */
async function connect(): Promise<SqliteHandle> {
  const store = openMirrorStore(path);
  stores.push(store);
  return store.raw();
}

function writeRow(handle: SqliteHandle, pid: number, host: string, heartbeatAt: number): void {
  handle
    .prepare(
      `INSERT INTO mirror_sync_lock(id, holder, pid, host, acquired_at, heartbeat_at) VALUES (1, 'other', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET holder = 'other', pid = excluded.pid, host = excluded.host, heartbeat_at = excluded.heartbeat_at`,
    )
    .run(pid, host, '2026-11-01T00:00:00.000Z', heartbeatAt);
}

describe('acquireMirrorLock', () => {
  it('refuses a second connection while held, naming the holder, and admits it after release', async () => {
    const first = await connect();
    const second = await connect();
    const lock = acquireMirrorLock(first);
    expect(() => acquireMirrorLock(second)).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining(`held by pid ${process.pid} on host ${hostname()}`),
        data: expect.objectContaining({
          reason: 'mirror_lock_held',
          holder: expect.objectContaining({ pid: process.pid, host: hostname() }),
        }),
      }),
    );
    expect(readMirrorLock(second)).toMatchObject({ pid: process.pid, host: hostname() });
    lock.release();
    expect(readMirrorLock(second)).toBeUndefined();
    acquireMirrorLock(second).release();
  });

  it('refuses a live holder on another host until its heartbeat is older than the TTL', async () => {
    const handle = await connect();
    writeRow(handle, 1, 'other-host', Date.now());
    expect(() => acquireMirrorLock(handle)).toThrowError(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'mirror_lock_held' }) }),
    );
    writeRow(handle, 1, 'other-host', Date.now() - LOCK_TTL_MS - 1_000);
    const lock = acquireMirrorLock(handle);
    expect(readMirrorLock(handle)).toMatchObject({ pid: process.pid, host: hostname() });
    lock.release();
  });

  it('holds a lease until its heartbeat is more than 5 minutes old, then hands it over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-01T12:00:00.000Z'));
    const now = Date.now();
    expect(LOCK_TTL_MS).toBe(300_000);
    const handle = await connect();

    writeRow(handle, 1, 'other-host', now - 300_000);
    expect(() => acquireMirrorLock(handle)).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('reclaimed once its heartbeat is 5 minutes old'),
        data: expect.objectContaining({
          reason: 'mirror_lock_held',
          holder: {
            pid: 1,
            host: 'other-host',
            acquiredAt: '2026-11-01T00:00:00.000Z',
            heartbeatAt: '2026-11-01T11:55:00.000Z',
          },
        }),
      }),
    );
    expect(readMirrorLock(handle)).toMatchObject({ pid: 1, host: 'other-host' });

    writeRow(handle, 1, 'other-host', now - 300_001);
    expect(readMirrorLock(handle)).toBeUndefined();
    const lock = acquireMirrorLock(handle);
    expect(readMirrorLock(handle)).toEqual({
      pid: process.pid,
      host: hostname(),
      acquiredAt: '2026-11-01T12:00:00.000Z',
      heartbeatAt: '2026-11-01T12:00:00.000Z',
    });
    lock.release();
  });

  it('reclaims at once a row whose process on this host has exited', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await once(child, 'exit');
    const handle = await connect();
    writeRow(handle, child.pid as number, hostname(), Date.now());
    acquireMirrorLock(handle).release();
  });

  it('reclaims a row carrying this process id that this process does not hold (a reused pid)', async () => {
    const handle = await connect();
    writeRow(handle, process.pid, hostname(), Date.now());
    acquireMirrorLock(handle).release();
  });

  it('aborts the holder when its lease is reclaimed, and release leaves the new row alone', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const handle = await connect();
    const lock = acquireMirrorLock(handle);
    vi.advanceTimersByTime(30_000);
    expect(lock.lost.aborted).toBe(false);
    writeRow(handle, 1, 'other-host', Date.now());
    vi.advanceTimersByTime(30_000);
    expect(lock.lost.aborted).toBe(true);
    expect(lock.lost.reason).toMatchObject({ data: { reason: 'mirror_lock_lost' } });
    lock.release();
    expect(readMirrorLock(handle)).toMatchObject({ pid: 1, host: 'other-host' });
  });

  it.each<[string, (handle: SqliteHandle) => void]>([
    ['reclaimed by another holder', (handle) => writeRow(handle, 1, 'other-host', Date.now())],
    [
      'deleted by a reclaiming holder that released it',
      (handle) => handle.prepare('DELETE FROM mirror_sync_lock').run(),
    ],
  ])('fails assertHeld on a row %s before the heartbeat has run', async (_label, reclaim) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const handle = await connect();
    const lock = acquireMirrorLock(handle);
    lock.assertHeld();
    expect(lock.lost.aborted).toBe(false);

    reclaim(handle);
    let thrown: unknown;
    try {
      lock.assertHeld();
    } catch (err) {
      thrown = err;
    }

    expect(lock.lost.aborted).toBe(true);
    expect(lock.lost.reason).toMatchObject({ data: { reason: 'mirror_lock_lost' } });
    expect(thrown).toBe(lock.lost.reason);
    expect(() => lock.assertHeld()).toThrow(lock.lost.reason as Error);
    lock.release();
  });

  it('renews the heartbeat every 30 s while held, stamped with the time of the beat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(Date.parse('2026-11-01T12:00:00.000Z'));
    const handle = await connect();
    const lock = acquireMirrorLock(handle);
    handle.prepare('UPDATE mirror_sync_lock SET heartbeat_at = 0').run();
    const beat = () =>
      handle.prepare<{ heartbeat_at: number }>('SELECT heartbeat_at FROM mirror_sync_lock').get()
        ?.heartbeat_at;
    vi.advanceTimersByTime(29_999);
    expect(beat()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(beat()).toBe(Date.parse('2026-11-01T12:00:30.000Z'));
    lock.release();
  });
});

describe('a mirror script that meets a held lock', () => {
  it('exits non-zero and names the holder', { timeout: 60_000 }, async () => {
    const lock = acquireMirrorLock(await connect());
    try {
      const bun = process.versions.bun ? process.execPath : 'bun';
      const child = spawn(bun, ['run', 'scripts/mirror-refresh.ts'], {
        env: { ...process.env, OFF_MIRROR_PATH: path },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const [code] = (await once(child, 'close')) as [number | null];
      expect(code).toBe(1);
      expect(stderr).toContain(`held by pid ${process.pid} on host ${hostname()}`);
      expect(stderr).toContain('(mirror_lock_held)');
    } finally {
      lock.release();
    }
  });
});

describe("a mirror script that meets a sync's held write lock", () => {
  /** Runs `scripts/<script>` on the test store, as `bun run mirror:*` does. */
  async function runScript(
    script: string,
    ...args: string[]
  ): Promise<{ code: number | null; stderr: string }> {
    const bun = process.versions.bun ? process.execPath : 'bun';
    const child = spawn(bun, ['run', `scripts/${script}`, ...args], {
      env: { ...process.env, OFF_MIRROR_PATH: path },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const [code] = (await once(child, 'close')) as [number | null];
    return { code, stderr };
  }

  /**
   * Holds the write lock on `handle`, as a sort index build does for minutes, until every run of
   * `scripts` has exited: each waits out its 5 s busy timeout and gives up.
   */
  async function whileWriting(
    handle: SqliteHandle,
    scripts: [string, ...string[]][],
  ): Promise<{ code: number | null; stderr: string }[]> {
    handle.exec('BEGIN IMMEDIATE');
    try {
      return await Promise.all(scripts.map((script) => runScript(...script)));
    } finally {
      handle.exec('ROLLBACK');
    }
  }

  it('names the sync holding it, read from its lease row, and exits non-zero', {
    timeout: 60_000,
  }, async () => {
    const handle = await connect();
    const lock = acquireMirrorLock(handle);
    const holder = readMirrorLock(handle);
    if (holder === undefined) throw new Error('The lease row was not written.');
    let runs: { code: number | null; stderr: string }[];
    try {
      runs = await whileWriting(handle, [
        ['mirror-status.ts'],
        ['mirror-status.ts', '--verify'],
        ['mirror-refresh.ts'],
      ]);
    } finally {
      lock.release();
    }

    for (const { code, stderr } of runs) {
      expect(code).toBe(1);
      expect(stderr).toContain(
        `error: The mirror store is busy: the sync run by pid ${process.pid} on host ${hostname()} since ${holder.acquiredAt} (last heartbeat ${holder.heartbeatAt}) holds its write lock. Try again once that write finishes.\n`,
      );
      expect(stderr).not.toContain('mirror store "store.sqlite"');
    }
  });

  it('reports the lock alone when no live sync holds the lease', { timeout: 60_000 }, async () => {
    const [run] = await whileWriting(await connect(), [['mirror-status.ts']]);

    expect(run?.code).toBe(1);
    expect(run?.stderr).toContain(
      'error: The mirror store is busy: another connection holds its write lock. Try again once that write finishes.\n',
    );
    expect(run?.stderr).not.toContain('mirror store "store.sqlite"');
  });
});
