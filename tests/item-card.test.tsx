// A BROWSER'S OR NOTE'S CARD (owner, 2026-11-01: "browsers&notes card 要带缩略图，
// 和现在实现的 agent card 里面的那种一样"), and the side groups as
// group-motion-pivot.html draws them beside the full view.
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ItemCard, type CrewFace, type ItemFace } from '../src/renderer/src/pets/ItemPets'

const controls = { draft: () => undefined, open: () => undefined, close: () => undefined }
const crew = new Map<string, CrewFace>([
  ['a1', { name: 'Velvet', preset: 'claude', orch: false }],
  ['a2', { name: 'Forge', preset: 'codex', orch: true }]
])
const browser: ItemFace = {
  id: 'b1',
  kind: 'browser',
  title: 'Cookrew docs',
  sub: 'cookrew.dev/docs',
  owners: ['a1', 'a2'],
  view: { id: 'b1', kind: 'browser', title: 'Cookrew docs', host: 'cookrew.dev', tint: '#a8692b', initial: 'C', line: 'https://cookrew.dev/docs', owners: ['a1', 'a2'] }
}
const note: ItemFace = {
  id: 'n1',
  kind: 'note',
  title: 'plan',
  sub: 'Ship the stage',
  owners: [],
  body: '# Plan\nShip the stage\nThen the site',
  view: { id: 'n1', kind: 'note', title: 'plan', host: 'note', tint: '#999', initial: '', line: 'Plan', owners: [] }
}
const card = (item: ItemFace): string => renderToStaticMarkup(<ItemCard item={item} crew={crew} controls={controls} onAgent={() => undefined} />)

describe("a browser's or note's card", () => {
  it('carries the page as a big thumbnail, the one the navigator and the agent card draw', () => {
    const html = card(browser)
    expect(html).toContain('zv-th zv-big item-page browser')
    expect(html).toContain('zv-bar')
    expect(html).toContain('cookrew.dev/docs')
  })

  it('names the agents that use it, each a way to that agent', () => {
    const html = card(browser)
    expect(html).toContain('used by 2')
    expect(html).toContain('title="Open Velvet"')
    expect(html).toContain('title="Open Forge"')
  })

  it('a note: its paper thumbnail and its opening lines; nobody uses it, and it says so', () => {
    const html = card(note)
    expect(html).toContain('zv-th zv-big item-page note')
    expect(html).toContain('Then the site')
    expect(html).toContain('no agent')
    expect(html).not.toContain('item-users')
  })

  it('wears the agent card frame', () => {
    expect(readFileSync('src/renderer/src/pets/ItemPets.tsx', 'utf8')).toContain('`ag-ink item-card item ${byId.get(id)?.kind ?? \'\'}`')
  })
})

describe('the side groups, attached, as the demo draws them', () => {
  const css = readFileSync('src/renderer/src/pets/pets.css', 'utf8')
  it('browsers and notes become page thumbnails (0.3 of 168 x 108), agents half-size faces', () => {
    expect(css).toMatch(/\.cr-pets\.docked \.cr-pet\.item \{[^}]*width: 52px;[^}]*height: 34px;/)
    expect(css).toMatch(/\.cr-pets\.docked \.cr-pet\.item \.cr-pet-coin \{\s*display: none;/)
    expect(css).toMatch(/\.cr-pets\.docked \.cr-pet\.item \.cr-pet-page \{\s*display: block;/)
    expect(css).toMatch(/\.cr-pets\.docked \.cr-pet:not\(\.item\):not\(\.more\) \{[^}]*width: 34px;/)
  })
  it('floating, an item is still its coin', () => {
    expect(css).toMatch(/\.cr-pet-coin \{\s*display: contents;/)
    expect(css).toMatch(/\.cr-pet-page \{\s*display: none;/)
  })
})
