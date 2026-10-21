import { describe, expect, it } from 'vitest'
import type { LevelsSnapshot } from '../src/shared/strata'
import { syntheticFleet } from '../src/strata/fixture/synthetic'
import { parseFleetList, parseLevelsEvent } from '../src/strata/fleet/guards'
import { foldLevels } from '../src/strata/fleet/levels-fold'

const SNAP = syntheticFleet(1_800_000_000_000).find((m) => m.id === 'syn-studio')!.levels as LevelsSnapshot
const [focused, background] = SNAP.workspaces

const fold = (levels: LevelsSnapshot, event: Parameters<typeof foldLevels>[1]) => {
  const result = foldLevels(levels, event)
  if (!result.ok) throw new Error(result.reason)
  return result.levels
}

describe('folding levels events', () => {
  it('moves the focused state with focus', () => {
    const next = fold(SNAP, { type: 'focus', rev: SNAP.rev + 1, workspaceId: background.id })
    expect(next.focusedWorkspaceId).toBe(background.id)
    expect(next.workspaces.find((w) => w.id === background.id)?.state).toBe('focused')
    expect(next.workspaces.find((w) => w.id === focused.id)?.state).toBe('background')
    expect(SNAP.workspaces[0].state).toBe('focused')
  })

  it('adds a new agent at the end and keeps counts true', () => {
    const agent = { ...focused.agents[0], id: 'new-one', name: 'Newt' }
    const next = fold(SNAP, { type: 'agent', rev: SNAP.rev + 1, workspaceId: focused.id, agent })
    const workspace = next.workspaces[0]
    expect(workspace.agents.at(-1)?.id).toBe('new-one')
    expect(workspace.counts.agents).toBe(focused.agents.length + 1)
    const gone = fold(next, { type: 'agent-gone', rev: next.rev + 1, workspaceId: focused.id, agentId: 'new-one' })
    expect(gone.workspaces[0].counts.agents).toBe(focused.agents.length)
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
    expect(foldLevels(null, { type: 'focus', rev: 2, workspaceId: null })).toEqual({ ok: false, reason: 'no-base' })
    expect(foldLevels(SNAP, { type: 'focus', rev: SNAP.rev, workspaceId: null })).toEqual({ ok: false, reason: 'gap' })
    expect(foldLevels(SNAP, { type: 'focus', rev: SNAP.rev + 2, workspaceId: null })).toEqual({ ok: false, reason: 'gap' })
  })
})

describe('checking what crosses the wire', () => {
  it('reads only events this version understands', () => {
    expect(parseLevelsEvent(JSON.stringify({ type: 'snapshot', snapshot: SNAP }))?.type).toBe('snapshot')
    expect(parseLevelsEvent(JSON.stringify({ type: 'snapshot', snapshot: { ...SNAP, v: 9 } }))).toBeNull()
    expect(parseLevelsEvent(JSON.stringify({ type: 'agent', rev: 3, workspaceId: 'w' }))).toBeNull()
    expect(parseLevelsEvent(JSON.stringify({ type: 'teleport', rev: 3 }))).toBeNull()
    expect(parseLevelsEvent('nope')).toBeNull()
  })

  it('takes the registry list as the bare array, drops bad and duplicate rows', () => {
    const good = { id: 'a', name: 'a', online: true, lastSeenAt: null, appVersion: null, profile: null, base: '/m/a/' }
    expect(parseFleetList([good, good, { ...good, id: 'b', base: 'http://x/' }])).toHaveLength(1)
    expect(parseFleetList({ desktops: [good] })).toEqual([])
    expect(parseFleetList('nope')).toEqual([])
  })
})
