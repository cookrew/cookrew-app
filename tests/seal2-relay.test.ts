// COOKREW-SEAL/2 THROUGH THE REAL RELAY: the unmodified registry, a real held
// line, real HTTP, the callers' own carrier (seal2/http-link.ts). What the
// registry reads on both sides, the Mac's line and the callers' requests, is
// searched for every canary; a request in the clear through the same relay
// shows the search finds them when they are there.
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXCHANGES_PER_LINK } from '../registry/src/v2-canvas-relay'
import { RELAY_MARKER } from '../src/main/canvas-bridge'
import type { SealedNotice, SealTerminus } from '../src/main/canvas-seal-terminus'
import { createSealMarks, SEALED_ONLY_ERROR } from '../src/main/seal-marks'
import { cameOverRelayLine } from '../src/main/seal-proof'
import { takeRelayDevice } from '../src/main/relay-device'
import { connectCodeId, newConnectCode } from '../src/shared/canvas-seal'
import { startCodeHandshake, startDeviceHandshake } from '../src/shared/seal2/handshake'
import { readBody, sealedFetch } from '../src/shared/seal2/http'
import { runSeal2Link, Seal2RefusedError, shakeHandsOverHttp, type Seal2Link } from '../src/shared/seal2/http-link'
import type { Seal2Session } from '../src/shared/seal2/records'
import { ABORT } from '../src/shared/seal2/spec'
import { isSealPath, loopbackDialer, newDevice, routeSeal, startRelayWorld, until, verifyDevice, type RelayWorld } from './support/seal2-relay-world'

const BEARER = 'Bearer canary-pairing-token-7f3a'
const REPLY = 'canary-transcript-words-91bd'
const ROUTE = '/api/canary-route-44c1'
const UPLOAD = 'canary-prompt-typed-c05e'
const MACHINE_KEY = 'Bearer canary-machine-key-d00d'

const seen: Array<{ authorization?: string; relayed?: string; device?: string; body: string; path?: string }> = []
let events: ((chunk: string) => void) | null = null
const PICTURE = Buffer.from(Array.from({ length: 1_000_000 }, (_, i) => i % 251))

const marksDir = mkdtempSync(path.join(tmpdir(), 'seal2-marks-'))
const marks = createSealMarks(path.join(marksDir, 'seal-marks.json'))

/** The companion's own order (mobile-server.ts · handle): the seal first, then the relay device, then the marks. */
const companion = (terminus: () => SealTerminus | undefined): Server =>
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (isSealPath(url.pathname)) return void routeSeal(request, response, terminus())
    const device = takeRelayDevice(request)
    if (cameOverRelayLine(request) && marks.refuses(device?.deviceId ?? null)) {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: SEALED_ONLY_ERROR }))
      return
    }
    if (device) request.headers['x-cookrew-device'] = device.deviceId
    if (url.pathname === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': open\n\n')
      events = (chunk) => response.write(chunk)
      return
    }
    if (url.pathname === '/api/picture') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(PICTURE)
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({
        authorization: request.headers.authorization,
        relayed: request.headers[RELAY_MARKER] as string | undefined,
        device: request.headers['x-cookrew-device'] as string | undefined,
        body: body.length > 1000 ? `${body.length} bytes` : body.toString(),
        path: request.url
      })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(REPLY)
    })
  })

const code = newConnectCode()
const sealed: SealedNotice[] = []
let world: RelayWorld
const opened: Seal2Link[] = []

beforeAll(async () => {
  const id = await connectCodeId(code)
  world = await startRelayWorld(companion, (port, mac, other) => ({
    codeFor: (asked) => (asked === id ? code : null),
    dial: loopbackDialer(port),
    device: { self: () => mac.signer, verify: verifyDevice, trusted: async (deviceId) => deviceId === other.id },
    kinds: {
      echo: (stream, peer) => {
        stream.respond(200, { peer: peer.mode })
        void stream.readable.pipeTo(stream.writable).catch(() => undefined)
      }
    },
    onSealed: (notice) => {
      sealed.push(notice)
      if (notice.peer.mode === 'code' && notice.outer.device !== undefined) marks.mark(notice.outer.device)
    }
  }))
})

afterAll(async () => {
  for (const link of opened) link.close()
  await world?.close()
  rmSync(marksDir, { recursive: true, force: true })
})

/** A phone or console holding the code: the v2 handshake, then the carrier. */
async function phone(fetchFn = world.capture(world.phoneSession)): Promise<Seal2Link> {
  const deps = { url: (route: string) => `${world.prefix()}${route}`, fetchFn, retryMs: 50 }
  const started = await startCodeHandshake(code, { allowV1: false })
  const done = await shakeHandsOverHttp(deps, started, async () => new Seal2RefusedError('code', 'refused'))
  if (done.version !== 2) throw new Error('not v2')
  const link = runSeal2Link(deps, done.session as Seal2Session)
  opened.push(link)
  return link
}

/** The account's other desktop, dialling the Mac by its device id. */
async function otherDesktop(): Promise<Seal2Link> {
  const deps = { url: (route: string) => `${world.prefix()}${route}`, fetchFn: world.capture(world.otherDesktop.session), retryMs: 50 }
  const started = await startDeviceHandshake({ self: world.otherDesktop.signer, to: world.macDevice.id, verify: verifyDevice })
  const done = await shakeHandsOverHttp(deps, started, async (said) => new Seal2RefusedError('device', String(said?.error)))
  const link = runSeal2Link(deps, done.session)
  opened.push(link)
  return link
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString()
const mark = (): [number, number] => [world.lines.length, world.exchanges.length]

describe('code mode (phone and console) through the real relay', () => {
  it('carries a request and its answer, and the relay reads none of it, the code included', async () => {
    const [from, fromExchange] = mark()
    const link = await phone()
    const answer = await sealedFetch(link.connection, { method: 'POST', path: ROUTE, headers: { authorization: BEARER }, body: UPLOAD })
    expect(answer.status).toBe(200)
    expect(text(await readBody(answer.body))).toBe(REPLY)
    expect(seen.at(-1)).toMatchObject({ authorization: BEARER, relayed: '1', device: expect.any(String), body: UPLOAD, path: ROUTE })
    const read = world.relayCouldRead(from, fromExchange)
    expect(read.length).toBeGreaterThan(500)
    for (const canary of [BEARER, 'canary-pairing-token', REPLY, ROUTE, UPLOAD, 'authorization']) expect(read, canary).not.toContain(canary)
    expect(read).not.toContain(Buffer.from(code).toString('base64url'))
    expect(read).not.toContain(Buffer.from(code).toString('hex'))
  })

  it('the same canaries in the clear are found by the same search', async () => {
    const [from, fromExchange] = mark()
    // The other desktop: it has not spoken v2 on the code, so it may still speak in the clear.
    const plain = world.capture(world.otherDesktop.session)
    const answer = await plain(`${world.prefix()}${ROUTE}`, { method: 'POST', headers: { authorization: BEARER }, body: UPLOAD })
    expect(await answer.text()).toBe(REPLY)
    const read = world.relayCouldRead(from, fromExchange)
    for (const canary of [BEARER, REPLY, ROUTE, UPLOAD]) expect(read, canary).toContain(canary)
  })

  it('tells the Mac a v2 caller has come, with the device the relay named', async () => {
    expect(sealed.some((notice) => notice.peer.mode === 'code' && typeof notice.outer.device === 'string' && typeof notice.codeId === 'string')).toBe(true)
  })

  it('streams events as they happen', async () => {
    const link = await phone()
    const answer = await sealedFetch(link.connection, { method: 'GET', path: '/api/events', headers: { authorization: BEARER } })
    const reader = answer.body.getReader()
    let got = ''
    const next = async (): Promise<void> => {
      const { value } = await reader.read()
      got += text(value ?? new Uint8Array())
    }
    await next()
    expect(got).toContain(': open')
    events?.('data: first\n\n')
    while (!got.includes('first')) await next()
    events?.('data: second\n\n')
    while (!got.includes('second')) await next()
    answer.stream.abort(ABORT.cancel, 'done')
  })

  it('brings a large answer through whole, and a large upload past one window', async () => {
    const link = await phone()
    const picture = await sealedFetch(link.connection, { method: 'GET', path: '/api/picture', headers: { authorization: BEARER } })
    expect(Buffer.from(await readBody(picture.body)).equals(PICTURE)).toBe(true)
    const upload = new Uint8Array(3 * 1024 * 1024 + 7).fill(0x61)
    const posted = await sealedFetch(link.connection, { method: 'POST', path: '/api/upload', headers: { authorization: BEARER }, body: upload })
    expect(text(await readBody(posted.body))).toBe(REPLY)
    expect(seen.at(-1)?.body).toBe(`${upload.length} bytes`)
  })

  it('runs more exchanges at once than a relay line carries', async () => {
    const link = await phone()
    const many = EXCHANGES_PER_LINK * 2
    const answers = await Promise.all(Array.from({ length: many }, (_, i) => sealedFetch(link.connection, { method: 'GET', path: `/api/n/${i}` }).then((answer) => readBody(answer.body))))
    expect(answers.map(text)).toEqual(Array.from({ length: many }, () => REPLY))
  })

  it('survives the down line dropping in the middle of an answer', async () => {
    let cut: AbortController | null = null
    const capture = world.capture(world.phoneSession)
    const fetchFn: typeof fetch = (input, init) => {
      if (!String(input).includes('/~seal/down')) return capture(input, init)
      const own = new AbortController()
      init?.signal?.addEventListener('abort', () => own.abort())
      cut = own
      return capture(input, { ...init, signal: own.signal })
    }
    const link = await phone(fetchFn)
    const answer = await sealedFetch(link.connection, { method: 'GET', path: '/api/events', headers: { authorization: BEARER } })
    const reader = answer.body.getReader()
    expect(text((await reader.read()).value ?? new Uint8Array())).toContain(': open')
    ;(cut as AbortController | null)?.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    events?.('data: while-away\n\n')
    let got = ''
    while (!got.includes('while-away')) got += text((await reader.read()).value ?? new Uint8Array())
    answer.stream.abort(ABORT.cancel, 'done')
  })

  it('a stranger without the code gets no session, and nothing in the clear', async () => {
    const started = await startCodeHandshake(newConnectCode(), { allowV1: false })
    const deps = { url: (route: string) => `${world.prefix()}${route}`, fetchFn: world.capture(world.phoneSession) }
    await expect(shakeHandsOverHttp(deps, started, async () => new Seal2RefusedError('code', 'no'))).rejects.toMatchObject({ why: 'code' })
  })
})

describe('versions', () => {
  const stripping: (session: Record<string, string>) => typeof fetch = (session) => (input, init) => {
    if (!String(input).endsWith('/~seal/hello') || typeof init?.body !== 'string') return world.capture(session)(input, init)
    const { vs: _dropped, ...hello } = JSON.parse(init.body) as Record<string, unknown>
    return world.capture(session)(input, { ...init, body: JSON.stringify(hello) })
  }

  it('a Mac that answers v1 (an old Mac, or a carrier that stripped the offer) gives a sealed v1 session when v1 is allowed', async () => {
    const started = await startCodeHandshake(code)
    const deps = { url: (route: string) => `${world.prefix()}${route}`, fetchFn: stripping(world.phoneSession) }
    const done = await shakeHandsOverHttp(deps, started, async () => new Seal2RefusedError('code', 'no'))
    expect(done.version).toBe(1)
  })

  it('a client pinned to v2 refuses the v1 answer: a downgrade is an error, never a quieter session', async () => {
    const started = await startCodeHandshake(code, { allowV1: false })
    const deps = { url: (route: string) => `${world.prefix()}${route}`, fetchFn: stripping(world.phoneSession) }
    await expect(shakeHandsOverHttp(deps, started, async () => new Seal2RefusedError('code', 'no'))).rejects.toMatchObject({ why: 'proof' })
  })
})

describe('device mode (desktop to desktop on one account) through the real relay', () => {
  it('opens on the device keys, carries a machine-keyed request, and the relay reads none of it', async () => {
    const [from, fromExchange] = mark()
    const link = await otherDesktop()
    const answer = await sealedFetch(link.connection, { method: 'POST', path: ROUTE, headers: { authorization: MACHINE_KEY }, body: UPLOAD })
    expect(text(await readBody(answer.body))).toBe(REPLY)
    expect(seen.at(-1)).toMatchObject({ authorization: MACHINE_KEY, relayed: '1', device: world.otherDesktop.id, body: UPLOAD })
    const read = world.relayCouldRead(from, fromExchange)
    for (const canary of [MACHINE_KEY, 'canary-machine-key', REPLY, ROUTE, UPLOAD]) expect(read, canary).not.toContain(canary)
    expect(sealed.some((notice) => notice.peer.mode === 'device' && notice.peer.deviceId === world.otherDesktop.id)).toBe(true)
  })

  it('opens a stream of another kind (openStream), here an echo', async () => {
    const link = await otherDesktop()
    const stream = link.connection.openStream('echo', {})
    const writer = stream.writable.getWriter()
    void writer.write(new TextEncoder().encode('ping-through')).then(() => writer.close())
    expect((await stream.head).fields).toEqual({ peer: 'device' })
    expect(text(await readBody(stream.readable))).toBe('ping-through')
  })

  it('refuses a device the account does not list', async () => {
    const stranger = newDevice()
    const deps = { url: (route: string) => `${world.prefix()}${route}`, fetchFn: world.capture(world.otherDesktop.session) }
    // Sent with the other desktop's session, so the relay names the other desktop: that alone refuses it.
    const started = await startDeviceHandshake({ self: stranger.signer, to: world.macDevice.id, verify: verifyDevice })
    await expect(shakeHandsOverHttp(deps, started, async (said) => new Seal2RefusedError('device', String(said?.error)))).rejects.toThrow(/not that device/)
  })

  it('refuses a hello in another device\'s name than the relay saw', async () => {
    const deps = { url: (route: string) => `${world.prefix()}${route}`, fetchFn: world.capture(world.phoneSession) }
    const started = await startDeviceHandshake({ self: world.otherDesktop.signer, to: world.macDevice.id, verify: verifyDevice })
    await expect(shakeHandsOverHttp(deps, started, async (said) => new Seal2RefusedError('device', String(said?.error)))).rejects.toThrow(/not that device/)
  })

  it('refuses an answer from any key but the one dialled', async () => {
    const deps = { url: (route: string) => `${world.prefix()}${route}`, fetchFn: world.capture(world.otherDesktop.session) }
    const wrong = newDevice()
    const started = await startDeviceHandshake({ self: world.otherDesktop.signer, to: wrong.id, verify: verifyDevice })
    await expect(shakeHandsOverHttp(deps, started, async (said) => new Seal2RefusedError('device', String(said?.error)))).rejects.toThrow()
  })
})

describe('the Mac keeps v1', () => {
  it('still answers an old phone on v1 at the same address', async () => {
    const { SealPhone } = await import('./support/seal-phone')
    const old = new SealPhone(world.prefix(), code, world.phoneSession)
    await old.connect()
    await old.send({ kind: 'open', stream: 1, method: 'GET', path: '/api/old', headers: { authorization: BEARER } }, { kind: 'end', stream: 1 })
    await until(() => old.of(1).some((frame) => frame.kind === 'end'), 'the old answer')
    expect(old.text(1)).toBe(REPLY)
    old.hangUp()
  })
})

describe('openStream(peer, kind) for other lanes (main/seal-peers.ts)', () => {
  const peersFor = async () => {
    const { createSealPeers } = await import('../src/main/seal-peers')
    const { machineRelayPath } = await import('../src/shared/machine-relay')
    const capture = world.capture(world.otherDesktop.session)
    return createSealPeers({
      self: () => world.otherDesktop.signer,
      verify: verifyDevice,
      relayed: (deviceId, route, init) => capture(`${world.site.origin}${machineRelayPath(deviceId, route)}`, init),
      retryMs: 50
    })
  }

  it('fetches over one sealed session per peer, and opens a new one after it ends', async () => {
    const peers = await peersFor()
    const first = await peers.fetch(world.macDevice.id, { method: 'GET', path: '/api/peers-1', headers: { authorization: MACHINE_KEY } })
    expect(text(await readBody(first.body))).toBe(REPLY)
    const before = world.terminus().stats().sessions
    const second = await peers.fetch(world.macDevice.id, { method: 'GET', path: '/api/peers-2', headers: { authorization: MACHINE_KEY } })
    expect(text(await readBody(second.body))).toBe(REPLY)
    expect(world.terminus().stats().sessions).toBe(before)
    // The Mac drops every session (its code changed, say): the next call shakes hands again.
    world.terminus().endSessions('rotated')
    await new Promise((resolve) => setTimeout(resolve, 200))
    const third = await peers.fetch(world.macDevice.id, { method: 'GET', path: '/api/peers-3', headers: { authorization: MACHINE_KEY } })
    expect(text(await readBody(third.body))).toBe(REPLY)
    expect(seen.at(-1)).toMatchObject({ path: '/api/peers-3', device: world.otherDesktop.id })
    peers.close()
  })

  it('openStream gives a duplex stream of any kind the far end serves', async () => {
    const peers = await peersFor()
    const stream = await peers.openStream(world.macDevice.id, 'echo')
    const writer = stream.writable.getWriter()
    void writer.write(new TextEncoder().encode('both ways')).then(() => writer.close())
    expect(text(await readBody(stream.readable))).toBe('both ways')
    const unknown = await peers.openStream(world.macDevice.id, 'no-such-kind')
    await expect(unknown.head).rejects.toMatchObject({ code: ABORT.unknownKind })
    peers.close()
  })

  it('the same words on both desktops for their pair', async () => {
    const peers = await peersFor()
    const { pairWords } = await import('../src/shared/seal2/handshake')
    expect(await peers.words(world.macDevice.id)).toEqual(await pairWords(world.macDevice.id, world.otherDesktop.id))
    peers.close()
  })
})

describe('a v2 caller is answered nothing in the clear on the relay line', () => {
  it('the phone, once sealed, is refused in the clear and still answered sealed', async () => {
    await phone()
    const plain = await world.capture(world.phoneSession)(`${world.prefix()}${ROUTE}`, { method: 'POST', headers: { authorization: BEARER }, body: UPLOAD })
    expect(plain.status).toBe(403)
    expect(await plain.json()).toEqual({ error: SEALED_ONLY_ERROR })
    const link = await phone()
    const answer = await sealedFetch(link.connection, { method: 'GET', path: ROUTE, headers: { authorization: BEARER } })
    expect(text(await readBody(answer.body))).toBe(REPLY)
  })

  it('a device that has not spoken v2 still is answered in the clear, until the owner says sealed only', async () => {
    const other = world.capture(world.otherDesktop.session)
    expect((await other(`${world.prefix()}/api/still-plain`, { headers: { authorization: MACHINE_KEY } })).status).toBe(200)
    marks.setSealedOnly(true)
    try {
      expect((await other(`${world.prefix()}/api/still-plain`, { headers: { authorization: MACHINE_KEY } })).status).toBe(403)
      const peer = await otherDesktop()
      const sealedAnswer = await sealedFetch(peer.connection, { method: 'GET', path: '/api/sealed-anyway', headers: { authorization: MACHINE_KEY } })
      expect(sealedAnswer.status).toBe(200)
    } finally {
      marks.setSealedOnly(false)
    }
  })

  it('a new connect code clears the marks: the phone can reach the pairing page again', async () => {
    marks.clearDevices()
    const plain = await world.capture(world.phoneSession)(`${world.prefix()}/api/after-rotation`, { headers: { authorization: BEARER } })
    expect(plain.status).toBe(200)
  })
})
