/**
 * @fileoverview Tool definition for searching Open Food Facts products by text, tag filters, and
 * numeric nutrient thresholds.
 * @module mcp-server/tools/definitions/search-products
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  getOpenFoodFactsService,
  TEXT_SEARCH_RESULT_WINDOW,
} from '@/services/openfoodfacts/openfoodfacts-service.js';
import {
  NUTRIENT_FIELDS,
  NUTRIENT_OPERATORS,
  type NutrientOperator,
  type SearchParams,
} from '@/services/openfoodfacts/types.js';
import { mdInline } from '@/utils/markdown.js';

/** Comparison symbol per operator, for echoing a constraint back to the caller in the notice. */
const NUTRIENT_OPERATOR_SYMBOLS: Record<NutrientOperator, string> = {
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/**
 * Freshness disclosure attached to every response the text backend answered. No date is named:
 * the endpoint publishes no index timestamp, and deriving one would cost an extra search request
 * per call, so a literal date here would be a claim nothing re-checks. The observed cutoff and the
 * date it was observed live in docs/design.md instead.
 */
const TEXT_INDEX_SNAPSHOT_NOTE =
  'These results come from the text-search index, a snapshot that lags the live Open Food Facts database, so a recently contributed product can be missing from them. The same filters without query read the live database.';

export const offSearchProductsTool = tool('off_search_products', {
  title: 'Search Food Products',
  description:
    'Search Open Food Facts by full-text query, structured tag filters, or both at once. Returns a summary list with barcodes, product names, brands, Nutri-Score, NOVA group, and categories — enough for triage and selection, not full label data. Use off_get_product on the returned barcodes for complete details. A text query and tag filters combine: results match the query text and satisfy every filter provided (e.g. query "dark chocolate" with labels_tag "en:organic" and countries_tag "en:france" returns organic chocolate sold in France); numeric nutrient_filters express per-100 g thresholds such as sugars below 8 g and combine the same way; additives_tag is the one exception, filtering only on searches carrying neither query nor nutrient_filters. Tag filter values must be canonical tag IDs (e.g. "en:organic", "en:no-gluten") — use off_browse_taxonomy to resolve human terms to tag IDs. At least one search parameter is required. The two paths read different indexes: a search carrying query is answered by the text index, a snapshot that lags the live database, while a tag-only search reads the live database and is current — so a recently contributed product can be missing from a text search and present in the same search without query. Data is crowd-sourced; result count reflects contributed products, not all products in the market. Data under ODbL 1.0 — cite Open Food Facts in downstream use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search term across product names, brands, and ingredients. Combines with any tag filters — results match this text and satisfy the filters. Example: "dark chocolate 70%". Supplying it routes the search to the text index, a snapshot that lags the live Open Food Facts database; drop it to run the same tag filters against the current data.',
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
        'Brand slug (lowercased, hyphenated). Example: "nutella", "kelloggs". Matched exactly against the normalized slug — a partial or misspelled slug matches nothing rather than falling back to a near match, so put open-ended brand wording in query instead.',
      ),
    labels_tag: z
      .string()
      .optional()
      .describe(
        'Canonical label/certification tag ID. Example: "en:organic", "en:fair-trade", "en:no-gluten". Use off_browse_taxonomy with facet="labels".',
      ),
    allergens_tag: z
      .string()
      .optional()
      .describe(
        'Canonical allergen tag ID. Example: "en:milk", "en:gluten". Use off_browse_taxonomy with facet="allergens". Selects products that declare this allergen; it cannot select allergen-free products, because a product with no allergen tags may simply have none entered yet.',
      ),
    additives_tag: z
      .string()
      .optional()
      .describe(
        'Canonical additive (E-number) tag ID. Example: "en:e322", "en:e330". Use off_browse_taxonomy with facet="additives". Available only on searches carrying neither query nor nutrient_filters — both route to a backend with no additives field, so combining them is rejected instead of silently returning nothing.',
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
    nutrient_filters: z
      .array(
        z
          .object({
            nutrient: z
              .enum(NUTRIENT_FIELDS)
              .describe(
                'Nutrient to constrain, measured per 100 g. Energy is kilocalories; every other value is grams per 100 g.',
              ),
            operator: z
              .enum(NUTRIENT_OPERATORS)
              .describe(
                'Comparison against value: "lt" below, "lte" at or below, "gt" above, "gte" at or above.',
              ),
            value: z
              .number()
              .min(0)
              .describe("Threshold to compare against, in the nutrient's per-100 g unit."),
          })
          .describe('One numeric constraint on a per-100 g nutrient value.'),
      )
      .max(18)
      .optional()
      .describe(
        'Numeric constraints on nutrient values per 100 g, combined as AND with each other and with every other filter. Pair two entries on the same nutrient to express a range (e.g. sugars gte 2 and sugars lte 8). Served only by the text backend, so supplying one routes the search there even without query — it then reads the lagging text index and is subject to the 10,000-result page window, and additives_tag cannot be combined with it. Per-serving and prepared-product values are not searchable.',
      ),
    sort_by: z
      .enum(['last_modified_t', 'unique_scans_n', 'created_t', 'popularity_key'])
      .optional()
      .describe(
        'Sort order, applied on every search. Each value orders newest or highest first: "unique_scans_n" surfaces the most-scanned products, "last_modified_t" and "created_t" the most recently updated and newest records, "popularity_key" the most popular. Omitting it leaves text searches relevance-ranked and tag-only searches in the default order.',
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
    total: z
      .number()
      .describe(
        'Matching products in the database for this search. Exact unless total_is_lower_bound is true, in which case at least this many match and the real figure is unknown.',
      ),
    total_is_lower_bound: z
      .boolean()
      .describe(
        'True when the backend stopped counting at its ceiling and total is a floor, not the match total. Only text searches can hit it; add filters to bring the result set under the ceiling and get an exact count.',
      ),
    page: z.number().describe('Current page number (1-based).'),
    page_count: z
      .number()
      .describe(
        'Products returned on this page (mirrors page_size except on the last page). Not the total number of pages.',
      ),
    last_page: z
      .number()
      .optional()
      .describe(
        'Deepest page of this result set that holds products, at the page_size used — capped by the 10,000-result window on a search the text index answers. Absent when total_is_lower_bound is true — the total it would divide is the ceiling the backend stopped counting at, so no exact last page exists — and when nothing matched at all. On a tag-only search Open Food Facts can still refuse a deep page, so narrowing the filters beats paging out to this bound.',
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
    text_index_snapshot: z
      .string()
      .optional()
      .describe(
        'Present only on searches the text backend answered. States that those results come from an index snapshot that lags the live Open Food Facts database, so a recently contributed product can be missing from them while the tag-only path still returns it. Absent on tag-only searches, which read the live database.',
      ),
    truncated: z.boolean().optional().describe('True when more results exist beyond this page.'),
    shown: z.number().optional().describe('Number of products returned on this page.'),
    cap: z.number().optional().describe('The page_size that was applied.'),
  },

  enrichmentTrailer: {
    text_index_snapshot: { label: 'Index freshness' },
  },

  errors: [
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No search query or filter was provided',
      recovery:
        'Provide at least one of: query, categories_tag, brands_tag, labels_tag, allergens_tag, additives_tag, nutrient_filters, nutrition_grade, nova_group, or countries_tag.',
    },
    {
      reason: 'additives_filter_needs_tag_search',
      code: JsonRpcErrorCode.ValidationError,
      when: 'additives_tag was combined with a query or nutrient_filters, which route to a backend that cannot filter by additive',
      retryable: false,
      recovery:
        'Drop query and nutrient_filters to search by tags alone and keep the additive filter, or drop additives_tag to keep them. Every other filter combines freely.',
    },
    {
      reason: 'page_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: `A search the text backend serves asks for page * page_size beyond the ${TEXT_SEARCH_RESULT_WINDOW}-result window Open Food Facts offers`,
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
    const nutrientFilters = input.nutrient_filters ?? [];
    // Nutrient constraints are served only by the text backend, so they carry every property of
    // that path — the result window, the lagging index, the absent additives facet — with or
    // without a query.
    const servedByTextBackend = Boolean(input.query?.trim()) || nutrientFilters.length > 0;
    const hasFilter =
      servedByTextBackend ||
      Boolean(input.categories_tag?.trim()) ||
      Boolean(input.brands_tag?.trim()) ||
      Boolean(input.labels_tag?.trim()) ||
      Boolean(input.allergens_tag?.trim()) ||
      Boolean(input.additives_tag?.trim()) ||
      Boolean(input.nutrition_grade) ||
      Boolean(input.nova_group) ||
      Boolean(input.countries_tag?.trim());

    if (!hasFilter) {
      throw ctx.fail('no_filters', 'At least one search parameter is required.', {
        ...ctx.recoveryFor('no_filters'),
      });
    }

    // Only the tag-filter backend indexes additives. The text backend accepts an additives clause
    // and answers zero hits for every value, so honoring the combination would report "no such
    // product" about products that plainly exist. Refuse it instead of returning that lie.
    if (servedByTextBackend && input.additives_tag?.trim()) {
      throw ctx.fail(
        'additives_filter_needs_tag_search',
        'additives_tag filters only on searches the tag backend answers — a query or a nutrient constraint moves the search to a backend with no additives field, so pairing them would match nothing regardless of the additive.',
        {
          additives_tag: input.additives_tag,
          ...ctx.recoveryFor('additives_filter_needs_tag_search'),
        },
      );
    }

    // The text backend refuses page * page_size beyond its result window with an HTTP 400 that no
    // retry can clear. Reject it here so the caller gets the reachable page bound instead of a
    // backoff sequence. Scoped to the text path — the tag-only backend publishes no such window.
    if (servedByTextBackend && input.page * input.page_size > TEXT_SEARCH_RESULT_WINDOW) {
      const maxPage = Math.floor(TEXT_SEARCH_RESULT_WINDOW / input.page_size);
      throw ctx.fail(
        'page_out_of_range',
        `The text backend serves only the first ${TEXT_SEARCH_RESULT_WINDOW} results, and page ${input.page} at page_size ${input.page_size} asks for result ${input.page * input.page_size}.`,
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
    if (input.allergens_tag?.trim()) searchParams.allergens_tag = input.allergens_tag.trim();
    if (input.additives_tag?.trim()) searchParams.additives_tag = input.additives_tag.trim();
    if (input.nutrition_grade) searchParams.nutrition_grade = input.nutrition_grade;
    if (input.nova_group) searchParams.nova_group = input.nova_group;
    if (input.countries_tag?.trim()) searchParams.countries_tag = input.countries_tag.trim();
    if (nutrientFilters.length > 0) searchParams.nutrient_filters = nutrientFilters;
    if (input.sort_by) searchParams.sort_by = input.sort_by;

    const response = await svc.searchProducts(searchParams, ctx);

    if (servedByTextBackend) ctx.enrich({ text_index_snapshot: TEXT_INDEX_SNAPSHOT_NOTE });

    ctx.log.info('Product search completed', {
      total: response.count,
      total_is_lower_bound: !response.count_is_exact,
      returned: response.products.length,
      page: response.page,
    });

    // Pages the backend will actually serve, not pages implied by the match total — on the text
    // path that is capped by the result window, and on the tag path deep pages are refused
    // unpredictably, so neither is promised as reachable.
    const totalPages = Math.ceil(response.count / input.page_size);
    const reachablePages = servedByTextBackend
      ? Math.min(totalPages, Math.floor(TEXT_SEARCH_RESULT_WINDOW / input.page_size))
      : totalPages;
    // Only a counted total yields a real last page: dividing a count the backend stopped
    // incrementing would present its ceiling as a measurement.
    const lastPage = response.count_is_exact && response.count > 0 ? reachablePages : undefined;

    if (response.products.length === 0 && response.count > 0) {
      // An empty page inside a positive result set is an exhausted page, not a zero-match search.
      // Both backends reach it with an ordinary HTTP 200, so nothing upstream distinguishes the
      // two — telling the caller to broaden filters that are matching products would be wrong.
      const bound =
        lastPage === undefined
          ? `The backend stopped counting at ${response.count} matches, so there is no exact last page — request an earlier page.`
          : `Request page ${lastPage} or lower to reach them.`;

      ctx.enrich({
        notice:
          `Page ${response.page} is past the end of this result set — ${response.count} matching ` +
          `products exist, but no page this deep holds any. ${bound}`,
      });
    } else if (response.products.length === 0) {
      const filterParts: string[] = [];
      if (input.query) filterParts.push(`query="${input.query}"`);
      if (input.categories_tag) filterParts.push(`category="${input.categories_tag}"`);
      if (input.brands_tag) filterParts.push(`brand="${input.brands_tag}"`);
      if (input.labels_tag) filterParts.push(`label="${input.labels_tag}"`);
      if (input.allergens_tag) filterParts.push(`allergen="${input.allergens_tag}"`);
      if (input.additives_tag) filterParts.push(`additive="${input.additives_tag}"`);
      if (input.nutrition_grade) filterParts.push(`nutriscore="${input.nutrition_grade}"`);
      if (input.nova_group) filterParts.push(`nova="${input.nova_group}"`);
      if (input.countries_tag) filterParts.push(`country="${input.countries_tag}"`);
      for (const filter of nutrientFilters) {
        filterParts.push(
          `nutrient="${filter.nutrient}${NUTRIENT_OPERATOR_SYMBOLS[filter.operator]}${filter.value}"`,
        );
      }

      // A text search that matched nothing is not evidence the product is absent from Open Food
      // Facts — the index it read lags the live database. Say so and name what does reach a
      // product it has not caught up to, instead of letting "no products found" stand alone.
      const staleness = servedByTextBackend
        ? ' The text index may not hold recently contributed products, so an empty result here does not settle whether a matching product has been contributed: re-run the same filters without query to read the live database, or call off_get_product when the barcode is known.'
        : '';

      ctx.enrich({
        notice:
          `No products found for ${filterParts.join(', ')}. ` +
          'Try broader terms, check tag IDs via off_browse_taxonomy, or remove some filters.' +
          staleness,
      });
    } else if (response.count > response.page_count) {
      // Disclose when the page is smaller than the total result set.
      let position: string;
      if (!response.count_is_exact) {
        // totalPages is derived from a count the backend stopped incrementing, so stating it would
        // dress the ceiling up as a measured figure. Only the reachable bound is knowable here.
        position =
          `Page ${response.page} of ${reachablePages} reachable pages — the backend stopped counting at ` +
          `${response.count} matches, so more exist than it will either count or serve.`;
      } else if (reachablePages < totalPages) {
        position =
          `Page ${response.page} of ${reachablePages} reachable pages — ${totalPages} pages of matches exist, ` +
          `but text search serves only the first ${TEXT_SEARCH_RESULT_WINDOW} results.`;
      } else {
        position = `Page ${response.page} of ${totalPages}.`;
      }

      let nextStep: string;
      if (response.page >= reachablePages) {
        // Already at the deepest page this backend serves. Pointing at the page parameter here
        // would send the caller into the rejection the pre-flight check exists to prevent.
        nextStep = servedByTextBackend
          ? 'That is as deep as text search paginates — add filters so the products you need rank higher instead of paging further.'
          : 'No further pages of matches exist.';
      } else if (servedByTextBackend) {
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
      total_is_lower_bound: !response.count_is_exact,
      page: response.page,
      page_count: response.page_count,
      ...(lastPage !== undefined && { last_page: lastPage }),
      products,
    };
  },

  format: (result) => {
    if (result.products.length === 0 && result.total === 0) {
      return [
        {
          type: 'text' as const,
          text: `**No products found** (total: ${result.total})\n\nTry broadening the search terms or checking tag IDs via off_browse_taxonomy.`,
        },
      ];
    }

    const totalLabel = `${result.total}${result.total_is_lower_bound ? '+' : ''}`;
    /** The clipped-total caveat, rendered wherever a total is shown so neither branch flattens it. */
    const lowerBoundCaveat = `*At least ${result.total} products match — Open Food Facts stops counting there and does not report the true total. Add filters for an exact count.*`;

    if (result.products.length === 0) {
      // A positive total with an empty page is an exhausted page. Preserve the total, say which
      // page holds results, and say nothing about broadening filters that are matching products.
      const exhausted = [
        `**Page ${result.page} is past the end of this result set** (${totalLabel} total products)`,
      ];
      if (result.total_is_lower_bound) exhausted.push(lowerBoundCaveat);
      exhausted.push(
        '',
        result.last_page === undefined
          ? 'Open Food Facts stopped counting before the end of the matches, so there is no exact last page — request an earlier page.'
          : `Request page ${result.last_page} or lower to reach the matching products.`,
      );
      return [{ type: 'text' as const, text: exhausted.join('\n') }];
    }

    const lines: string[] = [
      `**${totalLabel} total products** (page ${result.page}${result.last_page === undefined ? '' : ` of ${result.last_page}`}, showing ${result.page_count})`,
    ];
    if (result.total_is_lower_bound) {
      lines.push(lowerBoundCaveat);
    }
    lines.push('');

    for (const p of result.products) {
      // Every value on a result row comes from the upstream record, the barcode included — it is
      // the record's own `code`, not the caller's input — so all of them are escaped.
      lines.push(
        `### ${p.product_name === undefined ? 'Unknown product' : mdInline(p.product_name)}`,
      );
      lines.push(`**Barcode:** ${mdInline(p.barcode)}`);
      if (p.brands) lines.push(`**Brand:** ${mdInline(p.brands)}`);

      const scores: string[] = [];
      if (p.nutriscore_grade) scores.push(`Nutri-Score: ${mdInline(p.nutriscore_grade)}`);
      if (p.nova_group !== undefined) scores.push(`NOVA: ${p.nova_group}`);
      if (p.ecoscore_grade) scores.push(`Green-Score: ${mdInline(p.ecoscore_grade)}`);
      if (scores.length > 0) lines.push(`**Scores:** ${scores.join(' | ')}`);

      if (p.categories_tags && p.categories_tags.length > 0) {
        // Rendered in full — structuredContent already carries every tag, so slicing here only
        // left text-only clients with a short list they had no way to complete.
        lines.push(`**Categories:** ${p.categories_tags.map(mdInline).join(', ')}`);
      }
      lines.push('');
    }

    lines.push('*Data: Open Food Facts (ODbL 1.0)*');

    return [{ type: 'text' as const, text: lines.join('\n') }];
  },
});
