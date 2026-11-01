// THE BOARD, AS A SEARCH BOX (owner 2026-11-01): the board is no longer a view
// behind ⋯ but the box left of it. `/` reaches it from anywhere that is not
// already text; ⋯ no longer lists the board; the board, hanging under the box,
// draws no field of its own.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { isBoardKey } from '../src/renderer/src/BoardSearch'

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods
})
const inside = (selector: string | null) => ({
  closest: (sel: string): object | null => (selector !== null && sel.split(',').map((s) => s.trim()).includes(selector) ? {} : null)
})

describe('the / key', () => {
  it('opens the board from the page', () => {
    expect(isBoardKey(key('/'), inside(null) as unknown as EventTarget)).toBe(true)
    expect(isBoardKey(key('/'), null)).toBe(true)
  })

  it('is a character in a field, a terminal or a note', () => {
    for (const where of ['input', 'textarea', '[contenteditable="true"]', '.xterm']) {
      expect(isBoardKey(key('/'), inside(where) as unknown as EventTarget)).toBe(false)
    }
  })

  it('leaves chords and other keys alone', () => {
    expect(isBoardKey(key('/', { metaKey: true }), null)).toBe(false)
    expect(isBoardKey(key('/', { ctrlKey: true }), null)).toBe(false)
    expect(isBoardKey(key('/', { altKey: true }), null)).toBe(false)
    expect(isBoardKey(key('k'), null)).toBe(false)
  })
})

describe('where the board lives', () => {
  const src = (f: string): string => readFileSync(`src/renderer/src/${f}`, 'utf8')

  it('is not a row in ⋯ any more, deprecated or otherwise', () => {
    const more = src('HeaderMore.tsx')
    expect(more).not.toMatch(/label: 'Board'/)
    expect(more).not.toMatch(/deprecated/)
  })

  it('is not a view the stage gives way to', () => {
    expect(src('Header.tsx')).toMatch(/export type MainView = 'stage'\n/)
    expect(src('App.tsx')).not.toMatch(/view === 'agents'/)
  })

  it('hangs over the pets and under the sheets', () => {
    const css = readFileSync('src/renderer/src/header.css', 'utf8')
    const z = Number(/\.cr-board-pop \{[^}]*z-index: (\d+)/.exec(css)?.[1])
    expect(z).toBeGreaterThan(55)
    expect(z).toBeLessThan(60)
  })

  it("draws no field of its own under the box: the box's query drives it", () => {
    const roster = src('RosterPanel.tsx')
    expect(roster).toMatch(/\{popover \? \(/)
    expect(src('BoardSearch.tsx')).toMatch(/query=\{query\}\s+onQueryChange=\{setQuery\}\s+variant="popover"/)
  })

  it("keeps the zoom's Esc off the box and the board", () => {
    expect(src('zoom/ZoomView.tsx')).toMatch(/\.cr-board-search, \.cr-board-pop/)
  })
})
