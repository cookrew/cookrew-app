// THE CROSS-MACHINE INDEX (FleetIndex in src/strata/seams.ts): every agent of
// every machine the shell can see, cached ones included, for the finder and
// the level-0 pins. Pure: built from the fleet rows, rebuilt when they change.
//
// A query is words; EVERY word has to land somewhere — the agent's name, its
// task, its workspace or its machine — so "studio ada" means Ada on studio.
// A word lands by, best first: the whole word, a prefix, a substring, the
// initials of a field ("ruq" → Refactor the Upload Queue), or a typo within
// one edit (two for long words).
import { useMemo } from 'react'
import type { LevelsAgent, StrataMachine } from '../../shared/strata'
import type { AgentHit, FleetIndex } from '../seams'
import { useFleet } from './use-fleet'

interface Field {
  weight: number
  text: string
  words: string[]
  initials: string
}

interface Doc {
  hit: Omit<AgentHit, 'score'>
  agent: LevelsAgent
  /** The name as words, for the whole-name bonus. */
  name: string
  live: boolean
  fields: Field[]
}

const WEIGHT = { name: 1, machine: 0.7, workspace: 0.7, task: 0.5 } as const
const SCORE = { word: 1, prefix: 0.8, substring: 0.6, initials: 0.5, typo1: 0.4, typo2: 0.3 } as const
const DEFAULT_LIMIT = 20

export const normalize = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

const wordsOf = (text: string): string[] => normalize(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

const fieldOf = (weight: number, text: string | null): Field | null => {
  if (!text) return null
  const words = wordsOf(text)
  return { weight, text: words.join(' '), words, initials: words.map((w) => w[0]).join('') }
}

/** Optimal string alignment distance, giving up past `max`. */
export const editDistance = (a: string, b: string, max: number): number => {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prevPrev: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, prevPrev[j - 2] + 1)
      row.push(value)
      best = Math.min(best, value)
    }
    if (best > max) return max + 1
    prevPrev = prev
    prev = row
  }
  return prev[b.length]
}

const typosAllowed = (term: string) => (term.length >= 7 ? 2 : term.length >= 4 ? 1 : 0)

const isSubsequence = (needle: string, hay: string): boolean => {
  let i = 0
  for (const c of hay) if (c === needle[i]) i += 1
  return i === needle.length
}

/** How well one query word lands in one field, before the field's weight. */
const termScore = (term: string, field: Field): number => {
  if (field.words.includes(term)) return SCORE.word
  if (field.words.some((w) => w.startsWith(term))) return SCORE.prefix
  if (term.length >= 2 && field.text.includes(term)) return SCORE.substring
  if (term.length >= 2 && field.initials.length >= 2 && term[0] === field.initials[0] && isSubsequence(term, field.initials))
    return SCORE.initials
  const max = typosAllowed(term)
  if (max === 0) return 0
  let best = max + 1
  for (const word of field.words) {
    best = Math.min(best, editDistance(term, word, max))
    if (word.length > term.length) best = Math.min(best, editDistance(term, word.slice(0, term.length), max))
    if (best === 1) break
  }
  if (best > max) return 0
  return best <= 1 ? SCORE.typo1 : SCORE.typo2
}

const docsOf = (machines: readonly StrataMachine[]): Doc[] =>
  machines.flatMap((machine) =>
    (machine.levels?.workspaces ?? []).flatMap((workspace) =>
      workspace.agents.map((agent) => ({
        hit: { machineId: machine.id, workspaceId: workspace.id, agentId: agent.id, name: agent.name },
        agent,
        name: wordsOf(agent.name).join(' '),
        live: machine.link === 'live',
        fields: [
          fieldOf(WEIGHT.name, agent.name),
          fieldOf(WEIGHT.machine, machine.name),
          fieldOf(WEIGHT.workspace, workspace.name),
          fieldOf(WEIGHT.task, agent.task)
        ].filter((f): f is Field => f !== null)
      }))
    )
  )

const ATTENTION_RANK: Partial<Record<LevelsAgent['phase'], number>> = { waiting: 2, replied: 1 }

export const createFleetIndex = (machines: readonly StrataMachine[]): FleetIndex => {
  const docs = docsOf(machines)
  return {
    find(query, limit = DEFAULT_LIMIT, near) {
      const terms = wordsOf(query)
      if (terms.length === 0) return []
      const whole = terms.join(' ')
      const hits: AgentHit[] = []
      for (const doc of docs) {
        let score = 0
        for (const term of terms) {
          const best = Math.max(0, ...doc.fields.map((f) => termScore(term, f) * f.weight))
          if (best === 0) {
            score = 0
            break
          }
          score += best
        }
        if (score === 0) continue
        if (doc.name === whole) score += 0.5
        hits.push({ ...doc.hit, score: Math.round(score * 1000) / 1000 })
      }
      // Ids are unique only within a machine, so nearness is machine AND id.
      const nearness = (hit: AgentHit): number =>
        !near?.machine || hit.machineId !== near.machine ? 0 : near.workspace && hit.workspaceId === near.workspace ? 2 : 1
      // Equal scores lean toward where the user is (same workspace, then same
      // machine), then keep fleet order: Array.prototype.sort is stable.
      return hits.sort((a, b) => b.score - a.score || nearness(b) - nearness(a)).slice(0, Math.max(0, limit))
    },
    /**
     * Waiting on the owner, then replied, oldest first. Only machines whose
     * stream is live: a cached "waiting" may have been answered since, and the
     * "needs you" count must not ask the owner about a guess.
     */
    attention() {
      return docs
        .filter((doc) => doc.live && ATTENTION_RANK[doc.agent.phase] !== undefined)
        .sort(
          (a, b) =>
            (ATTENTION_RANK[b.agent.phase] ?? 0) - (ATTENTION_RANK[a.agent.phase] ?? 0) ||
            (a.agent.phaseSince ?? Number.MAX_SAFE_INTEGER) - (b.agent.phaseSince ?? Number.MAX_SAFE_INTEGER)
        )
        .map((doc) => ({ ...doc.hit, score: ATTENTION_RANK[doc.agent.phase] ?? 0 }))
    }
  }
}

/** The index over the live fleet; rebuilt only when the rows change. */
export const useFleetIndex = (): FleetIndex => {
  const machines = useFleet()
  return useMemo(() => createFleetIndex(machines), [machines])
}
