/**
 * @fileoverview Where a tool's answer was read, as its text names it: the live Open Food Facts API,
 * or this server's local copy of the export as of a time, the freshness note an answer the copy
 * served carries, and the note naming the fields a row the copy holds from before them lacks. One
 * place for every product tool, so each states its source in the same words.
 * @module mcp-server/tools/read-source
 */

import type { ReadSource, UnreadFields } from '@/services/openfoodfacts/openfoodfacts-service.js';
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
 * results come"), and `missed` what the copy cannot show of an edit made after `mirrorAsOf`.
 *
 * Contributor edits reach the copy through `mirrorAsOf` because each daily delta selects records
 * by `last_modified_t`. Open Food Facts also recomputes derived values in batch runs that move only
 * `last_updated_t`, which no delta selects, and a removed product is in no delta at all, so both
 * reach the copy only with a full reload: the note bounds the computed values by that instead.
 */
export function mirrorCopyNote(read: string, mirrorAsOf: string, missed: string): string {
  return `${read} from ${SOURCE_LABELS.off_mirror}, not the live database: the copy reflects contributor edits through ${mirrorAsOf}, so ${missed}; computed values (Nutri-Score, NOVA group, Green-Score, nutrient levels, estimated nutrients, parsed ingredients and their analysis, additives, allergens and traces, completeness, data-quality tags) are as of the record's last edit or the copy's last full reload (about every 30 days), whichever is later; and a product removed since that reload can still be shown.`;
}

/**
 * The `content[]` line of a `mirror_snapshot` enrichment field. The note is authored prose rather
 * than a value to copy, so it renders as a labelled sentence instead of the framework's code span.
 */
export function mirrorSnapshotTrailer(note: string | undefined): string {
  return `**Mirror freshness:** ${mdInline(String(note))}`;
}

/**
 * How the live read for fields a mirror row predates ended, or that none was sent. A removal
 * reaches the copy only with a full reload (see `mirrorCopyNote`), so a product the copy holds that
 * the live read does not find may have been removed at any time since that reload, however recent
 * `mirrorAsOf` is.
 */
function unreadOutcome(unread: UnreadFields, them: string, mirrorAsOf: string): string {
  switch (unread.outcome) {
    case 'not_found':
      return `the live read for ${them} found no product under this barcode, which Open Food Facts may have removed at any time since the copy's last full reload (about every 30 days): only a full reload brings a removal, so the copy's edits through ${mirrorAsOf} do not bound it.`;
    case 'failed': {
      const { reason } = unread.error.data ?? {};
      const quoted = `"${unread.error.message}"`;
      return `the live read for ${them} failed (${typeof reason === 'string' ? `${reason}: ${quoted}` : quoted}). Retry later to read ${them}.`;
    }
    case 'skipped':
      return `no live read was sent for ${them}; off_get_product reads ${them} for this barcode.`;
  }
}

/**
 * The `mirror_fields_unread` note of a product or row the local copy served: which fields it lacks
 * because its row predates them, and how the live read that tried them first ended, or that none
 * was sent. A failure's reason and message are carried as the service raised them, so the note
 * says what a caller would have been told had the call failed.
 */
export function unreadFieldsNote(unread: UnreadFields, mirrorAsOf: string): string {
  const one = unread.fields.length === 1;
  const them = one ? 'it' : 'them';
  const named = new Intl.ListFormat('en', { type: 'conjunction' }).format(unread.fields);
  return `${named} ${one ? 'is' : 'are'} absent because ${one ? 'it was' : 'they were'} not read, not because Open Food Facts lacks ${them}: this server's local copy of this product predates ${them}, and ${unreadOutcome(unread, them, mirrorAsOf)}`;
}
