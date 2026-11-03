import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBrowserCastIpc, type CastPort } from '../src/main/browser-cast-ipc'
import { findChrome, HeadlessInstance } from '../src/main/headless-chrome'
import { jpegSize } from '../src/main/jpeg-size'

/**
 * THE DESKTOP'S HANDS, AGAINST A REAL CHROME.
 *
 * Opt-in (COOKREW_REAL_CHROME_TEST=1): a real headless Chrome, driven the way
 * the desktop drives it — through the port viewer (browser-cast-ipc.ts), the
 * shared viewer core and the closed vocabulary (cast-input.ts). Each line here
 * was a thing the old wire could not do: drag-select, ⌘A, a CJK word, an IME
 * composition, sideways scroll, a trackpad pinch, a crisp 2x frame.
 */

const chrome = findChrome()
const enabled = process.env.COOKREW_REAL_CHROME_TEST === '1' && chrome !== null

const PAGE = `<!doctype html><meta name="viewport" content="width=device-width">
<body style="margin:0;width:3000px;height:4000px;font:20px sans-serif">
<input id="i" style="position:fixed;top:10px;left:10px;width:300px;font:16px sans-serif" value="hello world">
<p id="p" style="position:absolute;top:200px;left:10px;margin:0">Select this paragraph text by dragging across it</p>
</body>`

const FIELDS_PAGE = `<!doctype html><meta name="viewport" content="width=device-width">
<body style="margin:0;font:16px sans-serif">
<input id="i" style="position:absolute;top:20px;left:20px;width:300px;height:30px" value="">
<input id="n" type="number" style="position:absolute;top:80px;left:20px;width:120px;height:30px">
<textarea id="t" style="position:absolute;top:140px;left:20px;width:300px;height:60px"></textarea>
<p id="p" style="position:absolute;top:240px;left:20px;margin:0">Copy these words</p>
<script>
  // An editor that takes pastes over: it shouts them.
  t.addEventListener('paste', (e) => { e.preventDefault(); t.value += e.clipboardData.getData('text/plain').toUpperCase() })
</script>
</body>`

describe.skipIf(!enabled)('desktop input through the port viewer, real Chromium', () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'cookrew-input-integration-'))
  let server: http.Server
  let origin = ''

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(request.url === '/fields' ? FIELDS_PAGE : PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address')
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('drags, selects, types CJK, composes, scrolls sideways and pinches — at 2x', async () => {
    const instance = new HeadlessInstance({
      executablePath: chrome as string,
      profileDir,
      width: 800,
      height: 600,
      tabs: [{ id: 'tab', url: `${origin}/`, title: '' }],
      activeTabId: 'tab'
    })
    const posted: Array<Record<string, unknown>> = []
    let onMessage: (event: { data: unknown }) => void = () => undefined
    // A renderer that paints at once: every frame gets its receipt.
    const port: CastPort = {
      postMessage: (message) => {
        const record = message as Record<string, unknown>
        posted.push(record)
        if (record.t === 'frame') setTimeout(() => onMessage({ data: { t: 'painted', seq: record.seq } }), 0)
      },
      on: ((event: string, listener: (event: { data: unknown }) => void) => {
        if (event === 'message') onMessage = listener
      }) as CastPort['on'],
      start: () => undefined,
      close: () => undefined
    }
    const ipc = createBrowserCastIpc({ enabled: () => true, getInstance: () => Promise.resolve(instance) })
    const lastFrame = (): Record<string, unknown> | undefined => posted.filter((m) => m.t === 'frame').at(-1)
    const meta = (): { revision: number; displayScale: number } =>
      lastFrame()?.meta as { revision: number; displayScale: number }
    /** One input message, bound to the newest delivered frame and revision; CSS px in, frame px out. */
    const send = (message: Record<string, unknown>): void => {
      const frame = lastFrame()
      if (!frame) throw new Error('no frame yet')
      const { revision, displayScale } = meta()
      const scaled = { ...message }
      for (const axis of ['x', 'y'] as const) {
        if (typeof scaled[axis] === 'number') scaled[axis] = (scaled[axis] as number) * displayScale
      }
      onMessage({ data: { ...scaled, revision, frameSeq: frame.seq } })
    }
    const evaluate = (expression: string): Promise<unknown> => instance.evaluate(expression)
    const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

    try {
      await instance.start()
      ipc.open('card', port)
      await waitFor(() => lastFrame() !== undefined)

      // CRISP: the desktop owner asks for 2x, and the frames are 2x.
      onMessage({ data: { t: 'viewport-claim', width: 800, height: 600, mobile: false, scale: 2 } })
      await waitFor(() => instance.viewportState.revision >= 2 && meta()?.revision === instance.viewportState.revision)
      await waitFor(() => (jpegSize(Buffer.from(lastFrame()?.jpeg as Uint8Array))?.width ?? 0) >= 1600)
      expect(meta().displayScale).toBeCloseTo(2)
      expect(await evaluate('devicePixelRatio')).toBe(2)

      // The card's picture stays 1x: it goes to the phone over the relay too.
      const still = await instance.snapshot()
      expect(jpegSize(Buffer.from(still as string, 'base64'))?.width).toBe(800)

      // DRAG-SELECT: the moves name the held button.
      send({ t: 'down', x: 15, y: 211 })
      for (let x = 20; x <= 300; x += 20) send({ t: 'move', x, y: 211, buttons: 1 })
      send({ t: 'up', x: 300, y: 211 })
      await settle()
      expect(String(await evaluate('getSelection().toString()'))).toMatch(/^Select this paragraph/)

      // ⌘A in a field selects its text; then a CJK word goes in WHOLE.
      send({ t: 'tap', x: 100, y: 20 })
      await settle()
      send({ t: 'key', key: 'a', code: 'KeyA', mods: 4 })
      await settle()
      expect(await evaluate('[i.selectionStart, i.selectionEnd]')).toEqual([0, 11])
      send({ t: 'text', text: '你好' })
      await settle()
      expect(await evaluate('i.value')).toBe('你好')

      // AN IME: the composition shows in the field, the result replaces it.
      send({ t: 'compose', text: 'shi' })
      await settle()
      expect(await evaluate('i.value')).toBe('你好shi')
      send({ t: 'text', text: '世' })
      await settle()
      expect(await evaluate('i.value')).toBe('你好世')

      // ⌘Z undoes in the field.
      send({ t: 'key', key: 'z', code: 'KeyZ', mods: 4 })
      await settle()
      expect(String(await evaluate('i.value')).length).toBeLessThan(3)

      // Browser shortcuts are not the page's to lose: ⌘W, ⌘Q and Ctrl+W close nothing.
      for (const [key, mods] of [['w', 4], ['q', 4], ['w', 2]] as const) {
        send({ t: 'key', key, code: `Key${key.toUpperCase()}`, mods })
      }
      await settle(300)
      expect(await evaluate('1 + 1')).toBe(2)
      expect((await instance.pageInfo()).url).toBe(`${origin}/`)

      // SIDEWAYS: a two-finger swipe's dx scrolls the page left-right.
      send({ t: 'wheel', x: 400, y: 400, dy: 0, dx: 240 })
      await waitFor(async () => Number(await evaluate('scrollX')) >= 240)

      // A TRACKPAD PINCH zooms the visual viewport.
      send({ t: 'pinch', x: 400, y: 300, scale: 1.5 })
      await waitFor(async () => Number(await evaluate('visualViewport.scale')) > 1.4)
    } finally {
      ipc.shutdown()
      await instance.stop()
    }
  }, 60_000)
})


describe.skipIf(!enabled)('phone fields, paste and copy through the port viewer, real Chromium', () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'cookrew-fields-integration-'))
  let server: http.Server
  let origin = ''

  beforeAll(async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(FIELDS_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server has no TCP address')
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('reports where the fields are, which one has focus, takes pastes both ways and hands back copies', async () => {
    const instance = new HeadlessInstance({
      executablePath: chrome as string,
      profileDir,
      width: 400,
      height: 600,
      tabs: [{ id: 'tab', url: `${origin}/`, title: '' }],
      activeTabId: 'tab'
    })
    const posted: Array<Record<string, unknown>> = []
    let onMessage: (event: { data: unknown }) => void = () => undefined
    const port: CastPort = {
      postMessage: (message) => {
        const record = message as Record<string, unknown>
        posted.push(record)
        if (record.t === 'frame') setTimeout(() => onMessage({ data: { t: 'painted', seq: record.seq } }), 0)
      },
      on: ((event: string, listener: (event: { data: unknown }) => void) => {
        if (event === 'message') onMessage = listener
      }) as CastPort['on'],
      start: () => undefined,
      close: () => undefined
    }
    const ipc = createBrowserCastIpc({ enabled: () => true, getInstance: () => Promise.resolve(instance) })
    const lastOf = (t: string): Record<string, unknown> | undefined => posted.filter((m) => m.t === t).at(-1)
    const send = (message: Record<string, unknown>): void => {
      const frame = lastOf('frame')
      if (!frame) throw new Error('no frame yet')
      const { revision, displayScale } = frame.meta as { revision: number; displayScale: number }
      const scaled = { ...message }
      for (const axis of ['x', 'y'] as const) {
        if (typeof scaled[axis] === 'number') scaled[axis] = (scaled[axis] as number) * displayScale
      }
      onMessage({ data: { ...scaled, revision, frameSeq: frame.seq } })
    }
    const evaluate = (expression: string): Promise<unknown> => instance.evaluate(expression)
    const settle = (ms = 200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    type Fields = { focus: { editable: boolean; mode: string }; fields: Array<{ rect: number[]; mode: string }> }

    try {
      await instance.start()
      ipc.open('card', port)
      await waitFor(() => lastOf('frame') !== undefined)

      // WHERE THE FIELDS ARE: three, at their places, the number field asking for numbers.
      onMessage({ data: { t: 'watch-fields' } })
      await waitFor(() => ((lastOf('fields') as Fields | undefined)?.fields.length ?? 0) === 3)
      const fields = lastOf('fields') as unknown as Fields
      const scale = (lastOf('frame')?.meta as { displayScale: number }).displayScale
      expect(fields.fields[0].rect[0] / scale).toBeCloseTo(20, 0)
      expect(fields.fields[0].rect[1] / scale).toBeCloseTo(20, 0)
      expect(fields.fields[1].mode).toBe('decimal')
      expect(fields.focus.editable).toBe(false)

      // A TAP ON ONE: the page says a field has focus — the phone keeps or closes its keyboard on that.
      send({ t: 'tap', x: 60, y: 35 })
      await waitFor(() => (lastOf('fields') as Fields | undefined)?.focus.editable === true)
      send({ t: 'tap', x: 300, y: 400 })
      await waitFor(() => (lastOf('fields') as Fields | undefined)?.focus.editable === false)

      // PASTE, PLAIN FIELD: the page leaves it alone, so it is typed in.
      send({ t: 'tap', x: 60, y: 35 })
      await settle()
      send({ t: 'paste', text: '你好 paste' })
      send({ t: 'key', key: '!', code: 'Digit1', text: '!' })
      await waitFor(async () => (await evaluate('i.value')) === '你好 paste!')

      // PASTE, AN EDITOR THAT TAKES IT OVER: it gets a real paste event with the text.
      send({ t: 'tap', x: 60, y: 160 })
      await settle()
      send({ t: 'paste', text: 'shout' })
      await waitFor(async () => (await evaluate('t.value')) === 'SHOUT')

      // COPY: a selection on the page, ⌘C, and the words come back to this viewer.
      await evaluate(`(() => { const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r) })()`)
      send({ t: 'key', key: 'c', code: 'KeyC', mods: 4 })
      await waitFor(() => lastOf('copy') !== undefined)
      expect(lastOf('copy')).toEqual({ t: 'copy', text: 'Copy these words' })
      // And Ctrl+C, the phone's Copy button.
      const copiesBefore = posted.filter((m) => m.t === 'copy').length
      send({ t: 'tap', x: 10, y: 10 })
      await evaluate(`(() => { const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r) })()`)
      send({ t: 'key', key: 'c', code: 'KeyC', mods: 2 })
      await waitFor(() => posted.filter((m) => m.t === 'copy').length > copiesBefore)
    } finally {
      ipc.shutdown()
      await instance.stop()
    }
  }, 60_000)
})

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
