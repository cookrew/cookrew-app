/**
 * HELLO v2 — THE PROOF IS BOUND TO THE ENDPOINT THAT MADE IT.
 *
 * `cookrew-hello/1 <deviceId> <nonce>` proves one thing: whoever answered can
 * reach the device key. It does NOT prove that the box which answered is the
 * box holding the key. On a LAN, an attacker who gets a name to point at
 * itself takes our challenge, forwards it to the real Mac, and hands back the
 * real Mac's signature. Every check passes, the companion moves its data plane
 * to the attacker's address, and the pairing token goes with it. Nothing
 * throws; the badge says LAN.
 *
 * So version 2 signs the ENDPOINT as well:
 *
 *     cookrew-hello/2 <deviceId> <origin> <issuedAtMs> <nonce>
 *
 * and each end proves a different half:
 *
 *   THE MAC PROVES WHERE IT ANSWERED. `origin` is scheme + host + port as the
 *   MAC saw the request arrive — derived from the Host header and its own
 *   listener, never from a query parameter, because a caller who can choose
 *   the string being signed can have the Mac sign the attacker's address. The
 *   Host itself is pinned to the names this Mac published (a Host it never
 *   published is 421), so the one caller-supplied input cannot name a third
 *   party either. That closes DNS rebinding at the source.
 *
 *   THE CLIENT PROVES IT IS THE ENDPOINT IT DIALLED. The companion compares
 *   the signed origin against the origin it actually opened. A relayed
 *   signature is now self-incriminating: it says the real Mac's origin, which
 *   is not the attacker's, and the switch is refused. This is the check that
 *   defeats the relay attack, and it is why the client refuses version 1 —
 *   a v1 answer has no origin to compare, so it cannot be distinguished from
 *   a relayed one.
 *
 *   THE REGISTRY PROVES IT IS FRESH AND UNSPENT. It holds the device's public
 *   key, and only it can say the signature is the Mac's. It also holds a
 *   clock and a burn list: see registry/src/hello-verify.ts.
 *
 * `issuedAtMs` is the Mac's own clock at signing. It bounds how long a
 * captured answer is worth anything at all — without it, a signature scraped
 * from a phone's network log stays valid until the device key changes.
 */

/** The context line. Version is FIRST so a parser can refuse before it reads. */
export const HELLO_V2_CONTEXT = 'cookrew-hello/2'

/**
 * How far apart the Mac's clock and the registry's may be.
 *
 * Two minutes, because a Mac that has just woken from sleep has not yet talked
 * to a time server and can be tens of seconds out; anything tighter refuses
 * honest hellos on exactly the machines this feature exists for. Anything
 * looser turns the timestamp into decoration: it is a replay window, and the
 * window is how long a captured signature remains spendable.
 */
export const HELLO_SKEW_MS = 120_000

/** Exactly the bytes that get signed. Every implementation builds this string. */
export const helloMessageV2 = (
  deviceId: string,
  origin: string,
  issuedAtMs: number,
  nonce: string
): string => `${HELLO_V2_CONTEXT} ${deviceId} ${origin} ${issuedAtMs} ${nonce}`

/** What a version 2 `/api/hello` answers with. */
export interface HelloV2Body {
  readonly v: 2
  readonly deviceId: string
  readonly name: string
  /** The origin the MAC believes it answered on. Not the one the caller asked for. */
  readonly origin: string
  readonly issuedAtMs: number
  readonly nonce: string
  readonly sig: string
}

/**
 * Why a client threw an answer away. Named rather than boolean because these
 * are different events: `wrong_origin` is an attack in progress, `no_version`
 * is a Mac that has not been updated yet, and a log that cannot tell them
 * apart is a log that never reports the attack.
 */
export type HelloReplyRefusal =
  | 'no_version'
  | 'wrong_device'
  | 'wrong_nonce'
  | 'wrong_origin'
  | 'malformed'

/** Anything with the fields a reply might carry; nothing is assumed present. */
export interface HelloReplyLike {
  readonly v?: unknown
  readonly deviceId?: unknown
  readonly origin?: unknown
  readonly issuedAtMs?: unknown
  readonly nonce?: unknown
  readonly sig?: unknown
}

export interface HelloExpectation {
  /** The origin the client actually opened the connection to. */
  readonly origin: string
  readonly deviceId: string
  readonly nonce: string
}

/**
 * Is this answer worth sending to the registry? Null means yes.
 *
 * ORDER IS DELIBERATE: version first, because a v1 answer is a different
 * protocol and not a failure of this one; then the two cheap equalities; then
 * the origin, which is the one that names an attacker.
 */
export const checkHelloReply = (
  reply: HelloReplyLike | null,
  expected: HelloExpectation
): HelloReplyRefusal | null => {
  if (reply === null || typeof reply !== 'object') return 'malformed'
  // A Mac on an older bundle answers v1 and is simply not usable here. It is
  // refused rather than trusted: without a signed origin there is no way to
  // tell its answer from the same answer relayed by somebody else.
  if (reply.v !== 2) return 'no_version'
  if (reply.deviceId !== expected.deviceId) return 'wrong_device'
  if (reply.nonce !== expected.nonce) return 'wrong_nonce'
  if (typeof reply.sig !== 'string' || reply.sig.length === 0) return 'malformed'
  if (!Number.isSafeInteger(reply.issuedAtMs) || (reply.issuedAtMs as number) <= 0) return 'malformed'
  if (typeof reply.origin !== 'string' || reply.origin.length === 0) return 'malformed'
  // THE ATTACK, CAUGHT HERE. A signature relayed from the real Mac carries the
  // real Mac's origin, which is not the address this client dialled.
  if (normaliseOrigin(reply.origin) !== normaliseOrigin(expected.origin)) return 'wrong_origin'
  return null
}

/**
 * One spelling of an origin, so two sides comparing strings agree.
 *
 * `https://mac:443` and `https://mac` are the same endpoint and a browser will
 * write either; comparing them raw would refuse an honest Mac. Anything that
 * is not a parseable origin comes back unchanged and simply fails to match,
 * which is the safe direction.
 */
export const normaliseOrigin = (origin: string): string => {
  try {
    const url = new URL(origin)
    return `${url.protocol}//${url.host}`.toLowerCase()
  } catch {
    return origin.trim().toLowerCase()
  }
}

/**
 * THE ORIGIN THIS REQUEST ARRIVED AT, as the server itself saw it.
 *
 * Built from the LISTENER's scheme (a TLS socket or not) and the Host header,
 * which is the only part a caller supplies — and the only part that is then
 * checked against what this machine published. Returns null for a Host that is
 * missing, malformed, or not one of ours; the caller answers 421 Misdirected
 * Request, which is exactly what a rebound name is.
 */
export const publishedRequestOrigin = (
  hostHeader: string | undefined,
  secure: boolean,
  published: readonly string[]
): string | null => {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0 || hostHeader.length > 260) return null
  // A Host with a path, a comma (two headers folded into one) or whitespace is
  // not a Host; refusing it is cheaper than reasoning about what a URL parser
  // will make of it.
  if (/[\s,/\\?#@]/.test(hostHeader)) return null
  const asked = normaliseOrigin(`${secure ? 'https' : 'http'}://${hostHeader.replace(/\.$/, '')}`)
  if (!/^https?:\/\/[a-z0-9.\-[\]:]+$/.test(asked)) return null
  return published.some((origin) => normaliseOrigin(origin) === asked) ? asked : null
}
