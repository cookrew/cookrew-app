/**
 * TURNING THE SWITCH ON TAKES SOMEONE AT THE MAC, not something that can press the
 * window. `cookrew ui click` is real input in the owner's window, so the owner-only
 * check passes for an agent as well, and a switch that outlives a restart makes that
 * matter. A finger on the sensor cannot be synthesised. With no sensor (a closed lid,
 * an older Mac) a system dialog is out of reach of window input, though not of a
 * process with Accessibility: the weaker of the two, and the only one there is.
 *
 * Refused means no. There is no second way past a cancelled finger, or an agent could
 * cancel it and click the fallback.
 */

export interface SwitchConfirmDeps {
  canTouch(): boolean
  /** Resolves on a match, rejects on anything else. */
  touch(): Promise<void>
  /** True when the person agreed. */
  ask(): Promise<boolean>
}

/** One prompt at a time: an agent pressing the window must not stack them up. */
export function singleConfirm(deps: SwitchConfirmDeps): () => Promise<boolean> {
  let asking = false
  return async () => {
    if (asking) return false
    asking = true
    try {
      return await confirmSwitchOn(deps)
    } finally {
      asking = false
    }
  }
}

export async function confirmSwitchOn(deps: SwitchConfirmDeps): Promise<boolean> {
  if (!deps.canTouch()) return deps.ask()
  try {
    await deps.touch()
    return true
  } catch {
    return false
  }
}
