/**
 * @fileoverview Barrel export for all Open Food Facts tool definitions.
 * @module mcp-server/tools/definitions
 */

import { offBrowseTaxonomyTool } from './browse-taxonomy.tool.js';
import { offCompareProductsTool } from './compare-products.tool.js';
import { offGetProductTool } from './get-product.tool.js';
import { offSearchProductsTool } from './search-products.tool.js';

export const allToolDefinitions = [
  offGetProductTool,
  offSearchProductsTool,
  offCompareProductsTool,
  offBrowseTaxonomyTool,
];
