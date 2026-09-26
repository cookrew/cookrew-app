import type { DeviceKind } from './account-v2'

/**
 * A DEVICE ASKING TO SIGN IN (D6), and the account's second factors (D3) —
 * the shapes and the SENTENCES both halves of the app have to agree on.
 *
 * The sentence is here rather than in the renderer's copy table because this
 * one is said TWICE: once by main, as the body of a system notification, and
 * once by the card in the profile sheet. Two copies of "wants to sign in as"
 * is how a notification and the card it opens end up describing the same
 * request differently — and this is the one moment in the product where a
 * person is deciding whether to trust something, so the two must match word
 * for word.
 */

/** approve, deny, or "that was not me" (which locks the account down). */
export type ApprovalDecision = 'approve' | 'deny' | 'not-me'

/** One waiting request, as GET /v2/me/approvals lists it. */
export interface ApprovalRequest {
  id: string
  /** What and where, as the registry words it: "Chrome on macOS in Sydney". */
  deviceName: string
  kind: DeviceKind
  /** The address it is asking from — shown, never resolved by this app. */
  address: string
  /** When it started asking, epoch ms. */
  at: number
  /** When the registry stops waiting for an answer, epoch ms. */
  expiresAt: number
}

/** A passkey on the account, as the Security tab lists it. */
export interface PasskeySummary {
  id: string
  name: string
  addedAt: number
}

/**
 * What the Security tab reads, in one answer.
 *
 * `registry` rides along because the passkey row needs somewhere to SEND a
 * person when this Electron has no platform authenticator, and the origin is
 * main's to know (COOKREW_REGISTRY): a renderer that hard-coded cookrew.dev
 * would send a test build's owner to production.
 */
export interface FactorsView {
  totp: boolean
  passkeys: readonly PasskeySummary[]
  /** Set by the registry after "not me": every other session was ended. */
  mustChangePassword: boolean
  registry: string
}

/** What POST /v2/me/totp/enrol hands back, plus the QR main drew for it. */
export interface TotpEnrolment {
  secret: string
  otpauth: string
  /** The QR as rows of '0' and '1'; the renderer paints it as one SVG. */
  qr: readonly string[]
}

/** The sentences D6 and D3 are written in, once. */
export const APPROVAL_COPY = {
  /** The third clause of the D6 sentence, when the account has no factor. */
  NO_FACTOR: 'no second factor on the account yet',
  /** What NOT ME does, said before it is done. */
  NOT_ME_CONFIRM: 'Every other device signs out and you will set a new password.',
  /** The banner after "not me", or after the registry demanded a change. */
  MUST_CHANGE: 'Set a new password — every other device was signed out.',
  /** D3, the passkey row when this Electron cannot make one. */
  PASSKEY_ELSEWHERE: 'Add a passkey on cookrew.dev in your browser — it works from any device',
  /**
   * D3, taking a factor off. The registry's own sentence, because it is the
   * one it sends back when the password is missing — two wordings for one
   * rule is how a person learns the app and the site disagree.
   */
  REMOVE_NEEDS_PASSWORD: 'Type your password to take a factor off the account.',
  /** D3, the authenticator sheet. */
  TOTP_HOW: 'Scan this with your authenticator app, or type the secret into it.',
  /** The confirm field's rule, and why a wrong code is usually just late. */
  TOTP_CODE_RULE: 'Six digits from the app. They change every 30 seconds.',
} as const

const plural = (count: number, unit: string): string =>
  `${count} ${unit}${count === 1 ? '' : 's'}`

/**
 * "12 seconds", "3 minutes", "2 hours" — how long it has been asking.
 *
 * Seconds up to ninety, because "Started 90 seconds ago" is still a number a
 * person reads as "just now", and rounding it to "2 minutes" while the phone
 * in their hand says otherwise is the kind of small lie that costs trust in
 * exactly the screen that needs it.
 */
export function startedAgo(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (seconds < 90) return plural(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return plural(minutes, 'minute')
  return plural(Math.round(minutes / 60), 'hour')
}

/**
 * THE D6 SENTENCE BUILDERS ARE GONE WITH D6's CARD.
 *
 * D11 replaced the pinned approval card with the one queue, and a queue row
 * reads its lead from the copy table rather than from a builder here
 * (shared/account-requests.ts). `startedAgo` stayed: every row in that queue
 * still ends with how long it has been asking, and the units a person reads
 * them in were the one thing worth keeping.
 */
