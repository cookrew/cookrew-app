// THE ZOOM VIEW RE-RENDERS WHEN WHAT IT DRAWS OF THE FLEET CHANGES (perf,
// 2026-11-01): the fleet changes on every fleet delta, a working agent's
// reply and status line included, and the view drew none of that.
import { describe, expect, it } from 'vitest'
import { createFleetViewReader, type ZoomFleet } from '../src/renderer/src/zoom/use-zoom-fleet'

const fleetWith = (agent: Record<string, unknown>): ZoomFleet =>
  ({
    loading: false,
    error: null,
    machines: [{ id: 'm', name: 'Mac', local: true, online: true, detail: 'live', lastSeenAt: 1, appVersion: null, profile: null, focusedWorkspaceId: 'w', counts: null,
      workspaces: [{ id: 'w', name: 'Dev', icon: '🗂', traits: [], focused: true, live: true, loose: [], counts: { agents: 1, notes: 0, browsers: 0, waiting: 0, working: 1 },
        agents: [{ id: 'a', name: 'Forge', harness: 'claude', model: null, orch: false, phaseSource: 'tracker', phaseSince: 1, task: null, ...agent }] }] }]
  }) as unknown as ZoomFleet

describe('createFleetViewReader', () => {
  it('updates when an embedded agent card changes and ignores an undrawn status line', () => {
    let fleet = fleetWith({ phase: 'working', reply: 'Reading a.ts', status: 'Cerebrating…' })
    const read = createFleetViewReader(() => fleet)
    const first = read()
    expect(read()).toBe(first)
    fleet = fleetWith({ phase: 'working', reply: 'Editing b.ts', status: 'Pondering…' })
    const updated = read()
    expect(updated).not.toBe(first)
    fleet = fleetWith({ phase: 'working', reply: 'Editing b.ts', status: 'Still working…' })
    expect(read()).toBe(updated)
    fleet = fleetWith({ phase: 'waiting', reply: 'Editing b.ts', status: null })
    const next = read()
    expect(next).not.toBe(first)
    expect(next.machines[0].workspaces[0].agents[0]).toMatchObject({ id: 'a', name: 'Forge', harness: 'claude', phase: 'waiting', reply: 'Editing b.ts' })
  })
})
