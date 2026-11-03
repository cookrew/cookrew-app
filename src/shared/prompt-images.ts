/**
 * SCREENSHOTS IN A PROMPT, AS PICTURES (owner, 2026-11-01): a screenshot in
 * the prompt box, and in a turn's prompt in the CHAT and LOG views, is drawn
 * as the image itself, loaded only once it comes into view. LIVE is the
 * agent's own terminal and keeps its "[Image #N]".
 *
 * A prompt carries a picture two ways:
 *   · a PATH — what the prompt box puts in for a pasted or dropped
 *     screenshot (prompt-attach.ts): an absolute path to an image file,
 *     backslash-escaped the way a terminal drop is (attach.ts);
 *   · Claude Code's OWN paste — "[Image #N]" in the words, the bytes in an
 *     image block beside them in the session file (TraceImage).
 *
 * The pure parts, shared by the reader (main) and the views (renderer).
 */

/** The image files a prompt may name, by extension, and what each is served as. */
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

/** The MIME type of an image path, or null when it does not name an image. */
export function imageMimeOf(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.')
  if (dot < 0 || dot < filePath.lastIndexOf('/')) return null
  return IMAGE_MIME[filePath.slice(dot + 1).toLowerCase()] ?? null
}

/** One whitespace-delimited token: backslash escapes keep a space inside it. */
const TOKEN = /(?:\\.|[^\s\\])+/gu

const unescape = (token: string): string => token.replace(/\\(.)/gu, '$1')

/** Each absolute image path the text names, with where its token sits, in order. */
export function imagePathTokens(text: string): Array<{ path: string; start: number; end: number }> {
  const found: Array<{ path: string; start: number; end: number }> = []
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0]
    if (!token.startsWith('/')) continue
    const path = unescape(token)
    if (imageMimeOf(path) === null) continue
    const start = match.index ?? 0
    found.push({ path, start, end: start + token.length })
  }
  return found
}

/** The absolute image paths a prompt names, each once, in order. */
export function imagePathsIn(text: string): string[] {
  return [...new Set(imagePathTokens(text).map((t) => t.path))]
}

/** The text without `path` (every mention of it), and the one space that set it apart. */
export function withoutImagePath(text: string, path: string): string {
  let out = text
  for (const token of imagePathTokens(text).filter((t) => t.path === path).reverse()) {
    const end = /\s/u.test(out.charAt(token.end)) ? token.end + 1 : token.end
    const start = end === token.end && token.start > 0 && /\s/u.test(out.charAt(token.start - 1)) ? token.start - 1 : token.start
    out = out.slice(0, start) + out.slice(end)
  }
  return out
}

/**
 * One of Claude Code's own pasted images: the `i`-th image block of the
 * session record `uuid` (a prompt's own record, or a sibling of it), and the
 * N it showed as "[Image #N]" when Claude numbered it.
 */
export interface TraceImage {
  uuid: string
  i: number
  n?: number
}

/** Where a picture's bytes are: a path, or an image block in one of a card's session files. */
export type ImageRef =
  | { readonly path: string }
  | { readonly terminalId: string; readonly file: string; readonly uuid: string; readonly i: number }

/** One key per picture, for the views' cache. */
export const imageRefKey = (ref: ImageRef): string =>
  'path' in ref ? `path:${ref.path}` : `block:${ref.terminalId}:${ref.file}:${ref.uuid}:${ref.i}`

/** A picture's bytes, as both doors hand them over. */
export interface ImageBytes {
  mime: string
  bytes: Uint8Array
}

/** The largest picture either door hands over (the attach store's own cap). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
