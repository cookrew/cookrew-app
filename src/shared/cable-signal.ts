/**
 * A SIGNAL ON A CABLE — one agent asked another, or answered.
 *
 * The smallest fact the canvas can draw as traffic: who sent, who received,
 * which of the two things it was, and when. Nothing per token and nothing
 * per tracker tick: a signal is minted once at the moment the prompt is in
 * the receiver's pane, and once at the moment the reply closes the exchange.
 *
 * `from` and `to` are CARD ids. Card ids are agent ids (the dispatch deps
 * say so: `sessionNameFor(agentId)` is "Cookrew's node id → the multiplexer's
 * session"), so the renderer finds the cable by the pair and never looks a
 * name up.
 *
 * Shared between main (minting, IPC and SSE) and the renderer (the feed that
 * lights the harness), so the wire shape cannot drift.
 */

export type CableSignalKind = 'ask' | 'answer'

export interface CableSignal {
  from: string
  to: string
  kind: CableSignalKind
  /** Epoch ms, stamped where the signal is minted. Expiry is counted from it. */
  at: number
}

const KINDS: ReadonlySet<string> = new Set<CableSignalKind>(['ask', 'answer'])

/** Is this frame off the wire a signal? A stream is untrusted input like any other. */
export function isCableSignal(value: unknown): value is CableSignal {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.from === 'string' &&
    v.from.length > 0 &&
    typeof v.to === 'string' &&
    v.to.length > 0 &&
    v.from !== v.to &&
    typeof v.kind === 'string' &&
    KINDS.has(v.kind) &&
    typeof v.at === 'number' &&
    Number.isFinite(v.at)
  )
}
