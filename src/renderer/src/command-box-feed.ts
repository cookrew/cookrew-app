// WHAT THE BOX DOES WITHOUT A DOM (round 2): when it holds the inbox open in
// main, and what Enter means while a decision is held. Pure, so the tests
// own both without jsdom; CommandBox.tsx only calls them.

import type { Decision } from '../../main/sous-control'

/** The list is held open only while somebody can see it: the open desktop box, or the phone bar, which is always there. */
export function holdsInbox(input: { open: boolean; phone: boolean }): boolean {
  return input.open
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

/**
 * HP · A LATE REVISION may only APPEND alternates to a minted decision — never
 * change its target, mode or brief. Appending is by id, so a revision that
 * repeats what the box already shows changes nothing.
 */
export function appendAlternates<A extends { id: string }>(existing: readonly A[], incoming: readonly A[]): A[] {
  const seen = new Set(existing.map((a) => a.id))
  const fresh = incoming.filter((a) => !seen.has(a.id))
  return fresh.length === 0 ? [...existing] : [...existing, ...fresh]
}

/** Is this frame off the wire a revision? A stream is untrusted input like any other. */
export function isDecisionUpdate(value: unknown): value is { token: string; alternates: { id: string }[] } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.token === 'string' && Array.isArray(v.alternates) && v.alternates.every((a) => typeof a === 'object' && a !== null && typeof (a as { id?: unknown }).id === 'string')
}

/**
 * HP · DRAFT HYGIENE. Closing the box clears the field; reopening starts
 * empty. A field that is NOT empty when the box opens (the phone bar never
 * closes; a sentence typed while the box was hidden) is a draft from earlier,
 * and the box says so with a chip rather than sending it by surprise.
 */
export function draftOnOpen(text: string): boolean {
  return text.trim().length > 0
}

/** What a `sous` row offers: the act main named, and DISMISS when main allows it. */
export function sousRowActions(row: { kind: string; action?: 'retry' | 'open' | null; dismissable?: boolean }): { act: 'retry' | 'open' | null; dismiss: boolean } {
  if (row.kind !== 'sous') return { act: null, dismiss: row.dismissable === true }
  return { act: row.action ?? null, dismiss: row.dismissable !== false }
}

/** The id a row is acted on by: main's row id, else the card (an older main keyed rows by card). */
export function inboxRowId(row: { id?: string; nodeId: string }): string {
  return row.id ?? row.nodeId
}
