import { createPublicKey, verify } from 'node:crypto'

/**
 * IDENTITY v2 — THE REACH CARD.
 *
 * A desktop says where it can be found: its LAN addresses, its tailnet
 * address, whether the relay is available, and when it last said so. The
 * registry stores that and hands it to the account's OWN devices, so a phone
 * anywhere can pick a path without anyone typing an address.
 *
 * Three rules, and each of them exists because of a specific way this goes
 * wrong:
 *
 *   SIGNED BY THE MACHINE IT DESCRIBES. Anything else — a second device of
 *   the same account, a stolen session — could point the owner's own browser
 *   at an address of its choosing. The signature is over a canonical string
 *   so that two implementations that agree about the facts agree about the
 *   bytes.
 *
 *   PRIVATE HOSTS ONLY. A card naming a public host would make the /me page a
 *   machine for fetching arbitrary origins with the reader's own browser. The
 *   allow-list is the whole set of places a desktop can honestly be: private
 *   IPv4 and IPv6, the tailnet's 100.64/10 and *.ts.net, and mDNS .local.
 *
 *   AN ORIGIN, NOT A URL. `https://host:port` exactly — no path, no query, no
 *   credentials. The page appends `/api/hello`; anything richer than an origin
 *   is a way to smuggle a different request into that append.
 */

export interface ReachAddress {
  /** An origin: `https://host[:port]`, no trailing slash. */
  url: string
  /** The TLS certificate fingerprint, 64 lowercase hex characters. */
  certFp: string
}

export interface V2Reach {
  lan: readonly ReachAddress[]
  tailnet: ReachAddress | null
  relay: boolean
  /** ISO 8601, as the desktop wrote it. */
  at: string
  /** base64url Ed25519 (or P-256) over the canonical card. Kept so a device can re-check it. */
  sig: string
}

/** Eight is more addresses than a machine with three network interfaces has. */
export const LAN_MAX = 8
const URL_MAX = 200
const CERT_FP = /^[0-9a-f]{64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const BASE64URL = /^[A-Za-z0-9_-]{16,1024}$/
/** 16 bytes of base64url is 22 characters; the floor the contract names. */
const NONCE = /^[A-Za-z0-9_-]{22,256}$/

/**
 * CANONICAL JSON: keys sorted at every depth, no whitespace, arrays as they
 * are. The one thing both sides must compute identically — a signature over
 * `JSON.stringify` would depend on the order a sender happened to build an
 * object in, which is a bug that only shows up on somebody else's machine.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const held = value as Record<string, unknown>
  const body = Object.keys(held)
    .sort()
    .filter((key) => held[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(held[key])}`)
  return `{${body.join(',')}}`
}

const ipv4 = (host: string): number[] | null => {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1))
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null
}

/**
 * Which path an address IS, or null when a desktop may not name it. The answer
 * doubles as the probe's ordering: lan beats tailnet, and both beat the relay.
 */
export function reachHostKind(url: unknown): 'lan' | 'tailnet' | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > URL_MAX) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // An ORIGIN and nothing more. `origin` drops credentials, path, query and
  // fragment, so demanding it back verbatim refuses every one of them.
  if (parsed.protocol !== 'https:' || parsed.origin !== url) return null
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  const octets = ipv4(host)
  if (octets !== null) {
    const [a, b] = octets
    if (a === 10 || a === 127) return 'lan'
    if (a === 172 && b >= 16 && b <= 31) return 'lan'
    if (a === 192 && b === 168) return 'lan'
    if (a === 169 && b === 254) return 'lan'
    if (a === 100 && b >= 64 && b <= 127) return 'tailnet'
    return null
  }
  if (host.includes(':')) {
    if (host === '::1') return 'lan'
    const head = host.split(':')[0]
    if (/^f[cd][0-9a-f]{0,2}$/.test(head)) return 'lan'
    if (/^fe[89ab][0-9a-f]?$/.test(head)) return 'lan'
    return null
  }
  if (host.endsWith('.ts.net')) return 'tailnet'
  if (host.endsWith('.local')) return 'lan'
  return null
}

const readAddress = (input: unknown): ReachAddress | null => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const { url, certFp } = input as { url?: unknown; certFp?: unknown }
  if (reachHostKind(url) === null) return null
  if (typeof certFp !== 'string' || !CERT_FP.test(certFp)) return null
  return { url: url as string, certFp }
}

/**
 * The exact object the signature covers. Rebuilt from the members the contract
 * names rather than echoing what arrived, so an extra field cannot ride along
 * inside a signed card.
 */
const cardOf = (deviceId: string, reach: Omit<V2Reach, 'sig'>): Record<string, unknown> => ({
  deviceId,
  lan: reach.lan.map((a) => ({ url: a.url, certFp: a.certFp })),
  tailnet: reach.tailnet === null ? null : { url: reach.tailnet.url, certFp: reach.tailnet.certFp },
  relay: reach.relay,
  at: reach.at
})

/**
 * A DEVICE'S OWN SIGNATURE over a string. Ed25519 for a desktop and for a
 * browser that has it; P-256 for the browsers that do not, which is the same
 * pair of algorithms `sanitiseJwk` already admits. Anything malformed is
 * `false` — never a throw, because this is called on a stranger's bytes.
 */
export function verifyDeviceSignature(jwk: Record<string, string>, message: string, sig: unknown): boolean {
  if (typeof sig !== 'string' || !BASE64URL.test(sig)) return false
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' })
    const data = Buffer.from(message, 'utf8')
    const signature = Buffer.from(sig, 'base64url')
    return jwk.kty === 'OKP'
      ? verify(null, data, key, signature)
      : verify('sha256', data, key, signature)
  } catch {
    return false
  }
}

/**
 * A reach card, or null. Null covers a malformed body, a host this may not
 * name and a signature that is not this desktop's alike: a caller must not be
 * able to tell them apart and learn which part of a forgery to fix.
 */
export function readReach(
  deviceId: string,
  jwk: Record<string, string>,
  input: { reach: unknown; sig: unknown }
): V2Reach | null {
  const raw = input.reach
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { lan, tailnet, relay, at } = raw as {
    lan?: unknown
    tailnet?: unknown
    relay?: unknown
    at?: unknown
  }
  if (!Array.isArray(lan) || lan.length > LAN_MAX) return null
  const addresses: ReachAddress[] = []
  for (const entry of lan) {
    const address = readAddress(entry)
    if (address === null) return null
    addresses.push(address)
  }
  let overTailnet: ReachAddress | null = null
  if (tailnet !== null && tailnet !== undefined) {
    overTailnet = readAddress(tailnet)
    if (overTailnet === null) return null
  }
  if (typeof relay !== 'boolean') return null
  if (typeof at !== 'string' || !ISO.test(at) || !Number.isFinite(Date.parse(at))) return null

  const card: Omit<V2Reach, 'sig'> = { lan: addresses, tailnet: overTailnet, relay, at }
  if (!verifyDeviceSignature(jwk, canonicalJson(cardOf(deviceId, card)), input.sig)) return null
  return { ...card, sig: input.sig as string }
}

/**
 * THE HELLO A DESKTOP ANSWERS WITH. `cookrew-hello/1 <deviceId> <nonce>`,
 * signed by the device key — one line, so it can be typed into a test and read
 * in a log. The nonce is the phone's, which is what makes the answer this
 * conversation's rather than a recording of an earlier one.
 */
export const HELLO_PREFIX = 'cookrew-hello/1'
export const helloMessage = (deviceId: string, nonce: string): string => `${HELLO_PREFIX} ${deviceId} ${nonce}`

export function verifyHello(
  jwk: Record<string, string>,
  input: { deviceId: unknown; nonce: unknown; sig: unknown }
): boolean {
  const { deviceId, nonce } = input
  if (typeof deviceId !== 'string' || typeof nonce !== 'string' || !NONCE.test(nonce)) return false
  return verifyDeviceSignature(jwk, helloMessage(deviceId, nonce), input.sig)
}
