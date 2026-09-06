import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { handle, handleUpgrade, type MobileServerDeps } from '../src/main/mobile-server'

/**
 * THE STREAMING PATH, TESTED ON ITS OWN — because it is the one that gets
 * forgotten.
 *
 * Docker's gateway shipped a DNS-rebinding hole specifically in its
 * event-stream mode: the ordinary routes were covered and the long-lived one
 * was not. An SSE stream is the worst thing to leave open, too — it is not one
 * answer to one rebound request, it is a live tap on the canvas that keeps
 * delivering for as long as the page stays loaded.
 *
 * So each of these is asserted for a STREAM rather than inferred from a JSON
 * route: a wrong Host is refused; an unauthenticated stream is refused; the
 * pairing token is required exactly as it is on ordinary routes; a stream that
 * came down the relay bridge is allowed; and a forged relay marker from a
 * non-loopback peer is not. Both planes are covered — the direct origin (the
 * Mac's own name) and the relay prefix (`x-cookrew-base`, which the registry
 * sets after stripping it from the path).
 */

const TOKEN = 'pairing-token-for-the-stream'
const STREAM = '/api/terminal/t1/stream'
/** Loopback is always in the allow-list, so these tests need no interfaces. */
const OURS = 'localhost:8639'
/** What the bridge writes over whatever the caller sent (canvas-bridge). */
const BRIDGE = '127.0.0.1:8639'
const RELAY_PREFIX = '/relay/@ada/desktop/3f2b9c14-7a55-4d2e-9d0f-1c8e6b4a7f30'

class FakePty extends EventEmitter {
  geometry(): { cols: number; rows: number } {
    return { cols: 100, rows: 30 }
  }

  replayFrame(): string {
    return 'transcript'
  }
}

interface Captured {
  status: number
  headers: Record<string, string>
  set: Record<string, string>
  body: string
}

function fakeResponse(request: http.IncomingMessage): {
  response: http.ServerResponse
  captured: Captured
} {
  const captured: Captured = { status: 0, headers: {}, set: {}, body: '' }
  const emitter = new EventEmitter()
  const response = Object.assign(emitter, {
    req: request,
    setHeader(name: string, value: string) {
      captured.set[name.toLowerCase()] = value
    },
    writeHead(status: number, headers: Record<string, string> = {}) {
      captured.status = status
      captured.headers = { ...captured.set, ...headers }
      return response
    },
    write(chunk: string | Buffer) {
      captured.body += chunk.toString()
      return true
    },
    end(chunk?: string | Buffer) {
      if (chunk) captured.body += chunk.toString()
      emitter.emit('close')
    },
    destroy: vi.fn()
  }) as unknown as http.ServerResponse
  return { response, captured }
}

function streamRequest(over: {
  host?: string | string[]
  url?: string
  headers?: Record<string, string | string[]>
  peer?: string
}): http.IncomingMessage {
  const request = new EventEmitter() as http.IncomingMessage
  request.method = 'GET'
  request.url = over.url ?? STREAM
  request.headers = { ...(over.headers ?? {}) }
  if (over.host !== undefined) (request.headers as Record<string, unknown>).host = over.host
  Object.assign(request, { socket: { remoteAddress: over.peer ?? '192.168.2.77' } })
  return request
}

/** Every dep the stream route touches, and a counter for the ones it must not. */
function deps(): { value: MobileServerDeps; ptyReads: string[] } {
  const ptyReads: string[] = []
  const value = {
    multiInstance: () => false,
    store: { focusedId: 'w1' },
    ptys: {
      get: (id: string) => {
        ptyReads.push(id)
        return new FakePty()
      }
    },
    turns: { list: () => [] },
    ops: { listWorkspaces: () => [] },
    presets: [],
    traces: { latestCheckpoint: () => null },
    interactiveBrowserEnabled: () => false,
    pairingToken: TOKEN,
    rendererDir: '/nonexistent'
  } as unknown as MobileServerDeps
  return { value, ptyReads }
}

async function openStream(over: Parameters<typeof streamRequest>[0]): Promise<{
  captured: Captured
  ptyReads: string[]
}> {
  const request = streamRequest(over)
  const { response, captured } = fakeResponse(request)
  const { value, ptyReads } = deps()
  await handle(request, response, value)
  return { captured, ptyReads }
}

describe('an event stream a rebound page opens', () => {
  it('is refused 421 on the Host, before auth and before the PTY is touched', async () => {
    const { captured, ptyReads } = await openStream({
      host: 'evil.example',
      // The credential the victim's own browser would attach makes no
      // difference: the request is answered on the name, first.
      url: `${STREAM}?token=${TOKEN}`
    })
    expect(captured.status).toBe(421)
    expect(captured.headers['content-type']).toMatch(/text\/plain/)
    expect(captured.body).not.toContain('transcript')
    expect(ptyReads).toEqual([])
  })

  it('carries no allow-origin header a script could read the refusal with', async () => {
    const { captured } = await openStream({
      host: 'evil.example',
      headers: { origin: 'https://evil.example' }
    })
    expect(captured.status).toBe(421)
    expect(captured.headers['access-control-allow-origin']).toBeUndefined()
    expect(captured.set['access-control-allow-origin']).toBeUndefined()
    // The gate runs ahead of the CORS gate, so not even a preflight is answered.
    expect(captured.headers.vary).toBe('origin')
  })

  it('is refused whether or not it names the port we listen on', async () => {
    for (const host of ['evil.example', 'evil.example:8643', 'localhost.evil.example']) {
      expect((await openStream({ host })).captured.status, host).toBe(421)
    }
  })
})

describe('an event stream on a Host we do answer for', () => {
  it('is refused 401 with no token — a stream is a read, and reads are gated', async () => {
    const { captured, ptyReads } = await openStream({ host: OURS })
    expect(captured.status).toBe(401)
    expect(captured.body).toMatch(/Unauthorized/)
    expect(ptyReads).toEqual([])
  })

  it('is refused 401 with the wrong token', async () => {
    const { captured } = await openStream({ host: OURS, url: `${STREAM}?token=not-the-token` })
    expect(captured.status).toBe(401)
  })

  it('opens for the pairing token in the query — EventSource cannot set headers', async () => {
    const { captured, ptyReads } = await openStream({ host: OURS, url: `${STREAM}?token=${TOKEN}` })
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('text/event-stream')
    expect(captured.body).toContain('transcript')
    expect(ptyReads).toEqual(['t1'])
  })

  it('opens for the same token as a bearer header — exactly the ordinary rule', async () => {
    const { captured } = await openStream({
      host: OURS,
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('text/event-stream')
  })
})

describe('an event stream that came down the relay bridge', () => {
  const relayHeaders = { 'x-cookrew-relay': '1', 'x-cookrew-base': RELAY_PREFIX }

  it('is allowed: the bridge dials 127.0.0.1 here and writes the Host itself', async () => {
    const { captured } = await openStream({
      host: BRIDGE,
      peer: '127.0.0.1',
      url: `${STREAM}?token=${TOKEN}`,
      headers: relayHeaders
    })
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('text/event-stream')
  })

  it('is allowed even when the bridge presents the registry’s own Host', async () => {
    const { captured } = await openStream({
      host: 'cookrew.dev',
      peer: '::ffff:127.0.0.1',
      url: `${STREAM}?token=${TOKEN}`,
      headers: relayHeaders
    })
    expect(captured.status).toBe(200)
  })

  it('still requires the pairing token — the marker is a route, not a credential', async () => {
    const { captured } = await openStream({
      host: BRIDGE,
      peer: '127.0.0.1',
      headers: relayHeaders
    })
    expect(captured.status).toBe(401)
  })

  it('is refused when the marker is forged from a peer that is not loopback', async () => {
    const { captured, ptyReads } = await openStream({
      host: 'evil.example',
      peer: '192.168.2.77',
      url: `${STREAM}?token=${TOKEN}`,
      headers: relayHeaders
    })
    expect(captured.status).toBe(421)
    expect(ptyReads).toEqual([])
  })
})

describe('the WebSocket upgrade, which never reaches handle()', () => {
  const upgrade = (over: Parameters<typeof streamRequest>[0]): {
    written: string
    destroyed: boolean
    reached: boolean
  } => {
    const state = { written: '', destroyed: false, reached: false }
    const socket = {
      write: (chunk: string) => {
        state.written += chunk
        return true
      },
      destroy: () => {
        state.destroyed = true
      }
    } as unknown as Duplex
    const request = streamRequest({ url: '/api/browser/b1/stream?w=390&h=844', ...over })
    handleUpgrade(
      { ...deps().value, onUpgrade: () => void (state.reached = true) },
      request,
      socket,
      Buffer.alloc(0)
    )
    return state
  }

  it('refuses a rebound page on the Host before the socket is ever handed on', () => {
    const state = upgrade({ host: 'evil.example', headers: { origin: 'https://evil.example' } })
    expect(state.reached).toBe(false)
    expect(state.destroyed).toBe(true)
    expect(state.written).toMatch(/^HTTP\/1\.1 421 Misdirected Request/)
    expect(state.written).not.toContain('101')
  })

  it('refuses an absent Host as 400 rather than letting the handshake through', () => {
    const state = upgrade({})
    expect(state.reached).toBe(false)
    expect(state.written).toMatch(/^HTTP\/1\.1 400 Bad Request/)
  })

  it('hands a socket on a Host we answer for to the cast, which authenticates it', () => {
    expect(upgrade({ host: OURS }).reached).toBe(true)
  })

  it('hands a relayed socket on, and refuses a forged marker from the LAN', () => {
    const relayHeaders = { 'x-cookrew-relay': '1', 'x-cookrew-base': RELAY_PREFIX }
    expect(upgrade({ host: BRIDGE, peer: '127.0.0.1', headers: relayHeaders }).reached).toBe(true)
    const forged = upgrade({ host: 'evil.example', peer: '192.168.2.77', headers: relayHeaders })
    expect(forged.reached).toBe(false)
    expect(forged.written).toMatch(/421/)
  })
})
