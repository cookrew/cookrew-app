// THE ZOOM'S MODEL, from the app's real rows, nodes and cables
// (renderer zoom/zoom-model.ts): who the workspace's agents are, which
// browsers and notes they carry through the wiring, which are shared, and the
// newest browser that stands beside the stack at group zoom. Pure, so pinned here.
import { describe, expect, it } from 'vitest'
import { buildZoomModel, ITEMS_SHOWN, PHASE_WORD, lineOf } from '../src/renderer/src/zoom/zoom-model'
import { attachmentIndex } from '../src/renderer/src/terminal-attachments'
import { crewOf, type AgentRow } from '../src/renderer/src/agent-rows'
import type { BrowserNodeData, CanvasNode, Connection, NoteNodeData, TerminalNodeData, WorkspaceMeta } from '../src/shared/model'

const term = (id: string, name: string, over: Partial<TerminalNodeData> = {}): TerminalNodeData =>
  ({ kind: 'terminal', id, name, preset: 'Claude Code', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, cwd: '/x', ...over }) as TerminalNodeData
const browser = (id: string, url: string, title: string): BrowserNodeData =>
  ({ kind: 'browser', id, name: title, url, tabs: [{ id: `${id}:t`, url, title }], activeTabId: `${id}:t`, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }) as BrowserNodeData
const note = (id: string, name: string, content: string): NoteNodeData =>
  ({ kind: 'note', id, name, customName: name, content, locked: false, position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }) as NoteNodeData
const cable = (id: string, a: string, b: string): Connection => ({ id, a, b })
const row = (id: string, phase: AgentRow['phase'], over: Partial<AgentRow> = {}): AgentRow =>
  ({ id, name: id, preset: 'Claude Code', role: null, orch: false, active: true, workspaceId: 'w1', workspaceName: 'Dev', cwd: '/x', spawnedAt: 0, phase, turn: null, turnCount: 0, lastActivityAt: 0, ...over }) as AgentRow
const ws = (id: string, name: string): WorkspaceMeta => ({ id, name, dir: `/w/${id}`, dirs: [], icon: '🗂' }) as WorkspaceMeta

function fixture(nodes: CanvasNode[], connections: Connection[], rows: AgentRow[] = []) {
  return buildZoomModel({
    nodes,
    connections,
    rows,
    crew: crewOf(nodes, rows, { id: 'w1', name: 'Dev' }),
    attachIndex: attachmentIndex(nodes, connections),
    workspaces: [ws('w1', 'Dev'), ws('w2', 'Home')],
    activeId: 'w1',
    name: 'Dev'
  })
}

describe('the crew', () => {
  it('takes the workspace’s terminals, orchestrators first, with their phase word and latest line', () => {
    const m = fixture(
      [term('t1', 'Forge'), term('t2', 'Conductor', { orch: true } as Partial<TerminalNodeData>)],
      [],
      [row('t1', 'waiting', { turn: { title: 'push?', ask: 'push it', tools: [], latest: { text: 'push feat to origin?', tone: 'waiting' }, pendingInput: null, tail: null } as AgentRow['turn'] }), row('t2', 'working')]
    )
    expect(m.agents.map((a) => a.id)).toEqual(['t2', 't1'])
    expect(m.agents[0]).toMatchObject({ orch: true, word: PHASE_WORD.working, line: 'Nothing said yet.' })
    expect(m.agents[1]).toMatchObject({ word: 'needs you', line: 'push feat to origin?' })
    expect(m.frame.agents.map((a) => a.waiting)).toEqual([false, true])
  })

  it('falls back through title, ask and brief for its line', () => {
    expect(lineOf(undefined, 'a brief')).toBe('a brief')
    expect(lineOf({ turn: { title: 'T' } } as AgentRow, null)).toBe('T')
    expect(lineOf({ turn: { ask: 'A' } } as AgentRow, null)).toBe('A')
    expect(lineOf({ turn: null } as AgentRow, null)).toBe('Nothing said yet.')
  })
})

describe('what the agents carry', () => {
  it('links an agent to each browser and note it is wired to, with the items’ owners and shares', () => {
    const nodes = [term('t1', 'A'), term('t2', 'B'), browser('b1', 'https://github.com/cookrew/x', 'PR 82'), note('n1', 'Plan', '# The plan\nbody')]
    const m = fixture(nodes, [cable('c1', 't1', 'b1'), cable('c2', 't2', 'b1'), cable('c3', 't1', 'n1')])
    expect(m.frame.links.map((l) => `${l.agent}:${l.item}`).sort()).toEqual(['t1:b1', 't1:n1', 't2:b1'])
    const pr = m.items.find((i) => i.id === 'b1')!
    expect(pr).toMatchObject({ kind: 'browser', title: 'PR 82', host: 'github.com/cookrew', owners: ['t1', 't2'] })
    const plan = m.items.find((i) => i.id === 'n1')!
    expect(plan).toMatchObject({ kind: 'note', title: 'Plan', line: 'The plan' })
    expect(m.agents.find((a) => a.id === 't1')).toMatchObject({ browsers: 1, notes: 1 })
    // Owners are listed in the cabling order, so each link can dock in turn.
    expect(m.frame.links.filter((l) => l.item === 'b1').map((l) => l.j)).toEqual([0, 1])
  })

  it('points at the newest browser that somebody carries; loose items are still drawn', () => {
    const nodes = [term('t1', 'A'), browser('old', 'https://a.dev', 'Old'), browser('loose', 'https://c.dev', 'Loose'), browser('new', 'https://b.dev', 'New')]
    const m = fixture(nodes, [cable('c1', 't1', 'old'), cable('c2', 't1', 'new')])
    expect(m.frame.newest).toBe('t1|new')
    expect(m.items.map((i) => i.id)).toContain('loose')
    expect(m.frame.items.find((i) => i.id === 'loose')!.owners).toEqual([])
  })

  it('ties only terminal to terminal: a cable to a browser is ownership, not a tie', () => {
    const nodes = [term('t1', 'A'), term('t2', 'B'), browser('b1', 'https://x.dev', 'X')]
    const m = fixture(nodes, [cable('c1', 't1', 't2'), cable('c2', 't1', 'b1')])
    expect(m.frame.ties.map((t) => t.key)).toEqual(['c1'])
  })
})

describe('the device', () => {
  it('lists the account’s other workspaces as marks with their agents and waiting dot, the open one included', () => {
    const m = fixture([term('t1', 'A')], [], [row('t1', 'waiting'), row('x1', 'working', { workspaceId: 'w2' })])
    expect(m.frame.workspaces).toEqual(['w1', 'w2'])
    expect(m.frame.active).toBe('w1')
    const home = m.marks.find((k) => k.id === 'w2')!
    expect(home).toMatchObject({ name: 'Home', presets: ['Claude Code'], waiting: false })
    expect(m.marks.some((k) => k.id === 'w1')).toBe(false)
    expect(m.browsers + m.notes).toBe(0)
  })

  it('carries the real fleet machines through: counts when all their workspaces are live, null when only listed', () => {
    const m = buildZoomModel({
      nodes: [], connections: [], rows: [], crew: [], attachIndex: new Map(), workspaces: [ws('w1', 'Dev')], activeId: 'w1', name: 'Dev',
      machines: [
        { id: 'me', name: 'MacBook Pro', local: true, online: true, detail: 'live', workspaces: [{ id: 'w1', name: 'Dev', agents: [{ harness: 'claude', phase: 'busy' }], counts: { agents: 3, waiting: 1 } }] },
        { id: 'other', name: 'Mac mini', local: false, online: true, detail: 'listed', workspaces: [{ id: 'z', name: 'Lab', agents: [], counts: null }] }
      ]
    })
    expect(m.machines.map((x) => x.name)).toEqual(['MacBook Pro', 'Mac mini'])
    expect(m.machines[0]).toMatchObject({ agents: 3, waiting: 1 })
    expect(m.machines[1]).toMatchObject({ agents: null, waiting: null })
  })
})

describe('a workspace with hundreds of browsers and notes', () => {
  it('draws a screenful in the thumbs grid, carried ones first, and still counts them all', () => {
    const loose = Array.from({ length: 40 }, (_, n) => browser(`l${n}`, `https://l${n}.dev`, `L${n}`))
    const nodes = [term('t1', 'A'), browser('kept', 'https://k.dev', 'Kept'), ...loose]
    const m = fixture(nodes, [cable('c1', 't1', 'kept')])
    expect(m.items).toHaveLength(ITEMS_SHOWN)
    expect(m.items[0].id).toBe('kept')
    expect(m.browsers).toBe(41)
    expect(m.hiddenItems).toBe(41 - ITEMS_SHOWN)
    expect(m.frame.links.every((l) => m.items.some((i) => i.id === l.item))).toBe(true)
  })
})

// ONE CREW (owner, 2026-11-01): the crew view and the agent group drew two lists
// that disagreed on who was in the crew, how many, and in what state.
describe('the one crew list (agent-rows.ts · crewOf)', () => {
  const nodes: CanvasNode[] = [term('t1', 'Forge'), term('t2', 'Velvet', { orch: true }), term('t3', 'Sol'), browser('b1', 'https://x.dev', 'X')]
  const rows = [row('t1', 'working', { name: 'old-name', unread: true }), row('t2', 'waiting'), row('elsewhere', 'working', { workspaceId: 'w2' })]

  it('is one row per terminal card: the roster row when there is one, a quiet row when not', () => {
    const crew = crewOf(nodes, rows, { id: 'w1', name: 'Dev' })
    expect(crew.map((r) => [r.id, r.phase])).toEqual([['t1', 'working'], ['t2', 'waiting'], ['t3', 'quiet']])
    // The card's name wins, and a quiet row belongs to this workspace.
    expect(crew[0].name).toBe('Forge')
    expect(crew[2].workspaceId).toBe('w1')
  })

  it('is what the crew view draws: the same agents in the same states', () => {
    const crew = crewOf(nodes, rows, { id: 'w1', name: 'Dev' })
    const m = buildZoomModel({ nodes, connections: [], rows, crew, attachIndex: attachmentIndex(nodes, []), workspaces: [ws('w1', 'Dev')], activeId: 'w1', name: 'Dev' })
    const byId = new Map(m.agents.map((a) => [a.id, a]))
    expect(m.agents).toHaveLength(crew.length)
    for (const r of crew) {
      expect(byId.get(r.id)?.phase).toBe(r.phase)
      expect(byId.get(r.id)?.unread).toBe(r.unread === true)
    }
  })
})
