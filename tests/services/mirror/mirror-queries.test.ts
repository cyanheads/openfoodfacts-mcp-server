/**
 * @fileoverview Tests for the mirror's read queries against a real store built through the write
 * path: export lines (the live fixtures under `tests/fixtures/mirror/` and synthetic ones) through
 * the record builder, `TagIds`, and the store's batch upsert. Covers barcode lookup (hit, miss,
 * leading zeros, duplicates) and tag-only search: ANDed includes, any-of lists (driving, sought, and
 * excluded, on both page cuts), exclusions as absence, unknown values, the stored brand and NOVA
 * forms, every sort key with nulls and ties, and paging to and past the last page with the exact
 * total.
 * @module tests/services/mirror/mirror-queries.test
 */

import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MirrorStore, SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TagIds } from '@/services/mirror/mirror-ingester.js';
import {
  getByCodes,
  type MirrorTagFilter,
  type MirrorTagSearch,
  searchByTags,
} from '@/services/mirror/mirror-queries.js';
import {
  ensureSortIndexes,
  openMirrorStore,
  SORT_COLUMNS,
  SORT_KEYS_INDEX,
  sortIndexName,
} from '@/services/mirror/mirror-store.js';
import { buildMirrorRecord } from '@/services/mirror/record-builder.js';

type Line = Record<string, unknown>;

const FIXTURE_DIR = new URL('../../fixtures/mirror/', import.meta.url);

/** The export line of every live fixture. */
const FIXTURE_LINES: Line[] = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith('.json'))
  .map(
    (file) => (JSON.parse(readFileSync(new URL(file, FIXTURE_DIR), 'utf8')) as { line: Line }).line,
  );

const fixtureLine = (code: string): Line => {
  const line = FIXTURE_LINES.find((candidate) => candidate.code === code);
  if (!line) throw new Error(`No fixture line for ${code}`);
  return line;
};

let dir: string;
let store: MirrorStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'off-mirror-queries-'));
  store = openMirrorStore(join(dir, 'store.sqlite'));
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Writes export lines the way a sync page does: builder, tag ids, one batch upsert, each row stamped
 * with `recordVersion` as the record version that built it.
 */
async function write(lines: Line[], recordVersion = 1): Promise<void> {
  const handle = await store.raw();
  const records = lines.map((line) => {
    const record = buildMirrorRecord(line);
    if (!record) throw new Error(`Line ${String(line.code)} is not servable`);
    return record;
  });
  const ids = new TagIds().resolve(handle, new Set(records.flatMap((record) => record.tags)));
  await store.applyBatch(
    records.map((record) => ({
      code: record.code,
      popularity_key: record.popularityKey,
      unique_scans_n: record.uniqueScansN,
      created_t: record.createdT,
      last_modified_t: record.lastModifiedT,
      generation: 1,
      record_version: recordVersion,
      tag_ids: JSON.stringify(
        [...new Set(record.tags.map((key) => ids.get(key) as number))].sort((a, b) => a - b),
      ),
      doc: JSON.stringify(record.doc),
    })),
    [],
  );
}

/** A synthetic schema 1004 export line; a sort key left out is one the record lacks. */
function line(code: string, fields: Line = {}): Line {
  return { code, schema_version: 1004, lc: 'en', product_name: `Product ${code}`, ...fields };
}

/** A reader whose handle records every statement prepared through it. */
async function recordingReader(): Promise<{
  reader: { raw: () => Promise<SqliteHandle> };
  statements: string[];
}> {
  const handle = await store.raw();
  const statements: string[] = [];
  const recording: SqliteHandle = {
    ...handle,
    prepare: <TRow>(sql: string) => {
      statements.push(sql);
      return handle.prepare<TRow>(sql);
    },
  };
  return { reader: { raw: async () => recording }, statements };
}

async function search(
  include: MirrorTagFilter[],
  options: Partial<Omit<MirrorTagSearch, 'include'>> = {},
): Promise<{ codes: string[]; total: number }> {
  const page = await searchByTags(store, {
    include,
    exclude: [],
    page: 1,
    pageSize: 50,
    ...options,
  });
  return { codes: page.docs.map((doc) => doc.code as string), total: page.total };
}

describe('getByCodes', () => {
  beforeEach(async () => {
    await write([
      fixtureLine('0030000010402'),
      fixtureLine('01723380'),
      fixtureLine('3175681026650'),
    ]);
  });

  it('returns the stored document of a barcode the store holds, with its row’s record version', async () => {
    const docs = await getByCodes(store, ['3175681026650']);
    expect([...docs.keys()]).toEqual(['3175681026650']);
    expect(docs.get('3175681026650')).toEqual({
      doc: buildMirrorRecord(fixtureLine('3175681026650'))?.doc,
      recordVersion: 1,
    });
  });

  it('reads each row’s own record version, as a reload leaves rows of two versions side by side', async () => {
    await write([fixtureLine('0030000010402')], 2);

    const docs = await getByCodes(store, ['0030000010402', '3175681026650', '01723380']);

    expect(
      Object.fromEntries([...docs].map(([code, stored]) => [code, stored.recordVersion])),
    ).toEqual({ '0030000010402': 2, '3175681026650': 1, '01723380': 1 });
  });

  it('has no entry for a barcode the store lacks, beside a hit', async () => {
    const docs = await getByCodes(store, ['4006381333931', '3175681026650']);
    expect(docs.has('4006381333931')).toBe(false);
    expect([...docs.keys()]).toEqual(['3175681026650']);
  });

  it('finds a code given with fewer or more leading zeros than the store keeps, keyed as given', async () => {
    const docs = await getByCodes(store, ['030000010402', '30000010402', '0000001723380']);
    expect([...docs.keys()]).toEqual(['030000010402', '30000010402', '0000001723380']);
    expect(docs.get('030000010402')?.doc.code).toBe('0030000010402');
    expect(docs.get('30000010402')?.doc.code).toBe('0030000010402');
    // A 13-digit code starting 00000 is the EAN-8 it pads.
    expect(docs.get('0000001723380')?.doc.code).toBe('01723380');
  });

  it('accepts duplicate inputs, a miss among them', async () => {
    const docs = await getByCodes(store, [
      '01723380',
      '01723380',
      '9999999999994',
      '9999999999994',
    ]);
    expect([...docs.keys()]).toEqual(['01723380']);
    expect(docs.get('01723380')?.doc.code).toBe('01723380');
  });

  it('returns an empty map for no barcodes', async () => {
    expect((await getByCodes(store, [])).size).toBe(0);
  });
});

describe('searchByTags filters', () => {
  beforeEach(async () => {
    await write([
      line('4000000000001', {
        popularity_key: 60,
        countries_tags: ['en:filterland'],
        labels_tags: ['en:organic', 'en:fair-trade'],
        allergens_tags: ['en:milk'],
      }),
      line('4000000000002', {
        popularity_key: 50,
        countries_tags: ['en:filterland'],
        labels_tags: ['en:organic'],
      }),
      line('4000000000003', {
        popularity_key: 40,
        countries_tags: ['en:filterland'],
        labels_tags: ['en:fair-trade', 'en:organic', 'en:vegan'],
        allergens_tags: ['en:nuts'],
      }),
      line('4000000000004', {
        popularity_key: 30,
        countries_tags: ['en:filterland', 'en:elsewhere'],
        labels_tags: ['en:vegan'],
        traces_tags: ['en:milk'],
      }),
      line('4000000000005', {
        popularity_key: 20,
        countries_tags: ['en:filterland', 'en:elsewhere'],
        labels_tags: ['en:organic'],
        allergens_tags: ['en:milk', 'en:nuts'],
      }),
    ]);
  });

  it('ANDs two labels', async () => {
    expect(
      await search([
        { facet: 'labels', value: 'en:fair-trade' },
        { facet: 'labels', value: 'en:vegan' },
      ]),
    ).toEqual({ codes: ['4000000000003'], total: 1 });
    expect(
      await search([
        { facet: 'labels', value: 'en:organic' },
        { facet: 'labels', value: 'en:fair-trade' },
      ]),
    ).toEqual({ codes: ['4000000000001', '4000000000003'], total: 2 });
  });

  it('ANDs includes across facets, whichever is listed first', async () => {
    const organic: MirrorTagFilter = { facet: 'labels', value: 'en:organic' };
    const elsewhere: MirrorTagFilter = { facet: 'countries', value: 'en:elsewhere' };
    const expected = { codes: ['4000000000005'], total: 1 };
    expect(await search([organic, elsewhere])).toEqual(expected);
    expect(await search([elsewhere, organic])).toEqual(expected);
  });

  it('answers a total of 0 for stored includes no product carries together', async () => {
    expect(
      await search([
        { facet: 'labels', value: 'en:fair-trade' },
        { facet: 'countries', value: 'en:elsewhere' },
      ]),
    ).toEqual({ codes: [], total: 0 });
  });

  it('treats an exclusion as the tag being absent from that facet', async () => {
    expect(
      await search([{ facet: 'labels', value: 'en:organic' }], {
        exclude: [{ facet: 'allergens', value: 'en:milk' }],
      }),
    ).toEqual({ codes: ['4000000000002', '4000000000003'], total: 2 });
    // 4000000000004 lists milk as a trace, not an allergen, so only the trace exclusion drops it.
    expect(
      await search([{ facet: 'countries', value: 'en:filterland' }], {
        exclude: [
          { facet: 'allergens', value: 'en:milk' },
          { facet: 'allergens', value: 'en:nuts' },
        ],
      }),
    ).toEqual({ codes: ['4000000000002', '4000000000004'], total: 2 });
    expect(
      await search([{ facet: 'countries', value: 'en:filterland' }], {
        exclude: [{ facet: 'traces', value: 'en:milk' }],
      }),
    ).toEqual({
      codes: ['4000000000001', '4000000000002', '4000000000003', '4000000000005'],
      total: 4,
    });
  });

  it('serves exclusions alone over every stored product', async () => {
    expect(await search([], { exclude: [{ facet: 'allergens', value: 'en:milk' }] })).toEqual({
      codes: ['4000000000002', '4000000000003', '4000000000004'],
      total: 3,
    });
  });

  it('answers an include no stored product carries with a total of 0, reading no posting', async () => {
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [
        { facet: 'labels', value: 'en:organic' },
        { facet: 'labels', value: 'en:not-a-label-anyone-uses' },
      ],
      exclude: [{ facet: 'allergens', value: 'en:milk' }],
      page: 1,
      pageSize: 50,
    });
    expect(page).toEqual({ total: 0, docs: [] });
    expect(statements.filter((sql) => sql.includes('product_tags'))).toEqual([]);

    // The same reader reads postings once every include is stored.
    await searchByTags(reader, {
      include: [{ facet: 'labels', value: 'en:organic' }],
      exclude: [],
      page: 1,
      pageSize: 50,
    });
    expect(statements.some((sql) => sql.includes('product_tags'))).toBe(true);
  });

  it('drops an exclusion no stored product carries', async () => {
    expect(
      await search([{ facet: 'labels', value: 'en:organic' }], {
        exclude: [{ facet: 'allergens', value: 'en:not-an-allergen-anyone-declares' }],
      }),
    ).toEqual({
      codes: ['4000000000001', '4000000000002', '4000000000003', '4000000000005'],
      total: 4,
    });
  });

  it('pages a search with several includes and an exclusion, to and past its last page', async () => {
    const include: MirrorTagFilter[] = [
      { facet: 'countries', value: 'en:filterland' },
      { facet: 'labels', value: 'en:organic' },
    ];
    const exclude: MirrorTagFilter[] = [{ facet: 'allergens', value: 'en:nuts' }];
    const pages = await Promise.all(
      [1, 2, 3].map((page) => search(include, { exclude, page, pageSize: 1 })),
    );
    expect(pages).toEqual([
      { codes: ['4000000000001'], total: 2 },
      { codes: ['4000000000002'], total: 2 },
      { codes: [], total: 2 },
    ]);
  });
});

describe('searchByTags any-of lists', () => {
  const grade = (value: string | readonly string[]): MirrorTagFilter => ({
    facet: 'nutrition_grades',
    value,
  });
  const gradeland: MirrorTagFilter = { facet: 'countries', value: 'en:gradeland' };

  beforeEach(async () => {
    await write([
      line('6000000000001', {
        popularity_key: 60,
        countries_tags: ['en:gradeland'],
        nutrition_grades_tags: ['a'],
      }),
      line('6000000000002', {
        popularity_key: 50,
        countries_tags: ['en:gradeland'],
        nutrition_grades_tags: ['b'],
      }),
      line('6000000000003', {
        popularity_key: 40,
        countries_tags: ['en:gradeland'],
        nutrition_grades_tags: ['c'],
      }),
      // Two grades on one product: the store indexes what the export holds.
      line('6000000000004', {
        popularity_key: 30,
        countries_tags: ['en:gradeland'],
        nutrition_grades_tags: ['a', 'b'],
      }),
      line('6000000000005', { popularity_key: 20, nutrition_grades_tags: ['e'] }),
      line('6000000000006', { popularity_key: 10, countries_tags: ['en:gradeland'] }),
    ]);
  });

  it('matches a product carrying any value of a list, one carrying two of them once', async () => {
    expect(await search([grade(['a', 'b'])])).toEqual({
      codes: ['6000000000001', '6000000000002', '6000000000004'],
      total: 3,
    });
  });

  it('totals a list of values no product shares as their single totals summed', async () => {
    const b = await search([grade('b')]);
    const c = await search([grade('c')]);
    const either = await search([grade(['b', 'c'])]);
    expect(either).toEqual({
      codes: ['6000000000002', '6000000000003', '6000000000004'],
      total: 3,
    });
    expect(either.total).toBe(b.total + c.total);
  });

  it.each([
    ['a one-value list', ['a']],
    ['a list repeating one value', ['a', 'a']],
  ])('serves %s exactly as that value, through the same statements', async (_label, value) => {
    const scalar = await recordingReader();
    const listed = await recordingReader();
    const run = (reader: { raw: () => Promise<SqliteHandle> }, filter: MirrorTagFilter) =>
      searchByTags(reader, {
        include: [filter, gradeland],
        exclude: [],
        page: 1,
        pageSize: 50,
      });
    const expected = await run(scalar.reader, grade('a'));
    const page = await run(listed.reader, grade(value));
    expect(page.docs.map((doc) => doc.code)).toEqual(['6000000000001', '6000000000004']);
    expect(page).toEqual(expected);
    expect(listed.statements).toEqual(scalar.statements);
  });

  it('treats an empty list as no filter, as an include or an exclusion', async () => {
    const everyGradeland = {
      codes: ['6000000000001', '6000000000002', '6000000000003', '6000000000004', '6000000000006'],
      total: 5,
    };
    expect(await search([grade([]), gradeland])).toEqual(everyGradeland);
    expect(await search([gradeland], { exclude: [grade([])] })).toEqual(everyGradeland);
    expect(await search([grade([])])).toEqual(await search([]));
    expect((await search([grade([])])).total).toBe(6);
  });

  it('takes from an include list the values an exclusion on its facet names', async () => {
    expect(await search([grade(['a', 'b'])], { exclude: [grade('b')] })).toEqual({
      codes: ['6000000000001'],
      total: 1,
    });
  });

  it('excludes a product carrying any value of an exclusion list, as one exclusion per value', async () => {
    const listed = await recordingReader();
    const each = await recordingReader();
    const run = (reader: { raw: () => Promise<SqliteHandle> }, exclude: MirrorTagFilter[]) =>
      searchByTags(reader, { include: [gradeland], exclude, page: 1, pageSize: 50 });
    const page = await run(listed.reader, [grade(['a', 'b'])]);
    expect(page.docs.map((doc) => doc.code)).toEqual(['6000000000003', '6000000000006']);
    expect(page.total).toBe(2);
    expect(page).toEqual(await run(each.reader, [grade('a'), grade('b')]));
    expect(listed.statements).toEqual(each.statements);
  });

  it('drops the values of a list no product carries, and answers 0 for a list holding none', async () => {
    expect(await search([grade(['a', 'not-a-grade'])])).toEqual({
      codes: ['6000000000001', '6000000000004'],
      total: 2,
    });

    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [grade(['not-a-grade', 'nor-this']), gradeland],
      exclude: [grade('c')],
      page: 1,
      pageSize: 50,
    });
    expect(page).toEqual({ total: 0, docs: [] });
    expect(statements.filter((sql) => sql.includes('product_tags'))).toEqual([]);
  });

  it('reads a list given twice, in either order, once', async () => {
    const once = await recordingReader();
    const twice = await recordingReader();
    const run = (reader: { raw: () => Promise<SqliteHandle> }, include: MirrorTagFilter[]) =>
      searchByTags(reader, { include, exclude: [], page: 1, pageSize: 50 });
    const page = await run(twice.reader, [grade(['a', 'b']), grade(['b', 'a'])]);
    expect(page.total).toBe(3);
    expect(page).toEqual(await run(once.reader, [grade(['a', 'b'])]));
    expect(twice.statements).toEqual(once.statements);
  });
});

describe('searchByTags on the live fixtures', () => {
  beforeEach(async () => {
    await write(FIXTURE_LINES);
  });

  it('finds a brand by its canonical slug under the stored xx: form', async () => {
    expect(await search([{ facet: 'brands', value: 'betty-crocker' }])).toEqual({
      // Both have popularity_key 1, so code breaks the tie.
      codes: ['0016000289994', '0016000490949'],
      total: 2,
    });
  });

  it('finds NOVA group 4 by its digit, counting every product stored with it', async () => {
    const nova4 = FIXTURE_LINES.filter((fixture) =>
      (fixture.nova_groups_tags as string[] | undefined)?.includes(
        'en:4-ultra-processed-food-and-drink-products',
      ),
    ).map((fixture) => fixture.code as string);
    const found = await search([{ facet: 'nova_groups', value: '4' }]);
    expect(found.total).toBe(16);
    expect(nova4).toHaveLength(16);
    expect([...found.codes].sort()).toEqual([...nova4].sort());
    expect(found.codes[0]).toBe('7613035530799');
  });
});

describe('searchByTags order and paging', () => {
  const sortland: MirrorTagFilter[] = [{ facet: 'countries', value: 'en:sortland' }];

  beforeEach(async () => {
    // Written out of code order; each key has a tie, and each key is missing from some product.
    await write([
      line('3000000000003', {
        countries_tags: ['en:sortland'],
        popularity_key: 50,
        created_t: 300,
        last_modified_t: 700,
      }),
      line('3000000000001', {
        countries_tags: ['en:sortland'],
        popularity_key: 50,
        unique_scans_n: 7,
        last_modified_t: 900,
      }),
      line('3000000000005', {
        countries_tags: ['en:sortland'],
        unique_scans_n: 7,
        created_t: 300,
        last_modified_t: 900,
      }),
      line('3000000000002', {
        countries_tags: ['en:sortland'],
        popularity_key: 90,
        unique_scans_n: 2,
        created_t: 100,
      }),
      line('3000000000004', {
        countries_tags: ['en:sortland'],
        popularity_key: 10,
        created_t: 300,
        last_modified_t: 700,
      }),
    ]);
  });

  it.each([
    [
      'popularity_key',
      ['3000000000002', '3000000000001', '3000000000003', '3000000000004', '3000000000005'],
    ],
    [
      'unique_scans_n',
      ['3000000000001', '3000000000005', '3000000000002', '3000000000003', '3000000000004'],
    ],
    [
      'created_t',
      ['3000000000003', '3000000000004', '3000000000005', '3000000000002', '3000000000001'],
    ],
    [
      'last_modified_t',
      ['3000000000001', '3000000000005', '3000000000003', '3000000000004', '3000000000002'],
    ],
  ] as const)(
    'sorts by %s descending, missing values last, code ascending on ties',
    async (sortBy, codes) => {
      expect(await search(sortland, { sortBy })).toEqual({ codes, total: 5 });
    },
  );

  it('defaults to popularity_key', async () => {
    expect((await search(sortland)).codes).toEqual([
      '3000000000002',
      '3000000000001',
      '3000000000003',
      '3000000000004',
      '3000000000005',
    ]);
  });

  it('serves the first, a middle, and the last page with the exact total, and an empty page past it', async () => {
    const pages = await Promise.all(
      [1, 2, 3, 4, 40].map((page) => search(sortland, { page, pageSize: 2 })),
    );
    expect(pages).toEqual([
      { codes: ['3000000000002', '3000000000001'], total: 5 },
      { codes: ['3000000000003', '3000000000004'], total: 5 },
      { codes: ['3000000000005'], total: 5 },
      { codes: [], total: 5 },
      { codes: [], total: 5 },
    ]);
  });

  it('pages a sort with ties and missing values without repeating or skipping a product', async () => {
    const pages = await Promise.all(
      [1, 2, 3].map((page) => search(sortland, { sortBy: 'created_t', page, pageSize: 2 })),
    );
    expect(pages.map((page) => page.codes)).toEqual([
      ['3000000000003', '3000000000004'],
      ['3000000000005', '3000000000002'],
      ['3000000000001'],
    ]);
  });

  it('returns each document as the builder projected it', async () => {
    const page = await searchByTags(store, {
      include: sortland,
      exclude: [],
      page: 1,
      pageSize: 1,
    });
    expect(page.docs).toEqual([
      buildMirrorRecord(
        line('3000000000002', {
          countries_tags: ['en:sortland'],
          popularity_key: 90,
          unique_scans_n: 2,
          created_t: 100,
        }),
      )?.doc,
    ]);
  });
});

describe('searchByTags cuts', () => {
  const SORT_KEYS = ['popularity_key', 'unique_scans_n', 'created_t', 'last_modified_t'] as const;
  type SortKey = (typeof SORT_KEYS)[number];

  // 240 products: `en:common` on two in three, `en:pair` on every other one, `en:few` on one in
  // eight (each also `en:pair`), `en:rare` on two, the allergen `en:x` on one in five. Every sort key
  // has ties and products lacking it.
  const lines: Line[] = Array.from({ length: 240 }, (_, i) =>
    line(`5${String(i).padStart(12, '0')}`, {
      labels_tags: [
        ...(i % 3 !== 0 ? ['en:common'] : []),
        ...(i % 2 === 0 ? ['en:pair'] : []),
        ...(i % 8 === 2 ? ['en:few'] : []),
        ...(i === 17 || i === 200 ? ['en:rare'] : []),
      ],
      ...(i % 5 === 0 && { allergens_tags: ['en:x'] }),
      ...(i % 11 !== 0 && { popularity_key: (i * 37) % 13 }),
      ...(i % 4 !== 0 && { unique_scans_n: (i * 7) % 5 }),
      created_t: 1_000 + (i % 9),
      ...(i % 6 !== 0 && { last_modified_t: 2_000 + ((i * 11) % 17) }),
    }),
  );
  const labeled = (label: string) => (l: Line) => (l.labels_tags as string[]).includes(label);
  const common: MirrorTagFilter = { facet: 'labels', value: 'en:common' };
  const pair: MirrorTagFilter = { facet: 'labels', value: 'en:pair' };
  const rare: MirrorTagFilter = { facet: 'labels', value: 'en:rare' };
  const few: MirrorTagFilter = { facet: 'labels', value: 'en:few' };
  const x: MirrorTagFilter = { facet: 'allergens', value: 'en:x' };
  const hasX = (l: Line) => l.allergens_tags !== undefined;
  /** An any-of list of labels, and the lines it selects. */
  const anyOf = (...labels: string[]): MirrorTagFilter => ({ facet: 'labels', value: labels });
  const labeledAny =
    (...labels: string[]) =>
    (l: Line) =>
      labels.some((label) => labeled(label)(l));

  /** The codes `keep` selects, in search order, computed from the lines alone. */
  function expected(keep: (l: Line) => boolean, sortBy: SortKey): string[] {
    const key = (l: Line) => l[sortBy] as number | undefined;
    return lines
      .filter(keep)
      .sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        if (ka !== kb) {
          if (ka === undefined) return 1;
          if (kb === undefined) return -1;
          return kb - ka;
        }
        return String(a.code) < String(b.code) ? -1 : 1;
      })
      .map((l) => String(l.code));
  }

  const cases: [string, MirrorTagFilter[], MirrorTagFilter[], (l: Line) => boolean][] = [
    ['a common include', [common], [], labeled('en:common')],
    [
      'two includes and an exclusion',
      [common, pair],
      [x],
      (l) => labeled('en:common')(l) && labeled('en:pair')(l) && !hasX(l),
    ],
    ['a rare include', [rare], [], labeled('en:rare')],
    ['an exclusion alone', [], [x], (l) => !hasX(l)],
    // Overlapping exclusions, one shorter and one longer than what they exclude from.
    [
      'an include less two overlapping exclusions',
      [pair],
      [x, common],
      (l) => labeled('en:pair')(l) && !hasX(l) && !labeled('en:common')(l),
    ],
    [
      'a rare include less a common exclusion',
      [rare],
      [common],
      (l) => labeled('en:rare')(l) && !labeled('en:common')(l),
    ],
    ['two overlapping exclusions alone', [], [x, pair], (l) => !hasX(l) && !labeled('en:pair')(l)],
    // A driver near one include's size and the exclusion's, and far below the other include's.
    [
      'three includes of unlike sizes and an exclusion',
      [common, few, pair],
      [x],
      (l) => labeled('en:common')(l) && labeled('en:few')(l) && labeled('en:pair')(l) && !hasX(l),
    ],
    // Any-of lists, driving, sought, merged beside, and excluded.
    ['a list alone', [anyOf('en:rare', 'en:few')], [], labeledAny('en:rare', 'en:few')],
    // Every `en:few` product is also `en:pair`: each is counted once.
    [
      'a list of overlapping values less an exclusion',
      [anyOf('en:few', 'en:pair')],
      [x],
      (l) => labeledAny('en:few', 'en:pair')(l) && !hasX(l),
    ],
    // Rare enough that subtracting it from the include's postings would read least, but a list's
    // summed postings count the 30 products carrying both values twice: the stream counts it.
    [
      'a list of overlapping values less a rare exclusion',
      [anyOf('en:few', 'en:pair')],
      [rare],
      (l) => labeledAny('en:few', 'en:pair')(l) && !labeled('en:rare')(l),
    ],
    [
      'a list, an include merged with it, and an exclusion',
      [anyOf('en:rare', 'en:few'), pair],
      [x],
      (l) => labeledAny('en:rare', 'en:few')(l) && labeled('en:pair')(l) && !hasX(l),
    ],
    [
      'an include and a list it seeks',
      [few, anyOf('en:common', 'en:rare')],
      [],
      (l) => labeled('en:few')(l) && labeledAny('en:common', 'en:rare')(l),
    ],
    [
      'an include less an exclusion list',
      [pair],
      [anyOf('en:rare', 'en:few')],
      (l) => labeled('en:pair')(l) && !labeledAny('en:rare', 'en:few')(l),
    ],
    [
      'an exclusion list alone',
      [],
      [anyOf('en:common', 'en:rare')],
      (l) => !labeledAny('en:common', 'en:rare')(l),
    ],
  ];

  /** Drops `names`, by default every index `ensureSortIndexes` builds. */
  async function dropIndexes(
    names: readonly string[] = [...SORT_COLUMNS.map(sortIndexName), SORT_KEYS_INDEX],
  ): Promise<void> {
    const handle = await store.raw();
    for (const name of names) handle.exec(`DROP INDEX ${name}`);
  }

  /** The statement that cut the page: the one reading documents. */
  const pageStatement = (statements: string[]) =>
    statements.find((sql) => sql.includes('SELECT p.doc FROM')) ?? '';

  /** The statements that counted matches: every count but one tag's postings and every product. */
  const matchCounts = (statements: string[]) =>
    statements.filter(
      (sql) =>
        sql.startsWith('SELECT COUNT(*) AS n FROM') &&
        sql !== 'SELECT COUNT(*) AS n FROM product_tags WHERE tag_id = ?' &&
        sql !== 'SELECT COUNT(*) AS n FROM products',
    );

  /** What `EXPLAIN QUERY PLAN` reports for `sql`, each parameter bound to 0. */
  async function queryPlan(sql: string): Promise<string[]> {
    const handle = await store.raw();
    return handle
      .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from(sql.matchAll(/\?/g), () => 0))
      .map((row) => row.detail);
  }

  const POSTINGS_OF = 'SELECT code FROM product_tags WHERE tag_id = ?';

  beforeEach(async () => {
    await write(lines);
    await ensureSortIndexes(await store.raw());
  });

  it('walks the sort index forward for an early page of a common include', async () => {
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [common],
      exclude: [],
      page: 2,
      pageSize: 10,
    });
    const order = expected(labeled('en:common'), 'popularity_key');
    expect(page).toMatchObject({ total: order.length });
    expect(page.docs.map((doc) => doc.code)).toEqual(order.slice(10, 20));
    const cut = pageStatement(statements);
    expect(cut).toContain('INDEXED BY products_popularity_key_sort');
    expect(cut).toContain('ORDER BY w.popularity_key DESC NULLS LAST, w.code');
  });

  it('walks the sort index from its end for a page past the middle, short last page included', async () => {
    const order = expected(labeled('en:common'), 'created_t');
    const last = Math.ceil(order.length / 15);
    for (const pageNumber of [last - 1, last]) {
      const { reader, statements } = await recordingReader();
      const page = await searchByTags(reader, {
        include: [common],
        exclude: [],
        page: pageNumber,
        pageSize: 15,
        sortBy: 'created_t',
      });
      expect(page.docs.map((doc) => doc.code)).toEqual(
        order.slice((pageNumber - 1) * 15, pageNumber * 15),
      );
      const cut = pageStatement(statements);
      expect(cut).toContain('INDEXED BY products_created_t_sort');
      expect(cut).toContain('ORDER BY w.created_t ASC NULLS FIRST, w.code DESC');
    }
    expect(order.length % 15).not.toBe(0);
  });

  it('reads the postings of an include few products carry, their sort keys from the sort-keys index', async () => {
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [rare],
      exclude: [],
      page: 1,
      pageSize: 10,
    });
    expect(page).toMatchObject({ total: 2 });
    expect(page.docs.map((doc) => doc.code)).toEqual(
      expected(labeled('en:rare'), 'popularity_key'),
    );
    expect(pageStatement(statements)).toContain(
      'FROM product_tags d CROSS JOIN products w INDEXED BY products_code_sort_keys ON w.code = d.code',
    );
  });

  it('reads sort keys from the product rows on a store that lacks the sort-keys index', async () => {
    await dropIndexes([SORT_KEYS_INDEX]);
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [rare, common],
      exclude: [x],
      page: 1,
      pageSize: 10,
    });
    expect(page.docs.map((doc) => doc.code)).toEqual(
      expected(
        (l) => labeled('en:rare')(l) && labeled('en:common')(l) && !hasX(l),
        'popularity_key',
      ),
    );
    expect(pageStatement(statements)).toContain(
      'FROM product_tags d CROSS JOIN products w ON w.code = d.code',
    );
  });

  it('walks the sort index for a search no include drives', async () => {
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, { include: [], exclude: [x], page: 3, pageSize: 10 });
    expect(page.docs.map((doc) => doc.code)).toEqual(
      expected((l) => !hasX(l), 'popularity_key').slice(20, 30),
    );
    expect(pageStatement(statements)).toContain('INDEXED BY products_popularity_key_sort');
  });

  it('reads postings, or scans with no include, on a store that lacks the sort index', async () => {
    await dropIndexes([sortIndexName('popularity_key')]);
    const driven = await recordingReader();
    const page = await searchByTags(driven.reader, {
      include: [common],
      exclude: [],
      page: 1,
      pageSize: 10,
    });
    expect(page.docs.map((doc) => doc.code)).toEqual(
      expected(labeled('en:common'), 'popularity_key').slice(0, 10),
    );
    expect(pageStatement(driven.statements)).toContain(
      'FROM product_tags d CROSS JOIN products w INDEXED BY products_code_sort_keys',
    );

    const undriven = await recordingReader();
    const unordered = await searchByTags(undriven.reader, {
      include: [],
      exclude: [x],
      page: 1,
      pageSize: 10,
    });
    expect(unordered.docs.map((doc) => doc.code)).toEqual(
      expected((l) => !hasX(l), 'popularity_key').slice(0, 10),
    );
    const cut = pageStatement(undriven.statements);
    expect(cut).toContain('FROM products w');
    expect(cut).not.toContain('INDEXED BY');
  });

  it('counts includes and an exclusion of like sizes in one ordered pass over their postings', async () => {
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [common, pair],
      exclude: [x],
      page: 1,
      pageSize: 10,
    });
    const keep = (l: Line) => labeled('en:common')(l) && labeled('en:pair')(l) && !hasX(l);
    expect(page.total).toBe(expected(keep, 'popularity_key').length);
    // pair (120) drives; common (160) and x (48) are merged with it, none sought.
    const counts = matchCounts(statements);
    expect(counts).toEqual([
      `SELECT COUNT(*) AS n FROM (${POSTINGS_OF} INTERSECT ${POSTINGS_OF} EXCEPT ${POSTINGS_OF}) AS d`,
    ]);
    const plan = await queryPlan(counts[0] as string);
    expect(plan).toEqual(expect.arrayContaining(['MERGE (INTERSECT)', 'MERGE (EXCEPT)']));
    expect(plan.join('\n')).not.toMatch(/TEMP B-TREE|SCAN product_tags/);
  });

  it('seeks an include whose postings outnumber the driving one’s many times over', async () => {
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [common, rare],
      exclude: [],
      page: 1,
      pageSize: 10,
    });
    expect(page.total).toBe(
      lines.filter((l) => labeled('en:common')(l) && labeled('en:rare')(l)).length,
    );
    // rare (2) drives; common (160) is sought once per rare posting, never read whole.
    expect(matchCounts(statements)).toEqual([
      'SELECT COUNT(*) AS n FROM product_tags d WHERE d.tag_id = ? AND EXISTS (SELECT 1 FROM product_tags i WHERE i.tag_id = ? AND i.code = d.code)',
    ]);
  });

  it('merges the filters near the driving include’s size and seeks the rest, in one count', async () => {
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [common, few, pair],
      exclude: [x],
      page: 1,
      pageSize: 10,
    });
    const keep = (l: Line) =>
      labeled('en:common')(l) && labeled('en:few')(l) && labeled('en:pair')(l) && !hasX(l);
    expect(page.total).toBe(lines.filter(keep).length);
    // few (30) drives; pair (120) and x (48) are merged, common (160) sought.
    expect(matchCounts(statements)).toEqual([
      `SELECT COUNT(*) AS n FROM (${POSTINGS_OF} INTERSECT ${POSTINGS_OF} EXCEPT ${POSTINGS_OF}) AS d WHERE EXISTS (SELECT 1 FROM product_tags i WHERE i.tag_id = ? AND i.code = d.code)`,
    ]);
  });

  it('counts what exclusions take away as one union of their postings', async () => {
    const included = await recordingReader();
    const less = await searchByTags(included.reader, {
      include: [pair],
      exclude: [x, common],
      page: 1,
      pageSize: 10,
    });
    expect(less.total).toBe(
      lines.filter((l) => labeled('en:pair')(l) && !hasX(l) && !labeled('en:common')(l)).length,
    );
    // pair's 120 postings, less x ∪ common within them.
    expect(matchCounts(included.statements)).toEqual([
      `SELECT COUNT(*) AS n FROM (${POSTINGS_OF} UNION ${POSTINGS_OF} INTERSECT ${POSTINGS_OF}) AS d`,
    ]);

    // The union reaches every posting of its lists: common (160) is merged with rare ∪ x (50),
    // though five times rare's 2 alone would have it sought.
    const wide = await recordingReader();
    const fewer = await searchByTags(wide.reader, {
      include: [common],
      exclude: [rare, x],
      page: 1,
      pageSize: 10,
    });
    expect(fewer.total).toBe(
      lines.filter((l) => labeled('en:common')(l) && !labeled('en:rare')(l) && !hasX(l)).length,
    );
    expect(matchCounts(wide.statements)).toEqual([
      `SELECT COUNT(*) AS n FROM (${POSTINGS_OF} UNION ${POSTINGS_OF} INTERSECT ${POSTINGS_OF}) AS d`,
    ]);

    const alone = await recordingReader();
    const rest = await searchByTags(alone.reader, {
      include: [],
      exclude: [x, pair],
      page: 1,
      pageSize: 10,
    });
    expect(rest.total).toBe(lines.filter((l) => !hasX(l) && !labeled('en:pair')(l)).length);
    expect(matchCounts(alone.statements)).toEqual([
      `SELECT COUNT(*) AS n FROM (${POSTINGS_OF} UNION ${POSTINGS_OF}) AS d`,
    ]);
    expect(await queryPlan(matchCounts(alone.statements)[0] as string)).toContain('MERGE (UNION)');
  });

  it('counts an include few products carry directly, seeking an exclusion far larger than it', async () => {
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [rare],
      exclude: [common],
      page: 1,
      pageSize: 10,
    });
    expect(page.total).toBe(
      lines.filter((l) => labeled('en:rare')(l) && !labeled('en:common')(l)).length,
    );
    expect(matchCounts(statements)).toEqual([
      'SELECT COUNT(*) AS n FROM product_tags d WHERE d.tag_id = ? AND NOT EXISTS (SELECT 1 FROM product_tags x WHERE x.tag_id = ? AND x.code = d.code)',
    ]);
  });

  it('walks a page when the postings cut would seek an include once per driving posting', async () => {
    // few (30) drives and common (160) is sought for each of its postings, which costs more than a
    // walk past 4 of the 20 matches spread through 240 products.
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [few, common],
      exclude: [],
      page: 1,
      pageSize: 4,
    });
    const order = expected(
      (l) => labeled('en:few')(l) && labeled('en:common')(l),
      'popularity_key',
    );
    expect(page).toMatchObject({ total: 20 });
    expect(page.docs.map((doc) => doc.code)).toEqual(order.slice(0, 4));
    expect(pageStatement(statements)).toContain('INDEXED BY products_popularity_key_sort');
  });

  it('cuts a page from the merged postings of two includes when a walk would pass many products', async () => {
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [pair, few],
      exclude: [],
      page: 1,
      pageSize: 20,
    });
    const order = expected((l) => labeled('en:pair')(l) && labeled('en:few')(l), 'popularity_key');
    expect(page).toMatchObject({ total: order.length });
    expect(page.docs.map((doc) => doc.code)).toEqual(order.slice(0, 20));
    expect(pageStatement(statements)).toContain(
      `FROM (${POSTINGS_OF} INTERSECT ${POSTINGS_OF}) AS d CROSS JOIN products w INDEXED BY products_code_sort_keys ON w.code = d.code`,
    );
  });

  it('walks that page instead on a store lacking the sort-keys index, whose sort keys cost a product row each', async () => {
    // The same 30 matches: their merged postings cost 30 entries and a walk to 20 passes 160. Sort
    // keys from the sort-keys index bring the postings cut to 75; from product rows, to 330.
    await dropIndexes([SORT_KEYS_INDEX]);
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [pair, few],
      exclude: [],
      page: 1,
      pageSize: 20,
    });
    const order = expected((l) => labeled('en:pair')(l) && labeled('en:few')(l), 'popularity_key');
    expect(page).toMatchObject({ total: 30 });
    expect(order).toHaveLength(30);
    expect(page.docs.map((doc) => doc.code)).toEqual(order.slice(0, 20));
    const cut = pageStatement(statements);
    expect(cut).toContain('FROM products w INDEXED BY products_popularity_key_sort');
    expect(cut).not.toContain('CROSS JOIN');
  });

  /**
   * Serves every page by popularity through one recording reader, the one past the last included,
   * each checked against the lines; returns the statements that served them and the total.
   */
  async function everyPage(
    include: MirrorTagFilter[],
    keep: (l: Line) => boolean,
    pageSize: number,
  ): Promise<{ cuts: string[]; statements: string[]; total: number }> {
    const { reader, statements } = await recordingReader();
    const order = expected(keep, 'popularity_key');
    const last = Math.ceil(order.length / pageSize);
    for (let pageNumber = 1; pageNumber <= last + 1; pageNumber++) {
      const page = await searchByTags(reader, { include, exclude: [], page: pageNumber, pageSize });
      expect(page.total).toBe(order.length);
      expect(page.docs.map((doc) => doc.code)).toEqual(
        order.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
      );
    }
    const cuts = statements.filter((sql) => sql.includes('SELECT p.doc FROM'));
    return { cuts, statements, total: order.length };
  }

  it('cuts the pages of a driving list both ways, reading its values’ postings as one union', async () => {
    const { cuts, statements, total } = await everyPage(
      [anyOf('en:rare', 'en:few')],
      labeledAny('en:rare', 'en:few'),
      7,
    );
    expect(total).toBe(32);
    // A walk serves the pages nearest either end of the 32 matches, the postings those between.
    expect(
      cuts.filter((sql) =>
        sql.includes(
          'FROM products w INDEXED BY products_popularity_key_sort WHERE EXISTS (SELECT 1 FROM product_tags i WHERE i.tag_id IN (?, ?) AND i.code = w.code)',
        ),
      ),
    ).toHaveLength(2);
    expect(
      cuts.filter((sql) =>
        sql.includes(
          `FROM (${POSTINGS_OF} UNION ${POSTINGS_OF}) AS d CROSS JOIN products w INDEXED BY products_code_sort_keys ON w.code = d.code`,
        ),
      ),
    ).toHaveLength(3);
    const counts = [...new Set(matchCounts(statements))];
    expect(counts).toEqual([
      `SELECT COUNT(*) AS n FROM (${POSTINGS_OF} UNION ${POSTINGS_OF}) AS d`,
    ]);
    const plan = await queryPlan(counts[0] as string);
    expect(plan).toContain('MERGE (UNION)');
    expect(plan.join('\n')).not.toMatch(/TEMP B-TREE|SCAN product_tags/);
  });

  it('cuts the pages of a sought list both ways, seeking its values per driving posting', async () => {
    const sought =
      'EXISTS (SELECT 1 FROM product_tags i WHERE i.tag_id IN (?, ?) AND i.code = d.code)';
    const { cuts, statements, total } = await everyPage(
      [few, anyOf('en:common', 'en:rare')],
      (l) => labeled('en:few')(l) && labeledAny('en:common', 'en:rare')(l),
      4,
    );
    expect(total).toBe(20);
    // few (30) drives; the walk serves the first and last of the five pages.
    expect(
      cuts.filter((sql) =>
        sql.includes(
          'FROM products w INDEXED BY products_popularity_key_sort WHERE EXISTS (SELECT 1 FROM product_tags i WHERE i.tag_id = ? AND i.code = w.code) AND EXISTS (SELECT 1 FROM product_tags i WHERE i.tag_id IN (?, ?) AND i.code = w.code)',
        ),
      ),
    ).toHaveLength(2);
    expect(
      cuts.filter((sql) =>
        sql.includes(
          `FROM product_tags d CROSS JOIN products w INDEXED BY products_code_sort_keys ON w.code = d.code WHERE d.tag_id = ? AND ${sought}`,
        ),
      ),
    ).toHaveLength(3);
    const counts = [...new Set(matchCounts(statements))];
    expect(counts).toEqual([
      `SELECT COUNT(*) AS n FROM product_tags d WHERE d.tag_id = ? AND ${sought}`,
    ]);
    expect((await queryPlan(counts[0] as string)).join('\n')).not.toMatch(
      /TEMP B-TREE|SCAN product_tags/,
    );
  });

  it('seeks a list beside a driving include where a single filter of its size is merged', async () => {
    // few (30) drives, and a filter of up to 150 postings costs less to merge than to seek: pair
    // (120) alone is merged, rare ∪ pair (122) sought.
    const single = await recordingReader();
    await searchByTags(single.reader, { include: [few, pair], exclude: [], page: 1, pageSize: 10 });
    expect(matchCounts(single.statements)).toEqual([
      `SELECT COUNT(*) AS n FROM (${POSTINGS_OF} INTERSECT ${POSTINGS_OF}) AS d`,
    ]);

    const listed = await recordingReader();
    const page = await searchByTags(listed.reader, {
      include: [few, anyOf('en:rare', 'en:pair')],
      exclude: [],
      page: 1,
      pageSize: 10,
    });
    expect(page.total).toBe(30);
    const counts = matchCounts(listed.statements);
    expect(counts).toEqual([
      'SELECT COUNT(*) AS n FROM product_tags d WHERE d.tag_id = ? AND EXISTS (SELECT 1 FROM product_tags i WHERE i.tag_id IN (?, ?) AND i.code = d.code)',
    ]);
    expect((await queryPlan(counts[0] as string)).join('\n')).not.toMatch(
      /TEMP B-TREE|SCAN product_tags/,
    );
  });

  it('merges single filters with a driving list in one ordered pass over their postings', async () => {
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [anyOf('en:rare', 'en:few'), pair],
      exclude: [x],
      page: 1,
      pageSize: 10,
    });
    expect(page.total).toBe(
      lines.filter((l) => labeledAny('en:rare', 'en:few')(l) && labeled('en:pair')(l) && !hasX(l))
        .length,
    );
    // rare ∪ few (32) drives; pair (120) and x (48) are merged with it, none sought.
    const counts = matchCounts(statements);
    expect(counts).toEqual([
      `SELECT COUNT(*) AS n FROM (${POSTINGS_OF} UNION ${POSTINGS_OF} INTERSECT ${POSTINGS_OF} EXCEPT ${POSTINGS_OF}) AS d`,
    ]);
    const plan = await queryPlan(counts[0] as string);
    expect(plan).toEqual(
      expect.arrayContaining(['MERGE (UNION)', 'MERGE (INTERSECT)', 'MERGE (EXCEPT)']),
    );
    expect(plan.join('\n')).not.toMatch(/TEMP B-TREE|SCAN product_tags/);
  });

  it('ranks a list by every value’s postings summed, so a single include below the sum drives it', async () => {
    // few ∪ pair sums to 150 postings, more than x's 48, though few alone (30) carries fewer: x
    // drives, and the list is sought for each x posting.
    const { reader, statements } = await recordingReader();
    const page = await searchByTags(reader, {
      include: [anyOf('en:few', 'en:pair'), x],
      exclude: [],
      page: 1,
      pageSize: 10,
    });
    const keep = (l: Line) => labeledAny('en:few', 'en:pair')(l) && hasX(l);
    expect(page.total).toBe(24);
    expect(page.docs.map((doc) => doc.code)).toEqual(expected(keep, 'popularity_key').slice(0, 10));
    expect(matchCounts(statements)).toEqual([
      'SELECT COUNT(*) AS n FROM product_tags d WHERE d.tag_id = ? AND EXISTS (SELECT 1 FROM product_tags i WHERE i.tag_id IN (?, ?) AND i.code = d.code)',
    ]);
  });

  it.each([
    ['with the sort indexes', false],
    ['without them', true],
  ])(
    'serves every page of every sort key in the order computed from the lines, %s',
    async (_label, drop) => {
      if (drop) await dropIndexes();
      const { reader, statements } = await recordingReader();
      const pageSize = 7;
      for (const sortBy of SORT_KEYS) {
        for (const [, include, exclude, keep] of cases) {
          const order = expected(keep, sortBy);
          const last = Math.ceil(order.length / pageSize);
          for (let pageNumber = 1; pageNumber <= last + 1; pageNumber++) {
            const page = await searchByTags(reader, {
              include,
              exclude,
              page: pageNumber,
              pageSize,
              sortBy,
            });
            expect(page.total).toBe(order.length);
            expect(page.docs.map((doc) => doc.code)).toEqual(
              order.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
            );
          }
        }
      }
      // Each cut ran: the loop covers every side of the plan choice it can reach.
      const cuts = statements.filter((sql) => sql.includes('SELECT p.doc FROM'));
      const ran = (fragment: string) => cuts.some((sql) => sql.includes(fragment));
      expect(ran('CROSS JOIN')).toBe(true);
      expect(ran('INDEXED BY')).toBe(!drop);
      expect(ran('ASC NULLS FIRST')).toBe(true);
      expect(ran('DESC NULLS LAST, w.code')).toBe(true);
      // And each way of counting: merged postings, a union of exclusions, a sought exclusion.
      const counted = (fragment: string) =>
        matchCounts(statements).some((sql) => sql.includes(fragment));
      expect(counted(' INTERSECT ')).toBe(true);
      expect(counted(' UNION ')).toBe(true);
      expect(counted('NOT EXISTS')).toBe(true);
    },
  );
});
