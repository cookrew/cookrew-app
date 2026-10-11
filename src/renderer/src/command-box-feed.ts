// WHAT THE BOX DOES WITHOUT A DOM (round 2): when it holds the inbox open in
// main, and what Enter means while a decision is held. Pure, so the tests
// own both without jsdom; CommandBox.tsx only calls them.

import type { Decision } from '../../main/sous-control'

/** The list is held open only while somebody can see it: the open desktop box, or the phone bar, which is always there. */
export function holdsInbox(input: { open: boolean; phone: boolean }): boolean {
  return input.phone || input.open
}

export interface InboxApi {
  onInbox?: (cb: (rows: unknown[]) => void) => () => void
  inbox?: () => Promise<unknown[]>
}

/**
 * One subscription at a time, paired: attach while held, detach when not —
 * never two holds for one box, never a dangling one. A bridge without a
 * subscription falls back to a single read.
 */
export function createInboxFeed(api: InboxApi, onRows: (rows: unknown[]) => void): { attach: () => void; detach: () => void; attached: () => boolean } {
  let off: (() => void) | null = null
  let attached = false
  return {
    attach: () => {
      if (attached) return
      attached = true
      const sub = api.onInbox?.((rows) => attached && onRows(rows))
      if (sub) off = sub
      else void api.inbox?.().then((rows) => attached && onRows(rows)).catch(() => undefined)
    },
    detach: () => {
      if (!attached) return
      attached = false
      off?.()
      off = null
    },
    attached: () => attached
  }
}

/**
 * Enter while a decision is held: the same sentence commits it; a different
 * one is a new brief — the held decision is cancelled and the text submitted.
 */
export function enterDuringHold(text: string, decision: Decision): 'commit' | 'resubmit' {
  return text.trim() === decision.sentence.trim() ? 'commit' : 'resubmit'
}
