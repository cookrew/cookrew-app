// What the summary card says, as pure functions: a guess is never worded as
// fact (phaseSource), and every line has a fallback so the card's height never changes.
import type { LevelsAgent } from '../../shared/strata'

export const formatElapsed = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export interface PhaseLine {
  /** 'thinking', 'probably idle', 'last turn' … */
  label: string
  elapsed: string
  /** How it is known, in words. */
  source: string
  live: boolean
}

export const phaseLine = (agent: Pick<LevelsAgent, 'phase' | 'phaseSource' | 'phaseSince'>, now: number, machineOffline = false): PhaseLine => {
  const elapsed = formatElapsed(agent.phaseSince === null ? null : now - agent.phaseSince)
  if (machineOffline || agent.phase === 'offline') return { label: 'last turn', elapsed: `${elapsed} ago`, source: 'last known · offline', live: false }
  if (agent.phaseSource === 'live') return { label: agent.phase, elapsed, source: 'live', live: true }
  if (agent.phaseSource === 'probe') return { label: `probably ${agent.phase}`, elapsed, source: 'guess · multiplexer', live: false }
  return { label: 'last turn', elapsed: `${elapsed} ago`, source: 'last known', live: false }
}

export const modelLine = (agent: Pick<LevelsAgent, 'harness' | 'model'>): string => `${agent.harness} · ${agent.model ?? 'harness default model'}`

export const taskLine = (agent: Pick<LevelsAgent, 'task'>): string => agent.task ?? 'no task yet'
export const replyLine = (agent: Pick<LevelsAgent, 'reply'>): string => agent.reply ?? 'no reply yet'

export const statusLine = (agent: Pick<LevelsAgent, 'status' | 'phaseSource'>, machineOffline: boolean): string =>
  agent.status ?? (machineOffline ? 'machine offline' : agent.phaseSource === 'live' ? 'no live status' : 'no live status (not mirrored)')

export interface AttachmentCounts {
  notes: number
  browsers: number
  shared: number
}

export const attachmentCounts = (agent: Pick<LevelsAgent, 'attachments'>): AttachmentCounts => ({
  notes: agent.attachments.filter((a) => a.kind === 'note').length,
  browsers: agent.attachments.filter((a) => a.kind === 'browser').length,
  shared: agent.attachments.filter((a) => a.shared).length
})

/** The screen-reader label of an avatar: everything the card says, in one sentence. */
export const agentLabel = (agent: LevelsAgent, now: number, machineOffline = false): string => {
  const p = phaseLine(agent, now, machineOffline)
  return [agent.name, modelLine(agent), `${p.label} ${p.elapsed}, ${p.source}`, agent.task ? `task: ${agent.task}` : null].filter(Boolean).join(', ')
}
