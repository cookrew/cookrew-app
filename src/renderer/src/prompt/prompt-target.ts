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
