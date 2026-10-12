import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TerminalNodeData } from '../../shared/model'
import type { TurnPhase } from '../../shared/turn'
import {
  DIRECT,
  ROUTE_ID_RE,
  type CardRoute,
  type CardRouteState,
  type RouteDecision,
  type RouteModel,
  type RouteQuota,
  type RouteState,
  type RouteTurnFacts
} from '../../shared/route'
import type { HarnessId } from '../harness'
import { ROUTABLE, routeEnv, type RouteEnv } from '../route-env'
import { fetchCatalog, fetchQuotas, providersOf, withLocalRows, type CatalogFetch } from './catalog'
import { RouteDecisions, pushLive } from './decisions'
import { DEFAULT_PORT } from './discovery'
import type { GatewayMonitor, GatewayProbe } from './gateway'
import { ADD_KEY_STEM, HarnessScan, groupLineFor, setupLines } from './setup'
import { keyFor, readRouteKeys, type RouteKeys } from './route-keys'

/**
 * THE ROUTE SERVICE — one object main keeps, every route question answered
 * from it (route program, core lane).
 *
 * It composes the monitor (is the gateway here), the catalog (what it
 * serves), the decisions (where each turn went) and the owner's one choice
 * (the default model) into RouteState for the panel, and into a CardRouteState
 * and a spawn env for each card. Two emitters: 'route' with the whole state
 * on any change (debounced to at most one a second, the SSE and IPC fan it
 * out) and 'card-route' with one card's state when its route, decision or
 * turn facts change.
 *
 * THE KEY NEVER LEAVES MAIN. RouteState carries the gateway without it; the
 * only places that read it are the spawn env (route-env.ts) and the
 * gateway reads here. The read-only wall token can read RouteState.
 *
 * THE DEFAULT IS CHOSEN ONCE. New cards route to `defaultModel` only when the
 * gateway is online AND a default was named — by the plugin file (the owner
 * picked Cookrew's model on magpie's Agents page) or by PUT /api/route/default.
 * It is never inferred from the catalog: a fleet on claude.ai must never be
 * moved onto a local model because a gateway appeared.
 *
 * SERVED SESSIONS NEVER GET A ROUTE (design D3): a stranger's seat on this
 * machine runs on nothing of the owner's — no env, no default, no PUT, and
 * the Seatbelt profile denies the gateway's port outright (sandbox-deny.ts).
 *
 * WHAT WAS RECORDED IS WHAT A PROCESS GOT. `envFor` computes; `recordEffective`
 * is called by the spawner only when the attach CREATED a process (a tmux
 * reattach ignores the boot command, so nothing it was handed applies).
 */

export interface RouteServiceDeps {
  monitor: GatewayMonitor
  fetch: CatalogFetch
  home: string
  pathEnv: string | undefined
  pluginDir: string
  node: (terminalId: string) => TerminalNodeData | null
  updateNode: (terminalId: string, patch: Partial<TerminalNodeData>) => void
  isServed: (terminalId: string) => boolean
  harnessOf: (command: string) => HarnessId | null
  phaseOf: (terminalId: string) => TurnPhase | undefined
  canRestoreExact: (node: TerminalNodeData) => boolean
  /** Kill and respawn the card in place with exact context; true when it did. */
  respawn: (terminalId: string) => Promise<boolean>
  /** Has this card recorded any turn? A card with none and no session id has nothing to lose in a respawn. */
  hasTurns?: (terminalId: string) => boolean
  /**
   * Is the session the node names still on disk? Right after a restart the
   * exact-context gate says no until the lazy tracker has verified the
   * session; a file that exists is resumed by the harness itself, so a
   * respawn loses nothing. Refuses (false) with no session id or no file.
   */
  sessionOnDisk?: (node: TerminalNodeData) => boolean
  /** Every terminal node across workspaces, for seeding the routed set at boot. */
  terminalsAcross?: () => readonly TerminalNodeData[]
  /** The per-harness gateway key names (~/.cookrew/route-keys.json); default reads the file. Injected for tests. */
  routeKeys?: () => RouteKeys
  dockCommands: () => readonly string[]
  /** The harness scan (installed, signed in, in dock), cached; injected for tests. */
  scan?: HarnessScan
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
  writeFile?: (file: string, content: string) => void
}

export interface SpawnRoute {
  env: Record<string, string>
  args: string[]
  effective: CardRoute
  offline: boolean
}

const DEFAULT_FILE = 'route.json'
const ANNOUNCE_MS = 1000

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}

function writeFile0600(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, content, { mode: 0o600 })
}

export class RouteService extends EventEmitter {
  private models: RouteModel[] = []
  private quotas: RouteQuota[] = []
  private live: RouteDecision[] = []
  private ownerDefault: string | null
  private readonly offlineAtSpawn = new Set<string>()
  /** Cards whose running process was handed a route — the only ones a turn is followed for. */
  private readonly routed = new Set<string>()
  private readonly decisions: RouteDecisions
  private readonly scan: HarnessScan
  private holds = 0
  private releaseMonitor: (() => void) | null = null
  private announceTimer: (() => void) | null = null
  private announcePending = false
  private catalogFor = ''

  constructor(private readonly deps: RouteServiceDeps) {
    super()
    this.ownerDefault = this.readOwnerDefault()
    this.scan = deps.scan ?? new HarnessScan({ home: deps.home, pathEnv: deps.pathEnv, dockCommands: deps.dockCommands, harnessOfCommand: (c) => deps.harnessOf(c) })
    this.decisions = new RouteDecisions({
      fetch: (input, init) => deps.fetch(input, init),
      gateway: () => {
        const p = deps.monitor.probe
        return p.status === 'online' && p.gateway ? { url: p.gateway.url, key: p.key } : null
      },
      now: deps.now,
      schedule: deps.schedule,
      onDecision: (decision) => {
        this.live = pushLive(this.live, decision)
        this.emitCard(decision.terminalId)
        this.announce()
      },
      onTurn: (terminalId) => this.emitCard(terminalId),
      harnessSession: (terminalId) => deps.node(terminalId)?.claudeSessionId ?? null
    })
  }

  // ---- the whole state

  /** The gateway's bearer, main-only (never on RouteState): for the scrub. */
  gatewayKey(): string | null {
    const key = this.deps.monitor.probe.key
    return typeof key === 'string' && key.length > 0 ? key : null
  }

  state(): RouteState {
    const probe = this.deps.monitor.probe
    const lines = setupLines(this.deps.pluginDir)
    return {
      status: probe.status,
      gateway: probe.gateway,
      why: probe.why,
      defaultModel: this.defaultModel(),
      providers: providersOf(this.models),
      models: this.models,
      quotas: this.quotas,
      live: this.live,
      harnesses: this.scan.rows(),
      checkedAt: probe.checkedAt,
      autoGroup: this.models.some((m) => m.id === 'group/auto'),
      setup: { ...lines, addKeyLine: ADD_KEY_STEM, addGroupLine: groupLineFor(this.models.map((m) => m.id)) }
    }
  }

  health(): { status: RouteState['status']; source: 'plugin' | 'probe' | null; providers: number; live: number } {
    const probe = this.deps.monitor.probe
    return { status: probe.status, source: probe.gateway?.source ?? null, providers: providersOf(this.models), live: this.decisions.following.length }
  }

  /** The port(s) a served sandbox must not reach: the one found, and the default. */
  gatewayPorts(): number[] {
    const found = this.deps.monitor.probe.gateway?.port
    return found ? [found, DEFAULT_PORT] : [DEFAULT_PORT]
  }

  /** The plugin's pick wins; else the owner's own; else nothing. */
  defaultModel(): string | null {
    return this.deps.monitor.probe.defaultModel ?? this.ownerDefault
  }

  setDefault(model: string | null): RouteState {
    this.ownerDefault = model
    const file = path.join(this.deps.home, '.cookrew', DEFAULT_FILE)
    ;(this.deps.writeFile ?? writeFile0600)(file, `${JSON.stringify({ defaultModel: model })}\n`)
    this.announce()
    return this.state()
  }

  /** The panel, a rail or the main window is looking: the monitor's clock runs while it does. */
  hold(): () => void {
    this.holds += 1
    if (this.holds === 1) this.releaseMonitor = this.deps.monitor.listen((probe) => void this.onProbe(probe))
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds -= 1
      if (this.holds === 0) {
        this.releaseMonitor?.()
        this.releaseMonitor = null
      }
    }
  }

  /** One probe now, whoever is or is not looking. */
  async refresh(): Promise<RouteState> {
    const probe = await this.deps.monitor.refresh()
    await this.onProbe(probe)
    return this.state()
  }

  // ---- one card

  cardState(terminalId: string): CardRouteState {
    const node = this.deps.node(terminalId)
    const route = this.routeOf(node)
    const effective = node?.routeEffective ?? null
    return {
      route,
      effective,
      appliesOn: effective === null || effective === route ? 'now' : 'restart',
      live: this.decisions.cardLive(terminalId),
      turn: this.decisions.cardTurn(terminalId),
      offline: this.offlineAtSpawn.has(terminalId),
      note: this.noteFor(node, route),
      gateway: this.deps.monitor.probe.status,
      routable: this.routableOf(node)
    }
  }

  private routableOf(node: TerminalNodeData | null): boolean {
    const harness = node ? this.deps.harnessOf(node.command) : null
    return harness !== null && ROUTABLE[harness]
  }

  /**
   * Nothing to restore is also nothing to lose: a card with no session id of
   * any harness and no recorded turn can be respawned at once, where the
   * exact-context gate would refuse for want of anything to restore.
   */
  private fresh(node: TerminalNodeData): boolean {
    const hasSession = Boolean(node.claudeSessionId || node.codexSessionRef || node.opencodeSessionId || node.piSessionId)
    return !hasSession && !(this.deps.hasTurns?.(node.id) ?? false)
  }

  /**
   * The sentence the rail shows beside the route. Codex always asks for
   * reasoning on the Responses path and a model that refuses it answers 400;
   * the catalog's `reasoning` flag cannot tell (every Ollama model reads
   * false, qwen3 included), so nothing is filtered — the owner is told. Pi
   * cannot be pointed at the gateway this round at all.
   */
  private noteFor(node: TerminalNodeData | null, route: CardRoute): string | null {
    if (!node) return null
    const harness = this.deps.harnessOf(node.command)
    if (harness !== null && !ROUTABLE[harness]) return `direct · ${harness} is not routable`
    if (harness === 'codex' && route !== DIRECT) return 'codex needs a thinking-capable model behind the gateway'
    return null
  }

  /**
   * For Sous, minting a decision: the card's route and what its process got —
   * one node lookup, no probe, no respawn. Null for a card that is not there.
   */
  routeOfCard(terminalId: string): { route: CardRoute; effective: CardRoute | null } | null {
    const node = this.deps.node(terminalId)
    if (!node) return null
    return { route: this.routeOf(node), effective: node.routeEffective ?? null }
  }

  /** The card's route as it stands: its own, else the fleet default, else direct. A served card is direct, always. */
  routeOf(node: TerminalNodeData | null): CardRoute {
    if (node === null) return DIRECT
    if (this.isServedNode(node)) return DIRECT
    if (node.route) return node.route
    const d = this.defaultModel()
    return this.deps.monitor.probe.status === 'online' && d ? d : DIRECT
  }

  async setCardRoute(terminalId: string, route: CardRoute): Promise<CardRouteState | { error: string }> {
    const node = this.deps.node(terminalId)
    if (!node) return { error: 'unknown terminal' }
    if (this.isServedNode(node)) return { error: 'a served session is never routed' }
    if (route !== DIRECT) {
      if (!ROUTE_ID_RE.test(route)) return { error: 'not a route id' }
      if (this.models.length > 0 && !this.models.some((m) => m.id === route)) return { error: `not in the catalog: ${route}` }
    }
    this.deps.updateNode(terminalId, { route })
    const phase = this.deps.phaseOf(terminalId)
    const idle = phase === undefined || phase === 'idle' || phase === 'replied'
    const after = this.deps.node(terminalId)
    const restorable = (node: TerminalNodeData): boolean =>
      this.deps.canRestoreExact(node) || this.fresh(node) || (this.deps.sessionOnDisk?.(node) ?? false)
    if (idle && after && (after.routeEffective ?? null) !== route && restorable(after)) {
      await this.deps.respawn(terminalId)
    }
    this.emitCard(terminalId)
    return this.cardState(terminalId)
  }

  /**
   * What a spawn would hand the harness. Pure of the node: nothing is
   * recorded here — the spawner calls recordEffective once it knows a
   * process was created (a reattach got none of this).
   */
  envFor(node: TerminalNodeData): SpawnRoute {
    const direct = (offline: boolean): SpawnRoute => ({ env: {}, args: [], effective: DIRECT, offline })
    if (this.isServedNode(node)) return direct(false)
    const route = this.routeOf(node)
    if (route === DIRECT) return direct(false)
    const probe = this.deps.monitor.probe
    if (probe.status !== 'online' || !probe.gateway) return direct(true)
    const harness = this.deps.harnessOf(node.command)
    if (!harness) return direct(false)
    const contextWindow = this.models.find((m) => m.id === route)?.contextWindow ?? null
    // The harness's own gateway key when the owner named one, else the app's.
    const key = keyFor((this.deps.routeKeys ?? (() => readRouteKeys(this.deps.home)))(), harness, probe.key)
    const r: RouteEnv = routeEnv({ harness, gateway: { url: probe.gateway.url, v1: probe.gateway.v1, key }, model: route, cardId: node.id, contextWindow })
    if (!r.routable) return direct(false)
    for (const f of r.files) (this.deps.writeFile ?? writeFile0600)(f.path, f.content)
    return { env: r.env, args: r.args, effective: route, offline: false }
  }

  /**
   * After a restart the routed set is empty while cards that were routed
   * BEFORE it still run — their node data says so (`routeEffective`), and
   * without this their activity never starts the long-poll and `live` stays
   * null for good. Called once at boot, before the first probe.
   */
  seedRouted(): number {
    let seeded = 0
    for (const node of this.deps.terminalsAcross?.() ?? []) {
      const effective = node.routeEffective ?? null
      if (effective === null || effective === DIRECT || this.isServedNode(node)) continue
      this.routed.add(node.id)
      seeded += 1
    }
    return seeded
  }

  /** A process was CREATED with this spawn: what it got is now the card's effective route. */
  recordEffective(terminalId: string, spawn: SpawnRoute): void {
    if (spawn.offline) this.offlineAtSpawn.add(terminalId)
    else this.offlineAtSpawn.delete(terminalId)
    if (spawn.effective === DIRECT) this.routed.delete(terminalId)
    else this.routed.add(terminalId)
    const node = this.deps.node(terminalId)
    if (node && !this.isServedNode(node)) this.deps.updateNode(terminalId, { routeEffective: spawn.effective })
    this.emitCard(terminalId)
  }

  /** A turn's phase moved. Only a card whose process was handed a route is looked at; the rest cost nothing. */
  onActivity(terminalId: string, phase: TurnPhase): void {
    if (!this.routed.has(terminalId)) return
    const inFlight = phase === 'thinking' || phase === 'waiting'
    if (inFlight) this.decisions.follow(terminalId)
    else this.decisions.unfollow(terminalId)
  }

  forget(terminalId: string): void {
    this.decisions.forget(terminalId)
    this.offlineAtSpawn.delete(terminalId)
    this.routed.delete(terminalId)
  }

  dispose(): void {
    this.decisions.dispose()
    this.releaseMonitor?.()
    this.releaseMonitor = null
    this.announceTimer?.()
    this.announceTimer = null
    this.scan.dispose()
  }

  // ---- internals

  private isServedNode(node: TerminalNodeData): boolean {
    return Boolean(node.servedSession) || this.deps.isServed(node.id)
  }

  private async onProbe(probe: GatewayProbe): Promise<void> {
    try {
      if (probe.status !== 'online' || !probe.gateway) {
        this.models = []
        this.quotas = []
        this.catalogFor = ''
        this.announce()
        return
      }
      const key = `${probe.gateway.url}|${probe.key}|${probe.checkedAt}`
      if (key === this.catalogFor) return
      this.catalogFor = key
      const [models, quotas] = await Promise.all([
        fetchCatalog(this.deps.fetch, probe.gateway.v1, probe.key),
        fetchQuotas(this.deps.fetch, probe.gateway.url, probe.key)
      ])
      this.models = models
      this.quotas = withLocalRows(quotas, models)
      this.announce()
    } catch {
      // A probe that could not be followed up leaves the last catalog in place; nothing rejects upward.
    }
  }

  private announce(): void {
    this.announcePending = true
    if (this.announceTimer) return
    this.announceTimer = (this.deps.schedule ?? defaultSchedule)(() => {
      this.announceTimer = null
      if (!this.announcePending) return
      this.announcePending = false
      this.emit('route', this.state())
    }, ANNOUNCE_MS)
  }

  private emitCard(terminalId: string): void {
    this.emit('card-route', { terminalId, ...this.cardState(terminalId) })
  }

  private readOwnerDefault(): string | null {
    const file = path.join(this.deps.home, '.cookrew', DEFAULT_FILE)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { defaultModel?: unknown }
      return typeof parsed.defaultModel === 'string' && parsed.defaultModel !== '' ? parsed.defaultModel : null
    } catch {
      return null
    }
  }
}

export type { RouteTurnFacts }
