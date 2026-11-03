import { existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { RouteGateway, RouteStatus } from '../../shared/route'
import { defaultDiscoveryEnv, discover, pluginFilePath, type DiscoveryEnv } from './discovery'

/**
 * THE GATEWAY MONITOR — is magpie here, and is it up (route program, core).
 *
 * One object the app keeps for its lifetime. It answers `status` from the
 * last probe and re-probes only when something asks: on demand (`refresh`),
 * on a change of the plugin file, and on a clock that runs ONLY while a
 * panel or a rail is listening — 30 s apart when online, backing off 30 →
 * 60 → 120 → 300 s while offline, never a hot loop, no timer at all with
 * nobody listening. A probe is one GET /api/hello with a short timeout;
 * `{"name":"magpie"}` is the only answer that counts as online.
 *
 * `absent` is a stronger word than offline: nothing on this machine names
 * magpie (no binary on PATH, no plugin file, no MAGPIE_ADDR), so there is
 * nothing to be offline. The rail says nothing about routes then.
 *
 * The plugin file ~/.cookrew/magpie.json is watched through fs.watch on its
 * DIRECTORY (the file may not exist yet) with a stat poll as the fallback
 * fs.watch needs on some volumes; both are armed only while listening.
 */

export interface GatewayProbe {
  status: RouteStatus
  gateway: RouteGateway | null
  /** The bearer for routed requests. Main-only: the service never puts it on RouteState. */
  key: string
  defaultModel: string | null
  /** Said when the status needs a reason (a refused host). */
  why: string | null
  checkedAt: number
}

export interface GatewayMonitorDeps {
  discovery?: DiscoveryEnv
  /** `which magpie`, answered as a boolean; injected so a test needs no binary. */
  hasBinary?: () => boolean
  fetch?: (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>
  now?: () => number
  /** setTimeout-shaped; injected so a test can run the clock. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** fs.watch-shaped on the plugin file's directory, answering null when it cannot watch (the stat poll then runs); injected for tests, null to disable watching. */
  watchDir?: ((dir: string, cb: () => void) => (() => void) | null) | null
  helloTimeoutMs?: number
  statPollMs?: number
}

export const ONLINE_EVERY_MS = 30_000
export const OFFLINE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}

/** Null when no watch could be placed — the caller then polls instead. */
const defaultWatchDir = (dir: string, cb: () => void): (() => void) | null => {
  let watcher: FSWatcher | null = null
  try {
    if (existsSync(dir)) watcher = watch(dir, { persistent: false }, () => cb())
  } catch {
    watcher = null
  }
  if (watcher === null) return null
  return () => watcher?.close()
}

export async function hello(
  fetchFn: NonNullable<GatewayMonitorDeps['fetch']>,
  url: string,
  timeoutMs: number
): Promise<{ ok: boolean; version: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchFn(`${url}/api/hello`, { signal: controller.signal, headers: { 'user-agent': 'cookrew' } })
    if (!res.ok) return { ok: false, version: null }
    const body = (await res.json()) as { name?: unknown; version?: unknown } | null
    if (!body || body.name !== 'magpie') return { ok: false, version: null }
    return { ok: true, version: typeof body.version === 'string' ? body.version : null }
  } catch {
    return { ok: false, version: null }
  } finally {
    clearTimeout(timer)
  }
}

export class GatewayMonitor {
  private readonly d: DiscoveryEnv
  private readonly hasBinary: () => boolean
  private readonly fetchFn: NonNullable<GatewayMonitorDeps['fetch']>
  private readonly now: () => number
  private readonly schedule: NonNullable<GatewayMonitorDeps['schedule']>
  private readonly watchDir: GatewayMonitorDeps['watchDir']
  private readonly helloTimeoutMs: number
  private readonly statPollMs: number

  private last: GatewayProbe = { status: 'absent', gateway: null, key: '', defaultModel: null, why: null, checkedAt: 0 }
  private readonly listeners = new Set<(probe: GatewayProbe) => void>()
  private cancelClock: (() => void) | null = null
  private cancelStat: (() => void) | null = null
  private unwatch: (() => void) | null = null
  private pluginStamp = ''
  private offlineStreak = 0
  private inFlight: Promise<GatewayProbe> | null = null

  constructor(deps: GatewayMonitorDeps = {}) {
    this.d = deps.discovery ?? defaultDiscoveryEnv()
    this.hasBinary = deps.hasBinary ?? (() => false)
    this.fetchFn = deps.fetch ?? ((input, init) => fetch(input, init))
    this.now = deps.now ?? Date.now
    this.schedule = deps.schedule ?? defaultSchedule
    this.watchDir = deps.watchDir === undefined ? defaultWatchDir : deps.watchDir
    this.helloTimeoutMs = deps.helloTimeoutMs ?? 1500
    this.statPollMs = deps.statPollMs ?? 10_000
  }

  get probe(): GatewayProbe {
    return this.last
  }

  /** Re-probe now. Concurrent callers share one request. */
  refresh(): Promise<GatewayProbe> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.run().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  /** While at least one listener is held, the clock and the file watch run. */
  listen(listener: (probe: GatewayProbe) => void): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.arm()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.disarm()
    }
  }

  private async run(): Promise<GatewayProbe> {
    const found = discover(this.d, this.hasBinary())
    const checkedAt = this.now()
    let next: GatewayProbe
    if (!found.known) {
      next = { status: 'absent', gateway: null, key: found.key, defaultModel: null, why: found.why, checkedAt }
    } else {
      const answer = await hello(this.fetchFn, found.gateway.url, this.helloTimeoutMs)
      next = {
        status: answer.ok ? 'online' : 'offline',
        gateway: { ...found.gateway, version: answer.version },
        key: found.key,
        defaultModel: found.defaultModel,
        why: null,
        checkedAt
      }
    }
    this.offlineStreak = next.status === 'offline' ? this.offlineStreak + 1 : 0
    const changed = JSON.stringify({ ...this.last, checkedAt: 0 }) !== JSON.stringify({ ...next, checkedAt: 0 })
    this.last = next
    if (changed) for (const l of this.listeners) l(next)
    if (this.listeners.size > 0) this.armClock()
    return next
  }

  private arm(): void {
    this.pluginStamp = this.stamp()
    const dir = path.dirname(pluginFilePath(this.d))
    // fs.watch is the immediacy layer; the stat poll is the backstop armed
    // ONLY when a watch could not be placed (the directory is missing, or the
    // volume does not deliver events), so a watched file costs no clock.
    this.unwatch = this.watchDir ? this.watchDir(dir, () => this.onPluginMaybeChanged()) : null
    if (this.unwatch === null) this.armStat()
    void this.refresh()
  }

  private disarm(): void {
    this.cancelClock?.()
    this.cancelClock = null
    this.cancelStat?.()
    this.cancelStat = null
    this.unwatch?.()
    this.unwatch = null
  }

  private armClock(): void {
    this.cancelClock?.()
    const wait =
      this.last.status === 'offline'
        ? OFFLINE_BACKOFF_MS[Math.min(this.offlineStreak - 1, OFFLINE_BACKOFF_MS.length - 1)]
        : ONLINE_EVERY_MS
    this.cancelClock = this.schedule(() => {
      this.cancelClock = null
      void this.refresh()
    }, wait)
  }

  private armStat(): void {
    this.cancelStat = this.schedule(() => {
      this.cancelStat = null
      this.onPluginMaybeChanged()
      if (this.listeners.size > 0) this.armStat()
    }, this.statPollMs)
  }

  private stamp(): string {
    try {
      const s = statSync(pluginFilePath(this.d))
      return `${s.size}:${s.mtimeMs}`
    } catch {
      return ''
    }
  }

  private onPluginMaybeChanged(): void {
    const stamp = this.stamp()
    if (stamp === this.pluginStamp) return
    this.pluginStamp = stamp
    void this.refresh()
  }
}
