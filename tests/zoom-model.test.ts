// THE ZOOM'S MODEL, from the app's real rows, nodes and cables
// (renderer zoom/zoom-model.ts): who the workspace's agents are, which
// browsers and notes they carry through the wiring, which are shared, and the
// newest browser that stands beside the stack at group zoom. Pure, so pinned here.
import { describe, expect, it } from 'vitest'
import { buildZoomModel, COINS_PER_AGENT, ITEMS_SHOWN, itemViewOf, lineOf } from '../src/renderer/src/zoom/zoom-model'
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
    expect(m.agents[0]).toMatchObject({ orch: true, word: 'working', line: 'Nothing said yet.' })
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
  it("gives each other workspace its feed's totals, so its browsers can open it", () => {
    const m = buildZoomModel({
      nodes: [], connections: [], rows: [], crew: [], attachIndex: attachmentIndex([], []),
      workspaces: [ws('w1', 'Dev'), ws('w2', 'Home')], activeId: 'w1', name: 'Dev',
      counts: new Map([['w2', { browsers: 4, notes: 1 }]])
    })
    expect(m.marks.find((k) => k.id === 'w2')).toMatchObject({ browsers: 4, notes: 1 })
  })

  it('lists the account’s other workspaces as marks with their agents and waiting dot, the open one included', () => {
    const m = fixture([term('t1', 'A')], [], [row('t1', 'waiting'), row('x1', 'working', { workspaceId: 'w2' })])
    expect(m.frame.workspaces).toEqual(['w1', 'w2'])
    expect(m.frame.active).toBe('w1')
    const home = m.marks.find((k) => k.id === 'w2')!
    expect(home).toMatchObject({ name: 'Home', presets: ['Claude Code'], waiting: false })
    // No feed counts: none are made up.
    expect(home).toMatchObject({ browsers: null, notes: null })
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
  // The grid scrolls (owner, 2026-11-02): it holds every one, not a screenful of twelve.
  it('holds them all in the thumbs grid, carried ones first', () => {
    const loose = Array.from({ length: 40 }, (_, n) => browser(`l${n}`, `https://l${n}.dev`, `L${n}`))
    const nodes = [term('t1', 'A'), browser('kept', 'https://k.dev', 'Kept'), ...loose]
    const m = fixture(nodes, [cable('c1', 't1', 'kept')])
    expect(m.items).toHaveLength(41)
    expect(m.items[0].id).toBe('kept')
    expect(m.browsers).toBe(41)
    expect(m.hiddenItems).toBe(0)
  })
})

// EVERY AGENT WEARS ITS OWN COINS (owner, 2026-11-01): the coins used to be
// the thumbs grid's 12 newest items, so an agent whose browsers and notes were
// all older than the workspace's 12 newest wore none (Forge 9+18, Tinker 3+14).
describe('every agent wears its own coins, not the grid’s twelve', () => {
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => browser(`${prefix}${i}`, `https://${prefix}${i}.dev`, `${prefix}${i}`))

  it('an agent whose items are all older than the grid holds still wears its newest wires', () => {
    const old = many('old', 6)
    const fresh = many('new', ITEMS_SHOWN)
    // Forge's six are made first; Velvet's twenty fill the grid.
    const nodes: CanvasNode[] = [term('forge', 'Forge'), term('velvet', 'Velvet'), ...old, ...fresh]
    const cables = [...old.map((b, i) => cable(`co${i}`, 'forge', b.id)), ...fresh.map((b, i) => cable(`cn${i}`, 'velvet', b.id))]
    const m = fixture(nodes, cables)
    expect(m.items).toHaveLength(ITEMS_SHOWN)
    expect(m.items.some((i) => i.id.startsWith('old'))).toBe(false)
    const forge = m.frame.links.filter((l) => l.agent === 'forge')
    // Its newest wires first (old5 was cabled last), seats 0..3 in that order.
    expect(forge.map((l) => [l.item, l.k])).toEqual([['old5', 0], ['old4', 1], ['old3', 2], ['old2', 3]])
    // The coins outside the grid are drawn from their own views.
    // Velvet's newest four are in the grid already: only Forge's need their own faces.
    const last = ITEMS_SHOWN - 1
    expect(m.frame.links.filter((l) => l.agent === 'velvet').map((l) => l.item)).toEqual([0, 1, 2, 3].map((k) => `new${last - k}`))
    expect(m.coinItems.map((i) => i.id)).toEqual(['old5', 'old4', 'old3', 'old2'])
    expect(m.coinItems.find((i) => i.id === 'old5')).toMatchObject({ kind: 'browser', title: 'old5', owners: ['forge'] })
  })

  it('wears at most COINS_PER_AGENT, numbered from 0 over the ones it wears', () => {
    const items = many('b', 9)
    const nodes: CanvasNode[] = [term('t1', 'A'), ...items]
    const m = fixture(nodes, items.map((b, i) => cable(`c${i}`, 't1', b.id)))
    const mine = m.frame.links.filter((l) => l.agent === 't1')
    expect(mine).toHaveLength(COINS_PER_AGENT)
    expect(mine.map((l) => l.k)).toEqual([0, 1, 2, 3])
  })

  it('a coin item in the grid is not drawn twice', () => {
    const nodes: CanvasNode[] = [term('t1', 'A'), browser('b1', 'https://x.dev', 'X')]
    const m = fixture(nodes, [cable('c1', 't1', 'b1')])
    expect(m.items.map((i) => i.id)).toEqual(['b1'])
    expect(m.coinItems).toEqual([])
  })

  it('the newest browser points at a coin that is worn', () => {
    const items = many('b', 6)
    // Made last, but wired first: it is the agent's oldest wire, past its four seats.
    const nodes: CanvasNode[] = [term('t1', 'A'), ...items, browser('top', 'https://top.dev', 'Top')]
    const m = fixture(nodes, [cable('c0', 't1', 'top'), ...items.map((b, i) => cable(`c${i + 1}`, 't1', b.id))])
    const keys = new Set(m.frame.links.map((l) => l.key))
    expect(m.frame.newest === null || keys.has(m.frame.newest)).toBe(true)
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

describe('the cost of a rebuild (a workspace holds hundreds of browsers and notes)', () => {
  /** A browser whose tabs and a note whose text count every read. */
  const counted = (n: CanvasNode, reads: { n: number }): CanvasNode => {
    const key = n.kind === 'browser' ? 'tabs' : 'content'
    const value = (n as unknown as Record<string, unknown>)[key]
    return Object.defineProperty({ ...n }, key, { get: () => (reads.n++, value), enumerable: true }) as CanvasNode
  }

  it('reads a URL or a note text only for the items the grid holds, and counts the rest', () => {
    const reads = { n: 0 }
    const half = ITEMS_SHOWN / 2 + 150
    const nodes: CanvasNode[] = [term('t1', 'Forge')]
    for (let i = 0; i < half; i++) nodes.push(counted(browser(`b${i}`, `https://x.dev/${i}`, `Page ${i}`), reads))
    for (let i = 0; i < half; i++) nodes.push(counted(note(`n${i}`, `Note ${i}`, `# Note ${i}\nbody`), reads))
    const m = fixture(nodes, [cable('c1', 't1', 'b3')])
    expect(m.items).toHaveLength(ITEMS_SHOWN)
    expect(m.items[0].id).toBe('b3') // the carried one first
    expect(m.browsers).toBe(half)
    expect(m.notes).toBe(half)
    expect(m.hiddenItems).toBe(half * 2 - ITEMS_SHOWN)
    expect(reads.n).toBeLessThanOrEqual(ITEMS_SHOWN * 2)
  })

  it('a rebuild over the same nodes reads nothing again', () => {
    const reads = { n: 0 }
    const nodes: CanvasNode[] = [term('t1', 'Forge'), counted(browser('b1', 'https://x.dev/a', 'A'), reads), counted(note('n1', 'N', 'x'), reads)]
    fixture(nodes, [])
    const first = reads.n
    fixture(nodes, [])
    expect(reads.n).toBe(first)
  })

  it('a note says its first line worth reading, past blank lines and heading marks', () => {
    expect(itemViewOf(note('n', 'N', '\n  \n## Plan for today \nmore'), [])?.line).toBe('Plan for today')
    expect(itemViewOf(note('n', 'N', ''), [])?.line).toBe('')
    expect(itemViewOf(note('n', 'N', '#\n\n'), [])?.line).toBe('')
  })
})

