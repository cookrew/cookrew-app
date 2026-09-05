/* cookrew.dev — ONE DEVICE ID, DERIVED FROM THE KEY.
 *
 * The desktop computes this in node:crypto (src/main/account-v2.ts,
 * `deviceIdFor`) and the browser has to arrive at the same string from the
 * same public key. If the two ever disagree, one key is two devices: a phone
 * that signs in twice appears twice in Devices, a revoke misses the copy it
 * did not name, and the account's own list stops being a list of things.
 *
 * DERIVED, NOT MINTED, for the same reason there as here — a cleared
 * IndexedDB that still holds the key must not become a second device, and a
 * device id is then something the registry could check against the key it was
 * sent with rather than a number a client made up.
 *
 * The input is the RFC 7638 canonical member subset (`crv, kty, x` for OKP;
 * `crv, kty, x, y` for EC) in lexicographic order with no whitespace. Its
 * SHA-256 is the thumbprint; the SHA-256 OF THAT gives the sixteen bytes,
 * with version 8 (RFC 9562's slot for a UUID whose bits come from somewhere
 * else) and the RFC variant written over them.
 *
 * Loaded before site.js and reach.js, which both read it off the global. It
 * is its own file rather than a copy in each because two copies of a
 * derivation are two derivations, eventually.
 */
;(() => {
  'use strict'
  const enc = new TextEncoder()

  /**
   * The exact bytes RFC 7638 hashes. Members the JWK carries beyond these —
   * `kid`, `use`, `alg` — are deliberately dropped: they describe how a key is
   * labelled, not which key it is, and letting them in would make the same key
   * two devices depending on who exported it.
   */
  function canonicalKey(jwk) {
    if (!jwk || typeof jwk !== 'object') throw new Error('a device key is a JWK')
    if (jwk.kty === 'OKP') return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
    if (jwk.kty === 'EC') return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
    throw new Error(`${jwk.kty} is not a device key this browser mints`)
  }

  async function deviceIdFrom(jwk) {
    const canonical = canonicalKey(jwk)
    const thumbprint = await crypto.subtle.digest('SHA-256', enc.encode(canonical))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', thumbprint))
    const bytes = digest.slice(0, 16)
    bytes[6] = (bytes[6] & 0x0f) | 0x80 // version 8: custom
    bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10: RFC 9562
    let hex = ''
    for (const b of bytes) hex += b.toString(16).padStart(2, '0')
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
  }

  globalThis.cookrewDeviceId = { canonicalKey, deviceIdFrom }
})()
