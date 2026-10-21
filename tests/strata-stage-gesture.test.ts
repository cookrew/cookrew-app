import { describe, expect, it } from 'vitest'
import {
  COMMIT_AT,
  TOUCH_FLICK,
  WHEEL_FLICK,
  WHEEL_IDLE,
  decide,
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
})
