/**
 * @fileoverview Tests for the stored as-sold selection in nutrition-sets (#73): the prepared-only
 * trigger, the one-set choice, unit and basis conversion, and how a selection lands on a raw v2
 * product. Expected figures are read off the captured input sets by hand, never computed by the
 * code under test.
 * @module tests/services/openfoodfacts/nutrition-sets.test
 */

import { describe, expect, it } from 'vitest';
import {
  applyAsSoldSelection,
  defaultUnitForNid,
  holdsOnlyPreparedFigures,
  type NutritionInputSet,
  nutrientValueInStandardUnit,
  perlNumber,
  printfSignificant,
  readInputSets,
  selectAsSoldSet,
} from '@/services/openfoodfacts/nutrition-sets.js';
import type { RawProduct } from '@/services/openfoodfacts/types.js';
import { type V35CaptureCode, v2Capture, v35Capture } from '../../fixtures/as-sold-captures.js';

/** The input sets of a v3.5 capture, as the reading primitive returns them. */
function capturedSets(code: V35CaptureCode): NutritionInputSet[] {
  const sets = readInputSets(v35Capture(code).product.nutrition);
  if (!Array.isArray(sets)) throw new Error(`Expected input sets in the ${code} capture.`);
  return sets;
}

/** An as-sold set per 100 g from the manufacturer, with the given nutrients. */
function set(
  nutrients: NutritionInputSet['nutrients'],
  overrides: Partial<Omit<NutritionInputSet, 'nutrients'>> = {},
): NutritionInputSet {
  return {
    preparation: 'as_sold',
    source: 'manufacturer',
    per: '100g',
    per_quantity: 100,
    per_unit: 'g',
    nutrients,
    ...overrides,
  };
}

describe('holdsOnlyPreparedFigures', () => {
  it.each<[string, Record<string, unknown> | undefined, boolean]>([
    [
      'the live prepared-only read of 7613035530799',
      v2Capture('7613035530799').product.nutriments,
      true,
    ],
    ['per-serving prepared figures alone', { 'energy-kcal_prepared_serving': 143 }, true],
    // Compare shows eight columns; the rule reads every nutrient, so these still trigger the read.
    [
      'prepared figures for nutrients outside the compared columns alone',
      { calcium_prepared_100g: 0.1, 'vitamin-c_prepared_serving': 0.002 },
      true,
    ],
    ['a prepared energy figure in kJ alone', { energy_prepared_100g: 285 }, true],
    [
      'prepared figures beside the NOVA class',
      { fat_prepared_100g: 2, 'nova-group_100g': 4, 'nova-group_serving': 4 },
      true,
    ],
    ['the as-sold read of 3017620422003', v2Capture('3017620422003').product.nutriments, false],
    [
      'a prepared figure beside an as-sold per-serving one',
      { fat_prepared_100g: 2, 'energy-kcal_serving': 80 },
      false,
    ],
    [
      'a prepared figure beside an as-sold micronutrient',
      { fat_prepared_100g: 2, calcium_100g: 0.1 },
      false,
    ],
    ['the NOVA class alone', { 'nova-group_100g': 4 }, false],
    ['a prepared figure that is not a number', { fat_prepared_100g: '1.9' }, false],
    [
      'prepared value and unit siblings with no per-100 or per-serving key',
      { fat_prepared: 1.9, fat_prepared_value: 1.9, fat_unit: 'g' },
      false,
    ],
    ['an empty map', {}, false],
    ['no map', undefined, false],
  ])('%s → %s', (_label, nutriments, expected) => {
    expect(holdsOnlyPreparedFigures(nutriments)).toBe(expected);
  });
});

describe('selectAsSoldSet', () => {
  describe('captured records', () => {
    it('reads the sparse as-sold set of 7613035530799, NOVA and estimates left out', () => {
      expect(selectAsSoldSet(capturedSets('7613035530799'))).toEqual({
        status: 'read',
        nutriments: {
          alcohol_100g: 0,
          'energy-kcal_100g': 327,
          'energy-kj_100g': 1370,
          energy_100g: 1370,
          fat_100g: 5.4,
          'saturated-fat_100g': 2.2,
        },
      });
    });

    it('takes the manufacturer set over packaging and converts 150 mg vitamin C to 0.15 g (8445290133403)', () => {
      expect(selectAsSoldSet(capturedSets('8445290133403'))).toEqual({
        status: 'read',
        nutriments: {
          carbohydrates_100g: 78.9,
          'energy-kcal_100g': 386,
          'energy-kj_100g': 1634,
          energy_100g: 1634,
          fat_100g: 3.6,
          fiber_100g: 7.7,
          proteins_100g: 5.1,
          salt_100g: 0.41,
          'saturated-fat_100g': 1.6,
          sodium_100g: 0.164,
          sugars_100g: 75.1,
          'vitamin-c_100g': 0.15,
          'vitamin-d_100g': 0.000011,
        },
      });
    });

    it('scales the 20 g serving set of 7612100914199 to 100 g, concentrations unscaled', () => {
      expect(selectAsSoldSet(capturedSets('7612100914199'))).toEqual({
        status: 'read',
        nutriments: {
          alcohol_100g: 0,
          biotin_100g: 0.00005,
          calcium_100g: 0.32,
          carbohydrates_100g: 78,
          'energy-kcal_100g': 375,
          'energy-kj_100g': 1595,
          energy_100g: 1595,
          fat_100g: 2,
          fiber_100g: 0,
          magnesium_100g: 0.33,
          'pantothenic-acid_100g': 0.006,
          proteins_100g: 9.5,
          salt_100g: 0.5,
          'saturated-fat_100g': 1,
          sodium_100g: 0.2,
          // 10.2 × 100 / 20 is 50.99999999999999 in floating point; Product Opener writes 51.
          sugars_100g: 51,
          'vitamin-c_100g': 0.08,
          'vitamin-e_100g': 0.012,
          'vitamin-pp_100g': 0.016,
        },
      });
    });

    it('reads a serving set of 100 g as it stands, value_computed filling energy in kJ (16256866)', () => {
      const selection = selectAsSoldSet(capturedSets('16256866'));

      expect(selection).toEqual({
        status: 'read',
        nutriments: {
          carbohydrates_100g: 63,
          'energy-kcal_100g': 515,
          'energy-kj_100g': 2161.7,
          energy_100g: 2161.7,
          fat_100g: 26,
          fiber_100g: 1,
          proteins_100g: 7.1,
          salt_100g: 0.245,
          'saturated-fat_100g': 7.74,
          sodium_100g: 0.098,
          sugars_100g: 61,
        },
      });
    });

    it('prefers the per-100 g set of 3664346306027 to its 15 g serving set, sodium from value_computed', () => {
      const selection = selectAsSoldSet(capturedSets('3664346306027'));

      // The serving set holds saturated fat 2.1 for 15 g; the 100 g set holds 2.4.
      expect(selection).toEqual({
        status: 'read',
        nutriments: {
          carbohydrates_100g: 18,
          'energy-kcal_100g': 148,
          'energy-kj_100g': 621,
          energy_100g: 621,
          fat_100g: 4,
          fiber_100g: 2.5,
          proteins_100g: 8.4,
          salt_100g: 0.22,
          'saturated-fat_100g': 2.4,
          sodium_100g: 0.088,
          sugars_100g: 17,
        },
      });
    });

    it('reads the manufacturer set of the seven 3033710065783 stores, never merging packaging figures', () => {
      const selection = selectAsSoldSet(capturedSets('3033710065783'));

      expect(selection.status).toBe('read');
      if (selection.status !== 'read') return;
      expect(selection.nutriments.salt_100g).toBe(0.12);
      expect(selection.nutriments.sodium_100g).toBe(0.048);
      expect(selection.nutriments).not.toHaveProperty('cocoa_100g');
      expect(selection.nutriments).not.toHaveProperty('magnesium_100g');
    });

    it.each<V35CaptureCode>(['3033710065783', '3664346306027', '8445290133403'])(
      'chooses the same set of %s whatever order the record stores them in',
      (code) => {
        const sets = capturedSets(code);
        expect(selectAsSoldSet([...sets].reverse())).toEqual(selectAsSoldSet(sets));
      },
    );
  });

  describe('ranking', () => {
    it('ranks a per-100 set of any source before a serving set from the manufacturer', () => {
      const selection = selectAsSoldSet([
        set({ fat: { value: 1, unit: 'g' } }, { per: 'serving', per_quantity: 50 }),
        set({ fat: { value: 3, unit: 'g' } }, { source: 'web' }),
      ]);
      expect(selection).toEqual({ status: 'read', nutriments: { fat_100g: 3 } });
    });

    it('ranks manufacturer, packaging, usda, then any other source', () => {
      const sources = ['web', 'usda', 'packaging', 'manufacturer'];
      const sets = sources.map((source, i) => set({ fat: { value: i, unit: 'g' } }, { source }));
      expect(selectAsSoldSet(sets)).toEqual({ status: 'read', nutriments: { fat_100g: 3 } });
      expect(selectAsSoldSet(sets.slice(0, 3))).toEqual({
        status: 'read',
        nutriments: { fat_100g: 2 },
      });
      expect(selectAsSoldSet(sets.slice(0, 2))).toEqual({
        status: 'read',
        nutriments: { fat_100g: 1 },
      });
    });

    it('ranks a source named like an Object prototype key as any other source', () => {
      const selection = selectAsSoldSet([
        set({ fat: { value: 1, unit: 'g' } }, { source: 'constructor' }),
        set({ fat: { value: 2, unit: 'g' } }, { source: 'usda' }),
      ]);
      expect(selection).toEqual({ status: 'read', nutriments: { fat_100g: 2 } });
    });

    it('ranks 100 g before 100 ml, and keeps stored order on a tie', () => {
      expect(
        selectAsSoldSet([
          set({ fat: { value: 1, unit: 'g' } }, { per: '100ml', per_unit: 'ml' }),
          set({ fat: { value: 2, unit: 'g' } }),
          set({ fat: { value: 3, unit: 'g' } }),
        ]),
      ).toEqual({ status: 'read', nutriments: { fat_100g: 2 } });
    });

    it('passes over a set whose figures all fail conversion for the next eligible one', () => {
      expect(
        selectAsSoldSet([
          set({ 'vitamin-a': { value: 400, unit: 'IU' } }),
          set({ fat: { value: 2, unit: 'g' } }, { source: 'packaging' }),
        ]),
      ).toEqual({ status: 'read', nutriments: { fat_100g: 2 } });
    });
  });

  describe('values and units', () => {
    it('converts mass to grams and leaves concentrations and unitless values as entered', () => {
      expect(
        selectAsSoldSet([
          set({
            salt: { value: 0.002, unit: 'kg' },
            iron: { value: 1700, unit: 'µg' },
            zinc: { value: 950, unit: 'mcg' },
            calcium: { value: 120, unit: 'mg' },
            alcohol: { value: 4.5, unit: '% vol' },
            cocoa: { value: 32, unit: '%' },
            'water-hardness': { value: 2, unit: 'mmol/l' },
            ph: { value: 6.5, unit: '' },
          }),
        ]),
      ).toEqual({
        status: 'read',
        nutriments: {
          salt_100g: 2,
          iron_100g: 0.0017,
          zinc_100g: 0.00095,
          calcium_100g: 0.12,
          alcohol_100g: 4.5,
          cocoa_100g: 32,
          'water-hardness_100g': 2,
          ph_100g: 6.5,
        },
      });
    });

    it('leaves out IU, % DV, unknown and missing units, and energy in the other energy unit', () => {
      expect(
        selectAsSoldSet([
          set({
            fat: { value: 2, unit: 'g' },
            'vitamin-a': { value: 400, unit: 'IU' },
            'vitamin-c': { value: 10, unit: '% DV' },
            iron: { value: 3, unit: 'grain' },
            zinc: { value: 1 },
            'energy-kcal': { value: 1370, unit: 'kJ' },
            'energy-kj': { value: 327, unit: 'kcal' },
          }),
        ]),
      ).toEqual({ status: 'read', nutriments: { fat_100g: 2 } });
    });

    it('converts vitamins entered in milligrams and micrograms to grams', () => {
      expect(
        selectAsSoldSet([
          set({
            'vitamin-b1': { value: 1.4, unit: 'mg' },
            'vitamin-b12': { value: 2.5, unit: 'µg' },
          }),
        ]),
      ).toEqual({
        status: 'read',
        nutriments: { 'vitamin-b1_100g': 0.0014, 'vitamin-b12_100g': 0.0000025 },
      });
    });

    it('reads value before value_computed, and value_computed when no value was entered', () => {
      expect(
        selectAsSoldSet([
          set({
            salt: { value: 0.22, value_computed: 0.11, unit: 'g' },
            sodium: { value_computed: 0.088, unit: 'g' },
            fiber: { unit: 'g' },
          }),
        ]),
      ).toEqual({ status: 'read', nutriments: { salt_100g: 0.22, sodium_100g: 0.088 } });
    });

    it('drops modifiers and skips NOVA and a stored energy figure', () => {
      expect(
        selectAsSoldSet([
          set({
            sugars: { value: 0.5, unit: 'g', modifier: '<' },
            'nova-group': { value: 4, unit: '' },
            energy: { value: 900, unit: 'kJ' },
            'energy-kcal': { value: 215, unit: 'kcal' },
          }),
        ]),
      ).toEqual({ status: 'read', nutriments: { sugars_100g: 0.5, 'energy-kcal_100g': 215 } });
    });

    it('makes energy_100g from energy-kj alone, never from a stored energy figure in any unit', () => {
      expect(
        selectAsSoldSet([set({ energy: { value: 900, unit: '' }, fat: { value: 2, unit: 'g' } })]),
      ).toEqual({ status: 'read', nutriments: { fat_100g: 2 } });
    });

    it('copies concentrations and unitless values from a serving set, scaling only the rest', () => {
      // The 7612100914199 capture's only concentration is alcohol 0, which scales to 0 either way.
      expect(
        selectAsSoldSet([
          set(
            {
              fat: { value: 1, unit: 'g' },
              alcohol: { value: 4.5, unit: '% vol' },
              cocoa: { value: 32, unit: '%' },
              'water-hardness': { value: 2, unit: 'mmol/l' },
              ph: { value: 6.5, unit: '' },
            },
            { per: 'serving', per_quantity: 20 },
          ),
        ]),
      ).toEqual({
        status: 'read',
        nutriments: {
          fat_100g: 5,
          alcohol_100g: 4.5,
          cocoa_100g: 32,
          'water-hardness_100g': 2,
          ph_100g: 6.5,
        },
      });
    });

    it('scales from a serving at the 5 g boundary and from a serving entered in kilograms', () => {
      expect(
        selectAsSoldSet([
          set({ fat: { value: 1, unit: 'g' } }, { per: 'serving', per_quantity: 5 }),
        ]),
      ).toEqual({ status: 'read', nutriments: { fat_100g: 20 } });
      expect(
        selectAsSoldSet([
          set(
            { fat: { value: 1, unit: 'g' } },
            { per: 'serving', per_quantity: 0.02, per_unit: 'kg' },
          ),
        ]),
      ).toEqual({ status: 'read', nutriments: { fat_100g: 5 } });
    });

    it('emits no per-serving key', () => {
      const selection = selectAsSoldSet(capturedSets('7612100914199'));
      expect(selection.status).toBe('read');
      if (selection.status !== 'read') return;
      expect(Object.keys(selection.nutriments).length).toBeGreaterThan(0);
      expect(Object.keys(selection.nutriments).every((key) => key.endsWith('_100g'))).toBe(true);
    });
  });

  describe('none', () => {
    it.each<[string, NutritionInputSet[]]>([
      ['no sets', []],
      ['only prepared sets', [set({ fat: { value: 2, unit: 'g' } }, { preparation: 'prepared' })]],
      [
        'only estimate sets',
        [
          set(
            { 'added-sugars': { value: 8.68, unit: 'g', modifier: '~' } },
            { source: 'estimate' },
          ),
        ],
      ],
      [
        'a serving under 5 g',
        [set({ fat: { value: 1, unit: 'g' } }, { per: 'serving', per_quantity: 4.9 })],
      ],
      [
        'a serving in a unit that does not convert',
        [
          set(
            { fat: { value: 1, unit: 'g' } },
            { per: 'serving', per_quantity: 1, per_unit: 'slice' },
          ),
        ],
      ],
      // Past the 5 g floor, so only the unit check can refuse them.
      [
        'a serving of 30 in a unit that does not convert',
        [
          set(
            { fat: { value: 1, unit: 'g' } },
            { per: 'serving', per_quantity: 30, per_unit: 'slice' },
          ),
        ],
      ],
      [
        'a serving of 30 with no unit',
        [
          {
            preparation: 'as_sold',
            source: 'manufacturer',
            per: 'serving',
            per_quantity: 30,
            nutrients: { fat: { value: 1, unit: 'g' } },
          },
        ],
      ],
      [
        'a serving with no quantity',
        [
          {
            preparation: 'as_sold',
            source: 'manufacturer',
            per: 'serving',
            per_unit: 'g',
            nutrients: { fat: { value: 1, unit: 'g' } },
          },
        ],
      ],
      ['a pet-food set per 1 kg', [set({ fat: { value: 1, unit: 'g' } }, { per: '1kg' })]],
      ['a set of IU figures alone', [set({ 'vitamin-a': { value: 400, unit: 'IU' } })]],
      ['a set of NOVA alone', [set({ 'nova-group': { value: 4, unit: '' } })]],
    ])('settles %s as none', (_label, sets) => {
      expect(selectAsSoldSet(sets)).toEqual({ status: 'none' });
    });
  });
});

describe('applyAsSoldSelection', () => {
  it('adds the read figures beside the prepared keys, leaving the input untouched', () => {
    const product: RawProduct = {
      product_name: 'NESQUIK Moins de Sucres',
      nutriments: { 'energy-kcal_prepared_100g': 68, 'energy-kcal_prepared_serving': 143 },
    };

    const applied = applyAsSoldSelection(product, {
      status: 'read',
      nutriments: { 'energy-kcal_100g': 327, fat_100g: 5.4 },
    });

    expect(applied).toEqual({
      product: {
        product_name: 'NESQUIK Moins de Sucres',
        nutriments: {
          'energy-kcal_prepared_100g': 68,
          'energy-kcal_prepared_serving': 143,
          'energy-kcal_100g': 327,
          fat_100g: 5.4,
        },
      },
      stored_as_sold: { status: 'read' },
    });
    expect(product.nutriments).toEqual({
      'energy-kcal_prepared_100g': 68,
      'energy-kcal_prepared_serving': 143,
    });
  });

  it('returns the product unchanged for none', () => {
    const product: RawProduct = { nutriments: { fat_prepared_100g: 2 } };

    const applied = applyAsSoldSelection(product, { status: 'none' });

    expect(applied.product).toBe(product);
    expect(applied.stored_as_sold).toEqual({ status: 'none' });
  });
});

/** Upstream strings that name a property every plain object inherits. */
const PROTOTYPE_KEYS = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];

describe('defaultUnitForNid', () => {
  it('reads the fixed units, the ratio units, and the taxonomy units', () => {
    expect(defaultUnitForNid('energy-kcal')).toBe('kcal');
    expect(defaultUnitForNid('energy')).toBe('kJ');
    expect(defaultUnitForNid('alcohol_prepared')).toBe('% vol');
    expect(defaultUnitForNid('fruits-vegetables-nuts')).toBe('%');
    expect(defaultUnitForNid('nova-group')).toBe('');
    expect(defaultUnitForNid('vitamin-c')).toBe('g');
  });

  it.each(PROTOTYPE_KEYS)('reads the nid %s as a nutrient it does not know, in grams', (nid) => {
    expect(defaultUnitForNid(nid)).toBe('g');
    expect(defaultUnitForNid(`${nid}_prepared`)).toBe('g');
  });
});

describe('nutrientValueInStandardUnit', () => {
  it('converts mass to grams and keeps concentrations', () => {
    expect(nutrientValueInStandardUnit('fat', 2, 'kg')).toBe(2000);
    expect(nutrientValueInStandardUnit('fat', 3, 'g')).toBe(3);
    expect(nutrientValueInStandardUnit('alcohol', 5, '% vol')).toBe(5);
    expect(nutrientValueInStandardUnit('vitamin-a', 1, 'IU')).toBeUndefined();
  });

  it.each<[string, number, string, number | undefined]>([
    ['energy-kcal', 327, 'kcal', 327],
    ['energy-kj', 1370, 'kJ', 1370],
    ['energy-kcal', 1370, 'kJ', undefined],
    ['energy-kj', 327, 'kcal', undefined],
    ['sodium', 164, 'mg', 0.164],
    ['vitamin-c', 150, 'mg', 0.15],
    ['vitamin-d', 11, 'µg', 0.000011],
    ['alcohol', 4.5, '% vol', 4.5],
  ])('reads %s entered as %s %s as %s', (nid, value, unit, expected) => {
    expect(nutrientValueInStandardUnit(nid, value, unit)).toBe(expected);
  });

  it.each(PROTOTYPE_KEYS)('refuses the unit %s rather than computing with it', (unit) => {
    expect(nutrientValueInStandardUnit('fat', 1, unit)).toBeUndefined();
  });

  it.each(PROTOTYPE_KEYS)('places the nid %s like any other mass nutrient', (nid) => {
    expect(nutrientValueInStandardUnit(nid, 2, 'kg')).toBe(2000);
    expect(nutrientValueInStandardUnit(nid, 2, 'constructor')).toBeUndefined();
  });
});

describe('printfSignificant', () => {
  it('rounds an exact binary tie to the even digit, as C printf does', () => {
    // 5610 kJ per 100 ml × 5 ml is exactly 280.5: Perl's sprintf("%.2e") writes 2.80e+02.
    expect(printfSignificant(280.5, 3)).toBe(280);
    expect(printfSignificant(-280.5, 3)).toBe(-280);
    expect(printfSignificant(0.125, 2)).toBe(0.12);
  });

  it('rounds an odd tie up, and every non-tie to the nearest', () => {
    expect(printfSignificant(281.5, 3)).toBe(282);
    expect(printfSignificant(280.50000000000006, 3)).toBe(281);
    expect(printfSignificant(280.49999999999994, 3)).toBe(280);
    expect(printfSignificant(0.0123456, 3)).toBe(0.0123);
    expect(printfSignificant(0, 3)).toBe(0);
  });
});

describe('perlNumber', () => {
  it('writes a double to 15 significant digits and leaves integers whole', () => {
    expect(perlNumber(0.008672595983426845)).toBe(0.00867259598342685);
    expect(perlNumber(50.99999999999999)).toBe(51);
    expect(perlNumber(42)).toBe(42);
  });

  it('rounds a 15-digit tie to the even digit', () => {
    // 123456789012.0625 is exact in binary; %.15g keeps the even 2, where toPrecision rounds up.
    expect(perlNumber(123456789012.0625)).toBe(123456789012.062);
    expect(perlNumber(123456789012.1875)).toBe(123456789012.188);
  });
});
