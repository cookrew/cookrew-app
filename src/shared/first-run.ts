/**
 * THE FIRST RUN, AS ONE LINE WALKED ONCE.
 *
 *   preflight  the tool check: what this Mac has, and the fix for what it lacks
 *   task       one prompt box: pick a folder, say what the agent should do
 *   phone      the agent is working; its first finished turn offers the phone
 *   second     the phone was offered; a later turn teaches a second agent
 *   closed     nothing here is ever shown again
 *
 * Pure, and shared: main keeps the stage on disk (main/first-run-store.ts) and
 * the renderer draws it. A stage only moves forward, so a late or repeated
 * call cannot raise a screen that was already passed.
 */

export const FIRST_RUN_STAGES = ['preflight', 'task', 'phone', 'second', 'closed'] as const

export type FirstRunStage = (typeof FIRST_RUN_STAGES)[number]

export function isFirstRunStage(value: unknown): value is FirstRunStage {
  return typeof value === 'string' && (FIRST_RUN_STAGES as readonly string[]).includes(value)
}

/** `to` when it is later than `from`; a way back is no move at all. */
export function advancedStage(from: FirstRunStage, to: FirstRunStage): FirstRunStage {
  return FIRST_RUN_STAGES.indexOf(to) > FIRST_RUN_STAGES.indexOf(from) ? to : from
}

export interface OpeningFacts {
  /** What the disk holds; null on the very first read. */
  saved: FirstRunStage | null
  /** Any card in any workspace, or a second workspace. */
  hasContent: boolean
  /** An account, or a handle from before accounts. */
  hasAccount: boolean
  /** The old launch card was closed on this Mac: this person has been here. */
  oldCardClosed: boolean
}

/**
 * WHO IS NEW IS DECIDED ONCE. The saved stage wins from then on, because the
 * run itself makes content: the Setup card and the first agent must not read
 * as "this person was already here".
 */
export function openingStage({ saved, hasContent, hasAccount, oldCardClosed }: OpeningFacts): FirstRunStage {
  if (saved !== null) return saved
  return hasContent || hasAccount || oldCardClosed ? 'closed' : 'preflight'
}
