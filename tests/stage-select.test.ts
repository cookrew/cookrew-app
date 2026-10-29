// THE STAGE'S COLUMNS (2026-10-30): browsers and notes left, agents right,
// each filtering the other through the canvas wiring.
import { describe, expect, it } from 'vitest'
import type { AgentRow } from '../src/renderer/src/agent-rows'
import type { AttachmentIndex, TerminalAttachment } from '../src/renderer/src/terminal-attachments'
import { firstLine, hostPath, ownersOf, stageColumns, stageSelect, type StageItemCard } from '../src/renderer/src/stage/stage-select'

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
  it('show everything while nothing is picked', () => {
    const c = stageColumns({ kind: 'auto' }, items, agents, index)
    expect([c.items.length, c.agents.length, c.itemsFor, c.agentsFor]).toEqual([3, 3, null, null])
  })

  it('an agent picked: the left shows its items, newest wire first; the right keeps everyone', () => {
    const c = stageColumns({ kind: 'agent', id: 'a' }, items, agents, index)
    expect(c.items.map((i) => i.id)).toEqual(['n2', 'n1'])
    expect(c.agents).toHaveLength(3)
    expect(c.itemsFor).toBe('a')
  })

  it('an agent with nothing wired shows an empty left, still filtered', () => {
    const c = stageColumns({ kind: 'agent', id: 'c' }, items, agents, index)
    expect([c.items.length, c.itemsFor]).toEqual([0, 'c'])
  })

  it('an item picked: the right shows its agents; the left keeps everything', () => {
    const c = stageColumns({ kind: 'item', id: 'n1' }, items, agents, index)
    expect(c.agents.map((a) => a.id)).toEqual(['a', 'b'])
    expect(c.items).toHaveLength(3)
    expect(c.agentsFor).toBe('n1')
  })

  it('a pick whose card is gone filters nothing', () => {
    expect(stageColumns({ kind: 'item', id: 'gone' }, items, agents, index).agentsFor).toBeNull()
    expect(stageColumns({ kind: 'agent', id: 'gone' }, items, agents, index).itemsFor).toBeNull()
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
