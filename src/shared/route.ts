/**
 * THE ROUTE CONTRACT — Magpie agent and model routing inside Cookrew.
 *
 * Owned by the core lane (docs/route-program/LEDGER.md); every other lane
 * codes against these shapes. Main fills them from the gateway probe, the
 * plugin file, /v1/models, /v1/magpie/quotas and /v1/magpie/route; the
 * renderer draws them (RoutingPanel.tsx, the RTE dial on the rail) and never
 * reads a session file or a key.
 */

/** absent = no magpie binary and no plugin file; offline = known but /api/hello fails. */
export type RouteStatus = 'absent' | 'offline' | 'online'

export interface RouteGateway {
  url: string
  v1: string
  key: string
  port: number
  version: string | null
  source: 'plugin' | 'probe'
}

export interface RouteModel {
  id: string
  displayName: string
  ownedBy: string
  group: boolean
  reasoning: boolean
  levels: string[]
  contextWindow: number | null
}

export interface RouteQuotaWindow {
  name: string
  used: number | null
  limit: number | null
  resetsAt: number | null
}

export interface RouteQuota {
  provider: string
  account: string | null
  alias: string | null
  plan: string | null
  kind: 'subscription' | 'key' | 'local'
  windows: RouteQuotaWindow[]
  last: boolean
}

export interface RouteDecision {
  terminalId: string
  session: string
  seq: number
  asked: string | null
  group: string | null
  model: string | null
  effort: string | null
  tries: number
  done: boolean
  status: string | null
  at: number
}

export interface RouteTurnFacts {
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  cost: number | null
  at: number | null
}

export interface HarnessRow {
  id: 'claude' | 'codex' | 'opencode' | 'pi'
  name: string
  installed: boolean
  signedIn: boolean | null
  inDock: boolean
  installLine: string
  loginLine: string | null
}

export interface RouteSetupLines {
  installLine: string
  serveLine: string
  pluginLine: string
  addSubscriptionLine: string
  addKeyLine: (preset: string) => string
  addLocalLine: string
  addGroupLine: string
}

export interface RouteState {
  status: RouteStatus
  gateway: RouteGateway | null
  /** null = new cards stay direct even when online; the owner picks once. */
  defaultModel: string | null
  providers: number
  models: RouteModel[]
  quotas: RouteQuota[]
  /** Newest first, last 20. */
  live: RouteDecision[]
  harnesses: HarnessRow[]
  checkedAt: number
  /** addKeyLine ends with a space: the user pastes the key. */
  setup: Omit<RouteSetupLines, 'addKeyLine'> & { addKeyLine: string }
}

/** A Magpie model id ('deepseek/deepseek-chat'), a group ('group/smart'), or direct. */
export type CardRoute = 'direct' | string

export interface CardRouteState {
  route: CardRoute
  effective: CardRoute | null
  appliesOn: 'now' | 'restart'
  live: RouteDecision | null
  turn: RouteTurnFacts | null
  offline: boolean
}
