import { describe, expect, it } from 'vitest'
import {
  clampViewport,
  frameDataUrl,
  frameSource,
  keyMsg,
  nextStreamStatus,
  parseStreamMessage,
  pointerMsg,
  streamSupported,
  streamUrl,
  viewToFramePoint,
  wheelMsg
} from '../src/renderer/src/browser-stream'
import { sanitizeInput } from '../src/shared/cast-input'

describe('streamUrl (ws/wss from origin, w/h query per Forge contract)', () => {
  it('https → wss, with clamped w/h', () => {
    expect(streamUrl('https://10.0.0.5:8643', 'b1', 390, 844)).toBe(
      'wss://10.0.0.5:8643/api/browser/b1/stream?w=390&h=844'
    )
  })
  it('http → ws, id encoded', () => {
    expect(streamUrl('http://phone.local:8639', 'a/b', 800, 1400)).toBe(
      'ws://phone.local:8639/api/browser/a%2Fb/stream?w=800&h=1400'
    )
  })
  it('over/under-size requests clamp into 320..2048', () => {
    expect(streamUrl('http://h', 'b', 100, 5000)).toBe('ws://h/api/browser/b/stream?w=320&h=2048')
  })
})

describe('clampViewport (320..2048, rounded)', () => {
  it('passes through in-range, rounds', () => {
    expect(clampViewport(390.6)).toBe(391)
  })
  it('clamps below 320 and above 2048', () => {
    expect(clampViewport(100)).toBe(320)
    expect(clampViewport(9999)).toBe(2048)
  })
  it('degenerate → min', () => {
    expect(clampViewport(0)).toBe(320)
    expect(clampViewport(NaN)).toBe(320)
  })
})

describe('parseStreamMessage (Forge ready/frame/error text frames)', () => {
  it('{t:frame,seq,data} → frame with a jpeg data url', () => {
    expect(parseStreamMessage('{"t":"frame","seq":7,"data":"Zm9v","meta":{}}')).toEqual({
      kind: 'frame',
      seq: 7,
      src: 'data:image/jpeg;base64,Zm9v'
    })
  })
  it('{t:ready,w,h} → ready', () => {
    expect(parseStreamMessage('{"t":"ready","w":390,"h":844}')).toEqual({ kind: 'ready', w: 390, h: 844 })
  })
  it('{t:error,msg} → error', () => {
    expect(parseStreamMessage('{"t":"error","msg":"attach refused"}')).toEqual({
      kind: 'error',
      msg: 'attach refused'
    })
  })
  it('bare base64 (mock) → frame', () => {
    expect(parseStreamMessage('Zm9v')).toEqual({ kind: 'frame', seq: 0, src: 'data:image/jpeg;base64,Zm9v' })
  })
  it('unknown type / garbage / non-string → null', () => {
    expect(parseStreamMessage('{"t":"pong"}')).toBeNull()
    expect(parseStreamMessage('')).toBeNull()
    expect(parseStreamMessage(new ArrayBuffer(4))).toBeNull()
  })
  it('frameDataUrl prefixes jpeg, passes a data url through', () => {
    expect(frameDataUrl('AAA')).toBe('data:image/jpeg;base64,AAA')
    expect(frameDataUrl('data:image/jpeg;base64,AAA')).toBe('data:image/jpeg;base64,AAA')
  })
})

describe('viewToFramePoint (tap → FRAME px, letterbox-aware + clamped)', () => {
  // 400×800 frame letterboxed into an 800×800 view → fit 400×800 at left=200,top=0.
  const fit = { width: 400, height: 800, left: 200, top: 0 }
  it('center of the fit maps to the frame center', () => {
    expect(viewToFramePoint(400, 400, fit, 400, 800)).toEqual({ x: 200, y: 400 })
  })
  it('fit origin maps to (0,0)', () => {
    expect(viewToFramePoint(200, 0, fit, 400, 800)).toEqual({ x: 0, y: 0 })
  })
  it('a tap in the LEFT letterbox margin clamps to the frame left edge', () => {
    expect(viewToFramePoint(50, 400, fit, 400, 800)).toEqual({ x: 0, y: 400 })
  })
  it('a tap past the right edge clamps to frameW', () => {
    expect(viewToFramePoint(999, 400, fit, 400, 800)).toEqual({ x: 400, y: 400 })
  })
  it('unmeasured fit → origin', () => {
    expect(viewToFramePoint(10, 10, { width: 0, height: 0, left: 0, top: 0 }, 400, 800)).toEqual({ x: 0, y: 0 })
  })
})

describe('input builders → whitelisted by Forge’s sanitizeInput (contract lock)', () => {
  // Forge maps FRAME px → page px via displayScale; a scale of 1 keeps our coords.
  const ctx = { displayScale: 1, viewportWidth: 400, viewportHeight: 800 }
  it('a tap builds {t:tap,x,y} that sanitizes to press+release', () => {
    const cmds = sanitizeInput(pointerMsg('tap', { x: 120, y: 260 }), ctx)
    expect(cmds).not.toBeNull()
    expect(cmds?.map((c) => c.params.type)).toEqual(['mousePressed', 'mouseReleased'])
    expect(cmds?.[0].params.x).toBe(120)
  })
  it('down / move / up drive a scroll drag', () => {
    expect(sanitizeInput(pointerMsg('down', { x: 1, y: 2 }), ctx)?.[0].params.type).toBe('mousePressed')
    expect(sanitizeInput(pointerMsg('move', { x: 1, y: 2 }), ctx)?.[0].params.type).toBe('mouseMoved')
    expect(sanitizeInput(pointerMsg('up', { x: 1, y: 2 }), ctx)?.[0].params.type).toBe('mouseReleased')
  })
  it('wheel carries dy', () => {
    const cmds = sanitizeInput(wheelMsg({ x: 5, y: 5 }, 240), ctx)
    expect(cmds?.[0].params.type).toBe('mouseWheel')
    expect(cmds?.[0].params.deltaY).toBe(240)
  })
  it('a printable key carries text; a named key does not', () => {
    const cmds = sanitizeInput(keyMsg('a', 'KeyA'), ctx)
    expect(cmds?.map((c) => c.params.type)).toEqual(['keyDown', 'keyUp'])
    expect(cmds?.[0].params.text).toBe('a')
    expect(sanitizeInput(keyMsg('Enter', 'Enter'), ctx)?.[0].params.text).toBeUndefined()
  })
})

describe('nextStreamStatus (feature-detect → stream, else loud fallback)', () => {
  it('happy path: idle → connecting → streaming', () => {
    expect(nextStreamStatus('idle', 'connect')).toBe('connecting')
    expect(nextStreamStatus('connecting', 'firstFrame')).toBe('streaming')
  })
  it('connect error or close → fallback (from any state)', () => {
    expect(nextStreamStatus('connecting', 'error')).toBe('fallback')
    expect(nextStreamStatus('connecting', 'close')).toBe('fallback')
    expect(nextStreamStatus('streaming', 'close')).toBe('fallback')
  })
  it('unsupported env → fallback immediately', () => {
    expect(nextStreamStatus('idle', 'unsupported')).toBe('fallback')
  })
  it('fallback is terminal for this open', () => {
    expect(nextStreamStatus('fallback', 'firstFrame')).toBe('fallback')
    expect(nextStreamStatus('fallback', 'open')).toBe('fallback')
  })
})

describe('streamSupported / frameSource', () => {
  it('needs WebSocket AND remote mode', () => {
    expect(streamSupported(true, true)).toBe(true)
    expect(streamSupported(false, true)).toBe(false)
    expect(streamSupported(true, false)).toBe(false)
  })
  it('renders the stream only while streaming, else the thumb', () => {
    expect(frameSource('streaming')).toBe('stream')
    expect(frameSource('connecting')).toBe('thumb')
    expect(frameSource('fallback')).toBe('thumb')
    expect(frameSource('idle')).toBe('thumb')
  })
})
