import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handOffBlob, shouldHandOff } from '../src/renderer/src/browser-poster'
import { KeyedStore } from '../src/renderer/src/keyed-store'

/**
 * THE LAST PICTURE YOU SAW IS THE PICTURE THE CARD KEEPS.
 *
 * A browser card has two pictures and no handover between them. Zoomed in,
 * the live screencast paints frames; zoomed out, the card shows whatever the
 * thumbnail poll last put in the store — minutes old, or nothing if the poll
 * was skipped (every card at mini), backed off (no engine yet), or impossible
 * (the relay carries no WebSocket, and over it the poll is all there is). So
 * the frame the owner was looking at a second ago was discarded at the exact
 * moment it became the best picture of that page anyone had.
 *
 * Three rules, and none of them fetches anything:
 *
 *   POSTER. While the live view has no decoded frame — connecting, stalled,
 *   or unavailable — the zoomed surface shows the card's stored picture under
 *   the status chip, the way a video element shows its poster. Over the
 *   relay that is the difference between a page and a black box saying
 *   UNAVAILABLE.
 *
 *   HAND-OFF. On the zoom-out edge, the last PAINTED live frame becomes the
 *   card's thumbnail. Once, at the edge — never per frame; the screencast
 *   runs at up to 12 fps and the store notifies a card on every set.
 *
 *   AS A BLOB. The live frame is a data: URL; the store holds blob: URLs so
 *   the browser keeps decoded bytes rather than base64 strings in JS memory
 *   (the phone's ceiling). One decode at the edge, the previous blob revoked.
 */

describe('when the hand-off happens', () => {
  it('on the zoom-out edge, when a frame was painted', () => {
    expect(shouldHandOff({ wasOpen: true, open: false, painted: true, computer: true })).toBe(false)
    expect(shouldHandOff({ wasOpen: true, open: false, painted: true })).toBe(true)
  })

  it('not while open, not when nothing was painted, not on the way in', () => {
    expect(shouldHandOff({ wasOpen: true, open: true, painted: true })).toBe(false)
    expect(shouldHandOff({ wasOpen: true, open: false, painted: false })).toBe(false)
    expect(shouldHandOff({ wasOpen: false, open: true, painted: true })).toBe(false)
    expect(shouldHandOff({ wasOpen: false, open: false, painted: true })).toBe(false)
  })
})

describe('handing a live frame to the card', () => {
  const created: Blob[] = []
  const revoked: string[] = []
  beforeEach(() => {
    created.length = 0
    revoked.length = 0
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        created.push(blob)
        return `blob:test/${created.length}`
      },
      revokeObjectURL: (url: string) => void revoked.push(url)
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('names the painted blob once, and the card sees it', () => {
    const store = new KeyedStore<string>()
    const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' })
    handOffBlob(store, 'b1', blob)
    expect(store.get('b1')).toBe('blob:test/1')
    expect(created).toEqual([blob])
  })

  it('revokes the blob it replaces, and only a blob', () => {
    const store = new KeyedStore<string>()
    const blob = new Blob([new Uint8Array([1])], { type: 'image/jpeg' })
    store.set('b1', 'blob:old')
    handOffBlob(store, 'b1', blob)
    expect(revoked).toEqual(['blob:old'])
    store.set('b2', 'data:image/png;base64,BBBB')
    handOffBlob(store, 'b2', blob)
    expect(revoked).toEqual(['blob:old'])
  })

  it('leaves the store alone when the blob cannot become a URL', () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => {
        throw new Error('no')
      },
      revokeObjectURL: (url: string) => void revoked.push(url)
    })
    const store = new KeyedStore<string>()
    store.set('b1', 'blob:keep')
    handOffBlob(store, 'b1', new Blob([new Uint8Array([1])]))
    expect(store.get('b1')).toBe('blob:keep')
    expect(revoked).toEqual([])
  })
})

/**
 * SOURCE PROXIES, for the three places the rules are applied and nothing but
 * a browser could exercise: the frame hands off on the edge and on unmount,
 * its headless placeholder yields to a poster, and the desktop's snapshot
 * sweep no longer walks every browser on the canvas.
 */
const strip = (file: string): string =>
  readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')

describe('the zoomed frame', () => {
  const frame = strip('MobileBrowserFrame.tsx')

  it('reads the card’s stored picture and shows it as the poster while nothing is live', () => {
    expect(frame).toContain('const poster = useThumb(browserId)')
    expect(frame).toContain(': (poster ?? null)')
  })

  it('remembers the last painted live frame, and hands it off on the edge and at unmount', () => {
    // The live view is a canvas now (frame-painter.ts): what it remembers is the painted JPEG.
    expect(frame).toContain('lastPaintedRef.current = frame.blob')
    expect(frame).toContain("shouldHandOff({ wasOpen: wasOpenRef.current, open, painted: lastPaintedRef.current !== null, computer: stream.deviceStatus?.use === 'computer' })")
    expect(frame).toContain('handOffBlob(thumbStore, browserId, lastPaintedRef.current)')
  })

  it('does not cover a poster with the loading glyph — the status chip says the state', () => {
    expect(frame).toContain("fallback === 'loading' ? poster === undefined : !loaded")
  })
})

describe('the desktop snapshot sweep', () => {
  const app = strip('App.tsx')

  it('photographs the browsers the screen shows, never every browser on the canvas', () => {
    expect(app).not.toContain('for (const browser of browsersRef.current)')
    expect(app).toContain('snapshotPlan({')
  })

  it('revokes a blob it replaces — a handed-off frame is one', () => {
    const sweep = app.slice(app.indexOf('snapshotPlan({'), app.indexOf('BROWSER_SNAPSHOT_MS)'))
    expect(sweep).toContain("const old = thumbStore.get(id) if (old?.startsWith('blob:')) URL.revokeObjectURL(old) thumbStore.set(id, dataUrl)")
  })
})
