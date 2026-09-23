/**
 * @fileoverview Raw API response types for the Open Food Facts API v2, plus the closed vocabularies
 * the search parameters draw on.
 * All response fields are optional — OFF is crowd-sourced and real payloads are sparse.
 * @module services/openfoodfacts/types
 */

/** Raw nutriments map from the OFF API — flat key-value with hyphenated keys and suffix variants. */
export type RawNutriments = Record<string, number | string | undefined>;

/**
 * Parsed ingredient entry from the OFF API. `ingredients` holds its sub-ingredients in the same
 * shape — upstream declares the field self-recursive and unbounded, and a non-empty array is the
 * only signal an entry has any (`has_sub_ingredients` never appears in the v2 product response).
 * A sub-ingredient's `percent_estimate` is its share of the whole product, not of its parent.
 */
export type RawIngredient = {
  id?: string;
  text?: string;
  percent_estimate?: number;
  vegan?: string;
  vegetarian?: string;
  ingredients?: RawIngredient[];
};

/** Raw product object from the OFF API. Only documents the fields we actually use. */
export type RawProduct = {
  product_name?: string;
  brands?: string;
  quantity?: string;
  ingredients_text?: string;
  ingredients?: RawIngredient[];
  allergens_tags?: string[];
  /**
   * Allergens the label declares the product may contain as traces. Distinct from
   * `allergens_tags`: `["en:none"]` is a positive statement that the label declares no traces,
   * while `[]` and an absent field both mean not yet entered.
   */
  traces_tags?: string[];
  additives_tags?: string[];
  /** Product-level vegan, vegetarian, and palm-oil verdicts Open Food Facts computes itself. */
  ingredients_analysis_tags?: string[];
  nutriscore_grade?: string;
  nova_group?: number;
  ecoscore_grade?: string;
  nutriments?: RawNutriments;
  /** Serving size as printed on the label (e.g. "28 g", "1 can (12 fl oz)"). */
  serving_size?: string;
  /**
   * Serving size parsed to a number. Typed as a union because OFF is inconsistent about it:
   * live-verified as the JSON number `39` on barcode 0016000275287 and the JSON string `"28"` on
   * 0028400157827. Narrowing this to `number` silently drops the value for every product on the
   * string side, so callers coerce rather than type-test.
   */
  serving_quantity?: number | string;
  /** Unit of `serving_quantity` — not always grams (live-verified `"ml"` on barcode 0049000042566). */
  serving_quantity_unit?: string;
  categories_tags?: string[];
  labels_tags?: string[];
  packaging_tags?: string[];
  origins_tags?: string[];
  /** Countries the product is sold in — the values `off_search_products` accepts as `countries_tag`. */
  countries_tags?: string[];
  image_url?: string;
  completeness?: number;
  data_quality_tags?: string[];
};

/** Response envelope from GET /api/v2/product/{barcode}.json */
export type RawProductResponse = {
  code?: string;
  status: number;
  status_verbose?: string;
  product?: RawProduct;
};

/**
 * A search result row as either backend sends it: the summary fields plus the barcode it is keyed
 * by. `code` is requested on both paths but, like every upstream field, not assumed present.
 */
export type RawSearchProduct = RawProduct & { code?: string };

/**
 * A search result row the service hands on: its barcode matches `BARCODE_PATTERN`. Rows without
 * one are dropped before the page is counted — a row with nothing a product lookup can serve is not
 * a usable result.
 */
export type SearchRow = RawProduct & { code: string };

/** Response envelope from GET /api/v2/search */
export type RawSearchResponse = {
  count?: number;
  page?: number;
  page_count?: number;
  page_size?: number;
  skip?: number;
  products?: RawSearchProduct[];
};

/**
 * Response envelope from POST https://search.openfoodfacts.org/search
 * Used for text-based queries — the /api/v2/search endpoint silently ignores the `search_terms`
 * parameter and returns all products unfiltered.
 * Note: `page_count` here is TOTAL PAGES, not products on the page (differs from /api/v2/search).
 */
export type RawTextSearchResponse = {
  /**
   * Present, with no `hits` or `count`, when the backend's Elasticsearch query failed. The endpoint
   * still answers HTTP 200 in that case, so this list is the only failure signal.
   */
  errors?: { title?: string; description?: string }[];
  count?: number;
  /**
   * False when `count` is the backend's hit-tracking ceiling rather than the real match total —
   * search-a-licious stops counting at 10,000 and says so here. Required by its response schema;
   * typed optional to match this file's convention that no upstream field is assumed present.
   */
  is_count_exact?: boolean;
  page?: number;
  page_size?: number;
  /** Total number of pages (not products on this page — differs from /api/v2/search). */
  page_count?: number;
  hits?: RawTextSearchHit[];
};

/** A product hit from the search.openfoodfacts.org endpoint. */
export type RawTextSearchHit = {
  code?: string;
  product_name?: string;
  /** brands is an array here, unlike the /api/v2 string field. */
  brands?: string | string[];
  nutriscore_grade?: string;
  nova_group?: number;
  ecoscore_grade?: string;
  categories_tags?: string[];
};

/**
 * One suggestion from GET https://search.openfoodfacts.org/autocomplete — the live taxonomy
 * resolver. `id` is the canonical tag ID (`en:hummus`) and `text` its display name; `taxonomy_name`
 * echoes which vocabulary the suggestion came from, which matters only when several are requested
 * at once. Typed optional per this file's convention that no upstream field is assumed present.
 */
export type RawTaxonomyOption = {
  id?: string;
  text?: string;
  taxonomy_name?: string;
};

/**
 * Response envelope from GET https://search.openfoodfacts.org/autocomplete. The endpoint is a
 * suggester, not an enumerator: it reports no match total, accepts no offset or cursor, and answers
 * HTTP 200 with an empty `options` list for an empty query or an unknown taxonomy name.
 */
export type RawAutocompleteResponse = {
  options?: RawTaxonomyOption[];
};

/**
 * Nutrients the text index carries as numeric per-100 g fields, under `nutriments.<name>_100g`.
 * Closed because the index answers a clause naming an unindexed field with HTTP 200 and zero hits
 * rather than an error: every name here was live-verified to return matches, and the per-serving
 * variants were verified not to, so only the per-100 g basis is offered.
 */
export const NUTRIENT_FIELDS = [
  'energy-kcal',
  'fat',
  'saturated-fat',
  'carbohydrates',
  'sugars',
  'fiber',
  'proteins',
  'salt',
  'sodium',
] as const;

/** Comparisons a nutrient constraint may express, each mapping to one Lucene range form. */
export const NUTRIENT_OPERATORS = ['lt', 'lte', 'gt', 'gte'] as const;

/**
 * The barcodes Open Food Facts serves: Product Opener's `is_valid_code`
 * (`lib/ProductOpener/Products.pm`) strips leading zeros and then requires 4–40 digits, so a code
 * as short as `1212` or as long as 22 digits resolves. Deliberately stricter than upstream in one
 * way: Product Opener drops every non-digit before looking a code up, so `3017620422003a` answers
 * with Nutella — digits only here, so a typo is refused instead of returning another product.
 */
export const BARCODE_PATTERN = /^0*[1-9]\d{3,39}$/;

/** The validation message for a barcode `BARCODE_PATTERN` rejects. */
export const BARCODE_PATTERN_MESSAGE =
  'Barcode must be digits only, 4–40 digits long after any leading zeros.';

/**
 * The 12 verdicts of the Open Food Facts `ingredients_analysis` taxonomy
 * (`taxonomies/ingredients_analysis.txt` in openfoodfacts-server): the vegan, vegetarian, and
 * palm-oil answers Open Food Facts computes from a product's parsed ingredients, each with its
 * `maybe`/`may contain` and `unknown` states. A closed vocabulary, so it is offered as an enum and
 * needs no canonicalization on either search path.
 */
export const INGREDIENTS_ANALYSIS_TAGS = [
  'en:palm-oil',
  'en:palm-oil-free',
  'en:may-contain-palm-oil',
  'en:palm-oil-content-unknown',
  'en:vegan',
  'en:maybe-vegan',
  'en:non-vegan',
  'en:vegan-status-unknown',
  'en:vegetarian',
  'en:maybe-vegetarian',
  'en:non-vegetarian',
  'en:vegetarian-status-unknown',
] as const;

export type IngredientsAnalysisTag = (typeof INGREDIENTS_ANALYSIS_TAGS)[number];

export type NutrientField = (typeof NUTRIENT_FIELDS)[number];
export type NutrientOperator = (typeof NUTRIENT_OPERATORS)[number];

/** One numeric constraint on a per-100 g nutrient value. */
export type NutrientFilter = {
  nutrient: NutrientField;
  operator: NutrientOperator;
  value: number;
};

/**
 * Search parameters shared by both search backends. A `query` or a nutrient constraint (with or
 * without tag filters) routes to search.openfoodfacts.org, where any tag filters are folded into
 * the Lucene `q`; tag filters alone route to /api/v2/search. `sort_by` applies on both paths, in
 * each one's spelling. The text path quotes tag values verbatim into exact-match clauses, so a
 * caller routing there passes canonical values (the search tool canonicalizes them first).
 */
export type SearchParams = {
  query?: string;
  categories_tag?: string;
  brands_tag?: string;
  /** One label, or several that must all apply. */
  labels_tag?: string | string[];
  allergens_tag?: string;
  /** An allergen the label warns the product may contain as a trace. */
  traces_tag?: string;
  ingredients_analysis_tag?: IngredientsAnalysisTag;
  /**
   * Allergen and trace tags a product must not carry. Sent only as confirmed canonical IDs: an
   * exclusion value neither backend recognizes excludes nothing, so the tool refuses one rather
   * than passing it here.
   */
  exclude_allergens?: string[];
  exclude_traces?: string[];
  /**
   * Applied only on the tag-filter path (/api/v2/search). search-a-licious does not index
   * `additives_tags`, so the tool rejects this filter alongside a text query rather than sending a
   * clause that would silently match nothing.
   */
  additives_tag?: string;
  nutrition_grade?: string;
  nova_group?: string;
  countries_tag?: string;
  /**
   * Numeric per-100 g nutrient constraints, ANDed with every other filter. Served only by the text
   * backend — /api/v2/search documents the equivalent comparison parameters but ignores them, so a
   * request carrying one routes to search.openfoodfacts.org whether or not it also carries `query`.
   */
  nutrient_filters?: NutrientFilter[];
  /**
   * Sort order, applied on both paths. /api/v2/search reads the bare value as descending;
   * search-a-licious needs an explicit `-` prefix for the same order, which the text path adds.
   */
  sort_by?: 'last_modified_t' | 'unique_scans_n' | 'created_t' | 'popularity_key';
  page?: number;
  page_size?: number;
};

/**
 * Normalized envelope both search paths return. `page_count` is products on this page on both
 * paths — the text backend's own `page_count` means total pages and is converted before it gets
 * here.
 */
export type SearchResult = {
  count: number;
  /**
   * False when `count` is a floor rather than the match total. Only the text backend clips; the
   * tag-filter path reports real totals well past the text ceiling, so it always reports true.
   */
  count_is_exact: boolean;
  page: number;
  /**
   * Rows on this page after rows without a servable barcode are dropped — always
   * `products.length`.
   */
  page_count: number;
  page_size: number;
  products: SearchRow[];
  /** Rows the upstream returned on this page that were dropped for lacking a servable barcode. */
  dropped: number;
};
