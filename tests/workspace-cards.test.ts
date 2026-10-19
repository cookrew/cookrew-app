import { describe, expect, it } from 'vitest'
import { EMPTY_CARDS, equipmentOf, workspaceCards } from '../src/shared/workspace-cards'
import type { CanvasNode, WorkspaceState } from '../src/shared/model'

/**
 * A workspace's cards as a scene can use them, read for ANY workspace without
 * switching to it. Names and shapes only: the thing a chip shows and the place
 * a card stands, never a note's body or a browser's address.
 */

const terminal = (id: string): CanvasNode =>
  ({
    kind: 'terminal',
    id,
    name: id,
    preset: 'Claude Code',
    command: '',
    cwd: '~',
    orch: false,
    role: null,
    claudeSessionId: 'secret-session',
    position: { x: 0, y: 0 },
    size: { width: 320, height: 220 }
  }) as CanvasNode

const note = (id: string, customName: string | null): CanvasNode =>
  ({
    kind: 'note',
    id,
    name: 'Untitled',
    customName,
    content: '# ANTHROPIC_API_KEY=sk-nope',
    locked: false,
    position: { x: 400, y: 0 },
    size: { width: 260, height: 180 }
  }) as CanvasNode

const browser = (id: string): CanvasNode =>
  ({
    kind: 'browser',
    id,
    name: 'Docs',
    url: 'https://example.com/private?token=abc',
    position: { x: 800, y: 0 },
    size: { width: 480, height: 320 }
  }) as CanvasNode

const state = (nodes: CanvasNode[], connections: Array<{ id: string; a: string; b: string }> = []): WorkspaceState =>
  ({ name: 'W', dir: '/w', dirs: ['/w'], nodes, connections }) as WorkspaceState

describe('the cards of a workspace', () => {
  it('keeps names and shapes and nothing else', () => {
    const out = workspaceCards('w', state([terminal('t'), note('n', 'Spec'), browser('b')]))
    expect(out.cards).toEqual([
      { id: 't', kind: 'terminal', name: 't', x: 0, y: 0, w: 320, h: 220 },
      { id: 'n', kind: 'note', name: 'Spec', x: 400, y: 0, w: 260, h: 180 },
      { id: 'b', kind: 'browser', name: 'Docs', x: 800, y: 0, w: 480, h: 320 }
    ])
    const text = JSON.stringify(out)
    expect(text).not.toContain('sk-nope')
    expect(text).not.toContain('example.com')
    expect(text).not.toContain('secret-session')
  })

  it("shows a note by its custom name, else the canvas name", () => {
    const out = workspaceCards('w', state([note('n1', 'Plan'), note('n2', null), note('n3', '  ')]))
    expect(out.cards.map((c) => c.name)).toEqual(['Plan', 'Untitled', 'Untitled'])
  })

  it('drops a link whose far end is not on this canvas', () => {
    // Cross-workspace edges are mirrored into both workspaces; here the far
    // card is somewhere else and the link would point at nothing.
    const out = workspaceCards(
      'w',
      state([terminal('t'), note('n', null)], [
        { id: 'c1', a: 't', b: 'n' },
        { id: 'c2', a: 't', b: 'elsewhere' }
      ])
    )
    expect(out.links).toEqual([{ a: 't', b: 'n' }])
  })

  it('is EMPTY_CARDS with the id for a workspace with nothing on it', () => {
    expect(workspaceCards('w', null)).toEqual({ ...EMPTY_CARDS, id: 'w' })
    expect(workspaceCards('w', state([]))).toEqual({ ...EMPTY_CARDS, id: 'w' })
  })
})

describe('an agent and its equipment', () => {
  it('gives each note and browser to the first agent wired to it', () => {
    const out = workspaceCards(
      'w',
      state([terminal('t1'), terminal('t2'), note('n', 'Spec'), browser('b')], [
        { id: 'c1', a: 'n', b: 't1' },
        { id: 'c2', a: 't2', b: 'n' },
        { id: 'c3', a: 't2', b: 'b' },
        { id: 'c4', a: 't1', b: 't2' }
      ])
    )
    const kit = equipmentOf(out)
    expect(kit.get('t1')?.map((c) => c.id)).toEqual(['n'])
    expect(kit.get('t2')?.map((c) => c.id)).toEqual(['b'])
  })

  it('leaves a card wired only to other cards on its own', () => {
    const out = workspaceCards('w', state([note('n', null), browser('b')], [{ id: 'c', a: 'n', b: 'b' }]))
    expect(equipmentOf(out).size).toBe(0)
  })
})
