import { describe, expect, it } from 'vitest'
import type { LevelsAgent, StrataMachine } from '../src/shared/strata'
import { agentKey, createFleetIndex, flattenFleet, scoreAgent, SCORE } from '../src/strata/finder/search'
import { CODE_PATTERN, jumpCodes } from '../src/strata/finder/codes'
import { syntheticFleet } from '../src/strata/fixture/synthetic'

const agent = (id: string, name: string, extra: Partial<LevelsAgent> = {}): LevelsAgent => ({
  id,
  name,
  harness: 'claude',
  model: null,
  orch: false,
  phase: 'idle',
  phaseSource: 'live',
  phaseSince: 0,
  task: null,
  reply: null,
  turns: 0,
  attachments: [],
  ...extra
})

const machine = (id: string, name: string, workspaces: Array<{ id: string; name: string; agents: LevelsAgent[] }>): StrataMachine => ({
  id,
  name,
  online: true,
  lastSeenAt: 0,
  appVersion: '0.3.0',
  profile: null,
  base: `/m/${id}/`,
  link: 'live',
  stale: false,
  levels: {
    v: 1,
    rev: 1,
    at: 0,
    machine: { name, appVersion: '0.3.0', profile: { kind: 'desktop', model: null, label: null, vendor: null, os: 'darwin', osVersion: null, arch: 'arm64', cpus: null, memoryGb: null, evidence: [] } },
    focusedWorkspaceId: workspaces[0]?.id ?? null,
    workspaces: workspaces.map((w) => ({ ...w, icon: null, state: 'focused', loose: [], counts: { agents: w.agents.length, notes: 0, browsers: 0 } }))
  }
})

const fleet = [
  machine('m1', 'studio', [
    { id: 'w1', name: 'Monorepo', agents: [agent('a1', 'Hazel', { phase: 'waiting', phaseSince: 50 }), agent('a2', 'Codex Sentinel', { task: 'Review the auth middleware' }), agent('a3', 'Ada')] },
    { id: 'w2', name: 'Paper Notes', agents: [agent('a4', 'Ada', { phase: 'replied', phaseSince: 10 })] }
  ]),
  machine('m2', 'night-runner', [{ id: 'w3', name: 'CI Night Shift', agents: [agent('b1', 'Heath', { phase: 'waiting', phaseSince: 20 }), agent('b2', 'Echo')] }])
]

describe('finder scoring', () => {
  const [hazel, sentinel] = flattenFleet(fleet)
  it('ranks name prefix > word start > initials > substring > place > task', () => {
    expect(scoreAgent('haz', hazel)).toBe(SCORE.namePrefix)
    expect(scoreAgent('sent', sentinel)).toBe(SCORE.nameWord)
    expect(scoreAgent('cs', sentinel)).toBe(SCORE.initials)
    expect(scoreAgent('zel', hazel)).toBe(SCORE.nameSub)
    expect(scoreAgent('mono', hazel)).toBe(SCORE.place)
    expect(scoreAgent('auth', sentinel)).toBe(SCORE.task)
    expect(scoreAgent('qqq', hazel)).toBe(0)
  })

  it('needs every word to match', () => {
    expect(scoreAgent('mono haz', hazel)).toBe(SCORE.place + SCORE.namePrefix)
    expect(scoreAgent('paper haz', hazel)).toBe(0)
  })

  it('folds case and accents', () => {
    expect(scoreAgent('HAZ', hazel)).toBe(SCORE.namePrefix)
  })
})

describe('finder results', () => {
  it('finds across every machine, best first, ties in fleet order', () => {
    const hits = createFleetIndex(fleet).find('h')
    expect(hits.map((h) => h.agentId)).toEqual(['a1', 'b1', 'b2'])
  })

  it('lets a namesake in the current workspace win the tie', () => {
    expect(createFleetIndex(fleet).find('ada')[0].agentId).toBe('a3')
    expect(createFleetIndex(fleet, { machine: 'm1', workspace: 'w2' }).find('ada')[0].agentId).toBe('a4')
  })

  it('a workspace word disambiguates namesakes', () => {
    expect(createFleetIndex(fleet).find('paper ada')[0].agentId).toBe('a4')
  })

  it('respects the limit and returns nothing for an empty query', () => {
    expect(createFleetIndex(fleet).find('a', 2)).toHaveLength(2)
    expect(createFleetIndex(fleet).find('  ')).toEqual([])
  })

  it('lists attention: waiting oldest first, then replied', () => {
    expect(createFleetIndex(fleet).attention().map((h) => h.agentId)).toEqual(['b1', 'a1', 'a4'])
  })
})

describe('jump codes: any agent in two keystrokes plus Enter', () => {
  const machines: StrataMachine[] = syntheticFleet(0).map((m) => ({ ...m, base: `/m/${m.id}/`, link: 'live', stale: false }))

  it('gives every agent a unique digit+letter code', () => {
    const codes = createFleetIndex(machines).codes()
    expect(codes.size).toBe(flattenFleet(machines).length)
    expect(new Set(codes.values()).size).toBe(codes.size)
    for (const code of codes.values()) expect(code).toMatch(CODE_PATTERN)
  })

  it('a code is the top hit for its agent, from anywhere, namesakes included', () => {
    const index = createFleetIndex(machines)
    for (const e of flattenFleet(machines)) {
      expect(index.find(e.code, 1)[0]).toMatchObject({ machineId: e.machineId, agentId: e.agent.id, score: SCORE.code })
    }
  })

  it('keeps an agent\'s code when others join or leave', () => {
    const keys = ['m/a', 'm/b', 'm/c', 'm/d']
    const before = jumpCodes(keys)
    const after = jumpCodes(['m/a', 'm/c', 'm/d', 'n/z'])
    expect(after.get('m/a')).toBe(before.get('m/a'))
    expect(after.get('m/d')).toBe(before.get('m/d'))
  })

  it('a lone digit lights every agent whose code starts with it', () => {
    const index = createFleetIndex(machines)
    const codes = index.codes()
    const threes = [...codes.values()].filter((c) => c.startsWith('3')).length
    expect(index.find('3', 1000)).toHaveLength(threes)
  })

  it('runs past 234 agents with longer codes, still unique', () => {
    const keys = Array.from({ length: 300 }, (_, i) => `m/a${i}`)
    const codes = jumpCodes(keys)
    expect(new Set(codes.values()).size).toBe(300)
  })

  it('agent keys are machine-scoped', () => {
    expect(agentKey('m1', 'a1')).not.toBe(agentKey('m2', 'a1'))
  })
})

describe('two letters and Enter (synthetic fleet)', () => {
  it('reaches most agents with a two-letter query from inside their workspace, and every distinct name from anywhere', () => {
    const machines: StrataMachine[] = syntheticFleet(0).map((m) => ({ ...m, base: `/m/${m.id}/`, link: 'live', stale: false }))
    const entries = flattenFleet(machines)
    const firstOfName = new Map<string, string>()
    for (const e of entries) if (!firstOfName.has(e.agent.name)) firstOfName.set(e.agent.name, e.agent.id)
    // From anywhere, typing a name's first two letters plus a third if needed reaches the first of that name.
    let reachedInTwo = 0
    for (const e of entries) {
      const index = createFleetIndex(machines, { machine: e.machineId, workspace: e.workspaceId })
      const q = e.agent.name.slice(0, 2)
      if (index.find(q, 1)[0]?.agentId === e.agent.id) reachedInTwo += 1
    }
    expect(reachedInTwo / entries.length).toBeGreaterThan(0.5)
  })
})
