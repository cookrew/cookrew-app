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
  /** Not a new install, or any card, or a second workspace. */
  hasContent: boolean
  /** An account, or a handle from before accounts. */
  hasAccount: boolean
}

/**
 * WHO IS NEW IS DECIDED ONCE. The saved stage wins from then on, because the
 * run itself makes content: the Setup card and the first agent must not read
 * as "this person was already here".
 */
export function openingStage({ saved, hasContent, hasAccount }: OpeningFacts): FirstRunStage {
  if (saved !== null) return saved
  return hasContent || hasAccount ? 'closed' : 'preflight'
}

/**
 * THE CONDUCTOR WAITS. Every empty workspace used to boot one, on Claude with
 * permissions bypassed, before anything had checked Claude was installed. On a
 * new Mac that is the board's first agent, nobody asked for it, and it would
 * read as this person having been here. It is seeded again past these screens.
 */
export function conductorWaits(stage: FirstRunStage): boolean {
  return stage === 'preflight' || stage === 'task'
}

/** What a held first task is waiting on (first-task.ts). */
export type FirstTaskWait = 'starting' | 'choice' | 'sign-in' | 'consent'

/**
 * A FIRST TASK, UNTIL THE AGENT HAS IT. `holding`: the words are with main and
 * the agent is coming up. `returned`: it never took them, so they go back to the
 * box, with the reason (null when the person called it off).
 */
export type FirstTask =
  | { readonly state: 'holding'; readonly id: string; readonly words: string; readonly harness: string; readonly wait: FirstTaskWait }
  | { readonly state: 'returned'; readonly words: string; readonly why: string | null; readonly id?: string }

export function isFirstTask(value: unknown): value is FirstTask {
  const task = value as Partial<Record<string, unknown>> | null
  if (typeof task !== 'object' || task === null || typeof task.words !== 'string') return false
  if (task.state === 'returned') return task.why === null || typeof task.why === 'string'
  return task.state === 'holding' && typeof task.id === 'string' && typeof task.harness === 'string'
}

/** The screen of an agent that is up and not taking input: what it wants from the person. */
export function waitOfScreen(screen: string): Exclude<FirstTaskWait, 'starting'> {
  if (/bypass permissions mode/i.test(screen)) return 'consent'
  return /log[ -]?in|sign[ -]?in|authenticat/i.test(screen) ? 'sign-in' : 'choice'
}
