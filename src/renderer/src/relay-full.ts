/**
 * THE RELAY IS FULL. cookrew.dev carries sixteen exchanges per desktop, and a
 * seventeenth is refused `too_many_exchanges` before it is framed for the Mac
 * (registry/src/v2-canvas-relay.ts · open).
 *
 * It shows up while the Mac is not answering: measured 2026-11-05 on a machine
 * deep in swap, the same exchanges held every slot for 18 s and then drained
 * together. A READ waits that out. A WRITE does not: it never reached the Mac,
 * but asked again it could land after a newer write and undo it, so the person
 * who made it is told instead, in words rather than the raw code.
 */
import { retry } from './retry'

/** The relay's refusal, as `error` in its 503 body. */
export const RELAY_FULL = 'too_many_exchanges'

/** Five tries over 15 s: longer than most stalls, short enough to still be a tap. */
export const RELAY_FULL_WAITS_MS = [1000, 2000, 4000, 8000] as const

/** What a person reads when the waits run out. */
export const RELAY_FULL_WORDS = 'The Mac is not answering right now. Try again in a moment.'

export const isRelayFull = (error: unknown): boolean => {
  const failure = error as { status?: unknown; message?: unknown } | null
  return failure?.status === 503 && failure.message === RELAY_FULL
}

/** Run a read, asking again only while the relay says it is full. */
export const waitOutRelayFull = <T>(attempt: () => Promise<T>, sleep?: (ms: number) => Promise<void>): Promise<T> =>
  retry(attempt, { delaysMs: RELAY_FULL_WAITS_MS, retryable: isRelayFull, ...(sleep ? { sleep } : {}) })
