/**
 * @fileoverview How the product tools render a record's metadata: its data completeness score and
 * when it was created and last modified, the same way on every tool that shows them.
 * @module mcp-server/tools/record-metadata
 */

/**
 * A completeness score with its exact value and a human-readable label. The rounded percentage
 * alone is lossy and unrecoverable — a text-only client reading "79%" cannot get back to 0.7875,
 * and re-calling returns the same rounded string — so the scalar is rendered alongside it. Open
 * Food Facts reports scores above 1 (1.0875), which render as they are reported: `109% (exact
 * 1.0875, high)`.
 */
export function completenessLabel(score: number): string {
  const pct = Math.round(score * 100);
  if (score >= 0.8) return `${pct}% (exact ${score}, high)`;
  if (score >= 0.5) return `${pct}% (exact ${score}, moderate)`;
  return `${pct}% (exact ${score}, low — many fields missing)`;
}

/**
 * A record's completeness score as the number the tools report. Open Food Facts sends it as a
 * number, and on some records as a numeric string (`/api/v2/search` sent 5053990161669's as
 * `"0.65"`), which is read as the number it spells. `undefined` for anything else: absent, blank,
 * or not a finite number.
 */
export function completenessScore(value: unknown): number | undefined {
  const score = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof score === 'number' && Number.isFinite(score) ? score : undefined;
}

/**
 * A record time Open Food Facts gives in epoch seconds (`last_modified_t`, `created_t`), as the ISO
 * 8601 time the tools report (`2023-07-13T16:31:30.000Z`, the form `mirror_as_of` takes).
 * `undefined` for anything but a number a `Date` can hold past the epoch: a stored 0 is no time
 * recorded, and neither is one at or before the epoch, so none is reported, never 0 or the epoch.
 */
export function recordTime(epochSeconds: unknown): string | undefined {
  if (typeof epochSeconds !== 'number') return;
  const time = new Date(epochSeconds * 1000);
  // NaN, for a time no Date holds, fails the comparison too.
  return time.getTime() > 0 ? time.toISOString() : undefined;
}

/** A record's two times as output fields, each present only when `recordTime` yields one. */
export function recordDates(record: { last_modified_t?: unknown; created_t?: unknown }): {
  last_modified?: string;
  created?: string;
} {
  const lastModified = recordTime(record.last_modified_t);
  const created = recordTime(record.created_t);
  return {
    ...(lastModified !== undefined && { last_modified: lastModified }),
    ...(created !== undefined && { created }),
  };
}

/** The text line naming a record's times, each as `structuredContent` carries it; none without either. */
export function recordDatesLine(record: {
  last_modified?: string | undefined;
  created?: string | undefined;
}): string | undefined {
  const parts = [
    record.last_modified && `**Last modified:** ${record.last_modified}`,
    record.created && `**Created:** ${record.created}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' | ') : undefined;
}
