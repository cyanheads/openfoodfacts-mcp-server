/**
 * @fileoverview Tool definition for browsing Open Food Facts canonical tag vocabularies.
 * @module mcp-server/tools/definitions/browse-taxonomy
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { type Facet, getTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';

export const offBrowseTaxonomyTool = tool('off_browse_taxonomy', {
  title: 'Browse Food Facts Taxonomy',
  description:
    'Browse and search the canonical tag vocabulary for Open Food Facts filter facets. Returns tag IDs and display names for use as filter values in off_search_products. Covers categories, labels/certifications, allergens, additives, countries, NOVA groups, and Nutri-Score grades. The taxonomy is embedded — not fetched live — because the OFF taxonomy API is unavailable to anonymous bot clients. Tag IDs use the "en:" prefix convention (e.g. "en:organic", "en:gluten-free", "en:milk"). Always use these tag IDs as filter values, not plain English terms.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },

  input: z.object({
    facet: z
      .enum([
        'categories',
        'labels',
        'allergens',
        'additives',
        'countries',
        'nova_groups',
        'nutrition_grades',
      ])
      .describe(
        '"categories" covers food categories (en:cheeses, en:breakfast-cereals). "labels" covers certifications (en:organic, en:fair-trade). "allergens" covers declared allergens (en:milk, en:gluten). "additives" covers E-numbers (en:e322). "countries" covers country-of-sale tags (en:france). "nova_groups" and "nutrition_grades" return the complete fixed vocabularies.',
      ),
    search: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring filter against tag ID or display name. Example: "gluten" returns en:gluten, en:no-gluten. Omit to list all entries for the facet (may be large for categories).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        'Maximum entries to return (1–100, default 20). Categories has many entries — always provide a search term when browsing categories.',
      ),
  }),

  output: z.object({
    facet: z.string().describe('The facet name that was queried (echoes the input).'),
    tags: z
      .array(
        z
          .object({
            id: z
              .string()
              .describe(
                'Canonical tag ID (e.g. "en:organic"). Use this value in off_search_products filter parameters.',
              ),
            name: z.string().describe('Human-readable display name (e.g. "Organic").'),
            products: z
              .number()
              .optional()
              .describe(
                'Approximate count of products with this tag. Not available for all facets.',
              ),
          })
          .describe('A single taxonomy tag entry with its canonical ID and display name.'),
      )
      .describe('Matching tag entries.'),
    total_in_facet: z
      .number()
      .optional()
      .describe('Total entries in this facet before search filtering. Large for categories.'),
  }),

  handler(input, ctx) {
    const svc = getTaxonomyService();
    const result = svc.search(
      input.facet as Facet,
      input.search && input.search.trim().length > 0 ? input.search.trim() : undefined,
      input.limit,
    );

    ctx.log.info('Taxonomy browsed', {
      facet: input.facet,
      search: input.search,
      returned: result.tags.length,
      total: result.total_in_facet,
    });

    return {
      facet: result.facet,
      tags: result.tags,
      total_in_facet: result.total_in_facet,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ${result.facet} (${result.tags.length} entries${result.total_in_facet !== undefined ? ` of ${result.total_in_facet} total` : ''})\n`,
    ];

    if (result.tags.length === 0) {
      lines.push('No matching tags found. Try a different search term.');
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

    for (const tag of result.tags) {
      const products =
        tag.products !== undefined ? ` (~${tag.products.toLocaleString()} products)` : '';
      lines.push(`- \`${tag.id}\` — ${tag.name}${products}`);
    }

    lines.push(
      '\n*Use the `id` values (e.g. "en:organic") as filter parameters in off_search_products.*',
    );

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
