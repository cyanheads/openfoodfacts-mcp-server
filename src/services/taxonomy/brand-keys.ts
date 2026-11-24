/**
 * @fileoverview Brand keys: the one form every spelling of a brand is matched under. Product Opener
 * stores a brand as typed text on some records (`xx:Красный Октябрь`) and as a slug on others
 * (`xx:красный-октябрь`); both carry one key. A brand's keys widen to the names its
 * `taxonomies/brands.txt` entry lists (`brand-synonyms.ts`), so a synonym matches the records of
 * every other name of its entry.
 * @module services/taxonomy/brand-keys
 */

import { BRAND_SYNONYM_GROUPS } from './brand-synonyms.js';
import { LANGUAGE_PREFIX, tagIdOf } from './tag-id.js';

/**
 * A brand as Product Opener stores it in `brands_tags`, with any language prefix dropped: the slug
 * of the brand name under the `xx` normalization (`tagIdOf`), which folds a fixed set of accented
 * Latin letters (`Nestlé` → `nestle`, `Meßmer` → `messmer`, `Ben & Jerry's` → `ben-jerry-s`) and
 * keeps every other letter as written (`Løgismose` → `løgismose`, `ブルボン`). Product Opener matches
 * `brands_tags=xx:nutella` and `=en:nutella` as it matches `=nutella`, and slugging the prefix
 * would turn its colon into part of the slug (`xx-nutella`), which no brand carries.
 */
export function brandSlug(value: string): string {
  return tagIdOf(value.trim().replace(LANGUAGE_PREFIX, ''), true);
}

/**
 * The key of one brand, stored or given: its `brandSlug`, with sigma case-folded (`ς` → `σ`, as
 * Unicode case folding maps it). `brandSlug` lowercases one character at a time, so an all-caps
 * `ΌΛΥΜΠΟΣ` slugs to `όλυμποσ`, while `όλυμπος` typed in lowercase keeps its final `ς`; both key as
 * `όλυμποσ`. `xx:Красный Октябрь`, `xx:красный-октябрь`, and `красный-октябрь` key alike. A key
 * carries no language prefix, and the key of a key is itself. Empty when the value slugs to
 * nothing (`™`, whitespace), which names no brand.
 */
export function brandKey(value: string): string {
  return brandSlug(value).replace(/ς/g, 'σ');
}

/** Each key `BRAND_SYNONYM_GROUPS` lists, to the whole group it belongs to. */
const SYNONYM_GROUP_OF: ReadonlyMap<string, readonly string[]> = new Map(
  BRAND_SYNONYM_GROUPS.flatMap((line) => {
    const group = line.split(' ');
    return group.map((key): [string, readonly string[]] => [key, group]);
  }),
);

/**
 * Every key a brand can be stored under: `brandKey(value)` first, then, when that key is a name of
 * a `taxonomies/brands.txt` entry, the key of each of the entry's names, its canonical ID's first
 * (`7-Up` → `7-up`, `7up`, `seven-up`; `Andechser` → `andechser`, `andechser-natur`). A brand in
 * no entry has its own key alone (`nutell` → `nutell`): an entry matches a whole key, never a
 * substring. Empty when the value slugs to nothing.
 */
export function brandKeys(value: string): readonly string[] {
  const key = brandKey(value);
  if (key === '') return [];
  const group = SYNONYM_GROUP_OF.get(key);
  return group ? [key, ...group.filter((other) => other !== key)] : [key];
}
