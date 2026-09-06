import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { V2Accounts, V2_FILE } from '../registry/src/v2-accounts'

/**
 * H2 — WHAT AN NXDOMAIN COSTS.
 *
 * Every negative DNS answer runs `desktopFor` (to decide whether the name
 * exists) and then `changedAt` (for the SOA serial in the authority section).
 * Both used to walk every account in the registry, on the same event loop that
 * serves the HTTPS API, driven by unauthenticated UDP that nobody has to
 * authenticate to send. A stranger asking for names that do not exist was
 * therefore buying a full scan per packet.
 *
 * So the two questions DNS asks are answered from an index kept in step by the
 * one function that writes an account, and the test is written twice over: an
 * absolute cost, and — the part that actually proves an index rather than a
 * lucky machine — that ten thousand accounts cost about what a hundred do.
 */

const dirs: string[] = []
afterAll(() => {
  for (const one of dirs) rmSync(one, { recursive: true, force: true })
})

const UUID = (n: number): string => {
  const hex = n.toString(16).padStart(12, '0')
  return `abcd1234-aaaa-bbbb-cccc-${hex}`
}

/**
 * A store of N accounts, written straight to the file rather than claimed.
 *
 * Ten thousand `create` calls would be ten thousand password stretches — an
 * hour of CPU to prove something about a lookup. The file is the same shape
 * the store writes, and `load` checks it on the way in.
 */
function storeOf(count: number): { accounts: V2Accounts; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'desktop-index-'))
  dirs.push(dir)
  const accounts = Array.from({ length: count }, (_, i) => ({
    username: `person${i}`,
    password: { hash: 'x'.repeat(44), salt: 'y'.repeat(22), n: 1, r: 8, p: 1 },
    displayName: '',
    avatar: null,
    claimedAt: 1_757_000_000_000,
    devices: [
      {
        id: UUID(i),
        kind: 'desktop',
        name: 'MacBook Pro',
        jwk: { kty: 'OKP', crv: 'Ed25519', x: 'aaa' },
        addedAt: 1_757_000_000_000,
        lastSeenAt: 1_757_000_000_000
      }
    ],
    desktops: [
      { deviceId: UUID(i), name: 'MacBook Pro', workspaces: [], reach: null, updatedAt: 1_757_000_000_000 + i }
    ],
    sessions: [],
    recovery: [],
    revoked: []
  }))
  writeFileSync(path.join(dir, V2_FILE), JSON.stringify({ version: 2, accounts }))
  return { accounts: new V2Accounts(dir), dir }
}

/** Microseconds per negative answer: the two lookups a NXDOMAIN makes. */
function costPerNegative(accounts: V2Accounts, rounds = 1000): number {
  // Warm, so the first call's lazy compilation is not the measurement.
  for (let i = 0; i < 200; i += 1) accounts.desktopFor(`missing-${i}`)
  const started = performance.now()
  for (let i = 0; i < rounds; i += 1) {
    accounts.desktopFor(`no-such-device-${i}`)
    accounts.desktopsChangedAt()
  }
  return ((performance.now() - started) * 1000) / rounds
}

describe('the desktop index', () => {
  it('answers a negative lookup in constant time, whatever the registry holds', () => {
    const small = storeOf(100)
    const large = storeOf(10_000)

    expect(large.accounts.desktopFor(UUID(9999))?.name).toBe('MacBook Pro')
    expect(large.accounts.desktopFor(UUID(99_999))).toBeNull()

    const cheap = costPerNegative(small.accounts)
    const dear = costPerNegative(large.accounts)
    // Generous on purpose: a laptop under a full test run is not a benchmark
    // rig, and what is being pinned is the shape rather than the number.
    expect(dear).toBeLessThan(200)
    // THE PART THAT PROVES AN INDEX. A scan across 10 000 accounts cannot be
    // within a small factor of a scan across 100; only a map can.
    expect(dear).toBeLessThan(Math.max(cheap, 0.05) * 20)
    console.log(`H2: ${cheap.toFixed(3)} µs at 100 accounts, ${dear.toFixed(3)} µs at 10 000`)
  })

  it('costs the same for the SOA serial, which every negative answer also reads', () => {
    const large = storeOf(10_000)
    const started = performance.now()
    for (let i = 0; i < 10_000; i += 1) large.accounts.desktopsChangedAt()
    const each = ((performance.now() - started) * 1000) / 10_000
    expect(each).toBeLessThan(5)
  })

  it('stays in step through a PUT, a revoke and a second account', () => {
    const { accounts } = storeOf(20)
    const id = UUID(3)
    expect(accounts.desktopFor(id)?.name).toBe('MacBook Pro')

    const before = accounts.desktopsChangedAt()
    expect(accounts.putDesktop('person3', id, { name: 'Studio', workspaces: [{ id: 'w', name: 'Work' }] })).toEqual({
      ok: true
    })
    expect(accounts.desktopFor(id)?.name).toBe('Studio')
    expect(accounts.desktopFor(id)?.workspaces).toHaveLength(1)
    // A desktop that changed moves the serial, or a secondary would never see it.
    expect(accounts.desktopsChangedAt()).toBeGreaterThanOrEqual(before)

    // A revoke takes the desktop with the device, and the index has to forget it.
    const second = {
      id: UUID(500_001),
      kind: 'phone' as const,
      name: 'iPhone',
      jwk: { kty: 'OKP', crv: 'Ed25519', x: 'bbb' }
    }
    expect(accounts.attachDevice('person3', second).ok).toBe(true)
    expect(accounts.revokeDevice('person3', id)).toEqual({ ok: true })
    expect(accounts.desktopFor(id)).toBeNull()

    // And a name that was never there is still not there.
    expect(accounts.desktopFor('not-a-device')).toBeNull()
  })

  it('does not move the DNS serial for a change that is not a desktop', () => {
    const { accounts } = storeOf(5)
    const serial = accounts.desktopsChangedAt()
    // `touch` writes last-seen on every /v2/me read. If that moved the serial,
    // every page view would look like a zone change to anyone watching.
    accounts.touch('person1', UUID(1))
    expect(accounts.desktopsChangedAt()).toBe(serial)
  })

  it('rebuilds the index from the file, so a restart answers the same', () => {
    const { dir } = storeOf(50)
    const reopened = new V2Accounts(dir)
    expect(reopened.desktopFor(UUID(7))?.name).toBe('MacBook Pro')
    expect(reopened.desktopsChangedAt()).toBe(1_757_000_000_000 + 49)
  })
})
