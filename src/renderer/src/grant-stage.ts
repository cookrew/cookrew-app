/**
 * Staged ticks, and the sentence the commit button carries (deck §5).
 *
 * NOTHING IS GRANTED UNTIL THE OWNER COMMITS. Ticks accumulate here and are
 * applied in one act, so the dangerous half of this surface is a thing the
 * owner does deliberately rather than a side effect of exploring a list.
 *
 * THE COMMIT CARRIES THE CHANGE, NOT A QUESTION. "GRANT KESTREL 2 AGENTS",
 * with the consequence spelled out underneath in words — "Kestrel will be able
 * to call Tinker and Forge." A confirm that restates the consequence is worth
 * its click; "Are you sure?" is not, because it asks the owner to re-affirm a
 * decision without telling them anything they did not already have.
 *
 * THE DIRECTION OF THE CHANGE IS A FIRST-CLASS FACT, not a detail of the error
 * path. A failed commit means opposite things depending on which way the owner
 * was moving — added access failing is a nuisance, removed access failing is a
 * warning — so the direction is computed here, where the change is known, and
 * handed to the copy rather than guessed at the catch site.
 *
 * NO SELECT-ALL, ANYWHERE IN THIS FILE. There is no operation here that ticks
 * more than one agent, and that absence is the single most important line in
 * the deck: bulk-grant is precisely the accident the whole surface is shaped to
 * prevent. Adding one later would need this comment deleted first.
 */

export interface StagedGrants {
  /** What the record says today. */
  readonly committed: ReadonlySet<string>
  /** What the owner has ticked toward. */
  readonly staged: ReadonlySet<string>
}

export const stageFrom = (committed: readonly string[]): StagedGrants => ({
  committed: new Set(committed),
  staged: new Set(committed)
})

/** Tick or untick ONE agent. The only mutator, deliberately. */
export function toggleAgent(state: StagedGrants, nodeId: string): StagedGrants {
  const staged = new Set(state.staged)
  if (staged.has(nodeId)) staged.delete(nodeId)
  else staged.add(nodeId)
  return { committed: state.committed, staged }
}

export const isStaged = (state: StagedGrants, nodeId: string): boolean => state.staged.has(nodeId)

/** Discard — a staged grant is not a grant (deck §5, step 5). */
export const discard = (state: StagedGrants): StagedGrants => ({
  committed: state.committed,
  staged: new Set(state.committed)
})

export interface StageChange {
  added: readonly string[]
  removed: readonly string[]
  /** True when nothing was ticked — the commit control is not offered. */
  clean: boolean
  /**
   * Which way the owner was moving, for the failure copy.
   *
   * 'remove' wins a mixed change on purpose. If a commit that both added and
   * removed fails, the fact the owner needs first is that somebody still has
   * access they were meant to lose; the reassuring half can wait.
   */
  direction: 'add' | 'remove' | 'none'
}

export function changeOf(state: StagedGrants): StageChange {
  const added = [...state.staged].filter((id) => !state.committed.has(id))
  const removed = [...state.committed].filter((id) => !state.staged.has(id))
  return {
    added,
    removed,
    clean: added.length === 0 && removed.length === 0,
    direction: removed.length > 0 ? 'remove' : added.length > 0 ? 'add' : 'none'
  }
}

/** Join names the way a person would say them: "Tinker and Forge". */
export function speakList(names: readonly string[]): string {
  if (names.length === 0) return 'nothing'
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export interface CommitLabel {
  /** The button. Carries the change, never a question. */
  button: string
  /** Underneath it, in words — the consequence, stated. */
  consequence: string
}

/**
 * What the commit control says, given who is being changed and what to.
 *
 * `nameOf` resolves a node id to the agent's display name, because the
 * consequence sentence is about agents the owner recognises and a terminal id
 * is not one.
 */
export function commitLabel(
  callerName: string,
  state: StagedGrants,
  nameOf: (nodeId: string) => string
): CommitLabel | null {
  const change = changeOf(state)
  if (change.clean) return null

  const total = state.staged.size
  const names = [...state.staged].map(nameOf)

  if (change.added.length > 0 && change.removed.length === 0) {
    return {
      button: `GRANT ${callerName.toUpperCase()} ${total} AGENT${total === 1 ? '' : 'S'}`,
      consequence: `${callerName} will be able to call ${speakList(names)}.`
    }
  }
  if (change.removed.length > 0 && change.added.length === 0) {
    return {
      button:
        total === 0
          ? `REVOKE EVERY AGENT FROM ${callerName.toUpperCase()}`
          : `UPDATE ${callerName.toUpperCase()} TO ${total} AGENT${total === 1 ? '' : 'S'}`,
      consequence:
        total === 0
          ? `${callerName} will not be able to call anything.`
          : `${callerName} will be able to call ${speakList(names)}, and will lose ` +
            `${speakList(change.removed.map(nameOf))}.`
    }
  }
  return {
    button: `UPDATE ${callerName.toUpperCase()} TO ${total} AGENT${total === 1 ? '' : 'S'}`,
    consequence:
      `${callerName} will be able to call ${speakList(names)}, and will lose ` +
      `${speakList(change.removed.map(nameOf))}.`
  }
}

/**
 * WHICH EMPTY STATE THE OWNER IS IN (deck §7).
 *
 * A first-time owner meets this surface knowing nothing, and the three empty
 * states are not interchangeable: one says "you have not opened anything up",
 * one says "nobody can call, and that is the default", and one is a caller who
 * is enrolled but can call nothing. Told the wrong one, the owner looks for a
 * control that is not the next step.
 *
 * A pure function because the ORDER is the teaching — exportable first, because
 * enrolling somebody before any agent is exportable produces a caller with
 * nothing to grant — and an order buried in JSX conditionals is one nobody can
 * check. The panel renders what this returns.
 */
export type GrantEmptyState = 'no-export' | 'no-callers' | 'none'

export function emptyStateFor(input: {
  agents: readonly unknown[]
  callers: readonly unknown[]
}): GrantEmptyState {
  if (input.agents.length === 0) return 'no-export'
  if (input.callers.length === 0) return 'no-callers'
  return 'none'
}
