// THE CANDIDATES SOUS DECIDES OVER (fix/hp-decide round 2): the fleet as the
// Board and the tracker know it, with NO pane capture per card. `capture` is
// in the dependency set on purpose — it is the function the first cut called
// once per idle same-repo card, and the budget test proves at runtime, with
// a spy, that this builder never touches it.

import type { DecideCandidate } from '../shared/sous-decide'
import type { BoardRow } from '../shared/board'

export interface CandidateTerminal {
  id: string
  name: string
  cwd: string
  role: string | null
  orch?: boolean
  servedSession?: unknown
}

export interface CandidateDeps {
  terminals: () => readonly CandidateTerminal[]
  rowOf: (terminalId: string) => BoardRow | undefined
  ownerOf: (terminalId: string) => string | undefined
  /** The tracker's cached verdict off its own mirror — never a capture. */
  contextFull: (terminalId: string) => boolean
  /** A pane capture. Present so a test can prove it is never called. */
  capture: (terminalId: string) => unknown
}

export function buildCandidates(deps: CandidateDeps): DecideCandidate[] {
  const out: DecideCandidate[] = []
  for (const t of deps.terminals()) {
    const row = deps.rowOf(t.id)
    out.push({
      id: t.id,
      name: t.name,
      workspaceId: deps.ownerOf(t.id) ?? '',
      cwd: t.cwd,
      role: t.role,
      orch: t.orch === true,
      phase: row?.phase ?? 'offline',
      contextFull: deps.contextFull(t.id),
      lastTask: row?.task.title ?? row?.task.summary ?? null,
      lastActivityAt: row?.lastActivityAt ?? 0,
      served: t.servedSession != null
    })
  }
  return out
}
