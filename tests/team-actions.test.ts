import { describe, expect, it } from 'vitest'
import type { CanvasNode, Connection, TeamMeta, WorkspaceState } from '../src/shared/model'
import { saveClash, scopeToSelection, selectionSummary } from '../src/shared/team-actions'
import { fileSlug } from '../src/shared/slug'

function terminal(id: string): CanvasNode {
  return { kind: 'terminal', id, name: id } as unknown as CanvasNode
}
function note(id: string): CanvasNode {
  return { kind: 'note', id, name: id } as unknown as CanvasNode
}
function browser(id: string): CanvasNode {
  return { kind: 'browser', id, name: id } as unknown as CanvasNode
}
function cable(id: string, a: string, b: string): Connection {
  return { id, a, b }
}

function ws(
  nodes: CanvasNode[],
  connections: Connection[] = [],
  name = 'kitchen'
): WorkspaceState {
  return { name, dir: '/w', dirs: ['/w'], nodes, connections }
}

/**
 * The Figma model: a SELECTION is the unit of copy/cut/save, and the cables
 * between selected elements travel with it.
 */
describe('scopeToSelection — what a scoped template contains', () => {
  const state = ws(
    [terminal('t1'), terminal('t2'), note('n1'), browser('b1')],
    [cable('c12', 't1', 't2'), cable('c1n', 't1', 'n1'), cable('c2b', 't2', 'b1')]
  )

  it('keeps selected nodes and ONLY the cables with both ends selected', () => {
    const scoped = scopeToSelection(state, ['t1', 't2', 'n1'])
    expect(scoped.nodes.map((n) => n.id)).toEqual(['t1', 't2', 'n1'])
    // c2b reaches outside the selection — a dangling cable must not travel.
    expect(scoped.connections.map((c) => c.id)).toEqual(['c12', 'c1n'])
  })

  it('preserves canvas order, not selection order', () => {
    const scoped = scopeToSelection(state, ['n1', 't1'])
    expect(scoped.nodes.map((n) => n.id)).toEqual(['t1', 'n1'])
  })

  it('is the identity for a full selection', () => {
    const scoped = scopeToSelection(state, ['t1', 't2', 'n1', 'b1'])
    expect(scoped.nodes).toEqual(state.nodes)
    expect(scoped.connections).toEqual(state.connections)
  })

  it('does not mutate the source state', () => {
    const before = JSON.stringify(state)
    scopeToSelection(state, ['t1'])
    expect(JSON.stringify(state)).toBe(before)
  })
})

describe('selectionSummary — the bar label', () => {
  const state = ws(
    [terminal('t1'), terminal('t2'), note('n1')],
    [cable('c12', 't1', 't2'), cable('c1n', 't1', 'n1')]
  )

  it('counts selected nodes, terminals, and fully-inside cables', () => {
    expect(selectionSummary(state, ['t1', 't2'])).toEqual({ nodes: 2, terminals: 2, cables: 1 })
    expect(selectionSummary(state, ['t1', 't2', 'n1'])).toEqual({
      nodes: 3,
      terminals: 2,
      cables: 2
    })
    expect(selectionSummary(state, ['n1'])).toEqual({ nodes: 1, terminals: 0, cables: 0 })
  })

  it('ignores ids that are not on the canvas (stale selections)', () => {
    expect(selectionSummary(state, ['t1', 'ghost'])).toEqual({ nodes: 1, terminals: 1, cables: 0 })
  })
})

function team(name: string): TeamMeta {
  return { name, savedAt: 1, nodeCount: 1, terminalCount: 1 }
}

/**
 * The overwrite guard behind SAVE TEMPLATE. Team files are keyed by
 * fileSlug(name), so the guard must collide exactly where the backend's
 * writeFileSync would — same-slug different-spelling names included.
 */
describe('saveClash', () => {
  it('matches the shared slug, not the literal name', () => {
    const teams = [team('kitchen copy')]
    expect(saveClash(teams, 'Kitchen Copy', 'ws')?.name).toBe('kitchen copy')
    expect(saveClash(teams, 'kitchen-copy', 'ws')?.name).toBe('kitchen copy')
    expect(saveClash(teams, 'kitchen', 'ws')).toBeNull()
  })

  it('empty input falls back to the workspace name — the likeliest collision', () => {
    expect(saveClash([team('GOAT Team')], '  ', 'GOAT Team')?.name).toBe('GOAT Team')
    expect(saveClash([team('other')], '', 'GOAT Team')).toBeNull()
  })

  it('fileSlug matches the backend roleSlug behavior', () => {
    expect(fileSlug('  Kitchen  Copy! ')).toBe('kitchen-copy')
    expect(fileSlug('***')).toBe('role')
    expect(fileSlug('***', 'team')).toBe('team')
  })
})
