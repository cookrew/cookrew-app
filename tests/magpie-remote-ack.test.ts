// A SEALED KEY IS LIVE ONLY ONCE ITS COMPUTER ACKNOWLEDGES IT (Relay contract).
// B binds a key it gives as pending; A keeps the key durably, then acknowledges
// it over its own device session with the key itself as the proof. Until then B
// serves no model request with it and B's intent warns, through broken streams
// and restarts. An acknowledgement is idempotent; an old A that never sends one
// is left with a key that works nowhere (fail closed), and a new A meeting an
// old B gives the key back.
import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loopbackDialer } from '../src/main/canvas-bridge'
import { createBoundKeys, fileStorage, keyHash, memoryStorage, type BoundKeys, type BoundKeysStorage } from '../src/main/magpie-remote/bound-keys'
import { createMagpieServe, type MagpieServeDeps } from '../src/main/magpie-remote/serve'
import { ackKeyOver } from '../src/main/magpie-remote/wire'
import { ShareKeys, type KeyRow, type MagpieRun } from '../src/main/route/share-keys'
import { memoryIntentStore, type IntentStore } from '../src/main/route/share-intents'
import { MAGPIE_KEY_ACK_PATH, MAGPIE_KEY_PATH, MAGPIE_KEY_RETURN_PATH, MAGPIE_REMOTE_KIND } from '../src/shared/remote-magpie'
import { readBody, requestFields } from '../src/shared/seal2/http'
import type { Seal2Stream } from '../src/shared/seal2/stream'
import { seal2Pair } from './support/seal2-pair'

const A = 'deviceA0000000000000000000000001'
const OTHER = 'deviceC0000000000000000000000003'
const FRESH = `sk-magpie-key-${'n'.repeat(30)}fresh1`
const FRESH_ID = 'id-of-a-key-00000002'
const ON = { magpie: true, magpieRemote: true }

async function fakeMagpieHttp(): Promise<{ port: number; seen: string[]; close(): Promise<void> }> {
  const seen: string[] = []
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":"model answered"}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as { port: number }).port, seen, close: () => new Promise((r) => server.close(() => r())) }
}

interface B {
  keys: BoundKeys
  listed: KeyRow[]
  acked: string[]
  revoked: string[]
  logs: string[]
  ackAnswer: { ok: true } | { ok: false; why: string }
  serve: ReturnType<typeof createMagpieServe>
}

let magpie: Awaited<ReturnType<typeof fakeMagpieHttp>>
let closers: Array<() => void> = []

beforeEach(async () => {
  magpie = await fakeMagpieHttp()
})
afterEach(async () => {
  closers.forEach((close) => close())
  closers = []
  await magpie.close()
})

function makeB(over: Partial<MagpieServeDeps> = {}, storage: BoundKeysStorage = memoryStorage()): B {
  const b = {
    keys: createBoundKeys(storage),
    listed: [] as KeyRow[],
    acked: [] as string[],
    revoked: [] as string[],
    logs: [] as string[],
    ackAnswer: { ok: true } as B['ackAnswer']
  } as B
  b.serve = createMagpieServe({
    switches: () => ON,
    gatewayPort: () => magpie.port,
    keys: b.keys,
    listKeys: async () => b.listed,
    issue: async () => {
      b.listed = [...b.listed, { id: FRESH_ID, name: `device-laptop-device--${'a'.repeat(32)}`, limit: null, tail: FRESH.slice(-6), state: 'enabled', access: 'read-only' }]
      return { ok: true, key: FRESH, id: FRESH_ID }
    },
    revoke: async (id) => {
      b.revoked.push(id)
      b.listed = b.listed.filter((row) => row.id !== id)
      return { ok: true }
    },
    // As ShareKeys does: a confirmed key is turned on in Magpie (access full) before its record is cleared.
    acknowledge: async (id) => {
      b.acked.push(id)
      if (b.ackAnswer.ok) b.listed = b.listed.map((row) => (row.id === id ? { ...row, access: 'full' } : row))
      return b.ackAnswer
    },
    dial: (port) => loopbackDialer(port),
    name: () => 'Solis-Core',
    log: (line) => b.logs.push(line),
    ...over
  })
  return b
}

async function connect(b: B, peer = A): Promise<(path: string, headers?: Record<string, string>, body?: string) => Promise<{ status: number; json: Record<string, unknown> }>> {
  const pair = await seal2Pair((s) => b.serve(s, { mode: 'device', deviceId: peer }, {} as never))
  closers.push(() => pair.close())
  return async (path, headers = {}, body = '{}') => {
    const stream = pair.a.openStream(MAGPIE_REMOTE_KIND, requestFields('POST', path, { 'content-type': 'application/json', ...headers }))
    const writer = stream.writable.getWriter()
    await writer.write(new TextEncoder().encode(body))
    await writer.close()
    const head = await stream.head
    const text = new TextDecoder().decode(await readBody(stream.readable))
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      json = { raw: text }
    }
    return { status: head.status, json }
  }
}

const ask = (send: Awaited<ReturnType<typeof connect>>) => send(MAGPIE_KEY_PATH, {}, JSON.stringify({ name: 'laptop' }))
const ack = (send: Awaited<ReturnType<typeof connect>>, key = FRESH, id = FRESH_ID) => send(MAGPIE_KEY_ACK_PATH, { authorization: `Bearer ${key}` }, JSON.stringify({ id }))
const model = (send: Awaited<ReturnType<typeof connect>>, key = FRESH) => send('/v1/messages', { 'x-api-key': key }, '{"model":"claude/claude-opus-5-5"}')

describe('a key B gives is pending until A acknowledges it', () => {
  it('binds the key as pending and serves no model request with it: an old A that never acknowledges is shut out', async () => {
    const b = makeB()
    const send = await connect(b)
    expect(await ask(send)).toMatchObject({ status: 200, json: { ok: true, id: FRESH_ID } })
    expect(b.keys.list()).toMatchObject([{ id: FRESH_ID, peer: A, pending: true }])
    const refused = await model(send)
    expect(refused.status).toBe(401)
    expect(JSON.stringify(refused.json)).toContain('confirm')
    expect(magpie.seen).toEqual([])
  })

  it('an acknowledgement with the key and its id makes it live, and settles B’s intent', async () => {
    const b = makeB()
    const send = await connect(b)
    await ask(send)
    expect(await ack(send)).toMatchObject({ status: 200, json: { ok: true, id: FRESH_ID } })
    expect(b.acked).toEqual([FRESH_ID])
    expect(b.keys.list()[0].pending).toBeFalsy()
    expect((await model(send)).status).toBe(200)
    expect(magpie.seen).toEqual(['/v1/messages'])
  })

  it('answers a repeated acknowledgement the same way and leaves one live key', async () => {
    const b = makeB()
    const send = await connect(b)
    await ask(send)
    const [first, second] = await Promise.all([ack(send), ack(send)])
    expect([first.status, second.status]).toEqual([200, 200])
    expect((await ack(send)).status).toBe(200)
    expect(b.keys.list().map((k) => [k.id, k.pending ?? false])).toEqual([[FRESH_ID, false]])
  })

  it('takes acknowledgements one at a time per computer', async () => {
    let inside = 0
    let most = 0
    const b = makeB({
      acknowledge: async () => {
        inside += 1
        most = Math.max(most, inside)
        await new Promise((r) => setTimeout(r, 15))
        inside -= 1
        return { ok: true }
      }
    })
    const send = await connect(b)
    await ask(send)
    await Promise.all([ack(send), ack(send), ack(send)])
    expect(most).toBe(1)
  })

  it.each([
    ['another key', () => `sk-magpie-key-${'f'.repeat(30)}fresh1`, FRESH_ID, A],
    ['another id', () => FRESH, 'id-of-a-key-00000009', A],
    ['another computer', () => FRESH, FRESH_ID, OTHER]
  ])('refuses an acknowledgement with %s, and the key stays pending', async (_label, key, id, peer) => {
    const b = makeB()
    await ask(await connect(b))
    const send = await connect(b, peer)
    expect((await ack(send, key(), id)).status).toBe(401)
    expect(b.acked).toEqual([])
    expect(b.keys.list()[0].pending).toBe(true)
  })

  it('refuses an acknowledgement with no key or two keys that differ', async () => {
    const b = makeB()
    const send = await connect(b)
    await ask(send)
    expect((await send(MAGPIE_KEY_ACK_PATH, {}, JSON.stringify({ id: FRESH_ID }))).status).toBe(400)
    expect((await send(MAGPIE_KEY_ACK_PATH, { authorization: `Bearer ${FRESH}`, 'x-api-key': 'sk-magpie-key-other00000000000' }, JSON.stringify({ id: FRESH_ID }))).status).toBe(400)
    expect(b.acked).toEqual([])
  })

  it('refuses an acknowledgement for a key Magpie no longer lists as enabled', async () => {
    const b = makeB()
    const send = await connect(b)
    await ask(send)
    b.listed = b.listed.map((row) => ({ ...row, state: 'disabled' }))
    expect((await ack(send)).status).toBe(410)
    expect(b.acked).toEqual([])
    expect(b.keys.list()[0].pending).toBe(true)
  })

  it('fails the acknowledgement when B cannot settle its intent, so A gives the key back', async () => {
    const b = makeB()
    b.ackAnswer = { ok: false, why: 'disk full' }
    const send = await connect(b)
    await ask(send)
    expect(await ack(send)).toMatchObject({ status: 500, json: { ok: false } })
    expect((await send(MAGPIE_KEY_RETURN_PATH)).status).toBe(200)
    expect(b.revoked).toEqual([FRESH_ID])
    expect(b.keys.list()).toEqual([])
  })

  it('takes the key back itself when it cannot settle its intent, without waiting for A to return it', async () => {
    const b = makeB()
    b.ackAnswer = { ok: false, why: 'disk full' }
    const send = await connect(b)
    await ask(send)
    expect(await ack(send)).toMatchObject({ status: 500, json: { ok: false } })
    // A never gives it back (its return is lost): B already stopped honouring it and revoked it.
    expect(b.keys.list()).toEqual([])
    expect(b.revoked).toEqual([FRESH_ID])
  })

  it('fails closed with no way to settle intents at all', async () => {
    const b = makeB({ acknowledge: undefined })
    const send = await connect(b)
    await ask(send)
    expect((await ack(send)).status).toBeGreaterThanOrEqual(500)
    expect(b.keys.list()[0].pending).toBe(true)
  })

  it('gives back a pending key on return, and asking again replaces it', async () => {
    const b = makeB()
    const send = await connect(b)
    await ask(send)
    expect((await send(MAGPIE_KEY_RETURN_PATH)).status).toBe(200)
    expect(b.revoked).toEqual([FRESH_ID])
    await ask(send)
    await ask(send)
    expect(b.keys.list().filter((k) => k.peer === A)).toHaveLength(1)
  })

  it('never writes a key in its log', async () => {
    const b = makeB()
    const send = await connect(b)
    await ask(send)
    await ack(send)
    expect(b.logs.length).toBeGreaterThan(0)
    expect(b.logs.join('\n')).not.toContain('sk-magpie')
  })

  it('still serves a key bound before acknowledgements existed', async () => {
    const OLD = `sk-magpie-key-${'o'.repeat(30)}oldkey`
    const b = makeB()
    b.keys.add({ id: 'id-of-a-key-00000001', tail: 'oldkey', hash: keyHash(OLD), peer: A, device: 'laptop', at: 'x' })
    b.listed = [{ id: 'id-of-a-key-00000001', name: 'device-laptop--x', limit: null, tail: 'oldkey', state: 'enabled', access: 'full' }]
    expect((await model(await connect(b), OLD)).status).toBe(200)
  })
})

describe('the list of bound keys on disk', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bound-ack-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is written as v2 while a key is pending, so an older Cookrew reads nothing rather than honour it, and as v1 once none is', () => {
    const file = path.join(dir, 'magpie-bound-keys.json')
    const keys = createBoundKeys(fileStorage(file))
    keys.add({ id: FRESH_ID, tail: 'fresh1', hash: keyHash(FRESH), peer: A, device: 'laptop', at: 'x', pending: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ v: 2 })
    expect(createBoundKeys(fileStorage(file)).find(A, FRESH)).toMatchObject({ pending: true })
    keys.confirm(FRESH_ID)
    expect(JSON.parse(readFileSync(file, 'utf8')).v).toBe(1)
    expect(createBoundKeys(fileStorage(file)).find(A, FRESH)?.pending).toBeFalsy()
    expect(readFileSync(file, 'utf8')).not.toContain(FRESH)
  })

  it('confirms nothing it does not hold, and refuses a pending mark that is not true or false', () => {
    const file = path.join(dir, 'magpie-bound-keys.json')
    const keys = createBoundKeys(fileStorage(file))
    keys.confirm('id-nobody-gave-0001')
    expect(keys.list()).toEqual([])
    writeFileSync(file, JSON.stringify({ v: 2, keys: [{ id: FRESH_ID, tail: 'fresh1', hash: keyHash(FRESH), peer: A, device: 'laptop', at: 'x', pending: 'yes' }] }))
    expect(() => createBoundKeys(fileStorage(file)).list()).toThrow()
    writeFileSync(file, JSON.stringify({ v: 3, keys: [] }))
    expect(() => createBoundKeys(fileStorage(file)).list()).toThrow()
  })
})

describe('A’s acknowledgement on the wire', () => {
  async function farEnd(status: number, answer: unknown): Promise<{ open: Parameters<typeof ackKeyOver>[0]; seen: Array<{ fields: Record<string, string>; body: string }> }> {
    const seen: Array<{ fields: Record<string, string>; body: string }> = []
    const pair = await seal2Pair((stream: Seal2Stream) => {
      void (async () => {
        const body = new TextDecoder().decode(await readBody(stream.readable))
        seen.push({ fields: { ...stream.fields } as Record<string, string>, body })
        stream.respond(status, { 'content-type': 'application/json' })
        const writer = stream.writable.getWriter()
        await writer.write(new TextEncoder().encode(JSON.stringify(answer)))
        await writer.close()
      })()
    })
    closers.push(() => pair.close())
    return { open: async (_peer, kind, fields) => pair.a.openStream(kind, fields), seen }
  }

  it('carries the key as the credential and only the id in the body', async () => {
    const far = await farEnd(200, { ok: true, id: FRESH_ID })
    expect(await ackKeyOver(far.open)(A, FRESH, FRESH_ID)).toEqual({ ok: true })
    expect(far.seen).toHaveLength(1)
    expect(far.seen[0].fields[':path']).toBe(MAGPIE_KEY_ACK_PATH)
    expect(far.seen[0].fields.authorization).toBe(`Bearer ${FRESH}`)
    expect(JSON.parse(far.seen[0].body)).toEqual({ id: FRESH_ID })
  })

  it('reads an older Cookrew’s 404 as “cannot acknowledge”, and any other refusal as a refusal', async () => {
    const old = await farEnd(404, { error: { type: 'cookrew_sealed', message: 'Only model requests are served here.' } })
    expect(await ackKeyOver(old.open)(A, FRESH, FRESH_ID)).toMatchObject({ ok: false, old: true })
    const no = await farEnd(401, { ok: false, why: 'Solis-Core did not give this computer that key.' })
    expect(await ackKeyOver(no.open)(A, FRESH, FRESH_ID)).toEqual({ ok: false, old: false, why: 'Solis-Core did not give this computer that key.' })
    const odd = await farEnd(200, { ok: 'yes' })
    expect(await ackKeyOver(odd.open)(A, FRESH, FRESH_ID)).toMatchObject({ ok: false })
  })
})

describe('B restarts between giving a key and hearing it acknowledged', () => {
  const HEAD = 'ID  NAME  STATE  GATEWAY KEY  LIMIT  MODELS  ACCOUNTS  ACCESS'
  const KEY = `sk-magpie-key-${'k'.repeat(40)}abc123`

  /** The real ShareKeys against a Magpie CLI kept in memory. */
  function cli(): { run: MagpieRun; rows: Array<{ id: string; name: string; access: string }> } {
    const rows: Array<{ id: string; name: string; access: string }> = []
    let n = 0
    const run: MagpieRun = async (args) => {
      const [, verb, a1] = args
      if (verb === 'list') return { code: 0, stdout: `${HEAD}\n${rows.map((r) => `${r.id}  ${r.name}  enabled  sk-magpie-key-…${KEY.slice(-6)}  -  all  all  ${r.access}`).join('\n')}\n`, stderr: '' }
      if (verb === 'add') {
        n += 1
        rows.push({ id: String(n).padStart(24, 'e'), name: a1, access: args.includes('--read-only') ? 'read-only' : 'full' })
        return { code: 0, stdout: `${KEY}\n`, stderr: '' }
      }
      if (verb === 'access') {
        const row = rows.find((r) => r.id === a1)
        if (row) row.access = args[3]
      }
      if (verb === 'remove') rows.splice(rows.findIndex((r) => r.id === a1), 1)
      return { code: 0, stdout: '', stderr: '' }
    }
    return { run, rows }
  }

  function bootB(magpieCli: ReturnType<typeof cli>, intents: IntentStore, storage: BoundKeysStorage): { serve: ReturnType<typeof createMagpieServe>; keys: BoundKeys; share: ShareKeys } {
    const keys = createBoundKeys(storage)
    let serve: ReturnType<typeof createMagpieServe> | null = null
    const share = new ShareKeys({ run: magpieCli.run, intents, nonce: () => 'a'.repeat(32), processes: async () => [], beforeRevoke: (id) => serve?.unbind(id) })
    serve = createMagpieServe({
      switches: () => ON,
      gatewayPort: () => magpie.port,
      keys,
      listKeys: () => share.listed(),
      issue: async (device, permitted) => {
        const made = await share.issue({ device, dailyUsd: 20 }, permitted, { handover: false })
        return made.ok ? { ok: true, key: made.key, id: made.shared.id } : made
      },
      revoke: (id) => share.revoke(id),
      acknowledge: (id) => share.acknowledge(id),
      dial: (port) => loopbackDialer(port),
      name: () => 'Solis-Core',
      log: () => undefined
    })
    return { serve, keys, share }
  }

  const sender = async (serve: ReturnType<typeof createMagpieServe>) => {
    const pair = await seal2Pair((s) => serve(s, { mode: 'device', deviceId: A }, {} as never))
    closers.push(() => pair.close())
    return async (path: string, headers: Record<string, string>, body: string): Promise<{ status: number; json: Record<string, unknown> }> => {
      const stream = pair.a.openStream(MAGPIE_REMOTE_KIND, requestFields('POST', path, { 'content-type': 'application/json', ...headers }))
      const writer = stream.writable.getWriter()
      await writer.write(new TextEncoder().encode(body))
      await writer.close()
      const head = await stream.head
      return { status: head.status, json: JSON.parse(new TextDecoder().decode(await readBody(stream.readable))) as Record<string, unknown> }
    }
  }

  it('keeps warning and refusing the key after the restart, and a late acknowledgement then settles both', async () => {
    const magpieCli = cli()
    const intents = memoryIntentStore()
    const storage = memoryStorage()
    const first = bootB(magpieCli, intents, storage)
    const given = await (await sender(first.serve))(MAGPIE_KEY_PATH, {}, JSON.stringify({ name: 'laptop' }))
    expect(given).toMatchObject({ status: 200, json: { ok: true } })
    const id = String(given.json.id)
    // The answer is lost and B restarts: everything below is a new B on the same records.
    const second = bootB(magpieCli, intents, storage)
    expect((await second.share.list()).pending).toMatchObject([{ device: expect.stringContaining('laptop'), clearable: false }])
    const send = await sender(second.serve)
    expect((await send('/v1/messages', { 'x-api-key': KEY }, '{}')).status).toBe(401)
    expect(await send(MAGPIE_KEY_ACK_PATH, { authorization: `Bearer ${KEY}` }, JSON.stringify({ id }))).toMatchObject({ status: 200 })
    expect(intents.read()).toEqual([])
    expect(second.keys.find(A, KEY)?.pending).toBeFalsy()
    expect((await send('/v1/messages', { 'x-api-key': KEY }, '{}')).status).toBe(200)
  })

  it('lets the owner revoke it by name after the restart, which unbinds it before Magpie forgets it', async () => {
    const magpieCli = cli()
    const intents = memoryIntentStore()
    const storage = memoryStorage()
    const first = bootB(magpieCli, intents, storage)
    await (await sender(first.serve))(MAGPIE_KEY_PATH, {}, JSON.stringify({ name: 'laptop' }))
    const second = bootB(magpieCli, intents, storage)
    const [pending] = (await second.share.list()).pending
    expect(await second.share.resolve(pending.name)).toMatchObject({ ok: true, left: 0, live: 0 })
    expect(second.keys.list()).toEqual([])
    expect(magpieCli.rows).toEqual([])
    expect(await second.share.clear(pending.name)).toEqual({ ok: true })
  })
})
