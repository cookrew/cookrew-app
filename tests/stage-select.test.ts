// THE STAGE'S COLUMNS (2026-10-30): browsers and notes left, agents right,
// each filtering the other through the canvas wiring.
import { describe, expect, it } from 'vitest'
import type { AgentRow } from '../src/renderer/src/agent-rows'
import type { AttachmentIndex, TerminalAttachment } from '../src/renderer/src/terminal-attachments'
import { agentLinks, firstLine, hostPath, ownersOf, stageColumns, stageLevel, stageSelect, type StageItemCard } from '../src/renderer/src/stage/stage-select'

const row = (id: string): AgentRow => ({
  id, name: id.toUpperCase(), preset: 'claude', role: null, orch: false, active: true, workspaceId: 'w', workspaceName: 'W',
  cwd: '/', spawnedAt: 0, phase: 'done', turn: null, turnCount: 0, lastActivityAt: 0
})
const att = (id: string): TerminalAttachment => ({ kind: 'note', node: { id, kind: 'note', name: id } as never })
const index: AttachmentIndex = new Map([
  ['a', [att('n2'), att('n1')]],
  ['b', [att('n1')]]
])
const owners = ownersOf(index)
const card = (id: string): StageItemCard => ({ id, kind: 'note', title: id, sub: '', owners: owners.get(id) ?? [], attachment: att(id) })
const items = [card('n3'), card('n2'), card('n1')]
const agents = [row('a'), row('b'), row('c')]

describe('the wiring read both ways', () => {
  it('lists every agent wired to an item', () => {
    expect(owners.get('n1')).toEqual(['a', 'b'])
    expect(owners.get('n2')).toEqual(['a'])
    expect(owners.get('n3')).toBeUndefined()
  })
})

describe('the columns', () => {
  it('the workspace level shows everything', () => {
    const c = stageColumns({ kind: 'auto' }, items, agents, index)
    expect([c.items.length, c.agents.length, c.focus]).toEqual([3, 3, null])
  })

  it('an agent zoomed in: its items, newest wire first; itself and the agents sharing a card with it', () => {
    const c = stageColumns({ kind: 'agent', id: 'a' }, items, agents, index)
    expect(c.items.map((i) => i.id)).toEqual(['n2', 'n1'])
    expect(c.agents.map((r) => r.id)).toEqual(['a', 'b'])
    expect(c.focus).toEqual({ kind: 'agent', id: 'a' })
  })

  it('an agent cabled to another keeps it, with no card between them', () => {
    const links = agentLinks([{ a: 'c', b: 'b' }, { a: 'c', b: 'n1' }], new Set(['a', 'b', 'c']))
    expect(stageColumns({ kind: 'agent', id: 'c' }, items, agents, index, links).agents.map((r) => r.id)).toEqual(['b', 'c'])
    expect(stageColumns({ kind: 'agent', id: 'c' }, items, agents, index, links).items).toEqual([])
  })

  it('an item zoomed in: itself on the left, its agents on the right', () => {
    const c = stageColumns({ kind: 'item', id: 'n1' }, items, agents, index)
    expect(c.items.map((i) => i.id)).toEqual(['n1'])
    expect(c.agents.map((a) => a.id)).toEqual(['a', 'b'])
    expect(c.focus).toEqual({ kind: 'item', id: 'n1' })
  })

  it('a pick whose card is gone filters nothing', () => {
    expect(stageColumns({ kind: 'item', id: 'gone' }, items, agents, index).focus).toBeNull()
    expect(stageColumns({ kind: 'agent', id: 'gone' }, items, agents, index).focus).toBeNull()
  })
})

describe('the levels', () => {
  it('a pick lands on the workspace level, wherever the stage was', () => {
    stageLevel.set('devices')
    stageSelect.set({ kind: 'agent', id: 'zz' })
    expect(stageLevel.get()).toBe('workspace')
    stageSelect.clear()
  })
})

describe('the selection store', () => {
  it('tells its readers only when the pick changes, and clears back to auto', () => {
    let told = 0
    const off = stageSelect.subscribe(() => (told += 1))
    stageSelect.set({ kind: 'agent', id: 'a' })
    stageSelect.set({ kind: 'agent', id: 'a' })
    stageSelect.set({ kind: 'item', id: 'a' })
    stageSelect.clear()
    stageSelect.clear()
    off()
    expect(told).toBe(3)
    expect(stageSelect.get()).toEqual({ kind: 'auto' })
  })
})

describe('what a card says', () => {
  it('a note by its first real line', () => {
    expect(firstLine('\n# Welcome to **Cookrew**\nmore')).toBe('Welcome to Cookrew')
    expect(firstLine('   \n')).toBe('')
  })
  it('a browser by host and path, never the query', () => {
    expect(hostPath('https://example.com/a/b?q=1#f')).toBe('example.com/a/b')
    expect(hostPath('https://example.com/')).toBe('example.com')
    expect(hostPath('not a url')).toBe('not a url')
  })
})
