/**
 * @fileoverview Tests for off_browse_taxonomy — live taxonomy resolution against the
 * search-a-licious autocomplete endpoint, the offline-sample merge and fallback (GH issue #14),
 * and bare NOVA group tag IDs (GH issue #15).
 *
 * The taxonomy service now makes an HTTP call for the five open facets, so these stub global
 * `fetch` rather than mocking `fetchWithTimeout`: the framework helper throws on a non-2xx, so a
 * mock that *returns* one exercises a branch production never reaches.
 * @module tests/mcp-server/tools/definitions/browse-taxonomy.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn(() => ({
    baseUrl: 'https://world.openfoodfacts.org',
    rateLimitProduct: 100,
    rateLimitSearch: 10,
    rateLimitTaxonomy: 100,
  })),
}));

import { offBrowseTaxonomyTool } from '@/mcp-server/tools/definitions/browse-taxonomy.tool.js';
import { initOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

/** One suggestion in the shape the autocomplete endpoint returns. */
type Option = { id: string; text: string; taxonomy_name?: string };

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
function stubAutocomplete(options: Option[]): void {
  global.fetch = vi.fn().mockResolvedValue(mockResponse({ took: 1, timed_out: false, options }));
}

/** The URL the stubbed fetch was called with, parsed. */
function fetchedUrl(call = 0): URL {
  return new URL(vi.mocked(global.fetch).mock.calls[call]?.[0] as string);
}

describe('off_browse_taxonomy', () => {
  let ctx: Context;
  const globalFetch = global.fetch;

  beforeEach(() => {
    initOpenFoodFactsService();
    initTaxonomyService();
    ctx = createMockContext();
    // Default: upstream matches nothing, so a test that does not stub its own options exercises
    // the offline half alone rather than silently hitting the network.
    stubAutocomplete([]);
  });

  afterEach(() => {
    global.fetch = globalFetch;
    vi.restoreAllMocks();
  });

  it('returns tags for the labels facet', async () => {
    const result = await offBrowseTaxonomyTool.handler({ facet: 'labels', limit: 10 }, ctx);

    expect(result.facet).toBe('labels');
    expect(result.tags).toBeInstanceOf(Array);
    expect(result.tags.length).toBeGreaterThan(0);
    expect(result.tags.length).toBeLessThanOrEqual(10);

    for (const tag of result.tags) {
      expect(tag).toHaveProperty('id');
      expect(tag).toHaveProperty('name');
      expect(tag.id).toMatch(/^[a-z]+:/); // e.g. "en:organic"
    }
  });

  it('filters tags by search term (case-insensitive)', async () => {
    const result = await offBrowseTaxonomyTool.handler(
      { facet: 'allergens', search: 'milk', limit: 20 },
      ctx,
    );

    expect(result.tags.length).toBeGreaterThan(0);
    for (const tag of result.tags) {
      const matches =
        tag.id.toLowerCase().includes('milk') || tag.name.toLowerCase().includes('milk');
      expect(matches).toBe(true);
    }
  });

  it('returns the fixed nova_groups vocabulary', async () => {
    const result = await offBrowseTaxonomyTool.handler({ facet: 'nova_groups', limit: 10 }, ctx);

    expect(result.facet).toBe('nova_groups');
    expect(result.tags.length).toBeGreaterThan(0);
    // NOVA group names describe the processing level
    for (const tag of result.tags) {
      expect(tag.name.toUpperCase()).toContain('NOVA');
    }
  });

  it('returns the fixed nutrition_grades vocabulary', async () => {
    const result = await offBrowseTaxonomyTool.handler(
      { facet: 'nutrition_grades', limit: 10 },
      ctx,
    );

    expect(result.facet).toBe('nutrition_grades');
    expect(result.tags.length).toBeGreaterThan(0);
  });

  it('returns empty tags when neither source matches the search term', async () => {
    const result = await offBrowseTaxonomyTool.handler(
      { facet: 'categories', search: 'xyzzy-no-match-ever', limit: 10 },
      ctx,
    );

    expect(result.tags).toHaveLength(0);
  });

  it('respects the limit parameter', async () => {
    const result = await offBrowseTaxonomyTool.handler({ facet: 'categories', limit: 3 }, ctx);

    expect(result.tags.length).toBeLessThanOrEqual(3);
  });

  it('formats results with tag IDs and names', () => {
    const output = {
      facet: 'labels',
      tags: [
        { id: 'en:organic', name: 'Organic' },
        { id: 'en:fair-trade', name: 'Fair Trade', products: 5000 },
      ],
      total_in_facet: 50,
    };
    const blocks = offBrowseTaxonomyTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks[0].text;
    expect(text).toContain('en:organic');
    expect(text).toContain('Organic');
    expect(text).toContain('en:fair-trade');
    // products count rendered
    expect(text).toContain('5');
    expect(text).toContain('labels');
  });

  it('formats an empty result without claiming the tag does not exist', () => {
    // Whether nothing matched or the live lookup failed is the notice's to say — it reaches
    // content[] as an enrichment trailer. format() asserting "no such tag" would restate the very
    // bug #14 fixed for the fallback case, where the vocabulary went unchecked.
    const output = { facet: 'categories', tags: [] };
    const text = offBrowseTaxonomyTool.format!(output)[0].text;
    expect(text.toLowerCase()).toContain('no tags returned');
    expect(text.toLowerCase()).not.toContain('try a different search term');
  });

  // ── GH issue #14: live taxonomy resolution ────────────────────────────────

  describe('live resolution (GH issue #14)', () => {
    it('resolves a term the offline sample does not hold', async () => {
      // The reported repro: "hummus" returned zero tags while en:hummus filters 4,375 products.
      stubAutocomplete([{ id: 'en:hummus', text: 'Hummus', taxonomy_name: 'category' }]);

      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'categories', search: 'hummus', limit: 10 },
        ctx,
      );

      expect(result.tags).toEqual([{ id: 'en:hummus', name: 'Hummus' }]);
      expect(global.fetch).toHaveBeenCalledOnce();
    });

    it('returns the upstream tag verbatim rather than the singular term asked for', async () => {
      // Live-verified: "kombucha" resolves to en:kombuchas. Issue #14's own repro table says
      // en:kombucha, so a fix that assumed the query term were the tag would emit an invalid ID.
      stubAutocomplete([{ id: 'en:kombuchas', text: 'Kombuchas', taxonomy_name: 'category' }]);

      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'categories', search: 'kombucha', limit: 10 },
        ctx,
      );

      expect(result.tags.map((t) => t.id)).toEqual(['en:kombuchas']);
    });

    it('queries the autocomplete endpoint with the facet taxonomy name and one past the limit', async () => {
      await offBrowseTaxonomyTool.handler({ facet: 'labels', search: 'organic', limit: 5 }, ctx);

      const url = fetchedUrl();
      expect(url.host).toBe('search.openfoodfacts.org');
      expect(url.pathname).toBe('/autocomplete');
      expect(url.searchParams.get('q')).toBe('organic');
      expect(url.searchParams.get('taxonomy_names')).toBe('label');
      // limit + 1 — the endpoint has no offset, so an extra option is the only truncation signal.
      expect(url.searchParams.get('size')).toBe('6');
    });

    it('maps each open facet to its upstream taxonomy name', async () => {
      const expected: [string, string][] = [
        ['categories', 'category'],
        ['labels', 'label'],
        ['allergens', 'allergen'],
        ['additives', 'additive'],
        ['countries', 'country'],
      ];

      for (const [facet, taxonomyName] of expected) {
        stubAutocomplete([]);
        await offBrowseTaxonomyTool.handler({ facet, search: 'x', limit: 5 } as never, ctx);
        expect(fetchedUrl().searchParams.get('taxonomy_names')).toBe(taxonomyName);
      }
    });

    it('merges offline matches ahead of live suggestions and deduplicates by tag ID', async () => {
      stubAutocomplete([
        { id: 'en:organic', text: 'Organic' }, // already in the offline sample
        { id: 'en:organic-beers', text: 'Organic beers' },
      ]);

      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'labels', search: 'organic', limit: 10 },
        ctx,
      );

      const ids = result.tags.map((t) => t.id);
      expect(ids.filter((id) => id === 'en:organic')).toHaveLength(1);
      expect(ids[0]).toBe('en:organic');
      expect(ids).toContain('en:organic-beers');
    });

    it('drops live suggestions that do not satisfy the documented substring rule', async () => {
      // Live-verified: the endpoint matches display names and degrades to loosely-related
      // suggestions, so "e330" comes back as a page of unrelated E-numbers. Passing those through
      // would answer an exact E-number lookup with tags that do not contain it.
      stubAutocomplete([
        { id: 'en:e968', text: 'E-968' },
        { id: 'en:e1208', text: 'E1208' },
        { id: 'en:e126', text: 'E126' },
      ]);

      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'additives', search: 'e330', limit: 10 },
        ctx,
      );

      // en:e330 is in the offline sample; none of the upstream noise survives the filter.
      expect(result.tags.map((t) => t.id)).toEqual(['en:e330']);
    });

    it('keeps a live suggestion whose ID matches even when the display name does not', async () => {
      stubAutocomplete([{ id: 'en:hummus-with-tahini', text: 'Tahini spread' }]);

      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'categories', search: 'hummus', limit: 10 },
        ctx,
      );

      expect(result.tags.map((t) => t.id)).toContain('en:hummus-with-tahini');
    });

    it('skips a live option missing an id or a display name', async () => {
      // Neither half is usable — as a filter value or as a label — so the option is dropped
      // rather than passed on with an invented placeholder.
      stubAutocomplete([
        { id: 'en:hummus' } as Option,
        { text: 'hummus' } as Option,
        { id: 'en:hummus-dips', text: 'Hummus dips' },
      ]);

      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'categories', search: 'hummus', limit: 10 },
        ctx,
      );

      expect(result.tags).toEqual([{ id: 'en:hummus-dips', name: 'Hummus dips' }]);
    });

    it('treats a blank search term as absent, sending no query upstream', async () => {
      // Trimming lives in the service alone; a whitespace-only term must not reach the endpoint,
      // which answers an empty option list for an empty query.
      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'labels', search: '   ', limit: 3 },
        ctx,
      );

      expect(global.fetch).not.toHaveBeenCalled();
      expect(result.tags).toHaveLength(3);
      expect(getEnrichment(ctx).notice).toContain('offline');
    });

    it('trims surrounding whitespace off the term before resolving it', async () => {
      stubAutocomplete([{ id: 'en:hummus', text: 'Hummus' }]);

      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'categories', search: '  hummus  ', limit: 10 },
        ctx,
      );

      expect(fetchedUrl().searchParams.get('q')).toBe('hummus');
      expect(result.tags.map((t) => t.id)).toEqual(['en:hummus']);
    });

    it('makes no HTTP call for the closed vocabularies', async () => {
      // nova_groups and nutrition_grades have no upstream taxonomy — naming one answers an empty
      // option list — and both are complete offline, so a request would be pure latency.
      for (const facet of ['nova_groups', 'nutrition_grades'] as const) {
        const result = await offBrowseTaxonomyTool.handler({ facet, limit: 10 }, ctx);
        expect(result.tags.length).toBeGreaterThan(0);
      }

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('makes no HTTP call for an unfiltered browse, and says the listing is the offline sample', async () => {
      // The endpoint suggests against a term and answers an empty list for an empty query, so an
      // unfiltered call cannot be served live. Presenting the sample as the facet would repeat the
      // bug; the notice names it as a sample and points at the search term.
      const result = await offBrowseTaxonomyTool.handler({ facet: 'categories', limit: 100 }, ctx);

      expect(global.fetch).not.toHaveBeenCalled();
      expect(result.tags.length).toBeGreaterThan(0);
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('offline');
      expect(notice).toContain('search term');
    });
  });

  // ── GH issue #14: total_in_facet no longer presents a sample as the facet ──

  describe('total_in_facet', () => {
    it('is omitted for the live facets, which have no knowable total', async () => {
      // Reporting 79 for categories presented this server's sample as the size of the Open Food
      // Facts category vocabulary, which holds 14,552 entries. The autocomplete endpoint reports
      // no match total and cannot be enumerated, so no honest figure exists.
      stubAutocomplete([{ id: 'en:hummus', text: 'Hummus' }]);

      const withSearch = await offBrowseTaxonomyTool.handler(
        { facet: 'categories', search: 'hummus', limit: 10 },
        ctx,
      );
      const withoutSearch = await offBrowseTaxonomyTool.handler(
        { facet: 'categories', limit: 10 },
        createMockContext(),
      );

      expect(withSearch.total_in_facet).toBeUndefined();
      expect(withoutSearch.total_in_facet).toBeUndefined();
    });

    it('reports the real total for the closed vocabularies', async () => {
      const nova = await offBrowseTaxonomyTool.handler({ facet: 'nova_groups', limit: 10 }, ctx);
      const grades = await offBrowseTaxonomyTool.handler(
        { facet: 'nutrition_grades', limit: 10 },
        createMockContext(),
      );

      expect(nova.total_in_facet).toBe(4);
      expect(nova.tags).toHaveLength(4);
      expect(grades.total_in_facet).toBe(5);
      expect(grades.tags).toHaveLength(5);
    });
  });

  // ── GH issue #14: fallback when the live backend is unreachable ───────────

  describe('offline fallback', () => {
    it('returns offline matches and names the cause when the upstream is unreachable', async () => {
      global.fetch = vi.fn().mockRejectedValue(new TypeError('Unable to connect.'));

      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'labels', search: 'organic', limit: 10 },
        ctx,
      );

      // A working lookup during an Open Food Facts outage still answers.
      expect(result.tags.map((t) => t.id)).toContain('en:organic');
      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('could not be reached');
      // The caveat must be explicit that a miss here is not authoritative.
      expect(notice).toContain('offline sample');
    });

    it('falls back on an upstream 5xx rather than aborting the call', async () => {
      global.fetch = vi.fn().mockResolvedValue(mockResponse('Service Unavailable', 503));

      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'allergens', search: 'milk', limit: 10 },
        ctx,
      );

      expect(result.tags.map((t) => t.id)).toContain('en:milk');
      expect(getEnrichment(ctx).notice).toContain('could not be reached');
    });

    it('falls back on an HTML error page served with a 200', async () => {
      // Open Food Facts serves a rendered page under load; the service classifies it as an
      // upstream error rather than a parse failure, and the fallback absorbs it.
      let consumed = false;
      global.fetch = vi.fn(async () => {
        const read = (): string => {
          if (consumed) throw new TypeError('Body already read');
          consumed = true;
          return '<!doctype html><html><body>busy</body></html>';
        };
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
          json: async () => JSON.parse(read()),
          text: async () => read(),
        } as unknown as Response;
      });

      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'labels', search: 'organic', limit: 10 },
        ctx,
      );

      expect(result.tags.map((t) => t.id)).toContain('en:organic');
      expect(getEnrichment(ctx).notice).toContain('could not be reached');
    });

    it('still discloses the caveat when the offline sample also has no match', async () => {
      // The empty result must not read as "no such tag" — this is the exact failure #14 reported,
      // and a silent empty fallback would reintroduce it.
      global.fetch = vi.fn().mockRejectedValue(new TypeError('Unable to connect.'));

      const result = await offBrowseTaxonomyTool.handler(
        { facet: 'categories', search: 'hummus', limit: 10 },
        ctx,
      );

      expect(result.tags).toHaveLength(0);
      expect(getEnrichment(ctx).notice).toContain('could not be reached');
    });

    it('refuses locally without contacting Open Food Facts once the taxonomy budget is spent', async () => {
      // The taxonomy tier is its own bucket, so browsing the vocabulary cannot spend the budget
      // for the search the filter is being built for.
      const { OpenFoodFactsService } = await import(
        '@/services/openfoodfacts/openfoodfacts-service.js'
      );
      const { TaxonomyService } = await import('@/services/taxonomy/taxonomy-service.js');
      const svc = new TaxonomyService(
        new OpenFoodFactsService({
          baseUrl: 'https://world.openfoodfacts.org',
          rateLimitProduct: 100,
          rateLimitSearch: 100,
          rateLimitTaxonomy: 1,
        }),
      );
      stubAutocomplete([{ id: 'en:hummus', text: 'Hummus' }]);

      await svc.search('categories', 'hummus', 10, ctx);
      const second = await svc.search('categories', 'organic', 10, ctx);

      expect(global.fetch).toHaveBeenCalledOnce();
      expect(second.notice).toContain('could not be reached');
      expect(second.notice).toContain('budget');
    });
  });

  // ── GH issue #15: nova_groups tag IDs round-trip into off_search_products ──

  describe('tag ID formats (GH issue #15)', () => {
    it('emits bare digits for nova_groups, matching the off_search_products enum', async () => {
      // en:1..en:4 were rejected outright by off_search_products' nova_group enum, and on the text
      // backend `nova_group:en:1` is live-verified answering zero hits flagged is_count_exact:true
      // — a false "no products" rather than an error.
      const { offSearchProductsTool } = await import(
        '@/mcp-server/tools/definitions/search-products.tool.js'
      );

      const nova = await offBrowseTaxonomyTool.handler({ facet: 'nova_groups', limit: 10 }, ctx);

      expect(nova.tags.map((t) => t.id)).toEqual(['1', '2', '3', '4']);
      for (const tag of nova.tags) {
        expect(tag.id).not.toMatch(/^en:/);
        // The round trip the issue reported broken: every emitted ID is a valid filter value.
        expect(offSearchProductsTool.input.safeParse({ nova_group: tag.id }).success).toBe(true);
      }
    });

    it('emits bare letters for nutrition_grades, and en: IDs everywhere else', async () => {
      const grades = await offBrowseTaxonomyTool.handler(
        { facet: 'nutrition_grades', limit: 10 },
        ctx,
      );
      for (const tag of grades.tags) {
        expect(tag.id).toMatch(/^[a-e]$/);
      }

      const allergens = await offBrowseTaxonomyTool.handler(
        { facet: 'allergens', limit: 50 },
        createMockContext(),
      );
      for (const tag of allergens.tags) {
        expect(tag.id).toMatch(/^en:/);
      }
    });
  });

  // ── Bug #4 regression: truncation reflects matched rows, not facet size ────

  it('does not signal truncation when a filtered search returns zero matches', async () => {
    // Bug #4: a 0-match filtered search compared returned (0) against the full pre-filter
    // facet size (79), wrongly emitting truncated:true. There is nothing more to show.
    const result = await offBrowseTaxonomyTool.handler(
      { facet: 'categories', search: 'zzzz-no-match', limit: 5 },
      ctx,
    );

    expect(result.tags).toHaveLength(0);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('does not signal truncation when all filtered matches fit under the limit', async () => {
    // Bug #4: labels + "gluten" yields fewer than `limit` matches; every match was returned,
    // so truncation must not fire even though the full labels facet is larger.
    const result = await offBrowseTaxonomyTool.handler(
      { facet: 'labels', search: 'gluten', limit: 5 },
      ctx,
    );

    expect(result.tags.length).toBeGreaterThan(0);
    expect(result.tags.length).toBeLessThan(5);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('signals truncation when filtered matches exceed the limit', async () => {
    // Regression guard for the genuinely-capped case: labels + "no" matches several entries
    // (a strict subset of the facet); capping at 3 drops matches, so truncation must fire.
    const result = await offBrowseTaxonomyTool.handler(
      { facet: 'labels', search: 'no', limit: 3 },
      ctx,
    );

    expect(result.tags).toHaveLength(3);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(3);
    expect(enrichment.cap).toBe(3);
  });

  it('signals truncation when live suggestions overflow the limit', async () => {
    // The endpoint is asked for limit + 1 precisely so a saturated page is reported as capped
    // rather than passed off as the complete match set.
    stubAutocomplete([
      { id: 'en:cheese-naans', text: 'Cheese naans' },
      { id: 'en:cheese-pizzas', text: 'Cheese pizzas' },
      { id: 'en:cheese-spreads', text: 'Cheese spreads' },
    ]);

    const result = await offBrowseTaxonomyTool.handler(
      { facet: 'categories', search: 'cheese', limit: 2 },
      ctx,
    );

    expect(result.tags).toHaveLength(2);
    expect(getEnrichment(ctx).truncated).toBe(true);
  });

  it('signals truncation for an unfiltered browse that exceeds the limit', async () => {
    // No search term: the whole offline sample is the match set, so a page smaller than it
    // still truncates. The fix must not suppress genuine truncation.
    const result = await offBrowseTaxonomyTool.handler({ facet: 'categories', limit: 5 }, ctx);

    expect(result.tags).toHaveLength(5);
    expect(getEnrichment(ctx).truncated).toBe(true);
    // The sample caveat rides the truncation guidance rather than being overwritten by it —
    // `notice` is one slot, and the offline-sample warning is the more useful next move.
    expect(getEnrichment(ctx).notice).toContain('offline');
  });

  it('search matches against both id and name fields', async () => {
    // Design: "case-insensitive substring match against tag ID or display name"
    // "Lecithin" is part of the name "E322 Lecithins" but not in the ID "en:e322"
    const byName = await offBrowseTaxonomyTool.handler(
      { facet: 'additives', search: 'Lecithin', limit: 10 },
      ctx,
    );
    const byId = await offBrowseTaxonomyTool.handler(
      { facet: 'additives', search: 'e322', limit: 10 },
      createMockContext(),
    );

    expect(byName.tags.length).toBeGreaterThan(0);
    expect(byId.tags.length).toBeGreaterThan(0);

    // Both should find the e322 entry
    expect(byName.tags.some((t) => t.id === 'en:e322')).toBe(true);
    expect(byId.tags.some((t) => t.id === 'en:e322')).toBe(true);
  });

  it('throws when taxonomy service is not initialized', async () => {
    // Verify the accessor guard is present — accessing without init throws.
    const { getTaxonomyService } = await import('@/services/taxonomy/taxonomy-service.js');
    // After beforeEach calls initTaxonomyService(), the service is initialized.
    expect(() => getTaxonomyService()).not.toThrow();
  });
});
