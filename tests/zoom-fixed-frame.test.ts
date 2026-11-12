// ONE FRAME SIZE FOR EVERY MACHINE (owner 2026-11-11: the same two machines
// drew at half the phone's width inside a one-workspace machine and at nine
// tenths inside a nine-workspace one). The frame was sized by the workspace
// grid of the machine in scope while the room for names and gauges stayed
// fixed, so the devices stop's scale followed whichever machine was entered.
import { describe, expect, it } from 'vitest'
import { deviceOf, fitScale, machineFrameOf, SCREEN_SCALE, screenFit, screenAspectOf } from '../src/renderer/src/zoom/zoom-layout'
import { layoutOf, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `w${i}`)
const model = (workspaces: number, otherMachines: number): FrameModel => ({
  agents: [], items: [], links: [], ties: [], workspaces: ids(workspaces), otherMachines, active: 'w0', newest: null, screenAspect: undefined
})
const PHONE = { w: 410, h: 780 }
const DESK = { w: 1440, h: 860 }

describe('the devices stop', () => {
  for (const [narrow, view] of [[true, PHONE], [false, DESK]] as const) {
    it(`frames the same machines at one scale whichever is entered (${narrow ? 'phone' : 'desk'})`, () => {
      const scales = [1, 2, 9, 16].map((n) => fitScale(layoutOf(model(n, 1), narrow).devicesBox, view.w, view.h))
      for (const scale of scales) expect(scale).toBeCloseTo(scales[0], 6)
    })
  }

  it('gives every machine one frame, at the display’s proportions', () => {
    const a = machineFrameOf(deviceOf(ids(1), true), true)
    const b = machineFrameOf(deviceOf(ids(9), true), true)
    expect(a).toEqual(b)
    const wide = machineFrameOf(deviceOf(ids(3), false, screenAspectOf({ w: 3440, h: 1440 })), false)
    expect((wide.w - 28) / (wide.h - 28)).toBeCloseTo(3440 / 1440, 6)
  })

  it('draws tiles at one size in every frame, smaller only where a machine has too many to fit', () => {
    const frame = machineFrameOf(deviceOf(ids(1), true), true)
    expect(screenFit(deviceOf(ids(1), true), frame)).toBe(SCREEN_SCALE)
    expect(screenFit(deviceOf(ids(9), true), frame)).toBeGreaterThan(SCREEN_SCALE * 0.95)
    const crowded = deviceOf(ids(40), true)
    expect(screenFit(crowded, frame) * crowded.screen.w).toBeCloseTo(frame.w - 28, 6)
  })
})
