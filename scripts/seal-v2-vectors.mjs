// Writes tests/fixtures/seal-v2-vectors.json with node:crypto alone, so the
// vectors are a second implementation of cookrew-seal/2 (src/shared/seal2/),
// not a copy of its output. Fixed keys, raw bytes in hex: the Swift client
// (watch/SealVectors) and the browser bundle check themselves against them.
//
// Run: node scripts/seal-v2-vectors.mjs
import { createCipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LABEL = 'cookrew-seal/2'
const V1_LABEL = 'cookrew-canvas-seal/1'
const EPOCH_RECORDS = 65536
const hex = (bytes) => Buffer.from(bytes).toString('hex')
const fill = (start, length = 32) => Buffer.from(Array.from({ length }, (_, i) => (start + i) & 0xff))
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex')
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
const xPriv = (raw) => createPrivateKey({ key: Buffer.concat([X_PKCS8, raw]), format: 'der', type: 'pkcs8' })
const xPub = (raw) => createPublicKey({ key: Buffer.concat([X_SPKI, raw]), format: 'der', type: 'spki' })
const xRawPublic = (raw) => createPublicKey(xPriv(raw)).export({ format: 'der', type: 'spki' }).subarray(-32)
const edPriv = (raw) => createPrivateKey({ key: Buffer.concat([ED_PKCS8, raw]), format: 'der', type: 'pkcs8' })
const edJwk = (raw) => {
  const { kty, crv, x } = createPublicKey(edPriv(raw)).export({ format: 'jwk' })
  return { kty, crv, x }
}
const hkdf = (ikm, salt, info, length) => Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info), length))
const sha256 = (...parts) => parts.reduce((hash, part) => hash.update(part), createHash('sha256')).digest()
const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
const u8 = (value) => Buffer.from([value])
const u16 = (value) => {
  const out = Buffer.alloc(2)
  out.writeUInt16BE(value)
  return out
}
const u32 = (value) => {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value)
  return out
}
const u64 = (value) => {
  const out = Buffer.alloc(8)
  out.writeUInt32BE(Math.floor(value / 0x100000000), 0)
  out.writeUInt32BE(value >>> 0, 4)
  return out
}

// ── identity of a device key (account-v2.ts · deviceIdFor) ────────────────
const thumbprint = (jwk) => sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
const deviceIdOf = (jwk) => {
  const bytes = Buffer.from(sha256(thumbprint(jwk)).subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const h = bytes.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
const uuidBytes = (id) => Buffer.from(id.replace(/-/g, ''), 'hex')

// ── the handshake ─────────────────────────────────────────────────────────
const MODE = { code: 1, device: 2 }
const transcriptOf = ({ mode, chosen, offered, context, eI, eR }) =>
  sha256(Buffer.from(LABEL), u8(0), u8(MODE[mode]), u8(chosen), u8(offered.length), Buffer.from(offered), context, eI, eR)

const scheduleOf = (ikm, transcript) => {
  const okm = hkdf(ikm, transcript, `${LABEL} keys`, 96)
  return { toResponder: okm.subarray(0, 32), toInitiator: okm.subarray(32, 64), confirm: okm.subarray(64) }
}
const proofOf = (confirm, who, transcript) => createHmac('sha256', confirm).update(who).update(transcript).digest()

// ── records ───────────────────────────────────────────────────────────────
const epochSecret = (secret, epoch) => {
  let at = secret
  for (let step = 0; step < epoch; step += 1) at = hkdf(at, Buffer.alloc(0), `${LABEL} next`, 32)
  return at
}
const recordKeys = (secret, epoch) => {
  const at = epochSecret(secret, epoch)
  return { key: hkdf(at, Buffer.alloc(0), `${LABEL} key`, 32), iv: hkdf(at, Buffer.alloc(0), `${LABEL} iv`, 12) }
}
const DIRECTION = { toResponder: 1, toInitiator: 2 }
const nonceOf = (iv, seq) => {
  const out = Buffer.from(iv)
  const counter = Buffer.concat([Buffer.alloc(4), u64(seq)])
  for (let i = 0; i < 12; i += 1) out[i] ^= counter[i]
  return out
}
const aadOf = (direction, seq) => Buffer.concat([Buffer.from(LABEL), u8(DIRECTION[direction]), u64(seq)])
const sealRecord = (secret, direction, seq, plain) => {
  const { key, iv } = recordKeys(secret, Math.floor(seq / EPOCH_RECORDS))
  const cipher = createCipheriv('aes-256-gcm', key, nonceOf(iv, seq))
  cipher.setAAD(aadOf(direction, seq))
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  const box = Buffer.concat([body, cipher.getAuthTag()])
  return { box, wire: Buffer.concat([u32(8 + box.length), u64(seq), box]) }
}

// ── frames ────────────────────────────────────────────────────────────────
const FRAME = { open: 1, head: 2, data: 3, end: 4, abort: 5, ack: 6, ping: 7, credit: 8, goaway: 9 }
const fields = (entries) =>
  Buffer.concat([u16(entries.length), ...entries.flatMap(([name, value]) => [u16(Buffer.byteLength(name)), Buffer.from(name), u32(Buffer.byteLength(value)), Buffer.from(value)])])
const frame = (type, stream, body = Buffer.alloc(0)) => Buffer.concat([u8(FRAME[type]), u32(stream), body])
const frames = [
  {
    name: 'open-http',
    value: { kind: 'open', stream: 1, type: 'http', fields: { ':method': 'POST', ':path': '/api/use/sources/unlock', 'content-type': 'application/json' } },
    bytes: frame('open', 1, Buffer.concat([u8(4), Buffer.from('http'), fields([[':method', 'POST'], [':path', '/api/use/sources/unlock'], ['content-type', 'application/json']])]))
  },
  {
    name: 'head',
    value: { kind: 'head', stream: 1, status: 200, fields: { 'content-type': 'text/event-stream' } },
    bytes: frame('head', 1, Buffer.concat([u16(200), fields([['content-type', 'text/event-stream']])]))
  },
  { name: 'data', value: { kind: 'data', stream: 3, data: '00ff10' }, bytes: frame('data', 3, Buffer.from('00ff10', 'hex')) },
  { name: 'end', value: { kind: 'end', stream: 3 }, bytes: frame('end', 3) },
  { name: 'abort', value: { kind: 'abort', stream: 5, code: 3, reason: 'flow-control' }, bytes: frame('abort', 5, Buffer.concat([u16(3), Buffer.from('flow-control')])) },
  { name: 'ack', value: { kind: 'ack', stream: 0, next: 4294967297 }, bytes: frame('ack', 0, u64(4294967297)) },
  { name: 'ping', value: { kind: 'ping', stream: 0 }, bytes: frame('ping', 0) },
  { name: 'credit', value: { kind: 'credit', stream: 7, bytes: 65536 }, bytes: frame('credit', 7, u32(65536)) },
  { name: 'goaway', value: { kind: 'goaway', stream: 0, code: 0, reason: 'closing' }, bytes: frame('goaway', 0, Buffer.concat([u16(0), Buffer.from('closing')])) }
].map(({ name, value, bytes }) => ({ name, value, bytes: hex(bytes) }))

// ── code mode: phone or console to its Mac ────────────────────────────────
const code = fill(0x10)
const initiator = fill(0x40)
const responder = fill(0x80)
const eI = xRawPublic(initiator)
const eR = xRawPublic(responder)
const id = hkdf(code, Buffer.alloc(0), `${V1_LABEL} id`, 16)
const offered = [2]
const codeTranscript = transcriptOf({ mode: 'code', chosen: 2, offered, context: id, eI, eR })
const shared = diffieHellman({ privateKey: xPriv(initiator), publicKey: xPub(eR) })
const codeKeys = scheduleOf(Buffer.concat([shared, code]), codeTranscript)

const plains = [
  { seq: 0, plain: frames[0].bytes },
  { seq: 1, plain: '00ff01fe' },
  { seq: 65535, plain: '' },
  { seq: 65536, plain: '6e657874206570656368' },
  { seq: 131073, plain: '74776f2065706f636873' }
]
const records = plains.map(({ seq, plain }) => {
  const bytes = Buffer.from(plain, 'hex')
  return {
    seq,
    epoch: Math.floor(seq / EPOCH_RECORDS),
    plain,
    toResponder: hex(sealRecord(codeKeys.toResponder, 'toResponder', seq, bytes).wire),
    toInitiator: hex(sealRecord(codeKeys.toInitiator, 'toInitiator', seq, bytes).wire)
  }
})
const epochs = [0, 1, 2].map((epoch) => {
  const { key, iv } = recordKeys(codeKeys.toResponder, epoch)
  return { epoch, secret: hex(epochSecret(codeKeys.toResponder, epoch)), key: hex(key), iv: hex(iv) }
})

// ── device mode: one desktop to another of the same account ───────────────
const deviceA = fill(0x20)
const deviceB = fill(0x60)
const jwkA = edJwk(deviceA)
const jwkB = edJwk(deviceB)
const fromId = deviceIdOf(jwkA)
const toId = deviceIdOf(jwkB)
const dI = fill(0xa0)
const dR = fill(0xc0)
const deI = xRawPublic(dI)
const deR = xRawPublic(dR)
const deviceContext = Buffer.concat([uuidBytes(fromId), uuidBytes(toId), thumbprint(jwkA), thumbprint(jwkB)])
const deviceTranscript = transcriptOf({ mode: 'device', chosen: 2, offered, context: deviceContext, eI: deI, eR: deR })
const deviceShared = diffieHellman({ privateKey: xPriv(dI), publicKey: xPub(deR) })
const deviceKeys = scheduleOf(deviceShared, deviceTranscript)
const signed = (who, transcript) => `${LABEL} ${who}\n${b64u(transcript)}`
// Ed25519 is deterministic, so these signatures are vectors too.
const sigOf = (raw, who) => sign(null, Buffer.from(signed(who, deviceTranscript)), edPriv(raw))

// ── fingerprint words for a pair of devices ───────────────────────────────
const sorted = [fromId, toId].sort()
const wordsDigest = sha256(Buffer.from(`${LABEL} words`), u8(0), uuidBytes(sorted[0]), uuidBytes(sorted[1]))

// ── words for a pair of KEYS (a watch, whose id is not its key's) ──────────
const keyThumbs = [thumbprint(jwkA), thumbprint(jwkB)].sort(Buffer.compare)
const keyWordsDigest = sha256(Buffer.from(`${LABEL} key words`), u8(0), keyThumbs[0], keyThumbs[1])

const vectors = {
  label: LABEL,
  epochRecords: EPOCH_RECORDS,
  frames,
  code: {
    code: hex(code),
    initiatorPrivate: hex(initiator),
    responderPrivate: hex(responder),
    initiatorPublic: hex(eI),
    responderPublic: hex(eR),
    id: hex(id),
    offered,
    chosen: 2,
    hello: { v: 1, vs: offered, id: b64u(id), e: b64u(eI) },
    accept: { v: 2, e: b64u(eR), proof: b64u(proofOf(codeKeys.confirm, 'responder', codeTranscript)) },
    finish: { proof: b64u(proofOf(codeKeys.confirm, 'initiator', codeTranscript)) },
    transcript: hex(codeTranscript),
    sessionId: b64u(codeTranscript.subarray(0, 16)),
    sharedSecret: hex(shared),
    secretToResponder: hex(codeKeys.toResponder),
    secretToInitiator: hex(codeKeys.toInitiator),
    confirm: hex(codeKeys.confirm),
    epochs,
    records
  },
  device: {
    initiatorDevicePrivate: hex(deviceA),
    responderDevicePrivate: hex(deviceB),
    initiatorJwk: jwkA,
    responderJwk: jwkB,
    from: fromId,
    to: toId,
    initiatorThumbprint: hex(thumbprint(jwkA)),
    responderThumbprint: hex(thumbprint(jwkB)),
    initiatorPrivate: hex(dI),
    responderPrivate: hex(dR),
    initiatorPublic: hex(deI),
    responderPublic: hex(deR),
    hello: { v: 2, vs: offered, mode: 'device', from: fromId, to: toId, jwk: jwkA, e: b64u(deI) },
    accept: { v: 2, e: b64u(deR), jwk: jwkB, sig: b64u(sigOf(deviceB, 'responder')), proof: b64u(proofOf(deviceKeys.confirm, 'responder', deviceTranscript)) },
    finish: { sig: b64u(sigOf(deviceA, 'initiator')), proof: b64u(proofOf(deviceKeys.confirm, 'initiator', deviceTranscript)) },
    transcript: hex(deviceTranscript),
    sessionId: b64u(deviceTranscript.subarray(0, 16)),
    secretToResponder: hex(deviceKeys.toResponder),
    secretToInitiator: hex(deviceKeys.toInitiator),
    confirm: hex(deviceKeys.confirm),
    record: { seq: 0, plain: frames[6].bytes, toResponder: hex(sealRecord(deviceKeys.toResponder, 'toResponder', 0, Buffer.from(frames[6].bytes, 'hex')).wire) },
    wordsDigest: hex(wordsDigest),
    keyWordsDigest: hex(keyWordsDigest)
  }
}
writeFileSync(fileURLToPath(new URL('../tests/fixtures/seal-v2-vectors.json', import.meta.url)), `${JSON.stringify(vectors, null, 2)}\n`)
