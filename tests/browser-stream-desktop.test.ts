import { describe, expect, it } from 'vitest'
import {
  buttonName,
  composeMsg,
  fieldAt,
  keyMsg,
  pasteMsg,
  modsOf,
  moveMsg,
  parseStreamObject,
  pinchScaleFromWheel,
  pointerMsg,
  textMsg,
  viewportControlMsg,
  viewScale,
  wheelDeltaPx,
  wheelMsg,
  MAX_TEXT_MSG
} from '../src/renderer/src/browser-stream'

describe('a frame from the desktop’s port', () => {
  it('parses JPEG bytes as bytes (no base64, no data: URL)', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff])
    expect(parseStreamObject({ t: 'frame', seq: 3, jpeg, meta: { revision: 2, deviceWidth: 800, deviceHeight: 600 } })).toEqual({
      kind: 'frame',
      seq: 3,
      bytes: jpeg,
      revision: 2,
      deviceWidth: 800,
      deviceHeight: 600
    })
  })
  it('a socket’s base64 frame still parses to a data: URL', () => {
    expect(parseStreamObject({ t: 'frame', seq: 1, data: 'Zm9v', meta: {} })).toEqual({
      kind: 'frame',
      seq: 1,
      src: 'data:image/jpeg;base64,Zm9v'
    })
  })
  it('an empty or malformed frame is ignored; control messages parse the same as off a socket', () => {
    expect(parseStreamObject({ t: 'frame', seq: 1, jpeg: new Uint8Array(0) })).toBeNull()
    expect(parseStreamObject({ t: 'frame', seq: 1, jpeg: 'not bytes' })).toBeNull()
    expect(parseStreamObject(null)).toBeNull()
    expect(parseStreamObject({ t: 'ready', w: 400, h: 300, revision: 1, mobile: false })).toEqual({
      kind: 'ready', w: 400, h: 300, revision: 1, mobile: false
    })
    expect(parseStreamObject({ t: 'copy', text: 'hi' })).toEqual({ kind: 'copy', text: 'hi' })
  })
})

describe('the desktop asks for its display’s pixels', () => {
  it('a Retina Mac asks for 2x; a 1x screen asks for nothing extra; never above 2', () => {
    expect(viewScale(2)).toBe(2)
    expect(viewScale(1)).toBe(1)
    expect(viewScale(3)).toBe(2)
    expect(viewScale(1.25)).toBe(1.5)
    expect(viewScale(Number.NaN)).toBe(1)
  })
  it('the viewport offer carries the scale only when it is above 1 (the phone’s offer is unchanged)', () => {
    expect(viewportControlMsg('offer', { width: 800, height: 600 }, false, 2)).toEqual({
      t: 'viewport-offer', width: 800, height: 600, mobile: false, scale: 2
    })
    expect(viewportControlMsg('offer', { width: 390, height: 700 }, true)).toEqual({
      t: 'viewport-offer', width: 390, height: 700, mobile: true
    })
  })
})

describe('the desktop’s pointer on the wire', () => {
  it('a press keeps its button and modifiers; a plain left click stays the old exact shape', () => {
    expect(pointerMsg('down', { x: 1, y: 2 })).toEqual({ t: 'down', x: 1, y: 2 })
    expect(pointerMsg('down', { x: 1, y: 2 }, 2, { button: 'right', mods: 8 })).toEqual({
      t: 'down', x: 1, y: 2, count: 2, button: 'right', mods: 8
    })
    expect(pointerMsg('move', { x: 1, y: 2 }, 3, { button: 'right' })).toEqual({ t: 'move', x: 1, y: 2 })
  })
  it('a hover is a bare move; a drag names the held buttons', () => {
    expect(moveMsg({ x: 1, y: 2 })).toEqual({ t: 'move', x: 1, y: 2 })
    expect(moveMsg({ x: 1, y: 2 }, 1, 4)).toEqual({ t: 'move', x: 1, y: 2, buttons: 1, mods: 4 })
    expect(moveMsg({ x: 1, y: 2 }, 0x18)).toEqual({ t: 'move', x: 1, y: 2 })
  })
  it('DOM button numbers and modifier flags map to the wire’s', () => {
    expect([0, 1, 2, 3].map(buttonName)).toEqual(['left', 'middle', 'right', 'left'])
    expect(modsOf({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true })).toBe(13)
    expect(modsOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(0)
  })
})

describe('the desktop’s wheel and pinch', () => {
  it('pixels pass through; lines and pages become pixels (a notched mouse scrolled 3 px)', () => {
    expect(wheelDeltaPx({ deltaX: 4, deltaY: -12, deltaMode: 0 }, 600)).toEqual({ dx: 4, dy: -12 })
    expect(wheelDeltaPx({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toEqual({ dx: 0, dy: 48 })
    expect(wheelDeltaPx({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600)).toEqual({ dx: 0, dy: 600 })
  })
  it('the wheel carries dx only when there is one', () => {
    expect(wheelMsg({ x: 1, y: 2 }, 10)).toEqual({ t: 'wheel', x: 1, y: 2, dy: 10 })
    expect(wheelMsg({ x: 1, y: 2 }, 10, -5, 8)).toEqual({ t: 'wheel', x: 1, y: 2, dy: 10, dx: -5, mods: 8 })
  })
  it('a ctrl+wheel step is Chromium’s exp(-deltaY/100): spreading fingers zooms in', () => {
    expect(pinchScaleFromWheel(0)).toBe(1)
    expect(pinchScaleFromWheel(-10)).toBeGreaterThan(1)
    expect(pinchScaleFromWheel(10)).toBeLessThan(1)
    expect(pinchScaleFromWheel(-10) * pinchScaleFromWheel(10)).toBeCloseTo(1)
  })
})

describe('the desktop’s keys and text', () => {
  it('a shortcut sends its modifiers and no text', () => {
    expect(keyMsg('a', 'KeyA', 4)).toEqual({ t: 'key', key: 'a', code: 'KeyA', mods: 4 })
    expect(keyMsg('A', 'KeyA', 8)).toEqual({ t: 'key', key: 'A', code: 'KeyA', text: 'A', mods: 8 })
  })
  it('committed text is sent whole and cut at the server’s bound; nothing is nothing', () => {
    expect(textMsg('你好')).toEqual({ t: 'text', text: '你好' })
    expect(textMsg('')).toBeNull()
    expect((textMsg('x'.repeat(MAX_TEXT_MSG + 10)) as { text: string }).text).toHaveLength(MAX_TEXT_MSG)
  })
  it('a composition is sent as it stands', () => {
    expect(composeMsg('ni')).toEqual({ t: 'compose', text: 'ni' })
  })
})

describe('the page’s text fields on the phone', () => {
  it('parses a fields report and drops what is malformed', () => {
    expect(
      parseStreamObject({
        t: 'fields',
        revision: 3,
        focus: { editable: true, rect: [1, 2, 3, 4], mode: 'email' },
        fields: [{ rect: [1, 2, 3, 4], mode: 'email' }, { rect: [1, 2], mode: 'text' }, { rect: [0, 0, 5, 5], mode: 'bogus' }]
      })
    ).toEqual({
      kind: 'fields',
      revision: 3,
      focus: { editable: true, rect: [1, 2, 3, 4], mode: 'email' },
      fields: [
        { rect: [1, 2, 3, 4], mode: 'email' },
        { rect: [0, 0, 5, 5], mode: 'text' }
      ]
    })
    expect(parseStreamObject({ t: 'fields', fields: [] })).toBeNull()
  })
  it('a tap on a field (with a finger’s slack) finds it; a tap beside it does not', () => {
    const fields = {
      focus: { editable: false, rect: null, mode: 'text' as const },
      fields: [{ rect: [100, 100, 200, 40] as [number, number, number, number], mode: 'search' as const }]
    }
    expect(fieldAt(fields, { x: 150, y: 120 })?.mode).toBe('search')
    expect(fieldAt(fields, { x: 97, y: 96 })?.mode).toBe('search')
    expect(fieldAt(fields, { x: 150, y: 200 })).toBeNull()
    expect(fieldAt(null, { x: 150, y: 120 })).toBeNull()
  })
  it('a paste is its own message, cut at the server’s bound', () => {
    expect(pasteMsg('hi')).toEqual({ t: 'paste', text: 'hi' })
    expect(pasteMsg('')).toBeNull()
    expect((pasteMsg('x'.repeat(MAX_TEXT_MSG + 1)) as { text: string }).text).toHaveLength(MAX_TEXT_MSG)
  })
})
