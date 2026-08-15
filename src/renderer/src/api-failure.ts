/**
 * Telling a DEAD CREDENTIAL from an OUT-OF-SCOPE ROUTE (delta-review D6).
 *
 * v4 §4 made reads gated, and that changed what a refusal means. Before, a
 * 401 was the only refusal a client saw and "re-pair" was always the fix. Now
 * a KNOWN token gets 403 for anything outside its groups (Sol F9) — and the
 * wall's token is exactly that: authorized for the board it renders, refused
 * for everything else. Treating those two the same has one very bad outcome:
 * the wall renders its board, requests one route outside `observe`, and the
 * whole app is replaced by a re-pair screen it does not need and cannot act on
 * (there is no keyboard on a wall).
 *
 * The rule this module encodes: report() — evicting the app to the re-pair
 * screen — is only for failures a re-pair would actually fix. Everything else
 * is surfaced where it happened, on the card that asked.
 */
import type { AuthScope } from './auth-gate'

/**
 * A 403 that means "this credential is fine, this route is not yours". Thrown
 * to the call site and rendered there; it must NEVER reach authStore.report().
 */
export class ScopeError extends Error {
  readonly path: string
  /** The server marked the credential read-only — a stronger one exists. */
  readonly readOnly: boolean

  constructor(message: string, path: string, readOnly: boolean) {
    super(message)
    this.name = 'ScopeError'
    this.path = path
    this.readOnly = readOnly
  }
}

export function isScopeError(error: unknown): error is ScopeError {
  return error instanceof ScopeError
}

/**
 * Routes the client cannot render ANYTHING without. A 403 here is not a scope
 * refusal you can shrug off in a corner of the UI — this credential cannot
 * drive this app at all, so the re-pair screen is the honest answer.
 *
 * Matched EXACTLY, never by prefix: `/api/workspaces/:id/dirs` is an ordinary
 * scoped write, and a prefix match would evict the app on a refusal that only
 * concerns one workspace.
 */
export const BOOTSTRAP_ROUTES: readonly string[] = [
  '/api/auth/status',
  '/api/workspace',
  '/api/workspaces'
]

export function isBootstrapRoute(path: string): boolean {
  return BOOTSTRAP_ROUTES.includes(path.split('?')[0])
}

/**
 * The server keeps the phrase "read-only" in that message on purpose — it is
 * the marker for "your credential is KNOWN but weaker than this route needs",
 * i.e. the one 403 a re-pair can fix (auth-gate.ts gateMessage).
 */
export function isReadOnlyRefusal(message: string): boolean {
  return /read-only/i.test(message)
}

export type FailureKind = 'credential' | 'scope' | 'other'

export interface HttpFailure {
  status: number
  /** The server's error message, verbatim. */
  message: string
  path: string
  method?: string
}

/**
 * What kind of failure this is — the whole point of the fix.
 *
 * 'credential' evicts to the re-pair screen. It is reserved for the cases
 * where pairing again plausibly helps:
 *   - 401: the server does not know this token at all.
 *   - 403 on a bootstrap route: known, but cannot even load the app.
 *   - 403 read-only on a MUTATION: known, and the write credential is exactly
 *     what the user is missing. (This is the C1 behaviour worth keeping — a
 *     read-only phone whose keystrokes vanish silently is the original bug.)
 *
 * 'scope' is everything else a 403 can mean: an out-of-scope READ, an unknown
 * route, another workspace's data. Re-pairing changes none of them, so the
 * call site says so locally and the rest of the app keeps working.
 */
export function classifyHttpFailure(failure: HttpFailure): FailureKind {
  const { status, message, path } = failure
  const method = (failure.method ?? 'GET').toUpperCase()
  if (status === 401) return 'credential'
  if (status !== 403) return 'other'
  if (isBootstrapRoute(path)) return 'credential'
  if (method !== 'GET' && isReadOnlyRefusal(message)) return 'credential'
  return 'scope'
}

/** The scope this failure implies, for the re-pair screen's copy. */
export function failureScope(message: string): AuthScope {
  return isReadOnlyRefusal(message) ? 'read-only' : 'none'
}

/** A card-level message: what this one card cannot show, and why. */
export interface StreamNotice {
  kind: 'scope' | 'unpaired' | 'unavailable'
  message: string
}

/**
 * Card-level copy for a failed fetch. A scope refusal is named as one — the
 * user is not missing data, they are holding a credential that does not cover
 * it — and everything else says the read failed rather than rendering the
 * empty state, which would claim there is nothing to show.
 */
export function noticeForError(error: unknown, subject: string): StreamNotice {
  if (isScopeError(error)) {
    return {
      kind: 'scope',
      message: error.readOnly
        ? `${subject} is outside this device’s scope — it is paired read-only.`
        : `${subject} is outside this token’s scope.`
    }
  }
  return { kind: 'unavailable', message: `${subject} could not be loaded.` }
}

/**
 * What to do when a stream fails.
 *
 * EventSource never exposes the HTTP status, so a refused stream is
 * indistinguishable from a dropped one — which is how a 403 became a silently
 * blank terminal card. The diagnosis is a probe of the PUBLIC /api/auth/status
 * route rather than a preflight of the stream itself: asking what this
 * credential is worth costs one open GET and touches no attach bookkeeping,
 * whereas re-opening the stream to read its status would attach and detach a
 * viewer as a side effect of drawing an error message.
 */
export type StreamFailureAction =
  | { action: 'ignore' }
  | { action: 'report'; scope: AuthScope; message: string }
  | { action: 'notice'; notice: StreamNotice }

export function diagnoseStreamFailure(input: {
  /** Did this stream ever deliver anything? */
  opened: boolean
  /** Result of the auth probe, or null when the probe itself failed. */
  scope: AuthScope | null
}): StreamFailureAction {
  // A stream that worked and then dropped is a network event, not an auth
  // one. EventSource reconnects on its own; shouting about it would put an
  // error on every card each time the phone changes cell tower.
  if (input.opened) return { action: 'ignore' }

  if (input.scope === 'none') {
    return { action: 'report', scope: 'none', message: 'This device is not paired.' }
  }
  if (input.scope === 'read-only') {
    return {
      action: 'notice',
      notice: {
        kind: 'scope',
        message: 'Live output is outside this device’s scope — it is paired read-only.'
      }
    }
  }
  // Authorized, or the probe itself failed: either way this is not something
  // the user can fix by pairing, so it stays on the card.
  return {
    action: 'notice',
    notice: {
      kind: 'unavailable',
      message: 'Live output is unavailable — the stream was refused. Reopen the card to retry.'
    }
  }
}
