/**
 * THE ROUTE CONTRACT — Cookrew × Magpie (route program, 2026-10-11).
 *
 * The one file every lane codes against (docs/route-program/LEDGER.md owns
 * the wording; a change here is a change there). Magpie is a local LLM
 * gateway on 127.0.0.1:3425: every model the owner has — subscriptions, API
 * keys, local models, routing groups — is served there under one id each.
 * Cookrew never holds a key: a card's harness is pointed at the gateway at
 * spawn (route-env.ts) and the gateway counts every call under
 * `X-Magpie-Session: cookrew:<cardId>`.
 *
 * `absent`  — no magpie binary on PATH and no plugin file: the owner has not
 *             installed it; the rail says nothing about routes.
 * `offline` — magpie is known (binary or plugin file) but /api/hello fails.
 * `online`  — /api/hello answered {"name":"magpie"}.
 */

export type RouteStatus = 'absent' | 'offline' | 'online'

export interface RouteGateway {
  url: string
  v1: string
  key: string
  port: number
  version: string | null
  /** 'plugin' when ~/.cookrew/magpie.json (written by the Magpie agent plugin) named it; 'probe' otherwise. */
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
  /** null = new cards stay direct even when online: the owner picks once, never inferred. */
  defaultModel: string | null
  providers: number
  models: RouteModel[]
  quotas: RouteQuota[]
  /** Newest first, last 20. */
  live: RouteDecision[]
  harnesses: HarnessRow[]
  checkedAt: number
  /** addKeyLine ends with a space: the user pastes the key after it. */
  setup: Omit<RouteSetupLines, 'addKeyLine'> & { addKeyLine: string }
}

/** 'direct', or a Magpie model id ('deepseek/deepseek-chat') or group ('group/smart'). */
export type CardRoute = 'direct' | string

export interface CardRouteState {
  route: CardRoute
  /** What the running process actually got; null before the first spawn. */
  effective: CardRoute | null
  appliesOn: 'now' | 'restart'
  live: RouteDecision | null
  turn: RouteTurnFacts | null
  /** The gateway was offline when the card spawned, so it went direct. */
  offline: boolean
}

export const DIRECT: CardRoute = 'direct'
export const ROUTE_LIVE_MAX = 20

/** The session header every routed request carries, so the gateway counts per card. */
export function routeSession(cardId: string): string {
  return `cookrew:${cardId}`
}
