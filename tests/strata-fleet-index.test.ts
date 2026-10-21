import { describe, expect, it } from 'vitest'
import type { LevelsAgent, StrataMachine } from '../src/shared/strata'
import { syntheticFleet } from '../src/strata/fixture/synthetic'
import { createFleetIndex, editDistance } from '../src/strata/fleet/fleet-index'

const NOW = 1_800_000_000_000

const asRows = (): StrataMachine[] =>
  syntheticFleet(NOW).map(({ levels, ...m }) => ({
    ...m,
    base: `/m/${m.id}/`,
    link: m.online ? 'live' : 'offline',
    levels,
    stale: !m.online && levels !== null
  }))

const agent = (id: string, name: string, patch: Partial<LevelsAgent> = {}): LevelsAgent => ({
  id,
  name,
  harness: 'claude',
  model: null,
  orch: false,
  phase: 'idle',
  phaseSource: 'live',
  phaseSince: NOW,
  task: null,
  reply: null,
  turns: 0,
  attachments: [],
  ...patch
})

const machine = (id: string, name: string, link: StrataMachine['link'], workspaces: Array<[string, string, LevelsAgent[]]>): StrataMachine => ({
  id,
  name,
  online: link === 'live',
  lastSeenAt: NOW,
  appVersion: '0.4.0',
  profile: null,
  base: `/m/${id}/`,
  link,
  stale: link !== 'live',
  levels: {
    v: 1,
    rev: 1,
    at: NOW,
    machine: { name, appVersion: null, profile: { kind: 'desktop', model: null, label: null, vendor: null, os: 'darwin', osVersion: null, arch: 'arm64', cpus: null, memoryGb: null, evidence: [] } },
    focusedWorkspaceId: workspaces[0]?.[0] ?? null,
    workspaces: workspaces.map(([wid, wname, agents], i) => ({
      id: wid,
      name: wname,
      icon: null,
      state: i === 0 ? 'focused' : 'background',
      agents,
      loose: [],
      counts: { agents: agents.length, notes: 0, browsers: 0 }
    }))
  }
})

const small = [
  machine('m1', 'studio', 'live', [
    ['w1', 'Monorepo', [agent('a1', 'Ada', { task: 'Refactor the upload queue so retries back off' }), agent('a2', 'Basil', { task: 'Draft the release notes' })]],
    ['w2', 'Paper Notes', [agent('a3', 'Cleo', { task: 'Summarise the incident' })]]
  ]),
  machine('m2', 'night-runner', 'live', [['w3', 'CI Night Shift', [agent('a4', 'Ada', { task: 'Migrate the cron jobs' }), agent('a5', 'Adalbert')]]]),
  machine('m3', 'old-thinkpad', 'offline', [['w4', 'Thesis', [agent('a6', 'Quill', { phase: 'waiting', phaseSince: NOW - 10 })]]])
]

describe('FleetIndex.find', () => {
  const index = createFleetIndex(small)
  const ids = (query: string) => index.find(query).map((h) => h.agentId)

  it('finds by name across machines, exact names first, fleet order on ties', () => {
    expect(ids('ada').slice(0, 2)).toEqual(['a1', 'a4'])
    expect(ids('ada')).toContain('a5')
  })

  it('needs every word to land: machine plus name', () => {
    expect(ids('night ada')).toEqual(['a4', 'a5'])
    expect(ids('studio ada')).toEqual(['a1'])
  })

  it('finds by task words, workspace names and machine names', () => {
    expect(ids('upload')).toEqual(['a1'])
    expect(ids('paper')).toEqual(['a3'])
    expect(ids('thinkpad')).toEqual(['a6'])
  })

  it('forgives a typo, and reads initials', () => {
    expect(ids('cloe')).toEqual(['a3'])
    expect(ids('refcator')).toEqual(['a1'])
    expect(ids('ruq')).toEqual(['a1'])
    expect(ids('cns')).toContain('a4')
  })

  it('breaks equal scores toward the user’s workspace, then machine, then fleet order', () => {
    const near = createFleetIndex([
      machine('m1', 'one', 'live', [
        ['w1', 'Alpha', [agent('p1', 'Pip')]],
        ['w2', 'Beta', [agent('p2', 'Pip')]]
      ]),
      machine('m2', 'two', 'live', [['w1', 'Alpha', [agent('p1', 'Pip')]]])
    ])
    const order = (where?: { machine?: string; workspace?: string }) => near.find('pip', 10, where).map((h) => `${h.machineId}/${h.agentId}`)
    expect(order()).toEqual(['m1/p1', 'm1/p2', 'm2/p1'])
    expect(order({ machine: 'm1', workspace: 'w2' })).toEqual(['m1/p2', 'm1/p1', 'm2/p1'])
    expect(order({ machine: 'm2', workspace: 'w1' })).toEqual(['m2/p1', 'm1/p1', 'm1/p2'])
    expect(order({ machine: 'm2' })).toEqual(['m2/p1', 'm1/p1', 'm1/p2'])
  })

  it('finds nothing for nothing, and honours the limit', () => {
    expect(index.find('')).toEqual([])
    expect(index.find('   ')).toEqual([])
    expect(index.find('zzzzqqq')).toEqual([])
    expect(index.find('ada', 1)).toHaveLength(1)
  })

  it('is case- and accent-blind', () => {
    const accented = createFleetIndex([machine('m', 'café', 'live', [['w', 'Señor', [agent('x', 'Zoë')]]])])
    expect(accented.find('ZOE').map((h) => h.agentId)).toEqual(['x'])
    expect(accented.find('cafe senor').map((h) => h.agentId)).toEqual(['x'])
  })

  it('keeps up with the synthetic fleet, cached machines included', () => {
    const fleet = createFleetIndex(asRows())
    expect(fleet.find('ada').length).toBeGreaterThan(0)
    expect(fleet.find('thesis').every((h) => h.machineId === 'syn-laptop')).toBe(true)
    const started = performance.now()
    for (let i = 0; i < 50; i += 1) fleet.find('refactr queue')
    expect((performance.now() - started) / 50).toBeLessThan(20)
  })
})

describe('FleetIndex.attention', () => {
  it('lists waiting before replied, oldest first, live machines only', () => {
    const index = createFleetIndex([
      machine('m1', 'studio', 'live', [
        [
          'w1',
          'Monorepo',
          [
            agent('r-new', 'R1', { phase: 'replied', phaseSince: NOW - 1 }),
            agent('w-new', 'W1', { phase: 'waiting', phaseSince: NOW - 5 }),
            agent('r-old', 'R2', { phase: 'replied', phaseSince: NOW - 100 }),
            agent('idle', 'I', { phase: 'idle' })
          ]
        ]
      ]),
      machine('m2', 'cloud', 'live', [['w2', 'CI', [agent('w-old', 'W2', { phase: 'waiting', phaseSince: NOW - 50 })]]]),
      small[2]
    ])
    expect(index.attention().map((h) => h.agentId)).toEqual(['w-old', 'w-new', 'r-old', 'r-new'])
  })
})

describe('edit distance', () => {
  it('counts a swap as one edit and gives up past the limit', () => {
    expect(editDistance('cleo', 'cloe', 2)).toBe(1)
    expect(editDistance('kitten', 'sitting', 3)).toBe(3)
    expect(editDistance('a', 'abcdef', 1)).toBe(2)
  })
})
