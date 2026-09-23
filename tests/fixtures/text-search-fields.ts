/**
 * @fileoverview The full-text fields search.openfoodfacts.org searches, as its own compiled query
 * reports them.
 *
 * Reproduces, entry for entry and in the backend's order, the `multi_match.fields` of the
 * `debug.query` the text backend returned on 2026-09-23 for `q=milk` with `langs` offered 60 codes:
 * it kept exactly these 31 languages, the codes with an analyzer in the index, and listed their
 * subfields in the order `langs` gave them. The name fields are written as a map over the language
 * list, which yields the captured sequence exactly. A per-word group that names a field outside
 * this list can only narrow the result, and one that misses a field drops matches the relevance
 * part found, so the service's derived field list is pinned against this capture as a set.
 * @module tests/fixtures/text-search-fields
 */

/** The 31 language codes, in the order the backend lists their subfields. */
export const UPSTREAM_TEXT_LANGS = [
  'en',
  'fr',
  'it',
  'es',
  'de',
  'nl',
  'ar',
  'hy',
  'eu',
  'bn',
  'bg',
  'ca',
  'da',
  'et',
  'fi',
  'gl',
  'el',
  'hi',
  'hu',
  'id',
  'ga',
  'lv',
  'lt',
  'fa',
  'pt',
  'ro',
  'ru',
  'sv',
  'tr',
  'th',
  'no',
] as const;

/** `multi_match.fields` for those 31 languages: 31 + 31 name fields, 6 + 6 taxonomy fields, brands. */
export const UPSTREAM_MULTI_MATCH_FIELDS = [
  ...UPSTREAM_TEXT_LANGS.map((lang) => `product_name.${lang}`),
  ...UPSTREAM_TEXT_LANGS.map((lang) => `generic_name.${lang}`),
  'categories.en',
  'categories.fr',
  'categories.it',
  'categories.es',
  'categories.de',
  'categories.nl',
  'labels.en',
  'labels.fr',
  'labels.it',
  'labels.es',
  'labels.de',
  'labels.nl',
  'brands',
] as const;
