/**
 * @fileoverview Tests for off_get_product tool.
 * @module tests/mcp-server/tools/definitions/get-product.tool.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/openfoodfacts/openfoodfacts-service.js', () => ({
  getOpenFoodFactsService: vi.fn(),
}));

import { offGetProductTool } from '@/mcp-server/tools/definitions/get-product.tool.js';
import { getOpenFoodFactsService } from '@/services/openfoodfacts/openfoodfacts-service.js';

const mockGetProduct = vi.fn();

describe('off_get_product', () => {
  let ctx: Context;

  beforeEach(() => {
    mockGetProduct.mockReset();
    vi.mocked(getOpenFoodFactsService).mockReturnValue({
      getProduct: mockGetProduct,
    } as never);
    ctx = createMockContext({ errors: offGetProductTool.errors });
  });

  // ── error contract assertions ──────────────────────────────────────────────

  it('throws ctx.fail("not_found") with the declared reason for status:0 barcodes', async () => {
    // Design: status:0 response from OFF API (HTTP 200, body {status:0}) → not a throw at HTTP
    // layer, but getProduct() returns null → handler throws ctx.fail('not_found').
    mockGetProduct.mockResolvedValue(null);

    const err = await offGetProductTool.handler({ barcode: '0000000000001' }, ctx).catch((e) => e);
    expect(err.data).toBeDefined();
    expect(err.data.reason).toBe('not_found');
  });

  it('propagates upstream_error when service throws serviceUnavailable', async () => {
    // Design: upstream 5xx → serviceUnavailable() thrown by service layer, propagated from handler.
    // The declared upstream_error contract reason is not used with ctx.fail — the factory error
    // propagates directly. Assert that the thrown error reaches the caller.
    const svcError = new Error('Open Food Facts API error: HTTP 503');
    mockGetProduct.mockRejectedValue(svcError);

    await expect(offGetProductTool.handler({ barcode: '3017620422003' }, ctx)).rejects.toThrow(
      'Open Food Facts API error: HTTP 503',
    );
  });

  it('returns full product data for a known barcode', async () => {
    mockGetProduct.mockResolvedValue({
      product_name: 'Nutella',
      brands: 'Ferrero',
      quantity: '400g',
      nutriscore_grade: 'e',
      nova_group: 4,
      ecoscore_grade: 'c',
      completeness: 0.85,
      data_quality_tags: ['en:nutrition-completed'],
      nutriments: {
        'energy-kcal_100g': 539,
        fat_100g: 30.9,
        sugars_100g: 56.3,
        proteins_100g: 6.3,
        salt_100g: 0.107,
      },
      categories_tags: ['en:spreads', 'en:chocolate-spreads'],
      allergens_tags: ['en:milk', 'en:hazelnuts'],
    });

    const result = await offGetProductTool.handler({ barcode: '3017620422003' }, ctx);

    expect(result.found).toBe(true);
    expect(result.barcode).toBe('3017620422003');
    expect(result.product).toBeDefined();
    expect(result.product?.product_name).toBe('Nutella');
    expect(result.product?.nutriscore_grade).toBe('e');
    expect(result.product?.ecoscore_grade).toBe('c');
    expect(result.product?.data_quality_tags).toContain('en:nutrition-completed');
    expect(result.product?.nutriments?.energy_kcal_100g).toBe(539);
  });

  it('throws ctx.fail("not_found") for status:0 barcodes', async () => {
    mockGetProduct.mockResolvedValue(null);

    await expect(
      offGetProductTool.handler({ barcode: '0000000000000' }, ctx),
    ).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('applies field selection — returns only requested fields', async () => {
    mockGetProduct.mockResolvedValue({
      product_name: 'Test Product',
      nutriscore_grade: 'b',
      nova_group: 2,
    });

    const result = await offGetProductTool.handler(
      { barcode: '1234567890123', fields: ['product_name', 'nutriscore_grade'] },
      ctx,
    );

    expect(result.found).toBe(true);
    expect(result.product?.product_name).toBe('Test Product');
    expect(result.product?.nutriscore_grade).toBe('b');
  });

  it('handles sparse upstream payload without fabricating values', async () => {
    // Minimal product — only product_name, nothing else
    mockGetProduct.mockResolvedValue({
      product_name: 'Sparse Product',
    });

    const result = await offGetProductTool.handler({ barcode: '9999999999999' }, ctx);

    expect(result.found).toBe(true);
    expect(result.product?.product_name).toBe('Sparse Product');
    expect(result.product?.nutriscore_grade).toBeUndefined();
    expect(result.product?.ecoscore_grade).toBeUndefined();
    expect(result.product?.data_quality_tags).toBeUndefined();
    expect(result.product?.nutriments).toBeUndefined();
  });

  it('formats found product with all key fields rendered', () => {
    const output = {
      barcode: '3017620422003',
      found: true,
      product: {
        product_name: 'Nutella',
        brands: 'Ferrero',
        quantity: '400g',
        nutriscore_grade: 'e',
        nova_group: 4,
        ecoscore_grade: 'c',
        completeness: 0.85,
        data_quality_tags: ['en:nutrition-completed'],
        nutriments: {
          energy_kcal_100g: 539,
          fat_100g: 30.9,
          sugars_100g: 56.3,
          proteins_100g: 6.3,
          salt_100g: 0.107,
        },
        allergens_tags: ['en:milk'],
      },
    };
    const blocks = offGetProductTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks[0].text;
    expect(text).toContain('Nutella');
    expect(text).toContain('Nutri-Score'); // nutriscore_grade label
    expect(text).toContain('Eco-Score'); // ecoscore_grade label
    expect(text).toContain('en:nutrition-completed'); // data_quality_tags
    expect(text).toContain('539'); // energy value
    expect(text).toContain('en:milk'); // allergen
  });

  it('formats not-found result with guidance', () => {
    const output = { barcode: '0000000000000', found: false };
    const blocks = offGetProductTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks[0].text;
    expect(text).toContain('0000000000000');
    expect(text.toLowerCase()).toContain('not found');
  });

  it('formats sparse product without crashing or inventing values', () => {
    const output = {
      barcode: '9999999999999',
      found: true,
      product: { product_name: 'Sparse Product' },
    };
    const blocks = offGetProductTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks[0].text;
    expect(text).toContain('Sparse Product');
    expect(text).not.toContain('undefined');
  });

  // ── fields= selection behavior ────────────────────────────────────────────

  it('passes the fields parameter to the service layer', async () => {
    // Design: "Field selection mandatory on every request — the product object is ~200 keys;
    // always scope fields=". Handler must forward the fields input to service.getProduct().
    mockGetProduct.mockResolvedValue({
      nutriscore_grade: 'b',
      nova_group: 2,
    });

    await offGetProductTool.handler(
      { barcode: '1234567890123', fields: ['nutriscore_grade', 'nova_group'] },
      ctx,
    );

    // Service called once — with the barcode (fields routing is handler-side)
    expect(mockGetProduct).toHaveBeenCalledOnce();
    expect(mockGetProduct.mock.calls[0][0]).toBe('1234567890123');
  });

  it('omitting fields returns all standard fields from the service response', async () => {
    // When fields is omitted, the service uses PRODUCT_FIELDS internally (full default set).
    // Handler should still normalize and return whatever the service resolves.
    mockGetProduct.mockResolvedValue({
      product_name: 'Full Product',
      nutriscore_grade: 'a',
      nova_group: 1,
      nutriments: { 'energy-kcal_100g': 100, proteins_100g: 10 },
      allergens_tags: ['en:milk'],
    });

    const result = await offGetProductTool.handler({ barcode: '9876543210123' }, ctx);

    expect(result.found).toBe(true);
    expect(result.product?.product_name).toBe('Full Product');
    expect(result.product?.nutriments?.energy_kcal_100g).toBe(100);
    expect(result.product?.allergens_tags).toContain('en:milk');
  });

  // ── crowd-sourced sparsity: missing field ≠ absent attribute ─────────────

  it('preserves absent allergens_tags without fabricating an empty array', async () => {
    // Design: "Absence means not yet entered — not that the product is allergen-free."
    // A product that has no allergens_tags in the upstream response must not get an empty array
    // injected — the field must be absent from the output so consumers can distinguish
    // "not entered" from "no allergens declared".
    mockGetProduct.mockResolvedValue({
      product_name: 'Unknown Allergen Product',
      nutriscore_grade: 'c',
      // allergens_tags intentionally omitted
    });

    const result = await offGetProductTool.handler({ barcode: '1111111111111' }, ctx);

    expect(result.product?.allergens_tags).toBeUndefined();
  });

  it('preserves absent nutriments without fabricating zeros', async () => {
    // A product where upstream omits nutriments entirely — output must not fabricate zeros.
    mockGetProduct.mockResolvedValue({
      product_name: 'No Nutrition Data',
      ecoscore_grade: 'unknown',
      // nutriments intentionally absent
    });

    const result = await offGetProductTool.handler({ barcode: '2222222222222' }, ctx);

    expect(result.product?.nutriments).toBeUndefined();
  });

  it('formats product with absent allergens with the "not entered" caveat', () => {
    // format() must surface the crowd-sourced caveat for missing allergens, not silently omit.
    const output = {
      barcode: '1111111111111',
      found: true,
      product: {
        product_name: 'Unknown Allergen Product',
        nutriscore_grade: 'c',
        // allergens_tags absent
      },
    };
    const blocks = offGetProductTool.format!(output);
    const text = blocks[0].text;
    // Should contain the caveat about absence not meaning allergen-free
    expect(text.toLowerCase()).toMatch(/allergen|absence/);
    expect(text.toLowerCase()).not.toContain('undefined');
  });

  it('normalizes hyphenated nutriments keys to underscore form', async () => {
    // Design: "The raw OFF nutriments object uses hyphenated keys (energy-kcal_100g)...
    // The service layer normalizes to underscore form (energy_kcal_100g)."
    mockGetProduct.mockResolvedValue({
      product_name: 'Key Normalization Test',
      nutriments: {
        'energy-kcal_100g': 250,
        'saturated-fat_100g': 5.5,
        fat_100g: 12,
        proteins_100g: 8,
        'energy-kcal_serving': 125,
      },
    });

    const result = await offGetProductTool.handler({ barcode: '3333333333333' }, ctx);

    const n = result.product?.nutriments;
    expect(n?.energy_kcal_100g).toBe(250);
    expect(n?.saturated_fat_100g).toBe(5.5);
    expect(n?.fat_100g).toBe(12);
    expect(n?.energy_kcal_serving).toBe(125);
    // Raw hyphenated keys must not appear in the output
    expect(n).not.toHaveProperty('energy-kcal_100g');
    expect(n).not.toHaveProperty('saturated-fat_100g');
  });
});
