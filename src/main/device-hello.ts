import type { AccountFile } from './account-v2'
import { signWithDevice } from './account-v2'
import { allowedOrigin, CORS_MAX_AGE } from './companion-cors'

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
