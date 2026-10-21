// THE LEVELS SERVICE: one snapshot per CHANGE, not per request.
//
// Change signals (store, turns, probe, tuning) only mark the snapshot dirty —
// a boolean, whatever their rate. The snapshot is rebuilt:
//   - on a GET that finds it dirty (no stream open: nothing pays in between);
//   - LEVELS_PUSH_MS after the first signal of a burst while a stream is open,
//     so a delta reaches the shell well inside a second.
// A rebuild whose content is byte-identical to the last one is no change: no
// rev, no event, the same body and ETag. One that differs is diffed into
// deltas, each rev = previous + 1, sent to every open stream.

import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { STRATA_VERSION } from '../../shared/strata'
import type { AgentTuning } from '../../shared/agent-tuning'
import type { BoardPhase } from '../../shared/board'
import type { GitInfo, TerminalNodeData, WorkspaceMeta, WorkspaceState } from '../../shared/model'
import type { TerminalActivity, TurnRecord } from '../../shared/turn'
import type { Harness, LevelsAgentDetail, LevelsEvent, LevelsSnapshot } from '../../shared/strata'
import { scrubShapes, type Scrub } from '../scrub'
import { agentDetail, buildLevels, type PhaseMemory } from './build'
import { diffLevels, stampRevs } from './diff'

/** Coalescing window for stream pushes. Well inside the 1 s promise, wide enough to batch a turn's chatter. */
export const LEVELS_PUSH_MS = 400

/** Past this many deltas in one rebuild, a fresh snapshot is cheaper to send and to apply. */
export const LEVELS_MAX_DELTAS = 48

export interface LevelsSources {
  workspaces: () => readonly WorkspaceMeta[]
  focusedId: () => string | null
  /** Any workspace: the focused one from memory, a background one from disk. */
  workspaceState: (id: string) => WorkspaceState
  /** The board's L1 (verified activities). */
  live: () => readonly TerminalActivity[]
  /** The board's L2. */
  probe: () => ReadonlyMap<string, BoardPhase>
  /** The board's L3. */
  ledger: () => ReadonlyMap<string, readonly TurnRecord[]>
  /** Every card's dials, read once per build. */
  tuning: () => Readonly<Record<string, AgentTuning>>
  harnessOf: (node: TerminalNodeData) => Harness
  machine: () => LevelsSnapshot['machine']
  /** Subscribe to every change signal; returns the unlisten. */
  onChange: (listener: () => void) => () => void
  /** Hold the probe sampler open while a stream is; returns the release. */
  holdProbe?: () => () => void
  scrub?: Scrub
  now?: () => number
  /** Build-time observer (loop health), ms of main thread per build. */
  observe?: (ms: number) => void
  /** A cwd's git answer if already cached, never a query (the detail's node.git). */
  gitPeek?: (dir: string) => GitInfo | undefined
}

export interface LevelsCurrent {
  snapshot: LevelsSnapshot
  /** The serialized snapshot, built once per change. */
  body: Buffer
  /** Content hash of `body`. */
  etag: string
}

export interface LevelsStats {
  builds: number
  changes: number
  lastBuildMs: number
  maxBuildMs: number
  streams: number
  rev: number
}

export interface LevelsService {
  current: () => LevelsCurrent
  /** Open a stream: the first event is a snapshot, then every delta. */
  subscribe: (send: (event: LevelsEvent) => void) => () => void
  detail: (agentId: string) => LevelsAgentDetail | null
  /**
   * The cold first build cut into steps (prewarm.ts runs each at a quiet
   * moment): each workspace's state, the ledger, the dials, then the build.
   */
  prewarmSteps: () => Array<() => void>
  stats: () => LevelsStats
  close: () => void
}

export function createLevelsService(sources: LevelsSources, pushMs: number = LEVELS_PUSH_MS): LevelsService {
  const now = sources.now ?? (() => Date.now())
  const scrub = sources.scrub ?? scrubShapes
  const streams = new Set<(event: LevelsEvent) => void>()
  let memory = new Map<string, PhaseMemory>()
  let latest: LevelsCurrent | null = null
  let content: string | null = null
  let dirty = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let unlisten: (() => void) | null = null
  let releaseProbe: (() => void) | null = null
  const stats = { builds: 0, changes: 0, lastBuildMs: 0, maxBuildMs: 0 }

  const broadcast = (events: readonly LevelsEvent[]): void => {
    for (const send of streams) {
      for (const event of events) {
        try {
          send(event)
        } catch (error) {
          console.error('Levels stream send failed:', error)
        }
      }
    }
  }

  const rebuild = (): LevelsCurrent => {
    const started = performance.now()
    const focusedWorkspaceId = sources.focusedId()
    const tuning = sources.tuning()
    const built = buildLevels({
      workspaces: sources.workspaces().map((meta) => ({ meta, state: sources.workspaceState(meta.id) })),
      focusedWorkspaceId,
      live: new Map(sources.live().map((activity) => [activity.terminalId, activity])),
      probe: sources.probe(),
      ledger: sources.ledger(),
      tuning: (id) => tuning[id] ?? null,
      harnessOf: sources.harnessOf,
      memory,
      now: now(),
      scrub
    })
    memory = built.memory
    const machine = sources.machine()
    const nextContent = JSON.stringify({ machine, focusedWorkspaceId, workspaces: built.workspaces })
    dirty = false
    stats.builds += 1
    if (latest !== null && nextContent === content) {
      finishBuild(started)
      return latest
    }
    const before = latest?.snapshot
    const deltas = before ? diffLevels(before, { focusedWorkspaceId, workspaces: built.workspaces }) : []
    const rev = before ? before.rev : 0
    const resync = before !== undefined && (deltas.length === 0 || deltas.length > LEVELS_MAX_DELTAS)
    const nextRev = before === undefined ? 1 : resync ? rev + 1 : rev + deltas.length
    const snapshot: LevelsSnapshot = {
      v: STRATA_VERSION,
      rev: nextRev,
      at: now(),
      machine,
      focusedWorkspaceId,
      workspaces: built.workspaces
    }
    const body = Buffer.from(JSON.stringify(snapshot))
    latest = { snapshot, body, etag: createHash('sha1').update(body).digest('base64url') }
    content = nextContent
    if (before) {
      stats.changes += 1
      broadcast(resync ? [{ type: 'snapshot', snapshot }] : stampRevs(rev, deltas))
    }
    finishBuild(started)
    return latest
  }

  const finishBuild = (started: number): void => {
    const ms = performance.now() - started
    stats.lastBuildMs = ms
    stats.maxBuildMs = Math.max(stats.maxBuildMs, ms)
    try {
      sources.observe?.(ms)
    } catch {
      // An observer's failure is not the build's.
    }
  }

  const onSignal = (): void => {
    dirty = true
    if (streams.size === 0 || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      if (!dirty || streams.size === 0) return
      try {
        rebuild()
      } catch (error) {
        console.error('Levels rebuild failed:', error)
      }
    }, pushMs)
    timer.unref?.()
  }

  /** Listen from the first use on; a service nobody asked never subscribes to anything. */
  const listen = (): void => {
    if (unlisten === null) unlisten = sources.onChange(onSignal)
  }

  const current = (): LevelsCurrent => {
    listen()
    return dirty || latest === null ? rebuild() : latest
  }

  return {
    current,
    subscribe: (send) => {
      const opening = current()
      send({ type: 'snapshot', snapshot: opening.snapshot })
      streams.add(send)
      if (streams.size === 1 && sources.holdProbe) releaseProbe = sources.holdProbe()
      let closed = false
      return () => {
        if (closed) return
        closed = true
        streams.delete(send)
        if (streams.size === 0) {
          releaseProbe?.()
          releaseProbe = null
        }
      }
    },
    detail: (agentId) => {
      const { snapshot } = current()
      const workspace = snapshot.workspaces.find((w) => w.agents.some((a) => a.id === agentId))
      if (!workspace) return null
      return agentDetail(workspace, sources.workspaceState(workspace.id), agentId, scrub, sources.gitPeek)
    },
    prewarmSteps: () => [
      ...sources.workspaces().map((meta) => () => void sources.workspaceState(meta.id)),
      () => void sources.ledger(),
      () => void sources.tuning(),
      () => void current()
    ],
    stats: () => ({ ...stats, streams: streams.size, rev: latest?.snapshot.rev ?? 0 }),
    close: () => {
      if (timer) clearTimeout(timer)
      timer = null
      unlisten?.()
      unlisten = null
      releaseProbe?.()
      releaseProbe = null
      streams.clear()
    }
  }
}
