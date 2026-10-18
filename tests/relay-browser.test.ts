// THE BROWSER CARD ON THE RELAY, AND A TAILNET THAT IS NOT WORTH IT
// (2026-10-18: "relay can't open the browser; tailnet opens nothing").
import http from 'node:http'
import { describe, expect, it } from 'vitest'
import { bridgeablePath, createSocketBridge } from '../src/main/socket-bridge'
import type { LoopbackSocket, LoopbackSocketDeps } from '../src/main/ws-client'
import { BridgeWebSocket, type BridgeStream } from '../src/renderer/src/path/bridge-socket'
import { tailnetWorthIt, TAILNET_WARM_MAX_MS, warmRoundTrip } from '../src/renderer/src/path/plane-quality'
import { switchPlaneIfBetter, type PlaneSwitchDeps } from '../src/renderer/src/path/plane-switch'

describe('which sockets may be bridged', () => {
  it('is the browser card stream and nothing else', () => {
    expect(bridgeablePath('/api/browser/b1/stream?w=390&h=700&token=t')).toBe(true)
    expect(bridgeablePath('/api/browser/b1/stream')).toBe(true)
    expect(bridgeablePath('/api/terminal/t1/stream')).toBe(false)
    expect(bridgeablePath('/api/browser/b1/stream/../../secrets')).toBe(false)
    expect(bridgeablePath('http://evil/api/browser/b1/stream')).toBe(false)
  })
})

describe('the Mac end of the bridge', () => {
  it('dials the socket, streams its messages down, and takes messages up', async () => {
    const sent: string[] = []
    let deps!: LoopbackSocketDeps
    let closed = false
    const bridge = createSocketBridge({
      dial: (d) => {
        deps = d
        return { send: (t) => void sent.push(t), close: () => void (closed = true), pause: () => undefined, resume: () => undefined } satisfies LoopbackSocket
      }
    })
    const server = http.createServer((req, res) => {
      if (!bridge.open('/api/browser/b1/stream?token=t', res)) res.writeHead(400).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const body: string[] = []
    const done = new Promise<void>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { 'accept-encoding': 'identity' } }, (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body.push(chunk)
          if (body.join('').includes('event: m')) resolve()
        })
      })
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(deps.path).toBe('/api/browser/b1/stream?token=t')
    deps.onOpen()
    deps.onMessage('{"t":"ready"}')
    await done
    const text = body.join('')
    const id = /event: id\ndata: \{"id":"([0-9a-f-]{36})"\}/.exec(text)?.[1]
    expect(id).toBeDefined()
    expect(text).toContain('event: m\ndata: "{\\"t\\":\\"ready\\"}"')
    expect(bridge.post(id!, ['{"t":"offer"}'])).toBe(true)
    expect(sent).toEqual(['{"t":"offer"}'])
    expect(bridge.post('00000000-0000-0000-0000-000000000000', ['x'])).toBe(false)
    server.closeAllConnections()
    server.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(closed).toBe(true)
    expect(bridge.size()).toBe(0)
  })

  it('refuses a path that is not the browser stream, and refuses when full', () => {
    const bridge = createSocketBridge({ max: 0, dial: () => ({ send: () => undefined, close: () => undefined, pause: () => undefined, resume: () => undefined }) })
    const res = { writeHead: () => res, on: () => res, write: () => true, end: () => undefined } as unknown as http.ServerResponse
    expect(bridge.open('/api/terminal/t1/stream', res)).toBe(false)
    expect(bridge.open('/api/browser/b1/stream', res)).toBe(false)
  })
})

class FakeStream extends EventTarget implements BridgeStream {
  readyState = 0
  closed = false
  close(): void {
    this.closed = true
    this.readyState = 2
  }
  emit(type: string, data: unknown): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
}

describe('the phone end of the bridge', () => {
  it('opens on the session id, hands messages over whole, and posts in order, batched behind one in flight', async () => {
    const stream = new FakeStream()
    const posts: string[][] = []
    let release: (ok: boolean) => void = () => undefined
    const ws = new BridgeWebSocket({
      stream: () => stream,
      post: (_id, m) => {
        posts.push([...m])
        return new Promise((r) => (release = r))
      }
    })
    const seen: string[] = []
    ws.onopen = () => void seen.push(`open:${ws.readyState}`)
    ws.onmessage = (e) => void seen.push(`m:${String(e.data)}`)
    expect(() => ws.send('early')).toThrow()
    stream.emit('id', { id: 'abc' })
    stream.emit('m', '{"t":"frame"}')
    ws.send('a')
    ws.send('b')
    ws.send('c')
    expect(posts).toEqual([['a']])
    release(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(posts).toEqual([['a'], ['b', 'c']])
    expect(seen).toEqual(['open:1', 'm:{"t":"frame"}'])
  })

  it('closes, with an error, when the stream drops or the Mac forgets the session — the card reopens', async () => {
    const stream = new FakeStream()
    const ws = new BridgeWebSocket({ stream: () => stream, post: async () => false })
    const seen: string[] = []
    ws.onerror = () => void seen.push('error')
    ws.onclose = () => void seen.push('close')
    stream.emit('id', { id: 'abc' })
    ws.send('x')
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(['error', 'close'])
    expect(stream.closed).toBe(true)
  })
})

describe('a tailnet worth moving onto', () => {
  it('beats the relay on a warm connection, under a ceiling', () => {
    expect(tailnetWorthIt(150, 900)).toBe(true)
    expect(tailnetWorthIt(150, 100)).toBe(true) // plainly fast
    expect(tailnetWorthIt(400, 500)).toBe(true)
    expect(tailnetWorthIt(600, 300)).toBe(false) // slower than the relay
    expect(tailnetWorthIt(TAILNET_WARM_MAX_MS + 1, 5000)).toBe(false)
    expect(tailnetWorthIt(null, 300)).toBe(false) // the warm hellos did not come back
    expect(tailnetWorthIt(500, null)).toBe(true) // nothing to compare against yet
  })

  it('times the faster of two answered round trips', async () => {
    let t = 0
    const times = [300, 120]
    const ms = await warmRoundTrip(async () => {
      t += times.shift() ?? 0
      return true
    }, 2, () => t)
    expect(ms).toBe(120)
    expect(await warmRoundTrip(async () => false)).toBeNull()
  })

  it('keeps the phone where it is when the winner is slower — outcome "slower", nothing adopted', async () => {
    const DEVICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const TAIL = `https://100-68-81-64.${DEVICE}.d.cookrew.dev:8643`
    let adopted = 0
    const deps: PlaneSwitchDeps = {
      plane: () => ({ origin: '', kind: 'relay' }),
      card: async () => ({ deviceId: DEVICE, lan: [], tailnet: null, trusted: [TAIL] }),
      hello: async (origin, nonce) => ({ ok: true, reply: { v: 2, deviceId: DEVICE, origin, issuedAtMs: 1, nonce, sig: 's' } }),
      verify: async () => true,
      adopt: () => void (adopted += 1),
      nonce: () => 'n',
      worthIt: async () => false
    }
    expect(await switchPlaneIfBetter(deps)).toBe('slower')
    expect(adopted).toBe(0)
    expect(await switchPlaneIfBetter({ ...deps, worthIt: async () => true })).toBe('switched')
  })
})
