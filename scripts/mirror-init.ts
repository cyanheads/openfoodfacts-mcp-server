#!/usr/bin/env bun
/**
 * @fileoverview mirror:init — full load of the Open Food Facts export into the store at
 * `OFF_MIRROR_PATH`, then the deltas published since. Re-running after an interrupt resumes the
 * download and the ingest where they stopped; running it on a completed store reloads it, deleting
 * products the new export no longer lists. On the 4.9M-product export it peaks at about 27 GB on
 * disk while the download sits beside the store, and leaves a store of about 14.3 GB.
 * @module scripts/mirror-init
 */

import { runMirrorSync } from '@/services/mirror/mirror-sync.js';
import * as recordBuilder from '@/services/mirror/record-builder.js';
import { runMirrorScript } from './_mirror-context.js';

await runMirrorScript(async ({ log, path, signal }) => {
  const report = await runMirrorSync({ builder: recordBuilder, log, mode: 'init', path, signal });
  log.info?.('mirror:init finished.', {
    generation: report.fullLoad?.generation,
    products: report.deltaResult.total,
    deltasApplied: report.deltasApplied,
    skippedLines: (report.fullLoad?.skippedLines ?? 0) + report.skippedDeltaLines,
  });
  return 0;
});
