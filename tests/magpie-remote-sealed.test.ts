// MAGPIE ACROSS COMPUTERS, OVER THE SEAL (fixture: a fake Magpie, the real
// cookrew-seal/2 engine joined in memory). A's Magpie calls A's forwarder with
// a placeholder key; the forwarder seals the request with the key B gave A; B
// checks the device, its switches and the key, and hands the request to its
// Magpie on loopback with that key. Every gate is asked on every request.
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loopbackDialer } from '../src/main/canvas-bridge'
import type { SealPeer } from '../src/main/canvas-seal-terminus'
import { createBoundKeys, keyHash, memoryStorage, type BoundKeys } from '../src/main/magpie-remote/bound-keys'
import { createMagpieForwarder } from '../src/main/magpie-remote/forward'
import { createMagpieServe, presentedKey } from '../src/main/magpie-remote/serve'
import { magpieHeaders, modelRoute } from '../src/shared/remote-magpie'
import type { KeyRow } from '../src/main/route/share-keys'
import type { Seal2Stream } from '../src/shared/seal2/stream'
import type { LiveValues } from '../src/shared/launch-settings'
import { MAGPIE_KEY_PATH, MAGPIE_REMOTE_KIND, SEALED_PLACEHOLDER_KEY } from '../src/shared/remote-magpie'
import { requestFields } from '../src/shared/seal2/http'
import { seal2Pair } from './support/seal2-pair'

const A = 'deviceA0000000000000000000000001'
const KEY = `sk-magpie-key-${'r'.repeat(30)}tail42`
const ON: LiveValues = { magpie: true, magpieRemote: true }

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

async function fakeMagpie(): Promise<{ port: number; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += String(c)))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      if (req.url === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
        setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 20)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'claude/claude-opus-5-5' }] }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as { port: number }).port, seen, close: () => new Promise((r) => server.close(() => r())) }
}

interface World {
  magpie: Awaited<ReturnType<typeof fakeMagpie>>
  forwardPort: number
  b: { switches: LiveValues | null; listed: KeyRow[]; keys: BoundKeys; peer: SealPeer; issued: string[]; revoked: string[] }
  a: { switches: LiveValues | null; key: string | null; caller: boolean; gate: boolean }
  pair: Awaited<ReturnType<typeof seal2Pair>>
  serve: ReturnType<typeof createMagpieServe>
  close(): Promise<void>
}

let world: World

async function build(): Promise<World> {
  const magpie = await fakeMagpie()
  const keys = createBoundKeys(memoryStorage())
  keys.add({ id: 'id-of-a-key-00000001', tail: 'tail42', hash: keyHash(KEY), peer: A, device: 'laptop', at: 'x' })
  const b: World['b'] = { switches: ON, listed: [{ id: 'id-of-a-key-00000001', name: 'device-laptop--x', limit: null, tail: 'tail42', state: 'enabled' }], keys, peer: { mode: 'device', deviceId: A }, issued: [], revoked: [] }
  const serve = createMagpieServe({
    switches: () => b.switches,
    gatewayPort: () => magpie.port,
    keys,
    listKeys: async () => b.listed,
    issue: async (device) => {
      b.issued.push(device)
      return { ok: true, key: `sk-magpie-key-${'n'.repeat(30)}fresh1`, id: 'id-of-a-key-00000002' }
    },
    revoke: async (id) => {
      b.revoked.push(id)
      return { ok: true }
    },
    dial: (port) => loopbackDialer(port),
    name: () => 'Solis-Core',
    log: () => undefined
  })
  const pair = await seal2Pair((stream) => serve(stream, b.peer, {} as never))
  const a: World['a'] = { switches: ON, key: KEY, caller: true, gate: true }
  const forwarder = createMagpieForwarder({
    switches: () => a.switches,
    keyFor: (peer) => (peer === A.replace('deviceA', 'deviceB') ? a.key : null),
    openStream: async (_peer, kind, fields) => pair.a.openStream(kind, fields),
    callerAllowed: async () => a.caller,
    open: async () => a.gate,
    log: () => undefined
  })
  const forwardPort = await forwarder.listen(0)
  return {
    magpie,
    forwardPort,
    b,
    a,
    pair,
    serve,
    close: async () => {
      await forwarder.close()
      pair.close()
      await magpie.close()
    }
  }
}

const B_PEER = A.replace('deviceA', 'deviceB')

async function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string; type: string | null }> {
  const response = await fetch(`http://127.0.0.1:${world.forwardPort}/peer/${B_PEER}${path}`, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': SEALED_PLACEHOLDER_KEY, ...init.headers },
    body: init.method === 'GET' ? undefined : (init.body ?? '{"model":"claude/claude-opus-5-5","stream":true}')
  })
  return { status: response.status, body: await response.text(), type: response.headers.get('content-type') }
}

beforeEach(async () => {
  world = await build()
})
afterEach(async () => {
  await world.close()
})

describe('a model request from A answered by B’s Magpie, sealed', () => {
  it('streams the answer back, and B’s Magpie sees the real key, never the placeholder', async () => {
    const answer = await call('/v1/messages')
    expect(answer.status).toBe(200)
    expect(answer.type).toBe('text/event-stream')
    expect(answer.body).toContain('message_start')
    expect(answer.body).toContain('message_stop')
    const seen = world.magpie.seen.at(-1)
    expect(seen?.url).toBe('/v1/messages')
    expect(seen?.headers['x-api-key']).toBe(KEY)
    expect(JSON.stringify(seen?.headers)).not.toContain(SEALED_PLACEHOLDER_KEY)
    expect(seen?.body).toContain('claude-opus-5-5')
  })

  it('refuses at A, before anything is sealed, while either of A’s switches is off or unreadable', async () => {
    for (const s of [{ magpie: true, magpieRemote: false }, { magpie: false, magpieRemote: true }, null]) {
      world.a.switches = s
      expect((await call('/v1/messages')).status).toBe(403)
    }
    expect(world.magpie.seen).toEqual([])
  })

  it('refuses at B while either of B’s switches is off or unreadable', async () => {
    for (const s of [{ magpie: true, magpieRemote: false }, { magpie: false, magpieRemote: true }, null]) {
      world.b.switches = s
      const answer = await call('/v1/messages')
      expect(answer.status).toBe(403)
      expect(answer.body).toContain('Solis-Core')
    }
    expect(world.magpie.seen).toEqual([])
  })

  it('refuses a computer A is not connected to, and a page in a browser', async () => {
    world.a.key = null
    expect((await call('/v1/messages')).status).toBe(403)
    world.a.key = KEY
    expect((await call('/v1/messages', { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    expect(world.magpie.seen).toEqual([])
  })

  it('refuses a key B did not give that device, or one Magpie no longer lists', async () => {
    world.b.peer = { mode: 'device', deviceId: 'deviceC0000000000000000000000003' }
    expect((await call('/v1/messages')).status).toBe(401)
    world.b.peer = { mode: 'device', deviceId: A }
    world.b.listed = []
    // The list is cached for a few seconds: a fresh world sees the revocation at once.
    await world.close()
    world = await build()
    world.b.listed = []
    expect((await call('/v1/messages')).status).toBe(401)
    expect(world.magpie.seen).toEqual([])
  })

  it('never serves a phone’s connect-code session, nor Magpie’s management API', async () => {
    expect((await call('/v1/magpie/admin/providers', { method: 'GET' })).status).toBe(404)
    expect((await call('/v1/magpie/keys')).status).toBe(404)
    world.b.peer = { mode: 'code' }
    expect((await call('/v1/messages')).status).toBe(502)
    expect(world.magpie.seen).toEqual([])
  })
})

describe('asking B for a key', () => {
  it('revokes the key it gave that device before, then makes and records a new one bound to the device', async () => {
    const pair = await seal2Pair(() => undefined)
    pair.close()
    const stream = await (async () => {
      const { a } = await seal2Pair((s) => createMagpieServe({
        switches: () => world.b.switches,
        gatewayPort: () => world.magpie.port,
        keys: world.b.keys,
        listKeys: async () => world.b.listed,
        issue: async (device) => {
          world.b.issued.push(device)
          return { ok: true, key: `sk-magpie-key-${'n'.repeat(30)}fresh1`, id: 'id-of-a-key-00000002' }
        },
        revoke: async (id) => {
          world.b.revoked.push(id)
          return { ok: true }
        },
        dial: (port) => loopbackDialer(port),
        name: () => 'Solis-Core',
        log: () => undefined
      })(s, { mode: 'device', deviceId: A }, {} as never))
      return a.openStream(MAGPIE_REMOTE_KIND, requestFields('POST', MAGPIE_KEY_PATH, { 'content-type': 'application/json' }))
    })()
    const writer = stream.writable.getWriter()
    await writer.write(new TextEncoder().encode(JSON.stringify({ name: 'laptop' })))
    await writer.close()
    const head = await stream.head
    const text = await new Response(stream.readable).text()
    expect(head.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ ok: true, id: 'id-of-a-key-00000002' })
    expect(world.b.revoked).toEqual(['id-of-a-key-00000001'])
    expect(world.b.issued).toEqual([`laptop-${A.slice(0, 6).toLowerCase()}`])
    expect(world.b.keys.list().map((k) => [k.id, k.peer])).toEqual([['id-of-a-key-00000002', A]])
    expect(JSON.stringify(world.b.keys.list())).not.toContain('fresh1x')
  })
})

describe('pieces', () => {
  it('reads one key from the credential headers, and refuses two that differ', () => {
    expect(presentedKey({ authorization: 'Bearer k1' })).toBe('k1')
    expect(presentedKey({ 'x-api-key': 'k1', authorization: 'Bearer k1' })).toBe('k1')
    expect(presentedKey({ 'x-api-key': 'k1', authorization: 'Bearer k2' })).toBeNull()
    expect(presentedKey({ authorization: 'Basic abc' })).toBeNull()
    expect(presentedKey({})).toBeNull()
  })

  it('serves the model endpoints only, by exact path and method', () => {
    expect(modelRoute('POST', '/v1/messages')).toBe(true)
    expect(modelRoute('POST', '/v1/messages/count_tokens')).toBe(true)
    expect(modelRoute('POST', '/v1/chat/completions')).toBe(true)
    expect(modelRoute('POST', '/v1/responses')).toBe(true)
    expect(modelRoute('GET', '/v1/models')).toBe(true)
    expect(modelRoute('GET', '/v1/magpie/quotas')).toBe(true)
    expect(modelRoute('GET', '/v1/messages')).toBe(false)
    expect(modelRoute('POST', '/v1/models')).toBe(false)
  })

  it('refuses Magpie’s management routes however they are spelled', () => {
    for (const [method, path] of [
      ['GET', '/v1/magpie/admin/providers'],
      ['POST', '/v1/%6dagpie/admin/x'],
      ['POST', '/v1/magpie/%61dmin/x'],
      ['POST', '/v1/magpie/keys'],
      ['POST', '/v1/magpie/limit'],
      ['POST', '/v1/magpie/library'],
      ['POST', '/v1/magpie/update'],
      ['GET', '/v1/magpie/native/claude/x'],
      ['GET', '/v1/magpie/heap'],
      ['POST', '/v1//messages'],
      ['POST', '/v1/./messages'],
      ['POST', '/v1/x/../messages'],
      ['POST', '/v1/messages/'],
      ['POST', '/V1/messages'],
      ['GET', '/v1/models?x=%2e'],
      ['GET', '/api/hello']
    ] as const) {
      expect(modelRoute(method, path), `${method} ${path}`).toBe(false)
    }
    expect(modelRoute('GET', '/v1/models?limit=50')).toBe(true)
  })

  it('stops a management route at A, before anything is sealed, and again at B', async () => {
    expect((await call('/v1/%6dagpie/admin/x')).status).toBe(404)
    expect((await call('/v1/magpie/keys')).status).toBe(404)
    expect(world.magpie.seen).toEqual([])
  })
})

describe('review fixes: asking again after a revocation, and whose screen a key lands on', () => {
  const serveWith = (over: Partial<Parameters<typeof createMagpieServe>[0]>) =>
    createMagpieServe({
      switches: () => world.b.switches,
      gatewayPort: () => world.magpie.port,
      keys: world.b.keys,
      listKeys: async () => world.b.listed,
      issue: async (device) => {
        world.b.issued.push(device)
        return { ok: true, key: `sk-magpie-key-${'n'.repeat(30)}fresh1`, id: 'id-of-a-key-00000002' }
      },
      revoke: async (id) => {
        world.b.revoked.push(id)
        return { ok: false, why: 'Only a key made here for a device can be revoked here.' }
      },
      dial: (port) => loopbackDialer(port),
      name: () => 'Solis-Core',
      log: () => undefined,
      ...over
    })

  async function askKey(handler: ReturnType<typeof createMagpieServe>): Promise<{ status: number; json: Record<string, unknown> }> {
    const { a } = await seal2Pair((s) => handler(s, { mode: 'device', deviceId: A }, {} as never))
    const stream = a.openStream(MAGPIE_REMOTE_KIND, requestFields('POST', MAGPIE_KEY_PATH, { 'content-type': 'application/json' }))
    const writer = stream.writable.getWriter()
    await writer.write(new TextEncoder().encode(JSON.stringify({ name: 'MacBook Pro' })))
    await writer.close()
    const head = await stream.head
    return { status: head.status, json: JSON.parse(await new Response(stream.readable).text()) as Record<string, unknown> }
  }

  it('drops the binding of a key Magpie no longer lists instead of failing to revoke it, and makes a new one', async () => {
    world.b.listed = []
    const answer = await askKey(serveWith({}))
    expect(answer).toMatchObject({ status: 200, json: { ok: true } })
    expect(world.b.revoked).toEqual([])
    expect(world.b.keys.list().map((k) => k.id)).toEqual(['id-of-a-key-00000002'])
  })

  it('names the key after the asking computer and its device id, so two computers of one name never collide', async () => {
    world.b.listed = []
    await askKey(serveWith({}))
    expect(world.b.issued).toEqual([`macbook-pro-${A.slice(0, 6).toLowerCase()}`])
  })
})

describe('review fixes: a refused request with a body nobody read', () => {
  it('frees its stream on both ends once the refusal is delivered', async () => {
    world.b.switches = { magpie: true, magpieRemote: false }
    const big = JSON.stringify({ model: 'x', pad: 'p'.repeat(1_500_000) })
    const answer = await call('/v1/messages', { body: big })
    expect(answer.status).toBe(403)
    for (let i = 0; i < 40 && world.pair.a.stats().streams + world.pair.b.stats().streams > 0; i += 1) await new Promise((r) => setTimeout(r, 50))
    expect(world.pair.a.stats().streams).toBe(0)
    expect(world.pair.b.stats().streams).toBe(0)
  })
})

describe('review fixes: one key per computer, and only an enabled one', () => {
  it('handles one key request per computer at a time, so two at once leave one key', async () => {
    let made = 0
    const issueGate: Array<() => void> = []
    const keys = world.b.keys
    const handler = createMagpieServe({
      switches: () => ON,
      gatewayPort: () => world.magpie.port,
      keys,
      listKeys: async () => keys.list().map((k) => ({ id: k.id, name: `device-x--${'a'.repeat(32)}`, limit: null, tail: k.tail, state: 'enabled' })),
      issue: async () => {
        made += 1
        const n = made
        await new Promise<void>((r) => issueGate.push(r))
        return { ok: true, key: `sk-magpie-key-${'m'.repeat(30)}made${n}x`, id: `id-made-0000000000${n}` }
      },
      revoke: async () => ({ ok: true }),
      dial: (port) => loopbackDialer(port),
      name: () => 'Solis-Core',
      log: () => undefined
    })
    const { a } = await seal2Pair((s) => handler(s, { mode: 'device', deviceId: A }, {} as never))
    const ask = async (name: string): Promise<number> => {
      const stream = a.openStream(MAGPIE_REMOTE_KIND, requestFields('POST', MAGPIE_KEY_PATH, { 'content-type': 'application/json' }))
      const writer = stream.writable.getWriter()
      await writer.write(new TextEncoder().encode(JSON.stringify({ name })))
      await writer.close()
      return (await stream.head).status
    }
    const both = Promise.all([ask('one'), ask('two')])
    for (let i = 0; i < 40 && issueGate.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
    issueGate.shift()?.()
    for (let i = 0; i < 40 && issueGate.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
    issueGate.shift()?.()
    expect(await both).toEqual([200, 200])
    expect(keys.list().filter((k) => k.peer === A)).toHaveLength(1)
  })

  it('refuses a key Magpie lists as anything but enabled', async () => {
    world.b.listed = [{ id: 'id-of-a-key-00000001', name: 'device-laptop--x', limit: null, tail: 'tail42', state: 'disabled' }]
    await world.close()
    const listed = world.b.listed
    world = await build()
    world.b.listed = listed
    expect((await call('/v1/messages')).status).toBe(401)
  })
})

describe('review round 2: nothing but the checked key reaches Magpie as a credential', () => {
  it('refuses a query Magpie could read a key from, and keeps the ones agents send', () => {
    expect(modelRoute('POST', '/v1/messages?beta=true')).toBe(true)
    expect(modelRoute('GET', '/v1/models?limit=50&after_id=x')).toBe(true)
    for (const q of ['key=junk', 'api_key=x', 'beta=true&key=x', 'token=x']) expect(modelRoute('POST', `/v1/messages?${q}`), q).toBe(false)
  })

  it('forwards only the allowed headers, with the verified key in both credential headers', () => {
    const out = magpieHeaders({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-stainless-os': 'MacOS', 'x-goog-api-key': 'junk', 'x-magpie-account': 'claude/other', cookie: 'a=1', 'x-api-key': 'placeholder', authorization: 'Bearer placeholder' }, KEY)
    expect(out).toEqual({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-stainless-os': 'MacOS', authorization: `Bearer ${KEY}`, 'x-api-key': KEY })
  })

  it('end to end: B’s Magpie never sees a second credential or a steering header', async () => {
    expect((await call('/v1/messages', { headers: { 'x-goog-api-key': 'junk', 'x-magpie-provider': 'claude' } })).status).toBe(200)
    const seen = world.magpie.seen.at(-1)
    expect(seen?.headers['x-goog-api-key']).toBeUndefined()
    expect(seen?.headers['x-magpie-provider']).toBeUndefined()
    expect(seen?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(seen?.headers['x-api-key']).toBe(KEY)
  })
})

describe('review round 2: a key revoked while a body is held never reaches Magpie', () => {
  const send = (headers: Record<string, string>) => world.pair.a.openStream(MAGPIE_REMOTE_KIND, requestFields('POST', '/v1/messages', { 'content-type': 'application/json', ...headers }))

  it('checks the key again once the body is in, so a revocation meanwhile refuses it', async () => {
    const stream = send({ 'x-api-key': KEY })
    const writer = stream.writable.getWriter()
    await writer.write(new TextEncoder().encode('{"model":"claude/claude-opus-5-5",'))
    await new Promise((r) => setTimeout(r, 30))
    // The key stops being honoured (asked again, given back, or revoked in the panel).
    world.serve.unbind('id-of-a-key-00000001')
    await writer.write(new TextEncoder().encode('"stream":true}'))
    await writer.close()
    expect((await stream.head).status).toBe(401)
    expect(world.magpie.seen).toEqual([])
  })

  it('cuts an answer still streaming with a key that is unbound', async () => {
    const stream = send({ 'x-api-key': KEY })
    const writer = stream.writable.getWriter()
    await writer.write(new TextEncoder().encode('{"model":"claude/claude-opus-5-5","stream":true}'))
    await writer.close()
    await stream.head
    world.serve.unbind('id-of-a-key-00000001')
    await expect(stream.closed).rejects.toBeDefined()
  })

  it('gives one computer at most three keys a day', async () => {
    world.b.listed = []
    const handler = world.serve
    const { a } = await seal2Pair((s) => handler(s, { mode: 'device', deviceId: A }, {} as never))
    const ask = async (): Promise<number> => {
      const stream = a.openStream(MAGPIE_REMOTE_KIND, requestFields('POST', MAGPIE_KEY_PATH, { 'content-type': 'application/json' }))
      const writer = stream.writable.getWriter()
      await writer.write(new TextEncoder().encode(JSON.stringify({ name: 'laptop' })))
      await writer.close()
      return (await stream.head).status
    }
    expect([await ask(), await ask(), await ask(), await ask()]).toEqual([200, 200, 200, 429])
  })
})

describe('review round 3: who may use the forwarder, and how much B holds', () => {
  it('serves only this computer’s magpie, and nothing while the served-seat gate is shut', async () => {
    world.a.caller = false
    expect((await call('/v1/messages')).status).toBe(403)
    world.a.caller = true
    world.a.gate = false
    expect((await call('/v1/messages')).status).toBe(403)
    expect(world.magpie.seen).toEqual([])
  })

  it('answers at most eight requests from one computer at once, counted before any body is held', async () => {
    const held = Array.from({ length: 8 }, () => {
      const stream = world.pair.a.openStream(MAGPIE_REMOTE_KIND, requestFields('POST', '/v1/messages', { 'content-type': 'application/json', 'x-api-key': KEY }))
      void stream.writable.getWriter().write(new TextEncoder().encode('{"a":'))
      return stream
    })
    await new Promise((r) => setTimeout(r, 50))
    const ninth = world.pair.a.openStream(MAGPIE_REMOTE_KIND, requestFields('POST', '/v1/messages', { 'content-type': 'application/json', 'x-api-key': KEY }))
    expect((await ninth.head).status).toBe(429)
    for (const stream of held) stream.abort(1, 'test over')
  })
})

describe('review round 3: a request is checked by a key list read that started after its body arrived', () => {
  it('does not reuse a read already running when its body arrived, and shares one read after it', async () => {
    const reads: Array<{ resolve: (rows: KeyRow[]) => void }> = []
    const listed: KeyRow = { id: 'id-of-a-key-00000001', name: 'device-laptop--x', limit: null, tail: 'tail42', state: 'enabled' }
    const handler = createMagpieServe({
      switches: () => ON,
      gatewayPort: () => world.magpie.port,
      keys: world.b.keys,
      listKeys: () => new Promise<KeyRow[]>((resolve) => reads.push({ resolve })),
      issue: async () => ({ ok: false, why: 'no' }),
      revoke: async () => ({ ok: true }),
      dial: (port) => loopbackDialer(port),
      name: () => 'Solis-Core',
      log: () => undefined
    })
    const { a } = await seal2Pair((s) => handler(s, { mode: 'device', deviceId: A }, {} as never))
    const send = async (): Promise<Seal2Stream> => {
      const stream = a.openStream(MAGPIE_REMOTE_KIND, requestFields('POST', '/v1/messages', { 'content-type': 'application/json', 'x-api-key': KEY }))
      const writer = stream.writable.getWriter()
      await writer.write(new TextEncoder().encode('{"model":"claude/claude-opus-5-5","stream":true}'))
      await writer.close()
      return stream
    }
    const first = await send()
    for (let i = 0; i < 50 && reads.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5))
    const second = await send()
    const third = await send()
    await new Promise((r) => setTimeout(r, 50))
    expect(reads).toHaveLength(1)
    // The first read (begun before the later bodies) still lists the key; the one after it does not.
    reads[0].resolve([listed])
    for (let i = 0; i < 50 && reads.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5))
    expect(reads).toHaveLength(2)
    reads[1].resolve([])
    expect((await first.head).status).toBe(200)
    expect((await second.head).status).toBe(401)
    expect((await third.head).status).toBe(401)
    expect(reads).toHaveLength(2)
  })
})
