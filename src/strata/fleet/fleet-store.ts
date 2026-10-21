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
import type { FleetMachine, FleetPresence, LevelsSnapshot, MachineLink, StrataMachine } from '../../shared/strata'
import { backoffDelay, OUTDATED_RECHECK_MS } from './backoff'
import type { FleetCache } from './fleet-cache'
import { isLevelsSnapshot, parseFleetList, parseFleetPresence, parseLevelsEvent } from './guards'
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
  /** A `:` comment line: the desktop's 15 s keep-alive. Proves the line is alive, carries nothing. */
  onPing(): void
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
  /** `token` goes in a header, never the URL: the transport reads status and pings, which EventSource cannot. */
  openStream(url: string, token: string | null, handlers: StreamHandlers): LevelsStream
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
  /** The registry's list, GET /v2/me/desktops: read at start and when presence names a stranger. */
  listUrl: string
  /** GET /v2/me/presence: who is online, every desktop in one answer with the account cap, on a timer. */
  presenceUrl: string
  /** Production: no token means unpaired. The preview's mock needs none. */
  requireToken: boolean
  /** PREVIEW ONLY: last-known snapshots the mock hands out for machines this browser never saw. */
  seedCacheUrl: string | null
  presenceRefreshMs: number
  hiddenCloseMs: number
  requestTimeoutMs: number
  /** A link live this long has its backoff reset when it next drops. */
  stableMs: number
  /** No event and no ping for this long (three missed pings) = the stream is dead without saying so. */
  silenceMs: number
}

export const FLEET_TIMINGS = {
  presenceRefreshMs: 60_000,
  hiddenCloseMs: 60_000,
  requestTimeoutMs: 10_000,
  stableMs: 10_000,
  silenceMs: 45_000
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
  /** The list has answered: from this browser's cache, live, or with an error (UseFleetLoaded). */
  loaded(): boolean
  /**
   * The user is in that machine now (a level inside it, or a dive). Over a
   * stream budget it streams first, then the most recently entered ones.
   */
  enter(machineId: string): void
  /**
   * How many levels streams the page may hold at once: Infinity on HTTP/2,
   * a handful on HTTP/1.1 where Chrome allows six connections per origin and
   * the embed's documents take theirs first. The rest are parked.
   */
  setStreamLimit(limit: number): void
  /** The registry's last word on the account's lines: cap and how many are online. Null before one. */
  presence(): Pick<FleetPresence, 'cap' | 'online'> | null
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
  /**
   * Answering, but not streamed: over HTTP/1.1 the page cannot hold a stream
   * per machine (stream budget below). Its snapshot is the one read when it
   * was last connected or entered; presence keeps its line. Internal only:
   * its row does not change (machineOf).
   */
  parked: boolean
}

/** The live handles of one machine. `gen` voids every callback of an earlier connect. */
interface Handles {
  gen: number
  abort: AbortController | null
  stream: LevelsStream | null
  timer: unknown
  /** The silence watchdog of the open stream. */
  silence: unknown
  /** The stream has delivered its opening snapshot. */
  streamed: boolean
  /** The token the desktop last refused, held only to compare: never emitted or logged. */
  refused: string | null
}

const IDLE: Omit<Handles, 'gen' | 'refused'> = { abort: null, stream: null, timer: null, silence: null, streamed: false }

const freshEntry = (row: FleetMachine, levels: LevelsSnapshot | null): Entry => ({
  row,
  link: row.online ? 'connecting' : 'offline',
  levels,
  detail: row.online ? null : 'no-link',
  attempt: 0,
  liveSince: null,
  gaps: 0,
  parked: false
})

/** Same desktop process and the same rev: the snapshot says nothing new. */
const sameSnapshot = (a: LevelsSnapshot | null, b: LevelsSnapshot): boolean => a !== null && a.rev === b.rev && a.at === b.at

const ROW_KEYS = ['id', 'name', 'online', 'lastSeenAt', 'appVersion', 'profile', 'base'] as const
const sameRow = (a: FleetMachine, b: FleetMachine): boolean => ROW_KEYS.every((key) => a[key] === b[key])

export const createFleetStore = (deps: FleetDeps, config: FleetConfig): FleetStore => {
  let entries = new Map<string, Entry>()
  let order: string[] = []
  const handles = new Map<string, Handles>()
  const listeners = new Set<() => void>()
  /** The row last handed out per machine: reused while its content is the same, so a reader commits only on change. */
  let rows = new Map<string, StrataMachine>()
  let snapshot: StrataMachine[] = []
  let dirty = true
  let notifyQueued = false
  let started = false
  let paused = false
  let hideTimer: unknown = null
  let listTimer: unknown = null
  let listing: Promise<void> | null = null
  let lines: Pick<FleetPresence, 'cap' | 'online'> | null = null
  let listAnswered = false
  let streamLimit = Number.POSITIVE_INFINITY
  /** Machines the user has been in, most recent first. */
  let recent: string[] = []
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
    if (held.silence !== null) deps.clearTimer(held.silence)
    handles.set(id, { ...held, ...IDLE, gen: held.gen + 1 })
  }

  /** Machines that want a stream: online, and not refused, outdated or signed out. */
  const wantsStream = (entry: Entry) =>
    entry.row.online && entry.link !== 'unpaired' && entry.link !== 'outdated' && entry.detail !== 'signed-out'

  /** The machines that may stream now: the user's machine first, then the recently entered, then fleet order. */
  const streamSet = (): Set<string> => {
    if (!Number.isFinite(streamLimit)) return new Set(order)
    const ranked = [...recent.filter((id) => order.includes(id)), ...order.filter((id) => !recent.includes(id))]
    return new Set(ranked.filter((id) => { const e = entries.get(id); return e !== undefined && wantsStream(e) }).slice(0, Math.max(0, streamLimit)))
  }

  /** Close the streams past the budget, wake the parked ones back inside it. */
  const rebalance = () => {
    if (!started || paused) return
    const allowed = streamSet()
    for (const id of order) {
      const entry = entries.get(id)
      if (!entry) continue
      const held = handlesOf(id)
      if (!allowed.has(id) && held.stream !== null) {
        release(id)
        // A stream only opens after a snapshot answered, so a parked machine has one to show.
        update(id, (e) => ({ ...e, parked: true, liveSince: null, link: e.levels ? 'live' : e.link }))
      } else if (allowed.has(id) && entry.parked) {
        update(id, (e) => ({ ...e, parked: false }))
        connect(id)
      }
    }
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
    const dropped = outcome.detail === 'stream-dropped' || outcome.detail === 'silent'
    const link: MachineLink = dropped && attempt >= STREAM_PATIENCE ? 'offline' : outcome.link
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
    // A reconnect's opening snapshot that says nothing new keeps what is drawn.
    const levels = event.type === 'snapshot' && sameSnapshot(entry.levels, folded.levels) ? entry.levels : folded.levels
    const firstLive = entry.link !== 'live'
    patchHandles(id, { streamed: true })
    update(id, (e) => ({
      ...e,
      levels,
      link: 'live',
      detail: null,
      liveSince: firstLive ? deps.now() : e.liveSince,
      gaps: event.type === 'snapshot' ? e.gaps : 0
    }))
    deps.cache.saveLevels(id, folded.levels, firstLive)
  }

  /** Every event and every ping pushes the deadline; reaching it drops the stream like an error. */
  const armSilence = (id: string, gen: number) => {
    const held = handlesOf(id)
    if (held.silence !== null) deps.clearTimer(held.silence)
    const silence = deps.setTimer(() => {
      if (current(id, gen)) fail(id, { link: 'connecting', detail: 'silent', retry: 'backoff' })
    }, config.silenceMs)
    patchHandles(id, { silence })
  }

  const openStream = (id: string, gen: number, token: string | null) => {
    const entry = entries.get(id)
    if (!entry) return
    const stream = deps.openStream(`${entry.row.base}api/levels/stream`, token, {
      onMessage: (data) => {
        if (!current(id, gen)) return
        armSilence(id, gen)
        onStreamData(id, data)
      },
      onPing: () => {
        if (current(id, gen)) armSilence(id, gen)
      },
      onError: () => {
        if (current(id, gen)) fail(id, { link: 'connecting', detail: 'stream-dropped', retry: 'backoff' })
      }
    })
    patchHandles(id, { stream })
    armSilence(id, gen)
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
    // A parked machine being woken keeps showing live: it was answering all along.
    update(id, (e) => (e.link === 'connecting' || (e.parked && e.link === 'live') ? e : { ...e, link: 'connecting', liveSince: null }))
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
            // Past the stream budget the snapshot is all it gets: live, but drawn stale.
            if (!streamSet().has(id)) {
              update(id, (e) => ({ ...e, levels: sameSnapshot(e.levels, body) ? e.levels : body, detail: null, link: 'live', parked: true, liveSince: null }))
              return
            }
            update(id, (e) => ({ ...e, levels: sameSnapshot(e.levels, body) ? e.levels : body, detail: null, parked: false }))
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
      if (entry.link !== 'live' || entry.parked) connect(id)
      return
    }
    // Parked and still online: presence is its refresh; a snapshot comes when it is entered.
    if (entry.parked && before.row.online) return
    if (entry.link === 'outdated') {
      // An update restarts the desktop: it comes back online, or the list shows the new version.
      if (before.row.appVersion !== entry.row.appVersion || !before.row.online) connect(id)
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
    rebalance()
  }

  const schedulePresence = () => {
    if (listTimer !== null) deps.clearTimer(listTimer)
    listTimer = started && !paused ? deps.setTimer(() => void loadPresence(), config.presenceRefreshMs) : null
  }

  const loadList = (): Promise<void> => {
    if (listing) return listing
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
        if (!listAnswered) {
          listAnswered = true
          notify()
        }
        schedulePresence()
      })
    return listing
  }

  /**
   * Presence moves `online` and `lastSeenAt` on the rows the list gave. A
   * desktop it names that the list did not, or one it no longer names, means
   * the list itself changed: read it again instead.
   */
  const loadPresence = (): Promise<void> =>
    deps
      .fetch(config.presenceUrl, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        const presence = response.status === 200 ? parseFleetPresence(await response.json()) : null
        if (!presence || !started || paused) return schedulePresence()
        if (lines?.cap !== presence.cap || lines?.online !== presence.online) {
          lines = { cap: presence.cap, online: presence.online }
          notify()
        }
        // A row means what its list row means at the same instant: laid over it as it stands.
        const named = new Map(presence.desktops.map((d) => [d.id, d]))
        if (named.size !== order.length || !order.every((id) => named.has(id))) return loadList()
        const rows = order.flatMap((id) => {
          const entry = entries.get(id)
          const seen = named.get(id)
          return entry && seen ? [{ ...entry.row, online: seen.online, lastSeenAt: seen.lastSeenAt }] : []
        })
        const moved = rows.some((row) => {
          const was = entries.get(row.id)?.row
          return was?.online !== row.online || was?.lastSeenAt !== row.lastSeenAt
        })
        if (moved) {
          merge(rows)
          deps.cache.saveList(rows)
        }
        schedulePresence()
      })
      .catch(() => schedulePresence())

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
    void loadPresence()
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

  /**
   * Parking is internal: a parked machine's row does not change (its snapshot
   * is as good as when its stream closed, and presence keeps its line), so the
   * stream budget moving at a dive costs no reader a commit.
   */
  const machineOf = (entry: Entry): StrataMachine => {
    const stale = entry.levels !== null && entry.link !== 'live'
    const known = rows.get(entry.row.id)
    if (known && known.link === entry.link && known.levels === entry.levels && known.stale === stale && sameRow(known, entry.row)) return known
    const row: StrataMachine = { ...entry.row, link: entry.link, levels: entry.levels, stale }
    rows = new Map(rows).set(entry.row.id, row)
    return row
  }


  return {
    start() {
      if (started) return
      started = true
      const fromCache = deps.cache.list()
      if (fromCache) listAnswered = true
      const cached = fromCache ?? []
      entries = new Map(cached.map((row) => [row.id, freshEntry(row, deps.cache.levels(row.id)?.levels ?? null)]))
      order = cached.map((row) => row.id)
      notify()
      unsubscribe = [deps.visibility.onChange(onVisibility), ...(deps.onWake ? [deps.onWake(wake)] : [])]
      if (deps.visibility.hidden()) onVisibility()
      for (const id of order) connect(id)
      void loadList().then(() => Promise.all([loadPresence(), config.seedCacheUrl ? seed(config.seedCacheUrl) : undefined]))
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
        const next = order.flatMap((id) => {
          const entry = entries.get(id)
          return entry ? [machineOf(entry)] : []
        })
        dirty = false
        // The same rows in the same order are the same snapshot.
        if (next.length !== snapshot.length || next.some((row, i) => row !== snapshot[i])) snapshot = next
      }
      return snapshot
    },
    presence: () => lines,
    loaded: () => listAnswered,
    enter(machineId) {
      if (recent[0] === machineId) return
      recent = [machineId, ...recent.filter((id) => id !== machineId)].slice(0, 16)
      rebalance()
    },
    setStreamLimit(limit) {
      const next = Number.isNaN(limit) ? Number.POSITIVE_INFINITY : Math.max(0, limit)
      if (next === streamLimit) return
      streamLimit = next
      rebalance()
    },
    detail: (machineId) => entries.get(machineId)?.detail ?? null,
    retry(machineId) {
      update(machineId, (e) => ({ ...e, attempt: 0, gaps: 0 }))
      patchHandles(machineId, { refused: null })
      connect(machineId)
    },
    refresh: () => loadPresence()
  }
}
