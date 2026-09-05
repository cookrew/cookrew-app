/**
 * A device id DERIVED from the device's key, in the shape the registry wants.
 *
 * Both halves of the identity had a reason and the reasons collided: the
 * registry admits only UUID-shaped device ids (accounts.ts), and the app
 * derives a device's id from its key digest so that a phone which loses its
 * stored id but keeps its key re-derives the SAME id rather than binding a
 * duplicate. This keeps both: the first sixteen bytes of the digest, written
 * as a UUID with the version nibble set to 8 (no RFC version claims a
 * hash-of-a-JWK) and the RFC 4122 variant bits, so it is a valid UUID and
 * still a pure function of the key.
 */
export function uuidFromDigest(digest: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(digest instanceof Uint8Array ? digest : new Uint8Array(digest))
  if (bytes.length < 16) throw new Error('a device id needs at least 16 digest bytes')
  const id = Array.from(bytes.slice(0, 16))
  id[6] = (id[6] & 0x0f) | 0x80
  id[8] = (id[8] & 0x3f) | 0x80
  const hex = id.map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const DEVICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
