/**
 * @fileoverview Entry of the scheduled refresh's child process: one `refresh` sync against the store
 * at `OFF_MIRROR_PATH`, logged as JSON lines on stdout for the parent to relay. SIGTERM stops it at
 * the next page boundary with the lock released and the checkpoint where the last applied delta
 * left it. Exits 0 on success and 1 otherwise.
 * @module services/mirror/mirror-job
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { jobLogger } from './mirror-scheduler.js';
import { runMirrorSync } from './mirror-sync.js';
import * as recordBuilder from './record-builder.js';

const log = jobLogger();
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => controller.abort(new Error(`Received ${signal}.`)));
}

const { mirrorPath } = getServerConfig();
if (mirrorPath === undefined) {
  log.error?.('OFF_MIRROR_PATH is not set, so the refresh job has no store to refresh.');
  process.exitCode = 1;
} else {
  try {
    const report = await runMirrorSync({
      builder: recordBuilder,
      log,
      mode: 'refresh',
      path: mirrorPath,
      signal: controller.signal,
    });
    log.info?.('Mirror refresh finished.', {
      fullLoad: report.fullLoad?.reason ?? null,
      deltasApplied: report.deltasApplied,
      recordsApplied:
        (report.fullLoad?.result.recordsApplied ?? 0) + report.deltaResult.recordsApplied,
    });
    process.exitCode = 0;
  } catch (err) {
    log.error?.(err instanceof Error ? err.message : String(err), {
      reason: err instanceof McpError ? (err.data?.reason ?? null) : null,
    });
    process.exitCode = 1;
  }
}
