// THE PHONE'S TYPE (owner, 2026-11-02: "the phone's font sizes are all over the place; fix them to what a phone app requires").
// A phone reads at five sizes, one per role, never under 11, and every text
// field at 16 (src/renderer/src/phone-type.css). The zoom's scene is drawn at
// each stop's camera scale, so its words are pinned on screen by factors
// (zoom/scene-words.ts): these tests hold the factors to the screen sizes, on
// three phones and every agents-per-row pick, and keep a desk at 1.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deviceWords, layoutOf, restScales } from '../src/renderer/src/zoom/zoom-frame'
import { COL, ROW } from '../src/renderer/src/zoom/zoom-layout'
import { crewWordsOnScreen, PHONE_TYPE, sceneWords, UNDER_FACE } from '../src/renderer/src/zoom/scene-words'
import { modelOf } from './zoom-qa-helpers'

const PHONES = [[412, 753], [375, 650], [360, 618]] as const
const CREWS = [3, 13, 30]
const PICKS = [2, 3, 4, 5]

const each = (fn: (w: number, h: number, n: number, cols: number) => void): void => {
  for (const [w, h] of PHONES) for (const n of CREWS) for (const cols of PICKS) fn(w, h, n, cols)
}
const scalesOf = (w: number, h: number, n: number, cols: number) => restScales(layoutOf({ ...modelOf(n), crewCols: cols }, true), w, h, true)

describe('the phone type sheet', () => {
  const css = readFileSync('src/renderer/src/phone-type.css', 'utf8')

  it('declares the five sizes the scene words are pinned to', () => {
    for (const [role, px] of Object.entries(PHONE_TYPE)) expect(css).toMatch(new RegExp(`--ph-${role}: ${px}px;`))
  })

  it('sets every size through a role, never a number of its own', () => {
    const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(sizes.length).toBeGreaterThan(20)
    for (const s of sizes) expect(s, s).toMatch(/var\(--ph-(caption|control|body|title|display)\)|^inherit$|^0\.875em$/)
  })

  it('is loaded by the app, last', () => {
    const main = readFileSync('src/renderer/src/main.tsx', 'utf8')
    expect(main.indexOf("import './phone-type.css'")).toBeGreaterThan(main.indexOf("import './zoom/ink-theme.css'"))
  })
})

describe("the crew's words on a phone, on screen", () => {
  it('a name reads at body or control and the status at caption, at every pick', () => {
    each((w, h, n, cols) => {
      const s = scalesOf(w, h, n, cols)
      const on = crewWordsOnScreen(s, true)
      expect([PHONE_TYPE.body, PHONE_TYPE.control].some((px) => Math.abs(on.name - px) < 0.01), `${w} ${n} ${cols}: ${on.name}`).toBe(true)
      expect(on.status).toBeCloseTo(PHONE_TYPE.caption, 2)
    })
  })

  it('a name is cut before its neighbour, and the counts line shows only where it clears the next row', () => {
    each((w, h, n, cols) => {
      const s = scalesOf(w, h, n, cols)
      const words = sceneWords(s, true)
      const max = parseFloat(words.vars['--zv-nm-max'])
      expect(max * words.crew.name * s.crew).toBeLessThanOrEqual(COL * s.crew - 7)
      const bottom = UNDER_FACE.nameTop + UNDER_FACE.toStatus * words.crew.name + UNDER_FACE.toCounts * words.crew.status + 11 * words.crew.status
      if (words.crew.counts) expect(bottom).toBeLessThanOrEqual(ROW - 32)
    })
  })

  it("the open card's head reads at title and caption", () => {
    each((w, h, n, cols) => {
      const s = scalesOf(w, h, n, cols)
      const words = sceneWords(s, true)
      expect(15 * words.card.name * s.card).toBeCloseTo(PHONE_TYPE.title, 2)
      expect(11 * words.card.status * s.card).toBeCloseTo(PHONE_TYPE.caption, 2)
    })
  })

  it("the workspaces' labels read at caption exactly", () => {
    for (const [w, h] of PHONES) {
      const L = layoutOf(modelOf(13), true)
      const dw = deviceWords(L.device, w, h, true)
      expect(11 * dw.openK * restScales(L, w, h, true).marks).toBeCloseTo(PHONE_TYPE.caption, 2)
      expect(dw.openMax).toBeLessThan(Infinity)
    }
  })
})

describe('a desk', () => {
  it('keeps every word as zoom.css sets it', () => {
    const s = restScales(layoutOf(modelOf(13), false), 1440, 820, false)
    const words = sceneWords(s, false)
    expect(words.crew).toEqual({ name: 1, status: 1, counts: true })
    expect(words.card).toEqual({ name: 1, status: 1 })
    expect(words.label).toEqual({ crew: 1, card: 1, thumbs: 1 })
    expect(words.vars).toEqual({})
    expect(deviceWords(layoutOf(modelOf(13), false).device, 1440, 820, false).openMax).toBe(Infinity)
  })
})
