/**
 * @fileoverview The Open Food Facts export feeds the mirror reads: newline-delimited JSON (the full
 * export and each daily delta, one product document per line) and the delta index
 * (`data/delta/index.txt`, one `openfoodfacts_products_<start>_<end>.json.gz` name per line, where
 * start and end are the epoch seconds of the first and last change the file holds).
 * @module services/mirror/mirror-feeds
 */

import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

/**
 * Longest line accepted. The 2026-11 export's longest line is about 265 KB; a line past this is a
 * corrupt or foreign stream, and buffering it whole would break the ingest's flat memory.
 */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

const LF = 0x0a;

/**
 * Splits a byte stream on LF, one line at a time. Bytes of an unfinished line are held as chunk
 * slices and joined once, when its LF arrives, so the work stays linear however a line is chunked.
 * A final line without LF is yielded too. Lines keep a trailing CR if the stream has one.
 *
 * @throws McpError `ServiceUnavailable` (`upstream_line_too_long`) for a line over 16 MiB.
 */
export async function* readLines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const chunk of chunks) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let lf = bytes.indexOf(LF, start); lf !== -1; lf = bytes.indexOf(LF, start)) {
      const tail = bytes.subarray(start, lf);
      const length = pendingBytes + tail.length;
      assertLineLength(length);
      yield pending.length === 0 ? tail : Buffer.concat([...pending, tail], length);
      pending = [];
      pendingBytes = 0;
      start = lf + 1;
    }
    if (start < bytes.length) {
      const rest = bytes.subarray(start);
      pendingBytes += rest.length;
      assertLineLength(pendingBytes);
      pending.push(rest);
    }
  }
  if (pendingBytes > 0) yield Buffer.concat(pending, pendingBytes);
}

function assertLineLength(bytes: number): void {
  if (bytes > MAX_LINE_BYTES) {
    throw serviceUnavailable(
      `An export line runs past ${MAX_LINE_BYTES} bytes, so the stream is not an Open Food Facts JSONL export; the sync stopped.`,
      { reason: 'upstream_line_too_long' },
    );
  }
}

/** One daily delta file the index lists. */
export interface DeltaFile {
  /** Epoch seconds of the last change the file holds. */
  endSeconds: number;
  /** File name under `data/delta/`. */
  name: string;
  /** Epoch seconds of the first change the file holds. */
  startSeconds: number;
}

const DELTA_FILE_PATTERN = /^openfoodfacts_products_(\d{1,12})_(\d{1,12})\.json\.gz$/;

/**
 * Parses the delta index into files ordered oldest first. Blank lines are skipped; any other line
 * that is not a delta file name means the format changed, and applying a partial reading of it
 * could skip a day of changes.
 *
 * @throws McpError `ServiceUnavailable` (`delta_index_malformed`) naming the first bad line.
 */
export function parseDeltaIndex(text: string): DeltaFile[] {
  const files: DeltaFile[] = [];
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const match = DELTA_FILE_PATTERN.exec(line);
    if (!match) {
      throw serviceUnavailable(
        `Line ${index + 1} of the delta index is not an openfoodfacts_products_<start>_<end>.json.gz name; the sync stopped with its checkpoint unchanged.`,
        { reason: 'delta_index_malformed', line: index + 1 },
      );
    }
    files.push({ name: line, startSeconds: Number(match[1]), endSeconds: Number(match[2]) });
  }
  return files.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}

/** The deltas a refresh applies, or a gap the listed deltas cannot bridge. */
export type DeltaPlan =
  | { deltas: DeltaFile[]; kind: 'apply' }
  /** The first change after the checkpoint is older than every delta that could carry it. */
  | { kind: 'gap'; resumesAtSeconds: number };

/**
 * Picks the deltas ending past `asOfSeconds`, oldest first. Each must start at or before the point
 * the data already reaches; otherwise the changes in between are in no listed file, and only a
 * full reload recovers them. A checkpoint older than the oldest listed delta is that case at the
 * first file.
 */
export function planDeltas(index: readonly DeltaFile[], asOfSeconds: number): DeltaPlan {
  const deltas = index.filter((file) => file.endSeconds > asOfSeconds);
  let reached = asOfSeconds;
  for (const file of deltas) {
    if (file.startSeconds > reached) return { kind: 'gap', resumesAtSeconds: reached };
    reached = Math.max(reached, file.endSeconds);
  }
  return { kind: 'apply', deltas };
}
