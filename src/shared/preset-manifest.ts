/**
 * PRESET MANIFEST (marketplace §2, §5, appendix) — the wire types and the pure
 * decisions that hang off them. No crypto and no fs here: the renderer, the
 * phone client and the CLI all read this, so it stays importable everywhere.
 * Hashing and signing live in main/preset-publish.ts.
 */

/** Findings name a location, never the matched secret. */
export interface SecretFinding {
  where: string
  kind: string
}

/** The `scrub` object: what the install review sheet renders (§5). */
export interface ScrubReport {
  sessions: boolean
  paths: 'placeholders'
  /**
   * Terminals carrying a command — ALL of them, not just `preset: 'Shell'`.
   * The paste engine writes `command` into a PTY whatever the preset is, so a
   * Shell-only count let a Claude Code node smuggle one past the sheet.
   */
  commands: number
  notes: number
  urls: number
  secretScan: 'clean' | 'blocked'
  findings: SecretFinding[]
}

export const PRESET_SCHEMA = 'cookrew.preset/1' as const

export interface PresetAuthor {
  /** `ed25519:<base64url raw public key>` — derived from the key, not chosen. */
  keyId: string
  handle: string
}

export interface PresetPricing {
  model: 'one-time' | 'per-call'
  amount: string
  asset: 'USDC'
}

export interface PresetManifest {
  schema: typeof PRESET_SCHEMA
  /** Content address of team.json — the preset's identity. */
  id: string
  /** Monotonic; the update channel (§10). A HEAD answers with this. */
  version: number
  team: string
  /** Every distributed file by content address. */
  blobs: Record<string, string>
  author: PresetAuthor
  scrub: ScrubReport
  pricing?: PresetPricing
  /** `ed25519:<base64url sig>` over the canonical form of everything above. */
  sig?: string
}

/**
 * Deterministic JSON: keys sorted at every depth, arrays left alone (their
 * order is meaning), undefined dropped. A manifest must have exactly ONE
 * signable byte string, or a round-trip through any JSON layer — a CDN, a
 * client, a test — reorders keys and invalidates a good signature.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/**
 * The bytes a signature covers: the whole manifest except `sig` itself. Author
 * and scrub report are inside it on purpose — attribution and the review
 * sheet's claims are exactly what a tampering registry would want to change.
 */
export function signedPayload(manifest: PresetManifest): string {
  const { sig: _sig, ...rest } = manifest
  void _sig
  return canonicalJson(rest)
}

/** The header a manifest HEAD answers with (R3). */
export const PRESET_VERSION_HEADER = 'x-cookrew-preset-version'

/**
 * R3: the update check is a manifest HEAD by version and nothing more. Only a
 * strictly newer registry version is an update — never a downgrade, and an
 * unreadable answer is "no update" rather than a guess, because a false update
 * badge costs the buyer a re-import of the version they already have.
 */
export function updateAvailable(installed: number, head: number | null): boolean {
  if (head === null || !Number.isInteger(head) || !Number.isInteger(installed)) return false
  return head > installed
}

/**
 * The 403 vocabulary (§2) plus R11's `balance_empty`. 403 is the one answer the
 * client never loops on — it is not self-recoverable — so every member needs a
 * remedy the UI can link instead of a retry.
 */
export const FORBIDDEN_REASONS = [
  'revoked',
  'refunded',
  'seat_limit',
  'version_gate',
  'region',
  /** R11 / R5: a prepaid per-call balance ran out. Remedy is top-up. */
  'balance_empty'
] as const

export type ForbiddenReason = (typeof FORBIDDEN_REASONS)[number]

export interface ForbiddenBody {
  reason: ForbiddenReason
  /** Where the buyer goes to fix it — author page, seat purchase, top-up. */
  remedy?: string
}

export function isForbiddenReason(value: string): value is ForbiddenReason {
  return (FORBIDDEN_REASONS as readonly string[]).includes(value)
}

/**
 * R5: the CALL path answers 200 or 403 only. Payment never interrupts a
 * conversation — pay-per-call is a prepaid balance bought at install or top-up,
 * so an exhausted balance arrives as 403 `balance_empty` with a top-up remedy,
 * not as a wallet sheet mid-turn. 401 is excluded for the same reason: identity
 * is settled before the call, not during it. The download path keeps the full
 * 200/401/402/403 machine; this guard is only for the call path.
 */
export function isCallPathAnswer(status: number): boolean {
  return status === 200 || status === 403
}

/**
 * R12 — METERED DRAWDOWN, recorded here because this is the module that will
 * enforce it. NOT YET IMPLEMENTED: the call path itself does not exist, so
 * there is nothing to charge against. Written down now so the shape cannot
 * drift before then.
 *
 * The rule: drawdown is per-TURN and charged at turn ACCEPT — the moment the
 * gate takes the turn, before any work — and the gate never interrupts a turn
 * once running. A balance is therefore checked exactly once per turn, at the
 * boundary, so `balance_empty` can only ever surface BETWEEN turns.
 *
 * That ordering is what makes "your last answer completed" true by
 * construction rather than by copy: an accepted turn is already paid for, so
 * there is no state in which the gate stops a turn halfway and leaves a partial
 * answer to apologise for. Charging at completion, or re-checking mid-turn,
 * would both create exactly that state — which is why this is a contract and
 * not a wording choice.
 */
export const DRAWDOWN_CONTRACT = {
  unit: 'turn',
  chargedAt: 'accept',
  interruptsRunningTurn: false,
  surfacesBetweenTurnsOnly: true
} as const
