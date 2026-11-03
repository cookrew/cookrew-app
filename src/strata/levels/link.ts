// How a machine reads, from its MachineLink plus what the shell knows about
// it. A cache is shown as a cache; a machine never reached says so.
import type { StrataMachine } from '../../shared/strata'
import { formatElapsed } from '../summary/format'

export type MachineState = 'live' | 'connecting' | 'stale' | 'offline' | 'never' | 'unpaired' | 'outdated' | 'error'

export const machineState = (m: StrataMachine): MachineState => {
  if (m.link === 'live' || m.link === 'unpaired' || m.link === 'outdated') return m.link
  if (m.link === 'connecting') return 'connecting'
  if (m.levels && m.stale) return 'stale'
  if (!m.levels && m.lastSeenAt === null) return 'never'
  return m.link === 'error' ? 'error' : 'offline'
}

/** ' · last seen 3h 5m ago', or nothing for a machine never seen. */
export const lastSeenWords = (m: StrataMachine, now: number): string => (m.lastSeenAt === null ? '' : ` · last seen ${formatElapsed(now - m.lastSeenAt)} ago`)

export const stateWords = (m: StrataMachine, now: number): string => {
  const ago = lastSeenWords(m, now)
  switch (machineState(m)) {
    case 'live':
      return 'live'
    case 'connecting':
      return 'connecting…'
    case 'stale':
      return `offline${ago} · last known`
    case 'offline':
      return `offline${ago}`
    case 'never':
      return 'never connected'
    case 'unpaired':
      return 'pair this browser'
    case 'outdated':
      return 'update for levels · classic OPEN'
    case 'error':
      return `unreachable${ago}`
  }
}

/** The figure's tone: anything not live is drawn dimmed, the way the kit expects. */
export const isDimmed = (m: StrataMachine) => machineState(m) !== 'live'

export const agentCount = (m: StrataMachine) => (m.levels?.workspaces ?? []).reduce((n, w) => n + w.agents.length, 0)

export const waitingCount = (m: StrataMachine, workspaceId?: string) =>
  m.link !== 'live'
    ? 0
    : (m.levels?.workspaces ?? []).filter((w) => !workspaceId || w.id === workspaceId).reduce((n, w) => n + w.agents.filter((a) => a.phase === 'waiting').length, 0)

/** D6: the relay admits this many desktops online per account. */
export const ONLINE_CAP = 8

export const onlineSummary = (fleet: readonly StrataMachine[]) => {
  const online = fleet.filter((m) => m.online).length
  return `${Math.min(online, ONLINE_CAP)} of ${fleet.length} online`
}
