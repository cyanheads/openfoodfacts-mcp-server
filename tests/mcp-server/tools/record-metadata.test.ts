/**
 * @fileoverview Tests for how the product tools render a record's metadata: the completeness
 * label every tool shares, and how each tool's schema describes the score.
 * @module tests/mcp-server/tools/record-metadata.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { offCompareProductsTool } from '@/mcp-server/tools/definitions/compare-products.tool.js';
import { offGetProductTool } from '@/mcp-server/tools/definitions/get-product.tool.js';
import { offSearchProductsTool } from '@/mcp-server/tools/definitions/search-products.tool.js';
import {
  completenessLabel,
  completenessScore,
  recordTime,
} from '@/mcp-server/tools/record-metadata.js';

/** Every `completeness` property description in a schema as it is advertised to clients. */
function completenessDescriptions(schema: z.ZodType): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'completeness' && typeof value === 'object' && value !== null) {
          found.push(String((value as { description?: unknown }).description));
        }
        walk(value);
      }
    }
  };
  walk(z.toJSONSchema(schema));
  return found;
}

describe('completenessLabel', () => {
  it.each([
    [1.1, '110% (exact 1.1, high)'],
    [1.0875, '109% (exact 1.0875, high)'],
    [1, '100% (exact 1, high)'],
    [0.9, '90% (exact 0.9, high)'],
    [0.8, '80% (exact 0.8, high)'],
    [0.7875, '79% (exact 0.7875, moderate)'],
    [0.5, '50% (exact 0.5, moderate)'],
    [0.4999, '50% (exact 0.4999, low — many fields missing)'],
    [0, '0% (exact 0, low — many fields missing)'],
  ])('labels %s as %s', (score, label) => {
    expect(completenessLabel(score)).toBe(label);
  });
});

describe('completenessScore (#92)', () => {
  it.each([
    ['a number', 0.7875, 0.7875],
    ['a score above 1', 1.0875, 1.0875],
    ['0', 0, 0],
    // /api/v2/search sends some scores as strings: 5053990161669 as "0.65" (2026-11-24).
    ['a numeric string', '0.65', 0.65],
    ['a numeric string above 1', '1.0875', 1.0875],
    ['a whole-number string', '1', 1],
    ['"0"', '0', 0],
  ])('reads %s as the score it spells', (_, value, score) => {
    expect(completenessScore(value)).toBe(score);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a blank string', '  '],
    ['a word', 'high'],
    ['a number followed by text', '0.65 %'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['"Infinity"', 'Infinity'],
    ['a boolean', true],
    ['an object', { value: 0.65 }],
  ])('leaves out a value that is %s', (_, value) => {
    expect(completenessScore(value)).toBeUndefined();
  });
});

describe('recordTime (#96)', () => {
  it.each([
    // The text index's revision of 50457250 and the live record it lags (2026-11-23).
    [1_689_265_890, '2023-07-13T16:31:30.000Z'],
    [1_779_824_102, '2026-05-26T19:35:02.000Z'],
    [1_415_566_933, '2014-11-09T21:02:13.000Z'],
    // Fractional seconds keep their milliseconds.
    [1_689_265_890.5, '2023-07-13T16:31:30.500Z'],
    // The first millisecond after the epoch is the earliest time reported.
    [0.001, '1970-01-01T00:00:00.001Z'],
  ])('renders %s epoch seconds as %s', (seconds, iso) => {
    expect(recordTime(seconds)).toBe(iso);
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a numeric string', '1689265890'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['past the last time a Date holds', 8.64e12 + 1],
    // A stored 0 is a placeholder, not a record created or edited at the epoch.
    ['0, the epoch itself', 0],
    ['-0', -0],
    ['before the epoch', -1],
    ['under a millisecond past the epoch, which a Date holds as the epoch', 0.0004],
  ])('leaves out a value that is %s', (_, value) => {
    expect(recordTime(value)).toBeUndefined();
  });
});

describe('completeness as the tools describe it (#92)', () => {
  it.each([
    ['off_get_product', offGetProductTool.output],
    ['off_search_products', offSearchProductsTool.output],
    ['off_compare_products', offCompareProductsTool.output],
  ])('%s describes the score without a 0–1 range, and says it can exceed 1', (_, output) => {
    const descriptions = completenessDescriptions(output);

    expect(descriptions).toHaveLength(1);
    for (const description of descriptions) {
      expect(description).not.toMatch(/0\s*[–-]\s*1\b|between 0 and 1/);
      expect(description).toContain('can exceed 1');
    }
  });
});
