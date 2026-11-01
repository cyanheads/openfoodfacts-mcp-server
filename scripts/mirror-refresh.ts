#!/usr/bin/env bun
/**
 * @fileoverview mirror:refresh — one pass of the scheduled refresh, by hand: apply each delta
 * published since the store's checkpoint, or reload the export when the last full load is 30 days
 * old, was built by an older record builder, or the listed deltas no longer reach back to it.
 * @module scripts/mirror-refresh
 */

import { runMirrorSync } from '@/services/mirror/mirror-sync.js';
import * as recordBuilder from '@/services/mirror/record-builder.js';
import { runMirrorScript } from './_mirror-context.js';

await runMirrorScript(async ({ log, path, signal }) => {
  const report = await runMirrorSync({
    builder: recordBuilder,
    log,
    mode: 'refresh',
    path,
    signal,
  });
  log.info?.('mirror:refresh finished.', {
    fullLoad: report.fullLoad?.reason ?? null,
    deltasApplied: report.deltasApplied,
    products: report.deltaResult.total,
  });
  return 0;
});
