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
 * there now. What was typed still goes, and every release goes, or a finger stays
 * down in Chrome for good.
 *
 * Pure. Messages are the socket's own text.
 */

/** A press older than this is aimed at a picture that has moved on. */
export const BRIDGE_INPUT_STALE_MS = 3000

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

export function staleInput(text: string, at: number, now: number): boolean {
  if (now - at <= BRIDGE_INPUT_STALE_MS) return false
  const message = read(text)
  return message !== null && AIMED.has(message.t as string)
}

/** A batch keeps its length: its numbers are already spent. A blank is skipped at the Mac. */
export function stripStale(batch: readonly OutboxItem[], now: number): OutboxItem[] {
  return batch.map((item) => (staleInput(item.text, item.at, now) ? { ...item, text: '' } : item))
}
