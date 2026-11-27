// WHAT EACH HARNESS'S LAUNCH LINE GAINS AT SPAWN (harness-integration-contract
// rule 9): the per-process arguments Cookrew adds to the line a card boots,
// after resume and routing are decided. One entry per HarnessId, none hidden
// behind a name test in spawnTracked. Everything added here is rebuilt at
// every spawn, so each harness's stripSessionFlags removes it from a copy.

import type { HarnessId } from '../shared/harness-catalog'
import { agySessionLine } from './agy-bind'
import { codexInlineLine } from './codex-inline'
import { harnessFor } from './harness'

type LaunchLine = (line: string, cwd: string) => string

const AS_IS: LaunchLine = (line) => line

export const LAUNCH_LINE: Readonly<Record<HarnessId, LaunchLine>> = {
  claude: AS_IS,
  // Inline, never on its own alternate screen (codex-inline.ts).
  codex: (line) => codexInlineLine(line),
  opencode: AS_IS,
  pi: AS_IS,
  // The card's folder trusted and inline rendering, for this session only (agy-bind.ts).
  agy: (line, cwd) => agySessionLine(line, cwd)
}

/** The line a card's process is started with, given the line resume and routing produced. */
export function harnessLaunchLine(line: string, cwd: string): string {
  const harness = harnessFor(line)
  return harness ? LAUNCH_LINE[harness.id](line, cwd) : line
}
