import type { AccountFile } from './account-v2'
import { deviceIdFor, signWithDevice, verifyWithDevice } from './account-v2'
import { allowedOrigin, CORS_MAX_AGE } from './companion-cors'
import {
  HELLO_SKEW_MS,
  helloMessageV2,
  normaliseOrigin,
  type HelloV2Body
} from '../shared/hello-proof'

/**
 * "ARE YOU THE MAC I THINK YOU ARE?"
 *
 * The phone gets a list of addresses from cookrew.dev and races them. An
 * address that answers proves only that something is listening; the pinned
 * certificate proves the TLS peer is the box that made the cert. Neither
 * proves the box is the DEVICE the registry named — a Mac that reissued its
 * self-signed certificate, or a second app on the same LAN, both answer.
 *
 * So the probe asks for a signature over a nonce it just made. Replaying a
 * recorded answer needs the same nonce, and only the device key can produce a
 * new one. That is the whole protocol.
 *
 * THAT IS NO LONGER THE WHOLE PROTOCOL. A nonce proves the answer is fresh
 * and the key proves the answerer holds it — neither proves WHICH ENDPOINT
 * answered, so a box on the LAN can forward our challenge to the real Mac and
 * return its signature as its own. Version 2 signs the origin too; see
 * `helloAnswerV2` below and src/shared/hello-proof.ts. Version 1 is still
 * answered for phones on an older bundle, and is refused by every current one.
 *
 * It is UNAUTHENTICATED on purpose. It reveals the device id — which the phone
 * already has, since it came from the registry — and the Mac's name, which is
 * on the certificate anyway. Gating it behind the pairing token would mean a
 * phone could not tell whether the box is the right one until after it had
 * sent it a credential, which is backwards.
 */

export const HELLO_CONTEXT = 'cookrew-hello/1'

export const NONCE_MIN_BYTES = 16
export const NONCE_MAX_BYTES = 64

/** Exactly the bytes that get signed. Both ends build this string. */
export const helloMessage = (deviceId: string, nonce: string): string =>
  `${HELLO_CONTEXT} ${deviceId} ${nonce}`

/**
 * The nonce's decoded length, or null if it is not base64url at all.
 *
 * Strict: the nonce is echoed back inside a signed string, so anything the two
 * ends might spell differently — padding, the base64 alphabet's + and / — is
 * refused rather than normalised.
 */
export const nonceBytes = (nonce: string): number | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) return null
  const decoded = Buffer.from(nonce, 'base64url')
  // Round-trip: base64url decoding is lenient and silently accepts trailing
  // bits that no encoder would ever produce.
  if (decoded.toString('base64url') !== nonce) return null
  return decoded.length
}

export const nonceAcceptable = (nonce: string): boolean => {
  const bytes = nonceBytes(nonce)
  return bytes !== null && bytes >= NONCE_MIN_BYTES && bytes <= NONCE_MAX_BYTES
}

export type HelloBody = {
  readonly deviceId: string
  readonly name: string
  readonly nonce: string
  readonly sig: string
}

export type HelloAnswer =
  | { readonly status: 200; readonly body: HelloBody }
  | { readonly status: 400; readonly body: { error: string } }
  | { readonly status: 404; readonly body: { error: string } }

export const helloAnswer = (account: AccountFile | null, nonce: string | null): HelloAnswer => {
  // No account, no identity to assert. 404 rather than 500: this Mac genuinely
  // has no such endpoint until someone claims a username on it.
  if (!account) return { status: 404, body: { error: 'no account on this desktop' } }
  if (nonce === null || !nonceAcceptable(nonce)) {
    return { status: 400, body: { error: 'nonce must be 16 to 64 base64url bytes' } }
  }
  return {
    status: 200,
    body: {
      deviceId: account.deviceId,
      name: account.name,
      nonce,
      sig: signWithDevice(account, helloMessage(account.deviceId, nonce))
    }
  }
}

/**
 * CORS for exactly one origin, and no credentials.
 *
 * The rest of this server writes no access-control headers at all, on purpose
 * (C2): a wildcard would let any page in any browser read transcripts. This
 * route is the one exception, because the caller IS a page — the cookrew.dev
 * probe running in the phone's browser — and it needs to read the answer.
 *
 * The exception is kept as narrow as it can be: one origin, echoed only when
 * it matches; no `allow-credentials`, so the browser sends no cookies and no
 * ambient authority rides along; and it is written here rather than in the
 * shared respondJson, so nothing else can inherit it by accident.
 */
/**
 * THIS MAC'S OWN OTHER ADDRESSES, and why they are the second exception.
 *
 * Live path switching (phase 3) is a companion served over the TAILNET asking
 * a LAN address of the SAME Mac whether it is the same Mac. The asking page's
 * origin is then `https://100.x.x.x:8643` — not the registry — so with one
 * allowed origin the answer is unreadable and the phone can never learn that
 * the better path is there. It would stay on the slow one forever, which is
 * the whole thing the badge exists to avoid.
 *
 * It is still as narrow as it can be: exact origins this server ITSELF
 * advertises, echoed only on match, and still no `allow-credentials` — so no
 * cookie and no ambient authority rides along, on any of them.
 */
/**
 * ONE ORIGIN RULE, TWO CALLERS. The decision — exact match against the
 * registry origin plus this Mac's own — lives in companion-cors.ts, which is
 * also what gates every other route now that the phone's data plane is direct
 * from a page on cookrew.dev. Two allow-lists would be two chances to admit
 * somebody, and only one of them would be reviewed.
 *
 * The VERBS stay narrow here because this route is narrow: a GET and its
 * preflight, and no request body worth naming a content type for.
 */
export const helloCorsHeaders = (
  requestOrigin: string | undefined,
  registryOrigin: string,
  selfOrigins: readonly string[] = []
): Record<string, string> => {
  const headers: Record<string, string> = { vary: 'origin' }
  const asked = allowedOrigin(requestOrigin, [registryOrigin, ...selfOrigins])
  if (asked !== null) {
    headers['access-control-allow-origin'] = asked
    headers['access-control-allow-methods'] = 'GET, OPTIONS'
    headers['access-control-allow-headers'] = 'content-type'
    headers['access-control-max-age'] = CORS_MAX_AGE
  }
  return headers
}

// ── version 2: the proof that names the endpoint ──────────────────────────

/**
 * WHAT THIS MAC WILL SWEAR TO, and the three things it refuses to.
 *
 * The signature covers `cookrew-hello/2 <deviceId> <origin> <issuedAtMs>
 * <nonce>`, where `origin` is what THIS server saw the request arrive at — the
 * listener's scheme and the Host header, once the Host has been checked
 * against the names this Mac actually published. A caller cannot put a string
 * of its choosing into a signature this Mac makes, which is the whole point:
 * a relayed challenge comes back naming the real Mac, not the relay.
 *
 *   404  no account, so there is no identity to assert. Answered FIRST, as in
 *        version 1: the absent account is the first fact about this machine.
 *   421  Misdirected Request. Either the Host is not a name this Mac published
 *        — which is what a rebound DNS name looks like from in here — or the
 *        caller's `?origin=` disagrees with where the request actually landed,
 *        which is what a relay looks like. 421 is the honest status: the
 *        request reached a server that is not the one it was addressed to.
 *   400  the nonce is missing or out of bounds, exactly as in version 1.
 */
export type HelloAnswerV2 =
  | { readonly status: 200; readonly body: HelloV2Body }
  | { readonly status: 400 | 404 | 421; readonly body: { error: string } }

export interface HelloV2Request {
  readonly account: AccountFile | null
  readonly nonce: string | null
  /** `?origin=` — what the caller believes it dialled. A hint, never the signed value. */
  readonly asked: string | null
  /** Where the request actually arrived, or null when the Host is not one of ours. */
  readonly arrived: string | null
  readonly now: number
}

export const helloAnswerV2 = (input: HelloV2Request): HelloAnswerV2 => {
  const { account, arrived } = input
  if (!account) return { status: 404, body: { error: 'no account on this desktop' } }
  if (arrived === null) {
    return { status: 421, body: { error: 'this is not a name this desktop published' } }
  }
  // The fast refusal the client asks for: if the caller already knows it
  // dialled something else, say so now rather than spending a signature and
  // letting the client discover the mismatch a round trip later.
  if (input.asked !== null && normaliseOrigin(input.asked) !== normaliseOrigin(arrived)) {
    return { status: 421, body: { error: 'that is not the address this request reached' } }
  }
  if (input.nonce === null || !nonceAcceptable(input.nonce)) {
    return { status: 400, body: { error: 'nonce must be 16 to 64 base64url bytes' } }
  }
  const issuedAtMs = input.now
  return {
    status: 200,
    body: {
      v: 2,
      deviceId: account.deviceId,
      name: account.name,
      origin: arrived,
      issuedAtMs,
      nonce: input.nonce,
      sig: signWithDevice(
        account,
        helloMessageV2(account.deviceId, arrived, issuedAtMs, input.nonce)
      )
    }
  }
}

// ── admission: the phone proves ITS key, and the root token becomes its own ──

/**
 * "I AM THE DEVICE THIS KEY NAMES, AND I AM TALKING TO YOU" (v3, V3-21).
 *
 * The hello above is the Mac proving itself to the phone. Admission is the
 * other direction, and it exists because on the LAN a request carries no
 * identity: the relay stamps a device id on what it forwards (relay-device.ts)
 * and strips whatever the caller wrote, so a direct request has nothing to
 * refuse BY. The phone therefore proves a key — the same shape, the same
 * three refusals — and the Mac mints a token for THAT key and no other.
 *
 * The signature covers `cookrew-admit/1 <deviceId> <origin> <issuedAtMs>
 * <nonce>`, where `origin` is the address the request ARRIVED at, checked
 * against the names this Mac published, exactly as the version 2 hello does
 * in the other direction. Bound to the origin so a proof captured on one Mac
 * cannot be replayed to admit the same phone on another; bound to a
 * timestamp so a captured one is spendable for two minutes and not for ever.
 *
 * THE DEVICE ID IS THE KEY'S THUMBPRINT (account-v2.ts · deviceIdFor), so a
 * caller cannot present somebody else's id with its own key: the id is
 * recomputed from the JWK it sent and must match. What this does NOT prove
 * is that the id is on the ACCOUNT — the root token is what says this phone
 * may be admitted at all, as it always has, and the registry's revoked list
 * (prune) is what ends an account device's admission afterwards.
 */
export const ADMIT_CONTEXT = 'cookrew-admit/1'

export const admitMessage = (
  deviceId: string,
  origin: string,
  issuedAtMs: number,
  nonce: string
): string => `${ADMIT_CONTEXT} ${deviceId} ${origin} ${issuedAtMs} ${nonce}`

/** The body `POST /api/admit` takes from a phone on the LAN. */
export interface AdmitBody {
  readonly deviceId: string
  /** What the Devices sheet calls it. Optional; cut to a safe name on write. */
  readonly name?: string
  /** The phone's Ed25519 public key. Never stored: only its thumbprint is. */
  readonly jwk: Record<string, unknown>
  readonly nonce: string
  readonly issuedAtMs: number
  readonly sig: string
}

export type AdmissionReading =
  | { readonly ok: true; readonly deviceId: string; readonly name?: string }
  | { readonly ok: false; readonly status: 400 | 401 | 421; readonly error: string }

export interface AdmissionInput {
  readonly body: unknown
  /** Where the request arrived, or null when the Host is not one of ours. */
  readonly arrived: string | null
  /** The device the RELAY named, when the request came down the bridge. */
  readonly bridged: { readonly deviceId: string; readonly name?: string } | null
  readonly now: number
}

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const looksLikeJwk = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>).kty === 'OKP' &&
  (value as Record<string, unknown>).crv === 'Ed25519' &&
  typeof (value as Record<string, unknown>).x === 'string'

/**
 * Read an admission, two ways.
 *
 * DOWN THE BRIDGE the registry has already authenticated the phone and named
 * it in the stamp; the body may name the same device or nothing, and no
 * signature is asked for — the bridge is loopback-only and marker-checked
 * (relay-device.ts), which is the trust the whole relay path already rests
 * on. A body that names a DIFFERENT device than the stamp is refused: one
 * request, one identity.
 *
 * ON THE LAN there is no stamp, so the body is the whole proof.
 */
export const readAdmission = (input: AdmissionInput): AdmissionReading => {
  const body = (typeof input.body === 'object' && input.body !== null ? input.body : {}) as Record<
    string,
    unknown
  >
  if (input.bridged !== null) {
    if (typeof body.deviceId === 'string' && body.deviceId !== input.bridged.deviceId) {
      return { ok: false, status: 401, error: 'the relay names a different device' }
    }
    const name = typeof body.name === 'string' ? body.name : input.bridged.name
    return { ok: true, deviceId: input.bridged.deviceId, ...(name ? { name } : {}) }
  }
  const deviceId = body.deviceId
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) {
    return { ok: false, status: 400, error: 'deviceId must be a device id' }
  }
  if (!looksLikeJwk(body.jwk)) {
    return { ok: false, status: 400, error: 'jwk must be an Ed25519 public key' }
  }
  if (typeof body.nonce !== 'string' || !nonceAcceptable(body.nonce)) {
    return { ok: false, status: 400, error: 'nonce must be 16 to 64 base64url bytes' }
  }
  if (typeof body.issuedAtMs !== 'number' || !Number.isFinite(body.issuedAtMs)) {
    return { ok: false, status: 400, error: 'issuedAtMs must be a number' }
  }
  if (typeof body.sig !== 'string' || body.sig.length === 0) {
    return { ok: false, status: 400, error: 'sig is required' }
  }
  if (input.arrived === null) {
    return { ok: false, status: 421, error: 'this is not a name this desktop published' }
  }
  if (Math.abs(input.now - body.issuedAtMs) > HELLO_SKEW_MS) {
    return { ok: false, status: 401, error: 'this proof is too old or too far ahead' }
  }
  // The id is not taken from the caller; it is recomputed from the key the
  // caller proved it holds, and the two must agree.
  if (deviceIdFor(body.jwk) !== deviceId) {
    return { ok: false, status: 401, error: 'deviceId is not the thumbprint of jwk' }
  }
  const message = admitMessage(deviceId, input.arrived, body.issuedAtMs, body.nonce)
  if (!verifyWithDevice(body.jwk, message, body.sig)) {
    return { ok: false, status: 401, error: 'the signature does not open for this key and address' }
  }
  const name = typeof body.name === 'string' ? body.name : undefined
  return { ok: true, deviceId, ...(name ? { name } : {}) }
}
