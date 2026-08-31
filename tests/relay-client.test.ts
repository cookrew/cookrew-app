import { describe, expect, it } from 'vitest'
import {
  RelayRefused,
  attachDoorToRelay,
  type RelayResponse,
  type RelaySocket
} from '../src/main/relay-client'
import { decodeFrame, encodeFrame, type RelayFrame } from '../src/shared/relay-frame'

/**
 * THE DOOR SIDE OF THE RELAY, over a socket that is not a network.
 *
 * The claims worth holding are about AUTHORITY and CONTAINMENT: the relay adds
 * none of the former, and a connection published for one team must not become
 * a way to reach the rest of the owner's app.
 */

function fakeSocket(): RelaySocket & { sent: RelayFrame[]; deliver: (f: unknown) => void; hangUp: () => void } {
  const listeners: ((data: string) => void)[] = []
  const closers: (() => void)[] = []
  const sent: RelayFrame[] = []
  return {
    sent,
    send: (data) => {
      const frame = decodeFrame(data)
      if (frame) sent.push(frame)
    },
    close: () => closers.forEach((c) => c()),
    onMessage: (listener) => listeners.push(listener),
    onClose: (listener) => closers.push(listener),
    deliver: (frame) => listeners.forEach((l) => l(typeof frame === 'string' ? frame : JSON.stringify(frame))),
    hangUp: () => closers.forEach((c) => c())
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the seal guard', () => {
  it('refuses a remote relay while the frames are still plaintext', () => {
    expect(() =>
      attachDoorToRelay(fakeSocket(), 'wss://cookrew.dev/relay', {
        slug: 'x',
        handle: async () => ({ status: 200, headers: {} })
      })
    ).toThrow(RelayRefused)
  })

  it('allows loopback, where plaintext never leaves the machine', () => {
    expect(() =>
      attachDoorToRelay(fakeSocket(), 'ws://127.0.0.1:9999/relay', {
        slug: 'x',
        handle: async () => ({ status: 200, headers: {} })
      })
    ).not.toThrow()
  })

  it('allows a remote relay once the channel is sealed', () => {
    expect(() =>
      attachDoorToRelay(fakeSocket(), 'wss://cookrew.dev/relay', {
        slug: 'x',
        sealed: true,
        handle: async () => ({ status: 200, headers: {} })
      })
    ).not.toThrow()
  })
})

describe('a relayed request is the same request', () => {
  it('answers a GET under the door’s own slug', async () => {
    const socket = fakeSocket()
    const seen: { method: string; path: string }[] = []
    attachDoorToRelay(socket, 'ws://127.0.0.1:1/relay', {
      slug: 'cookrew-alpha',
      handle: async (req) => {
        seen.push({ method: req.method, path: req.path })
        return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"door":"Pilot"}' }
      }
    })
    socket.deliver({ t: 'open', id: 's1', method: 'GET', path: '/crew', headers: {} })
    await settle()

    // The slug is prepended by the DOOR, so a caller cannot name another team.
    expect(seen).toEqual([{ method: 'GET', path: '/cookrew-alpha/crew' }])
    expect(socket.sent.map((f) => f.t)).toEqual(['head', 'chunk', 'end'])
    expect(socket.sent[0]).toMatchObject({ status: 200 })
  })

  it('waits for a POST body before answering', async () => {
    const socket = fakeSocket()
    let bodySeen = ''
    attachDoorToRelay(socket, 'ws://127.0.0.1:1/relay', {
      slug: 'team',
      handle: async (req) => {
        bodySeen = req.body
        return { status: 200, headers: {}, body: 'ok' }
      }
    })
    socket.deliver({ t: 'open', id: 's1', method: 'POST', path: '/ask', headers: {} })
    socket.deliver({ t: 'body', id: 's1', data: '{"prompt":"hi' })
    await settle()
    expect(socket.sent).toHaveLength(0) // nothing answered yet

    socket.deliver({ t: 'body', id: 's1', data: '"}', done: true })
    await settle()
    expect(bodySeen).toBe('{"prompt":"hi"}')
    expect(socket.sent.map((f) => f.t)).toEqual(['head', 'chunk', 'end'])
  })

  it('carries the line as a stream, and stops it when the caller hangs up', async () => {
    const socket = fakeSocket()
    const pushes: ((chunk: string) => void)[] = []
    let cancelled = false
    attachDoorToRelay(socket, 'ws://127.0.0.1:1/relay', {
      slug: 'team',
      handle: async (): Promise<RelayResponse> => ({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        stream: (write) => {
          pushes.push(write)
          return () => {
            cancelled = true
          }
        }
      })
    })
    socket.deliver({ t: 'open', id: 's1', method: 'GET', path: '/line', headers: {} })
    await settle()
    expect(socket.sent.map((f) => f.t)).toEqual(['head'])

    pushes[0]?.('event: hello\n\n')
    pushes[0]?.('data: bytes\n\n')
    expect(socket.sent.filter((f) => f.t === 'chunk')).toHaveLength(2)

    // The caller closed their card. The door must stop feeding the stream.
    socket.deliver({ t: 'end', id: 's1' })
    expect(cancelled).toBe(true)
  })
})

describe('containment', () => {
  it('refuses any path outside the door, and never calls the handler', async () => {
    const socket = fakeSocket()
    let called = 0
    attachDoorToRelay(socket, 'ws://127.0.0.1:1/relay', {
      slug: 'team',
      handle: async () => {
        called += 1
        return { status: 200, headers: {} }
      }
    })
    for (const path of ['/api/terminal/abc/raw', '/api/workspace', '/api/events']) {
      socket.deliver({ t: 'open', id: `s-${path}`, method: 'GET', path, headers: {} })
    }
    await settle()
    expect(called).toBe(0)
    expect(socket.sent.every((f) => f.t === 'abort')).toBe(true)
  })

  it('a handler that throws aborts one exchange, never the connection', async () => {
    const socket = fakeSocket()
    let attempt = 0
    attachDoorToRelay(socket, 'ws://127.0.0.1:1/relay', {
      slug: 'team',
      handle: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('boom')
        return { status: 200, headers: {}, body: 'fine' }
      }
    })
    socket.deliver({ t: 'open', id: 's1', method: 'GET', path: '/crew', headers: {} })
    await settle()
    expect(socket.sent).toEqual([{ t: 'abort', id: 's1', reason: 'door-error' }])

    // The next caller is unaffected.
    socket.deliver({ t: 'open', id: 's2', method: 'GET', path: '/crew', headers: {} })
    await settle()
    expect(
      socket.sent.filter((f) => 'id' in f && f.id === 's2').map((f) => f.t)
    ).toEqual(['head', 'chunk', 'end'])
  })

  it('refuses a body that would make the door buffer without bound', async () => {
    const socket = fakeSocket()
    let called = 0
    attachDoorToRelay(socket, 'ws://127.0.0.1:1/relay', {
      slug: 'team',
      handle: async () => {
        called += 1
        return { status: 200, headers: {} }
      }
    })
    socket.deliver({ t: 'open', id: 's1', method: 'POST', path: '/ask', headers: {} })
    for (let i = 0; i < 40; i += 1) {
      socket.deliver({ t: 'body', id: 's1', data: 'x'.repeat(16 * 1024) })
    }
    await settle()
    expect(called).toBe(0)
    expect(socket.sent.some((f) => f.t === 'abort' && f.reason === 'body-too-large')).toBe(true)
  })

  it('an unparseable message gets no answer at all', async () => {
    const socket = fakeSocket()
    attachDoorToRelay(socket, 'ws://127.0.0.1:1/relay', {
      slug: 'team',
      handle: async () => ({ status: 200, headers: {} })
    })
    socket.deliver('not json')
    socket.deliver(JSON.stringify({ t: 'unknown' }))
    await settle()
    // Silence: answering would tell whoever sent it that something is here.
    expect(socket.sent).toHaveLength(0)
  })

  it('a dropped connection stops every stream it was feeding', async () => {
    const socket = fakeSocket()
    const cancelled: string[] = []
    attachDoorToRelay(socket, 'ws://127.0.0.1:1/relay', {
      slug: 'team',
      handle: async (req): Promise<RelayResponse> => ({
        status: 200,
        headers: {},
        stream: () => () => cancelled.push(req.path)
      })
    })
    socket.deliver({ t: 'open', id: 's1', method: 'GET', path: '/line', headers: {} })
    socket.deliver({ t: 'open', id: 's2', method: 'GET', path: '/turns', headers: {} })
    await settle()
    socket.hangUp()
    expect(cancelled.sort()).toEqual(['/team/line', '/team/turns'])
  })
})
