// Writes tests/fixtures/canvas-seal-vectors.json with node:crypto alone, so the
// vectors are a second implementation of the protocol, not a copy of its output.
// Fixed keys, raw bytes in hex: a native client can check itself against them.
import { createCipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LABEL = 'cookrew-canvas-seal/1'
const hex = (bytes) => Buffer.from(bytes).toString('hex')
const fill = (start) => Buffer.from(Array.from({ length: 32 }, (_, i) => (start + i) & 0xff))
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI = Buffer.from('302a300506032b656e032100', 'hex')
const priv = (raw) => createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: 'der', type: 'pkcs8' })
const pub = (raw) => createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' })
const rawPublic = (raw) => createPublicKey(priv(raw)).export({ format: 'der', type: 'spki' }).subarray(-32)
const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info), length))

const code = fill(0x10)
const initiator = fill(0x40)
const responder = fill(0x80)
const eI = rawPublic(initiator)
const eR = rawPublic(responder)
const id = hkdf(code, Buffer.alloc(0), `${LABEL} id`, 16)
const transcript = createHash('sha256').update(LABEL).update(id).update(eI).update(eR).digest()
const shared = diffieHellman({ privateKey: priv(initiator), publicKey: pub(eR) })
const keys = hkdf(Buffer.concat([shared, code]), transcript, `${LABEL} keys`, 96)
const [toResponder, toInitiator, confirm] = [keys.subarray(0, 32), keys.subarray(32, 64), keys.subarray(64)]
const proof = (who) => createHmac('sha256', confirm).update(who).update(transcript).digest()

const nonce = (seq) => {
  const out = Buffer.alloc(12)
  out.writeUInt32BE(Math.floor(seq / 0x100000000), 0)
  out.writeUInt32BE(seq >>> 0, 4)
  return out
}
const seal = (key, seq, plain) => {
  const cipher = createCipheriv('aes-256-gcm', key, nonce(seq))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}
const records = [
  { seq: 0, plain: Buffer.from('hello') },
  { seq: 1, plain: Buffer.from([0, 255, 1, 254]) },
  { seq: 4294967296, plain: Buffer.alloc(0) }
].map(({ seq, plain }) => ({ seq, plain: hex(plain), toResponder: hex(seal(toResponder, seq, plain)), toInitiator: hex(seal(toInitiator, seq, plain)) }))

const vectors = {
  label: LABEL,
  code: hex(code),
  initiatorPrivate: hex(initiator),
  responderPrivate: hex(responder),
  initiatorPublic: hex(eI),
  responderPublic: hex(eR),
  id: hex(id),
  transcript: hex(transcript),
  sharedSecret: hex(shared),
  keyToResponder: hex(toResponder),
  keyToInitiator: hex(toInitiator),
  keyConfirm: hex(confirm),
  proofResponder: hex(proof('responder')),
  proofInitiator: hex(proof('initiator')),
  records
}
writeFileSync(fileURLToPath(new URL('../tests/fixtures/canvas-seal-vectors.json', import.meta.url)), `${JSON.stringify(vectors, null, 2)}\n`)
