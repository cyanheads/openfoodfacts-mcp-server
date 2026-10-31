/**
 * @fileoverview Tool definition for searching Open Food Facts products by text, tag filters, and
 * numeric nutrient thresholds.
 * @module mcp-server/tools/definitions/search-products
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  countQueryWords,
  getOpenFoodFactsService,
  MAX_QUERY_WORDS,
  TAG_SEARCH_MAX_PAGE,
  TEXT_SEARCH_LANGS,
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
  WHOLE_NUMBER_NUTRIENTS,
} from '@/services/openfoodfacts/types.js';
import {
  type CanonicalTag,
  getTaxonomyService,
  type TagFacet,
} from '@/services/taxonomy/taxonomy-service.js';
import { mdInline } from '@/utils/markdown.js';

/**
 * Most results one search call returns. A larger `page_size` is served at this size and disclosed,
 * and `page` then counts pages of this size.
 */
const SEARCH_PAGE_SIZE_CAP = 50;

/** Comparison symbol per operator, for echoing a constraint back to the caller in the notice. */
const NUTRIENT_OPERATOR_SYMBOLS: Record<NutrientOperator, string> = {
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/**
 * The string tag filters, the facet whose vocabulary each draws on, and the label the empty-result
 * notice echoes it under. On the text path each value is canonicalized before it is sent;
 * `additives_tag` is absent because the text path refuses it. Trace tags are allergen tags, so
 * `traces_tag` resolves against the allergen vocabulary.
 */
const TAG_FILTERS = [
  { key: 'categories_tag', facet: 'categories', label: 'category' },
  { key: 'brands_tag', facet: 'brands', label: 'brand' },
  { key: 'labels_tag', facet: 'labels', label: 'label' },
  { key: 'allergens_tag', facet: 'allergens', label: 'allergen' },
  { key: 'traces_tag', facet: 'allergens', label: 'trace' },
  { key: 'countries_tag', facet: 'countries', label: 'country' },
] as const satisfies readonly { key: keyof SearchParams; facet: TagFacet; label: string }[];

/** A tag filter value as supplied and as sent; `canonical` is set only on the text path. */
type AppliedTagFilter = {
  key: (typeof TAG_FILTERS)[number]['key'];
  label: string;
  given: string;
  sent: string;
  canonical?: CanonicalTag;
};

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
 * The disclosure for rows that failed a nutrient constraint, shared by the notice and the text
 * surface. They are not matches, so they never read as `omittedSentence` rows do.
 */
function outsideConstraintsSentence(count: number): string {
  return count === 1
    ? '1 row on this page was left off: its indexed value falls outside nutrient_filters. The text index compares some nutrients as whole numbers, so it returns such rows, and total still counts them.'
    : `${count} rows on this page were left off: their indexed values fall outside nutrient_filters. The text index compares some nutrients as whole numbers, so it returns such rows, and total still counts them.`;
}

/**
 * What to do after a page every row left, shared by the notice and the text surface. `reachable` is
 * the deepest page the search can request, so a page named here is one the window serves.
 * `moreBeyond` is whether rows lie past this page. Narrowing advice goes only with rows outside the
 * constraints: an unservable code is no reason to change the search, and on the last page of the
 * answer there is nothing further for narrowing to bring forward.
 */
function emptyPageNextStep(
  page: number,
  reachable: number,
  moreBeyond: boolean,
  outsideConstraints: boolean,
): string {
  if (page < reachable) {
    return outsideConstraints
      ? `Request page ${page + 1} for the next rows, or add query or tag filters to narrow what the index returns.`
      : `Request page ${page + 1} for further matches.`;
  }
  return outsideConstraints && moreBeyond
    ? `No further page of matches can be requested: text search serves only the first ${TEXT_SEARCH_RESULT_WINDOW} results, so add query or tag filters to bring other rows into them.`
    : 'No further page of matches can be requested.';
}

/** Why an unconfirmed tag value was sent as it was, in the empty-result notice's words. */
const UNCONFIRMED_TAG_REASONS = {
  no_vocabulary: 'brand slugs have no vocabulary to check them against',
  no_match: 'no matching Open Food Facts tag was found',
  lookup_failed:
    'the tag vocabulary could not be reached or gave no usable answer, so it went unchecked',
} as const;

/**
 * What still reaches the live database from a search the text index answered, which depends on
 * what the search carries. Nutrient constraints exist only on the text index, so no variant of a
 * search carrying them leaves it; otherwise dropping `query` does, keeping any filters the tag path
 * applies. Returned as the two phrasings the freshness note and the empty-result notice use.
 */
function liveDatabaseRoute(
  hasNutrientFilters: boolean,
  hasTagPathFilters: boolean,
): { note: string; advice: string } {
  if (hasNutrientFilters) {
    return {
      note: 'Nutrient constraints are served only by this index, so no form of this search reads the live database.',
      advice:
        'nutrient_filters are served only by this index, so no form of this search reads the live database',
    };
  }
  if (hasTagPathFilters) {
    return {
      note: 'The same tag filters without query read the live database.',
      advice: 're-run the same tag filters without query to read the live database',
    };
  }
  return {
    note: 'A search by tag filters alone, without query, reads the live database.',
    advice:
      'a search without query reads the live database, so try expressing the product as tag filters instead (off_browse_taxonomy resolves them)',
  };
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

/** The `indexed_nutriments` keys of the nutrients the text index compares as whole numbers. */
const WHOLE_NUMBER_KEYS: ReadonlySet<string> = new Set(
  [...WHOLE_NUMBER_NUTRIENTS].map(indexedNutrientKey),
);

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
 * Freshness disclosure attached to every response the text backend answered. No date is named:
 * the endpoint publishes no index timestamp, and deriving one would cost an extra search request
 * per call, so a literal date here would be a claim nothing re-checks. The observed cutoff and the
 * date it was observed live in docs/design.md instead.
 */
const TEXT_INDEX_SNAPSHOT_NOTE =
  'These results come from the text-search index, a snapshot that lags the live Open Food Facts database, so a recently contributed product can be missing from them.';

export const offSearchProductsTool = tool('off_search_products', {
  title: 'Search Food Products',
  description:
    'Search Open Food Facts by full-text query, structured tag filters, or both at once. Returns a summary list with barcodes, product names, brands, Nutri-Score, NOVA group, and categories — enough for triage and selection, not full label data. Use off_get_product on the returned barcodes for complete details. A text query and tag filters combine: every word of the query must match the product name, generic name, categories, labels, or brand, and every filter provided must hold (e.g. query "dark chocolate" with labels_tag "en:organic" and countries_tag "en:france" returns organic chocolate sold in France); numeric nutrient_filters express thresholds per 100 g, or per 100 ml for liquids, such as sugars below 8 g, and combine the same way, and each row then carries the indexed values the thresholds were checked against; additives_tag is the one exception, filtering only on searches carrying neither query nor nutrient_filters. Tag filter values are canonical tag IDs (e.g. "en:organic", "en:no-gluten") — use off_browse_taxonomy to resolve human terms to tag IDs. A case variant, synonym, or singular of a tag is resolved to its canonical ID where Open Food Facts recognizes it; anything else is matched exactly. exclude_allergens and exclude_traces drop products that declare an allergen or a "may contain" trace, but a product with no allergen or trace data entered passes them, so confirm a candidate with off_get_product before relying on it. At least one search parameter is required. The two paths read different indexes: a search carrying query is answered by the text index, a snapshot that lags the live database, while a tag-only search reads the live database and is current — so a recently contributed product can be missing from a text search and present in the same search without query. Data is crowd-sourced; result count reflects contributed products, not all products in the market. Data under ODbL 1.0 — cite Open Food Facts in downstream use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        `Words to find. Every word must match the product name, generic name, categories, labels, or brand — ingredients and quantity are not searched — so put only words the product itself would carry. Punctuation separates words — except an underscore, an apostrophe or period inside a word, and a decimal comma inside a number — so each part of "milk-chocolate" or "salt/pepper" must match, while "l'eau" and "1,5" stay one word. Stop words of English, French, Spanish, German, and Italian ("with", "the", "de", "mit", …) are not required, and neither is a content word that is a stop word in one of them (such as Spanish "soy"), though it still ranks the results. Names are matched in the ${TEXT_SEARCH_LANGS.length} languages the text index analyzes, so a product named only in French is found by its French name. At most ${MAX_QUERY_WORDS} words, counted as runs of letters and digits, so each part of a hyphenated or apostrophe-joined word counts. Example: "dark chocolate 70%". Supplying it routes the search to the text index, a snapshot that lags the live Open Food Facts database; drop it to run the same tag filters against the current data.`,
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
        'Brand slug (lowercased, hyphenated). Example: "nutella", "kelloggs". A brand name is slugged the way Open Food Facts slugs it ("Ben & Jerry\'s" → "ben-jerry-s") and then matched exactly — a partial or misspelled slug matches nothing rather than falling back to a near match, so put open-ended brand wording in query instead.',
      ),
    labels_tag: z
      .union([
        z.string().describe('One canonical label tag ID.'),
        z
          .array(z.string().describe('One canonical label tag ID.'))
          .max(10)
          .describe('Up to 10 canonical label tag IDs, all of which must apply.'),
      ])
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
    additives_tag: z
      .string()
      .optional()
      .describe(
        'Canonical additive (E-number) tag ID. Example: "en:e322", "en:e330". Use off_browse_taxonomy with facet="additives". Available only on searches carrying neither query nor nutrient_filters — both route to a backend with no additives field, so combining them is rejected instead of silently returning nothing.',
      ),
    nutrition_grade: z
      .enum(['a', 'b', 'c', 'd', 'e'])
      .optional()
      .describe(
        'Filter by Nutri-Score grade. "a" is highest nutritional quality, "e" is lowest. Products without a score are excluded.',
      ),
    nova_group: z
      .enum(['1', '2', '3', '4'])
      .optional()
      .describe(
        'Filter by NOVA food processing class. "1"=unprocessed/minimally processed, "4"=ultra-processed. Products without a NOVA score are excluded.',
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
        `Numeric constraints on nutrient values per 100 g, or per 100 ml for liquids, combined as AND with each other and with every other filter. Pair two entries on the same nutrient to express a range (e.g. sugars gte 2 and sugars lte 8). Served only by the text backend, so supplying one routes the search there even without query — it then reads the lagging text index and is subject to the 10,000-result page window, and additives_tag cannot be combined with it. The text index compares ${[...WHOLE_NUMBER_NUTRIENTS].join(', ')} as whole numbers, so every returned row is checked against these constraints: a row outside them leaves the page and counts in outside_constraints, and a nutrient the index holds no value for does not count against a row. A page can come back short or empty while later pages hold matches, and a range inside one whole number (sugars gt 3.9 and lt 4) can pass few rows of the 10,000 reachable, so add query or tag filters to narrow it. Per-serving and prepared-product values are not searchable.`,
      ),
    sort_by: z
      .enum(['last_modified_t', 'unique_scans_n', 'created_t', 'popularity_key'])
      .optional()
      .describe(
        'Sort order, applied on every search. Each value orders newest or highest first: "unique_scans_n" surfaces the most-scanned products, "last_modified_t" and "created_t" the most recently updated and newest records, "popularity_key" the most popular. Omitting it leaves text searches relevance-ranked and tag-only searches in the default order.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        `Page number (1-based). Use with page_size to paginate results. Pages are counted at the page_size served, which is at most ${SEARCH_PAGE_SIZE_CAP}, so repeating one larger page_size pages contiguously (page 2 at page_size 80 is results 51–100). A search by tag filters alone is served through page ${TAG_SEARCH_MAX_PAGE} only, so at page_size ${SEARCH_PAGE_SIZE_CAP} it reaches the first ${TAG_SEARCH_MAX_PAGE * SEARCH_PAGE_SIZE_CAP} matches. A search carrying query or nutrient_filters serves only the first ${TEXT_SEARCH_RESULT_WINDOW} results, so page * page_size (as served) must stay at or below ${TEXT_SEARCH_RESULT_WINDOW}. A request past either bound is rejected rather than sent; narrow the filters or change sort_by to bring other products forward.`,
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
        'Matching products in the database for this search. Exact unless total_is_lower_bound is true, in which case at least this many match and the real figure is unknown. On a search constraining a nutrient the text index compares as a whole number (see nutrient_filters) this is its whole-number answer, which can include rows those constraints rule out.',
      ),
    total_is_lower_bound: z
      .boolean()
      .describe(
        'True when the backend stopped counting at its ceiling and total is a floor, not the match total. Only text searches can hit it; add filters to bring the result set under the ceiling and get an exact count. On a search constraining a whole-number nutrient the floor is on the whole-number answer, not on the products that meet the constraints.',
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
        'Products returned on this page — page_size except on the last page, or when a match stored under a code Open Food Facts cannot serve or a row outside nutrient_filters was left off. Not the total number of pages.',
      ),
    last_page: z
      .number()
      .optional()
      .describe(
        `Deepest page of this result set that holds products and can be requested, at the page_size served — capped at page ${TAG_SEARCH_MAX_PAGE} on a search by tag filters alone and by the ${TEXT_SEARCH_RESULT_WINDOW}-result window on a search the text index answers. Absent when total_is_lower_bound is true — the total it would divide is the ceiling the backend stopped counting at, so no exact last page exists — and when nothing matched at all. On a search constraining a whole-number nutrient it counts pages of the whole-number answer, so a page up to it can list few products or none.`,
      ),
    omitted: z
      .number()
      .optional()
      .describe(
        'Matches on this page left off because Open Food Facts stores them under a code it cannot serve (not 4–40 digits once leading zeros are stripped), so off_get_product could not look them up either. Absent when none was. total still counts them.',
      ),
    outside_constraints: z
      .number()
      .optional()
      .describe(
        'Rows the text index returned on this page that fail nutrient_filters on their indexed values, compared at the 32-bit precision the index uses, and so left off. The index returns them because it compares some nutrients as whole numbers. Separate from omitted, whose rows are matches; a row both unservable and outside counts only in omitted. total, total_is_lower_bound, and last_page still count these rows, and each page keeps its place in the result set. Absent when none was.',
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
              .describe('Brand name(s), comma-separated. Absent when not yet entered.'),
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
            indexed_nutriments: z
              .object(INDEXED_NUTRIMENTS_SHAPE)
              .optional()
              .describe(
                'Present on every row of a search carrying nutrient_filters, and only there: the values the text index holds for the constrained nutrients, per 100 g, or per 100 ml for liquids — the values the filters were checked against. Keyed as off_get_product keys them (sugars_100g, energy_kcal_100g). A nutrient the index holds no value for is left out, never zero-filled, so the object can be empty, and it does not count against the row. off_get_product returns the current record, whose values can differ.',
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
        'Guidance about this result set — echoes the filters and suggests how to broaden when nothing matched, names the current page and how far the backend will actually paginate when more results exist, or, on a page that returned no rows because it lies past the last match or every row was left off, says which page to request instead. When rows outside nutrient_filters emptied the page and more rows can be reached or lie past the window, it also suggests adding query or tag filters.',
      ),
    text_index_snapshot: z
      .string()
      .optional()
      .describe(
        'Present only on searches the text backend answered. States that those results come from an index snapshot that lags the live Open Food Facts database, so a recently contributed product can be missing from them while the tag-only path still returns it. On a search carrying nutrient_filters it also echoes the constraints and says they were checked against the index values each row carries as indexed_nutriments, which can differ from what off_get_product returns. When a constraint falls on a whole-number nutrient (see nutrient_filters) it also says that total, total_is_lower_bound, and last_page describe the whole-number answer and that rows outside the constraints count in outside_constraints. Absent on tag-only searches, which read the live database.',
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
        'Provide at least one of: query, categories_tag, brands_tag, labels_tag, allergens_tag, traces_tag, exclude_allergens, exclude_traces, ingredients_analysis_tag, additives_tag, nutrient_filters, nutrition_grade, nova_group, or countries_tag.',
    },
    {
      reason: 'unrecognized_exclusion',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An exclude_allergens or exclude_traces value is not an allergen tag the Open Food Facts vocabulary confirms, or the vocabulary could not be reached or gave no usable answer when checking it — an unrecognized exclusion would exclude nothing',
      retryable: false,
      severity: 'warning',
      recovery:
        'Resolve each excluded value to its canonical allergen tag ID with off_browse_taxonomy (facet "allergens"), such as "en:nuts" or "en:milk", and search again.',
    },
    {
      reason: 'additives_filter_needs_tag_search',
      code: JsonRpcErrorCode.ValidationError,
      when: 'additives_tag was combined with a query or nutrient_filters, which route to a backend that cannot filter by additive',
      retryable: false,
      severity: 'warning',
      recovery:
        'Drop query and nutrient_filters to search by tags alone and keep the additive filter, or drop additives_tag to keep them. Every other filter combines freely.',
    },
    {
      reason: 'query_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: `query carries more than ${MAX_QUERY_WORDS} words, more than the text backend can require at once`,
      retryable: false,
      severity: 'warning',
      recovery: `Keep only the few distinctive words the product's name, brand, or category would carry (at most ${MAX_QUERY_WORDS}, and every one must match), and move brand, category, label, allergen, or country wording into the matching tag filter.`,
    },
    {
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: `A search by tag filters alone asks for a page past ${TAG_SEARCH_MAX_PAGE}, or a search the text backend serves asks for page * page_size beyond its ${TEXT_SEARCH_RESULT_WINDOW}-result window, counting page_size at the ${SEARCH_PAGE_SIZE_CAP} served when a larger one was requested`,
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
      recovery:
        'Do not retry. Read data.status and the upstream explanation in the message, then correct the filter values.',
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
    // Nutrient constraints are served only by the text backend, so they carry every property of
    // that path — the result window, the lagging index, the absent additives facet — with or
    // without a query.
    const servedByTextBackend = Boolean(query) || nutrientFilters.length > 0;
    // Every page computation below — what is sent, the page bounds, last_page, truncation — runs at
    // the size served, so a repeated over-cap page_size pages contiguously in pages of the cap.
    const pageSize = Math.min(input.page_size, SEARCH_PAGE_SIZE_CAP);
    // The deepest page this search's backend serves: the text backend's result window at this
    // page_size, or the tag path's page bound.
    const maxPage = servedByTextBackend
      ? Math.floor(TEXT_SEARCH_RESULT_WINDOW / pageSize)
      : TAG_SEARCH_MAX_PAGE;
    const hasExclusion = EXCLUSION_FILTERS.some(({ key }) => tagValues(input[key]).length > 0);
    const hasFilter =
      servedByTextBackend ||
      hasExclusion ||
      TAG_FILTERS.some(({ key }) => tagValues(input[key]).length > 0) ||
      Boolean(input.additives_tag?.trim()) ||
      Boolean(input.ingredients_analysis_tag) ||
      Boolean(input.nutrition_grade) ||
      Boolean(input.nova_group);

    if (!hasFilter) {
      throw ctx.fail('no_filters', 'At least one search parameter is required.');
    }

    // Only the tag-filter backend indexes additives. The text backend accepts an additives clause
    // and answers zero hits for every value, so honoring the combination would report "no such
    // product" about products that plainly exist. Refuse it instead of returning that lie.
    if (servedByTextBackend && input.additives_tag?.trim()) {
      throw ctx.fail(
        'additives_filter_needs_tag_search',
        'additives_tag filters only on searches the tag backend answers — a query or a nutrient constraint moves the search to a backend with no additives field, so pairing them would match nothing regardless of the additive.',
        { additives_tag: input.additives_tag },
      );
    }

    // Every word costs clauses in the backend's query, and past its clause ceiling the backend
    // answers with an error in place of results. Refuse before spending a request on it.
    const wordCount = query ? countQueryWords(query) : 0;
    if (wordCount > MAX_QUERY_WORDS) {
      throw ctx.fail(
        'query_too_long',
        `query has ${wordCount} words; the text backend can require at most ${MAX_QUERY_WORDS} at once.`,
        { word_count: wordCount, max_words: MAX_QUERY_WORDS },
      );
    }

    // Product Opener refuses every anonymous page past 10 with an HTTP 401, whatever the page_size
    // and however few products match. Reject it here with the bound instead of sending a request
    // that cannot succeed.
    if (!servedByTextBackend && input.page > TAG_SEARCH_MAX_PAGE) {
      throw ctx.fail(
        'page_out_of_range',
        `A search by tag filters alone is served through page ${TAG_SEARCH_MAX_PAGE} only, and page ${input.page} was requested.`,
        {
          page: input.page,
          page_size: pageSize,
          max_page: TAG_SEARCH_MAX_PAGE,
          recovery: {
            hint: `Request page ${TAG_SEARCH_MAX_PAGE} or lower — at page_size ${pageSize} that reaches the first ${TAG_SEARCH_MAX_PAGE * pageSize} matches — or narrow the filters or change sort_by to bring the products you need forward.`,
          },
        },
      );
    }

    // The text backend refuses page * page_size beyond its result window with an HTTP 422 that no
    // retry can clear. Reject it here so the caller gets the reachable page bound instead of a
    // backoff sequence.
    if (servedByTextBackend && input.page * pageSize > TEXT_SEARCH_RESULT_WINDOW) {
      const served =
        pageSize < input.page_size
          ? `page_size ${input.page_size} served at ${pageSize}`
          : `page_size ${pageSize}`;
      throw ctx.fail(
        'page_out_of_range',
        `The text backend serves only the first ${TEXT_SEARCH_RESULT_WINDOW} results, and page ${input.page} at ${served} asks for result ${input.page * pageSize}.`,
        {
          page: input.page,
          page_size: pageSize,
          max_page: maxPage,
          result_window: TEXT_SEARCH_RESULT_WINDOW,
          recovery: {
            hint: `Request page ${maxPage} or lower at page_size ${pageSize}, or add filters so the products you need rank inside the first ${TEXT_SEARCH_RESULT_WINDOW} results.`,
          },
        },
      );
    }

    // The text backend's tag fields are exact-match keywords, so a value the tag path would
    // canonicalize (case, synonym, singular, missing prefix) matches nothing there. Canonicalize
    // each value first; resolution is best-effort and fails the search only when the caller
    // cancels. The tag path is left alone — Product Opener canonicalizes its parameters itself.
    //
    // Exclusions are canonicalized on both paths and must be confirmed: a value neither backend
    // recognizes is a negation that matches nothing, so it would exclude nothing and return every
    // product as though the exclusion held.
    const taxonomy = getTaxonomyService();
    const [tagFilters, exclusions] = await Promise.all([
      Promise.all(
        TAG_FILTERS.flatMap(({ key, facet, label }) =>
          tagValues(input[key]).map(
            (given): Promise<AppliedTagFilter> =>
              servedByTextBackend
                ? taxonomy
                    .canonicalizeTag(facet, given, ctx)
                    .then((canonical) => ({ key, label, given, sent: canonical.value, canonical }))
                : Promise.resolve({ key, label, given, sent: given }),
          ),
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
    ]);

    const unrecognized = exclusions.flatMap(({ key, given, canonical }) =>
      canonical.resolution === 'normalized'
        ? [{ field: key, value: given, reason: canonical.reason }]
        : [],
    );
    if (unrecognized.length > 0) {
      // A refusal the vocabulary could not settle — unreachable, or no usable answer — can succeed
      // on a retry; one it answered cannot, so the retry flag holds only when every refusal is of
      // the first kind.
      const retryable = unrecognized.every(({ reason }) => reason === 'lookup_failed');
      const listed = unrecognized
        .map(({ field, value, reason }) =>
          reason === 'lookup_failed'
            ? `${field} "${value}" could not be checked, because the allergen vocabulary could not be reached or gave no usable answer`
            : `${field} "${value}" is not an allergen tag ID or name the Open Food Facts vocabulary confirms`,
        )
        .join('; ');
      throw ctx.fail(
        'unrecognized_exclusion',
        `Exclusions are sent only as allergen tags Open Food Facts confirms, because an unrecognized one excludes nothing: ${listed}.`,
        {
          unrecognized,
          retryable,
          ...(retryable && {
            recovery: {
              hint: 'Retry shortly — the allergen vocabulary could not be reached or gave no usable answer, so the value went unconfirmed. The canonical IDs of the 14 major allergens, such as "en:nuts" or "en:milk", are confirmed without it.',
            },
          }),
        },
      );
    }

    const svc = getOpenFoodFactsService();
    const searchParams: SearchParams = {
      page: input.page,
      page_size: pageSize,
    };
    if (query) searchParams.query = query;
    for (const { key } of TAG_FILTERS) {
      const sent = tagFilters.filter((filter) => filter.key === key).map((filter) => filter.sent);
      const [first] = sent;
      if (first === undefined) continue;
      // A labels array stays an array for the service, even of one; a string stays a string.
      if (key === 'labels_tag' && Array.isArray(input.labels_tag)) searchParams.labels_tag = sent;
      else searchParams[key] = first;
    }
    for (const { key } of EXCLUSION_FILTERS) {
      const sent = exclusions.filter((e) => e.key === key).map((e) => e.canonical.value);
      if (sent.length > 0) searchParams[key] = sent;
    }
    if (input.additives_tag?.trim()) searchParams.additives_tag = input.additives_tag.trim();
    if (input.ingredients_analysis_tag) {
      searchParams.ingredients_analysis_tag = input.ingredients_analysis_tag;
    }
    if (input.nutrition_grade) searchParams.nutrition_grade = input.nutrition_grade;
    if (input.nova_group) searchParams.nova_group = input.nova_group;
    if (nutrientFilters.length > 0) searchParams.nutrient_filters = nutrientFilters;
    if (input.sort_by) searchParams.sort_by = input.sort_by;

    const response = await svc.searchProducts(searchParams, ctx);

    const liveRoute = liveDatabaseRoute(
      nutrientFilters.length > 0,
      tagFilters.length > 0 ||
        exclusions.length > 0 ||
        Boolean(input.ingredients_analysis_tag) ||
        Boolean(input.nutrition_grade) ||
        Boolean(input.nova_group),
    );
    // Once each, since a range pair names its nutrient twice.
    const wholeNumber = [...new Set(nutrientFilters.map(({ nutrient }) => nutrient))].filter(
      (nutrient) => WHOLE_NUMBER_NUTRIENTS.has(nutrient),
    );
    if (servedByTextBackend) {
      const checkedAgainst =
        nutrientFilters.length > 0
          ? ` The nutrient constraints (${constraintEcho(nutrientFilters)}) were checked against these index values, shown on each row as indexed_nutriments; off_get_product returns the current record, whose values can differ.`
          : '';
      const wholeNumberAnswer =
        wholeNumber.length > 0
          ? ` The index compares ${wholeNumber.join(', ')} as whole numbers, so total, total_is_lower_bound, and last_page describe its whole-number answer, and rows of that answer outside these constraints are left off each page and counted in outside_constraints.`
          : '';
      ctx.enrich({
        text_index_snapshot: `${TEXT_INDEX_SNAPSHOT_NOTE} ${liveRoute.note}${checkedAgainst}${wholeNumberAnswer}`,
      });
    }
    const exclusionCoverage = exclusionCoverageNote(exclusions);
    if (exclusionCoverage) ctx.enrich({ exclusion_coverage: exclusionCoverage });

    ctx.log.info('Product search completed', {
      total: response.count,
      total_is_lower_bound: !response.count_is_exact,
      returned: response.products.length,
      outside_constraints: response.outside_constraints,
      page: response.page,
    });

    // Pages the backend will actually serve, not pages implied by the match total.
    const totalPages = Math.ceil(response.count / pageSize);
    const reachablePages = Math.min(totalPages, maxPage);
    // Only a counted total yields a real last page: dividing a count the backend stopped
    // incrementing would present its ceiling as a measurement.
    const lastPage = response.count_is_exact && response.count > 0 ? reachablePages : undefined;
    // Matches exist past this page when the backend stopped counting, or when the pages up to and
    // including this one, at the size served, end before the total. Keyed on the page's offset,
    // never on the rows it delivered: a row left off for an unservable code or a failed constraint
    // shortens the page without leaving anything beyond it.
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

    const outside = response.outside_constraints;
    if (response.products.length === 0 && (response.dropped > 0 || outside !== undefined)) {
      // Every row on this page was left off, for a code no product lookup can serve or for failing
      // a nutrient constraint. The page is not past the end, and the search is matching rows, so
      // neither notice applies. Truncation follows the same offset rule as a page that kept its
      // rows.
      const notice = [
        `Page ${response.page} lists no products:`,
        ...(response.dropped > 0 ? [omittedSentence(response.dropped)] : []),
        ...(outside === undefined ? [] : [outsideConstraintsSentence(outside)]),
        emptyPageNextStep(response.page, reachablePages, moreBeyond, outside !== undefined),
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
      const bound =
        lastPage === undefined
          ? `The backend stopped counting at ${response.count} matches, so there is no exact last page — request an earlier page.`
          : `Request page ${lastPage} or lower to reach them.`;

      // A whole-number answer counts rows the constraints can rule out, so it is no product count.
      const matches = wholeNumber.length > 0 ? 'whole-number matches' : 'matching products';
      ctx.enrich.notice(
        `Page ${response.page} is past the end of this result set — ${response.count} ${matches} exist, but no page this deep holds any. ${bound}`,
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
      pushEcho('nutriscore', input.nutrition_grade);
      pushEcho('nova', input.nova_group);
      pushEcho('country', input.countries_tag);
      for (const { key, label } of EXCLUSION_FILTERS) pushEcho(label, input[key]);
      for (const filter of nutrientFilters) {
        filterParts.push(
          `nutrient="${filter.nutrient}${NUTRIENT_OPERATOR_SYMBOLS[filter.operator]}${filter.value}"`,
        );
      }

      const echo = `No products found for ${filterParts.join(', ')}.`;
      if (!servedByTextBackend) {
        ctx.enrich.notice(
          `${echo} Try broader terms, check tag IDs via off_browse_taxonomy, or remove some filters.`,
        );
      } else {
        // A text-path zero has three possible causes, and the caller needs the ones that apply to
        // this search named: a word no product carries, a tag value matched exactly, and index
        // lag — a text search that matched nothing is not evidence the product is absent from
        // Open Food Facts.
        const causes: string[] = [];
        if (query) {
          causes.push(
            'Every word of query must match — in a product name, generic name, category, label, or brand — so one word no product carries empties the result; drop or change words the product may not carry.',
          );
          // A field:value form is matched as words, so its field name is required as a word too.
          const fieldName = /([\p{L}_]+):/u.exec(query)?.[1];
          if (fieldName) {
            causes.push(
              `query is matched as words, never as field:value syntax, so "${fieldName}" had to match as a word as well; put a field constraint in its filter input instead (brands_tag, categories_tag, nutrition_grade, …).`,
            );
          }
        }
        if (tagFilters.length > 0) {
          const unconfirmed = tagFilters.flatMap(({ label, given, sent, canonical }) =>
            canonical?.resolution === 'normalized'
              ? [
                  `${label}="${given}"${sent === given ? '' : ` was sent as "${sent}"`} (${UNCONFIRMED_TAG_REASONS[canonical.reason]})`,
                ]
              : [],
          );
          causes.push(
            `Tag values are matched exactly on this path${unconfirmed.length > 0 ? `: ${unconfirmed.join('; ')}` : ''}. Check tag IDs via off_browse_taxonomy.`,
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

    const products = response.products.map((p) => ({
      barcode: p.code,
      ...(p.product_name && { product_name: p.product_name }),
      ...(p.brands && { brands: p.brands }),
      ...(p.nutriscore_grade && { nutriscore_grade: p.nutriscore_grade }),
      ...(typeof p.nova_group === 'number' && { nova_group: p.nova_group }),
      ...(p.ecoscore_grade && { ecoscore_grade: p.ecoscore_grade }),
      ...(p.categories_tags && { categories_tags: p.categories_tags }),
      ...(p.indexed_nutriments && { indexed_nutriments: p.indexed_nutriments }),
    }));

    return {
      total: response.count,
      total_is_lower_bound: !response.count_is_exact,
      page: response.page,
      page_size: pageSize,
      page_count: response.page_count,
      ...(lastPage !== undefined && { last_page: lastPage }),
      ...(response.dropped > 0 && { omitted: response.dropped }),
      ...(outside !== undefined && { outside_constraints: outside }),
      products,
    };
  },

  format: (result) => {
    if (result.products.length === 0 && result.total === 0) {
      return [
        {
          type: 'text' as const,
          text: `**No products found** (total: ${result.total})\n\nTry broadening the search terms or checking tag IDs via off_browse_taxonomy.`,
        },
      ];
    }

    const outside = result.outside_constraints;
    // format() has no input. A page that lost rows, or whose rows carry a whole-number nutrient
    // (only a constrained nutrient reaches a row), shows the total is the index's whole-number
    // answer, not a product count. A page with neither keeps the plain wording, past-end pages too.
    const wholeNumberAnswer =
      outside !== undefined ||
      result.products.some((p) =>
        Object.keys(p.indexed_nutriments ?? {}).some((key) => WHOLE_NUMBER_KEYS.has(key)),
      );
    const totalLabel = `${result.total}${result.total_is_lower_bound ? '+' : ''} ${wholeNumberAnswer ? 'whole-number matches' : 'total products'}`;
    /** The clipped-total caveat, rendered wherever a total is shown so neither branch flattens it. */
    const lowerBoundCaveat = wholeNumberAnswer
      ? `*Open Food Facts stops counting its whole-number answer at ${result.total} and does not report how many products meet these constraints. Add query or tag filters for an exact count of that answer.*`
      : `*At least ${result.total} products match — Open Food Facts stops counting there and does not report the true total. Add filters for an exact count.*`;

    if (result.products.length === 0 && (result.omitted !== undefined || outside !== undefined)) {
      const leftOff = [
        `**Page ${result.page}${result.last_page === undefined ? '' : ` of ${result.last_page}`} lists no products** (${totalLabel}, ${result.page_size} per page)`,
      ];
      if (result.omitted !== undefined) leftOff.push(`*${omittedSentence(result.omitted)}*`);
      if (outside !== undefined) leftOff.push(`*${outsideConstraintsSentence(outside)}*`);
      if (result.total_is_lower_bound) leftOff.push(lowerBoundCaveat);
      // The handler's reachable bound, rebuilt from the output: last_page when the count is exact,
      // and otherwise the text backend's result window — only that backend stops counting.
      const reachable =
        result.last_page ??
        Math.min(
          Math.ceil(result.total / result.page_size),
          Math.floor(TEXT_SEARCH_RESULT_WINDOW / result.page_size),
        );
      const moreBeyond =
        result.total_is_lower_bound || result.page * result.page_size < result.total;
      leftOff.push(
        '',
        emptyPageNextStep(result.page, reachable, moreBeyond, outside !== undefined),
      );
      return [{ type: 'text' as const, text: leftOff.join('\n') }];
    }

    if (result.products.length === 0) {
      // A positive total with an empty page is an exhausted page. Preserve the total, say which
      // page holds results, and say nothing about broadening filters that are matching products.
      const exhausted = [
        `**Page ${result.page} is past the end of this result set** (${totalLabel})`,
      ];
      if (result.total_is_lower_bound) exhausted.push(lowerBoundCaveat);
      exhausted.push(
        '',
        result.last_page === undefined
          ? 'Open Food Facts stopped counting before the end of the matches, so there is no exact last page — request an earlier page.'
          : `Request page ${result.last_page} or lower to reach the matching products.`,
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
    if (outside !== undefined) lines.push(`*${outsideConstraintsSentence(outside)}*`);
    lines.push('');

    for (const p of result.products) {
      // Every value on a result row comes from the upstream record, the barcode included — it is
      // the record's own `code`, not the caller's input — so all of them are escaped.
      lines.push(
        `### ${p.product_name === undefined ? 'Unknown product' : mdInline(p.product_name)}`,
      );
      lines.push(`**Barcode:** ${mdInline(p.barcode)}`);
      if (p.brands) lines.push(`**Brand:** ${mdInline(p.brands)}`);

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
      lines.push('');
    }

    lines.push('*Data: Open Food Facts (ODbL 1.0)*');

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
