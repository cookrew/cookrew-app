// THE PHONE'S TYPE (owner, 2026-11-02: "the phone's font sizes are all over
// the place; fix them to what a phone app requires"; 2026-11-03: "as the canvas
// zooms the type still changes size: whatever view the main screen zooms to,
// keep the type the same everywhere"). A phone reads at a few sizes, one per
// role, never under 11, every text field at 16 (src/renderer/src/phone-type.css).
// The zoom's words are drawn at ONE size on screen on every frame, wherever the
// camera is (zoom/scene-words.ts): these tests run the real painter along the
// whole path, on three phones and every agents-per-row pick, and keep a desk as it was.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deviceWords, layoutOf, paint, restScales, SWS, type AgentEls, type FrameEls, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'
import { COL, ROW } from '../src/renderer/src/zoom/zoom-layout'
import { near, PHONE_TYPE, pinned, sceneWords, SCENE_TYPE, UNDER_FACE } from '../src/renderer/src/zoom/scene-words'
import { modelOf } from './zoom-qa-helpers'

const PHONES = [[412, 753], [375, 650], [360, 618]] as const
const CREWS = [3, 13, 30]
const PICKS = [2, 3, 4, 5]

const each = (fn: (w: number, h: number, n: number, cols: number) => void): void => {
  for (const [w, h] of PHONES) for (const n of CREWS) for (const cols of PICKS) fn(w, h, n, cols)
}
const scalesOf = (w: number, h: number, n: number, cols: number) => restScales(layoutOf({ ...modelOf(n), crewCols: cols }, true), w, h, true)

type Part = HTMLElement & { _t?: string; _o?: number }
const part = (): Part => ({ style: { setProperty: () => undefined } }) as unknown as Part
const agentParts = (): AgentEls =>
  ({ node: part(), av: part(), nm: part(), st: part(), cnt: part(), dft: part(), body: part(), reply: part(), card: part(), cardl: part(), emp: part(), dot: null, nmW: 80, stW: 60, cntW: 50, nmH: 18, stH: 13 }) as unknown as AgentEls
const scaleOf = (t: string): number => {
  const m = [...t.matchAll(/scale\(([^)]*)\)/g)].map((x) => parseFloat(x[1].split(',')[0]))
  return m.length ? m.reduce((a, b) => a * b, 1) : 1
}

/** One frame at path value sv: what each word reads at on screen, and whether it is seen. */
function frameAt(model: FrameModel, w: number, h: number, sv: number, narrow = true, dir: 'agents' | 'items' = 'agents') {
  const agents = new Map(model.agents.map((a) => [a.id, agentParts()] as const))
  const markLabels = [part(), part()]
  const els = {
    devices: part(), device: part(), scene: part(), panel: part(), wash: part(), ring: part(), label: part(), newCap: part(), machine: part(),
    labelW: 200, labelH: 24, agents, links: new Map(), items: new Map(), ties: new Map(), marks: new Map(), next: null,
    deviceLabel: part(), markLabels, markNones: [part()], machineWords: [part()]
  } as unknown as FrameEls
  const L = layoutOf(model, narrow)
  paint(model, L, els, { dir, sv, w, h, narrow, focus: model.agents[0]?.id ?? null, leaving: null, leavingAmt: 0, focusItem: null })
  const S = scaleOf(els.scene.style.transform)
  const dS = scaleOf(els.device.style.transform)
  const seen = (p: Part): boolean => Number(p.style.opacity) > 0.05
  const words: { what: string; px: number }[] = []
  for (const e of agents.values()) {
    if (seen(e.nm as Part)) words.push({ what: 'name', px: 15 * scaleOf(e.nm.style.transform) * S })
    if (seen(e.st as Part)) words.push({ what: 'state', px: 11 * scaleOf(e.st.style.transform) * S })
  }
  if (seen(els.label as Part)) words.push({ what: 'label', px: 11 * scaleOf(els.label.style.transform) * S })
  const mark = markLabels[0]
  if (seen(mark) && dS > 0) words.push({ what: 'mark', px: 32 * scaleOf(mark.style.transform) * SWS * dS })
  return words
}

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

describe('a phone draws every word at one size, wherever the camera is', () => {
  // The whole path, in steps finer than a frame of any zoom: devices, workspaces, the group, the crew, the card, the full view.
  const PATH = Array.from({ length: 81 }, (_, i) => -2 + i * 0.05)

  it('a name is 16 and a state, a label and a mark 11 on every frame, at every pick, on three phones', () => {
    const want: Record<string, number> = { name: SCENE_TYPE.name, state: SCENE_TYPE.small, label: SCENE_TYPE.small, mark: SCENE_TYPE.small }
    for (const [w, h] of PHONES) {
      for (const n of CREWS) {
        for (const cols of PICKS) {
          const model = { ...modelOf(n), crewCols: cols }
          const kinds = new Set<string>()
          for (const sv of PATH) {
            for (const word of frameAt(model, w, h, sv)) {
              kinds.add(word.what)
              expect(word.px, `${w} ${n}/${cols} at ${sv.toFixed(2)}: ${word.what}`).toBeCloseTo(want[word.what], 1)
            }
          }
          expect([...kinds].sort()).toEqual(['label', 'mark', 'name', 'state'])
        }
      }
    }
  })

  it('and on the artifacts side', () => {
    for (const [w, h] of PHONES) {
      for (const sv of Array.from({ length: 41 }, (_, i) => -2 + i * 0.05)) {
        for (const word of frameAt(modelOf(13), w, h, sv, true, 'items')) {
          expect(word.px, `${w} items at ${sv.toFixed(2)}: ${word.what}`).toBeCloseTo(word.what === 'name' ? SCENE_TYPE.name : SCENE_TYPE.small, 1)
        }
      }
    }
  })

  it('the words that do not fit at their size, toward the devices, fade instead of shrinking', () => {
    const at = frameAt(modelOf(13), 412, 753, -2)
    expect(at.map((x) => x.what)).not.toContain('mark')
    expect(at.map((x) => x.what)).not.toContain('label')
  })

  it("a picture's words show only where the camera draws them at their size", () => {
    expect(near(1.39, 1.39)).toBe(1)
    expect(near(1.39 * 1.005, 1.39)).toBe(1)
    expect(near(1.39 * 1.05, 1.39)).toBe(0)
    expect(near(1.39 / 1.05, 1.39)).toBe(0)
    expect(pinned(16, 15, 0.5) * 15 * 0.5).toBeCloseTo(16, 6)
  })
})

describe("the crew's layout on a phone", () => {
  it('a name is cut before its neighbour, and the counts line shows only where it clears the next row', () => {
    each((w, h, n, cols) => {
      const s = scalesOf(w, h, n, cols)
      const words = sceneWords(s, true)
      const max = parseFloat(words.vars['--zv-nm-max'])
      const name = pinned(SCENE_TYPE.name, 15, s.crew)
      const status = pinned(SCENE_TYPE.small, 11, s.crew)
      expect(max * name * s.crew).toBeLessThanOrEqual(COL * s.crew - 7)
      const bottom = UNDER_FACE.nameTop + UNDER_FACE.toStatus * name + UNDER_FACE.toCounts * status + 11 * status
      if (words.counts) expect(bottom).toBeLessThanOrEqual(ROW - 32)
    })
  })

  it("the workspaces' labels are set for caption at the workspaces stop", () => {
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
    expect(words.live).toBe(false)
    expect(words.label).toEqual({ crew: 1, card: 1 })
    expect(words.vars).toEqual({})
    expect(deviceWords(layoutOf(modelOf(13), false).device, 1440, 820, false).openMax).toBe(Infinity)
  })

  it('draws a name at its own size, scaled with the crew as before', () => {
    const word = frameAt(modelOf(13), 1440, 820, 1, false).find((x) => x.what === 'name')
    expect(word).toBeDefined()
    expect(word!.px).not.toBeCloseTo(SCENE_TYPE.name, 1)
  })
})
