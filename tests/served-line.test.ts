import { describe, expect, it, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { EventEmitter } from 'node:events'
import { handleServedLineRoute, type LinePtyView, type ServedLineDeps } from '../src/main/served-line'
import type { ServedTemplate } from '../src/main/session-served'

/**
 * THE CALLER'S LINE — route behavior over a real socket.
 *
 * The gate itself is the SHARED gateCaller (covered through /ask in
 * served-endpoints tests); here it is a seam, so these tests pin what the
 * line does AROUND it: refusals pass through verbatim, a stream mints, raw
 * input never mints, and listener cleanup follows the socket.
 */

class FakeView extends EventEmitter implements LinePtyView {
  resized: Array<[number, number]> = []
  geometry(): unknown {
    return { cols: 100, rows: 30 }
  }
  replayFrame(): string {
    return 'FRAME<initial>'
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows])
  }
}

const TEMPLATE = { serviceId: 'svc-research-crew', slug: 'research-crew' } as ServedTemplate

interface Harness {
  origin: string
  view: FakeView
  writes: string[]
  minted: string[]
  close: () => Promise<void>
}

function harness(overrides: Partial<ServedLineDeps> = {}): Promise<Harness> {
  const view = new FakeView()
  const writes: string[] = []
  const minted: string[] = []
  const deps: ServedLineDeps = {
    gate: async (headers) =>
      headers.authorization === 'Bearer good'
        ? { ok: true, claims: { sub: 'alice' } }
        : {
            ok: false,
            response: { status: 401, headers: { 'www-authenticate': 'Cookrew challenge=x' }, body: {} }
          },
    admit: async (serviceId, sub) => {
      minted.push(`${serviceId}/${sub}`)
      return { sessionId: 'sess-1', created: true }
    },
    conductorFor: () => 'term-conductor',
    openConductorFor: (_service, sub) => (sub === 'alice' ? 'term-conductor' : null),
    attach: async () => view,
    write: async (_id, data) => {
      writes.push(data)
      return { ok: true }
    },
    ...overrides
  }
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => (raw += chunk))
      request.on('end', () => {
        let body: unknown = null
        try {
          body = JSON.parse(raw)
        } catch {
          body = null
        }
        const url = new URL(request.url ?? '/', 'http://x')
        const headers: Record<string, string | undefined> = {}
        for (const [key, value] of Object.entries(request.headers)) {
          headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value
        }
        void handleServedLineRoute(
          deps,
          TEMPLATE,
          request.method ?? 'GET',
          url.pathname,
          { headers, body, request, response }
        ).then((handled) => {
          if (!handled) {
            response.writeHead(404)
            response.end()
          }
        })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        origin: `http://127.0.0.1:${port}`,
        view,
        writes,
        minted,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}

let open: Harness | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

describe('the caller line — served PTY over the door', () => {
  it('a path outside the line surface falls through', async () => {
    open = await harness()
    const res = await fetch(`${open.origin}/other`)
    expect(res.status).toBe(404)
  })

  it('a gate refusal passes through verbatim, headers included', async () => {
    open = await harness()
    const res = await fetch(`${open.origin}/line`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('challenge=')
  })

  it('an admitted stream mints once and opens with geometry, then the frame', async () => {
    open = await harness()
    const res = await fetch(`${open.origin}/line`, {
      headers: { authorization: 'Bearer good', 'accept-encoding': 'identity' }
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(open.minted).toEqual(['svc-research-crew/alice'])

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (!text.includes('FRAME<initial>')) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    const helloAt = text.indexOf('event: hello')
    const frameAt = text.indexOf('FRAME<initial>')
    expect(helloAt).toBeGreaterThanOrEqual(0)
    expect(frameAt).toBeGreaterThan(helloAt)
    expect(text).toContain('"sessionId":"sess-1"')
    expect(text).toContain('"created":true')

    // Live bytes follow on the same stream.
    open.view.emit('data', 'delta-bytes')
    let more = text
    while (!more.includes('delta-bytes')) {
      const { value, done } = await reader.read()
      if (done) break
      more += decoder.decode(value, { stream: true })
    }
    expect(more).toContain('delta-bytes')

    // Closing the request detaches every listener — no leak per viewer.
    await reader.cancel()
    for (let i = 0; i < 40 && open.view.listenerCount('data') > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(open.view.listenerCount('data')).toBe(0)
    expect(open.view.listenerCount('replay')).toBe(0)
    expect(open.view.listenerCount('exit')).toBe(0)
  })

  it('raw input never mints: no open session is a 404, not a fresh charge', async () => {
    open = await harness({ openConductorFor: () => null })
    const res = await fetch(`${open.origin}/line/raw`, {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'ls\r' })
    })
    expect(res.status).toBe(404)
    expect(open.minted).toEqual([])
    expect(open.writes).toEqual([])
  })

  it('keystrokes ride the submit primitive; a refusal is a 409, not a drop', async () => {
    open = await harness()
    const ok = await fetch(`${open.origin}/line/raw`, {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'hello\r' })
    })
    expect(ok.status).toBe(200)
    expect(open.writes).toEqual(['hello\r'])

    await open.close()
    open = await harness({ write: async () => ({ ok: false, reason: 'dispatch in flight' }) })
    const refused = await fetch(`${open.origin}/line/raw`, {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'hello\r' })
    })
    expect(refused.status).toBe(409)
  })

  it('a keystroke burst beyond the bound is refused as too large', async () => {
    open = await harness()
    const res = await fetch(`${open.origin}/line/raw`, {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(9000) })
    })
    expect(res.status).toBe(413)
    expect(open.writes).toEqual([])
  })

  it('resize applies clamped geometry to the open session only', async () => {
    open = await harness()
    const res = await fetch(`${open.origin}/line/resize`, {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 9999, rows: 42 })
    })
    expect(res.status).toBe(200)
    expect(open.view.resized).toEqual([[500, 42]])
  })
})
