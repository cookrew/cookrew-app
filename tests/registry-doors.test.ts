import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DOOR_REACH,
  DoorStore,
  doorPath,
  isPrivateAddress,
  validDoorAddress,
  validRelayAddress,
  type DoorInput
} from '../registry/src/doors'

/**
 * THE DIRECTORY OF SERVED TEAMS (R30 step 1).
 *
 * What the registry lists is no longer an artifact you download but a door you
 * can reach. These pin the two properties a directory of other people's
 * addresses has to have: a name belongs to exactly one handle, and the address
 * is recorded verbatim — a registry that could edit it could point a caller's
 * payment somewhere else.
 */

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'doors-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const door = (over: Partial<DoorInput> = {}): DoorInput => ({
  handle: 'drej',
  name: 'cookrew-alpha',
  title: 'COOKREW Alpha',
  door: 'Pilot',
  agents: 3,
  address: 'http://192.168.2.40:8639/cookrew-alpha',
  transport: 'lan',
  access: 'paid',
  priceUsd: '2.50',
  rails: ['x402', 'stripe'],
  ...over
})

describe('a door address is validated the way the caller parses it', () => {
  it('accepts exactly one slug deep, over http or https', () => {
    expect(validDoorAddress('http://192.168.2.40:8639/cookrew-alpha')).toBe(true)
    expect(validDoorAddress('https://drej.cookrew.dev/research-crew')).toBe(true)
  })

  it('refuses anything that is not one plain address', () => {
    for (const bad of [
      'http://a.example/',
      'http://a.example/two/deep',
      'http://user:pw@a.example/slug',
      'http://a.example/slug?x=1',
      'http://a.example/slug#f',
      'ftp://a.example/slug',
      'not a url'
    ]) {
      expect(validDoorAddress(bad), bad).toBe(false)
    }
  })
})

describe('registering a door', () => {
  it('records the address verbatim and stamps when it was seen', () => {
    const store = new DoorStore(dir)
    const result = store.register('drej', door())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.door.address).toBe('http://192.168.2.40:8639/cookrew-alpha')
    expect(result.door.seenAt).toBeGreaterThan(0)
    expect(store.get('drej', 'cookrew-alpha')?.title).toBe('COOKREW Alpha')
  })

  it('a name belongs to ONE handle — the caller cannot register under another', () => {
    const store = new DoorStore(dir)
    const result = store.register('drej', door({ handle: 'someone-else' }))
    expect(result).toEqual({ ok: false, reason: 'not-yours' })
    expect(store.list()).toHaveLength(0)
  })

  it('refuses a face it cannot show honestly', () => {
    const store = new DoorStore(dir)
    // Paid with no price is a door that cannot quote.
    expect(store.register('drej', { ...door(), priceUsd: undefined })).toEqual({
      ok: false,
      reason: 'bad-face'
    })
    expect(store.register('drej', door({ title: '' }))).toEqual({ ok: false, reason: 'bad-face' })
    expect(store.register('drej', door({ agents: -1 }))).toEqual({ ok: false, reason: 'bad-face' })
    expect(store.register('drej', door({ address: 'http://a/b/c' }))).toEqual({
      ok: false,
      reason: 'bad-address'
    })
    expect(store.register('drej', door({ name: 'Not A Slug' }))).toEqual({
      ok: false,
      reason: 'bad-name'
    })
  })

  it('re-registering the same name refreshes it rather than duplicating', () => {
    const store = new DoorStore(dir)
    store.register('drej', door())
    store.register('drej', door({ title: 'COOKREW Alpha v2', priceUsd: '3.00' }))
    expect(store.list()).toHaveLength(1)
    expect(store.get('drej', 'cookrew-alpha')?.title).toBe('COOKREW Alpha v2')
  })

  it('a free door needs no price, and never invents one', () => {
    const store = new DoorStore(dir)
    const result = store.register('drej', {
      ...door(),
      name: 'qa-orch-door',
      access: 'account',
      priceUsd: undefined,
      rails: []
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.door.priceUsd).toBeUndefined()
  })
})

describe('the directory', () => {
  it('lists newest refresh first and searches title, handle and name', () => {
    const store = new DoorStore(dir)
    store.register('drej', door({ name: 'alpha', title: 'COOKREW Alpha' }))
    store.register('ana', {
      ...door(),
      handle: 'ana',
      name: 'research-crew',
      title: 'Research Crew',
      access: 'account',
      priceUsd: undefined,
      rails: []
    })
    expect(store.list().map((d) => d.name)).toEqual(['research-crew', 'alpha'])
    expect(store.list('research').map((d) => d.handle)).toEqual(['ana'])
    expect(store.list('drej').map((d) => d.name)).toEqual(['alpha'])
    expect(store.list('nothing-like-this')).toHaveLength(0)
  })

  it('withdrawing is a listing decision, and only the owner may make it', () => {
    const store = new DoorStore(dir)
    store.register('drej', door())
    expect(store.withdraw('ana', 'cookrew-alpha')).toBe(false)
    expect(store.list()).toHaveLength(1)
    expect(store.withdraw('drej', 'cookrew-alpha')).toBe(true)
    expect(store.list()).toHaveLength(0)
  })

  it('survives a restart — a shared link is a promise', () => {
    new DoorStore(dir).register('drej', door())
    const reopened = new DoorStore(dir)
    expect(reopened.get('drej', 'cookrew-alpha')?.address).toBe(
      'http://192.168.2.40:8639/cookrew-alpha'
    )
    // Written privately: the file lists where other people's doors are.
    const raw = JSON.parse(readFileSync(path.join(dir, 'doors.json'), 'utf8')) as unknown[]
    expect(raw).toHaveLength(1)
  })

  it('the canonical path is one owner, one name', () => {
    expect(doorPath('drej', 'cookrew-alpha')).toBe('/@drej/cookrew-alpha')
  })
})

describe('a door says who can actually open its link', () => {
  /**
   * The transport is not bookkeeping. It is the answer to the only question an
   * owner should be asked about serving, and the card that hands out a link
   * has to be able to say it — a person who shares a 192.168 address believing
   * it is public has been told something false by the product.
   */
  it('every transport has a reach sentence, in the reader’s words not ours', () => {
    for (const [transport, reach] of Object.entries(DOOR_REACH)) {
      expect(reach.length, transport).toBeGreaterThan(8)
      // OUR tokens must not surface. "tailnet" is deliberately NOT banned: to
      // someone who turned Tailscale on it is their own product's noun and the
      // most precise word available, where "lan" and "relay" are ours.
      expect(reach, transport).not.toMatch(/\b(lan|relay|transport|nat|proxy)\b/i)
    }
    expect(DOOR_REACH.lan).not.toBe(DOOR_REACH.public)
  })

  it('refuses to list a private address as reachable by anyone', () => {
    const store = new DoorStore(dir)
    for (const transport of ['public', 'tailnet'] as const) {
      expect(store.register('drej', door({ transport })), transport).toEqual({
        ok: false,
        reason: 'bad-face'
      })
    }
    // A RELAYED door is refused earlier and harder: its address may only ever
    // be its own published name, so there is no address of the owner's to
    // record — private or otherwise.
    expect(store.register('drej', door({ transport: 'relay' }))).toEqual({
      ok: false,
      reason: 'bad-address'
    })
    // The same address IS listable when it says what it is.
    expect(store.register('drej', door({ transport: 'lan' })).ok).toBe(true)
  })

  it('knows which hosts only the owner can route to', () => {
    for (const priv of [
      'http://127.0.0.1:8639/x',
      'http://192.168.2.40:8639/x',
      'http://10.0.0.4:8639/x',
      'http://172.16.5.5:8639/x',
      'http://172.31.0.1:8639/x',
      'http://169.254.1.1:8639/x',
      'http://mac.local:8639/x',
      'http://localhost:8639/x'
    ]) {
      expect(isPrivateAddress(priv), priv).toBe(true)
    }
    for (const pub of [
      'https://cookrew.dev/x',
      'https://tenonworkspace-1994.tailc542fb.ts.net/x',
      'http://172.32.0.1:8639/x'
    ]) {
      expect(isPrivateAddress(pub), pub).toBe(false)
    }
  })
})

describe('a relayed door publishes a name, not a place', () => {
  const relayed = (over: Partial<DoorInput> = {}): DoorInput => ({
    handle: 'drej',
    name: 'cookrew-alpha',
    title: 'COOKREW Alpha',
    door: 'Pilot',
    agents: 3,
    address: 'https://cookrew.dev/@drej/cookrew-alpha',
    transport: 'relay',
    access: 'paid',
    priceUsd: '2.50',
    rails: ['x402'],
    sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
    ...over
  })

  it('records the relay’s own URL and nothing about the owner', () => {
    const store = new DoorStore(dir)
    const out = store.register('drej', relayed())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // The owner is on a laptop behind a router. Publishing where that laptop
    // actually is would put their home network in a public directory, for a
    // machine nobody can dial anyway.
    const recorded = JSON.stringify(out.door)
    expect(recorded).not.toContain('192.168')
    expect(recorded).not.toContain('8639')
    expect(out.door.address).toBe('https://cookrew.dev/@drej/cookrew-alpha')
  })

  it('refuses an address that is not exactly this door’s name', () => {
    const store = new DoorStore(dir)
    for (const address of [
      'https://cookrew.dev/@ana/cookrew-alpha',
      'https://cookrew.dev/@drej/other-team',
      'https://cookrew.dev/cookrew-alpha',
      'http://192.168.2.40:8639/cookrew-alpha',
      'https://cookrew.dev/@drej/cookrew-alpha?x=1'
    ]) {
      expect(store.register('drej', relayed({ address })), address).toEqual({
        ok: false,
        reason: 'bad-address'
      })
    }
  })

  it('refuses a relayed door with no key to pin', () => {
    // Unpinned, the relay carrying the conversation could stand in the middle
    // of it. A listing without the key would ask callers to trust that blindly.
    const store = new DoorStore(dir)
    expect(store.register('drej', relayed({ sealKey: undefined }))).toEqual({
      ok: false,
      reason: 'bad-face'
    })
    expect(store.register('drej', relayed({ sealKey: 'short' }))).toEqual({
      ok: false,
      reason: 'bad-face'
    })
  })

  it('a relay address is this door’s path, on any origin', () => {
    expect(validRelayAddress('https://cookrew.dev/@drej/alpha', 'drej', 'alpha')).toBe(true)
    // A local registry is a legitimate origin; the PATH is what is pinned.
    expect(validRelayAddress('http://localhost:8791/@drej/alpha', 'drej', 'alpha')).toBe(true)
    expect(validRelayAddress('https://cookrew.dev/@drej/beta', 'drej', 'alpha')).toBe(false)
    expect(validRelayAddress('not a url', 'drej', 'alpha')).toBe(false)
  })
})
