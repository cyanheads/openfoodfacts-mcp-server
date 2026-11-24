/**
 * @fileoverview Tests for the keys every brand spelling is matched under (GH issue #98):
 * `brandSlug`, the Product Opener slug a key starts from (GH issue #94); `brandKey`, which drops the
 * prefix and folds sigma so the typed and slugged forms of one stored brand key alike; `brandKeys`,
 * which widens a key to the names of its `taxonomies/brands.txt` entry; and the generated synonym
 * table that widening reads.
 * @module tests/services/taxonomy/brand-keys.test
 */

import { describe, expect, it } from 'vitest';
import { brandKey, brandKeys, brandSlug } from '@/services/taxonomy/brand-keys.js';
import { BRAND_SYNONYM_GROUPS } from '@/services/taxonomy/brand-synonyms.js';

describe('brandSlug', () => {
  it('composes before folding, so a decomposed accent folds like a precomposed one', () => {
    expect(brandSlug('Nestlé')).toBe('nestle');
    expect(brandSlug('Häagen-Dazs')).toBe('haagen-dazs');
  });

  it('keeps the marks of letters outside the folded list, decomposed ones included', () => {
    expect(brandSlug('ブルボン')).toBe('ブルボン');
    expect(brandSlug('Йогурт')).toBe('йогурт');
    expect(brandSlug('Δέλτα')).toBe('δέλτα');
    expect(brandSlug('Vĩnh Hảo')).toBe('vĩnh-hảo');
  });

  it('folds a capital sharp s, which lowercases to ß', () => {
    expect(brandSlug('MEẞMER')).toBe('messmer');
  });

  it('folds every letter of the fold list, capital and small', () => {
    // One word per fold group, its letters capital then small, in fold-list order.
    expect(
      brandSlug(
        'ÀÁÂÃÄÅĂàáâãäåă Çç ÈÉÊËèéêë ÌÍÎÏìíîï Ññ ÒÓÔÕÖòóôõö ÙÚÛÜùúûü ÝŸýÿ ȘŞșş ȚŢțţ Œœ Ææ ẞß',
      ),
    ).toBe(
      'aaaaaaaaaaaaaa-cc-eeeeeeee-iiiiiiii-nn-oooooooooo-uuuuuuuu-yyyy-ssss-tttt-oeoe-aeae-ssss',
    );
  });

  it.each([
    ['xx:nutella', 'nutella'],
    ['en:nutella', 'nutella'],
    [' XX:Nestlé ', 'nestle'],
  ])('drops the language prefix of %j', (input, slug) => {
    expect(brandSlug(input)).toBe(slug);
  });
});

describe('brandKey', () => {
  /**
   * Product Opener stores a brand outside its taxonomy as typed text on newer records and as a slug
   * on older ones, and a contributor's spelling varies: every form keys alike.
   */
  it.each([
    ['xx:Красный Октябрь'],
    ['xx:Красный октябрь'],
    ['xx:красный-октябрь'],
    ['красный-октябрь'],
    ['КРАСНЫЙ ОКТЯБРЬ'],
  ])('keys %j as красный-октябрь', (value) => {
    expect(brandKey(value)).toBe('красный-октябрь');
  });

  it.each([
    ['xx:Nestlé', 'nestle'],
    ['xx:Meßmer', 'messmer'],
    ['xx:Løgismose', 'løgismose'],
    ['xx:ブルボン', 'ブルボン'],
    ["xx:Ben & Jerry's", 'ben-jerry-s'],
    ['en:nutella', 'nutella'],
  ])('keeps the slug rule of GH issue #94 for %j', (value, key) => {
    expect(brandKey(value)).toBe(key);
  });

  it('folds sigma, so a name in capitals and one typed in lowercase share a key', () => {
    expect(brandSlug('xx:ΌΛΥΜΠΟΣ')).toBe('όλυμποσ');
    expect(brandSlug('xx:όλυμπος')).toBe('όλυμπος');
    expect(brandKey('xx:ΌΛΥΜΠΟΣ')).toBe('όλυμποσ');
    expect(brandKey('xx:όλυμπος')).toBe('όλυμποσ');
    expect(brandKey('σοφος καφες')).toBe('σοφοσ-καφεσ');
    // Unicode case folding maps every ς to σ, a misplaced one inside a word included.
    expect(brandKey('οςα')).toBe('οσα');
  });

  it.each([[''], ['   '], ['™'], ['xx:']])('names no brand for %j', (value) => {
    expect(brandKey(value)).toBe('');
  });

  it('keys a key as itself', () => {
    const keys = ['красный-октябрь', 'nestle', 'løgismose', 'ブルボン', 'όλυμποσ', 'ica-i❤️eco'];
    expect(keys.map(brandKey)).toEqual(keys);
  });
});

describe('brandKeys', () => {
  it.each(['7-Up', '7 Up', 'Seven Up', '7up', 'xx:7UP'])(
    'widens %j to every key of the 7UP entry, its own first',
    (brand) => {
      const keys = brandKeys(brand);
      expect(keys[0]).toBe(brandKey(brand));
      expect([...keys].sort()).toEqual(['7-up', '7up', 'seven-up']);
    },
  );

  it("follows its own key with the entry's canonical key, then the other names'", () => {
    expect(brandKeys('Seven Up')).toEqual(['seven-up', '7up', '7-up']);
    expect(brandKeys('7UP')).toEqual(['7up', '7-up', 'seven-up']);
    expect(brandKeys("KELLOGG'S")).toEqual(['kellogg-s', 'kelloggs', 'kellogg']);
    expect(brandKeys('Kelloggs')).toEqual(['kelloggs', 'kellogg-s', 'kellogg']);
  });

  it('keeps a name that is a prefix of another name of its entry, beside it', () => {
    expect(brandKeys('Andechser')).toEqual(['andechser', 'andechser-natur']);
    expect(brandKeys('Andechser Natur')).toEqual(['andechser-natur', 'andechser']);
  });

  it('keys a brand in no entry, or one whose entry has one name, under its own key alone', () => {
    expect(brandKeys('xx:Красный Октябрь')).toEqual(['красный-октябрь']);
    expect(brandKeys('Nutella')).toEqual(['nutella']);
  });

  it.each(['nutell', '7u', 'andechser-nat', 'seven'])(
    'finds no entry for %j, a part of a name',
    (brand) => {
      expect(brandKeys(brand)).toEqual([brandKey(brand)]);
    },
  );

  it.each([[''], ['  \t '], ['™']])('names no key for %j', (value) => {
    expect(brandKeys(value)).toEqual([]);
  });
});

describe('BRAND_SYNONYM_GROUPS', () => {
  const groups = BRAND_SYNONYM_GROUPS.map((line) => line.split(' '));

  it('lists keys in groups of two or more, each key once and as its own brandKey', () => {
    const keys = groups.flat();
    expect(groups.filter((group) => group.length < 2)).toEqual([]);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
    expect(keys.filter((key) => brandKey(key) !== key)).toEqual([]);
  });

  it('widens every key it lists to the whole of its group', () => {
    const misses = groups.flatMap((group) =>
      group.filter((key) => {
        const keys = brandKeys(key);
        return keys[0] !== key || [...keys].sort().join(' ') !== [...group].sort().join(' ');
      }),
    );
    expect(misses).toEqual([]);
  });
});
