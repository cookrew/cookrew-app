import type { CardRouteState, HarnessRow, RouteModel, RouteQuota, RouteState } from './route'

/**
 * WHAT THE ROUTING PANEL AND THE RTE DIAL SAY — as words and numbers, no DOM.
 *
 * RoutingPanel.tsx and TuneRail.tsx set what these return. Everything a test
 * wants to assert about the panel — the status sentence, which tick is the
 * button, which line a button types, the order of the picker — is decided
 * here and asserted without a browser.
 */

export const ROUTING_COPY = {
  title: 'Routing',
  absent: 'not installed · cards run direct on their own logins',
  offline: 'offline — /api/hello refused · cards run direct meanwhile',
  install: 'INSTALL',
  start: 'START',
  wire: 'WIRE',
  wiredByPlugin: 'wired by Magpie plugin · ~/.cookrew/magpie.json',
  wiredByProbe: 'found on this machine',
  defaultNone: 'direct — pick a model to route new cards',
  defaultLabel: 'DEFAULT',
  noGateway: 'each harness on its own login · one model per harness · nothing to meter',
  rented: 'budget key · subscriptions not lent by default',
  add: 'ADD',
  addSubscription: 'Subscription',
  addKey: 'API key',
  addLocal: 'Local',
  addGroup: 'Routing group',
  keyHint: 'the line is typed; paste the key and press Enter — it never touches Cookrew'
} as const

/** Key presets the Add menu offers; each is one `magpie provider add <preset> <key>` line. */
export const KEY_PRESETS = ['deepseek', 'openai', 'anthropic', 'kimi', 'glm', 'openrouter', 'minimax', 'qwen'] as const

export interface StatusLine {
  status: RouteState['status']
  /** The sentence beside the lamp. */
  text: string
  /** The one action, or null when the line is green. */
  action: { label: string; line: string } | null
  /** Who wired it, online only. */
  source: string | null
}

export function statusLine(state: RouteState): StatusLine {
  if (state.status === 'absent') {
    return { status: 'absent', text: ROUTING_COPY.absent, action: { label: ROUTING_COPY.install, line: state.setup.installLine }, source: null }
  }
  if (state.status === 'offline') {
    return { status: 'offline', text: ROUTING_COPY.offline, action: { label: ROUTING_COPY.start, line: state.setup.serveLine }, source: null }
  }
  const g = state.gateway
  const where = g ? `${g.url.replace(/^https?:\/\//, '')}` : 'gateway'
  const groups = state.models.filter((m) => m.group).length
  const def = state.defaultModel ?? 'direct'
  return {
    status: 'online',
    text: `${where} · ${state.providers} provider${state.providers === 1 ? '' : 's'} · ${groups} group${groups === 1 ? '' : 's'} · default ${def}`,
    action: null,
    source: g?.source === 'plugin' ? ROUTING_COPY.wiredByPlugin : ROUTING_COPY.wiredByProbe
  }
}

export interface Tick {
  label: string
  ok: boolean
  /** The line the button types when the tick is missing; null = nothing to do. */
  line: string | null
  /** For a tick that is a Cookrew act, not a terminal line. */
  act: 'dock' | null
}

/** installed · signed in · in dock — the missing tick is the button. */
export function harnessTicks(row: HarnessRow): Tick[] {
  const installed: Tick = { label: 'installed', ok: row.installed, line: row.installed ? null : row.installLine, act: null }
  const signedIn: Tick =
    row.signedIn === null
      ? { label: 'no sign-in', ok: true, line: null, act: null }
      : { label: 'signed in', ok: row.signedIn, line: row.signedIn ? null : row.loginLine, act: null }
  const inDock: Tick = { label: 'in dock', ok: row.inDock, line: null, act: row.inDock ? null : 'dock' }
  return [installed, signedIn, inDock]
}

/** Picker order: direct, then groups, then models — the groups are what a card should usually ride. */
export function routeChoices(models: readonly RouteModel[]): string[] {
  const groups = models.filter((m) => m.group).map((m) => m.id)
  const plain = models.filter((m) => !m.group).map((m) => m.id)
  return ['direct', ...groups, ...plain]
}

export interface QuotaBar {
  title: string
  sub: string
  kind: RouteQuota['kind']
  /** 0..1 of the fullest window, or null when nothing is metered (a key balance, a local model). */
  fill: number | null
  /** The fullest window's name and percent, or the balance / "local". */
  reading: string
  hot: boolean
}

export function quotaBar(q: RouteQuota): QuotaBar {
  const title = q.alias ?? q.provider
  const sub = [q.account, q.plan].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' · ')
  const metered = q.windows.filter((w) => w.used !== null && w.limit !== null && w.limit > 0)
  if (metered.length === 0) {
    return { title, sub, kind: q.kind, fill: null, reading: q.kind === 'local' ? 'local' : 'key', hot: false }
  }
  const fullest = metered.reduce((a, b) => (a.used! / a.limit! >= b.used! / b.limit! ? a : b))
  const fill = Math.min(1, fullest.used! / fullest.limit!)
  return { title, sub, kind: q.kind, fill, reading: `${fullest.name} ${Math.round(fill * 100)}%`, hot: fill >= 0.9 }
}

/** The three lines under the RTE chip. */
export interface RouteDialLines {
  value: string
  /** "this turn → model · tokens · cost", or null before the first routed turn. */
  turn: string | null
  /** "applies on restart" / "gateway offline · direct" / null. */
  note: string | null
  /** The chip wears a flag when its reading is not what the card asked for. */
  flag: 'restart' | 'offline' | null
}

export function routeDialLines(card: CardRouteState | null): RouteDialLines {
  if (card === null) return { value: '—', turn: null, note: null, flag: null }
  if (card.offline) return { value: 'direct', turn: null, note: 'gateway offline · direct', flag: 'offline' }
  const turn = card.turn && card.turn.model ? `this turn → ${card.turn.model}${tokens(card.turn.inputTokens, card.turn.outputTokens)}${cost(card.turn.cost)}` : card.live?.model ? `this turn → ${card.live.model}` : null
  const note = card.appliesOn === 'restart' ? 'applies on restart' : null
  return { value: card.route, turn, note, flag: card.appliesOn === 'restart' ? 'restart' : null }
}

function tokens(input: number | null, output: number | null): string {
  if (input === null && output === null) return ''
  const total = (input ?? 0) + (output ?? 0)
  return ` · ${total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total)} tok`
}

function cost(value: number | null): string {
  if (value === null) return ''
  return ` · $${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`
}

/** Shorten a model id for a 46px chip: the part after the last slash. */
export function shortRoute(id: string): string {
  if (id === 'direct') return 'direct'
  const tail = id.slice(id.lastIndexOf('/') + 1)
  return tail.length > 0 ? tail : id
}

/** A card the owner does not own (a served session) never gets a route dial. */
export function routeDialAllowed(input: { remote: boolean; served: boolean }): boolean {
  return !input.remote && !input.served
}
