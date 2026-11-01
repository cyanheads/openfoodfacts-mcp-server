/**
 * @fileoverview Live Open Food Facts captures from 2026-11-01 behind the stored as-sold read (#73),
 * saved under `tests/fixtures/as-sold/`. `v2-<code>.json` is the `GET /api/v2/product/<code>.json`
 * body trimmed to the product fields the service requests; `v35-<code>.json` is the
 * `GET /api/v3.5/product/<code>?fields=nutrition.input_sets` body as sent (the three captured with
 * `fields=nutrition` have the `aggregated_set` the narrower request leaves out removed).
 * `v35-99999999999994.json` is the 404 body for a code no record holds.
 * @module tests/fixtures/as-sold-captures
 */

import { readFileSync } from 'node:fs';
import type { RawProduct } from '@/services/openfoodfacts/types.js';

/** The barcodes with a v2 capture: two prepared-only reads and one as-sold read. */
export type V2CaptureCode = '7613035530799' | '3664346306027' | '3017620422003';

/** The barcodes with a v3.5 capture. */
export type V35CaptureCode =
  | V2CaptureCode
  | '8445290133403'
  | '7612100914199'
  | '16256866'
  | '3033710065783'
  | '99999999999994';

function capture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./as-sold/${name}.json`, import.meta.url), 'utf8'));
}

/** A v2 product read's body: `{ code, product, status: 1, status_verbose }`. */
export function v2Capture(code: V2CaptureCode): { code: string; product: RawProduct; status: 1 } {
  return capture(`v2-${code}`) as { code: string; product: RawProduct; status: 1 };
}

/** A v3.5 product read's body, fresh on every call so a test may edit it. */
export function v35Capture(code: V35CaptureCode): {
  product: { nutrition: { input_sets: Record<string, unknown>[] } };
  [key: string]: unknown;
} {
  return capture(`v35-${code}`) as {
    product: { nutrition: { input_sets: Record<string, unknown>[] } };
  };
}
