/**
 * THE GATE WALK — the render model behind the one Gate Sheet (R28).
 *
 * WHY THIS EXISTS
 * ---------------
 * `decideGate` (shared/gate.ts) answers ONE resource in a fixed order:
 *
 *   exists → public → identity(401) → covers/entitled(403) → priced(402) → serve
 *
 * R28 rules that the user therefore meets ONE sheet that walks that order, and
 * that a step the gate never demands renders DASHED, never hidden. The only way
 * a sheet cannot drift from the protocol is if it is a PICTURE of it — derived,
 * not hand-drawn. This module is that derivation: given what the gate is saying
 * (a phase) and the door the caller came through, it returns the exact rail of
 * steps with their states, and which band each paints. The component renders
 * this and nothing else, so a step it shows and a step the gate demands are the
 * same list by construction.
 *
 * NO PROSE HERE (R14). The model carries structure — which steps, which state,
 * which band variant, the terms, the pin. Every sentence the sheet says is
 * Velvet's, read from shared/marketplace-copy.ts by the component keyed on
 * (door, step id, state). A string baked in here would freeze the wording and
 * make Magpie's fixtures assert copy instead of behaviour.
 *
 * TWO DOORS, ONE WALK.
 *   • install (Door A) — buy/download a copy: identify → [pay] → open. The pay
 *     step is ALWAYS present; when the preset is free it is a `skip` (dashed),
 *     because a sheet that hid it would be lying about what it did not ask.
 *   • call (Door B) — a live line: identify → open. There is no pay slot at all,
 *     by R5 — a call answers 200/403 only and never takes money inline; seat
 *     credit is prepaid at install, so the wallet never interrupts a
 *     conversation and so the rail must not draw a step that cannot occur.
 */

/**
 * The one 403 the buyer can clear — an exhausted prepaid balance (R11). It
 * wears amber, not rose, and its glyph and band both key on this literal, so it
 * lives here as the single source both the model and the copy resolver read.
 */
export const CREDIT_DENIAL = 'balance_empty'

/** Which door the caller came through — it decides the shape of the walk. */
export type GateDoor = 'install' | 'call'

/** The three step slots, in the gate's own order. */
export type StepId = 'identify' | 'pay' | 'open'

/**
 * A step's state on the rail. `skip` is the load-bearing one: a step that never
 * applies here is dashed, distinct from `todo` (ahead of you) and `done`
 * (cleared). The sheet never paints `skip` as `done` — progress you did not make
 * is not progress you made.
 */
export type StepState = 'done' | 'now' | 'todo' | 'skip'

/**
 * Which gate-band a step paints for its headline, or null for none. A band is
 * shown only when the step is `now` (the live form) or `done` (collapsed to a
 * one-line receipt); a `todo` or `skip` step is a tick with no band, so the
 * sheet gets SHORTER as you succeed and never previews a step you have not
 * reached. `403-credit` is the one 403 that wears amber, not rose — a
 * balance you can top up, per R11.
 */
export type BandVariant = '401' | '402' | '403' | '403-credit' | 'open'

export interface WalkStep {
  id: StepId
  state: StepState
  band: BandVariant | null
}

/** The 402 offer, as the sheet needs it to quote terms. Mirrors PaymentTerms. */
export interface WalkTerms {
  price: string
  asset: string
  chain: string
  author: string
  /** Epoch ms the quote expires — the sheet owns the countdown. */
  expiry: number
}

/**
 * The pricing the install door carries in. `null` means free — the pay step
 * still appears, as a `skip`. `call` door pricing is prepaid credit, not an
 * inline charge, so it is never passed here.
 */
export interface WalkPricing {
  model: 'one-time' | 'per-call'
  terms: WalkTerms
}

/**
 * What the gate is currently saying. This is the whole input other than the
 * door: everything the walk shows is a function of the phase, so the sheet
 * cannot show a state the gate is not in.
 */
export type GatePhase =
  | { kind: 'identify' }
  | { kind: 'pay' }
  | { kind: 'open' }
  | { kind: 'denied'; reason: string; retryable: boolean }
  | { kind: 'gone' }
  | { kind: 'error'; status: number }

export interface GateScene {
  door: GateDoor
  phase: GatePhase
  /** Present on the install door; null when free. Absent on the call door. */
  pricing?: WalkPricing | null
  /** The version you leave with — the violet pin mark. e.g. 'V4'. */
  pin?: string | null
}

/**
 * The render model. A happy-path scene is a `walk` (the rail); a refusal is its
 * own kind because the design draws it as bands without a rail — a 403 is not a
 * place on the journey, it is the journey stopping.
 */
export type GateWalk =
  | { kind: 'walk'; door: GateDoor; steps: WalkStep[]; pin: string | null }
  | { kind: 'denied'; reason: string; retryable: boolean; band: BandVariant }
  | { kind: 'gone' }
  | { kind: 'error'; status: number }

/** Does this door carry a pay slot at all? Only the install door can charge. */
function hasPaySlot(door: GateDoor): boolean {
  return door === 'install'
}

/** Is the pay step a real step here, or a dashed one? Free presets skip it. */
function payIsSkipped(pricing: WalkPricing | null | undefined): boolean {
  return pricing === null || pricing === undefined
}

/**
 * The band a step paints given its state. `now` and `done` get their variant;
 * everything else gets none. Kept in one place so the "shorter as you succeed"
 * rule holds for every step identically.
 */
function bandFor(id: StepId, state: StepState): BandVariant | null {
  if (state !== 'now' && state !== 'done') return null
  switch (id) {
    case 'identify':
      return '401'
    case 'pay':
      return '402'
    case 'open':
      return 'open'
  }
}

/**
 * The state of each step on the happy path, given which step is live. The
 * identify step is `done` once we are past it; the pay step is `skip` when free
 * regardless of where we are; the open step is `now` only when served.
 */
function walkSteps(door: GateDoor, live: StepId, pricing: WalkPricing | null | undefined): WalkStep[] {
  const order: StepId[] = hasPaySlot(door) ? ['identify', 'pay', 'open'] : ['identify', 'open']
  const liveIndex = order.indexOf(live)

  return order.map((id, index): WalkStep => {
    if (id === 'pay' && payIsSkipped(pricing)) {
      return { id, state: 'skip', band: null }
    }
    const state: StepState = index < liveIndex ? 'done' : index === liveIndex ? 'now' : 'todo'
    return { id, state, band: bandFor(id, state) }
  })
}

/**
 * Derive the sheet's render model from one scene. Total over the phase: every
 * phase maps to exactly one model, and a refusal is never a rail step.
 */
export function gateWalk(scene: GateScene): GateWalk {
  const { door, phase, pricing = null, pin = null } = scene

  switch (phase.kind) {
    case 'identify':
      return { kind: 'walk', door, steps: walkSteps(door, 'identify', pricing), pin }

    case 'pay':
      // A pay phase on a door with no pay slot is a contradiction the gate
      // cannot produce (R5), so it collapses to identify rather than inventing
      // a step the rail has no room for.
      return {
        kind: 'walk',
        door,
        steps: walkSteps(door, hasPaySlot(door) ? 'pay' : 'identify', pricing),
        pin
      }

    case 'open':
      return { kind: 'walk', door, steps: walkSteps(door, 'open', pricing), pin }

    case 'denied':
      return {
        kind: 'denied',
        reason: phase.reason,
        retryable: phase.retryable,
        band: phase.reason === CREDIT_DENIAL ? '403-credit' : '403'
      }

    case 'gone':
      return { kind: 'gone' }

    case 'error':
      return { kind: 'error', status: phase.status }
  }
}

/**
 * Bridge the download client's per-response `GateStep` (preset-download.ts) to a
 * scene phase, so a caller that already loops the gate can feed the sheet in one
 * call. The step kinds map one-to-one; `ready` is the served state, `enrol` is
 * the identify state (the enrolment ceremony IS proving identity on Door B).
 */
export function phaseFromGateStep(
  step: { kind: string; reason?: string; retryable?: boolean; status?: number }
): GatePhase {
  switch (step.kind) {
    case 'ready':
      return { kind: 'open' }
    case 'enrol':
      return { kind: 'identify' }
    case 'pay':
      return { kind: 'pay' }
    case 'denied':
      return {
        kind: 'denied',
        reason: step.reason ?? 'unknown',
        retryable: step.retryable === true
      }
    case 'gone':
      return { kind: 'gone' }
    default:
      return { kind: 'error', status: step.status ?? 0 }
  }
}
