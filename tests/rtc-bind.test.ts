// THE DIRECT LINK'S BINDING (shared/rtc-bind.ts): the Mac's answer names both
// DTLS fingerprints under its account device signature, whose key must hash to
// the machine in scope. The relay carries both SDPs in plaintext; anything it
// can make on its own (swapped fingerprints, its own key, a code planted by a
// crafted link, another machine's genuine binding, a replay) is refused.
import { createHmac, hkdfSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceIdFor, mintDeviceKey, signWithDevice, type AccountFile } from '../src/main/account-v2'
import { HELLO_CONTEXT } from '../src/main/device-hello'
import { HELLO_V2_CONTEXT } from '../src/shared/hello-proof'
import { RENEW_PREFIX } from '../src/shared/session-renew'
import { ACCOUNT_PAIR_CONTEXT } from '../src/shared/account-pair'
import {
  RTC_BIND_LABEL,
  RTC_NO_BINDING,
  RTC_NO_ED25519,
  bindMessage,
  ed25519Available,
  checkBindSignature,
  checkRtcBind,
  deviceIdOfKey,
  makeRtcBind,
  sdpFingerprints,
  type RtcBindSigner
} from '../src/shared/rtc-bind'

const hex = (byte: string, bytes = 32): string => Array.from({ length: bytes }, () => byte).join(':')
const FP_OFFER = `sha-256 ${hex('5E')}`
const FP_ANSWER = `sha-256 ${hex('01')}`
const FP_RELAY = `sha-256 ${hex('AA')}`
const FP_OLD_OFFER = `sha-256 ${hex('0C')}`

const sdp = (fingerprint: string, at: 'session' | 'media' = 'media'): string =>
  [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    ...(at === 'session' ? [`a=fingerprint:${fingerprint}`] : []),
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...(at === 'media' ? [`a=fingerprint:${fingerprint}`] : []),
    'a=setup:actpass',
    ''
  ].join('\r\n')

const OFFER = sdp(FP_OFFER)
const ANSWER = sdp(FP_ANSWER, 'session')
const RELAY_ANSWER = sdp(FP_RELAY)

/** A machine with an account device key, signing as the Mac does (account-v2.ts). */
const machine = (): { deviceId: string; account: AccountFile; signer: RtcBindSigner } => {
  const keys = mintDeviceKey()
  const deviceId = deviceIdFor(keys.publicKeyJwk)
  const account = { ...keys, deviceId } as unknown as AccountFile
  return { deviceId, account, signer: { jwk: account.publicKeyJwk, sign: (message) => signWithDevice(account, message) } }
}

/** The proof the earlier branch accepted, keyed by a connect code: a crafted link can plant the code. */
const codeMac = (code: Uint8Array, message: string): string => {
  const key = hkdfSync('sha256', code, Buffer.alloc(0), Buffer.from(`${RTC_BIND_LABEL} key`), 32)
  return createHmac('sha256', Buffer.from(key)).update(message).digest('base64url')
}

describe('sdpFingerprints', () => {
  it('reads a session- or media-level fingerprint as lower-case hash and upper-case hex', () => {
    expect(sdpFingerprints(OFFER)).toBe(FP_OFFER)
    expect(sdpFingerprints(sdp(FP_OFFER, 'session'))).toBe(FP_OFFER)
    expect(sdpFingerprints(sdp(`SHA-256 ${hex('5e')}`))).toBe(FP_OFFER)
  })

  it('names every distinct fingerprint once, sorted and comma-joined', () => {
    const both = OFFER.replace('a=setup:actpass', `a=fingerprint:${FP_ANSWER}\r\na=fingerprint:${FP_OFFER}\r\na=setup:actpass`)
    expect(sdpFingerprints(both)).toBe([FP_ANSWER, FP_OFFER].sort().join(','))
  })

  it('reads sha-384 and sha-512 at their own lengths', () => {
    expect(sdpFingerprints(sdp(`sha-384 ${hex('AB', 48)}`))).toBe(`sha-384 ${hex('AB', 48)}`)
    expect(sdpFingerprints(sdp(`sha-512 ${hex('CD', 64)}`))).toBe(`sha-512 ${hex('CD', 64)}`)
  })

  it('has no fingerprints for a weak or unknown hash, or a digest of the wrong length', () => {
    for (const fingerprint of [`sha-1 ${hex('AB', 20)}`, `md5 ${hex('AB', 16)}`, `sha-256 ${hex('AB', 31)}`, `sha-256 ${hex('AB', 48)}`, `x-hash ${hex('AB')}`]) {
      expect(sdpFingerprints(sdp(fingerprint)), fingerprint).toBeNull()
    }
  })

  it('fails closed on ANY line that mentions a fingerprint and is not a well-formed one', () => {
    const suspect = [
      ` a=fingerprint:${FP_RELAY}`,
      `\ta=fingerprint:${FP_RELAY}`,
      `a =fingerprint:${FP_RELAY}`,
      `a=fingerprint :${FP_RELAY}`,
      `a=setup:actpass\ra=fingerprint:${FP_RELAY}`,
      `\u0085a=fingerprint:${FP_RELAY}`,
      `\u200Ba=fingerprint:${FP_RELAY}`,
      `a=fingerprint:${FP_RELAY}\u2028a=fingerprint:${FP_OFFER}`,
      'a=fingerprint',
      `a=fingerprint ${FP_RELAY}`,
      `a=fingerprint-x:${FP_RELAY}`,
      `a=fingerprint:${FP_RELAY} trailing`
    ]
    for (const line of suspect) expect(sdpFingerprints(`${OFFER}${line}\r\n`), JSON.stringify(line)).toBeNull()
  })

  it('is null with no fingerprint, or one it cannot read', () => {
    expect(sdpFingerprints('v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n')).toBeNull()
    expect(sdpFingerprints(sdp('sha-256 nothex'))).toBeNull()
    expect(sdpFingerprints('')).toBeNull()
  })

  it('still reads an ordinary SDP whose other lines say nothing of a fingerprint', () => {
    expect(sdpFingerprints(`${OFFER}a=mid:0\r\na=sctp-port:5000\r\n`)).toBe(FP_OFFER)
  })
})

describe('bindMessage', () => {
  it('is the label, the device, the offer fingerprints and the answer fingerprints, one per line', () => {
    expect(RTC_BIND_LABEL).toBe('cookrew-rtc-bind/1')
    expect(bindMessage('6C1A2B3C-0000-8000-8000-000000000001', OFFER, ANSWER)).toBe(
      `${RTC_BIND_LABEL}\n6c1a2b3c-0000-8000-8000-000000000001\n${FP_OFFER}\n${FP_ANSWER}`
    )
  })

  it('is null when either side has no fingerprint', () => {
    expect(bindMessage('d', 'v=0', ANSWER)).toBeNull()
    expect(bindMessage('d', OFFER, 'v=0')).toBeNull()
  })

  it('cannot be any other message the device key signs (domain separation)', () => {
    // Every other signWithDevice caller signs `<context> <fields>` (or a reach card's canonical JSON).
    const message = bindMessage('d', OFFER, ANSWER)!
    for (const context of [HELLO_CONTEXT, HELLO_V2_CONTEXT, RENEW_PREFIX, ACCOUNT_PAIR_CONTEXT]) {
      expect(message.startsWith(`${context} `), context).toBe(false)
      expect(`${context} `.startsWith(`${RTC_BIND_LABEL}\n`), context).toBe(false)
    }
    expect(message.startsWith('{')).toBe(false)
  })
})

describe('deviceIdOfKey', () => {
  it('names the device an Ed25519 key hashes to, as the Mac and the registry do', async () => {
    const { account, deviceId } = machine()
    expect(await deviceIdOfKey(account.publicKeyJwk)).toBe(deviceId)
  })

  it('names nothing for any other kind of key, or a malformed one', async () => {
    const p256 = await crypto.subtle.exportKey('jwk', ((await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair).publicKey)
    for (const jwk of [p256, { kty: 'RSA', n: 'x', e: 'AQAB' }, { kty: 'OKP', crv: 'X25519', x: 'A'.repeat(43) }, { kty: 'OKP', crv: 'Ed25519', x: 'short' }, { kty: 'OKP', crv: 'Ed25519', x: 7 }, 'nope', null]) {
      expect(await deviceIdOfKey(jwk), JSON.stringify(jwk)).toBeNull()
    }
  })
})

describe('checkBindSignature', () => {
  it('verifies what signWithDevice made, and nothing else', async () => {
    const { account } = machine()
    const message = bindMessage(account.deviceId, OFFER, ANSWER)!
    const sig = signWithDevice(account, message)
    expect(await checkBindSignature(account.publicKeyJwk, message, sig)).toBe(true)
    expect(await checkBindSignature(account.publicKeyJwk, `${message}x`, sig)).toBe(false)
    expect(await checkBindSignature(machine().account.publicKeyJwk, message, sig)).toBe(false)
    const flipped = Buffer.from(sig, 'base64url')
    flipped[0] ^= 1
    expect(await checkBindSignature(account.publicKeyJwk, message, flipped.toString('base64url'))).toBe(false)
    expect(await checkBindSignature(account.publicKeyJwk, message, sig.slice(0, -4))).toBe(false)
    expect(await checkBindSignature(account.publicKeyJwk, message, 'AAAA')).toBe(false)
    expect(await checkBindSignature(account.publicKeyJwk, message, null)).toBe(false)
    expect(await checkBindSignature(null, message, sig)).toBe(false)
  })

  it('takes no P-256 signature, however valid: a Mac\'s device key is Ed25519', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>
    const raw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode('m'))
    expect(await checkBindSignature(jwk, 'm', Buffer.from(raw).toString('base64url'))).toBe(false)
  })
})

describe('makeRtcBind', () => {
  it('is a v1 binding: the device, its PUBLIC key and the signature, and no code proof', () => {
    const mac = machine()
    const bind = makeRtcBind({ device: mac.deviceId.toUpperCase(), offerSdp: OFFER, answerSdp: ANSWER, signer: mac.signer })
    expect(bind).not.toBeNull()
    expect(Object.keys(bind!).sort()).toEqual(['device', 'jwk', 'sig', 'v'])
    expect(bind).toMatchObject({ v: 1, device: mac.deviceId })
    expect(bind!.jwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: mac.account.publicKeyJwk.x })
    expect(bind!.sig).toMatch(/^[A-Za-z0-9_-]{86}$/)
  })

  it('is null with nothing to sign by, a signer that fails, a key that is not Ed25519, or nothing to bind', () => {
    const mac = machine()
    expect(makeRtcBind({ device: mac.deviceId, offerSdp: OFFER, answerSdp: ANSWER, signer: null })).toBeNull()
    const failing: RtcBindSigner = { jwk: mac.signer.jwk, sign: () => { throw new Error('locked') } }
    expect(makeRtcBind({ device: mac.deviceId, offerSdp: OFFER, answerSdp: ANSWER, signer: failing })).toBeNull()
    const rsa: RtcBindSigner = { jwk: { kty: 'RSA', n: 'x', e: 'AQAB' }, sign: mac.signer.sign }
    expect(makeRtcBind({ device: mac.deviceId, offerSdp: OFFER, answerSdp: ANSWER, signer: rsa })).toBeNull()
    expect(makeRtcBind({ device: mac.deviceId, offerSdp: OFFER, answerSdp: 'v=0', signer: mac.signer })).toBeNull()
    expect(makeRtcBind({ device: mac.deviceId, offerSdp: 'v=0', answerSdp: ANSWER, signer: mac.signer })).toBeNull()
  })
})

describe('checkRtcBind', () => {
  const genuine = (mac = machine(), offerSdp = OFFER, answerSdp = ANSWER) => ({
    mac,
    bind: makeRtcBind({ device: mac.deviceId, offerSdp, answerSdp, signer: mac.signer })
  })

  it('takes the Mac\'s own signature for the machine in scope', async () => {
    const { mac, bind } = genuine()
    expect(await checkRtcBind({ bind, offerSdp: OFFER, answerSdp: ANSWER, machineId: mac.deviceId })).toEqual({ ok: true, by: 'device' })
    expect(await checkRtcBind({ bind, offerSdp: OFFER, answerSdp: ANSWER, machineId: mac.deviceId.toUpperCase() })).toEqual({ ok: true, by: 'device' })
  })

  it('takes nothing with no machine in scope, not even a genuine binding', async () => {
    const { bind } = genuine()
    expect(await checkRtcBind({ bind, offerSdp: OFFER, answerSdp: ANSWER, machineId: null })).toEqual({ ok: false, why: 'no machine in scope' })
  })

  it('refuses an older Mac that sends no binding', async () => {
    const { mac } = genuine()
    expect(await checkRtcBind({ bind: undefined, offerSdp: OFFER, answerSdp: ANSWER, machineId: mac.deviceId })).toEqual({ ok: false, why: 'no binding' })
  })

  it('refuses junk', async () => {
    const { mac } = genuine()
    for (const junk of [null, 'x', [], { v: 2, device: mac.deviceId }, { v: 1 }, { v: 1, device: 7 }, { v: '1', device: mac.deviceId }]) {
      const verdict = await checkRtcBind({ bind: junk, offerSdp: OFFER, answerSdp: ANSWER, machineId: mac.deviceId })
      expect(verdict.ok, JSON.stringify(junk)).toBe(false)
    }
  })

  it('refuses the answer\'s fingerprint swapped under the Mac\'s own binding', async () => {
    const { mac, bind } = genuine()
    expect(await checkRtcBind({ bind, offerSdp: OFFER, answerSdp: RELAY_ANSWER, machineId: mac.deviceId })).toEqual({ ok: false, why: 'binding did not verify' })
  })

  it('refuses when the relay swapped the offer\'s fingerprint on the way to the Mac', async () => {
    // The Mac bound what it received: the relay's certificate, not this browser's.
    const { mac, bind } = genuine(machine(), sdp(FP_RELAY))
    expect(await checkRtcBind({ bind, offerSdp: OFFER, answerSdp: ANSWER, machineId: mac.deviceId })).toEqual({ ok: false, why: 'binding did not verify' })
  })

  it('refuses a genuine binding replayed onto a new offer', async () => {
    const { mac, bind } = genuine(machine(), sdp(FP_OLD_OFFER))
    expect((await checkRtcBind({ bind, offerSdp: OFFER, answerSdp: ANSWER, machineId: mac.deviceId })).ok).toBe(false)
  })

  it('refuses another of the account\'s machines, genuine as its binding is', async () => {
    const { bind } = genuine()
    const inScope = machine().deviceId
    expect(await checkRtcBind({ bind, offerSdp: OFFER, answerSdp: ANSWER, machineId: inScope })).toEqual({ ok: false, why: 'binding for another machine' })
  })

  it('refuses the relay\'s own key, signing honestly and naming the machine in scope', async () => {
    const target = machine()
    const relay = machine()
    const forged = makeRtcBind({ device: target.deviceId, offerSdp: OFFER, answerSdp: RELAY_ANSWER, signer: relay.signer })
    expect(await checkRtcBind({ bind: forged, offerSdp: OFFER, answerSdp: RELAY_ANSWER, machineId: target.deviceId })).toEqual({
      ok: false,
      why: 'key is not the machine in scope'
    })
  })

  it('refuses the machine\'s real public key beside a signature it did not make', async () => {
    const target = machine()
    const relay = machine()
    const message = bindMessage(target.deviceId, OFFER, RELAY_ANSWER)!
    const forged = { v: 1, device: target.deviceId, jwk: target.signer.jwk, sig: signWithDevice(relay.account, message) }
    expect(await checkRtcBind({ bind: forged, offerSdp: OFFER, answerSdp: RELAY_ANSWER, machineId: target.deviceId })).toEqual({
      ok: false,
      why: 'binding did not verify'
    })
  })

  it('never takes a connect code: one a crafted #code= link planted proves nothing', async () => {
    const target = machine()
    const planted = new Uint8Array(32).fill(3)
    const mac = codeMac(planted, bindMessage(target.deviceId, OFFER, RELAY_ANSWER)!)
    const codeOnly = { v: 1, device: target.deviceId, jwk: null, sig: null, mac }
    expect((await checkRtcBind({ bind: codeOnly, offerSdp: OFFER, answerSdp: RELAY_ANSWER, machineId: target.deviceId })).ok).toBe(false)
    expect((await checkRtcBind({ bind: codeOnly, offerSdp: OFFER, answerSdp: RELAY_ANSWER, machineId: null })).ok).toBe(false)
    // A valid code proof beside a signature over something else is still only the code.
    const stale = genuine(target).bind!
    const mixed = { ...stale, mac }
    expect((await checkRtcBind({ bind: mixed, offerSdp: OFFER, answerSdp: RELAY_ANSWER, machineId: target.deviceId })).ok).toBe(false)
  })

  it('refuses when either SDP has a fingerprint line it cannot read', async () => {
    const { mac, bind } = genuine()
    const smuggled = `${ANSWER} a=fingerprint:${FP_RELAY}\r\n`
    expect(await checkRtcBind({ bind, offerSdp: OFFER, answerSdp: smuggled, machineId: mac.deviceId })).toEqual({ ok: false, why: 'no fingerprint' })
  })

  it('names an older Mac by the same words the page reads (RTC_NO_BINDING)', async () => {
    const { mac } = genuine()
    expect(await checkRtcBind({ bind: undefined, offerSdp: OFFER, answerSdp: ANSWER, machineId: mac.deviceId })).toEqual({ ok: false, why: RTC_NO_BINDING })
  })
})

describe('a browser that cannot check Ed25519', () => {
  /** WebCrypto as a browser without Ed25519 has it: every other algorithm still works. */
  const withoutEd25519 = () => {
    const real = crypto.subtle.importKey.bind(crypto.subtle) as (...args: unknown[]) => Promise<CryptoKey>
    return vi.spyOn(crypto.subtle, 'importKey').mockImplementation((async (...args: unknown[]) => {
      const algorithm = args[2] as string | { name: string }
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name
      if (name.toLowerCase() === 'ed25519') throw new DOMException('Unrecognized name.', 'NotSupportedError')
      return real(...args)
    }) as typeof crypto.subtle.importKey)
  }

  afterEach(() => vi.restoreAllMocks())

  it('is known before anything is asked of the Mac', async () => {
    expect(await ed25519Available()).toBe(true)
    withoutEd25519()
    expect(await ed25519Available()).toBe(false)
  })

  it('says so, and never reads a genuine binding as one that did not verify', async () => {
    const mac = machine()
    const bind = makeRtcBind({ device: mac.deviceId, offerSdp: OFFER, answerSdp: ANSWER, signer: mac.signer })
    withoutEd25519()
    expect(await checkRtcBind({ bind, offerSdp: OFFER, answerSdp: ANSWER, machineId: mac.deviceId })).toEqual({ ok: false, why: RTC_NO_ED25519 })
  })

  it('still refuses before it gets that far: no machine, or no binding', async () => {
    const mac = machine()
    withoutEd25519()
    expect(await checkRtcBind({ bind: undefined, offerSdp: OFFER, answerSdp: ANSWER, machineId: null })).toEqual({ ok: false, why: 'no machine in scope' })
    expect(await checkRtcBind({ bind: undefined, offerSdp: OFFER, answerSdp: ANSWER, machineId: mac.deviceId })).toEqual({ ok: false, why: RTC_NO_BINDING })
  })
})
