import { isHarnessId, type HarnessId } from './harness-catalog'

// WHAT THE RENDERER DOES DIFFERENTLY PER HARNESS (harness-integration-contract
// rule 9): one table per behaviour, every harness named. The renderer knows a
// card's harness from its command (harness-catalog harnessOfCommand) or from
// the fleet row, never from a name test of its own.

/**
 * Whether a send from the prompt box clears the agent's input line and pastes
 * the whole text again (prompt/live-line.ts). Codex's editor keeps a draft the
 * live line cannot see, so typing onto it truncated the prompt; the others
 * take typed keys as they arrive.
 */
export const LINE_REBUILT_ON_SEND: Readonly<Record<HarnessId, boolean>> = {
  claude: false,
  codex: true,
  opencode: false,
  pi: false,
  agy: false
}

/**
 * Whether the model dial merges the gateway's catalog into the harness's own
 * models (owner 2026-11-04: one MDL dial for model and route alike). Only a
 * harness whose model pick main can turn into a route pick (claude-model-route.ts)
 * may merge; the others keep the route on its own RTE dial.
 */
export const GATEWAY_MODELS_IN_TUNE: Readonly<Record<HarnessId, boolean>> = {
  claude: true,
  codex: false,
  opencode: false,
  pi: false,
  agy: false
}

/** Table lookup for a value that may not be a harness (a shell, 'other', a wire string, null). */
export function harnessFlag(table: Readonly<Record<HarnessId, boolean>>, id: unknown): boolean {
  return isHarnessId(id) && table[id]
}
