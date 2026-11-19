/**
 * THE GATE MAGPIE REMOTE ASKS before its forwarder serves or a provider is pointed at it (setup.ts).
 *
 * On macOS it is lane Seatbelt's servedSeatGate (index.ts · seat-ledger.ts): open only while every
 * served seat runs the profile a spawn would write now and no process is left behind in a session
 * sandbox. That profile denies a served seat any loopback port it was not lent, the forwarder's
 * included.
 *
 * Elsewhere there is no Seatbelt profile (sandbox-exec is macOS only) to vouch for a served terminal,
 * and Seatbelt's scan does not run there, so the stricter rule stands: shut while any served terminal
 * is on the canvas. Anything that throws is shut.
 */

export interface MagpieSeatGateDeps {
  readonly platform: NodeJS.Platform
  /** Lane Seatbelt's gate (index.ts · servedSeatGate); asked on macOS only. */
  servedSeatGate(): Promise<{ readonly open: boolean }>
  /** Is any served terminal (or a terminal of a served workspace) on the canvas now? */
  servedOnCanvas(): boolean
}

export function magpieSeatGate(deps: MagpieSeatGateDeps): () => Promise<boolean> {
  return async () => {
    try {
      if (deps.platform === 'darwin') return (await deps.servedSeatGate()).open === true
      return !deps.servedOnCanvas()
    } catch {
      return false
    }
  }
}

export interface ServedSeatHooks<S> {
  /** Lane Seatbelt's ledger: a fresh seat and the profile it started under. */
  record(seat: S): void
  forget(seat: S): void
  /** Magpie remote drops its cached gate answer (setup.ts · seatsChanged). */
  seatsChanged(): void
  /** Runs once, when the session's process exits. */
  onExit(run: () => void): void
}

/**
 * A served session started (relay acceptance 3). A fresh seat goes in the ledger (`seat`); a reattached
 * one is not recorded there (`null`), but Seatbelt's gate still sees its process. Either way Magpie
 * remote asks its gate afresh now and again when the process ends: no answer cached before the seat
 * outlives it.
 */
export function trackServedSeat<S>(seat: S | null, hooks: ServedSeatHooks<S>): void {
  if (seat !== null) hooks.record(seat)
  hooks.seatsChanged()
  hooks.onExit(() => {
    if (seat !== null) hooks.forget(seat)
    hooks.seatsChanged()
  })
}
