// cookrew-seal/2 against its vectors, in whatever runtime loads this: Node,
// Electron's Node (scripts/seal-v2-runtimes.mjs runs it there), and Chrome
// (the same script loads a bundle of it into headless Chrome). WebCrypto only.
import { createInbox } from '../../src/shared/canvas-seal-wire'
import { decodeFrame2, encodeFrame2, type Frame2 } from '../../src/shared/seal2/frames'
import { acceptCodeHandshake, acceptDeviceHandshake, deviceIdOf, startCodeHandshake, startDeviceHandshake, type DeviceKey, type DeviceSigner, type DeviceVerifier } from '../../src/shared/seal2/handshake'
import { createSeal2Session, epochKeyBytes, nextEpochSecret } from '../../src/shared/seal2/records'

export interface RuntimeReport {
  readonly runtime: string
  readonly passed: string[]
  readonly failed: string[]
  readonly skipped: string[]
}

type Vectors = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const bytes = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))
const hex = (data: Uint8Array): string => Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const recordOf = (wire: Uint8Array): { seq: number; box: Uint8Array } => {
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
  return { seq: view.getUint32(4) * 0x100000000 + view.getUint32(8), box: wire.slice(12) }
}
const ED_PKCS8 = '302e020100300506032b657004220420'

async function ed25519(): Promise<{ signerOf(privateHex: string, jwk: DeviceKey, id: string): Promise<DeviceSigner>; verify: DeviceVerifier } | null> {
  try {
    const probe = await crypto.subtle.importKey('pkcs8', bytes(`${ED_PKCS8}${'11'.repeat(32)}`), { name: 'Ed25519' }, false, ['sign'])
    await crypto.subtle.sign({ name: 'Ed25519' }, probe, new Uint8Array(1))
  } catch {
    return null
  }
  const b64u = (data: Uint8Array): string => btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const unb64u = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  return {
    async signerOf(privateHex, jwk, id) {
      const key = await crypto.subtle.importKey('pkcs8', bytes(`${ED_PKCS8}${privateHex}`), { name: 'Ed25519' }, false, ['sign'])
      return { deviceId: id, jwk, sign: async (message) => b64u(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(message)))) }
    },
    async verify(jwk, message, sig) {
      const key = await crypto.subtle.importKey('jwk', { ...jwk }, { name: 'Ed25519' }, false, ['verify'])
      return crypto.subtle.verify({ name: 'Ed25519' }, key, unb64u(sig), new TextEncoder().encode(message))
    }
  }
}

export async function runSeal2Checks(vectors: Vectors, runtime: string): Promise<RuntimeReport> {
  const report: RuntimeReport = { runtime, passed: [], failed: [], skipped: [] }
  const check = async (name: string, run: () => Promise<boolean>): Promise<void> => {
    try {
      ;((await run()) ? report.passed : report.failed).push(name)
    } catch (error) {
      report.failed.push(`${name}: ${String(error)}`)
    }
  }
  const v = vectors.code

  await check('code handshake: hello, accept, finish, session id', async () => {
    const started = await startCodeHandshake(bytes(v.code), { ephemeral: bytes(v.initiatorPrivate) })
    const accepted = await acceptCodeHandshake(bytes(v.code), started.hello, { ephemeral: bytes(v.responderPrivate) })
    const done = await started.finish(accepted?.accept)
    return same(started.hello, v.hello) && same(accepted?.accept, v.accept) && same(done?.finish, v.finish) && done?.session.id === v.sessionId && (await accepted?.confirm(done?.finish)) === true
  })

  await check('epoch keys', async () => {
    let secret = bytes(v.secretToResponder)
    for (const epoch of v.epochs) {
      const keys = await epochKeyBytes(secret)
      if (hex(secret) !== epoch.secret || hex(keys.key) !== epoch.key || hex(keys.iv) !== epoch.iv) return false
      secret = await nextEpochSecret(secret)
    }
    return true
  })

  await check('records open in both directions across epochs', async () => {
    const initiator = createSeal2Session(v.sessionId, bytes(v.secretToResponder), bytes(v.secretToInitiator), 'toResponder')
    const responder = createSeal2Session(v.sessionId, bytes(v.secretToInitiator), bytes(v.secretToResponder), 'toInitiator')
    for (const record of v.records) {
      const a = await responder.open(recordOf(bytes(record.toResponder)))
      const b = await initiator.open(recordOf(bytes(record.toInitiator)))
      if (a === null || b === null || hex(a) !== record.plain || hex(b) !== record.plain) return false
    }
    return true
  })

  await check('records seal to the same bytes', async () => {
    const initiator = createSeal2Session(v.sessionId, bytes(v.secretToResponder), bytes(v.secretToInitiator), 'toResponder')
    const first = await initiator.seal(bytes(v.records[0].plain))
    return hex(first.box) === hex(recordOf(bytes(v.records[0].toResponder)).box)
  })

  await check('tamper, wrong direction and a moved number fail closed', async () => {
    const responder = createSeal2Session(v.sessionId, bytes(v.secretToInitiator), bytes(v.secretToResponder), 'toInitiator')
    const initiator = createSeal2Session(v.sessionId, bytes(v.secretToResponder), bytes(v.secretToInitiator), 'toResponder')
    const good = recordOf(bytes(v.records[1].toResponder))
    const flipped = good.box.slice()
    flipped[0] ^= 1
    const tampered = await responder.open({ seq: good.seq, box: flipped })
    const moved = await responder.open({ seq: good.seq + 1, box: good.box })
    const reflected = await initiator.open(good)
    return tampered === null && moved === null && reflected === null
  })

  await check('replay and reorder through the inbox: once each, in order', async () => {
    const sender = createSeal2Session(v.sessionId, bytes(v.secretToResponder), bytes(v.secretToInitiator), 'toResponder')
    const receiver = createSeal2Session(v.sessionId, bytes(v.secretToInitiator), bytes(v.secretToResponder), 'toInitiator')
    const got: string[] = []
    const inbox = createInbox(receiver, (plain) => got.push(hex(plain)))
    const r = [await sender.seal(bytes('0a')), await sender.seal(bytes('0b'))]
    const answers = [await inbox.accept(r[1]), await inbox.accept(r[1]), await inbox.accept(r[0])]
    return same(answers, ['taken', 'duplicate', 'taken']) && same(got, ['0a', '0b'])
  })

  await check('frames encode and decode to the vectors', async () => {
    for (const frame of vectors.frames) {
      const value = frame.value.kind === 'data' ? { ...frame.value, data: bytes(frame.value.data) } : frame.value
      if (hex(encodeFrame2(value as Frame2)) !== frame.bytes) return false
      const decoded = decodeFrame2(bytes(frame.bytes))
      if (decoded === null || hex(encodeFrame2(decoded)) !== frame.bytes) return false
    }
    return true
  })

  const d = vectors.device
  await check('device ids from keys', async () => (await deviceIdOf(d.initiatorJwk)) === d.from && (await deviceIdOf(d.responderJwk)) === d.to)

  const ed = await ed25519()
  if (ed === null) {
    report.skipped.push('device handshake: this runtime has no Ed25519 in WebCrypto (device mode runs in Electron main on node:crypto)')
  } else {
    await check('device handshake, Ed25519 signatures included', async () => {
      const initiator = await ed.signerOf(d.initiatorDevicePrivate, d.initiatorJwk, d.from)
      const responder = await ed.signerOf(d.responderDevicePrivate, d.responderJwk, d.to)
      const started = await startDeviceHandshake({ self: initiator, to: d.to, verify: ed.verify, ephemeral: bytes(d.initiatorPrivate) })
      const accepted = await acceptDeviceHandshake(started.hello, { self: responder, verify: ed.verify, ephemeral: bytes(d.responderPrivate) })
      const done = await started.finish(accepted?.accept)
      return same(started.hello, d.hello) && same(accepted?.accept, d.accept) && same(done?.finish, d.finish) && (await accepted?.confirm(done?.finish)) === true
    })
  }
  return report
}
