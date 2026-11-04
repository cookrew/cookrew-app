// THE MACHINE'S SCREEN AT ITS DISPLAY'S PROPORTIONS (owner, 2026-11-01: seven
// workspaces drew a near-square screen, 1110 × 1080, on a 16:10 MacBook). The
// screen was the device view's own box; it is now that box grown to the real
// display's aspect, the view centred in it, and the device stop still frames
// the view alone.
import { describe, expect, it } from 'vitest'
import { DEFAULT_SCREEN_ASPECT, deviceOf, machinesAt, screenAspectOf, screenOf } from '../src/renderer/src/zoom/zoom-layout'
import { layoutOf, type FrameModel } from '../src/renderer/src/zoom/zoom-frame'
import { buildZoomModel } from '../src/renderer/src/zoom/zoom-model'
import { attachmentIndex } from '../src/renderer/src/terminal-attachments'
import { pickMachineDisplay, readMachineDisplay } from '../src/main/machine-display'
import { fleetViewOf, type ZoomFleet } from '../src/renderer/src/zoom/use-zoom-fleet'

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `w${i}`)
const MBP16 = { w: 1728, h: 1117 }

describe('screenAspectOf', () => {
  it('is the display width over its height', () => {
    expect(screenAspectOf(MBP16)).toBeCloseTo(1728 / 1117, 6)
    expect(screenAspectOf({ w: 1080, h: 1920 })).toBeCloseTo(0.5625, 6)
  })

  it('falls back to 16:10 for an unknown or broken display', () => {
    expect(screenAspectOf(null)).toBe(DEFAULT_SCREEN_ASPECT)
    expect(screenAspectOf(undefined)).toBe(DEFAULT_SCREEN_ASPECT)
    expect(screenAspectOf({ w: 0, h: 900 })).toBe(DEFAULT_SCREEN_ASPECT)
    expect(screenAspectOf({ w: Number.NaN, h: 900 })).toBe(DEFAULT_SCREEN_ASPECT)
  })

  it('keeps to shapes a screen has', () => {
    expect(screenAspectOf({ w: 10000, h: 10 })).toBe(4)
    expect(screenAspectOf({ w: 10, h: 10000 })).toBe(0.4)
  })
})

describe('screenOf', () => {
  it('widens a box taller than the display, about the same centre', () => {
    expect(screenOf({ w: 1110, h: 1080, cy: -20 }, 1.6)).toEqual({ w: 1728, h: 1080, cy: -20 })
  })

  it('heightens a box wider than the display', () => {
    expect(screenOf({ w: 1600, h: 500, cy: 7 }, 1.6)).toEqual({ w: 1600, h: 1000, cy: 7 })
  })

  it('never shrinks the box: the view always fits inside its screen', () => {
    for (const box of [{ w: 400, h: 900, cy: 0 }, { w: 2000, h: 300, cy: 0 }]) {
      const s = screenOf(box, 1.5)
      expect(s.w).toBeGreaterThanOrEqual(box.w)
      expect(s.h).toBeGreaterThanOrEqual(box.h)
    }
  })
})

describe('deviceOf', () => {
  it("draws seven workspaces' screen at the Mac's proportions, not near square", () => {
    const d = deviceOf(ids(7), false, screenAspectOf(MBP16))
    expect(d.box.w / d.box.h).toBeLessThan(1.3)
    expect(d.screen.w / d.screen.h).toBeCloseTo(1728 / 1117, 6)
    expect(d.screen.cy).toBe(d.box.cy)
  })

  it('keeps the device view itself as it was: the device stop frames the view, not the screen', () => {
    const before = deviceOf(ids(7), false)
    const after = deviceOf(ids(7), false, 2.4)
    expect(after.box).toEqual(before.box)
    expect(after.at).toEqual(before.at)
  })

  it('is 16:10 when no aspect is given', () => {
    const d = deviceOf(ids(3), false)
    expect(d.screen.w / d.screen.h).toBeCloseTo(1.6, 6)
  })

  it('a phone draws the same machine: its screen is the display, whatever the phone', () => {
    const d = deviceOf(ids(7), true, screenAspectOf(MBP16))
    expect(d.screen.w / d.screen.h).toBeCloseTo(1728 / 1117, 6)
  })
})

describe('the devices stop', () => {
  const frame = (screenAspect: number | undefined, otherMachines = 0): FrameModel => ({
    agents: [], items: [], links: [], ties: [], workspaces: ids(7), otherMachines, active: 'w0', newest: null, screenAspect
  })

  it('frames the whole screen, wider than the view', () => {
    const L = layoutOf(frame(screenAspectOf(MBP16)), false)
    expect(L.devicesBox.w).toBeGreaterThan(L.device.screen.w * 0.5)
    expect(L.device.screen.w).toBeGreaterThan(L.device.box.w)
  })

  it('stands the other machines under the screen', () => {
    const tall = deviceOf(ids(2), false, 0.5)
    expect(machinesAt(1, tall.screen, false).at[0].y).toBe(tall.screen.h / 2 + 120)
  })
})

describe('the model', () => {
  const input = (display?: { w: number; h: number } | null): Parameters<typeof buildZoomModel>[0] => ({
    nodes: [], connections: [], rows: [], crew: [], attachIndex: attachmentIndex([], []), workspaces: [], activeId: 'w1', name: 'w1',
    machines: [
      { id: 'other', name: 'Other', local: false, online: true, detail: 'listed', display: { w: 1000, h: 1000 }, workspaces: [] },
      { id: 'me', name: 'Me', local: true, online: true, detail: 'live', display, workspaces: [] }
    ]
  })

  it("takes this machine's display, never another's", () => {
    expect(buildZoomModel(input(MBP16)).frame.screenAspect).toBeCloseTo(1728 / 1117, 6)
  })

  it('is 16:10 before the feed tells the display', () => {
    expect(buildZoomModel(input(null)).frame.screenAspect).toBe(DEFAULT_SCREEN_ASPECT)
  })
})

describe('the fleet view', () => {
  it('carries the display, and null where it is not known', () => {
    const machine = { id: 'm', name: 'M', local: true, online: true, lastSeenAt: null, appVersion: null, profile: null, detail: 'live' as const, focusedWorkspaceId: null, workspaces: [], counts: null }
    const fleet = { machines: [{ ...machine, display: MBP16 }, { ...machine, id: 'n', local: false }] } as unknown as ZoomFleet
    expect(fleetViewOf(fleet).machines.map((m) => m.display)).toEqual([MBP16, null])
  })
})

describe('the desktop display (main)', () => {
  const d = (width: number, height: number, internal?: boolean): { size: { width: number; height: number }; internal?: boolean } => ({ size: { width, height }, internal })

  it("is a laptop's own panel, even at a monitor that is primary", () => {
    expect(pickMachineDisplay([d(2560, 1440, false), d(1512, 982, true)], d(2560, 1440, false))).toEqual({ w: 1512, h: 982 })
  })

  it('is the primary display without a built-in one', () => {
    expect(pickMachineDisplay([d(1920, 1080), d(2560, 1440)], d(2560, 1440))).toEqual({ w: 2560, h: 1440 })
  })

  it('is null with no display to read', () => {
    expect(pickMachineDisplay([], null)).toBeNull()
    expect(pickMachineDisplay([d(0, 0)], d(0, 0))).toBeNull()
  })

  it('is null when the screen cannot answer (before ready, or mocked away)', () => {
    expect(readMachineDisplay(() => undefined)).toBeNull()
    const quiet = console.error
    console.error = (): void => undefined
    try {
      expect(readMachineDisplay(() => ({ getAllDisplays: () => { throw new Error('not ready') }, getPrimaryDisplay: () => d(1, 1) }))).toBeNull()
    } finally {
      console.error = quiet
    }
  })
})
