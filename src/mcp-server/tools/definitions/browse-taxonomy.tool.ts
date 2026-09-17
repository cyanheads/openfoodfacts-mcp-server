/**
 * @fileoverview Tool definition for browsing Open Food Facts canonical tag vocabularies.
 * @module mcp-server/tools/definitions/browse-taxonomy
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { type Facet, getTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';
import { mdInline, mdInlineCode } from '@/utils/markdown.js';

export const offBrowseTaxonomyTool = tool('off_browse_taxonomy', {
  title: 'Browse Food Facts Taxonomy',
  description:
    'Resolve a human term to the canonical Open Food Facts tag ID that off_search_products filters on. Covers categories, labels/certifications, allergens, additives, countries, NOVA groups, and Nutri-Score grades. Pass a search term to resolve against the Open Food Facts vocabulary, which holds tens of thousands of tags; omitting it returns only a small reference list for each facet except NOVA groups and Nutri-Score grades, which are complete. Most tag IDs use the "en:" prefix (e.g. "en:organic", "en:no-gluten", "en:crustaceans"); NOVA groups return bare digits "1"-"4" and Nutri-Score grades bare letters "a"-"e". Pass the id through to off_search_products exactly as returned. Category tags are frequently plural ("kombucha" resolves to "en:kombuchas"), so use the returned id rather than constructing one.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
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
        '"categories" covers food categories (en:cheeses, en:breakfast-cereals). "labels" covers certifications (en:organic, en:fair-trade). "allergens" covers declared allergens (en:milk, en:gluten). "additives" covers E-numbers (en:e322). "countries" covers country-of-sale tags (en:france). "nova_groups" and "nutrition_grades" are closed vocabularies returned complete; the other five are resolved against the Open Food Facts taxonomy.',
      ),
    search: z
      .string()
      .optional()
      .describe(
        'Term to resolve. Matched case-insensitively as a substring of the tag ID, the display name, or a common synonym of either ("shellfish" resolves to en:crustaceans, "gluten free" to en:no-gluten). A single word works best ("hummus", not "hummus dip"). Omit only to see a small reference list — Open Food Facts cannot list the full vocabulary without a term, so an unfiltered call is not a view of the full facet.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        'Maximum entries to return (1–100, default 20). There is no offset or page input: Open Food Facts returns only the first `limit` matches for a term and offers no cursor, so narrow the search term rather than paging.',
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
                'Canonical tag ID (e.g. "en:organic"; bare "1"–"4" for NOVA groups, bare "a"–"e" for Nutri-Score grades). Pass this value through to the matching off_search_products filter parameter unchanged.',
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
      .describe(
        'Total entries in this facet. Present only for nova_groups and nutrition_grades, whose vocabularies are closed and complete. Absent for the other facets: Open Food Facts reports no match total and cannot enumerate them, so no figure would be a real one.',
      ),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Caveat about the answer — that the listing is a limited reference list rather than the full vocabulary, that Open Food Facts was unreachable, or that nothing matched and why.',
      ),
    truncated: z.boolean().optional().describe('True when more tags exist beyond the limit.'),
    shown: z.number().optional().describe('Number of tags returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
  },

  async handler(input, ctx) {
    const svc = getTaxonomyService();
    // The service trims and treats a blank term as absent, so the raw input goes through as given.
    const result = await svc.search(input.facet as Facet, input.search, input.limit, ctx);

    ctx.log.info('Taxonomy browsed', {
      facet: input.facet,
      search: input.search,
      returned: result.tags.length,
      matched: result.matched_in_facet,
    });

    // Disclose truncation only when matching rows were dropped by the limit. Compare the
    // returned count against the filtered-match count, not the full facet size — otherwise a
    // filtered search (including a zero-match one) falsely reports truncation against the
    // pre-filter vocabulary total.
    //
    // `notice` is one slot, and ctx.enrich.truncated() writes it from `guidance`, so the service's
    // caveat is routed through that argument when both apply rather than being emitted separately
    // and silently overwritten. It is the more useful next move than the generic raise-the-limit
    // default: on an unfiltered browse the answer is to pass a search term, not a larger cap.
    if (result.tags.length < result.matched_in_facet) {
      ctx.enrich.truncated({
        shown: result.tags.length,
        cap: input.limit,
        ...(result.notice && { guidance: result.notice }),
      });
    } else if (result.notice) {
      ctx.enrich.notice(result.notice);
    }

    return {
      facet: result.facet,
      tags: result.tags,
      ...(result.total_in_facet !== undefined && { total_in_facet: result.total_in_facet }),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ${result.facet} (${result.tags.length} entries${result.total_in_facet !== undefined ? ` of ${result.total_in_facet} total` : ''})\n`,
    ];

    if (result.tags.length === 0) {
      // No claim about the vocabulary is made here — whether nothing matched or the live lookup
      // failed is the notice's to say, and it reaches this surface as a trailer either way.
      lines.push('No tags returned for this query.');
      return [{ type: 'text' as const, text: lines.join('\n') }];
    }

    for (const tag of result.tags) {
      const products =
        tag.products !== undefined ? ` (~${tag.products.toLocaleString()} products)` : '';
      // A backtick in a tag ID would close a single-backtick span and render the rest of the ID as
      // prose, so the span's delimiter is sized past whatever the ID carries.
      lines.push(`- ${mdInlineCode(tag.id)} — ${mdInline(tag.name)}${products}`);
    }

    lines.push(
      '\n*Pass an `id` through to off_search_products exactly as shown — "en:organic" for most facets, bare "1"–"4" for NOVA groups, bare "a"–"e" for Nutri-Score grades.*',
    );

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
