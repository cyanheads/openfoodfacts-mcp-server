/**
 * @fileoverview Schedules the mirror refresh from the serving process. Each run is a child process
 * (the compiled `mirror-job` entry beside this module), because a sync's SQLite write transactions
 * block the event loop they run on; the parent only relays the child's log lines and stops it on
 * shutdown.
 * @module services/mirror/mirror-scheduler
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { z } from '@cyanheads/mcp-ts-core';
import type { MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import {
  logger,
  type RequestContext,
  schedulerService,
  withExtra,
} from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/**
 * Every three hours, at minute 30. Open Food Facts publishes one delta a day: the 13 listed on
 * 2026-11-01 end between 05:35 and 06:56 UTC, and `index.txt` is rewritten within seconds of the
 * newest file's end. Three hours applies each delta within three hours of publication whatever the
 * server's time zone (node-cron reads the pattern in local time), and a run with nothing new costs
 * one 0.7 KB index request.
 */
export const MIRROR_REFRESH_SCHEDULE = '30 */3 * * *';

/** How long a stopped job gets to finish its page and release the lock before SIGKILL. */
const STOP_GRACE_MS = 5_000;

const JOB_ID = 'openfoodfacts-mirror-refresh';

/** `mirror-job.js` beside this module in `dist/`, or `mirror-job.ts` when Bun runs `src/`. */
const JOB_ENTRY = fileURLToPath(
  new URL(`./mirror-job${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

let scheduled = false;
let active: MirrorJob | undefined;

/** Schedules the refresh job when `OFF_MIRROR_PATH` is set; otherwise does nothing. */
export async function startMirrorRefreshSchedule(): Promise<void> {
  if (getServerConfig().mirrorPath === undefined) return;
  await schedulerService.schedule(
    JOB_ID,
    MIRROR_REFRESH_SCHEDULE,
    async (context) => {
      const job = spawnMirrorJob(JOB_ENTRY, context);
      active = job;
      try {
        await job.exited;
      } finally {
        active = undefined;
      }
    },
    'Apply new Open Food Facts deltas to the local export mirror',
  );
  schedulerService.start(JOB_ID);
  scheduled = true;
}

/** Unschedules the job and stops a run in progress: SIGTERM, then SIGKILL after 5 s. */
export async function stopMirrorRefreshSchedule(): Promise<void> {
  if (scheduled) {
    schedulerService.remove(JOB_ID);
    scheduled = false;
  }
  await active?.stop(STOP_GRACE_MS);
}

/** How a job child ended. */
export interface MirrorJobExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** A running job child. */
export interface MirrorJob {
  /** Settles once the child has exited and its output is fully relayed; rejects if it never spawned. */
  readonly exited: Promise<MirrorJobExit>;
  /** SIGTERM, then SIGKILL once `graceMs` passes; resolves when the child is gone. */
  stop(graceMs: number): Promise<void>;
}

/**
 * Spawns `entry` with this process's runtime and flags, relaying each stdout line written by
 * {@link jobLogger} at its own level and any other output as a warning.
 */
export function spawnMirrorJob(entry: string, context: RequestContext): MirrorJob {
  const child = spawn(process.execPath, [...process.execArgv, entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  relayLines(child.stdout, (line) => relayJobLine(line, context));
  relayLines(child.stderr, (line) => logger.warning(`Mirror refresh job: ${line}`, context));
  const exited = (async (): Promise<MirrorJobExit> => {
    const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    const exit = { code, signal };
    if (code === 0) logger.info('Mirror refresh job finished.', withExtra(context, exit));
    else logger.warning('Mirror refresh job did not finish cleanly.', withExtra(context, exit));
    return exit;
  })();
  return {
    exited,
    async stop(graceMs) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), graceMs);
      try {
        await Promise.allSettled([exited]);
      } finally {
        clearTimeout(kill);
      }
    },
  };
}

const JobLineSchema = z.object({
  level: z.enum(['debug', 'info', 'notice', 'warning', 'error']),
  message: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** The logger a job child writes: one JSON object per stdout line, read back by the parent. */
export function jobLogger(
  write: (line: string) => void = (line) => process.stdout.write(line),
): MirrorLogger {
  const emit =
    (level: z.infer<typeof JobLineSchema>['level']) =>
    (message: string, meta?: Readonly<Record<string, unknown>>) =>
      write(`${JSON.stringify({ level, message, ...(meta && { meta }) })}\n`);
  return {
    debug: emit('debug'),
    info: emit('info'),
    notice: emit('notice'),
    warning: emit('warning'),
    error: emit('error'),
  };
}

function relayJobLine(line: string, context: RequestContext): void {
  let parsed: z.infer<typeof JobLineSchema> | undefined;
  try {
    parsed = JobLineSchema.parse(JSON.parse(line));
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    logger.warning(`Mirror refresh job: ${line}`, context);
    return;
  }
  const at = withExtra(context, parsed.meta ?? {});
  if (parsed.level === 'error') logger.error(parsed.message, at);
  else logger[parsed.level](parsed.message, at);
}

function relayLines(stream: Readable, onLine: (line: string) => void): void {
  createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on('line', (line) => {
    if (line.trim() !== '') onLine(line);
  });
}
