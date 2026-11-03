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

describe('sanitizeInput — click count (double/triple click to select)', () => {
  it('a tap with count:2 is a double-click (clickCount 2 on press AND release)', () => {
    expect(sanitizeInput({ t: 'tap', x: 200, y: 400, count: 2 }, ctx)).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 100, y: 200, button: 'left', clickCount: 2 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 100, y: 200, button: 'left', clickCount: 2 } }
    ])
  })
  it('down/up carry the click count', () => {
    expect(sanitizeInput({ t: 'down', x: 20, y: 40, count: 3 }, ctx)?.[0]).toMatchObject({ params: { clickCount: 3 } })
    expect(sanitizeInput({ t: 'up', x: 20, y: 40, count: 2 }, ctx)?.[0]).toMatchObject({ params: { clickCount: 2 } })
  })
  it('clamps an out-of-range / non-integer / missing count to a single click', () => {
    for (const count of [9, 0, -1, 1.5, 'evil'] as const) {
      expect(sanitizeInput({ t: 'tap', x: 20, y: 40, count }, ctx)?.[0]).toMatchObject({ params: { clickCount: 1 } })
    }
    expect(sanitizeInput({ t: 'tap', x: 20, y: 40 }, ctx)?.[0]).toMatchObject({ params: { clickCount: 1 } })
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

  it('maps and clamps exactly two stable touch slots for native pinch', () => {
    expect(sanitizeInput({
      t: 'touchmove',
      points: [
        { id: 1, x: 100000, y: -50 },
        { id: 0, x: 200, y: 400 }
      ]
    }, ctx)).toEqual([{
      method: 'Input.dispatchTouchEvent',
      params: {
        type: 'touchMove',
        touchPoints: [
          { id: 0, x: 100, y: 200 },
          { id: 1, x: 400, y: 0 }
        ]
      }
    }])
  })

  it('rejects third, duplicate, or client-selected touch ids', () => {
    expect(sanitizeInput({
      t: 'touchstart',
      points: [
        { id: 0, x: 1, y: 1 },
        { id: 1, x: 2, y: 2 },
        { id: 0, x: 3, y: 3 }
      ]
    }, ctx)).toBeNull()
    expect(sanitizeInput({
      t: 'touchmove',
      points: [{ id: 0, x: 1, y: 1 }, { id: 0, x: 2, y: 2 }]
    }, ctx)).toBeNull()
    expect(sanitizeInput({
      t: 'touchmove',
      points: [{ id: 9, x: 1, y: 1 }]
    }, ctx)).toBeNull()
  })

  it('rejects malformed and empty touch-point arrays', () => {
    expect(sanitizeInput({ t: 'touchstart', points: [] }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'touchstart', points: [{ id: 0, x: NaN, y: 1 }] }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'touchstart', points: [{ id: 0, x: '1', y: 1 }] }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'touchstart', points: [{ id: 0.5, x: 1, y: 1 }] }, ctx)).toBeNull()
    expect(sanitizeInput({
      t: 'touchstart',
      points: [{ id: 0, x: 1, y: 1, force: 1 }]
    }, ctx)).toBeNull()
    expect(sanitizeInput({
      t: 'touchend',
      points: [{ id: 0, x: 1, y: 1 }]
    }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'touchend', points: [] }, ctx)).toEqual([{
      method: 'Input.dispatchTouchEvent',
      params: { type: 'touchEnd', touchPoints: [] }
    }])
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
  it('Backspace/Enter/arrows carry a virtual key code so the browser acts on them', () => {
    expect(sanitizeInput({ t: 'key', key: 'Backspace', code: 'Backspace' }, ctx)?.[0]).toMatchObject({
      params: { key: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }
    })
    expect(sanitizeInput({ t: 'key', key: 'Enter', code: 'Enter' }, ctx)?.[0]).toMatchObject({
      params: { windowsVirtualKeyCode: 13 }
    })
    expect(sanitizeInput({ t: 'key', key: 'ArrowLeft', code: 'ArrowLeft' }, ctx)?.[0]).toMatchObject({
      params: { windowsVirtualKeyCode: 37 }
    })
  })
  it('a letter or digit carries its virtual key code (pages and games read keyCode) and still inserts via text', () => {
    expect(sanitizeInput({ t: 'key', key: 'a', code: 'KeyA', text: 'a' }, ctx)?.[0].params).toMatchObject({
      text: 'a',
      windowsVirtualKeyCode: 65
    })
    expect(sanitizeInput({ t: 'key', key: '7', code: 'Digit7', text: '7' }, ctx)?.[0].params).toMatchObject({
      windowsVirtualKeyCode: 55
    })
    // A key with no code (the phone bridge) gets none: nothing to derive it from.
    expect(sanitizeInput({ t: 'key', key: 'a', text: 'a' }, ctx)?.[0].params).not.toHaveProperty(
      'windowsVirtualKeyCode'
    )
  })
})

/**
 * THE DESKTOP'S HANDS. Hover, drag, the other buttons, modifiers, sideways
 * scroll, a trackpad pinch, IME text and the editing shortcuts a headless
 * Chrome does not bind by itself — each verified against a real headless
 * Chrome before it was allowed onto the wire (headless-chrome.integration).
 */
describe('sanitizeInput — desktop pointer: hover, drag, buttons, modifiers', () => {
  it('a bare move is a hover: mouseMoved with no button', () => {
    expect(sanitizeInput({ t: 'move', x: 20, y: 40 }, ctx)).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 10, y: 20 } }
    ])
  })
  it('a move with buttons held is a drag: it names the button, or Chromium selects nothing', () => {
    expect(sanitizeInput({ t: 'move', x: 20, y: 40, buttons: 1 }, ctx)?.[0].params).toEqual({
      type: 'mouseMoved', x: 10, y: 20, button: 'left', buttons: 1
    })
    expect(sanitizeInput({ t: 'move', x: 20, y: 40, buttons: 2 }, ctx)?.[0].params).toMatchObject({ button: 'right', buttons: 2 })
    expect(sanitizeInput({ t: 'move', x: 20, y: 40, buttons: 4 }, ctx)?.[0].params).toMatchObject({ button: 'middle', buttons: 4 })
  })
  it('a hostile buttons mask is ignored, never forwarded', () => {
    for (const buttons of [8, -1, 1.5, 'all', 255]) {
      expect(sanitizeInput({ t: 'move', x: 20, y: 40, buttons }, ctx)?.[0].params).not.toHaveProperty('buttons')
    }
  })
  it('right and middle clicks keep their button; anything else is the left one', () => {
    expect(sanitizeInput({ t: 'down', x: 2, y: 4, button: 'right' }, ctx)?.[0].params).toMatchObject({ button: 'right' })
    expect(sanitizeInput({ t: 'up', x: 2, y: 4, button: 'middle' }, ctx)?.[0].params).toMatchObject({ button: 'middle' })
    expect(sanitizeInput({ t: 'tap', x: 2, y: 4, button: 'back' }, ctx)?.[0].params).toMatchObject({ button: 'left' })
  })
  it('held modifiers ride on clicks and wheels (⇧-click extends, ⌘-click opens)', () => {
    expect(sanitizeInput({ t: 'down', x: 2, y: 4, mods: 8 }, ctx)?.[0].params).toMatchObject({ modifiers: 8 })
    expect(sanitizeInput({ t: 'wheel', x: 2, y: 4, dy: 3, mods: 8 }, ctx)?.[0].params).toMatchObject({ modifiers: 8 })
  })
  it('a modifier mask outside the four bits is dropped, not forwarded', () => {
    for (const mods of [16, -1, 2.5, '4']) {
      expect(sanitizeInput({ t: 'down', x: 2, y: 4, mods }, ctx)?.[0].params).not.toHaveProperty('modifiers')
    }
  })
  it('the wheel carries a sideways delta, clamped like the vertical one', () => {
    expect(sanitizeInput({ t: 'wheel', x: 2, y: 4, dy: 10, dx: -30 }, ctx)?.[0].params).toMatchObject({ deltaX: -30, deltaY: 10 })
    expect(sanitizeInput({ t: 'wheel', x: 2, y: 4, dy: 0, dx: 1e9 }, ctx)?.[0].params).toMatchObject({ deltaX: 10_000 })
    expect(sanitizeInput({ t: 'wheel', x: 2, y: 4, dy: 0, dx: 'NaN' }, ctx)).toBeNull()
  })
})

describe('sanitizeInput — a trackpad pinch', () => {
  it('becomes a mouse-sourced pinch gesture at the page point (the page sees ctrl+wheel, the viewport zooms)', () => {
    expect(sanitizeInput({ t: 'pinch', x: 200, y: 400, scale: 1.2 }, ctx)).toEqual([{
      method: 'Input.synthesizePinchGesture',
      params: { x: 100, y: 200, scaleFactor: 1.2, relativeSpeed: 20_000, gestureSourceType: 'mouse' }
    }])
  })
  it('clamps a step to [0.25, 4] and refuses a non-positive one', () => {
    expect(sanitizeInput({ t: 'pinch', x: 2, y: 4, scale: 1000 }, ctx)?.[0].params).toMatchObject({ scaleFactor: 4 })
    expect(sanitizeInput({ t: 'pinch', x: 2, y: 4, scale: 0.0001 }, ctx)?.[0].params).toMatchObject({ scaleFactor: 0.25 })
    expect(sanitizeInput({ t: 'pinch', x: 2, y: 4, scale: 0 }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'pinch', x: 2, y: 4, scale: -2 }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'pinch', x: 2, y: 4 }, ctx)).toBeNull()
  })
})

describe('sanitizeInput — keys with modifiers: the editing commands', () => {
  const keyDown = (raw: Record<string, unknown>) => sanitizeInput({ t: 'key', ...raw }, ctx)?.[0].params
  it('⌘A selects all, ⌘C copies, ⌘X cuts, ⌘Z undoes, ⇧⌘Z redoes', () => {
    expect(keyDown({ key: 'a', code: 'KeyA', mods: 4 })).toMatchObject({ commands: ['selectAll'], modifiers: 4 })
    expect(keyDown({ key: 'c', code: 'KeyC', mods: 4 })).toMatchObject({ commands: ['copy'] })
    expect(keyDown({ key: 'x', code: 'KeyX', mods: 4 })).toMatchObject({ commands: ['cut'] })
    expect(keyDown({ key: 'z', code: 'KeyZ', mods: 4 })).toMatchObject({ commands: ['undo'] })
    expect(keyDown({ key: 'z', code: 'KeyZ', mods: 12 })).toMatchObject({ commands: ['redo'] })
  })
  it('Ctrl does the same for a phone’s hardware keyboard', () => {
    expect(keyDown({ key: 'a', code: 'KeyA', mods: 2 })).toMatchObject({ commands: ['selectAll'] })
    expect(keyDown({ key: 'y', code: 'KeyY', mods: 2 })).toMatchObject({ commands: ['redo'] })
  })
  it('line, word and document moves, with and without ⇧', () => {
    expect(keyDown({ key: 'ArrowLeft', code: 'ArrowLeft', mods: 4 })).toMatchObject({ commands: ['moveToBeginningOfLine'] })
    expect(keyDown({ key: 'ArrowRight', code: 'ArrowRight', mods: 12 })).toMatchObject({
      commands: ['moveToEndOfLineAndModifySelection']
    })
    expect(keyDown({ key: 'ArrowLeft', code: 'ArrowLeft', mods: 1 })).toMatchObject({ commands: ['moveWordLeft'] })
    expect(keyDown({ key: 'Backspace', code: 'Backspace', mods: 1 })).toMatchObject({ commands: ['deleteWordBackward'] })
    expect(keyDown({ key: 'Backspace', code: 'Backspace', mods: 4 })).toMatchObject({ commands: ['deleteToBeginningOfLine'] })
  })
  it('a plain key or ⇧ alone carries no command (Chromium binds those itself)', () => {
    expect(keyDown({ key: 'a', code: 'KeyA', text: 'a' })).not.toHaveProperty('commands')
    expect(keyDown({ key: 'ArrowLeft', code: 'ArrowLeft', mods: 8 })).not.toHaveProperty('commands')
  })
  it('the keyUp never carries the command (it would run twice)', () => {
    expect(sanitizeInput({ t: 'key', key: 'a', code: 'KeyA', mods: 4 }, ctx)?.[1].params).not.toHaveProperty('commands')
  })
  it('a shortcut types nothing: ⌘A with text "a" sends no text', () => {
    expect(keyDown({ key: 'a', code: 'KeyA', text: 'a', mods: 4 })).not.toHaveProperty('text')
    expect(keyDown({ key: 'a', code: 'KeyA', text: 'a', mods: 8 })).toMatchObject({ text: 'a' })
  })
  it('the wire can never name a command itself', () => {
    expect(keyDown({ key: 'q', code: 'KeyQ', mods: 4, commands: ['paste'] })).not.toHaveProperty('commands')
  })
  it('an absurd key or code name is refused', () => {
    expect(sanitizeInput({ t: 'key', key: 'x'.repeat(40) }, ctx)).toBeNull()
    expect(keyDown({ key: 'a', code: 'K'.repeat(40) })).not.toHaveProperty('code')
  })
})

describe('sanitizeInput — committed text and IME composition', () => {
  it('text goes in whole with Input.insertText (a CJK word is never split into keys)', () => {
    expect(sanitizeInput({ t: 'text', text: '你好世界' }, ctx)).toEqual([
      { method: 'Input.insertText', params: { text: '你好世界' } }
    ])
  })
  it('text is typing-sized: empty, non-string or over 4096 is refused', () => {
    expect(sanitizeInput({ t: 'text', text: '' }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'text', text: 7 }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'text', text: 'x'.repeat(4097) }, ctx)).toBeNull()
    expect(sanitizeInput({ t: 'text', text: 'x'.repeat(4096) }, ctx)).not.toBeNull()
  })
  it('a composition shows in the page with the caret at its end; an empty one clears it', () => {
    expect(sanitizeInput({ t: 'compose', text: 'ni' }, ctx)).toEqual([
      { method: 'Input.imeSetComposition', params: { text: 'ni', selectionStart: 2, selectionEnd: 2 } }
    ])
    expect(sanitizeInput({ t: 'compose', text: '' }, ctx)?.[0].params).toEqual({ text: '', selectionStart: 0, selectionEnd: 0 })
    expect(sanitizeInput({ t: 'compose', text: 'x'.repeat(257) }, ctx)).toBeNull()
  })
})
