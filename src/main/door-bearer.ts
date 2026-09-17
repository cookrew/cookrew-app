import type { AdmissionPhase, ServeTargetRef } from './served-admission'

/**
 * WHICH CREDENTIAL A DOOR IS ASKED WITH — one decision, in one place (v3, G1).
 *
 * V3-04 made the import walk sign in as the ACCOUNT at a listed door: the door
 * seats `acct-<username>`, which is what lets a seat bought on the web admit
 * this Mac with no second payment. The two calls that FOLLOW an import — the
 * card's transcript reads and its END — kept signing in with the per-door
 * caller KEY, so one door heard two different callers for the same card. The
 * rail then read a session the card never opened, and END ended that one while
 * the account's stayed up, spending the owner's lending budget for nothing.
 *
 * A door with a published name is LISTED and is asked as the account. Anything
 * else is the DIRECT walk, where the key is the only credential the door can
 * check. Nothing here knows how either sign-in works; that is the port's.
 */
export interface DoorBearerPort {
  /** The account's walk at a listed team: cookrew.dev's word, asserted there. */
  admit(target: ServeTargetRef, team: string): Promise<{ token: string | null; phase: AdmissionPhase }>
  /** The per-door caller key — an unlisted door has nothing else to verify. */
  withKey(target: ServeTargetRef): Promise<string>
}

/**
 * The Bearer, or a refusal that NAMES ITSELF.
 *
 * A listed door that will not admit this account throws rather than falling
 * back to the key: the fallback is what produced the two-callers bug, and a
 * card that quietly becomes somebody else is worse than a card that says it
 * could not be read. The phase is in the message so a failed read reports no
 * account, no seat, or a door that refused the minted token — three different
 * things a person acts on differently.
 */
export async function doorBearer(
  port: DoorBearerPort,
  target: ServeTargetRef,
  name: string | null
): Promise<string> {
  if (name === null) return port.withKey(target)
  const admitted = await port.admit(target, name)
  if (admitted.token !== null) return admitted.token
  throw new Error(`${name} did not admit this account (${admitted.phase.kind})`)
}
