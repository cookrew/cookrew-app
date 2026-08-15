/**
 * The v4 gate decision, pure (spec §4: "one gate, one order, deny-by-default").
 * Lives in shared/ because the decision ORDER is a security property both
 * sides must agree on — the wave-B server enforces it, and clients/tests must
 * predict it (a 403 means "don't retry"; a 402 means "pay and retry"). Two
 * implementations would eventually reorder the steps and leak existence or
 * skip settlement under load.
 *
 * ORDER (each step short-circuits the rest):
 *   0  public        — route is open (/auth/status, bootstrap) → 200
 *   1  authenticate  — no/unknown consumer                      → 401
 *                      (before ANY resolution, so existence never leaks —
 *                      eval P1: the gate fires 401 upstream of the 404)
 *   2  authorize     — unclassified route, route ∉ groups, then target
 *                      scope                                   → 403
 *                      (the wall-token-write migration: a KNOWN token
 *                      outside its groups is 403, never 401 — Sol F9.
 *                      Scope FAILS CLOSED (D2a): a scoped consumer on a
 *                      non-observe route whose workspace is unresolvable
 *                      from the path is refused, never vacuously
 *                      unconstrained. observe is exempt — serializer-scoped,
 *                      Sol F7.)
 *   3  throttle      — rate/concurrency caps                    → 429
 *                      (before body-heavy work; validate is schema-level
 *                      and lives in the wiring, it has no status here)
 *   4  settle        — payable operation without funding        → 402
 *                      (payment is a gate outcome, not a system)
 *   5  execute       → 200
 *
 * The module holds no clock, no I/O, no rate state: the wiring evaluates the
 * world (throttled? payable? funded?) and passes the verdicts in `state`.
 */
import type { RouteGroup } from './route-manifest'

export type GateStatus = 200 | 401 | 403 | 429 | 402

export interface GateDecision {
  status: GateStatus
  /**
   * Stable machine token for logs/audit: 'public' | 'ok' | 'unknown-token' |
   * 'unclassified-route' | 'route-not-in-groups' | 'workspace-unresolvable' |
   * 'workspace-out-of-scope' | 'agent-out-of-scope' | 'throttled' |
   * 'payment-required'.
   */
  reason: string
}

/** One row of consumers.json (v4 §4), minus runtime-only fields. */
export interface GateConsumer {
  groups: readonly RouteGroup[]
  /** '*' or a list of exact names / 'prefix-*' globs (e.g. 'homelab-*'). */
  workspaces: '*' | readonly string[]
  /** Absent or '*' = unconstrained (ha-sous reaches any agent in scope). */
  agents?: '*' | readonly string[]
}

export interface GateTarget {
  workspace?: string
  agent?: string
}

export interface GateState {
  throttled?: boolean
  payable?: boolean
  funded?: boolean
}

export interface GateInput {
  /** null = no or unknown token (authentication already failed upstream). */
  consumer: GateConsumer | null
  /** classifyRoute's verdict; null = the route is not in the manifest. */
  route: RouteGroup | null
  target?: GateTarget
  state?: GateState
}

function inScope(scope: '*' | readonly string[] | undefined, value: string | undefined): boolean {
  if (value === undefined || scope === undefined || scope === '*') return true
  return scope.some((pattern) =>
    pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : pattern === value
  )
}

export function gateDecision(input: GateInput): GateDecision {
  const { consumer, route, target, state } = input

  // 0 — public routes pass with or without a token; /auth/status is exactly
  // "does MY token work" and must answer an unpaired device.
  if (route === 'public') return { status: 200, reason: 'public' }

  // 1 — authenticate first, even for routes that do not exist: a 401 reveals
  // nothing about what is behind the gate.
  if (consumer === null) return { status: 401, reason: 'unknown-token' }

  // 2 — authorize: manifest membership, then group, then target scope.
  if (route === null) return { status: 403, reason: 'unclassified-route' }
  if (!consumer.groups.includes(route)) return { status: 403, reason: 'route-not-in-groups' }
  // D2a: fail closed. A body-addressed route names no workspace in the path,
  // so target.workspace is undefined and inScope would pass VACUOUSLY — a
  // workspace-scoped consumer becomes unconstrained (cross-tenant dispatch
  // the day a real token exists). observe is exempt: serializer-scoped reads.
  if (consumer.workspaces !== '*' && route !== 'observe' && target?.workspace === undefined) {
    return { status: 403, reason: 'workspace-unresolvable' }
  }
  if (!inScope(consumer.workspaces, target?.workspace)) {
    return { status: 403, reason: 'workspace-out-of-scope' }
  }
  if (!inScope(consumer.agents, target?.agent)) return { status: 403, reason: 'agent-out-of-scope' }

  // 3 — throttle before settle: never do settlement work under overload.
  if (state?.throttled) return { status: 429, reason: 'throttled' }

  // 4 — settle: valid scope, metered operation, no live balance/receipt.
  if (state?.payable && !state.funded) return { status: 402, reason: 'payment-required' }

  // 5 — execute.
  return { status: 200, reason: 'ok' }
}
