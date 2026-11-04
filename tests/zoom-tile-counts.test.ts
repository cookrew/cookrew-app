// A TILE COUNTS ITS WORKSPACE'S AGENTS, NOT ITS ROSTER (owner, 2026-11-05). The
// roster keeps every agent a workspace ever held: GOAT Team read 87 on its tile
// and 18 once opened, Cookrew Dev 29 open and 364 left. The desktop's feed seats
// who is there now, so a tile says that, the same before and after it opens.
import { describe, expect, it } from 'vitest'
import { buildZoomModel } from '../src/renderer/src/zoom/zoom-model'
import { attachmentIndex } from '../src/renderer/src/terminal-attachments'
import { crewOf, type AgentRow } from '../src/renderer/src/agent-rows'
import type { CanvasNode, TerminalNodeData, WorkspaceMeta } from '../src/shared/model'

const term = (id: string): TerminalNodeData =>
  ({ kind: 'terminal', id, name: id, preset: 'Claude Code', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, cwd: '/x' }) as TerminalNodeData
const row = (id: string, workspaceId: string, phase = 'quiet'): AgentRow =>
  ({ id, name: id, preset: 'Claude Code', role: null, orch: false, active: true, workspaceId, workspaceName: workspaceId, cwd: '/x', spawnedAt: 0, phase, turn: null, turnCount: 0, lastActivityAt: 0 }) as AgentRow
const ws = (id: string): WorkspaceMeta => ({ id, name: id, dir: `/w/${id}`, dirs: [], icon: '🗂' }) as WorkspaceMeta

const nodes: CanvasNode[] = [term('t1')]
// The roster: w2 ever held four, one of them waiting; the feed seats two.
const rows = [row('t1', 'w1'), row('a', 'w2'), row('b', 'w2'), row('c', 'w2'), row('d', 'w2', 'waiting')]
const base = { nodes, connections: [], rows, crew: crewOf(nodes, rows, { id: 'w1', name: 'w1' }), attachIndex: attachmentIndex(nodes, []), workspaces: [ws('w1'), ws('w2')], activeId: 'w1', name: 'w1' }
const crews = new Map([
  ['w1', [{ harness: 'claude', phase: 'quiet' }]],
  ['w2', [{ harness: 'codex', phase: 'waiting' }, { harness: 'claude', phase: 'working' }]]
])

describe("a tile's agents", () => {
  it('are the ones the feed seats, not every row the roster ever held', () => {
    const tile = buildZoomModel({ ...base, crews }).marks[0]
    expect(tile.presets).toEqual(['codex', 'claude'])
  })

  it('wait as the feed says', () => {
    const tile = buildZoomModel({ ...base, crews }).marks[0]
    expect(tile).toMatchObject({ waiting: true, waitingCount: 1 })
    const none = new Map([['w2', [{ harness: 'claude', phase: 'working' }]]])
    expect(buildZoomModel({ ...base, crews: none }).marks[0]).toMatchObject({ waiting: false, waitingCount: 0 })
  })

  it('can be none: a seated workspace with nobody in it is empty, whatever the roster remembers', () => {
    const empty = new Map([['w2', []]])
    expect(buildZoomModel({ ...base, crews: empty }).marks[0].presets).toEqual([])
  })

  it('come from the roster only where the feed has not seated the workspace', () => {
    const tile = buildZoomModel({ ...base, crews: new Map([['w1', crews.get('w1')!]]) }).marks[0]
    expect(tile.presets).toHaveLength(4)
    expect(tile.waitingCount).toBe(1)
  })

  it('add up to what the machine says', () => {
    expect(buildZoomModel({ ...base, crews }).deviceAgents).toBe(3)
  })
})

describe('the open tile while its canvas is on its way', () => {
  it('says who the feed seats, not "no agents"', () => {
    const m = buildZoomModel({ ...base, crew: [], nodes: [], attachIndex: attachmentIndex([], []), crews, activeId: 'w2', loaded: false })
    expect(m.openMark.presets).toEqual(['codex', 'claude'])
    expect(m.openMark).toMatchObject({ waiting: true, waitingCount: 1 })
  })

  it('says its crew once it has one', () => {
    const m = buildZoomModel({ ...base, crews, loaded: true })
    expect(m.openMark.presets).toEqual(['Claude Code'])
  })
})
