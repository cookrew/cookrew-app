// LOCAL FLEET INDEX: a plain search over useFleet() until Harbor's FleetIndex
// lands (same interface, so the swap is one import). Every agent on every
// machine the shell can see, cached ones included. Equal scores keep fleet
// order (machine, workspace, creation); a small context bonus lets a namesake
// in the workspace you are looking at win a tie. A jump code ('3f') beats any
// name, so every agent is two keystrokes plus Enter away.
import type { LevelsAgent, StrataMachine, StrataPath } from '../../shared/strata'
import type { AgentHit, FleetIndex } from '../seams'
import { CODE_PATTERN, jumpCodes } from './codes'

export interface IndexedAgent {
  machineId: string
  machineName: string
  workspaceId: string
  workspaceName: string
  agent: LevelsAgent
  /** Position in fleet order. */
  order: number
  /** Its jump code (see codes.ts). */
  code: string
}

export const flattenFleet = (machines: readonly StrataMachine[]): IndexedAgent[] => {
  let order = 0
  const rows = machines.flatMap((m) =>
    (m.levels?.workspaces ?? []).flatMap((w) =>
      w.agents.map((agent) => ({ machineId: m.id, machineName: m.name, workspaceId: w.id, workspaceName: w.name, agent, order: order++ }))
    )
  )
  const codes = jumpCodes(rows.map((r) => agentKey(r.machineId, r.agent.id)))
  return rows.map((r) => ({ ...r, code: codes.get(agentKey(r.machineId, r.agent.id)) as string }))
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
const words = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

export const SCORE = { code: 1000, codeDigit: 500, namePrefix: 100, nameWord: 80, initials: 70, nameSub: 50, place: 30, task: 10 } as const

/** One query word against one agent: the best way it matches, 0 for none. */
const scoreWord = (q: string, entry: IndexedAgent): number => {
  if (CODE_PATTERN.test(q) && entry.code === q) return SCORE.code
  if (/^[1-9]$/.test(q) && entry.code.startsWith(q)) return SCORE.codeDigit
  const name = fold(entry.agent.name)
  const nameWords = words(entry.agent.name)
  if (name.startsWith(q)) return SCORE.namePrefix
  if (nameWords.some((w) => w.startsWith(q))) return SCORE.nameWord
  if (q.length >= 2 && nameWords.length >= 2 && nameWords.map((w) => w[0]).join('').startsWith(q)) return SCORE.initials
  if (name.includes(q)) return SCORE.nameSub
  if ([...words(entry.workspaceName), ...words(entry.machineName)].some((w) => w.startsWith(q))) return SCORE.place
  if (entry.agent.task && words(entry.agent.task).some((w) => w.startsWith(q))) return SCORE.task
  return 0
}

/** Every word must match somewhere; 0 = not a hit. */
export const scoreAgent = (query: string, entry: IndexedAgent): number => {
  const qs = words(query)
  if (qs.length === 0) return 0
  let total = 0
  for (const q of qs) {
    const s = scoreWord(q, entry)
    if (s === 0) return 0
    total += s
  }
  return total
}

const toHit = (entry: IndexedAgent, score: number): AgentHit => ({
  machineId: entry.machineId,
  workspaceId: entry.workspaceId,
  agentId: entry.agent.id,
  name: entry.agent.name,
  score
})

/** Smaller than any gap between two match kinds: it only ever breaks ties. */
const contextBonus = (entry: IndexedAgent, context: StrataPath) =>
  entry.machineId === context.machine ? (entry.workspaceId === context.workspace ? 3 : 1) : 0

/** The seam's FleetIndex plus the jump codes the shell draws while the finder is open. */
export interface LocalFleetIndex extends FleetIndex {
  codes(): Map<string, string>
}

export const createFleetIndex = (machines: readonly StrataMachine[], context: StrataPath = {}): LocalFleetIndex => {
  const entries = flattenFleet(machines)
  return {
    find(query, limit = 8) {
      return entries
        .map((e) => ({ e, s: scoreAgent(query, e) }))
        .filter((x) => x.s > 0)
        .map((x) => ({ ...x, s: x.s + contextBonus(x.e, context) }))
        .sort((a, b) => b.s - a.s || a.e.order - b.e.order)
        .slice(0, limit)
        .map((x) => toHit(x.e, x.s))
    },
    codes() {
      return new Map(entries.map((e) => [agentKey(e.machineId, e.agent.id), e.code]))
    },
    attention() {
      const since = (e: IndexedAgent) => e.agent.phaseSince ?? Number.MAX_SAFE_INTEGER
      const byAge = (a: IndexedAgent, b: IndexedAgent) => since(a) - since(b) || a.order - b.order
      const waiting = entries.filter((e) => e.agent.phase === 'waiting').sort(byAge)
      const replied = entries.filter((e) => e.agent.phase === 'replied').sort(byAge)
      return [...waiting, ...replied].map((e) => toHit(e, 0))
    }
  }
}

export const hitPath = (hit: AgentHit): Required<StrataPath> => ({ machine: hit.machineId, workspace: hit.workspaceId, agent: hit.agentId })

/** Key of an agent across the fleet (agent ids are only unique per desktop). */
export const agentKey = (machineId: string, agentId: string) => `${machineId}/${agentId}`
