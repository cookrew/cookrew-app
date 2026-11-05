import { describe, expect, it } from 'vitest'
import { FLEET_VERSION, type FleetAgent, type FleetSnapshot, type FleetWorkspace } from '../src/shared/fleet'
import { foldFleet } from '../src/shared/fleet-fold'
import { PROFILE } from './fleet-fixture'

const agent = (id: string): FleetAgent => ({
  id,
  name: id,
  harness: 'claude',
  model: null,
  orch: false,
  phase: 'idle',
  phaseSource: 'live',
  phaseSince: null,
  task: null,
  reply: null,
  turns: 0,
  attachments: []
})

const workspace = (id: string, state: FleetWorkspace['state'], agents: FleetAgent[]): FleetWorkspace => ({
  id,
  name: id,
  icon: null,
  state,
  agents,
  loose: [],
  counts: { agents: agents.length, notes: 0, browsers: 0 }
})

const SNAP: FleetSnapshot = {
  v: FLEET_VERSION,
  rev: 7,
  at: 1_800_000_000_000,
  machine: { name: 'Studio', appVersion: null, profile: PROFILE },
  focusedWorkspaceId: 'w1',
  workspaces: [workspace('w1', 'focused', [agent('a1'), agent('a2')]), workspace('w2', 'background', [agent('a3')])]
}
const [focused, background] = SNAP.workspaces

const fold = (snapshot: FleetSnapshot, event: Parameters<typeof foldFleet>[1]) => {
  const result = foldFleet(snapshot, event)
  if (!result.ok) throw new Error(result.reason)
  return result.snapshot
}

describe('folding fleet events', () => {
  it('moves the focused state with focus', () => {
    const next = fold(SNAP, { type: 'focus', rev: SNAP.rev + 1, workspaceId: background.id })
    expect(next.focusedWorkspaceId).toBe(background.id)
    expect(next.workspaces.find((w) => w.id === background.id)?.state).toBe('focused')
    expect(next.workspaces.find((w) => w.id === focused.id)?.state).toBe('background')
    expect(SNAP.workspaces[0].state).toBe('focused')
  })

  it('takes a seating change as one whole workspace, counts with it', () => {
    const seated = { ...focused, agents: focused.agents.slice(1), counts: { ...focused.counts, agents: focused.agents.length - 1 } }
    const next = fold(SNAP, { type: 'workspace', rev: SNAP.rev + 1, workspace: seated })
    expect(next.workspaces[0].agents.map((a) => a.id)).toEqual(focused.agents.slice(1).map((a) => a.id))
    expect(next.workspaces[0].counts.agents).toBe(focused.agents.length - 1)
  })

  it('replaces everything on a mid-stream snapshot at rev + 1: not a gap', () => {
    const fresh = { ...SNAP, rev: SNAP.rev + 1, workspaces: SNAP.workspaces.slice(1), focusedWorkspaceId: null }
    expect(foldFleet(SNAP, { type: 'snapshot', snapshot: fresh })).toEqual({ ok: true, snapshot: fresh })
  })

  it('replaces, appends and removes whole workspaces', () => {
    const renamed = fold(SNAP, { type: 'workspace', rev: SNAP.rev + 1, workspace: { ...background, name: 'Renamed' } })
    expect(renamed.workspaces.map((w) => w.name)).toContain('Renamed')
    expect(renamed.workspaces).toHaveLength(SNAP.workspaces.length)
    const removed = fold(renamed, { type: 'workspace-gone', rev: renamed.rev + 1, workspaceId: focused.id })
    expect(removed.workspaces).toHaveLength(SNAP.workspaces.length - 1)
    expect(removed.focusedWorkspaceId).toBeNull()
  })

  it('refuses a delta with no snapshot under it, or off by any amount', () => {
    expect(foldFleet(null, { type: 'focus', rev: 2, workspaceId: null })).toEqual({ ok: false, reason: 'no-base' })
    expect(foldFleet(SNAP, { type: 'focus', rev: SNAP.rev, workspaceId: null })).toEqual({ ok: false, reason: 'gap' })
    expect(foldFleet(SNAP, { type: 'focus', rev: SNAP.rev + 2, workspaceId: null })).toEqual({ ok: false, reason: 'gap' })
  })
})
