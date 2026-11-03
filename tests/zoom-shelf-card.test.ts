// AN AGENT'S CARD OVER THE ARTIFACTS (owner, 2026-11-03: "a tap on an agent
// should pop its card up on this page"): a face on the shelf or a coin under a
// thumbnail opens the troop's card where it was tapped, instead of crossing to
// the agents' side (renderer zoom/ShelfCard.tsx, ZoomView.tsx · tapAgent).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { shelfCardSpot } from '../src/renderer/src/zoom/ShelfCard'

const CARD = { width: 260, height: 244 }
const PHONE = { width: 412, height: 915 }
const BAND = { top: 60, bottom: 840 }

describe('where the card opens', () => {
  it('under the face, centred on it', () => {
    const face = { left: 190, top: 200, width: 32, height: 32 }
    expect(shelfCardSpot(face, CARD, PHONE, BAND)).toEqual({ left: 76, top: 242 })
  })

  it('kept on screen at either end of the row', () => {
    expect(shelfCardSpot({ left: 10, top: 200, width: 32, height: 32 }, CARD, PHONE, BAND).left).toBe(8)
    expect(shelfCardSpot({ left: 380, top: 200, width: 32, height: 32 }, CARD, PHONE, BAND).left).toBe(412 - 260 - 8)
  })

  it('above a face low on the screen (a coin under a bottom thumbnail), never under the bar', () => {
    const spot = shelfCardSpot({ left: 190, top: 760, width: 32, height: 32 }, CARD, PHONE, BAND)
    expect(spot.top).toBe(760 - 10 - 244)
    expect(spot.top + CARD.height).toBeLessThanOrEqual(BAND.bottom)
  })

  it('inside the stage where neither side has room', () => {
    const spot = shelfCardSpot({ left: 190, top: 200, width: 32, height: 32 }, CARD, { width: 412, height: 400 }, { top: 60, bottom: 380 })
    expect(spot.top).toBeGreaterThanOrEqual(68)
  })
})

describe('who opens it', () => {
  const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
  it('a face and a coin, on the artifacts side; elsewhere an agent still zooms', () => {
    expect(view).toContain("tapAgent(a.id, `agent-av:${a.id}`)")
    expect(view).toContain("tapAgent(a.id, `link-coin:${l.key}`)")
    expect(view).toMatch(/if \(!atShelf\(\)\) return motion\.agent\(id\)/)
  })
  it('the same agent again is its full view; Escape closes the card before it steps out', () => {
    expect(view).toMatch(/shelfCard\?\.id === id\) \{\s*closeShelfCard\(\)\s*return zoomStore\.jumpTo\('agent', id\)/)
    const esc = view.slice(view.indexOf("if (e.key !== 'Escape') return"), view.indexOf('stepBack()\n    }'))
    expect(esc.indexOf('shelfCardOpen.current')).toBeGreaterThan(-1)
  })
})

describe('what keeps the card open (review, 2026-11-04)', () => {
  const card = readFileSync('src/renderer/src/zoom/ShelfCard.tsx', 'utf8')
  const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
  it('the agent’s own draft, typed in the card or before, read from its store', () => {
    expect(card).toContain('getDraft(draftKey(agent.id)).trim()')
    expect(view).toContain('getDraft(draftKey(shelfCard.id)).trim()')
    expect(view).not.toContain('cardDraft')
  })
  it('only a plain press is a tap outside; an IME, an overlay, a name being renamed or the who-picker keeps its Escape', () => {
    expect(card).toContain('if (e.button !== 0) return')
    expect(view).toMatch(/shelfCardOpen\.current && !e\.isComposing && !\(e\.target as Element \| null\)\?\.closest\?\.\('\.cmd, \.cr-board-search, \.cr-board-pop, \.cr-name-input, \.pf-who'\)/)
  })
})
