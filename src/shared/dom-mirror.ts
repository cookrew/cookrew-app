/**
 * A PAGE'S STRUCTURE, FOR A DEVICE TO DRAW (owner, 2026-11-23: "no pixel feel").
 *
 * A viewer of a browser card today watches pixels and presses at coordinates.
 * That is what a remote desktop feels like. This is the other half of the
 * answer: what a page IS, sent as data, so a device can lay it out itself and
 * act on elements by identity rather than by position.
 *
 * WHAT TRAVELS is a list of blocks in reading order — a heading, a paragraph, a
 * link, a button, a field — each with the ref of the element it came from. The
 * device draws that list natively: local scrolling, local text selection, no
 * frame stream. Tapping a link or button sends its ref back, and the computer
 * on the other end clicks THAT element.
 *
 * WHAT DOES NOT TRAVEL: scripts, event attributes, stylesheets, embedded
 * frames, and any address that could run code. A page is data here, never a
 * program: a mirror that could execute would hand the viewer's device whatever
 * the page wanted to run. A link's address is kept as data only and is never
 * followed from the device.
 *
 * PIXELS REMAIN THE FALLBACK. A canvas, a video, a page whose meaning lives in
 * an image: the mirror says so (`pixelOnly`) and the viewer keeps the stream it
 * already had.
 */

export type MirrorRole =
  | 'heading'
  | 'paragraph'
  | 'link'
  | 'button'
  | 'field'
  | 'checkbox'
  | 'select'
  | 'listitem'
  | 'image'
  | 'separator'

export interface MirrorBlock {
  /** The element this block came from, opaque to the viewer. */
  readonly ref: number
  readonly role: MirrorRole
  /** What it says, as one line (whitespace collapsed, length capped here). */
  readonly text: string
  /** A link's address, kept as data: shown under the text, never followed here. */
  readonly href?: string
  /** `field`/`select`: what the field holds, or its placeholder. */
  readonly value?: string
  readonly level?: number
  readonly disabled?: boolean
  readonly checked?: boolean
}

export interface MirrorPage {
  readonly url: string
  readonly title: string
  readonly blocks: readonly MirrorBlock[]
  /** Some of the page was left out (too long, or content the mirror cannot carry). */
  readonly truncated: boolean
  /** Meaning lives in pixels here: the viewer should keep streaming the screen. */
  readonly pixelOnly: boolean
}

/** One block's text never grows past this: a mirror is for reading, not archiving. */
export const MIRROR_TEXT_MAX = 4_000
/** A page's mirror stops after this many blocks, and says it did. */
export const MIRROR_BLOCKS_MAX = 1_500

const SPACE = /\s+/g

/** One line of text, as a person would read it. */
export function mirrorText(raw: string): string {
  const flat = raw.replace(SPACE, ' ').trim()
  return flat.length > MIRROR_TEXT_MAX ? `${flat.slice(0, MIRROR_TEXT_MAX)}…` : flat
}

/** Frames and canvases carry meaning the mirror cannot: the screen stays the source. */
const PIXEL_TAGS: ReadonlySet<string> = new Set(['canvas', 'video', 'iframe', 'embed', 'object'])
export const pixelOnlyPage = (tags: readonly string[]): boolean => tags.some((tag) => PIXEL_TAGS.has(tag.toLowerCase()))

/** A link is data here: anything that could run code is not an address we keep. */
export function safeHref(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value === '' || value.startsWith('#')) return undefined
  if (/^\s*(javascript|data|vbscript):/i.test(value)) return undefined
  return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value
}

/**
 * In reading order, dropping what cannot be carried and anything that says
 * nothing. A control with no label is still kept: it can be pressed.
 */
export function mirrorBlocks(blocks: readonly MirrorBlock[]): { blocks: MirrorBlock[]; truncated: boolean } {
  const kept: MirrorBlock[] = []
  let truncated = false
  for (const block of blocks) {
    if (kept.length >= MIRROR_BLOCKS_MAX) {
      truncated = true
      break
    }
    const text = mirrorText(block.text)
    const control = block.role === 'field' || block.role === 'select' || block.role === 'checkbox' || block.role === 'button'
    if (text === '' && block.role !== 'separator' && !control) continue
    const href = block.href === undefined ? undefined : safeHref(block.href)
    kept.push({
      ...block,
      text,
      ...(href === undefined ? { href: undefined } : { href })
    })
  }
  return { blocks: kept, truncated }
}
