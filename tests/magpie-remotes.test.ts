// THE OTHER COMPUTERS WHOSE MAGPIE THIS ONE USES (remotes.ts): the key each gave
// this one, sealed at rest where a keychain is; connecting asks for it over the
// seal and adds a provider whose key is only a placeholder; anything that fails
// gives the key back.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectRemote, createRemotesStore, disconnectRemote, perComputer, providerIdFor, type ConnectDeps } from '../src/main/magpie-remote/remotes'
import type { SecretSealer } from '../src/main/secrets-store'

const PEER = 'deviceB0000000000000000000000002'
const KEY = `sk-magpie-key-${'s'.repeat(40)}`
const rot = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97))
const sealer: SecretSealer = { available: () => true, seal: (v) => Buffer.from(rot(v)), open: (b) => rot(b.toString()) }

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'magpie-remotes-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the remotes store', () => {
  it('keeps the key sealed, 0600, and gives it back to main only', () => {
    const file = path.join(dir, 'magpie-remotes.json')
    const store = createRemotesStore(file, sealer)
    store.put({ peer: PEER, name: 'Solis-Core', providerId: 'solis-core', at: 'x' }, KEY)
    expect(readFileSync(file, 'utf8')).not.toContain(KEY)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(createRemotesStore(file, sealer).keyFor(PEER)).toBe(KEY)
    expect(JSON.stringify(store.list())).not.toContain(KEY)
    expect(store.sealed()).toBe(true)
  })

  it('says when there is no keychain to seal with, and still keeps the key 0600', () => {
    const file = path.join(dir, 'magpie-remotes.json')
    const store = createRemotesStore(file, { ...sealer, available: () => false })
    store.put({ peer: PEER, name: 'Solis-Core', providerId: 'solis-core', at: 'x' }, KEY)
    expect(store.sealed()).toBe(false)
    expect(store.keyFor(PEER)).toBe(KEY)
  })

  it('refuses a garbled file instead of reading it as empty', () => {
    const file = path.join(dir, 'magpie-remotes.json')
    writeFileSync(file, '{"v":1,"remotes":[{"peer":1}]}')
    expect(() => createRemotesStore(file, sealer).list()).toThrow()
  })

  it('names the provider after the computer, never taking an id that is there', () => {
    expect(providerIdFor('Solis Core', [])).toBe('solis-core')
    expect(providerIdFor('Solis Core', ['solis-core'])).toBe('solis-core-2')
    expect(providerIdFor('!!!', [])).toBe('remote')
  })
})

function deps(over: Partial<ConnectDeps> = {}): ConnectDeps & { returned: string[]; added: [string, string][] } {
  const returned: string[] = []
  const added: [string, string][] = []
  return {
    switches: () => ({ magpie: true, magpieRemote: true }),
    store: createRemotesStore(path.join(dir, 'magpie-remotes.json'), sealer),
    askKey: async () => ({ ok: true, key: KEY, id: 'id1' }),
    returnKey: async (peer) => void returned.push(peer),
    addProvider: async (id, url) => {
      added.push([id, url])
      return { ok: true }
    },
    setProvider: async (id, url) => {
      added.push([`set:${id}`, url])
      return { ok: true }
    },
    removeProvider: async () => {},
    providers: async () => [{ id: 'solis', preset: 'remote-magpie', urls: ['http://127.0.0.1:13425'] }],
    forwarderPort: () => 3428,
    myName: () => 'drej-mac',
    returned,
    added,
    ...over
  }
}

describe('connecting to another computer’s Magpie', () => {
  it('asks for a key over the seal, keeps it, and adds a provider at the forwarder with no key in it', async () => {
    const d = deps()
    expect(await connectRemote(PEER, 'Solis Core', d)).toEqual({ ok: true, providerId: 'solis-core' })
    expect(d.added).toEqual([['solis-core', `http://127.0.0.1:3428/peer/${PEER}`]])
    expect(JSON.stringify(d.added)).not.toContain(KEY)
    expect(d.store.keyFor(PEER)).toBe(KEY)
  })

  it('refuses while either switch is off or unreadable, or with no forwarder, asking nothing', async () => {
    const askKey = vi.fn()
    for (const switches of [() => ({ magpie: true, magpieRemote: false }), () => null, () => { throw new Error('x') }]) {
      expect(await connectRemote(PEER, 'Solis', deps({ askKey, switches }))).toMatchObject({ ok: false })
    }
    expect(await connectRemote(PEER, 'Solis', deps({ askKey, forwarderPort: () => null }))).toMatchObject({ ok: false })
    expect(askKey).not.toHaveBeenCalled()
  })

  it('gives the key back when the provider cannot be added', async () => {
    const d = deps({ addProvider: async () => ({ ok: false, why: 'magpie said no' }) })
    expect(await connectRemote(PEER, 'Solis', d)).toEqual({ ok: false, why: 'magpie said no' })
    expect(d.returned).toEqual([PEER])
    expect(d.store.keyFor(PEER)).toBeNull()
  })

  it('passes the other computer’s refusal through', async () => {
    const d = deps({ askKey: async () => ({ ok: false, why: 'Magpie remote is switched off on Solis-Core.' }) })
    expect(await connectRemote(PEER, 'Solis', d)).toEqual({ ok: false, why: 'Magpie remote is switched off on Solis-Core.' })
  })

  it('disconnecting drops the key here, gives it back there, and removes the provider', async () => {
    const removed: string[] = []
    const d = deps({ removeProvider: async (id) => void removed.push(id) })
    await connectRemote(PEER, 'Solis Core', d)
    expect(await disconnectRemote(PEER, d)).toEqual({ ok: true })
    expect(d.store.keyFor(PEER)).toBeNull()
    expect(d.returned).toEqual([PEER])
    expect(removed).toEqual(['solis-core'])
  })
})

describe('review fixes: never repoint a provider that is not ours, and one connect per computer', () => {
  it('fails rather than guess when Magpie’s provider list cannot be read', async () => {
    const d = deps({ providers: async () => null })
    expect(await connectRemote(PEER, 'Solis Core', d)).toMatchObject({ ok: false })
    expect(d.added).toEqual([])
  })

  it('adds under a free id when the owner has a provider of that name, and points only our own one again', async () => {
    const owners = { id: 'solis-core', preset: 'deepseek', urls: ['https://api.deepseek.com'] }
    const d = deps({ providers: async () => [owners] })
    expect(await connectRemote(PEER, 'Solis Core', d)).toEqual({ ok: true, providerId: 'solis-core-2' })
    expect(d.added).toEqual([['solis-core-2', `http://127.0.0.1:3428/peer/${PEER}`]])
    const ours = { id: 'solis-core-2', preset: 'remote-magpie', urls: [`http://127.0.0.1:3428/peer/${PEER}`] }
    const again = deps({ store: d.store, providers: async () => [owners, ours] })
    expect(await connectRemote(PEER, 'Solis Core', again)).toEqual({ ok: true, providerId: 'solis-core-2' })
    expect(again.added).toEqual([['set:solis-core-2', `http://127.0.0.1:3428/peer/${PEER}`]])
  })

  it('never repoints a provider the owner made under the id this app used before', async () => {
    const d = deps({ providers: async () => [] })
    await connectRemote(PEER, 'Solis Core', d)
    const theirs = { id: 'solis-core', preset: 'openai', urls: ['https://api.example.com/v1'] }
    const again = deps({ store: d.store, providers: async () => [theirs] })
    expect(await connectRemote(PEER, 'Solis Core', again)).toEqual({ ok: true, providerId: 'solis-core-2' })
    expect(again.added).toEqual([['solis-core-2', `http://127.0.0.1:3428/peer/${PEER}`]])
  })

  it('never names a provider group, which Magpie reads as its own routing groups', () => {
    expect(providerIdFor('Group', [])).toBe('group-computer')
  })

  it('runs one connect or disconnect per computer at a time', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const d = deps({
      askKey: async () => {
        order.push('ask')
        await new Promise<void>((r) => (release = r))
        return { ok: true, key: KEY, id: 'id1' }
      },
      returnKey: async () => void order.push('return')
    })
    const lane = perComputer()
    const first = lane(PEER, () => connectRemote(PEER, 'Solis', d))
    const second = lane(PEER, () => disconnectRemote(PEER, d))
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['ask'])
    release()
    await first
    await second
    expect(order).toEqual(['ask', 'return'])
  })
})
