/**
 * @fileoverview The identifying User-Agent every request to Open Food Facts sends: API reads and the
 * export mirror's downloads alike.
 * @module services/openfoodfacts/user-agent
 */

import { readFileSync } from 'node:fs';

/**
 * Package version, read from package.json at load so the identifying User-Agent always matches the
 * shipped release rather than a hand-maintained constant that silently drifts between versions.
 */
const { version: PACKAGE_VERSION } = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * Identifying User-Agent required by OFF terms — identifies the client and provides a contact email.
 * Format per OFF docs: <client>/<version> (<contact>)
 */
export const USER_AGENT = `openfoodfacts-mcp-server/${PACKAGE_VERSION} (casey@caseyjhand.com)`;
