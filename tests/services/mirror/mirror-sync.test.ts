/**
 * @fileoverview Tests for a mirror sync run against a fake Open Food Facts static host on
 * 127.0.0.1: full init, download resume (`Range` + `If-Range`) and its restart on a changed ETag,
 * an interrupted ingest resuming with no line skipped or applied twice, malformed and oversize
 * lines skipped and counted once across a resume, delta order and idempotence, the non-2xx stop, a
 * delta re-applied after a failure part way through it, the full reloads (age, record version,
 * gap) with their sweep and the checkpoint they move back, a load that stamps no product refused
 * before its sweep, the as-of a reload cites while it rewrites rows (interrupted and resumed
 * included), the age and gap reloads an unchanged export ETag skips, a refresh at a path naming no
 * file refused before it opens anything, and a run whose lease another run reclaimed writing
 * nothing over that run's completed state.
 * @module tests/services/mirror/mirror-sync.test
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { MirrorLogger, MirrorStore, SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type MirrorBuilder,
  type MirrorUpstream,
  OFF_UPSTREAM,
  parseExportCursor,
} from '@/services/mirror/mirror-ingester.js';
import {
  decodeCheckpoint,
  encodeCheckpoint,
  isMirrorReady,
  mirrorAsOf,
  openMirrorStore,
  readMirrorLoad,
  SORT_COLUMNS,
  SORT_KEYS_INDEX,
  sortIndexName,
} from '@/services/mirror/mirror-store.js';
import { runMirrorSync } from '@/services/mirror/mirror-sync.js';
import { USER_AGENT as SERVER_USER_AGENT } from '@/services/openfoodfacts/user-agent.js';

const USER_AGENT =
  'openfoodfacts-mcp-server/test (+https://github.com/cyanheads/openfoodfacts-mcp-server)';

interface Line {
  code?: string;
  name?: string;
  noise?: string;
  t?: number;
  tags?: string[];
}

const jsonl = (lines: Line[]) => gzipSync(lines.map((line) => JSON.stringify(line)).join('\n'));

function products(count: number, t = 1_793_000_000, prefix = 'P'): Line[] {
  return Array.from({ length: count }, (_, i) => ({
    code: `${prefix}${String(i).padStart(5, '0')}`,
    name: `${prefix}${i}`,
    t: t + i,
    tags: [`categories\u0001en:c${i % 7}`, `countries\u0001en:k${i % 3}`],
  }));
}

/** Projects a line as the real builder's seam does; `onBuild` sees every servable code it builds. */
function fakeBuilder(version = 1, onBuild?: (code: string) => void): MirrorBuilder {
  return {
    MIRROR_RECORD_VERSION: version,
    buildMirrorRecord(raw) {
      const line = raw as Line;
      if (typeof line.code !== 'string') return null;
      onBuild?.(line.code);
      return {
        code: line.code,
        popularityKey: line.t ?? null,
        uniqueScansN: null,
        createdT: null,
        lastModifiedT: line.t ?? null,
        tags: line.tags ?? [],
        doc: { product_name: line.name ?? null, version },
      };
    },
  };
}

interface Request {
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
}

/** The static host: the export behind a redirect (as S3 serves it), the delta index, the deltas. */
class FakeHost {
  server!: Server;
  base = '';
  requests: Request[] = [];
  exportBody = Buffer.alloc(0);
  etag = '"e1"';
  /** Send this many body bytes, call `onHold`, and never finish the response. Applies to one GET. */
  holdAfterBytes: number | undefined;
  onHold: () => void = () => {};
  /** The response `holdAfterBytes` left unfinished, for a test to cut. */
  held: ServerResponse | undefined;
  index: string[] = [];
  deltas = new Map<string, Buffer>();
  statuses = new Map<string, number>();
  /** Called as each request arrives, before it is answered. */
  onRequest: (path: string) => void = () => {};
  /**
   * Answers an export request in place of the host, given the byte the request resumes from (0
   * unless its `Range` and `If-Range` match). Returns false to leave it to the host.
   */
  answerExport: ((res: ServerResponse, from: number, req: IncomingMessage) => boolean) | undefined;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const path = req.url ?? '';
      this.requests.push({ path, method: req.method ?? '', headers: req.headers });
      this.onRequest(path);
      const status = this.statuses.get(path);
      if (status !== undefined) {
        res.writeHead(status).end('refused');
        return;
      }
      if (path === '/data/openfoodfacts-products.jsonl.gz') {
        res.writeHead(302, { location: '/s3/openfoodfacts-products.jsonl.gz' }).end();
        return;
      }
      if (path === '/s3/openfoodfacts-products.jsonl.gz') {
        const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
        const from = range && req.headers['if-range'] === this.etag ? Number(range[1]) : 0;
        if (this.answerExport?.(res, from, req)) return;
        const body = this.exportBody.subarray(from);
        res.writeHead(from > 0 ? 206 : 200, {
          etag: this.etag,
          'content-length': body.length,
          ...(from > 0 && {
            'content-range': `bytes ${from}-${this.exportBody.length - 1}/${this.exportBody.length}`,
          }),
        });
        const hold = this.holdAfterBytes;
        // A HEAD has no body to hold.
        if (hold === undefined || req.method !== 'GET') {
          res.end(body);
          return;
        }
        this.holdAfterBytes = undefined;
        this.held = res;
        res.write(body.subarray(0, hold), () => this.onHold());
        return;
      }
      if (path === '/data/delta/index.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end(this.index.join('\n'));
        return;
      }
      const delta = this.deltas.get(path.replace('/data/delta/', ''));
      if (delta !== undefined) {
        res.writeHead(200).end(delta);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get upstream(): MirrorUpstream {
    return {
      exportUrl: `${this.base}/data/openfoodfacts-products.jsonl.gz`,
      deltaBaseUrl: `${this.base}/data/delta/`,
      requestGapMs: 0,
      userAgent: USER_AGENT,
    };
  }

  /** Lists a delta (newest first, as upstream does) and serves its lines. */
  addDelta(start: number, end: number, lines: Line[]): string {
    const name = `openfoodfacts_products_${start}_${end}.json.gz`;
    this.deltas.set(name, jsonl(lines));
    this.index = [name, ...this.index];
    return name;
  }

  paths(): string[] {
    return this.requests.map((r) => r.path);
  }

  /** Each request as `<method> <path>`. */
  calls(): string[] {
    return this.requests.map((r) => `${r.method} ${r.path}`);
  }
}

/** The requests a refresh sends to read the delta index and check the export's ETag. */
const INDEX_AND_ETAG_CHECK = [
  'GET /data/delta/index.txt',
  'HEAD /data/openfoodfacts-products.jsonl.gz',
  'HEAD /s3/openfoodfacts-products.jsonl.gz',
];

const silent: MirrorLogger = {};

interface LogLine {
  level: string;
  message: string;
  meta?: Readonly<Record<string, unknown>>;
}

/** A logger that keeps every line it is given. */
function capture(): { lines: LogLine[]; log: MirrorLogger; warnings(): LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: string) => (message: string, meta?: Readonly<Record<string, unknown>>) => {
    lines.push({ level, message, ...(meta && { meta }) });
  };
  return {
    lines,
    log: {
      debug: at('debug'),
      info: at('info'),
      notice: at('notice'),
      warning: at('warning'),
      error: at('error'),
    },
    warnings: () => lines.filter((line) => line.level === 'warning'),
  };
}

let dir: string;
let path: string;
let host: FakeHost;
let probe: MirrorStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'off-mirror-sync-'));
  path = join(dir, 'store.sqlite');
  host = new FakeHost();
  await host.start();
  probe = openMirrorStore(path);
});

afterEach(async () => {
  vi.useRealTimers();
  await probe.close();
  await host.stop();
  await rm(dir, { recursive: true, force: true });
});

function sync(
  mode: 'init' | 'refresh',
  builder: MirrorBuilder = fakeBuilder(),
  signal = new AbortController().signal,
  log: MirrorLogger = silent,
) {
  return runMirrorSync({ builder, log, mode, path, signal, upstream: host.upstream });
}

/** Adds incompressible bytes to each line, so the gzipped export spans many network chunks. */
function noisy(lines: Line[]): Line[] {
  return lines.map((line) => ({ ...line, noise: randomBytes(24).toString('hex') }));
}

/**
 * Runs an init whose export download stalls after `bytes`, and aborts it once part of the body is
 * on disk — the condition, not a timer, decides when. Resolves with the bytes left on disk.
 */
async function interruptedDownload(bytes: number): Promise<number> {
  const download = `${path}.export.jsonl.gz`;
  const controller = new AbortController();
  host.holdAfterBytes = bytes;
  host.onHold = () => {
    const poll = setInterval(() => {
      if (existsSync(download) && statSync(download).size > 0) {
        clearInterval(poll);
        controller.abort(new Error('interrupted'));
      }
    }, 2);
  };
  await expect(sync('init', fakeBuilder(), controller.signal)).rejects.toThrow();
  const onDisk = statSync(download).size;
  expect(onDisk).toBeGreaterThan(0);
  return onDisk;
}

/** Resolves once `ready()` holds, checked on a real interval (the tests fake setTimeout only). */
function until(ready: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!ready()) return;
      clearInterval(poll);
      resolve();
    }, 2);
  });
}

/** Resolves once `ready()` holds, checked between event-loop turns, for tests that fake setInterval. */
async function settle(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Runs the scheduled refresh's child entry against the store, as the server's scheduler spawns it,
 * and reads back the JSON log lines it writes to stdout.
 */
async function runJob(): Promise<{ code: number | null; lines: unknown[]; stderr: string }> {
  const bun = process.versions.bun ? process.execPath : 'bun';
  const child = spawn(bun, ['src/services/mirror/mirror-job.ts'], {
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
  const lines = stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
  return { code, lines, stderr };
}

/** Runs `mode` over the served export and aborts it once the builder reaches `code`. */
async function interruptedIngest(mode: 'init' | 'refresh', code: string): Promise<void> {
  const controller = new AbortController();
  const builder = fakeBuilder(1, (built) => {
    if (built === code) controller.abort(new Error('interrupted'));
  });
  await expect(sync(mode, builder, controller.signal)).rejects.toThrow('interrupted');
}

async function codes(): Promise<string[]> {
  const handle = await probe.raw();
  return handle
    .prepare<{ code: string }>('SELECT code FROM products ORDER BY code')
    .all()
    .map((r) => r.code);
}

async function doc(code: string): Promise<Record<string, unknown> | undefined> {
  const [found] = await probe.getByIds([code]);
  return found ? JSON.parse(String(found.doc)) : undefined;
}

/** How many product rows carry `generation`. */
async function stampedCount(generation: number): Promise<number | undefined> {
  const handle = await probe.raw();
  return handle
    .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM products WHERE generation = ?')
    .get(generation)?.n;
}

async function checkpoint() {
  const value = (await probe.readState()).checkpoint;
  return value === undefined ? undefined : decodeCheckpoint(value);
}

/** Every index `ensureSortIndexes` builds, by name. */
const SORT_INDEXES = [...SORT_COLUMNS.map(sortIndexName), SORT_KEYS_INDEX].sort();

/** The indexes on `products` the store holds beyond its primary key, by name. */
function sortIndexes(handle: SqliteHandle): string[] {
  return handle
    .prepare<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'products' AND sql IS NOT NULL ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

describe('mirror:init', () => {
  it('loads every servable line, applies the deltas after the export, and deletes the download', async () => {
    const lines: Line[] = [{ name: 'no code' }, ...products(2_500)];
    host.exportBody = jsonl(lines);
    const exportMax = 1_793_000_000 + 2_499;
    host.addDelta(1_792_900_000, exportMax - 10, [{ code: 'P00000', name: 'stale', t: 1 }]);
    const after = host.addDelta(exportMax - 10, exportMax + 500, [
      { code: 'P00001', name: 'edited', t: exportMax + 400 },
      { code: 'NEW01', name: 'new', t: exportMax + 450 },
    ]);

    const report = await sync('init');

    expect(report.fullLoad).toMatchObject({ reason: 'requested', generation: 1 });
    expect(report.deltasApplied).toEqual([after]);
    expect(await codes()).toHaveLength(2_501);
    expect(await doc('P00000')).toMatchObject({ product_name: 'P0' });
    expect(await doc('P00001')).toMatchObject({ product_name: 'edited' });
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax + 500 });
    expect(await mirrorAsOf(probe)).toBe(new Date((exportMax + 500) * 1000).toISOString());
    expect(await isMirrorReady(probe)).toBe(true);
    expect(readMirrorLoad(await probe.raw())).toMatchObject({ generation: 1, recordVersion: 1 });
    expect(readMirrorLoad(await probe.raw())).toMatchObject({ etag: '"e1"', skippedLines: 0 });
    expect(existsSync(`${path}.export.jsonl.gz`)).toBe(false);
    expect(host.paths()).toEqual([
      '/data/openfoodfacts-products.jsonl.gz',
      '/s3/openfoodfacts-products.jsonl.gz',
      '/data/delta/index.txt',
      `/data/delta/${after}`,
    ]);
    for (const request of host.requests) expect(request.headers['user-agent']).toBe(USER_AGENT);
    const handle = await probe.raw();
    const posting = handle
      .prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.key = 'countries\u0001en:k0'",
      )
      .get();
    expect(posting?.n).toBe(834);
  });

  it('resumes an interrupted download with Range and If-Range from the bytes on disk', async () => {
    host.exportBody = jsonl(noisy(products(3_000)));
    const onDisk = await interruptedDownload(30_000);
    const state = await probe.readState();
    expect(state.status).toBe('error');
    expect(parseExportCursor(state.cursor)).toMatchObject({ phase: 'download', etag: '"e1"' });
    expect(onDisk).toBeLessThan(host.exportBody.length);

    host.requests = [];
    const report = await sync('init');

    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 1 });
    const resumed = host.requests.find((r) => r.path.startsWith('/s3/'));
    expect(resumed?.headers.range).toBe(`bytes=${onDisk}-`);
    expect(resumed?.headers['if-range']).toBe('"e1"');
    expect(await codes()).toHaveLength(3_000);
  });

  it('restarts from byte 0 when the export changed, answering the resume with 200', async () => {
    host.exportBody = jsonl(noisy(products(3_000, 1_793_000_000, 'OLD')));
    await interruptedDownload(30_000);
    host.exportBody = jsonl(products(1_000, 1_793_100_000, 'NEW'));
    host.etag = '"e2"';
    host.requests = [];

    await sync('init');

    const resumed = host.requests.find((r) => r.path.startsWith('/s3/'));
    expect(resumed?.headers['if-range']).toBe('"e1"');
    const stored = await codes();
    expect(stored).toHaveLength(1_000);
    expect(stored.every((code) => code.startsWith('NEW'))).toBe(true);
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: 1_793_100_999 });
  });

  it('resumes an interrupted ingest after its last applied page, skipping and repeating no line', async () => {
    const lines: Line[] = [{ name: 'no code' }, ...products(4_500)];
    host.exportBody = jsonl(lines);
    const controller = new AbortController();
    const firstRun: string[] = [];
    await expect(
      sync(
        'init',
        fakeBuilder(1, (code) => {
          firstRun.push(code);
          if (code === 'P02500') controller.abort(new Error('interrupted'));
        }),
        controller.signal,
      ),
    ).rejects.toThrow('interrupted');
    const cursor = parseExportCursor((await probe.readState()).cursor);
    // The page the abort landed in (P02000–P03999) was built but never applied.
    expect(cursor).toMatchObject({ phase: 'ingest', line: 2_001 });
    expect(await codes()).toHaveLength(2_000);

    const secondRun: string[] = [];
    await sync(
      'init',
      fakeBuilder(1, (code) => secondRun.push(code)),
    );

    expect(secondRun[0]).toBe('P02000');
    expect(secondRun).toHaveLength(2_500);
    expect(new Set([...firstRun.slice(0, 2_000), ...secondRun]).size).toBe(4_500);
    expect(await codes()).toHaveLength(4_500);
  });

  it('restarts the ingest under a new generation when the export changed after part of it was applied', async () => {
    host.exportBody = jsonl(products(4_500, 1_793_000_000, 'OLD'));
    await interruptedIngest('init', 'OLD02500');
    expect(parseExportCursor((await probe.readState()).cursor)).toMatchObject({
      generation: 1,
      phase: 'ingest',
      line: 2_000,
    });
    expect(await codes()).toHaveLength(2_000);
    // A download cut short on disk sends the resume back to the host, which now serves a new export.
    await truncate(`${path}.export.jsonl.gz`, 100);
    host.exportBody = jsonl(products(1_000, 1_793_100_000, 'NEW'));
    host.etag = '"e2"';
    host.requests = [];

    const built: string[] = [];
    const report = await sync(
      'init',
      fakeBuilder(1, (code) => built.push(code)),
    );

    const resumed = host.requests.find((r) => r.path.startsWith('/s3/'));
    expect(resumed?.headers.range).toBe('bytes=100-');
    expect(resumed?.headers['if-range']).toBe('"e1"');
    expect(built[0]).toBe('NEW00000');
    expect(built).toHaveLength(1_000);
    const stored = await codes();
    expect(stored).toHaveLength(1_000);
    expect(stored.every((code) => code.startsWith('NEW'))).toBe(true);
    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 2 });
    expect(readMirrorLoad(await probe.raw())).toMatchObject({ generation: 2 });
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: 1_793_100_999 });
  });

  it('restarts under a new generation when a corrupt download is fetched again from a changed export', async () => {
    host.exportBody = jsonl(products(4_500, 1_793_000_000, 'OLD'));
    await interruptedIngest('init', 'OLD02500');
    // A flipped byte in the gzip trailer's CRC: the resumed ingest reads to the end, then fails.
    const download = `${path}.export.jsonl.gz`;
    const bytes = await readFile(download);
    const crc = bytes.length - 8;
    bytes.writeUInt8(bytes.readUInt8(crc) ^ 0xff, crc);
    await writeFile(download, bytes);
    await expect(sync('init')).rejects.toMatchObject({ data: { reason: 'export_corrupt' } });
    expect(existsSync(download)).toBe(false);
    expect(parseExportCursor((await probe.readState()).cursor)).toMatchObject({
      generation: 1,
      phase: 'download',
    });
    expect((await codes()).length).toBeGreaterThan(2_000);
    host.exportBody = jsonl(products(1_000, 1_793_100_000, 'NEW'));
    host.etag = '"e2"';

    const report = await sync('init');

    const stored = await codes();
    expect(stored).toHaveLength(1_000);
    expect(stored.every((code) => code.startsWith('NEW'))).toBe(true);
    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 2 });
  });

  it('skips a malformed line and one past 16 MiB in an otherwise good export, counting and logging each by number alone', async () => {
    const [first, second, third] = products(3).map((line) => JSON.stringify(line));
    const oversize = JSON.stringify({ code: 'HUGE', name: 'x'.repeat(16 * 1024 * 1024) });
    host.exportBody = gzipSync(
      [first, '{"code":"BAD","name":', oversize, second, '', third].join('\n'),
    );
    const { lines, log, warnings } = capture();

    const report = await sync('init', fakeBuilder(), undefined, log);

    expect(report.fullLoad).toMatchObject({ reason: 'requested', generation: 1, skippedLines: 2 });
    expect(await codes()).toEqual(['P00000', 'P00001', 'P00002']);
    expect(readMirrorLoad(await probe.raw())).toMatchObject({ generation: 1, skippedLines: 2 });
    expect(warnings()).toEqual([
      {
        level: 'warning',
        message: 'Skipped a feed line that is not valid JSON.',
        meta: { feed: 'export', line: 2, reason: 'upstream_line_malformed' },
      },
      {
        level: 'warning',
        message: 'Skipped a feed line longer than 16 MiB.',
        meta: {
          feed: 'export',
          line: 3,
          reason: 'upstream_line_too_long',
          bytes: Buffer.byteLength(oversize),
        },
      },
    ]);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain('BAD');
    expect(logged).not.toContain('xxxxxxxx');
    expect(existsSync(`${path}.export.jsonl.gz`)).toBe(false);
    expect(await isMirrorReady(probe)).toBe(true);
  });

  it('resumes an ingest interrupted past skipped lines, counting each once and skipping no good line', async () => {
    const lines = products(4_500).map((line) => JSON.stringify(line));
    // Line 1,001 lands in the first page, applied before the interrupt.
    lines.splice(1_000, 0, '{"code":');
    // Line 2,301 lands in the page the interrupt discards, so the resume reads it again.
    lines.splice(2_300, 0, 'not json');
    host.exportBody = gzipSync(lines.join('\n'));
    const skippedAt = (line: number) => ({
      level: 'warning',
      message: 'Skipped a feed line that is not valid JSON.',
      meta: { feed: 'export', line, reason: 'upstream_line_malformed' },
    });
    const firstRun = capture();
    const controller = new AbortController();
    const interrupting = fakeBuilder(1, (code) => {
      if (code === 'P02500') controller.abort(new Error('interrupted'));
    });

    await expect(sync('init', interrupting, controller.signal, firstRun.log)).rejects.toThrow(
      'interrupted',
    );

    expect(parseExportCursor((await probe.readState()).cursor)).toMatchObject({
      phase: 'ingest',
      line: 2_001,
      skipped: 1,
    });
    expect(await codes()).toHaveLength(2_000);
    expect(firstRun.warnings()).toEqual([skippedAt(1_001), skippedAt(2_301)]);

    const secondRun = capture();
    const built: string[] = [];
    const report = await sync(
      'init',
      fakeBuilder(1, (code) => built.push(code)),
      undefined,
      secondRun.log,
    );

    expect(built[0]).toBe('P02000');
    expect(built).toHaveLength(2_500);
    expect(await codes()).toHaveLength(4_500);
    expect(report.fullLoad).toMatchObject({ reason: 'resume', skippedLines: 2 });
    expect(readMirrorLoad(await probe.raw())).toMatchObject({ skippedLines: 2 });
    expect(secondRun.warnings()).toEqual([skippedAt(2_301)]);
  });

  it('builds the sort indexes once the ingest is in, before the checkpoint is set and the load completes', async () => {
    host.exportBody = jsonl(products(2_500));
    // A second connection, as the serving process holds, read when the build is logged.
    const watcher = openMirrorStore(path);
    const watcherHandle = await watcher.raw();
    const seen: {
      checkpoint: string | null;
      completedAt: string | null;
      indexes: string[];
      products: number;
    }[] = [];
    const log: MirrorLogger = {
      info: (message) => {
        if (message !== 'Built the sort indexes.') return;
        const state = watcherHandle
          .prepare<{ checkpoint: string | null; completed_at: string | null }>(
            'SELECT checkpoint, completed_at FROM mirror_sync_state',
          )
          .get();
        seen.push({
          checkpoint: state?.checkpoint ?? null,
          completedAt: state?.completed_at ?? null,
          indexes: sortIndexes(watcherHandle),
          products:
            watcherHandle.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM products').get()?.n ??
            0,
        });
      },
    };

    await runMirrorSync({
      builder: fakeBuilder(),
      log,
      mode: 'init',
      path,
      signal: new AbortController().signal,
      upstream: host.upstream,
    });
    await watcher.close();

    expect(seen).toEqual([
      { checkpoint: null, completedAt: null, indexes: SORT_INDEXES, products: 2_500 },
    ]);
    expect(sortIndexes(await probe.raw())).toEqual(SORT_INDEXES);
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: 1_793_002_499 });
  });

  it('refuses the scheduled job with mirror_lock_held while a cold mirror:init runs, and the init resumes after', {
    timeout: 60_000,
  }, async () => {
    host.exportBody = jsonl(noisy(products(3_000)));
    const controller = new AbortController();
    const holding = new Promise<void>((resolve) => {
      host.holdAfterBytes = 30_000;
      host.onHold = resolve;
    });
    const init = sync('init', fakeBuilder(), controller.signal);
    const stopped = expect(init).rejects.toThrow();
    await holding;

    const job = await runJob();

    expect(job.code).toBe(1);
    expect(job.lines).toContainEqual({
      level: 'error',
      message: expect.stringContaining(`held by pid ${process.pid} on host ${hostname()}`),
      meta: { reason: 'mirror_lock_held' },
    });
    controller.abort(new Error('interrupted'));
    await stopped;
    expect(parseExportCursor((await probe.readState()).cursor)).toMatchObject({
      phase: 'download',
      etag: '"e1"',
      generation: 1,
    });
    expect(readMirrorLoad(await probe.raw())).toBeUndefined();

    const report = await sync('init');

    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 1 });
    expect(await codes()).toHaveLength(3_000);
  });

  it('refuses a refresh while the first load is interrupted, leaving it for mirror:init to resume', async () => {
    host.exportBody = jsonl(products(4_500));
    await interruptedIngest('init', 'P02500');
    const before = await probe.readState();
    host.requests = [];

    await expect(sync('refresh')).rejects.toMatchObject({
      message: expect.stringContaining(
        'first full load was interrupted. Run `bun run mirror:init` to resume it.',
      ),
      data: { reason: 'mirror_not_initialized' },
    });

    expect(host.requests).toEqual([]);
    expect(await probe.readState()).toEqual(before);
    await sync('init');
    expect(await codes()).toHaveLength(4_500);
  });

  it('refuses a first load whose export stamps no product, leaving the store never loaded', async () => {
    host.exportBody = gzipSync(['{', '', '{"name":"no code"}'].join('\n'));

    await expect(sync('init')).rejects.toMatchObject({
      message: expect.stringContaining('built no product'),
      data: { reason: 'export_no_products' },
    });

    const state = await probe.readState();
    expect(state.status).toBe('error');
    expect(state.completedAt).toBeUndefined();
    expect(state.checkpoint).toBeUndefined();
    expect(parseExportCursor(state.cursor)).toMatchObject({ phase: 'download', generation: 1 });
    expect(readMirrorLoad(await probe.raw())).toBeUndefined();
    expect(await codes()).toEqual([]);
    expect(await isMirrorReady(probe)).toBe(false);
    expect(existsSync(`${path}.export.jsonl.gz`)).toBe(false);
  });

  it('stops on an export answered without a strong ETag or a Content-Length, downloading nothing', async () => {
    host.exportBody = jsonl(products(100));
    const body = host.exportBody;
    const answers: ((res: ServerResponse) => void)[] = [
      (res) => res.writeHead(200, { etag: 'W/"e1"', 'content-length': body.length }).end(body),
      (res) => res.writeHead(200, { 'content-length': body.length }).end(body),
      // No Content-Length: Node sends the body chunked.
      (res) => {
        res.writeHead(200, { etag: '"e1"' });
        res.write(body);
        res.end();
      },
    ];
    for (const answer of answers) {
      host.answerExport = (res) => {
        answer(res);
        return true;
      };
      await expect(sync('init')).rejects.toMatchObject({
        data: { reason: 'export_unresumable' },
      });
      expect(existsSync(`${path}.export.jsonl.gz`)).toBe(false);
      expect(await codes()).toEqual([]);
      expect(await probe.readState()).toMatchObject({ status: 'error' });
      expect((await probe.readState()).cursor).toBeUndefined();
    }

    host.answerExport = undefined;
    await sync('init');
    expect(await codes()).toHaveLength(100);
  });

  it('stops on a resume answered with another byte range, appending nothing to the bytes on disk', async () => {
    host.exportBody = jsonl(noisy(products(3_000)));
    const onDisk = await interruptedDownload(30_000);
    const total = host.exportBody.length;
    const ranges = [
      (from: number) => [from - 1, total - 1, total],
      (from: number) => [from, total - 1, total + 1],
    ];
    for (const range of ranges) {
      host.answerExport = (res, from) => {
        if (from === 0) return false;
        const [start, end, size] = range(from) as [number, number, number];
        const body = host.exportBody.subarray(start);
        res
          .writeHead(206, {
            etag: host.etag,
            'content-length': body.length,
            'content-range': `bytes ${start}-${end}/${size}`,
          })
          .end(body);
        return true;
      };
      await expect(sync('init')).rejects.toMatchObject({
        data: { reason: 'upstream_range_mismatch' },
      });
      expect(statSync(`${path}.export.jsonl.gz`).size).toBe(onDisk);
    }

    host.answerExport = undefined;
    const report = await sync('init');

    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 1 });
    expect(await codes()).toHaveLength(3_000);
  });

  it('resumes again from where a resume whose body ended short left the file', async () => {
    host.exportBody = jsonl(noisy(products(3_000)));
    const onDisk = await interruptedDownload(30_000);
    const delivered = 20_000;
    expect(onDisk + delivered).toBeLessThan(host.exportBody.length);
    host.answerExport = (res, from) => {
      if (from !== onDisk) return false;
      const body = host.exportBody.subarray(from, from + delivered);
      res
        .writeHead(206, {
          etag: host.etag,
          'content-length': body.length,
          'content-range': `bytes ${from}-${host.exportBody.length - 1}/${host.exportBody.length}`,
        })
        .end(body);
      return true;
    };

    await expect(sync('init')).rejects.toMatchObject({
      data: { reason: 'upstream_body_truncated' },
    });
    expect(statSync(`${path}.export.jsonl.gz`).size).toBe(onDisk + delivered);
    expect(parseExportCursor((await probe.readState()).cursor)).toMatchObject({
      phase: 'download',
      etag: '"e1"',
    });

    host.requests = [];
    const report = await sync('init');

    const resumed = host.requests.find((r) => r.path.startsWith('/s3/'));
    expect(resumed?.headers.range).toBe(`bytes=${onDisk + delivered}-`);
    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 1 });
    expect(await codes()).toHaveLength(3_000);
  });

  it('abandons a download that delivers no bytes for 60 s as upstream_stalled, and the next run resumes it', async () => {
    host.exportBody = jsonl(noisy(products(3_000)));
    const download = `${path}.export.jsonl.gz`;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const holding = new Promise<void>((resolve) => {
      host.holdAfterBytes = 30_000;
      host.onHold = resolve;
    });
    const run = sync('init');
    const stalled = expect(run).rejects.toMatchObject({ data: { reason: 'upstream_stalled' } });
    await holding;
    // Every byte the host sent is on disk, so the stall timer was last armed by the last chunk.
    await until(() => existsSync(download) && statSync(download).size === 30_000);
    vi.advanceTimersByTime(60_000);
    await stalled;

    vi.useRealTimers();
    const onDisk = statSync(download).size;
    expect(onDisk).toBe(30_000);
    expect(parseExportCursor((await probe.readState()).cursor)).toMatchObject({
      phase: 'download',
      etag: '"e1"',
    });
    host.requests = [];
    const report = await sync('init');
    const resumed = host.requests.find((r) => r.path.startsWith('/s3/'));
    expect(resumed?.headers.range).toBe(`bytes=${onDisk}-`);
    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 1 });
    expect(await codes()).toHaveLength(3_000);
  });

  it("identifies the mirror's downloads with the server's User-Agent, contact included", () => {
    expect(OFF_UPSTREAM.userAgent).toBe(SERVER_USER_AGENT);
    expect(OFF_UPSTREAM.userAgent).toMatch(
      /^openfoodfacts-mcp-server\/\d+\.\d+\.\d+ \(casey@caseyjhand\.com\)$/,
    );
  });
});

describe('mirror refresh', () => {
  const exportMax = 1_793_000_000 + 99;

  beforeEach(async () => {
    host.exportBody = jsonl(products(100));
    await sync('init');
    host.requests = [];
  });

  it('is refused on a store with no completed full load', async () => {
    await rm(path, { force: true });
    await probe.close();
    probe = openMirrorStore(join(dir, 'other.sqlite'));
    // The store exists, as an init that stopped before its first page leaves it.
    await probe.raw();
    await expect(
      runMirrorSync({
        builder: fakeBuilder(),
        log: silent,
        mode: 'refresh',
        path: join(dir, 'other.sqlite'),
        signal: new AbortController().signal,
        upstream: host.upstream,
      }),
    ).rejects.toMatchObject({
      message:
        'The mirror store has never completed a full load, so there is nothing to refresh. Run `bun run mirror:init` first.',
      data: { reason: 'mirror_not_initialized' },
    });
    expect(host.requests).toEqual([]);
  });

  it('is refused at a path naming no file before it opens anything, creating no store or directory', async () => {
    const absent = join(dir, 'absent');

    await expect(
      runMirrorSync({
        builder: fakeBuilder(),
        log: silent,
        mode: 'refresh',
        path: join(absent, 'store.sqlite'),
        signal: new AbortController().signal,
        upstream: host.upstream,
      }),
    ).rejects.toMatchObject({
      message:
        'The mirror store has never completed a full load, so there is nothing to refresh. Run `bun run mirror:init` first.',
      data: { reason: 'mirror_not_initialized' },
    });

    expect(existsSync(absent)).toBe(false);
    expect(host.requests).toEqual([]);
  });

  it('applies each delta past the checkpoint oldest first, and a second run applies nothing', async () => {
    const first = host.addDelta(exportMax - 50, exportMax + 100, [{ code: 'P00007', name: 'v1' }]);
    const second = host.addDelta(exportMax + 100, exportMax + 200, [
      { code: 'P00007', name: 'v2' },
    ]);
    const third = host.addDelta(exportMax + 200, exportMax + 300, [{ code: 'P00007', name: 'v3' }]);

    const report = await sync('refresh');

    expect(report.fullLoad).toBeUndefined();
    expect(report.deltasApplied).toEqual([first, second, third]);
    expect(host.paths()).toEqual([
      '/data/delta/index.txt',
      `/data/delta/${first}`,
      `/data/delta/${second}`,
      `/data/delta/${third}`,
    ]);
    expect(await doc('P00007')).toMatchObject({ product_name: 'v3' });
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax + 300 });

    host.requests = [];
    const again = await sync('refresh');
    expect(again.deltasApplied).toEqual([]);
    expect(again.deltaResult.recordsApplied).toBe(0);
    expect(host.paths()).toEqual(['/data/delta/index.txt']);
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax + 300 });
  });

  it('builds a sort index the loaded store lacks before anything else, a run that then fails included', async () => {
    const handle = await probe.raw();
    handle.exec('DROP INDEX products_unique_scans_n_sort');
    expect(sortIndexes(handle)).not.toContain('products_unique_scans_n_sort');
    host.statuses.set('/data/delta/index.txt', 503);
    const atRequest: string[][] = [];
    host.onRequest = () => atRequest.push(sortIndexes(handle));

    await expect(sync('refresh')).rejects.toMatchObject({ data: { reason: 'upstream_status' } });

    // Built before the run's first upstream request, not on its way out.
    expect(atRequest).toEqual([SORT_INDEXES]);
    expect(sortIndexes(handle)).toEqual(SORT_INDEXES);
  });

  it('stops on a non-2xx index with the checkpoint unchanged', async () => {
    host.addDelta(exportMax - 50, exportMax + 100, [{ code: 'P00007', name: 'v1' }]);
    host.statuses.set('/data/delta/index.txt', 429);
    const before = (await probe.readState()).checkpoint;

    await expect(sync('refresh')).rejects.toMatchObject({
      data: { reason: 'upstream_status', status: 429 },
    });

    expect((await probe.readState()).checkpoint).toBe(before);
    expect(host.paths()).toEqual(['/data/delta/index.txt']);
    expect(await isMirrorReady(probe)).toBe(true);
  });

  it('stops at a failing delta, keeping the deltas before it and requesting none after', async () => {
    const first = host.addDelta(exportMax - 50, exportMax + 100, [{ code: 'P00007', name: 'v1' }]);
    const failing = host.addDelta(exportMax + 100, exportMax + 200, [
      { code: 'P00007', name: 'v2' },
    ]);
    const after = host.addDelta(exportMax + 200, exportMax + 300, [{ code: 'P00007', name: 'v3' }]);
    host.statuses.set(`/data/delta/${failing}`, 503);

    await expect(sync('refresh')).rejects.toMatchObject({
      data: { reason: 'upstream_status', status: 503 },
    });

    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax + 100 });
    expect(await doc('P00007')).toMatchObject({ product_name: 'v1' });
    expect(host.paths()).toContain(`/data/delta/${first}`);
    expect(host.paths()).not.toContain(`/data/delta/${after}`);
    expect((await probe.readState()).status).toBe('error');
    expect(await isMirrorReady(probe)).toBe(true);
  });

  it('re-applies whole a delta whose body failed part way, its checkpoint left before it', async () => {
    const lines = products(2_500, exportMax + 1, 'D');
    const name = host.addDelta(exportMax - 50, exportMax + 3_000, lines);
    // The gzip stream stops short, after the delta's first 2,000-record page has applied.
    const whole = jsonl(lines);
    host.deltas.set(name, whole.subarray(0, Math.floor(whole.length * 0.9)));

    await expect(sync('refresh')).rejects.toMatchObject({ code: 'Z_BUF_ERROR' });
    expect(await codes()).toHaveLength(2_100);
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax });

    host.deltas.set(name, whole);
    const report = await sync('refresh');

    expect(report.deltasApplied).toEqual([name]);
    expect(await codes()).toHaveLength(2_600);
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax + 3_000 });
  });

  it('skips a malformed delta line, counting it, and moves the checkpoint past the delta', async () => {
    const name = host.addDelta(exportMax - 50, exportMax + 100, []);
    host.deltas.set(
      name,
      gzipSync(
        [
          JSON.stringify({ code: 'P00007', name: 'v1' }),
          '{"code":"BAD",',
          JSON.stringify({ code: 'NEW01', name: 'new' }),
        ].join('\n'),
      ),
    );
    const { lines, log, warnings } = capture();

    const report = await sync('refresh', fakeBuilder(), undefined, log);

    expect(report.deltasApplied).toEqual([name]);
    expect(report.skippedDeltaLines).toBe(1);
    expect(await doc('P00007')).toMatchObject({ product_name: 'v1' });
    expect(await doc('NEW01')).toMatchObject({ product_name: 'new' });
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax + 100 });
    expect(warnings()).toEqual([
      {
        level: 'warning',
        message: 'Skipped a feed line that is not valid JSON.',
        meta: { feed: name, line: 2, reason: 'upstream_line_malformed' },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('BAD');
  });

  it('reloads after 30 days, removing products the new export lacks and their postings', async () => {
    const handle = await probe.raw();
    handle
      .prepare('UPDATE mirror_load SET loaded_at = ?')
      .run(new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString());
    // A row past the sweep's first rowid window, where most of a full-size store sits.
    handle
      .prepare(
        "INSERT INTO products(rowid, code, generation, record_version, tag_ids, doc) VALUES (120000, 'FAR', 1, 1, '[1]', '{}')",
      )
      .run();
    const kept = products(100).filter((line) => line.code !== 'P00042');
    host.exportBody = jsonl([...kept, { code: 'ADDED', name: 'added', t: 1_793_000_500 }]);
    host.etag = '"e2"';

    const report = await sync('refresh');

    expect(report.fullLoad).toMatchObject({ reason: 'age', generation: 2 });
    const stored = await codes();
    expect(stored).toHaveLength(100);
    expect(stored).not.toContain('P00042');
    expect(stored).not.toContain('FAR');
    expect(stored).toContain('ADDED');
    const orphans = handle
      .prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM product_tags WHERE code IN ('P00042', 'FAR')",
      )
      .get();
    expect(orphans?.n).toBe(0);
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: 1_793_000_500 });
    expect(readMirrorLoad(handle)).toMatchObject({ generation: 2 });
    const stale = handle
      .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM products WHERE generation < 2')
      .get();
    expect(stale?.n).toBe(0);
  });

  it('reloads once the last full load is 30 days old, and not a millisecond sooner', async () => {
    const day = 24 * 3600 * 1000;
    const loadedAt = Date.parse('2026-10-01T00:00:00.000Z');
    const handle = await probe.raw();
    handle.prepare('UPDATE mirror_load SET loaded_at = ?').run(new Date(loadedAt).toISOString());
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(loadedAt + 30 * day - 1);
    expect((await sync('refresh')).fullLoad).toBeUndefined();
    expect(readMirrorLoad(handle)).toMatchObject({ generation: 1 });

    vi.setSystemTime(loadedAt + 30 * day);
    host.etag = '"e2"';
    expect((await sync('refresh')).fullLoad).toMatchObject({ reason: 'age', generation: 2 });
    expect(readMirrorLoad(handle)).toEqual({
      generation: 2,
      loadedAt: '2026-10-31T00:00:00.000Z',
      recordVersion: 1,
      etag: '"e2"',
      skippedLines: 0,
    });
  });

  it('skips the 30-day reload while the export is unchanged, still applying the deltas, and runs it once the export changes', async () => {
    const day = 24 * 3600 * 1000;
    const loadedAt = '2026-10-01T00:00:00.000Z';
    const handle = await probe.raw();
    handle.prepare('UPDATE mirror_load SET loaded_at = ?').run(loadedAt);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(loadedAt) + 30 * day);
    const delta = host.addDelta(exportMax - 50, exportMax + 100, [{ code: 'P00007', name: 'v1' }]);
    const { log, warnings } = capture();

    const skipped = await sync('refresh', fakeBuilder(), undefined, log);

    expect(skipped.fullLoad).toBeUndefined();
    expect(skipped.reloadSkipped).toBe('age');
    expect(skipped.deltasApplied).toEqual([delta]);
    expect(host.calls()).toEqual([...INDEX_AND_ETAG_CHECK, `GET /data/delta/${delta}`]);
    expect(await doc('P00007')).toMatchObject({ product_name: 'v1' });
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax + 100 });
    expect(readMirrorLoad(handle)).toMatchObject({ generation: 1, loadedAt, etag: '"e1"' });
    expect(warnings()).toEqual([
      {
        level: 'warning',
        message:
          'The last full load is 30 days old, but the export is unchanged since that load, so reloading it would change nothing; the reload is skipped and the mirror keeps serving.',
        meta: { reason: 'age', etag: '"e1"', loadedAt },
      },
    ]);

    host.etag = '"e2"';
    host.requests = [];
    const reloaded = await sync('refresh');

    expect(reloaded.fullLoad).toMatchObject({ reason: 'age', generation: 2 });
    expect(reloaded.reloadSkipped).toBeUndefined();
    expect(host.calls().slice(0, 5)).toEqual([
      ...INDEX_AND_ETAG_CHECK,
      'GET /data/openfoodfacts-products.jsonl.gz',
      'GET /s3/openfoodfacts-products.jsonl.gz',
    ]);
    expect(readMirrorLoad(handle)).toMatchObject({ generation: 2, etag: '"e2"' });
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: exportMax + 100 });
  });

  it('stops a reload whose download answers non-2xx after the ETag check found the export changed', async () => {
    const handle = await probe.raw();
    handle.prepare('UPDATE mirror_load SET loaded_at = ?').run('2000-01-01T00:00:00.000Z');
    host.etag = '"e2"';
    host.answerExport = (res, _from, req) => {
      if (req.method !== 'GET') return false;
      res.writeHead(503).end('refused');
      return true;
    };

    await expect(sync('refresh')).rejects.toMatchObject({
      data: { reason: 'upstream_status', status: 503 },
    });

    expect(host.calls()).toEqual([
      ...INDEX_AND_ETAG_CHECK,
      'GET /data/openfoodfacts-products.jsonl.gz',
      'GET /s3/openfoodfacts-products.jsonl.gz',
    ]);
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax });
    expect(await codes()).toHaveLength(100);
    expect(await isMirrorReady(probe)).toBe(true);
  });

  it('resumes an interrupted sweep from its rowid cursor, skipping no stale row and reading no export line again', async () => {
    const handle = await probe.raw();
    handle.prepare('UPDATE mirror_load SET loaded_at = ?').run('2000-01-01T00:00:00.000Z');
    // Rows only the first export listed, across three 50,000-rowid sweep windows, two of them on a
    // window's last rowid.
    const stale: [string, number][] = [
      ['STALE_A', 50_000],
      ['STALE_B', 50_001],
      ['TRIP', 60_000],
      ['STALE_C', 100_000],
      ['STALE_D', 100_001],
      ['STALE_E', 140_000],
    ];
    const insert = handle.prepare(
      "INSERT INTO products(rowid, code, generation, record_version, tag_ids, doc) VALUES (?, ?, 1, 1, '[1]', '{}')",
    );
    for (const [code, rowid] of stale) insert.run(rowid, code);
    // Deleting TRIP fails the second window's batch, ending the run between two sweep pages as a
    // crash would.
    handle.exec(
      "CREATE TRIGGER trip BEFORE DELETE ON products WHEN old.code = 'TRIP' BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
    );
    const kept = products(100)
      .filter((line) => line.code !== 'P00042')
      .map((line) => line.code as string);
    host.exportBody = jsonl(products(100).filter((line) => line.code !== 'P00042'));
    host.etag = '"e2"';

    await expect(sync('refresh')).rejects.toThrow('interrupted');

    expect(parseExportCursor((await probe.readState()).cursor)).toMatchObject({
      phase: 'sweep',
      generation: 2,
      rowid: 50_000,
    });
    // The first window is swept; the rest are not.
    expect(await codes()).toEqual(
      [...kept, 'STALE_B', 'TRIP', 'STALE_C', 'STALE_D', 'STALE_E'].sort(),
    );
    expect(existsSync(`${path}.export.jsonl.gz`)).toBe(false);

    handle.exec('DROP TRIGGER trip');
    host.requests = [];
    const built: string[] = [];
    const report = await sync(
      'refresh',
      fakeBuilder(1, (code) => built.push(code)),
    );

    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 2 });
    expect(report.fullLoad?.result.tombstonesApplied).toBe(5);
    expect(built).toEqual([]);
    expect(host.paths()).toEqual(['/data/delta/index.txt']);
    expect(await codes()).toEqual([...kept].sort());
    const orphans = handle
      .prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM product_tags WHERE code LIKE 'STALE%' OR code = 'TRIP'",
      )
      .get();
    expect(orphans?.n).toBe(0);
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: exportMax });
    expect(readMirrorLoad(handle)).toMatchObject({ generation: 2 });
  });

  it('keeps serving the previous as-of time while a reload runs', async () => {
    const before = (await probe.readState()).checkpoint;
    const handle = await probe.raw();
    handle.prepare('UPDATE mirror_load SET loaded_at = ?').run('2000-01-01T00:00:00.000Z');
    host.exportBody = jsonl(products(100, 1_793_100_000));
    host.etag = '"e2"';
    const seen: (string | undefined)[] = [];
    // A second connection, as the serving process holds; the builder samples it mid-ingest.
    const watcher = openMirrorStore(path);
    const watcherHandle = await watcher.raw();
    const read = () =>
      watcherHandle
        .prepare<{ checkpoint: string | null }>('SELECT checkpoint FROM mirror_sync_state')
        .get()?.checkpoint ?? undefined;
    const builder = fakeBuilder(1, (code) => {
      if (code === 'P00050') seen.push(read());
    });

    await sync('refresh', builder);
    await watcher.close();

    expect(seen).toEqual([before]);
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: 1_793_100_099 });
  });

  it('sweeps both earlier exports when an interrupted reload resumes under a changed export', async () => {
    const handle = await probe.raw();
    handle.prepare('UPDATE mirror_load SET loaded_at = ?').run('2000-01-01T00:00:00.000Z');
    host.exportBody = jsonl(products(4_500, 1_793_100_000, 'OLD'));
    host.etag = '"e2"';
    await interruptedIngest('refresh', 'OLD02500');
    expect(parseExportCursor((await probe.readState()).cursor)).toMatchObject({
      generation: 2,
      phase: 'ingest',
      line: 2_000,
    });
    expect(await codes()).toHaveLength(2_100);
    await truncate(`${path}.export.jsonl.gz`, 100);
    host.exportBody = jsonl(products(1_000, 1_793_200_000, 'NEW'));
    host.etag = '"e3"';

    const report = await sync('refresh');

    const stored = await codes();
    expect(stored).toHaveLength(1_000);
    expect(stored.every((code) => code.startsWith('NEW'))).toBe(true);
    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 3 });
    expect(readMirrorLoad(handle)).toMatchObject({ generation: 3 });
    expect(await checkpoint()).toEqual({ generation: 3, asOfSeconds: 1_793_200_999 });
  });

  it('stops a reload whose export answers non-2xx, keeping the checkpoint and the loaded products', async () => {
    const handle = await probe.raw();
    handle.prepare('UPDATE mirror_load SET loaded_at = ?').run('2000-01-01T00:00:00.000Z');
    host.statuses.set('/data/openfoodfacts-products.jsonl.gz', 503);

    await expect(sync('refresh')).rejects.toMatchObject({
      data: { reason: 'upstream_status', status: 503 },
    });

    expect(host.paths()).toEqual([
      '/data/delta/index.txt',
      '/data/openfoodfacts-products.jsonl.gz',
    ]);
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax });
    expect(await codes()).toHaveLength(100);
    expect(await isMirrorReady(probe)).toBe(true);
  });

  it('moves the checkpoint back to a reloaded export older than the applied deltas, then re-applies them', async () => {
    const delta = host.addDelta(exportMax - 50, exportMax + 1_000, [
      { code: 'P00007', name: 'edited', t: exportMax + 900 },
    ]);
    await sync('refresh');
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax + 1_000 });
    const handle = await probe.raw();
    handle
      .prepare('UPDATE mirror_load SET loaded_at = ?')
      .run(new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString());
    // The new export predates the delta's edit, so its as-of is older than the checkpoint.
    host.etag = '"e2"';
    host.requests = [];

    const report = await sync('refresh');

    expect(report.fullLoad).toMatchObject({ reason: 'age', generation: 2 });
    expect(report.deltasApplied).toEqual([delta]);
    expect(await doc('P00007')).toMatchObject({ product_name: 'edited' });
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: exportMax + 1_000 });
  });

  it('reloads for a newer record builder whatever the export, even when the load is also 30 days old', async () => {
    const handle = await probe.raw();
    handle.prepare('UPDATE mirror_load SET loaded_at = ?').run('2000-01-01T00:00:00.000Z');

    const report = await sync('refresh', fakeBuilder(2));

    expect(report.fullLoad).toMatchObject({ reason: 'record_version', generation: 2 });
    expect(report.reloadSkipped).toBeUndefined();
    expect(host.requests.filter((r) => r.method === 'HEAD')).toEqual([]);
    expect(readMirrorLoad(handle)).toMatchObject({ recordVersion: 2, etag: '"e1"' });
  });

  it('reloads when the record builder is newer than the last full load', async () => {
    const report = await sync('refresh', fakeBuilder(2));

    expect(report.fullLoad).toMatchObject({ reason: 'record_version', generation: 2 });
    const handle = await probe.raw();
    const versions = handle
      .prepare<{ record_version: number; n: number }>(
        'SELECT record_version, COUNT(*) AS n FROM products GROUP BY record_version',
      )
      .all();
    expect(versions).toEqual([{ record_version: 2, n: 100 }]);
    expect(await doc('P00003')).toMatchObject({ version: 2 });
    expect(readMirrorLoad(handle)).toMatchObject({ recordVersion: 2 });
  });

  it('reloads when the checkpoint predates the oldest listed delta and the export changed since the last load', async () => {
    host.addDelta(exportMax + 100, exportMax + 200, [{ code: 'P00007', name: 'later' }]);
    host.etag = '"e2"';

    const report = await sync('refresh');

    expect(report.fullLoad).toMatchObject({ reason: 'gap', generation: 2 });
    expect(host.paths().filter((p) => p === '/data/delta/index.txt')).toHaveLength(2);
    // The reloaded export still predates the delta, so it stays unapplied until a later reload.
    expect(report.deltasApplied).toEqual([]);
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: exportMax });
  });

  it('reloads an export older than the oldest delta once, then only checks its ETag while it stays unchanged', async () => {
    host.addDelta(exportMax + 100, exportMax + 200, [{ code: 'P00007', name: 'later' }]);
    // Regenerated once since the init, and still older than every listed delta.
    host.etag = '"e2"';
    const first = await sync('refresh');
    expect(first.fullLoad).toMatchObject({ reason: 'gap', generation: 2 });
    const handle = await probe.raw();
    const asOf = await mirrorAsOf(probe);
    const { log, warnings } = capture();
    host.requests = [];

    const second = await sync('refresh', fakeBuilder(), undefined, log);

    expect(host.calls()).toEqual(INDEX_AND_ETAG_CHECK);
    expect(second.fullLoad).toBeUndefined();
    expect(second.reloadSkipped).toBe('gap');
    expect(second.deltasApplied).toEqual([]);
    for (const request of host.requests) expect(request.headers['user-agent']).toBe(USER_AGENT);
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: exportMax });
    expect(await mirrorAsOf(probe)).toBe(asOf);
    expect(readMirrorLoad(handle)).toMatchObject({ generation: 2, etag: '"e2"' });
    expect(await isMirrorReady(probe)).toBe(true);
    expect(warnings()).toEqual([
      {
        level: 'warning',
        message:
          'The listed deltas no longer reach back to the mirror’s checkpoint, but the export is unchanged since the last full load, so reloading it would leave the gap in place; the reload is skipped and the mirror keeps serving.',
        meta: {
          reason: 'gap',
          etag: '"e2"',
          loadedAt: readMirrorLoad(handle)?.loadedAt,
          asOf: new Date(exportMax * 1000).toISOString(),
        },
      },
    ]);
  });

  it('applies the deltas before a gap the unchanged export cannot bridge, and none past it', async () => {
    const before = host.addDelta(exportMax - 50, exportMax + 100, [{ code: 'P00007', name: 'v1' }]);
    // The day between exportMax + 100 and exportMax + 200 is in no listed file.
    host.addDelta(exportMax + 200, exportMax + 300, [{ code: 'P00007', name: 'v3' }]);
    const firstRun = capture();

    const first = await sync('refresh', fakeBuilder(), undefined, firstRun.log);

    expect(first.fullLoad).toBeUndefined();
    expect(first.reloadSkipped).toBe('gap');
    expect(first.deltasApplied).toEqual([before]);
    expect(host.calls()).toEqual([...INDEX_AND_ETAG_CHECK, `GET /data/delta/${before}`]);
    expect(await doc('P00007')).toMatchObject({ product_name: 'v1' });
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax + 100 });
    expect(firstRun.warnings().map((line) => line.meta?.reason)).toEqual(['gap']);

    const secondRun = capture();
    host.requests = [];
    const again = await sync('refresh', fakeBuilder(), undefined, secondRun.log);

    expect(again.reloadSkipped).toBe('gap');
    expect(again.deltasApplied).toEqual([]);
    expect(host.calls()).toEqual(INDEX_AND_ETAG_CHECK);
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax + 100 });
    expect(secondRun.warnings().map((line) => line.meta?.reason)).toEqual(['gap']);
  });

  it('reloads on a gap as before when the last load recorded no ETag, sending no ETag check', async () => {
    // A store whose load row predates the ETag column: migration 2 adds it empty.
    const handle = await probe.raw();
    handle.exec('ALTER TABLE mirror_load DROP COLUMN etag');
    handle.exec('ALTER TABLE mirror_load DROP COLUMN skipped_lines');
    handle.prepare('UPDATE schema_version SET version = 1').run();
    await probe.close();
    probe = openMirrorStore(path);
    expect(readMirrorLoad(await probe.raw())).toEqual({
      generation: 1,
      loadedAt: expect.any(String),
      recordVersion: 1,
      skippedLines: 0,
    });
    host.addDelta(exportMax + 100, exportMax + 200, [{ code: 'P00007', name: 'later' }]);

    const report = await sync('refresh');

    expect(report.fullLoad).toMatchObject({ reason: 'gap', generation: 2 });
    expect(host.requests.filter((r) => r.method === 'HEAD')).toEqual([]);
    expect(host.calls().slice(0, 3)).toEqual([
      'GET /data/delta/index.txt',
      'GET /data/openfoodfacts-products.jsonl.gz',
      'GET /s3/openfoodfacts-products.jsonl.gz',
    ]);
    expect(readMirrorLoad(await probe.raw())).toMatchObject({ generation: 2, etag: '"e1"' });
  });

  describe('a reload whose export stamps no product', () => {
    const download = () => `${path}.export.jsonl.gz`;
    let before: {
      asOf: string | undefined;
      checkpoint: string | undefined;
      codes: string[];
      load: ReturnType<typeof readMirrorLoad>;
    };

    /** A delta past the export moves the checkpoint, then the last load is aged under a new ETag. */
    beforeEach(async () => {
      host.addDelta(exportMax - 50, exportMax + 1_000, [
        { code: 'P00007', name: 'edited', t: exportMax + 900 },
      ]);
      await sync('refresh');
      const handle = await probe.raw();
      handle.prepare('UPDATE mirror_load SET loaded_at = ?').run('2000-01-01T00:00:00.000Z');
      host.etag = '"e2"';
      host.requests = [];
      before = {
        asOf: await mirrorAsOf(probe),
        checkpoint: (await probe.readState()).checkpoint,
        codes: await codes(),
        load: readMirrorLoad(handle),
      };
      expect(before.codes).toHaveLength(100);
      expect(decodeCheckpoint(before.checkpoint as string)).toEqual({
        generation: 1,
        asOfSeconds: exportMax + 1_000,
      });
    });

    /** The store as the reload found it: rows, last full load, checkpoint, and readiness. */
    async function expectUnchanged(): Promise<void> {
      expect(await codes()).toEqual(before.codes);
      expect(readMirrorLoad(await probe.raw())).toEqual(before.load);
      expect((await probe.readState()).checkpoint).toBe(before.checkpoint);
      expect(await mirrorAsOf(probe)).toBe(before.asOf);
      expect(await isMirrorReady(probe)).toBe(true);
      expect(await doc('P00007')).toMatchObject({ product_name: 'edited' });
    }

    /** One line past 16 MiB, built on demand. */
    const oversize = () => JSON.stringify({ code: 'HUGE', name: 'x'.repeat(16 * 1024 * 1024) });

    it.each<[string, () => FakeHost['exportBody']]>([
      ['an empty gzip', () => gzipSync('')],
      ['blank lines only', () => gzipSync('\n\r\n\n')],
      ['every line malformed', () => gzipSync(['{', '{"code":', 'not json'].join('\n'))],
      ['every line past 16 MiB', () => gzipSync([oversize(), oversize()].join('\n'))],
      [
        'JSON lines without a usable code',
        () =>
          gzipSync(['{}', '[]', '1', '"P00001"', '{"name":"no code"}', '{"code":7}'].join('\n')),
      ],
    ])(
      'is refused before its sweep for %s, leaving the store as it was and deleting the download',
      async (_label, body) => {
        host.exportBody = body();

        await expect(sync('refresh')).rejects.toMatchObject({
          message: expect.stringContaining('built no product'),
          data: { reason: 'export_no_products' },
        });

        await expectUnchanged();
        expect(existsSync(download())).toBe(false);
        const state = await probe.readState();
        expect(state.status).toBe('error');
        expect(parseExportCursor(state.cursor)).toMatchObject({
          phase: 'download',
          generation: 2,
          etag: '"e2"',
        });
      },
    );

    it('downloads a refused export again on the next refresh, refused again while unchanged and loaded once it lists products', async () => {
      host.exportBody = gzipSync('{\n{');
      await expect(sync('refresh')).rejects.toMatchObject({
        data: { reason: 'export_no_products' },
      });
      host.requests = [];

      await expect(sync('refresh')).rejects.toMatchObject({
        data: { reason: 'export_no_products' },
      });

      expect(host.calls()).toEqual([
        'GET /data/openfoodfacts-products.jsonl.gz',
        'GET /s3/openfoodfacts-products.jsonl.gz',
      ]);
      expect(host.requests.at(-1)?.headers.range).toBeUndefined();
      await expectUnchanged();

      const listed = products(50, 1_793_100_000, 'NEW');
      host.exportBody = jsonl(listed);
      host.etag = '"e3"';
      const report = await sync('refresh');

      expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 3 });
      expect(await codes()).toEqual(listed.map((line) => line.code));
      expect(readMirrorLoad(await probe.raw())).toMatchObject({ generation: 3, etag: '"e3"' });
      expect(await checkpoint()).toEqual({ generation: 3, asOfSeconds: 1_793_100_049 });
    });

    it('is refused on resuming a sweep a 0.4.2 build persisted for a load that stamped no product', async () => {
      // A 0.4.2 build persisted the sweep cursor with the last ingest page, then was stopped.
      (await probe.raw()).prepare("UPDATE mirror_sync_state SET status = 'error', cursor = ?").run(
        JSON.stringify({
          v: 1,
          generation: 2,
          phase: 'sweep',
          line: 2,
          maxModifiedT: 0,
          rowid: 0,
          skipped: 2,
          etag: '"e2"',
          totalBytes: 40,
        }),
      );

      await expect(sync('refresh')).rejects.toMatchObject({
        data: { reason: 'export_no_products' },
      });

      expect(host.requests).toEqual([]);
      await expectUnchanged();
      expect(parseExportCursor((await probe.readState()).cursor)).toMatchObject({
        phase: 'download',
        generation: 2,
      });
    });

    it('completes a resumed reload whose earlier run stamped its products, from a cursor as 0.4.2 wrote it', async () => {
      const listed = products(2_000, 1_793_100_000, 'NEW');
      host.exportBody = gzipSync(
        [...listed.map((line) => JSON.stringify(line)), ...Array<string>(50).fill('{')].join('\n'),
      );
      const controller = new AbortController();
      // The first line skipped after the full first page stops the run, as a SIGTERM would.
      const stopOnSkip: MirrorLogger = {
        warning: () => controller.abort(new Error('interrupted')),
      };
      await expect(sync('refresh', fakeBuilder(), controller.signal, stopOnSkip)).rejects.toThrow(
        'interrupted',
      );
      const written = parseExportCursor((await probe.readState()).cursor);
      expect(written).toMatchObject({ phase: 'ingest', generation: 2, line: 2_000, skipped: 0 });
      expect((await codes()).filter((code) => code.startsWith('NEW'))).toHaveLength(2_000);
      // Every field the published 0.4.2 build serialized, and nothing else.
      (await probe.raw()).prepare('UPDATE mirror_sync_state SET cursor = ?').run(
        JSON.stringify({
          v: 1,
          generation: 2,
          phase: 'ingest',
          line: 2_000,
          maxModifiedT: 1_793_101_999,
          rowid: 0,
          skipped: 0,
          etag: '"e2"',
          totalBytes: written?.totalBytes,
        }),
      );

      const built: string[] = [];
      const report = await sync(
        'refresh',
        fakeBuilder(1, (code) => built.push(code)),
      );

      expect(built).toEqual([]);
      expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 2, skippedLines: 50 });
      expect(await codes()).toEqual(listed.map((line) => line.code));
      expect(readMirrorLoad(await probe.raw())).toMatchObject({
        generation: 2,
        etag: '"e2"',
        skippedLines: 50,
      });
      expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: 1_793_101_999 });
    });

    it('completes a reload whose export stamps one product, sweeping every other row', async () => {
      host.exportBody = gzipSync(
        ['{', JSON.stringify({ code: 'ONLY', name: 'only', t: 1_793_100_000 }), ''].join('\n'),
      );

      const report = await sync('refresh');

      expect(report.fullLoad).toMatchObject({ reason: 'age', generation: 2, skippedLines: 1 });
      expect(report.fullLoad?.result.tombstonesApplied).toBe(100);
      expect(await codes()).toEqual(['ONLY']);
      expect(await isMirrorReady(probe)).toBe(true);
      expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: 1_793_100_000 });
    });

    it('completes a reload whose one stamped product sits past the first 50,000-rowid window', async () => {
      const handle = await probe.raw();
      // A row at rowid 60,000 puts the next insert, the one product stamped, in the second window.
      handle
        .prepare(
          "INSERT INTO products (rowid, code, generation, record_version, tag_ids, doc) VALUES (60000, 'FILLER', 1, 1, '[]', '{}')",
        )
        .run();
      host.exportBody = gzipSync(
        ['{', JSON.stringify({ code: 'ONLY', name: 'only', t: 1_793_100_000 }), ''].join('\n'),
      );

      const report = await sync('refresh');

      expect(report.fullLoad).toMatchObject({ reason: 'age', generation: 2, skippedLines: 1 });
      expect(report.fullLoad?.result.tombstonesApplied).toBe(101);
      expect(await codes()).toEqual(['ONLY']);
      expect(
        handle.prepare<{ id: number }>("SELECT rowid AS id FROM products WHERE code = 'ONLY'").get()
          ?.id,
      ).toBeGreaterThan(50_000);
      expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: 1_793_100_000 });
    });

    it.each<[string, string, (res: ServerResponse) => void]>([
      [
        'a zero-length body',
        'export_unresumable',
        (res) => res.writeHead(200, { etag: '"e2"', 'content-length': 0 }).end(),
      ],
      [
        'a gzip cut short',
        'export_corrupt',
        (res) => {
          const cut = jsonl(products(100)).subarray(0, 30);
          res.writeHead(200, { etag: '"e2"', 'content-length': cut.length }).end(cut);
        },
      ],
    ])(
      'stops on %s as %s, as before, leaving the store as it was',
      async (_label, reason, answer) => {
        host.answerExport = (res, _from, req) => {
          if (req.method !== 'GET') return false;
          answer(res);
          return true;
        };

        await expect(sync('refresh')).rejects.toMatchObject({ data: { reason } });

        await expectUnchanged();
      },
    );
  });

  describe('a run and its sync lease', () => {
    const download = () => `${path}.export.jsonl.gz`;
    const reloadedMax = 1_793_100_000 + 2_999;

    /**
     * Starts a reload whose export download stalls after its first 30,000 bytes, with the lock's
     * heartbeat on a fake interval, and returns once those bytes are on disk. `ended` resolves with
     * the run's report, or with the error it rejects with.
     */
    async function stalledReload(): Promise<{ ended: Promise<unknown> }> {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      (await probe.raw())
        .prepare('UPDATE mirror_load SET loaded_at = ?')
        .run('2000-01-01T00:00:00.000Z');
      host.exportBody = jsonl(noisy(products(3_000, 1_793_100_000)));
      host.etag = '"e2"';
      host.holdAfterBytes = 30_000;
      const ended = sync('refresh').then(
        (report) => report,
        (err: unknown) => err,
      );
      await settle(() => existsSync(download()) && statSync(download()).size === 30_000);
      return { ended };
    }

    /**
     * Ages the stalled holder's heartbeat past the TTL, as a process stopped that long leaves it,
     * then lets a second run reclaim the lease and complete the reload. Returns its sync state.
     */
    async function reclaimAndComplete() {
      (await probe.raw()).prepare('UPDATE mirror_sync_lock SET heartbeat_at = 0').run();
      const report = await sync('refresh');
      expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 2 });
      const state = await probe.readState();
      expect(state.status).toBe('complete');
      expect(state.cursor).toBeUndefined();
      expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: reloadedMax });
      return state;
    }

    /** The next refresh finds the completed reload, so it loads nothing and requests only the index. */
    async function expectNothingToReload(): Promise<void> {
      host.requests = [];
      const next = await sync('refresh');
      expect(next.fullLoad).toBeUndefined();
      expect(host.paths()).toEqual(['/data/delta/index.txt']);
      expect(await codes()).toHaveLength(3_000);
    }

    it('records its own failure, with its cursor and checkpoint, while it keeps the lease', async () => {
      const before = await probe.readState();
      const { ended } = await stalledReload();
      // A heartbeat that renews: the lease is still this run's when its download fails.
      vi.advanceTimersByTime(30_000);
      host.held?.destroy();
      const error = await ended;

      expect(error).toBeInstanceOf(Error);
      const state = await probe.readState();
      expect(state).toMatchObject({
        status: 'error',
        error: (error as Error).message,
        completedAt: before.completedAt,
      });
      expect(parseExportCursor(state.cursor)).toMatchObject({
        phase: 'download',
        etag: '"e2"',
        generation: 2,
      });
      expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: exportMax });

      host.requests = [];
      const resumed = await sync('refresh');
      expect(resumed.fullLoad).toMatchObject({ reason: 'resume', generation: 2 });
      expect(host.requests.find((r) => r.path.startsWith('/s3/'))?.headers.range).toBe(
        'bytes=30000-',
      );
    });

    it('records nothing once its heartbeat finds the lease reclaimed, leaving the completed reload as it stands', async () => {
      const { ended } = await stalledReload();
      const completed = await reclaimAndComplete();

      vi.advanceTimersByTime(30_000);
      const error = await ended;

      expect(await probe.readState()).toEqual(completed);
      expect(error).toMatchObject({ data: { reason: 'mirror_lock_lost' } });
      await expectNothingToReload();
    });

    it('applies no page once the lease is reclaimed mid-ingest, before its heartbeat has run', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const handle = await probe.raw();
      handle.prepare('UPDATE mirror_load SET loaded_at = ?').run('2000-01-01T00:00:00.000Z');
      host.exportBody = jsonl(products(4_500, 1_793_100_000, 'NEW'));
      host.etag = '"e2"';
      // Another run takes the lease while this one builds its second page.
      const builder = fakeBuilder(1, (code) => {
        if (code !== 'NEW02500') return;
        handle
          .prepare("UPDATE mirror_sync_lock SET holder = 'other', pid = 1, host = 'other-host'")
          .run();
      });

      const error = await sync('refresh', builder).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(error).toMatchObject({ data: { reason: 'mirror_lock_lost' } });
      const loaded = (await codes()).filter((code) => code.startsWith('NEW'));
      expect(loaded).toHaveLength(2_000);
      expect(loaded.at(-1)).toBe('NEW01999');
    });

    it('records nothing when its own run fails after the reclaim, before its heartbeat has run', async () => {
      const { ended } = await stalledReload();
      const completed = await reclaimAndComplete();

      host.held?.destroy();
      const error = await ended;

      expect(await probe.readState()).toEqual(completed);
      expect(error).toMatchObject({ data: { reason: 'mirror_lock_lost' } });
      await expectNothingToReload();
    });
  });
});

describe('the as-of a reload cites', () => {
  const T0 = 1_793_000_000;
  /** The export's newest change: line i changed at T0 + i, over ingest pages of 2,000, 2,000, and 500. */
  const T = T0 + 4_499;
  /** The end of the delta applied after the export, which edits P00010, a product of the first page. */
  const D = T + 1_000;
  const LISTED = products(4_500, T0).map((line) => line.code as string);
  let delta: string;

  beforeEach(async () => {
    host.exportBody = jsonl(products(4_500, T0));
    delta = host.addDelta(T - 50, D, [{ code: 'P00010', name: 'edited', t: T + 900 }]);
    await sync('init');
    expect(await checkpoint()).toEqual({ generation: 1, asOfSeconds: D });
    expect(await doc('P00010')).toMatchObject({ product_name: 'edited' });
    host.requests = [];
  });

  /** Makes the next refresh reload the export: the last load 30 days old, the export's ETag changed. */
  async function reloadDue(
    body: FakeHost['exportBody'] = jsonl(products(4_500, T0)),
  ): Promise<void> {
    (await probe.raw())
      .prepare('UPDATE mirror_load SET loaded_at = ?')
      .run('2000-01-01T00:00:00.000Z');
    host.exportBody = body;
    host.etag = '"e2"';
  }

  interface RowWrite {
    checkpoint: string;
    completedAt: string | null;
    generation: number;
    t: number | null;
  }

  /**
   * Records, at every product row a sync inserts or updates, the sync state as the sync's own
   * connection has committed it then: what a reader of that row would be told.
   */
  async function recordRowWrites(): Promise<() => RowWrite[]> {
    const handle = await probe.raw();
    handle.exec(
      'CREATE TABLE row_writes (seq INTEGER PRIMARY KEY, generation INTEGER, t INTEGER, checkpoint TEXT, completed_at TEXT)',
    );
    for (const event of ['INSERT', 'UPDATE']) {
      handle.exec(`CREATE TRIGGER row_writes_${event.toLowerCase()} AFTER ${event} ON products BEGIN
        INSERT INTO row_writes(generation, t, checkpoint, completed_at)
          SELECT new.generation, new.last_modified_t, checkpoint, completed_at FROM mirror_sync_state;
      END`);
    }
    return () =>
      handle
        .prepare<RowWrite>(
          'SELECT generation, t, checkpoint, completed_at AS completedAt FROM row_writes ORDER BY seq',
        )
        .all();
  }

  /** The reload's 4,500 row writes under `generation`, in its three ingest pages. */
  function loadPages(writes: RowWrite[], generation: number): RowWrite[][] {
    const rows = writes.filter((write) => write.generation === generation).slice(0, 4_500);
    expect(rows).toHaveLength(4_500);
    return [rows.slice(0, 2_000), rows.slice(2_000, 4_000), rows.slice(4_000)];
  }

  /** Each page's distinct checkpoints, decoded, as its rows met them. */
  const asOfByPage = (pages: RowWrite[][]) =>
    pages.map((page) => [...new Set(page.map((write) => write.checkpoint))].map(decodeCheckpoint));

  /** The end of an uninterrupted reload of the export: every product restamped, the delta re-applied. */
  async function expectReloaded(): Promise<void> {
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: D });
    expect(await codes()).toEqual(LISTED);
    expect(await doc('P00010')).toMatchObject({ product_name: 'edited' });
    expect(await doc('P04499')).toMatchObject({ product_name: 'P4499' });
    expect(readMirrorLoad(await probe.raw())).toMatchObject({ generation: 2, etag: '"e2"' });
    expect(await stampedCount(2)).toBe(4_500);
  }

  it('keeps the store ready, as the last completed load left it, through every row a reload writes', async () => {
    await reloadDue();
    const writes = await recordRowWrites();
    const { completedAt } = await probe.readState();
    expect(completedAt).toBeDefined();

    await sync('refresh');

    const rows = loadPages(writes(), 2).flat();
    expect([...new Set(rows.map((write) => write.completedAt))]).toEqual([completedAt]);
  });

  it.each<[string, number, { generation: number; asOfSeconds: number }[][], number]>([
    [
      'an export older than the last delta lowers it to the newest change stamped, and raises it as later pages land',
      T0,
      [
        [{ generation: 2, asOfSeconds: T0 + 1_999 }],
        [{ generation: 2, asOfSeconds: T0 + 1_999 }],
        [{ generation: 2, asOfSeconds: T0 + 3_999 }],
      ],
      D,
    ],
    [
      'an export straddling the last delta lowers it for the older page, then raises it back no further than that delta',
      T0 + 3_000,
      [
        [{ generation: 2, asOfSeconds: T0 + 4_999 }],
        [{ generation: 2, asOfSeconds: T0 + 4_999 }],
        [{ generation: 2, asOfSeconds: D }],
      ],
      T0 + 7_499,
    ],
    [
      'an export newer than the last delta leaves it where the delta left it',
      T + 2_000,
      [
        [{ generation: 1, asOfSeconds: D }],
        [{ generation: 1, asOfSeconds: D }],
        [{ generation: 1, asOfSeconds: D }],
      ],
      T + 6_499,
    ],
  ])('%s', async (_label, start, expected, finalAsOf) => {
    await reloadDue(jsonl(products(4_500, start)));
    const writes = await recordRowWrites();

    await sync('refresh');

    const pages = loadPages(writes(), 2);
    expect(asOfByPage(pages)).toEqual(expected);
    // No row is written under an as-of past the newest change the reload has stamped with it.
    let newest = 0;
    for (const [i, page] of pages.entries()) {
      for (const write of page) newest = Math.max(newest, write.t ?? 0);
      for (const cited of asOfByPage(pages)[i] ?? []) {
        expect(cited.asOfSeconds).toBeLessThanOrEqual(newest);
      }
    }
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: finalAsOf });
  });

  it('cites no time newer than the export once the first page of an older one commits, the product it rewrote included', async () => {
    await reloadDue();
    // A second connection, as the serving process holds, read while the second page is built.
    const watcher = openMirrorStore(path);
    const watcherHandle = await watcher.raw();
    const seen: { asOf: string | undefined; product: unknown }[] = [];
    const builder = fakeBuilder(1, (code) => {
      if (code !== 'P02500') return;
      const state = watcherHandle
        .prepare<{ checkpoint: string }>('SELECT checkpoint FROM mirror_sync_state')
        .get();
      const row = watcherHandle
        .prepare<{ doc: string }>("SELECT doc FROM products WHERE code = 'P00010'")
        .get();
      seen.push({
        asOf:
          state && new Date(decodeCheckpoint(state.checkpoint).asOfSeconds * 1000).toISOString(),
        product: row && JSON.parse(row.doc).product_name,
      });
    });

    const report = await sync('refresh', builder);
    await watcher.close();

    expect(seen).toEqual([{ asOf: new Date((T0 + 1_999) * 1000).toISOString(), product: 'P10' }]);
    expect(report.deltasApplied).toEqual([delta]);
    expect(await mirrorAsOf(probe)).toBe(new Date(D * 1000).toISOString());
    await expectReloaded();
  });

  it('ends a reload stopped after its as-of was lowered, as SIGTERM stops it, where an uninterrupted one ends', async () => {
    await reloadDue();
    await interruptedIngest('refresh', 'P04100');

    const state = await probe.readState();
    expect(state.status).toBe('error');
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: T0 + 3_999 });
    expect(parseExportCursor(state.cursor)).toMatchObject({
      phase: 'ingest',
      generation: 2,
      line: 4_000,
    });
    expect(await isMirrorReady(probe)).toBe(true);
    expect(await doc('P00010')).toMatchObject({ product_name: 'P10' });

    const report = await sync('refresh');

    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 2 });
    expect(report.deltasApplied).toEqual([delta]);
    await expectReloaded();
  });

  it('ends a reload whose first page failed after the as-of lowered ahead of it committed where an uninterrupted one ends', async () => {
    await reloadDue();
    const handle = await probe.raw();
    handle.exec(
      "CREATE TRIGGER trip BEFORE UPDATE ON products WHEN new.code = 'P00100' AND new.generation = 2 BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
    );

    await expect(sync('refresh')).rejects.toThrow('interrupted');

    const state = await probe.readState();
    expect(state.status).toBe('error');
    // Lowered for the page that failed: still no newer than any row the export holds.
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: T0 + 1_999 });
    expect(parseExportCursor(state.cursor)).toMatchObject({
      phase: 'ingest',
      generation: 2,
      line: 0,
    });
    expect(await stampedCount(2)).toBe(0);
    expect(await isMirrorReady(probe)).toBe(true);

    handle.exec('DROP TRIGGER trip');
    const report = await sync('refresh');

    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 2 });
    expect(report.deltasApplied).toEqual([delta]);
    await expectReloaded();
  });

  it('cites no time newer than the rows an abandoned export stamped while the reload resumes under a changed export', async () => {
    await reloadDue();
    await interruptedIngest('refresh', 'P02500');
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: T0 + 1_999 });
    // A download cut short on disk sends the resume back to the host, which now serves a new export.
    await truncate(`${path}.export.jsonl.gz`, 100);
    const listed = products(1_000, T + 5_000, 'NEW');
    host.exportBody = jsonl(listed);
    host.etag = '"e3"';
    const writes = await recordRowWrites();

    const report = await sync('refresh');

    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 3 });
    const stamped = writes().filter((write) => write.generation === 3);
    expect(stamped).toHaveLength(1_000);
    expect([...new Set(stamped.map((write) => write.checkpoint))].map(decodeCheckpoint)).toEqual([
      { generation: 2, asOfSeconds: T0 + 1_999 },
    ]);
    expect(await checkpoint()).toEqual({ generation: 3, asOfSeconds: T + 5_999 });
    expect(await codes()).toEqual(listed.map((line) => line.code));
  });

  it('lowers the as-of under the new generation, ahead of its rows, when the changed export a reload resumes under is older', async () => {
    await reloadDue();
    await interruptedIngest('refresh', 'P02500');
    expect(await checkpoint()).toEqual({ generation: 2, asOfSeconds: T0 + 1_999 });
    await truncate(`${path}.export.jsonl.gz`, 100);
    const listed = products(1_000, T0 - 10_000, 'OLD');
    host.exportBody = jsonl(listed);
    host.etag = '"e3"';
    const writes = await recordRowWrites();

    const report = await sync('refresh');

    expect(report.fullLoad).toMatchObject({ reason: 'resume', generation: 3 });
    const stamped = writes().filter((write) => write.generation === 3);
    expect(stamped).toHaveLength(1_000);
    expect([...new Set(stamped.map((write) => write.checkpoint))].map(decodeCheckpoint)).toEqual([
      { generation: 3, asOfSeconds: T0 - 9_001 },
    ]);
    expect(await codes()).toEqual(listed.map((line) => line.code));
  });

  it('lowers the as-of before it reads on when it resumes an ingest a 0.4.2 build stopped', async () => {
    await reloadDue();
    await interruptedIngest('refresh', 'P02500');
    // As 0.4.2 left it: the first page at the export's version, under the delta's as-of.
    (await probe.raw())
      .prepare('UPDATE mirror_sync_state SET checkpoint = ?')
      .run(encodeCheckpoint({ generation: 1, asOfSeconds: D }));
    expect(await doc('P00010')).toMatchObject({ product_name: 'P10' });
    const watcher = openMirrorStore(path);
    const watcherHandle = await watcher.raw();
    const seen: (string | undefined)[] = [];
    const builder = fakeBuilder(1, (code) => {
      if (code !== 'P02000') return;
      seen.push(
        watcherHandle
          .prepare<{ checkpoint: string }>('SELECT checkpoint FROM mirror_sync_state')
          .get()?.checkpoint,
      );
    });

    await sync('refresh', builder);
    await watcher.close();

    expect(seen.map((value) => value && decodeCheckpoint(value))).toEqual([
      { generation: 2, asOfSeconds: T0 + 1_999 },
    ]);
    await expectReloaded();
  });

  it('lowers the as-of before it sweeps when it resumes a reload a 0.4.2 build stopped after its last ingest page', async () => {
    const handle = await probe.raw();
    handle
      .prepare(
        "INSERT INTO products (code, generation, record_version, tag_ids, doc) VALUES ('GONE', 1, 1, '[]', '{}')",
      )
      .run();
    await reloadDue();
    const stop = new AbortController();
    const atSweep: MirrorLogger = {
      info: (message) => {
        if (message.startsWith('Ingested the export')) stop.abort(new Error('interrupted'));
      },
    };
    await expect(sync('refresh', fakeBuilder(), stop.signal, atSweep)).rejects.toThrow(
      'interrupted',
    );
    expect(parseExportCursor((await probe.readState()).cursor)).toMatchObject({
      phase: 'sweep',
      generation: 2,
      maxModifiedT: T,
    });
    // As 0.4.2 left it: every row at the export's version, under the delta's as-of.
    handle
      .prepare('UPDATE mirror_sync_state SET checkpoint = ?')
      .run(encodeCheckpoint({ generation: 1, asOfSeconds: D }));
    handle.exec('CREATE TABLE swept (checkpoint TEXT)');
    handle.exec(
      'CREATE TRIGGER swept_ad AFTER DELETE ON products BEGIN INSERT INTO swept SELECT checkpoint FROM mirror_sync_state; END',
    );

    await sync('refresh');

    const swept = handle.prepare<{ checkpoint: string }>('SELECT checkpoint FROM swept').all();
    expect(swept.map((row) => decodeCheckpoint(row.checkpoint))).toEqual([
      { generation: 2, asOfSeconds: T },
    ]);
    await expectReloaded();
  });
});
