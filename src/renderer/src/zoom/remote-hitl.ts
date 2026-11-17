import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { FleetSnapshot } from '../../../shared/fleet'
import type { RemoteMachineAnswer } from '../../../shared/remote-machine-calls'
import { registerScopeState } from '../machine-scope'
import { machineSeen, type SeenBook } from './bar-seen'
import type { WorkspaceFace } from './bar-reach'
import {
  ARTIFACT_TYPES,
  artifactInbox,
  asLogEvent,
  EMPTY_ARTIFACTS,
  ENDING_TYPES,
  foldArtifacts,
  isArtifactChange,
  type ArtifactEntry,
  type ArtifactState,
  type LogEvent
} from './hitl-artifacts'
import { hitlWant, type HitlWant } from './remote-hitl-want'
import { callRemote } from './use-remote-machine'
import { documentSight, sharedZoomFleet, type RemoteFleetRead, type Sight } from './use-zoom-fleet'

/**
 * WHAT NEEDS YOU ON THE ACCOUNT'S OTHER MACHINES (owner, 2026-11-16; plan
 * docs/hitl-cross-workspace-2026-11-15 · v6.2 phase 6). The same rule as this
 * machine's, read off each of the others this desktop holds a key for:
 *
 *   AGENTS     its agents waiting on you or with a reply not read, off its
 *              fleet snapshot: the page's one fleet store reads it, slowly while
 *              a bar is mounted (use-zoom-fleet.ts · remoteBackground)
 *   ARTIFACTS  what an agent there made or changed since you looked, off its
 *              own activity log: one allow-listed read on the same slow clock,
 *              the same address each time, so an unchanged log is a 304
 *
 * Every entry is that machine's: keyed by machine and id (never merged by
 * name), seen in that machine's own book (bar-seen.ts · machineSeen), opened in
 * that machine's view (remote-open.ts). A served workspace, one its fleet does
 * not name, and a machine that does not answer hold nothing.
 */

export type RemoteMachineRead = RemoteFleetRead

/** One machine's entry, never another's: the face's key in the bar's stacks. */
export const remoteKey = (machineId: string, id: string): string => `remote:${machineId}:${id}`

interface RemotePlace {
  readonly key: string
  readonly machineId: string
  readonly machineName: string
  readonly machineOs: string | null
  readonly workspaceId: string
  readonly workspaceName: string
  readonly workspaceIcon: string | null
}

export interface RemoteAgentEntry extends RemotePlace {
  readonly agentId: string
  readonly name: string
  readonly harness: string
  readonly orch: boolean
  readonly why: 'waiting' | 'reply'
  /** When it came to this phase, on that machine's clock. */
  readonly at: number
  /** Its reply's first line, else what it is on. */
  readonly line: string | null
}

export interface RemoteItemEntry extends RemotePlace, ArtifactEntry {}

const placeOf = (read: RemoteMachineRead, workspace: { id: string; name: string; icon: string | null }, id: string): RemotePlace => ({
  key: remoteKey(read.id, id),
  machineId: read.id,
  machineName: read.name,
  machineOs: read.snapshot.machine.profile?.os ?? null,
  workspaceId: workspace.id,
  workspaceName: workspace.name,
  workspaceIcon: workspace.icon
})

/** Each other machine's agents waiting on you or with a reply not read; none of a served workspace's. */
export function remoteAgentsOf(reads: readonly RemoteMachineRead[]): RemoteAgentEntry[] {
  return reads.flatMap((read) =>
    read.snapshot.workspaces.flatMap((workspace) => {
      if (workspace.served === true) return []
      return workspace.agents.flatMap((agent): RemoteAgentEntry[] => {
        if (agent.phase !== 'waiting' && agent.phase !== 'replied') return []
        return [{
          ...placeOf(read, workspace, agent.id),
          agentId: agent.id,
          name: agent.name,
          harness: agent.harness,
          orch: agent.orch,
          why: agent.phase === 'waiting' ? 'waiting' : 'reply',
          at: agent.phaseSince ?? read.snapshot.at,
          line: agent.reply ?? agent.task
        }]
      })
    })
  )
}

/** The most rows one read is folded from: the route asks for fewer. */
const ROWS_MAX = 1000
/** How many of the newest log rows one read asks for: changes and their ends together. */
export const REMOTE_EVENT_LIMIT = 300
/** The one read of another machine's log: the same address each time, so its tag answers an unchanged log. */
export const REMOTE_EVENTS_ROUTE = `api/events/query?types=${[...ARTIFACT_TYPES, ...ENDING_TYPES].join(',')}&limit=${REMOTE_EVENT_LIMIT}`

/** The rows of a log read (main/mobile-api.ts · `{ events }`), well-formed ones only. */
export function logRowsOf(body: unknown): LogEvent[] {
  const events = typeof body === 'object' && body !== null ? (body as { events?: unknown }).events : undefined
  if (!Array.isArray(events)) return []
  return events.slice(-ROWS_MAX).flatMap((raw) => asLogEvent(raw) ?? [])
}

const READ: ArtifactState = { ...EMPTY_ARTIFACTS, ready: true }

/** A log read, folded as this machine folds its own (hitl-artifacts.ts · foldArtifacts). */
export const eventsOf = (body: unknown): ArtifactState => foldArtifacts(READ, logRowsOf(body))

const facesOf = (snapshot: FleetSnapshot): ReadonlyMap<string, WorkspaceFace> =>
  new Map(snapshot.workspaces.map((w) => [w.id, { name: w.name, icon: w.icon, ...(w.served === true ? { served: true } : {}) }]))

/** What an agent changed on that machine since you looked there, newest first (hitl-artifacts.ts · artifactInbox). */
export function remoteItemsOf(read: RemoteMachineRead, log: ArtifactState, book: SeenBook): RemoteItemEntry[] {
  const nowNamed = new Map(read.snapshot.workspaces.map((w) => [w.id, w]))
  return artifactInbox(log.entries.values(), book, { workspaces: facesOf(read.snapshot), here: null, onCanvas: () => false }).flatMap((entry) => {
    const workspace = nowNamed.get(entry.workspaceId)
    return workspace ? [{ ...entry, ...placeOf(read, workspace, entry.id), workspaceName: workspace.name }] : []
  })
}

/** One order across this machine and the others: waiting first, then replies and news, newest first within. */
export function oneOrder<T extends { readonly why: 'waiting' | 'reply' | 'news'; readonly at: number }>(entries: readonly T[]): T[] {
  const rank = (e: T): number => (e.why === 'waiting' ? 0 : 1)
  return [...entries].sort((a, b) => rank(a) - rank(b) || b.at - a.at)
}

/** A machine's mark on a face: its name's first letter. */
export function machineMark(name: string): string {
  const first = Array.from(name.trim())[0]
  return first ? first.toUpperCase() : '?'
}

export const remoteAgentLabel = (e: RemoteAgentEntry): string =>
  `${e.name}, ${e.why === 'waiting' ? 'needs you' : 'replied'}, in ${e.workspaceName}, on ${e.machineName}`

export const remoteItemLabel = (e: RemoteItemEntry): string =>
  `${e.kind === 'browser' ? 'Browser' : 'Note'}: ${e.title}, in ${e.workspaceName}, on ${e.machineName}, new`

// ── the feed of the other machines' logs ───────────────────────────────────

/** The other machines' logs are read on this clock while a bar is mounted and the page is seen. */
export const HITL_REMOTE_MS = 15_000

export interface RemoteArtifactFeedDeps {
  /** One allow-listed call on another machine (use-remote-machine.ts · callRemote). */
  call: (machineId: string, route: string) => Promise<RemoteMachineAnswer>
  /** The machines to read: the ones the fleet store reads now (online, readable, answering). */
  machines: () => readonly string[]
  want: Pick<HitlWant, 'now' | 'watch'>
  sight: Sight | null
  /** That machine's starting point, null before its first read set one. */
  cutoffOf: (machineId: string) => number | null
  onCutoff: (machineId: string, at: number) => void
  everyMs?: number
}

export interface RemoteArtifactFeed {
  /** Each machine's log as last read, by machine id: the same map until a read changes something. */
  get: () => ReadonlyMap<string, ArtifactState>
  subscribe: (listener: () => void) => () => void
  /** The fleet's machines changed: drop the ones gone at once, read the new ones now. */
  machinesChanged: () => void
  /** Let go (another machine in scope): nothing more is asked, and what was read is dropped. */
  stop: () => void
}

const sameEntry = (a: ArtifactEntry, b: ArtifactEntry | undefined): boolean =>
  b !== undefined && a.kind === b.kind && a.title === b.title && a.at === b.at && a.workspaceId === b.workspaceId && a.workspaceName === b.workspaceName

const sameLog = (a: ArtifactState | undefined, b: ArtifactState): boolean =>
  a !== undefined && a.entries.size === b.entries.size && [...a.entries.values()].every((entry) => sameEntry(entry, b.entries.get(entry.id)))

/** A log read is the machine's when it answered 200 with a log; anything else holds nothing. */
const logOf = (answer: RemoteMachineAnswer): unknown | null =>
  answer.status === 200 && 'body' in answer && typeof answer.body === 'object' && answer.body !== null ? answer.body : null

export function createRemoteArtifactFeed(deps: RemoteArtifactFeedDeps): RemoteArtifactFeed {
  const everyMs = deps.everyMs ?? HITL_REMOTE_MS
  const listeners = new Set<() => void>()
  const inFlight = new Set<string>()
  let logs: ReadonlyMap<string, ArtifactState> = new Map()
  let alive = true
  let timer: ReturnType<typeof setInterval> | null = null
  let unwatch: (() => void)[] = []

  const publish = (next: ReadonlyMap<string, ArtifactState>): void => {
    logs = next
    for (const listener of listeners) listener()
  }
  const without = (gone: (id: string) => boolean): void => {
    const kept = [...logs].filter(([id]) => !gone(id))
    if (kept.length !== logs.size) publish(new Map(kept))
  }
  const land = (machineId: string, body: unknown | null): void => {
    if (!alive) return
    if (!deps.machines().includes(machineId)) return without((id) => id === machineId)
    if (body === null) return without((id) => id === machineId)
    const rows = logRowsOf(body)
    // First sight of this machine: its own newest change is the starting point, so what was there is not news.
    if (deps.cutoffOf(machineId) === null) deps.onCutoff(machineId, rows.filter((e) => isArtifactChange(e.type)).reduce((at, e) => Math.max(at, e.timestamp), 0))
    const next = foldArtifacts(READ, rows)
    if (sameLog(logs.get(machineId), next)) return
    publish(new Map([...logs, [machineId, next]]))
  }
  const readOne = async (machineId: string): Promise<void> => {
    if (inFlight.has(machineId)) return
    inFlight.add(machineId)
    try {
      land(machineId, logOf(await deps.call(machineId, REMOTE_EVENTS_ROUTE).catch(() => ({ status: 0, body: null }))))
    } finally {
      inFlight.delete(machineId)
    }
  }
  const round = (only?: (id: string) => boolean): void => {
    for (const id of deps.machines()) if (!only || only(id)) void readOne(id)
  }
  const wanted = (): boolean => alive && listeners.size > 0 && deps.want.now() && !deps.sight?.hidden()
  const follow = (): void => {
    if (!wanted()) {
      if (timer !== null) clearInterval(timer)
      timer = null
      return
    }
    if (timer !== null) return
    round()
    timer = setInterval(() => round(), everyMs)
  }
  const watchAll = (): void => {
    unwatch = [deps.want.watch(follow), ...(deps.sight ? [deps.sight.watch(follow)] : [])]
  }
  const unwatchAll = (): void => {
    for (const off of unwatch) off()
    unwatch = []
  }

  return {
    get: () => logs,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1 && alive) watchAll()
      follow()
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        unwatchAll()
        follow()
      }
    },
    machinesChanged() {
      const now = deps.machines()
      without((id) => !now.includes(id))
      if (timer !== null) round((id) => !logs.has(id))
    },
    stop() {
      alive = false
      unwatchAll()
      if (timer !== null) clearInterval(timer)
      timer = null
      publish(new Map())
    }
  }
}

const readMachines = (): readonly string[] => sharedZoomFleet().remoteReads().machines.map((m) => m.id)

let shared: RemoteArtifactFeed | null = null
const sharedFeed = (): RemoteArtifactFeed =>
  (shared ??= createRemoteArtifactFeed({
    call: (machineId, route) => callRemote(machineId, 'GET', route),
    machines: readMachines,
    want: hitlWant,
    sight: documentSight,
    cutoffOf: (machineId) => machineSeen.get(machineId).cutoff,
    onCutoff: (machineId, at) => machineSeen.cutoff(machineId, at)
  }))

// Read through the keys of the machine in scope: left, it stops, and the next read makes the next one's.
registerScopeState(
  'hitl machines',
  () => {
    shared?.stop()
    shared = null
  },
  'stop'
)

/** Test seam: the feed now, made if none. */
export const remoteArtifactFeedNow = (): RemoteArtifactFeed => sharedFeed()

// ── the hook ────────────────────────────────────────────────────────────────

export interface RemoteHitl {
  readonly agents: readonly RemoteAgentEntry[]
  readonly items: readonly RemoteItemEntry[]
  /** Every agent and artifact the other machines still hold, in or out of the inbox: a card on one stays open. */
  readonly known: ReadonlySet<string>
}

const agentSig = (e: RemoteAgentEntry): string => [e.key, e.why, e.at, e.name, e.line, e.workspaceName, e.workspaceIcon, e.machineName].join('\u0000')
const itemSig = (e: RemoteItemEntry): string => [e.key, e.at, e.title, e.kind, e.workspaceName, e.workspaceIcon, e.machineName].join('\u0000')

/** The last list while nothing a face draws changed: the bar does not redraw on every poll. */
function useSteady<T>(list: readonly T[], sig: (e: T) => string): readonly T[] {
  const last = useRef<{ list: readonly T[]; key: string } | null>(null)
  const key = list.map(sig).join('\u0001')
  if (last.current === null || last.current.key !== key) last.current = { list, key }
  return last.current.list
}

const knownOf = (reads: readonly RemoteMachineRead[], logs: ReadonlyMap<string, ArtifactState>): ReadonlySet<string> =>
  new Set([
    ...reads.flatMap((read) => read.snapshot.workspaces.flatMap((w) => w.agents.map((a) => remoteKey(read.id, a.id)))),
    ...[...logs].flatMap(([machineId, log]) => [...log.entries.keys()].map((id) => remoteKey(machineId, id)))
  ])

/**
 * The other machines' share of the bar (BarGroups.tsx): held while mounted, so
 * they are read at all only while a bar is, and the page is seen.
 */
export function useRemoteHitl(): RemoteHitl {
  useEffect(() => hitlWant.claim(), [])
  const fleet = sharedZoomFleet()
  const reads = useSyncExternalStore(fleet.subscribe, fleet.remoteReads, fleet.remoteReads)
  const feed = sharedFeed()
  const logs = useSyncExternalStore(feed.subscribe, feed.get, feed.get)
  const seenAt = useSyncExternalStore(machineSeen.subscribe, machineSeen.version, machineSeen.version)
  const ids = reads.machines.map((m) => m.id).join(' ')
  useEffect(() => feed.machinesChanged(), [feed, ids])
  // A big book keeps only what that machine still holds, once its log is read.
  useEffect(() => {
    for (const [machineId, log] of logs) machineSeen.prune(machineId, (id) => log.entries.has(id))
  }, [logs])
  const agents = useSteady(useMemo(() => remoteAgentsOf(reads.machines), [reads]), agentSig)
  const items = useSteady(
    useMemo(
      () => reads.machines.flatMap((read) => {
        const log = logs.get(read.id)
        return log ? remoteItemsOf(read, log, machineSeen.get(read.id)) : []
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [reads, logs, seenAt]
    ),
    itemSig
  )
  // The same set while the same agents and artifacts are held: a busy machine's status line is no change here.
  const knownNow = useMemo(() => knownOf(reads.machines, logs), [reads, logs])
  const known = useSteady([...knownNow].sort(), (key) => key)
  const knownSet = useMemo(() => new Set(known), [known])
  return useMemo(() => ({ agents, items, known: knownSet }), [agents, items, knownSet])
}
