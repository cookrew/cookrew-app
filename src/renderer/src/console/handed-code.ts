/**
 * THE UNLOCK CODE, FROM A MACHINE'S OWN SCREEN TO THE CONSOLE.
 *
 * Unlocking a machine's screen from afar goes through a sealed session the
 * relay cannot read (path/seal-client.ts), keyed by a code that has to reach
 * this browser without ever passing the relay. A machine of an account draws
 * it on its OWN screen, in the fragment of its console link:
 *
 *   <console>/d/<machine>#code=<code>
 *
 * A fragment is sent to no server, the console's static host included. The
 * code is not a way in: signing in, the gate and the machine's own door all
 * still stand between whoever scanned the link and the machine.
 *
 * It is taken off the address at once, kept for this tab only (it has to
 * survive the trip to the sign-in page and back), and filed under its machine
 * at the moment that machine is entered, where the unlock sheet looks for it
 * (auth-gate.ts · connectCode).
 */
import { connectCodeFromFragment, nextCodeKey } from '../pairing-scope'
import type { ConsoleRoute } from './console-route'
import type { KeyValue } from './console-session'

export const HANDED_CODE_KEY = 'cr_console_code'

/** Read the code off the address the page was opened at. True when one was taken. */
export function takeHandedCode(input: { hash: string; route: ConsoleRoute; pending: KeyValue }): boolean {
  if (input.route.kind !== 'machine') return false
  const code = connectCodeFromFragment(input.hash)
  if (code === null) return false
  try {
    input.pending.setItem(HANDED_CODE_KEY, JSON.stringify({ machine: input.route.machine, code }))
  } catch {
    return false
  }
  return true
}

/** The machine it was handed for is being entered: file it where that machine's unlock sheet looks. */
export function landHandedCode(input: { machineId: string; pending: KeyValue; kept: KeyValue; keyFor: (machineId: string) => string | null }): void {
  let held: { machine?: unknown; code?: unknown } | null = null
  try {
    held = JSON.parse(input.pending.getItem(HANDED_CODE_KEY) ?? 'null') as { machine?: unknown; code?: unknown } | null
  } catch {
    held = null
  }
  if (held === null || held.machine !== input.machineId || typeof held.code !== 'string') return
  const key = input.keyFor(input.machineId)
  if (key === null) return
  try {
    // NEVER IN PLACE OF ONE ALREADY HELD: a link is something anybody can make. The handed one
    // waits beside it and is tried if the machine refuses the held one (pairing-scope.ts · takeNextCode).
    const already = input.kept.getItem(key)
    if (already === null) input.kept.setItem(key, held.code)
    else if (already !== held.code) input.kept.setItem(nextCodeKey(key), held.code)
    input.pending.removeItem(HANDED_CODE_KEY)
  } catch {
    // Storage that refuses keeps nothing: the unlock sheet asks for the code.
  }
}

/** Signed out: a code still waiting in this tab is nobody's. */
export function forgetHandedCode(pending: KeyValue): void {
  try {
    pending.removeItem(HANDED_CODE_KEY)
  } catch {
    // Nothing held.
  }
}
