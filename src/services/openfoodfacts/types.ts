/**
 * @fileoverview Raw API response types for the Open Food Facts API v2.
 * All fields are optional — OFF is crowd-sourced and real payloads are sparse.
 * @module services/openfoodfacts/types
 */

/** Raw nutriments map from the OFF API — flat key-value with hyphenated keys and suffix variants. */
export type RawNutriments = Record<string, number | string | undefined>;

/** Parsed ingredient entry from the OFF API. */
export type RawIngredient = {
  id?: string;
  text?: string;
  percent_estimate?: number;
  vegan?: string;
  vegetarian?: string;
};

/** Raw product object from the OFF API. Only documents the fields we actually use. */
export type RawProduct = {
  product_name?: string;
  brands?: string;
  quantity?: string;
  ingredients_text?: string;
  ingredients?: RawIngredient[];
  allergens_tags?: string[];
  additives_tags?: string[];
  nutriscore_grade?: string;
  nova_group?: number;
  ecoscore_grade?: string;
  nutriments?: RawNutriments;
  categories_tags?: string[];
  labels_tags?: string[];
  packaging_tags?: string[];
  origins_tags?: string[];
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

/** Response envelope from GET /api/v2/search */
export type RawSearchResponse = {
  count?: number;
  page?: number;
  page_count?: number;
  page_size?: number;
  skip?: number;
  products?: RawProduct[];
};

/**
 * Response envelope from GET https://search.openfoodfacts.org/search
 * Used for text-based queries — the /api/v2/search endpoint silently ignores the `search_terms`
 * parameter and returns all products unfiltered.
 * Note: `page_count` here is TOTAL PAGES, not products on the page (differs from /api/v2/search).
 */
export type RawTextSearchResponse = {
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
 * Search parameters shared by both search backends. A `query` (with or without tag filters) routes
 * to search.openfoodfacts.org, where any tag filters are folded into the Lucene `q`; tag filters
 * with no query route to /api/v2/search. `sort_by` applies only on the /api/v2/search path.
 */
export type SearchParams = {
  query?: string;
  categories_tag?: string;
  brands_tag?: string;
  labels_tag?: string;
  allergens_tag?: string;
  /**
   * Applied only on the tag-filter path (/api/v2/search). search-a-licious does not index
   * `additives_tags`, so the tool rejects this filter alongside a text query rather than sending a
   * clause that would silently match nothing.
   */
  additives_tag?: string;
  nutrition_grade?: string;
  nova_group?: string;
  countries_tag?: string;
  /** Sort order — applied only on the tag-filter path (/api/v2/search). Ignored on text search. */
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
  page_count: number;
  page_size: number;
  products: RawProduct[];
};
