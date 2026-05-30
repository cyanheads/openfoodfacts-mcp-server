/**
 * @fileoverview Server-specific configuration for the Open Food Facts MCP server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  baseUrl: z
    .string()
    .default('https://world.openfoodfacts.org')
    .describe('Open Food Facts API base URL'),
  rateLimitProduct: z.coerce
    .number()
    .int()
    .min(1)
    .default(100)
    .describe('Product read rate limit (requests/min)'),
  rateLimitSearch: z.coerce
    .number()
    .int()
    .min(1)
    .default(10)
    .describe('Search rate limit (requests/min)'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/** Lazy-parsed server config from environment variables. */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    baseUrl: 'OFF_BASE_URL',
    rateLimitProduct: 'OFF_RATE_LIMIT_PRODUCT',
    rateLimitSearch: 'OFF_RATE_LIMIT_SEARCH',
  });
  return _config;
}
