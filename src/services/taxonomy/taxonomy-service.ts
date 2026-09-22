/**
 * @fileoverview Taxonomy service for Open Food Facts tag vocabularies. Resolves a search term
 * against the live search-a-licious autocomplete endpoint and merges the result with an embedded
 * vocabulary, which also serves unfiltered browsing, the two fixed facets, and offline operation.
 * @module services/taxonomy/taxonomy-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { OpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import {
  getOpenFoodFactsService,
  MAX_AUTOCOMPLETE_SIZE,
} from '@/services/openfoodfacts/openfoodfacts-service.js';

export type TaxonomyEntry = {
  id: string;
  name: string;
};

/**
 * An embedded entry plus the human-friendly terms it must stay searchable under. Several canonical
 * tag IDs are not the word a caller reaches for — `en:crustaceans` for "shellfish",
 * `en:no-gluten` for "gluten free", `en:biscuits` for "cookies" — and the canonical ID is the one
 * thing that cannot be traded away, because it is what `off_search_products` filters on. Aliases
 * are matched like the ID and display name and never leave the service: they widen what resolves,
 * not what is handed to the caller.
 */
type EmbeddedEntry = TaxonomyEntry & { aliases?: readonly string[] };

export type Facet =
  | 'categories'
  | 'labels'
  | 'allergens'
  | 'additives'
  | 'countries'
  | 'nova_groups'
  | 'nutrition_grades';

/* -------------------------------------------------------------------------- */
/* Embedded vocabulary                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Offline sample of each facet, and the whole vocabulary for the two fixed facets. For the live
 * facets this is a small, hand-maintained slice of a much larger upstream taxonomy — it is merged
 * ahead of live suggestions rather than replaced by them, because the autocomplete endpoint matches
 * on display names and answers an E-number query with unrelated E-numbers, so `additives` searches
 * that resolve correctly here would regress on a live-only path.
 *
 * Every ID here is a top-level key in the published taxonomy dumps
 * (https://static.openfoodfacts.org/data/taxonomies/). A synonym or singular form is not an error
 * anywhere on the way out — it is a filter that matches nothing and reports the zero as exact — so
 * a term with no canonical key is left out rather than approximated, and the human word it was
 * carrying moves to `aliases` on the entry that does have one.
 */
const TAXONOMY: Record<Facet, EmbeddedEntry[]> = {
  categories: [
    { id: 'en:beverages', name: 'Beverages' },
    { id: 'en:breakfast-cereals', name: 'Breakfast cereals' },
    { id: 'en:breads', name: 'Breads' },
    { id: 'en:cakes', name: 'Cakes' },
    { id: 'en:candies', name: 'Candies' },
    { id: 'en:cereals-and-potatoes', name: 'Cereals and potatoes' },
    { id: 'en:cheeses', name: 'Cheeses' },
    { id: 'en:chocolates', name: 'Chocolates' },
    { id: 'en:cocoa-and-its-products', name: 'Cocoa and its products' },
    { id: 'en:coffees', name: 'Coffees' },
    { id: 'en:condiments', name: 'Condiments' },
    { id: 'en:biscuits', name: 'Biscuits', aliases: ['cookies'] },
    { id: 'en:dairy-desserts', name: 'Dairy desserts' },
    { id: 'en:dried-fruits', name: 'Dried fruits' },
    { id: 'en:energy-drinks', name: 'Energy drinks' },
    { id: 'en:fermented-milk-products', name: 'Fermented milk products' },
    { id: 'en:fishes', name: 'Fishes' },
    { id: 'en:fruit-juices', name: 'Fruit juices' },
    { id: 'en:fruits-and-vegetables-based-foods', name: 'Fruits and vegetables based foods' },
    { id: 'en:ice-creams', name: 'Ice creams' },
    { id: 'en:jams', name: 'Jams' },
    { id: 'en:legumes', name: 'Legumes' },
    { id: 'en:margarines', name: 'Margarines' },
    { id: 'en:meats', name: 'Meats' },
    { id: 'en:milks', name: 'Milks' },
    { id: 'en:mineral-waters', name: 'Mineral waters' },
    { id: 'en:nuts', name: 'Nuts' },
    { id: 'en:vegetable-oils', name: 'Vegetable oils' },
    { id: 'en:pastas', name: 'Pastas' },
    { id: 'en:pastries', name: 'Pastries' },
    {
      id: 'en:plant-based-milk-alternatives',
      name: 'Plant-based milk alternatives',
      aliases: ['plant-based milks'],
    },
    { id: 'en:meals', name: 'Meals', aliases: ['prepared meals'] },
    { id: 'en:rices', name: 'Rices' },
    { id: 'en:sauces', name: 'Sauces' },
    { id: 'en:snacks', name: 'Snacks' },
    { id: 'en:soft-drinks', name: 'Soft drinks' },
    { id: 'en:soups', name: 'Soups' },
    { id: 'en:spreads', name: 'Spreads' },
    { id: 'en:sugars', name: 'Sugars' },
    { id: 'en:sweetened-beverages', name: 'Sweetened beverages' },
    { id: 'en:vegetables', name: 'Vegetables' },
    { id: 'en:waters', name: 'Waters' },
    { id: 'en:wines', name: 'Wines' },
    { id: 'en:yogurts', name: 'Yogurts' },
    { id: 'en:baby-foods', name: 'Baby foods' },
    { id: 'en:cereals-and-their-products', name: 'Cereals and their products' },
    { id: 'en:dairies', name: 'Dairies', aliases: ['dairy products'] },
    { id: 'en:fats', name: 'Fats' },
    { id: 'en:flavored-waters', name: 'Flavored waters', aliases: ['flavoured waters'] },
    { id: 'en:flours', name: 'Flours' },
    { id: 'en:fresh-cheeses', name: 'Fresh cheeses' },
    { id: 'en:fruit-based-beverages', name: 'Fruit-based beverages', aliases: ['fruit beverages'] },
    { id: 'en:honeys', name: 'Honeys' },
    { id: 'en:ketchup', name: 'Ketchup' },
    { id: 'en:mueslis', name: 'Mueslis' },
    { id: 'en:mustards', name: 'Mustards' },
    { id: 'en:noodles', name: 'Noodles' },
    { id: 'en:olive-oils', name: 'Olive oils' },
    { id: 'en:plant-based-foods', name: 'Plant-based foods' },
    { id: 'en:potato-crisps', name: 'Potato crisps', aliases: ['potato chips'] },
    { id: 'en:protein-bars', name: 'Protein bars' },
    { id: 'en:salty-snacks', name: 'Salty snacks', aliases: ['salted snacks'] },
    { id: 'en:sandwiches', name: 'Sandwiches' },
    { id: 'en:seafood', name: 'Seafood' },
    { id: 'en:seeds', name: 'Seeds' },
    { id: 'en:soy-based-drinks', name: 'Soy-based drinks', aliases: ['soy beverages'] },
    { id: 'en:spices', name: 'Spices' },
    { id: 'en:sugar-substitutes', name: 'Sugar substitutes' },
    { id: 'en:sweet-snacks', name: 'Sweet snacks' },
    { id: 'en:teas', name: 'Teas' },
    { id: 'en:vinegars', name: 'Vinegars' },
    { id: 'en:whipped-creams', name: 'Whipped creams' },
    { id: 'en:wholemeal-breads', name: 'Wholemeal breads', aliases: ['whole wheat breads'] },
  ],

  labels: [
    { id: 'en:organic', name: 'Organic', aliases: ['bio'] },
    { id: 'en:fair-trade', name: 'Fair trade' },
    {
      id: 'en:no-gluten',
      name: 'No gluten',
      aliases: ['gluten free', 'gluten-free', 'no gluten-containing ingredients'],
    },
    { id: 'en:vegan', name: 'Vegan' },
    { id: 'en:vegetarian', name: 'Vegetarian' },
    { id: 'en:no-added-sugar', name: 'No added sugar' },
    { id: 'en:no-artificial-colors', name: 'No artificial colors' },
    { id: 'en:no-artificial-flavors', name: 'No artificial flavors' },
    { id: 'en:no-preservatives', name: 'No preservatives' },
    { id: 'en:no-gmos', name: 'No GMOs', aliases: ['non-GMO', 'non GMO'] },
    { id: 'en:kosher', name: 'Kosher' },
    { id: 'en:halal', name: 'Halal' },
    { id: 'en:no-lactose', name: 'No lactose', aliases: ['lactose free', 'lactose-free'] },
    { id: 'en:eu-organic', name: 'EU Organic' },
    { id: 'en:usda-organic', name: 'USDA Organic' },
    { id: 'en:rainforest-alliance', name: 'Rainforest Alliance' },
    { id: 'en:made-in-france', name: 'Made in France' },
    { id: 'en:whole-grain', name: 'Whole grain' },
    { id: 'en:low-fat', name: 'Low fat' },
    { id: 'en:low-sugar', name: 'Low sugar' },
    { id: 'en:low-sodium', name: 'Low sodium' },
    { id: 'en:high-proteins', name: 'High proteins' },
    { id: 'en:high-fibres', name: 'High fibres', aliases: ['high fiber', 'high-fiber'] },
    {
      id: 'en:no-palm-oil',
      name: 'No palm oil',
      aliases: ['palm oil free', 'palm-oil-free', 'without palm oil'],
    },
    { id: 'en:made-in-germany', name: 'Made in Germany' },
  ],

  /**
   * The 14 allergens Open Food Facts recognizes as tags. Per-nut and per-grain terms (almonds,
   * hazelnuts, wheat, rye, lactose, …) have no allergen key upstream — they are ingredients, not
   * allergen tags — so they are absent rather than mapped onto a broader tag they do not mean.
   */
  allergens: [
    { id: 'en:gluten', name: 'Gluten' },
    { id: 'en:milk', name: 'Milk' },
    { id: 'en:eggs', name: 'Eggs' },
    { id: 'en:fish', name: 'Fish' },
    { id: 'en:crustaceans', name: 'Crustaceans', aliases: ['shellfish'] },
    { id: 'en:peanuts', name: 'Peanuts' },
    { id: 'en:soybeans', name: 'Soybeans' },
    { id: 'en:celery', name: 'Celery' },
    { id: 'en:mustard', name: 'Mustard' },
    { id: 'en:sesame-seeds', name: 'Sesame seeds' },
    { id: 'en:sulphur-dioxide-and-sulphites', name: 'Sulphur dioxide and sulphites' },
    { id: 'en:lupin', name: 'Lupin' },
    { id: 'en:molluscs', name: 'Molluscs' },
    { id: 'en:nuts', name: 'Nuts', aliases: ['tree nuts', 'tree-nuts'] },
  ],

  additives: [
    { id: 'en:e100', name: 'E100 Curcumin' },
    { id: 'en:e102', name: 'E102 Tartrazine' },
    { id: 'en:e110', name: 'E110 Sunset yellow FCF' },
    { id: 'en:e120', name: 'E120 Cochineal' },
    { id: 'en:e122', name: 'E122 Azorubine' },
    { id: 'en:e124', name: 'E124 Ponceau 4R' },
    { id: 'en:e129', name: 'E129 Allura red AC' },
    { id: 'en:e131', name: 'E131 Patent blue V' },
    { id: 'en:e133', name: 'E133 Brilliant blue FCF' },
    { id: 'en:e160a', name: 'E160a Carotenes' },
    { id: 'en:e200', name: 'E200 Sorbic acid' },
    { id: 'en:e202', name: 'E202 Potassium sorbate' },
    { id: 'en:e210', name: 'E210 Benzoic acid' },
    { id: 'en:e211', name: 'E211 Sodium benzoate' },
    { id: 'en:e220', name: 'E220 Sulphur dioxide' },
    { id: 'en:e250', name: 'E250 Sodium nitrite' },
    { id: 'en:e251', name: 'E251 Sodium nitrate' },
    { id: 'en:e300', name: 'E300 Ascorbic acid (Vitamin C)' },
    { id: 'en:e301', name: 'E301 Sodium ascorbate' },
    { id: 'en:e306', name: 'E306 Tocopherols (Vitamin E)' },
    { id: 'en:e322', name: 'E322 Lecithins' },
    { id: 'en:e322i', name: 'E322i Soya lecithin' },
    { id: 'en:e330', name: 'E330 Citric acid' },
    { id: 'en:e331', name: 'E331 Sodium citrates' },
    { id: 'en:e407', name: 'E407 Carrageenan' },
    { id: 'en:e412', name: 'E412 Guar gum' },
    { id: 'en:e414', name: 'E414 Acacia gum' },
    { id: 'en:e415', name: 'E415 Xanthan gum' },
    { id: 'en:e420', name: 'E420 Sorbitol' },
    { id: 'en:e421', name: 'E421 Mannitol' },
    { id: 'en:e422', name: 'E422 Glycerol' },
    { id: 'en:e440', name: 'E440 Pectins' },
    { id: 'en:e450', name: 'E450 Diphosphates' },
    { id: 'en:e471', name: 'E471 Mono- and diglycerides of fatty acids' },
    { id: 'en:e500', name: 'E500 Sodium carbonates' },
    { id: 'en:e503', name: 'E503 Ammonium carbonates' },
    { id: 'en:e621', name: 'E621 Monosodium glutamate (MSG)' },
    { id: 'en:e627', name: 'E627 Disodium guanylate' },
    { id: 'en:e631', name: 'E631 Disodium inosinate' },
    { id: 'en:e951', name: 'E951 Aspartame' },
    { id: 'en:e952', name: 'E952 Cyclamic acid' },
    { id: 'en:e954', name: 'E954 Saccharin' },
    { id: 'en:e955', name: 'E955 Sucralose' },
    { id: 'en:e960', name: 'E960 Steviol glycosides' },
  ],

  countries: [
    { id: 'en:france', name: 'France' },
    { id: 'en:united-states', name: 'United States' },
    { id: 'en:germany', name: 'Germany' },
    { id: 'en:united-kingdom', name: 'United Kingdom' },
    { id: 'en:spain', name: 'Spain' },
    { id: 'en:italy', name: 'Italy' },
    { id: 'en:belgium', name: 'Belgium' },
    { id: 'en:netherlands', name: 'Netherlands' },
    { id: 'en:switzerland', name: 'Switzerland' },
    { id: 'en:canada', name: 'Canada' },
    { id: 'en:australia', name: 'Australia' },
    { id: 'en:brazil', name: 'Brazil' },
    { id: 'en:china', name: 'China' },
    { id: 'en:india', name: 'India' },
    { id: 'en:japan', name: 'Japan' },
    { id: 'en:mexico', name: 'Mexico' },
    { id: 'en:portugal', name: 'Portugal' },
    { id: 'en:poland', name: 'Poland' },
    { id: 'en:austria', name: 'Austria' },
    { id: 'en:sweden', name: 'Sweden' },
    { id: 'en:denmark', name: 'Denmark' },
    { id: 'en:norway', name: 'Norway' },
    { id: 'en:finland', name: 'Finland' },
    { id: 'en:argentina', name: 'Argentina' },
    { id: 'en:south-africa', name: 'South Africa' },
    { id: 'en:new-zealand', name: 'New Zealand' },
    { id: 'en:singapore', name: 'Singapore' },
    { id: 'en:south-korea', name: 'South Korea' },
    { id: 'en:russia', name: 'Russia' },
    { id: 'en:turkey', name: 'Turkey' },
  ],

  /**
   * Bare digits, matching the bare grade letters `nutrition_grades` emits and the value
   * `off_search_products` accepts for `nova_group`. The `en:`-prefixed form these once carried was
   * not a valid filter value anywhere: the tool's own Zod enum rejects it outright, and while the
   * tag backend normalizes `nova_groups_tags=en:1` to the same 136,019 matches as `=1`, the text
   * backend does not — `nova_group:en:1` is live-verified answering zero hits flagged
   * `is_count_exact: true`, a confident false "no such product" rather than an error.
   */
  nova_groups: [
    { id: '1', name: 'NOVA 1 — Unprocessed or minimally processed foods' },
    { id: '2', name: 'NOVA 2 — Processed culinary ingredients' },
    { id: '3', name: 'NOVA 3 — Processed foods' },
    { id: '4', name: 'NOVA 4 — Ultra-processed food and drink products' },
  ],

  nutrition_grades: [
    { id: 'a', name: 'Nutri-Score A — Highest nutritional quality' },
    { id: 'b', name: 'Nutri-Score B — Good nutritional quality' },
    { id: 'c', name: 'Nutri-Score C — Average nutritional quality' },
    { id: 'd', name: 'Nutri-Score D — Below average nutritional quality' },
    { id: 'e', name: 'Nutri-Score E — Lowest nutritional quality' },
  ],
};

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * search-a-licious taxonomy name per facet. `nova_groups` and `nutrition_grades` have no live
 * counterpart — the autocomplete endpoint serves no such taxonomy and answers HTTP 200 with an
 * empty option list when named one — and both vocabularies are closed and complete above, so the
 * embedded entries are the whole truth for them rather than a sample.
 */
const LIVE_TAXONOMY_NAME: Partial<Record<Facet, string>> = {
  categories: 'category',
  labels: 'label',
  allergens: 'allergen',
  additives: 'additive',
  countries: 'country',
};

/**
 * The facet's documented match rule: case-insensitive substring against tag ID, display name, or —
 * for embedded entries — one of the human synonyms the canonical ID does not spell out.
 */
function matchesTerm(entry: EmbeddedEntry, term: string): boolean {
  const needle = term.toLowerCase();
  return (
    entry.id.toLowerCase().includes(needle) ||
    entry.name.toLowerCase().includes(needle) ||
    (entry.aliases?.some((alias) => alias.toLowerCase().includes(needle)) ?? false)
  );
}

/** Public projection: aliases widen what resolves, never what the caller is handed. */
const toTag = ({ aliases: _aliases, ...tag }: EmbeddedEntry): TaxonomyEntry => tag;

/**
 * Stable-sorts the live suggestions whose ID is the term itself as a tag — `en:<slug>`,
 * `en:<slug>s`, or `en:<slug>es`, where the slug is the lowercased term with whitespace runs
 * hyphenated, the normalization tag IDs use — ahead of the rest, which keep upstream order. Only
 * an equal ID moves, so a compound that merely shares a word (`en:red-lentils` for "lentil") stays
 * where upstream put it. Nothing is added or dropped.
 */
function rankExactTagFirst(live: TaxonomyEntry[], term: string): TaxonomyEntry[] {
  const slug = term.toLowerCase().replace(/\s+/g, '-');
  const exact = new Set([`en:${slug}`, `en:${slug}s`, `en:${slug}es`]);
  return [
    ...live.filter((entry) => exact.has(entry.id)),
    ...live.filter((entry) => !exact.has(entry.id)),
  ];
}

export type TaxonomySearchResult = {
  facet: string;
  tags: TaxonomyEntry[];
  /**
   * Full facet size before any search filter. Present only for the closed vocabularies, whose
   * entries are enumerable here. The live facets have no knowable total — the autocomplete endpoint
   * reports no match count and cannot be enumerated — and reporting the offline sample size as the
   * facet total is what presented 79 entries as the size of the Open Food Facts category taxonomy.
   */
  total_in_facet?: number;
  /**
   * Count of entries matching the search term, before the `limit` cap. Drives the truncation
   * decision so a filtered result is never reported as truncated against the full facet size.
   */
  matched_in_facet: number;
  /**
   * Agent-facing caveat about how this answer was produced — that the vocabulary listed is the
   * offline sample, that the live vocabulary could not be reached, or that nothing matched. Absent
   * when the live resolution answered normally.
   */
  notice?: string;
};

export class TaxonomyService {
  constructor(private readonly off: OpenFoodFactsService) {}

  /**
   * Resolve tags for a facet. With a search term, the live Open Food Facts vocabulary is queried
   * and its suggestions merged behind the embedded matches; without one, the embedded sample is
   * listed, because the upstream endpoint suggests against a term and cannot enumerate a facet.
   */
  async search(
    facet: Facet,
    search: string | undefined,
    limit: number,
    ctx: Context,
  ): Promise<TaxonomySearchResult> {
    const embedded = TAXONOMY[facet];
    const term = search?.trim();
    const taxonomyName = LIVE_TAXONOMY_NAME[facet];

    if (!taxonomyName) {
      const matched = term ? embedded.filter((entry) => matchesTerm(entry, term)) : embedded;
      return {
        facet,
        tags: matched.slice(0, limit).map(toTag),
        total_in_facet: embedded.length,
        matched_in_facet: matched.length,
      };
    }

    if (!term) {
      return {
        facet,
        tags: embedded.slice(0, limit).map(toTag),
        matched_in_facet: embedded.length,
        notice:
          `This is this server's offline ${facet} sample (${embedded.length} entries), not the Open Food Facts ` +
          `${facet} taxonomy, which is far larger and cannot be listed in full — pass a search term to resolve ` +
          'one against the live vocabulary.',
      };
    }

    const offline = embedded.filter((entry) => matchesTerm(entry, term));

    /**
     * The live call is the enrichment, not the answer of record: a caller asking for `en:organic`
     * during an Open Food Facts outage is better served by the offline match plus a caveat than by
     * a failure, and a caller whose term matches nothing offline needs to be told the vocabulary
     * went unchecked rather than reading an empty list as "no such tag". Both are the failure this
     * degradation exists to prevent, so the throw is absorbed here and reported in `notice`.
     */
    let live: TaxonomyEntry[];
    try {
      /**
       * The whole pool the endpoint honors, not a request sized to the limit. Upstream lists a
       * term's compound tags ahead of the plain one (`lentil` answers eight `en:lentil-*`
       * suggestions with `en:lentils` last; `cheese` puts `en:cheeses` 37th of 69), so a
       * limit-sized request never receives the tag the term names and no reordering can reach it.
       * It costs a few kilobytes and no extra request, and anything past the limit still reads as
       * truncation — the endpoint has no offset, so over-asking is the only way to know more exist.
       */
      live = await this.off.suggestTaxonomy(taxonomyName, term, MAX_AUTOCOMPLETE_SIZE, ctx);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      ctx.log.warning('Live taxonomy resolution failed — falling back to the offline sample', {
        facet,
        term,
        error: cause,
      });
      return {
        facet,
        tags: offline.slice(0, limit).map(toTag),
        matched_in_facet: offline.length,
        notice:
          `The live Open Food Facts ${facet} vocabulary could not be reached ` +
          `(${cause}). These ${offline.length} result(s) come ` +
          `from this server's offline sample of ${embedded.length} entries, so a term the sample does not ` +
          'cover reads as no match here even when the tag exists upstream. Retry for an authoritative answer.',
      };
    }

    /**
     * Held to the same substring rule the facet documents. Upstream matches whole words against
     * display names and falls back to loosely-related suggestions when nothing matches — an
     * E-number query returns a page of unrelated E-numbers — so unfiltered pass-through would
     * answer `e330` with tags that do not contain it. Measured across ordinary terms (cheese,
     * kombucha, olive oil, organic, tofu, …) this drops nothing and removes only that noise.
     *
     * What survives is ranked exact-tag first, the live portion only: the embedded block keeps its
     * hand-maintained order ahead of it.
     */
    const seen = new Set(offline.map((entry) => entry.id));
    const liveMatches: TaxonomyEntry[] = [];
    for (const entry of live) {
      if (!seen.has(entry.id) && matchesTerm(entry, term)) {
        seen.add(entry.id);
        liveMatches.push(entry);
      }
    }
    const merged = [...offline.map(toTag), ...rankExactTagFirst(liveMatches, term)];

    return {
      facet,
      tags: merged.slice(0, limit),
      matched_in_facet: merged.length,
      ...(merged.length === 0 && {
        notice:
          `No ${facet} tag matched "${term}" in the Open Food Facts vocabulary. Matching is on whole words in ` +
          'the tag name, so try a single simpler word (e.g. "hummus" rather than "hummus dip"); note also that ' +
          'many category tags are plural upstream ("kombucha" resolves to en:kombuchas).',
      }),
    };
  }
}

/* --- Init/accessor pattern --- */

let _service: TaxonomyService | undefined;

export function initTaxonomyService(): void {
  _service = new TaxonomyService(getOpenFoodFactsService());
}

export function getTaxonomyService(): TaxonomyService {
  if (!_service) {
    throw new Error('TaxonomyService not initialized — call initTaxonomyService() in setup()');
  }
  return _service;
}
