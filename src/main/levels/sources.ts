// The levels' sources, read off the main-process objects the companion server
// already holds — the store, the board's three layers, the dials — so the
// levels and the board can never disagree about an agent.

import type { EventEmitter } from 'node:events'
import type { AgentTuning } from '../../shared/agent-tuning'
import type { TerminalNodeData } from '../../shared/model'
import type { Harness, MachineProfile } from '../../shared/strata'
import type { BoardSources } from '../board-index'
import { harnessFor } from '../harness'
import type { Scrub } from '../scrub'
import type { WorkspaceStore } from '../store'
import type { LevelsSources } from './service'

/** The harness a card runs: a known agent, a plain shell (no command), or something else. */
export function harnessOfNode(node: Pick<TerminalNodeData, 'command'>): Harness {
  if (!node.command || node.command.trim().length === 0) return 'shell'
  return harnessFor(node.command)?.id ?? 'other'
}

export interface LevelsRuntime {
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
  }
  /** Subscribe to the profile probe's answer (it lands once, shortly after start). */
  onProfile?: (listener: () => void) => () => void
  scrub?: Scrub
  observe?: (ms: number) => void
}

const STORE_SIGNALS = ['change', 'workspace-change', 'workspaces', 'switch'] as const
const TURN_SIGNALS = ['activity', 'turn'] as const

export function levelsSourcesFrom(runtime: LevelsRuntime): LevelsSources {
  const { store, board } = runtime
  return {
    workspaces: () => store.list().workspaces,
    focusedId: () => store.focusedId,
    workspaceState: (id) => store.workspaceState(id),
    live: () => board.live(),
    probe: () => board.probe?.() ?? new Map(),
    ledger: () => board.ledger(),
    tuning: () => runtime.tuning?.fleet() ?? {},
    harnessOf: harnessOfNode,
    machine: () => {
      const profile = runtime.machine.profile()
      return { name: runtime.machine.name() ?? profile.label ?? 'This desktop', appVersion: runtime.machine.appVersion, profile }
    },
    onChange: (listener) => {
      for (const signal of STORE_SIGNALS) store.on(signal, listener)
      for (const signal of TURN_SIGNALS) runtime.turns.on(signal, listener)
      runtime.tuningBus?.on('tuning', listener)
      const offProbe = board.probeOnChange?.(listener) ?? null
      const offProfile = runtime.onProfile?.(listener) ?? null
      return () => {
        for (const signal of STORE_SIGNALS) store.off(signal, listener)
        for (const signal of TURN_SIGNALS) runtime.turns.off(signal, listener)
        runtime.tuningBus?.off('tuning', listener)
        offProbe?.()
        offProfile?.()
      }
    },
    holdProbe: board.probeSubscribe,
    scrub: runtime.scrub,
    observe: runtime.observe
  }
}
