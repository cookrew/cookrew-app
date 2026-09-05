import { describe, expect, it } from 'vitest'
import { RelayHub, type HubSocket } from '../registry/src/relay-hub'
import { attachDoorToRelay, type RelayResponse, type RelaySocket } from '../src/main/relay-client'
import { decodeFrame, encodeFrame, type RelayFrame } from '../src/shared/relay-frame'

/**
 * THE WHOLE RELAY, both halves, no network.
 *
 * The two sides were tested apart; this is the claim that matters to a person:
 * a request made from outside reaches a door that cannot be dialled, and the
 * answer — including a live stream — comes back. If this passes, what remains
 * before it is real is a socket and a deployment, not a design.
 */

/** Wire the door client's socket into the hub, both directions. */
function connectDoor(hub: RelayHub, name: string): { door: RelaySocket; detach: () => void; deps: () => void } {
  const listeners: ((data: string) => void)[] = []
  const closers: (() => void)[] = []
  // What the HUB sends to the door.
  const toDoor: HubSocket = {
    send: (data) => listeners.forEach((l) => l(data)),
    close: () => closers.forEach((c) => c())
  }
  // What the DOOR sends back to the hub.
  const door: RelaySocket = {
    send: (data) => hub.fromDoor(name, data),
    close: () => hub.closeDoor(name),
    onMessage: (listener) => listeners.push(listener),
    onClose: (listener) => closers.push(listener)
  }
  hub.openDoor(name, toDoor)
  return { door, detach: () => hub.closeDoor(name), deps: () => undefined }
}

function callerSocket(): HubSocket & { got: RelayFrame[] } {
  const got: RelayFrame[] = []
  return {
    got,
    send: (data) => {
      const frame = decodeFrame(data)
      if (frame) got.push(frame)
    },
    close: () => undefined
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const NAME = '@drej/cookrew-alpha'

describe('a call reaches a door that cannot be dialled', () => {
  it('carries a request and its answer, end to end', async () => {
    const hub = new RelayHub()
    const { door } = connectDoor(hub, NAME)
    const seen: string[] = []
    attachDoorToRelay(door, 'ws://127.0.0.1:1/relay', {
      slug: 'cookrew-alpha',
      handle: async (request) => {
        seen.push(`${request.method} ${request.path}`)
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"door":"Pilot","access":"paid"}'
        }
      }
    })

    const caller = callerSocket()
    const opened = hub.openStream(NAME, caller, { method: 'GET', path: '/crew', headers: {} })
    expect(opened.ok).toBe(true)
    await settle()

    // The door answered its OWN slug — the caller never named the team.
    expect(seen).toEqual(['GET /cookrew-alpha/crew'])
    expect(caller.got.map((f) => f.t)).toEqual(['head', 'chunk', 'end'])
    const chunk = caller.got.find((f) => f.t === 'chunk')
    expect(chunk?.t === 'chunk' && JSON.parse(chunk.data).door).toBe('Pilot')
    // Both ends let the exchange go.
    expect(hub.stats()).toEqual({ doors: 1, streams: 0 })
  })

  it('carries a POST with a body, in pieces', async () => {
    const hub = new RelayHub()
    const { door } = connectDoor(hub, NAME)
    let received = ''
    attachDoorToRelay(door, 'ws://127.0.0.1:1/relay', {
      slug: 'alpha',
      handle: async (request) => {
        received = request.body
        return { status: 200, headers: {}, body: '{"reply":"51"}' }
      }
    })

    const caller = callerSocket()
    const s = hub.openStream(NAME, caller, { method: 'POST', path: '/ask', headers: {} })
    if (!s.ok) return
    hub.fromCaller(s.id, caller, encodeFrame({ t: 'body', id: s.id, data: '{"prompt":"17' }))
    hub.fromCaller(s.id, caller, encodeFrame({ t: 'body', id: s.id, data: ' * 3"}', done: true }))
    await settle()

    expect(received).toBe('{"prompt":"17 * 3"}')
    const chunk = caller.got.find((f) => f.t === 'chunk')
    expect(chunk?.t === 'chunk' && chunk.data).toContain('51')
  })

  it('carries the LINE — a stream that stays open and keeps arriving', async () => {
    const hub = new RelayHub()
    const { door } = connectDoor(hub, NAME)
    const pushes: ((chunk: string) => void)[] = []
    let stopped = false
    attachDoorToRelay(door, 'ws://127.0.0.1:1/relay', {
      slug: 'alpha',
      handle: async (): Promise<RelayResponse> => ({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        stream: (write) => {
          pushes.push(write)
          return () => {
            stopped = true
          }
        }
      })
    })

    const caller = callerSocket()
    const s = hub.openStream(NAME, caller, { method: 'GET', path: '/line', headers: {} })
    if (!s.ok) return
    await settle()
    expect(caller.got.map((f) => f.t)).toEqual(['head'])

    pushes[0]?.('event: hello\ndata: {"cols":100}\n\n')
    pushes[0]?.('event: data\ndata: "\\u001b[2mFRAME"\n\n')
    expect(caller.got.filter((f) => f.t === 'chunk')).toHaveLength(2)

    // The caller closes their card: the door is told, and stops the stream.
    hub.closeCaller(s.id)
    expect(stopped).toBe(true)
    expect(hub.stats().streams).toBe(0)
  })

  it('a door that vanishes mid-stream does not leave a caller waiting', async () => {
    const hub = new RelayHub()
    const { door, detach } = connectDoor(hub, NAME)
    attachDoorToRelay(door, 'ws://127.0.0.1:1/relay', {
      slug: 'alpha',
      handle: async (): Promise<RelayResponse> => ({
        status: 200,
        headers: {},
        stream: () => () => undefined
      })
    })
    const caller = callerSocket()
    hub.openStream(NAME, caller, { method: 'GET', path: '/line', headers: {} })
    await settle()

    detach()
    expect(caller.got.at(-1)).toMatchObject({ t: 'abort', reason: 'door-gone' })
  })

  it('the containment survives the full path: no route outside the door', async () => {
    const hub = new RelayHub()
    const { door } = connectDoor(hub, NAME)
    let called = 0
    attachDoorToRelay(door, 'ws://127.0.0.1:1/relay', {
      slug: 'alpha',
      handle: async () => {
        called += 1
        return { status: 200, headers: {} }
      }
    })

    const caller = callerSocket()
    hub.openStream(NAME, caller, {
      method: 'GET',
      path: '/api/terminal/abc/stream',
      headers: {}
    })
    await settle()

    expect(called).toBe(0)
    expect(caller.got.at(-1)).toMatchObject({ t: 'abort', reason: 'not-a-door-path' })
  })
})
