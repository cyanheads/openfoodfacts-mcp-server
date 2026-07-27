/**
 * @fileoverview Server-specific configuration for the Open Food Facts MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Rate-limit defaults sit at the per-IP ceilings Open Food Facts publishes, not above them: 15
 * req/min for product reads (`GET /api/v2/product/…`) and 10 req/min for search
 * (`GET /api/v2/search`). The documented consequence of exceeding either is an IP ban rather than a
 * throttle, so there is no headroom to spend. A shared outbound IP needs a lower number than the
 * published one — that is what the env vars are for, alongside operators running their own Product
 * Opener instance who can raise them.
 *
 * The taxonomy tier is covered by neither published figure: it calls search.openfoodfacts.org
 * (search-a-licious), a separate deployment the published limits do not name and for which no limit
 * is documented. Its default matches the search tier as a conservative stand-in.
 */
const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .default('https://world.openfoodfacts.org')
    .describe('Open Food Facts API base URL'),
  rateLimitProduct: z.coerce
    .number()
    .int()
    .min(1)
    .default(15)
    .describe('Product read rate limit (requests/min)'),
  rateLimitSearch: z.coerce
    .number()
    .int()
    .min(1)
    .default(10)
    .describe('Search rate limit (requests/min)'),
  rateLimitTaxonomy: z.coerce
    .number()
    .int()
    .min(1)
    .default(10)
    .describe('Taxonomy resolution rate limit (requests/min)'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazy-parsed server config from environment variables. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'OFF_BASE_URL',
    rateLimitProduct: 'OFF_RATE_LIMIT_PRODUCT',
    rateLimitSearch: 'OFF_RATE_LIMIT_SEARCH',
    rateLimitTaxonomy: 'OFF_RATE_LIMIT_TAXONOMY',
  });
  return _config;
}
