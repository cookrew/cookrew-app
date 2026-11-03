'use strict'

/**
 * ENGLISH WORDS THE KOKORO VOICE CAN SAY (kokoro-server.cjs).
 *
 * Kokoro reads English only through its lexicon, and silently SKIPS any word
 * it lacks: "merged into dev" came out as "merged into". Agent replies are
 * full of such words (identifiers, acronyms, tool names), so each one is
 * turned into words the lexicon has before it reaches the model:
 *
 *   PromptExtras -> prompt extras      (camelCase split)
 *   API, CDP     -> a p i, c d p       (short capitals spelled)
 *   worktree     -> work tree          (split into known words)
 *   dev, tmux    -> dev, tmux          (the SUPPLEMENT lexicon below)
 *   xq           -> x q                (short unknowns spelled)
 *
 * A longer word that none of these reach is left as it is (the model skips it).
 */

/** Words Kokoro's lexicon lacks that agent replies use, in its own phoneme tokens. */
const SUPPLEMENT = {
  dev: 'd ˈ ɛ v',
  config: 'k ˈ ɑ n f ɪ ɡ',
  json: 'ʤ ˈ A s ə n',
  cookrew: 'k ˈ ʊ k ɹ u',
  vite: 'v ˈ i t',
  tmux: 't ˈ i m ʌ k s',
  herdr: 'h ˈ ɜ ɹ d ə ɹ',
  todo: 't ˈ u d u',
  repo: 'ɹ ˈ i p O',
  npm: 'ˌ ɛ n p ˌ i ˈ ɛ m'
}

/** SUPPLEMENT as lexicon lines, for the file passed to the model beside its own. */
function supplementLexicon() {
  return Object.entries(SUPPLEMENT)
    .map(([word, phones]) => `${word} ${phones}`)
    .join('\n') + '\n'
}

const SPELL_MAX = 4
const ACRONYM_MAX = 6

function spell(word) {
  return word.toLowerCase().split('').join(' ')
}

/** `word` as known parts, longest first, or null. Parts are at least 2 letters. */
function segment(word, known) {
  if (word.length < 4) return null
  const memo = new Map()
  const from = (start) => {
    if (start === word.length) return []
    if (memo.has(start)) return memo.get(start)
    let found = null
    for (let end = word.length; end >= start + 2 && !found; end -= 1) {
      const part = word.slice(start, end)
      if (!known(part)) continue
      const rest = from(end)
      if (rest) found = [part, ...rest]
    }
    memo.set(start, found)
    return found
  }
  const parts = from(0)
  return parts && parts.length > 1 ? parts : null
}

/** One run of letters as words the lexicon has. */
function sayable(token, known) {
  const lower = token.toLowerCase()
  if (/^[A-Z]{2,}$/.test(token) && token.length <= ACRONYM_MAX && !known(lower) && !(lower in SUPPLEMENT)) return spell(token)
  if (known(lower) || lower in SUPPLEMENT) return lower
  const parts = segment(lower, (w) => known(w) || w in SUPPLEMENT)
  if (parts) return parts.join(' ')
  if (lower.length <= SPELL_MAX) return spell(lower)
  return lower
}

/**
 * The text with every English word made sayable; everything else (Chinese,
 * digits, punctuation) untouched. `known(word)` asks the lexicon (lowercase).
 */
function sayableText(text, known) {
  return text.replace(/[A-Za-z]+(?:'[a-z]+)?/g, (run) => {
    if (run.includes("'")) return known(run.toLowerCase()) ? run.toLowerCase() : run
    // camelCase and PascalCase split, an acronym kept whole: "HTTPServer" -> HTTP Server
    const pieces = run.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) || [run]
    return pieces.map((piece) => sayable(piece, known)).join(' ')
  })
}

module.exports = { SUPPLEMENT, supplementLexicon, sayableText }
