// The fleet feed's sources, read off the main-process objects the companion server
// already holds — the store, the board's three layers, the dials — so the
// feed and the board can never disagree about an agent.

import type { EventEmitter } from 'node:events'
import type { AgentTuning } from '../../shared/agent-tuning'
import type { GitInfo, TerminalNodeData } from '../../shared/model'
import type { Harness, MachineDisplay, MachineProfile } from '../../shared/fleet'
import type { BoardSources } from '../board-index'
import { harnessFor } from '../harness'
import type { Scrub } from '../scrub'
import type { WorkspaceStore } from '../store'
import type { FleetSources } from './service'
import { createTraitLookup } from './traits'

/** The harness a card runs: a known agent, a plain shell (no command), or something else. */
export function harnessOfNode(node: Pick<TerminalNodeData, 'command'>): Harness {
  if (!node.command || node.command.trim().length === 0) return 'shell'
  return harnessFor(node.command)?.id ?? 'other'
}

export interface FleetRuntime {
  store: WorkspaceStore
  board: BoardSources
  turns: EventEmitter
  tuning?: { fleet: () => Record<string, AgentTuning> }
  tuningBus?: EventEmitter
  machine: {
    /** The name the owner's account lists this desktop under; null before an account. */
    name: () => string | null
    appVersion: string | null
    profile: () => MachineProfile
    /** Its display in points, read each time (zoom draws the screen at its proportions); absent off Electron. */
    display?: () => MachineDisplay | null
  }
  /** Subscribe to the profile probe's answer (it lands once, shortly after start). */
  onProfile?: (listener: () => void) => () => void
  scrub?: Scrub
  observe?: (ms: number) => void
  now?: () => number
  /** Test seam; the real one reads the brief, else the primary dir's README and package.json. */
  traits?: FleetSources['traits']
}

const STORE_SIGNALS = ['change', 'workspace-change', 'workspaces', 'switch'] as const
const TURN_SIGNALS = ['activity', 'turn'] as const

/**
 * How stale the dials may get between whole-fleet reads. A model changes a
 * few times a day and the tuning bus announces a change as it happens; the
 * whole read (a stat, and a tail parse per moved session file) is what a
 * build would otherwise pay on every turn's chatter.
 */
export const TUNING_REFRESH_MS = 30_000

export function levelsSourcesFrom(runtime: FleetRuntime): FleetSources {
  const { store, board } = runtime
  const clock = runtime.now ?? ((): number => Date.now())
  let dials: Readonly<Record<string, AgentTuning>> | null = null
  let dialsAt = 0
  const onTuning = (row: { terminalId?: unknown; tuning?: AgentTuning } | undefined): void => {
    if (dials !== null && typeof row?.terminalId === 'string' && row.tuning) dials = { ...dials, [row.terminalId]: row.tuning }
  }
  return {
    workspaces: () => store.list().workspaces,
    focusedId: () => store.focusedId,
    workspaceState: (id) => store.workspaceState(id),
    live: () => board.live(),
    probe: () => board.probe?.() ?? new Map(),
    ledger: () => board.ledger(),
    tuning: () => {
      if (dials === null || clock() - dialsAt >= TUNING_REFRESH_MS) {
        dials = runtime.tuning?.fleet() ?? {}
        dialsAt = clock()
      }
      return dials
    },
    harnessOf: harnessOfNode,
    machine: () => {
      const profile = runtime.machine.profile()
      const display = runtime.machine.display?.() ?? null
      return { name: runtime.machine.name() ?? profile.label ?? 'This desktop', appVersion: runtime.machine.appVersion, profile, ...(display ? { display } : {}) }
    },
    onChange: (listener) => {
      for (const signal of STORE_SIGNALS) store.on(signal, listener)
      for (const signal of TURN_SIGNALS) runtime.turns.on(signal, listener)
      const tuned = (row: { terminalId?: unknown; tuning?: AgentTuning } | undefined): void => {
        onTuning(row)
        listener()
      }
      runtime.tuningBus?.on('tuning', tuned)
      const offProbe = board.probeOnChange?.(listener) ?? null
      const offProfile = runtime.onProfile?.(listener) ?? null
      return () => {
        for (const signal of STORE_SIGNALS) store.off(signal, listener)
        for (const signal of TURN_SIGNALS) runtime.turns.off(signal, listener)
        runtime.tuningBus?.off('tuning', tuned)
        offProbe?.()
        offProfile?.()
      }
    },
    holdProbe: board.probeSubscribe,
    scrub: runtime.scrub,
    observe: runtime.observe,
    traits: runtime.traits ?? createTraitLookup()
  }
}
