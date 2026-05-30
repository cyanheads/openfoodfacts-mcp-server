/**
 * @fileoverview Tool definition for searching Open Food Facts products by text and tag filters.
 * @module mcp-server/tools/definitions/search-products
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';
import type { SearchParams } from '@/services/openfoodfacts/types.js';

export const offSearchProductsTool = tool('off_search_products', {
  title: 'Search Food Products',
  description:
    'Search Open Food Facts by text query or structured tag filters. Returns a summary list with barcodes, product names, brands, Nutri-Score, NOVA group, and categories — enough for triage and selection, not full label data. Use off_get_product on the returned barcodes for complete details. Text query and tag filters are mutually exclusive routing paths: when query is provided, a text search is performed and tag filters are ignored; when only tag filters are provided (no query), structured facet filtering is applied. Tag filter values must be canonical tag IDs (e.g. "en:organic", "en:gluten-free") — use off_browse_taxonomy to resolve human terms to tag IDs. At least one search parameter is required. Data is crowd-sourced; result count reflects contributed products, not all products in the market. Data under ODbL 1.0 — cite Open Food Facts in downstream use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search term across product names, brands, and ingredients. When provided, routes to the text search engine — tag filters (categories_tag, brands_tag, etc.) are ignored in this path. Example: "dark chocolate 70%".',
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
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('Page number (1-based). Use with page_size to paginate results.'),
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
      .describe('Guidance when results are empty — echoes filters and suggests how to broaden.'),
  },

  errors: [
    {
      reason: 'no_filters',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'No search query or filter was provided',
      recovery:
        'Provide at least one of: query, categories_tag, brands_tag, labels_tag, nutrition_grade, nova_group, or countries_tag.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Open Food Facts API returns 5xx or is unreachable',
      retryable: true,
      recovery:
        'Retry after a brief pause. The Open Food Facts service may be rate-limiting or experiencing high load.',
    },
  ],

  async handler(input, ctx) {
    const hasFilter =
      (input.query && input.query.trim().length > 0) ||
      (input.categories_tag && input.categories_tag.trim().length > 0) ||
      (input.brands_tag && input.brands_tag.trim().length > 0) ||
      (input.labels_tag && input.labels_tag.trim().length > 0) ||
      input.nutrition_grade ||
      input.nova_group ||
      (input.countries_tag && input.countries_tag.trim().length > 0);

    if (!hasFilter) {
      throw ctx.fail('no_filters', 'At least one search parameter is required.', {
        ...ctx.recoveryFor('no_filters'),
      });
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
    }

    const products = response.products.map((p) => ({
      barcode: ((p as unknown as Record<string, unknown>).code as string) ?? '',
      ...(p.product_name && { product_name: p.product_name }),
      ...(p.brands && { brands: p.brands }),
      ...(p.nutriscore_grade && { nutriscore_grade: p.nutriscore_grade }),
      ...(typeof p.nova_group === 'number' && { nova_group: p.nova_group }),
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
