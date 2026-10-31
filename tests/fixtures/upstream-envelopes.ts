/**
 * @fileoverview Genuine 2xx (and 404) response envelopes from the four Open Food Facts reads, taken
 * from live captures on 2026-10-13. Hit lists and nested product objects are trimmed and the
 * search-a-licious `debug` echo is dropped; every remaining key and value is as the upstream sent
 * it. Tests that tighten envelope validation run these to prove a real answer is still accepted.
 * The two `*_TIMED_OUT` envelopes are the exception: no live answer has carried the flag, so they
 * are built from the fields search-a-licious v1.4.0's `postprocessing.py` emits.
 * @module tests/fixtures/upstream-envelopes
 */

/** GET /api/v2/product/3017620422003.json — a found product, trimmed to a few fields. */
export const PRODUCT_FOUND = {
  code: '3017620422003',
  product: {
    brands: 'Nutella, Ferrero',
    completeness: 0.8875,
    ecoscore_grade: 'unknown',
    nova_group: 4,
    nutriments: {
      'energy-kcal_100g': 539,
      fat_100g: 30.9,
      proteins_100g: 6.3,
      salt_100g: 0.107,
      sugars_100g: 56.3,
    },
    nutriscore_grade: 'e',
    product_name: 'Nutella',
  },
  status: 1,
  status_verbose: 'product found',
};

/** The same product asked for a field it does not carry: found, with nothing entered. */
export const PRODUCT_FOUND_EMPTY = {
  code: '3017620422003',
  product: {},
  status: 1,
  status_verbose: 'product found',
};

/** A barcode no contributor has entered — served with HTTP 404. */
export const PRODUCT_NOT_FOUND_404 = {
  code: '2961836540127',
  status: 0,
  status_verbose: 'product not found',
};

/** GET /api/v2/search?categories_tags=en:hummus&page_size=2 — two of 4,581 matches. */
export const TAG_SEARCH_HITS = {
  count: 4581,
  page: 1,
  page_count: 2,
  page_size: 2,
  products: [
    {
      brands: 'LABEYRIE FINE FOODS FRANCE',
      categories_tags: ['en:plant-based-foods-and-beverages', 'en:spreads', 'en:hummus'],
      code: '3292070005161',
      ecoscore_grade: 'b',
      nova_group: 3,
      nutriscore_grade: 'c',
      product_name: 'Houmous extra - Pois chiches français & graines de sésame',
    },
    {
      brands: 'Blini',
      categories_tags: ['en:plant-based-foods-and-beverages', 'en:spreads', 'en:hummus'],
      code: '3292070001576',
      ecoscore_grade: 'a',
      nova_group: 3,
      nutriscore_grade: 'b',
      product_name: 'Houmous sésame',
    },
  ],
  skip: 0,
};

/** GET /api/v2/search for a category matching nothing. */
export const TAG_SEARCH_EMPTY = {
  count: 0,
  page: 1,
  page_count: 0,
  page_size: 2,
  products: [],
  skip: 0,
};

/** POST https://search.openfoodfacts.org/search for `nutella`, page_size 2. */
export const TEXT_SEARCH_HITS = {
  hits: [
    {
      code: '0009800800049',
      brands: ['Nutella'],
      product_name: 'Nutella & go! hazelnut spread + breadsticks',
    },
    { code: '0098008952506', brands: ['Nutella'], product_name: 'Nutella' },
  ],
  aggregations: null,
  facets: {},
  charts: {},
  page: 1,
  page_size: 2,
  page_count: 316,
  took: 5,
  timed_out: false,
  count: 631,
  is_count_exact: true,
  warnings: null,
};

/** POST https://search.openfoodfacts.org/search for a word no product carries. */
export const TEXT_SEARCH_EMPTY = {
  hits: [],
  aggregations: null,
  facets: {},
  charts: {},
  page: 1,
  page_size: 2,
  page_count: 0,
  took: 2,
  timed_out: false,
  count: 0,
  is_count_exact: true,
  warnings: null,
};

/** A text search Elasticsearch stopped collecting early. The whole success shape, count exact. */
export const TEXT_SEARCH_TIMED_OUT = {
  hits: [],
  count: 0,
  is_count_exact: true,
  page: 1,
  page_size: 20,
  page_count: 0,
  took: 15000,
  timed_out: true,
};

/** GET https://search.openfoodfacts.org/autocomplete?q=hummus&taxonomy_names=category */
export const AUTOCOMPLETE_HITS = {
  took: 2,
  timed_out: false,
  options: [{ id: 'en:hummus', text: 'Hummus', taxonomy_name: 'category' }],
};

/** GET https://search.openfoodfacts.org/autocomplete for a term nothing matches. */
export const AUTOCOMPLETE_EMPTY = { took: 1, timed_out: false, options: [] };

/** An autocomplete Elasticsearch stopped collecting early. */
export const AUTOCOMPLETE_TIMED_OUT = { took: 15000, timed_out: true, options: [] };
