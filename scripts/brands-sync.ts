#!/usr/bin/env bun
/**
 * @fileoverview brands:sync — regenerates `src/services/taxonomy/brand-synonyms.ts` from Product
 * Opener's brands taxonomy (`taxonomies/brands.txt`) at one openfoodfacts-server commit: the full
 * SHA given as the only argument, or the one the current module names. Writes nothing when two
 * entries claim one brand key, or when an entry ID it computes is missing from the published
 * taxonomy dump, which means its reading of the file or its slug disagrees with Product Opener's.
 * @module scripts/brands-sync
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from '@cyanheads/mcp-ts-core';
import { USER_AGENT } from '@/services/openfoodfacts/user-agent.js';
import { brandKey } from '@/services/taxonomy/brand-keys.js';
import { tagIdOf } from '@/services/taxonomy/tag-id.js';

/** Why a sync wrote nothing. */
export type BrandsSyncReason =
  | 'invalid_commit'
  | 'unreadable_line'
  | 'missing_id'
  | 'duplicate_key';

/** A sync that refused to write the module, with the `reason` a caller branches on. */
export class BrandsSyncError extends Error {
  readonly reason: BrandsSyncReason;

  constructor(reason: BrandsSyncReason, message: string) {
    super(message);
    this.name = 'BrandsSyncError';
    this.reason = reason;
  }
}

/** One `taxonomies/brands.txt` entry: its canonical ID and every name its lines list, in order. */
export interface BrandEntry {
  /** `xx:` and Product Opener's ID of the entry's first name. */
  id: string;
  names: string[];
}

/**
 * A line as `sanitize_taxonomy_line` (`lib/ProductOpener/Tags.pm`) prepares it: a comma between
 * digits, or one escaped as `\,`, becomes the low comma `‚`, so the name keeps it; the first
 * parenthesized roman numeral loses its parentheses (`E333(iii)` → `E333iii`); trailing space goes.
 * Its `’` → `'` is left out: both are separators, so no ID or key tells them apart.
 */
function sanitizeLine(line: string): string {
  return line
    .replace(/(\p{Nd}),(\p{Nd})/gu, '$1‚$2')
    .replace(/\\,/g, '‚')
    .replace(/\(([ivx]+)\)/i, '$1')
    .trimEnd();
}

/** A line of names: a two-character language code, a colon, then the names. */
const NAMES_LINE = /^(\w\w):(.*)$/;

/** Lines whose meaning the generator does not model: parents, synonym-only blocks, stopwords. */
const UNMODELED_LINE = /^(?:<|synonyms:|stopwords:)/;

/** The refusal of line `index` (zero-based) of brands.txt, sanitized as `line`. */
function unreadableLine(index: number, line: string, why: string): BrandsSyncError {
  return new BrandsSyncError('unreadable_line', `brands.txt line ${index + 1} (${line}): ${why}`);
}

/**
 * Reads `taxonomies/brands.txt` as the first phase of Product Opener's taxonomy build does. A blank
 * line ends a block; `#` lines are comments; a names line splits on commas, and the first names
 * line of a block names its entry, whose ID is `xx:` and the ID of its first name. A block whose ID
 * an earlier one already took adds its names to that entry, as Product Opener merges them. Any other
 * line is a property (`wikidata:en:`, `comment:en:`) and names nothing; a block holding only
 * properties is no entry.
 *
 * Throws `unreadable_line` for a names line with no names (Product Opener refuses an empty one); a
 * block opened in a language other than `xx`, whose ID would follow that language's normalization;
 * and the lines `UNMODELED_LINE` matches.
 */
export function parseBrandsTaxonomy(text: string): BrandEntry[] {
  const entries = new Map<string, BrandEntry>();
  let current: BrandEntry | undefined;
  for (const [index, raw] of text.split('\n').entries()) {
    const line = sanitizeLine(raw);
    if (line === '') {
      current = undefined;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (UNMODELED_LINE.test(line)) {
      throw unreadableLine(
        index,
        line,
        'parents, synonym-only blocks, and stopwords are not modeled, so the keys would be wrong.',
      );
    }
    const match = NAMES_LINE.exec(line);
    if (!match) continue;
    const [, language, list = ''] = match;
    const names = list.trimStart().split(/\s*,\s*/);
    if (names.join('') === '') throw unreadableLine(index, line, 'a names line lists no name.');
    if (current === undefined) {
      if (language !== 'xx') {
        throw unreadableLine(
          index,
          line,
          'an entry opens with an `xx:` line, as every brand is language-less.',
        );
      }
      const id = `xx:${tagIdOf(names[0] ?? '', true)}`;
      current = entries.get(id) ?? { id, names: [] };
      entries.set(id, current);
    }
    current.names.push(...names);
  }
  return [...entries.values()];
}

/**
 * The brand keys of one entry: its canonical ID's, then each name's, without repeats. A name is
 * keyed as the stored tag `xx:<name>` would be, so a name that looks prefixed keeps its prefix; a
 * name that slugs to nothing has no key.
 */
function entryKeys(entry: BrandEntry): string[] {
  const keys = [entry.id, ...entry.names.map((name) => `xx:${name}`)].map(brandKey);
  return [...new Set(keys)].filter((key) => key !== '');
}

/**
 * The groups `brand-synonyms.ts` lists: the keys of each entry with more than one (`entryKeys`), in
 * file order. Throws `missing_id` naming every entry ID not in `publishedIds`, then
 * `duplicate_key` naming every key two entries share and both entries.
 */
export function brandSynonymGroups(
  entries: readonly BrandEntry[],
  publishedIds: ReadonlySet<string>,
): string[][] {
  const missing = entries.map((entry) => entry.id).filter((id) => !publishedIds.has(id));
  if (missing.length > 0) {
    throw new BrandsSyncError(
      'missing_id',
      `${missing.length} entry ID(s) computed from brands.txt are not in the published brands.json: ${missing.join(', ')}. The file was read or slugged differently from Product Opener; fix that before regenerating.`,
    );
  }
  const owners = new Map<string, string>();
  const shared: string[] = [];
  const groups: string[][] = [];
  for (const entry of entries) {
    const keys = entryKeys(entry);
    for (const key of keys) {
      const owner = owners.get(key);
      if (owner === undefined) owners.set(key, entry.id);
      else shared.push(`${key} (${owner} and ${entry.id})`);
    }
    if (keys.length > 1) groups.push(keys);
  }
  if (shared.length > 0) {
    throw new BrandsSyncError(
      'duplicate_key',
      `${shared.length} brand key(s) belong to two entries: ${shared.join(', ')}. A key must name one brand; fix brands.txt upstream or pin a commit where they differ.`,
    );
  }
  return groups;
}

/** The entry IDs of the published `brands.json` dump: its top-level keys. */
export function publishedIds(dump: string): Set<string> {
  return new Set(Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(dump))));
}

/** The generated module's text for `groups` taken from brands.txt at `commit`. */
export function renderBrandSynonymsModule(
  groups: readonly (readonly string[])[],
  commit: string,
): string {
  return `/**
 * @fileoverview Brand synonym groups, from Product Opener's \`taxonomies/brands.txt\` at
 * openfoodfacts-server commit ${commit}. Generated by
 * \`bun run brands:sync\`; regenerate rather than edit.
 * @module services/taxonomy/brand-synonyms
 */

/**
 * Each \`taxonomies/brands.txt\` entry with more than one brand key (\`brandKey\`), as its keys
 * separated by spaces, which no key contains, the key of the entry's canonical ID first.
 */
export const BRAND_SYNONYM_GROUPS: readonly string[] = [
${groups.map((keys) => `  '${keys.join(' ')}',`).join('\n')}
];
`;
}

/** A full commit SHA. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** The commit a module's header names, as `renderBrandSynonymsModule` writes it. */
const HEADER_COMMIT = /openfoodfacts-server commit ([0-9a-f]{40})\b/;

/**
 * The commit to sync: the one argument, lowercased, or with none the commit `currentModule`'s header
 * names. Throws `invalid_commit` for more than one argument, an argument that is not a full SHA (a
 * branch moves, a short SHA can be ambiguous), or a header that names none.
 */
export function commitToSync(args: readonly string[], currentModule: string): string {
  const [given, ...extra] = args;
  if (extra.length > 0) {
    throw new BrandsSyncError(
      'invalid_commit',
      `Pass one openfoodfacts-server commit at most, not ${args.length} arguments.`,
    );
  }
  if (given === undefined) {
    const pinned = HEADER_COMMIT.exec(currentModule)?.[1];
    if (pinned === undefined) {
      throw new BrandsSyncError(
        'invalid_commit',
        'brand-synonyms.ts names no openfoodfacts-server commit; pass one as the argument.',
      );
    }
    return pinned;
  }
  const commit = given.toLowerCase();
  if (!COMMIT_SHA.test(commit)) {
    throw new BrandsSyncError(
      'invalid_commit',
      `"${given}" is not a full 40-character commit SHA. Pass one, e.g. from \`git ls-remote https://github.com/openfoodfacts/openfoodfacts-server refs/heads/main\`.`,
    );
  }
  return commit;
}

const MODULE_PATH = new URL('../src/services/taxonomy/brand-synonyms.ts', import.meta.url);
const DUMP_URL = 'https://static.openfoodfacts.org/data/taxonomies/brands.json';
const FETCH_TIMEOUT_MS = 60_000;

/** The body of a GET to `url`, or a throw naming the status. */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${url} answered HTTP ${response.status}.`);
  return await response.text();
}

async function main(args: readonly string[]): Promise<void> {
  const commit = commitToSync(args, await readFile(MODULE_PATH, 'utf8'));
  const [taxonomy, dump] = await Promise.all([
    fetchText(
      `https://raw.githubusercontent.com/openfoodfacts/openfoodfacts-server/${commit}/taxonomies/brands.txt`,
    ),
    fetchText(DUMP_URL),
  ]);
  const entries = parseBrandsTaxonomy(taxonomy);
  const groups = brandSynonymGroups(entries, publishedIds(dump));
  const module = renderBrandSynonymsModule(groups, commit);
  await writeFile(MODULE_PATH, module);
  const extraKeys = groups.reduce((sum, keys) => sum + keys.length - 1, 0);
  console.log(
    `Wrote ${fileURLToPath(MODULE_PATH)} (${Buffer.byteLength(module)} bytes): ${groups.length} synonym groups holding ${extraKeys} keys beyond each group's first, from ${entries.length} entries at openfoodfacts-server ${commit}.`,
  );
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const reason = error instanceof BrandsSyncError ? ` [${error.reason}]` : '';
    console.error(
      `brands:sync failed${reason}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
