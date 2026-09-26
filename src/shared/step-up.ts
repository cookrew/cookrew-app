/**
 * THE ACTS THAT ASK AGAIN.
 *
 * A session is thirty days long, and it renews itself on the device key
 * (POST /v2/sessions/renew) rather than on a password typed once a month. That
 * is the right trade for serving — a Mac's doors should not go dark because a
 * person forgot — but it means a stolen session is a month of quiet access. So
 * the password stops being a heartbeat and becomes a THRESHOLD: nothing in the
 * ordinary day asks for it, and everything that widens what the account can be
 * opened from, or takes something away from another device, asks again.
 *
 * ONE LIST, THREE READERS. The registry enforces it, the desktop decides when
 * to raise its prompt, and the web does the same on /me. Three copies of a
 * security boundary drift, and the drift is silent: a client that has not
 * heard of an act simply never prompts, and the only sign is a 401 nobody
 * expected. So the list lives here and all three import it.
 *
 * TODAY IT HAS ONE READER, and that is a gap rather than a claim: neither
 * client can climb a step-up ladder yet, so an account holding a passkey or an
 * authenticator meets a 401 nothing on screen knows how to answer. Which acts
 * that bites is written down below, per act, rather than left to be discovered.
 *
 * The registry imports this file directly — registry/src already reaches into
 * src/shared for the relay frame, for the same reason: a wire contract with
 * two definitions has two meanings.
 */

/** Everything that must be proved again before it happens. */
export type StepUpAct =
  | 'change-password'
  | 'remove-factor'
  | 'revoke-device'
  | 'mint-join-code'
  | 'take-over-door'
  | 'end-seat'
  | 'not-me'

/**
 * The list, in the order the architecture note states it. Exported as an array
 * as well as a type because a client needs to ASK "is this act on the list"
 * at runtime, and a type cannot answer that.
 */
export const STEP_UP_ACTS: readonly StepUpAct[] = [
  'change-password',
  'remove-factor',
  'revoke-device',
  'mint-join-code',
  'take-over-door',
  'end-seat',
  'not-me'
]

export const isStepUpAct = (value: unknown): value is StepUpAct =>
  typeof value === 'string' && (STEP_UP_ACTS as readonly string[]).includes(value)

/**
 * HOW EACH ACT'S THRESHOLD IS ACTUALLY HELD, and why this exists.
 *
 * The list above shipped with a commit saying "the registry enforces it". The
 * registry enforced ONE of the seven; revoking another device and pressing the
 * not-me alarm — the two a thief most wants — were open to a bearer token
 * alone. A shared constant that claims a guarantee the code does not give is
 * worse than no constant, because it is the thing the next reader trusts
 * INSTEAD of reading the routes.
 *
 * So the claim is written down per act, in the only three shapes there are:
 *
 *   `gate`     — the shared gate (registry/src/v2-step-up.ts). The ladder when
 *                the account holds something stronger than its password, the
 *                password when it does not, and the not-me alarm closes both.
 *   `password` — the act's own route asks for the current password inline and
 *                refuses the alarm, which is a step-up in substance. Kept
 *                separate because moving them behind the gate would mean
 *                asking for a ladder no client can climb yet, and because
 *                changing the password is the one act that CLEARS the alarm:
 *                behind the gate it would be a lock with its key inside.
 *   `none`     — no registry route exists for this act in this cut.
 *
 * The registry's own test suite drives every act in this table over HTTP, so a
 * route that loses its threshold cannot leave this file still claiming one.
 */
export type StepUpEnforcement = 'gate' | 'password' | 'none'

export const STEP_UP_ENFORCEMENT: Record<StepUpAct, StepUpEnforcement> = {
  /** POST /v2/me/password — and the only way out of a raised alarm. */
  'change-password': 'password',
  /** DELETE /v2/me/totp · /v2/me/passkeys/:id. */
  'remove-factor': 'password',
  /** DELETE /v2/me/devices/:id. */
  'revoke-device': 'gate',
  /** POST /v2/me/join-codes. */
  'mint-join-code': 'gate',
  /**
   * Taking a door over from another Mac of the account. It happens at the
   * relay's hub against a ticket, not at a /v2 route, and the lane that builds
   * it (V3-18) is not in this cut. Nothing here enforces it because there is
   * nothing here to enforce.
   */
  'take-over-door': 'none',
  /** DELETE /v2/teams/@owner/team/seats/:id. */
  'end-seat': 'gate',
  /** POST /v2/me/approvals/:id with {decision:'not-me'}. */
  'not-me': 'gate'
}

/**
 * What each act is called where a person can see it.
 *
 * The prompt says what is about to happen, not what the API is called. "Prove
 * it is you before removing a factor" is a sentence somebody can decide about;
 * "step-up required for remove-factor" is a log line wearing a prompt's
 * clothes.
 */
export const STEP_UP_SENTENCE: Record<StepUpAct, string> = {
  'change-password': 'Prove it is you before changing the password.',
  'remove-factor': 'Prove it is you before taking a factor off the account.',
  'revoke-device': 'Prove it is you before taking another device off the account.',
  'mint-join-code': 'Prove it is you before adding a machine to the account.',
  'take-over-door': 'Prove it is you before taking a door over from another Mac.',
  'end-seat': 'Prove it is you before ending somebody else’s seat.',
  'not-me': 'Prove it is you before locking the account down.'
}
