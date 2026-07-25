import { describe, expect, it } from 'vitest'
import {
  browserRenderMode,
  clampViewport,
  DESKTOP_STREAM_ORIGIN,
  frameDataUrl,
  frameIsFresh,
  frameMatchesViewport,
  frameSource,
  inputWithRevision,
  keyMsg,
  mobileViewportPreference,
  nextStreamStatus,
  parseStreamMessage,
  pointerMsg,
  streamCanDrive,
  streamInputAllowed,
  streamSupported,
  streamOrigin,
  streamSurfaceState,
  streamUrl,
  touchMsg,
  viewToFramePoint,
  viewportControlMsg,
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
  it('appends and encodes the optional desktop credential', () => {
    expect(streamUrl('http://127.0.0.1:8639', 'b', 800, 600, 'secret/one')).toBe(
      'ws://127.0.0.1:8639/api/browser/b/stream?w=800&h=600&desktopToken=secret%2Fone'
    )
  })
})

describe('browserRenderMode (full renderer replacement contract)', () => {
  it('fails closed while capability is unresolved', () => {
    expect(browserRenderMode({ interactive: null, client: 'desktop', selfEmbedding: false })).toBe(
      'pending'
    )
  })

  it('flag on is headless-only for desktop, phone, demo, and self-embedding URLs', () => {
    for (const client of ['desktop', 'remote', 'demo'] as const) {
      expect(browserRenderMode({ interactive: true, client, selfEmbedding: false })).toBe(
        'headless-stream'
      )
      expect(browserRenderMode({ interactive: true, client, selfEmbedding: true })).toBe(
        'headless-stream'
      )
    }
  })

  it('flag off preserves each legacy renderer and its self-embed guard', () => {
    expect(browserRenderMode({ interactive: false, client: 'desktop', selfEmbedding: false })).toBe(
      'legacy-webview'
    )
    expect(browserRenderMode({ interactive: false, client: 'remote', selfEmbedding: false })).toBe(
      'legacy-thumb'
    )
    expect(browserRenderMode({ interactive: false, client: 'demo', selfEmbedding: false })).toBe(
      'legacy-iframe'
    )
    for (const client of ['desktop', 'remote', 'demo'] as const) {
      expect(browserRenderMode({ interactive: false, client, selfEmbedding: true })).toBe(
        'legacy-blocked'
      )
    }
  })
})

describe('streamOrigin (phone same-origin, Electron via companion loopback)', () => {
  it('keeps the companion origin for a remote phone', () => {
    expect(streamOrigin('https://10.0.0.5:8643', 'remote')).toBe('https://10.0.0.5:8643')
  })
  it('routes both packaged/file and dev Electron renderers to the local server', () => {
    expect(streamOrigin('file://', 'desktop')).toBe(DESKTOP_STREAM_ORIGIN)
    expect(streamOrigin('http://localhost:5173', 'desktop')).toBe(DESKTOP_STREAM_ORIGIN)
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

describe('viewport control messages (closed arbitration vocabulary)', () => {
  it('offers and claims measured dimensions with a mobile preference', () => {
    expect(viewportControlMsg('offer', { width: 390.4, height: 844.6 }, true)).toEqual({
      t: 'viewport-offer',
      width: 390,
      height: 845,
      mobile: true
    })
    expect(viewportControlMsg('claim', { width: 100, height: 5000 }, false)).toEqual({
      t: 'viewport-claim',
      width: 320,
      height: 2048,
      mobile: false
    })
  })

  it('releases without leaking stale dimensions or device preference', () => {
    expect(viewportControlMsg('release', { width: 390, height: 844 }, true)).toEqual({
      t: 'viewport-release'
    })
  })
})

describe('mobileViewportPreference (measured device preference)', () => {
  it('prefers mobile metrics for coarse pointers or narrow frame boxes', () => {
    expect(mobileViewportPreference(1200, true)).toBe(true)
    expect(mobileViewportPreference(390, false)).toBe(true)
  })

  it('keeps a wide fine-pointer view in desktop metrics', () => {
    expect(mobileViewportPreference(1200, false)).toBe(false)
    expect(mobileViewportPreference(0, false)).toBe(false)
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
  it('parses exact ready, viewport-state, and frame metadata fields', () => {
    expect(parseStreamMessage(
      '{"t":"ready","w":390,"h":844,"mobile":true,"revision":7}'
    )).toEqual({ kind: 'ready', w: 390, h: 844, mobile: true, revision: 7 })

    expect(parseStreamMessage(
      '{"t":"viewport-state","width":390,"height":844,"mobile":true,"revision":7,' +
      '"owner":"other","viewerCount":2,"agentHeld":false,"transitioning":true}'
    )).toEqual({
      kind: 'control',
      width: 390,
      height: 844,
      mobile: true,
      revision: 7,
      owner: 'other',
      isOwner: false,
      viewerCount: 2,
      agentHeld: false,
      transitioning: true
    })

    expect(parseStreamMessage(
      '{"t":"frame","seq":8,"data":"Zm9v","meta":{"deviceWidth":390,' +
      '"deviceHeight":844,"displayScale":2,"mobile":true,"revision":7}}'
    )).toEqual({
      kind: 'frame',
      seq: 8,
      src: 'data:image/jpeg;base64,Zm9v',
      deviceWidth: 390,
      deviceHeight: 844,
      displayScale: 2,
      mobile: true,
      revision: 7
    })
  })
  it('rejects malformed viewport state including non-integer revisions', () => {
    expect(parseStreamMessage(
      '{"t":"viewport-state","width":390,"height":844,"mobile":true,"revision":1.5,' +
      '"owner":"self","viewerCount":1,"agentHeld":false,"transitioning":false}'
    )).toBeNull()
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
  it('tags pointer and touch input with the exact integer viewport revision', () => {
    expect(inputWithRevision(pointerMsg('tap', { x: 4, y: 9 }), 7)).toEqual({
      t: 'tap', x: 4, y: 9, revision: 7
    })
    const touch = inputWithRevision(touchMsg('touchmove', { x: 8, y: 12 }), 7)
    expect(touch).toEqual({ t: 'touchmove', x: 8, y: 12, revision: 7 })
    expect(sanitizeInput(touch, ctx)?.[0].params.type).toBe('touchMove')
  })
})

describe('streamCanDrive (revision and activity gate, independent of fit owner)', () => {
  const ready = {
    live: true,
    agentHeld: false,
    transitioning: false,
    frameRevision: 4,
    viewportRevision: 4
  }

  it('allows any viewer whose live frame matches the effective revision', () => {
    expect(streamCanDrive(ready)).toBe(true)
    expect(frameMatchesViewport(4, 4)).toBe(true)
  })

  it('pauses for stale revisions, viewport transitions, or agent activity', () => {
    expect(streamCanDrive({ ...ready, live: false })).toBe(false)
    expect(streamCanDrive({ ...ready, frameRevision: 3 })).toBe(false)
    expect(streamCanDrive({ ...ready, transitioning: true })).toBe(false)
    expect(streamCanDrive({ ...ready, agentHeld: true })).toBe(false)
    expect(frameMatchesViewport(null, 4)).toBe(false)
  })

  it('allows only pointer release cleanup through liveness and activity holds', () => {
    const held = { ...ready, live: false, agentHeld: true, transitioning: true }
    expect(streamInputAllowed(pointerMsg('up', { x: 1, y: 2 }), held)).toBe(true)
    expect(streamInputAllowed(touchMsg('touchend', { x: 1, y: 2 }), held)).toBe(true)
    expect(streamInputAllowed(pointerMsg('down', { x: 1, y: 2 }), held)).toBe(false)
    expect(streamInputAllowed(touchMsg('touchmove', { x: 1, y: 2 }), held)).toBe(false)
  })

  it('never allows release cleanup across a viewport revision boundary', () => {
    const stale = { ...ready, live: false, frameRevision: 3 }
    expect(streamInputAllowed(pointerMsg('up', { x: 1, y: 2 }), stale)).toBe(false)
    expect(streamInputAllowed(touchMsg('touchend', { x: 1, y: 2 }), stale)).toBe(false)
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
  it('an intentionally disabled capability stays on the legacy fallback', () => {
    expect(nextStreamStatus('idle', 'disabled')).toBe('fallback')
  })
  it('fallback is terminal for this open', () => {
    expect(nextStreamStatus('fallback', 'firstFrame')).toBe('fallback')
    expect(nextStreamStatus('fallback', 'open')).toBe('fallback')
  })
})

describe('streamSupported / frameSource', () => {
  it('allows desktop + phone with WebSocket, but never the standalone demo', () => {
    expect(streamSupported(true, 'desktop')).toBe(true)
    expect(streamSupported(true, 'remote')).toBe(true)
    expect(streamSupported(false, 'remote')).toBe(false)
    expect(streamSupported(true, 'demo')).toBe(false)
  })
  it('renders the stream only while streaming, else the thumb', () => {
    expect(frameSource('streaming')).toBe('stream')
    expect(frameSource('connecting')).toBe('thumb')
    expect(frameSource('fallback')).toBe('thumb')
    expect(frameSource('idle')).toBe('thumb')
  })
})

describe('frameIsFresh (B honesty contract)', () => {
  it('requires a real frame inside the stale window', () => {
    expect(frameIsFresh(0, 10_000, 1200)).toBe(false)
    expect(frameIsFresh(9_000, 10_000, 1200)).toBe(true)
    expect(frameIsFresh(8_800, 10_000, 1200)).toBe(true)
    expect(frameIsFresh(8_799, 10_000, 1200)).toBe(false)
    expect(frameIsFresh(10_001, 10_000, 1200)).toBe(false)
  })
})

describe('streamSurfaceState (stable real-UI probe contract)', () => {
  const base = {
    open: true,
    status: 'streaming' as const,
    frameLoaded: true,
    live: true,
    fallback: 'loading' as const
  }

  it('distinguishes decoded live, stalled, and pre-decode loading states', () => {
    expect(streamSurfaceState(base)).toBe('live')
    expect(streamSurfaceState({ ...base, live: false })).toBe('stalled')
    expect(streamSurfaceState({ ...base, frameLoaded: false })).toBe('loading')
  })

  it('distinguishes a neutral headless failure from the phone thumbnail fallback', () => {
    expect(streamSurfaceState({ ...base, status: 'fallback' })).toBe('unavailable')
    expect(streamSurfaceState({ ...base, status: 'fallback', fallback: 'thumb' })).toBe('fallback')
  })

  it('reports a closed surface as idle', () => {
    expect(streamSurfaceState({ ...base, open: false })).toBe('idle')
  })
})
