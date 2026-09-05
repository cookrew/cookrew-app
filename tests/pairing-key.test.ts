import { describe, expect, it } from 'vitest'
import {
  PAIRING_ALPHABET,
  PAIRING_KEY_LENGTH,
  PAIRING_KEY_TTL_MS,
  createPairingKeyRing,
  normalizePairingKey
} from '../src/main/pairing-key'

/** A clock the test drives by hand, so rotation is exact and not a sleep. */
const clock = (start = 1_000_000) => {
  let t = start
  return { now: () => t, tick: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) }
}

/** Bytes that walk the alphabet, so a minted key is predictable. */
const counterBytes = () => {
  let n = 0
  return (size: number) => Uint8Array.from({ length: size }, () => n++)
}

describe('pairing key alphabet', () => {
  it('is the unambiguous 32-character alphabet with no I, O, 0 or 1', () => {
    expect(PAIRING_ALPHABET).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ23456789')
    expect(PAIRING_ALPHABET).toHaveLength(32)
    for (const confusing of ['I', 'O', '0', '1']) {
      expect(PAIRING_ALPHABET).not.toContain(confusing)
    }
  })

  it('mints six characters drawn only from that alphabet', () => {
    const ring = createPairingKeyRing()
    for (let i = 0; i < 200; i++) {
      ring.reset()
      const { key } = ring.current()
      expect(key).toHaveLength(PAIRING_KEY_LENGTH)
      expect(key).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    }
  })

  it('masks each random byte to five bits, so every value maps into the alphabet', () => {
    // 0..255 covers every byte a real CSPRNG can hand over.
    const ring = createPairingKeyRing({ randomBytes: counterBytes() })
    const seen = new Set<string>()
    for (let i = 0; i < 42; i++) {
      ring.reset()
      for (const ch of ring.current().key) seen.add(ch)
    }
    expect(seen.size).toBe(32)
    for (const ch of seen) expect(PAIRING_ALPHABET).toContain(ch)
  })

  it('does not repeat itself across mints', () => {
    const ring = createPairingKeyRing()
    const keys = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ring.reset()
      keys.add(ring.current().key)
    }
    expect(keys.size).toBeGreaterThan(90)
  })
})

describe('pairing key rotation', () => {
  it('holds one key steady for two minutes and reports when it renews', () => {
    const c = clock()
    const ring = createPairingKeyRing({ now: c.now })
    const first = ring.current()
    expect(first.expiresAt - first.mintedAt).toBe(PAIRING_KEY_TTL_MS)

    c.tick(PAIRING_KEY_TTL_MS - 1)
    expect(ring.current().key).toBe(first.key)

    c.tick(1)
    const second = ring.current()
    expect(second.key).not.toBe(first.key)
    expect(second.mintedAt).toBe(first.expiresAt)
  })

  it('rotates lazily — asking twice inside the window mints once', () => {
    const c = clock()
    const ring = createPairingKeyRing({ now: c.now })
    const a = ring.current()
    c.tick(1000)
    const b = ring.current()
    expect(b).toEqual(a)
  })
})

describe('pairing key acceptance', () => {
  it('accepts the current key', () => {
    const c = clock()
    const ring = createPairingKeyRing({ now: c.now })
    expect(ring.accepts(ring.current().key)).toBe(true)
  })

  it('accepts the previous key for as long as its replacement lives', () => {
    const c = clock()
    const ring = createPairingKeyRing({ now: c.now })
    const first = ring.current().key
    c.tick(PAIRING_KEY_TTL_MS)
    const second = ring.current().key
    expect(second).not.toBe(first)

    // The phone read `first` just before the flip and types it now.
    expect(ring.accepts(first)).toBe(true)
    expect(ring.accepts(second)).toBe(true)

    // `second` expires; `first` goes with it.
    c.tick(PAIRING_KEY_TTL_MS - 1)
    expect(ring.accepts(first)).toBe(true)
    c.tick(1)
    expect(ring.accepts(first)).toBe(false)
  })

  it('never accepts a third generation back', () => {
    const c = clock()
    const ring = createPairingKeyRing({ now: c.now })
    const first = ring.current().key
    c.tick(PAIRING_KEY_TTL_MS)
    ring.current()
    c.tick(PAIRING_KEY_TTL_MS)
    ring.current()
    expect(ring.accepts(first)).toBe(false)
  })

  it('refuses an expired current that was never rotated', () => {
    // The popout closed, so nobody asked for a new key. Calling accepts must
    // not resurrect the dead one by rotating it into the previous slot.
    const c = clock()
    const ring = createPairingKeyRing({ now: c.now })
    const only = ring.current().key
    c.tick(PAIRING_KEY_TTL_MS)
    expect(ring.accepts(only)).toBe(false)
    expect(ring.accepts(only)).toBe(false)
  })

  it('refuses a key that was never minted, and the empty string', () => {
    const ring = createPairingKeyRing()
    ring.current()
    expect(ring.accepts('ZZZZZZ')).toBe(false)
    expect(ring.accepts('')).toBe(false)
    expect(ring.accepts('ABCDEFG')).toBe(false)
  })

  it('refuses everything before a key has ever been minted', () => {
    const ring = createPairingKeyRing()
    expect(ring.accepts('ABCDEF')).toBe(false)
  })

  it('forgives case, spaces and dashes, because the key is typed by hand', () => {
    const c = clock()
    const ring = createPairingKeyRing({ now: c.now })
    const { key } = ring.current()
    expect(ring.accepts(key.toLowerCase())).toBe(true)
    expect(ring.accepts(`${key.slice(0, 3)} ${key.slice(3)}`)).toBe(true)
    expect(ring.accepts(`${key.slice(0, 3)}-${key.slice(3)}`)).toBe(true)
    expect(normalizePairingKey(' ab-cd ef ')).toBe('ABCDEF')
  })

  it('forgets both keys on reset', () => {
    const c = clock()
    const ring = createPairingKeyRing({ now: c.now })
    const first = ring.current().key
    c.tick(PAIRING_KEY_TTL_MS)
    const second = ring.current().key
    ring.reset()
    expect(ring.accepts(first)).toBe(false)
    expect(ring.accepts(second)).toBe(false)
  })
})
