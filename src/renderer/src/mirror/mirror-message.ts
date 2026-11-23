import {
  MIRROR_BLOCKS_MAX,
  MIRROR_TEXT_MAX,
  safeHref,
  type MirrorBlock,
  type MirrorPage,
  type MirrorRole
} from '../../../shared/dom-mirror'

/**
 * THE MIRROR'S MESSAGES, AS THIS DEVICE READS THEM (mirror/mirror-message.ts).
 *
 * A page arrives over a line from another machine, so it is read as untrusted
 * data: every field is checked, text is capped, and a link's address goes
 * through `safeHref` again. Nothing here is ever turned into markup — the view
 * draws these strings as text (MirrorView.tsx).
 */

export type MirrorAct = 'press' | 'focus' | 'type' | 'check'
export type MirrorStage = 'read' | 'act'

export type MirrorMessage =
  | { readonly kind: 'dom'; readonly page: MirrorPage }
  | { readonly kind: 'dom-refused'; readonly why: string; readonly stage: MirrorStage }

const ROLES: ReadonlySet<string> = new Set<MirrorRole>([
  'heading',
  'paragraph',
  'link',
  'button',
  'field',
  'checkbox',
  'select',
  'listitem',
  'image',
  'separator'
])

const WHY_MAX = 300

const record = (raw: unknown): Record<string, unknown> | null =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null

const capped = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? (value.length > max ? `${value.slice(0, max)}…` : value) : null

function parseBlock(raw: unknown): MirrorBlock | null {
  const obj = record(raw)
  if (!obj) return null
  const { ref, role, level } = obj
  if (typeof ref !== 'number' || !Number.isInteger(ref) || ref <= 0) return null
  if (typeof role !== 'string' || !ROLES.has(role)) return null
  const text = capped(obj.text, MIRROR_TEXT_MAX) ?? ''
  const href = typeof obj.href === 'string' ? safeHref(obj.href) : undefined
  const value = capped(obj.value, MIRROR_TEXT_MAX)
  return {
    ref,
    role: role as MirrorRole,
    text,
    ...(href !== undefined ? { href } : {}),
    ...(value !== null ? { value } : {}),
    ...(typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6 ? { level } : {}),
    ...(obj.disabled === true ? { disabled: true } : {}),
    ...(obj.checked === true ? { checked: true } : {})
  }
}

/** A page as this device will draw it, or null when it is not one. */
export function parseMirrorPage(raw: unknown): MirrorPage | null {
  const obj = record(raw)
  if (!obj || !Array.isArray(obj.blocks)) return null
  const blocks = obj.blocks
    .slice(0, MIRROR_BLOCKS_MAX)
    .map(parseBlock)
    .filter((block): block is MirrorBlock => block !== null)
  return {
    url: capped(obj.url, 2_000) ?? '',
    title: capped(obj.title, 500) ?? '',
    blocks,
    truncated: obj.truncated === true || obj.blocks.length > MIRROR_BLOCKS_MAX,
    pixelOnly: obj.pixelOnly === true
  }
}

/** A `dom` or `dom-refused` message off the cast line, or null for anything else. */
export function parseMirrorMessage(raw: unknown): MirrorMessage | null {
  const obj = record(raw)
  if (!obj) return null
  if (obj.t === 'dom') {
    const page = parseMirrorPage(obj.page)
    return page ? { kind: 'dom', page } : null
  }
  if (obj.t === 'dom-refused') {
    const why = capped(obj.why, WHY_MAX) ?? 'The page refused that.'
    return { kind: 'dom-refused', why, stage: obj.stage === 'act' ? 'act' : 'read' }
  }
  return null
}

/** What this device sends: a read, or one verb on one ref. Nothing else exists to send. */
export const readMsg = (): { t: 'dom' } => ({ t: 'dom' })

export function actMsg(ref: number, act: MirrorAct, value?: string): { t: 'dom-act'; ref: number; act: MirrorAct; value?: string } {
  return act === 'type' ? { t: 'dom-act', ref, act, value: value ?? '' } : { t: 'dom-act', ref, act }
}

/** A mirror line asks the computer to hold its frames: this view draws none. */
export const framesOffMsg = (): { t: 'frames'; on: false } => ({ t: 'frames', on: false })
