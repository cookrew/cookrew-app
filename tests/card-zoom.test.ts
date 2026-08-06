import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MINI_ZOOM, NATURAL_ZOOM, cardTypeScale, cardZoomMode } from '../src/renderer/src/nodes/card-zoom'

const NODE_SOURCE = readFileSync(
  join(__dirname, '../src/renderer/src/nodes/TerminalNode.tsx'),
  'utf8'
)

/**
 * A terminal card has exactly TWO renderings: the summary card, and the mini
 * tile it degrades to when the whole canvas is in view. The third one — the
 * "full" view that swapped in a terminal tail, tool trail and footer once zoom
 * crossed ~0.95 — is gone; zooming past that point no longer changes what the
 * card says, only how big it is.
 */
describe('card zoom modes', () => {
  it('renders the summary card at overview zoom', () => {
    expect(cardZoomMode(0.5)).toBe('card')
  })

  it('still renders the SAME summary card at natural zoom', () => {
    expect(cardZoomMode(1)).toBe('card')
  })

  it('still renders the same summary card when zoomed deep in', () => {
    expect(cardZoomMode(2.5)).toBe('card')
  })

  it('degrades to the mini tile below the mini threshold', () => {
    expect(cardZoomMode(MINI_ZOOM - 0.01)).toBe('mini')
    expect(cardZoomMode(MINI_ZOOM)).toBe('card')
  })

  it('never reports a mode the card cannot render', () => {
    for (const zoom of [0.05, 0.28, 0.5, 0.94, 0.95, 1, 4]) {
      expect(['card', 'mini']).toContain(cardZoomMode(zoom))
    }
  })
})

/**
 * Type is inverse-scaled against canvas zoom so a card stays readable when
 * shrunk, and stops at natural size so it never grows past its own design.
 */
describe('card type scale', () => {
  it('stays at natural size at and above natural zoom', () => {
    expect(cardTypeScale(NATURAL_ZOOM)).toBe(1)
    expect(cardTypeScale(1)).toBe(1)
    expect(cardTypeScale(3)).toBe(1)
  })

  it('inverse-scales below natural zoom so shrunk cards stay legible', () => {
    expect(cardTypeScale(0.5)).toBeGreaterThan(1)
    expect(cardTypeScale(0.25)).toBeGreaterThan(cardTypeScale(0.5))
  })

  it('quantizes to 1/8 steps so zoom animation frames do not re-render cards', () => {
    for (const zoom of [0.3, 0.42, 0.55, 0.71]) {
      expect(cardTypeScale(zoom) * 8).toBe(Math.round(cardTypeScale(zoom) * 8))
    }
  })

  it('clamps the divisor so a zoom near zero cannot blow the scale up', () => {
    expect(cardTypeScale(0.0001)).toBe(cardTypeScale(0.12))
  })
})

/** The deleted view, pinned so it cannot quietly grow back. */
describe('the full view is gone', () => {
  it('has no FullTurnView renderer', () => {
    expect(NODE_SOURCE).not.toMatch(/FullTurnView/)
  })

  it('has no full-view header line (status name + conclusion)', () => {
    expect(NODE_SOURCE).not.toMatch(/vi-status-name|vi-conclusion/)
  })

  it('has no full-view footer (spinner, turn clock, zoom hint) on agent cards', () => {
    expect(NODE_SOURCE).not.toMatch(/vi-foot|vi-hint|card-clock|card-spinner/)
  })

  it('leaves no orphaned styles behind', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
    for (const dead of [
      '.vi-foot',
      '.vi-hint',
      '.vi-conclusion',
      '.vi-status-name',
      '.card-spinner',
      '.card-clock',
      '.vi-card.full',
      '.vi-head.full'
    ]) {
      expect(css).not.toContain(dead)
    }
  })
})

/**
 * The tool trail came WITH the deleted full view and is the one thing worth
 * keeping from it. It now lives in TurnView — the SINGLE turn block rendered
 * by both the canvas card and the agents sidebar row.
 */
const TURN_VIEW = readFileSync(
  join(__dirname, '../src/renderer/src/nodes/TurnView.tsx'),
  'utf8'
)
const AGENT_ROW = readFileSync(join(__dirname, '../src/renderer/src/AgentRow.tsx'), 'utf8')

describe('the working turn block shows the tool trail', () => {
  it('renders the tools with their glyphs', () => {
    expect(TURN_VIEW).toMatch(/tools\.map/)
    expect(TURN_VIEW).toMatch(/vi-tools/)
    expect(TURN_VIEW).toMatch(/toolGlyph\(toolCall\)/)
  })

  it('marks the newest call latest and the rest older', () => {
    expect(TURN_VIEW).toMatch(/i === tools\.length - 1 \? 'latest' : 'older'/)
  })

  it('keeps the styles the trail needs', () => {
    const css = readFileSync(join(__dirname, '../src/renderer/src/styles.css'), 'utf8')
    for (const live of [
      '.vi-tools {',
      '.vi-tool {',
      '.vi-tool.older {',
      '.vi-tool.latest {',
      '.vi-tool-glyph {'
    ]) {
      expect(css).toContain(live)
    }
  })
})

/**
 * One source. The card and the sidebar row must RENDER the shared block, not
 * own copies of it — this is the guard against the two drifting apart.
 */
describe('card and sidebar row share one turn block', () => {
  it('both render TurnView', () => {
    expect(NODE_SOURCE).toMatch(/<TurnView model=/)
    expect(AGENT_ROW).toMatch(/<TurnView model=/)
  })

  it('neither keeps a private copy of the turn markup', () => {
    for (const source of [NODE_SOURCE, AGENT_ROW]) {
      expect(source).not.toMatch(/vi-turn-title|vi-you-label|vi-tools|vi-ready/)
    }
  })

  it('both bind to the one selector rather than reading activity directly', () => {
    expect(NODE_SOURCE).toMatch(/turnViewOf\(/)
    expect(AGENT_ROW).toMatch(/row\.turn/)
  })
})
