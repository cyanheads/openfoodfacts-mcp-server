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
const mockGetProductFields = vi.fn();

describe('off_get_product', () => {
  let ctx: Context;

  beforeEach(() => {
    mockGetProduct.mockReset();
    mockGetProductFields.mockReset();
    vi.mocked(getOpenFoodFactsService).mockReturnValue({
      getProduct: mockGetProduct,
      getProductFields: mockGetProductFields,
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

  it('applies field selection — calls getProductFields with the joined field list', async () => {
    // Bug #1 regression: when fields= is provided, handler must call getProductFields() not getProduct().
    // Previously the fields input was accepted but silently ignored (getProduct() was called instead).
    mockGetProductFields.mockResolvedValue({
      product_name: 'Test Product',
      nutriscore_grade: 'b',
      nova_group: 2,
    });

    const result = await offGetProductTool.handler(
      { barcode: '1234567890123', fields: ['product_name', 'nutriscore_grade'] },
      ctx,
    );

    expect(result.product?.product_name).toBe('Test Product');
    expect(result.product?.nutriscore_grade).toBe('b');
    // getProductFields must have been called, not getProduct
    expect(mockGetProductFields).toHaveBeenCalledOnce();
    expect(mockGetProduct).not.toHaveBeenCalled();
    expect(mockGetProductFields.mock.calls[0]?.[1]).toBe('product_name,nutriscore_grade');
  });

  it('handles sparse upstream payload without fabricating values', async () => {
    // Minimal product — only product_name, nothing else
    mockGetProduct.mockResolvedValue({
      product_name: 'Sparse Product',
    });

    const result = await offGetProductTool.handler({ barcode: '9999999999999' }, ctx);

    expect(result.product?.product_name).toBe('Sparse Product');
    expect(result.product?.nutriscore_grade).toBeUndefined();
    expect(result.product?.ecoscore_grade).toBeUndefined();
    expect(result.product?.data_quality_tags).toBeUndefined();
    expect(result.product?.nutriments).toBeUndefined();
  });

  it('formats found product with all key fields rendered', () => {
    const output = {
      barcode: '3017620422003',
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

  // ── #20: not-found is the error path, never an output shape ────────────────

  it('advertises no `found` field and makes `product` required', () => {
    // #20 regression: the schema used to advertise `found: false` with an optional `product`,
    // a state the handler could never produce — it throws not_found before building any output.
    // A caller branching on `found === false` therefore never handled the path that actually
    // fires. The shape is the assertion: no `found` key, and `product` not optional.
    const shape = offGetProductTool.output.shape;
    expect(Object.keys(shape)).not.toContain('found');
    expect(shape.product.safeParse(undefined).success).toBe(false);
  });

  it('never returns a not-found result object — the handler throws instead', async () => {
    // #20 regression: both call shapes (full fetch and fields-subset) resolve status:0 to null in
    // the service and throw before buildProductOutput() runs, so no `found: false` object exists.
    mockGetProduct.mockResolvedValue(null);
    mockGetProductFields.mockResolvedValue(null);

    await expect(
      offGetProductTool.handler({ barcode: '8462719305174' }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
    await expect(
      offGetProductTool.handler({ barcode: '8462719305174', fields: ['product_name'] }, ctx),
    ).rejects.toMatchObject({ data: { reason: 'not_found' } });
  });

  it('formats sparse product without crashing or inventing values', () => {
    const output = {
      barcode: '9999999999999',
      product: { product_name: 'Sparse Product' },
    };
    const blocks = offGetProductTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = blocks[0].text;
    expect(text).toContain('Sparse Product');
    expect(text).not.toContain('undefined');
  });

  // ── fields= selection behavior ────────────────────────────────────────────

  it('passes the fields parameter to getProductFields, not getProduct', async () => {
    // Bug #1 regression: fields= input must route to getProductFields() with the field list.
    // Before the fix, the handler always called getProduct() regardless of input.fields.
    mockGetProductFields.mockResolvedValue({
      nutriscore_grade: 'b',
      nova_group: 2,
    });

    await offGetProductTool.handler(
      { barcode: '1234567890123', fields: ['nutriscore_grade', 'nova_group'] },
      ctx,
    );

    expect(mockGetProductFields).toHaveBeenCalledOnce();
    expect(mockGetProductFields.mock.calls[0]?.[0]).toBe('1234567890123');
    expect(mockGetProductFields.mock.calls[0]?.[1]).toBe('nutriscore_grade,nova_group');
    expect(mockGetProduct).not.toHaveBeenCalled();
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

    expect(result.product?.product_name).toBe('Full Product');
    expect(result.product?.nutriments?.energy_kcal_100g).toBe(100);
    expect(result.product?.allergens_tags).toContain('en:milk');
  });

  // ── requested_fields discriminator: "omitted" ≠ "missing upstream" (Bug #5) ─

  it('carries requested_fields mirroring input.fields for a subset request', async () => {
    // Bug #5: without threading the requested subset into the output, format() cannot tell
    // "not requested" from "missing upstream." The handler must surface input.fields.
    mockGetProductFields.mockResolvedValue({
      product_name: 'Nutella',
      brands: 'Ferrero',
      nutriscore_grade: 'e',
    });

    const result = await offGetProductTool.handler(
      { barcode: '3017620422003', fields: ['product_name', 'brands', 'nutriscore_grade'] },
      ctx,
    );

    expect(result.requested_fields).toEqual(['product_name', 'brands', 'nutriscore_grade']);
  });

  it('omits requested_fields for a full request (no fields subset)', async () => {
    mockGetProduct.mockResolvedValue({ product_name: 'Nutella', nutriscore_grade: 'e' });

    const result = await offGetProductTool.handler({ barcode: '3017620422003' }, ctx);

    expect(result.requested_fields).toBeUndefined();
  });

  it('format() marks omitted sections as "Not requested" for a field-subset result', () => {
    // Bug #5: for a subset call, omitted sections must not read as "Not available"/"Not entered"
    // — that conflates "not requested" with "OFF has no data."
    const output = {
      barcode: '3017620422003',
      product: {
        product_name: 'Nutella',
        brands: 'Ferrero, Nutella, Yum yum',
        nutriscore_grade: 'e',
      },
      requested_fields: ['product_name', 'brands', 'nutriscore_grade'],
    };

    const blocks = offGetProductTool.format!(output);
    const text = blocks[0].text;

    // The requested subset is disclosed up front, carrying the field names.
    expect(text).toContain('Requested fields:');
    expect(text).toContain('product_name');
    // Omitted sections read as "Not requested", not as missing upstream data.
    expect(text).toContain('**Nutrition:** Not requested');
    expect(text).toContain('**Ingredients:** Not requested');
    expect(text).toContain('**Allergens:** Not requested');
    // Must not imply Open Food Facts lacks the un-requested data.
    expect(text).not.toContain('Not available');
    expect(text).not.toContain('does not mean allergen-free');
  });

  it('format() still renders "Not available"/"Not entered" for genuinely-missing fields on a full request', () => {
    // Sparse upstream payload on a FULL request (no fields subset): the honest missing-data
    // rendering must be preserved — these fields really are absent from Open Food Facts.
    const output = {
      barcode: '0000000000000',
      product: { product_name: 'Bare Product', nutriscore_grade: 'd' },
      // requested_fields absent → full request
    };

    const blocks = offGetProductTool.format!(output);
    const text = blocks[0].text;

    expect(text).toContain('**Nutrition:** Not available');
    expect(text).toContain('**Ingredients:** Not available');
    expect(text).toContain('**Allergens:** Not entered');
    // No subset was requested, so nothing is "Not requested".
    expect(text).not.toContain('Not requested');
    expect(text).not.toContain('Requested fields:');
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

  // ── #16: per-serving figures carry their denominator ───────────────────────

  it('threads serving size through to the output', async () => {
    // #16 regression: per-serving nutrition used to be returned with no serving size, so 160 kcal
    // had no denominator. Values mirror barcode 0028400157827 as the live API returns it.
    mockGetProduct.mockResolvedValue({
      product_name: 'Cheetos Jalapeno & Cheddar',
      serving_size: '28 g',
      serving_quantity: 28,
      serving_quantity_unit: 'g',
      nutriments: { 'energy-kcal_serving': 160, fat_serving: 10, sugars_serving: 1 },
    });

    const result = await offGetProductTool.handler({ barcode: '0028400157827' }, ctx);

    expect(result.product?.serving_size).toBe('28 g');
    expect(result.product?.serving_quantity).toBe(28);
    expect(result.product?.serving_quantity_unit).toBe('g');
  });

  it('coerces a string serving_quantity to a number', async () => {
    // Open Food Facts is inconsistent about this field's JSON type — live-verified as the string
    // "28" on barcode 0028400157827 and the number 39 on 0016000275287. A typeof-number test would
    // silently drop the value for every product on the string side, including #16's own repro.
    mockGetProduct.mockResolvedValue({
      product_name: 'String Quantity Product',
      serving_size: '28 g',
      serving_quantity: '28',
      serving_quantity_unit: 'g',
    });

    const result = await offGetProductTool.handler({ barcode: '0028400157827' }, ctx);

    expect(result.product?.serving_quantity).toBe(28);
  });

  it('drops a serving_quantity_unit that has no quantity to describe', async () => {
    // Live-verified on barcode 3017620422003: Open Food Facts returns serving_quantity_unit "g"
    // with no serving_size and no serving_quantity. Passing the bare unit through would put a
    // value in structuredContent that format() has nothing to render — the same surface mismatch
    // #9 is about, arriving from the opposite direction.
    mockGetProduct.mockResolvedValue({
      product_name: 'Nutella',
      serving_quantity_unit: 'g',
    });

    const result = await offGetProductTool.handler({ barcode: '3017620422003' }, ctx);

    expect(result.product?.serving_quantity_unit).toBeUndefined();
    const text = offGetProductTool.format!(result)[0].text;
    expect(text).not.toContain('**Serving size:**');
  });

  it('omits serving_quantity when upstream sends an unparseable value', async () => {
    mockGetProduct.mockResolvedValue({
      product_name: 'Bad Quantity Product',
      serving_quantity: 'one scoop',
    });

    const result = await offGetProductTool.handler({ barcode: '4444444444444' }, ctx);

    expect(result.product?.serving_quantity).toBeUndefined();
  });

  it('requests serving fields from the upstream field subset when asked', async () => {
    mockGetProductFields.mockResolvedValue({ serving_size: '39g', serving_quantity: 39 });

    await offGetProductTool.handler(
      { barcode: '0016000275287', fields: ['serving_size', 'serving_quantity'] },
      ctx,
    );

    expect(mockGetProductFields.mock.calls[0]?.[1]).toBe('serving_size,serving_quantity');
  });

  it('format() states the serving size as the denominator of the per-serving section', () => {
    const output = {
      barcode: '0049000042566',
      product: {
        product_name: 'Coca-Cola Zero Sugar',
        serving_size: '1 can (12 fl oz)',
        serving_quantity: 354.882,
        serving_quantity_unit: 'ml',
        nutriments: { energy_kcal_serving: 0 },
      },
    };
    const text = offGetProductTool.format!(output)[0].text;

    expect(text).toContain('### Nutrition per serving (per 1 can (12 fl oz))');
    // The parsed quantity is unusable without its unit — this product's 354.882 is millilitres.
    expect(text).toContain('354.882 ml');
  });

  it('format() says so when per-serving figures have no recorded serving size', () => {
    // Live-verified on barcode 3017620422003, which carries per-serving data and the upstream
    // data-quality flag en:nutrition-data-per-serving-missing-serving-size with no serving_size.
    const output = {
      barcode: '3017620422003',
      product: {
        product_name: 'Nutella',
        nutriments: { energy_kcal_serving: 80 },
      },
    };
    const text = offGetProductTool.format!(output)[0].text;

    expect(text).toContain('### Nutrition per serving');
    expect(text).toContain('Serving size not recorded');
    // The heading must not imply a denominator that does not exist.
    expect(text).not.toContain('per undefined');
  });

  // ── #17: nutriment coverage beyond the named subset ───────────────────────

  it('surfaces nutrients outside the named subset with their upstream units', async () => {
    // #17 regression: everything outside the fixed 12-key map used to be dropped from both output
    // surfaces. Keys and units mirror barcode 0028400157827 as the live API returns them.
    mockGetProduct.mockResolvedValue({
      product_name: 'Cheetos Jalapeno & Cheddar',
      nutriments: {
        'energy-kcal_100g': 571,
        calcium_100g: 0.071,
        calcium_unit: 'g',
        iron_100g: 0.00129,
        iron_unit: 'g',
        'trans-fat_100g': 0,
        'trans-fat_unit': 'g',
        'vitamin-a_100g': 0.0001071,
        'vitamin-a_unit': 'g',
        folates_100g: 0.000086,
        folates_unit: 'g',
        energy_100g: 2389,
        energy_unit: 'kJ',
      },
    });

    const result = await offGetProductTool.handler({ barcode: '0028400157827' }, ctx);
    const additional = result.product?.nutriments?.additional_100g;

    expect(additional?.calcium).toEqual({ value: 0.071, unit: 'g' });
    expect(additional?.iron).toEqual({ value: 0.00129, unit: 'g' });
    // Hyphenated upstream keys normalize to underscores, matching the named fields' convention.
    expect(additional?.trans_fat).toEqual({ value: 0, unit: 'g' });
    expect(additional?.vitamin_a).toEqual({ value: 0.0001071, unit: 'g' });
    // folates and the raw kJ energy figure are dropped by the fixed map and by #17's own table.
    expect(additional?.folates).toEqual({ value: 0.000086, unit: 'g' });
    // Units are carried, never assumed to be grams — this one is kilojoules.
    expect(additional?.energy).toEqual({ value: 2389, unit: 'kJ' });
  });

  it('never double-reports a nutrient that already has a named field', async () => {
    mockGetProduct.mockResolvedValue({
      product_name: 'Collision Test',
      nutriments: {
        'saturated-fat_100g': 5.36,
        'saturated-fat_unit': 'g',
        fat_100g: 35.71,
        calcium_100g: 0.071,
        calcium_unit: 'g',
      },
    });

    const result = await offGetProductTool.handler({ barcode: '5555555555555' }, ctx);
    const n = result.product?.nutriments;

    expect(n?.saturated_fat_100g).toBe(5.36);
    expect(n?.fat_100g).toBe(35.71);
    // Named keys must not reappear in the open map under their normalized name.
    expect(n?.additional_100g).not.toHaveProperty('saturated_fat');
    expect(n?.additional_100g).not.toHaveProperty('fat');
    expect(n?.additional_100g?.calcium).toEqual({ value: 0.071, unit: 'g' });
  });

  it('excludes nova-group from the nutrient maps', async () => {
    // Open Food Facts stores the NOVA processing class inside the nutriments map (live-verified:
    // nova-group_100g / nova-group_serving with an empty nova-group_unit). It is not a nutrient
    // and is already surfaced as the typed nova_group field, so passing it through would report
    // the same classification twice — once as a score, once as a unitless "nutrient".
    mockGetProduct.mockResolvedValue({
      product_name: 'NOVA Test',
      nova_group: 4,
      nutriments: {
        'nova-group_100g': 4,
        'nova-group_serving': 4,
        'nova-group_unit': '',
        calcium_100g: 0.071,
      },
    });

    const result = await offGetProductTool.handler({ barcode: '6666666666666' }, ctx);

    expect(result.product?.nova_group).toBe(4);
    expect(result.product?.nutriments?.additional_100g).not.toHaveProperty('nova_group');
    expect(result.product?.nutriments?.additional_serving).toBeUndefined();
  });

  it('carries per-serving macros that have a named per-100g field but no named per-serving one', async () => {
    // The named set is asymmetric: saturated-fat has a named _100g field but no _serving one.
    // Excluding by base nutrient name rather than by exact key would drop these figures entirely.
    mockGetProduct.mockResolvedValue({
      product_name: 'Asymmetric Serving Test',
      nutriments: {
        'saturated-fat_100g': 5.36,
        'saturated-fat_serving': 1.5,
        'saturated-fat_unit': 'g',
        sugars_serving: 1,
      },
    });

    const result = await offGetProductTool.handler({ barcode: '7777777777777' }, ctx);
    const n = result.product?.nutriments;

    expect(n?.sugars_serving).toBe(1);
    expect(n?.additional_serving?.saturated_fat).toEqual({ value: 1.5, unit: 'g' });
    expect(n?.additional_serving).not.toHaveProperty('sugars');
  });

  it('omits the unit when upstream records none', async () => {
    // Live-verified on barcode 3017620422003: the fruits-vegetables estimates have no _unit
    // sibling, and nova-group's is an empty string.
    mockGetProduct.mockResolvedValue({
      product_name: 'Unitless Test',
      nutriments: { 'fruits-vegetables-nuts-estimate-from-ingredients_100g': 13 },
    });

    const result = await offGetProductTool.handler({ barcode: '8888888888888' }, ctx);
    const entry =
      result.product?.nutriments?.additional_100g?.fruits_vegetables_nuts_estimate_from_ingredients;

    expect(entry).toEqual({ value: 13 });
    expect(entry).not.toHaveProperty('unit');
  });

  it('format() renders the additional nutrients on both per-100g and per-serving', () => {
    const output = {
      barcode: '0028400157827',
      product: {
        product_name: 'Cheetos',
        nutriments: {
          energy_kcal_100g: 571,
          additional_100g: {
            calcium: { value: 0.071, unit: 'g' },
            energy: { value: 2389, unit: 'kJ' },
          },
          additional_serving: { calcium: { value: 0.0199, unit: 'g' } },
        },
        serving_size: '28 g',
      },
    };
    const text = offGetProductTool.format!(output)[0].text;

    expect(text).toContain('calcium: 0.071 g');
    expect(text).toContain('energy: 2389 kJ');
    expect(text).toContain('calcium: 0.0199 g');
  });

  // ── #9: content[] must carry the same arrays as structuredContent ──────────

  it('format() renders every parsed ingredient, not the first 20', () => {
    // #9 regression: format() sliced the list at 20 while structuredContent carried all of them,
    // so text-only clients silently lost ingredients. Barcode 5202336064700 has 23 (live-verified).
    const ingredients = Array.from({ length: 23 }, (_, i) => ({ text: `ingredient-${i + 1}` }));
    const output = { barcode: '5202336064700', product: { product_name: 'Parity', ingredients } };

    const text = offGetProductTool.format!(output)[0].text;

    for (const ing of ingredients) expect(text).toContain(ing.text);
    expect(text).not.toContain('more ingredients');
  });

  it('format() renders every category tag, not the first 5', () => {
    // Barcode 5202336064700 carries 6 category tags (live-verified); the 6th used to be dropped.
    const categories_tags = [
      'en:snacks',
      'en:sweet-snacks',
      'en:biscuits-and-cakes',
      'en:biscuits',
      'en:chocolate-biscuits',
      'en:filled-biscuits',
    ];
    const output = {
      barcode: '5202336064700',
      product: { product_name: 'Parity', categories_tags },
    };

    const text = offGetProductTool.format!(output)[0].text;

    for (const tag of categories_tags) expect(text).toContain(tag);
  });

  it('format() renders vegan/vegetarian "maybe" instead of dropping it', () => {
    // #9 regression: "maybe" was filtered out, so a real Open Food Facts verdict ("depends on
    // sourcing") rendered identically to no verdict at all. Barcode 5202336064700 has one of each.
    const output = {
      barcode: '5202336064700',
      product: {
        product_name: 'Maybe Test',
        ingredients: [
          { text: 'sugar', vegan: 'yes', vegetarian: 'yes' },
          { text: 'emulsifier', vegan: 'maybe', vegetarian: 'maybe' },
        ],
      },
    };
    const text = offGetProductTool.format!(output)[0].text;

    expect(text).toContain('vegan: maybe');
    expect(text).toContain('vegetarian: maybe');
  });

  it('format() renders the exact completeness scalar alongside the rounded percentage', () => {
    // #9 regression: only "79%" was rendered, and 0.7875 is not recoverable from it — re-calling
    // returns the same rounded string, so a text-only client could never reach the exact value.
    const output = {
      barcode: '5202336064700',
      product: { product_name: 'Completeness', completeness: 0.7875 },
    };
    const text = offGetProductTool.format!(output)[0].text;

    expect(text).toContain('79%');
    expect(text).toContain('0.7875');
  });

  it('format() renders percent_estimate at full precision, not rounded to one decimal', () => {
    // #9 regression: toFixed(1) turned 56.85 into "56.9" and 9.375 into "9.4" while
    // structuredContent carried the exact figures (live values from barcodes 0049000042566 and
    // 0028400157827). Re-calling returns the same rounded text, so the precision was unreachable
    // from a text-only client — the same loss the completeness percentage had.
    const output = {
      barcode: '0049000042566',
      product: {
        product_name: 'Precision',
        ingredients: [
          { text: 'Carbonated water', percent_estimate: 56.85 },
          { text: 'Cheddar Jalapeno Seasoning', percent_estimate: 9.375 },
        ],
      },
    };
    const text = offGetProductTool.format!(output)[0].text;

    expect(text).toContain('~56.85%');
    expect(text).toContain('~9.375%');
    expect(text).not.toContain('~56.9%');
    expect(text).not.toContain('~9.4%');
  });
});
