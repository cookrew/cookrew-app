// LOCAL FLEET INDEX: a plain search over useFleet() until Harbor's FleetIndex
// is wired in at the merge (same FleetIndex seam, so the swap is one import).
// Every agent on every machine the shell can see, cached ones included. Equal
// scores keep fleet order (machine, workspace, creation); `near` breaks ties
// toward the user's workspace, then machine. Jump codes are not in here: they
// sit on top of whichever index runs (codes.ts, Finder.tsx).
import type { LevelsAgent, StrataMachine, StrataPath } from '../../shared/strata'
import type { AgentHit, FleetIndex } from '../seams'

export interface IndexedAgent {
  machineId: string
  machineName: string
  workspaceId: string
  workspaceName: string
  agent: LevelsAgent
  /** Position in fleet order. */
  order: number
}

/** Key of an agent across the fleet (agent and workspace ids are only unique per machine). */
export const agentKey = (machineId: string, agentId: string) => `${machineId}/${agentId}`

export const flattenFleet = (machines: readonly StrataMachine[]): IndexedAgent[] => {
  let order = 0
  return machines.flatMap((m) =>
    (m.levels?.workspaces ?? []).flatMap((w) =>
      w.agents.map((agent) => ({ machineId: m.id, machineName: m.name, workspaceId: w.id, workspaceName: w.name, agent, order: order++ }))
    )
  )
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
const words = (s: string) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

export const SCORE = { namePrefix: 100, nameWord: 80, initials: 70, nameSub: 50, place: 30, task: 10 } as const

/** One query word against one agent: the best way it matches, 0 for none. */
const scoreWord = (q: string, entry: IndexedAgent): number => {
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

/** 2 same workspace, 1 same machine, else 0: only ever breaks ties. */
const nearness = (entry: IndexedAgent, near?: Pick<StrataPath, 'machine' | 'workspace'>) =>
  near?.machine && entry.machineId === near.machine ? (near.workspace && entry.workspaceId === near.workspace ? 2 : 1) : 0

export const createFleetIndex = (machines: readonly StrataMachine[]): FleetIndex => {
  const entries = flattenFleet(machines)
  return {
    find(query, limit = 8, near) {
      return entries
        .map((e) => ({ e, s: scoreAgent(query, e) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || nearness(b.e, near) - nearness(a.e, near) || a.e.order - b.e.order)
        .slice(0, limit)
        .map((x) => toHit(x.e, x.s))
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
