// THE OTHER COMPUTERS WHOSE MAGPIE THIS ONE USES (remotes.ts): the key each gave
// this one, sealed at rest where a keychain is; connecting asks for it over the
// seal and adds a provider whose key is only a placeholder; anything that fails
// gives the key back.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectRemote, createRemotesStore, disconnectRemote, perComputer, providerIdFor, resumeRemotes, type ConnectDeps } from '../src/main/magpie-remote/remotes'
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
    ackKey: async () => ({ ok: true }),
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
    seatGate: async () => true,
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
    expect(await connectRemote(PEER, 'Solis', d)).toEqual({ ok: false, why: 'magpie said no The key was given back.' })
    expect(d.returned).toEqual([PEER])
    expect(d.store.keyFor(PEER)).toBeNull()
  })

  it('says so when the other computer would not take its key back, instead of claiming it did', async () => {
    const d = deps({ addProvider: async () => ({ ok: false, why: 'magpie said no.' }), returnKey: async () => { throw new Error('403 switched off') } })
    const answer = await connectRemote(PEER, 'Solis', d)
    expect(answer).toMatchObject({ ok: false, why: expect.stringContaining('could not be given back') })
    expect(JSON.stringify(answer)).not.toContain('was given back')
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

describe('acknowledging the key (Relay contract)', () => {
  it('acknowledges only once the key is kept on disk, and before any provider is added', async () => {
    const file = path.join(dir, 'magpie-remotes.json')
    const seen: Array<{ peer: string; key: string; id: string; onDisk: string | null; added: number }> = []
    const d = deps({
      ackKey: async (peer, key, id) => {
        seen.push({ peer, key, id, onDisk: createRemotesStore(file, sealer).unacked(peer)?.key ?? null, added: d.added.length })
        return { ok: true }
      }
    })
    expect(await connectRemote(PEER, 'Solis Core', d)).toEqual({ ok: true, providerId: 'solis-core' })
    expect(seen).toEqual([{ peer: PEER, key: KEY, id: 'id1', onDisk: KEY, added: 0 }])
    expect(d.added).toHaveLength(1)
  })

  it('fails closed when the other computer refuses the acknowledgement: no key kept, the key given back, no provider', async () => {
    const d = deps({ ackKey: async () => ({ ok: false, why: 'Solis-Core did not give this computer that key.', old: false }) })
    expect(await connectRemote(PEER, 'Solis', d)).toEqual({ ok: false, why: 'Solis-Core did not give this computer that key. The key was given back.' })
    expect(d.store.keyFor(PEER)).toBeNull()
    expect(d.returned).toEqual([PEER])
    expect(d.added).toEqual([])
  })

  it('fails closed against an older Cookrew that cannot acknowledge, and says to update it', async () => {
    const d = deps({ ackKey: async () => ({ ok: false, why: 'Only model requests are served here.', old: true }) })
    expect(await connectRemote(PEER, 'Solis', d)).toMatchObject({ ok: false, why: expect.stringContaining('Update Cookrew on Solis') })
    expect(d.store.keyFor(PEER)).toBeNull()
    expect(d.returned).toEqual([PEER])
    expect(d.added).toEqual([])
  })

  it('asks once more when the acknowledgement’s stream breaks (it is idempotent); after a second break the key waits, unused, to be said again', async () => {
    let tries = 0
    const flaky = deps({
      ackKey: async () => {
        tries += 1
        if (tries === 1) throw new Error('stream cut')
        return { ok: true }
      }
    })
    expect(await connectRemote(PEER, 'Solis', flaky)).toMatchObject({ ok: true })
    expect(tries).toBe(2)
    const broken = deps({
      ackKey: async () => {
        throw new Error('stream cut')
      }
    })
    expect(await connectRemote(PEER, 'Solis', broken)).toMatchObject({ ok: false })
    // Unheard is not refused (Relay's ruling): kept with acked false, sent with nothing, never given back yet.
    expect(broken.store.keyFor(PEER)).toBeNull()
    expect(broken.store.unacked(PEER)).toMatchObject({ key: KEY, keyId: 'id1' })
    expect(broken.returned).toEqual([])
    expect(broken.added).toEqual([])
  })
})

describe('the served-seat gate (lane Seatbelt)', () => {
  it('refuses to connect while the gate fails or cannot answer, asking the other computer nothing', async () => {
    const askKey = vi.fn()
    for (const seatGate of [async () => false, async () => { throw new Error('lsof missing') }]) {
      expect(await connectRemote(PEER, 'Solis', deps({ askKey, seatGate }))).toMatchObject({ ok: false, why: expect.stringContaining('older sandbox') })
    }
    expect(askKey).not.toHaveBeenCalled()
    expect(await connectRemote(PEER, 'Solis', deps({ seatGate: async () => true }))).toMatchObject({ ok: true })
  })
})

describe('the forwarder waits on the served-seat gate', () => {
  it('holds its port, refuses every request while the gate is shut, and serves once it passes', async () => {
    const { createMagpieRemote } = await import('../src/main/magpie-remote/setup')
    const asked: boolean[] = []
    const make = (answer: boolean) =>
      createMagpieRemote({
        base: dir,
        switches: () => ({ magpie: true, magpieRemote: true }),
        shareKeys: () => null,
        gatewayPort: () => null,
        openStream: async () => { throw new Error('none') },
        desktops: async () => [],
        selfId: () => null,
        sealer: null,
        magpieBin: () => null,
        env: () => ({ home: dir, env: {} }),
        log: () => undefined,
        seatGate: async () => {
          asked.push(answer)
          return answer
        },
        callerIsMagpie: async () => true,
        forwardPort: 0
      })
    // The port is held whatever the gate says; a shut gate refuses every request instead (forward.ts open()).
    const shut = make(false)
    await shut.start()
    try {
      expect(shut.port()).not.toBeNull()
      const r = await fetch(`http://127.0.0.1:${shut.port()}/peer/deviceB0000000000000000000000002/v1/models`, { headers: { host: `127.0.0.1:${shut.port()}` } })
      expect(r.status).toBe(403)
      expect(asked).toEqual([false])
    } finally {
      await shut.stop()
    }
    const open = make(true)
    await open.start()
    try {
      expect(open.port()).not.toBeNull()
    } finally {
      await open.stop()
    }
  })
})

describe('relay ruling (b): a key kept but not yet acknowledged is acknowledged again on start and on reconnect', () => {
  /** A's crash between keeping the key and acknowledging it: the ack's stream breaks every time. */
  const crashedBeforeAck = async (): Promise<ReturnType<typeof deps>> => {
    const d = deps({ ackKey: async () => { throw new Error('stream broke') } })
    expect(await connectRemote(PEER, 'Solis', d)).toMatchObject({ ok: false })
    return d
  }

  it('keeps the key with its id and acked false, and the forwarder gets no key until acknowledged', async () => {
    const d = await crashedBeforeAck()
    expect(d.store.list()).toMatchObject([{ peer: PEER, keyId: 'id1', acked: false }])
    expect(d.store.keyFor(PEER)).toBeNull()
    expect(JSON.stringify(JSON.parse(readFileSync(path.join(dir, 'magpie-remotes.json'), 'utf8')))).not.toContain(KEY)
    expect(d.added).toEqual([])
  })

  it('on start: acknowledges the kept key again, then points the provider at the forwarder, asking for no new key', async () => {
    const d = await crashedBeforeAck()
    const askKey = vi.fn(async () => ({ ok: true as const, key: KEY, id: 'id2' }))
    const acks: string[] = []
    const again = deps({ store: d.store, askKey, ackKey: async (_p, key, id) => (acks.push(`${id}:${key === KEY}`), { ok: true }) })
    await resumeRemotes(again)
    expect(acks).toEqual(['id1:true'])
    expect(askKey).not.toHaveBeenCalled()
    expect(again.store.list()).toMatchObject([{ peer: PEER, keyId: 'id1', acked: true }])
    expect(again.store.keyFor(PEER)).toBe(KEY)
    // 'solis' is the owner's own provider in this fixture: the kept record's id is used again.
    expect(again.added).toEqual([[d.store.list()[0].providerId, `http://127.0.0.1:3428/peer/${PEER}`]])
    expect(again.added[0][0]).toBe('solis-2')
  })

  it('on start: drops the key and gives it back when the other computer refuses it', async () => {
    const d = await crashedBeforeAck()
    const again = deps({ store: d.store, ackKey: async () => ({ ok: false, why: 'no longer has this key', old: false }) })
    await resumeRemotes(again)
    expect(again.store.list()).toEqual([])
    expect(again.returned).toEqual([PEER])
    expect(again.added).toEqual([])
  })

  it('on start: leaves it waiting while the other computer cannot be reached or a switch is off', async () => {
    const d = await crashedBeforeAck()
    await resumeRemotes(deps({ store: d.store, ackKey: async () => { throw new Error('offline') } }))
    expect(d.store.list()).toMatchObject([{ acked: false }])
    const off = deps({ store: d.store, switches: () => ({ magpie: true, magpieRemote: false }), ackKey: vi.fn() })
    await resumeRemotes(off)
    expect(off.ackKey).not.toHaveBeenCalled()
    expect(d.store.list()).toMatchObject([{ acked: false }])
  })

  it('on reconnect: acknowledges the kept key again instead of asking for another', async () => {
    const d = await crashedBeforeAck()
    const askKey = vi.fn(async () => ({ ok: true as const, key: KEY, id: 'id2' }))
    const again = deps({ store: d.store, askKey })
    expect(await connectRemote(PEER, 'Solis', again)).toMatchObject({ ok: true })
    expect(askKey).not.toHaveBeenCalled()
    expect(again.store.list()).toMatchObject([{ keyId: 'id1', acked: true }])
  })

  it('on reconnect: asks for a new key when the kept one is refused', async () => {
    const d = await crashedBeforeAck()
    let n = 0
    const again = deps({ store: d.store, askKey: async () => ({ ok: true as const, key: KEY, id: 'id2' }), ackKey: async (_p, _k, id) => (n += 1, id === 'id1' ? { ok: false, why: 'gone', old: false } : { ok: true }) })
    expect(await connectRemote(PEER, 'Solis', again)).toMatchObject({ ok: true })
    expect(n).toBe(2)
    expect(again.store.list()).toMatchObject([{ keyId: 'id2', acked: true }])
  })

  it('reads a record from before acknowledgements as acknowledged, so old connections keep working', () => {
    const store = createRemotesStore(path.join(dir, 'magpie-remotes.json'), null)
    writeFileSync(path.join(dir, 'magpie-remotes.json'), JSON.stringify({ v: 1, remotes: [{ peer: PEER, name: 'Solis', providerId: 'solis', at: 'x', plain: KEY }] }))
    expect(store.keyFor(PEER)).toBe(KEY)
  })

  it('refuses an acked field that is not a boolean instead of guessing', () => {
    const store = createRemotesStore(path.join(dir, 'magpie-remotes.json'), null)
    writeFileSync(path.join(dir, 'magpie-remotes.json'), JSON.stringify({ v: 1, remotes: [{ peer: PEER, name: 'Solis', providerId: 'solis', at: 'x', plain: KEY, keyId: 'id1', acked: 'no' }] }))
    expect(() => store.list()).toThrow()
  })
})

describe('verification review: the re-acknowledgement timer stops with the app', () => {
  const make = async () => {
    const { createMagpieRemote } = await import('../src/main/magpie-remote/setup')
    return createMagpieRemote({
      base: dir,
      switches: () => ({ magpie: true, magpieRemote: true }),
      shareKeys: () => null,
      gatewayPort: () => null,
      openStream: async () => {
        throw new Error('none')
      },
      desktops: async () => [],
      selfId: () => null,
      sealer: null,
      magpieBin: () => null,
      env: () => ({ home: dir, env: {} }),
      log: () => undefined,
      seatGate: async () => true,
      callerIsMagpie: async () => true,
      forwardPort: 0
    })
  }

  it('sets no retry timer when stop() runs while start() is still under way', async () => {
    const remote = await make()
    const intervals = vi.spyOn(globalThis, 'setInterval')
    try {
      const starting = remote.start()
      await remote.stop()
      await starting
      expect(intervals.mock.calls.filter(([, ms]) => ms === 5 * 60_000)).toEqual([])
    } finally {
      intervals.mockRestore()
      await remote.stop()
    }
  })

  it('sets one retry timer on start, and clears it on stop', async () => {
    const remote = await make()
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    try {
      await remote.start()
      await remote.start()
      const set = intervals.mock.results.filter((_, i) => intervals.mock.calls[i][1] === 5 * 60_000)
      expect(set).toHaveLength(1)
      await remote.stop()
      expect(cleared).toHaveBeenCalledWith(set[0].value)
    } finally {
      intervals.mockRestore()
      cleared.mockRestore()
      await remote.stop()
    }
  })
})
