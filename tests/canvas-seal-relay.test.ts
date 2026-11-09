// THE SEALED SESSION THROUGH THE REAL RELAY: the unmodified registry, a real held
// line, real HTTP. Every frame the registry touches is kept, and what must never be
// in them is searched for, raw and decoded. A plain request through the same line
// shows the search can find it.
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DoorStore } from '../registry/src/doors'
import { IdentityService } from '../registry/src/identity'
import { TransparencyLog } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { StarStore } from '../registry/src/stars'
import { RegistryStore } from '../registry/src/store'
import { EXCHANGES_PER_LINK } from '../registry/src/v2-canvas-relay'
import { createV2 } from '../registry/src/v2-routes'
import { createCanvasBridge, loopbackDialer, RELAY_MARKER } from '../src/main/canvas-bridge'
import { createCanvasLink, type CanvasLink } from '../src/main/canvas-link'
import { createSealTerminus, isSealPath, routeSeal, type SealTerminus } from '../src/main/canvas-seal-terminus'
import { connectCodeId, newConnectCode } from '../src/shared/canvas-seal'
import type { SealFrame } from '../src/shared/canvas-seal-wire'
import { openSeal } from '../src/renderer/src/path/seal-client'
import { SealPhone, until } from './support/seal-phone'

const PASSWORD = 'correct horse battery staple'
const BEARER = 'Bearer canary-pairing-token-7f3a'
const REPLY = 'canary-transcript-words-91bd'
const ROUTE = '/api/canary-route-44c1'
const UPLOAD = 'canary-prompt-typed-c05e'

let terminus: SealTerminus | undefined
const seen: Array<{ authorization?: string; relayed?: string; device?: string; body: string; path?: string }> = []
let events: ((chunk: string) => void) | null = null

const companion = (): Server =>
  createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (isSealPath(url.pathname)) return void routeSeal(request, response, terminus)
    if (url.pathname === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(': open\n\n')
      events = (chunk) => response.write(chunk)
      return
    }
    if (url.pathname === '/api/picture') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(Buffer.from(Array.from({ length: 1_000_000 }, (_, i) => i % 251)))
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({
        authorization: request.headers.authorization,
        relayed: request.headers[RELAY_MARKER] as string | undefined,
        device: request.headers['x-cookrew-device'] as string | undefined,
        body: Buffer.concat(chunks).toString(),
        path: request.url
      })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(REPLY)
    })
  })

interface Up {
  origin: string
  close(): Promise<void>
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

const jwkOf = (): Record<string, string> => generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>

let site: Up
let mac: Up
let dir = ''
let username = ''
let deviceId = ''
let desktopToken = ''
let cookie = ''
let link: CanvasLink | null = null
const code = newConnectCode()
/** Every frame the registry sent or received on the Mac's line. */
const lines: string[] = []

async function signUp(): Promise<void> {
  username = 'owner'
  deviceId = randomUUID()
  const json = { 'content-type': 'application/json' }
  const claimed = await fetch(`${site.origin}/v2/accounts`, { method: 'POST', headers: json, body: JSON.stringify({ username, password: PASSWORD, device: { id: deviceId, kind: 'desktop', name: 'This Mac', jwk: jwkOf() } }) })
  desktopToken = ((await claimed.json()) as { session: { token: string } }).session.token
  await fetch(`${site.origin}/v2/me/desktops/${deviceId}`, { method: 'PUT', headers: { ...json, authorization: `Bearer ${desktopToken}` }, body: JSON.stringify({ name: 'This Mac', workspaces: [{ id: 'w1', name: 'One' }] }) })
  const attached = await fetch(`${site.origin}/v2/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ username, password: PASSWORD, device: { id: randomUUID(), kind: 'phone', name: 'A phone', jwk: jwkOf() } }) })
  const asked = (await attached.json()) as { pending: string; match: string }
  const request = await fetch(`${site.origin}/v2/sessions/${asked.pending}/approve`, { method: 'POST' })
  const { approval } = (await request.json()) as { approval: string }
  await fetch(`${site.origin}/v2/me/approvals/${approval}`, { method: 'POST', headers: { ...json, authorization: `Bearer ${desktopToken}` }, body: JSON.stringify({ decision: 'approve', match: asked.match }) })
  const done = await fetch(`${site.origin}/v2/sessions/${asked.pending}`)
  cookie = `__Host-cr_session=${((await done.json()) as { token: string }).token}`
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'canvas-seal-relay-'))
  mac = await listen(companion())
  site = await listen(
    createRegistry({
      store: new RegistryStore(dir),
      log: new TransparencyLog(dir),
      identity: new IdentityService(dir),
      doors: new DoorStore(dir, { allowPrivate: true }),
      stars: new StarStore(dir),
      origin: 'https://cookrew.dev',
      v2: createV2(dir, { secondStep: 'legacy', limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000, lookupsPerMinute: 1000 } })
    })
  )
  await signUp()
  const port = Number(new URL(mac.origin).port)
  const id = await connectCodeId(code)
  terminus = createSealTerminus({ codeFor: (asked) => (asked === id ? code : null), dial: loopbackDialer(port) })
  link = createCanvasLink({ origin: () => site.origin, credential: () => ({ token: desktopToken, deviceId }) })
  const bridge = createCanvasBridge({
    send: (line) => {
      lines.push(line)
      link!.send(line)
    },
    dial: loopbackDialer(port)
  })
  link.onFrame((line) => {
    lines.push(line)
    bridge.frame(line)
  })
  link.onDrop(bridge.reset)
  link.start()
  await until(() => link!.held(), 'the line', 4000)
})

afterAll(async () => {
  link?.stop()
  terminus?.close()
  await site.close()
  await mac.close()
  rmSync(dir, { recursive: true, force: true })
})

const prefix = (): string => `${site.origin}/relay/@${username}/desktop/${deviceId}`
const connected = async (): Promise<SealPhone> => {
  const phone = new SealPhone(prefix(), code, { cookie })
  await phone.connect()
  return phone
}
const get = (stream: number, route: string): SealFrame[] => [
  { kind: 'open', stream, method: 'GET', path: route, headers: { authorization: BEARER } },
  { kind: 'end', stream }
]

/** Everything in these frames as the relay could read it: the lines, and their payloads decoded. */
const relayCouldRead = (from: number): string => {
  const kept = lines.slice(from)
  const decoded = kept.map((line) => {
    try {
      const frame = JSON.parse(line) as { data?: string }
      return frame.data ? Buffer.from(frame.data, 'base64').toString('latin1') : ''
    } catch {
      return ''
    }
  })
  return [...kept, ...decoded].join('\n')
}

describe('a body on a method with no framing, through the real relay', () => {
  it('stays inside its request: nothing reaches this Mac as a second, unmarked request', async () => {
    const before = seen.length
    const smuggled = 'POST /smuggled HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n'
    const target = new URL(`${prefix()}/api/plain`)
    await new Promise<void>((resolve, reject) => {
      const asked = httpRequest({ host: target.hostname, port: target.port, path: target.pathname, method: 'GET', headers: { cookie, 'transfer-encoding': 'chunked' } }, (answer) => {
        answer.resume()
        answer.on('end', resolve)
      })
      asked.on('error', reject)
      asked.end(smuggled)
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(seen.slice(before).map((request) => request.path)).toEqual(['/api/plain'])
  })
})

describe('the sealed session through the real relay', () => {
  it('carries a request and its answer, and the relay sees none of it', async () => {
    const from = lines.length
    const phone = await connected()
    await phone.send(
      { kind: 'open', stream: 1, method: 'POST', path: ROUTE, headers: { authorization: BEARER } },
      { kind: 'data', stream: 1, data: Buffer.from(UPLOAD) },
      { kind: 'end', stream: 1 }
    )
    await until(() => phone.of(1).some((frame) => frame.kind === 'end'), 'the answer')
    expect(phone.text(1)).toBe(REPLY)
    const got = seen.at(-1)
    expect(got).toMatchObject({ authorization: BEARER, relayed: '1', device: expect.any(String), body: UPLOAD, path: ROUTE })
    const read = relayCouldRead(from)
    expect(read.length).toBeGreaterThan(200)
    for (const canary of [BEARER, 'canary-pairing-token', REPLY, ROUTE, UPLOAD]) expect(read, canary).not.toContain(canary)
    expect(read).not.toContain(Buffer.from(code).toString('base64url'))
    phone.hangUp()
  })

  it('the phone page\'s own client carries a request through it, and the relay sees none of it', async () => {
    const from = lines.length
    const withCookie: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie } })
    const client = await openSeal({ url: (route) => `${prefix()}${route}`, code: Buffer.from(code).toString('base64url'), fetchFn: withCookie })
    const answer = await client.request({ method: 'POST', path: ROUTE, headers: { authorization: BEARER }, body: PASSWORD })
    client.close()
    expect(Buffer.from(answer.body).toString()).toBe(REPLY)
    expect(seen.at(-1)).toMatchObject({ authorization: BEARER, relayed: '1', body: PASSWORD, path: ROUTE })
    const read = relayCouldRead(from)
    for (const canary of [BEARER, 'canary-pairing-token', REPLY, ROUTE, PASSWORD]) expect(read, canary).not.toContain(canary)
    expect(read).not.toContain(Buffer.from(code).toString('base64url'))
  })

  it('the same words in the clear are found by the same search', async () => {
    const from = lines.length
    const answer = await fetch(`${prefix()}${ROUTE}`, { method: 'POST', headers: { cookie, authorization: BEARER }, body: UPLOAD })
    expect(await answer.text()).toBe(REPLY)
    const read = relayCouldRead(from)
    for (const canary of [BEARER, REPLY, ROUTE, UPLOAD]) expect(read, canary).toContain(canary)
  })

  it('streams an event stream through the relay as it happens', async () => {
    const phone = await connected()
    await phone.send(...get(2, '/api/events'))
    await until(() => phone.text(2).includes(': open') && events !== null, 'the stream to open')
    events?.('data: first\n\n')
    await until(() => phone.text(2).includes('first'), 'the first event')
    events?.('data: second\n\n')
    await until(() => phone.text(2).includes('second'), 'the second event')
    await phone.send({ kind: 'abort', stream: 2, reason: 'done' })
    phone.hangUp()
  })

  it('brings a large picture through whole', async () => {
    const phone = await connected()
    await phone.send(...get(3, '/api/picture'))
    await until(() => phone.of(3).some((frame) => frame.kind === 'end'), 'the picture', 8000)
    const got = Buffer.concat(phone.of(3).flatMap((frame) => (frame.kind === 'data' ? [Buffer.from(frame.data)] : [])))
    expect(got.equals(Buffer.from(Array.from({ length: 1_000_000 }, (_, i) => i % 251)))).toBe(true)
    phone.hangUp()
  })

  it('runs more exchanges at once than a relay line carries, on one of them', async () => {
    const phone = await connected()
    const many = EXCHANGES_PER_LINK * 2
    await phone.send(...Array.from({ length: many }, (_, i) => get(100 + i, `/api/n/${i}`)).flat())
    await until(() => phone.frames.filter((frame) => frame.kind === 'end').length === many, 'every answer', 8000)
    phone.hangUp()
  })

  it('survives the down stream dropping mid-answer', async () => {
    const phone = await connected()
    await phone.send(...get(4, '/api/events'))
    await until(() => phone.text(4).includes(': open'), 'the stream')
    phone.hangUp()
    await new Promise((resolve) => setTimeout(resolve, 50))
    events?.('data: while-away\n\n')
    await phone.listen()
    await until(() => phone.text(4).includes('while-away'), 'what was missed')
    await phone.send({ kind: 'abort', stream: 4, reason: 'done' })
    phone.hangUp()
  })

  it('a stranger with no code gets no session through the relay', async () => {
    const stranger = new SealPhone(prefix(), newConnectCode(), { cookie })
    await expect(stranger.connect()).rejects.toThrow()
  })
})
