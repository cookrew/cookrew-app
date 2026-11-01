/**
 * WHO THE GLOBAL PROMPT TALKS TO (owner, 2026-11-01): the agent whose full
 * view is showing, else the agent whose card is open; with neither, nobody —
 * and a prompt to nobody makes a new agent. A leading "@Name" picks an agent
 * by name instead.
 */

export interface TargetZoom {
  readonly dir: 'agents' | 'items'
  readonly v: number
  readonly agent: string | null
}

/** The card stop is v = 2 on the agent side (zoom-path.ts); past halfway to it, a card is open. */
const CARD_FROM = 1.5

export function promptTargetOf({ zoom, fullAgentId }: { zoom: TargetZoom; fullAgentId: string | null }): string | null {
  if (fullAgentId) return fullAgentId
  if (zoom.dir === 'agents' && zoom.agent && zoom.v >= CARD_FROM) return zoom.agent
  return null
}

/** What the view shows, as one key: an agent's card and its full view are two views. */
export function viewKeyOf(fullAgentId: string | null, cardAgent: string | null): string {
  return `${fullAgentId ?? ''}|${cardAgent ?? ''}`
}

/**
 * WHO THE BOX CARRIES (owner, 2026-11-01): the agent the view shows, unless
 * the box is pinned — by words showing in it, or by the ear while it listens —
 * so a view that moves on (a waiting agent taking the stage) never carries
 * them off. A release (× or Backspace on an empty box) lets go of the viewed
 * agent only while the view stays put: stepping into any agent's card or full
 * view brings @agent back.
 */
export function boxTargetId({
  viewed,
  viewKey,
  pin,
  released,
  known
}: {
  viewed: string | null
  viewKey: string
  pin: { id: string | null } | null
  /** The view the box was let go in, if any. */
  released: string | null
  known: (id: string) => boolean
}): string | null {
  const id = pin && (pin.id === null || known(pin.id)) ? pin.id : viewed
  return id !== null && id === viewed && released === viewKey ? null : id
}

/** What pins the box: the ear while it listens, else the focused box's agent while words show in it. */
export function boxPin(aim: { id: string | null } | null, held: { id: string | null } | null, heldWords: string): { id: string | null } | null {
  return aim ?? (held && heldWords !== '' ? held : null)
}

/**
 * The focused box's hold, kept on whoever it carries while it shows no words
 * (or holds an agent that is gone): the words typed next stay with them.
 */
export function heldAfter(
  held: { id: string | null } | null,
  { boxId, heldWords, known }: { boxId: string | null; heldWords: string; known: (id: string) => boolean }
): { id: string | null } | null {
  if (!held || held.id === boxId) return held
  return heldWords === '' || (held.id !== null && !known(held.id)) ? { id: boxId } : held
}

/** "@Name the rest": the named agent and the rest of the words; null when nothing matches. */
export function mentionTarget(text: string, agents: readonly { id: string; name: string }[]): { id: string; text: string } | null {
  const raw = text.trimStart()
  if (!raw.startsWith('@')) return null
  const body = raw.slice(1)
  const longestFirst = [...agents].sort((a, b) => b.name.length - a.name.length)
  for (const agent of longestFirst) {
    const name = agent.name.trim()
    if (!name || body.slice(0, name.length).toLowerCase() !== name.toLowerCase()) continue
    const after = body.charAt(name.length)
    if (after !== '' && !/\s/u.test(after)) continue
    return { id: agent.id, text: body.slice(name.length).trim() }
  }
  return null
}
