/**
 * @fileoverview Tests for `brands:sync` (GH issue #98), the generator of
 * `src/services/taxonomy/brand-synonyms.ts`: reading a fixture `taxonomies/brands.txt` as Product
 * Opener's taxonomy build reads it, the synonym groups and the two refusals (an entry ID missing from
 * the published dump, a key two entries share), the module it writes, and the commit it syncs.
 * @module tests/scripts/brands-sync.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BrandsSyncError,
  brandSynonymGroups,
  commitToSync,
  parseBrandsTaxonomy,
  publishedIds,
  renderBrandSynonymsModule,
} from '../../scripts/brands-sync.js';

const FIXTURE = readFileSync(new URL('../fixtures/brands/brands.txt', import.meta.url), 'utf8');

/** Every entry ID the fixture defines, as the published dump would list them. */
const FIXTURE_IDS = [
  'xx:7up',
  'xx:andechser-natur',
  'xx:nutella',
  'xx:bio',
  'xx:eaglobe',
  'xx:pilsner-1-5',
  'xx:salt-pepper-co',
  'xx:viniv',
  'xx:όλυμπος',
  'xx:kellogg-s',
];

const COMMIT = 'c6a9ede919a3c55ded2d5f71ae25bb347c260b42';

/** The `BrandsSyncError` `run` throws. */
function refusal(run: () => unknown): BrandsSyncError {
  try {
    run();
  } catch (error) {
    if (error instanceof BrandsSyncError) return error;
    throw error;
  }
  throw new Error('Expected a refusal, but the call returned.');
}

describe('parseBrandsTaxonomy', () => {
  it('reads each block as an entry: its ID from the first name, every name of every line', () => {
    expect(parseBrandsTaxonomy(FIXTURE)).toEqual([
      { id: 'xx:7up', names: ['7UP', '7-Up', 'Seven Up'] },
      { id: 'xx:andechser-natur', names: ['Andechser Natur', 'Andechser'] },
      { id: 'xx:nutella', names: ['Nutella'] },
      // A second block whose ID the first took is merged into it, as Product Opener merges it.
      { id: 'xx:bio', names: ['Bio', 'Bio+'] },
      // A line in another language adds its names to the block's entry.
      { id: 'xx:eaglobe', names: ['EAGLOBE', '鷹球牌', '鷹球牌'] },
      // A comma between digits, or escaped, stays inside the name as the low comma.
      { id: 'xx:pilsner-1-5', names: ['Pilsner 1‚5', 'Pilsner Light'] },
      { id: 'xx:salt-pepper-co', names: ['Salt‚ Pepper & Co', 'Salt Pepper'] },
      // A parenthesized roman numeral loses its parentheses.
      { id: 'xx:viniv', names: ['VinIV', 'Vin Quatre'] },
      // The ID keeps the final ς the name was typed with.
      { id: 'xx:όλυμπος', names: ['Όλυμπος', 'ΌΛΥΜΠΟΣ'] },
      // A block of properties alone (the orphaned wikidata line) is no entry.
      { id: 'xx:kellogg-s', names: ["Kellogg's", 'Kelloggs', 'Kellogg'] },
    ]);
  });

  it('drops trailing space from a line, so a whitespace-only line ends a block', () => {
    expect(parseBrandsTaxonomy('xx: Foo, Foo Bar  \t\n \t\nxx: Baz\n')).toEqual([
      { id: 'xx:foo', names: ['Foo', 'Foo Bar'] },
      { id: 'xx:baz', names: ['Baz'] },
    ]);
  });

  it.each([
    ['a names line with no name', 'xx:', 1],
    ['a names line of empty names', 'xx: Foo\n\nxx: ,', 3],
    ['a parent', 'xx: Foo\n< xx:Bar', 2],
    ['a synonym-only block', 'synonyms:xx: foo, bar', 1],
    ['stopwords', 'stopwords:xx: the, of', 1],
    ['a block opened in another language', 'zh: 鷹球牌', 1],
  ])('refuses %s, naming its line', (_case, text, line) => {
    const { reason, message } = refusal(() => parseBrandsTaxonomy(text));
    expect(reason).toBe('unreadable_line');
    expect(message).toContain(`line ${line} `);
  });
});

describe('brandSynonymGroups', () => {
  const entries = parseBrandsTaxonomy(FIXTURE);

  it('lists the keys of each entry with more than one, the canonical key first, in file order', () => {
    expect(brandSynonymGroups(entries, new Set(FIXTURE_IDS))).toEqual([
      ['7up', '7-up', 'seven-up'],
      ['andechser-natur', 'andechser'],
      ['eaglobe', '鷹球牌'],
      ['pilsner-1-5', 'pilsner-light'],
      ['salt-pepper-co', 'salt-pepper'],
      ['viniv', 'vin-quatre'],
      ['kellogg-s', 'kelloggs', 'kellogg'],
    ]);
  });

  it('refuses entry IDs the published dump lacks, naming each', () => {
    const published = new Set(FIXTURE_IDS.filter((id) => id !== 'xx:nutella' && id !== 'xx:viniv'));
    const { reason, message } = refusal(() => brandSynonymGroups(entries, published));
    expect(reason).toBe('missing_id');
    expect(message).toContain('xx:nutella');
    expect(message).toContain('xx:viniv');
    expect(message).not.toContain('xx:7up');
  });

  it('refuses a single entry ID the published dump lacks', () => {
    const published = new Set(FIXTURE_IDS.filter((id) => id !== 'xx:nutella'));
    const { reason, message } = refusal(() => brandSynonymGroups(entries, published));
    expect(reason).toBe('missing_id');
    expect(message).toContain('1 entry ID(s)');
    expect(message).toContain('xx:nutella');
  });

  it('refuses a key two entries share, naming the key and both entries', () => {
    const clashing = parseBrandsTaxonomy(`${FIXTURE}\nxx: Seven Up Light, 7 Up\n`);
    const published = new Set([...FIXTURE_IDS, 'xx:seven-up-light']);
    const { reason, message } = refusal(() => brandSynonymGroups(clashing, published));
    expect(reason).toBe('duplicate_key');
    expect(message).toContain('7-up (xx:7up and xx:seven-up-light)');
  });

  it('refuses keys that coincide only once sigma is folded', () => {
    const clashing = parseBrandsTaxonomy(`${FIXTURE}\nxx: Σοφός\n\nxx: Sofos, ΣΟΦΌΣ\n`);
    const published = new Set([...FIXTURE_IDS, 'xx:σοφός', 'xx:sofos']);
    const { reason, message } = refusal(() => brandSynonymGroups(clashing, published));
    expect(reason).toBe('duplicate_key');
    expect(message).toContain('σοφόσ (xx:σοφός and xx:sofos)');
  });
});

describe('publishedIds', () => {
  it("reads the dump's top-level keys", () => {
    const dump = '{"xx:7up":{"name":{"xx":"7UP"},"wikidata":{"en":"Q270059"}},"xx:nutella":{}}';
    expect(publishedIds(dump)).toEqual(new Set(['xx:7up', 'xx:nutella']));
  });

  it('refuses a dump that is not an object of entries', () => {
    expect(() => publishedIds('"xx:7up"')).toThrow();
  });
});

describe('renderBrandSynonymsModule', () => {
  it('writes the groups one per line, keys joined by spaces, under a header naming the commit', () => {
    expect(
      renderBrandSynonymsModule(
        [
          ['7up', '7-up', 'seven-up'],
          ['eaglobe', '鷹球牌'],
        ],
        COMMIT,
      ),
    ).toBe(`/**
 * @fileoverview Brand synonym groups, from Product Opener's \`taxonomies/brands.txt\` at
 * openfoodfacts-server commit c6a9ede919a3c55ded2d5f71ae25bb347c260b42. Generated by
 * \`bun run brands:sync\`; regenerate rather than edit.
 * @module services/taxonomy/brand-synonyms
 */

/**
 * Each \`taxonomies/brands.txt\` entry with more than one brand key (\`brandKey\`), as its keys
 * separated by spaces, which no key contains, the key of the entry's canonical ID first.
 */
export const BRAND_SYNONYM_GROUPS: readonly string[] = [
  '7up 7-up seven-up',
  'eaglobe 鷹球牌',
];
`);
  });
});

describe('commitToSync', () => {
  const current = readFileSync(
    new URL('../../src/services/taxonomy/brand-synonyms.ts', import.meta.url),
    'utf8',
  );

  it('syncs the commit given, lowercased', () => {
    const other = '0123456789abcdef0123456789abcdef01234567';
    expect(commitToSync([other], current)).toBe(other);
    expect(commitToSync([other.toUpperCase()], current)).toBe(other);
  });

  it('syncs the commit the current module names when none is given', () => {
    expect(commitToSync([], current)).toBe(COMMIT);
    const other = 'fedcba9876543210fedcba9876543210fedcba98';
    expect(commitToSync([], renderBrandSynonymsModule([['a', 'b']], other))).toBe(other);
  });

  it.each([
    ['a branch name', ['main'], current],
    ['a short SHA', ['c6a9ede'], current],
    ['two arguments', [COMMIT, COMMIT], current],
    ['no argument and a module naming no commit', [], 'export const BRAND_SYNONYM_GROUPS = [];'],
  ])('refuses %s', (_case, args, module) => {
    expect(refusal(() => commitToSync(args, module)).reason).toBe('invalid_commit');
  });
});
