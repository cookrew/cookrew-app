import { describe, expect, it } from 'vitest'
import { ANCHORS_FRESH_MS, createAnchorSource } from '../src/main/pair-anchors'

/**
 * THE MACHINE ASKS COOKREW.DEV AS LITTLE AS IT CAN.
 *
 * GET /api/pair needs no credential, so every ask must not become a registry
 * call: one read answers half a minute, callers arriving together share one,
 * and a failed read is not retried for half a minute either.
 */

const body = { username: 'anvztor', rpId: 'cookrew.dev', locked: false, passkeys: [], devices: [] }

describe('the anchor source', () => {
  it('shares one read between callers, and answers from it for half a minute', async () => {
    let clock = 1_000
    let calls = 0
    const source = createAnchorSource({
      fetch: async () => (calls += 1, body),
      username: () => 'anvztor',
      now: () => clock
    })
    await Promise.all([source.get(), source.get(), source.get()])
    expect(calls).toBe(1)
    clock += ANCHORS_FRESH_MS - 1
    await source.get()
    expect(calls).toBe(1)
    clock += 2
    await source.get()
    expect(calls).toBe(2)
    await source.get({ fresh: true })
    expect(calls).toBe(3)
  })

  it('after a failed read waits before asking again, and falls back to the last good answer', async () => {
    let clock = 1_000
    let calls = 0
    let up = true
    const source = createAnchorSource({
      fetch: async () => (calls += 1, up ? body : null),
      username: () => 'anvztor',
      now: () => clock
    })
    expect(await source.get()).not.toBeNull()
    up = false
    clock += ANCHORS_FRESH_MS
    expect(await source.get()).not.toBeNull()
    expect(calls).toBe(2)
    clock += 1
    await source.get()
    await source.get()
    expect(calls).toBe(2)
  })
})
