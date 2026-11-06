/**
 * WHAT WAITS TO GO UP A SLOW LINE (path/bridge-socket.ts).
 *
 * Over the relay a POST takes a round trip to cookrew.dev and on to the Mac, and
 * a finger makes sixty positions a second. So what is still waiting is folded:
 * a position is absolute, so the newest stands for the ones before it, and a
 * wheel's deltas add up, so no distance is lost. Nothing folds across a press or
 * a release, and only what has not left yet folds at all: a batch already sent
 * keeps its numbers, because it may be sent again.
 *
 * After a dropped line the question is the opposite one: what is too old to
 * deliver. A tap aimed at a page from twenty seconds ago must not land on what is
 * there now, and neither must the words typed after it, which were meant for the
 * field it would have focused. Every release goes, or a finger stays down in Chrome.
 *
 * Pure. Messages are the socket's own text.
 */

/** A press older than this is aimed at a picture that has moved on. */
export const BRIDGE_INPUT_STALE_MS = 3000
/** A press made this long after the line last said anything was aimed at a stale picture. */
const BLIND_MS = 1500

export interface OutboxItem {
  readonly text: string
  /** When it was sent, by the caller's clock. */
  readonly at: number
}

type Message = Record<string, unknown>

const read = (text: string): Message | null => {
  if (!text.startsWith('{"t":')) return null
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? (value as Message) : null
  } catch {
    return null
  }
}

const sameFingers = (a: Message, b: Message): boolean => {
  const count = (m: Message): number => (Array.isArray(m.points) ? m.points.length : 1)
  return count(a) === count(b)
}

const num = (value: unknown, otherwise: number): number => (typeof value === 'number' ? value : otherwise)

/** The two as one message, or null when they must both go. */
export function coalesceInput(waiting: string, next: string): string | null {
  const a = read(waiting)
  const b = read(next)
  if (!a || !b || a.t !== b.t) return null
  switch (a.t) {
    case 'move':
      return a.buttons === b.buttons && a.mods === b.mods ? next : null
    case 'touchmove':
      return sameFingers(a, b) ? next : null
    case 'compose':
      return next
    case 'wheel':
      if (a.mods !== b.mods) return null
      return JSON.stringify({ ...b, dy: num(a.dy, 0) + num(b.dy, 0), dx: num(a.dx, 0) + num(b.dx, 0) })
    case 'pinch':
      return JSON.stringify({ ...b, scale: num(a.scale, 1) * num(b.scale, 1) })
    default:
      return null
  }
}

const AIMED = new Set(['tap', 'down', 'move', 'wheel', 'pinch', 'touchstart', 'touchmove'])

const TYPED = new Set(['key', 'text', 'paste', 'compose'])

/** Aimed at something: a press lands where the picture was. */
export const aimedInput = (text: string): boolean => {
  const message = read(text)
  return message !== null && AIMED.has(message.t as string)
}

export function staleInput(text: string, at: number, now: number): boolean {
  return now - at > BRIDGE_INPUT_STALE_MS && aimedInput(text)
}

export interface StaleCheck {
  readonly now: number
  /** A press was dropped and nothing has been aimed since: typing has no known target. */
  readonly keysHeld?: boolean
  /** When the line last said anything before it went down. */
  readonly heardAt?: number
  /** When it came back; absent while it is still down. */
  readonly until?: number
}

const blind = (at: number, check: StaleCheck): boolean =>
  check.heardAt !== undefined && at - check.heardAt > BLIND_MS && (check.until === undefined || at <= check.until)

/** A batch keeps its length: its numbers are already spent. A blank is skipped at the Mac. */
export function stripStale(batch: readonly OutboxItem[], check: StaleCheck): { items: OutboxItem[]; keysHeld: boolean } {
  let keysHeld = check.keysHeld ?? false
  const items = batch.map((item) => {
    if (aimedInput(item.text)) {
      keysHeld = staleInput(item.text, item.at, check.now) || blind(item.at, check)
      return keysHeld ? { ...item, text: '' } : item
    }
    const message = read(item.text)
    return keysHeld && message !== null && TYPED.has(message.t as string) ? { ...item, text: '' } : item
  })
  return { items, keysHeld }
}
