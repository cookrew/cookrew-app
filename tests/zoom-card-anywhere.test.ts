// THE OPEN CARD SITS IN THE SAME PLACE ON A PHONE, WHICHEVER COLUMN ITS AGENT
// IS IN AND HOWEVER LARGE THE CREW (Gauge, 2026-11-01, shots/r4/phone-2-card.png:
// Conductor's card, right column, crew of 16, had its left third and the
// workspace label cut off at the left edge). The camera already centred it;
// what moved was the overview itself, scrolled by a scroll into view, so the
// whole scene slid off the camera. Pinned here: the card's screen rect is the
// same for every agent and crew, and the overview can never scroll.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { FrameModel } from '../src/renderer/src/zoom/zoom-frame'
import { paintAt } from './zoom-qa-helpers'

const crew = (n: number, leads: number): FrameModel => ({
  agents: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `A${i}`, preset: 'Claude Code', orch: i < leads, waiting: false })),
  items: [],
  links: [],
  ties: [],
  workspaces: ['w0'],
  otherMachines: 0,
  active: 'w0',
  newest: null
})

/** The card (260 x 244 from -34, -34 of its agent) on screen. */
const cardOnScreen = (m: FrameModel, focus: string, w: number, h: number) => {
  const { scene, L } = paintAt(m, { sv: 2, w, h, narrow: true, focus })
  const at = L.crew.at[focus]
  const [Ox, Oy] = scene.t
  return { left: Ox + (at.x - 34) * scene.s, top: Oy + (at.y - 34) * scene.s, right: Ox + (at.x + 226) * scene.s, bottom: Oy + (at.y + 210) * scene.s }
}

describe('the open card on a phone', () => {
  for (const [w, h] of [[412, 760], [375, 680], [360, 640]]) {
    it(`${w}x${h}: one place on screen for every agent, left, middle and right, in crews of 1 to 24 with 0 to 3 leads`, () => {
      const ref = cardOnScreen(crew(1, 0), 'a0', w, h)
      expect(ref.left).toBeGreaterThanOrEqual(0)
      expect(ref.right).toBeLessThanOrEqual(w)
      expect(ref.top).toBeGreaterThanOrEqual(0)
      expect(ref.bottom).toBeLessThanOrEqual(h)
      for (let n = 1; n <= 24; n++) {
        for (let leads = 0; leads <= Math.min(3, n); leads++) {
          const m = crew(n, leads)
          for (const a of m.agents) {
            const r = cardOnScreen(m, a.id, w, h)
            expect(r.left).toBeCloseTo(ref.left, 0)
            expect(r.right).toBeCloseTo(ref.right, 0)
            expect(r.top).toBeCloseTo(ref.top, 0)
          }
        }
      }
    })
  }
})

describe('the overview', () => {
  it('is clipped, never a scroll box, so nothing can slide the scene off its camera', () => {
    const css = readFileSync('src/renderer/src/zoom/zoom.css', 'utf8')
    for (const sel of ['.zv-root', '.zv-overview']) {
      const rule = css.match(new RegExp(`\\n${sel.replace('.', '\\.')} \\{([^}]*)\\}`))?.[1] ?? ''
      // `clip` after `hidden`: the last one an engine knows wins.
      expect(rule.lastIndexOf('overflow: clip;')).toBeGreaterThan(rule.lastIndexOf('overflow: hidden;'))
    }
  })

  it('puts back any scroll that happens anyway (an engine without clip)', () => {
    const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
    expect(view).toContain('<div className="zv-overview" ref={overview}')
    expect(view).toContain('const boxes = [root.current, overview.current]')
    expect(view).toMatch(/if \(el\.scrollLeft !== 0\) el\.scrollLeft = 0\s+if \(el\.scrollTop !== 0\) el\.scrollTop = 0/)
  })
})
