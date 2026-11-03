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

/**
 * The view's DELIBERATE moves, as one key: a step, a side, a focused card, a
 * jump. Read off the zoom store, which only the owner's hand moves. The
 * agent a view SHOWS is derived (the stage's pick, the crew's rows) and can
 * blink to nobody and back with no hand on anything, so it is not what ends a
 * release (owner 2026-11-01: × did not let go of @agent).
 */
export function zoomMoveKey(zoom: TargetZoom & { readonly full?: string | null; readonly jump?: number }): string {
  return `${zoom.dir}|${zoom.v}|${zoom.agent ?? ''}|${zoom.full ?? ''}|${zoom.jump ?? 0}`
}

/**
 * WHO THE BOX CARRIES (owner, 2026-11-01): the agent the view shows, unless
 * the box is pinned — by words showing in it, or by the ear while it listens —
 * so a view that moves on (a waiting agent taking the stage) never carries
 * them off.
 *
 * A release (× or Backspace on an empty box) lets go of ONE AGENT, however the
 * box came to carry it: by the view, or by words held in a focused box. It
 * was once keyed to the view instead, and × then did nothing whenever words
 * held the box on an agent the view was not showing (a phone tap on × keeps
 * the box focused), and a view that blinked to nobody and back undid it.
 */
export function boxTargetId({
  viewed,
  pin,
  released,
  known,
  picked = null
}: {
  viewed: string | null
  pin: { id: string | null } | null
  /** The release, if any (releaseAfter says how long it lasts). */
  released: Release | null
  known: (id: string) => boolean
  /**
   * An agent picked on the face's who-picker (owner, 2026-11-04): it stands
   * in for the view's until the zoom's next deliberate move (zoomMoveKey).
   */
  picked?: string | null
}): string | null {
  const shown = picked !== null && known(picked) ? picked : viewed
  const id = pin && (pin.id === null || known(pin.id)) ? pin.id : shown
  return id !== null && id === released?.id ? null : id
}

/**
 * A PICK, AND HOW LONG IT LASTS: an agent chosen on the face's who-picker, or
 * the agent a prompt just made (owner task, 2026-11-04: "after a prompt makes
 * a new agent, the box follows it", so the next words are a follow-up). It
 * stands in for the view's agent while the zoom is where it was when the pick
 * was made (zoomMoveKey); the zoom's next deliberate move ends it. Keyed to
 * the move rather than reset by one: the make moves the zoom itself (to the
 * new agent's card), and a reset racing that move would drop the pick.
 */
export interface Pick {
  readonly id: string
  /** The zoom's move key when the pick was made. */
  readonly at: string
}

export function pickNow(pick: Pick | null, moveKey: string): string | null {
  return pick !== null && pick.at === moveKey ? pick.id : null
}

/** The pick kept through a move: dropped for good once the zoom has left where it was made. */
export function pickAfterMove(pick: Pick | null, moveKey: string): Pick | null {
  return pick !== null && pick.at !== moveKey ? null : pick
}

/** A let-go: the agent let go of, and who the view showed at that moment. */
export interface Release {
  readonly id: string
  readonly viewed: string | null
}

/**
 * How long a release lasts: until the view shows an agent it was NOT showing
 * when the release was made. Nobody on show (a blink) and the same agent back
 * keep it; the view already showing someone else (words held the box on
 * another agent) is no move either. Stepping into any card or full view ends
 * it outright through the zoom's move key (zoomMoveKey).
 */
export function releaseAfter(released: Release | null, viewed: string | null): Release | null {
  if (released === null || viewed === null) return released
  return viewed === released.viewed || viewed === released.id ? released : null
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
