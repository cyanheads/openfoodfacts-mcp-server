/**
 * @fileoverview Tests for off_compare_products tool.
 * @module tests/mcp-server/tools/definitions/compare-products.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfoodfacts/openfoodfacts-service.js', () => ({
  getOpenFoodFactsService: vi.fn(),
}));

import { offCompareProductsTool } from '@/mcp-server/tools/definitions/compare-products.tool.js';
import { getOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';

const mockGetProductFields = vi.fn();

describe('off_compare_products', () => {
  let ctx: Context;

  beforeEach(() => {
    mockGetProductFields.mockReset();
    vi.mocked(getOpenFoodFactsService).mockReturnValue({
      getProductFields: mockGetProductFields,
    } as never);
    ctx = createMockContext();
  });

  it('returns comparison rows for two found products', async () => {
    mockGetProductFields
      .mockResolvedValueOnce({
        product_name: 'Nutella',
        brands: 'Ferrero',
        nutriscore_grade: 'e',
        nova_group: 4,
        ecoscore_grade: 'c',
        completeness: 0.85,
        nutriments: { 'energy-kcal_100g': 539, fat_100g: 30.9, sugars_100g: 56.3 },
      })
      .mockResolvedValueOnce({
        product_name: 'Peanut Butter',
        brands: 'Skippy',
        nutriscore_grade: 'c',
        nova_group: 3,
        ecoscore_grade: 'b',
        completeness: 0.72,
        nutriments: { 'energy-kcal_100g': 580, fat_100g: 50, sugars_100g: 8 },
      });

    const result = await offCompareProductsTool.handler(
      { barcodes: ['3017620422003', '7622210100146'] },
      ctx,
    );

    expect(result.succeeded).toBe(2);
    expect(result.not_found).toHaveLength(0);
    expect(result.products).toHaveLength(2);

    const nutella = result.products[0];
    expect(nutella?.product_name).toBe('Nutella');
    expect(nutella?.nutriscore_grade).toBe('e');
    expect(nutella?.ecoscore_grade).toBe('c');
    expect(nutella?.completeness).toBe(0.85);
    expect(nutella?.energy_kcal_100g).toBe(539);
  });

  it('marks missing barcodes as not_found without throwing', async () => {
    mockGetProductFields
      .mockResolvedValueOnce({
        product_name: 'Nutella',
        nutriscore_grade: 'e',
        ecoscore_grade: 'c',
        completeness: 0.85,
        nutriments: { 'energy-kcal_100g': 539 },
      })
      .mockResolvedValueOnce(null); // not found

    const result = await offCompareProductsTool.handler(
      { barcodes: ['3017620422003', '0000000000000'] },
      ctx,
    );

    expect(result.succeeded).toBe(1);
    expect(result.not_found).toContain('0000000000000');
    expect(result.products.find((p) => p.barcode === '0000000000000')?.found).toBe(false);
  });

  it('handles sparse upstream payload per product', async () => {
    // Product with no nutriments or scores
    mockGetProductFields
      .mockResolvedValueOnce({ product_name: 'Sparse A' })
      .mockResolvedValueOnce({ product_name: 'Sparse B', nutriscore_grade: 'b' });

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '2222222222222'] },
      ctx,
    );

    expect(result.succeeded).toBe(2);
    expect(result.products[0]?.nutriscore_grade).toBeUndefined();
    expect(result.products[1]?.nutriscore_grade).toBe('b');
  });

  it('formats comparison table with nutriscore, ecoscore, and completeness columns', () => {
    const output = {
      products: [
        {
          barcode: '3017620422003',
          product_name: 'Nutella',
          brands: 'Ferrero',
          found: true,
          nutriscore_grade: 'e',
          nova_group: 4,
          ecoscore_grade: 'c',
          completeness: 0.85,
          energy_kcal_100g: 539,
          fat_100g: 30.9,
          sugars_100g: 56.3,
        },
        {
          barcode: '7622210100146',
          product_name: 'Peanut Butter',
          found: true,
          nutriscore_grade: 'c',
          ecoscore_grade: 'b',
          completeness: 0.72,
          energy_kcal_100g: 580,
        },
      ],
      succeeded: 2,
      not_found: [],
    };
    const blocks = offCompareProductsTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks[0].text;
    expect(text).toContain('Nutella');
    expect(text).toContain('Peanut Butter');
    // nutriscore_grade values (not uppercased)
    expect(text).toContain('e');
    expect(text).toContain('c');
    // ecoscore_grade values
    expect(text).toContain('b');
    // completeness column present
    expect(text).toContain('85%');
    // nutrition values
    expect(text).toContain('539');
  });

  it('formats result with not_found barcodes listed', () => {
    const output = {
      products: [
        { barcode: '0000000000000', found: false },
        { barcode: '1111111111111', found: false },
      ],
      succeeded: 0,
      not_found: ['0000000000000', '1111111111111'],
    };
    const blocks = offCompareProductsTool.format!(output);
    const text = blocks[0].text;
    expect(text).toContain('0000000000000');
    expect(text.toLowerCase()).toContain('not found');
  });

  // ── mixed found + not-found barcodes ──────────────────────────────────────

  it('correctly separates found and not_found in a mixed batch', async () => {
    // Design: "When 3 of 5 barcodes resolve and 2 are not found, the caller gets a comparison
    // table for the 3 found products plus a not_found list."
    mockGetProductFields
      .mockResolvedValueOnce({ product_name: 'Product A', nutriscore_grade: 'a', nutriments: {} })
      .mockResolvedValueOnce(null) // not found
      .mockResolvedValueOnce({ product_name: 'Product C', nutriscore_grade: 'c', nutriments: {} })
      .mockResolvedValueOnce(null) // not found
      .mockResolvedValueOnce({ product_name: 'Product E', nutriscore_grade: 'b', nutriments: {} });

    const result = await offCompareProductsTool.handler(
      {
        barcodes: [
          '1111111111111',
          '2222222222222',
          '3333333333333',
          '4444444444444',
          '5555555555555',
        ],
      },
      ctx,
    );

    expect(result.succeeded).toBe(3);
    expect(result.not_found).toHaveLength(2);
    expect(result.not_found).toContain('2222222222222');
    expect(result.not_found).toContain('4444444444444');
    expect(result.products).toHaveLength(5); // all rows present, found or not

    // Products preserve input order
    expect(result.products[0]?.product_name).toBe('Product A');
    expect(result.products[0]?.found).toBe(true);
    expect(result.products[1]?.found).toBe(false);
    expect(result.products[2]?.product_name).toBe('Product C');
    expect(result.products[3]?.found).toBe(false);
    expect(result.products[4]?.product_name).toBe('Product E');
  });

  it('not_found barcodes in the output have found=false and no nutrition fields', async () => {
    // Design: comparison rows for not-found products have {barcode, found: false} — no fabricated
    // nutrition zeros or undefined scores.
    mockGetProductFields
      .mockResolvedValueOnce({
        product_name: 'Found Product',
        nutriscore_grade: 'b',
        nutriments: { 'energy-kcal_100g': 300 },
      })
      .mockResolvedValueOnce(null);

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '9999999999999'] },
      ctx,
    );

    const notFoundRow = result.products.find((p) => p.barcode === '9999999999999');
    expect(notFoundRow?.found).toBe(false);
    expect(notFoundRow?.product_name).toBeUndefined();
    expect(notFoundRow?.nutriscore_grade).toBeUndefined();
    expect(notFoundRow?.energy_kcal_100g).toBeUndefined();
    expect(notFoundRow?.fat_100g).toBeUndefined();
  });

  // ── upstream_error propagation ────────────────────────────────────────────

  it('throws upstream error (serviceUnavailable) when a product fetch fails with an OFF error', async () => {
    // Design: "Upstream 5xx → serviceUnavailable() factory." When a rejected settlement contains
    // an Open Food Facts error, the handler should propagate it.
    mockGetProductFields
      .mockResolvedValueOnce({ product_name: 'Good Product', nutriments: {} })
      .mockRejectedValueOnce(new Error('Open Food Facts API error: HTTP 503'));

    await expect(
      offCompareProductsTool.handler({ barcodes: ['1111111111111', '2222222222222'] }, ctx),
    ).rejects.toThrow('Open Food Facts');
  });

  it('treats a non-OFF rejection as a not_found row rather than throwing', async () => {
    // Design: rejected settlements that aren't explicit OFF errors get folded into not_found.
    // The current handler checks err.message?.includes('Open Food Facts') — other errors are
    // treated as not-found silently.
    mockGetProductFields
      .mockResolvedValueOnce({ product_name: 'Good Product', nutriments: {} })
      .mockRejectedValueOnce(new Error('Network timeout'));

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '2222222222222'] },
      ctx,
    );

    expect(result.succeeded).toBe(1);
    expect(result.not_found).toContain('2222222222222');
  });

  // ── sparsity: missing nutrition fields ≠ zero ────────────────────────────

  it('preserves null nutrition fields without fabricating zeros for found products', async () => {
    // Design: "Missing nutrition data for any product is preserved as absent — comparisons are
    // not imputed."
    mockGetProductFields
      .mockResolvedValueOnce({
        product_name: 'No Nutrition',
        nutriscore_grade: 'c',
        // nutriments omitted — contributor hasn't entered them
      })
      .mockResolvedValueOnce({
        product_name: 'Has Nutrition',
        nutriscore_grade: 'a',
        nutriments: { 'energy-kcal_100g': 50, proteins_100g: 5 },
      });

    const result = await offCompareProductsTool.handler(
      { barcodes: ['1111111111111', '2222222222222'] },
      ctx,
    );

    const noNutrition = result.products[0];
    expect(noNutrition?.found).toBe(true);
    expect(noNutrition?.energy_kcal_100g).toBeUndefined();
    expect(noNutrition?.fat_100g).toBeUndefined();
    expect(noNutrition?.proteins_100g).toBeUndefined();

    const hasNutrition = result.products[1];
    expect(hasNutrition?.energy_kcal_100g).toBe(50);
    expect(hasNutrition?.proteins_100g).toBe(5);
  });

  it('formats mixed found/not-found comparison with "N/A" for absent nutrition', () => {
    // format() must render "N/A" for absent nutrition values, not "undefined" or zero
    const output = {
      products: [
        {
          barcode: '1111111111111',
          product_name: 'Found, No Nutrition',
          found: true,
          nutriscore_grade: 'c',
          // all nutrition fields absent
        },
        {
          barcode: '2222222222222',
          found: false,
        },
      ],
      succeeded: 1,
      not_found: ['2222222222222'],
    };
    const blocks = offCompareProductsTool.format!(output);
    const text = blocks[0].text;
    expect(text).toContain('N/A'); // absent nutrition rendered as N/A
    expect(text).not.toContain('undefined');
    expect(text).toContain('2222222222222'); // not_found barcode surfaced
  });
});
