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
    'Query Open Food Facts, a free crowd-sourced database of 3M+ packaged foods: off_get_product looks up one product by EAN-13/UPC barcode, off_search_products finds products by text or tag filters, off_compare_products puts several side by side on nutrition, and off_browse_taxonomy resolves a human term to the canonical tag ID the other tools filter on — so start there when you have a category or label rather than a barcode. Every field is contributor-entered, so a missing one means "not yet recorded" rather than absent, and the computed Nutri-Score, NOVA, and Green-Score grades carry regional caveats. No API key is required; the data is ODbL 1.0, so cite Open Food Facts wherever you pass it on.',
  sessionMode: 'stateless',
  setup() {
    initOpenFoodFactsService();
    initTaxonomyService();
  },
});
