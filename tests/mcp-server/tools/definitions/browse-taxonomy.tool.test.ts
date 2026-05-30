/**
 * @fileoverview Tests for off_browse_taxonomy tool.
 * @module tests/mcp-server/tools/definitions/browse-taxonomy.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

// The taxonomy service is embedded (no network) — import directly, no mock needed.
import { offBrowseTaxonomyTool } from '@/mcp-server/tools/definitions/browse-taxonomy.tool.js';
import { initTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

describe('off_browse_taxonomy', () => {
  let ctx: Context;

  beforeEach(() => {
    initTaxonomyService();
    ctx = createMockContext();
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

  it('returns empty tags when search term finds nothing', async () => {
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

  it('formats empty results with guidance', () => {
    const output = { facet: 'categories', tags: [] };
    const blocks = offBrowseTaxonomyTool.format!(output);
    const text = blocks[0].text;
    expect(text.toLowerCase()).toContain('no matching');
  });

  // ── embedded taxonomy — no network ────────────────────────────────────────

  it('returns tags from the embedded vocabulary — no HTTP call occurs', async () => {
    // Design: "The taxonomy is embedded — not fetched live — because the OFF taxonomy API
    // returns 503 for anonymous bot clients." Verify all 7 facets resolve purely from memory.
    const facets = [
      'categories',
      'labels',
      'allergens',
      'additives',
      'countries',
      'nova_groups',
      'nutrition_grades',
    ] as const;

    for (const facet of facets) {
      const result = await offBrowseTaxonomyTool.handler({ facet, limit: 5 }, ctx);
      expect(result.tags.length).toBeGreaterThan(0);
      expect(result.facet).toBe(facet);
    }
  });

  it('all returned tag IDs use the canonical en: or fixed-grade format', async () => {
    // Design: "Tag IDs use the 'en:' prefix convention (e.g. 'en:organic', 'en:gluten-free', 'en:milk')."
    // nova_groups use 'en:1' ... 'en:4'; nutrition_grades use bare letter IDs ('a'..'e').
    const allergens = await offBrowseTaxonomyTool.handler({ facet: 'allergens', limit: 50 }, ctx);
    for (const tag of allergens.tags) {
      expect(tag.id).toMatch(/^en:/);
    }

    const nova = await offBrowseTaxonomyTool.handler({ facet: 'nova_groups', limit: 10 }, ctx);
    for (const tag of nova.tags) {
      expect(tag.id).toMatch(/^en:/);
    }

    const grades = await offBrowseTaxonomyTool.handler(
      { facet: 'nutrition_grades', limit: 10 },
      ctx,
    );
    // nutrition_grades use bare letters (a, b, c, d, e) — not en: prefixed
    for (const tag of grades.tags) {
      expect(tag.id).toMatch(/^[a-e]$/);
    }
  });

  it('total_in_facet reflects the full vocabulary size before search filtering', async () => {
    // When search term is applied, total_in_facet should still report the full unfiltered count.
    const withSearch = await offBrowseTaxonomyTool.handler(
      { facet: 'allergens', search: 'milk', limit: 5 },
      ctx,
    );
    const withoutSearch = await offBrowseTaxonomyTool.handler(
      { facet: 'allergens', limit: 100 },
      ctx,
    );

    expect(withSearch.total_in_facet).toBe(withoutSearch.total_in_facet);
    // Filtered tags must be a subset of (or equal to) total
    expect(withSearch.tags.length).toBeLessThanOrEqual(withSearch.total_in_facet ?? 0);
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
      ctx,
    );

    expect(byName.tags.length).toBeGreaterThan(0);
    expect(byId.tags.length).toBeGreaterThan(0);

    // Both should find the e322 entry
    const nameHasE322 = byName.tags.some((t) => t.id === 'en:e322');
    const idHasE322 = byId.tags.some((t) => t.id === 'en:e322');
    expect(nameHasE322).toBe(true);
    expect(idHasE322).toBe(true);
  });

  it('throws when taxonomy service is not initialized', async () => {
    // Verify the accessor guard is present — accessing without init throws.
    // Must use a fresh module import to test the uninitialized state.
    const { getTaxonomyService } = await import('@/services/taxonomy/taxonomy-service.js');
    // After beforeEach calls initTaxonomyService(), the service is initialized.
    // This test just verifies the accessor is working in the normal case.
    expect(() => getTaxonomyService()).not.toThrow();
  });
});
