// UI/UX QA (Gauge, 2026-11-01, a real browser at 1440x900 and 412x915): four
// faults in the full views and the side groups. One test per fault; each was
// also measured in the real App (scratchpad/uiux-qa/probe.mjs).
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { cardPlacement } from '../src/renderer/src/pets/pet-pick'
import { itemFaceLetter } from '../src/renderer/src/stage/StageView'
import { Page } from '../src/renderer/src/zoom/ZoomParts'
import { itemInitial, type ItemView } from '../src/renderer/src/zoom/zoom-model'

const css = (path: string): string => readFileSync(new URL(`../src/renderer/src/${path}`, import.meta.url), 'utf8')

describe("1 · a full view's title ends before the way back out", () => {
  // Above a phone the back pill stands at the middle of the top, over the head.
  const desk = css('zoom/full-views.css').split('@media (min-width: 701px)')[1] ?? ''
  it('each half of the head keeps clear of the pill', () => {
    expect(desk).toMatch(/--fv-back-clear:\s*\d+px/)
    expect(desk).toMatch(/\.zv-fv-who\s*\{[^}]*max-width:\s*calc\(50% - [^}]*var\(--fv-back-clear\)\)/)
    expect(desk).toMatch(/\.zv-fv-used\s*\{[^}]*max-width:\s*calc\(50% - [^}]*var\(--fv-back-clear\)\)/)
  })
  it('and cuts its words short with an ellipsis instead of running under it', () => {
    expect(desk).toMatch(/\.zv-fv-who b,\s*\.zv-fv-who small\s*\{[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis/)
  })
})

describe("2 · a pet's card opens between the header and the bottom bar", () => {
  const viewport = { width: 412, height: 915 }
  const band = { top: 50, bottom: 863 }
  const card = { width: 260, height: 244 }
  it('a face in the strip just under the header: the card starts below the header, not at the screen top', () => {
    const face = { left: 270, top: 120, width: 28, height: 28 }
    const at = cardPlacement(face, card, viewport, 'right', 10, band)
    expect(at.top).toBeGreaterThanOrEqual(band.top + 8)
    expect(at.top + card.height).toBeLessThanOrEqual(band.bottom - 8)
  })
  it('a face low on the screen: the card ends above the bottom bar', () => {
    const face = { left: 370, top: 840, width: 34, height: 34 }
    const at = cardPlacement(face, card, viewport, 'right', 10, band)
    expect(at.top + card.height).toBeLessThanOrEqual(band.bottom - 8)
  })
  it('with no band, the screen as before', () => {
    expect(cardPlacement({ left: 270, top: 0, width: 28, height: 28 }, card, viewport, 'right').top).toBe(8)
  })
})

describe("3 · an item's letter is the same on its card and its full view", () => {
  it("a file:// page takes its title's letter, not its address's (\"U\" for /Users)", () => {
    const title = 'Deliverables · your image, and what the agent hands back'
    expect(itemFaceLetter({ kind: 'browser', title })).toBe('D')
    expect(itemFaceLetter({ kind: 'browser', title })).toBe(itemInitial(title))
  })
  it('a note keeps its mark', () => {
    expect(itemFaceLetter({ kind: 'note', title: 'plan' })).toBe('¶')
  })
})

describe("4 · the side group's faces carry no words too small to read", () => {
  const browser: ItemView = { id: 'b1', kind: 'browser', title: 'Plan', host: 'file://agent-deliverables', tint: '#a8692b', initial: 'P', line: 'file:///Users/x/plan.html', owners: [] }
  const note: ItemView = { id: 'n1', kind: 'note', title: 'sol-plan', host: 'note', tint: '#999', initial: '', line: 'Sol: the plan', owners: [] }
  it('a page without words: no address, no note lines', () => {
    const page = renderToStaticMarkup(<Page item={browser} words={false} />)
    expect(page).toContain('zv-bar')
    expect(page).not.toContain('file://')
    const paper = renderToStaticMarkup(<Page item={note} words={false} />)
    expect(paper).not.toContain('sol-plan')
    expect(paper).not.toContain('Sol: the plan')
  })
  it('the card and the navigator keep theirs', () => {
    expect(renderToStaticMarkup(<Page item={browser} />)).toContain('file://agent-deliverables')
  })
  it('the side group draws its pages without words', () => {
    expect(css('pets/ItemPets.tsx')).toMatch(/className=\{`zv-th cr-pet-page[^`]*`\}[^>]*>\s*<Page item=\{item\.view\} words=\{false\} \/>/)
  })
})
