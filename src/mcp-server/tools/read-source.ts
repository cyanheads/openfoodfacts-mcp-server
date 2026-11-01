/**
 * @fileoverview Where a tool's answer was read, as its text names it: the live Open Food Facts API,
 * or this server's local copy of the export as of a time, and the freshness note an answer the copy
 * served carries. One place for every product tool, so each states its source in the same words.
 * @module mcp-server/tools/read-source
 */

import type { ReadSource } from '@/services/openfoodfacts/openfoodfacts-service.js';
import { mdInline } from '@/utils/markdown.js';

/** How the text surface names each answer's source. */
const SOURCE_LABELS = {
  off_api: 'Open Food Facts',
  off_mirror: "this server's local copy of the Open Food Facts export",
} as const satisfies Record<ReadSource['source'], string>;

/** A source as the text names it: its value, its label, and the as-of time of a copy. */
function sourceLabel(source: ReadSource['source'], mirrorAsOf: string | undefined): string {
  return `${source} (${SOURCE_LABELS[source]}${mirrorAsOf === undefined ? '' : `, as of ${mirrorAsOf}`})`;
}

/** Where the answer was read, closing every text-surface branch. */
export function sourceLine(source: ReadSource['source'], mirrorAsOf: string | undefined): string {
  return `**Source:** ${sourceLabel(source, mirrorAsOf)}`;
}

/** One source of a multi-row answer, as of when, and the barcodes of the rows it answered. */
export type SourceGroup = {
  source: ReadSource['source'];
  mirrorAsOf: string | undefined;
  barcodes: string[];
};

/**
 * Where the rows of a multi-row answer were read, in one line: `sourceLine` when every row shares
 * one source, else each source followed by the barcodes it answered.
 */
export function sourcesLine([first, ...rest]: readonly [SourceGroup, ...SourceGroup[]]): string {
  if (rest.length === 0) return sourceLine(first.source, first.mirrorAsOf);
  const parts = [first, ...rest].map(
    (group) => `${sourceLabel(group.source, group.mirrorAsOf)} for ${group.barcodes.join(', ')}`,
  );
  return `**Source:** ${parts.join('; ')}`;
}

/**
 * The freshness note of an answer the local copy served. `read` names what came from it ("These
 * results come"), and `missed` what the copy cannot show of a change made after `mirrorAsOf`.
 */
export function mirrorCopyNote(read: string, mirrorAsOf: string, missed: string): string {
  return `${read} from ${SOURCE_LABELS.off_mirror}, current as of ${mirrorAsOf}, not the live database, so ${missed}.`;
}

/**
 * The `content[]` line of a `mirror_snapshot` enrichment field. The note is authored prose rather
 * than a value to copy, so it renders as a labelled sentence instead of the framework's code span.
 */
export function mirrorSnapshotTrailer(note: string | undefined): string {
  return `**Mirror freshness:** ${mdInline(String(note))}`;
}
