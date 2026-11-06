import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createTcp, connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { createCanvasLink, type CanvasLink } from '../src/main/canvas-link'
import { createCanvasBridge, loopbackDialer } from '../src/main/canvas-bridge'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { createSocketBridge } from '../src/main/socket-bridge'
import type { LoopbackSocket, LoopbackSocketDeps } from '../src/main/ws-client'
import { BridgeWebSocket, type BridgeStream, type BridgeBody } from '../src/renderer/src/path/bridge-socket'

/**
 * THE BROWSER CARD ON A PHONE'S NETWORK, END TO END.
 *
 * Real registry, real relay, the real line and the real Mac routes, with a phone
 * behind a proxy that adds a mobile network's delay and a cap on what comes down,
 * and can cut every connection at once, as leaving the Wi-Fi does. Chrome is a
 * stand-in that sends a changing picture and stamps it with the last input it saw,
 * so input-to-picture time is measured on the whole path. Old and new protocol run
 * on the same line.
 *
 *   RELAY_LINE_E2E=1 npx vitest run tests/relay-browser-line.integration.test.ts
 */

const run = process.env.RELAY_LINE_E2E === '1' ? describe : describe.skip
const PASSWORD = 'correct horse battery staple'
const PAIRING = 'the-pairing-token-of-this-mac'
const ONE_WAY_MS = 100
const GOOD_LINE = 350 // KB/s: a good mobile link's share
const POOR_LINE = 120 // and a poor one's
const FRAME_BYTES = 45_000
const FRAME_MS = 33

interface Up {
  origin: string
  close: () => Promise<void>
}

const listen = async (server: Server): Promise<Up> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/** A phone's network: delay both ways, a cap coming down, and a way to lose it all. */
function phoneNetwork(target: number) {
  const pairs = new Set<Socket>()
  let down = false
  let bytesPerMs = GOOD_LINE
  const server = createTcp((phone) => {
    if (down) return void phone.destroy()
    const site = connect(target, '127.0.0.1')
    pairs.add(phone)
    pairs.add(site)
    let freeAt = 0
    const closeBoth = (): void => {
      phone.destroy()
      site.destroy()
      pairs.delete(phone)
      pairs.delete(site)
    }
    phone.on('data', (chunk) => {
      setTimeout(() => {
        if (!site.destroyed) site.write(chunk)
      }, ONE_WAY_MS)
    })
    site.on('data', (chunk) => {
      const now = Date.now()
      freeAt = Math.max(freeAt, now) + chunk.length / bytesPerMs
      setTimeout(() => {
        if (!phone.destroyed) phone.write(chunk)
      }, freeAt - now + ONE_WAY_MS)
    })
    for (const end of [phone, site]) {
      end.on('close', closeBoth)
      end.on('error', closeBoth)
    }
  })
  return {
    open: async (): Promise<number> => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      return (server.address() as AddressInfo).port
    },
    speed: (next: number): void => void (bytesPerMs = next),
    /** Every connection gone, and nothing new for `ms`: the move from one network to the next. */
    drop: (ms: number): void => {
      down = true
      for (const socket of [...pairs]) socket.destroy()
      setTimeout(() => void (down = false), ms)
    },
    close: () => {
      for (const socket of [...pairs]) socket.destroy()
      server.close()
    }
  }
}

/** The card's Chrome: a changing picture, stamped with the last input it saw. */
class FakeChrome {
  received: string[] = []
  lastInput = 0
  seq = 0
  still = false
  private timer: ReturnType<typeof setInterval> | null = null
  private deps: LoopbackSocketDeps | null = null
  private readonly picture = randomBytes(FRAME_BYTES).toString('base64')

  dial = (deps: LoopbackSocketDeps): LoopbackSocket => {
    this.deps = deps
    this.seq = 0
    this.received = []
    setTimeout(() => {
      deps.onOpen()
      deps.onMessage('{"t":"ready"}')
      this.timer = setInterval(() => this.frame(), FRAME_MS)
    }, 0)
    return {
      send: (text) => {
        this.received.push(text)
        const key = /"n":(\d+)/.exec(text)
        if (key) this.lastInput = Number(key[1])
      },
      close: () => {
        if (this.timer) clearInterval(this.timer)
      },
      pause: () => undefined,
      resume: () => undefined
    } as LoopbackSocket
  }

  private frame(): void {
    this.seq += 1
    // The whole of `data` changes frame to frame, as a moving page's JPEG does.
    const data = this.still ? this.picture : `${this.seq}${this.picture.slice(this.seq % 1000)}${this.picture.slice(0, this.seq % 1000)}`
    this.deps?.onMessage(JSON.stringify({ t: 'frame', seq: this.seq, data, meta: { input: this.lastInput, revision: 1 } }))
  }
}

/** The phone's stream, as rtc-plane's: fetch and a server-sent-event reader. */
function fetchStream(url: string, headers: Record<string, string>): BridgeStream {
  const listeners = new Map<string, ((event: Event) => void)[]>()
  const controller = new AbortController()
  const fire = (type: string, data?: string): void => {
    for (const listener of listeners.get(type) ?? []) listener(new MessageEvent(type, { data }))
  }
  let closed = false
  void (async () => {
    try {
      const response = await fetch(url, { headers, signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(String(response.status))
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) throw new Error('ended')
        buffer += value
        for (;;) {
          const end = buffer.indexOf('\n\n')
          if (end < 0) break
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const event = /^event: (.*)$/m.exec(block)?.[1]
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (event) fire(event, data)
        }
      }
    } catch {
      if (!closed) fire('error')
    }
  })()
  return {
    readyState: 1,
    addEventListener: (type, listener) => void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    close: () => {
      closed = true
      controller.abort()
    }
  }
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? NaN
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

run('the browser card on a phone network, through the real relay', () => {
  let site: Up
  let mac: Up
  let dir = ''
  let token = ''
  let session = ''
  let link: CanvasLink | null = null
  let net: ReturnType<typeof phoneNetwork>
  let phoneOrigin = ''
  const chrome = new FakeChrome()
  const username = 'owner'
  const deviceId = randomUUID()
  const jwkOf = (): Record<string, string> => generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'relay-line-'))
    const deps = {
      pairingToken: PAIRING,
      wallToken: 'wall',
      store: { focusedState: { nodes: [], connections: [] } },
      ptys: { get: () => undefined },
      turns: { list: () => [], seen: () => undefined },
      agents: { list: () => [] },
      ops: {},
      presets: [],
      socketBridge: createSocketBridge({ dial: chrome.dial })
    } as unknown as MobileApiDeps
    mac = await listen(
      createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        void handleMobileApi(request, response, url, deps).then((handled) => {
          if (handled) return
          response.writeHead(404)
          response.end()
        })
      })
    )
    site = await listen(
      createRegistry({
        store: new RegistryStore(dir),
        log: new TransparencyLog(dir),
        identity: new IdentityService(dir),
        doors: new DoorStore(dir, { allowPrivate: true }),
        stars: new StarStore(dir),
        origin: 'https://cookrew.dev',
        v2: createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } })
      })
    )
    const claimed = await fetch(`${site.origin}/v2/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD, device: { id: deviceId, kind: 'desktop', name: 'This Mac', jwk: jwkOf() } })
    })
    token = ((await claimed.json()) as { session: { token: string } }).session.token
    await fetch(`${site.origin}/v2/me/desktops/${deviceId}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'This Mac', workspaces: [{ id: 'w1', name: 'Cookrew Dev' }] })
    })
    const minted = await fetch(`${site.origin}/v2/me/join-codes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ current: PASSWORD })
    })
    const { code } = (await minted.json()) as { code: string }
    const joined = await fetch(`${site.origin}/v2/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, device: { id: randomUUID(), kind: 'phone', name: 'A phone', jwk: jwkOf() } })
    })
    session = ((await joined.json()) as { token: string }).token
    link = createCanvasLink({ origin: () => site.origin, credential: () => ({ token, deviceId }) })
    const bridge = createCanvasBridge({ send: (line) => link!.send(line), dial: loopbackDialer(Number(new URL(mac.origin).port)) })
    link.onFrame(bridge.frame)
    link.onDrop(bridge.reset)
    link.start()
    const deadline = Date.now() + 4000
    while (!link.held()) {
      if (Date.now() > deadline) throw new Error('the desktop never held its line')
      await sleep(10)
    }
    net = phoneNetwork(Number(new URL(site.origin).port))
    phoneOrigin = `http://127.0.0.1:${await net.open()}`
  }, 20_000)

  afterAll(async () => {
    net.close()
    link?.stop()
    await site.close()
    await mac.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const headers = (): Record<string, string> => ({ cookie: `__Host-cr_session=${session}`, authorization: `Bearer ${PAIRING}` })
  const base = (): string => `${phoneOrigin}/relay/@${username}/desktop/${deviceId}/api/socket-bridge`
  const socketPath = encodeURIComponent('/api/browser/b1/stream')

  const phone = (v2: boolean): BridgeWebSocket =>
    new BridgeWebSocket({
      stream: (resume) =>
        fetchStream(
          resume
            ? `${base()}?resume=${resume.id}&after=${resume.after}`
            : `${base()}?${v2 ? 'v=2&' : ''}path=${socketPath}`,
          headers()
        ),
      post: async (id, body: BridgeBody) => {
        const response = await fetch(`${base()}/${id}`, {
          method: 'POST',
          headers: { ...headers(), 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
        if (response.status === 404) return 'gone'
        return response.ok ? 'ok' : 'retry'
      }
    })

  /** Press a key every 300 ms; how long until a picture shows it? */
  const measure = async (v2: boolean, ms: number): Promise<{ p50: number; p90: number; last: number; fps: number; bytes: number }> => {
    const ws = phone(v2)
    await new Promise<void>((resolve) => (ws.onopen = () => resolve()))
    const sentAt = new Map<number, number>()
    const latencies: number[] = []
    let frames = 0
    let bytes = 0
    let lastAt = Date.now()
    const gaps: number[] = []
    ws.onmessage = (event) => {
      const text = String(event.data)
      if (!text.startsWith('{"t":"frame"')) return
      frames += 1
      bytes += text.length
      gaps.push(Date.now() - lastAt)
      lastAt = Date.now()
      const frame = JSON.parse(text) as { seq: number; meta: { input: number } }
      setTimeout(() => ws.painted(frame.seq), 12) // the phone's decode and draw
      for (const [n, at] of sentAt) {
        if (n <= frame.meta.input) {
          latencies.push(Date.now() - at)
          sentAt.delete(n)
        }
      }
    }
    const started = Date.now()
    let n = 0
    while (Date.now() - started < ms) {
      n += 1
      sentAt.set(n + (v2 ? 100_000 : 0), Date.now())
      ws.send(JSON.stringify({ t: 'key', key: 'a', n: n + (v2 ? 100_000 : 0) }))
      await sleep(300)
    }
    ws.close()
    await sleep(300)
    if (process.env.RELAY_LINE_TRACE) console.log('gaps', v2, gaps.join(' '), 'lat', latencies.join(' '))
    return {
      p50: percentile(latencies, 0.5),
      p90: percentile(latencies, 0.9),
      last: latencies.at(-1) ?? NaN,
      fps: frames / (ms / 1000),
      bytes: bytes / (ms / 1000)
    }
  }

  it('on a good line: more pictures, for about the same delay', async () => {
    net.speed(GOOD_LINE)
    const before = await measure(false, 8000)
    chrome.lastInput = 0
    const after = await measure(true, 8000)
    console.log('good old', JSON.stringify(before))
    console.log('good new', JSON.stringify(after))
    expect(after.fps).toBeGreaterThan(before.fps)
    expect(after.p90).toBeLessThan(before.p90 * 1.5)
  }, 40_000)

  it('on a poor line: the delay stays put where the old one kept growing', async () => {
    net.speed(POOR_LINE)
    const before = await measure(false, 12_000)
    await sleep(6000) // what the old protocol queued has to drain before the next run
    chrome.lastInput = 0
    const after = await measure(true, 12_000)
    net.speed(GOOD_LINE)
    console.log('poor old', JSON.stringify(before))
    console.log('poor new', JSON.stringify(after))
    expect(after.last).toBeLessThan(before.last)
    expect(after.p90).toBeLessThan(before.p90)
  }, 60_000)

  it('a still page stops costing pictures', async () => {
    chrome.still = true
    const ws = phone(true)
    await new Promise<void>((resolve) => (ws.onopen = () => resolve()))
    let pictures = 0
    let beats = 0
    ws.onmessage = (event) => {
      const text = String(event.data)
      if (text.startsWith('{"t":"frame"')) {
        pictures += 1
        ws.painted((JSON.parse(text) as { seq: number }).seq)
      } else if (text.startsWith('{"t":"same"')) beats += 1
    }
    await sleep(3000)
    ws.close()
    chrome.still = false
    await sleep(300)
    console.log('still page', { pictures, beats })
    expect(pictures).toBe(1)
    expect(beats).toBeGreaterThan(10)
  }, 15_000)

  it('leaving the network loses nothing: same session, every key once, in order', async () => {
    const ws = phone(true)
    await new Promise<void>((resolve) => (ws.onopen = () => resolve()))
    const seen: { at: number; text: string }[] = []
    let closed = false
    ws.onclose = () => void (closed = true)
    ws.onmessage = (event) => {
      const text = String(event.data)
      seen.push({ at: Date.now(), text: text.slice(0, 12) })
      if (text.startsWith('{"t":"frame"')) ws.painted((JSON.parse(text) as { seq: number }).seq)
    }
    const resumed: boolean[] = []
    ws.onresuming = (on) => void resumed.push(on)
    const raw = ws as unknown as { lost: () => void }
    const lost = raw.lost.bind(ws)
    raw.lost = () => {
      if (process.env.RELAY_LINE_TRACE) console.log('lost', Date.now(), new Error().stack?.split('\n').slice(2, 5).join(' | '))
      lost()
    }
    const seqBefore = chrome.seq
    for (let i = 1; i <= 40; i += 1) {
      if (i === 15) net.drop(1500)
      ws.send(JSON.stringify({ t: 'key', key: `k${i}` }))
      await sleep(100)
    }
    const droppedAt = Date.now()
    await sleep(4000)
    const keys = chrome.received.filter((t) => t.includes('"key"')).map((t) => Number(/"k(\d+)"/.exec(t)?.[1]))
    console.log('keys through a dropped line', keys.length, 'resuming', resumed, 'held the viewer', chrome.seq > seqBefore, 'quiet after', Date.now() - droppedAt)
    expect(closed).toBe(false)
    expect(resumed).toEqual([true, false])
    expect(keys).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
    ws.close()
    await sleep(200)
  }, 20_000)
})
