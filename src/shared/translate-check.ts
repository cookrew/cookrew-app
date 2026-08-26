// Did the model actually translate, or hand the text back?
//
// This is the failure that survives every other check. An untranslated echo is
// a well-formed string of the right length in the right shape — sanitize is
// happy with it, the transcript renders it, and it is marked as a translation.
// The reader sees English under a banner that says 简体中文 and has no way to
// know which part of that is a lie.

import { languageByCode } from './translate'

/**
 * Ranges that make a script identifiable. Only scripts that CANNOT be confused
 * with the Latin transcript we are translating from — asking for Japanese and
 * getting no kana or kanji back is decisive; asking for Spanish and getting
 * Latin letters back tells us nothing at all.
 */
const SCRIPTS: Record<string, RegExp> = {
  'zh-Hans': /[一-鿿]/,
  'zh-Hant': /[一-鿿]/,
  ja: /[぀-ヿ一-鿿]/,
  ko: /[가-힯ᄀ-ᇿ]/,
  th: /[฀-๿]/,
  hi: /[ऀ-ॿ]/,
  ar: /[؀-ۿ]/,
  ru: /[Ѐ-ӿ]/
}

/**
 * Enough prose that an untranslated answer is meaningful. A short piece can
 * legitimately come back unchanged — a heading that is a bare identifier, a
 * line that is one file path — and flagging those would report a working
 * translation as broken.
 */
const MIN_LETTERS = 40

function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length
}

/**
 * True when the answer is evidently NOT in the requested language.
 *
 * Deliberately one-directional. It reports "certainly not translated", never
 * "certainly translated": for a Latin-script target there is no signal to be
 * had, so those always return false rather than guessing. A check that is only
 * sometimes able to speak is worth having as long as it never speaks wrongly.
 */
export function looksUntranslated(source: string, output: string, languageCode: string): boolean {
  if (!languageByCode(languageCode)) return false
  const script = SCRIPTS[languageCode]
  if (!script) return false
  if (letterCount(source) < MIN_LETTERS) return false
  if (script.test(output)) return false
  // No character of the target script anywhere in an answer long enough to
  // have needed one.
  return true
}
