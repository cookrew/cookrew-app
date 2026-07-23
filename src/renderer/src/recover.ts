import type { RecoverResult } from '../../shared/model'

/**
 * Agent-recover UI logic (agent-recover-feature-design, backend live @4e5cf65).
 * Pure: eligibility for the roster RECOVER button and the result → toast
 * mapping, with the toast copy VERBATIM from the landed contract. JSX-free so
 * both are unit-tested under the node tsconfig.
 */

/** What a recover attempt shows the user. Fresco tints by tone. */
export interface RecoverToast {
  tone: 'ok' | 'defer' | 'warn' | 'error'
  text: string
}

/**
 * A roster row gets the one-tap RECOVER button when its registry entry is
 * INACTIVE (contract: `active === false` — killed/dismissed/exited). Whether a
 * full kill-snapshot exists is resolved server-side at recover time and
 * surfaced via the result's `legacy` flag, so eligibility needs no other field.
 */
export function recoverEligible(entry: { active: boolean }): boolean {
  return entry.active === false
}

/**
 * RecoverResult → toast, copy per the contract note:
 *   spawned=true  → "Recovered {name}"
 *   spawned=false → "Recovered {name} into {workspaceName} — resumes when that
 *                    workspace opens"                       (deferred boot)
 *   legacy=true   → "Recovered {name} (best-effort — pre-snapshot kill,
 *                    session may start fresh)"
 * Legacy outranks the defer copy when both apply (one toast, the stronger
 * caveat). A non-ok result is an honest error, never a success toast.
 */
export function recoverToastFor(result: RecoverResult): RecoverToast {
  if (!result.ok) return recoverErrorToast(`could not recover ${result.name || result.id}`)
  if (result.legacy) {
    return {
      tone: 'warn',
      text: `Recovered ${result.name} (best-effort — pre-snapshot kill, session may start fresh)`
    }
  }
  if (!result.spawned) {
    return {
      tone: 'defer',
      text: `Recovered ${result.name} into ${result.workspaceName} — resumes when that workspace opens`
    }
  }
  return { tone: 'ok', text: `Recovered ${result.name}` }
}

/** A rejected recover call (IPC throw / HTTP 4xx-5xx) → error toast. */
export function recoverErrorToast(message: string): RecoverToast {
  return { tone: 'error', text: `Recover failed — ${message}` }
}
