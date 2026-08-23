import type { CanvasNode } from '../shared/model'

/**
 * THE ADDRESS (§9, §11 · ④ · S2) — POST /<slug>/agents/<name>/ask.
 *
 * Pure: parsing and resolution only, no HTTP and no state. The server binds it.
 *
 * WHY THIS ROUTE IS NOT ON THE NODE_ROUTES TABLE. That table scopes a route by
 * MEMBERSHIP: the path carries a node id, and once ownerOf(id) matches the
 * addressed workspace the handler acting by id is correct by construction. This
 * route carries no id — it carries a NAME, and a name is only meaningful inside
 * a workspace. So it is scoped by RESOLUTION instead: the name is looked up in
 * the addressed workspace's own state and nowhere else, which makes a node
 * outside the scope unreachable rather than merely refused. The two mechanisms
 * are different and the difference is load-bearing; conflating them is how a
 * route ends up allow-listed and ungated.
 *
 * The trap this avoids by name: store.nodeByName() reads focusedState. Using it
 * would answer for whichever canvas the owner happens to be looking at — the
 * exact defect that took /cwd off the table.
 */

/** A parsed call address. */
export interface CallAddress {
  /** The agent name as it appeared in the path, percent-decoded. */
  agent: string
}

/**
 * Parse POST /agents/<name>/ask, after the slug has been split off.
 *
 * Returns null for anything else, INCLUDING a well-formed path on the wrong
 * method: a GET here is not a call, and answering one would make the route
 * readable by a link.
 */
export function parseCallAddress(method: string, pathname: string): CallAddress | null {
  if (method !== 'POST') return null
  const match = pathname.match(/^\/agents\/([^/]+)\/ask$/)
  if (!match) return null
  let agent: string
  try {
    agent = decodeURIComponent(match[1])
  } catch {
    // A malformed escape is not a name. Refused rather than passed through as
    // literal bytes, because two spellings that resolve to one agent are two
    // addresses for one resource.
    return null
  }
  return agent.length > 0 ? { agent } : null
}

/** The ceremony's two routes, which exist so the 401 is not a lie. */
export function parseCeremonyRoute(
  method: string,
  pathname: string
): 'challenge' | 'assert' | null {
  if (method !== 'POST') return null
  if (pathname === '/api/call/challenge') return 'challenge'
  if (pathname === '/api/call/assert') return 'assert'
  return null
}

/** What a name resolved to inside one workspace. */
export type AgentResolution =
  | { kind: 'found'; nodeId: string; name: string }
  | { kind: 'none' }
  /** Two terminals whose names differ only by case. Refused, never guessed. */
  | { kind: 'ambiguous' }

/**
 * Resolve an agent NAME to a terminal node, within ONE workspace's nodes.
 *
 * Case-insensitive, matching how names are compared everywhere else in the app
 * — but an ambiguity is refused rather than resolved by order. Picking the
 * first match would make the address depend on canvas layout, so calling
 * "Forge" could reach a different agent after the owner moved a card. The
 * owner's remedy is to rename one of them; until then neither is addressable.
 *
 * Terminals only. A note or a browser card is not a teammate, and a name
 * shared with one must not shadow the agent.
 */
export function resolveAgentByName(nodes: readonly CanvasNode[], name: string): AgentResolution {
  const wanted = name.toLowerCase()
  const matches = nodes.filter(
    (node) => node.kind === 'terminal' && node.name.toLowerCase() === wanted
  )
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length > 1) return { kind: 'ambiguous' }
  return { kind: 'found', nodeId: matches[0].id, name: matches[0].name }
}
