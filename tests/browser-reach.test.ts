// Which browser card a name means, for a caller in ANY workspace.
//
// Owner ruling 2026-11-04: every workspace works on its own; switching what
// the window shows must never stop, refuse or lose anything elsewhere. The
// browser engine is node-owned headless Chrome held by main, so the card a
// name means is a fact about the CALLER, never about focus.
import { describe, expect, it } from 'vitest'
import { browserByName } from '../src/main/browser-reach'
import type { BrowserNodeData, CanvasNode } from '../src/shared/model'

const card = (id: string, name: string): BrowserNodeData => ({
  kind: 'browser', id, name, url: 'https://example.test',
  position: { x: 0, y: 0 }, size: { width: 720, height: 560 }
})

function canvases(map: Record<string, CanvasNode[]>): (id: string) => readonly CanvasNode[] {
  return (id) => map[id] ?? []
}

describe('browserByName', () => {
  it('finds a card of the caller\'s own workspace while another one is shown', () => {
    const shots = card('b1', 'Solis-Shots')
    const hit = browserByName({
      name: 'solis-shots',
      callerWorkspaceId: 'goat',
      focusedId: 'cookrew',
      nodesOf: canvases({ goat: [shots], cookrew: [] }),
      wired: () => []
    })
    expect(hit).toEqual({ node: shots, workspaceId: 'goat' })
  })

  it('own canvas beats a same-named card on the shown canvas', () => {
    const mine = card('b-mine', 'Browser')
    const shown = card('b-shown', 'Browser')
    const hit = browserByName({
      name: 'Browser',
      callerWorkspaceId: 'goat',
      focusedId: 'cookrew',
      nodesOf: canvases({ goat: [mine], cookrew: [shown] }),
      wired: () => []
    })
    expect(hit?.node.id).toBe('b-mine')
  })

  it('reaches a card it is wired to in another workspace', () => {
    const far = card('b-far', 'Docs')
    const hit = browserByName({
      name: 'Docs',
      callerWorkspaceId: 'goat',
      focusedId: 'goat',
      nodesOf: canvases({ goat: [] }),
      wired: () => [{ node: far, workspaceId: 'portfolio' }]
    })
    expect(hit).toEqual({ node: far, workspaceId: 'portfolio' })
  })

  it('a caller no workspace holds (registry-only) still reaches the shown canvas', () => {
    const shown = card('b1', 'Docs')
    const hit = browserByName({
      name: 'Docs',
      callerWorkspaceId: undefined,
      focusedId: 'cookrew',
      nodesOf: canvases({ cookrew: [shown] }),
      wired: () => []
    })
    expect(hit).toEqual({ node: shown, workspaceId: 'cookrew' })
  })

  it('ignores cards of another kind and answers null on a miss', () => {
    const note = { ...card('n1', 'Docs'), kind: 'note' } as unknown as CanvasNode
    expect(
      browserByName({
        name: 'Docs',
        callerWorkspaceId: 'goat',
        focusedId: 'goat',
        nodesOf: canvases({ goat: [note] }),
        wired: () => [{ node: note, workspaceId: 'goat' }]
      })
    ).toBeNull()
  })

  it('refuses a name two wired cards share instead of picking by store order', () => {
    // Review finding: with "Docs" wired in two workspaces the pick followed
    // which workspace was resident, so one `fill` could land on either page.
    expect(() =>
      browserByName({
        name: 'Docs',
        callerWorkspaceId: 'goat',
        focusedId: 'goat',
        nodesOf: canvases({ goat: [] }),
        wired: () => [
          { node: card('in-b', 'Docs'), workspaceId: 'b' },
          { node: card('in-c', 'Docs'), workspaceId: 'c' }
        ]
      })
    ).toThrow(/more than one browser named "Docs".*\bb\b.*\bc\b|more than one browser named "Docs"/)
  })

  it('a served caller reaches only what it is wired to — never its canvas or the screen', () => {
    const mine = card('b-mine', 'Docs')
    const input = {
      name: 'Docs',
      callerWorkspaceId: 'sandbox',
      focusedId: 'sandbox',
      nodesOf: canvases({ sandbox: [mine] }),
      served: true
    }
    expect(browserByName({ ...input, wired: () => [] })).toBeNull()
    expect(browserByName({ ...input, wired: () => [{ node: mine, workspaceId: 'sandbox' }] })?.node.id).toBe('b-mine')
  })

  it('does not walk the cables when the caller\'s own canvas answers', () => {
    const wired = () => {
      throw new Error('walked')
    }
    expect(
      browserByName({ name: 'Docs', callerWorkspaceId: 'goat', focusedId: 'x', nodesOf: canvases({ goat: [card('b', 'Docs')] }), wired })
    ).not.toBeNull()
  })
})

describe('keptBrowsers — what a switch must not stop', () => {
  it('keeps resident cards plus recently-used running pages that still exist, once each', async () => {
    const { keptBrowsers } = await import('../src/main/browser-reach')
    const a = card('a', 'A')
    const far = card('far', 'Far')
    const kept = keptBrowsers({
      resident: [a],
      recentlyUsed: ['a', 'far', 'deleted'],
      nodeOf: (id) => (id === 'far' ? far : id === 'a' ? a : null)
    })
    expect(kept.map((n) => n.id)).toEqual(['a', 'far'])
  })
})
