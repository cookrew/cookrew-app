import { decodeBase64Url, fingerprintOfDigest } from '../../../shared/key-fingerprint'
import { UNLOCK_INFO } from '../../../shared/remote-unlock'

/**
 * THE PHONE'S HALF OF THE SEAL: relay-seal.ts's sealToDoor in WebCrypto, so the
 * relay carries a password it cannot read. tests/unlock-seal.test.ts opens what
 * this seals with the Mac's own code, which keeps the two in step.
 */

const encoder = new TextEncoder()

const b64u = (bytes: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const keyBytes = (key: string): Uint8Array<ArrayBuffer> => {
  const bytes = decodeBase64Url(key)
  if (bytes === null) throw new Error('This Mac sent a key that cannot be read')
  return new Uint8Array(bytes)
}

export async function sealForMac(key: string, plaintext: string): Promise<string> {
  const { subtle } = crypto
  const mac = await subtle.importKey('spki', keyBytes(key), { name: 'X25519' }, false, [])
  const mine = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair
  const shared = await subtle.deriveBits({ name: 'X25519', public: mac }, mine.privateKey, 256)
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(`cookrew-relay/1 body ${UNLOCK_INFO}`) }, ikm, 256)
  const aes = await subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt'])
  // A zero nonce is sound here: this key is new and seals exactly one message.
  const sealed = await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12), tagLength: 128 }, aes, encoder.encode(plaintext))
  return `${b64u(await subtle.exportKey('spki', mine.publicKey))}.${b64u(sealed)}`
}

/** The six words the Mac's ⋯ menu shows for the same key. */
export async function wordsOfKey(key: string): Promise<readonly string[]> {
  return fingerprintOfDigest(new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes(key)))).words
}
