import { describe, expect, it } from 'vitest'
import {
  NEW_WORKSPACE_ID,
  withNewScreen,
  WALL_VISIBLE_DEPTH,
  flipOnto,
  mruOrder,
  openingPick,
  shotAge,
  stepPick,
  tierFor,
  wallView,
  type Snapshot,
  type WorkspaceFace,
} from '../src/renderer/src/workspace-wall-store'

/**
 * THE SCREEN WALL, AS ARITHMETIC.
 *
 * Every number the wall draws is decided here, so every number can be checked
 * without a browser: which screen faces you, how far back the others sit, how
 * old each picture is, and where the picked one has to land so the canvas can
 * take over from it without a seam.
 */

const WS: WorkspaceFace[] = [
  { id: 'w1', name: 'Cookrew Dev', icon: '📁', dir: '~/workspace/cookrew-dev' },
  { id: 'w2', name: 'Lab', icon: '🧪', dir: '~/workspace/lab' },
  { id: 'w3', name: 'Voice', icon: '🌏', dir: '~/workspace/voice-gateway' },
  { id: 'w4', name: 'Mall', icon: '🛍️', dir: '~/workspace/shop' },
  { id: 'w5', name: 'Scratch', icon: '📐', dir: '~/scratch' },
]
const NOW = 1_790_000_000_000
const shot = (at: number | null): Snapshot => ({ src: at === null ? null : 'data:image/jpeg;base64,x', at })

const view = (over: Partial<Parameters<typeof wallView>[0]> = {}) =>
  wallView({
    workspaces: WS,
    recent: WS.map((w) => w.id),
    activeId: 'w1',
    pick: 0,
    width: 1200,
    shots: {},
    now: NOW,
    ...over,
  })

describe('the order is most-recently-used', () => {
  it('puts the workspace you were last in beside the one you are in', () => {
    // The common move is bouncing between two, and MRU makes that one step.
    const out = mruOrder(WS, ['w3', 'w1'])
    expect(out.map((w) => w.id)).toEqual(['w3', 'w1', 'w2', 'w4', 'w5'])
  })

  it('keeps the store’s own order for anything recency has never seen', () => {
    expect(mruOrder(WS, []).map((w) => w.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
  })

  it('ignores a remembered id whose workspace is gone', () => {
    // A deleted workspace leaves its id in the recency list; a wall that drew
    // a screen for it would be a screen that cannot be entered.
    expect(mruOrder(WS, ['gone', 'w2']).map((w) => w.id)).toEqual(['w2', 'w1', 'w3', 'w4', 'w5'])
  })
})

describe('which screen faces you', () => {
  it('sits the picked one square on, at the front', () => {
    const { screens, picked } = view({ pick: 0 })
    expect(picked?.id).toBe('w1')
    expect(screens[0].transform).toContain('rotateY(0deg)')
    expect(screens[0].transform).toContain('translateZ(0px)')
    expect(screens[0].distance).toBe(0)
    expect(screens[0].zIndex).toBeGreaterThan(screens[1].zIndex)
  })

  it('turns the neighbours away, in opposite directions', () => {
    const { screens } = view({ pick: 2 })
    expect(screens[1].transform).toContain('rotateY(34deg)')   // to the left
    expect(screens[3].transform).toContain('rotateY(-34deg)')  // to the right
    expect(screens[1].transform).toMatch(/translateX\(-\d/)
    expect(screens[3].transform).toMatch(/translateX\(\d/)
  })

  it('steps each further screen further back, and darker', () => {
    const { screens } = view({ pick: 0 })
    const z = (i: number) => Number(/translateZ\((-?\d+(?:\.\d+)?)px\)/.exec(screens[i].transform)![1])
    expect(z(0)).toBe(0)
    expect(z(1)).toBeLessThan(z(0))
    expect(z(2)).toBeLessThan(z(1))
    expect(screens[0].shade).toBe(0)
    expect(screens[2].shade).toBeGreaterThan(screens[1].shade)
  })

  it('caps the darkening, so a far screen is never a black rectangle', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...WS[0], id: `x${i}` }))
    const { screens } = wallView({
      workspaces: many, recent: [], activeId: 'x0', pick: 0, width: 1200, shots: {}, now: NOW,
    })
    expect(Math.max(...screens.map((s) => s.shade))).toBeLessThanOrEqual(0.42)
  })

  it('stops drawing past the visible depth rather than fading forever', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...WS[0], id: `x${i}` }))
    const { screens } = wallView({
      workspaces: many, recent: [], activeId: 'x0', pick: 0, width: 1200, shots: {}, now: NOW,
    })
    expect(screens[WALL_VISIBLE_DEPTH].opacity).toBe(1)
    expect(screens[WALL_VISIBLE_DEPTH + 1].opacity).toBe(0)
  })

  it('reflects the immediate neighbours only — the label owns the space under the picked one', () => {
    const { screens } = view({ pick: 2 })
    expect(screens[2].mirror).toBe(false)
    expect(screens[1].mirror).toBe(true)
    expect(screens[3].mirror).toBe(true)
    expect(screens[0].mirror).toBe(false)
  })

  it('marks the LIVE workspace, which is not always the picked one', () => {
    const { screens } = view({ activeId: 'w1', pick: 3 })
    expect(screens.find((s) => s.live)?.id).toBe('w1')
    expect(screens.find((s) => s.picked)?.id).toBe('w4')
  })
})

describe('the width bands', () => {
  it('shrinks the screens on a narrow card instead of dropping the neighbours', () => {
    // A browser card on the canvas can be 380px wide. The whole idea is a ROW
    // of screens; one screen and two slivers is the same as no wall at all.
    const narrow = tierFor(386)
    const wide = tierFor(1200)
    expect(narrow.screen.width).toBeLessThan(wide.screen.width)
    // Centre plus both neighbours have to fit inside the card.
    expect(narrow.screen.width / 2 + narrow.stepA).toBeLessThan(386)
  })

  it('moves the bands with the width, in one direction', () => {
    const widths = [380, 600, 1000, 1600]
    const steps = widths.map((w) => tierFor(w).stepA)
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
  })

  it('pulls the perspective in when the screens are small', () => {
    expect(tierFor(386).perspective).toBeLessThan(tierFor(1200).perspective)
  })
})

describe('stepping the pick', () => {
  it('wraps both ways', () => {
    expect(stepPick(4, 5, 1)).toBe(0)
    expect(stepPick(0, 5, -1)).toBe(4)
  })
  it('never moves on a wall of one, and never divides by zero on an empty one', () => {
    expect(stepPick(0, 1, 1)).toBe(0)
    expect(stepPick(0, 0, 1)).toBe(0)
  })
})

describe('how old the picture is', () => {
  it('says so in words a corner stamp can hold', () => {
    expect(shotAge(NOW - 5_000, NOW)).toBe('just now')
    expect(shotAge(NOW - 3 * 60_000, NOW)).toBe('3m ago')
    expect(shotAge(NOW - 5 * 3_600_000, NOW)).toBe('5h ago')
    expect(shotAge(NOW - 3 * 86_400_000, NOW)).toBe('3d ago')
  })

  it('says "just now" rather than "0m ago", which reads as a bug', () => {
    expect(shotAge(NOW, NOW)).toBe('just now')
  })

  it('is null when there is no picture, so nothing is stamped', () => {
    expect(shotAge(null, NOW)).toBeNull()
    expect(view({ shots: {} }).screens[0].age).toBeNull()
  })

  it('never reads the future as a negative age', () => {
    // Clocks move; a stamp saying "-2m ago" is worse than one saying nothing new.
    expect(shotAge(NOW + 60_000, NOW)).toBe('just now')
  })

  it('carries the picture and its age onto the screen together', () => {
    const { screens } = view({ shots: { w2: shot(NOW - 120_000) } })
    const lab = screens.find((s) => s.id === 'w2')!
    expect(lab.snapshot.src).toContain('data:image')
    expect(lab.age).toBe('2m ago')
    // And a workspace never left has neither.
    expect(screens.find((s) => s.id === 'w3')!.snapshot.src).toBeNull()
  })
})

describe('the handoff onto the canvas', () => {
  it('lands the screen exactly on the viewport', () => {
    // The live canvas mounts underneath while this grows; a seam between the
    // two is the one thing the animation cannot afford.
    const from = { left: 100, top: 100, width: 200, height: 100 }
    const to = { left: 0, top: 0, width: 800, height: 400 }
    const t = flipOnto(from, to)
    expect(t).toBe('translate(200px, 50px) scale(4)')
  })

  it('covers the viewport when the aspect ratios differ, rather than letter-boxing', () => {
    const t = flipOnto({ left: 0, top: 0, width: 200, height: 100 }, { left: 0, top: 0, width: 400, height: 400 })
    expect(t).toContain('scale(4)')   // the taller axis wins
  })

  it('does not divide by zero on a screen that has not been laid out', () => {
    expect(() => flipOnto({ left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, width: 10, height: 10 })).not.toThrow()
  })
})

describe('an empty or single wall', () => {
  it('has no picked screen and does not throw', () => {
    const out = wallView({ workspaces: [], recent: [], activeId: '', pick: 0, width: 1200, shots: {}, now: NOW })
    expect(out.screens).toEqual([])
    expect(out.picked).toBeNull()
  })

  it('clamps a pick that is out of range rather than drawing nothing', () => {
    // The list can shrink under an open wall when another surface removes one.
    const out = view({ pick: 99 })
    expect(out.picked).not.toBeNull()
    expect(out.screens.filter((s) => s.picked)).toHaveLength(1)
  })
})

describe('which screen the wall opens on', () => {
  it('opens on the PREVIOUS workspace, not the one you are in', () => {
    // Opening on the current one pre-selects where you already are, so the
    // first key is a correction — and because MRU keeps the live workspace at
    // the head, the wall would open with a dead half to the left every time.
    expect(openingPick(5)).toBe(1)
    expect(openingPick(2)).toBe(1)
  })

  it('has nowhere else to go on a single workspace', () => {
    expect(openingPick(1)).toBe(0)
    expect(openingPick(0)).toBe(0)
  })

  it('puts the live workspace to the LEFT of the pick, balancing the row', () => {
    const out = wallView({
      workspaces: WS, recent: ['w1', 'w2', 'w3', 'w4', 'w5'],
      activeId: 'w1', pick: openingPick(5), width: 1200, shots: {}, now: NOW,
    })
    expect(out.picked?.id).toBe('w2')
    const live = out.screens.find((s) => s.live)!
    expect(live.id).toBe('w1')
    expect(live.transform).toMatch(/translateX\(-\d/)   // to the left
    expect(out.screens.filter((s) => s.opacity === 1 && !s.picked).length).toBeGreaterThan(1)
  })
})

describe('a phone held upright', () => {
  it('draws bigger screens than the same width would get in a browser card', () => {
    // A 390px-wide stage that is 700px TALL is a phone, not a narrow card:
    // the row has all that height to spend, and the landscape band's 196px
    // screens left most of it empty.
    const upright = tierFor(390, 700)
    const card = tierFor(390)
    expect(upright.screen.width).toBeGreaterThan(card.screen.width)
    // Centre plus a neighbour still fits — a wall is a ROW or it is nothing.
    expect(upright.screen.width / 2 + upright.stepA).toBeLessThan(390)
  })

  it('is only a phone when the stage is taller than it is wide', () => {
    expect(tierFor(390, 300)).toEqual(tierFor(390))
    expect(tierFor(1200, 2000)).toEqual(tierFor(1200))
  })

  it('reaches the wall through the view, so nothing else has to know', () => {
    const upright = view({ width: 390, height: 700 })
    expect(upright.tier).toEqual(tierFor(390, 700))
  })
})

describe('the NEW screen at the end of the row', () => {
  it('is appended after every workspace, whatever the recency order says', () => {
    const faces = withNewScreen(WS)
    const { screens } = wallView({
      workspaces: faces, recent: ['w3', 'w1'], activeId: 'w1', pick: 0, width: 1200, shots: {}, now: NOW,
    })
    expect(screens.at(-1)?.id).toBe(NEW_WORKSPACE_ID)
    expect(screens.at(-1)?.kind).toBe('new')
    expect(screens.slice(0, -1).every((s) => s.kind === 'workspace')).toBe(true)
  })

  it('never carries a picture, an age, or a directory', () => {
    const { screens } = wallView({
      workspaces: withNewScreen(WS), recent: [], activeId: 'w1', pick: 0, width: 1200,
      shots: { [NEW_WORKSPACE_ID]: shot(NOW) }, now: NOW,
    })
    const fresh = screens.at(-1)!
    expect(fresh.snapshot.src).toBeNull()
    expect(fresh.age).toBeNull()
    expect(fresh.dir).toBe('')
  })

  it('does not move where the wall opens: the previous workspace is still the pick', () => {
    // One real workspace plus NEW must open on the workspace, not on NEW.
    expect(openingPick(1)).toBe(0)
  })
})
