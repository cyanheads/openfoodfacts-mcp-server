/**
 * @fileoverview Tool definition for browsing Open Food Facts canonical tag vocabularies.
 * @module mcp-server/tools/definitions/browse-taxonomy
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { type Facet, getTaxonomyService } from '@/services/taxonomy/taxonomy-service.js';
import { mdInline, mdInlineCode } from '@/utils/markdown.js';

/**
 * Most tags one call returns. A larger `limit` returns this many and discloses the cut when more
 * matched.
 */
const TAXONOMY_LIMIT_CAP = 200;

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
    // `.int()` would advertise a `maximum` of 2^53 - 1 for a value the handler clamps to the cap.
    limit: z
      .number()
      .multipleOf(1, 'Send limit as a whole number, not a fractional one.')
      // multipleOf tolerates float noise (20.000000000000004). It stays for what it advertises; this
      // closes the gap, only where it passed, so 1.5 reports once.
      .refine(Number.isInteger, {
        error: 'Send limit as a whole number, not a fractional one.',
        when: ({ issues }) => issues.length === 0,
      })
      .min(1)
      .default(20)
      .describe(
        `Maximum entries to return (default 20). One call returns at most ${TAXONOMY_LIMIT_CAP}: a larger value returns the first ${TAXONOMY_LIMIT_CAP} and, when more matched, says how many did. There is no offset or page input: Open Food Facts offers no cursor for this lookup, so narrow the search term rather than paging. The tag spelling the term itself (e.g. "lentil" → en:lentils) is listed first among the live matches, so it is not the one a small limit cuts.`,
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
        `Caveat about the answer — that the listing is a limited reference list rather than the full vocabulary, that the live vocabulary could not be reached or gave no usable answer, that nothing matched and why, or that the limit cut matches, naming how many matched and the next call: a larger limit while one would list more, otherwise a narrower term, which is the only route past the first ${TAXONOMY_LIMIT_CAP} (a limit above ${TAXONOMY_LIMIT_CAP} is named too).`,
      ),
    truncated: z.boolean().optional().describe('True when more tags exist beyond the limit.'),
    shown: z.number().optional().describe('Number of tags returned.'),
    cap: z
      .number()
      .optional()
      .describe(`The limit that was applied — at most ${TAXONOMY_LIMIT_CAP}.`),
  },

  // The notice echoes the search term and an upstream failure cause, so it is escaped here at render
  // time: structuredContent keeps those values as sent.
  enrichmentTrailer: {
    notice: { render: (v) => `> ${mdInline(String(v))}` },
  },

  async handler(input, ctx) {
    const svc = getTaxonomyService();
    const limit = Math.min(input.limit, TAXONOMY_LIMIT_CAP);
    // The service trims and treats a blank term as absent, so the raw input goes through as given.
    const result = await svc.search(input.facet as Facet, input.search, limit, ctx);

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
    // caveat follows the cut guidance in that argument rather than being emitted separately and
    // silently overwritten: on an unfiltered browse it says to pass a search term.
    //
    // The cut guidance names the match count and a call that can bring more forward. Below the
    // cap that is a larger limit, or a narrower term when there is one. At the cap a larger limit
    // returns these same tags, so only a narrower term reaches the rest; a limit above the cap is
    // named too, since it is no longer what the cut was measured against. With every match
    // returned, nothing was withheld and nothing is disclosed. The cap branch can say "the term":
    // every embedded sample is smaller than the cap, so only a live search term reaches it.
    if (result.tags.length < result.matched_in_facet) {
      const matched = result.matched_in_facet;
      let cut: string;
      if (limit === TAXONOMY_LIMIT_CAP) {
        cut = `${limit < input.limit ? `limit ${input.limit} is above the ${TAXONOMY_LIMIT_CAP} tags one call returns; the` : 'The'} term matched ${matched} tags, and these are the first ${TAXONOMY_LIMIT_CAP}. Narrow the search term with a more specific word to bring the tag you need into the first ${TAXONOMY_LIMIT_CAP} — there is no offset to page past them.`;
      } else {
        const hasTerm = Boolean(input.search?.trim());
        const raise =
          matched <= TAXONOMY_LIMIT_CAP
            ? `Raise limit to ${matched} to list them all`
            : `Raise limit to ${TAXONOMY_LIMIT_CAP} for the first ${TAXONOMY_LIMIT_CAP}`;
        cut = `${hasTerm ? 'The term matched' : 'The listing holds'} ${matched} tags, and these are the first ${limit}. ${raise}${hasTerm ? ', or narrow the search term with a more specific word' : ''}.`;
      }
      ctx.enrich.truncated({
        shown: result.tags.length,
        cap: limit,
        guidance: [cut, result.notice].filter(Boolean).join(' '),
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
      // A backtick in a tag ID would close a single-backtick span and render the rest of the ID as
      // prose, so the span's delimiter is sized past whatever the ID carries.
      lines.push(`- ${mdInlineCode(tag.id)} — ${mdInline(tag.name)}`);
    }

    lines.push(
      '\n*Pass an `id` through to off_search_products exactly as shown — "en:organic" for most facets, bare "1"–"4" for NOVA groups, bare "a"–"e" for Nutri-Score grades.*',
    );

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
