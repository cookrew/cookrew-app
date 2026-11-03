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

/**
 * Four kinds, and the DIRECTION is always `from` → `to`:
 *  - `ask`     an agent's question, agent → agent
 *  - `answer`  the reply, back the other way
 *  - `write`   an agent putting something INTO a card it is wired to — a note
 *              written or edited, a browser driven (navigate, click, type …)
 *  - `read`    an agent taking something OUT of a card — a note read, a page's
 *              text or snapshot — so the pulse runs card → agent
 * A verb on a card the agent has no cable to lights nothing: the renderer only
 * draws on a link that exists, and a signal rides a cable or it is not drawn.
 */
export type CableSignalKind = 'ask' | 'answer' | 'write' | 'read'

export interface CableSignal {
  from: string
  to: string
  kind: CableSignalKind
  /** Epoch ms, stamped where the signal is minted. Expiry is counted from it. */
  at: number
}

const KINDS: ReadonlySet<string> = new Set<CableSignalKind>(['ask', 'answer', 'write', 'read'])

/**
 * Which way a `cookrew note …` verb moves. `create` makes the card AND the
 * cable in one step and announces itself; `delete` removes the cable's end.
 * Neither is traffic on a cable, so neither lights one.
 */
export function noteVerbKind(verb: string): Extract<CableSignalKind, 'write' | 'read'> | null {
  switch (verb) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'write'
    default:
      return null
  }
}

/**
 * Which way a `cookrew browser …` verb moves: driving the page is input
 * (agent → browser), taking the page's words or picture is output
 * (browser → agent). `create` is a new card with a new cable; unknown verbs
 * and `create` light nothing.
 */
export function browserVerbKind(verb: string): Extract<CableSignalKind, 'write' | 'read'> | null {
  switch (verb) {
    case 'navigate':
    case 'click':
    case 'fill':
    case 'type':
    case 'key':
    case 'scroll':
    case 'evaluate':
      return 'write'
    case 'text':
    case 'html':
    case 'snapshot':
    case 'info':
      return 'read'
    default:
      return null
  }
}

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
