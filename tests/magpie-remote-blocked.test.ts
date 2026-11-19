// A DESKTOP THE OWNER SAID IS NOT THE SAME (Seal's seal-blocked.ts) LEAVES NO LIVE MAGPIE KEY (Relay, landing
// round): on B every key bound to that device is unbound first (its streams cut), then revoked by id through
// ShareKeys, each audited; a revoke that fails stays recorded and the launch sweep tries again. On A the
// remote for that desktop is dropped here (no give-back: it is refused on every lane). Idempotent.
import { describe, expect, it, vi } from 'vitest'
import { afterPeerAnswer, forgetBlockedDesktop, memoryPendingRevokes, sweepBlocked, type BlockedDeps } from '../src/main/magpie-remote/blocked'

const DEVICE = '0f3c9a2e-1b4d-4c8e-9f00-aa11bb22cc33'
const OTHER = '9a8b7c6d-0000-4000-8000-123456789abc'
const K1 = 'aaaaaaaaaaaaaaaaaaaaaaa1'
const K2 = 'aaaaaaaaaaaaaaaaaaaaaaa2'
const SECRET = `sk-magpie-key-${'z'.repeat(40)}`

function world(over: Partial<BlockedDeps> = {}) {
  const calls: string[] = []
  const audit: string[] = []
  let magpie = [K1, K2, 'other-computers-key00001']
  const deps: BlockedDeps = {
    pending: memoryPendingRevokes(),
    bound: (device) => (device === DEVICE ? [K1, K2] : device === OTHER ? ['other-computers-key00001'] : []),
    listed: async () => magpie,
    unbind: (id) => void calls.push(`unbind:${id}`),
    revoke: async (id) => {
      calls.push(`revoke:${id}`)
      magpie = magpie.filter((k) => k !== id)
      return { ok: true }
    },
    dropRemote: async (device) => (calls.push(`drop:${device}`), true),
    audit: (line) => void audit.push(line),
    ...over
  }
  return { deps, calls, audit, magpieKeys: () => magpie }
}

describe('blocking a desktop on B: its keys are unbound first, then revoked', () => {
  it('unbinds every key bound to it before revoking any, revokes each by id, and touches no other computer’s key', async () => {
    const w = world()
    expect(await forgetBlockedDesktop(DEVICE, w.deps)).toEqual({ revoked: [K1, K2], failed: [], dropped: true })
    expect(w.calls).toEqual([`unbind:${K1}`, `unbind:${K2}`, `revoke:${K1}`, `revoke:${K2}`, `drop:${DEVICE}`])
    expect(w.magpieKeys()).toEqual(['other-computers-key00001'])
    expect(w.deps.pending.read()).toEqual({})
  })

  it('audits each key, by id and device only', async () => {
    const w = world()
    await forgetBlockedDesktop(DEVICE, w.deps)
    expect(w.audit.filter((l) => l.includes('revoked'))).toHaveLength(2)
    expect(w.audit.join('\n')).toContain(K1)
    expect(w.audit.join('\n')).toContain(DEVICE.slice(0, 8))
    expect(w.audit.join('\n')).not.toContain(SECRET)
  })

  it('counts a key Magpie no longer lists as gone, asking Magpie to remove nothing', async () => {
    const w = world({ listed: async () => [K2] })
    expect(await forgetBlockedDesktop(DEVICE, w.deps)).toMatchObject({ revoked: [K1, K2], failed: [] })
    expect(w.calls).toEqual([`unbind:${K1}`, `unbind:${K2}`, `revoke:${K2}`, `drop:${DEVICE}`])
  })
})

describe('a revoke that fails is kept, said so, and tried again', () => {
  it('keeps the failed key recorded, never reports it done, and the next sweep revokes it', async () => {
    let failing = true
    const w = world({
      revoke: async (id) => (failing && id === K2 ? { ok: false, why: 'magpie busy' } : { ok: true })
    })
    expect(await forgetBlockedDesktop(DEVICE, w.deps)).toMatchObject({ revoked: [K1], failed: [K2] })
    expect(w.deps.pending.read()).toEqual({ [DEVICE]: [K2] })
    expect(w.audit.find((l) => l.includes(K2))).toMatch(/not revoked.*again/)
    // The binding is gone already (unbound first); the record is what the sweep finds.
    const retry = { ...w.deps, bound: () => [] }
    failing = false
    expect(await forgetBlockedDesktop(DEVICE, retry)).toMatchObject({ revoked: [K2], failed: [] })
    expect(w.deps.pending.read()).toEqual({})
  })

  it('records the keys to revoke before it unbinds or revokes anything', async () => {
    const order: string[] = []
    const pending = memoryPendingRevokes()
    const w = world({
      pending: { read: pending.read, write: (v) => (order.push(`write:${JSON.stringify(v)}`), pending.write(v)) },
      unbind: (id) => void order.push(`unbind:${id}`)
    })
    await forgetBlockedDesktop(DEVICE, w.deps)
    expect(order[0]).toBe(`write:${JSON.stringify({ [DEVICE]: [K1, K2] })}`)
    expect(order[1]).toBe(`unbind:${K1}`)
  })

  it('still unbinds and revokes when the record cannot be written, and says so', async () => {
    const w = world({ pending: { read: () => ({}), write: () => { throw new Error('disk full') } } })
    expect(await forgetBlockedDesktop(DEVICE, w.deps)).toMatchObject({ revoked: [K1, K2] })
    expect(w.audit.join('\n')).toMatch(/not recorded/)
  })

  it('with Magpie’s key list unreadable, still asks Magpie to revoke each key', async () => {
    const w = world({ listed: async () => null })
    expect(await forgetBlockedDesktop(DEVICE, w.deps)).toMatchObject({ revoked: [K1, K2] })
  })
})

describe('on A: the remote for a blocked desktop is dropped here', () => {
  it('drops it with no give-back, and audits it', async () => {
    const w = world({ bound: () => [] })
    expect(await forgetBlockedDesktop(DEVICE, w.deps)).toEqual({ revoked: [], failed: [], dropped: true })
    expect(w.calls).toEqual([`drop:${DEVICE}`])
    expect(w.audit.join('\n')).toMatch(/dropped/)
  })

  it('a drop that throws is a drop not done, and the B side still runs', async () => {
    const w = world({ dropRemote: async () => { throw new Error('store') } })
    expect(await forgetBlockedDesktop(DEVICE, w.deps)).toMatchObject({ revoked: [K1, K2], dropped: false })
  })
})

describe('the sweep and the owner’s answer reach it', () => {
  it('is idempotent: a second run with nothing bound or recorded revokes nothing', async () => {
    const w = world()
    await forgetBlockedDesktop(DEVICE, w.deps)
    const again = { ...w.deps, bound: () => [], dropRemote: async () => false }
    w.calls.length = 0
    expect(await forgetBlockedDesktop(DEVICE, again)).toEqual({ revoked: [], failed: [], dropped: false })
    expect(w.calls.filter((c) => c.startsWith('revoke'))).toEqual([])
  })

  it('the launch sweep asks for every blocked desktop, past one that throws', async () => {
    const forget = vi.fn(async (id: string) => {
      if (id === 'b') throw new Error('x')
    })
    await sweepBlocked(['a', 'b', 'c'], forget)
    expect(forget.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])
  })

  it('only NOT THE SAME, once Seal has taken the answer, reaches Magpie', () => {
    const blocked = vi.fn(async () => undefined)
    expect(afterPeerAnswer(DEVICE, 'not-same', true, blocked)).toBe(true)
    expect(afterPeerAnswer(DEVICE, 'same', true, blocked)).toBe(true)
    expect(afterPeerAnswer(DEVICE, 'later', true, blocked)).toBe(true)
    // Seal refused the answer (not a device id, not one of the three): Magpie does nothing either.
    expect(afterPeerAnswer('nope', 'not-same', false, blocked)).toBe(false)
    expect(blocked.mock.calls).toEqual([[DEVICE]])
  })
})
