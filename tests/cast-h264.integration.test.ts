import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findChrome, HeadlessInstance } from '../src/main/headless-chrome'
import { CastViewer, type OutboundFrame, type ViewerSink } from '../src/main/cast-viewer'
import { createCastEncoder, type EncoderPage } from '../src/main/cast-encoder'
import { VIDEO_REFRESHES } from '../src/main/cast-video-out'
import { CAST_CODEC } from '../src/shared/cast-video'

/**
 * THE WHOLE H.264 PATH ON REAL CHROME, nothing faked in between: a card's
 * Chrome streams a page, the real CastViewer encodes it with the encoder
 * script running in a second real Chrome page (the stand-in for the hidden
 * Electron window, with the same throttling off), and the test plays the
 * phone: it acknowledges each chunk, then decodes them all with WebCodecs and
 * compares the last picture with the JPEG it was made from.
 *
 * Measured 11-24 (ten runs): 25-28 chunks for the scroll, 13-15 KB each, the
 * picture at rest 0.61 levels (of 255) from its source, and at rest one or
 * two refreshes under 1 KB, then only `same`.
 */

const chrome = findChrome()
const enabled = process.env.COOKREW_REAL_CHROME_TEST === '1' && chrome !== null

/** A page in its own Chrome, driven over CDP: the encoder window's stand-in. */
async function encoderChrome(url: string): Promise<{ page: EncoderPage; close: () => void }> {
  const profile = mkdtempSync(path.join(tmpdir(), 'cookrew-encoder-'))
  const args = [
    '--headless=new',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    // cast-encoder-window.ts: backgroundThrottling is off, so here too.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    url
  ]
  const proc: ChildProcess = spawn(chrome as string, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buf = ''
    proc.stderr?.on('data', (d) => {
      buf += String(d)
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) resolve(m[1])
    })
    setTimeout(() => reject(new Error('the encoder Chrome did not start')), 15_000)
  })
  let target: { webSocketDebuggerUrl: string; url: string } | undefined
  for (let i = 0; i < 50 && !target?.url.startsWith(url); i++) {
    await new Promise((r) => setTimeout(r, 100))
    const list = (await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
    target = list.find((t) => t.type === 'page')
  }
  const ws = new WebSocket((target as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  type Answer = { result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }
  const waiting = new Map<number, (m: Answer) => void>()
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(String(data)) as { id?: number }
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)?.(m as Answer)
      waiting.delete(m.id)
    }
  })
  const page: EncoderPage = {
    run: async <T,>(expression: string): Promise<T> => {
      const n = ++id
      const res = await new Promise<Answer>((r) => {
        waiting.set(n, r)
        ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      })
      if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 300))
      return res.result?.result?.value as T
    }
  }
  return {
    page,
    close: () => {
      ws.close()
      proc.kill('SIGKILL')
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 300)
    }
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const end = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Chunk {
  n: number
  seq: number
  key: boolean
  w: number
  h: number
  data: string
}

describe.skipIf(!enabled)('H.264 live view, end to end on real Chrome', () => {
  let server: http.Server
  let origin = ''

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      if (request.url === '/encoder') return void response.end('<title>encoder</title>')
      response.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;margin:12px">' +
          Array.from({ length: 300 }, (_, i) => `<p>Paragraph ${i}: the quick brown fox jumps over the lazy dog.</p>`).join('')
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no address')
    origin = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('switches over without a frozen picture, streams one decodable chain, sharpens at rest, then goes quiet', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-h264-card-'))
    const card = new HeadlessInstance({
      executablePath: chrome as string,
      profileDir: path.join(root, 'profile'),
      width: 720,
      height: 560,
      tabs: [{ id: 'tab-a', url: `${origin}/page`, title: '' }],
      activeTabId: 'tab-a'
    })
    const enc = await encoderChrome(`${origin}/encoder`)
    const chunks: Chunk[] = []
    const jpegs: OutboundFrame[] = []
    const controls: Record<string, unknown>[] = []
    const sources = new Map<number, string>()
    let cast: CastViewer | null = null
    const sink: ViewerSink = {
      sendControl: (message) => {
        controls.push(message)
        if (message.t !== 'vframe') return
        chunks.push(message as unknown as Chunk)
        // The phone: decoded, so acknowledged.
        setTimeout(() => cast?.handleMessage({ t: 'vack', n: message.n }), 5)
      },
      frameReady: () => true,
      sendFrame: (frame) => void jpegs.push(frame),
      onceReady: () => undefined,
      close: () => undefined
    }
    try {
      await card.start()
      card.frameListeners.add((data, meta) => void sources.set(meta.revision ?? 0, data))
      cast = new CastViewer(sink, () => undefined, 'b1', undefined, { encoder: createCastEncoder(async () => enc.page), report: () => undefined })
      cast.handleMessage({ t: 'codecs', h264: true })
      cast.attach(card)
      cast.handleMessage({ t: 'viewport-offer', width: 390, height: 700, mobile: true, scale: 2 })
      await waitFor(() => controls.some((c) => c.t === 'video'))
      expect(controls.find((c) => c.t === 'video')).toMatchObject({ codec: CAST_CODEC })
      await waitFor(() => card.viewportState.revision >= 2 && card.frameQualityInUse === 90)
      // The encoder is set up by its first chunk (~3 s on real Chrome); until then the phone had JPEG.
      await waitFor(() => chunks.some((c) => c.w === 780 && c.key), 20_000)
      expect(jpegs.length).toBeGreaterThan(0)
      const jpegsAtSwitch = jpegs.length

      for (let i = 0; i < 25; i++) {
        await card.evaluate('scrollBy(0, 60)')
        await sleep(40)
      }
      await waitFor(() => chunks.filter((c) => c.w === 780).length >= 10)
      // From the first chunk on, no JPEG.
      expect(jpegs.length).toBe(jpegsAtSwitch)

      // At rest: a few refreshes, then only `same` for Chrome's heartbeat.
      const atRest = chunks.length
      await sleep(2000)
      const quiet = chunks.length
      expect(quiet - atRest).toBeLessThanOrEqual(VIDEO_REFRESHES + 1)
      await sleep(1500)
      expect(chunks.length).toBe(quiet)
      expect(controls.some((c) => c.t === 'same')).toBe(true)

      // Every chunk in order, without a gap, starting from a key frame at the phone's size.
      expect(chunks.map((c) => c.n)).toEqual(chunks.map((_, i) => i + 1))
      const first = chunks.findIndex((c) => c.w === 780 && c.h === 1400 && c.key)
      const tail = chunks.slice(first)
      expect(tail.every((c) => c.w === 780 && c.h === 1400)).toBe(true)

      // The phone's part: decode every chunk, and compare the last picture with its source.
      await enc.page.run(
        `window.__d = { out: 0, err: null, last: null }; window.__dec = new VideoDecoder({ output: (f) => { window.__d.out++; if (window.__d.last) window.__d.last.close(); window.__d.last = f }, error: (e) => { window.__d.err = String(e) } }); __dec.configure({ codec: ${JSON.stringify(CAST_CODEC)}, optimizeForLatency: true }); true`
      )
      for (const c of tail) {
        await enc.page.run(
          `(() => { const s = atob(${JSON.stringify(c.data)}); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); __dec.decode(new EncodedVideoChunk({ type: ${c.key} ? 'key' : 'delta', timestamp: ${c.n}, data: b })); return true })()`
        )
      }
      await enc.page.run('__dec.flush().then(() => true)')
      const decoded = await enc.page.run<{ out: number; err: string | null; w: number; h: number }>(
        '({ out: __d.out, err: __d.err, w: __d.last.displayWidth, h: __d.last.displayHeight })'
      )
      expect(decoded.err).toBeNull()
      expect(decoded.out).toBe(tail.length)
      expect([decoded.w, decoded.h]).toEqual([780, 1400])
      const source = sources.get(card.viewportState.revision) as string
      const diff = await enc.page.run<number>(`(async () => {
        const s = atob(${JSON.stringify(source)}); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
        const src = await createImageBitmap(new Blob([b], { type: 'image/jpeg' }));
        const w = __d.last.displayWidth, h = __d.last.displayHeight;
        const a = new OffscreenCanvas(w, h).getContext('2d'); a.drawImage(src, 0, 0);
        const c = new OffscreenCanvas(w, h).getContext('2d'); c.drawImage(__d.last, 0, 0);
        const x = a.getImageData(0, 0, w, h).data, y = c.getImageData(0, 0, w, h).data;
        let sum = 0; for (let i = 0; i < x.length; i += 4) sum += Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
        return sum / (x.length / 4 * 3);
      })()`)
      // At rest, after sharpening: within two levels of the source on average (0-255).
      expect(diff).toBeLessThan(2)
      const chunkBytes = tail.reduce((sum, c) => sum + (c.data.length * 3) / 4, 0) / tail.length
      const sourceBytes = (source.length * 3) / 4
      expect(chunkBytes).toBeLessThan(sourceBytes / 3)
      console.info('[h264-e2e]', JSON.stringify({ chunks: tail.length, chunkKB: Math.round(chunkBytes / 102.4) / 10, sourceKB: Math.round(sourceBytes / 102.4) / 10, meanAbsDiff: Math.round(diff * 100) / 100 }))
    } finally {
      cast?.close()
      enc.close()
      await card.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
})
