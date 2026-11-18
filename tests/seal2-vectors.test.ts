// cookrew-seal/2 against tests/fixtures/seal-v2-vectors.json, which
// scripts/seal-v2-vectors.mjs writes with node:crypto alone: two
// implementations, one answer. The Swift client checks the same file.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deviceIdFor } from '../src/main/account-v2'
import { createInbox } from '../src/shared/canvas-seal-wire'
import { acceptCodeHandshake, acceptDeviceHandshake, deviceIdOf, pairWords, startCodeHandshake, startDeviceHandshake, type DeviceKey, type DeviceSigner, type DeviceVerifier } from '../src/shared/seal2/handshake'
import { decodeFrame2, encodeFrame2, type Frame2 } from '../src/shared/seal2/frames'
import { createSeal2Session, epochKeyBytes, nextEpochSecret } from '../src/shared/seal2/records'
import { fingerprintOfDigest } from '../src/shared/key-fingerprint'

const vectors = JSON.parse(readFileSync('tests/fixtures/seal-v2-vectors.json', 'utf8'))
const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'))
const hex = (data: Uint8Array): string => Buffer.from(data).toString('hex')
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')

const signerOf = (privateHex: string, jwk: DeviceKey, deviceId: string): DeviceSigner => {
  const key = createPrivateKey({ key: Buffer.concat([ED_PKCS8, Buffer.from(privateHex, 'hex')]), format: 'der', type: 'pkcs8' })
  return { deviceId, jwk, sign: async (message) => sign(null, Buffer.from(message), key).toString('base64url') }
}
const verifyDevice: DeviceVerifier = async (jwk, message, sig) => verify(null, Buffer.from(message), createPublicKey({ key: jwk as never, format: 'jwk' }), Buffer.from(sig, 'base64url'))

const recordOf = (wire: Uint8Array): { seq: number; box: Uint8Array } => {
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
  return { seq: view.getUint32(4) * 0x100000000 + view.getUint32(8), box: wire.slice(12) }
}

describe('cookrew-seal/2 code mode, against node:crypto', () => {
  const v = vectors.code
  const fixed = { initiator: bytes(v.initiatorPrivate), responder: bytes(v.responderPrivate) }

  it('makes the same hello, accept and finish', async () => {
    const started = await startCodeHandshake(bytes(v.code), { ephemeral: fixed.initiator })
    expect(started.hello).toEqual(v.hello)
    const accepted = await acceptCodeHandshake(bytes(v.code), started.hello, { ephemeral: fixed.responder })
    expect(accepted?.accept).toEqual(v.accept)
    expect(accepted?.session.id).toBe(v.sessionId)
    const done = await started.finish(accepted?.accept)
    expect(done?.version).toBe(2)
    expect(done?.finish).toEqual(v.finish)
    expect(done?.session.id).toBe(v.sessionId)
    expect(await accepted?.confirm(done?.finish)).toBe(true)
  })

  it('walks the epochs the same way', async () => {
    let secret = bytes(v.secretToResponder)
    for (const epoch of v.epochs) {
      expect(hex(secret)).toBe(epoch.secret)
      const keys = await epochKeyBytes(secret)
      expect(hex(keys.key)).toBe(epoch.key)
      expect(hex(keys.iv)).toBe(epoch.iv)
      secret = await nextEpochSecret(secret)
    }
  })

  it('seals and opens every record the same way, across epochs, in both directions', async () => {
    const initiator = createSeal2Session(v.sessionId, bytes(v.secretToResponder), bytes(v.secretToInitiator), 'toResponder')
    const responder = createSeal2Session(v.sessionId, bytes(v.secretToInitiator), bytes(v.secretToResponder), 'toInitiator')
    for (const record of v.records) {
      const toResponder = recordOf(bytes(record.toResponder))
      const toInitiator = recordOf(bytes(record.toInitiator))
      expect(toResponder.seq).toBe(record.seq)
      expect(hex((await responder.open(toResponder)) ?? new Uint8Array([1, 2, 3]))).toBe(record.plain)
      expect(hex((await initiator.open(toInitiator)) ?? new Uint8Array([1, 2, 3]))).toBe(record.plain)
    }
  })

  it('numbers its own records so they match', async () => {
    const initiator = createSeal2Session(v.sessionId, bytes(v.secretToResponder), bytes(v.secretToInitiator), 'toResponder')
    const first = await initiator.seal(bytes(v.records[0].plain))
    expect(hex(first.box)).toBe(hex(recordOf(bytes(v.records[0].toResponder)).box))
    const second = await initiator.seal(bytes(v.records[1].plain))
    expect(hex(second.box)).toBe(hex(recordOf(bytes(v.records[1].toResponder)).box))
  })
})

describe('cookrew-seal/2 device mode, against node:crypto', () => {
  const v = vectors.device
  const initiator = signerOf(v.initiatorDevicePrivate, v.initiatorJwk, v.from)
  const responder = signerOf(v.responderDevicePrivate, v.responderJwk, v.to)

  it('names a device the way the account does', async () => {
    expect(await deviceIdOf(v.initiatorJwk)).toBe(v.from)
    expect(deviceIdFor(v.initiatorJwk)).toBe(v.from)
    expect(await deviceIdOf(v.responderJwk)).toBe(v.to)
  })

  it('makes the same hello, accept and finish, Ed25519 signatures included', async () => {
    const started = await startDeviceHandshake({ self: initiator, to: v.to, verify: verifyDevice, ephemeral: bytes(v.initiatorPrivate) })
    expect(started.hello).toEqual(v.hello)
    const accepted = await acceptDeviceHandshake(started.hello, { self: responder, verify: verifyDevice, ephemeral: bytes(v.responderPrivate) })
    expect(accepted?.accept).toEqual(v.accept)
    expect(accepted?.peer.deviceId).toBe(v.from)
    const done = await started.finish(accepted?.accept)
    expect(done?.finish).toEqual(v.finish)
    expect(done?.session.id).toBe(v.sessionId)
    expect(await accepted?.confirm(done?.finish)).toBe(true)
    const opened = await accepted?.session.open(recordOf(bytes(v.record.toResponder)))
    expect(hex(opened ?? new Uint8Array(0))).toBe(v.record.plain)
  })

  it('the dialling desktop refuses an answer signed by any key but the one whose id it dialled', async () => {
    const { newDevice } = await import('./support/seal2-accounts')
    const started = await startDeviceHandshake({ self: initiator, to: v.to, verify: verifyDevice })
    // Another key answers in the dialled id's name: a well-formed, correctly signed accept for the wrong key.
    const impostor = newDevice()
    const accepted = await acceptDeviceHandshake(started.hello, { self: { ...impostor.signer, deviceId: v.to }, verify: verifyDevice })
    expect(accepted).not.toBeNull()
    expect(await started.finish(accepted?.accept)).toBeNull()
  })

  it('speaks the same words for the pair from either side', async () => {
    const words = fingerprintOfDigest(bytes(v.wordsDigest))
    expect(await pairWords(v.from, v.to)).toEqual(words)
    expect(await pairWords(v.to, v.from)).toEqual(words)
  })
})

describe('cookrew-seal/2 frames, against node:crypto', () => {
  const asFrame = (value: Record<string, unknown>): Frame2 => (value.kind === 'data' ? ({ ...value, data: bytes(value.data as string) } as Frame2) : (value as unknown as Frame2))

  const frames = vectors.frames as Array<{ name: string; value: Record<string, unknown>; bytes: string }>
  it.each(frames)('$name encodes and decodes to the same bytes', ({ value, bytes: wire }) => {
    expect(hex(encodeFrame2(asFrame(value)))).toBe(wire)
    const decoded = decodeFrame2(bytes(wire))
    expect(decoded).not.toBeNull()
    expect(hex(encodeFrame2(decoded as Frame2))).toBe(wire)
  })
})

describe('cookrew-seal/2 records through the v1 inbox', () => {
  it('delivers in order, once, whatever order they arrive in', async () => {
    const v = vectors.code
    const sender = createSeal2Session(v.sessionId, bytes(v.secretToResponder), bytes(v.secretToInitiator), 'toResponder')
    const receiver = createSeal2Session(v.sessionId, bytes(v.secretToInitiator), bytes(v.secretToResponder), 'toInitiator')
    const got: string[] = []
    const inbox = createInbox(receiver, (plain) => got.push(new TextDecoder().decode(plain)))
    const records = [await sender.seal(new TextEncoder().encode('a')), await sender.seal(new TextEncoder().encode('b')), await sender.seal(new TextEncoder().encode('c'))]
    expect(await inbox.accept(records[2])).toBe('taken')
    expect(await inbox.accept(records[0])).toBe('taken')
    expect(await inbox.accept(records[0])).toBe('duplicate')
    expect(await inbox.accept(records[1])).toBe('taken')
    expect(got).toEqual(['a', 'b', 'c'])
  })
})
