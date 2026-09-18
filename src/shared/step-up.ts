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
