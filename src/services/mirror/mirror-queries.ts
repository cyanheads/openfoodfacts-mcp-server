/**
 * @fileoverview The mirror's read queries — barcode lookup and tag-only search — over the store
 * `mirror-store.ts` defines. The one module that turns caller values into the store's keys and SQL:
 * a barcode through `normalizeCodeZeroes`, a tag filter through `toStoredTag` and `mirrorTagKey`.
 *
 * A tag search reads its matches as a stream of codes in code order: the rarest include's postings,
 * merged with each filter whose postings cost less to read whole than to seek (SQLite reads every
 * merged list once, in order, combining them with `INTERSECT` and `EXCEPT`), and a `product_tags`
 * primary-key seek per streamed code into each other filter. An include may be an any-of list of
 * tags: driving, its tags' postings are merged with `UNION`; otherwise it is sought, up to one seek
 * per tag, and never merged. An exclusion list is one exclusion per tag. It counts the stream, or,
 * with at most one include, of one tag, that include's postings (every product, with none) less
 * the union of the exclusions' postings within them, whichever reads less. Its page is cut
 * whichever of two ways costs less for that page: a walk of the sort key's index in search order
 * (from the end, for a page nearer the end), seeking every filter's postings for each product it
 * passes until it reaches the page; or the stream, its codes' sort keys taken from
 * `SORT_KEYS_INDEX` and ordered in a temporary B-tree. A walk costs what precedes the page, the
 * stream what it reads and what matches. Only the page's own documents are read. On a store still
 * missing an index, the cuts that do without it serve the same pages, slower.
 * @module services/mirror/mirror-queries
 */

import type { MirrorStore, SqliteHandle, SqlValue } from '@cyanheads/mcp-ts-core/mirror';
import type { SearchParams } from '@/services/openfoodfacts/types.js';
import { SORT_KEYS_INDEX, type SortColumn, sortIndexName } from './mirror-store.js';
import {
  type MIRROR_TAG_FACETS,
  type MirrorRecord,
  mirrorTagKey,
  normalizeCodeZeroes,
  toStoredTag,
} from './record-builder.js';

/** What the queries read the store through: `getMirrorStore()` satisfies it. */
type MirrorReader = Pick<MirrorStore, 'raw'>;

/** A stored product: the projected v2 JSON the record builder wrote. */
export type MirrorDoc = MirrorRecord['doc'];

/** A tag facet the store indexes, named as `MIRROR_TAG_FACETS` names it. */
export type MirrorTagFacet = (typeof MIRROR_TAG_FACETS)[number];

/**
 * One tag filter. `value` is canonical, as the taxonomy service's `canonicalizeTag` returns it; a
 * list matches a product carrying any of its values (a repeated value counts once), and an empty
 * list is no filter.
 */
export interface MirrorTagFilter {
  facet: MirrorTagFacet;
  value: string | readonly string[];
}

/** A sort key of the search tool, each a `products` column. */
export type MirrorSortKey = NonNullable<SearchParams['sort_by']>;

/** The `products` column each sort key orders by: the whitelist interpolated into ORDER BY. */
const SORT_KEY_COLUMNS = {
  popularity_key: 'popularity_key',
  unique_scans_n: 'unique_scans_n',
  created_t: 'created_t',
  last_modified_t: 'last_modified_t',
} as const satisfies Record<MirrorSortKey, SortColumn>;

/**
 * What a postings cut pays per match to read its sort key and order it, in the sort-index entries
 * (each with its posting seek) a walk reads in the same time: from `SORT_KEYS_INDEX`, which the
 * stream's code order reads nearly in sequence, or, on a store that lacks it, from the product row.
 * Measured on the full 4.9M-product export (Bun, warm cache, pages of 50): a walk entry costs
 * 0.32–0.38 µs near the start of the order and 0.41–1.02 µs through the middle of a 1.29M-product
 * tag; a match costs 0.39–0.76 µs on that tag (offset 0 to 500,000) and 0.41–1.16 µs on tags of
 * 3,700–87,000 products through the index, 3.4–4.2 µs through product rows, and 57 µs once those
 * rows have left the page cache.
 */
const MATCH_COST = { indexed: 1.5, row: 10 } as const;

/**
 * Postings a merge reads in code order in the time of one posting seek, measured as `MATCH_COST`
 * is: 0.052–0.065 µs per posting merged against 0.33 µs per seek. A seek costs a walk entry.
 */
const POSTINGS_PER_SEEK = 5;

/** A tag-only search. */
export interface MirrorTagSearch {
  /** Filters a product must match none of. */
  exclude: readonly MirrorTagFilter[];
  /** Filters a product must all match. */
  include: readonly MirrorTagFilter[];
  /** 1-based. */
  page: number;
  pageSize: number;
  /** Defaults to `popularity_key`, the `sort_by` Product Opener applies when given none. */
  sortBy?: MirrorSortKey | undefined;
}

/** One page of a tag-only search. */
export interface MirrorTagPage {
  /** The page's products, in sort order; empty on a page past the last. */
  docs: MirrorDoc[];
  /** Every product the filters match, exact. */
  total: number;
}

/**
 * A product row as a barcode lookup reads it: its doc, and the `MIRROR_RECORD_VERSION` the row was
 * built with, which a reload in progress leaves older on the rows it has not yet rewritten.
 */
export interface StoredProduct {
  doc: MirrorDoc;
  recordVersion: number;
}

/**
 * Looks barcodes up as Product Opener does, by the code `normalizeCodeZeroes` makes of each, so
 * `030000010402` finds the product stored as `0030000010402`. The map holds an entry for each input
 * barcode the store has, keyed by the barcode as given; a barcode it lacks has none. Inputs that
 * normalize to one code, a duplicate included, share one parsed row.
 */
export async function getByCodes(
  store: MirrorReader,
  codes: readonly string[],
): Promise<Map<string, StoredProduct>> {
  const handle = await store.raw();
  const keys = new Map(codes.map((code) => [code, normalizeCodeZeroes(code)]));
  const stored = new Map(
    handle
      .prepare<{ code: string; doc: string; record_version: number }>(
        'SELECT code, doc, record_version FROM products WHERE code IN (SELECT value FROM json_each(?))',
      )
      .all(JSON.stringify([...new Set(keys.values())]))
      .map((row): [string, StoredProduct] => [
        row.code,
        { doc: JSON.parse(row.doc), recordVersion: row.record_version },
      ]),
  );
  const found = new Map<string, StoredProduct>();
  for (const [code, key] of keys) {
    const product = stored.get(key);
    if (product !== undefined) found.set(code, product);
  }
  return found;
}

/**
 * Serves one page of a tag-only search: products matching every `include` filter (a list: any of
 * its values) and no `exclude` filter (a list: none of its values), ordered by `sortBy` descending,
 * products lacking it last as a live search places them, `code` ascending breaking ties.
 * `total` is exact and every page is servable; a page past the last returns no products and the
 * same total. An include none of whose values a stored product carries matches nothing, so the
 * search answers a total of 0 without reading a posting; a value no stored product carries is
 * otherwise dropped, from a list or as an exclusion. A list repeated, in any order, is read once.
 * With no include at all, every stored product is a candidate.
 *
 * Count, page, and documents are read in one transaction, so they describe one state of the store
 * while a refresh writes to it.
 */
export async function searchByTags(
  store: MirrorReader,
  search: MirrorTagSearch,
): Promise<MirrorTagPage> {
  const handle = await store.raw();
  const column = SORT_KEY_COLUMNS[search.sortBy ?? 'popularity_key'];
  const offset = (search.page - 1) * search.pageSize;
  const includeLists = [
    ...new Map(
      search.include
        .map(storedKeys)
        .filter((keys) => keys.length > 0)
        .map((keys) => [JSON.stringify(keys), keys]),
    ).values(),
  ];
  // Excluding a list excludes each of its values.
  const excludeKeys = new Set(search.exclude.flatMap(storedKeys));

  return handle.transaction(() => {
    const idOf = tagIds(handle, [...includeLists.flat(), ...excludeKeys]);
    const included: number[][] = [];
    for (const keys of includeLists) {
      const ids = keys.flatMap((key) => idOf.get(key) ?? []);
      if (ids.length === 0) return { total: 0, docs: [] };
      included.push(ids);
    }
    const withPostings = (ids: readonly number[]): PostingList => ({
      ids,
      postings: ids.reduce((sum, id) => sum + postingCount(handle, id), 0),
    });
    const excluded = [...excludeKeys].flatMap((key) => {
      const id = idOf.get(key);
      return id === undefined ? [] : [withPostings([id])];
    });

    // Rarest include first: it drives the stream, and a walk checks it first.
    const ranked = included.map(withPostings).sort((a, b) => a.postings - b.postings);
    const [driver, ...others] = ranked;
    const matches = driver === undefined ? undefined : matchStream([driver], others, excluded);
    const total = countMatches(handle, ranked, excluded, matches);
    if (offset >= total) return { total, docs: [] };

    // A page nearer the end is cut from the end of the order, where fewer matches precede it.
    const forwardNeed = Math.min(offset + search.pageSize, total);
    const reverse = total - offset < forwardNeed;
    const plan = planCut(handle, {
      column,
      matches,
      need: reverse ? total - offset : forwardNeed,
      total,
    });
    const cut: MatchSource =
      plan.kind === 'postings'
        ? { from: plan.from, clauses: plan.matches.clauses, params: plan.matches.params }
        : {
            from: plan.from,
            ...checks(
              'w.code',
              ranked.map(({ ids }) => ids),
              excluded.flatMap(({ ids }) => ids),
            ),
          };

    /**
     * The page is cut over sort keys alone, then joined to its documents: a document read inside
     * the cut would be read for every product the cut passes over, not only the page's.
     */
    const docs = handle
      .prepare<{ doc: string }>(
        `SELECT p.doc FROM (
           SELECT w.rowid AS rid, w.${column} AS sort_key, w.code AS code
           FROM ${cut.from}${whereOf(cut.clauses)}
           ORDER BY ${reverse ? `w.${column} ASC NULLS FIRST, w.code DESC` : `w.${column} DESC NULLS LAST, w.code`}
           LIMIT ? OFFSET ?
         ) AS page
         JOIN products p ON p.rowid = page.rid
         ORDER BY page.sort_key DESC NULLS LAST, page.code`,
      )
      .all(
        ...cut.params,
        reverse ? Math.min(search.pageSize, total - offset) : search.pageSize,
        reverse ? Math.max(0, total - offset - search.pageSize) : offset,
      )
      .map((row): MirrorDoc => JSON.parse(row.doc));
    return { total, docs };
  });
}

/**
 * A `FROM` source and the `WHERE` clauses that select a search's matches, with their parameters in
 * the order the two bind them.
 */
interface MatchSource {
  clauses: string[];
  from: string;
  params: SqlValue[];
}

/**
 * The stored tags a filter names (any of them, for a list) and their postings summed: the products
 * carrying the tag, for one, and at most that many for several, as a product can carry two.
 */
interface PostingList {
  ids: readonly number[];
  postings: number;
}

/**
 * Codes in code order, as a source whose code column is `d.code`, with what reading them costs in
 * sort-index entries. `count` is how many it yields, when that is known without reading them.
 */
interface MatchStream extends MatchSource {
  cost: number;
  count?: number;
}

/**
 * The codes in any tag of `base`'s posting lists (at least one), in a tag of every `include`'s, and
 * in no `exclude`'s. A filter of one tag whose postings cost no more to read whole than seeking
 * every base posting in them is merged: SQLite reads each merged list once, in code order, and
 * combines them as it goes, `UNION` across the base's tags, then `INTERSECT` and `EXCEPT`. Every
 * other filter is sought: for each code the merge yields, a posting seek into each tag it names
 * until one holds the code. A list of several tags beside the base is never merged: read as one
 * term, its postings arrive in code order only tag by tag, and SQLite sorts them in a temporary
 * B-tree before it can merge them.
 */
function matchStream(
  base: readonly PostingList[],
  include: readonly PostingList[],
  exclude: readonly PostingList[],
): MatchStream {
  const reach = postingsOf(base);
  const merged = ({ ids, postings }: PostingList) =>
    ids.length === 1 && postings <= reach * POSTINGS_PER_SEEK;
  const mergedIn = include.filter(merged);
  const mergedOut = exclude.filter(merged);
  const read = [...base, ...mergedIn, ...mergedOut];
  const sought = checks(
    'd.code',
    include.filter((list) => !merged(list)).map(({ ids }) => ids),
    exclude.filter((list) => !merged(list)).flatMap(({ ids }) => ids),
  );
  const cost = postingsOf(read) / POSTINGS_PER_SEEK + (sought.clauses.length > 0 ? reach : 0);
  const only = read.length === 1 && read[0]?.ids.length === 1 ? read[0] : undefined;
  if (only !== undefined) {
    return {
      from: 'product_tags d',
      clauses: ['d.tag_id = ?', ...sought.clauses],
      params: [...only.ids, ...sought.params],
      cost,
      ...(sought.clauses.length === 0 && { count: only.postings }),
    };
  }
  const postings = 'SELECT code FROM product_tags WHERE tag_id = ?';
  const compound = [
    base.flatMap(({ ids }) => ids.map(() => postings)).join(' UNION '),
    ...mergedIn.map(() => `INTERSECT ${postings}`),
    ...mergedOut.map(() => `EXCEPT ${postings}`),
  ].join(' ');
  return {
    from: `(${compound}) AS d`,
    clauses: sought.clauses,
    params: [...read.flatMap(({ ids }) => ids), ...sought.params],
    cost,
  };
}

/** Postings across `lists`. */
function postingsOf(lists: readonly PostingList[]): number {
  return lists.reduce((sum, { postings }) => sum + postings, 0);
}

/**
 * Every match, exact: what `matches` yields, or, with at most one include, of one tag, that
 * include's postings (every product, with none) less the union of the exclusions' postings within
 * them, whichever reads less. The subtraction reads an include's postings only where it merges
 * them. A list's summed postings count twice a product carrying two of its tags, so a list is
 * counted from the stream.
 */
function countMatches(
  handle: SqliteHandle,
  ranked: readonly PostingList[],
  excluded: readonly PostingList[],
  matches: MatchStream | undefined,
): number {
  const exactPostings = ranked.length === 0 || (ranked.length === 1 && ranked[0]?.ids.length === 1);
  if (exactPostings && excluded.length > 0) {
    const removed = matchStream(excluded, ranked, []);
    if (matches === undefined || removed.cost <= matches.cost) {
      return (ranked[0]?.postings ?? productCount(handle)) - streamCount(handle, removed);
    }
  }
  return matches === undefined ? productCount(handle) : streamCount(handle, matches);
}

/** How many codes `stream` yields. */
function streamCount(handle: SqliteHandle, stream: MatchStream): number {
  return (
    stream.count ??
    countOf(
      handle,
      `SELECT COUNT(*) AS n FROM ${stream.from}${whereOf(stream.clauses)}`,
      stream.params,
    )
  );
}

/** Every stored product. */
function productCount(handle: SqliteHandle): number {
  return countOf(handle, 'SELECT COUNT(*) AS n FROM products', []);
}

/**
 * Posting seeks on the product `code` names: per include, into each of its tags (`IN` for a list,
 * which any of them satisfies), and per excluded tag.
 */
function checks(
  code: string,
  included: readonly (readonly number[])[],
  excluded: readonly number[],
): Omit<MatchSource, 'from'> {
  const tagIn = (ids: readonly number[]) =>
    ids.length === 1 ? '= ?' : `IN (${ids.map(() => '?').join(', ')})`;
  return {
    clauses: [
      ...included.map(
        (ids) =>
          `EXISTS (SELECT 1 FROM product_tags i WHERE i.tag_id ${tagIn(ids)} AND i.code = ${code})`,
      ),
      ...excluded.map(
        () => `NOT EXISTS (SELECT 1 FROM product_tags x WHERE x.tag_id = ? AND x.code = ${code})`,
      ),
    ],
    params: [...included.flat(), ...excluded],
  };
}

/**
 * How a page is cut, with the `FROM` source it reads. `walk` reads the sort key's index in search
 * order (or from its end), seeking every filter's postings for each product it passes, until it
 * reaches the page. `postings` reads the match stream and orders every match's sort key in a
 * temporary B-tree. `scan` orders every product that way: a search no include drives, on a store
 * that lacks the sort index.
 */
type CutPlan =
  | { from: string; kind: 'postings'; matches: MatchStream }
  | { from: string; kind: 'scan' | 'walk' };

/** What a cut's cost depends on. */
interface CutShape {
  column: SortColumn;
  /** The match stream the driving include leads; none without an include. */
  matches: MatchStream | undefined;
  /** Matches the cut reads, in the direction it reads them, through the end of the page. */
  need: number;
  /** Matches, exact, at least 1. */
  total: number;
}

/**
 * Picks the cheaper cut, in sort-index entries read. Matches spread evenly through the sort order
 * put a walk at `need × products ÷ total` entries; the postings cut costs what its stream reads,
 * plus every match's sort key at `MATCH_COST`. A store missing an index leaves the cuts that do
 * without it.
 */
function planCut(handle: SqliteHandle, shape: CutShape): CutPlan {
  const sortIndex = sortIndexName(shape.column);
  const present = new Set(
    handle
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN (?, ?)",
      )
      .all(sortIndex, SORT_KEYS_INDEX)
      .map(({ name }) => name),
  );
  const walk: CutPlan = { kind: 'walk', from: `products w INDEXED BY ${sortIndex}` };
  const { matches } = shape;
  if (matches === undefined) {
    return present.has(sortIndex) ? walk : { kind: 'scan', from: 'products w' };
  }
  const keyed = present.has(SORT_KEYS_INDEX);
  /**
   * CROSS JOIN keeps the stream the outer loop: left to choose, the planner may walk a sort
   * index, and it reads sort keys from the product row unless told the index that holds them.
   */
  const postings: CutPlan = {
    kind: 'postings',
    from: `${matches.from} CROSS JOIN products w${keyed ? ` INDEXED BY ${SORT_KEYS_INDEX}` : ''} ON w.code = d.code`,
    matches,
  };
  if (!present.has(sortIndex)) return postings;
  // MAX(rowid) bounds the product count from above in one seek; COUNT(*) reads every row.
  const products =
    handle.prepare<{ last: number | null }>('SELECT MAX(rowid) AS last FROM products').get()
      ?.last ?? 0;
  const walkCost = (shape.need * products) / shape.total;
  const postingsCost = matches.cost + shape.total * (keyed ? MATCH_COST.indexed : MATCH_COST.row);
  return walkCost <= postingsCost ? walk : postings;
}

/** ` WHERE` over `clauses`, or nothing for none. */
function whereOf(clauses: readonly string[]): string {
  return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
}

/** A filter's `tags.key`s, one per distinct value, sorted; none for an empty list. */
function storedKeys({ facet, value }: MirrorTagFilter): string[] {
  const values = typeof value === 'string' ? [value] : value;
  return [...new Set(values.map((v) => mirrorTagKey(facet, toStoredTag(facet, v))))].sort();
}

/**
 * `tags.id` of each key the store holds; a key it lacks has no entry. One seek per key keeps the
 * plan off the statistics: given `ANALYZE` figures for a small `tags` table, the planner answers an
 * `IN (json_each)` list with a scan.
 */
function tagIds(handle: SqliteHandle, keys: readonly string[]): Map<string, number> {
  const select = handle.prepare<{ id: number }>('SELECT id FROM tags WHERE key = ?');
  const ids = new Map<string, number>();
  for (const key of keys) {
    // bun:sqlite answers a miss with null, better-sqlite3 with undefined.
    const row = select.get(key);
    if (row != null) ids.set(key, row.id);
  }
  return ids;
}

/** Products carrying the tag: a range scan of its postings. */
function postingCount(handle: SqliteHandle, tagId: number): number {
  return countOf(handle, 'SELECT COUNT(*) AS n FROM product_tags WHERE tag_id = ?', [tagId]);
}

/** Runs a `SELECT COUNT(*) AS n …`, which yields exactly one row. */
function countOf(handle: SqliteHandle, sql: string, params: readonly SqlValue[]): number {
  return handle.prepare<{ n: number }>(sql).get(...params)?.n ?? 0;
}
