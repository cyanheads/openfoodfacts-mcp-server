/**
 * @fileoverview Tool definition for searching Open Food Facts products by text, tag filters, and
 * numeric nutrient thresholds.
 * @module mcp-server/tools/definitions/search-products
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  mirrorCopyNote,
  mirrorSnapshotTrailer,
  sourceLine,
} from '@/mcp-server/tools/read-source.js';
import {
  completenessLabel,
  completenessScore,
  recordDates,
  recordDatesLine,
} from '@/mcp-server/tools/record-metadata.js';
import {
  countQueryWords,
  getOpenFoodFactsService,
  MAX_QUERY_WORDS,
  MIRROR_SEARCH_RESULT_WINDOW,
  type ProductSearch,
  TAG_SEARCH_MAX_PAGE,
  TEXT_SEARCH_RESULT_WINDOW,
} from '@/services/openfoodfacts/openfoodfacts-service.js';
import {
  INGREDIENTS_ANALYSIS_TAGS,
  type IndexedNutrientKey,
  indexedNutrientKey,
  NUTRIENT_FIELDS,
  NUTRIENT_OPERATORS,
  type NutrientFilter,
  type NutrientOperator,
  type SearchParams,
  type TagValue,
} from '@/services/openfoodfacts/types.js';
import { brandKeys } from '@/services/taxonomy/brand-keys.js';
import {
  brandLiveIds,
  brandTextIds,
  type CanonicalTag,
  getTaxonomyService,
  type LiveFacet,
  type LookupFailure,
  taxonomyTextIds,
} from '@/services/taxonomy/taxonomy-service.js';
import { mdInline } from '@/utils/markdown.js';

/**
 * Most results one search call returns: `/api/v2/search`'s own anonymous page maximum, which it
 * clamps a larger `page_size` to, and a page the text backend and the mirror serve too. A larger
 * `page_size` is served at this size and disclosed, and `page` then counts pages of this size.
 */
const SEARCH_PAGE_SIZE_CAP = 100;

/** Comparison symbol per operator, for echoing a constraint back to the caller in the notice. */
const NUTRIENT_OPERATOR_SYMBOLS: Record<NutrientOperator, string> = {
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/**
 * The string tag filters, the facet whose vocabulary each draws on, and the label the empty-result
 * notice echoes it under. On the text path each value is canonicalized before it is sent.
 * `additives_tag` is canonicalized the same way but is not listed here: the service takes one
 * additive ID, never the any-of IDs a value here can be sent under. Trace tags are allergen tags,
 * so `traces_tag` resolves against the allergen vocabulary. A brand has no vocabulary: it is sent
 * under its keys (`brandKeys`), in each backend's form. `allOf` marks a filter that also takes an
 * array of values, all of which must apply (`allOfTagInput`). `ingredients_tag` is served only by
 * the text path, so a search carrying it is always canonicalized.
 */
const TAG_FILTERS = [
  { key: 'categories_tag', facet: 'categories', label: 'category' },
  { key: 'brands_tag', label: 'brand' },
  { key: 'labels_tag', facet: 'labels', label: 'label', allOf: true },
  { key: 'ingredients_tag', facet: 'ingredients', label: 'ingredient', allOf: true },
  { key: 'allergens_tag', facet: 'allergens', label: 'allergen' },
  { key: 'traces_tag', facet: 'allergens', label: 'trace' },
  { key: 'countries_tag', facet: 'countries', label: 'country' },
] as const satisfies readonly {
  key: keyof SearchParams;
  facet?: LiveFacet;
  label: string;
  allOf?: true;
}[];

/**
 * The input of a tag filter marked `allOf` in `TAG_FILTERS`: one canonical tag ID, or an array of
 * up to 10, all of which must apply. `item` describes one ID, `list` the array.
 */
function allOfTagInput(item: string, list: string) {
  return z.union([
    z.string().describe(item),
    z.array(z.string().describe(item)).max(10).describe(list),
  ]);
}

/**
 * A tag filter value as supplied and as sent, the additive's included. `sent` is every ID the value
 * went to its backend under, any of which matches: one, the final-ς ID beside it of a taxonomy
 * value nothing confirmed (`taxonomyTextIds`), or a brand's, in the backend's form — the keys the
 * mirror holds it under, `brandLiveIds` on the live tag path, `brandTextIds` on the text path.
 * `canonical` is set on a taxonomy value canonicalized: on the text path, and on the tag path when
 * the mirror is ready.
 */
type AppliedTagFilter = {
  key: (typeof TAG_FILTERS)[number]['key'] | 'additives_tag';
  label: string;
  given: string;
  sent: readonly [string, ...string[]];
  canonical?: CanonicalTag;
};

/**
 * A brand that keeps a search off the ready mirror, and why: the mirror holds no product under any
 * of its keys (`not_held`), or its last full load predates brand keys (`unindexed`), so the keys it
 * holds count only part of the brand's products.
 */
type OffMirrorBrand = { value: string; reason: 'not_held' | 'unindexed' };

/** Why a brand kept a search off the ready mirror, in a refusal's words. */
function offMirrorBrandReason({ value, reason }: OffMirrorBrand): string {
  return reason === 'not_held'
    ? `brands_tag "${value}" names no brand it holds a product under, in any of its spellings or Open Food Facts synonyms`
    : `brands_tag "${value}" is matched there only once a full reload of it has keyed every brand, and that reload has not completed`;
}

/** The retry half of a refusal's hint when a brand the ready mirror has not keyed kept it live. */
const BRAND_RELOAD_HINT = `Once this server's local copy of the export completes the full reload that keys every brand, it serves pages past ${TAG_SEARCH_MAX_PAGE} of a search whose every value it confirms.`;

/**
 * The exclusion filters, the label each is echoed under, and the kind of data a product needs
 * entered for the exclusion to mean anything. Both draw on the allergen vocabulary.
 */
const EXCLUSION_FILTERS = [
  {
    key: 'exclude_allergens',
    label: 'excluded_allergen',
    kind: 'allergen',
    field: 'allergens_tags',
  },
  { key: 'exclude_traces', label: 'excluded_trace', kind: 'trace', field: 'traces_tags' },
] as const satisfies readonly {
  key: keyof SearchParams;
  label: string;
  kind: string;
  field: string;
}[];

/** An exclusion value as supplied, with what the allergen vocabulary made of it. */
type AppliedExclusion = {
  key: (typeof EXCLUSION_FILTERS)[number]['key'];
  given: string;
  canonical: CanonicalTag;
};

/** A tag input's values: a string is one value, each trimmed, blanks dropped. */
function tagValues(value: string | readonly string[] | undefined): string[] {
  return [value ?? []]
    .flat()
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

const NUTRITION_GRADES = ['a', 'b', 'c', 'd', 'e'] as const;
const NOVA_GROUPS = ['1', '2', '3', '4'] as const;
const GREEN_SCORE_GRADES = ['a-plus', 'a', 'b', 'c', 'd', 'e', 'f'] as const;

/**
 * The grade filters and the label the empty-result notice echoes each under. A product carries one
 * grade of each, so an array of grades matches any of its values, where an array of labels must
 * all apply.
 */
const GRADE_FILTERS = [
  { key: 'nutrition_grade', label: 'nutriscore' },
  { key: 'nova_group', label: 'nova' },
  { key: 'ecoscore_grade', label: 'ecoscore' },
] as const satisfies readonly { key: keyof SearchParams; label: string }[];

/** A grade filter as supplied: its distinct values in the caller's order, at least one. */
type AppliedGradeFilter = {
  key: (typeof GRADE_FILTERS)[number]['key'];
  label: string;
  values: string[];
};

/** A grade input's distinct values in the caller's order: a string is one value, `[]` none. */
function gradeValues(value: string | readonly string[] | undefined): string[] {
  return [...new Set([value ?? []].flat())];
}

/**
 * The caveat every response carrying an exclusion gets. Open Food Facts cannot tell a product free
 * of an allergen from one whose allergens were never entered, and an exclusion passes both — on
 * a tag-only chocolate search, most of the products passing a nuts exclusion had no allergen data
 * at all — so the caller is told what an excluded result does not establish.
 */
function exclusionCoverageNote(exclusions: readonly AppliedExclusion[]): string | undefined {
  const applied = EXCLUSION_FILTERS.filter(({ key }) => exclusions.some((e) => e.key === key));
  if (applied.length === 0) return;
  const kinds = applied.map(({ kind }) => kind);
  const fields = applied.map(({ field }) => field).join(' and ');
  return (
    `An exclusion also passes every product with no ${kinds.join(' or ')} data entered, which ` +
    `Open Food Facts cannot tell apart from a product free of the excluded ${kinds.map((kind) => `${kind}s`).join(' and ')}, ` +
    `so a result here is not confirmed free of them. Check each product's ${fields} with off_get_product before relying on it.`
  );
}

/** The disclosure for matches left off a page, shared by the notice and the text surface. */
function omittedSentence(count: number): string {
  return count === 1
    ? '1 match on this page was left off: Open Food Facts stores it under a code it cannot serve, so off_get_product could not look it up either.'
    : `${count} matches on this page were left off: Open Food Facts stores them under codes it cannot serve, so off_get_product could not look them up either.`;
}

/**
 * What to do after a page every match left, shared by the notice and the text surface. `reachable`
 * is the deepest page the search can request, so a page named here is one the window serves. An
 * unservable code is no reason to change the search, so nothing here suggests narrowing it.
 */
function emptyPageNextStep(page: number, reachable: number): string {
  return page < reachable
    ? `Request page ${page + 1} for further matches.`
    : 'No further page of matches can be requested.';
}

/** A tag value nothing confirmed, as the taxonomy service returns it. */
type UnconfirmedTag = Extract<CanonicalTag, { resolution: 'normalized' }>;

/**
 * How a brand is matched, in the empty-result notice's words: it has no vocabulary to confirm it,
 * so it goes under its keys (`brandKeys`), any of which matches, and never under part of a name.
 */
const BRAND_MATCH_REASON =
  'as given, under its slug, and under every other name of its Open Food Facts brand entry, any of which matches, never as part of a name';

/**
 * Why an unconfirmed tag value was sent as it was, in the empty-result notice's words. A failed
 * lookup is worded by its cause, with the wait when one is known: only an unavailable vocabulary is
 * blamed on the vocabulary.
 */
function unconfirmedTagReason(canonical: UnconfirmedTag): string {
  if (canonical.reason === 'no_match') return 'no matching Open Food Facts tag was found';
  switch (canonical.cause) {
    case 'budget_spent':
      return `this server's own per-minute taxonomy budget was spent, so it went unchecked; a lookup slot frees in about ${canonical.retryAfter} s`;
    case 'rate_limited':
      return `Open Food Facts was rate-limiting this server's taxonomy lookups, so it went unchecked${canonical.retryAfter === undefined ? '' : `; it asked for a wait of ${canonical.retryAfter} s`}`;
    case 'unavailable':
      return 'the tag vocabulary could not be reached or gave no usable answer, so it went unchecked';
    default: {
      const unhandled: never = canonical;
      throw new Error(`Unhandled lookup failure: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Why an exclusion value was refused, in the refusal message's words. Like
 * `unconfirmedTagReason`, a failed lookup is worded by its cause and names its wait.
 */
function refusedExclusion(field: string, value: string, canonical: UnconfirmedTag): string {
  if (canonical.reason !== 'lookup_failed') {
    return `${field} "${value}" is not an allergen tag ID or name the Open Food Facts vocabulary confirms`;
  }
  switch (canonical.cause) {
    case 'budget_spent':
      return `${field} "${value}" could not be checked, because this server's own per-minute taxonomy budget is spent, so no lookup was sent; a slot frees in about ${canonical.retryAfter} s`;
    case 'rate_limited':
      return `${field} "${value}" could not be checked, because Open Food Facts is rate-limiting this server's taxonomy lookups (HTTP 429)${canonical.retryAfter === undefined ? '' : ` and asked for a wait of ${canonical.retryAfter} s`}`;
    case 'unavailable':
      return `${field} "${value}" could not be checked, because the allergen vocabulary could not be reached or gave no usable answer`;
    default: {
      const unhandled: never = canonical;
      throw new Error(`Unhandled lookup failure: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Each lookup-failure cause as the retry hint of an exclusion refusal names it. */
const EXCLUSION_LOOKUP_FAILURES = {
  budget_spent: "this server's own per-minute taxonomy budget is spent and no lookup was sent",
  rate_limited: "Open Food Facts is rate-limiting this server's taxonomy lookups",
  unavailable: 'the allergen vocabulary could not be reached or gave no usable answer',
} as const satisfies Record<LookupFailure['cause'], string>;

/**
 * The longest wait the failed lookups named: a spent budget always names one, a 429 when Open Food
 * Facts sent it.
 */
function longestWait(failures: readonly LookupFailure[]): number | undefined {
  const waits = failures.flatMap((failure) =>
    failure.cause !== 'unavailable' && failure.retryAfter !== undefined ? [failure.retryAfter] : [],
  );
  return waits.length > 0 ? Math.max(...waits) : undefined;
}

/** A tag value that kept a search off the ready mirror, with what the taxonomy service said of it. */
type UnconfirmedValue = { field: string; value: string; canonical: UnconfirmedTag };

/**
 * The recovery of a tag-only page past `TAG_SEARCH_MAX_PAGE` that only the live database could
 * serve, which serves none: the pages it does serve, at `pageSize`, out of `total` matches when
 * known, a total that runs past every one of them.
 */
function livePagesHint(pageSize: number, total?: number): string {
  const reach = TAG_SEARCH_MAX_PAGE * pageSize;
  const reached =
    total === undefined
      ? `the first ${reach} matches`
      : `the first ${reach} of the ${total} matches`;
  return `Request page ${TAG_SEARCH_MAX_PAGE} or lower — at page_size ${pageSize} that reaches ${reached} — or narrow the filters or change sort_by to bring the products you need forward.`;
}

/**
 * The refusal of a tag-only page past `TAG_SEARCH_MAX_PAGE` that the ready mirror could not take
 * because a value went unconfirmed, so the search would read live, where that page is refused.
 * Like the exclusion refusal, it names each value and why, and `offMirrorBrand`, a brand the
 * mirror cannot match, beside them. It is retryable, with the longest wait known, when every value
 * went unconfirmed only because its lookup failed and no brand keeps the search off the mirror: the
 * same call is then served from the mirror once the lookup succeeds. Otherwise the hint goes by
 * each value's reason: one no tag matches has no canonical ID to replace it, so it is to be
 * corrected or dropped, and one whose lookup failed is retried.
 */
function unconfirmedPageRefusal(
  page: number,
  pageSize: number,
  unconfirmed: readonly UnconfirmedValue[],
  offMirrorBrand: OffMirrorBrand | undefined,
): { message: string; data: Record<string, unknown> } {
  const failed = unconfirmed.flatMap(({ canonical }) =>
    canonical.reason === 'lookup_failed' ? [canonical] : [],
  );
  const retryable = offMirrorBrand === undefined && failed.length === unconfirmed.length;
  const wait = longestWait(failed);
  const retryAfter = retryable ? wait : undefined;
  const values = unconfirmed.length === 1 ? 'the value' : 'the values';
  /** The values as `field "value"`, joined as a list of `type`. */
  const named = (entries: readonly UnconfirmedValue[], type: 'conjunction' | 'disjunction') =>
    new Intl.ListFormat('en', { type }).format(
      entries.map(({ field, value }) => `${field} "${value}"`),
    );
  const unmatched = unconfirmed.filter(({ canonical }) => canonical.reason !== 'lookup_failed');
  const unchecked = unconfirmed.filter(({ canonical }) => canonical.reason === 'lookup_failed');
  const retryUnchecked =
    unchecked.length === 0
      ? ''
      : `, and retry ${wait === undefined ? 'shortly' : `after ${wait} s`} once ${named(unchecked, 'conjunction')} can be confirmed,`;
  const listed = [
    ...unconfirmed.map(
      ({ field, value, canonical }) =>
        `${field} "${value}" went unconfirmed (${unconfirmedTagReason(canonical)})`,
    ),
    ...(offMirrorBrand === undefined ? [] : [offMirrorBrandReason(offMirrorBrand)]),
  ].join('; ');
  const hint = retryable
    ? `${retryAfter === undefined ? 'Retry shortly' : `Retry after ${retryAfter} s`} — once ${values} can be confirmed, this server's local copy of the export serves page ${page}. Request page ${TAG_SEARCH_MAX_PAGE} or lower to read the live database now.`
    : offMirrorBrand === undefined
      ? `No Open Food Facts tag matches ${named(unmatched, 'disjunction')}: correct or drop ${unmatched.length === 1 ? 'it' : 'them'}${retryUnchecked} so this server's local copy of the export can serve page ${page}, or request page ${TAG_SEARCH_MAX_PAGE} or lower — at page_size ${pageSize} that reaches the first ${TAG_SEARCH_MAX_PAGE * pageSize} matches.`
      : offMirrorBrand.reason === 'not_held'
        ? livePagesHint(pageSize)
        : `${livePagesHint(pageSize)} ${BRAND_RELOAD_HINT}`;
  return {
    message: `A search by tag filters alone is served through page ${TAG_SEARCH_MAX_PAGE} only when it reads the live database, and page ${page} was requested: this server's local copy of the export serves deeper pages only when it confirms every value, and ${listed}.`,
    data: {
      page,
      page_size: pageSize,
      max_page: TAG_SEARCH_MAX_PAGE,
      unconfirmed: [
        ...unconfirmed.map(({ field, value, canonical }) => ({
          field,
          value,
          reason: canonical.reason,
          ...(canonical.reason === 'lookup_failed' && { cause: canonical.cause }),
        })),
        ...(offMirrorBrand === undefined
          ? []
          : [{ field: 'brands_tag', value: offMirrorBrand.value, reason: offMirrorBrand.reason }]),
      ],
      retryable,
      ...(retryAfter !== undefined && { retryAfter }),
      recovery: { hint },
    },
  };
}

/**
 * The refusal of a tag-only page past `TAG_SEARCH_MAX_PAGE` whose only value the ready mirror
 * cannot match is a brand (`OffMirrorBrand`): the search reads live, where that page is refused,
 * and the live count read says how many products it would match there, `liveTotal`, which reaches
 * into the page and so past every page the live database serves.
 */
function offMirrorBrandPageRefusal(
  page: number,
  pageSize: number,
  brand: OffMirrorBrand,
  liveTotal: number,
): { message: string; data: Record<string, unknown> } {
  const why =
    brand.reason === 'not_held'
      ? `holds no product under brands_tag "${brand.value}", in any of its spellings or Open Food Facts synonyms`
      : `matches brands_tag "${brand.value}" only once a full reload of it has keyed every brand, and that reload has not completed`;
  const hint = livePagesHint(pageSize, liveTotal);
  return {
    message: `A search by tag filters alone is served through page ${TAG_SEARCH_MAX_PAGE} only when it reads the live database, and page ${page} was requested: this server's local copy of the export ${why}, so the search reads the live database, where it matches ${liveTotal} products.`,
    data: {
      page,
      page_size: pageSize,
      max_page: TAG_SEARCH_MAX_PAGE,
      brand: brand.value,
      live_total: liveTotal,
      retryable: false,
      recovery: { hint: brand.reason === 'not_held' ? hint : `${hint} ${BRAND_RELOAD_HINT}` },
    },
  };
}

/** The retry hint of an exclusion refusal whose every value failed only because nothing was reached. */
const UNAVAILABLE_EXCLUSION_HINT =
  'Retry shortly — the allergen vocabulary could not be reached or gave no usable answer, so the value went unconfirmed. The canonical IDs of the 14 major allergens, such as "en:nuts" or "en:milk", are confirmed without it.';

/**
 * What still reaches the live database from a search the text index answered, which depends on
 * what the search carries. Nutrient constraints exist only on the text index, so no variant of a
 * search carrying them leaves it; otherwise dropping `query`, and `ingredients_tag`, which this
 * server sends only to the text index, does, keeping any filters the tag path applies. Returned as
 * the two phrasings the freshness note and the empty-result notice use.
 */
function liveDatabaseRoute(search: {
  nutrientFilters: boolean;
  ingredients: boolean;
  query: boolean;
  tagPathFilters: boolean;
}): { note: string; advice: string } {
  if (search.nutrientFilters) {
    return {
      note: 'Nutrient constraints are served only by this index, so no form of this search reads the live database.',
      advice:
        'nutrient_filters are served only by this index, so no form of this search reads the live database',
    };
  }
  const drop = search.ingredients ? `ingredients_tag${search.query ? ' and query' : ''}` : 'query';
  const lead = search.ingredients
    ? 'This server answers ingredients_tag only from this index. '
    : '';
  if (search.tagPathFilters) {
    return {
      note: `${lead}The same tag filters without ${drop} read the live database or this server's local copy of the export where it keeps one (source and mirror_as_of say which).`,
      advice: `re-run the same tag filters without ${drop} to read the live database or this server's local copy of the export`,
    };
  }
  return {
    note: `${lead}A search by tag filters alone, without ${drop}, reads the live database or this server's local copy of the export where it keeps one (source and mirror_as_of say which).`,
    advice: `a search without ${drop} reads the live database or this server's local copy of the export, so try expressing the product as tag filters instead (off_browse_taxonomy resolves them)`,
  };
}

/**
 * The freshness disclosure of a search the mirror answered, citing its as-of time where a live
 * tag-only answer reads the live database. Its filters matched the values stored with each record,
 * so a computed one (a grade, an allergen, an additive, an ingredient-analysis tag) is matched as
 * the note bounds it. The mirror orders `popularity_key` (the default) and `unique_scans_n` by the
 * values stored with each record, while the live search ranks both by its own current scan counts,
 * so those orders can differ page for page; scan counts also move without an edit, so the stored
 * ones are no newer than the record's last edit or the last full reload. The timestamps sort alike.
 */
function mirrorSnapshotNote(mirrorAsOf: string, sortBy: SearchParams['sort_by']): string {
  const scanSort = sortBy ?? 'popularity_key';
  const order =
    scanSort === 'popularity_key' || scanSort === 'unique_scans_n'
      ? ` ${sortBy === undefined ? 'The default order follows' : 'The order follows'} each record's stored ${scanSort}, which can differ page for page from a live search, where Open Food Facts orders it by its current scan counts.`
      : '';
  return `${mirrorCopyNote('These results come', mirrorAsOf, 'a product contributed or edited since then is missing or shown as it was')} The filters matched the values stored with each record, computed ones included.${order}`;
}

/** The unit an indexed nutrient value is in: energy in kcal, everything else in grams. */
function indexedUnit(key: string): 'kcal' | 'g' {
  return key === 'energy_kcal_100g' ? 'kcal' : 'g';
}

/**
 * One optional number per filterable nutrient, under the key `off_get_product` uses for it, so a
 * row's value and the product's current value line up by name.
 */
const INDEXED_NUTRIMENTS_SHAPE = Object.fromEntries(
  NUTRIENT_FIELDS.map((nutrient) => {
    const key = indexedNutrientKey(nutrient);
    const label = nutrient === 'energy-kcal' ? 'Energy' : nutrient.replace(/-/g, ' ');
    return [
      key,
      z
        .number()
        .optional()
        .describe(
          `${label[0]?.toUpperCase()}${label.slice(1)} in ${indexedUnit(key)} per 100 g, or per 100 ml for liquids, as the text index holds it. Absent when this nutrient was not constrained or the index holds no value for it.`,
        ),
    ];
  }),
) as Record<IndexedNutrientKey, z.ZodOptional<z.ZodNumber>>;

/** The constraints as the caller wrote them, for echoing: `sugars < 8, proteins >= 5`. */
function constraintEcho(filters: readonly NutrientFilter[]): string {
  return filters
    .map(
      ({ nutrient, operator, value }) =>
        `${nutrient} ${NUTRIENT_OPERATOR_SYMBOLS[operator]} ${value}`,
    )
    .join(', ');
}

/**
 * Freshness disclosure of a response the text backend answered while the service holds no date
 * for the index: its probe failed, timed out, or was skipped to spare the search budget. No date is
 * ever written here — the index moves whenever Open Food Facts reloads it, so a literal would be a
 * claim nothing re-checks. With a probed date, `textIndexSnapshotNote` names it instead.
 */
const TEXT_INDEX_SNAPSHOT_NOTE =
  'These results come from the text-search index, a snapshot that lags the live Open Food Facts database, so a recently contributed product can be missing from them.';

/**
 * The opening of `text_index_snapshot`: dated by `asOf`, the newest edit the index holds, which
 * also tells a caller that an edit made since is matched and shown as it was then, or
 * `TEXT_INDEX_SNAPSHOT_NOTE` when the service holds no date.
 */
function textIndexSnapshotNote(asOf: string | undefined): string {
  return asOf === undefined
    ? TEXT_INDEX_SNAPSHOT_NOTE
    : `These results come from the text-search index, whose newest record is dated ${asOf}, so a product contributed since is missing from them and one edited since is matched and shown as it was then.`;
}

export const offSearchProductsTool = tool('off_search_products', {
  title: 'Search Food Products',
  description:
    'Search Open Food Facts by full-text query, structured tag filters, or both at once. Returns a summary list with barcodes, product names, brands, quantity (which tells pack sizes of one product apart), Nutri-Score, NOVA group, Green-Score, categories, data completeness, and when each record was last modified and created — enough for triage and selection, not full label data. Use off_get_product on the returned barcodes for complete details. A text query and tag filters combine: every word of the query must match the product name or generic name, and every filter provided must hold (e.g. query "dark chocolate" with labels_tag "en:organic" and countries_tag "en:france" returns organic chocolate sold in France). The query searches names only, so express a category, label, or brand as categories_tag, labels_tag, or brands_tag rather than as query words. Numeric nutrient_filters express thresholds per 100 g, or per 100 ml for liquids, such as sugars below 8 g, each compared as given, and combine the same way; they reach only products whose text-index entry carries the constrained nutrient, and each row then carries the indexed values the thresholds were compared against. ingredients_tag takes canonical ingredient IDs (e.g. "en:inulin") that must all appear among the ingredients Open Food Facts parsed from the label, and combines the same way. nutrition_grade, nova_group, and ecoscore_grade (Green-Score) each take one grade or an array matching any of them. Tag filter values are canonical tag IDs (e.g. "en:organic", "en:no-gluten") — use off_browse_taxonomy to resolve human terms to tag IDs. A case variant, synonym, or singular of a tag is resolved to its canonical ID where Open Food Facts recognizes it; anything else is matched exactly. exclude_allergens and exclude_traces drop products that declare an allergen or a "may contain" trace, but a product with no allergen or trace data entered passes them, so confirm a candidate with off_get_product before relying on it. At least one search parameter is required. The two paths read different indexes: a search carrying query, nutrient_filters, or ingredients_tag is answered by the text index, a snapshot that lags the live database and whose newest record text_index_as_of dates, while a tag-only search reads the live database and is current, or, where this server keeps a local copy of the Open Food Facts export, can be served from that copy, which source and mirror_as_of then report and whose default order and popularity_key or unique_scans_n sort follow the values stored with each record, so they can differ from a live search, which ranks by its current scan counts — so a recently contributed product can be missing from a text search and present in the same search without query. Data is crowd-sourced; result count reflects contributed products, not all products in the market. Data under ODbL 1.0 — cite Open Food Facts in downstream use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        `Words to find. Every word must match the product name or generic name, in the product's main language or any of the major languages the text index analyzes, so a product named only in French is found by its French name. Categories, labels, brand, ingredients, and quantity are not searched, so express a category, label, or brand as categories_tag, labels_tag, or brands_tag (off_browse_taxonomy resolves category and label IDs), and put here only words the product name would carry. Punctuation separates words — except an underscore, an apostrophe or period inside a word, and a decimal comma inside a number — so each part of "milk-chocolate" or "salt/pepper" must match, while "l'eau" and "1,5" stay one word. Stop words such as "with", "the", "de", and "mit" are not required, and neither is a word that is a stop word in one of the languages searched (such as Spanish "soy"). At most ${MAX_QUERY_WORDS} words, counted as runs of letters and digits, so each part of a hyphenated or apostrophe-joined word counts. Example: "dark chocolate 70%". Supplying it routes the search to the text index, a snapshot that lags the live Open Food Facts database and whose newest record text_index_as_of dates; drop it, and nutrient_filters and ingredients_tag, which route there too, to run the same tag filters against the live database or, where this server keeps one, its local copy of the export.`,
      ),
    categories_tag: z
      .string()
      .optional()
      .describe(
        'Canonical category tag ID. Example: "en:breakfast-cereals", "en:cheeses". Use off_browse_taxonomy with facet="categories" to discover valid values.',
      ),
    brands_tag: z
      .string()
      .optional()
      .describe(
        'Brand name as printed, or its slug (lowercased, hyphenated). Example: "nutella", "kellogg-s". A brand is matched as a whole name: as given, under its slug — lowercased, common Latin accents dropped, punctuation and spaces hyphenated ("Ben & Jerry\'s" → "ben-jerry-s", "Nestlé" → "nestle"), the form older Open Food Facts records store it under — and under every other name its Open Food Facts brand entry lists, so "7-Up", "7up", and "Seven Up" match the same products. A partial or misspelled brand matches nothing rather than falling back to a near match. Query words reach product names only, so a brand is matched through this filter, never through query.',
      ),
    labels_tag: allOfTagInput(
      'One canonical label tag ID.',
      'Up to 10 canonical label tag IDs, all of which must apply.',
    )
      .optional()
      .describe(
        'Canonical label/certification tag ID, or an array of up to 10 that must all apply. Example: "en:organic", or ["en:organic", "en:fair-trade"] for products carrying both. Use off_browse_taxonomy with facet="labels".',
      ),
    allergens_tag: z
      .string()
      .optional()
      .describe(
        'Canonical allergen tag ID. Example: "en:milk", "en:gluten". Use off_browse_taxonomy with facet="allergens". Selects products that declare this allergen; it cannot select allergen-free products, because a product with no allergen tags may simply have none entered yet. To leave an allergen out, use exclude_allergens.',
      ),
    traces_tag: z
      .string()
      .optional()
      .describe(
        'Canonical allergen tag ID the label warns the product may contain as a trace ("may contain nuts"). Example: "en:nuts". Trace tags are allergen tags, so off_browse_taxonomy with facet="allergens" resolves them. Selects products carrying the warning; to leave them out, use exclude_traces.',
      ),
    exclude_allergens: z
      .array(z.string().describe('One canonical allergen tag ID to exclude, e.g. "en:nuts".'))
      .max(14)
      .optional()
      .describe(
        'Allergen tag IDs a product must not declare, all applied. Example: ["en:nuts", "en:peanuts"]. Each value must be an allergen tag Open Food Facts recognizes — resolve it with off_browse_taxonomy facet="allergens" — and one it does not recognize is rejected rather than sent, because it would exclude nothing. A product with no allergen data entered passes an exclusion, so check a candidate with off_get_product before relying on it.',
      ),
    exclude_traces: z
      .array(
        z.string().describe('One canonical allergen tag ID to exclude as a trace, e.g. "en:nuts".'),
      )
      .max(14)
      .optional()
      .describe(
        'Allergen tag IDs a product\'s label must not warn it may contain as traces, all applied. Example: ["en:nuts"]. Values are validated like exclude_allergens. A product with no trace data entered passes, so check a candidate with off_get_product before relying on it.',
      ),
    ingredients_analysis_tag: z
      .enum(INGREDIENTS_ANALYSIS_TAGS)
      .optional()
      .describe(
        'Vegan, vegetarian, or palm-oil verdict Open Food Facts computes from the parsed ingredients. Example: "en:vegan", "en:palm-oil-free". "en:maybe-vegan" and "en:may-contain-palm-oil" mean the ingredients could not settle it, and the "-unknown" values mean no verdict could be computed.',
      ),
    ingredients_tag: allOfTagInput(
      'One canonical ingredient tag ID.',
      'Up to 10 canonical ingredient tag IDs, all of which must appear.',
    )
      .optional()
      .describe(
        `Canonical ingredient tag ID, or an array of up to 10 that must all appear among the ingredients Open Food Facts parsed from the label. Example: "en:inulin", or ["en:inulin", "en:oat"] for products listing both. IDs are singular ("en:oat", not "en:oats"); use off_browse_taxonomy with facet="ingredients" to resolve them, and use ingredients_analysis_tag instead for a vegan, vegetarian, or palm-oil verdict. Each parsed ingredient also carries its taxonomy parents, so "en:vegetable" matches a product listing carrot. Served only by the text index, so supplying one routes the search there even without query — it then reads the lagging text index and is subject to the ${TEXT_SEARCH_RESULT_WINDOW}-result page window.`,
      ),
    additives_tag: z
      .string()
      .optional()
      .describe(
        'Canonical additive (E-number) tag ID. Example: "en:e322", "en:e330". Use off_browse_taxonomy with facet="additives".',
      ),
    nutrition_grade: z
      .union([
        z.enum(NUTRITION_GRADES).describe('One Nutri-Score grade.'),
        z
          .array(z.enum(NUTRITION_GRADES).describe('One Nutri-Score grade.'))
          .max(NUTRITION_GRADES.length)
          .describe('Nutri-Score grades, any of which a product may carry.'),
      ])
      .optional()
      .describe(
        'Filter by Nutri-Score grade, or an array of grades matching any of them. "a" is highest nutritional quality, "e" is lowest. Example: "a", or ["a", "b"] for B or better. A product carries one grade, so an array matches products graded any of its values, unlike labels_tag, whose values must all apply. Products without a score are excluded.',
      ),
    nova_group: z
      .union([
        z.enum(NOVA_GROUPS).describe('One NOVA group.'),
        z
          .array(z.enum(NOVA_GROUPS).describe('One NOVA group.'))
          .max(NOVA_GROUPS.length)
          .describe('NOVA groups, any of which a product may be in.'),
      ])
      .optional()
      .describe(
        'Filter by NOVA food processing class, or an array of classes matching any of them. "1"=unprocessed/minimally processed, "4"=ultra-processed. Example: "1", or ["1", "2"]. A product is in one class, so an array matches products in any of its classes, unlike labels_tag, whose values must all apply. Products without a NOVA score are excluded.',
      ),
    ecoscore_grade: z
      .union([
        z.enum(GREEN_SCORE_GRADES).describe('One Green-Score grade.'),
        z
          .array(z.enum(GREEN_SCORE_GRADES).describe('One Green-Score grade.'))
          .max(GREEN_SCORE_GRADES.length)
          .describe('Green-Score grades, any of which a product may carry.'),
      ])
      .optional()
      .describe(
        'Filter by Green-Score (environmental impact) grade, or an array of grades matching any of them: "a-plus" is the lowest impact, then "a" through "f". "a" does not include "a-plus", so ask for ["a-plus", "a"] for A or better. A product carries one grade, so an array matches products graded any of its values, unlike labels_tag, whose values must all apply. A search by tag filters alone, without ingredients_tag, matches the grade Open Food Facts files for France, while each row shows the world grade, so a row can show a different letter than the one it matched. Products without a Green-Score are excluded.',
      ),
    countries_tag: z
      .string()
      .optional()
      .describe(
        'Canonical country tag ID. Example: "en:france", "en:united-states". Filters to products sold in that country.',
      ),
    nutrient_filters: z
      .array(
        z
          .object({
            nutrient: z
              .enum(NUTRIENT_FIELDS)
              .describe(
                'Nutrient to constrain, measured per 100 g, or per 100 ml for liquids. Energy is kilocalories; every other value is grams.',
              ),
            operator: z
              .enum(NUTRIENT_OPERATORS)
              .describe(
                'Comparison against value: "lt" below, "lte" at or below, "gt" above, "gte" at or above.',
              ),
            value: z
              .number()
              .min(0)
              .describe(
                'Threshold to compare against: kilocalories for energy, grams for every other nutrient, per 100 g, or per 100 ml for liquids.',
              ),
          })
          .describe(
            'One numeric constraint on a nutrient value per 100 g, or per 100 ml for liquids.',
          ),
      )
      .max(18)
      .optional()
      .describe(
        `Numeric constraints on nutrient values per 100 g, or per 100 ml for liquids, combined as AND with each other and with every other filter. Each bound is compared as given, decimals included: sugars gt 3.5 excludes 3.5 and keeps 3.6. Pair two entries on the same nutrient to express a range (e.g. sugars gte 2 and sugars lte 8). A constraint reaches only products whose text-index entry carries that nutrient, and many entries carry no nutrient values even when the record off_get_product reads has them, so a product meeting the constraint can be missing from the results, and an empty result does not show that none exists. Served only by the text backend, so supplying one routes the search there even without query — it then reads the lagging text index and is subject to the ${TEXT_SEARCH_RESULT_WINDOW}-result page window. Per-serving and prepared-product values are not searchable.`,
      ),
    sort_by: z
      .enum(['last_modified_t', 'unique_scans_n', 'created_t', 'popularity_key'])
      .optional()
      .describe(
        'Sort order, applied on every search. Each value orders newest or highest first: "unique_scans_n" surfaces the most-scanned products, "last_modified_t" and "created_t" the most recently updated and newest records, by the times each row carries as last_modified and created, "popularity_key" the most popular. Omitting it leaves text searches relevance-ranked and tag-only searches in the default order. Where this server serves a tag-only search from its local copy of the export (source "off_mirror"), the default order and "popularity_key" and "unique_scans_n" follow the values stored with each record, so they can differ from a live search, which ranks by its current scan counts; "last_modified_t" and "created_t" sort alike.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        `Page number (1-based). Use with page_size to paginate results. Pages are counted at the page_size served, which is at most ${SEARCH_PAGE_SIZE_CAP}, so repeating one larger page_size pages contiguously (page 2 at page_size ${2 * SEARCH_PAGE_SIZE_CAP} is results ${SEARCH_PAGE_SIZE_CAP + 1}–${2 * SEARCH_PAGE_SIZE_CAP}). A search by tag filters alone that reads the live database is served through page ${TAG_SEARCH_MAX_PAGE} only, so at page_size ${SEARCH_PAGE_SIZE_CAP} it reaches the first ${TAG_SEARCH_MAX_PAGE * SEARCH_PAGE_SIZE_CAP} matches; where this server keeps a local copy of the export, a tag-only search whose every value it confirms (canonical IDs from off_browse_taxonomy, and a brand it holds products under in any of its spellings or Open Food Facts synonyms) is served from that copy through its first ${MIRROR_SEARCH_RESULT_WINDOW} results, so page * page_size (as served) must stay at or below ${MIRROR_SEARCH_RESULT_WINDOW} there. One carrying ecoscore_grade is served from that copy only once a full reload of it has indexed Green-Score, and one carrying brands_tag only once a full reload of it has keyed every brand. A search carrying query, nutrient_filters, or ingredients_tag serves only the first ${TEXT_SEARCH_RESULT_WINDOW} results, so page * page_size (as served) must stay at or below ${TEXT_SEARCH_RESULT_WINDOW}. A request past any of these bounds is rejected rather than sent; narrow the filters or change sort_by to bring other products forward. A brand the local copy cannot match — one it holds no product under, or any brand before that reload — is the exception on a page past ${TAG_SEARCH_MAX_PAGE}: one live count answers it empty, with that total, when the live matches end before the page, and rejects it when they reach into it.`,
      ),
    page_size: z
      .number()
      .multipleOf(1, 'Send page_size as a whole number, not a fractional one.')
      // multipleOf tolerates float noise (20.000000000000004), which would reach the request. It
      // stays for what it advertises; this closes the gap, only where it passed, so 1.5 reports once.
      .refine(Number.isInteger, {
        error: 'Send page_size as a whole number, not a fractional one.',
        when: ({ issues }) => issues.length === 0,
      })
      .min(1)
      .default(20)
      .describe(
        `Results per page (default 20). One call returns at most ${SEARCH_PAGE_SIZE_CAP}: a larger value is served at ${SEARCH_PAGE_SIZE_CAP}, reported in page_size and page_size_capped, and page then counts pages of ${SEARCH_PAGE_SIZE_CAP}. Keep low for initial exploration; increase for comparison workflows.`,
      ),
  }),

  output: z.object({
    total: z
      .number()
      .describe(
        'Matching products in the database for this search. Exact unless total_is_lower_bound is true, in which case at least this many match and the real figure is unknown.',
      ),
    total_is_lower_bound: z
      .boolean()
      .describe(
        'True when the backend stopped counting at its ceiling and total is a floor, not the match total. Only text searches can hit it; add filters to bring the result set under the ceiling and get an exact count.',
      ),
    page: z.number().describe('Current page number (1-based).'),
    page_size: z
      .number()
      .describe(
        `The page_size served: the one requested, or ${SEARCH_PAGE_SIZE_CAP} when a larger one was requested. page and last_page count pages of this size.`,
      ),
    page_count: z
      .number()
      .describe(
        'Products returned on this page — page_size except on the last page, or when a match stored under a code Open Food Facts cannot serve was left off. Not the total number of pages.',
      ),
    last_page: z
      .number()
      .optional()
      .describe(
        `Deepest page of this result set that holds products and can be requested, at the page_size served — capped at page ${TAG_SEARCH_MAX_PAGE} on a search by tag filters alone that read the live database, by the ${TEXT_SEARCH_RESULT_WINDOW}-result window on a search the text index answers, and by the local copy's ${MIRROR_SEARCH_RESULT_WINDOW}-result window when source is "off_mirror". Absent when total_is_lower_bound is true — the total it would divide is the ceiling the backend stopped counting at, so no exact last page exists — and when nothing matched at all.`,
      ),
    omitted: z
      .number()
      .optional()
      .describe(
        'Matches on this page left off because Open Food Facts stores them under a code it cannot serve (not 4–40 digits once leading zeros are stripped), so off_get_product could not look them up either. Absent when none was. total still counts them.',
      ),
    source: z
      .enum(['off_api', 'off_mirror'])
      .describe(
        'Where this answer was read: "off_api", Open Food Facts itself, or "off_mirror", this server\'s local copy of the Open Food Facts export, which serves a search by tag filters alone on a deployment that keeps one.',
      ),
    mirror_as_of: z
      .string()
      .optional()
      .describe(
        'ISO 8601 time up to which the local copy reflects every product contributed or edited on Open Food Facts. Present only when source is "off_mirror".',
      ),
    text_index_as_of: z
      .string()
      .optional()
      .describe(
        'ISO 8601 time of the newest record in the text index — its latest last_modified — so a product contributed since is missing from these results and one edited since is matched and shown as it was then. Present only on searches the text index answered, and only when this server could read that time; absent otherwise, with text_index_snapshot then undated.',
      ),
    products: z
      .array(
        z
          .object({
            barcode: z
              .string()
              .describe(
                'Product barcode, 4–40 digits after any leading zeros — a code off_get_product accepts as is, so pass it there for full details. A match stored under a code Open Food Facts cannot serve is left off the page.',
              ),
            product_name: z
              .string()
              .optional()
              .describe('Product name. May be absent for incompletely entered products.'),
            brands: z
              .string()
              .optional()
              .describe(
                'Brand name(s), comma-separated. Absent when not yet entered. On a search the text index answers, the brands as that index stores them — each a brand\'s slug or its name as a contributor typed it (e.g. "heinz", "Member\'s Mark") — rather than the display name off_get_product returns.',
              ),
            quantity: z
              .string()
              .optional()
              .describe(
                'Net quantity as printed on the packaging (e.g. "400 g", "1 kg"), which tells pack sizes and editions of one product apart. Absent when not yet entered. On a search the text index answers, the value of the revision it indexed.',
              ),
            nutriscore_grade: z
              .string()
              .optional()
              .describe(
                'Nutri-Score grade: "a" through "e", "unknown" when the nutrition data entered is not enough to compute it, or "not-applicable" for product categories the score does not cover. Absent when Open Food Facts sent none.',
              ),
            nova_group: z
              .number()
              .optional()
              .describe('NOVA processing class (1–4). Absent when not assigned.'),
            ecoscore_grade: z
              .string()
              .optional()
              .describe(
                'Green-Score environmental impact grade: "a-plus" (lowest impact), then "a" through "f"; "unknown" when the data it needs is missing, or "not-applicable" for product categories the score does not cover. Absent when Open Food Facts sent none.',
              ),
            categories_tags: z
              .array(z.string().describe('Canonical category tag ID (e.g. "en:cheeses").'))
              .optional()
              .describe(
                'Category tag IDs in canonical form. Use as filter values for off_search_products.',
              ),
            completeness: z
              .number()
              .optional()
              .describe(
                'Data completeness score as Open Food Facts reports it: higher means more of the record is filled in, and it can exceed 1 (e.g. 1.0875). Below 0.5 indicates many fields are missing. Absent when Open Food Facts sent none. On a search the text index answers, the score of the revision it indexed.',
              ),
            last_modified: z
              .string()
              .optional()
              .describe(
                'When the record was last edited, as an ISO 8601 time (e.g. "2026-05-26T19:35:02.000Z") — the value sort_by "last_modified_t" orders by. On a search the text index answers, the edit time of the revision it indexed: the index lags the live database, so off_get_product can read a later revision; when source is "off_mirror", that of the revision the local copy holds. Absent when the record holds none.',
              ),
            created: z
              .string()
              .optional()
              .describe(
                'When the record was created, as an ISO 8601 time (e.g. "2014-11-09T21:02:13.000Z") — the value sort_by "created_t" orders by. Absent when the record holds none.',
              ),
            indexed_nutriments: z
              .object(INDEXED_NUTRIMENTS_SHAPE)
              .optional()
              .describe(
                'Present on every row of a search carrying nutrient_filters, and only there: the values the text index holds for the constrained nutrients, per 100 g, or per 100 ml for liquids — the values the filters were compared against. Keyed as off_get_product keys them (sugars_100g, energy_kcal_100g). A nutrient the index holds no numeric value for is left out, never zero-filled. off_get_product returns the current record, whose values can differ.',
              ),
          })
          .describe('A single matching product summary row.'),
      )
      .describe('Matching products. Use barcodes with off_get_product for full label data.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance about this result set — echoes the filters and suggests how to broaden when nothing matched, names the current page and how far the backend will actually paginate when more results exist, or, on a page that returned no rows because it lies past the last match or every match on it was left off, says which page to request instead.',
      ),
    text_index_snapshot: z
      .string()
      .optional()
      .describe(
        'Present only on searches the text backend answered. States that those results come from an index snapshot that lags the live Open Food Facts database, so a product can be missing from them while the tag-only path still returns it: when text_index_as_of is present it names that time and says a product contributed since is missing and one edited since is matched and shown as it was then; otherwise it says a recently contributed product can be missing. On a search carrying nutrition_grade, nova_group, or ecoscore_grade it also says those filters were matched against the grades the index holds, which each row shows and which can differ from what off_get_product returns. On a search carrying nutrient_filters it also echoes the constraints and says they were compared as given against the index values each row carries as indexed_nutriments, so they reach only products whose index entry carries each constrained nutrient, and that those values can differ from what off_get_product returns. Absent on tag-only searches, which read the live database or, when source is "off_mirror", the local copy mirror_snapshot describes.',
      ),
    mirror_snapshot: z
      .string()
      .optional()
      .describe(
        "Present only when source is \"off_mirror\". States that the results come from the local copy, which reflects contributor edits through mirror_as_of, so a product contributed or edited since is missing or shown as it was; that computed values (grades, nutrient levels, estimated nutrients, parsed ingredients and their analysis, additives, allergens and traces, completeness, data-quality tags) are as of the record's last edit or the copy's last full reload (about every 30 days), whichever is later; that a product removed since that reload can still be shown; that the filters matched the values stored with each record, computed ones included; and, under the default order or a popularity_key or unique_scans_n sort, that the order follows each record's stored value and can differ from a live search.",
      ),
    exclusion_coverage: z
      .string()
      .optional()
      .describe(
        'Present only on searches carrying exclude_allergens or exclude_traces. States that products with no allergen or trace data entered pass an exclusion, so a result is not confirmed free of the excluded allergens, and names the off_get_product fields to check.',
      ),
    page_size_capped: z
      .string()
      .optional()
      .describe(
        `Present only when page_size was above ${SEARCH_PAGE_SIZE_CAP}: names the page_size requested and the ${SEARCH_PAGE_SIZE_CAP} served, and, when a further page holds matches and can be requested, the page to request next and the results it holds.`,
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more results exist beyond this page. Absent on the final page of a result set.',
      ),
    shown: z.number().optional().describe('Number of products returned on this page.'),
    cap: z.number().optional().describe('The page_size that was applied.'),
  },

  // These fields are authored prose, not values a caller copies into its next call, so the notice
  // renders as a block quote and the rest as labelled sentences; the framework's default for a
  // string field is a code span. The prose echoes caller and upstream values, so it is escaped here
  // at render time: structuredContent keeps those values as sent.
  enrichmentTrailer: {
    notice: { render: (v) => `> ${mdInline(String(v))}` },
    text_index_snapshot: { render: (v) => `**Index freshness:** ${mdInline(String(v))}` },
    mirror_snapshot: { render: mirrorSnapshotTrailer },
    exclusion_coverage: { render: (v) => `**Exclusions:** ${mdInline(String(v))}` },
    page_size_capped: { render: (v) => `**Page size:** ${mdInline(String(v))}` },
  },

  errors: [
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No search query or filter was provided',
      severity: 'warning',
      recovery:
        'Provide at least one of: query, categories_tag, brands_tag, labels_tag, allergens_tag, traces_tag, exclude_allergens, exclude_traces, ingredients_analysis_tag, ingredients_tag, additives_tag, nutrient_filters, nutrition_grade, nova_group, ecoscore_grade, or countries_tag.',
    },
    {
      reason: 'unrecognized_exclusion',
      code: JsonRpcErrorCode.ValidationError,
      when: "An exclude_allergens or exclude_traces value is not an allergen tag the Open Food Facts vocabulary confirms, or could not be checked because the vocabulary could not be reached or gave no usable answer, Open Food Facts rate-limited the lookup, or this server's own taxonomy budget was spent — an unrecognized exclusion would exclude nothing",
      retryable: false,
      severity: 'warning',
      recovery:
        'Resolve each excluded value to its canonical allergen tag ID with off_browse_taxonomy (facet "allergens"), such as "en:nuts" or "en:milk", and search again.',
    },
    {
      reason: 'query_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: `query carries more than ${MAX_QUERY_WORDS} words, the most one text search accepts`,
      retryable: false,
      severity: 'warning',
      recovery: `Keep only the few distinctive words of the product's name (at most ${MAX_QUERY_WORDS}, and every one must match), and move brand, category, label, allergen, or country wording into the matching tag filter.`,
    },
    {
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: `A search by tag filters alone asks for a page past ${TAG_SEARCH_MAX_PAGE} and would read the live database — this server keeps no ready local copy of the export, a tag value is one it cannot confirm, the brand is one it holds no product under, or one it has not yet keyed in a full reload, and the live database matches enough products to reach into the requested page, or the search carries ecoscore_grade before a full reload of that copy has indexed Green-Score — or a search the text backend serves asks for page * page_size beyond its ${TEXT_SEARCH_RESULT_WINDOW}-result window, or one the local copy serves beyond its ${MIRROR_SEARCH_RESULT_WINDOW}-result window, counting page_size at the ${SEARCH_PAGE_SIZE_CAP} served when a larger one was requested`,
      retryable: false,
      severity: 'warning',
      recovery:
        'Request an earlier page, or add filters so the products you need fall inside the first results rather than deep in the ranking.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Open Food Facts returns a 5xx other than 501 or 504, serves an HTML error page with a 2xx or 5xx status, reports a search-engine failure inside an HTTP 200, answers 2xx with a malformed envelope, closes the connection before finishing its answer, or is unreachable',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry after a brief pause — the Open Food Facts service may be shedding load. If it keeps failing, narrow the filters or try again later.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Open Food Facts did not answer within the request or retry deadline, flagged its text search as timed out, or answered 408, 425, or 504',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Retry once with a smaller page_size. Broad unfiltered searches are the slowest for Open Food Facts to assemble.',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Open Food Facts refuses the request with a 4xx other than 408, 425, or 429, or with 501 Not Implemented — the request as formed will be refused again',
      retryable: false,
      thrownBy: 'service',
      // Static: the service throws this reason with no hint, and a handler that rewrote it per call
      // would have to catch. The wording covers both paths without asserting any input is wrong.
      recovery:
        'Do not resend the same request. Read data.status and the upstream explanation in the message, and change an input only when that explanation names a value this call supplied; otherwise Open Food Facts refused the request as this server built it, and when the call carried query, nutrient_filters, or ingredients_tag, the same tag filters without them are answered by a different backend.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own per-minute search budget is spent, or Open Food Facts answers 429",
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Wait the seconds given in data.retryAfter, or about a minute when it is absent, then retry. Searches carry a much smaller budget than product lookups.',
    },
  ],

  async handler(input, ctx) {
    const query = input.query?.trim();
    const nutrientFilters = input.nutrient_filters ?? [];
    const hasIngredients = tagValues(input.ingredients_tag).length > 0;
    // Nutrient constraints are served only by the text backend, and an ingredient filter only from
    // it (the mirror indexes no ingredients, and the live tag path stops at page 10), so either
    // carries every property of that path — the result window, the lagging index — with or
    // without a query.
    const servedByTextBackend = Boolean(query) || nutrientFilters.length > 0 || hasIngredients;
    // Every page computation below — what is sent, the page bounds, last_page, truncation — runs at
    // the size served, so a repeated over-cap page_size pages contiguously in pages of the cap.
    const pageSize = Math.min(input.page_size, SEARCH_PAGE_SIZE_CAP);
    // The deepest page the text backend's result window, and the mirror's, reach at this page_size.
    const textMaxPage = Math.floor(TEXT_SEARCH_RESULT_WINDOW / pageSize);
    const mirrorMaxPage = Math.floor(MIRROR_SEARCH_RESULT_WINDOW / pageSize);
    // The page_size a window refusal names: as served, and as requested when that was larger.
    const servedPageSize =
      pageSize < input.page_size
        ? `page_size ${input.page_size} served at ${pageSize}`
        : `page_size ${pageSize}`;
    const additive = input.additives_tag?.trim();
    const hasExclusion = EXCLUSION_FILTERS.some(({ key }) => tagValues(input[key]).length > 0);
    const grades = GRADE_FILTERS.flatMap(({ key, label }): AppliedGradeFilter[] => {
      const values = gradeValues(input[key]);
      return values.length > 0 ? [{ key, label, values }] : [];
    });
    const hasFilter =
      servedByTextBackend ||
      hasExclusion ||
      TAG_FILTERS.some(({ key }) => tagValues(input[key]).length > 0) ||
      Boolean(additive) ||
      Boolean(input.ingredients_analysis_tag) ||
      grades.length > 0;

    if (!hasFilter) {
      throw ctx.fail('no_filters', 'At least one search parameter is required.');
    }

    // A longer query is refused before a request is spent on it.
    const wordCount = query ? countQueryWords(query) : 0;
    if (wordCount > MAX_QUERY_WORDS) {
      throw ctx.fail(
        'query_too_long',
        `query has ${wordCount} words; a text search accepts at most ${MAX_QUERY_WORDS}.`,
        { word_count: wordCount, max_words: MAX_QUERY_WORDS },
      );
    }

    const svc = getOpenFoodFactsService();
    // Only the local mirror serves a tag-only page past TAG_SEARCH_MAX_PAGE, and only a search
    // whose every value it can match as stored, so a tag-only search asks first whether it is
    // ready. A search the text backend answers never reads it. Rows built before the mirror
    // indexed Green-Score carry no Green-Score tag, so a search carrying ecoscore_grade also asks
    // whether its last full load did, and until one has, runs exactly as with no mirror.
    const mirrorReady = !servedByTextBackend && (await svc.mirrorReady(ctx));
    const greenScoreUnindexed =
      mirrorReady &&
      grades.some(({ key }) => key === 'ecoscore_grade') &&
      !(await svc.mirrorIndexesGreenScore(ctx));
    const mirror = mirrorReady && !greenScoreUnindexed;
    // Rows built before the mirror keyed brands hold a brand under the spelling their record
    // carries, so a brand's keys there count part of its products. Until a full load has keyed
    // every brand, a search carrying brands_tag reads live, as one the mirror holds no product
    // under does, with the live count answering a page past TAG_SEARCH_MAX_PAGE.
    const brand = tagValues(input.brands_tag)[0];
    const brandUnindexed =
      mirror && brand !== undefined && !(await svc.mirrorIndexesBrandKeys(ctx));

    // Product Opener refuses every anonymous page past 10 with an HTTP 401, whatever the page_size
    // and however few products match. Reject such a page with the bound instead of sending a
    // request that cannot succeed: here when no mirror is ready, before any lookup is spent, and
    // when the service answers that the mirror could not serve the search after all. A value the
    // ready mirror cannot match is refused by `unconfirmedPageRefusal`, which names it, and a brand
    // it holds no product under, when nothing else keeps the search off it, only once a live count
    // read finds matches reaching into the page.
    const tagPageRefusal = () =>
      ctx.fail(
        'page_out_of_range',
        `A search by tag filters alone is served through page ${TAG_SEARCH_MAX_PAGE} only, and page ${input.page} was requested.`,
        {
          page: input.page,
          page_size: pageSize,
          max_page: TAG_SEARCH_MAX_PAGE,
          recovery: { hint: livePagesHint(pageSize) },
        },
      );
    // The mirror serves a search through its result window only, which bounds the work one page
    // costs the serving process. Refused once the search is known to be the mirror's — every value
    // confirmed — before the service is called, and when the service answers that bound itself.
    const mirrorWindowRefusal = () =>
      ctx.fail(
        'page_out_of_range',
        `This server's local copy of the export serves only the first ${MIRROR_SEARCH_RESULT_WINDOW} results of a search, and page ${input.page} at ${servedPageSize} asks for result ${input.page * pageSize}.`,
        {
          page: input.page,
          page_size: pageSize,
          max_page: mirrorMaxPage,
          result_window: MIRROR_SEARCH_RESULT_WINDOW,
          recovery: {
            hint: `Request page ${mirrorMaxPage} or lower at page_size ${pageSize}, or narrow the filters or change sort_by so the products you need fall inside the first ${MIRROR_SEARCH_RESULT_WINDOW} results.`,
          },
        },
      );
    // A ready mirror that has not indexed Green-Score leaves a search carrying ecoscore_grade to
    // the live bound, so the refusal names the filter and the reload that lifts the bound.
    const greenScorePageRefusal = () =>
      ctx.fail(
        'page_out_of_range',
        `A search by tag filters alone is served through page ${TAG_SEARCH_MAX_PAGE} only when it reads the live database, and page ${input.page} was requested: this server's local copy of the export serves a search carrying ecoscore_grade only once a full reload has indexed Green-Score, and that reload has not completed.`,
        {
          page: input.page,
          page_size: pageSize,
          max_page: TAG_SEARCH_MAX_PAGE,
          recovery: {
            hint: `Request page ${TAG_SEARCH_MAX_PAGE} or lower — at page_size ${pageSize} that reaches the first ${TAG_SEARCH_MAX_PAGE * pageSize} matches — or retry once this server's local copy of the export completes the full reload that indexes Green-Score. Without ecoscore_grade, the copy serves pages past ${TAG_SEARCH_MAX_PAGE} of a search whose every value it confirms.`,
          },
        },
      );
    if (!servedByTextBackend && !mirror && input.page > TAG_SEARCH_MAX_PAGE) {
      throw greenScoreUnindexed ? greenScorePageRefusal() : tagPageRefusal();
    }

    // The text backend refuses page * page_size beyond its result window with an HTTP 422 that no
    // retry can clear. Reject it here so the caller gets the reachable page bound instead of a
    // backoff sequence.
    if (servedByTextBackend && input.page * pageSize > TEXT_SEARCH_RESULT_WINDOW) {
      throw ctx.fail(
        'page_out_of_range',
        `The text backend serves only the first ${TEXT_SEARCH_RESULT_WINDOW} results, and page ${input.page} at ${servedPageSize} asks for result ${input.page * pageSize}.`,
        {
          page: input.page,
          page_size: pageSize,
          max_page: textMaxPage,
          result_window: TEXT_SEARCH_RESULT_WINDOW,
          recovery: {
            hint: `Request page ${textMaxPage} or lower at page_size ${pageSize}, or add filters so the products you need rank inside the first ${TEXT_SEARCH_RESULT_WINDOW} results.`,
          },
        },
      );
    }

    // The text backend's tag fields are exact-match keywords, so a value the tag path would
    // canonicalize (case, synonym, singular, missing prefix) matches nothing there. Canonicalize
    // each value first; resolution is best-effort and fails the search only when the caller
    // cancels. The live tag path is left alone — Product Opener canonicalizes its parameters
    // itself — but the mirror matches stored tags exactly, so with it ready the tag path's values,
    // the additive included, are canonicalized too.
    //
    // Exclusions are canonicalized on both paths and must be confirmed: a value neither backend
    // recognizes is a negation that matches nothing, so it would exclude nothing and return every
    // product as though the exclusion held.
    //
    // A brand has no vocabulary and is never looked up: it goes under its keys (`brandKeys`, its
    // spellings and its Open Food Facts synonyms). The mirror matches it under the keys some
    // product it holds carries, and with none held the search reads live.
    //
    // Every lookup runs in this one parallel batch, so a call's longest chain stays one lookup
    // deadline plus one search read.
    const canonicalize = servedByTextBackend || mirror;
    const taxonomy = getTaxonomyService();
    const [resolvedTags, exclusions, canonicalAdditive, heldBrand] = await Promise.all([
      Promise.all(
        TAG_FILTERS.flatMap((filter) =>
          tagValues(input[filter.key]).map((given): Promise<Omit<AppliedTagFilter, 'sent'>> => {
            const { key, label } = filter;
            return canonicalize && 'facet' in filter
              ? taxonomy
                  .canonicalizeTag(filter.facet, given, ctx)
                  .then((canonical) => ({ key, label, given, canonical }))
              : Promise.resolve({ key, label, given });
          }),
        ),
      ),
      Promise.all(
        EXCLUSION_FILTERS.flatMap(({ key }) =>
          tagValues(input[key]).map(
            (given): Promise<AppliedExclusion> =>
              taxonomy
                .canonicalizeTag('allergens', given, ctx)
                .then((canonical) => ({ key, given, canonical })),
          ),
        ),
      ),
      canonicalize && additive ? taxonomy.canonicalizeTag('additives', additive, ctx) : undefined,
      mirror && brand !== undefined && !brandUnindexed
        ? svc.mirrorHeldBrand(brandKeys(brand), ctx)
        : undefined,
    ]);

    const refused = exclusions.flatMap(({ key, given, canonical }) =>
      canonical.resolution === 'normalized' ? [{ key, given, canonical }] : [],
    );
    if (refused.length > 0) {
      // A refusal the vocabulary could not settle — a lookup that failed for any cause — can
      // succeed on a retry; one it answered cannot, so the retry flag holds only when every
      // refusal is of the first kind.
      const failedLookups = refused.flatMap(({ canonical }) =>
        canonical.reason === 'lookup_failed' ? [canonical] : [],
      );
      const retryable = failedLookups.length === refused.length;
      const retryAfter = longestWait(failedLookups);
      const causes = [...new Set(failedLookups.map(({ cause }) => cause))];
      const hint = causes.every((cause) => cause === 'unavailable')
        ? UNAVAILABLE_EXCLUSION_HINT
        : `${retryAfter === undefined ? 'Retry in about a minute' : `Retry after ${retryAfter} s`} — ${causes.map((cause) => EXCLUSION_LOOKUP_FAILURES[cause]).join('; ')}, so ${failedLookups.length === 1 ? 'the value' : 'the values'} went unconfirmed. The canonical IDs of the 14 major allergens, such as "en:nuts" or "en:milk", are confirmed without a lookup.`;
      const listed = refused
        .map(({ key, given, canonical }) => refusedExclusion(key, given, canonical))
        .join('; ');
      throw ctx.fail(
        'unrecognized_exclusion',
        `Exclusions are sent only as allergen tags Open Food Facts confirms, because an unrecognized one excludes nothing: ${listed}.`,
        {
          unrecognized: refused.map(({ key, given, canonical }) => ({
            field: key,
            value: given,
            reason: canonical.reason,
            ...(canonical.reason === 'lookup_failed' && { cause: canonical.cause }),
          })),
          retryable,
          ...(retryable && retryAfter !== undefined && { retryAfter }),
          ...(retryable && { recovery: { hint } }),
        },
      );
    }

    // The mirror serves the search only when it can match every value as stored: each taxonomy
    // value confirmed, and the brand held. Exclusions were confirmed above, and nutrition_grade,
    // nova_group, ecoscore_grade, and ingredients_analysis_tag are closed vocabularies the input
    // schema enforces.
    const unconfirmed: UnconfirmedValue[] = mirror
      ? [
          ...resolvedTags.flatMap(({ key, given, canonical }) =>
            canonical?.resolution === 'normalized' ? [{ field: key, value: given, canonical }] : [],
          ),
          ...(additive && canonicalAdditive?.resolution === 'normalized'
            ? [{ field: 'additives_tag', value: additive, canonical: canonicalAdditive }]
            : []),
        ]
      : [];
    const offMirrorBrand: OffMirrorBrand | undefined =
      mirror && brand !== undefined && heldBrand === undefined
        ? { value: brand, reason: brandUnindexed ? 'unindexed' : 'not_held' }
        : undefined;
    const allConfirmed = mirror && unconfirmed.length === 0 && offMirrorBrand === undefined;
    // The mirror is ready (an earlier check refused this page without it) but cannot match a value,
    // so the search would read live, which cannot serve this page. The refusal names each such
    // value, since one whose lookup failed is served from the mirror on a retry. When the only such
    // value is the brand, a live count settles the page below.
    const pastLivePages = !servedByTextBackend && input.page > TAG_SEARCH_MAX_PAGE;
    if (pastLivePages && unconfirmed.length > 0) {
      const { message, data } = unconfirmedPageRefusal(
        input.page,
        pageSize,
        unconfirmed,
        offMirrorBrand,
      );
      throw ctx.fail('page_out_of_range', message, data);
    }
    if (allConfirmed && input.page * pageSize > MIRROR_SEARCH_RESULT_WINDOW) {
      throw mirrorWindowRefusal();
    }

    // Canonical values reach the text backend always, and the tag path only on a search the mirror
    // serves; any other tag-only search sends each value as given, as it did before the mirror. A
    // confirmed value goes under its entry's ID. The text index holds a value nothing confirmed
    // under the ID the text each record carries gives it, so one ending in a capital sigma goes
    // there under both IDs it can take (`taxonomyTextIds`). A brand goes under its keys in each
    // backend's form: the ones the mirror holds, `brandLiveIds` on the live tag path, and
    // `brandTextIds` on the text path.
    const sendCanonical = servedByTextBackend || allConfirmed;
    const tagFilters: AppliedTagFilter[] = resolvedTags.map((filter): AppliedTagFilter => {
      const { key, given, canonical } = filter;
      if (key === 'brands_tag') {
        const sent = servedByTextBackend
          ? brandTextIds(given)
          : allConfirmed && heldBrand !== undefined
            ? heldBrand
            : brandLiveIds(given);
        return { ...filter, sent };
      }
      if (!sendCanonical || canonical === undefined) return { ...filter, sent: [given] };
      if (canonical.resolution === 'vocabulary') return { ...filter, sent: [canonical.value] };
      return { ...filter, sent: taxonomyTextIds(given) };
    });

    const searchParams: ProductSearch = {
      page: input.page,
      page_size: pageSize,
    };
    if (query) searchParams.query = query;
    for (const filter of TAG_FILTERS) {
      const values = tagFilters
        .filter(({ key }) => key === filter.key)
        .map(({ sent }): TagValue => (sent.length === 1 ? sent[0] : [...sent]));
      const [first] = values;
      if (first === undefined) continue;
      // A value sent under several IDs goes as all of them, any of which matches. An all-of list
      // stays a list for the service, even of one, and so does a single value sent under several
      // IDs, since several IDs as the list itself would each be required; any other string stays a
      // string.
      if ('allOf' in filter && (Array.isArray(input[filter.key]) || typeof first !== 'string')) {
        searchParams[filter.key] = values;
      } else {
        searchParams[filter.key] = first;
      }
    }
    for (const { key } of EXCLUSION_FILTERS) {
      const sent = exclusions.filter((e) => e.key === key).map((e) => e.canonical.value);
      if (sent.length > 0) searchParams[key] = sent;
    }
    // The additive is canonicalized and sent as the values above are, under one ID: the service
    // takes one additive. It joins them wherever the sent tag values are named.
    const additiveFilter: AppliedTagFilter | undefined = additive
      ? {
          key: 'additives_tag',
          label: 'additive',
          given: additive,
          sent: [sendCanonical && canonicalAdditive ? canonicalAdditive.value : additive],
          ...(canonicalAdditive && { canonical: canonicalAdditive }),
        }
      : undefined;
    if (additiveFilter) searchParams.additives_tag = additiveFilter.sent[0];
    const sentTags = additiveFilter ? [...tagFilters, additiveFilter] : tagFilters;
    if (input.ingredients_analysis_tag) {
      searchParams.ingredients_analysis_tag = input.ingredients_analysis_tag;
    }
    // One distinct grade reaches the service as the string a single grade always did.
    for (const { key, values } of grades) {
      const [first, ...more] = values;
      if (first !== undefined) searchParams[key] = more.length > 0 ? values : first;
    }
    if (nutrientFilters.length > 0) searchParams.nutrient_filters = nutrientFilters;
    if (input.sort_by) searchParams.sort_by = input.sort_by;
    if (allConfirmed) searchParams.tags_confirmed = true;

    // A page past the live bound that only a brand the mirror cannot match keeps off it reads live,
    // which serves no such page, so the same filters are counted there instead: a total that ends
    // before the page starts answers the page empty with that total, as the mirror would answer
    // it, and one reaching into the page is refused.
    const countFirst = pastLivePages && offMirrorBrand !== undefined;
    let response = await svc.searchProducts(
      countFirst ? { ...searchParams, page: 1, page_size: 1 } : searchParams,
      ctx,
    );
    if (response.status === 'page_out_of_range') {
      throw { live_max_page: tagPageRefusal, mirror_window: mirrorWindowRefusal }[response.bound]();
    }
    if (countFirst) {
      if (response.count > (input.page - 1) * pageSize) {
        const { message, data } = offMirrorBrandPageRefusal(
          input.page,
          pageSize,
          offMirrorBrand,
          response.count,
        );
        throw ctx.fail('page_out_of_range', message, data);
      }
      // The count read's one row, or the one it dropped, is page 1's, never this page's.
      response = {
        ...response,
        page: input.page,
        page_size: pageSize,
        page_count: 0,
        products: [],
        dropped: 0,
      };
    }
    if (response.source === 'off_mirror') {
      ctx.enrich({ mirror_snapshot: mirrorSnapshotNote(response.mirrorAsOf, input.sort_by) });
    }

    const liveRoute = liveDatabaseRoute({
      nutrientFilters: nutrientFilters.length > 0,
      ingredients: hasIngredients,
      query: Boolean(query),
      tagPathFilters:
        sentTags.some(({ key }) => key !== 'ingredients_tag') ||
        exclusions.length > 0 ||
        Boolean(input.ingredients_analysis_tag) ||
        grades.length > 0,
    });
    if (servedByTextBackend) {
      // The index's grades lag the live records as its product set does, and a grade filter
      // matches them, so a row's grade can differ from the product's current one.
      const gradeKeys = grades.map(({ key }) => key);
      const gradeSubject = new Intl.ListFormat('en').format(gradeKeys);
      const gradesMatched =
        gradeKeys.length > 0
          ? ` The ${gradeSubject} ${gradeKeys.length === 1 ? 'filter was' : 'filters were'} matched against the grades this index holds, which each row shows; off_get_product returns the current record, whose grades can differ.`
          : '';
      // Many index entries carry no nutrient values, and a constraint cannot reach a record whose
      // entry lacks its nutrient, whatever the live record holds.
      const comparedAgainst =
        nutrientFilters.length > 0
          ? ` The nutrient constraints (${constraintEcho(nutrientFilters)}) were compared as given against this index's values, shown on each row as indexed_nutriments, so they reach only products whose index entry carries each constrained nutrient, which many entries do not; off_get_product returns the current record, whose values can differ.`
          : '';
      ctx.enrich({
        text_index_snapshot: `${textIndexSnapshotNote(response.textIndexAsOf)} ${liveRoute.note}${gradesMatched}${comparedAgainst}`,
      });
    }
    const exclusionCoverage = exclusionCoverageNote(exclusions);
    if (exclusionCoverage) ctx.enrich({ exclusion_coverage: exclusionCoverage });

    ctx.log.info('Product search completed', {
      total: response.count,
      total_is_lower_bound: !response.count_is_exact,
      returned: response.products.length,
      page: response.page,
      source: response.source,
    });

    // The deepest page the backend that answered serves: the text backend's or the mirror's result
    // window at this page_size, or the live tag path's page bound.
    const maxPage = servedByTextBackend
      ? textMaxPage
      : response.source === 'off_mirror'
        ? mirrorMaxPage
        : TAG_SEARCH_MAX_PAGE;
    // Pages the backend will actually serve, not pages implied by the match total.
    const totalPages = Math.ceil(response.count / pageSize);
    const reachablePages = Math.min(totalPages, maxPage);
    // Only a counted total yields a real last page: dividing a count the backend stopped
    // incrementing would present its ceiling as a measurement.
    const lastPage = response.count_is_exact && response.count > 0 ? reachablePages : undefined;
    // Matches exist past this page when the backend stopped counting, or when the pages up to and
    // including this one, at the size served, end before the total. Keyed on the page's offset,
    // never on the rows it delivered: a row left off for an unservable code shortens the page
    // without leaving anything beyond it.
    const moreBeyond = !response.count_is_exact || response.page * pageSize < response.count;

    if (pageSize < input.page_size) {
      // The rest of what was asked for starts on the next page, so name that call when one holds
      // matches and can be requested.
      const firstNext = response.page * pageSize + 1;
      const lastNext = (response.page + 1) * pageSize;
      const next =
        response.page < reachablePages
          ? ` Pages are counted at that size: request page ${response.page + 1} for results ${firstNext}–${response.count_is_exact ? Math.min(lastNext, response.count) : lastNext}.`
          : '';
      ctx.enrich({
        page_size_capped: `page_size ${input.page_size} is above the ${SEARCH_PAGE_SIZE_CAP} results one call returns; this page was served at page_size ${pageSize}.${next}`,
      });
    }

    if (response.products.length === 0 && response.dropped > 0) {
      // Every match on this page was left off, for a code no product lookup can serve. The page is
      // not past the end, and the search is matching rows, so neither notice applies. Truncation
      // follows the same offset rule as a page that kept its rows.
      const notice = [
        `Page ${response.page} lists no products:`,
        omittedSentence(response.dropped),
        emptyPageNextStep(response.page, reachablePages),
      ].join(' ');
      if (moreBeyond) {
        ctx.enrich.truncated({ shown: response.page_count, cap: pageSize, guidance: notice });
      } else {
        ctx.enrich.notice(notice);
      }
    } else if (response.products.length === 0 && response.count > 0) {
      // An empty page inside a positive result set is an exhausted page, not a zero-match search.
      // Both backends reach it with an ordinary HTTP 200, so nothing upstream distinguishes the
      // two — telling the caller to broaden filters that are matching products would be wrong.
      const single = response.count === 1;
      // A page past the live tag path's bound, answered from the live count, can sit beyond matches
      // that no page this search can request holds, so the bound then names how far it reaches.
      const bound =
        lastPage === undefined
          ? `The backend stopped counting at ${response.count} matches, so there is no exact last page — request an earlier page.`
          : lastPage * pageSize < response.count
            ? `Request page ${lastPage} or lower — at page_size ${pageSize} that reaches the first ${lastPage * pageSize} of the ${response.count} matches — or narrow the filters or change sort_by to bring the products you need forward.`
            : `Request page ${lastPage} or lower to reach ${single ? 'it' : 'them'}.`;

      ctx.enrich.notice(
        `Page ${response.page} is past the end of this result set — ${response.count} ${single ? 'matching product exists' : 'matching products exist'}, but no page this deep holds any. ${bound}`,
      );
    } else if (response.products.length === 0) {
      // Echoed as given but trimmed, and only when sent: a blank value never reaches a backend.
      const filterParts: string[] = [];
      const pushEcho = (label: string, value: string | readonly string[] | undefined) => {
        for (const entry of tagValues(value)) filterParts.push(`${label}="${entry}"`);
      };
      pushEcho('query', query);
      pushEcho('category', input.categories_tag);
      pushEcho('brand', input.brands_tag);
      pushEcho('label', input.labels_tag);
      pushEcho('allergen', input.allergens_tag);
      pushEcho('trace', input.traces_tag);
      pushEcho('additive', input.additives_tag);
      pushEcho('ingredients_analysis', input.ingredients_analysis_tag);
      pushEcho('ingredient', input.ingredients_tag);
      // A grade filter matches any of its values: nutriscore="a" or "b".
      for (const { label, values } of grades) {
        filterParts.push(`${label}=${values.map((value) => `"${value}"`).join(' or ')}`);
      }
      pushEcho('country', input.countries_tag);
      for (const { key, label } of EXCLUSION_FILTERS) pushEcho(label, input[key]);
      for (const filter of nutrientFilters) {
        filterParts.push(
          `nutrient="${filter.nutrient}${NUTRIENT_OPERATOR_SYMBOLS[filter.operator]}${filter.value}"`,
        );
      }

      const echo = `No products found for ${filterParts.join(', ')}.`;
      /**
       * Beside a brand, off_browse_taxonomy helps only with the other tag IDs the search sent, which
       * a caller can hold wrong: an inclusion tag filter or the additive. A grade or ingredients
       * analysis comes from a closed list, and an exclusion was confirmed before the search.
       * off_browse_taxonomy holds no brands, so a brand's spelling is the caller's to check.
       */
      const otherTagIds = sentTags.some(({ key }) => key !== 'brands_tag');
      if (!servedByTextBackend) {
        const checks =
          brand === undefined
            ? 'check tag IDs via off_browse_taxonomy'
            : otherTagIds
              ? "check the other tag IDs via off_browse_taxonomy and the brand's spelling"
              : "check the brand's spelling";
        const brandMatch = brand === undefined ? '' : ` A brand is matched ${BRAND_MATCH_REASON}.`;
        ctx.enrich.notice(
          `${echo} Try broader terms, ${checks}, or remove some filters.${brandMatch}`,
        );
      } else {
        // A text-path zero has three possible causes, and the caller needs the ones that apply to
        // this search named: a word no product carries, a tag value matched exactly, and index
        // lag — a text search that matched nothing is not evidence the product is absent from
        // Open Food Facts.
        const causes: string[] = [];
        if (query) {
          causes.push(
            'Every word of query must match the product name or generic name, so one word the name does not carry empties the result; drop or change such words, and express a category, label, or brand as categories_tag, labels_tag, or brands_tag.',
          );
          // A field:value form is matched as words, so its field name is required as a word too.
          const fieldName = /([\p{L}_]+):/u.exec(query)?.[1];
          if (fieldName) {
            causes.push(
              `query is matched as words, never as field:value syntax, so "${fieldName}" had to match as a word as well; put a field constraint in its filter input instead (brands_tag, categories_tag, nutrition_grade, …).`,
            );
          }
        }
        if (sentTags.length > 0) {
          const unconfirmed = sentTags.flatMap(({ key, label, given, sent, canonical }) => {
            const reason =
              key === 'brands_tag'
                ? BRAND_MATCH_REASON
                : canonical?.resolution === 'normalized'
                  ? unconfirmedTagReason(canonical)
                  : undefined;
            if (reason === undefined) return [];
            const asSent =
              sent.length === 1 && sent[0] === given
                ? ''
                : ` was sent as ${sent.map((id) => `"${id}"`).join(' or ')}`;
            return [`${label}="${given}"${asSent} (${reason})`];
          });
          const browse =
            brand === undefined
              ? ' Check tag IDs via off_browse_taxonomy.'
              : otherTagIds
                ? ' Check the other tag IDs via off_browse_taxonomy.'
                : '';
          causes.push(
            `Tag values are matched exactly on this path${unconfirmed.length > 0 ? `: ${unconfirmed.join('; ')}` : ''}.${browse}`,
          );
        }
        causes.push(
          `The text index may not hold recently contributed products, so an empty result here does not settle whether a matching product has been contributed: ${liveRoute.advice}, or call off_get_product when the barcode is known.`,
        );
        ctx.enrich.notice(`${echo} ${causes.join(' ')}`);
      }
    } else if (moreBeyond) {
      // Disclose when matches exist past this page. A final page — every match up to the total
      // already paged through — carries no disclosure, like a single-page result.
      let position: string;
      if (!response.count_is_exact) {
        // totalPages is derived from a count the backend stopped incrementing, so stating it would
        // dress the ceiling up as a measured figure. Only the reachable bound is knowable here.
        position =
          `Page ${response.page} of ${reachablePages} reachable pages — the backend stopped counting at ` +
          `${response.count} matches, so more exist than it will either count or serve.`;
      } else if (reachablePages < totalPages) {
        position =
          `Page ${response.page} of ${reachablePages} reachable pages — ${totalPages} pages of matches exist, ` +
          (servedByTextBackend
            ? `but text search serves only the first ${TEXT_SEARCH_RESULT_WINDOW} results.`
            : response.source === 'off_mirror'
              ? `but this server's local copy of the export serves only the first ${MIRROR_SEARCH_RESULT_WINDOW} results.`
              : `but a search by tag filters alone is served through page ${TAG_SEARCH_MAX_PAGE} only.`);
      } else {
        position = `Page ${response.page} of ${totalPages}.`;
      }

      // Matches exist beyond this page, so a page at or past the reachable bound means the bound
      // cut the result set.
      let nextStep: string;
      if (response.page < reachablePages) {
        nextStep = 'Use the page parameter to fetch subsequent pages.';
      } else if (servedByTextBackend) {
        // Already at the deepest page this backend serves. Pointing at the page parameter here
        // would send the caller into the rejection the pre-flight check exists to prevent.
        nextStep =
          'That is as deep as text search paginates — add filters so the products you need rank higher instead of paging further.';
      } else {
        nextStep =
          'That is as deep as a tag-only search paginates — narrow the filters or change sort_by to reach other products.';
      }

      ctx.enrich.truncated({
        shown: response.page_count,
        cap: pageSize,
        guidance: `${position} ${nextStep}`,
      });
    }

    const products = response.products.map((p) => {
      const completeness = completenessScore(p.completeness);
      return {
        barcode: p.code,
        ...(p.product_name && { product_name: p.product_name }),
        ...(p.brands && { brands: p.brands }),
        // An empty quantity is one not yet entered, like an absent one.
        ...(typeof p.quantity === 'string' && p.quantity !== '' && { quantity: p.quantity }),
        ...(p.nutriscore_grade && { nutriscore_grade: p.nutriscore_grade }),
        ...(typeof p.nova_group === 'number' && { nova_group: p.nova_group }),
        ...(p.ecoscore_grade && { ecoscore_grade: p.ecoscore_grade }),
        ...(p.categories_tags && { categories_tags: p.categories_tags }),
        ...(completeness !== undefined && { completeness }),
        ...recordDates(p),
        ...(p.indexed_nutriments && { indexed_nutriments: p.indexed_nutriments }),
      };
    });

    return {
      total: response.count,
      total_is_lower_bound: !response.count_is_exact,
      page: response.page,
      page_size: pageSize,
      page_count: response.page_count,
      ...(lastPage !== undefined && { last_page: lastPage }),
      ...(response.dropped > 0 && { omitted: response.dropped }),
      source: response.source,
      ...(response.source === 'off_mirror' && { mirror_as_of: response.mirrorAsOf }),
      ...(response.textIndexAsOf !== undefined && { text_index_as_of: response.textIndexAsOf }),
      products,
    };
  },

  format: (result) => {
    const source = [
      sourceLine(result.source, result.mirror_as_of),
      ...(result.text_index_as_of === undefined
        ? []
        : [`**Text index as of:** ${result.text_index_as_of}`]),
    ].join('\n');
    if (result.products.length === 0 && result.total === 0) {
      // What to try next depends on the filters, which format() never sees: the handler's notice,
      // on both surfaces, names it for every empty answer, so this block carries only the result.
      return [
        {
          type: 'text' as const,
          text: `**No products found** (total: ${result.total})\n\n${source}`,
        },
      ];
    }

    const totalLabel = `${result.total}${result.total_is_lower_bound ? '+' : ''} ${result.total === 1 ? 'total product' : 'total products'}`;
    /** The clipped-total caveat, rendered wherever a total is shown so neither branch flattens it. */
    const lowerBoundCaveat = `*At least ${result.total} products match — Open Food Facts stops counting there and does not report the true total. Add filters for an exact count.*`;

    if (result.products.length === 0 && result.omitted !== undefined) {
      const leftOff = [
        `**Page ${result.page}${result.last_page === undefined ? '' : ` of ${result.last_page}`} lists no products** (${totalLabel}, ${result.page_size} per page)`,
        `*${omittedSentence(result.omitted)}*`,
      ];
      if (result.total_is_lower_bound) leftOff.push(lowerBoundCaveat);
      // The handler's reachable bound, rebuilt from the output: last_page when the count is exact,
      // and otherwise the text backend's result window — only that backend stops counting.
      const reachable =
        result.last_page ??
        Math.min(
          Math.ceil(result.total / result.page_size),
          Math.floor(TEXT_SEARCH_RESULT_WINDOW / result.page_size),
        );
      leftOff.push('', emptyPageNextStep(result.page, reachable), '', source);
      return [{ type: 'text' as const, text: leftOff.join('\n') }];
    }

    if (result.products.length === 0) {
      // A positive total with an empty page is an exhausted page. Preserve the total, say which
      // page holds results, and say nothing about broadening filters that are matching products.
      const exhausted = [
        `**Page ${result.page} is past the end of this result set** (${totalLabel}, ${result.page_size} per page)`,
      ];
      if (result.total_is_lower_bound) exhausted.push(lowerBoundCaveat);
      exhausted.push(
        '',
        result.last_page === undefined
          ? 'Open Food Facts stopped counting before the end of the matches, so there is no exact last page — request an earlier page.'
          : result.last_page * result.page_size < result.total
            ? `Request page ${result.last_page} or lower — at page_size ${result.page_size} that reaches the first ${result.last_page * result.page_size} of the ${result.total} matches.`
            : `Request page ${result.last_page} or lower to reach the matching ${result.total === 1 ? 'product' : 'products'}.`,
        '',
        source,
      );
      return [{ type: 'text' as const, text: exhausted.join('\n') }];
    }

    const lines: string[] = [
      `**${totalLabel}** (page ${result.page}${result.last_page === undefined ? '' : ` of ${result.last_page}`}, ${result.page_size} per page, showing ${result.page_count})`,
    ];
    if (result.total_is_lower_bound) {
      lines.push(lowerBoundCaveat);
    }
    if (result.omitted !== undefined) lines.push(`*${omittedSentence(result.omitted)}*`);
    lines.push('');

    for (const p of result.products) {
      // Every value on a result row comes from the upstream record, the barcode included — it is
      // the record's own `code`, not the caller's input — so all of them are escaped.
      lines.push(
        `### ${p.product_name === undefined ? 'Unknown product' : mdInline(p.product_name)}`,
      );
      lines.push(`**Barcode:** ${mdInline(p.barcode)}`);
      if (p.brands) lines.push(`**Brand:** ${mdInline(p.brands)}`);
      if (p.quantity) lines.push(`**Quantity:** ${mdInline(p.quantity)}`);

      const scores: string[] = [];
      if (p.nutriscore_grade) scores.push(`Nutri-Score: ${mdInline(p.nutriscore_grade)}`);
      if (p.nova_group !== undefined) scores.push(`NOVA: ${p.nova_group}`);
      if (p.ecoscore_grade) scores.push(`Green-Score: ${mdInline(p.ecoscore_grade)}`);
      if (scores.length > 0) lines.push(`**Scores:** ${scores.join(' | ')}`);

      if (p.categories_tags && p.categories_tags.length > 0) {
        // Rendered in full — structuredContent already carries every tag, so slicing here only
        // left text-only clients with a short list they had no way to complete.
        lines.push(`**Categories:** ${p.categories_tags.map(mdInline).join(', ')}`);
      }
      if (p.indexed_nutriments) {
        const values = Object.entries(p.indexed_nutriments).map(
          ([key, value]) => `${key} ${value} ${indexedUnit(key)}`,
        );
        lines.push(
          `**Indexed per 100 g, or per 100 ml for liquids:** ${values.length > 0 ? values.join(', ') : 'none returned for the constrained nutrients'}`,
        );
      }
      if (p.completeness !== undefined) {
        lines.push(`**Data completeness:** ${completenessLabel(p.completeness)}`);
      }
      const dates = recordDatesLine(p);
      if (dates) lines.push(dates);
      lines.push('');
    }

    lines.push(source, '*Data: Open Food Facts (ODbL 1.0)*');

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
