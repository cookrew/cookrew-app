import { describe, expect, it } from 'vitest'
import { RelayHub, type HubSocket } from '../registry/src/relay-hub'
import { RelayCaller, RelayCallFailed, type CallerTransport } from '../src/main/relay-caller'
import { attachDoorToRelay, type RelayResponse, type RelaySocket } from '../src/main/relay-client'
import { decodeFrame, encodeFrame, type RelayFrame } from '../src/shared/relay-frame'
import { generateSealKeyPair } from '../src/shared/relay-seal'

/**
 * A REAL CALL, SEALED, THROUGH A RELAY THAT CANNOT READ IT.
 *
 * Both halves were tested apart and the plaintext path was tested end to end.
 * This is the claim the product actually makes: someone calls a door that
 * cannot be dialled, the conversation crosses a machine we operate, and that
 * machine cannot read a word of it.
 *
 * Everything the relay carries is captured, so the assertions can be made
 * against what a relay operator would actually have.
 */

const NAME = '@drej/cookrew-alpha'
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

interface Wired {
  caller: RelayCaller
  /** Every frame the relay handled, in order. The operator's view. */
  seen: RelayFrame[]
  /** Only what was delivered to the caller — where its own labels appear. */
  delivered: RelayFrame[]
  /** What the door's handler was given, after the seal came off. */
  asked: { method: string; path: string; headers: Record<string, string>; body: string }[]
  hub: RelayHub
  dropDoor: () => void
  /** Change a chunk on its way through, as a dishonest relay would. */
  tamper: (fn: (data: string) => string) => void
  /** Make up a frame the door never sent, as a dishonest relay would. */
  inject: (frame: RelayFrame) => void
}

function wire(
  respond: (input: { path: string; body: string }) => RelayResponse,
  options: { doorKey?: string; callerPin?: string } = {}
): Wired {
  const hub = new RelayHub()
  const keys = generateSealKeyPair()
  const doorPrivate = options.doorKey ?? keys.privateKey
  const seen: RelayFrame[] = []
  const delivered: RelayFrame[] = []
  const asked: Wired['asked'] = []
  let meddle: ((data: string) => string) | null = null

  // ---- the door's socket, plugged into the hub -------------------------
  const toDoor: ((data: string) => void)[] = []
  const doorClosed: (() => void)[] = []
  const doorSide: RelaySocket = {
    send: (data) => {
      const frame = decodeFrame(data)
      if (frame) seen.push(frame)
      if (frame && frame.t === 'chunk' && meddle) {
        hub.fromDoor(NAME, encodeFrame({ ...frame, data: meddle(frame.data) }))
        return
      }
      hub.fromDoor(NAME, data)
    },
    close: () => hub.closeDoor(NAME),
    onMessage: (listener) => toDoor.push(listener),
    onClose: (listener) => doorClosed.push(listener)
  }
  hub.openDoor(NAME, {
    send: (data) => {
      const frame = decodeFrame(data)
      if (frame) seen.push(frame)
      toDoor.forEach((l) => l(data))
    },
    close: () => doorClosed.forEach((c) => c())
  })
  attachDoorToRelay(doorSide, 'wss://cookrew.dev/relay', {
    slug: 'cookrew-alpha',
    seal: { privateKey: doorPrivate, name: NAME },
    handle: async (request) => {
      asked.push(request)
      return respond({ path: request.path, body: request.body })
    }
  })

  // ---- the caller's socket, plugged into the hub -----------------------
  const toCaller: ((data: string) => void)[] = []
  const callerClosed: (() => void)[] = []
  const callerAtHub: HubSocket = {
    send: (data) => {
      const frame = decodeFrame(data)
      if (frame) {
        seen.push(frame)
        delivered.push(frame)
      }
      toCaller.forEach((l) => l(data))
    },
    close: () => callerClosed.forEach((c) => c())
  }
  const transport: CallerTransport = {
    send: (data) => {
      const frame = decodeFrame(data)
      if (!frame) return
      seen.push(frame)
      if (frame.t === 'open') {
        hub.openStream(
          NAME,
          callerAtHub,
          { method: frame.method, path: frame.path, headers: frame.headers },
          frame.id
        )
        return
      }
      if (frame.t !== 'ready') hub.fromCaller(frame.id, callerAtHub, data)
    },
    close: () => callerClosed.forEach((c) => c()),
    onMessage: (listener) => toCaller.push(listener),
    onClose: (listener) => callerClosed.push(listener)
  }

  return {
    caller: new RelayCaller(transport, NAME, options.callerPin ?? keys.publicKey),
    seen,
    delivered,
    asked,
    hub,
    dropDoor: () => hub.closeDoor(NAME),
    tamper: (fn) => {
      meddle = fn
    },
    inject: (frame) => toCaller.forEach((l) => l(encodeFrame(frame)))
  }
}

/** Everything a relay operator could read off the wire, as one string. */
function relayView(seen: RelayFrame[]): string {
  return seen
    .map((f) => {
      if (f.t === 'open') return `${f.method} ${f.path} ${JSON.stringify(f.headers)}`
      if (f.t === 'body' || f.t === 'chunk') return f.data
      if (f.t === 'head') return `${f.status} ${JSON.stringify(f.headers)}`
      return f.t
    })
    .join('\n')
}

describe('a sealed call, end to end', () => {
  it('reaches the door and comes back', async () => {
    const w = wire(() => ({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-cookrew-session': 'sess_9f2' },
      body: '{"reply":"51"}'
    }))

    const answer = await w.caller.request('POST', '/ask', { authorization: 'Bearer tok_secret' }, '{"prompt":"17 * 3"}')

    // The door was handed the request as it was made — the relay is transport,
    // not a second protocol, and the gate never learns it exists.
    expect(w.asked).toEqual([
      {
        method: 'POST',
        path: '/cookrew-alpha/ask',
        headers: { authorization: 'Bearer tok_secret' },
        body: '{"prompt":"17 * 3"}'
      }
    ])
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('{"reply":"51"}')
    // Response headers survive the seal: the session the caller was just
    // granted arrives, and it arrived encrypted.
    expect(answer.headers['x-cookrew-session']).toBe('sess_9f2')
  })

  it('a POST with NO body is answered — the door does not wait for a frame that never comes', async () => {
    // The sign-in challenge is every card's first request and carries no
    // body. The door answers a GET on sight and waits for `done` on anything
    // else, so this hung forever while the same POST with `{}` answered.
    const w = wire(() => ({ status: 200, headers: {}, body: '{"challenge":"n1"}' }))
    const answer = await Promise.race([
      w.caller.request('POST', '/api/call/challenge', {}, ''),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung: empty POST never answered')), 2000))
    ])
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('{"challenge":"n1"}')
    expect(w.asked).toEqual([
      { method: 'POST', path: '/cookrew-alpha/api/call/challenge', headers: {}, body: '' }
    ])
  })

  it('the relay carries the whole exchange and can read none of it', async () => {
    const w = wire(() => ({
      status: 200,
      headers: { 'x-cookrew-session': 'sess_9f2' },
      body: '{"reply":"51 — and here is the reasoning"}'
    }))
    await w.caller.request('POST', '/ask', { authorization: 'Bearer tok_secret' }, '{"prompt":"17 * 3"}')

    const view = relayView(w.seen)
    // The prompt, the reply, the caller's bearer, the session it was given.
    for (const secret of ['17 * 3', 'reasoning', 'tok_secret', 'sess_9f2', 'authorization']) {
      expect(view, secret).not.toContain(secret)
    }
    // And it is not merely encoded: nothing legible falls out of base64 either.
    const decoded = w.seen
      .filter((f) => f.t === 'chunk' || f.t === 'body')
      .map((f) => Buffer.from((f as { data: string }).data, 'base64url').toString('utf8'))
      .join('')
    for (const secret of ['prompt', 'reply', 'Bearer']) {
      expect(decoded, secret).not.toContain(secret)
    }
    // What it DOES see is the shape, which is the honest limit of the claim.
    expect(view).toContain('POST /ask')
  })

  it('carries the LINE — a stream that stays open, in order, sealed', async () => {
    const pushes: ((chunk: string) => void)[] = []
    let stopped = false
    const w = wire(() => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      stream: (write) => {
        pushes.push(write)
        return () => {
          stopped = true
        }
      }
    }))

    const got: string[] = []
    let head: { status: number; headers: Record<string, string> } | null = null
    const line = w.caller.stream(
      'GET',
      '/line',
      { authorization: 'Bearer tok_secret' },
      (status, headers) => {
        head = { status, headers }
      },
      (chunk) => got.push(chunk)
    )
    await settle()
    expect(head).toEqual({ status: 200, headers: { 'content-type': 'text/event-stream' } })

    // A terminal's worth of bursts, each opened as it arrives — no batching,
    // because the person is watching this.
    const frames = [
      'event: hello\ndata: {"cols":100,"rows":30}\n\n',
      'event: data\ndata: "\\u001b[2m$ npm test\\u001b[0m"\n\n',
      'event: data\ndata: "51 passing"\n\n'
    ]
    for (const frame of frames) pushes[0]?.(frame)
    expect(got).toEqual(frames)
    expect(relayView(w.seen)).not.toContain('npm test')

    // Closing the card stops the door producing, rather than leaking a stream.
    line?.close()
    expect(stopped).toBe(true)
    expect(w.hub.stats().streams).toBe(0)
  })
})

describe('what the relay cannot get away with', () => {
  it('cannot stand in the middle: a pinned key it does not hold', async () => {
    // The caller pins the key it was given at import. The relay tries to serve
    // the call itself with a door key of its own.
    const impostor = generateSealKeyPair()
    const w = wire(() => ({ status: 200, headers: {}, body: 'x' }), {
      callerPin: impostor.publicKey
    })

    await expect(w.caller.request('GET', '/crew', {})).rejects.toThrow(RelayCallFailed)
    // The real door refused to answer at all — it could not open the request,
    // so nothing was served under a key the caller never trusted.
    expect(w.asked).toEqual([])
    expect(w.seen.at(-1)).toMatchObject({ t: 'abort', reason: 'unsealable' })
  })

  it('cannot alter a reply — the caller fails rather than showing a lie', async () => {
    const w = wire(() => ({ status: 200, headers: {}, body: '{"reply":"51"}' }))
    w.tamper((data) => {
      const raw = Buffer.from(data, 'base64url')
      raw[0] ^= 0x01
      return raw.toString('base64url')
    })

    await expect(w.caller.request('GET', '/crew', {})).rejects.toThrow(
      /did not verify/
    )
  })

  it('cannot answer on the door’s behalf', async () => {
    // A door that is not serving at all, so nothing can answer honestly.
    const w = wire(() => ({ status: 200, headers: {}, body: 'real' }))
    w.dropDoor()
    const call = w.caller.request('GET', '/crew', {})
    // The relay makes up a plausible answer. It has no channel to seal with,
    // and a bare head is not the door — so this is refused, not rendered.
    w.inject({ t: 'head', id: 'c1', status: 200, headers: { 'content-type': 'application/json' } })
    w.inject({ t: 'chunk', id: 'c1', data: '{"door":"Free","price":0}' })
    w.inject({ t: 'end', id: 'c1' })

    await expect(call).rejects.toThrow(/without the seal/)
  })

  it('a door that vanishes mid-line tells the caller, rather than hanging', async () => {
    const w = wire(() => ({
      status: 200,
      headers: {},
      stream: () => () => undefined
    }))
    let failure: Error | null = null
    w.caller.stream('GET', '/line', {}, () => undefined, () => undefined, (error) => {
      failure = error
    })
    await settle()

    w.dropDoor()
    expect(failure).toBeInstanceOf(RelayCallFailed)
    expect(String(failure)).toContain('door-gone')
  })
})

describe('two callers on one door', () => {
  it('never learn each other’s stream ids', async () => {
    // Each caller labels its own exchanges, so the ids it sees are its own and
    // there is nothing to guess at. The id that reaches the door is the hub's.
    const w = wire(() => ({ status: 200, headers: {}, body: 'ok' }))
    const first = await w.caller.request('GET', '/crew', {})
    const second = await w.caller.request('GET', '/crew', {})
    expect([first.body, second.body]).toEqual(['ok', 'ok'])

    // The caller only ever sees labels it chose. The hub's own ids (s1, s2)
    // went to the door and stopped there.
    expect(w.delivered.map((f) => (f.t === 'ready' ? f.name : f.id))).toEqual([
      'c1',
      'c1',
      'c1',
      'c2',
      'c2',
      'c2'
    ])
    const atDoor = w.seen.filter((f) => f.t === 'open').map((f) => f.id)
    expect(atDoor).toEqual(['c1', 's1', 'c2', 's2'])
  })
})
