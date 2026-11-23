import type { MirrorPage } from '../shared/dom-mirror'
import type { ViewerWho } from '../shared/remote-access'
import type { BrowserInstance } from './browser-instance'
import type { MirrorAct, MirrorCommand } from './dom-mirror'

/**
 * A MIRROR ON THE CAST LINE (main/cast-mirror.ts).
 *
 * Owner ruling, 2026-11-23: a browser card seen from another device is drawn
 * from data on that device by default; the screen stream is a mode the viewer
 * picks. Two messages ride the viewer's cast line for it, and neither carries
 * a point on the page, so neither waits on a painted frame:
 *
 *   {t:'dom'}                     → {t:'dom', page}
 *   {t:'dom-act', ref, act, value?} → {t:'dom', page} after acting, or
 *                                     {t:'dom-refused', why, stage}
 *
 * What a viewer may say is reduced here to a ref (a positive integer), one of
 * four verbs, and text to type. Any other field it sends is never read: no
 * method, selector, expression or function reaches the page from a viewer.
 */

const ACTS: ReadonlySet<string> = new Set<MirrorAct>(['press', 'focus', 'type', 'check'])

/** Text typed into one field in one go: a paragraph, not a file. */
export const MIRROR_TYPE_MAX = 10_000
/** A page's reply never grows past this on the line; past it, blocks are cut and the page says so. */
export const MIRROR_REPLY_MAX_BYTES = 1_000_000

export type MirrorRequest =
  | { readonly kind: 'read' }
  /** `command` is null when the message named no usable ref, verb or text: refused, never guessed. */
  | { readonly kind: 'act'; readonly command: MirrorCommand | null }

export type MirrorStage = 'read' | 'act'

export type MirrorReply =
  | { readonly t: 'dom'; readonly page: MirrorPage }
  | { readonly t: 'dom-refused'; readonly why: string; readonly stage: MirrorStage }

const refused = (why: string, stage: MirrorStage): MirrorReply => ({ t: 'dom-refused', why, stage })

/** A viewer's mirror message as what it may say, or null when it is not one. */
export function mirrorRequest(raw: unknown): MirrorRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as Record<string, unknown>
  if (msg.t === 'dom') return { kind: 'read' }
  if (msg.t !== 'dom-act') return null
  const { ref, act, value } = msg
  if (typeof ref !== 'number' || !Number.isInteger(ref) || ref <= 0) return { kind: 'act', command: null }
  if (typeof act !== 'string' || !ACTS.has(act)) return { kind: 'act', command: null }
  if (act !== 'type') return { kind: 'act', command: { ref, act: act as MirrorAct } }
  if (typeof value !== 'string' || value.length > MIRROR_TYPE_MAX) return { kind: 'act', command: null }
  return { kind: 'act', command: { ref, act: 'type', value } }
}

/**
 * May this viewer act on the page right now? The input path's own rule: a
 * card that guards control asks it (mayDrive), and nobody's hand goes in while
 * an agent holds the page.
 */
export function refusalToAct(instance: BrowserInstance, who: ViewerWho): string | null {
  if (instance.mayDrive && !instance.mayDrive(who)) return 'Take control of this card first.'
  if (instance.viewportState.agentHeld) return 'An agent is using this page right now.'
  return null
}

/** The page within the line's budget: blocks from the end go first, and the page says it was cut. */
export function fitPage(page: MirrorPage, maxBytes: number = MIRROR_REPLY_MAX_BYTES): MirrorPage {
  let fitted = page
  let size = Buffer.byteLength(JSON.stringify(fitted))
  while (size > maxBytes && fitted.blocks.length > 0) {
    const count = fitted.blocks.length
    const keep = Math.min(count - 1, Math.floor(count * (maxBytes / size) * 0.95))
    fitted = { ...page, blocks: page.blocks.slice(0, Math.max(0, keep)), truncated: true }
    size = Buffer.byteLength(JSON.stringify(fitted))
  }
  return fitted
}

async function readPage(instance: BrowserInstance): Promise<MirrorReply> {
  if (!instance.mirrorPage) return refused('This card has no page to read.', 'read')
  try {
    const info = await instance.pageInfo().catch(() => null)
    const page = await instance.mirrorPage(info?.url ?? '', info?.title ?? '')
    return { t: 'dom', page: fitPage(page) }
  } catch {
    return refused('The page could not be read just now.', 'read')
  }
}

/** One mirror request answered. Never throws: every failure is a sentence for the viewer. */
export async function answerMirror(instance: BrowserInstance, request: MirrorRequest, who: ViewerWho): Promise<MirrorReply> {
  if (request.kind === 'read') return readPage(instance)
  if (request.command === null) return refused('That is not something the page can do.', 'act')
  const why = refusalToAct(instance, who)
  if (why !== null) return refused(why, 'act')
  if (!instance.actMirror) return refused('This card has no page to act on.', 'act')
  const done = await instance.actMirror(request.command).catch(() => ({ ok: false as const, why: 'The page did not answer.' }))
  if (!done.ok) return refused(done.why, 'act')
  return readPage(instance)
}
