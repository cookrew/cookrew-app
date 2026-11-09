import { describe, expect, it } from 'vitest'
import type { BoardPhase, BoardRow } from '../src/shared/board'
import { rowsOfWorkspace, watchWorkspaces } from '../src/main/watch-cards'

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
      { id: 'dev', name: 'Cookrew Dev', active: false, agents: 4, waiting: 1, working: 1, done: 0 },
      { id: 'goat', name: 'GOAT Team', active: true, agents: 3, waiting: 1, working: 0, done: 1 },
      { id: 'empty', name: 'Playground', active: false, agents: 0, waiting: 0, working: 0, done: 0 }
    ])
  })

  it('never says fewer agents than it has rows for, and a closed agent waits on nobody', () => {
    const [dev] = watchWorkspaces({ workspaces: spaces, activeId: 'dev', rows: ROWS, agentsIn: () => 0, active: (id) => id !== 'a' })
    expect(dev).toMatchObject({ agents: 2, waiting: 0, working: 1 })
  })

  it('a row whose workspace the Mac no longer lists still gets a tile', () => {
    const lost = watchWorkspaces({ workspaces: [], activeId: 'dev', rows: [row('x', 'waiting', 'gone')], agentsIn: () => 0, active: () => true })
    expect(lost).toEqual([{ id: 'gone', name: 'GONE', active: false, agents: 1, waiting: 1, working: 0, done: 0 }])
  })
})

describe('one workspace’s cards', () => {
  it('are its rows and no others, and no workspace asked means all', () => {
    expect(rowsOfWorkspace(ROWS, 'goat').map((r) => r.terminalId)).toEqual(['c', 'd', 'e'])
    expect(rowsOfWorkspace(ROWS, null)).toHaveLength(5)
    expect(rowsOfWorkspace(ROWS, 'nowhere')).toEqual([])
  })
})
