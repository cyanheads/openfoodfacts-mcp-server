/**
 * @fileoverview Tests for the tag-value canonicalizer the text search path runs every tag filter
 * through (GH issue #39): brand slugging, offline-sample and live-autocomplete resolution under the
 * exact-match rule, best-effort fallback (timed-out answers from GH issue #68, the retry deadline
 * from GH issue #72), the in-process cache, and caller cancellation (GH issue #60). Driven through
 * the real OpenFoodFactsService with a stubbed global fetch, so the rate limiter, retry
 * classification, and option parsing on the lookup path all run.
 * @module tests/services/taxonomy/taxonomy-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import { slugTagValue, TaxonomyService } from '@/services/taxonomy/taxonomy-service.js';
import { AUTOCOMPLETE_TIMED_OUT } from '../../fixtures/upstream-envelopes.js';

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

/** Run a call to settlement with the retry backoff collapsed onto fake timers. */
async function onFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = run();
    pending.catch(() => undefined);
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
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

    it('confirms a tag past the first 200 suggestions, sharing the whole-answer size (#70)', async () => {
      // Live 2026-10-30: `en:e314` is the 229th of the 650 suggestions an E-number term answers.
      const vocabulary = Array.from({ length: 650 }, (_, i) =>
        i === 228 ? { id: 'en:e314', text: 'E 314' } : { id: `en:zz-${i}`, text: `Filler ${i}` },
      );
      global.fetch = vi.fn(async (input: unknown) =>
        mockResponse({
          took: 1,
          timed_out: false,
          options: vocabulary.slice(0, Number(new URL(String(input)).searchParams.get('size'))),
        }),
      );

      await expect(taxonomy.canonicalizeTag('additives', 'en:e314', ctx)).resolves.toEqual({
        value: 'en:e314',
        resolution: 'vocabulary',
      });
      expect(lookupUrl().searchParams.get('size')).toBe('2000');
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

    it('reads a timed-out autocomplete as lookup_failed, never no_match, and caches nothing (#68)', async () => {
      global.fetch = vi.fn(async () => mockResponse(AUTOCOMPLETE_TIMED_OUT));

      const refused = await onFakeTimers(() =>
        taxonomy.canonicalizeTag('allergens', 'en:kiwi', ctx),
      );

      expect(refused).toEqual({
        value: 'en:kiwi',
        resolution: 'normalized',
        reason: 'lookup_failed',
      });
      expect(global.fetch).toHaveBeenCalledTimes(4);

      // A cached answer would resolve without this stub ever being called.
      stubOptions([{ id: 'en:kiwi', text: 'Kiwi' }]);
      await expect(taxonomy.canonicalizeTag('allergens', 'en:kiwi', ctx)).resolves.toEqual({
        value: 'en:kiwi',
        resolution: 'vocabulary',
      });
      expect(global.fetch).toHaveBeenCalledOnce();
    });

    it('reads a lookup past its retry deadline as lookup_failed and caches nothing (#72)', async () => {
      global.fetch = vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ) as typeof fetch;
      vi.useFakeTimers();
      let settledAtMs = -1;
      try {
        const start = Date.now();
        const pending = taxonomy.canonicalizeTag('allergens', 'en:kiwi', ctx).then((result) => {
          settledAtMs = Date.now() - start;
          return result;
        });
        await vi.advanceTimersByTimeAsync(120_000);

        await expect(pending).resolves.toEqual({
          value: 'en:kiwi',
          resolution: 'normalized',
          reason: 'lookup_failed',
        });
      } finally {
        vi.useRealTimers();
      }
      expect(settledAtMs).toBe(20_000);

      stubOptions([{ id: 'en:kiwi', text: 'Kiwi' }]);
      await expect(taxonomy.canonicalizeTag('allergens', 'en:kiwi', ctx)).resolves.toEqual({
        value: 'en:kiwi',
        resolution: 'vocabulary',
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

describe('TaxonomyService — caller cancellation (#60)', () => {
  const globalFetch = global.fetch;
  /** Resolves when the stubbed autocomplete fetch has been entered and is holding its request open. */
  let fetchEntered: Promise<void>;

  /**
   * Stubs the autocomplete with a request that stays in flight until its signal aborts, then
   * rejects the way a real fetch does. Calls after the first answer `options` at once, so a second
   * caller's own lookup can complete.
   */
  function stubHangingThen(options: { id: string; text: string }[] = []): void {
    let entered: () => void = () => undefined;
    fetchEntered = new Promise((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    global.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) {
        return Promise.resolve(mockResponse({ took: 1, timed_out: false, options }));
      }
      entered();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    }) as typeof fetch;
  }

  /** Starts `run`, aborts the controller once the lookup is in flight, and returns its rejection. */
  async function abortMidFetch(
    controller: AbortController,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    const pending = run();
    pending.catch(() => undefined);
    await fetchEntered;
    controller.abort();
    return pending.then(
      () => {
        throw new Error('Expected the aborted call to reject.');
      },
      (error: unknown) => error,
    );
  }

  afterEach(() => {
    global.fetch = globalFetch;
    vi.restoreAllMocks();
  });

  it('ends canonicalizeTag as cancelled, never as lookup_failed, and retries nothing', async () => {
    const taxonomy = makeTaxonomy();
    stubHangingThen();
    const controller = new AbortController();

    const error = await abortMidFetch(controller, () =>
      taxonomy.canonicalizeTag(
        'countries',
        'Never Land',
        createMockContext({ signal: controller.signal }),
      ),
    );

    expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it('caches nothing for a cancelled lookup, so the next caller asks the vocabulary', async () => {
    const taxonomy = makeTaxonomy();
    stubHangingThen([{ id: 'en:united-states', text: 'US' }]);
    const controller = new AbortController();
    await abortMidFetch(controller, () =>
      taxonomy.canonicalizeTag('countries', 'US', createMockContext({ signal: controller.signal })),
    );

    await expect(taxonomy.canonicalizeTag('countries', 'US', createMockContext())).resolves.toEqual(
      { value: 'en:united-states', resolution: 'vocabulary' },
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps one caller's cancellation from the callers sharing its lookup, replacing it once", async () => {
    const taxonomy = makeTaxonomy();
    stubHangingThen([{ id: 'en:united-states', text: 'US' }]);
    const controller = new AbortController();
    const owner = taxonomy.canonicalizeTag(
      'countries',
      'US',
      createMockContext({ signal: controller.signal }),
    );
    owner.catch(() => undefined);
    await fetchEntered;
    // Each joins the lookup the first caller started, then sees it end in that caller's cancellation.
    const joiners = Array.from({ length: 4 }, () =>
      taxonomy.canonicalizeTag('countries', 'US', createMockContext()),
    );
    controller.abort();

    await expect(owner).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    await expect(Promise.all(joiners)).resolves.toEqual(
      Array.from({ length: 4 }, () => ({ value: 'en:united-states', resolution: 'vocabulary' })),
    );
    // The cancelled request, then one replacement shared by every caller still waiting.
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('ends search() as cancelled, never as the offline fallback', async () => {
    const taxonomy = makeTaxonomy();
    stubHangingThen();
    const controller = new AbortController();

    const error = await abortMidFetch(controller, () =>
      taxonomy.search('categories', 'lentil', 20, createMockContext({ signal: controller.signal })),
    );

    expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(global.fetch).toHaveBeenCalledOnce();
  });

  it('keeps the offline fallback for an upstream failure that is not a cancellation', async () => {
    const taxonomy = makeTaxonomy();
    global.fetch = vi.fn(async () => mockResponse({ detail: 'refused' }, 400));

    const result = await taxonomy.search('categories', 'cheese', 20, createMockContext());

    expect(result.tags.map((tag) => tag.id)).toEqual(['en:cheeses', 'en:fresh-cheeses']);
    expect(result.notice).toContain('could not be reached or gave no usable answer');
  });

  describe.each([
    ['a timed-out answer', () => mockResponse(AUTOCOMPLETE_TIMED_OUT)],
    ['a 503', () => mockResponse('unavailable', 503)],
  ])('an abort during the backoff after %s', (_label, answer) => {
    /** Runs `run` until its first attempt failed and it is sleeping, then aborts the controller. */
    async function abortDuringBackoff(
      controller: AbortController,
      run: () => Promise<unknown>,
    ): Promise<unknown> {
      global.fetch = vi.fn(async () => answer());
      vi.useFakeTimers();
      try {
        const settled = run().then(
          () => {
            throw new Error('Expected the aborted call to reject.');
          },
          (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(global.fetch).toHaveBeenCalledOnce();

        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        return await settled;
      } finally {
        vi.useRealTimers();
      }
    }

    it('ends canonicalizeTag as cancelled, never as lookup_failed, and caches nothing', async () => {
      const taxonomy = makeTaxonomy();
      const controller = new AbortController();

      const error = await abortDuringBackoff(controller, () =>
        taxonomy.canonicalizeTag(
          'allergens',
          'en:kiwi',
          createMockContext({ signal: controller.signal }),
        ),
      );

      expect(error).toMatchObject({ name: 'AbortError' });
      expect(global.fetch).toHaveBeenCalledOnce();

      stubOptions([{ id: 'en:kiwi', text: 'Kiwi' }]);
      await expect(
        taxonomy.canonicalizeTag('allergens', 'en:kiwi', createMockContext()),
      ).resolves.toEqual({ value: 'en:kiwi', resolution: 'vocabulary' });
    });

    it('ends search() as cancelled, never as the offline sample', async () => {
      const taxonomy = makeTaxonomy();
      const controller = new AbortController();

      const error = await abortDuringBackoff(controller, () =>
        taxonomy.search(
          'categories',
          'cheese',
          20,
          createMockContext({ signal: controller.signal }),
        ),
      );

      expect(error).toMatchObject({ name: 'AbortError' });
      expect(global.fetch).toHaveBeenCalledOnce();
    });
  });

  describe('an abort in a retried attempt (#72)', () => {
    /** Answers 503, then holds the retry open and aborts the controller from inside it. */
    function stub503ThenAbort(controller: AbortController): void {
      let calls = 0;
      global.fetch = vi.fn((_input: unknown, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) return Promise.resolve(mockResponse('unavailable', 503));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
          controller.abort();
        });
      }) as typeof fetch;
    }

    it('ends canonicalizeTag as cancelled on the second attempt', async () => {
      const taxonomy = makeTaxonomy();
      const controller = new AbortController();
      stub503ThenAbort(controller);

      const error = await onFakeTimers(() =>
        taxonomy
          .canonicalizeTag('allergens', 'en:kiwi', createMockContext({ signal: controller.signal }))
          .then(
            () => {
              throw new Error('Expected the aborted call to reject.');
            },
            (rejection: unknown) => rejection,
          ),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect((error as Error).message).toContain('was aborted');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('ends search() as cancelled on the second attempt', async () => {
      const taxonomy = makeTaxonomy();
      const controller = new AbortController();
      stub503ThenAbort(controller);

      const error = await onFakeTimers(() =>
        taxonomy
          .search('categories', 'cheese', 20, createMockContext({ signal: controller.signal }))
          .then(
            () => {
              throw new Error('Expected the aborted call to reject.');
            },
            (rejection: unknown) => rejection,
          ),
      );

      expect(error).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
      expect((error as Error).message).toContain('was aborted');
      expect(global.fetch).toHaveBeenCalledTimes(2);
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
