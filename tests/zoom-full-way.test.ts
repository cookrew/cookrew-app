// THE WAY INTO A FULL VIEW (owner 2026-11-02: "like the draft",
// group-motion-pivot.html). From the card stop the draft never shows an empty
// sheet: the open card's face and name go to the head, its thumbnails to the
// browsers-and-notes column, and the other faces dock as the troop. The app
// grew a blank sheet over everything and faded the card's parts away, so the
// content popped in only once the real full view took over.
//
// Run on stand-in elements (zoom-qa-helpers.ts): what the painter wrote is
// read back and turned into a spot on screen.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fullPoses } from '../src/renderer/src/zoom/full-poses'
import { layoutOf, paint, type AgentEls, type FrameEls, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'
import { modelOf } from './zoom-qa-helpers'

type Part = HTMLElement & { _t?: string; _o?: number }
const part = (): Part => ({ style: {} }) as unknown as Part

const agentEls = (): AgentEls =>
  ({
    node: part(), cardl: part(), card: part(), av: part(), nm: part(), st: part(), cnt: part(), dft: part(),
    body: part(), reply: part(), emp: part(), dot: null, nmW: 60, stW: 50, cntW: 40, nmH: 18, stH: 13
  }) as unknown as AgentEls

const nums = (t: string | undefined, fn: string): number[] =>
  ((t ?? '').match(new RegExp(`${fn}\\(([^)]*)\\)`))?.[1] ?? '').split(',').map((n) => parseFloat(n))

function run(model: FrameModel, sv: number, w: number, h: number, narrow: boolean) {
  const agents = new Map(model.agents.map((a) => [a.id, agentEls()] as const))
  const els = {
    devices: part(), device: part(), scene: part(), panel: part(), wash: part(), label: part(), newCap: part(), machine: part(),
    labelW: 200, labelH: 24, agents, links: new Map(), items: new Map(), ties: new Map(), marks: new Map(), next: null, fullHead: part()
  } as unknown as FrameEls
  paint(model, layoutOf(model, narrow), els, { dir: 'agents', sv, focus: model.agents[0].id, leaving: null, leavingAmt: 0, focusItem: null, w, h, narrow })
  const [Ox, Oy] = nums(els.scene.style.transform, 'translate')
  const S = nums(els.scene.style.transform, 'scale')[0]
  /** Where an agent's face is on screen, and how opaque. */
  const face = (id: string) => {
    const e = agents.get(id)!
    const [nx, ny] = nums(e.node.style.transform, 'translate')
    const at = e.av.style.transform?.startsWith('translate') ? nums(e.av.style.transform, 'translate') : [0, 0]
    return { x: Ox + (nx + at[0]) * S, y: Oy + (ny + at[1]) * S, o: Number(e.av.style.opacity ?? 1) * Number(e.node.style.opacity ?? 1) }
  }
  return { face, S, wash: Number(els.wash.style.opacity), panel: Number(els.panel.style.opacity) }
}

describe('where the full view draws things', () => {
  it('desktop: the head top-left, the cells down the right, the troop beside the sheet', () => {
    const F = fullPoses(1440, 788, false)
    expect(F.headFades).toBe(false)
    expect(F.cell(0)).toMatchObject({ x: 1440 - 179, y: 171, w: 168, h: 108, o: 1 })
    expect(F.cell(1).y - F.cell(0).y).toBe(124)
    expect(F.cell(9).o).toBe(0)
    expect(F.dock(0, 19).x).toBe(1405)
    expect(F.dock(5, 19).o).toBe(0)
    expect(F.aside(0)).not.toBeNull()
  })

  it('phone: the head is the bar’s, the cells a row at the foot, the troop a row at the top', () => {
    const F = fullPoses(412, 801, true)
    expect(F.headFades).toBe(true)
    expect(F.cell(0).y).toBe(801 - 55)
    expect(F.cell(3).o).toBe(0)
    expect(F.dock(0, 19).y).toBe(28)
    expect(F.aside(0)).toBeNull()
  })
})

describe('the way in carries the card, never an empty sheet', () => {
  const model = modelOf(8)

  it('desktop: the open face reaches the head, still drawn; the others dock in the column', () => {
    const r = run(model, 2.75, 1440, 788, false)
    const F = fullPoses(1440, 788, false)
    const open = r.face('a0')
    expect(open.o).toBeGreaterThan(0.9)
    expect(Math.abs(open.x - F.avatar.x)).toBeLessThan(2)
    expect(Math.abs(open.y - F.avatar.y)).toBeLessThan(2)
    for (let k = 0; k < 4; k++) {
      const f = r.face(`a${k + 1}`)
      expect(Math.abs(f.x - F.dock(k, 7).x)).toBeLessThan(2)
      expect(Math.abs(f.y - F.dock(k, 7).y)).toBeLessThan(2)
      expect(f.o).toBeGreaterThan(0.9)
    }
    // Behind "more": gone.
    expect(r.face('a6').o).toBeLessThan(0.05)
  })

  it('half-way, the open face is on its way and the others are still seen', () => {
    const r = run(model, 2.4, 1440, 788, false)
    expect(r.face('a0').o).toBeGreaterThan(0.9)
    expect(r.face('a1').o).toBeGreaterThan(0.5)
  })

  it('phone: the troop docks in the row at the top; the open face rises and fades into the bar', () => {
    const r = run(model, 2.75, 412, 801, true)
    const F = fullPoses(412, 801, true)
    const f = r.face('a1')
    expect(Math.abs(f.x - F.dock(0, 7).x)).toBeLessThan(2)
    expect(Math.abs(f.y - F.dock(0, 7).y)).toBeLessThan(2)
    // Still seen on its way up (the review of 11-02: an empty sheet before the hand-over) …
    expect(r.face('a0').o).toBeGreaterThan(0.3)
    // … and gone as the real view comes in (zoom-frame · cover from 2.86).
    expect(run(model, 2.87, 412, 801, true).face('a0').o).toBeLessThan(0.05)
  })

  it('the ground goes as the sheet comes', () => {
    expect(run(model, 2, 1440, 788, false).wash).toBeGreaterThan(0.5)
    expect(run(model, 2.5, 1440, 788, false).wash).toBe(0)
  })

  it('the sheet lies under the scene, so the parts ride over it', () => {
    const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
    expect(view.indexOf("bind('panel')")).toBeLessThan(view.indexOf("bind('scene')"))
    const css = readFileSync('src/renderer/src/zoom/zoom.css', 'utf8')
    expect(css).toMatch(/\.zv-panel \{[^}]*z-index: 0;/)
  })
})
