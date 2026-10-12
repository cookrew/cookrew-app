import type { CardRouteState, HarnessRow, RouteDecision, RouteModel, RouteQuota, RouteState } from './route'

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
  groupNeedsTwo: 'needs two models in the catalog',
  noRoutable: 'no routable models',
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
    // A why is a file the owner wrote (a refused gateway host): nothing to
    // install, something to fix — so the line says it and offers no button.
    if (state.why) return { status: 'absent', text: `not routing — ${state.why}`, action: null, source: null }
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
  /** Why a tick that nothing can fix is missing — the title of the ✗. */
  why?: string | null
}

/**
 * WHY A HARNESS CANNOT BE ROUTED — one sentence per harness, said the same
 * on R1's "routes" tick (as the ✗'s title) and on the card's RTE dial
 * ("direct · <reason>"). Main's CardRouteState.note should carry
 * notRoutableNote(id) so the two surfaces never drift. Null = routable.
 */
export const NOT_ROUTABLE_REASON: Record<HarnessRow['id'], string | null> = {
  claude: null,
  codex: null,
  opencode: null,
  pi: 'pi takes a provider only from its global models.json'
}

/** Forge's word when it sent one; the table above until then. */
export function harnessRoutable(row: Pick<HarnessRow, 'id' | 'routable'>): boolean {
  return row.routable ?? NOT_ROUTABLE_REASON[row.id] === null
}

/** The dial's line for a harness that cannot be routed. */
export function notRoutableNote(id: HarnessRow['id']): string | null {
  const why = NOT_ROUTABLE_REASON[id]
  return why === null ? null : `direct · ${why}`
}

/** installed · signed in · in dock — the missing tick is the button. */
export function harnessTicks(row: HarnessRow): Tick[] {
  const installed: Tick = { label: 'installed', ok: row.installed, line: row.installed ? null : row.installLine, act: null }
  const signedIn: Tick =
    row.signedIn === null
      ? { label: 'no sign-in', ok: true, line: null, act: null }
      : { label: 'signed in', ok: row.signedIn, line: row.signedIn ? null : row.loginLine, act: null }
  const inDock: Tick = { label: 'in dock', ok: row.inDock, line: null, act: row.inDock ? null : 'dock' }
  const routes: Tick = { label: 'routes', ok: harnessRoutable(row), line: null, act: null, why: NOT_ROUTABLE_REASON[row.id] }
  return [installed, signedIn, inDock, routes]
}

/** Picker order: direct, then groups, then models — the groups are what a card should usually ride. */
export function routeChoices(models: readonly RouteModel[]): string[] {
  const groups = models.filter((m) => m.group).map((m) => m.id)
  const plain = models.filter((m) => !m.group).map((m) => m.id)
  return ['direct', ...groups, ...plain]
}

export interface QuotaBar {
  title: string
  /** The account (an email shown as its local part and an ellipsis) and the plan. */
  sub: string
  kind: RouteQuota['kind']
  /** 0..1 of the fullest window, or null when nothing is metered (a key, a local model, an error). */
  fill: number | null
  /** The fullest window's name and label, or "local · free" / "key", or the error sentence. */
  reading: string
  /** The gateway could not read this row: the reading IS the sentence. */
  error: string | null
  hot: boolean
}

/** `drej@example.com` → `drej@…`: the local part names the account, the domain is nobody's business on a wall. */
export function maskAccount(account: string | null): string | null {
  if (account === null || account.length === 0) return null
  const at = account.indexOf('@')
  if (at <= 0) return account
  return `${account.slice(0, at)}@…`
}

/** A window's label: the gateway's own when it gives one, else a percent when both numbers are there, else the count. */
export function windowLabel(w: { used: number | null; limit: number | null; display: string | null }): string {
  if (w.display) return w.display
  if (w.used === null) return '—'
  if (w.limit !== null && w.limit > 0) return `${Math.round((w.used / w.limit) * 100)}%`
  return String(w.used)
}

export function quotaBar(q: RouteQuota): QuotaBar {
  const title = q.alias ?? q.provider
  const sub = [maskAccount(q.account), q.plan].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' · ')
  if (q.error) return { title, sub, kind: q.kind, fill: null, reading: q.error, error: q.error, hot: false }
  if (q.kind === 'local') return { title, sub, kind: q.kind, fill: null, reading: 'local · free', error: null, hot: false }
  const metered = q.windows.filter((w) => w.used !== null && w.limit !== null && w.limit > 0)
  if (metered.length === 0) {
    // No limit to divide by: a counter is shown as the count it is.
    const counted = q.windows.find((w) => w.used !== null)
    const reading = counted ? `${counted.name} ${windowLabel(counted)}` : 'key'
    return { title, sub, kind: q.kind, fill: null, reading, error: null, hot: false }
  }
  const fullest = metered.reduce((a, b) => (a.used! / a.limit! >= b.used! / b.limit! ? a : b))
  const fill = Math.min(1, fullest.used! / fullest.limit!)
  return { title, sub, kind: q.kind, fill, reading: `${fullest.name} ${windowLabel(fullest)}`, error: null, hot: fill >= 0.9 }
}

/**
 * The path a turn took, as the rail and R1 print it: `auto → <rule> → <model>`
 * when a group rule matched, `<group> → <model>` when a group picked without
 * one, the model alone when a plain model was asked.
 */
export function routePath(d: Pick<RouteDecision, 'rule' | 'group' | 'model' | 'asked'>): string {
  const model = d.model ?? '—'
  if (d.rule) return `auto → ${d.rule.id} → ${model}`
  if (d.group) return `${d.group} → ${model}`
  return d.model ?? d.asked ?? 'direct'
}

/** What the live row's first column says: `auto → <rule>` under a rule, else the group, the ask, or direct. */
export function routeHead(d: Pick<RouteDecision, 'rule' | 'group' | 'asked'>): string {
  if (d.rule) return `auto → ${d.rule.id}`
  return d.group ?? d.asked ?? 'direct'
}

/** What a live row says after the model: tries, a failure, the first-token time. */
export function decisionFacts(d: Pick<RouteDecision, 'tries' | 'status' | 'ttftMs' | 'group'>): string {
  const parts: string[] = []
  // The contract carries a count; the gateway's own array (each try with
  // a `fail`) is accepted too, in case it ever arrives unfolded.
  const raw = d.tries as unknown
  const count = Array.isArray(raw) ? raw.length : typeof raw === 'number' ? raw : 0
  const failed = Array.isArray(raw) ? raw.filter((t) => t && typeof t === 'object' && 'fail' in (t as object) && (t as { fail?: unknown }).fail).length : 0
  if (count > 1) parts.push(`${count} tries${failed > 0 ? ` · ${failed} failed` : ''}`)
  if (d.status) parts.push(d.status)
  if (d.ttftMs !== null && d.ttftMs !== undefined) parts.push(`first token ${(d.ttftMs / 1000).toFixed(1)} s`)
  if (parts.length === 0) parts.push(d.group ? 'first pick' : 'direct pick')
  return parts.join(' · ')
}

/** The three lines under the RTE chip. */
export interface RouteDialLines {
  value: string
  /** "this turn → model · tokens · cost", or null before the first routed turn. */
  turn: string | null
  /** "applies on restart" / "gateway offline · direct" / "gateway offline — requests will fail until restart" / null. */
  note: string | null
  /** The chip wears a flag when its reading is not what the card asked for, or what it got will not answer. */
  flag: 'restart' | 'offline' | null
}

/** The gateway is down NOW under a process that was handed a route: its requests fail until it is respawned. */
export const GATEWAY_DOWN_NOW = 'gateway offline — requests will fail until restart'

export function routeDialLines(card: CardRouteState | null): RouteDialLines {
  if (card === null) return { value: '—', turn: null, note: null, flag: null }
  // Offline AT SPAWN: the process went direct and is fine; the chip says so.
  if (card.offline) return { value: 'direct', turn: null, note: joinNotes('gateway offline · direct', card.note), flag: 'offline' }
  // Offline NOW under a routed process: the same slot, the opposite sentence —
  // nothing is fine until the restart. `effective` is what the process got.
  if (card.gateway === 'offline' && card.effective !== null && card.effective !== 'direct') {
    return { value: card.route, turn: turnLine(card), note: joinNotes(GATEWAY_DOWN_NOW, card.note), flag: 'offline' }
  }
  const note = joinNotes(card.appliesOn === 'restart' ? 'applies on restart' : null, card.note)
  return { value: card.route, turn: turnLine(card), note, flag: card.appliesOn === 'restart' ? 'restart' : null }
}

function turnLine(card: CardRouteState): string | null {
  // Under a matched rule the line says how the model was reached:
  // `this turn → auto → <rule> → <model>`; without one, the model alone.
  const via = card.live?.rule ? `auto → ${card.live.rule.id} → ` : ''
  if (card.turn && card.turn.model) return `this turn → ${via}${card.turn.model}${tokens(card.turn.inputTokens, card.turn.outputTokens)}${cost(card.turn)}`
  return card.live?.model ? `this turn → ${via}${card.live.model}` : null
}

function joinNotes(...notes: (string | null | undefined)[]): string | null {
  const kept = notes.filter((n): n is string => typeof n === 'string' && n.length > 0)
  return kept.length === 0 ? null : kept.join(' · ')
}

/** `1.8k in · 312 out`; nothing when nothing was counted. */
function tokens(input: number | null, output: number | null): string {
  if (input === null && output === null) return ''
  const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const parts: string[] = []
  if (input !== null) parts.push(`${k(input)} in`)
  if (output !== null) parts.push(`${k(output)} out`)
  return ` · ${parts.join(' · ')}`
}

/** A price when the gateway priced it; "local" when it did not; nothing when it said nothing. */
function cost(turn: { cost: number | null; priced: boolean }): string {
  if (!turn.priced) return ' · local'
  if (turn.cost === null) return ''
  return ` · $${turn.cost < 0.01 ? turn.cost.toFixed(4) : turn.cost.toFixed(3)}`
}

/** Shorten a model id for a 46px chip: the part after the last slash. */
export function shortRoute(id: string): string {
  if (id === 'direct') return 'direct'
  const tail = id.slice(id.lastIndexOf('/') + 1)
  return tail.length > 0 ? tail : id
}

/**
 * What the RTE dial is given: main's choices alone (it alone knows whether
 * this card's harness can be routed); with none listed, no list and a
 * sentence — main's note when it sent one, else "no routable models".
 * Null when the card may not have a dial at all.
 */
export function routeDialInput(input: {
  allowed: boolean
  /** Main's `choices.route`, or null when main listed none. */
  routeChoices: readonly string[] | null
  state: CardRouteState | null
}): { choices: string[]; notRoutable: string | null } | null {
  if (!input.allowed) return null
  if (input.state?.routable === false) return { choices: [], notRoutable: input.state.note ?? ROUTING_COPY.noRoutable }
  if (input.routeChoices === null && input.state === null) return null
  if (input.routeChoices === null) return { choices: [], notRoutable: input.state?.note ?? ROUTING_COPY.noRoutable }
  return { choices: [...input.routeChoices], notRoutable: null }
}

/** A card the owner does not own (a served session) never gets a route dial. */
export function routeDialAllowed(input: { remote: boolean; served: boolean }): boolean {
  return !input.remote && !input.served
}
