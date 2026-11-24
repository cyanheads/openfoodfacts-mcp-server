/**
 * @fileoverview Tests for the export mirror's record builder (#79). Each live fixture under
 * `tests/fixtures/mirror/` holds one export line and the live `GET /api/v2/product` read of the same
 * barcode (plus the live API v3.5 `nutrition.input_sets` read when that v2 read is prepared-only).
 * `off_get_product` and `off_compare_products` run twice against a URL-keyed fetch stub, once served
 * the doc a mirror read returns for the built record (written to a store and read back by
 * `getByCodes`, dates included) and once the live read, and must answer the same on both surfaces;
 * the accepted divergences of pre-1004 records are reconciled by named assertions first. Unit cases
 * pin the record key, the tag index, the projections of single fields, the serving re-parse, and
 * the tag-value mapping the query layer uses.
 * @module tests/services/mirror/record-builder.test
 */

import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({
    baseUrl: 'https://world.openfoodfacts.org',
    rateLimitProduct: 1000,
    rateLimitSearch: 1000,
    rateLimitTaxonomy: 1000,
  })),
}));

import { offCompareProductsTool } from '@/mcp-server/tools/definitions/compare-products.tool.js';
import { offGetProductTool } from '@/mcp-server/tools/definitions/get-product.tool.js';
import type { MirrorBuilder } from '@/services/mirror/mirror-ingester.js';
import { getByCodes } from '@/services/mirror/mirror-queries.js';
import { openMirrorStore } from '@/services/mirror/mirror-store.js';
import * as recordBuilder from '@/services/mirror/record-builder.js';
import {
  buildMirrorRecord,
  fieldsNewerThan,
  MIRROR_RECORD_VERSION,
  MIRROR_TAG_FACETS,
  type MirrorRecord,
  mirrorTagKey,
  normalizeCodeZeroes,
  toStoredTag,
} from '@/services/mirror/record-builder.js';
import {
  holdsOnlyPreparedFigures,
  readInputSets,
  selectAsSoldSet,
} from '@/services/openfoodfacts/nutrition-sets.js';
import { initOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';

type Json = Record<string, unknown>;

/** One `tests/fixtures/mirror/<schema>-<shape>-<code>.json` capture. */
interface MirrorFixture {
  code: string;
  file: string;
  /** The export line, as `JSON.parse` returns it. */
  line: Json;
  /** The live v2 envelope for the service's product fields plus `code` and `last_modified_t`. */
  live: { status: number; product: Json };
  /** The live v3.5 read, present when the v2 read holds only prepared figures. */
  liveInputSets?: { body: { product: { nutrition: unknown } } };
  /** `le1000`, `1001` … `1004`. */
  schema: string;
  /** `as_sold`, `prepared_only`, `both`, `per_serving`, `per_100ml`, or an extra shape. */
  shape: string;
}

const FIXTURE_DIR = new URL('../../fixtures/mirror/', import.meta.url);

const FIXTURES: readonly MirrorFixture[] = readdirSync(FIXTURE_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => ({
    file,
    ...(JSON.parse(readFileSync(new URL(file, FIXTURE_DIR), 'utf8')) as Omit<
      MirrorFixture,
      'file'
    >),
  }));

function fixture(code: string): MirrorFixture {
  const found = FIXTURES.find((f) => f.code === code);
  if (!found) throw new Error(`No mirror fixture for ${code}.`);
  return found;
}

function record(line: unknown): MirrorRecord {
  const built = buildMirrorRecord(line);
  if (!built) throw new Error('Expected a servable record.');
  return built;
}

/** A record saved before schema 1004, whose live read regenerates its tags from today's taxonomies. */
function isPre1004(f: MirrorFixture): boolean {
  const version = f.line.schema_version;
  return typeof version !== 'number' || version < 1004;
}

/**
 * The tag fields a v2 read of a pre-1004 record regenerates from the current taxonomy, adding the
 * parents introduced since the record was saved. Accepted divergence: the stored tags are a subset
 * of the live ones.
 */
const TAXONOMY_TAG_FIELDS = [
  'categories_tags',
  'labels_tags',
  'origins_tags',
  'allergens_tags',
  'traces_tags',
  'countries_tags',
] as const;

/**
 * The fields a v2 search row carries from the stored doc: `SEARCH_FIELDS` in
 * `openfoodfacts-service.ts` less `last_modified_t` and `created_t`, which a mirror row takes from
 * its product row's columns, never the doc.
 */
const SEARCH_ROW_FIELDS = [
  'code',
  'product_name',
  'brands',
  'quantity',
  'nutriscore_grade',
  'nova_group',
  'ecoscore_grade',
  'categories_tags',
  'completeness',
] as const;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Paths of the objects whose keys are out of sorted order. Product Opener writes canonical JSON,
 * and `off_get_product` lists the nutrients it has no named field for in `nutriments` key order.
 */
function unsortedObjects(value: unknown, path = '$'): string[] {
  if (Array.isArray(value))
    return value.flatMap((entry, i) => unsortedObjects(entry, `${path}[${i}]`));
  if (typeof value !== 'object' || value === null) return [];
  const keys = Object.keys(value);
  const own = keys.join('\n') === [...keys].sort().join('\n') ? [] : [path];
  return [
    ...own,
    ...keys.flatMap((key) => unsortedObjects((value as Json)[key], `${path}.${key}`)),
  ];
}

/** Per taxonomy tag field: what the live read adds to the stored tags, and what it drops. */
function tagGaps(doc: Json, live: Json) {
  return TAXONOMY_TAG_FIELDS.map((field) => {
    const stored = strings(doc[field]);
    const read = strings(live[field]);
    return {
      field,
      liveOnly: read.filter((tag) => !stored.includes(tag)),
      docOnly: stored.filter((tag) => !read.includes(tag)),
      docHas: field in doc,
      liveHas: field in live,
    };
  });
}

/**
 * Fixtures whose live read stopped deriving from their export line, and the fields where it did.
 * Each listed field is served its live value and skips the stored ⊆ live tag check; every other
 * field of the fixture, and every other fixture, is held to the same parity as before.
 *
 * `0070177248499`: its export line and `last_modified_t` (1774628911) are the same in the line and
 * in the 2026-11-08 and 2026-11-24 captures, yet the 11-24 read files it under
 * `en:teas-in-tea-bags` and `en:green-or-white-teas` where the line stores `en:tea-bags`, returns
 * two of its three ingredients under unrecognized ids with new percent estimates (81 / 17.5 / 1.5
 * for 82 / 17 / 1), and drops `en:ingredients-percent-analysis-ok`.
 */
const LIVE_DRIFT: ReadonlyMap<string, { fields: readonly string[]; why: string }> = new Map([
  [
    '0070177248499',
    {
      fields: ['categories_tags', 'ingredients', 'data_quality_tags'],
      why: 'Open Food Facts changed them after the export without moving last_modified_t',
    },
  ],
]);

/** The divergences a fixture shows, for its test title. */
function divergenceNote(f: MirrorFixture): string {
  const drift = LIVE_DRIFT.get(f.code);
  const notes = drift ? [`live ${drift.fields.join(', ')} served: ${drift.why}`] : [];
  if (!isPre1004(f)) return notes.length > 0 ? notes.join('; ') : 'unloosened';
  const doc = record(f.line).doc;
  notes.push(
    ...tagGaps(doc, f.live.product)
      .filter((gap) => gap.liveOnly.length > 0 && !drift?.fields.includes(gap.field))
      .map((gap) => `live adds ${gap.field} ${gap.liveOnly.join(', ')}`),
  );
  if (doc.brands !== f.live.product.brands) {
    notes.push(`live shows brands "${String(f.live.product.brands)}" for "${String(doc.brands)}"`);
  }
  return notes.length > 0 ? notes.join('; ') : 'no divergence';
}

/**
 * The doc a tool run is served, from the built `doc` by default: its `LIVE_DRIFT` fields replaced
 * by the live ones; for a pre-1004 fixture, after asserting the accepted divergences (stored tags ⊆
 * live, the same brands up to case), with the live values in their place.
 */
function reconciledDoc(f: MirrorFixture, doc: Json = record(f.line).doc): Json {
  const live = f.live.product;
  const drift = LIVE_DRIFT.get(f.code)?.fields ?? [];
  const served: Json = Object.fromEntries(
    Object.entries(doc).filter(([field]) => !drift.includes(field)),
  );
  for (const field of drift) if (field in live) served[field] = live[field];
  if (!isPre1004(f)) return served;
  for (const gap of tagGaps(doc, live)) {
    if (drift.includes(gap.field)) continue;
    expect(gap.docOnly, `${gap.field}: stored tags the live read lacks`).toEqual([]);
    expect(gap.docHas, `${gap.field}: present on one side only`).toBe(gap.liveHas);
  }
  expect(String(doc.brands ?? '').toLowerCase(), 'brands up to case').toBe(
    String(live.brands ?? '').toLowerCase(),
  );
  for (const field of [...TAXONOMY_TAG_FIELDS, 'brands'] as const) {
    if (field in live) served[field] = live[field];
  }
  return served;
}

/* --- Upstream stub --------------------------------------------------------------------------- */

/** Wrap a JSON body in the minimal Response the service reads. */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** What one barcode answers: its v2 product envelope and its v3.5 input-sets envelope. */
interface Upstream {
  v2: unknown;
  v35?: unknown;
}

/**
 * Route `fetch` by URL: `/api/v2/product/<code>.json` and `/api/v3.5/product/<code>` look the code up
 * as Product Opener stores it (`normalizeCodeZeroes`); anything else answers HTTP 400, which no retry
 * absorbs, and is listed in `unexpected`.
 */
function stubUpstream(bodies: ReadonlyMap<string, Upstream>) {
  const requests: string[] = [];
  const unexpected: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : 'url' in input ? input.url : input.href,
    );
    requests.push(url.pathname);
    const v2 = /^\/api\/v2\/product\/(\d+)\.json$/.exec(url.pathname)?.[1];
    const v35 = /^\/api\/v3\.5\/product\/(\d+)$/.exec(url.pathname)?.[1];
    const entry = bodies.get(normalizeCodeZeroes(v2 ?? v35 ?? ''));
    const body = v2 !== undefined ? entry?.v2 : v35 !== undefined ? entry?.v35 : undefined;
    if (body === undefined) {
      unexpected.push(url.href);
      return mockResponse({ error: 'unexpected request' }, 400);
    }
    return mockResponse(body);
  }) as unknown as typeof fetch;
  return { requests, unexpected };
}

let fixtureStoreDir: string;
let fixtureStore: MirrorStore;

/**
 * Writes every fixture's built record to a fresh store as a sync page does, so the doc side of a
 * run is what a mirror read serves: the doc `getByCodes` parses from the row, with `created_t` and
 * `last_modified_t` merged from the row's columns. Tag ids are left empty: a barcode lookup reads none.
 */
async function openFixtureStore(): Promise<void> {
  fixtureStoreDir = await mkdtemp(join(tmpdir(), 'off-record-builder-'));
  fixtureStore = openMirrorStore(join(fixtureStoreDir, 'store.sqlite'));
  await fixtureStore.applyBatch(
    FIXTURES.map((f) => {
      const built = record(f.line);
      return {
        code: built.code,
        popularity_key: built.popularityKey,
        unique_scans_n: built.uniqueScansN,
        created_t: built.createdT,
        last_modified_t: built.lastModifiedT,
        generation: 1,
        record_version: MIRROR_RECORD_VERSION,
        tag_ids: '[]',
        doc: JSON.stringify(built.doc),
      };
    }),
    [],
  );
}

async function closeFixtureStore(): Promise<void> {
  await fixtureStore.close();
  await rm(fixtureStoreDir, { recursive: true, force: true });
}

/** Each fixture served from the doc a mirror read returns for it, keyed by the record's own primary key. */
async function docBodies(fixtures: readonly MirrorFixture[]): Promise<Map<string, Upstream>> {
  const stored = await getByCodes(
    fixtureStore,
    fixtures.map((f) => record(f.line).code),
  );
  return new Map(
    fixtures.map((f) => {
      const { code } = record(f.line);
      const read = stored.get(code);
      if (!read) throw new Error(`The fixture store holds no row for ${code}.`);
      const doc = reconciledDoc(f, read.doc);
      return [
        code,
        {
          v2: { status: 1, product: doc },
          v35: {
            status: 'success',
            result: { id: 'product_found' },
            product: { nutrition: { input_sets: doc._input_sets } },
          },
        },
      ];
    }),
  );
}

/** Each fixture served from its live captures. */
function liveBodies(fixtures: readonly MirrorFixture[]): Map<string, Upstream> {
  return new Map(
    fixtures.map((f) => [
      normalizeCodeZeroes(f.code),
      { v2: f.live, ...(f.liveInputSets && { v35: f.liveInputSets.body }) },
    ]),
  );
}

async function getProduct(barcode: string, bodies: ReadonlyMap<string, Upstream>) {
  const upstream = stubUpstream(bodies);
  const result = await runToolContract(offGetProductTool, { barcode });
  return { result, ...upstream };
}

async function compareProducts(barcodes: string[], bodies: ReadonlyMap<string, Upstream>) {
  const upstream = stubUpstream(bodies);
  const result = await runToolContract(offCompareProductsTool, { barcodes });
  return { result, ...upstream };
}

type Run = Awaited<ReturnType<typeof getProduct>>;

/** A run's `structuredContent`, as the JSON object it is. */
function structured(run: Run): Json {
  return (run.result.structuredContent ?? {}) as Json;
}

/** The doc run answers exactly as the live run does, from the same requests, on both surfaces. */
function expectSameAnswer(docRun: Run, liveRun: Run): void {
  expect(liveRun.unexpected).toEqual([]);
  expect(docRun.unexpected).toEqual([]);
  expect(liveRun.result.isError).toBeFalsy();
  expect(docRun.requests).toEqual(liveRun.requests);
  expect(docRun.result.structuredContent).toEqual(liveRun.result.structuredContent);
  expect(docRun.result.content).toEqual(liveRun.result.content);
}

/* --- Live fixtures --------------------------------------------------------------------------- */

const globalFetch = globalThis.fetch;

beforeEach(() => {
  initOpenFoodFactsService();
});

afterEach(() => {
  globalThis.fetch = globalFetch;
  vi.restoreAllMocks();
});

describe('buildMirrorRecord against live v2 reads', () => {
  /**
   * The #79 matrix is schema (≤1000, 1001–1004) × nutrition shape (as sold, prepared only, both,
   * per serving, per 100 ml). Three buckets hold no product in the export's first 2 GB of gzip
   * (431,270 products, codes up to 4001724015840), so they have no fixture: 1001 × both,
   * 1001 × prepared only, 1002 × prepared only.
   */
  const NOT_IN_CORPUS = ['1001×both', '1001×prepared_only', '1002×prepared_only'];

  beforeAll(openFixtureStore);
  afterAll(closeFixtureStore);

  it('covers every schema × nutrition shape bucket except the three absent from the export sample', () => {
    const present = new Set(FIXTURES.map((f) => `${f.schema}×${f.shape}`));
    const missing = ['le1000', '1001', '1002', '1003', '1004'].flatMap((schema) =>
      ['as_sold', 'prepared_only', 'both', 'per_serving', 'per_100ml']
        .map((shape) => `${schema}×${shape}`)
        .filter((bucket) => !present.has(bucket)),
    );
    expect(missing.sort()).toEqual([...NOT_IN_CORPUS].sort());
    expect(FIXTURES).toHaveLength(29);
  });

  describe.each(FIXTURES.map((f) => [`${f.schema} ${f.shape} ${f.code}`, f] as const))(
    '%s',
    (_, f) => {
      it(`off_get_product answers as live (${divergenceNote(f)})`, async () => {
        const docRun = await getProduct(f.code, await docBodies([f]));
        const liveRun = await getProduct(f.code, liveBodies([f]));
        expectSameAnswer(docRun, liveRun);
        expect(Object.keys(structured(liveRun).product as Json).length).toBeGreaterThan(0);
      });

      it('carries the v2 search row fields raw', () => {
        const pick = (p: Json) =>
          Object.fromEntries(
            SEARCH_ROW_FIELDS.filter((key) => key in p).map((key) => [key, p[key]]),
          );
        expect(pick(reconciledDoc(f))).toEqual(pick(f.live.product));
      });

      it('keeps _input_sets exactly when the v2 read is prepared-only, in a JSON-safe doc', () => {
        const { doc } = record(f.line);
        const preparedOnly = holdsOnlyPreparedFigures(
          f.live.product.nutriments as Json | undefined,
        );
        expect(preparedOnly).toBe(f.liveInputSets !== undefined);
        expect('_input_sets' in doc).toBe(preparedOnly);
        expect(holdsOnlyPreparedFigures(doc.nutriments as Json | undefined)).toBe(preparedOnly);
        expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
      });

      it('orders every object’s keys as the live read does', () => {
        expect(unsortedObjects(f.live.product)).toEqual([]);
        expect(unsortedObjects(record(f.line).doc)).toEqual([]);
      });
    },
  );

  const chunks = [0, 10, 20].map((start) => FIXTURES.slice(start, start + 10));

  it.each(chunks.map((chunk, i) => [i + 1, chunk] as const))(
    'off_compare_products answers as live, batch %i',
    async (_, chunk) => {
      const barcodes = chunk.map((f) => f.code);
      const docRun = await compareProducts(barcodes, await docBodies(chunk));
      const liveRun = await compareProducts(barcodes, liveBodies(chunk));
      expectSameAnswer(docRun, liveRun);
      expect(structured(liveRun).products).toHaveLength(chunk.length);
    },
  );

  it.each(FIXTURES.filter((f) => f.liveInputSets).map((f) => [f.code, f] as const))(
    'stores the input sets a live v3.5 read returns for %s',
    (_, f) => {
      const stored = readInputSets({ input_sets: record(f.line).doc._input_sets });
      const live = readInputSets(f.liveInputSets?.body.product.nutrition);
      expect(Array.isArray(live) && live.length > 0).toBe(true);
      expect(stored).toEqual(live);
    },
  );

  it('selects 7613035530799’s stored as-sold set from the record alone', async () => {
    const f = fixture('7613035530799');
    const { doc } = record(f.line);
    const stored = readInputSets({ input_sets: doc._input_sets });
    const live = readInputSets(f.liveInputSets?.body.product.nutrition);
    if (!Array.isArray(stored) || !Array.isArray(live)) throw new Error('Expected input sets.');

    const selection = selectAsSoldSet(stored);
    expect(selection.status).toBe('read');
    expect(selection).toEqual(selectAsSoldSet(live));

    const docRun = await getProduct(f.code, await docBodies([f]));
    const { nutriments } = structured(docRun).product as { nutriments: Json };
    expect(nutriments.stored_as_sold).toEqual({ status: 'read' });
    expect(nutriments.energy_kcal_100g).toEqual(expect.any(Number));
  });

  it('keys 030000010402 as 0030000010402 and answers the 12-digit barcode as live does', async () => {
    const f = fixture('0030000010402');
    expect(f.live.product.code).toBe('0030000010402');
    expect(record(f.line).code).toBe('0030000010402');

    const docRun = await getProduct('030000010402', await docBodies([f]));
    const liveRun = await getProduct('030000010402', liveBodies([f]));
    expectSameAnswer(docRun, liveRun);
    expect(docRun.requests).toEqual(['/api/v2/product/030000010402.json']);
    expect(structured(docRun).barcode).toBe('030000010402');
  });

  it('indexes a brand under the stored form live search matches', () => {
    const { tags } = record(fixture('0008346800025').line);
    // Live: brands_tags=xx:Slimfast finds 0008346800025, brands_tags=slimfast does not.
    expect(tags).toContain(mirrorTagKey('brands', toStoredTag('brands', 'xx:Slimfast')));
    expect(tags).not.toContain(mirrorTagKey('brands', toStoredTag('brands', 'en:slimfast')));
    expect(tags).toContain('brands:xx:Slimfast');
  });
});

/* --- Unit cases ------------------------------------------------------------------------------ */

/** A minimal schema 1004 line with an as-sold aggregated set per 100 g, so the v2 downgrade runs. */
function aggregatedLine(extra: Json = {}): Json {
  return {
    code: '3017620422003',
    schema_version: 1004,
    nutrition: {
      aggregated_set: {
        preparation: 'as_sold',
        per: '100g',
        nutrients: { 'energy-kcal': { value: 100, unit: 'kcal', source: 'packaging' } },
      },
    },
    ...extra,
  };
}

describe('buildMirrorRecord', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"code":"3017620422003"}'],
    ['a number', 3017620422003],
    ['an array', [{ code: '3017620422003' }]],
    ['an object without a code', {}],
    ['a numeric code', { code: 3017620422003 }],
    ['an empty code', { code: '' }],
    ['a code with a letter', { code: '301762042200a' }],
    ['a code under 4 digits', { code: '0123' }],
    ['an all-zero code', { code: '0000000000000' }],
    ['a code over 40 digits', { code: '1'.repeat(41) }],
  ])('returns null for %s', (_, line) => {
    expect(buildMirrorRecord(line)).toBeNull();
  });

  it('builds a sparse line holding only a code into a doc holding the code and the read’s defaults', () => {
    // normalize_product_data defaults the main language to en; a <field>_languages read is always an object.
    expect(buildMirrorRecord({ code: '3017620422003' })).toEqual({
      code: '3017620422003',
      popularityKey: null,
      uniqueScansN: null,
      createdT: null,
      lastModifiedT: null,
      tags: [],
      doc: { code: '3017620422003', ingredients_text_languages: {}, lang: 'en' },
    });
  });

  it('keys the record by the normalized code', () => {
    expect(record({ code: '030000010402' }).code).toBe('0030000010402');
    expect(record({ code: '00001723380' }).code).toBe('01723380');
  });

  it('copies numeric sort keys and nulls the rest', () => {
    const numeric = record({
      code: '3017620422003',
      popularity_key: 20_250_000_123,
      unique_scans_n: 42,
      created_t: 1_400_000_000,
      last_modified_t: 1_760_000_000,
    });
    expect([
      numeric.popularityKey,
      numeric.uniqueScansN,
      numeric.createdT,
      numeric.lastModifiedT,
    ]).toEqual([20_250_000_123, 42, 1_400_000_000, 1_760_000_000]);
    const textual = record({
      code: '3017620422003',
      popularity_key: '20250000123',
      unique_scans_n: '42',
      created_t: null,
    });
    expect([
      textual.popularityKey,
      textual.uniqueScansN,
      textual.createdT,
      textual.lastModifiedT,
    ]).toEqual([null, null, null, null]);
  });

  it('indexes each stored facet tag once, skipping non-strings, empties, and unindexed facets', () => {
    const { tags } = record({
      code: '3017620422003',
      categories_tags: ['en:spreads', 'en:spreads', '', 7, 'en:cocoa-spreads'],
      brands_tags: ['xx:Slimfast', 'xx:Slimfast'],
      labels_tags: 'en:organic',
      traces_tags: ['en:spreads'],
      nova_groups_tags: ['en:4-ultra-processed-food-and-drink-products'],
      packaging_tags: ['en:jar'],
      origins_tags: ['en:italy'],
    });
    expect(new Set(tags).size).toBe(tags.length);
    expect([...tags].sort()).toEqual(
      [
        'categories:en:spreads',
        'categories:en:cocoa-spreads',
        'brands:xx:Slimfast',
        'traces:en:spreads',
        'nova_groups:en:4-ultra-processed-food-and-drink-products',
      ].sort(),
    );
  });

  describe('_input_sets', () => {
    const asSold = {
      preparation: 'as_sold',
      source: 'packaging',
      per: '100g',
      per_quantity: 100,
      per_unit: 'g',
      nutrients: { fat: { value: 0.9500000000000001, unit: 'g' } },
    };
    const prepared = {
      preparation: 'prepared',
      source: 'packaging',
      per: '100g',
      per_quantity: 100,
      per_unit: 'g',
      nutrients: { fat: { value: 3.1, unit: 'g' } },
    };
    const line = (preparation: string) =>
      aggregatedLine({
        nutrition: {
          aggregated_set: {
            preparation,
            per: '100g',
            nutrients: {
              fat: {
                value: preparation === 'prepared' ? 3.1 : 0.95,
                unit: 'g',
                source: 'packaging',
              },
            },
          },
          input_sets: [asSold, prepared],
        },
      });

    it('stores the input sets of a prepared-only record, numbers as Product Opener writes them', () => {
      const { doc } = record(line('prepared'));
      expect(doc.nutriments).toEqual({ fat_prepared_100g: 3.1 });
      expect(doc._input_sets).toEqual([
        { ...asSold, nutrients: { fat: { value: 0.95, unit: 'g' } } },
        prepared,
      ]);
    });

    it('leaves them out when the v2 read holds as-sold figures', () => {
      const { doc } = record(line('as_sold'));
      expect(doc.nutriments).toEqual({ fat_100g: 0.95 });
      expect('_input_sets' in doc).toBe(false);
    });

    it('upgrades a pre-1003 record’s legacy nutriments, a "-" modifier marking the nutrient unspecified', () => {
      const { doc } = record({
        code: '3017620422003',
        schema_version: 1002,
        nutrition_data_prepared: 'on',
        nutriments: { sugars_prepared: 5, sugars_prepared_100g: 5, fat_prepared_modifier: '-' },
      });
      expect(doc.nutriments).toEqual({ sugars_prepared_100g: 5 });
      expect(doc._input_sets).toEqual([
        {
          preparation: 'prepared',
          source: 'packaging',
          per: '100g',
          per_quantity: 100,
          per_unit: 'g',
          nutrients: { sugars: { value: 5, unit: 'g', value_string: '5' } },
          unspecified_nutrients: ['fat'],
        },
      ]);
    });
  });
});

describe('generic_name and nutrient_levels (#87)', () => {
  it.each<[string, Json, string | undefined]>([
    // 4000417025005: the v2 read answers "" although the English name is set.
    [
      'the main-language name when it is empty, over a set translation',
      { lc: 'nl', generic_name: '', generic_name_en: 'Dark chocolate with marzipan filling' },
      '',
    ],
    [
      'the main-language name over a translation',
      { lc: 'fr', generic_name: 'Eau De Source', generic_name_en: 'Spring water' },
      'Eau De Source',
    ],
    [
      'the English name when no main-language one is stored',
      { lc: 'fr', generic_name_en: 'Spring water', generic_name_fr: 'Eau de source' },
      'Spring water',
    ],
    [
      'the product language’s name when the English one is empty',
      { lc: 'fr', generic_name_en: '', generic_name_fr: 'Eau de source' },
      'Eau de source',
    ],
    ['nothing when no name is stored', { lc: 'fr', generic_name_de: 'Quellwasser' }, undefined],
  ])('projects generic_name as the v2 read does: %s', (_label, fields, expected) => {
    const { doc } = record({ code: '3274080005003', schema_version: 1004, ...fields });
    expect('generic_name' in doc).toBe(expected !== undefined);
    expect(doc.generic_name).toBe(expected);
  });

  it.each<[string, unknown]>([
    ['a full verdict', { fat: 'low', salt: 'low', 'saturated-fat': 'low', sugars: 'moderate' }],
    ['a partial one', { fat: 'low' }],
    ['an empty one', {}],
  ])('stores nutrient_levels as the export holds it: %s', (_label, levels) => {
    const { doc } = record({
      code: '7613035530799',
      schema_version: 1004,
      nutrient_levels: levels,
    });
    expect(doc.nutrient_levels).toEqual(levels);
  });

  it('stores no nutrient_levels for a line without one', () => {
    expect('nutrient_levels' in record({ code: '7613035530799', schema_version: 1004 }).doc).toBe(
      false,
    );
  });

  it.each<[string, number, string[], string[]]>([
    ['no field', 1, [], []],
    ['the fields off_compare_products reads', 1, ['product_name', 'brands', 'nutriments'], []],
    ['generic_name', 1, ['product_name', 'generic_name'], ['generic_name']],
    ['nutrient_levels', 1, ['nutrient_levels', 'nutriments'], ['nutrient_levels']],
    [
      'both, in request order',
      1,
      ['nutrient_levels', 'product_name', 'generic_name'],
      ['nutrient_levels', 'generic_name'],
    ],
    ['both from a row built at 2', 2, ['generic_name', 'nutrient_levels'], []],
    ['a field the doc never holds', 1, ['last_modified_t'], []],
  ])('names what a row stamped below a field lacks of %s', (_label, version, fields, lacks) => {
    expect(fieldsNewerThan(version, fields)).toEqual(lacks);
  });
});

describe('main language, ingredient texts, label photos, and score points (#91, #93)', () => {
  const CODE = '3017620422003';
  const IMAGES = 'https://images.openfoodfacts.org/images/products/301/762/042/2003';
  const doc = (fields: Json) => record({ code: CODE, schema_version: 1004, ...fields }).doc;

  it('builds at record version 3, the version that added the six fields, through the seam the sync reads', () => {
    // The sync reloads a store whose last load is older than the builder it is handed
    // (mirror-sync.test.ts); the production builder is this module, at 3 since #91 and #93.
    const builder: MirrorBuilder = recordBuilder;
    expect(builder.MIRROR_RECORD_VERSION).toBe(3);
    expect(MIRROR_RECORD_VERSION).toBe(3);
  });

  it.each<[string, Json, string]>([
    ['lc over lang', { lc: 'fr', lang: 'de' }, 'fr'],
    ['lang when lc is empty', { lc: '', lang: 'de' }, 'de'],
    ['lang when no lc is stored', { lang: 'de' }, 'de'],
    ['en when neither is stored', {}, 'en'],
  ])('settles lang as normalize_product_data does: %s', (_label, fields, lang) => {
    expect(doc(fields).lang).toBe(lang);
  });

  it('maps every listed language’s ingredients text, empty ones included, in key order', () => {
    const { ingredients_text_languages: map } = doc({
      lc: 'en',
      languages_codes: { fr: 6, en: 2, ro: 0, ch: 0, de: 3 },
      ingredients_text: 'sugar, palm oil',
      ingredients_text_en: 'sugar, palm oil',
      ingredients_text_fr: 'Sucre, huile de palme, NOISETTES 13%',
      ingredients_text_ch: '',
      ingredients_text_ro: null,
      ingredients_text_it: 'Zucchero, olio di palma',
    });
    // de is listed with no text; ro's is undef; it has text but is not listed.
    expect(map).toEqual({
      ch: '',
      en: 'sugar, palm oil',
      fr: 'Sucre, huile de palme, NOISETTES 13%',
    });
    expect(Object.keys(map as Json)).toEqual(['ch', 'en', 'fr']);
  });

  it('maps no language when the record lists none', () => {
    const built = doc({ ingredients_text: 'Sucre', ingredients_text_fr: 'Sucre' });
    expect(built.ingredients_text_languages).toEqual({});
  });

  it('keeps a stored __proto__ language code as an own key of the map', () => {
    const line = JSON.parse(
      `{"code":"${CODE}","schema_version":1004,"languages_codes":{"__proto__":1},"ingredients_text___proto__":"x"}`,
    );
    const map = record(line).doc.ingredients_text_languages as Json;
    expect(Object.hasOwn(map, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
    expect(JSON.stringify(map)).toBe('{"__proto__":"x"}');
  });

  it.each<[string, Json, string | undefined]>([
    [
      'the English image over the product language’s',
      { lc: 'fr', images: { selected: { ingredients: { fr: { rev: '4' }, en: { rev: '7' } } } } },
      'ingredients_en.7.400.jpg',
    ],
    [
      'the product language’s when no English one is selected',
      { lc: 'fr', images: { selected: { ingredients: { fr: { rev: '4' }, de: { rev: '2' } } } } },
      'ingredients_fr.4.400.jpg',
    ],
    [
      'the first language in alphabetical order when neither is',
      { lc: 'fr', images: { selected: { ingredients: { it: { rev: '3' }, de: { rev: '2' } } } } },
      'ingredients_de.2.400.jpg',
    ],
    [
      'nothing for the chosen language’s image without a rev, rather than another language',
      { lc: 'en', images: { selected: { ingredients: { en: { imgid: '3' }, fr: { rev: '4' } } } } },
      undefined,
    ],
    [
      'nothing when only other image types are selected',
      { lc: 'en', images: { selected: { front: { en: { rev: '2' } } } } },
      undefined,
    ],
    [
      'a schema 1001 record’s legacy ingredients_<lc> key',
      {
        schema_version: 1001,
        lc: 'fr',
        images: { front_en: { rev: '2' }, ingredients_fr: { rev: '6' } },
      },
      'ingredients_fr.6.400.jpg',
    ],
  ])('builds image_ingredients_url as image_url is built: %s', (_label, fields, file) => {
    const built = doc(fields);
    expect('image_ingredients_url' in built).toBe(file !== undefined);
    expect(built.image_ingredients_url).toBe(file && `${IMAGES}/${file}`);
  });

  it('reads each photo from its own selection, on a current record and a schema 1001 one', () => {
    const selected = {
      front: { en: { rev: '2' } },
      ingredients: { en: { rev: '5' } },
      nutrition: { en: { rev: '9' } },
    };
    const legacy = {
      front_en: { rev: '2' },
      ingredients_en: { rev: '5' },
      nutrition_en: { rev: '9' },
    };
    const expected = {
      image_url: `${IMAGES}/front_en.2.400.jpg`,
      image_ingredients_url: `${IMAGES}/ingredients_en.5.400.jpg`,
      image_nutrition_url: `${IMAGES}/nutrition_en.9.400.jpg`,
    };
    expect(doc({ lc: 'en', images: { selected } })).toMatchObject(expected);
    expect(doc({ schema_version: 1001, lc: 'en', images: legacy })).toMatchObject(expected);
  });

  it('builds 0011110135056’s photos from its schema 1001 keys as live does, with no front image', () => {
    const built = record(fixture('0011110135056').line).doc;
    const path = 'https://images.openfoodfacts.org/images/products/001/111/013/5056';
    expect(built.image_ingredients_url).toBe(`${path}/ingredients_en.6.400.jpg`);
    expect(built.image_nutrition_url).toBe(`${path}/nutrition_en.8.400.jpg`);
    expect('image_url' in built).toBe(false);
  });

  it('stores nutriscore_score as the export holds it, and none where none is computed', () => {
    expect(doc({ nutriscore_grade: 'a', nutriscore_score: -8 }).nutriscore_score).toBe(-8);
    expect(doc({ nutriscore_grade: 'b', nutriscore_score: 0 }).nutriscore_score).toBe(0);
    expect('nutriscore_score' in record(fixture('01723380').line).doc).toBe(false);
  });

  it('localizes 01723380’s Green-Score to the world score a live read returns, not the stored French one', () => {
    const f = fixture('01723380');
    expect(f.line.environmental_score_score).toBe(46);
    expect(record(f.line).doc).toMatchObject({ ecoscore_score: 35, ecoscore_grade: 'd' });
  });

  it.each<[string, Json, number | undefined]>([
    [
      'the stored score when no world score is computed',
      { environmental_score_grade: 'b', environmental_score_score: 62 },
      62,
    ],
    [
      'no score from a stale ecoscore_score on a schema 1000+ record',
      { environmental_score_grade: 'b', ecoscore_score: 20 },
      undefined,
    ],
    [
      'environmental_score_score over ecoscore_score on a pre-1000 record',
      { schema_version: 999, environmental_score_score: 62, ecoscore_score: 55 },
      62,
    ],
    [
      'ecoscore_score alone on a pre-1000 record',
      { schema_version: 999, ecoscore_grade: 'b', ecoscore_score: 55 },
      55,
    ],
    [
      'the world score from a pre-1000 record’s ecoscore_data',
      {
        schema_version: 999,
        ecoscore_score: 50,
        ecoscore_data: { scores: { world: 41, fr: 50 }, grades: { world: 'c', fr: 'b' } },
      },
      41,
    ],
    ['nothing when no score is stored', { environmental_score_grade: 'unknown' }, undefined],
  ])('reads ecoscore_score as the grade is read: %s', (_label, fields, score) => {
    const built = doc(fields);
    expect('ecoscore_score' in built).toBe(score !== undefined);
    expect(built.ecoscore_score).toBe(score);
  });

  const ADDED_AT_3 = [
    'lang',
    'ingredients_text_languages',
    'nutriscore_score',
    'ecoscore_score',
    'image_ingredients_url',
    'image_nutrition_url',
  ];

  it.each(
    ADDED_AT_3.flatMap((field) => [
      [field, 1, [field]],
      [field, 2, [field]],
      [field, 3, []],
    ]) as [string, number, string[]][],
  )('names %s as lacking from a row stamped %i: %j', (field, version, lacks) => {
    expect(fieldsNewerThan(version, ['product_name', field])).toEqual(lacks);
  });

  it('names every field a row lacks across both versions, in request order', () => {
    const fields = ['generic_name', 'lang', 'nutriments', 'nutrient_levels', 'ecoscore_score'];
    expect(fieldsNewerThan(1, fields)).toEqual([
      'generic_name',
      'lang',
      'nutrient_levels',
      'ecoscore_score',
    ]);
    expect(fieldsNewerThan(2, fields)).toEqual(['lang', 'ecoscore_score']);
    expect(fieldsNewerThan(3, fields)).toEqual([]);
  });
});

describe('serving_size re-parse', () => {
  /**
   * `parse_serving_size` tries a mass or volume first and a household measure (spoon, glass, cup,
   * pinch) only when none parses, and the unit is the parsed serving's own (openfoodfacts-server
   * d53c21be), whose documented examples read `2 tbsp (32 g)` as 32 g and `6 g (1 c. à soupe)` as 6 g.
   */
  it.each([
    // A mass or volume, the backward scan's last one or the one at the start.
    ['1/2 cup (60 g)', 60, 'g'],
    ['2 tbsp (32 g)', 32, 'g'],
    ['6 g (1 c. à soupe)', 6, 'g'],
    // The unit is the parsed serving's, never the first one in the text (`ml` here).
    ['250 ml (240 g)', 240, 'g'],
    ['27 g', 27, 'g'],
    ['6 x 33 cl', 330, 'ml'],
    ['100 kcal', 418, 'kj'],
    ['14.000000000000002g', 14, 'g'],
    ['1,5 l', 1500, 'ml'],
    // A household measure alone, at the start or after a space; `c. à c.` ends at a word boundary
    // only without its last dot.
    ['1 tbsp', 15, 'ml'],
    ['1 cup', 240, 'ml'],
    ['about 1 tsp', 5, 'ml'],
    ['2 c. à c.', 10, 'ml'],
  ])('reads %j as %d %s', (servingSize, quantity, unit) => {
    const { doc } = record(
      aggregatedLine({
        serving_size: servingSize,
        serving_quantity: 1,
        serving_quantity_unit: 'g',
      }),
    );
    expect(doc.serving_size).toBe(servingSize);
    expect(doc.serving_quantity).toBe(quantity);
    expect(doc.serving_quantity_unit).toBe(unit);
  });

  it('scales per-serving nutriments by the re-parsed serving, not the stored one', () => {
    const { doc } = record(
      aggregatedLine({
        serving_size: '1/2 cup (60 g)',
        serving_quantity: 30,
        serving_quantity_unit: 'g',
      }),
    );
    expect(doc.nutriments).toEqual({ 'energy-kcal_100g': 100, 'energy-kcal_serving': 60 });
  });

  it('nulls the quantity of a serving no number and unit parse from, keeping the stored unit', () => {
    const { doc } = record(
      aggregatedLine({
        serving_size: 'about a handful',
        serving_quantity: 30,
        serving_quantity_unit: 'g',
      }),
    );
    expect(doc).toMatchObject({
      serving_size: 'about a handful',
      serving_quantity: null,
      serving_quantity_unit: 'g',
    });
    expect(doc.nutriments).toEqual({ 'energy-kcal_100g': 100 });
  });

  it.each([
    // No space or parenthesis before a number, so no serving parses; parse_quantity_unit takes the
    // mass over the household measure written before it, else the household measure.
    ['serving:1cup=30g', 'g'],
    ['serving:2tbsp', 'ml'],
  ])(
    'takes the unit of %j from parse_quantity_unit when no serving parses: %s',
    (servingSize, unit) => {
      const { doc } = record(
        aggregatedLine({
          serving_size: servingSize,
          serving_quantity: 30,
          serving_quantity_unit: 'kj',
        }),
      );
      expect(doc.serving_quantity).toBeNull();
      expect(doc.serving_quantity_unit).toBe(unit);
    },
  );

  it('drops an empty serving_size and the stored quantity, keeping the stored unit', () => {
    const { doc } = record(
      aggregatedLine({ serving_size: '', serving_quantity: 30, serving_quantity_unit: 'g' }),
    );
    expect('serving_size' in doc).toBe(false);
    expect('serving_quantity' in doc).toBe(false);
    expect(doc.serving_quantity_unit).toBe('g');
  });

  it('drops the stored quantity when no serving_size is stored', () => {
    const { doc } = record(aggregatedLine({ serving_quantity: 30, serving_quantity_unit: 'g' }));
    expect('serving_quantity' in doc).toBe(false);
    expect(doc.serving_quantity_unit).toBe('g');
  });

  it('passes the stored serving through when there is no aggregated set to downgrade', () => {
    const { doc } = record({
      code: '3017620422003',
      schema_version: 1004,
      serving_size: '1/2 cup (60 g)',
      serving_quantity: 0.30000000000000004,
      serving_quantity_unit: 'g',
    });
    expect(doc).toMatchObject({
      serving_size: '1/2 cup (60 g)',
      serving_quantity: 0.3,
      serving_quantity_unit: 'g',
    });
  });
});

describe('normalizeCodeZeroes', () => {
  it.each([
    ['030000010402', '0030000010402'],
    ['0030000010402', '0030000010402'],
    ['3017620422003', '3017620422003'],
    ['03017620422003', '3017620422003'],
    ['01723380', '01723380'],
    ['1723380', '01723380'],
    ['0000001723380', '01723380'],
    ['0000012345678', '12345678'],
    ['00012345678901234', '12345678901234'],
    ['12345678901234', '12345678901234'],
    ['301762042200a', '301762042200a'],
  ])('%s → %s', (code, normalized) => {
    expect(normalizeCodeZeroes(code)).toBe(normalized);
  });
});

describe('mirrorTagKey and toStoredTag', () => {
  it('keys a tag by facet and stored value', () => {
    expect(mirrorTagKey('brands', 'xx:Slimfast')).toBe('brands:xx:Slimfast');
    expect(mirrorTagKey('nova_groups', 'en:4-ultra-processed-food-and-drink-products')).toBe(
      'nova_groups:en:4-ultra-processed-food-and-drink-products',
    );
  });

  it('indexes exactly the tag-only search facets', () => {
    expect(MIRROR_TAG_FACETS).toEqual([
      'categories',
      'brands',
      'labels',
      'allergens',
      'traces',
      'ingredients_analysis',
      'additives',
      'nutrition_grades',
      'nova_groups',
      'environmental_score',
      'countries',
    ]);
  });

  it.each([
    ['brands', 'en:nutella', 'xx:nutella'],
    ['brands', 'xx:Slimfast', 'xx:Slimfast'],
    ['brands', 'nutella', 'xx:nutella'],
    ['brands', 'FR:Nutella', 'xx:Nutella'],
    ['nova_groups', '1', 'en:1-unprocessed-or-minimally-processed-foods'],
    ['nova_groups', '2', 'en:2-processed-culinary-ingredients'],
    ['nova_groups', '3', 'en:3-processed-foods'],
    ['nova_groups', '4', 'en:4-ultra-processed-food-and-drink-products'],
    ['nova_groups', 'en:3-processed-foods', 'en:3-processed-foods'],
    ['nova_groups', '5', '5'],
    ['additives', 'en:e322i', 'en:e322i'],
    ['additives', 'en:e330-citric-acid', 'en:e330'],
    ['categories', 'en:breakfast-cereals', 'en:breakfast-cereals'],
    ['labels', 'en:organic', 'en:organic'],
    ['allergens', 'en:milk', 'en:milk'],
    ['traces', 'en:nuts', 'en:nuts'],
    ['ingredients_analysis', 'en:palm-oil-free', 'en:palm-oil-free'],
    ['nutrition_grades', 'a', 'a'],
    ['countries', 'en:france', 'en:france'],
  ])('maps %s %s to %s', (facet, canonical, stored) => {
    expect(toStoredTag(facet, canonical)).toBe(stored);
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'returns a NOVA value named like an Object.prototype property (%s) as given',
    (value) => {
      expect(toStoredTag('nova_groups', value)).toBe(value);
    },
  );

  it.each(['origins', 'packaging', 'brands_tags', '', 'constructor', '__proto__'])(
    'throws for the facet %j outside MIRROR_TAG_FACETS',
    (facet) => {
      expect(() => toStoredTag(facet, 'en:x')).toThrow(`Unknown mirror tag facet: ${facet}`);
    },
  );
});

describe('the Green-Score facet', () => {
  const greenScoreKeys = (line: unknown) =>
    record(line).tags.filter((key) => key.startsWith('environmental_score:'));

  it('indexes environmental_score_tags, the field live search filters on', () => {
    expect(fixture('01723380').line.environmental_score_tags).toEqual(['c']);
    expect(greenScoreKeys(fixture('01723380').line)).toEqual(['environmental_score:c']);
  });

  it('never indexes the ecoscore_tags copy, alone or beside environmental_score_tags', () => {
    // A pre-1000 record holds only ecoscore_tags, which live environmental_score_tags= never finds.
    expect(fixture('0025000054167').line.ecoscore_tags).toEqual(['c']);
    expect(fixture('0025000054167').line.environmental_score_tags).toBeUndefined();
    expect(greenScoreKeys(fixture('0025000054167').line)).toEqual([]);
    expect(
      greenScoreKeys({
        code: '6000000000007',
        schema_version: 1004,
        lc: 'en',
        environmental_score_tags: ['b'],
        ecoscore_tags: ['d'],
      }),
    ).toEqual(['environmental_score:b']);
  });

  it.each([
    ['a-plus', 'a-plus'],
    ['a', 'a'],
    ['f', 'f'],
  ])('stores the grade %s as %s', (canonical, stored) => {
    expect(toStoredTag('environmental_score', canonical)).toBe(stored);
  });

  it('starts at record version 2, at or below the version the builder writes', () => {
    expect(recordBuilder.GREEN_SCORE_RECORD_VERSION).toBe(2);
    expect(recordBuilder.GREEN_SCORE_RECORD_VERSION).toBeLessThanOrEqual(MIRROR_RECORD_VERSION);
  });
});

/* --- Timing ---------------------------------------------------------------------------------- */

/**
 * Per-call thread CPU in ms: the least of three samples, each repeated until it has spent 20 ms,
 * so a coarse CPU tick never reads as zero.
 */
function cpuMs(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < 3; sample += 1) {
    const start = process.threadCpuUsage();
    let runs = 0;
    let spentMs = 0;
    do {
      run();
      runs += 1;
      const used = process.threadCpuUsage(start);
      spentMs = (used.user + used.system) / 1000;
    } while (spentMs < 20);
    best = Math.min(best, spentMs / runs);
  }
  return best;
}

describe('serving scanner timing', () => {
  /**
   * Each shape: its builder for a size, and its CPU budget per character. A number before the
   * first character of a unit name makes `unitAt` look up every name length up to the longest (50
   * characters) at each pass, the scan's costliest step, so that shape is built to the size in
   * characters and gets a larger budget; a super-linear scan still exceeds it by orders of magnitude.
   */
  const shapes: [string, (size: number) => string, number][] = [
    ['one long line ending in a break', (size) => `${'§1 x'.repeat(size)}\ny`, 0.002],
    ['breaks throughout', (size) => '  \r\n'.repeat(size), 0.002],
    ['openers with a number and no unit', (size) => ' (1'.repeat(size), 0.002],
    [
      'one number before a letter group of multiplier separators',
      (size) => `1${' x'.repeat(size)}`,
      0.002,
    ],
    [
      'numbers before an unfinished spoon name',
      (size) => ' 1 c. à t'.repeat(Math.round(size / ' 1 c. à t'.length)),
      0.01,
    ],
  ];

  /**
   * Linear on both unit passes. Each size doubles the last and meets an absolute CPU bound before
   * the next runs, so a quadratic fails in seconds. The 64× span's growth divides the largest size
   * by the 5k baseline timed again beside it, the least of up to three such pairs, so a baseline
   * that ran on a faster core cannot make linear work read as super-linear. The body is
   * synchronous, so vitest's timeout could only fail it after it returned: it is off.
   */
  it.each(shapes)(
    're-parses serving_size in linear time: %s',
    { timeout: 0 },
    (_, build, msPerCharacter) => {
      const sizes = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
      const timed = (size: number) => {
        const servingSize = build(size);
        const line = aggregatedLine({ serving_size: servingSize });
        // The scan ran to the end: the downgrade re-derived the serving and found no number and unit.
        expect(record(line).doc.serving_quantity).toBeNull();
        const ms = cpuMs(() => {
          buildMirrorRecord(line);
        });
        // The shape's budget per character plus a fixed floor: generous for linear work, far under a quadratic's.
        expect(ms).toBeLessThan(5 + servingSize.length * msPerCharacter);
        return ms;
      };
      for (const size of sizes.slice(0, -1)) timed(size);
      const [smallest, largest] = [sizes[0] as number, sizes.at(-1) as number];
      let growth = Number.POSITIVE_INFINITY;
      for (let pair = 0; pair < 3 && growth >= 256; pair += 1) {
        growth = Math.min(growth, timed(largest) / timed(smallest));
      }
      expect(growth).toBeLessThan(256);
    },
  );
});
