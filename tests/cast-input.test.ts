import { describe, expect, it } from 'vitest'
import { sanitizeInput } from '../src/shared/cast-input'

// SECURITY CORE. The interactive-browser WS lives on the UNAUTH LAN server, so
// the wire vocabulary is a small closed set that maps to whitelisted CDP
// Input.* commands only — never a generic CDP/Runtime.evaluate passthrough.
// Coords are clamped into the page viewport; malformed input is rejected.

const ctx = { displayScale: 2, viewportWidth: 400, viewportHeight: 800 }

describe('sanitizeInput — pointer vocab', () => {
  it('a tap becomes press+release in CSS px (frame px / displayScale)', () => {
    const cmds = sanitizeInput({ t: 'tap', x: 200, y: 400 }, ctx)
    expect(cmds).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 100, y: 200, button: 'left', clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 100, y: 200, button: 'left', clickCount: 1 } }
    ])
  })
  it('move -> mouseMoved, down/up -> pressed/released', () => {
    expect(sanitizeInput({ t: 'move', x: 20, y: 40 }, ctx)?.[0]).toMatchObject({
      params: { type: 'mouseMoved', x: 10, y: 20 }
    })
    expect(sanitizeInput({ t: 'down', x: 20, y: 40 }, ctx)?.[0]).toMatchObject({
      params: { type: 'mousePressed', button: 'left' }
    })
    expect(sanitizeInput({ t: 'up', x: 20, y: 40 }, ctx)?.[0]).toMatchObject({
      params: { type: 'mouseReleased', button: 'left' }
    })
  })
  it('wheel -> mouseWheel with clamped deltaY', () => {
    const cmd = sanitizeInput({ t: 'wheel', x: 20, y: 40, dy: 120 }, ctx)?.[0]
    expect(cmd).toMatchObject({ params: { type: 'mouseWheel', x: 10, y: 20, deltaY: 120, deltaX: 0 } })
  })
})

describe('sanitizeInput — touch vocab (phone swipe → native scroll)', () => {
  it('touchstart/touchmove -> dispatchTouchEvent with the clamped point', () => {
    expect(sanitizeInput({ t: 'touchstart', x: 200, y: 400 }, ctx)).toEqual([
      { method: 'Input.dispatchTouchEvent', params: { type: 'touchStart', touchPoints: [{ x: 100, y: 200 }] } }
    ])
    expect(sanitizeInput({ t: 'touchmove', x: 20, y: 40 }, ctx)?.[0]).toMatchObject({
      method: 'Input.dispatchTouchEvent',
      params: { type: 'touchMove', touchPoints: [{ x: 10, y: 20 }] }
    })
  })
  it('touchend carries an empty touchPoints set (finger lifted, CDP requirement)', () => {
    expect(sanitizeInput({ t: 'touchend', x: 20, y: 40 }, ctx)).toEqual([
      { method: 'Input.dispatchTouchEvent', params: { type: 'touchEnd', touchPoints: [] } }
    ])
  })
  it('touch coords are clamped into the page viewport like every other input', () => {
    expect(sanitizeInput({ t: 'touchmove', x: 100000, y: -50 }, ctx)?.[0]).toMatchObject({
      params: { touchPoints: [{ x: 400, y: 0 }] }
    })
  })
  it('a malformed touchstart (non-finite coords) is rejected, not smuggled', () => {
    expect(sanitizeInput({ t: 'touchstart', x: 'NaN', y: 40 }, ctx)).toBeNull()
  })
})

describe('sanitizeInput — clamping', () => {
  it('clamps out-of-range coords into [0, viewport]', () => {
    // x=100000/2 = 50000 -> clamp to 400; negative -> 0
    expect(sanitizeInput({ t: 'move', x: 100000, y: -50 }, ctx)?.[0]).toMatchObject({
      params: { x: 400, y: 0 }
    })
  })
  it('clamps an absurd wheel delta to a sane bound', () => {
    const cmd = sanitizeInput({ t: 'wheel', x: 0, y: 0, dy: 999999 }, ctx)?.[0]
    expect(cmd?.params.deltaY as number).toBeLessThanOrEqual(10000)
  })
})

describe('sanitizeInput — rejection (whitelist)', () => {
  it('rejects unknown/dangerous message types', () => {
    expect(sanitizeInput({ t: 'evaluate', expression: 'process.exit()' }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'navigate', url: 'file:///etc/passwd' }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'screenshot' }, ctx)).toBeNull()
  })
  it('rejects raw CDP method smuggling (no `t`)', () => {
    expect(sanitizeInput({ method: 'Runtime.evaluate', params: { expression: '1' } }, ctx)).toBeNull()
    expect(sanitizeInput({ method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed' } }, ctx)).toBeNull()
    // The new touch method must not be reachable by shape either — only via a `t` tag.
    expect(
      sanitizeInput({ method: 'Input.dispatchTouchEvent', params: { type: 'touchStart', touchPoints: [{ x: 0, y: 0 }] } }, ctx)
    ).toBeNull()
  })
  it('rejects non-objects and non-finite coords', () => {
    expect(sanitizeInput(null, ctx)).toBeNull()
    expect(sanitizeInput('tap', ctx)).toBeNull()
    expect(sanitizeInput({ t: 'tap', x: NaN, y: 0 }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'tap', x: 'evil', y: 0 }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'move' }, ctx)).toBeNull()
  })
})

describe('sanitizeInput — key vocab', () => {
  it('a printable key becomes keyDown(char)+keyUp, text only', () => {
    const cmds = sanitizeInput({ t: 'key', key: 'a', code: 'KeyA', text: 'a' }, ctx)
    expect(cmds?.map((c) => c.params.type)).toEqual(['keyDown', 'keyUp'])
    expect(cmds?.[0]).toMatchObject({ method: 'Input.dispatchKeyEvent', params: { key: 'a', code: 'KeyA' } })
  })
  it('rejects an over-long text payload (no bulk injection)', () => {
    expect(sanitizeInput({ t: 'key', key: 'x', text: 'x'.repeat(5000) }, ctx)).toBeNull()
  })
})
