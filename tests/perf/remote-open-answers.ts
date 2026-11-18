import { buildFleet } from '../../src/main/fleet/build'
import { harnessOfNode } from '../../src/main/fleet/sources'
import type { FleetSnapshot } from '../../src/shared/fleet'
import type { GitInfo, WorkspaceMeta, WorkspaceState } from '../../src/shared/model'
import type { RouteState } from '../../src/shared/route'
import { DEFAULT_SKIN } from '../../src/shared/skins'

/**
 * WHAT THE COMPANION ANSWERS, for every GET the remote boot makes.
 *
 * Each answer is the shape the real handler sends for a desktop like the
 * fixture's (no account, no Magpie gateway, no ear, no tuning set), and names
 * the handler it copies. A route answered 404 here when the real one answers
 * 200 changes what the boot does next (a retry, a reconnect, a fallback), so
 * the count would measure the fixture, not the renderer. The gate asserts
 * that every boot request was one of these.
 */

export const GIT: GitInfo = {
  isRepo: true,
  root: '/tmp/fixture',
  branch: 'main',
  dirty: false,
  ahead: 0,
  behind: 0
} as unknown as GitInfo

export const META: WorkspaceMeta = { id: 'w1', name: 'Fixture', dir: '/tmp/fixture', dirs: ['/tmp/fixture'], icon: '🍳' }

/** mobile-api.ts · GET /api/workspaces (ops.listWorkspaces). */
export const WORKSPACES = { workspaces: [META], activeId: META.id }

/** route/gateway.ts with no gateway installed: the state GET /api/route sends. */
const ROUTE_ABSENT: RouteState = {
  status: 'absent',
  gateway: null,
  why: null,
  defaultModel: null,
  providers: 0,
  models: [],
  quotas: [],
  live: [],
  harnesses: [],
  checkedAt: 0,
  autoGroup: false,
  sharedMcp: true,
  mcpServers: null,
  setup: {
    installLine: 'npm i -g magpie',
    serveLine: 'magpie serve',
    pluginLine: "magpie plugin add '/tmp/fixture'",
    addSubscriptionLine: 'magpie subscription add',
    addKeyLine: 'magpie provider add ',
    addLocalLine: 'magpie local add',
    addGroupLine: null
  }
} as unknown as RouteState

/**
 * The fleet stream's opening frame (fleet/routes.ts · openStream → service.ts):
 * the snapshot the real service builds for this canvas, through the real
 * builder, so the zoom view seats what it would seat on a live desktop.
 */
export function fleetSnapshot(state: WorkspaceState): FleetSnapshot {
  const { workspaces } = buildFleet({
    workspaces: [{ meta: META, state }],
    focusedWorkspaceId: META.id,
    live: new Map(),
    probe: new Map(),
    ledger: new Map(),
    tuning: () => null,
    harnessOf: harnessOfNode,
    memory: new Map(),
    now: 1_800_000_000_000
  })
  return {
    v: 1,
    rev: 1,
    at: 1_800_000_000_000,
    machine: {
      name: 'Fixture Mac',
      appVersion: null,
      profile: {
        kind: 'laptop',
        model: null,
        label: null,
        vendor: 'Apple',
        os: 'darwin',
        osVersion: null,
        arch: 'arm64',
        cpus: 10,
        memoryGb: 16,
        evidence: []
      },
      display: null
    },
    focusedWorkspaceId: META.id,
    workspaces
  }
}

/** The registry's entries for the canvas's terminals (mobile-api.ts · GET /api/agents). */
function agentsOf(state: WorkspaceState): unknown[] {
  return state.nodes.flatMap((node) =>
    node.kind === 'terminal'
      ? [
          {
            id: node.id,
            name: node.name,
            preset: node.preset,
            role: node.role,
            cwd: node.cwd,
            workspaceId: META.id,
            workspaceName: META.name,
            spawnedAt: 1_800_000_000_000,
            orch: node.orch,
            active: false
          }
        ]
      : []
  )
}

/**
 * The event log's rows (event-log.ts), as a working desktop's log holds them:
 * agents have changed notes and opened browsers (socket-server.ts logs those
 * as the agent's). With an empty log the HITL bar's boot read stops after its
 * first query and the gate would count one read fewer than a real phone pays.
 */
const LOG = Array.from({ length: 12 }, (_, i) => ({
  type: ['note.created', 'note.updated', 'browser.created', 'browser.navigated'][i % 4],
  entityId: i % 2 === 0 ? `n${i}` : `b${i}`,
  entityName: i % 2 === 0 ? `Note ${i}` : `Browser ${i}`,
  workspaceId: META.id,
  workspaceName: META.name,
  actor: 'agent',
  timestamp: 1_800_000_000_000 + i * 60_000
}))

/** mobile-api.ts · GET /api/events/query over LOG: type, types, since, limitPerType, limit (newest last). */
function queryLog(params: URLSearchParams): { events: unknown[]; counts?: Record<string, number> } {
  const types = params.get('types')?.split(',') ?? null
  const type = params.get('type')
  const since = Number(params.get('since') ?? Number.NEGATIVE_INFINITY)
  const limit = Number(params.get('limit') ?? Number.POSITIVE_INFINITY)
  const perType = Number(params.get('limitPerType') ?? Number.POSITIVE_INFINITY)
  const matched = LOG.filter((e) => (type === null && types === null) || e.type === type || (types?.includes(e.type) ?? false)).filter((e) => e.timestamp >= since)
  const taken = new Map<string, number>()
  const rows = [...matched].reverse().filter((e) => {
    const n = taken.get(e.type) ?? 0
    taken.set(e.type, n + 1)
    return n < perType
  }).reverse()
  const events = rows.slice(Math.max(0, rows.length - limit))
  // A typed read skips the count walk.
  return type !== null || types !== null ? { events } : { events, counts: {} }
}

export interface Answer {
  readonly status: number
  readonly body: unknown
}

/**
 * The plain JSON answers, keyed by method and path. `null` = not a JSON route
 * (the caller serves streams, pages and assets itself).
 */
export function answerJson(method: string, url: URL, state: WorkspaceState & { dirsGit: Record<string, GitInfo> }): Answer | null {
  const p = url.pathname
  const ok = (body: unknown): Answer => ({ status: 200, body })
  if (method === 'POST' && p === '/api/beacon') return { status: 204, body: null }
  if (method !== 'GET') return null
  switch (p) {
    // mobile-api.ts · GET /api/auth/status for the pairing token.
    case '/api/auth/status':
      return ok({ scope: 'pairing', required: true, canWrite: true })
    case '/api/workspace':
      return ok(state)
    case '/api/workspaces':
      return ok(WORKSPACES)
    case '/api/activity':
    case '/api/presets':
    case '/api/roles':
    case '/api/teams':
      return ok([])
    // mobile-server.ts: a desktop signed in to no account answers 404 on purpose.
    case '/api/account':
      return { status: 404, body: { error: 'no account on this desktop' } }
    case '/api/browser/capabilities':
      return ok({ interactive: false })
    case '/api/git':
      return ok(GIT)
    case '/api/browser/thumbs':
      return ok({ frames: [] })
    case '/api/events/query':
      return ok(queryLog(url.searchParams))
    case '/api/agents':
      return ok({ agents: agentsOf(state) })
    case '/api/route':
      return ok(ROUTE_ABSENT)
    case '/api/listen':
      return ok({ available: false, locale: null })
    case '/api/terminal-session':
      return ok({ stale: false, serverPid: null, serverStartedAt: null, loginAt: null })
    case '/api/tuning':
      return ok({})
    case '/api/skin':
      return ok({ skin: DEFAULT_SKIN })
    default:
      break
  }
  if (/^\/api\/browser\/[^/]+\/thumb$/.test(p)) return { status: 404, body: { error: 'No thumbnail yet' } }
  if (/^\/api\/terminal\/[^/]+\/stream\/open$/.test(p)) return ok({ blocks: [], total: 0, missing: [], tail: null })
  return null
}
