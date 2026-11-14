import { describe, expect, it } from 'vitest'
import type { BoardPhase, BoardRow } from '../src/shared/board'
import type { CanvasNode } from '../src/shared/model'
import { CARD_ITEMS, cardRows, crewRows, rowsOfWorkspace, watchCards, watchWorkspaces, MAX_CARDS } from '../src/main/watch-cards'

const row = (id: string, phase: BoardPhase, workspace: string): BoardRow =>
  ({
    terminalId: id,
    agent: { name: id, preset: 'Claude Code', role: null, orch: false },
    workspace: { id: workspace, name: workspace.toUpperCase(), active: workspace === 'dev' },
    cwd: '/tmp',
    task: { title: null, summary: '', turnIndex: 1, startedAt: 0, endedAt: null },
    phase,
    source: 'live',
    lastActivityAt: 1,
    turnCount: 1
  }) as BoardRow

const ROWS = [row('a', 'waiting', 'dev'), row('b', 'working', 'dev'), row('c', 'unread', 'goat'), row('d', 'offline', 'goat'), row('e', 'waiting', 'goat')]

describe('the workspaces a wrist zooms through', () => {
  const spaces = [
    { id: 'dev', name: 'Cookrew Dev' },
    { id: 'goat', name: 'GOAT Team' },
    { id: 'empty', name: 'Playground' }
  ]

  it('lists every workspace in the Mac’s order, the empty ones too, with what needs the owner counted', () => {
    const agents: Record<string, number> = { dev: 4, goat: 3, empty: 0 }
    expect(watchWorkspaces({ workspaces: spaces, activeId: 'goat', rows: ROWS, agentsIn: (id) => agents[id] ?? 0, active: () => true })).toEqual([
      { id: 'dev', name: 'Cookrew Dev', active: false, agents: 4, waiting: 1, working: 1, done: 0, presets: [], artifacts: [] },
      { id: 'goat', name: 'GOAT Team', active: true, agents: 3, waiting: 1, working: 0, done: 1, presets: [], artifacts: [] },
      { id: 'empty', name: 'Playground', active: false, agents: 0, waiting: 0, working: 0, done: 0, presets: [], artifacts: [] }
    ])
  })

  it('never says fewer agents than it has rows for, and a closed agent waits on nobody', () => {
    const [dev] = watchWorkspaces({ workspaces: spaces, activeId: 'dev', rows: ROWS, agentsIn: () => 0, active: (id) => id !== 'a' })
    expect(dev).toMatchObject({ agents: 2, waiting: 0, working: 1 })
  })

  it('a row whose workspace the Mac no longer lists still gets a tile', () => {
    const lost = watchWorkspaces({ workspaces: [], activeId: 'dev', rows: [row('x', 'waiting', 'gone')], agentsIn: () => 0, active: () => true })
    expect(lost).toEqual([{ id: 'gone', name: 'GONE', active: false, agents: 1, waiting: 1, working: 0, done: 0, presets: [], artifacts: [] }])
  })
})

describe('one workspace’s cards', () => {
  it('are its rows and no others, and no workspace asked means all', () => {
    expect(rowsOfWorkspace(ROWS, 'goat').map((r) => r.terminalId)).toEqual(['c', 'd', 'e'])
    expect(rowsOfWorkspace(ROWS, null)).toHaveLength(5)
    expect(rowsOfWorkspace(ROWS, 'nowhere')).toEqual([])
  })
})

const terminal = (id: string, name: string, extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ kind: 'terminal', id, name, preset: 'Codex', command: 'codex', cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, ...extra }) as CanvasNode

describe('one workspace’s crew on a wrist', () => {
  const goat = { id: 'goat', name: 'GOAT Team', active: false }

  it('is every terminal on its canvas, with its board row where there is one and a resting row where there is not', () => {
    const nodes = [terminal('c', 'Renamed C'), { kind: 'note', id: 'n1' } as unknown as CanvasNode, terminal('z', 'Zed', { brief: 'Ship the motion brief' })]
    const crew = crewRows(nodes, rowsOfWorkspace(ROWS, 'goat'), goat)
    expect(crew.map((r) => r.terminalId)).toEqual(['c', 'z'])
    expect(crew[0]).toMatchObject({ phase: 'unread', agent: { name: 'Renamed C', preset: 'Codex' } })
    expect(crew[1]).toMatchObject({ phase: 'done', lastActivityAt: 0, workspace: goat, agent: { name: 'Zed' }, task: { summary: 'Ship the motion brief' } })
  })

  it('a crew is not cut at the day’s card limit', () => {
    const many = Array.from({ length: MAX_CARDS + 15 }, (_, i) => terminal(`t${i}`, `T${i}`))
    const crew = crewRows(many, [], goat)
    expect(cardRows(crew, () => true, crew.length)).toHaveLength(MAX_CARDS + 15)
    expect(cardRows(crew)).toHaveLength(MAX_CARDS)
  })
})

describe('a card’s artifacts on a wrist', () => {
  it('carries every browser and note the agent has, as the phone’s thumbs grid does, up to a wrist’s worth', () => {
    const item = (i: number) => ({ id: `b${i}`, kind: 'browser' as const, title: `Page ${i}`, host: 'example.com', tint: '#6f8a5c', initial: 'P' })
    const cardsOf = (count: number) =>
      watchCards({
        rows: [row('a', 'done', 'dev')],
        activities: new Map(),
        checkpoints: new Map(),
        active: () => true,
        itemsOf: () => ({ items: Array.from({ length: count }, (_, i) => item(i)), browsers: count, notes: 0 })
      })
    expect(cardsOf(7)[0].items).toHaveLength(7)
    expect(cardsOf(CARD_ITEMS + 5)[0].items).toHaveLength(CARD_ITEMS)
  })
})

describe('a crew row the board filed elsewhere', () => {
  it('is found by its terminal, and says the workspace whose canvas it is on', () => {
    // A row with no registry entry is filed under the active workspace (board.ts · mergeBoard).
    const crew = crewRows([terminal('e', 'Echo')], [row('e', 'waiting', 'dev')], { id: 'goat', name: 'GOAT Team', active: false })
    expect(crew[0]).toMatchObject({ phase: 'waiting', workspace: { id: 'goat', name: 'GOAT Team' } })
  })
})
