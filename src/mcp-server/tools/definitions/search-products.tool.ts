/**
 * @fileoverview Tool definition for searching Open Food Facts products by text and tag filters.
 * @module mcp-server/tools/definitions/search-products
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getOpenFoodFactsService,
  TEXT_SEARCH_RESULT_WINDOW,
} from '@/services/openfoodfacts/openfoodfacts-service.js';
import type { SearchParams } from '@/services/openfoodfacts/types.js';

export const offSearchProductsTool = tool('off_search_products', {
  title: 'Search Food Products',
  description:
    'Search Open Food Facts by full-text query, structured tag filters, or both at once. Returns a summary list with barcodes, product names, brands, Nutri-Score, NOVA group, and categories — enough for triage and selection, not full label data. Use off_get_product on the returned barcodes for complete details. A text query and tag filters combine: results match the query text and satisfy every filter provided (e.g. query "dark chocolate" with labels_tag "en:organic" and countries_tag "en:france" returns organic chocolate sold in France). Tag filter values must be canonical tag IDs (e.g. "en:organic", "en:gluten-free") — use off_browse_taxonomy to resolve human terms to tag IDs. At least one search parameter is required. Data is crowd-sourced; result count reflects contributed products, not all products in the market. Data under ODbL 1.0 — cite Open Food Facts in downstream use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search term across product names, brands, and ingredients. Combines with any tag filters — results match this text and satisfy the filters. Example: "dark chocolate 70%".',
      ),
    categories_tag: z
      .string()
      .optional()
      .describe(
        'Canonical category tag ID. Example: "en:breakfast-cereals", "en:cheeses". Use off_browse_taxonomy with facet="categories" to discover valid values.',
      ),
    brands_tag: z
      .string()
      .optional()
      .describe(
        'Brand slug (lowercased, hyphenated). Example: "nutella", "kelloggs". Fuzzy — partial matches may work.',
      ),
    labels_tag: z
      .string()
      .optional()
      .describe(
        'Canonical label/certification tag ID. Example: "en:organic", "en:fair-trade", "en:no-gluten". Use off_browse_taxonomy with facet="labels".',
      ),
    nutrition_grade: z
      .enum(['a', 'b', 'c', 'd', 'e'])
      .optional()
      .describe(
        'Filter by Nutri-Score grade. "a" is highest nutritional quality, "e" is lowest. Products without a score are excluded.',
      ),
    nova_group: z
      .enum(['1', '2', '3', '4'])
      .optional()
      .describe(
        'Filter by NOVA food processing class. "1"=unprocessed/minimally processed, "4"=ultra-processed. Products without a NOVA score are excluded.',
      ),
    countries_tag: z
      .string()
      .optional()
      .describe(
        'Canonical country tag ID. Example: "en:france", "en:united-states". Filters to products sold in that country.',
      ),
    sort_by: z
      .enum(['last_modified_t', 'unique_scans_n', 'created_t', 'popularity_key'])
      .optional()
      .describe(
        'Sort order for searches without a text query. "unique_scans_n" surfaces the most-scanned products; omitting returns results in default order. Searches that include a text query are relevance-ranked and ignore this option.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Page number (1-based). Use with page_size to paginate results. Searches that include a text query serve only the first 10,000 results, so page * page_size must stay at or below 10,000 — a deeper request is rejected rather than sent. Tag-only searches have no published window, but Open Food Facts refuses deep pages unpredictably; narrowing the filters is more reliable than paging far in.',
      ),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe(
        'Results per page (1–50, default 20). Keep low for initial exploration; increase for comparison workflows.',
      ),
  }),

  output: z.object({
    total: z.number().describe('Total matching products in the database for this query.'),
    page: z.number().describe('Current page number (1-based).'),
    page_count: z
      .number()
      .describe(
        'Products returned on this page (mirrors page_size except on the last page). Not the total number of pages.',
      ),
    products: z
      .array(
        z
          .object({
            barcode: z
              .string()
              .describe('EAN/UPC barcode. Pass to off_get_product for full details.'),
            product_name: z
              .string()
              .optional()
              .describe('Product name. May be absent for incompletely entered products.'),
            brands: z
              .string()
              .optional()
              .describe('Brand name(s), comma-separated. Absent when not yet entered.'),
            nutriscore_grade: z
              .string()
              .optional()
              .describe('Nutri-Score letter (a–e). Absent when not computed.'),
            nova_group: z
              .number()
              .optional()
              .describe('NOVA processing class (1–4). Absent when not assigned.'),
            ecoscore_grade: z
              .string()
              .optional()
              .describe(
                'Green-Score letter (a–e). Environmental impact indicator. Absent when not computed.',
              ),
            categories_tags: z
              .array(z.string().describe('Canonical category tag ID (e.g. "en:cheeses").'))
              .optional()
              .describe(
                'Category tag IDs in canonical form. Use as filter values for off_search_products.',
              ),
          })
          .describe('A single matching product summary row.'),
      )
      .describe('Matching products. Use barcodes with off_get_product for full label data.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance about this result set — echoes the filters and suggests how to broaden when nothing matched, or names the current page and how far the backend will actually paginate when more results exist.',
      ),
    truncated: z.boolean().optional().describe('True when more results exist beyond this page.'),
    shown: z.number().optional().describe('Number of products returned on this page.'),
    cap: z.number().optional().describe('The page_size that was applied.'),
  },

  errors: [
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No search query or filter was provided',
      recovery:
        'Provide at least one of: query, categories_tag, brands_tag, labels_tag, nutrition_grade, nova_group, or countries_tag.',
    },
    {
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: `A text search asks for page * page_size beyond the ${TEXT_SEARCH_RESULT_WINDOW}-result window the text backend serves`,
      retryable: false,
      recovery:
        'Request an earlier page, or add filters so the products you need fall inside the first results rather than deep in the ranking.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Open Food Facts returns 5xx, serves an HTML error page, or is unreachable',
      retryable: true,
      recovery:
        'Retry after a brief pause. The Open Food Facts service may be shedding load — narrow the filters if deep pages keep failing.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'Open Food Facts did not answer within the request deadline',
      retryable: true,
      recovery:
        'Retry once with a smaller page_size. Broad unfiltered searches are the slowest for Open Food Facts to assemble.',
    },
    {
      reason: 'upstream_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Open Food Facts answers 4xx — the request as formed will be refused again',
      retryable: false,
      recovery:
        'Do not retry. Read data.status and the upstream explanation in the message; reduce the page depth or correct the filter values.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: "This server's own per-minute search budget is spent, or Open Food Facts answers 429",
      retryable: true,
      recovery:
        'Wait the seconds given in data.retryAfter, then retry. Searches carry a much smaller budget than product lookups.',
    },
  ],

  async handler(input, ctx) {
    const isTextSearch = Boolean(input.query?.trim());
    const hasFilter =
      isTextSearch ||
      Boolean(input.categories_tag?.trim()) ||
      Boolean(input.brands_tag?.trim()) ||
      Boolean(input.labels_tag?.trim()) ||
      Boolean(input.nutrition_grade) ||
      Boolean(input.nova_group) ||
      Boolean(input.countries_tag?.trim());

    if (!hasFilter) {
      throw ctx.fail('no_filters', 'At least one search parameter is required.', {
        ...ctx.recoveryFor('no_filters'),
      });
    }

    // The text backend refuses page * page_size beyond its result window with an HTTP 400 that no
    // retry can clear. Reject it here so the caller gets the reachable page bound instead of a
    // backoff sequence. Scoped to the text path — the tag-only backend publishes no such window.
    if (isTextSearch && input.page * input.page_size > TEXT_SEARCH_RESULT_WINDOW) {
      const maxPage = Math.floor(TEXT_SEARCH_RESULT_WINDOW / input.page_size);
      throw ctx.fail(
        'page_out_of_range',
        `Text search serves only the first ${TEXT_SEARCH_RESULT_WINDOW} results, and page ${input.page} at page_size ${input.page_size} asks for result ${input.page * input.page_size}.`,
        {
          page: input.page,
          page_size: input.page_size,
          max_page: maxPage,
          result_window: TEXT_SEARCH_RESULT_WINDOW,
          recovery: {
            hint: `Request page ${maxPage} or lower at page_size ${input.page_size}, or add filters so the products you need rank inside the first ${TEXT_SEARCH_RESULT_WINDOW} results.`,
          },
        },
      );
    }

    const svc = getOpenFoodFactsService();
    const searchParams: SearchParams = {
      page: input.page,
      page_size: input.page_size,
    };
    if (input.query?.trim()) searchParams.query = input.query.trim();
    if (input.categories_tag?.trim()) searchParams.categories_tag = input.categories_tag.trim();
    if (input.brands_tag?.trim()) searchParams.brands_tag = input.brands_tag.trim();
    if (input.labels_tag?.trim()) searchParams.labels_tag = input.labels_tag.trim();
    if (input.nutrition_grade) searchParams.nutrition_grade = input.nutrition_grade;
    if (input.nova_group) searchParams.nova_group = input.nova_group;
    if (input.countries_tag?.trim()) searchParams.countries_tag = input.countries_tag.trim();
    if (input.sort_by) searchParams.sort_by = input.sort_by;

    const response = await svc.searchProducts(searchParams, ctx);

    ctx.log.info('Product search completed', {
      total: response.count,
      returned: response.products.length,
      page: response.page,
    });

    if (response.products.length === 0) {
      const filterParts: string[] = [];
      if (input.query) filterParts.push(`query="${input.query}"`);
      if (input.categories_tag) filterParts.push(`category="${input.categories_tag}"`);
      if (input.brands_tag) filterParts.push(`brand="${input.brands_tag}"`);
      if (input.labels_tag) filterParts.push(`label="${input.labels_tag}"`);
      if (input.nutrition_grade) filterParts.push(`nutriscore="${input.nutrition_grade}"`);
      if (input.nova_group) filterParts.push(`nova="${input.nova_group}"`);
      if (input.countries_tag) filterParts.push(`country="${input.countries_tag}"`);

      ctx.enrich({
        notice:
          `No products found for ${filterParts.join(', ')}. ` +
          'Try broader terms, check tag IDs via off_browse_taxonomy, or remove some filters.',
      });
    } else if (response.count > response.page_count) {
      // Disclose when the page is smaller than the total result set. The guidance counts pages the
      // backend will actually serve, not pages implied by the match total — on the text path that
      // is capped by the result window, and on the tag path deep pages are refused unpredictably,
      // so neither is promised as reachable.
      const totalPages = Math.ceil(response.count / input.page_size);
      const reachablePages = isTextSearch
        ? Math.min(totalPages, Math.floor(TEXT_SEARCH_RESULT_WINDOW / input.page_size))
        : totalPages;

      const position =
        reachablePages < totalPages
          ? `Page ${response.page} of ${reachablePages} reachable pages — ${totalPages} pages of matches exist, ` +
            `but text search serves only the first ${TEXT_SEARCH_RESULT_WINDOW} results.`
          : `Page ${response.page} of ${totalPages}.`;

      let nextStep: string;
      if (response.page >= reachablePages) {
        // Already at the deepest page this backend serves. Pointing at the page parameter here
        // would send the caller into the rejection the pre-flight check exists to prevent.
        nextStep = isTextSearch
          ? 'That is as deep as text search paginates — add filters so the products you need rank higher instead of paging further.'
          : 'No further pages of matches exist.';
      } else if (isTextSearch) {
        nextStep = 'Use the page parameter to fetch subsequent pages.';
      } else {
        nextStep =
          'Use the page parameter to fetch subsequent pages; Open Food Facts refuses deep pages ' +
          'unpredictably, so narrow the filters rather than paging far into a large result set.';
      }

      ctx.enrich.truncated({
        shown: response.page_count,
        cap: input.page_size,
        guidance: `${position} ${nextStep}`,
      });
    }

    const products = response.products.map((p) => ({
      barcode: ((p as unknown as Record<string, unknown>).code as string) ?? '',
      ...(p.product_name && { product_name: p.product_name }),
      ...(p.brands && { brands: p.brands }),
      ...(p.nutriscore_grade && { nutriscore_grade: p.nutriscore_grade }),
      ...(typeof p.nova_group === 'number' && { nova_group: p.nova_group }),
      ...(p.ecoscore_grade && { ecoscore_grade: p.ecoscore_grade }),
      ...(p.categories_tags && { categories_tags: p.categories_tags }),
    }));

    return {
      total: response.count,
      page: response.page,
      page_count: response.page_count,
      products,
    };
  },

  format: (result) => {
    if (result.products.length === 0) {
      return [
        {
          type: 'text' as const,
          text: `**No products found** (total: ${result.total})\n\nTry broadening the search terms or checking tag IDs via off_browse_taxonomy.`,
        },
      ];
    }

    const lines: string[] = [
      `**${result.total} total products** (page ${result.page}, showing ${result.page_count})\n`,
    ];

    for (const p of result.products) {
      lines.push(`### ${p.product_name ?? 'Unknown product'}`);
      lines.push(`**Barcode:** ${p.barcode}`);
      if (p.brands) lines.push(`**Brand:** ${p.brands}`);

      const scores: string[] = [];
      if (p.nutriscore_grade) scores.push(`Nutri-Score: ${p.nutriscore_grade}`);
      if (p.nova_group !== undefined) scores.push(`NOVA: ${p.nova_group}`);
      if (p.ecoscore_grade) scores.push(`Green-Score: ${p.ecoscore_grade}`);
      if (scores.length > 0) lines.push(`**Scores:** ${scores.join(' | ')}`);

      if (p.categories_tags && p.categories_tags.length > 0) {
        lines.push(`**Categories:** ${p.categories_tags.slice(0, 3).join(', ')}`);
      }
      lines.push('');
    }

    lines.push('*Data: Open Food Facts (ODbL 1.0)*');

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
