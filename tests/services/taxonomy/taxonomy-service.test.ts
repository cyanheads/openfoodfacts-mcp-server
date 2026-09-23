/**
 * @fileoverview Tests for the tag-value canonicalizer the text search path runs every tag filter
 * through (GH issue #39): brand slugging, offline-sample and live-autocomplete resolution under the
 * exact-match rule, best-effort fallback, and the in-process cache. Driven through the real
 * OpenFoodFactsService with a stubbed global fetch, so the rate limiter, retry classification, and
 * option parsing on the lookup path all run.
 * @module tests/services/taxonomy/taxonomy-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import { slugTagValue, TaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

/** Wrap a body + status in a minimal Response-like mock, as a real fetch would resolve. */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

/** Stub the autocomplete endpoint with a fixed option list. */
function stubOptions(options: { id: string; text: string }[]): void {
  global.fetch = vi.fn(async () => mockResponse({ took: 1, timed_out: false, options }));
}

/** The autocomplete URL the stubbed fetch received on a given call. */
function lookupUrl(call = 0): URL {
  return new URL(String(vi.mocked(global.fetch).mock.calls[call]?.[0]));
}

/** A taxonomy service over a real Open Food Facts client with the given taxonomy budget. */
function makeTaxonomy(rateLimitTaxonomy = 100): TaxonomyService {
  return new TaxonomyService(
    new OpenFoodFactsService({
      baseUrl: 'https://world.openfoodfacts.org',
      rateLimitProduct: 100,
      rateLimitSearch: 100,
      rateLimitTaxonomy,
    }),
  );
}

describe('TaxonomyService.canonicalizeTag', () => {
  const globalFetch = global.fetch;
  let taxonomy: TaxonomyService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    taxonomy = makeTaxonomy();
    ctx = createMockContext();
    stubOptions([]);
  });

  afterEach(() => {
    global.fetch = globalFetch;
    vi.restoreAllMocks();
  });

  describe('brands', () => {
    it.each([
      ['Nutella', 'nutella'],
      ['  Nutella  ', 'nutella'],
      ['nutella', 'nutella'],
      ["Ben & Jerry's", 'ben-jerry-s'],
      ['Côte d’Or', 'côte-d-or'],
      ['M.&M.', 'm-m'],
      ['nutell', 'nutell'],
    ])('slugs %j to %j the way Product Opener does, with no lookup', async (input, slug) => {
      await expect(taxonomy.canonicalizeTag('brands', input, ctx)).resolves.toEqual({
        value: slug,
        resolution: 'normalized',
        reason: 'no_vocabulary',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('offline sample', () => {
    it.each([
      ['labels', 'en:organic', 'en:organic'],
      ['labels', 'EN:Organic', 'en:organic'],
      ['labels', 'Organic', 'en:organic'],
      ['labels', ' fair trade ', 'en:fair-trade'],
      ['countries', 'United States', 'en:united-states'],
      ['allergens', 'en:peanuts', 'en:peanuts'],
      ['categories', 'en:breakfast-cereals', 'en:breakfast-cereals'],
    ] as const)('resolves %s %j to %s without a lookup', async (facet, input, id) => {
      await expect(taxonomy.canonicalizeTag(facet, input, ctx)).resolves.toEqual({
        value: id,
        resolution: 'vocabulary',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('does not resolve through a browse alias, which is wider than a synonym', async () => {
      // "shellfish" finds en:crustaceans when browsing, but it is not the tag's name.
      await expect(taxonomy.canonicalizeTag('allergens', 'shellfish', ctx)).resolves.toEqual({
        value: 'en:shellfish',
        resolution: 'normalized',
        reason: 'no_match',
      });
      expect(global.fetch).toHaveBeenCalledOnce();
    });
  });

  describe('live autocomplete', () => {
    it('accepts the option whose name equals the value — a synonym (live response for "US")', async () => {
      stubOptions([
        { id: 'en:united-states', text: 'US' },
        { id: 'en:soviet-union', text: 'USSR' },
      ]);

      await expect(taxonomy.canonicalizeTag('countries', 'US', ctx)).resolves.toEqual({
        value: 'en:united-states',
        resolution: 'vocabulary',
      });
      const url = lookupUrl();
      expect(url.pathname).toBe('/autocomplete');
      expect(url.searchParams.get('taxonomy_names')).toBe('country');
      expect(url.searchParams.get('q')).toBe('US');
    });

    it('strips the language prefix to look up a singular (live response for "peanut")', async () => {
      stubOptions([{ id: 'en:peanuts', text: 'peanut' }]);

      await expect(taxonomy.canonicalizeTag('allergens', 'en:peanut', ctx)).resolves.toEqual({
        value: 'en:peanuts',
        resolution: 'vocabulary',
      });
      expect(lookupUrl().searchParams.get('taxonomy_names')).toBe('allergen');
      expect(lookupUrl().searchParams.get('q')).toBe('peanut');
    });

    it('reads hyphens as spaces when comparing a value to an option name', async () => {
      stubOptions([
        { id: 'en:soy-sauce-mixes', text: 'Soy sauce mixes' },
        { id: 'en:soy-sauces', text: 'Soy sauce' },
      ]);

      await expect(taxonomy.canonicalizeTag('categories', 'en:soy-sauce', ctx)).resolves.toEqual({
        value: 'en:soy-sauces',
        resolution: 'vocabulary',
      });
      expect(lookupUrl().searchParams.get('q')).toBe('soy sauce');
    });

    it('accepts the option whose ID equals the value ahead of a name match', async () => {
      stubOptions([
        { id: 'en:hummus-dips', text: 'Hummus' },
        { id: 'en:hummus', text: 'Hummus spreads' },
      ]);

      await expect(taxonomy.canonicalizeTag('categories', 'en:hummus', ctx)).resolves.toEqual({
        value: 'en:hummus',
        resolution: 'vocabulary',
      });
    });

    it('rejects a prefix or partial match (live compounds for "chocolate" in categories)', async () => {
      // The live pool answers compounds and tags whose English name merely contains the word.
      stubOptions([
        { id: 'en:chocolate-advent-calendars', text: 'Chocolate Advent calendars' },
        { id: 'en:milk-chocolates', text: 'Milk chocolates' },
      ]);

      await expect(taxonomy.canonicalizeTag('categories', 'en:chocolate', ctx)).resolves.toEqual({
        value: 'en:chocolate',
        resolution: 'normalized',
        reason: 'no_match',
      });
    });

    it('resolves the singular to the plural tag the live pool holds, past the compounds', async () => {
      // Live 2026-09-23: the autocomplete lists en:chocolates among 114 options, behind compounds,
      // and Product Opener counts categories_tags=en:chocolate exactly as en:chocolates (32,689).
      stubOptions([
        { id: 'en:chocolate-advent-calendars', text: 'Chocolate Advent calendars' },
        { id: 'en:chocolates', text: 'chocolate products' },
      ]);

      await expect(taxonomy.canonicalizeTag('categories', 'en:chocolate', ctx)).resolves.toEqual({
        value: 'en:chocolates',
        resolution: 'vocabulary',
      });
    });

    it('accepts the option whose ID is the value plus "s" (live response for "nut")', async () => {
      stubOptions([{ id: 'en:nuts', text: 'Nuts' }]);

      await expect(taxonomy.canonicalizeTag('allergens', 'en:nut', ctx)).resolves.toEqual({
        value: 'en:nuts',
        resolution: 'vocabulary',
      });
      expect(lookupUrl().searchParams.get('q')).toBe('nut');
    });

    it('accepts the option whose ID is the value plus "es"', async () => {
      stubOptions([
        { id: 'en:tomato-sauces', text: 'Tomato sauces' },
        { id: 'en:tomatoes', text: 'Tomatoes' },
      ]);

      await expect(taxonomy.canonicalizeTag('categories', 'Tomato', ctx)).resolves.toEqual({
        value: 'en:tomatoes',
        resolution: 'vocabulary',
      });
    });

    it('adds "es" only where English does, so a truncated word does not resolve', async () => {
      // Live 2026-09-23: the autocomplete answers `ric` with en:rice and en:rices and `chees` with
      // en:cheeses, while Product Opener counts categories_tags=en:ric as 0 — a typo, not a plural.
      stubOptions([
        { id: 'en:rice', text: 'Rice' },
        { id: 'en:rices', text: 'Rices' },
        { id: 'en:cheeses', text: 'Cheeses' },
        { id: 'en:peaches', text: 'Peaches' },
      ]);

      await expect(taxonomy.canonicalizeTag('categories', 'en:ric', ctx)).resolves.toMatchObject({
        value: 'en:ric',
        resolution: 'normalized',
      });
      await expect(taxonomy.canonicalizeTag('categories', 'en:chees', ctx)).resolves.toMatchObject({
        value: 'en:chees',
        resolution: 'normalized',
      });
      await expect(taxonomy.canonicalizeTag('categories', 'en:peach', ctx)).resolves.toEqual({
        value: 'en:peaches',
        resolution: 'vocabulary',
      });
    });

    it('accepts no other suffix and no shorter stem', async () => {
      stubOptions([
        { id: 'en:nuts', text: 'Nuts' },
        { id: 'en:nutmegs', text: 'Nutmeg' },
      ]);

      await expect(taxonomy.canonicalizeTag('allergens', 'en:nu', ctx)).resolves.toMatchObject({
        value: 'en:nu',
        resolution: 'normalized',
      });
      await expect(taxonomy.canonicalizeTag('allergens', 'en:nutmeg', ctx)).resolves.toEqual({
        value: 'en:nutmegs',
        resolution: 'vocabulary',
      });
      await expect(taxonomy.canonicalizeTag('allergens', 'en:nutme', ctx)).resolves.toMatchObject({
        resolution: 'normalized',
      });
    });

    it('rejects a longer name that only starts with the value', async () => {
      stubOptions([{ id: 'en:soviet-union', text: 'USSR' }]);

      await expect(taxonomy.canonicalizeTag('countries', 'US', ctx)).resolves.toMatchObject({
        value: 'en:us',
        resolution: 'normalized',
        reason: 'no_match',
      });
    });

    it('normalizes an unmatched value the way Product Opener would store it', async () => {
      await expect(taxonomy.canonicalizeTag('countries', 'Never Land', ctx)).resolves.toEqual({
        value: 'en:never-land',
        resolution: 'normalized',
        reason: 'no_match',
      });
      await expect(
        taxonomy.canonicalizeTag('categories', 'FR:Confitures de fraises', ctx),
      ).resolves.toMatchObject({ value: 'fr:confitures-de-fraises', reason: 'no_match' });
    });
  });

  describe('best effort', () => {
    it('falls back to the normalized value when the lookup is refused, and never throws', async () => {
      global.fetch = vi.fn(async () => mockResponse({ detail: 'refused' }, 400));

      await expect(taxonomy.canonicalizeTag('countries', 'US', ctx)).resolves.toEqual({
        value: 'en:us',
        resolution: 'normalized',
        reason: 'lookup_failed',
      });
    });

    it('falls back without sending anything once the taxonomy budget is spent', async () => {
      const budgeted = makeTaxonomy(1);
      stubOptions([]);

      await budgeted.canonicalizeTag('countries', 'Never Land', ctx);
      await expect(budgeted.canonicalizeTag('countries', 'Atlantis', ctx)).resolves.toEqual({
        value: 'en:atlantis',
        resolution: 'normalized',
        reason: 'lookup_failed',
      });
      expect(global.fetch).toHaveBeenCalledOnce();
    });

    it('does not cache a failed lookup, so the next search retries it', async () => {
      global.fetch = vi.fn(async () => mockResponse({ detail: 'refused' }, 400));
      await taxonomy.canonicalizeTag('countries', 'US', ctx);

      stubOptions([{ id: 'en:united-states', text: 'US' }]);
      await expect(taxonomy.canonicalizeTag('countries', 'US', ctx)).resolves.toMatchObject({
        value: 'en:united-states',
      });
      expect(global.fetch).toHaveBeenCalledOnce();
    });
  });

  describe('cache', () => {
    it('answers a repeated value from the cache, case-insensitively', async () => {
      stubOptions([{ id: 'en:united-states', text: 'US' }]);

      await taxonomy.canonicalizeTag('countries', 'US', ctx);
      await expect(taxonomy.canonicalizeTag('countries', 'us', ctx)).resolves.toMatchObject({
        value: 'en:united-states',
      });
      expect(global.fetch).toHaveBeenCalledOnce();
    });

    it('caches a definite no-match too', async () => {
      await taxonomy.canonicalizeTag('countries', 'Never Land', ctx);
      await taxonomy.canonicalizeTag('countries', 'Never Land', ctx);

      expect(global.fetch).toHaveBeenCalledOnce();
    });

    it('shares one lookup between concurrent calls for the same value', async () => {
      stubOptions([{ id: 'en:united-states', text: 'US' }]);

      const [first, second] = await Promise.all([
        taxonomy.canonicalizeTag('countries', 'US', ctx),
        taxonomy.canonicalizeTag('countries', ' us ', ctx),
      ]);

      expect(first).toEqual({ value: 'en:united-states', resolution: 'vocabulary' });
      expect(second).toEqual(first);
      expect(global.fetch).toHaveBeenCalledOnce();
    });

    it('shares a failed concurrent lookup too, but still retries it afterwards', async () => {
      global.fetch = vi.fn(async () => mockResponse({ detail: 'refused' }, 400));

      const results = await Promise.all([
        taxonomy.canonicalizeTag('countries', 'US', ctx),
        taxonomy.canonicalizeTag('countries', 'US', ctx),
      ]);
      expect(results.map((r) => r.resolution === 'normalized' && r.reason)).toEqual([
        'lookup_failed',
        'lookup_failed',
      ]);
      expect(global.fetch).toHaveBeenCalledOnce();

      stubOptions([{ id: 'en:united-states', text: 'US' }]);
      await expect(taxonomy.canonicalizeTag('countries', 'US', ctx)).resolves.toMatchObject({
        value: 'en:united-states',
      });
      expect(global.fetch).toHaveBeenCalledOnce();
    });

    it('keys the cache per facet', async () => {
      await taxonomy.canonicalizeTag('countries', 'Never Land', ctx);
      await taxonomy.canonicalizeTag('labels', 'Never Land', ctx);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(lookupUrl(1).searchParams.get('taxonomy_names')).toBe('label');
    });

    it('stays bounded, evicting the oldest entry first', async () => {
      taxonomy = makeTaxonomy(10_000);
      for (let i = 0; i <= 500; i++) await taxonomy.canonicalizeTag('countries', `place ${i}`, ctx);
      expect(global.fetch).toHaveBeenCalledTimes(501);

      // The newest entry is still cached; the first one was evicted and is looked up again.
      await taxonomy.canonicalizeTag('countries', 'place 500', ctx);
      expect(global.fetch).toHaveBeenCalledTimes(501);
      await taxonomy.canonicalizeTag('countries', 'place 0', ctx);
      expect(global.fetch).toHaveBeenCalledTimes(502);
    });
  });
});

describe('slugTagValue', () => {
  it('keeps letters outside ASCII and lowercases them', () => {
    expect(slugTagValue('ÉPICERIE Fine')).toBe('épicerie-fine');
    expect(slugTagValue('Шоколад')).toBe('шоколад');
  });

  it('collapses runs of separators and trims them from both ends', () => {
    expect(slugTagValue(' -- a  //  b -- ')).toBe('a-b');
  });
});
