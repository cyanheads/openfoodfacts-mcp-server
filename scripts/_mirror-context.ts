/**
 * @fileoverview Shared harness for the `mirror:*` scripts: the store path from `OFF_MIRROR_PATH`, a
 * console logger, abort on SIGINT/SIGTERM (a second signal exits at once), and one exit-code and
 * error-report policy, a store busy under a sync's write lock included. Imported by mirror-init,
 * mirror-refresh, and mirror-status, so it travels with them into the Docker image, where the
 * emitted tsconfig maps `@/` to `dist/` as a checkout maps it to `src/`.
 * @module scripts/_mirror-context
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { type MirrorLogger, openSqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig } from '@/config/server-config.js';
import { type MirrorLockHolder, readMirrorLock } from '@/services/mirror/mirror-lock.js';

/** What a script's body receives. */
export interface MirrorScriptContext {
  log: MirrorLogger;
  /** The store file `OFF_MIRROR_PATH` names. */
  path: string;
  signal: AbortSignal;
}

/**
 * Runs `main` and sets the exit code it returns: 1 when `OFF_MIRROR_PATH` is unset or `main`
 * throws, printing the error's message and `data.reason`. A store whose write lock another
 * connection held past the 5 s busy timeout (a sync's sort index build holds it for minutes) is
 * reported as busy, naming the sync that holds it, instead of by the lock error.
 */
export async function runMirrorScript(
  main: (context: MirrorScriptContext) => Promise<number>,
): Promise<void> {
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (controller.signal.aborted) process.exit(130);
      console.error(`${signal}: stopping after the current page (send it again to exit now).`);
      controller.abort(new Error(`Received ${signal}.`));
    });
  }
  let path: string | undefined;
  try {
    path = getServerConfig().mirrorPath;
    if (path === undefined) {
      console.error(
        'OFF_MIRROR_PATH is not set. Point it at the mirror store file, e.g. /usr/src/app/.mirror/openfoodfacts.sqlite in the Docker image.',
      );
      process.exitCode = 1;
      return;
    }
    process.exitCode = await main({
      log: consoleLogger(),
      path,
      signal: controller.signal,
    });
  } catch (err) {
    if (path !== undefined && isSqliteBusy(err)) {
      console.error(`error: ${busyMessage(await readLockHolder(path))}`);
    } else {
      const reason = err instanceof McpError ? err.data?.reason : undefined;
      console.error(
        `error: ${err instanceof Error ? err.message : String(err)}${reason ? ` (${String(reason)})` : ''}`,
      );
    }
    process.exitCode = 1;
  }
}

/** Whether `err` or an error it wraps is SQLite's `SQLITE_BUSY*`, which both drivers name on `code`. */
function isSqliteBusy(err: unknown): boolean {
  for (let cause = err; cause instanceof Error; cause = cause.cause) {
    const { code } = cause as { code?: unknown };
    if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return true;
  }
  return false;
}

/**
 * The live sync lock holder, read through a bare connection: it runs no schema statement, so it
 * writes nothing and, under WAL, reads the committed lease row past the write lock the store's own
 * open queues behind. `undefined` when the row names no live holder, or cannot be read, so the busy
 * report goes out without it.
 */
async function readLockHolder(path: string): Promise<MirrorLockHolder | undefined> {
  try {
    const handle = await openSqliteHandle(path);
    try {
      return readMirrorLock(handle);
    } finally {
      handle.close();
    }
  } catch {
    return;
  }
}

function busyMessage(holder: MirrorLockHolder | undefined): string {
  return holder === undefined
    ? 'The mirror store is busy: another connection holds its write lock. Try again once that write finishes.'
    : `The mirror store is busy: the sync run by pid ${holder.pid} on host ${holder.host} since ${holder.acquiredAt} (last heartbeat ${holder.heartbeatAt}) holds its write lock. Try again once that write finishes.`;
}

function consoleLogger(): MirrorLogger {
  const line = (level: string, message: string, meta?: Readonly<Record<string, unknown>>) =>
    `${new Date().toISOString()} ${level} ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`;
  return {
    debug: () => {},
    info: (message, meta) => console.log(line('info', message, meta)),
    notice: (message, meta) => console.log(line('notice', message, meta)),
    warning: (message, meta) => console.error(line('warning', message, meta)),
    error: (message, meta) => console.error(line('error', message, meta)),
  };
}
