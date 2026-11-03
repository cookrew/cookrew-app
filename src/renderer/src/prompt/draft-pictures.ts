import { shellQuotePath } from '../../../shared/attach'
import { imageMimeOf, imagePathTokens } from '../../../shared/prompt-images'

/**
 * THE BOX SHOWS THE PICTURE, NOT ITS PATH (owner, 2026-11-02). A screenshot
 * in the prompt box is drawn as a thumbnail (pictures/PictureStrip.tsx); the
 * words in the box are only the words. The DRAFT still carries the path —
 * it is the agent's own input line (live-line.ts), and the path is how the
 * agent reads the file — at the end, after the words:
 *
 *   draft = words + ' ' + path path …     (no paths: just the words)
 *
 * so "@Other …" still leads the draft, and the box edits the words in front
 * of the pictures. A path elsewhere in a draft (typed in LIVE, say) is hidden
 * the same way, and moves to the end once the words are edited.
 */

/** The picture paths a draft carries, as written there (escaped), each once, in order. */
export function pictureTokens(text: string): string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const token of imagePathTokens(text)) {
    if (seen.has(token.path)) continue
    seen.add(token.path)
    tokens.push(text.slice(token.start, token.end))
  }
  return tokens
}

/** The words the box shows: the draft without its picture paths, and the space before each. */
export function shownWords(text: string): string {
  let out = text
  for (const token of [...imagePathTokens(text)].reverse()) {
    const before = token.start > 0 && /\s/u.test(out.charAt(token.start - 1))
    const after = !before && /\s/u.test(out.charAt(token.end))
    out = out.slice(0, before ? token.start - 1 : token.start) + out.slice(after ? token.end + 1 : token.end)
  }
  return out
}

/** The draft of `words` carrying `tokens`. shownWords gives `words` back exactly. */
export function draftOf(words: string, tokens: readonly string[]): string {
  if (tokens.length === 0) return words
  return `${words ? `${words} ` : ''}${tokens.join(' ')}`
}

/** The draft with the box's words replaced by `words`, its pictures kept. */
export const withShownWords = (text: string, words: string): string => draftOf(words, pictureTokens(text))

/** The draft with these saved paths added as pictures (a store that saved nothing hands back ''). */
export function withPictures(text: string, paths: readonly string[]): string {
  const saved = paths.filter((p) => p !== '').map(shellQuotePath)
  if (saved.length === 0) return text
  const tokens = pictureTokens(text)
  return draftOf(shownWords(text), [...tokens, ...saved.filter((t) => !tokens.includes(t))])
}

/**
 * The draft with these attached paths (the paperclip, a drop): pictures are
 * drawn (withPictures); any other file goes in as words at the end of the
 * box's words, each once, a space after it so the next word stands apart.
 */
export function withAttached(text: string, paths: readonly string[]): string {
  const saved = paths.filter((p) => p !== '')
  const files = saved.filter((p) => imageMimeOf(p) === null).map(shellQuotePath)
  const worded = files.reduce((draft, token) => {
    const words = shownWords(draft)
    if (words.split(/(?<!\\)\s+/u).includes(token)) return draft
    const gap = words === '' || /\s$/u.test(words) ? '' : ' '
    return withShownWords(draft, `${words}${gap}${token} `)
  }, text)
  return withPictures(worded, saved.filter((p) => imageMimeOf(p) !== null))
}

/** The draft without the picture at `path`. */
export function withoutPicture(text: string, path: string): string {
  const keep = pictureTokens(text).filter((token) => imagePathTokens(token)[0]?.path !== path)
  return draftOf(shownWords(text), keep)
}

/** The draft without its last picture (Backspace in a box that shows no words). */
export function withoutLastPicture(text: string): string {
  return draftOf(shownWords(text), pictureTokens(text).slice(0, -1))
}
