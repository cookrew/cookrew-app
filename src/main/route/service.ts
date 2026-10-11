import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TerminalNodeData } from '../../shared/model'
import type { TurnPhase } from '../../shared/turn'
import {
  DIRECT,
  type CardRoute,
  type CardRouteState,
  type RouteDecision,
  type RouteModel,
  type RouteQuota,
  type RouteState,
  type RouteTurnFacts
} from '../../shared/route'
import type { HarnessId } from '../harness'
import { routeEnv, type RouteEnv } from '../route-env'
import { fetchCatalog, fetchQuotas, providersOf, type CatalogFetch } from './catalog'
import { RouteDecisions, pushLive } from './decisions'
import type { GatewayMonitor, GatewayProbe } from './gateway'
import { groupLineFor, harnessRows, setupLines, type HarnessRowDeps } from './setup'

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
 * THE DEFAULT IS CHOSEN ONCE. New cards route to `defaultModel` only when the
 * gateway is online AND a default was named — by the plugin file (the owner
 * picked Cookrew's model on magpie's Agents page) or by PUT /api/route/default.
 * It is never inferred from the catalog: a fleet on claude.ai must never be
 * moved onto a local model because a gateway appeared.
 *
 * SERVED SESSIONS NEVER GET A ROUTE ENV (design D3): a stranger's seat on
 * this machine runs on nothing of the owner's. `envFor` answers nothing for a
 * served node, and a test pins it.
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
  dockCommands: () => readonly string[]
  claudeKeychain?: () => boolean
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
  private readonly decisions: RouteDecisions
  private holds = 0
  private releaseMonitor: (() => void) | null = null
  private announceTimer: (() => void) | null = null
  private announcePending = false
  private catalogFor = ''

  constructor(private readonly deps: RouteServiceDeps) {
    super()
    this.ownerDefault = this.readOwnerDefault()
    this.decisions = new RouteDecisions({
      fetch: (input, init) => deps.fetch(input, init),
      gateway: () => {
        const g = deps.monitor.probe.gateway
        return deps.monitor.probe.status === 'online' && g ? { url: g.url, key: g.key } : null
      },
      now: deps.now,
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

  state(): RouteState {
    const probe = this.deps.monitor.probe
    const lines = setupLines(this.deps.pluginDir)
    return {
      status: probe.status,
      gateway: probe.gateway,
      defaultModel: this.defaultModel(),
      providers: providersOf(this.models),
      models: this.models,
      quotas: this.quotas,
      live: this.live,
      harnesses: harnessRows(this.rowDeps()),
      checkedAt: probe.checkedAt,
      setup: { ...lines, addKeyLine: lines.addKeyLine('<preset>'), addGroupLine: groupLineFor(this.models.map((m) => m.id)) }
    }
  }

  health(): { status: RouteState['status']; source: 'plugin' | 'probe' | null; providers: number; live: number } {
    const probe = this.deps.monitor.probe
    return { status: probe.status, source: probe.gateway?.source ?? null, providers: providersOf(this.models), live: this.decisions.following.length }
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

  /** The panel or a rail is looking: the monitor's clock runs while it does. */
  hold(): () => void {
    this.holds += 1
    if (this.holds === 1) this.releaseMonitor = this.deps.monitor.listen((probe) => this.onProbe(probe))
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
  refresh(): Promise<RouteState> {
    return this.deps.monitor.refresh().then((probe) => this.onProbe(probe)).then(() => this.state())
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
      offline: this.offlineAtSpawn.has(terminalId)
    }
  }

  /** The card's route as it stands: its own, else the fleet default, else direct. */
  routeOf(node: TerminalNodeData | null): CardRoute {
    if (node?.route) return node.route
    const d = this.defaultModel()
    return this.deps.monitor.probe.status === 'online' && d ? d : DIRECT
  }

  async setCardRoute(terminalId: string, route: CardRoute): Promise<CardRouteState | { error: string }> {
    const node = this.deps.node(terminalId)
    if (!node) return { error: 'unknown terminal' }
    if (route !== DIRECT && this.models.length > 0 && !this.models.some((m) => m.id === route)) {
      return { error: `not in the catalog: ${route}` }
    }
    this.deps.updateNode(terminalId, { route })
    const phase = this.deps.phaseOf(terminalId)
    const idle = phase === undefined || phase === 'idle' || phase === 'replied'
    const after = this.deps.node(terminalId)
    if (idle && after && this.deps.canRestoreExact(after) && (after.routeEffective ?? null) !== route) {
      await this.deps.respawn(terminalId)
    }
    this.emitCard(terminalId)
    return this.cardState(terminalId)
  }

  /** What the spawn hands the harness; recorded on the node as `routeEffective`. */
  envFor(node: TerminalNodeData): SpawnRoute {
    const direct = (offline: boolean): SpawnRoute => ({ env: {}, args: [], effective: DIRECT, offline })
    if (this.deps.isServed(node.id) || node.servedSession) return this.record(node.id, direct(false), false)
    const route = this.routeOf(node)
    if (route === DIRECT) return this.record(node.id, direct(false), true)
    const probe = this.deps.monitor.probe
    if (probe.status !== 'online' || !probe.gateway) return this.record(node.id, direct(true), true)
    const harness = this.deps.harnessOf(node.command)
    if (!harness) return this.record(node.id, direct(false), true)
    const r: RouteEnv = routeEnv({ harness, gateway: probe.gateway, model: route, cardId: node.id })
    if (!r.routable) return this.record(node.id, direct(false), true)
    for (const f of r.files) (this.deps.writeFile ?? writeFile0600)(f.path, f.content)
    return this.record(node.id, { env: r.env, args: r.args, effective: route, offline: false }, true)
  }

  private record(terminalId: string, spawn: SpawnRoute, persist: boolean): SpawnRoute {
    if (spawn.offline) this.offlineAtSpawn.add(terminalId)
    else this.offlineAtSpawn.delete(terminalId)
    if (persist) this.deps.updateNode(terminalId, { routeEffective: spawn.effective })
    this.emitCard(terminalId)
    return spawn
  }

  /** A turn's phase moved: follow a routed card in flight, drop it when it rests. */
  onActivity(terminalId: string, phase: TurnPhase): void {
    const inFlight = phase === 'thinking' || phase === 'waiting'
    const node = this.deps.node(terminalId)
    const routed = node !== null && (node.routeEffective ?? null) !== null && node.routeEffective !== DIRECT && !this.deps.isServed(terminalId)
    if (inFlight && routed) this.decisions.follow(terminalId)
    else this.decisions.unfollow(terminalId)
  }

  forget(terminalId: string): void {
    this.decisions.forget(terminalId)
    this.offlineAtSpawn.delete(terminalId)
  }

  dispose(): void {
    this.decisions.dispose()
    this.releaseMonitor?.()
    this.announceTimer?.()
  }

  // ---- internals

  private async onProbe(probe: GatewayProbe): Promise<void> {
    if (probe.status !== 'online' || !probe.gateway) {
      if (this.models.length > 0 || this.quotas.length > 0) {
        this.models = []
        this.quotas = []
      }
      this.catalogFor = ''
      this.announce()
      return
    }
    const key = `${probe.gateway.url}|${probe.gateway.key}|${probe.checkedAt}`
    if (key === this.catalogFor) return
    this.catalogFor = key
    const [models, quotas] = await Promise.all([
      fetchCatalog(this.deps.fetch, probe.gateway.v1, probe.gateway.key),
      fetchQuotas(this.deps.fetch, probe.gateway.url, probe.gateway.key)
    ])
    this.models = models
    this.quotas = quotas
    this.announce()
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

  private rowDeps(): HarnessRowDeps {
    return {
      home: this.deps.home,
      pathEnv: this.deps.pathEnv,
      dockCommands: this.deps.dockCommands,
      harnessOfCommand: (c) => this.deps.harnessOf(c),
      claudeKeychain: this.deps.claudeKeychain
    }
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
