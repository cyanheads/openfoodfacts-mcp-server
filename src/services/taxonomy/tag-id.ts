/**
 * @fileoverview Product Opener's tag IDs, ported: the ID `get_string_id_for_lang`
 * (`lib/ProductOpener/Store.pm`) builds from text, under its default normalization or the
 * language-less `xx` one brands take, and the language prefix a tag value can carry. Pure text, no
 * service dependency, so the mirror's record builder can key brands without loading the API client.
 * @module services/taxonomy/tag-id
 */

/**
 * Characters Product Opener turns into `-` when it builds a tag ID from text
 * (`get_string_id_for_lang` in `lib/ProductOpener/Store.pm`): whitespace, control characters, the
 * zero-width space, ASCII punctuation, and a list of typographic symbols. Letters in every script
 * pass through.
 */
const TAG_ID_SEPARATORS =
  /[\s\p{Cc}​!"#$%&'()*+,/:;<=>?@[\\\]^_`{|}~¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼⅓½⅔¾¿×ˆ˜–—‘’‚“”„†‡•…‰‹›€™]/gu;

/**
 * The letters `get_string_id_for_lang` folds under the normalization it gives the language-less
 * `xx` (unaccent on), each to what it becomes, and no others: `ø`, `ł`, `đ`, `ĩ`, `ả`, Cyrillic
 * `ё`, and Greek `έ` keep their marks. A `Map`, since the text it is read for comes from the caller.
 */
const XX_LETTER_FOLDS: ReadonlyMap<string, string> = new Map([
  ...[...'àáâãäå'].map((letter): [string, string] => [letter, 'a']),
  ['ç', 'c'],
  ...[...'èéêë'].map((letter): [string, string] => [letter, 'e']),
  ...[...'ìíîï'].map((letter): [string, string] => [letter, 'i']),
  ['ñ', 'n'],
  ...[...'òóôõö'].map((letter): [string, string] => [letter, 'o']),
  ...[...'ùúûü'].map((letter): [string, string] => [letter, 'u']),
  ['ý', 'y'],
  ['ÿ', 'y'],
  // Romanian, comma-below and the legacy cedilla forms.
  ['ă', 'a'],
  ['ș', 's'],
  ['ț', 't'],
  ['ş', 's'],
  ['ţ', 't'],
  ['œ', 'oe'],
  ['æ', 'ae'],
  ['ß', 'ss'],
]);

/** Any letter `XX_LETTER_FOLDS` folds. */
const XX_FOLDED_LETTER = new RegExp(`[${[...XX_LETTER_FOLDS.keys()].join('')}]`, 'g');

/**
 * A tag ID as `get_string_id_for_lang` builds one from text: Unicode NFC, then lowercase one
 * character at a time as Perl's `lc` does, so a final capital sigma becomes `σ` rather than the
 * `ς` a whole-string `toLowerCase()` gives it (`ΟΛΥΜΠΟΣ` → `ολυμποσ`); `.` to `-`; under `xx`
 * (`foldLetters`) the letters `XX_LETTER_FOLDS` names folded; then every separator to `-`, dash
 * runs collapsed, and leading and trailing dashes dropped.
 */
export function tagIdOf(text: string, foldLetters: boolean): string {
  const lowered = Array.from(text.normalize('NFC'), (char) => char.toLowerCase())
    .join('')
    .replace(/\./g, '-');
  return (
    foldLetters
      ? lowered.replace(XX_FOLDED_LETTER, (letter) => XX_LETTER_FOLDS.get(letter) ?? letter)
      : lowered
  )
    .replace(TAG_ID_SEPARATORS, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** A language prefix on a taxonomy value: `en:`, `FR:`. */
export const LANGUAGE_PREFIX = /^([a-z]{2}):/i;
