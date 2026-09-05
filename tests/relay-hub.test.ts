import { describe, expect, it } from 'vitest'
import { RelayHub, type HubSocket } from '../registry/src/relay-hub'
import { decodeFrame, encodeFrame, type RelayFrame } from '../src/shared/relay-frame'

/**
 * THE RELAY HUB.
 *
 * It will carry other people's conversations, so what is tested is mostly what
 * it refuses: a name cannot be taken over, a caller cannot name a stream that
 * is not theirs, a door cannot answer one it was never given, and nobody is
 * left hanging when the other end vanishes.
 */

function sock(): HubSocket & { got: RelayFrame[]; closed: boolean } {
  const got: RelayFrame[] = []
  const s = {
    got,
    closed: false,
    send: (data: string) => {
      const frame = decodeFrame(data)
      if (frame) got.push(frame)
    },
    close: () => {
      s.closed = true
    }
  }
  return s
}

const NAME = '@drej/cookrew-alpha'
const req = { method: 'GET', path: '/crew', headers: {} }

describe('a door claims a name', () => {
  it('is told it is ready, under the name it claimed', () => {
    const hub = new RelayHub()
    const door = sock()
    expect(hub.openDoor(NAME, door).ok).toBe(true)
    expect(door.got).toEqual([{ t: 'ready', name: NAME }])
  })

  it('refuses a second claim rather than handing the traffic over', () => {
    // A takeover and a rightful reconnect look identical from here, and only
    // one of them is safe to guess at.
    const hub = new RelayHub()
    hub.openDoor(NAME, sock())
    expect(hub.openDoor(NAME, sock())).toEqual({ ok: false, reason: 'name-taken' })
  })

  it('refuses a name that is not one owner and one team', () => {
    const hub = new RelayHub()
    for (const bad of ['drej/alpha', '@drej', '@drej/', '@/alpha', '@drej/Alpha', '@drej/a/b', '']) {
      expect(hub.openDoor(bad, sock()), bad).toEqual({ ok: false, reason: 'bad-name' })
    }
  })
})

describe('routing one exchange', () => {
  it('hands the door the request and the caller the answer', () => {
    const hub = new RelayHub()
    const door = sock()
    const caller = sock()
    hub.openDoor(NAME, door)
    const opened = hub.openStream(NAME, caller, req)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return

    expect(door.got.at(-1)).toMatchObject({ t: 'open', id: opened.id, path: '/crew' })
    hub.fromDoor(NAME, encodeFrame({ t: 'head', id: opened.id, status: 200, headers: {} }))
    hub.fromDoor(NAME, encodeFrame({ t: 'chunk', id: opened.id, data: 'body' }))
    hub.fromDoor(NAME, encodeFrame({ t: 'end', id: opened.id }))
    expect(caller.got.map((f) => f.t)).toEqual(['head', 'chunk', 'end'])
    expect(hub.stats()).toEqual({ doors: 1, streams: 0 })
  })

  it('assigns ids itself — a caller never chooses one', () => {
    const hub = new RelayHub()
    hub.openDoor(NAME, sock())
    const a = hub.openStream(NAME, sock(), req)
    const b = hub.openStream(NAME, sock(), req)
    expect(a.ok && b.ok && a.id !== b.id).toBe(true)
  })

  it('a name nobody serves answers like a name that never existed', () => {
    const hub = new RelayHub()
    expect(hub.openStream('@ana/nothing', sock(), req)).toEqual({
      ok: false,
      reason: 'no-such-door'
    })
  })
})

describe('what a caller may not do', () => {
  it('cannot speak about another caller’s stream', () => {
    const hub = new RelayHub()
    const door = sock()
    const mine = sock()
    const theirs = sock()
    hub.openDoor(NAME, door)
    const ours = hub.openStream(NAME, mine, req)
    hub.openStream(NAME, theirs, req)
    if (!ours.ok) return

    const before = door.got.length
    // The other caller's socket, naming our id.
    hub.fromCaller(ours.id, theirs, encodeFrame({ t: 'body', id: ours.id, data: 'x', done: true }))
    expect(door.got.length).toBe(before)
  })

  it('cannot forge a head or a chunk — only the door answers', () => {
    const hub = new RelayHub()
    const door = sock()
    const caller = sock()
    hub.openDoor(NAME, door)
    const s = hub.openStream(NAME, caller, req)
    if (!s.ok) return

    const before = door.got.length
    hub.fromCaller(s.id, caller, encodeFrame({ t: 'head', id: s.id, status: 200, headers: {} }))
    hub.fromCaller(s.id, caller, encodeFrame({ t: 'chunk', id: s.id, data: 'fake' }))
    expect(door.got.length).toBe(before)
  })
})

describe('what a door may not do', () => {
  it('cannot answer a stream it was never given', () => {
    const hub = new RelayHub()
    const doorA = sock()
    const doorB = sock()
    const caller = sock()
    hub.openDoor(NAME, doorA)
    hub.openDoor('@ana/research', doorB)
    const s = hub.openStream(NAME, caller, req)
    if (!s.ok) return

    hub.fromDoor('@ana/research', encodeFrame({ t: 'chunk', id: s.id, data: 'not yours' }))
    expect(caller.got).toHaveLength(0)
  })
})

describe('nobody is left hanging', () => {
  it('a door dropping tells every caller riding it, and closes them', () => {
    const hub = new RelayHub()
    hub.openDoor(NAME, sock())
    const one = sock()
    const two = sock()
    hub.openStream(NAME, one, req)
    hub.openStream(NAME, two, req)

    hub.closeDoor(NAME)
    for (const caller of [one, two]) {
      expect(caller.got.at(-1)).toMatchObject({ t: 'abort', reason: 'door-gone' })
      expect(caller.closed).toBe(true)
    }
    expect(hub.stats()).toEqual({ doors: 0, streams: 0 })
    expect(hub.has(NAME)).toBe(false)
  })

  it('a caller going away tells the door to stop the stream', () => {
    const hub = new RelayHub()
    const door = sock()
    const caller = sock()
    hub.openDoor(NAME, door)
    const s = hub.openStream(NAME, caller, req)
    if (!s.ok) return

    hub.closeCaller(s.id)
    expect(door.got.at(-1)).toEqual({ t: 'end', id: s.id })
    expect(hub.stats().streams).toBe(0)
  })

  it('an ended exchange stops being routable in either direction', () => {
    const hub = new RelayHub()
    const door = sock()
    const caller = sock()
    hub.openDoor(NAME, door)
    const s = hub.openStream(NAME, caller, req)
    if (!s.ok) return

    hub.fromDoor(NAME, encodeFrame({ t: 'end', id: s.id }))
    const callerFrames = caller.got.length
    const doorFrames = door.got.length
    hub.fromDoor(NAME, encodeFrame({ t: 'chunk', id: s.id, data: 'late' }))
    hub.fromCaller(s.id, caller, encodeFrame({ t: 'body', id: s.id, data: 'late', done: true }))
    expect(caller.got.length).toBe(callerFrames)
    expect(door.got.length).toBe(doorFrames)
  })
})
