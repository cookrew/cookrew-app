/* cookrew.dev — OPENING WHAT A MAC SEALED TO THIS DEVICE (M5, R2).
 *
 * registry/src/v2-device-seal.ts, the receiving half, in WebCrypto:
 * ECDH-P256 → HKDF-SHA256 → AES-256-GCM, nonce of twelve zero bytes, tag
 * appended, everything base64url without padding. The Mac seals; cookrew.dev
 * carries the envelope and cannot read it; this opens it.
 *
 *   CookrewDeviceSeal.open(privateKey, info, sealed) → string | null
 *     privateKey  a non-extractable ECDH P-256 CryptoKey (site.js mints it)
 *     info        the label the sealer used, e.g. `reach:<request id>`
 *     sealed      { alg: 'p256', e: '<x>.<y>', sealed: '<base64url>' }
 *
 * ONLY THE P-256 HALF IS HERE, and that is not an omission. The Node file also
 * seals to Ed25519 devices by mapping the signing key onto its X25519 twin,
 * which needs the private SEED; a browser's device key is non-extractable, so
 * the seed is the one thing it does not have. That is why site.js mints P-256
 * for the device — see mintDeviceKey — and why an Ed25519 envelope arriving
 * here is `null` rather than a half-built decryption: this browser genuinely
 * cannot open one, and saying so in the return value is how the caller learns
 * to offer the QR door instead.
 *
 * NULL FOR EVERY FAILURE, and never a throw. Tampered, replayed under the
 * wrong label, sealed to a different device of the same account, or simply not
 * ours: one silence for all of them, exactly as the Node half answers. A
 * caller that could tell those apart would be an oracle.
 *
 * Its own file, loaded beside reach.js, and imported by the test that holds it
 * against the Node implementation — two copies of a cipher is how one of them
 * quietly stops matching the other (the same arrangement seal.js has).
 */
;(() => {
  'use strict'
  const subtle = globalThis.crypto.subtle
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  const unb64u = (text) => {
    const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  /**
   * One key, one message — `cookrew-device/1 <info>` as the HKDF info and an
   * empty salt, which is what the Node half derives with. The label is what
   * keeps a secret sealed for one request from opening another.
   */
  const messageKey = async (shared, info) => {
    const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
    const bits = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`cookrew-device/1 ${info}`) },
      ikm,
      256
    )
    return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['decrypt'])
  }

  /** Sequence 0 of a channel that only ever carries one frame. */
  const NONCE_0 = new Uint8Array(12)

  async function open(privateKey, info, sealed) {
    try {
      if (!privateKey || !sealed || sealed.alg !== 'p256') return null
      const [x, y] = String(sealed.e).split('.')
      if (!x || !y) return null
      const theirs = await subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x, y },
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      )
      const shared = await subtle.deriveBits({ name: 'ECDH', public: theirs }, privateKey, 256)
      const key = await messageKey(shared, info)
      // WebCrypto takes the tag appended to the body, which is how the Node
      // half writes it; tagLength is in bits.
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: NONCE_0, tagLength: 128 },
        key,
        unb64u(sealed.sealed)
      )
      return dec.decode(plain)
    } catch {
      return null
    }
  }

  globalThis.CookrewDeviceSeal = { open }
})()
