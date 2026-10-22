import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMMIT_AT,
  TOUCH_FLICK,
  WHEEL_ABSORB_MS,
  WHEEL_FLICK,
  WHEEL_IDLE,
  decide,
  panFlick,
  panMove,
  panProgress,
  panStart,
  panVelocity,
  rubberBand,
  wheelIdle,
  wheelStep,
  type WheelOut,
  type WheelState
} from '../src/strata/stage/gesture'

describe('touch pan', () => {
  it('locks horizontal: fingers left = in, right = out', () => {
    expect(panMove(panStart(200, 400, 0), 185, 402, 16)).toMatchObject({ phase: 'locked', dir: 'in' })
    expect(panMove(panStart(200, 400, 0), 215, 398, 16)).toMatchObject({ phase: 'locked', dir: 'out' })
  })

  it('leaves vertical pans to the browser', () => {
    expect(panMove(panStart(200, 400, 0), 205, 420, 16).phase).toBe('rejected')
  })

  it('waits until the finger has moved', () => {
    expect(panMove(panStart(200, 400, 0), 195, 401, 16).phase).toBe('pending')
  })

  it('maps travel to progress over 60% of the width', () => {
    const s = panMove(panMove(panStart(300, 400, 0), 280, 400, 16), 300 - 0.3 * 390, 400, 200)
    expect(panProgress(s, 390)).toBeCloseTo(0.5)
  })

  it('reports velocity toward the target', () => {
    const s = panMove(panMove(panStart(300, 400, 0), 280, 400, 16), 240, 400, 32)
    expect(panVelocity(s)).toBeCloseTo(2.5)
  })
})

describe('touch flick (felix: > 48 px in < 350 ms)', () => {
  const pan = (points: Array<[number, number]>) => points.reduce((s, [x, t]) => panMove(s, x, 400, t), panStart(300, 400, 0))

  it('a casual thumb flick commits: 60 px in 250 ms, lifted while moving', () => {
    const s = pan([
      [290, 40],
      [280, 90],
      [265, 150],
      [250, 200],
      [240, 250]
    ])
    // It is under 35% of a phone's span and slower than TOUCH_FLICK at release...
    expect(panProgress(s, 390)).toBeLessThan(0.35)
    expect(panVelocity(s)).toBeLessThan(TOUCH_FLICK)
    expect(decide(panProgress(s, 390), panVelocity(s), TOUCH_FLICK)).toBe(false)
    // ...and still a flick.
    expect(panFlick(s)).toBe(true)
  })

  it('the same 60 px dragged slowly is not a flick, and springs back', () => {
    const s = pan([
      [290, 200],
      [270, 500],
      [250, 800],
      [240, 900]
    ])
    expect(panFlick(s)).toBe(false)
    expect(decide(panProgress(s, 390), panVelocity(s), TOUCH_FLICK)).toBe(false)
  })

  it('a flick that stopped or turned back before lifting is not a flick', () => {
    const stopped = pan([
      [280, 60],
      [245, 160],
      [240, 220],
      [240, 260]
    ])
    expect(panFlick(stopped)).toBe(false)
    const back = pan([
      [270, 60],
      [235, 160],
      [245, 230]
    ])
    expect(panFlick(back)).toBe(false)
  })

  it('under 48 px is never a flick', () => {
    expect(panFlick(pan([[285, 50], [262, 120]]))).toBe(false)
  })
})

describe('commit or spring back', () => {
  it('commits past 35%', () => {
    expect(decide(COMMIT_AT, 0, TOUCH_FLICK)).toBe(true)
    expect(decide(0.3, 0, TOUCH_FLICK)).toBe(false)
  })

  it('commits a flick from anywhere', () => {
    expect(decide(0.05, 0.6, TOUCH_FLICK)).toBe(true)
  })

  it('a pull back away from the target springs back even past 35%', () => {
    expect(decide(0.5, -0.5, TOUCH_FLICK)).toBe(false)
  })
})

describe('rubber band', () => {
  it('resists more the further it goes, and is capped', () => {
    const a = rubberBand(50, 390)
    const b = rubberBand(150, 390)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    expect(b - a).toBeLessThan(100)
    expect(rubberBand(5000, 390)).toBe(64)
    expect(rubberBand(-5000, 390)).toBe(-64)
  })
})

describe('trackpad wheel', () => {
  const run = (events: Array<[number, number, number]>, start: WheelState = WHEEL_IDLE) =>
    events.reduce<{ s: WheelState; outs: WheelOut[] }>(
      ({ s, outs }, [dx, dy, t]) => {
        const [next, out] = wheelStep(s, dx, dy, t)
        return { s: next, outs: [...outs, out] }
      },
      { s: start, outs: [] }
    )

  it('passes vertical scrolling through untouched', () => {
    expect(run([[1, 12, 0]]).outs).toEqual([{ type: 'pass' }])
  })

  it('positive deltaX (fingers left) goes in, negative goes out', () => {
    expect(run([[8, 1, 0]]).outs[0]).toMatchObject({ type: 'start', dir: 'in' })
    expect(run([[-8, 1, 0]]).outs[0]).toMatchObject({ type: 'start', dir: 'out' })
  })

  it('infers release when the momentum phase begins, then swallows the tail', () => {
    const { s, outs } = run([
      [10, 0, 0],
      [20, 0, 16],
      [30, 0, 32],
      [30, 0, 48],
      [15, 0, 64],
      [12, 0, 80],
      [9, 0, 96],
      [6, 0, 112]
    ])
    const release = outs.find((o) => o.type === 'release')
    expect(release).toMatchObject({ type: 'release', travel: 117 })
    expect(outs.slice(-2)).toEqual([{ type: 'swallow' }, { type: 'swallow' }])
    expect(s.phase).toBe('absorbing')
    expect(release && release.type === 'release' && release.velocity).toBeGreaterThan(WHEEL_FLICK)
  })

  it('a coalesced stream (busy main thread: fewer, bigger events) is not mistaken for momentum', () => {
    const { outs } = run([
      [26, 0, 0],
      [44, 0, 32],
      [24, 0, 48],
      [22, 0, 64],
      [18, 0, 80],
      [12, 0, 96],
      [8, 0, 112],
      [5, 0, 128]
    ])
    const release = outs.find((o) => o.type === 'release')
    expect(release && release.type === 'release' && release.travel).toBeGreaterThanOrEqual(154)
  })

  it('releases on a quiet gap, and the absorbed tail ends after its own gap', () => {
    const { s } = run([
      [10, 0, 0],
      [10, 0, 16]
    ])
    const [quiet, out] = wheelIdle(s, 200)
    expect(out).toMatchObject({ type: 'release', travel: 20 })
    expect(wheelIdle(quiet, 400)[0]).toEqual(WHEEL_IDLE)
  })

  it('new fingers during the tail start a new gesture', () => {
    const absorbing: WheelState = { ...WHEEL_IDLE, phase: 'absorbing', lastT: 100, lastAbs: 3 }
    expect(wheelStep(absorbing, -20, 0, 120)[1]).toMatchObject({ type: 'start', dir: 'out' })
  })

  it('a release by silence carries no speed: the fingers had stopped', () => {
    const { s } = run([
      [30, 0, 0],
      [30, 0, 16]
    ])
    expect(wheelIdle(s, 200)[1]).toMatchObject({ type: 'release', velocity: 0 })
  })

  it('a vertical scroll right after a swipe passes through: the swallow window ends on the first mostly vertical event', () => {
    const { s } = run([
      [10, 0, 0],
      [20, 0, 16],
      [30, 0, 32],
      [30, 0, 48],
      [15, 0, 64],
      [12, 0, 80]
    ])
    expect(s.phase).toBe('absorbing')
    // The reviewer's case: a vertical scroll 100 ms after the swipe, one event a frame.
    let w = s
    const outs: string[] = []
    for (let i = 0; i < 20; i++) {
      const [next, out] = wheelStep(w, i % 3 === 0 ? 1 : 0, 18, 180 + i * 16)
      w = next
      outs.push(out.type)
    }
    expect(outs.every((o) => o === 'pass')).toBe(true)
    expect(w.phase).toBe('idle')
  })

  it('the tail itself is still swallowed, a few px of vertical noise included', () => {
    const absorbing: WheelState = { ...WHEEL_IDLE, phase: 'absorbing', dir: 'in', lastT: 100, lastAbs: 6 }
    expect(wheelStep(absorbing, 5, 2, 116)[1]).toEqual({ type: 'swallow' })
    expect(wheelStep(absorbing, 0, 3, 116)[1]).toEqual({ type: 'swallow' })
  })

  it('a tail whose idle timer fired late ends at the next event after the gap, so a new swipe is not eaten', () => {
    const absorbing: WheelState = { ...WHEEL_IDLE, phase: 'absorbing', dir: 'in', lastT: 100, lastAbs: 30 }
    expect(wheelStep(absorbing, 12, 0, 100 + WHEEL_ABSORB_MS)[1]).toMatchObject({ type: 'start', dir: 'in' })
  })
})

describe('touch-action', () => {
  it('every scene hands horizontal pans to the stage: touch-action does not reach below a scroll container', () => {
    const css = readFileSync(path.join(__dirname, '..', 'src', 'strata', 'stage', 'stage.css'), 'utf8')
    const rule = css.match(/\.glide-scene\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/overflow-y:\s*auto/)
    expect(rule).toMatch(/touch-action:\s*pan-y/)
  })
})
