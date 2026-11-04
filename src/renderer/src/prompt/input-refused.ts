/**
 * KEYS THE MAC WOULD NOT TAKE (a dispatch in flight answers a phone's /raw with
 * a 409). The keys are fire and forget and the box clears as it sends, so the
 * refusal has to come back here for the words not to vanish: GlobalPrompt puts
 * them back and says why, live-line.ts forgets what it thought it had typed.
 */

type Listener = (terminalId: string, data: string) => void

const listeners = new Set<Listener>()

export const inputRefused = {
  emit(terminalId: string, data: string): void {
    for (const listener of listeners) listener(terminalId, data)
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}

/** The last words the box let go of. */
export interface SentWords {
  readonly id: string
  /** The draft they came from. */
  readonly box: string
  readonly words: string
  readonly at: number
}

/** Longer than the refusal takes to come back over a slow link, shorter than the next thought. */
export const REFUSED_WINDOW_MS = 15_000

/**
 * The words a refusal gives back. Only a refused Enter speaks for them: their
 * keystrokes may go on being refused while the words are still being typed, and
 * an arrow refused later says nothing of words that went.
 */
export function wordsToRestore(sent: SentWords | null, terminalId: string, data: string, now: number): SentWords | null {
  const entered = /[\r\n]/.test(data)
  return entered && sent !== null && sent.id === terminalId && now - sent.at <= REFUSED_WINDOW_MS ? sent : null
}

let lastSent: SentWords | null = null

/** Words left the box by the keys (the box, a card's reply box). */
export function noteSent(sent: SentWords): void {
  lastSent = sent
}

/** The words this refusal gives back, once. */
export function takeRefused(terminalId: string, data: string, now: number): SentWords | null {
  const back = wordsToRestore(lastSent, terminalId, data, now)
  if (back) lastSent = null
  return back
}
