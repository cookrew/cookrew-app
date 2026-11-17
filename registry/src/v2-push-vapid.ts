import { createECDH, createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { InFlight, Limiter, TokenBucket } from './v2-limiter'
import { bytesOf, isP256Point } from './v2-push-check'

/**
 * PHONE PUSH — THE REGISTRY'S VAPID KEY (RFC 8292), and the feature it turns on.
 *
 * A browser's subscription is bound to one application server key: the public
 * half below, which the console hands to `pushManager.subscribe`. Every post
 * to a push service then carries a short ES256 JWT signed with the private
 * half, so the push service knows the post comes from the holder of the key the
 * browser subscribed with. node:crypto only: the registry ships as one bundle
 * with no dependency, and an ES256 signature is two calls.
 *
 * ENVIRONMENT ONLY, like the provider keys: a flag is readable in `ps`. Neither
 * key set is the off state, and every push route then answers 404 push_off.
 * Half a pair, a key of the wrong shape or a private key whose public half is
 * not the one named turns push off too, and says so at boot, naming the
 * variable and never its value.
 */

export const VAPID_PUBLIC_ENV = 'COOKREW_VAPID_PUBLIC_KEY'
export const VAPID_PRIVATE_ENV = 'COOKREW_VAPID_PRIVATE_KEY'
export const VAPID_SUBJECT_ENV = 'COOKREW_VAPID_SUBJECT'
/** Who a push service writes to about this sender, when the deployment names nobody. */
export const DEFAULT_SUBJECT = 'https://cookrew.dev'
/** RFC 8292 section 2: no more than 24 hours. Half of that leaves room for a clock that is off. */
export const JWT_LIFETIME_S = 12 * 60 * 60
export const SENDS_PER_MINUTE = 120
export const SUBSCRIBES_PER_MINUTE = 30
/** Every account together (review L2): a burst of 300, then 20 a second. */
export const GLOBAL_BURST = 300
export const GLOBAL_PER_SECOND = 20
/** Posts to push services under way at once, all accounts together. */
export const MAX_IN_FLIGHT = 32

export interface VapidKeys {
  /** base64url of the uncompressed P-256 point (65 bytes). */
  publicKey: string
  /** base64url of the 32-byte private scalar `d`. */
  privateKey: string
  /** A mailto: or https: URL a push service may contact. */
  subject: string
}

export interface Vapid {
  publicKey: string
  subject: string
  key: KeyObject
}

export type PushFetch = (url: string, init: RequestInit) => Promise<Response>

export interface PushOptions extends VapidKeys {
  /** The outbound post, injected by tests. Defaults to the global fetch. */
  fetch?: PushFetch
  sendsPerMinute?: number
  globalBurst?: number
  globalPerSecond?: number
  maxInFlight?: number
}

export interface PushFeature {
  vapid: Vapid
  fetch: PushFetch
  /** Sends, per account. */
  sends: Limiter
  /** Subscription writes, per account. */
  writes: Limiter
  /** Sends, every account together. */
  everyone: TokenBucket
  /** Posts under way now, every account together. */
  inFlight: InFlight
}

const subjectOk = (subject: string): boolean => {
  if (subject.length > 256 || /\s/.test(subject)) return false
  if (subject.startsWith('mailto:')) return /^mailto:[^@]+@[^@]+$/.test(subject)
  try {
    const url = new URL(subject)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/** The key, ready to sign with, or a sentence naming what is wrong (never a value). */
export function vapidOf(keys: VapidKeys): Vapid | string {
  const point = bytesOf(keys.publicKey, 65)
  if (point === null || !isP256Point(point)) return `${VAPID_PUBLIC_ENV} is not a base64url uncompressed P-256 point`
  const d = bytesOf(keys.privateKey, 32)
  if (d === null || d.byteLength !== 32) return `${VAPID_PRIVATE_ENV} is not a base64url 32-byte P-256 private key`
  let derived: Buffer
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(d)
    derived = ecdh.getPublicKey()
  } catch {
    return `${VAPID_PRIVATE_ENV} is not a P-256 private key`
  }
  if (!derived.equals(point)) return `${VAPID_PUBLIC_ENV} is not the public half of ${VAPID_PRIVATE_ENV}`
  if (!subjectOk(keys.subject)) return `${VAPID_SUBJECT_ENV} must be a mailto: or https: URL`
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    format: 'jwk'
  })
  return { publicKey: keys.publicKey, subject: keys.subject, key }
}

const unpadded = (value: string | undefined): string => (value ?? '').trim().replace(/=+$/, '')

/** The keys from the environment, or undefined when push is off. */
export function readVapidEnv(env: NodeJS.ProcessEnv, note: (message: string) => void = () => undefined): VapidKeys | undefined {
  const publicKey = unpadded(env[VAPID_PUBLIC_ENV])
  const privateKey = unpadded(env[VAPID_PRIVATE_ENV])
  if (publicKey === '' && privateKey === '') return undefined
  if (publicKey === '' || privateKey === '') {
    note(`push: ${VAPID_PUBLIC_ENV} and ${VAPID_PRIVATE_ENV} must both be set; push is off`)
    return undefined
  }
  const keys: VapidKeys = { publicKey, privateKey, subject: (env[VAPID_SUBJECT_ENV] ?? '').trim() || DEFAULT_SUBJECT }
  const checked = vapidOf(keys)
  if (typeof checked === 'string') {
    note(`push: ${checked}; push is off`)
    return undefined
  }
  return keys
}

/** The feature, or null when the deployment named no key. A key given in code that is wrong stops the process. */
export function createPush(options: PushOptions | undefined, now?: () => number): PushFeature | null {
  if (options === undefined) return null
  const vapid = vapidOf(options)
  if (typeof vapid === 'string') throw new Error(`refusing to start: ${vapid}`)
  return {
    vapid,
    fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    sends: new Limiter(options.sendsPerMinute ?? SENDS_PER_MINUTE, 60_000, now),
    writes: new Limiter(SUBSCRIBES_PER_MINUTE, 60_000, now),
    everyone: new TokenBucket(options.globalBurst ?? GLOBAL_BURST, options.globalPerSecond ?? GLOBAL_PER_SECOND, now),
    inFlight: new InFlight(options.maxInFlight ?? MAX_IN_FLIGHT)
  }
}

const part = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

/**
 * The Authorization header for one post (RFC 8292 section 3): `vapid t=<JWT>, k=<public key>`.
 * The audience is the push service's origin; the signature is raw r||s, as JWS ES256 wants it.
 */
export function vapidAuthorization(vapid: Vapid, endpoint: string, nowMs: number): string {
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + JWT_LIFETIME_S, sub: vapid.subject }
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part(claims)}`
  const signature = sign('sha256', Buffer.from(unsigned, 'utf8'), { key: vapid.key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${vapid.publicKey}`
}
