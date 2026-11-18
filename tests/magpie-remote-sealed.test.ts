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
import { createMagpieServe, presentedKey, modelPath } from '../src/main/magpie-remote/serve'
import type { KeyRow } from '../src/main/route/share-keys'
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
  a: { switches: LiveValues | null; key: string | null }
  close(): Promise<void>
}

let world: World

async function build(): Promise<World> {
  const magpie = await fakeMagpie()
  const keys = createBoundKeys(memoryStorage())
  keys.add({ id: 'id-of-a-key-00000001', tail: 'tail42', hash: keyHash(KEY), peer: A, device: 'laptop', at: 'x' })
  const b: World['b'] = { switches: ON, listed: [{ id: 'id-of-a-key-00000001', name: 'device-laptop--x', limit: null, tail: 'tail42' }], keys, peer: { mode: 'device', deviceId: A }, issued: [], revoked: [] }
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
  const a: World['a'] = { switches: ON, key: KEY }
  const forwarder = createMagpieForwarder({
    switches: () => a.switches,
    keyFor: (peer) => (peer === A.replace('deviceA', 'deviceB') ? a.key : null),
    openStream: async (_peer, kind, fields) => pair.a.openStream(kind, fields),
    log: () => undefined
  })
  const forwardPort = await forwarder.listen(0)
  return {
    magpie,
    forwardPort,
    b,
    a,
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
    expect(world.b.issued).toEqual(['laptop'])
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

  it('serves model paths only', () => {
    expect(modelPath('/v1/messages')).toBe(true)
    expect(modelPath('/v1/chat/completions?x=1')).toBe(true)
    expect(modelPath('/v1/magpie/admin/providers')).toBe(false)
    expect(modelPath('/api/hello')).toBe(false)
    expect(modelPath('/v1/../admin')).toBe(false)
  })
})
