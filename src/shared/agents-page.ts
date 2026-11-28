// THE AGENTS PAGE (harness expansion, 2026-11-28): one row per harness the app
// can run, with everything needed to keep it: what it is, whether it is here
// and signed in, its version, the line a new card starts, where its model is
// kept — and the actions that fix what is wrong. Magpie's own Agents page, for
// Cookrew's harnesses; the routing panel's Harnesses section is the short
// version of it.

import { HARNESS_IDS, type HarnessId } from './harness-catalog'

export interface AgentPageRow {
  id: HarnessId
  name: string
  /** The executable a launch line starts with. */
  bin: string
  /** The dock's launch line for a new card of this harness. */
  command: string
  installed: boolean
  signedIn: boolean | null
  /** `<bin> --version`, when the app could read one; null when not installed or not asked yet. */
  version: string | null
  installLine: string
  loginLine: string | null
  /** Already in the dock's ＋ menu. */
  inDock: boolean
  /** The name `magpie <agent>` takes for this harness, when Magpie knows it (to keep its model there). */
  magpieAgent: string | null
  /** One sentence on what Cookrew adds for this harness, or null. */
  note: string | null
}

/** How Magpie's own Agents page names each harness (`magpie ls`). */
export const MAGPIE_AGENT: Readonly<Record<HarnessId, string | null>> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
  agy: 'agy',
  devin: 'devin',
  dsh: 'dsh',
  alma: 'alma'
}

/** What a person should know about the harness that is not obvious from the row. */
export const AGENT_NOTES: Readonly<Partial<Record<HarnessId, string>>> = {
  agy: 'Starts in accept-edits: edits run, shell commands ask.',
  devin: 'Its card keeps its own Devin config, so Claude settings and hooks never run in it. A new turn after /clear may need Enter pressed twice.',
  dsh: 'Has no terminal of its own: Cookrew runs it through its ACP host (cookrew-acp dsh).',
  alma: 'Runs on the Alma server on this machine (:23001); its threads show in Alma too.',
  pi: 'A wrapper named *-pi (for example qwen-pi) runs as Pi.',
  opencode: 'History is read from the screen: no checkpoint rail.'
}

/** The rows, in catalog order. Split out so a bridge and a test build it the same way. */
export function orderAgentRows<T extends { id: HarnessId }>(rows: readonly T[]): T[] {
  return HARNESS_IDS.flatMap((id) => rows.filter((row) => row.id === id))
}
