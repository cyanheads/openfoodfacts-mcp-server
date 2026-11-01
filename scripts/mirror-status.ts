#!/usr/bin/env bun
/**
 * @fileoverview mirror:status and mirror:verify (`--verify`) — print the store's health: sync
 * status, readiness, product count, last sync, the as-of time mirror answers cite, the last full
 * load with the export lines it skipped, the sync lock, and bytes on disk. Exits non-zero unless
 * the store is ready (a sync has completed and it holds products); `--verify` also runs SQLite's
 * integrity check, which reads the whole file, and exits non-zero when it fails. A store whose
 * write lock a sync holds past the open's 5 s wait gets a busy report instead, naming the sync from
 * its lease row, and a non-zero exit. Never creates a store that does not exist; its open runs any
 * pending migration.
 * @module scripts/mirror-status
 */

import { existsSync } from 'node:fs';
import { openMirrorStore, readMirrorReport } from '@/services/mirror/mirror-store.js';
import { runMirrorScript } from './_mirror-context.js';

const verify = process.argv.includes('--verify');

await runMirrorScript(async ({ path }) => {
  if (!existsSync(path)) {
    console.error(`No mirror store at ${path}. Build it with \`bun run mirror:init\`.`);
    return 1;
  }
  const store = openMirrorStore(path);
  try {
    const report = await readMirrorReport(store, path);
    const rows: [string, string][] = [
      ['store', `${path} (${(report.storeBytes / 1e9).toFixed(2)} GB with WAL)`],
      ['status', `${report.status}${report.error ? ` — ${report.error}` : ''}`],
      ['ready', report.ready ? 'yes' : 'no'],
      ['products', report.products.toLocaleString('en-US')],
      ['last sync', report.lastSyncAt ?? 'never'],
      ['mirror as of', report.asOf ?? 'never'],
      [
        'last full load',
        report.load
          ? `${report.load.loadedAt} (generation ${report.load.generation}, record version ${report.load.recordVersion}, ${report.load.skippedLines} export line${report.load.skippedLines === 1 ? '' : 's'} skipped)`
          : 'never',
      ],
      [
        'sync lock',
        report.lock
          ? `held by pid ${report.lock.pid} on ${report.lock.host} since ${report.lock.acquiredAt}, heartbeat ${report.lock.heartbeatAt}`
          : 'free',
      ],
    ];
    for (const [label, value] of rows) console.log(`${label.padEnd(14)} ${value}`);
    let ok = report.ready;
    if (verify) {
      const integrity = await store.integrityCheck();
      console.log(
        `${'integrity'.padEnd(14)} ${integrity.ok ? 'ok' : integrity.results.join('; ')}`,
      );
      ok &&= integrity.ok;
    }
    if (!report.ready) {
      console.error(
        report.lastSyncAt === undefined
          ? 'Not ready: no sync has completed. Run `bun run mirror:init`.'
          : 'Not ready: the last sync completed but the store holds no products. Run `bun run mirror:init`.',
      );
    }
    return ok ? 0 : 1;
  } finally {
    await store.close();
  }
});
