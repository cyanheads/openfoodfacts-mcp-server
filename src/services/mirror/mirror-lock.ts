/**
 * @fileoverview Cross-process sync lock for the mirror store. `defineMirror()` guards against
 * overlapping runs only within one instance, while `mirror:init` runs in its own process and the
 * scheduled refresh in a child of the server, so both share this lease row in the store itself.
 * @module services/mirror/mirror-lock
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { conflict } from '@cyanheads/mcp-ts-core/errors';
import type { SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';

/** How often the holder renews its lease. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * A lease not renewed for this long is reclaimable. Well above the longest synchronous stretch a
 * sync holds the event loop for (a page transaction, a sweep window, the final row count), so a
 * live holder never looks dead.
 */
export const LOCK_TTL_MS = 5 * 60_000;

/** Holder tokens this process owns, so a dead process's row with a reused pid is still reclaimable. */
const heldTokens = new Set<string>();

/** Who holds the lock, as its row records. */
export interface MirrorLockHolder {
  acquiredAt: string;
  /** ISO time of the holder's last heartbeat. */
  heartbeatAt: string;
  host: string;
  pid: number;
}

/** A held lock. */
export interface MirrorLock {
  /**
   * Throws `lost`'s reason, aborting `lost` first if it has not, unless the lease row is still
   * this holder's. It reads the row itself, so a reclaim the heartbeat has not yet seen counts too.
   * A sync calls it before each page and sync-state write.
   */
  assertHeld(): void;
  /** Aborts if another process reclaims the lease — the holder must stop writing. */
  readonly lost: AbortSignal;
  /** Stops the heartbeat and deletes the row if this holder still owns it. Idempotent. */
  release(): void;
}

interface LockRow {
  acquired_at: string;
  heartbeat_at: number;
  holder: string;
  host: string;
  pid: number;
}

/**
 * Takes the lock under `BEGIN IMMEDIATE`, reclaiming a row whose holder stopped heartbeating or,
 * on this host, whose process is gone.
 *
 * @throws McpError `Conflict` with `data.reason: 'mirror_lock_held'` and `data.holder` when a live
 *   holder has it.
 */
export function acquireMirrorLock(handle: SqliteHandle): MirrorLock {
  const token = randomUUID();
  const host = hostname();
  const now = Date.now();
  handle.exec('BEGIN IMMEDIATE');
  try {
    const row = handle
      .prepare<LockRow>(
        'SELECT holder, pid, host, acquired_at, heartbeat_at FROM mirror_sync_lock WHERE id = 1',
      )
      .get();
    if (row != null && isLive(row, host, now)) {
      const holder = toHolder(row);
      throw conflict(
        `The mirror sync lock is held by pid ${holder.pid} on host ${holder.host} since ${holder.acquiredAt} (last heartbeat ${holder.heartbeatAt}). Wait for that run to finish, or stop that process; a holder that dies is reclaimed once its heartbeat is ${LOCK_TTL_MS / 60_000} minutes old.`,
        { reason: 'mirror_lock_held', holder: { ...holder } },
      );
    }
    handle
      .prepare(
        `INSERT INTO mirror_sync_lock(id, holder, pid, host, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, pid = excluded.pid, host = excluded.host,
           acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at`,
      )
      .run(token, process.pid, host, new Date(now).toISOString(), now);
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
  heldTokens.add(token);

  const controller = new AbortController();
  const renew = handle.prepare(
    'UPDATE mirror_sync_lock SET heartbeat_at = ? WHERE id = 1 AND holder = ?',
  );
  const owned = handle.prepare<{ found: number }>(
    'SELECT 1 AS found FROM mirror_sync_lock WHERE id = 1 AND holder = ?',
  );
  const lose = () => {
    clearInterval(heartbeat);
    controller.abort(
      conflict('Another process reclaimed the mirror sync lock while this run held it; stopping.', {
        reason: 'mirror_lock_lost',
      }),
    );
  };
  const heartbeat = setInterval(() => {
    let renewed: boolean;
    try {
      renewed = renew.run(Date.now(), token).changes > 0;
    } catch {
      // A write lock held past busy_timeout skips this beat; the next one retries well inside the TTL.
      return;
    }
    if (!renewed) lose();
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  let released = false;
  return {
    lost: controller.signal,
    assertHeld() {
      if (!controller.signal.aborted && owned.get(token) == null) lose();
      controller.signal.throwIfAborted();
    },
    release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      heldTokens.delete(token);
      handle.prepare('DELETE FROM mirror_sync_lock WHERE id = 1 AND holder = ?').run(token);
    },
  };
}

/** The current holder, or `undefined` when the lock is free or its holder is reclaimable. */
export function readMirrorLock(handle: SqliteHandle): MirrorLockHolder | undefined {
  const row = handle
    .prepare<LockRow>(
      'SELECT holder, pid, host, acquired_at, heartbeat_at FROM mirror_sync_lock WHERE id = 1',
    )
    .get();
  if (row == null || !isLive(row, hostname(), Date.now())) return;
  return toHolder(row);
}

function isLive(row: LockRow, host: string, now: number): boolean {
  if (now - row.heartbeat_at > LOCK_TTL_MS) return false;
  if (row.host !== host) return true;
  if (row.pid === process.pid) return heldTokens.has(row.holder);
  return isProcessAlive(row.pid);
}

/** Signal 0 probes for existence; EPERM means the pid exists under another user. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function toHolder(row: LockRow): MirrorLockHolder {
  return {
    pid: row.pid,
    host: row.host,
    acquiredAt: row.acquired_at,
    heartbeatAt: new Date(row.heartbeat_at).toISOString(),
  };
}
