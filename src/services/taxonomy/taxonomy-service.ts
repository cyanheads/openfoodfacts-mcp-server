/**
 * @fileoverview Taxonomy service for Open Food Facts tag vocabularies. Resolves a search term
 * against the live search-a-licious autocomplete endpoint and merges the result with an embedded
 * vocabulary, which also serves unfiltered browsing, the two fixed facets, and offline operation.
 * @module services/taxonomy/taxonomy-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { OpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import { getOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';

export type TaxonomyEntry = {
  id: string;
  name: string;
  products?: number;
};

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
 */
const TAXONOMY: Record<Facet, TaxonomyEntry[]> = {
  categories: [
    { id: 'en:beverages', name: 'Beverages' },
    { id: 'en:breakfast-cereals', name: 'Breakfast cereals' },
    { id: 'en:breads', name: 'Breads' },
    { id: 'en:cakes', name: 'Cakes' },
    { id: 'en:candies', name: 'Candies' },
    { id: 'en:cereals-and-potatoes', name: 'Cereals and potatoes' },
    { id: 'en:cheeses', name: 'Cheeses' },
    { id: 'en:chips-and-crisps', name: 'Chips and crisps' },
    { id: 'en:chocolate-bars', name: 'Chocolate bars' },
    { id: 'en:chocolates', name: 'Chocolates' },
    { id: 'en:cocoa-and-chocolate-products', name: 'Cocoa and chocolate products' },
    { id: 'en:coffee', name: 'Coffee' },
    { id: 'en:condiments', name: 'Condiments' },
    { id: 'en:cookies', name: 'Cookies' },
    { id: 'en:dairy-desserts', name: 'Dairy desserts' },
    { id: 'en:dried-fruits', name: 'Dried fruits' },
    { id: 'en:energy-drinks', name: 'Energy drinks' },
    { id: 'en:fermented-milk-products', name: 'Fermented milk products' },
    { id: 'en:fish', name: 'Fish' },
    { id: 'en:fruit-juices', name: 'Fruit juices' },
    { id: 'en:fruits-and-vegetables-based-foods', name: 'Fruits and vegetables based foods' },
    { id: 'en:ice-creams', name: 'Ice creams' },
    { id: 'en:jams', name: 'Jams' },
    { id: 'en:legumes', name: 'Legumes' },
    { id: 'en:margarines', name: 'Margarines' },
    { id: 'en:meats', name: 'Meats' },
    { id: 'en:milk', name: 'Milk' },
    { id: 'en:mineral-waters', name: 'Mineral waters' },
    { id: 'en:mixed-salads', name: 'Mixed salads' },
    { id: 'en:nuts', name: 'Nuts' },
    { id: 'en:oils', name: 'Oils' },
    { id: 'en:pasta', name: 'Pasta' },
    { id: 'en:pastries', name: 'Pastries' },
    { id: 'en:plant-based-milks', name: 'Plant-based milks' },
    { id: 'en:prepared-meals', name: 'Prepared meals' },
    { id: 'en:processed-meats', name: 'Processed meats' },
    { id: 'en:rice', name: 'Rice' },
    { id: 'en:sauces', name: 'Sauces' },
    { id: 'en:snacks', name: 'Snacks' },
    { id: 'en:soft-drinks', name: 'Soft drinks' },
    { id: 'en:soups', name: 'Soups' },
    { id: 'en:spreads', name: 'Spreads' },
    { id: 'en:sugars', name: 'Sugars' },
    { id: 'en:sweetened-beverages', name: 'Sweetened beverages' },
    { id: 'en:tea', name: 'Tea' },
    { id: 'en:vegetables', name: 'Vegetables' },
    { id: 'en:waters', name: 'Waters' },
    { id: 'en:wines', name: 'Wines' },
    { id: 'en:yogurts', name: 'Yogurts' },
    { id: 'en:baby-foods', name: 'Baby foods' },
    { id: 'en:cereals', name: 'Cereals' },
    { id: 'en:crackers', name: 'Crackers' },
    { id: 'en:dairy-products', name: 'Dairy products' },
    { id: 'en:fats', name: 'Fats' },
    { id: 'en:flavoured-waters', name: 'Flavoured waters' },
    { id: 'en:flour', name: 'Flour' },
    { id: 'en:fresh-cheeses', name: 'Fresh cheeses' },
    { id: 'en:fruit-beverages', name: 'Fruit beverages' },
    { id: 'en:honey', name: 'Honey' },
    { id: 'en:ketchup', name: 'Ketchup' },
    { id: 'en:muesli', name: 'Muesli' },
    { id: 'en:mustard', name: 'Mustard' },
    { id: 'en:noodles', name: 'Noodles' },
    { id: 'en:olive-oils', name: 'Olive oils' },
    { id: 'en:plant-based-foods', name: 'Plant-based foods' },
    { id: 'en:potato-chips', name: 'Potato chips' },
    { id: 'en:protein-bars', name: 'Protein bars' },
    { id: 'en:salted-snacks', name: 'Salted snacks' },
    { id: 'en:sandwiches', name: 'Sandwiches' },
    { id: 'en:seafood', name: 'Seafood' },
    { id: 'en:seeds', name: 'Seeds' },
    { id: 'en:soy-beverages', name: 'Soy beverages' },
    { id: 'en:spices', name: 'Spices' },
    { id: 'en:sugar-substitutes', name: 'Sugar substitutes' },
    { id: 'en:sweet-snacks', name: 'Sweet snacks' },
    { id: 'en:teas', name: 'Teas' },
    { id: 'en:vinegars', name: 'Vinegars' },
    { id: 'en:whipped-creams', name: 'Whipped creams' },
    { id: 'en:whole-wheat-breads', name: 'Whole wheat breads' },
  ],

  labels: [
    { id: 'en:organic', name: 'Organic' },
    { id: 'en:fair-trade', name: 'Fair trade' },
    { id: 'en:no-gluten', name: 'No gluten' },
    { id: 'en:gluten-free', name: 'Gluten free' },
    { id: 'en:vegan', name: 'Vegan' },
    { id: 'en:vegetarian', name: 'Vegetarian' },
    { id: 'en:no-added-sugar', name: 'No added sugar' },
    { id: 'en:no-artificial-colors', name: 'No artificial colors' },
    { id: 'en:no-artificial-flavors', name: 'No artificial flavors' },
    { id: 'en:no-preservatives', name: 'No preservatives' },
    { id: 'en:non-gmo', name: 'Non GMO' },
    { id: 'en:kosher', name: 'Kosher' },
    { id: 'en:halal', name: 'Halal' },
    { id: 'en:lactose-free', name: 'Lactose free' },
    { id: 'en:eu-organic', name: 'EU Organic' },
    { id: 'en:usda-organic', name: 'USDA Organic' },
    { id: 'en:rainforest-alliance', name: 'Rainforest Alliance' },
    { id: 'en:made-in-france', name: 'Made in France' },
    { id: 'en:bio', name: 'Bio' },
    { id: 'en:whole-grain', name: 'Whole grain' },
    { id: 'en:low-fat', name: 'Low fat' },
    { id: 'en:low-sugar', name: 'Low sugar' },
    { id: 'en:low-sodium', name: 'Low sodium' },
    { id: 'en:high-protein', name: 'High protein' },
    { id: 'en:high-fiber', name: 'High fiber' },
    { id: 'en:no-gluten-containing-ingredients', name: 'No gluten-containing ingredients' },
    { id: 'en:palm-oil-free', name: 'Palm oil free' },
    { id: 'en:without-palm-oil', name: 'Without palm oil' },
    { id: 'en:fr-bio', name: 'FR Bio' },
    { id: 'en:made-in-germany', name: 'Made in Germany' },
  ],

  allergens: [
    { id: 'en:gluten', name: 'Gluten' },
    { id: 'en:milk', name: 'Milk' },
    { id: 'en:eggs', name: 'Eggs' },
    { id: 'en:fish', name: 'Fish' },
    { id: 'en:shellfish', name: 'Shellfish (Crustaceans)' },
    { id: 'en:peanuts', name: 'Peanuts' },
    { id: 'en:soybeans', name: 'Soybeans' },
    { id: 'en:tree-nuts', name: 'Tree nuts' },
    { id: 'en:celery', name: 'Celery' },
    { id: 'en:mustard', name: 'Mustard' },
    { id: 'en:sesame-seeds', name: 'Sesame seeds' },
    { id: 'en:sulphur-dioxide-and-sulphites', name: 'Sulphur dioxide and sulphites' },
    { id: 'en:lupin', name: 'Lupin' },
    { id: 'en:molluscs', name: 'Molluscs' },
    { id: 'en:nuts', name: 'Nuts (general)' },
    { id: 'en:wheat', name: 'Wheat' },
    { id: 'en:rye', name: 'Rye' },
    { id: 'en:barley', name: 'Barley' },
    { id: 'en:oats', name: 'Oats' },
    { id: 'en:lactose', name: 'Lactose' },
    { id: 'en:almonds', name: 'Almonds' },
    { id: 'en:cashews', name: 'Cashews' },
    { id: 'en:walnuts', name: 'Walnuts' },
    { id: 'en:hazelnuts', name: 'Hazelnuts' },
    { id: 'en:pecans', name: 'Pecans' },
    { id: 'en:pistachios', name: 'Pistachios' },
    { id: 'en:brazil-nuts', name: 'Brazil nuts' },
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

/** The facet's documented match rule: case-insensitive substring against tag ID or display name. */
function matchesTerm(entry: TaxonomyEntry, term: string): boolean {
  const needle = term.toLowerCase();
  return entry.id.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle);
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
        tags: matched.slice(0, limit),
        total_in_facet: embedded.length,
        matched_in_facet: matched.length,
      };
    }

    if (!term) {
      return {
        facet,
        tags: embedded.slice(0, limit),
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
      // One past the limit, so a full page can be told apart from an exactly-full one and reported
      // as truncated. The endpoint offers no offset, so this is the only way to know more exist.
      live = await this.off.suggestTaxonomy(taxonomyName, term, limit + 1, ctx);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      ctx.log.warning('Live taxonomy resolution failed — falling back to the offline sample', {
        facet,
        term,
        error: cause,
      });
      return {
        facet,
        tags: offline.slice(0, limit),
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
     */
    const seen = new Set(offline.map((entry) => entry.id));
    const merged = [...offline];
    for (const entry of live) {
      if (!seen.has(entry.id) && matchesTerm(entry, term)) {
        seen.add(entry.id);
        merged.push(entry);
      }
    }

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
