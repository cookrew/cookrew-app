/**
 * THE one route table for the v4 gate (spec §3/§4): every HTTP route and the
 * WS upgrade surface, each mapped to an auth group. Lives in shared/ because
 * BOTH sides of the gate depend on the same classification — the wave-B
 * server gate will deny by it, and consumers/tests must predict it. Two
 * implementations would eventually disagree about what a wall token can
 * reach; the conformance suite (tests/route-manifest.test.ts) grep-sweeps
 * mobile-api.ts/mobile-server.ts so a route added without an entry here
 * fails CI instead of shipping ungated.
 *
 * Group semantics (v4 §4 consumers.json rows are subsets of these):
 *   public       — bootstrap + /auth/status; no token required
 *   observe      — curated read projections (board, state, events, ledger)
 *   dispatch     — prompt an agent / follow a dispatch; bindings live here
 *   orchestrate  — workspace/board/team/role mutations
 *   terminal-io  — the raw pane byte surface; structurally local (Sol F6),
 *                  never granted to external consumers
 *   admin        — gate/consumer management; no routes yet, reserved
 *
 * Deliberate calls (each is a spec reading, flagged for review):
 *   - POST /api/terminal/:id/ask is DISPATCH, not terminal-io: §3's F1
 *     evidence frames /ask as the attach-bound ancestor of /dispatch, and
 *     bindings holding [observe, dispatch] (ha-sous) must keep asking.
 *   - /stream + /output are TERMINAL-IO, not observe: raw pane bytes can
 *     carry secrets; observe stays a curated projection. The wall renders
 *     from board/state/thumb/events.
 *   - POST /api/instances is ORCHESTRATE: instantiation is workspace
 *     creation; the one-shot bootstrap token carries the group for the
 *     purchase attempt, and the 402 settle step does the metering.
 */
export type RouteGroup = 'observe' | 'dispatch' | 'orchestrate' | 'terminal-io' | 'admin' | 'public'

export interface RouteEntry {
  method: string
  /**
   * `/`-joined literal segments; `:name` matches exactly one segment.
   * Example: '/api/terminal/:id/turns'.
   */
  pattern: string
  group: RouteGroup
}

export const ROUTE_MANIFEST: readonly RouteEntry[] = [
  // public — bootstrap surface + the one spec-mandated open read (v4 §4).
  // /api/catalog is spec'd public (§3) but has NO HANDLER yet — classifying
  // it now would be a pre-authorized hole for whoever implements it (D4).
  // Re-add the entry deliberately, with the handler.
  { method: 'GET', pattern: '/', group: 'public' },
  { method: 'GET', pattern: '/index.html', group: 'public' },
  { method: 'GET', pattern: '/api/auth/status', group: 'public' },

  // observe
  { method: 'GET', pattern: '/api/state', group: 'observe' },
  { method: 'GET', pattern: '/api/workspace', group: 'observe' },
  { method: 'GET', pattern: '/api/workspaces', group: 'observe' },
  { method: 'GET', pattern: '/api/board', group: 'observe' },
  { method: 'GET', pattern: '/api/activity', group: 'observe' },
  { method: 'GET', pattern: '/api/presets', group: 'observe' },
  { method: 'GET', pattern: '/api/git', group: 'observe' },
  { method: 'GET', pattern: '/api/teams', group: 'observe' },
  { method: 'GET', pattern: '/api/roles', group: 'observe' },
  { method: 'GET', pattern: '/api/team/clip', group: 'observe' },
  { method: 'GET', pattern: '/api/agents', group: 'observe' },
  { method: 'GET', pattern: '/api/events', group: 'observe' },
  { method: 'GET', pattern: '/api/events/query', group: 'observe' },
  { method: 'GET', pattern: '/api/terminal/:id/turns', group: 'observe' },
  { method: 'GET', pattern: '/api/terminal/:id/trace', group: 'observe' },
  { method: 'GET', pattern: '/api/terminal/:id/trace/index', group: 'observe' },
  { method: 'GET', pattern: '/api/terminal/:id/trace/markers', group: 'observe' },
  { method: 'GET', pattern: '/api/browser/capabilities', group: 'observe' },
  { method: 'GET', pattern: '/api/browser/:id/thumb', group: 'observe' },

  // dispatch
  { method: 'POST', pattern: '/api/terminal/:id/ask', group: 'dispatch' },
  { method: 'POST', pattern: '/api/agents/:id/dispatch', group: 'dispatch' },
  { method: 'GET', pattern: '/api/dispatches/:id', group: 'dispatch' },

  // terminal-io — raw bytes in or out of a pane; the browser stream entry is
  // the WS UPGRADE (an upgrade is a GET — Sol F1/F2: the manifest owns it too)
  { method: 'POST', pattern: '/api/terminal/:id/input', group: 'terminal-io' },
  { method: 'POST', pattern: '/api/terminal/:id/raw', group: 'terminal-io' },
  { method: 'POST', pattern: '/api/terminal/:id/resize', group: 'terminal-io' },
  { method: 'POST', pattern: '/api/terminal/:id/jump', group: 'terminal-io' },
  { method: 'GET', pattern: '/api/terminal/:id/stream', group: 'terminal-io' },
  { method: 'GET', pattern: '/api/terminal/:id/output', group: 'terminal-io' },
  { method: 'GET', pattern: '/api/browser/:id/stream', group: 'terminal-io' },

  // orchestrate — literals before :id patterns on shared prefixes
  { method: 'POST', pattern: '/api/workspaces', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/workspaces/switch', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/workspaces/rename', group: 'orchestrate' },
  { method: 'DELETE', pattern: '/api/workspaces/:id', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/workspaces/:id/service', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/workspaces/:id/dirs', group: 'orchestrate' },
  { method: 'DELETE', pattern: '/api/workspaces/:id/dirs', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/workspaces/:id/primary', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/nodes', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/nodes/:id', group: 'orchestrate' },
  { method: 'DELETE', pattern: '/api/nodes/:id', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/connections', group: 'orchestrate' },
  { method: 'DELETE', pattern: '/api/connections/:id', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/terminals', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/team/fork', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/team/save', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/team/clip', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/team/paste', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/role/save', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/role/delete', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/attachments', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/terminal/:id/cwd', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/terminal/:id/seen', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/terminal/:id/fork', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/agents/:id/restore', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/agents/:id/restore/undo', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/agents/:id/recover', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/say', group: 'orchestrate' },
  { method: 'POST', pattern: '/api/instances', group: 'orchestrate' }
]

function patternMatches(pattern: string, path: string): boolean {
  const pp = pattern.split('/')
  const sp = path.split('/')
  if (pp.length !== sp.length) return false
  return pp.every((segment, i) => segment.startsWith(':') || segment === sp[i])
}

/**
 * Classify one request for the gate. Returns null when nothing matches —
 * deny-by-default: the gate turns a null on /api/* into 403 and the router
 * into 404, never into an ungated route. Query strings are stripped (the
 * gate classifies the route, not the arguments); trailing slashes do NOT
 * normalize — a malformed path is an unknown route, not a fuzzy match.
 */
export function classifyRoute(method: string, path: string): RouteGroup | null {
  const verb = method.toUpperCase()
  const clean = path.split('?')[0].split('#')[0]
  for (const entry of ROUTE_MANIFEST) {
    if (entry.method === verb && patternMatches(entry.pattern, clean)) return entry.group
  }
  return null
}
