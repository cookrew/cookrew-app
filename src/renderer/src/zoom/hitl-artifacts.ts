import { useEffect, useSyncExternalStore } from 'react'
import { cookrew } from '../api'
import { registerScopeState } from '../machine-scope'
import { barSeen, type SeenBook } from './bar-seen'
import type { WorkspaceFace } from './bar-reach'

/**
 * WHAT AN AGENT MADE OR CHANGED, READ OFF THE ACTIVITY LOG (owner, 2026-11-16;
 * plan docs/hitl-cross-workspace-2026-11-15 · v6.2 phase 2). The main process
 * logs every agent's note and browser changes as the agent's (socket-server.ts ·
 * agentActorOf), every workspace's, the one on screen or not. The bar's
 * ARTIFACTS group is the newest of those per card that you have not looked at
 * since: the owner's own changes are logged too, as the user's, and never
 * count. The log is read once at boot, by type, then followed live.
 */

export interface LogEvent {
  readonly type: string
  readonly entityId: string
  readonly entityName: string
  readonly workspaceId: string
  readonly workspaceName: string
  readonly actor: string
  readonly timestamp: number
}

export interface ArtifactEntry {
  readonly id: string
  readonly kind: 'note' | 'browser'
  /** The card's name when the agent changed it. */
  readonly title: string
  readonly workspaceId: string
  readonly workspaceName: string
  /** When the agent changed it: main's clock, the same clock the seen book holds. */
  readonly at: number
}

export interface ArtifactState {
  readonly entries: ReadonlyMap<string, ArtifactEntry>
  /** card → when it was deleted: a change from before that, arriving late, is no comeback. */
  readonly gone: ReadonlyMap<string, number>
  /** The boot read has landed: until then, what is missing is unknown, not gone. */
  readonly ready: boolean
}

export const EMPTY_ARTIFACTS: ArtifactState = Object.freeze({ entries: new Map(), gone: new Map(), ready: false })

const KIND_OF: Readonly<Record<string, 'note' | 'browser'>> = {
  'note.created': 'note',
  'note.updated': 'note',
  'browser.created': 'browser',
  'browser.navigated': 'browser'
}
export const ARTIFACT_TYPES: readonly string[] = Object.keys(KIND_OF)
const GONE_TYPES: ReadonlySet<string> = new Set(['note.deleted', 'browser.closed'])
const WORKSPACE_GONE = 'workspace.deleted'
/** What ends a card's place in the group: read back to the oldest change the boot holds. */
export const ENDING_TYPES: readonly string[] = [...GONE_TYPES, WORKSPACE_GONE]
const AGENTS: ReadonlySet<string> = new Set(['agent', 'orch'])
/** Is this a change of a card (not its end): what a first read starts the seen book at. */
export const isArtifactChange = (type: string): boolean => KIND_OF[type] !== undefined
/** Past this many deletions remembered, the oldest are forgotten. */
const GONE_KEPT = 2000

/** A well-formed log row off the wire, else null. */
export function asLogEvent(raw: unknown): LogEvent | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const strings = ['type', 'entityId', 'entityName', 'workspaceId', 'workspaceName', 'actor'] as const
  if (strings.some((key) => typeof r[key] !== 'string')) return null
  if (typeof r.timestamp !== 'number' || !Number.isFinite(r.timestamp)) return null
  return r as unknown as LogEvent
}

/**
 * The state with these events in; the same state back when nothing changed (no
 * re-render). The maps given are never touched: each is copied once, on its
 * first change, and the copy built up locally (a boot folds ~1000 rows).
 */
export function foldArtifacts(state: ArtifactState, events: readonly LogEvent[]): ArtifactState {
  let entries: Map<string, ArtifactEntry> | null = null
  let gone: Map<string, number> | null = null
  const entriesNow = (): ReadonlyMap<string, ArtifactEntry> => entries ?? state.entries
  const goneNow = (): ReadonlyMap<string, number> => gone ?? state.gone
  const editEntries = (): Map<string, ArtifactEntry> => (entries ??= new Map(state.entries))
  const editGone = (): Map<string, number> => (gone ??= new Map(state.gone))
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp)
  for (const e of sorted) {
    if (GONE_TYPES.has(e.type)) {
      if ((goneNow().get(e.entityId) ?? Number.NEGATIVE_INFINITY) >= e.timestamp) continue
      const tombs = editGone()
      tombs.delete(e.entityId)
      tombs.set(e.entityId, e.timestamp)
      if (tombs.size > GONE_KEPT) tombs.delete(tombs.keys().next().value as string)
      const entry = entriesNow().get(e.entityId)
      if (entry && entry.at <= e.timestamp) editEntries().delete(e.entityId)
      continue
    }
    if (e.type === WORKSPACE_GONE) {
      const theirs = [...entriesNow().values()].filter((entry) => entry.workspaceId === e.entityId)
      for (const entry of theirs) editEntries().delete(entry.id)
      continue
    }
    const kind = KIND_OF[e.type]
    if (!kind || !AGENTS.has(e.actor)) continue
    if ((goneNow().get(e.entityId) ?? Number.NEGATIVE_INFINITY) >= e.timestamp) continue
    const before = entriesNow().get(e.entityId)
    if (before && before.at >= e.timestamp) continue
    editEntries().set(e.entityId, {
      id: e.entityId,
      kind,
      title: e.entityName,
      workspaceId: e.workspaceId,
      workspaceName: e.workspaceName,
      at: e.timestamp
    })
  }
  if (entries === null && gone === null) return state
  return { entries: entries ?? state.entries, gone: gone ?? state.gone, ready: state.ready }
}

export interface ArtifactPlace {
  /** Every workspace this surface knows, with its served mark. */
  readonly workspaces: ReadonlyMap<string, WorkspaceFace>
  /** The open workspace. */
  readonly here: string | null
  /** Is this card on the open workspace's canvas now (it may have been moved away). */
  readonly onCanvas: (id: string) => boolean
}

/**
 * The ARTIFACTS group: what an agent changed after the starting point and after
 * you last looked, newest first, every workspace. Nothing before the starting
 * point is set (the log still being read): the first boot is not a flood.
 */
export function artifactInbox(entries: Iterable<ArtifactEntry>, book: SeenBook, place: ArtifactPlace): ArtifactEntry[] {
  const { cutoff } = book
  if (cutoff === null) return []
  return [...entries]
    .filter((e) => {
      // On the open canvas it is HERE, whatever workspace the log named: a team
      // move carries cards across without an event per card.
      const here = place.onCanvas(e.id)
      const wsId = here ? place.here : e.workspaceId
      const ws = wsId === null ? undefined : place.workspaces.get(wsId)
      if (!ws || ws.served === true) return false
      if (!here && e.workspaceId === place.here) return false
      return e.at > Math.max(cutoff, book.seen[e.id] ?? Number.NEGATIVE_INFINITY)
    })
    .sort((a, b) => b.at - a.at)
}

export interface EventApi {
  queryEvents?: (query?: unknown) => Promise<unknown[]>
  onEvent?: (cb: (raw: unknown) => void) => () => void
}

/** How many rows of each artifact type the boot read holds (limitPerType: each its own). */
export const BOOT_LIMIT = 200
/** A failed boot read is tried again this much later. */
export const BOOT_RETRY_MS = 15_000

export interface ArtifactFeed {
  get: () => ArtifactState
  subscribe: (listener: () => void) => () => void
  start: () => void
  /** Let go: no more events, and a boot read still in flight is dropped. */
  stop: () => void
}

/**
 * The log, read once at boot in two typed reads (/api/events/query · types),
 * then followed live. On a phone each read is a relay exchange of the boot; it
 * was one read per type, seven in all.
 *
 * The changes are the newest BOOT_LIMIT of EACH artifact type, in one read
 * (event-log.ts · limitPerType): the per-type reads' own semantics, so a type
 * that floods the log (an agent rewriting notes all day) fills its own share
 * and cannot push an older, unseen change of a quiet type out of the bar.
 *
 * The endings are read with no limit back to the oldest change the window
 * holds, so a bulk close cannot leave a ghost. The first boot sets the seen
 * book's starting point at the newest change it read, so what was there before
 * is not news; a change that lands while the boot is in flight stays news.
 */
export function createArtifactFeed(
  api: EventApi,
  onCutoff: (at: number) => void,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms)
): ArtifactFeed {
  let state = EMPTY_ARTIFACTS
  let started = false
  let alive = true
  let booted = false
  let liveFirst: number | null = null
  let off: (() => void) | null = null
  const listeners = new Set<() => void>()
  const apply = (events: readonly LogEvent[]): void => {
    const next = foldArtifacts(state, events)
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
  }
  const boot = async (): Promise<void> => {
    const query = api.queryEvents
    if (!query) return
    const rows = (lists: unknown[][]): LogEvent[] => lists.flat().flatMap((raw) => asLogEvent(raw) ?? [])
    try {
      // The window of changes, then every ending back to its oldest row (see above).
      const changes = rows([await query({ types: [...ARTIFACT_TYPES], limitPerType: BOOT_LIMIT })])
      const oldest = changes.reduce((at, e) => Math.min(at, e.timestamp), Number.POSITIVE_INFINITY)
      const ends = Number.isFinite(oldest) ? rows([await query({ types: [...ENDING_TYPES], since: oldest })]) : []
      // The machine was left while this was read: it is the last machine's, not this one's.
      if (!alive) return
      apply([...changes, ...ends])
      const newest = changes.reduce((at, e) => Math.max(at, e.timestamp), 0)
      booted = true
      state = { ...state, ready: true }
      for (const listener of listeners) listener()
      onCutoff(liveFirst === null ? newest : Math.min(newest, liveFirst - 1))
    } catch {
      if (alive) schedule(() => void boot(), BOOT_RETRY_MS)
    }
  }
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      if (started || !alive) return
      started = true
      off = api.onEvent?.((raw) => {
        if (!alive) return
        const e = asLogEvent(raw)
        if (!e) return
        if (!booted && KIND_OF[e.type]) liveFirst = liveFirst === null ? e.timestamp : Math.min(liveFirst, e.timestamp)
        apply([e])
      }) ?? null
      void boot()
    },
    stop() {
      alive = false
      off?.()
      off = null
      // Readers re-render, and reading again they find the next machine's feed.
      state = EMPTY_ARTIFACTS
      for (const listener of listeners) listener()
    }
  }
}

let shared: ArtifactFeed | null = null
const sharedFeed = (): ArtifactFeed =>
  (shared ??= createArtifactFeed(cookrew() as unknown as EventApi, (at) => barSeen.cutoff(at)))

// The feed is ONE machine's log (a console entering another machine gets another
// api): left, it stops, and the next read makes the next machine's.
registerScopeState(
  'hitl artifacts',
  () => {
    shared?.stop()
    shared = null
  },
  'stop'
)

/** The artifacts every workspace's agents made or changed, as the log says (BarGroups.tsx). */
export function useArtifacts(): ArtifactState {
  const feed = sharedFeed()
  useEffect(() => feed.start(), [feed])
  return useSyncExternalStore(feed.subscribe, feed.get, feed.get)
}

/** Test seam: the feed now, made if none. */
export const artifactFeedNow = (): ArtifactFeed => sharedFeed()
