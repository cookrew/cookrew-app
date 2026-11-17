import { createCipheriv, createECDH, createHmac, randomBytes } from 'node:crypto'

/**
 * A WEB PUSH PAYLOAD, ENCRYPTED FOR ONE PHONE (RFC 8291 on RFC 8188's
 * aes128gcm). The desktop encrypts; the registry only signs and forwards the
 * bytes (plan docs/hitl-cross-workspace-2026-11-15 · phase 4, owner 11-16:
 * cookrew.dev must not see what a notification says). One record, a fresh
 * sender key and salt each time.
 */

/** The record size the header announces: one record holds the whole payload. */
export const RECORD_SIZE = 4096
const TAG_BYTES = 16
const KEY_BYTES = 65
/** Header (salt 16, rs 4, idlen 1) and the sender key. */
const HEADER_BYTES = 21 + KEY_BYTES
/**
 * The most a push service takes: the whole body within 4096 bytes (RFC 8291
 * §4) is header, payload, its delimiter and the tag, so 3993 bytes of payload.
 */
export const MAX_PLAINTEXT = 4096 - HEADER_BYTES - 1 - TAG_BYTES

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest()

export interface EncryptOptions {
  /** Test seams (the RFC's vector): fixed salt and sender private key. */
  salt?: Buffer
  asPrivate?: Buffer
}

export function encryptWebPush(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, options: EncryptOptions = {}): Buffer {
  if (uaPublic.length !== KEY_BYTES || uaPublic[0] !== 0x04) throw new Error('The phone key is not a P-256 point')
  if (authSecret.length !== 16) throw new Error('The phone secret is not 16 bytes')
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('The notification is too big to send')
  const sender = createECDH('prime256v1')
  if (options.asPrivate) sender.setPrivateKey(options.asPrivate)
  else sender.generateKeys()
  const asPublic = sender.getPublicKey()
  // Throws on a point not on the curve.
  const secret = sender.computeSecret(uaPublic)
  const prkKey = hmac(authSecret, secret)
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]))
  const salt = options.salt ?? randomBytes(16)
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header[20] = asPublic.length
  return Buffer.concat([header, asPublic, sealed])
}
