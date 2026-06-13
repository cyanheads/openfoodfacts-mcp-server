#!/usr/bin/env node
/**
 * @fileoverview openfoodfacts-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initOpenFoodFactsService } from './services/openfoodfacts/openfoodfacts-service.js';
import { initTaxonomyService } from './services/taxonomy/taxonomy-service.js';

await createApp({
  name: 'openfoodfacts-mcp-server',
  title: 'openfoodfacts-mcp-server',
  tools: allToolDefinitions,
  instructions:
    'Use the off_* tools to query Open Food Facts — a free, crowd-sourced global food product database covering 3M+ products. ' +
    'Primary workflow: off_get_product for barcode lookup (EAN-13/UPC), off_search_products to find products by text or tags, ' +
    'off_compare_products for side-by-side nutrition comparison, off_browse_taxonomy to resolve human terms to canonical tag IDs. ' +
    'Data is crowd-sourced — missing fields mean "not yet entered," not that the attribute is absent. ' +
    'Computed scores (Nutri-Score, NOVA, Green-Score) carry regional caveats. ' +
    'No API key required. Data under ODbL 1.0 — cite Open Food Facts in downstream use.',
  setup() {
    initOpenFoodFactsService();
    initTaxonomyService();
  },
});
