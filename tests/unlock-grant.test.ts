// SETTING UP UNLOCK FROM A NEW DEVICE (shared/unlock-grant.ts): the device's flow
// against the Mac's real door, and what a relay in the middle can and cannot do.
import { Readable } from 'node:stream'
import type http from 'node:http'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createUnlockGrantDoor, GRANT_WAIT_MS, type UnlockGrantDeps } from '../src/main/unlock-grant'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { sealProofHeaders } from '../src/main/seal-proof'
import type { ViewerWho } from '../src/shared/remote-access'
import { commitmentOf, grantDigest, grantNonce, mintGrantKey, openGrantCode, sealGrantCode, wordsOfGrant, UNLOCK_GRANT_WORDS } from '../src/shared/unlock-grant'
import { keepGrant, pollGrant, startGrant, type GrantApi } from '../src/renderer/src/use/unlock-grant-flow'
import { createUnlockVault } from '../src/renderer/src/use/unlock-vault'

const CODE = 'c'.repeat(43)
const NEW: ViewerWho = { key: 'device:new', name: 'Console on iPad', here: false }
const PAIRED: ViewerWho = { key: 'device:old', name: 'Console on Android phone', here: false }

function bed(over: Partial<UnlockGrantDeps> = {}) {
  let clock = 1_000_000
  const asked: Array<{ name: string; words: readonly string[]; signal: AbortSignal }> = []
  let answer: ((yes: boolean) => void) | null = null
  const door = createUnlockGrantDoor({
    refusal: () => null,
    code: () => CODE,
    unlockKey: () => 'the-unlock-key',
    confirm: (ask) => {
      asked.push(ask)
      return new Promise<boolean>((resolve) => {
        answer = resolve
        ask.signal.addEventListener('abort', () => resolve(false))
      })
    },
    record: () => undefined,
    now: () => clock,
    ...over
  })
  const api = (who: ViewerWho): GrantApi => ({
    ask: (commit) => door.ask(who, { commit }),
    reveal: (id, key, nonce) => door.reveal(who, { id, key, nonce }),
    status: (id) => door.status(who, id)
  })
  const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  return { door, api, asked, atTheMac: (yes: boolean) => answer?.(yes), tick: (ms: number) => (clock += ms), settled }
}

const memoryVault = () => {
  const held = new Map<string, unknown>()
  return { held, vault: createUnlockVault({ get: async (key) => held.get(key), set: async (key, value) => void held.set(key, value), del: async (key) => void held.delete(key) }) }
}

describe('the seal', () => {
  it('opens only with the key of this exchange', async () => {
    const mac = await mintGrantKey()
    const phone = await mintGrantKey()
    const other = await mintGrantKey()
    const digest = await grantDigest({ id: 'i', macKey: mac.publicKey, macNonce: grantNonce(), unlockKey: 'u', phoneKey: phone.publicKey, phoneNonce: grantNonce() })
    const sealed = await sealGrantCode(mac.privateKey, phone.publicKey, digest, CODE)
    expect(await openGrantCode(phone.privateKey, mac.publicKey, digest, sealed)).toBe(CODE)
    expect(await openGrantCode(other.privateKey, mac.publicKey, digest, sealed)).toBeNull()
    // Sealed by anyone but the Mac's key of this record: refused, though the relay knows the phone's public key.
    expect(await openGrantCode(phone.privateKey, other.publicKey, digest, sealed)).toBeNull()
    const forged = await sealGrantCode(other.privateKey, phone.publicKey, digest, 'f'.repeat(43))
    expect(await openGrantCode(phone.privateKey, mac.publicKey, digest, forged)).toBeNull()
  })

  it('says the record in four words', async () => {
    const digest = await grantDigest({ id: 'i', macKey: 'a', macNonce: 'b', unlockKey: 'c', phoneKey: 'd', phoneNonce: 'e' })
    expect(wordsOfGrant(digest)).toHaveLength(UNLOCK_GRANT_WORDS)
  })
})

describe('setting up from a new device', () => {
  it('approved by a device that can already unlock: both see the same words, and the code and key are kept', async () => {
    const { door, api, settled } = bed()
    const started = await startGrant(api(NEW))
    if (started.kind !== 'waiting') throw new Error(started.message)
    const [waiting] = door.pending(PAIRED)
    expect(waiting.words).toEqual(started.session.words)
    expect(waiting.name).toBe('Console on iPad')
    expect(door.pending(NEW)).toEqual([])
    expect(await pollGrant(api(NEW), started.session)).toEqual({ kind: 'waiting' })
    expect(door.decide(PAIRED, { id: waiting.id, allow: true })).toEqual({ ok: true })
    await settled()
    const done = await pollGrant(api(NEW), started.session)
    expect(done).toEqual({ kind: 'done', code: CODE, unlockKey: 'the-unlock-key', by: 'Console on Android phone' })
    const saved: string[] = []
    const { vault } = memoryVault()
    if (done.kind !== 'done') return
    await keepGrant(done, { saveCode: (code) => saved.push(code), vault, machine: 'm' })
    expect(saved).toEqual([CODE])
    expect(await vault.trust('m', 'the-unlock-key')).toBe('same')
  })

  it('approved at the Mac: the prompt has the same words, and settling elsewhere takes it down', async () => {
    const { api, asked, atTheMac, settled, door } = bed()
    const started = await startGrant(api(NEW))
    if (started.kind !== 'waiting') throw new Error(started.message)
    await settled()
    expect(asked[0].words).toEqual(started.session.words)
    atTheMac(true)
    await settled()
    expect((await pollGrant(api(NEW), started.session)).kind).toBe('done')

    const again = await startGrant(api(NEW))
    if (again.kind !== 'waiting') throw new Error(again.message)
    await settled()
    door.decide(PAIRED, { id: again.session.id, allow: false })
    expect(asked[1].signal.aborted).toBe(true)
    expect(await pollGrant(api(NEW), again.session)).toMatchObject({ kind: 'denied' })
  })

  it('a Mac with no screen to ask on leaves it for a device to answer', async () => {
    const { api, door, settled } = bed({ confirm: async () => Promise.reject(new Error('no screen')) })
    const started = await startGrant(api(NEW))
    if (started.kind !== 'waiting') throw new Error(started.message)
    await settled()
    expect(door.waiting()).toBe(1)
  })

  it('a device cannot approve itself, nor read another device’s exchange', async () => {
    const { api, door } = bed()
    const started = await startGrant(api(NEW))
    if (started.kind !== 'waiting') throw new Error(started.message)
    expect(door.decide(NEW, { id: started.session.id, allow: true })).toMatchObject({ ok: false })
    expect(await door.status(PAIRED, started.session.id)).toMatchObject({ ok: false })
  })

  it('nobody answering in time ends it', async () => {
    const { api, tick } = bed()
    const started = await startGrant(api(NEW))
    if (started.kind !== 'waiting') throw new Error(started.message)
    tick(GRANT_WAIT_MS + 1)
    expect(await pollGrant(api(NEW), started.session)).toMatchObject({ kind: 'denied', message: expect.stringContaining('in time') })
  })
})

describe('a relay in the middle', () => {
  it('cannot reveal a key the device did not commit to', async () => {
    const { door } = bed()
    const phone = await mintGrantKey()
    const nonce = grantNonce()
    const asked = await door.ask(NEW, { commit: await commitmentOf(phone.publicKey, nonce) })
    if (!asked.ok) throw new Error(asked.error)
    const swapped = await mintGrantKey()
    expect(await door.reveal(NEW, { id: asked.id, key: swapped.publicKey, nonce })).toMatchObject({ ok: false })
    expect(door.waiting()).toBe(0)
  })

  it('that runs its own exchange with the Mac shows the owner other words than the device does', async () => {
    const { door, api } = bed()
    // The device's exchange goes to a Mac the relay plays; the relay's own goes to the real one.
    const fake = bed()
    const device = await startGrant(fake.api(NEW))
    const relay = await startGrant(api(NEW))
    if (device.kind !== 'waiting' || relay.kind !== 'waiting') throw new Error('did not start')
    expect(door.pending(PAIRED)[0].words).toEqual(relay.session.words)
    expect(door.pending(PAIRED)[0].words).not.toEqual(device.session.words)
  })
})

describe('the routes', () => {
  const TOKEN = 'pairing-token-123'
  const deps = (door: ReturnType<typeof bed>['door']): MobileApiDeps =>
    ({ pairingToken: TOKEN, store: { focusedId: 'ws' }, ops: {}, unlockGrants: { door, who: () => PAIRED, bus: new EventEmitter() } }) as unknown as MobileApiDeps

  async function call(api: MobileApiDeps, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const request = Readable.from(opts.body === undefined ? [] : [JSON.stringify(opts.body)]) as http.IncomingMessage
    request.method = method
    request.headers = { host: '127.0.0.1:8643', 'x-cookrew-relay': '1', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers }
    const out: { status: number; body: unknown } = { status: 0, body: undefined }
    const response = {
      writeHead(status: number) {
        out.status = status
        return this
      },
      end(raw?: string | Buffer) {
        out.body = raw ? JSON.parse(raw.toString()) : undefined
      }
    } as unknown as http.ServerResponse
    await handleMobileApi(request, response, new URL(path, 'http://lan.local'), api)
    return out
  }

  it('a relayed device may ask, with its own credential and nothing less', async () => {
    const { door } = bed()
    const commit = await commitmentOf((await mintGrantKey()).publicKey, grantNonce())
    expect((await call(deps(door), 'POST', '/api/unlock-grants/ask', { body: { commit } })).status).not.toBe(200)
    expect(await call(deps(door), 'POST', '/api/unlock-grants/ask', { token: TOKEN, body: { commit } })).toMatchObject({ status: 200, body: { ok: true } })
  })

  it('the words and the yes are read only inside the sealed session', async () => {
    const { door } = bed()
    expect((await call(deps(door), 'GET', '/api/unlock-grants/pending', { token: TOKEN })).status).toBe(403)
    expect((await call(deps(door), 'POST', '/api/unlock-grants/decide', { token: TOKEN, body: { id: 'x', allow: true } })).status).toBe(403)
    expect(await call(deps(door), 'GET', '/api/unlock-grants/pending', { token: TOKEN, headers: sealProofHeaders() })).toMatchObject({ status: 200, body: { ok: true, pending: [] } })
  })
})

describe('the Mac’s prompt', () => {
  it('is not shown for a device that never revealed', async () => {
    const confirm = vi.fn(async () => true)
    const { door } = bed({ confirm })
    await door.ask(NEW, { commit: await commitmentOf((await mintGrantKey()).publicKey, grantNonce()) })
    expect(confirm).not.toHaveBeenCalled()
  })
})
