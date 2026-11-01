/**
 * @fileoverview Tests for the export feed formats: the JSONL line splitter (chunk boundaries, the
 * final unterminated line, the line-length bound, linear time), the delta index parser, and the
 * delta plan that decides between applying deltas and a full reload.
 * @module tests/services/mirror/mirror-feeds.test
 */

import { describe, expect, it } from 'vitest';
import {
  type DeltaFile,
  parseDeltaIndex,
  planDeltas,
  readLines,
} from '@/services/mirror/mirror-feeds.js';

async function* chunked(text: string | Buffer, size: number): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function collect(text: string, size: number): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readLines(chunked(text, size))) lines.push(line.toString('utf8'));
  return lines;
}

describe('readLines', () => {
  it('yields each line once whatever the chunk size, including one split mid-character', async () => {
    const text = '{"code":"1"}\n{"name":"crème brûlée"}\n\n{"code":"3"}\n';
    const expected = ['{"code":"1"}', '{"name":"crème brûlée"}', '', '{"code":"3"}'];
    for (const size of [1, 2, 3, 7, 64, 4096]) expect(await collect(text, size)).toEqual(expected);
  });

  it('yields a final line that has no LF, and nothing for a trailing LF', async () => {
    expect(await collect('a\nb', 1)).toEqual(['a', 'b']);
    expect(await collect('a\nb\n', 1)).toEqual(['a', 'b']);
    expect(await collect('', 1)).toEqual([]);
  });

  it('keeps a CR before the LF, which JSON.parse accepts as whitespace', async () => {
    expect(await collect('{"a":1}\r\n', 3)).toEqual(['{"a":1}\r']);
  });

  it('refuses a line past 16 MiB as a foreign stream', async () => {
    const huge = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
    const run = async () => {
      for await (const _ of readLines(chunked(huge, 1 << 20))) {
        /* drain */
      }
    };
    await expect(run()).rejects.toMatchObject({ data: { reason: 'upstream_line_too_long' } });
  });
});

describe('parseDeltaIndex', () => {
  const index = [
    'openfoodfacts_products_1793428456_1793514332.json.gz',
    'openfoodfacts_products_1793341341_1793428456.json.gz',
    '',
    'openfoodfacts_products_1793254716_1793341341.json.gz',
    '',
  ].join('\n');

  it('parses the newest-first upstream listing into files ordered oldest first', () => {
    expect(parseDeltaIndex(index)).toEqual([
      {
        name: 'openfoodfacts_products_1793254716_1793341341.json.gz',
        startSeconds: 1793254716,
        endSeconds: 1793341341,
      },
      {
        name: 'openfoodfacts_products_1793341341_1793428456.json.gz',
        startSeconds: 1793341341,
        endSeconds: 1793428456,
      },
      {
        name: 'openfoodfacts_products_1793428456_1793514332.json.gz',
        startSeconds: 1793428456,
        endSeconds: 1793514332,
      },
    ]);
  });

  it('accepts CRLF line ends and an empty index', () => {
    expect(parseDeltaIndex(index.replaceAll('\n', '\r\n'))).toHaveLength(3);
    expect(parseDeltaIndex('')).toEqual([]);
  });

  it('refuses any other line, naming its number, rather than apply a partial reading', () => {
    expect(() => parseDeltaIndex(`${index}\nopenfoodfacts_products_1_2.jsonl.gz\n`)).toThrowError(
      expect.objectContaining({ data: { reason: 'delta_index_malformed', line: 6 } }),
    );
    expect(() => parseDeltaIndex('<html>Not Found</html>')).toThrowError(
      expect.objectContaining({ data: { reason: 'delta_index_malformed', line: 1 } }),
    );
  });
});

describe('planDeltas', () => {
  const day = (start: number, end: number): DeltaFile => ({
    name: `openfoodfacts_products_${start}_${end}.json.gz`,
    startSeconds: start,
    endSeconds: end,
  });
  const index = [day(100, 200), day(200, 300), day(300, 400)];

  it('applies the deltas ending past the checkpoint, oldest first', () => {
    expect(planDeltas(index, 250)).toEqual({ kind: 'apply', deltas: [index[1], index[2]] });
    expect(planDeltas(index, 200)).toEqual({ kind: 'apply', deltas: [index[1], index[2]] });
  });

  it('applies nothing once the checkpoint reaches the newest delta', () => {
    expect(planDeltas(index, 400)).toEqual({ kind: 'apply', deltas: [] });
    expect(planDeltas([], 400)).toEqual({ kind: 'apply', deltas: [] });
  });

  it('reports a gap when the checkpoint predates the oldest listed delta', () => {
    expect(planDeltas(index, 99)).toEqual({ kind: 'gap', resumesAtSeconds: 99 });
    expect(planDeltas(index, 100)).toEqual({ kind: 'apply', deltas: index });
  });

  it('reports a gap when a missing day leaves changes in no listed file', () => {
    expect(planDeltas([index[0] as DeltaFile, index[2] as DeltaFile], 150)).toEqual({
      kind: 'gap',
      resumesAtSeconds: 200,
    });
  });
});

/**
 * Per-call thread CPU in ms: the least of three samples, each repeated until it has spent 20 ms,
 * so Linux's coarse CPU ticks never read as zero.
 */
async function cpuMs(run: () => Promise<void>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 3; sample += 1) {
    const start = process.threadCpuUsage();
    let runs = 0;
    let spentMs = 0;
    do {
      await run();
      runs += 1;
      const used = process.threadCpuUsage(start);
      spentMs = (used.user + used.system) / 1000;
    } while (spentMs < 20);
    best = Math.min(best, spentMs / runs);
  }
  return best;
}

/** Doubles the input from 5k to 320k units, bounding CPU at each size before the next. */
async function expectLinear(
  build: (units: number) => string,
  run: (input: string) => Promise<void>,
): Promise<void> {
  const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const times: number[] = [];
  for (const units of sizes) {
    const input = build(units);
    const ms = await cpuMs(() => run(input));
    // 2 µs per unit plus a fixed floor: generous for linear work, far under a quadratic's.
    expect(ms).toBeLessThan(5 + units * 0.002);
    times.push(ms);
  }
  expect((times.at(-1) as number) / (times[0] as number)).toBeLessThan(256);
}

describe('feed parser timing', () => {
  const shapes: [string, (units: number) => string][] = [
    ['one long line ending in a break', (units) => `${'§1 x'.repeat(units)}\ny`],
    ['breaks throughout', (units) => '  \r\n'.repeat(units)],
  ];

  for (const [shape, build] of shapes) {
    it(`readLines stays linear: ${shape}`, async () => {
      await expectLinear(build, async (input) => {
        let count = 0;
        for await (const _ of readLines(chunked(input, 1024))) count += 1;
        expect(count).toBeGreaterThan(0);
      });
    });

    it(`parseDeltaIndex stays linear: ${shape}`, async () => {
      await expectLinear(build, async (input) => {
        if (input.startsWith('§')) {
          expect(() => parseDeltaIndex(input)).toThrowError(
            expect.objectContaining({ data: { reason: 'delta_index_malformed', line: 1 } }),
          );
        } else {
          expect(parseDeltaIndex(input)).toEqual([]);
        }
      });
    });
  }
});
