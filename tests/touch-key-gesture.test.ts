import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  keyGesture,
  TAP_SLOP_PX,
  type KeyGestureEvent,
  type KeyGestureState
} from '../src/renderer/src/touch-key-gesture'

/**
 * The phone's key row fired on pointerdown, so a key was gone the instant a
 * thumb met it. That row lives at the bottom edge where a hand rests, and it
 * scrolls sideways — which necessarily starts by touching a key. Reaching for
 * → could send ESC on the way, and an accidental Escape leaves the menu the
 * agent was waiting on.
 */

/** Run a sequence, returning what the key would have done. */
function run(
  events: KeyGestureEvent[]
): { fires: number; repeats: number; stops: number; state: KeyGestureState } {
  let state: KeyGestureState = { kind: 'idle' }
  let fires = 0
  let repeats = 0
  let stops = 0
  for (const event of events) {
    const result = keyGesture(state, event)
    state = result.state
    if (result.fire) fires += 1
    if (result.startRepeat) repeats += 1
    if (result.stopRepeat) stops += 1
  }
  return { fires, repeats, stops, state }
}

const down = (x = 0, y = 0, pointerId = 1): KeyGestureEvent => ({ type: 'down', pointerId, x, y })
const move = (x: number, y = 0, pointerId = 1): KeyGestureEvent => ({
  type: 'move',
  pointerId,
  x,
  y
})
const up = (pointerId = 1): KeyGestureEvent => ({ type: 'up', pointerId })
const cancel = (pointerId = 1): KeyGestureEvent => ({ type: 'cancel', pointerId })
const hold = (pointerId = 1): KeyGestureEvent => ({ type: 'hold', pointerId })

describe('a key fires on release, so a touch can be taken back', () => {
  it('a plain tap sends exactly one keystroke', () => {
    expect(run([down(), up()])).toMatchObject({ fires: 1, repeats: 0 })
  })

  it('sends NOTHING while the finger is still down', () => {
    // The whole point: pressing is not sending. There is a moment to slide off.
    expect(run([down()])).toMatchObject({ fires: 0 })
    expect(run([down(), move(2)])).toMatchObject({ fires: 0 })
  })

  it('a slide past the slop sends nothing, however it ends', () => {
    // Scrolling the row to reach → must not send whatever it started on.
    expect(run([down(), move(TAP_SLOP_PX + 1), up()])).toMatchObject({ fires: 0 })
    expect(run([down(), move(60), up()])).toMatchObject({ fires: 0 })
  })

  it('a wobble within the slop is still a tap — thumbs are not styluses', () => {
    expect(run([down(), move(TAP_SLOP_PX), up()])).toMatchObject({ fires: 1 })
    expect(run([down(10, 10), move(14, 13), up()])).toMatchObject({ fires: 1 })
  })

  it('a cancelled press sends nothing — a call, an alert, a finger off the edge', () => {
    expect(run([down(), cancel(), up()])).toMatchObject({ fires: 0 })
  })

  it('once slid, coming back does not re-arm the key', () => {
    // The gesture is decided: a scroll that drifts back over the key it
    // started on must not fire it on release.
    expect(run([down(), move(40), move(1), up()])).toMatchObject({ fires: 0 })
  })
})

describe('holding still repeats, and does not double-send', () => {
  it('fires once when the hold matures, then repeats', () => {
    const held = run([down(), hold()])
    expect(held).toMatchObject({ fires: 1, repeats: 1 })
  })

  it('does not fire AGAIN on release after a hold', () => {
    expect(run([down(), hold(), up()])).toMatchObject({ fires: 1, repeats: 1 })
  })

  it('a hold that never happened (a non-repeating key) fires only as a tap', () => {
    // Escape gets no hold timer at all — a leaned-on Escape must not walk
    // back through every menu behind the one you meant to leave.
    expect(run([down(), up()])).toMatchObject({ fires: 1, repeats: 0 })
  })

  it('a hold cannot mature after the finger already slid away', () => {
    expect(run([down(), move(50), hold(), up()])).toMatchObject({
      fires: 0,
      repeats: 0
    })
  })

  it('every ending stops the repeat — a held key must not outlive the press', () => {
    expect(run([down(), hold(), up()]).stops).toBeGreaterThan(0)
    expect(run([down(), hold(), cancel()]).stops).toBeGreaterThan(0)
    expect(run([down(), hold(), move(50)]).stops).toBeGreaterThan(0)
  })

  it('a new press clears whatever the last one left running', () => {
    expect(run([down(), hold(), down()]).stops).toBeGreaterThan(0)
  })
})

describe('a second finger is not a chord, and cannot lend its slop', () => {
  it('a resting finger cannot make a long slide count as a tap', () => {
    // The reported posture: a hand on the row, a thumb dragging. A second
    // `down` used to overwrite the origin, so the first finger's slop was
    // measured against the SECOND finger's touch point — 30px travelled and
    // the key still fired.
    expect(
      run([down(100, 0, 1), down(140, 0, 2), move(130, 0, 1), up(1)])
    ).toMatchObject({ fires: 0 })
  })

  it("a stranger's press does not kill the owner's repeat", () => {
    const held = run([down(0, 0, 1), hold(1), down(50, 0, 2), up(2)])
    expect(held).toMatchObject({ fires: 1, repeats: 1 })
    // Only the owner's own ending stops it.
    expect(run([down(0, 0, 1), hold(1), down(50, 0, 2)]).stops).toBe(1)
  })

  it('the owner still finishes its own gesture while another finger is down', () => {
    expect(run([down(0, 0, 1), down(50, 0, 2), up(1)])).toMatchObject({ fires: 1 })
  })

  it('the row is free again once the owner lifts', () => {
    expect(run([down(0, 0, 1), up(1), down(0, 0, 2), up(2)])).toMatchObject({ fires: 2 })
  })
})

describe('the endings a phone actually produces', () => {
  it('a hold timer that lands AFTER a cancel fires nothing', () => {
    // A system gesture (control centre, a call) cancels mid-press while the
    // hold timeout is already queued.
    expect(run([down(), cancel(), hold()])).toMatchObject({ fires: 0, repeats: 0 })
  })

  it('a duplicate release does not send twice', () => {
    expect(run([down(), up(), up()])).toMatchObject({ fires: 1 })
  })

  it('a VERTICAL slide off the row toward the terminal sends nothing', () => {
    expect(run([down(0, 0), move(0, TAP_SLOP_PX + 1), up()])).toMatchObject({ fires: 0 })
  })
})

describe('the component keeps the keystroke on RELEASE', () => {
  // The reducer is only half the fix: these read the call site, so a refactor
  // cannot quietly put the send back on pointerdown — which is the bug.
  const source = readFileSync(
    path.join(__dirname, '..', 'src/renderer/src', 'VoiceBar.tsx'),
    'utf8'
  )

  it('pointerdown drives the gesture and sends nothing itself', () => {
    const start = source.indexOf('onPointerDown={(e) => {')
    expect(start).toBeGreaterThan(-1)
    const handler = source.slice(start, source.indexOf('onPointerMove', start))
    expect(handler).toContain("type: 'down'")
    expect(handler).not.toContain('ptyInput')
  })

  it('only a repeating key is ever armed to hold', () => {
    expect(source).toMatch(/event\.type === 'down' && key\.repeat/)
  })
})
