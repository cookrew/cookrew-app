/**
 * THE ACCOUNT, as both halves of the app describe it.
 *
 * A username is the identity; a device is a proof of presence (architecture
 * P2). Everything in here is a fact both main and the renderer need to agree
 * on — the shapes that cross the IPC bridge, and the two RULES about names and
 * passwords that must give the same answer on both sides.
 *
 * The rules live here rather than in main because the claim sheet judges every
 * keystroke and main judges the submission. Two copies of "twelve characters"
 * is exactly how a field that says STRONG comes back refused.
 */

/** What kind of thing holds a key on the account. */
export type DeviceKind = 'desktop' | 'phone' | 'browser'

/** One attached device, as the registry lists it. */
export interface AccountDevice {
  id: string
  kind: DeviceKind
  name: string
  addedAt: number
  lastSeenAt: number
  /** True for the device asking — "THIS DEVICE" in the Devices tab (D4). */
  current: boolean
}

/** A desktop of the account and the workspaces it has registered by name. */
export interface AccountDesktop {
  deviceId: string
  name: string
  workspaces: readonly { id: string; name: string }[]
}

/** The registry's answer to GET /v2/me. Directory facts, never content (P1). */
export interface AccountProfile {
  username: string
  displayName: string
  avatar: string | null
  claimedAt: number
  devices: readonly AccountDevice[]
  desktops: readonly AccountDesktop[]
}

/**
 * What the avatar and the sheets read, once per change.
 *
 * `requests` is the D6 seam: a device asking to sign in puts a count here and
 * the avatar wears the rose badge. Phase 1 has nothing that can raise it, so
 * it is always 0 — but the badge, the view-model and its test are real, so
 * Phase 4 adds a producer and nothing else.
 */
export interface AccountStatus {
  username: string | null
  displayName: string
  avatar: string | null
  locked: boolean
  lockAfterMs: number
  requests: number
  /**
   * COOKREW_HANDLE, when the env sets one. Phase 6 migrates identity onto the
   * account; until then serving keeps using the env and this exists only so a
   * surface can say the two names differ.
   */
  envUsername: string | null
  /** The session died of old age; the next authed action needs the password. */
  sessionExpired: boolean
  /** Workspaces of THIS Mac may be offered to the account's other devices. */
  workspacesReachable: boolean
}

/** HEAD /v2/accounts/:username, never optimistically. */
export type UsernameCheck = 'free' | 'taken' | 'invalid' | 'unknown'

/** The password meter's three words. */
export type PasswordStrength = 'weak' | 'ok' | 'strong'

/**
 * Fifteen minutes, on by default (ruling 2026-09-06).
 *
 * Here rather than beside the lock because BOTH halves say it: main arms the
 * timer with it and the security card's row is labelled with it. Two copies
 * is a card that promises fifteen while the timer waits twenty.
 */
export const DEFAULT_LOCK_AFTER_MS = 900_000

/** The floor. Twelve, stated once, read by the field and by the claim. */
export const MIN_PASSWORD = 12

/** Lowercase letters, digits and dashes, 1–32. */
const USERNAME = /^[a-z0-9-]{1,32}$/

/**
 * A username as typed becomes a username as claimed.
 *
 * Only the two edits a person cannot see the point of arguing with: the @ they
 * typed because the UI shows one, and the whitespace a paste brought. Case is
 * NOT folded here — "@Drej Smith" must be REFUSED with the sentence about
 * lowercase, not silently accepted as someone else's name.
 */
export function normaliseUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '')
}

/** `acct-` is the door-side namespace for registry callers; never a username. */
const RESERVED = /^acct-/

export function isValidUsername(raw: string): boolean {
  const name = normaliseUsername(raw)
  return USERNAME.test(name) && !RESERVED.test(name)
}

/** How many of lower / upper / digit / other the password draws on. */
function classesIn(password: string): number {
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/]
  return classes.filter((re) => re.test(password)).length
}

/**
 * The meter, with no dictionary behind it.
 *
 * Length first, because length is what a person can act on: "use twelve" is
 * advice; "raise your entropy" is not. Three character classes reaches STRONG
 * at the floor so a deliberately mixed twelve is not talked down to, and a
 * long sentence reaches it on length alone — which is the advice the sheet
 * actually gives ("a sentence works").
 */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < MIN_PASSWORD) return 'weak'
  if (password.length >= 16 || classesIn(password) >= 3) return 'strong'
  return 'ok'
}

/** Why an account operation refused, in the vocabulary the registry uses. */
export type AccountRefusal =
  | 'taken'
  | 'bad_username'
  | 'weak_password'
  | 'bad_device'
  | 'bad_credentials'
  | 'rate_limited'
  | 'last_device'
  | 'no_account'
  | 'session-expired'
  | 'offline'
  | 'unknown'

/**
 * Every account call answers in this shape.
 *
 * `message` is the registry's own sentence when it sent one — the wire says
 * errors carry {error, message} and that the message is shown verbatim, so it
 * is carried rather than re-worded here. A refusal we invented locally has no
 * message and the surface supplies the sentence.
 */
export type AccountResult<T> =
  { ok: true; value: T } | { ok: false; reason: AccountRefusal; message?: string }
