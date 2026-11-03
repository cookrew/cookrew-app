import { describe, expect, it } from 'vitest'
import { createRunner, type FlightLayers } from '../src/strata/stage/runner'
import type { FlightGeometry } from '../src/strata/stage/timeline'

// No jsdom: the runner only needs element.animate() and what it returns.
interface FakeAnimation {
  currentTime: number
  timing: KeyframeAnimationOptions
  reversed: number
  cancelled: boolean
  effect: { target: unknown }
  finished: Promise<void>
  pause(): void
  cancel(): void
  reverse(): void
}

const fakeEl = () => {
  const made: FakeAnimation[] = []
  const el = {
    made,
    animate(_frames: Keyframe[], timing: KeyframeAnimationOptions): FakeAnimation {
      const a: FakeAnimation = {
        currentTime: 0,
        timing,
        reversed: 0,
        cancelled: false,
        effect: { target: el },
        finished: new Promise<void>(() => undefined),
        pause: () => undefined,
        cancel: () => void (a.cancelled = true),
        reverse: () => void (a.reversed += 1)
      }
      made.push(a)
      return a
    }
  }
  return el
}

const FADE: FlightGeometry = { kind: 'fade', from: 0, to: 1, count: 2 }
const setup = (scrub: boolean) => {
  const els = [fakeEl(), fakeEl(), fakeEl(), fakeEl()]
  const layers = { scenes: [els[0], els[1]], coarse: els[2], fine: els[3] } as unknown as FlightLayers
  const runner = createRunner(1, FADE, layers, 500, 'linear', scrub)
  const live = () => els[0].made.filter((a) => !a.cancelled)
  const runTo = (share: number) => live().forEach((a) => (a.currentTime = Number(a.timing.duration) * share))
  return { runner, els, live, runTo }
}

describe('runner reverse', () => {
  it('a whole flight plays its own curve backwards: no new animations', () => {
    const { runner, els, runTo } = setup(false)
    runTo(0.4)
    runner.reverse()
    expect(els[0].made).toHaveLength(1)
    expect(els[0].made[0].reversed).toBe(1)
  })

  it('a committed scrub settling from where the finger let go springs all the way home, not back to the release point', () => {
    const { runner, live, runTo } = setup(true)
    runner.scrub(0.6)
    runner.settle(true, 0)
    runTo(0.5)
    const p = runner.progress()
    expect(p).toBeCloseTo(0.8, 5)
    runner.reverse()
    const [now] = live()
    expect(now.reversed).toBe(0)
    expect(runner.progress()).toBeCloseTo(p, 5)
    runTo(1)
    expect(runner.progress()).toBe(0)
  })

  it('reversed twice it heads for its target again', () => {
    const { runner, live, runTo } = setup(true)
    runner.scrub(0.5)
    runner.settle(true, 0)
    runner.reverse()
    runTo(0.5)
    runner.reverse()
    runTo(1)
    expect(runner.progress()).toBe(1)
    expect(live()).toHaveLength(1)
  })
})
