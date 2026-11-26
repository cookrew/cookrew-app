import type { HarnessId } from './harness-catalog'
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

/** Neutral words for a provider diagnostic the HTTP projection withheld. */
export const ROUTE_HIDDEN = 'hidden on this device'

/**
 * THE ROUTE HTTP SCHEMA, named so mixed versions are a release decision, not
 * a guess. Owner and restricted responses carry the same number. A client
 * older than this ignores unknown fields but cannot render `withheld` or
 * `remoteRisks`; ship server and client together and require the client to
 * upgrade first. A newer schema makes the current routing panel require a
 * client update. A payload without the field is the legacy shipped shape and
 * stays readable by the current renderer.
 */
export const ROUTE_HTTP_SCHEMA_VERSION = 2

/**
 * THE CLIENT SAYS WHICH ROUTE SCHEMA IT CAN READ, in the URL: `?route=2`.
 *
 * A client that predates the schema cannot render `withheld` or `remoteRisks`,
 * so it must not be handed a projection it would show as if nothing were
 * hidden. It also cannot set a header on an EventSource, which is why this is
 * a query parameter and not `x-cookrew-route-schema`.
 *
 * CLIENT FIRST (owner 2026-11-22): clients send it before any host acts on
 * it. A host that predates the schema ignores the parameter and answers the
 * legacy shape, which these clients still read. Only a later host refuses a
 * request without it (426, no route frames on the stream), and that switch
 * waits until updated clients are shown to have reached people. The
 * parameter is a capability claim, never authorisation. The desktop's own
 * renderer (IPC) is not affected.
 */
export const ROUTE_SCHEMA_PARAM = 'route'

/** The schema number a request's URL claims, or null when it claims none. */
export function routeSchemaQuery(search: string): number | null {
  const raw = new URLSearchParams(search).get(ROUTE_SCHEMA_PARAM)
  // Decimal digits only: '', ' 2 ' or '0x2' claim no schema.
  return raw !== null && /^\d{1,3}$/.test(raw) ? Number(raw) : null
}

/** Gateway details for desktop IPC and sealed owner responses. The key stays in main. */
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
  /** What is left, as the gateway says it: a percent when there is no limit, else in `unit`. */
  remaining?: number | null
  /** "credits", "requests"…; null for a percent window. */
  unit?: string | null
  /** Tokens this account spent in the window (the gateway's `holds.tokens`), since `since`. */
  tokensUsed?: number | null
  /** What those tokens would have cost at API prices, in dollars; null when unpriced. */
  valueUsed?: number | null
  since?: number | null
  /** Why the gateway gives no token figure for this window ("low", "new", "stale"); null when it gives one. */
  estimateWhy?: string | null
}

export interface RouteQuota {
  provider: string
  account: string | null
  alias: string | null
  plan: string | null
  kind: 'subscription' | 'key' | 'local' | 'balance'
  windows: RouteQuotaWindow[]
  /** A prepaid balance in the gateway's own words ("$64.90 · ¥-0.00"); null for anything else. */
  balance?: string | null
  /** When the subscription itself ends. */
  until?: number | null
  /** Window resets the account holds (Codex), and when the first of them expires. */
  resetCredits?: { count: number; firstExpiresAt: number | null } | null
  /** When the gateway last read this account. */
  readAt?: number | null
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
   * `auto → <rule.id> → <model>` when it is here. `held` means the rule was
   * decided when the turn began: a claude turn makes several requests and
   * the later ones report the rule the turn opened on, not a fresh match,
   * so a held repeat is not a change. `when` is the rendered conditions
   * ("tokens ≥ 1000"), for a title.
   */
  rule: { id: string; pick: string | null; held?: boolean; when?: string[] } | null
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
  id: HarnessId
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
  /**
   * E2E (design §5): the local tier. The command `scripts/route-auto-group.mjs`
   * printed — `magpie group add auto models=<installed ollama models> routing=smart stays=turn` —
   * when the gateway lists ollama models to build it from; null when it cannot
   * be built; ABSENT on a main without the script (the item is then disabled).
   */
  addAutoGroupLine?: string | null
}

export interface RouteState {
  /** HTTP projection version (ROUTE_HTTP_SCHEMA_VERSION); absent on IPC and the legacy shipped shape. */
  schemaVersion?: number
  status: RouteStatus
  gateway: RouteGateway | null
  /** Discovery source when the HTTP response omits gateway coordinates. */
  gatewaySource?: RouteGateway['source']
  /** Address-free warnings when HTTP omits the detailed provider rows. */
  remoteRisks?: { plain?: string; loopback?: string }
  /** Fields the HTTP projection withheld because their only value carried host topology. */
  withheld?: { mcpServers?: true; addGroupLine?: true; addAutoGroupLine?: true; defaultModel?: true; endpointInventory?: true; providerData?: true }
  /** Why the status is what it is when that needs saying — a rejected plugin file, a refused host. */
  why: string | null
  /** The owner switched Magpie off (launch settings): installed or not, nothing routes and no Magpie way is offered. */
  switchedOff?: boolean
  /**
   * Remote magpie providers on this computer's loopback. `managed` marks
   * Cookrew's own sealed link through its forwarder; the rest are tunnels made
   * by hand. Either way a program that takes the port receives the requests
   * (never the key: that stays in main and is put on per request).
   */
  loopbackRemotes?: { id: string; port: number; managed?: boolean }[]
  /** Remote magpie providers on plain http off a tailnet: the key crosses that network unencrypted. */
  plainRemotes?: { id: string; host: string }[]
  /** null = new cards stay direct even when online: the owner picks once, never inferred. */
  defaultModel: string | null
  providers: number
  models: RouteModel[]
  quotas: RouteQuota[]
  /** Newest first, last 20. */
  live: RouteDecision[]
  harnesses: HarnessRow[]
  checkedAt: number
  /**
   * Whether the gateway serves `group/auto` (design §5's local tier): the
   * renderer offers it only then; the group is made by the owner from the
   * line scripts/route-auto-group.mjs prints, never by the app.
   */
  autoGroup: boolean
  /** Every agent Cookrew spawns is handed Magpie's one MCP hub (main/route/shared-mcp.ts); on unless turned off. */
  sharedMcp: boolean
  /** The servers in Magpie's library, the ones the hub shares (names only); null when the library could not be read. */
  mcpServers?: string[] | null
  /** addKeyLine is the BARE stem `magpie provider add ` ending in one space: the renderer appends the preset, the user pastes the key. */
  setup: Omit<RouteSetupLines, 'addKeyLine'> & {
    addKeyLine: string
    /** Magpie's installer can reach for sudo here, which the panel says before the press. */
    installAsksAdmin?: boolean
  }
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
