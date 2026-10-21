// THE FLEET STORE: every desktop of the account, kept live at once through the
// relay. Framework-free and fully injected, so the link machine is tested in
// node without a DOM; use-fleet.ts is the React face of one shared instance.
//
// Per machine, one link:
//   unpaired    no token in this browser (or the desktop refused it)
//   connecting  GET <base>api/levels in flight, or the stream not yet delivering
//   live        the levels stream has delivered its snapshot
//   offline     the registry says so, or the relay has no line to it
//   outdated    it answers, but not the levels API: the classic OPEN
//   error       anything else; retried with backoff
// A connect is ONE snapshot GET (it classifies — EventSource cannot read a
// status) and then ONE stream, the machine's whole live budget for levels 0–2.
import type { FleetMachine, LevelsSnapshot, MachineLink, StrataMachine } from '../../shared/strata'
import { backoffDelay, OUTDATED_RECHECK_MS } from './backoff'
import type { FleetCache } from './fleet-cache'
import { isLevelsSnapshot, parseFleetList, parseLevelsEvent } from './guards'
import { foldLevels } from './levels-fold'
import { outcomeOf, outcomeOfThrow, type LinkDetail, type LinkOutcome } from './link-outcome'

export interface FleetResponse {
  status: number
  json(): Promise<unknown>
}

export interface FleetFetchInit {
  headers?: Record<string, string>
  signal?: AbortSignal
  credentials?: 'same-origin'
  cache?: 'no-store'
}

export interface StreamHandlers {
  onMessage(data: string): void
  /** The stream is gone for good: the store owns every retry, never the transport. */
  onError(): void
}

export interface LevelsStream {
  close(): void
}

export interface VisibilitySource {
  hidden(): boolean
  onChange(run: () => void): () => void
}

export interface FleetDeps {
  fetch(url: string, init: FleetFetchInit): Promise<FleetResponse>
  openStream(url: string, handlers: StreamHandlers): LevelsStream
  /** This browser's pairing token for that desktop, or null. Never logged, never stored by the store. */
  token(machineId: string): string | null
  cache: FleetCache
  now(): number
  random(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  visibility: VisibilitySource
  /** The network came back, or a pairing token changed in another tab. */
  onWake?(run: () => void): () => void
}

export interface FleetConfig {
  /** The registry's list: '/v2/me/desktops' in production, '/fleet.json' in the preview. */
  listUrl: string
  /** Production: no token means unpaired. The preview's mock needs none. */
  requireToken: boolean
  /** PREVIEW ONLY: last-known snapshots the mock hands out for machines this browser never saw. */
  seedCacheUrl: string | null
  listRefreshMs: number
  hiddenCloseMs: number
  requestTimeoutMs: number
  /** A link live this long has its backoff reset when it next drops. */
  stableMs: number
}

export const FLEET_TIMINGS = {
  listRefreshMs: 60_000,
  hiddenCloseMs: 60_000,
  requestTimeoutMs: 10_000,
  stableMs: 10_000
} as const

/** The relay's account cap (registry/src/v2-canvas-relay.ts `perAccount`). */
export const ONLINE_CAP = 8
/** Stream drops in a row, without ever going live, before the link reads offline. */
const STREAM_PATIENCE = 3

export interface FleetStore {
  start(): void
  stop(): void
  subscribe(listener: () => void): () => void
  getSnapshot(): StrataMachine[]
  /** Why a link is where it is, for retry copy; null while live. */
  detail(machineId: string): LinkDetail | null
  /** A user's RETRY: backoff forgotten, connect now. */
  retry(machineId: string): void
  refresh(): Promise<void>
}

interface Entry {
  row: FleetMachine
  link: MachineLink
  levels: LevelsSnapshot | null
  detail: LinkDetail | null
  /** Retries since the link was last stable. */
  attempt: number
  liveSince: number | null
  /** Resyncs in a row without a delta landing in between. */
  gaps: number
}

/** The live handles of one machine. `gen` voids every callback of an earlier connect. */
interface Handles {
  gen: number
  abort: AbortController | null
  stream: LevelsStream | null
  timer: unknown
  /** The stream has delivered its opening snapshot. */
  streamed: boolean
  /** The token the desktop last refused, held only to compare: never emitted or logged. */
  refused: string | null
}

const IDLE: Omit<Handles, 'gen' | 'refused'> = { abort: null, stream: null, timer: null, streamed: false }

const freshEntry = (row: FleetMachine, levels: LevelsSnapshot | null): Entry => ({
  row,
  link: row.online ? 'connecting' : 'offline',
  levels,
  detail: row.online ? null : 'no-link',
  attempt: 0,
  liveSince: null,
  gaps: 0
})

export const createFleetStore = (deps: FleetDeps, config: FleetConfig): FleetStore => {
  let entries = new Map<string, Entry>()
  let order: string[] = []
  const handles = new Map<string, Handles>()
  const listeners = new Set<() => void>()
  const rows = new WeakMap<Entry, StrataMachine>()
  let snapshot: StrataMachine[] = []
  let dirty = true
  let notifyQueued = false
  let started = false
  let paused = false
  let hideTimer: unknown = null
  let listTimer: unknown = null
  let listing: Promise<void> | null = null
  let unsubscribe: Array<() => void> = []

  const notify = () => {
    dirty = true
    if (notifyQueued) return
    notifyQueued = true
    queueMicrotask(() => {
      notifyQueued = false
      for (const listener of [...listeners]) listener()
    })
  }

  const update = (id: string, change: (entry: Entry) => Entry) => {
    const entry = entries.get(id)
    if (!entry) return
    const next = change(entry)
    if (next === entry) return
    entries = new Map(entries).set(id, next)
    notify()
  }

  const handlesOf = (id: string): Handles => handles.get(id) ?? { gen: 0, refused: null, ...IDLE }
  const patchHandles = (id: string, patch: Partial<Handles>) => handles.set(id, { ...handlesOf(id), ...patch })
  const current = (id: string, gen: number) => handles.get(id)?.gen === gen

  /** Drops whatever the machine holds open and voids its pending callbacks. */
  const release = (id: string) => {
    const held = handlesOf(id)
    held.abort?.abort()
    held.stream?.close()
    if (held.timer !== null) deps.clearTimer(held.timer)
    handles.set(id, { ...held, ...IDLE, gen: held.gen + 1 })
  }

  const schedule = (id: string, ms: number) => {
    const timer = deps.setTimer(() => {
      if (handlesOf(id).timer === timer) connect(id)
    }, ms)
    patchHandles(id, { timer })
  }

  const fail = (id: string, outcome: LinkOutcome) => {
    const entry = entries.get(id)
    if (!entry) return
    release(id)
    const stable = entry.liveSince !== null && deps.now() - entry.liveSince >= config.stableMs
    const attempt = stable ? 0 : entry.attempt
    const link: MachineLink = outcome.detail === 'stream-dropped' && attempt >= STREAM_PATIENCE ? 'offline' : outcome.link
    update(id, (e) => ({ ...e, link, detail: outcome.detail, attempt: attempt + 1, liveSince: null }))
    if (outcome.retry === 'never' || paused) return
    schedule(id, outcome.retry === 'outdated' ? OUTDATED_RECHECK_MS : backoffDelay(attempt, deps.random()))
  }

  /** A hole in the revs: resync at once the first time, back off if it keeps happening. */
  const resync = (id: string) => {
    const entry = entries.get(id)
    if (!entry) return
    if (entry.gaps === 0) {
      update(id, (e) => ({ ...e, gaps: e.gaps + 1 }))
      connect(id)
      return
    }
    update(id, (e) => ({ ...e, gaps: e.gaps + 1 }))
    fail(id, { link: 'connecting', detail: 'gap', retry: 'backoff' })
  }

  const onStreamData = (id: string, data: string) => {
    const entry = entries.get(id)
    const event = parseLevelsEvent(data)
    if (!entry || !event || (!handlesOf(id).streamed && event.type !== 'snapshot')) return resync(id)
    const folded = foldLevels(entry.levels, event)
    if (!folded.ok) return resync(id)
    const firstLive = entry.link !== 'live'
    patchHandles(id, { streamed: true })
    update(id, (e) => ({
      ...e,
      levels: folded.levels,
      link: 'live',
      detail: null,
      liveSince: firstLive ? deps.now() : e.liveSince,
      gaps: event.type === 'snapshot' ? e.gaps : 0
    }))
    deps.cache.saveLevels(id, folded.levels, firstLive)
  }

  const openStream = (id: string, gen: number, token: string | null) => {
    const entry = entries.get(id)
    if (!entry) return
    const query = token ? `?token=${encodeURIComponent(token)}` : ''
    const stream = deps.openStream(`${entry.row.base}api/levels/stream${query}`, {
      onMessage: (data) => {
        if (current(id, gen)) onStreamData(id, data)
      },
      onError: () => {
        if (current(id, gen)) fail(id, { link: 'connecting', detail: 'stream-dropped', retry: 'backoff' })
      }
    })
    patchHandles(id, { stream })
  }

  const connect = (id: string) => {
    release(id)
    const entry = entries.get(id)
    if (!entry || !started || paused) return
    if (!entry.row.online) {
      update(id, (e) => (e.link === 'offline' && e.detail === 'no-link' ? e : { ...e, link: 'offline', detail: 'no-link', liveSince: null }))
      return
    }
    const token = deps.token(id)
    if (config.requireToken && !token) {
      update(id, (e) => ({ ...e, link: 'unpaired', detail: 'no-token', liveSince: null }))
      return
    }
    const { gen } = handlesOf(id)
    const abort = new AbortController()
    let timedOut = false
    const timer = deps.setTimer(() => {
      timedOut = true
      abort.abort()
    }, config.requestTimeoutMs)
    patchHandles(id, { abort, timer: null })
    update(id, (e) => (e.link === 'connecting' ? e : { ...e, link: 'connecting', liveSince: null }))
    deps
      .fetch(`${entry.row.base}api/levels`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: abort.signal,
        credentials: 'same-origin',
        cache: 'no-store'
      })
      .then(async (response) => ({ status: response.status, body: await response.json().catch(() => undefined) }))
      .then(
        ({ status, body }) => {
          deps.clearTimer(timer)
          if (!current(id, gen)) return
          patchHandles(id, { abort: null })
          if (status === 200 && isLevelsSnapshot(body)) {
            update(id, (e) => ({ ...e, levels: body, detail: null }))
            openStream(id, gen, token)
            return
          }
          if (status === 401 || status === 403) patchHandles(id, { refused: token })
          fail(id, outcomeOf(status, body))
        },
        () => {
          deps.clearTimer(timer)
          if (current(id, gen)) fail(id, outcomeOfThrow(timedOut))
        }
      )
  }

  /** After a list refresh: what this machine should do now that its row may have changed. */
  const reconsider = (id: string, before: Entry | undefined) => {
    const entry = entries.get(id)
    if (!entry) return
    const held = handlesOf(id)
    const busy = held.abort !== null || held.stream !== null || held.timer !== null
    if (!before) return connect(id)
    if (!entry.row.online) {
      if (entry.link !== 'live') connect(id)
      return
    }
    if (entry.link === 'outdated') {
      if (before.row.appVersion !== entry.row.appVersion) connect(id)
      return
    }
    if (entry.link === 'unpaired' && entry.detail === 'refused' && held.refused === deps.token(id)) return
    if (!busy) connect(id)
  }

  const merge = (next: FleetMachine[]) => {
    const before = entries
    const ids = new Set(next.map((row) => row.id))
    for (const id of order) {
      if (ids.has(id)) continue
      release(id)
      handles.delete(id)
      deps.cache.forget(id)
    }
    entries = new Map(
      next.map((row) => {
        const old = before.get(row.id)
        return [row.id, old ? { ...old, row } : freshEntry(row, deps.cache.levels(row.id)?.levels ?? null)]
      })
    )
    order = next.map((row) => row.id)
    notify()
    for (const row of next) reconsider(row.id, before.get(row.id))
  }

  const loadList = (): Promise<void> => {
    if (listing) return listing
    if (listTimer !== null) deps.clearTimer(listTimer)
    listTimer = null
    listing = deps
      .fetch(config.listUrl, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (response.status !== 200) return
        const list = parseFleetList(await response.json())
        if (!started) return
        merge(list)
        deps.cache.saveList(list)
      })
      .catch(() => undefined)
      .finally(() => {
        listing = null
        if (started && !paused) listTimer = deps.setTimer(() => void loadList(), config.listRefreshMs)
      })
    return listing
  }

  /** PREVIEW ONLY: fill machines this browser never saw from the mock's stand-in cache. */
  const seed = (url: string) =>
    deps
      .fetch(url, { cache: 'no-store' })
      .then((response) => (response.status === 200 ? response.json() : null))
      .then((body) => {
        if (typeof body !== 'object' || body === null) return
        for (const [id, levels] of Object.entries(body as Record<string, unknown>)) {
          if (isLevelsSnapshot(levels)) update(id, (e) => (e.levels ? e : { ...e, levels }))
        }
      })
      .catch(() => undefined)

  const flushCache = () => {
    for (const entry of entries.values()) {
      if (entry.link === 'live' && entry.levels) deps.cache.saveLevels(entry.row.id, entry.levels, true)
    }
  }

  /** Hidden for hiddenCloseMs: every stream closes, nothing retries until the tab is back. */
  const pause = () => {
    hideTimer = null
    flushCache()
    paused = true
    if (listTimer !== null) deps.clearTimer(listTimer)
    listTimer = null
    for (const id of order) release(id)
    for (const id of order) update(id, (e) => (e.link === 'live' ? { ...e, link: 'connecting', liveSince: null } : e))
  }

  const resume = () => {
    paused = false
    for (const id of order) connect(id)
    void loadList()
  }

  const onVisibility = () => {
    if (deps.visibility.hidden()) {
      if (hideTimer === null && !paused) hideTimer = deps.setTimer(pause, config.hiddenCloseMs)
      return
    }
    if (hideTimer !== null) deps.clearTimer(hideTimer)
    hideTimer = null
    if (paused) resume()
  }

  /** Network back or a token changed: everything not live tries now, backoff forgotten. */
  const wake = () => {
    if (!started || paused) return
    for (const id of order) {
      if (entries.get(id)?.link === 'live') continue
      update(id, (e) => ({ ...e, attempt: 0 }))
      connect(id)
    }
  }

  const machineOf = (entry: Entry): StrataMachine => {
    const known = rows.get(entry)
    if (known) return known
    const row: StrataMachine = { ...entry.row, link: entry.link, levels: entry.levels, stale: entry.levels !== null && entry.link !== 'live' }
    rows.set(entry, row)
    return row
  }

  return {
    start() {
      if (started) return
      started = true
      const cached = deps.cache.list() ?? []
      entries = new Map(cached.map((row) => [row.id, freshEntry(row, deps.cache.levels(row.id)?.levels ?? null)]))
      order = cached.map((row) => row.id)
      notify()
      unsubscribe = [deps.visibility.onChange(onVisibility), ...(deps.onWake ? [deps.onWake(wake)] : [])]
      if (deps.visibility.hidden()) onVisibility()
      for (const id of order) connect(id)
      void loadList().then(() => (config.seedCacheUrl ? seed(config.seedCacheUrl) : undefined))
    },
    stop() {
      if (!started) return
      flushCache()
      started = false
      paused = false
      for (const off of unsubscribe) off()
      unsubscribe = []
      for (const timer of [hideTimer, listTimer]) if (timer !== null) deps.clearTimer(timer)
      hideTimer = null
      listTimer = null
      for (const id of order) release(id)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot() {
      if (dirty) {
        snapshot = order.flatMap((id) => {
          const entry = entries.get(id)
          return entry ? [machineOf(entry)] : []
        })
        dirty = false
      }
      return snapshot
    },
    detail: (machineId) => entries.get(machineId)?.detail ?? null,
    retry(machineId) {
      update(machineId, (e) => ({ ...e, attempt: 0, gaps: 0 }))
      patchHandles(machineId, { refused: null })
      connect(machineId)
    },
    refresh: () => loadList()
  }
}
