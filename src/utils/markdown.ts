/**
 * @fileoverview Contextual Markdown escaping for values this server did not author. Open Food Facts
 * is contributor-edited, so every product name, ingredient string, and tag ID rendered into
 * `content[]` sits outside this server's trust boundary: a value carrying Markdown syntax would
 * change the structure of the document rather than be displayed in it, and text presented as data
 * would present itself as instructions to the reading agent. Each function escapes for one
 * rendering context and preserves the value's characters, so `structuredContent` and `content[]`
 * still carry the same text.
 * @module utils/markdown
 */

import { markdown } from '@cyanheads/mcp-ts-core/utils';

/**
 * Characters that open Markdown structure inside a line. The backslash is escaped first, so an
 * escape this function adds is never itself re-escaped by the same pass.
 */
const INLINE_METACHARACTERS = /[\\`*_[\]<]/g;

/** Any line break, including the CRLF pair, collapsed as one unit rather than two. */
const LINE_BREAKS = /\r\n|[\r\n]/g;

/**
 * Escape a value rendered inside a line — a bold label's value, a bullet, a heading. Line breaks
 * collapse to a space: they are the only character that opens a new block, so a value carrying one
 * would otherwise end the line it was given and start structure of its own.
 */
export function mdInline(value: string): string {
  return value.replace(LINE_BREAKS, ' ').replace(INLINE_METACHARACTERS, '\\$&');
}

/**
 * Escape a value rendered inside a GFM table cell. A bare pipe adds a column and a line break ends
 * the row, so both are neutralized before the inline escapes apply.
 */
export function mdTableCell(value: string): string {
  return mdInline(value).replace(/\|/g, '\\|');
}

/**
 * Render a value as a fenced code block the value cannot terminate. The fence is sized past the
 * longest backtick run in the content, per CommonMark's rule that a fenced block closes only on a
 * run at least as long as the one that opened it.
 */
export function mdCodeFence(value: string): string {
  return markdown().codeBlock(value).build();
}

/**
 * Render a value as an inline code span the value cannot close. The delimiter is longer than the
 * longest backtick run inside, and the content is padded with one space on each side — CommonMark
 * strips a single leading and trailing space pair — so a value that begins or ends with a backtick
 * cannot merge with the delimiter.
 */
export function mdInlineCode(value: string): string {
  const text = value.replace(LINE_BREAKS, ' ');
  let longestRun = 0;
  for (const [run] of text.matchAll(/`+/g)) longestRun = Math.max(longestRun, run.length);
  if (longestRun === 0) return `\`${text}\``;
  const delimiter = '`'.repeat(longestRun + 1);
  return `${delimiter} ${text} ${delimiter}`;
}

/**
 * Neutralize a URL rendered as a bare value. The inline escapes are deliberately not applied: an
 * escaped underscore would leave a backslash inside a link a reader copies out. A line break is the
 * one character that can open block structure, so it collapses to a space, and `<` — never legal
 * unencoded in a URL, but able to open inline HTML — is percent-encoded, which is lossless.
 */
export function mdUrl(value: string): string {
  return value.replace(LINE_BREAKS, ' ').replace(/</g, '%3C');
}
