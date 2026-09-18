import { timingSafeEqual } from 'node:crypto'

/**
 * WHICH CREDENTIAL OPENED THIS MAC, AND WHETHER IT MAY (v3, V3-21).
 *
 * Reach v2.1 had ONE credential: the pairing token the Mac prints, held by
 * every phone alike. That is why revoking a phone at the registry could not
 * end its LAN access — on the LAN a request carries no identity, only the
 * token, and the token is everybody's. Pruning the admitted ledger on revoke
 * (V3-05) removed the ROW; it removed no credential, because the credential
 * was never the row's.
 *
 * So the root token is demoted to a BOOTSTRAP: it may open the admission
 * ceremony (`POST /api/admit`, mobile-identity-routes.ts) and nothing else.
 * Admission mints a token that is THIS phone's — its hash on the phone's own
 * row — and everything after admission is authenticated by that. Forgetting
 * or pruning the row is then, finally, the end of that phone's access; and
 * rotating the root token stops nobody who is admitted, only whoever has
 * not been.
 *
 * ONE DECISION, PURE, USED BY EVERY DOOR — the HTTP gate in mobile-api, the
 * browser-cast WebSocket, the bridge's device sighting. Three doors with
 * three readings of "is this the root token" is how the read hole was found
 * the first time (mobile-api's C1 note).
 *
 * `rootEverywhere` IS THE MIGRATION, and it is a flag rather than a code
 * path on purpose. A companion paired before this change holds the root
 * token and presents it on every request; refusing it outright would log
 * out every phone the owner has on the day the Mac updates, before any of
 * them has had the chance to bootstrap. So until the companion side lands
 * (V3-14: bootstrap once, store the per-device token as cr_token:<desktopId>
 * in place of the root), the root is still honoured everywhere — and the
 * per-device door is already the one that revoke and forget can close.
 */

export type CredentialRoute =
  /** `POST /api/admit` — the one route the root token may open. */
  | 'admission'
  /** Everything else the companion does. */
  | 'other'

export interface CompanionGateInput {
  readonly route: CredentialRoute
  /** The bearer or `?token=` this request presented, or null. */
  readonly presented: string | null
  /** The Mac's root pairing token; null before the server has minted one. */
  readonly rootToken: string | null
  /** The per-device door: admitted-devices.accepts. */
  readonly perDevice: (candidate: string) => boolean
  /** Compatibility: the root token still opens every route. See above. */
  readonly rootEverywhere: boolean
}

/** What opened the door, or null for a refusal. Never the token itself. */
export type CompanionCredential = 'root' | 'device' | null

const sameToken = (candidate: string, token: string): boolean => {
  const a = Buffer.from(candidate)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const companionCredential = (input: CompanionGateInput): CompanionCredential => {
  const { presented, rootToken } = input
  if (!presented) return null
  // The root is compared FIRST because it is a constant-time compare against
  // one string, and the per-device door reads a file. Neither result depends
  // on the order: a per-device token is never equal to the root.
  if (rootToken !== null && sameToken(presented, rootToken)) {
    return input.route === 'admission' || input.rootEverywhere ? 'root' : null
  }
  return input.perDevice(presented) ? 'device' : null
}

/** The yes/no the gates actually ask. */
export const companionAccepted = (input: CompanionGateInput): boolean =>
  companionCredential(input) !== null
