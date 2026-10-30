// THE CLOSED INPUT VOCABULARY, SPOKEN TO A PHONE.
//
// The cast hands every instance CDP literals — mouse pressed/moved/released,
// touch start/move/end, key down/up — in viewport points. A phone has no
// mouse: a press and release in one place is a tap, a press that travelled is
// a swipe, a wheel is a swipe, a key is a key name vphoned knows, and
// printable text is typed. Pure, so the mapping is tested without a VM.
import { describe, expect, it } from 'vitest'
import { VphoneGestureMapper, vphoneKeyName } from '../src/main/vphone-input'

const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({ method: 'Input.dispatchMouseEvent' as const, params: { type, x, y, ...extra } })
const touch = (type: string, points: Array<{ x: number; y: number }>) =>
  ({ method: 'Input.dispatchTouchEvent' as const, params: { type, touchPoints: points } })
const key = (type: string, k: string, text?: string) =>
  ({ method: 'Input.dispatchKeyEvent' as const, params: { type, key: k, ...(text ? { text } : {}) } })

describe('taps and swipes', () => {
  it('a press and release within the slop is a tap at the release point', () => {
    let now = 1000
    const m = new VphoneGestureMapper(() => now)
    expect(m.map(mouse('mousePressed', 100, 200))).toEqual([])
    now += 80
    expect(m.map(mouse('mouseReleased', 103, 198))).toEqual([{ method: 'input.tap', params: { x: 103, y: 198 } }])
  })

  it('a press that travelled is a swipe, timed by the gesture', () => {
    let now = 1000
    const m = new VphoneGestureMapper(() => now)
    m.map(mouse('mousePressed', 200, 600))
    now += 100
    m.map(mouse('mouseMoved', 200, 500))
    now += 150
    expect(m.map(mouse('mouseReleased', 200, 300))).toEqual([
      { method: 'input.swipe', params: { x1: 200, y1: 600, x2: 200, y2: 300, seconds: 0.25 } }
    ])
  })

  it('a swipe shorter than the floor still takes a readable time, and a long one is capped', () => {
    let now = 0
    const m = new VphoneGestureMapper(() => now)
    m.map(mouse('mousePressed', 0, 0))
    now += 5
    expect(m.map(mouse('mouseReleased', 0, 300))[0].params.seconds).toBe(0.1)
    m.map(mouse('mousePressed', 0, 0))
    now += 9000
    expect(m.map(mouse('mouseReleased', 0, 300))[0].params.seconds).toBe(2)
  })

  it('a release without a press is nothing, and a move without a press is nothing', () => {
    const m = new VphoneGestureMapper(() => 0)
    expect(m.map(mouse('mouseReleased', 1, 1))).toEqual([])
    expect(m.map(mouse('mouseMoved', 1, 1))).toEqual([])
  })

  it('touch start/move/end maps the same way, from the first point', () => {
    let now = 0
    const m = new VphoneGestureMapper(() => now)
    m.map(touch('touchStart', [{ x: 50, y: 900 }]))
    now += 200
    m.map(touch('touchMove', [{ x: 50, y: 400 }]))
    expect(m.map(touch('touchEnd', []))).toEqual([
      { method: 'input.swipe', params: { x1: 50, y1: 900, x2: 50, y2: 400, seconds: 0.2 } }
    ])
    m.map(touch('touchStart', [{ x: 10, y: 10 }]))
    expect(m.map(touch('touchEnd', []))).toEqual([{ method: 'input.tap', params: { x: 10, y: 10 } }])
  })

  it('a second finger is dropped: no pinch on the phone yet, and no half gesture either', () => {
    const m = new VphoneGestureMapper(() => 0)
    m.map(touch('touchStart', [{ x: 10, y: 10 }, { x: 50, y: 50 }]))
    expect(m.map(touch('touchEnd', []))).toEqual([])
  })

  it('a wheel is a swipe of its delta, scroll down meaning finger up, clamped to the screen', () => {
    const m = new VphoneGestureMapper(() => 0, { width: 430, height: 932 })
    expect(m.map(mouse('mouseWheel', 215, 466, { deltaY: 200 }))).toEqual([
      { method: 'input.swipe', params: { x1: 215, y1: 466, x2: 215, y2: 266, seconds: 0.2 } }
    ])
    expect(m.map(mouse('mouseWheel', 215, 900, { deltaY: -500 }))).toEqual([
      { method: 'input.swipe', params: { x1: 215, y1: 900, x2: 215, y2: 932, seconds: 0.2 } }
    ])
    expect(m.map(mouse('mouseWheel', 215, 466, { deltaY: 0 }))).toEqual([])
  })

  it('coordinates are rounded to whole points', () => {
    const m = new VphoneGestureMapper(() => 0)
    m.map(mouse('mousePressed', 10.4, 20.6))
    expect(m.map(mouse('mouseReleased', 10.4, 20.6))).toEqual([{ method: 'input.tap', params: { x: 10, y: 21 } }])
  })
})

describe('keys', () => {
  it('acts on keyDown only, and names the keys the way vphoned does', () => {
    const m = new VphoneGestureMapper(() => 0)
    expect(m.map(key('keyDown', 'Enter'))).toEqual([{ method: 'input.key', params: { name: 'return' } }])
    expect(m.map(key('keyUp', 'Enter'))).toEqual([])
    expect(m.map(key('keyDown', 'Backspace'))).toEqual([{ method: 'input.key', params: { name: 'delete' } }])
    expect(m.map(key('keyDown', 'ArrowDown'))).toEqual([{ method: 'input.key', params: { name: 'down' } }])
  })

  it('types printable text, and ignores a key it has no name for', () => {
    const m = new VphoneGestureMapper(() => 0)
    expect(m.map(key('keyDown', 'a', 'a'))).toEqual([{ method: 'input.type', params: { text: 'a' } }])
    expect(m.map(key('keyDown', '你', '你'))).toEqual([{ method: 'input.paste', params: { text: '你' } }])
    expect(m.map(key('keyDown', 'F5'))).toEqual([])
    expect(vphoneKeyName('Escape')).toBe('escape')
    expect(vphoneKeyName('Tab')).toBe('tab')
    expect(vphoneKeyName('Meta')).toBeNull()
  })
})
