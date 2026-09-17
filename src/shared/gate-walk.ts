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
 * TWO DOORS, ONE WALK (identity v3, G1–G3).
 *   • install — a team the directory LISTS: identify → seat → [pay] → open.
 *     Identity is the Cookrew account; the seat is the registry's 403 rung
 *     (a paid team admits seated accounts only); the pay step is the door's
 *     402 at session start. Seat and pay are ALWAYS present on this door: when
 *     the team is free they are `skip` (dashed), because a sheet that hid them
 *     would be lying about what it did not ask.
 *   • direct — a door the directory does NOT list (a Mac on this Wi-Fi, an
 *     unpublished team): identify → [pay] → open. Identity is this Mac's own
 *     caller key and nothing follows you elsewhere, so there is no seat slot
 *     at all — no registry is involved and none could seat anybody. The pay
 *     slot stays: a dialled paid door still charges at its own 402.
 *
 * The old `call` door (the six-word ceremony) is gone with the ceremony: it had
 * no mount in the renderer and nobody could walk it.
 */

/**
 * The one 403 the buyer can clear — an exhausted prepaid balance (R11). It
 * wears amber, not rose, and its glyph and band both key on this literal, so it
 * lives here as the single source both the model and the copy resolver read.
 */
export const CREDIT_DENIAL = 'balance_empty'

/**
 * The registry's seat rung, as a denial reason. Unlike every other 403 it is a
 * PLACE ON THE RAIL: the walk lights the seat step rather than leaving the
 * rail, because the person is one purchase (or one grant) from continuing.
 */
export const SEAT_DENIAL = 'no_seat'

/** Which door the caller came through — it decides the shape of the walk. */
export type GateDoor = 'install' | 'direct'

/** The four step slots, in the gate's own order. */
export type StepId = 'identify' | 'seat' | 'pay' | 'open'

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
 * balance you can top up, per R11. `403-seat` is the seat rung, amber too:
 * a seat is a thing to buy, not a stop.
 */
export type BandVariant = '401' | '402' | '403' | '403-credit' | '403-seat' | 'open'

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
 * The pricing the door carries in. `null` means free — the pay step (and, on
 * the install door, the seat step) still appears, as a `skip`.
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
  /** The door's price; null when free. */
  pricing?: WalkPricing | null
  /** The version you leave with — the violet pin mark. e.g. 'V4'. */
  pin?: string | null
}

/**
 * The render model. A happy-path scene is a `walk` (the rail); a refusal is its
 * own kind because the design draws it as bands without a rail — a 403 is not a
 * place on the journey, it is the journey stopping. The seat rung is the one
 * exception, and it comes back as a `walk` with the seat step live.
 */
export type GateWalk =
  | { kind: 'walk'; door: GateDoor; steps: WalkStep[]; pin: string | null }
  | { kind: 'denied'; reason: string; retryable: boolean; band: BandVariant }
  | { kind: 'gone' }
  | { kind: 'error'; status: number }

/**
 * WHICH DOOR — the one decision the install path and the direct path split on.
 *
 * Listed means the address is a published name (`@handle/team`) AND the
 * directory resolved it (GET /v1/doors/@handle/team answered with a door
 * record). Both halves matter: a dialled address has no name for a registry
 * to know, and a name the directory does not answer for is not a team anyone
 * can be seated at. Everything else is DIRECT — this Mac's own key, no
 * account, no seat.
 *
 * Pure, so the desktop sheet and the phone's gate verb cannot disagree about
 * which walk an address takes.
 */
export function gateDoorFor(
  target: { door?: string | null },
  directory: { listed: boolean } | null
): GateDoor {
  return typeof target.door === 'string' && target.door.length > 0 && directory?.listed === true
    ? 'install'
    : 'direct'
}

/** The slots a door carries, in the gate's own order. */
function stepOrder(door: GateDoor): StepId[] {
  return door === 'install' ? ['identify', 'seat', 'pay', 'open'] : ['identify', 'pay', 'open']
}

/** Is the pay step a real step here, or a dashed one? Free doors skip it. */
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
    case 'seat':
      return '403-seat'
    case 'pay':
      return '402'
    case 'open':
      return 'open'
  }
}

/**
 * The state of each step on the happy path, given which step is live. A step
 * before the live one is `done`; the seat and pay steps are `skip` when the
 * door is free regardless of where we are — a free team demands neither, and
 * the registry's seat rung admits without a seat there; the open step is
 * `now` only when served.
 */
function walkSteps(door: GateDoor, live: StepId, pricing: WalkPricing | null | undefined): WalkStep[] {
  const order = stepOrder(door)
  const liveIndex = order.indexOf(live)

  return order.map((id, index): WalkStep => {
    // The live step is never dashed: if the gate is asking, it was demanded,
    // whatever the price line said.
    if ((id === 'pay' || id === 'seat') && payIsSkipped(pricing) && index !== liveIndex) {
      return { id, state: 'skip', band: null }
    }
    const state: StepState = index < liveIndex ? 'done' : index === liveIndex ? 'now' : 'todo'
    return { id, state, band: bandFor(id, state) }
  })
}

/**
 * Derive the sheet's render model from one scene. Total over the phase: every
 * phase maps to exactly one model, and a refusal is never a rail step — except
 * the seat rung, which is the rail's own third slot lighting up.
 */
export function gateWalk(scene: GateScene): GateWalk {
  const { door, phase, pricing = null, pin = null } = scene

  switch (phase.kind) {
    case 'identify':
      return { kind: 'walk', door, steps: walkSteps(door, 'identify', pricing), pin }

    case 'pay':
      return { kind: 'walk', door, steps: walkSteps(door, 'pay', pricing), pin }

    case 'open':
      return { kind: 'walk', door, steps: walkSteps(door, 'open', pricing), pin }

    case 'denied':
      // The seat rung is answered on the rail, but only where a seat can exist.
      // A direct door has no registry to seat anyone, so `no_seat` from one is
      // a refusal like any other rather than a slot the rail has no room for.
      if (phase.reason === SEAT_DENIAL && door === 'install') {
        return { kind: 'walk', door, steps: walkSteps(door, 'seat', pricing), pin }
      }
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
 * the identify state (proving identity, whichever door).
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
