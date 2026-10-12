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

/**
 * The gateway as every surface may see it. The KEY IS NOT HERE: it never
 * leaves main (route-env.ts hands it to a harness process; the read-only
 * wall token can read RouteState and must not learn it).
 */
export interface RouteGateway {
  url: string
  v1: string
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
  /** The gateway's own rendering ("0 / 130"), when it gives one. */
  display: string | null
}

export interface RouteQuota {
  provider: string
  account: string | null
  alias: string | null
  plan: string | null
  kind: 'subscription' | 'key' | 'local'
  windows: RouteQuotaWindow[]
  last: boolean
  /** The gateway could not read this one ("Claude Code's /usage is temporarily unavailable"). */
  error: string | null
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
  /** Time to first token and the whole request, in ms, when the gateway has them. */
  ttftMs: number | null
  ms: number | null
  /**
   * The group's rule that matched this turn: `id` is the rule's number in
   * the group (the gateway's `n`, as a string), `pick` what it chose (the
   * gateway's `use`). Null when no rule matched — the gateway says that as
   * `{n: 0}`, never null — or a plain model was asked. The rail and R1 print
   * `auto → <rule.id> → <model>` when it is here.
   */
  rule: { id: string; pick: string | null } | null
}

export interface RouteTurnFacts {
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  /** null when the gateway did not price it (a local model): the rail says "local", never "$0.00". */
  cost: number | null
  priced: boolean
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
  /** Can a card of this harness be pointed at the gateway per process? (All four, proven on the real binaries 2026-10-11.) */
  routable: boolean
}

export interface RouteSetupLines {
  installLine: string
  serveLine: string
  /** `magpie plugin add '<absolute dir>'` — the path single-quoted, since a packaged path may hold a space. */
  pluginLine: string
  addSubscriptionLine: string
  addKeyLine: (preset: string) => string
  addLocalLine: string
  /** The group line with the first two catalog models, or null when the catalog has fewer than two — never a placeholder. */
  addGroupLine: string | null
}

export interface RouteState {
  status: RouteStatus
  gateway: RouteGateway | null
  /** Why the status is what it is when that needs saying — a rejected plugin file, a refused host. */
  why: string | null
  /** null = new cards stay direct even when online: the owner picks once, never inferred. */
  defaultModel: string | null
  providers: number
  models: RouteModel[]
  quotas: RouteQuota[]
  /** Newest first, last 20. */
  live: RouteDecision[]
  harnesses: HarnessRow[]
  checkedAt: number
  /** addKeyLine is the BARE stem `magpie provider add ` ending in one space: the renderer appends the preset, the user pastes the key. */
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
  /** A sentence the rail shows beside the route: codex's thinking-model need, pi's not-routable-yet. */
  note: string | null
  /**
   * The gateway's status NOW, so the rail can say "gateway offline" for a
   * RUNNING routed card whose requests will fail — `offline` above only says
   * it was offline at the spawn.
   */
  gateway: RouteStatus
  /** The card's harness can be routed; false reads as "direct · <harness> is not routable" on the rail. */
  routable: boolean
}

export const DIRECT: CardRoute = 'direct'
/** What a route string may look like when the catalog cannot vouch for it (offline, or never read). */
export const ROUTE_ID_RE = /^[A-Za-z0-9._/:-]{1,128}$/
export const ROUTE_LIVE_MAX = 20

/** The session header every routed request carries, so the gateway counts per card. */
export function routeSession(cardId: string): string {
  return `cookrew:${cardId}`
}
