// THE BOARD SEARCHES BROWSERS AND NOTES (owner 2026-11-01): by name, page
// title, site, any tab's address and a note's body, every term AND, a name
// hit above a mention in a body; and the row says why it matched.
import { describe, expect, it } from 'vitest'
import { itemCorpus, searchItems } from '../src/renderer/src/item-search'
import type { CanvasNode } from '../src/shared/model'

const at = { position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }
const note = (id: string, name: string, content: string): CanvasNode => ({ kind: 'note', id, name, customName: null, content, locked: false, ...at })
const browser = (id: string, name: string, tabs: { url: string; title: string }[], active = 0): CanvasNode => ({
  kind: 'browser',
  id,
  name,
  url: tabs[active].url,
  tabs: tabs.map((t, i) => ({ id: `${id}-t${i}`, ...t })),
  activeTabId: `${id}-t${active}`,
  ...at,
})
const agent: CanvasNode = { kind: 'terminal', id: 'a1', name: 'Fresco', ...at } as CanvasNode

const nodes: CanvasNode[] = [
  note('n1', 'release-plan', 'Ship 0.3.0 on Friday.\n\nThe zoom view needs one more pass from Fresco before the release.'),
  note('n2', 'fresco', 'Design notes for the ink theme.'),
  browser('b1', 'Docs', [{ url: 'https://github.com/cookrew/app/pulls', title: 'Pull requests' }]),
  browser('b2', 'Research', [
    { url: 'https://example.com/a', title: 'Example' },
    { url: 'https://www.figma.com/file/zoom-pivot', title: 'Zoom pivot — Figma' },
  ]),
  agent,
]
const corpus = itemCorpus(nodes)
const ids = (q: string): string[] => searchItems(corpus, q).map((h) => h.node.id)

describe('what the board finds', () => {
  it('holds browsers and notes, never agents', () => {
    expect(corpus.map((c) => c.node.id)).toEqual(['n1', 'n2', 'b1', 'b2'])
  })

  it("finds a note by a line of its body, and a name hit outranks it", () => {
    expect(ids('fresco')).toEqual(['n2', 'n1'])
  })

  it('finds a browser by its page title, its site and its address', () => {
    expect(ids('pull requests')).toEqual(['b1'])
    expect(ids('github')).toEqual(['b1'])
    expect(ids('cookrew/app')).toEqual(['b1'])
  })

  it('looks through every tab, not only the one showing', () => {
    expect(ids('figma')).toEqual(['b2'])
  })

  it('needs every term somewhere, in any field', () => {
    expect(ids('release friday')).toEqual(['n1'])
    expect(ids('release monday')).toEqual([])
  })

  it('ignores case', () => {
    expect(ids('FIGMA')).toEqual(['b2'])
  })
})

describe('why a row is in the results', () => {
  const hit = (q: string, id: string) => searchItems(corpus, q).find((h) => h.node.id === id)

  it("shows a note's passage around the word, the word marked as it is written", () => {
    const s = hit('fresco', 'n1')?.snippet
    expect(s?.hit).toBe('Fresco')
    expect(s?.pre.startsWith('…')).toBe(true)
    expect(s?.post).toContain('before the release')
    expect(`${s?.pre}${s?.hit}${s?.post}`).not.toContain('\n')
  })

  it('says nothing more when the name matched: the row already shows it', () => {
    expect(hit('fresco', 'n2')?.snippet).toBeNull()
  })

  it("says nothing more for the showing tab, and names another tab's page", () => {
    expect(hit('github', 'b1')?.snippet).toBeNull()
    const s = hit('figma', 'b2')?.snippet
    expect(s?.hit.toLowerCase()).toBe('figma')
    expect(`${s?.pre}${s?.hit}${s?.post}`).toContain('figma.com/file/zoom-pivot')
  })
})
