import { createPublicKey } from 'node:crypto'

/**
 * PHONE PUSH — WHAT A SUBSCRIPTION AND A SEND MAY LOOK LIKE (HITL phase 4).
 *
 * Pure checks, apart from the routes, because both of them are a boundary:
 *
 *   · THE ENDPOINT IS WHERE THIS REGISTRY WILL POST. A browser names it, so a
 *     page that got into the console could name anything: an address inside the
 *     cluster, a loopback port, somebody's server, or another API on a push
 *     vendor's own host. Only the four push services' Web Push endpoints are
 *     taken, each by its host and the path prefix browsers are handed (checked
 *     on the parsed, dot-segment-free path), over https on the default port and
 *     with no userinfo. No IP literal can match any of them.
 *   · THE KEYS ARE WHAT A DESKTOP WILL ENCRYPT TO (RFC 8291). A p256dh that is
 *     not a point on P-256, or an auth secret of the wrong length, is refused
 *     here rather than failing later on a machine nobody is looking at.
 *   · THE RECORD IS ALREADY ENCRYPTED. The registry never decrypts it and never
 *     logs it; it checks only that it is base64url and no larger than a push
 *     service takes (4096 bytes, RFC 8030 section 7.2).
 */

/**
 * Each service by what its browsers hand out (2026):
 *   Apple (Safari, iOS 16.4+)   https://web.push.apple.com/<token>
 *   Google (Chrome, Chromium)   https://fcm.googleapis.com/fcm/send/<token>, and /wp/<token> since 2023
 *   Mozilla (Firefox)           https://updates.push.services.mozilla.com/wpush/v1|v2/<token>
 *   Microsoft (Edge, Windows)   https://<one label>.notify.windows.com/w/?token=<token>
 * A prefix needs something after it: the bare prefix is no subscription.
 */
const PUSH_EXACT: ReadonlyMap<string, readonly string[]> = new Map([
  ['web.push.apple.com', ['/']],
  ['fcm.googleapis.com', ['/fcm/send/', '/wp/']],
  ['updates.push.services.mozilla.com', ['/wpush/']]
])
const WNS_SUFFIX = '.notify.windows.com'
const WNS_PATH = '/w/'
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export const ENDPOINT_MAX = 2048
export const LABEL_MAX = 64
/** RFC 8030 section 7.2: a push service must take at least 4096 bytes, and need take no more. */
export const RECORD_MAX = 4096
export const TTL_MAX = 86_400
export const URGENCIES = ['very-low', 'low', 'normal', 'high'] as const
export type Urgency = (typeof URGENCIES)[number]

/** A subscription's id: the registry's own 16 random bytes. */
export const SUBSCRIPTION_ID = /^[A-Za-z0-9_-]{22}$/
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/
const B64U = /^[A-Za-z0-9_-]+$/

export interface PushSubscriptionInput {
  endpoint: string
  p256dh: string
  auth: string
  label: string
}

export interface PushSend {
  subscription: string
  record: Buffer
  ttl: number
  urgency: Urgency
  topic: string | null
}

/** Is this an endpoint of a push service this registry will post to? */
export function pushEndpointOk(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > ENDPOINT_MAX) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') return false
  return pathsFor(url.hostname).some((prefix) => pathAfter(url, prefix))
}

/** The path prefixes this host's Web Push endpoints take; none for any other host. */
function pathsFor(host: string): readonly string[] {
  const exact = PUSH_EXACT.get(host)
  if (exact !== undefined) return exact
  const label = host.endsWith(WNS_SUFFIX) ? host.slice(0, -WNS_SUFFIX.length) : ''
  return DNS_LABEL.test(label) ? [WNS_PATH] : []
}

/** The prefix, and a token after it (in the path, or for WNS in the query). */
const pathAfter = (url: URL, prefix: string): boolean =>
  url.pathname.startsWith(prefix) && (url.pathname.length > prefix.length || (prefix === WNS_PATH && url.search.length > 1))

/** base64url, canonical and without padding, decoding to at most `max` bytes. Null for anything else. */
export function bytesOf(value: unknown, max: number): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil((max * 4) / 3) || !B64U.test(value)) return null
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.byteLength > max || bytes.toString('base64url') !== value) return null
  return bytes
}

/** An uncompressed P-256 point (65 bytes, 0x04 first) that really is on the curve. */
export function isP256Point(bytes: Buffer | null): boolean {
  if (bytes === null || bytes.byteLength !== 65 || bytes[0] !== 0x04) return false
  try {
    createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: bytes.subarray(1, 33).toString('base64url'), y: bytes.subarray(33).toString('base64url') },
      format: 'jwk'
    })
    return true
  } catch {
    return false
  }
}

/** A label a person reads in a list: up to 64 characters, no control or invisible ones. Absent is ''. */
function labelOf(value: unknown): string | null {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > LABEL_MAX || /\p{C}/u.test(value)) return null
  return value.trim()
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The body of POST /v2/me/push/subscriptions, or null. */
export function readSubscription(body: unknown): PushSubscriptionInput | null {
  if (!isRecord(body) || !pushEndpointOk(body.endpoint) || !isRecord(body.keys)) return null
  const { p256dh, auth } = body.keys
  if (!isP256Point(bytesOf(p256dh, 65))) return null
  if (bytesOf(auth, 16)?.byteLength !== 16) return null
  const label = labelOf(body.label)
  if (label === null) return null
  return { endpoint: body.endpoint, p256dh: p256dh as string, auth: auth as string, label }
}

const isUrgency = (value: unknown): value is Urgency => typeof value === 'string' && (URGENCIES as readonly string[]).includes(value)

/** The body of POST /v2/me/push/send, or null. */
export function readSend(body: unknown): PushSend | null {
  if (!isRecord(body)) return null
  const { subscription, ttl, urgency, topic } = body
  if (typeof subscription !== 'string' || !SUBSCRIPTION_ID.test(subscription)) return null
  const record = bytesOf(body.body, RECORD_MAX)
  if (record === null) return null
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 0 || ttl > TTL_MAX) return null
  if (!isUrgency(urgency)) return null
  if (topic !== undefined && (typeof topic !== 'string' || !TOPIC.test(topic))) return null
  return { subscription, record, ttl, urgency, topic: topic ?? null }
}
