/**
 * @fileoverview Regression tests for the server config rate-limit defaults — pins each tier to the
 * per-IP ceiling Open Food Facts publishes (GH issue #21) and covers the env override an operator
 * needs on a shared outbound IP.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every env var the config reads. Cleared per case so a caller's shell cannot colour a default. */
const CONFIG_ENV_VARS = [
  'OFF_BASE_URL',
  'OFF_RATE_LIMIT_PRODUCT',
  'OFF_RATE_LIMIT_SEARCH',
  'OFF_RATE_LIMIT_TAXONOMY',
] as const;

/**
 * Imports a fresh copy of the config module and parses it. `getServerConfig` memoizes its result,
 * so each case needs its own module instance to observe the environment it just set.
 */
async function loadConfig() {
  vi.resetModules();
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig();
}

describe('getServerConfig rate-limit defaults', () => {
  beforeEach(() => {
    for (const name of CONFIG_ENV_VARS) vi.stubEnv(name, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults product reads to the 15 req/min Open Food Facts publishes', async () => {
    // Open Food Facts documents 15 req/min/IP for `GET /api/v*/product` and answers an overrun
    // with an IP ban rather than a throttle, so the default must never sit above that ceiling.
    const config = await loadConfig();
    expect(config.rateLimitProduct).toBe(15);
  });

  it('defaults search to the 10 req/min Open Food Facts publishes', async () => {
    const config = await loadConfig();
    expect(config.rateLimitSearch).toBe(10);
  });

  it('defaults taxonomy resolution to 10 req/min', async () => {
    // search.openfoodfacts.org carries no published limit; the tier tracks the search figure as a
    // conservative stand-in rather than mirroring a documented number.
    const config = await loadConfig();
    expect(config.rateLimitTaxonomy).toBe(10);
  });

  it('lets an operator lower the product budget for a shared outbound IP', async () => {
    vi.stubEnv('OFF_RATE_LIMIT_PRODUCT', '5');
    const config = await loadConfig();
    expect(config.rateLimitProduct).toBe(5);
  });

  it('rejects a product budget below one request per minute', async () => {
    vi.stubEnv('OFF_RATE_LIMIT_PRODUCT', '0');
    await expect(loadConfig()).rejects.toThrow('OFF_RATE_LIMIT_PRODUCT');
  });
});
