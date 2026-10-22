import { describe, expect, it } from 'vitest'
import { anchorOf, levelOf, parentOf, STRATA_LINE_MAX, type MachineKind } from '../src/shared/strata'
import { syntheticFleet } from '../src/strata/fixture/synthetic'

const NOW = 1_800_000_000_000

describe('strata levels', () => {
  it('names the level a path stands on', () => {
    expect(levelOf({})).toBe('machines')
    expect(levelOf({ machine: 'm' })).toBe('workspaces')
    expect(levelOf({ machine: 'm', workspace: 'w' })).toBe('agents')
    expect(levelOf({ machine: 'm', workspace: 'w', agent: 'a' })).toBe('terminal')
  })

  it('steps out exactly one level', () => {
    expect(parentOf({ machine: 'm', workspace: 'w', agent: 'a' })).toEqual({ machine: 'm', workspace: 'w' })
    expect(parentOf({ machine: 'm', workspace: 'w' })).toEqual({ machine: 'm' })
    expect(parentOf({ machine: 'm' })).toEqual({})
    expect(parentOf({})).toEqual({})
  })

  it('anchors the deepest id a path names, with its machine', () => {
    expect(anchorOf({ machine: 'm' })).toBe('machine:m')
    expect(anchorOf({ machine: 'm', workspace: 'w' })).toBe('workspace:m/w')
    expect(anchorOf({ machine: 'm', workspace: 'w', agent: 'a' })).toBe('agent:m/a')
    expect(anchorOf({ machine: 'n', workspace: 'w', agent: 'a' })).not.toBe(anchorOf({ machine: 'm', workspace: 'w', agent: 'a' }))
  })
})

describe('the synthetic preview fleet', () => {
  const fleet = syntheticFleet(NOW)

  it('is the same fleet for the same seed', () => {
    expect(syntheticFleet(NOW)).toEqual(fleet)
    expect(syntheticFleet(NOW, 22)).not.toEqual(fleet)
  })

  it('covers every machine kind but unknown', () => {
    const kinds = new Set(fleet.map((m) => m.profile?.kind))
    const wanted: MachineKind[] = ['laptop', 'desktop', 'server', 'cloud', 'vm', 'cluster', 'sandbox']
    expect([...kinds].sort()).toEqual([...wanted].sort())
  })

  it('focuses exactly one workspace on every machine that has any', () => {
    for (const machine of fleet) {
      const workspaces = machine.levels?.workspaces ?? []
      if (workspaces.length === 0) continue
      const focused = workspaces.filter((w) => w.state === 'focused')
      expect(focused).toHaveLength(1)
      expect(machine.levels?.focusedWorkspaceId).toBe(focused[0].id)
    }
  })

  it('has an offline machine with a cache and one never reached', () => {
    const offline = fleet.filter((m) => !m.online)
    expect(offline.some((m) => m.levels !== null)).toBe(true)
    expect(offline.some((m) => m.levels === null && m.lastSeenAt === null)).toBe(true)
    for (const machine of offline) {
      for (const agent of machine.levels?.workspaces.flatMap((w) => w.agents) ?? []) {
        expect(agent.phase).toBe('offline')
        expect(agent.phaseSource).toBe('ledger')
      }
    }
  })

  it('carries the stress cases the views must survive', () => {
    const workspaces = fleet.flatMap((m) => m.levels?.workspaces ?? [])
    const agents = workspaces.flatMap((w) => w.agents)
    expect(Math.max(...workspaces.map((w) => w.agents.length))).toBeGreaterThanOrEqual(48)
    expect(Math.max(...agents.map((a) => a.attachments.length))).toBeGreaterThanOrEqual(40)
    expect(agents.some((a) => a.attachments.some((x) => x.shared))).toBe(true)
    expect(workspaces.some((w) => w.loose.length > 0)).toBe(true)
  })

  it('keeps every line within the contract limit and every id unique within its machine', () => {
    for (const machine of fleet) {
      const agents = machine.levels?.workspaces.flatMap((w) => w.agents) ?? []
      for (const agent of agents) {
        expect((agent.task ?? '').length).toBeLessThanOrEqual(STRATA_LINE_MAX)
        expect((agent.reply ?? '').length).toBeLessThanOrEqual(STRATA_LINE_MAX)
      }
      const ids = agents.map((a) => a.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('has a machine restored from another, sharing its workspace and agent ids', () => {
    const idsOf = (id: string) => {
      const workspaces = fleet.find((m) => m.id === id)?.levels?.workspaces ?? []
      return new Set([...workspaces.map((w) => w.id), ...workspaces.flatMap((w) => w.agents.map((a) => a.id))])
    }
    const studio = idsOf('syn-studio')
    const shared = [...idsOf('syn-laptop')].filter((id) => studio.has(id))
    expect(shared.length).toBeGreaterThanOrEqual(2)
  })

  it('says only the status verb, never a counter', () => {
    const statuses = fleet.flatMap((m) => m.levels?.workspaces.flatMap((w) => w.agents.map((a) => a.status)) ?? []).filter(Boolean)
    expect(statuses.length).toBeGreaterThan(0)
    for (const status of statuses) expect(status).toMatch(/^[A-Z][a-z]+…$/)
  })

  it('counts what the workspace holds', () => {
    for (const workspace of fleet.flatMap((m) => m.levels?.workspaces ?? [])) {
      const unique = new Map([...workspace.agents.flatMap((a) => a.attachments), ...workspace.loose].map((a) => [a.id, a]))
      expect(workspace.counts.agents).toBe(workspace.agents.length)
      expect(workspace.counts.notes).toBe([...unique.values()].filter((a) => a.kind === 'note').length)
      expect(workspace.counts.browsers).toBe([...unique.values()].filter((a) => a.kind === 'browser').length)
    }
  })
})
