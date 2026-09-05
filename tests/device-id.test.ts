import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { DEVICE_UUID, uuidFromDigest } from '../src/shared/device-id'

// The registry admits only UUID-shaped device ids; the app derives ids from
// the key so a device that loses its stored id re-derives the same one. Both
// hold when the derived id is written as a UUID.
describe('uuidFromDigest', () => {
  const digest = createHash('sha256').update('a key thumbprint').digest()

  it('is a valid UUID and a pure function of the digest', () => {
    const id = uuidFromDigest(digest)
    expect(id).toMatch(DEVICE_UUID)
    expect(uuidFromDigest(new Uint8Array(digest))).toBe(id)
    expect(id[14]).toBe('8')
    expect(['8', '9', 'a', 'b']).toContain(id[19])
  })

  it('differs for a different key and refuses a short digest', () => {
    expect(uuidFromDigest(createHash('sha256').update('another').digest())).not.toBe(
      uuidFromDigest(digest)
    )
    expect(() => uuidFromDigest(new Uint8Array(8))).toThrow(/16 digest bytes/)
  })
})
