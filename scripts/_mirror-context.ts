/**
 * @fileoverview Shared harness for the `mirror:*` scripts: the store path from `OFF_MIRROR_PATH`, a
 * console logger, abort on SIGINT/SIGTERM (a second signal exits at once), and one exit-code
 * policy. Imported by mirror-init, mirror-refresh, and mirror-status, so it travels with them into
 * the Docker image, where the emitted tsconfig maps `@/` to `dist/` as a checkout maps it to `src/`.
 * @module scripts/_mirror-context
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig } from '@/config/server-config.js';

/** What a script's body receives. */
export interface MirrorScriptContext {
  log: MirrorLogger;
  /** The store file `OFF_MIRROR_PATH` names. */
  path: string;
  signal: AbortSignal;
}

/**
 * Runs `main` and sets the exit code it returns: 1 when `OFF_MIRROR_PATH` is unset or `main`
 * throws, printing the error's message and `data.reason`.
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
  try {
    const { mirrorPath } = getServerConfig();
    if (mirrorPath === undefined) {
      console.error(
        'OFF_MIRROR_PATH is not set. Point it at the mirror store file, e.g. /usr/src/app/.mirror/openfoodfacts.sqlite in the Docker image.',
      );
      process.exitCode = 1;
      return;
    }
    process.exitCode = await main({
      log: consoleLogger(),
      path: mirrorPath,
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof McpError ? err.data?.reason : undefined;
    console.error(
      `error: ${err instanceof Error ? err.message : String(err)}${reason ? ` (${String(reason)})` : ''}`,
    );
    process.exitCode = 1;
  }
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
