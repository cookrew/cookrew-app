/* cookrew.dev — THE SEAL, in WebCrypto: src/shared/relay-seal.ts byte for byte.
 *
 * A caller seals every exchange to the door's long-term X25519 key and gets
 * a forward-secret reply channel back: X25519 → HKDF-SHA256 → AES-256-GCM,
 * a 12-byte nonce that is an 8-byte big-endian sequence followed by four
 * zero bytes, the tag appended, everything base64url without padding.
 *
 *   CookrewSeal.seal(doorKeySpki, info)  →  { pack(headers, body), finish(doorEphemeralSpki) }
 *     pack   → { headers: {'x-seal-e','x-seal-k','x-seal-h'}, body: 'e.sealed' }  (the op's headers and body)
 *     finish → { open(sealed, seq) }  the reply channel, once the door's ephemeral arrives on the head
 *
 * One file, loaded by the page and imported by the test that checks it against
 * the Node implementation — two copies of a cipher is how one of them quietly
 * stops matching the other.
 */
;(() => {
  'use strict'
  const subtle = globalThis.crypto.subtle
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  const b64u = (bytes) => {
    let s = ''
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  const unb64u = (text) => {
    const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  const concat = (a, b) => {
    const out = new Uint8Array(a.byteLength + b.byteLength)
    out.set(new Uint8Array(a), 0)
    out.set(new Uint8Array(b), a.byteLength)
    return out
  }

  const importPublic = (spki) => subtle.importKey('spki', unb64u(spki), { name: 'X25519' }, true, [])
  const ephemeral = async () => {
    const pair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    return { pair, pub: b64u(await subtle.exportKey('spki', pair.publicKey)) }
  }
  const dh = async (priv, pub) => new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256))
  const hkdf = async (ikm, info, bytes) => {
    const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    return new Uint8Array(
      await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, key, bytes * 8)
    )
  }
  const nonceOf = (seq) => {
    const n = new Uint8Array(12)
    const view = new DataView(n.buffer)
    view.setUint32(0, Math.floor(seq / 0x100000000))
    view.setUint32(4, seq >>> 0)
    return n
  }
  async function channel(keyBytes) {
    const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
    let seq = 0
    return {
      seal: async (plaintext) => b64u(await subtle.encrypt({ name: 'AES-GCM', iv: nonceOf(seq++), tagLength: 128 }, key, enc.encode(plaintext))),
      open: async (sealed, at) => {
        try {
          const raw = unb64u(sealed)
          if (raw.byteLength < 16) return null
          return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: nonceOf(at), tagLength: 128 }, key, raw))
        } catch {
          return null
        }
      }
    }
  }
  /** One-shot seal to the door's long-term key at sequence 0: `{ e, sealed }`. */
  async function sealToDoor(doorPub, info, plaintext) {
    const e = await ephemeral()
    const shared = await dh(e.pair.privateKey, doorPub)
    const ch = await channel(await hkdf(shared, `cookrew-relay/1 body ${info}`, 32))
    return { e: e.pub, sealed: await ch.seal(plaintext) }
  }

  async function seal(doorKeySpki, info) {
    const doorPub = await importPublic(doorKeySpki)
    const e = await ephemeral()
    const toStatic = await dh(e.pair.privateKey, doorPub)
    return {
      pack: async (headers, body) => {
        const h = await sealToDoor(doorPub, info, JSON.stringify(headers))
        const b = await sealToDoor(doorPub, info, body ?? '')
        return { headers: { 'x-seal-e': e.pub, 'x-seal-k': h.e, 'x-seal-h': h.sealed }, body: `${b.e}.${b.sealed}` }
      },
      finish: async (doorEphemeralSpki) => {
        const toEphemeral = await dh(e.pair.privateKey, await importPublic(doorEphemeralSpki))
        const material = await hkdf(concat(toStatic, toEphemeral), `cookrew-relay/1 ${info}`, 64)
        // The initiator transmits on the first half and receives on the second.
        const rx = await channel(material.slice(32, 64))
        return { open: rx.open }
      }
    }
  }

  globalThis.CookrewSeal = { seal, b64u, unb64u }
})()
