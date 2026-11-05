/**
 * THE WORDS AND SHAPES OF A WORKSPACE'S DOOR: what a new one is told before it
 * exists, and what removing one will stop and leave. Shared because the sheet
 * on the desktop, the same sheet on a phone, the CLI and the API all answer
 * from the same check (main/workspace-door.ts).
 */

/** What the check says about a workspace that has not been made yet. */
export interface WorkspaceCheck {
  /** False when the folder cannot be used: nothing may be created. */
  ok: boolean
  /** The name it would be saved under. */
  name: string
  /** The folder it would use, tilde and trailing slash resolved. */
  dir: string
  /** Why it is refused, as a sentence. */
  reason?: string
  /** What the person should know first; none of it stops the create. */
  notes: string[]
  /** Where the sheet opens: never a hidden worktree. */
  suggestedDir: string
}

/** A fork's own worktree and branch, and whether removing them loses nothing. */
export interface WorkspaceFork {
  worktree: string
  branch: string
  /** True only when both are clean: no changes, no commits held nowhere else. */
  removable: boolean
  /** Why they stay, as a sentence, when they are not removable. */
  reason?: string
}

/** What removing a workspace will do, said before it is done. */
export interface WorkspaceRemovePlan {
  id: string
  name: string
  /** The agents that will be stopped, by name. */
  stops: readonly string[]
  /** How many notes and browsers go with the workspace. */
  notes: number
  browsers: number
  /** Folders left on disk, untouched. */
  keeps: readonly string[]
  /** The worktrees this workspace was forked onto: one per repository. */
  forks: readonly WorkspaceFork[]
}

/** A phone wrote from a workspace that was removed: nothing was done. */
export const SEAT_GONE = 'That workspace has been removed. Choose another one.'

/** The marks the icon picker offers; any single short mark is accepted. */
export const WORKSPACE_ICONS = ['🗂', '🚀', '🧪', '🛠', '📚', '🎨', '🌱', '🔒', '⭐', '🐛', '🎮', '🏠'] as const

/** How long an icon may be, in code units: one emoji with its joiners, never a word. */
const ICON_MAX = 16

/** One short mark: emoji sequences pass, words and blanks do not. */
export function isWorkspaceIcon(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const icon = raw.trim()
  if (icon.length === 0 || icon.length > ICON_MAX) return false
  return !/\s/.test(icon) && [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(icon)].length === 1
}

/** "1 agent", "2 agents". */
export const countOf = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** "Shell", "Shell and Conductor", "Shell, Conductor and 3 more". */
export function namesLine(names: readonly string[], shown = 3): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length > shown) return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** A workspace's removal in sentences; `done` says it in the past. */
export function removeLines(plan: WorkspaceRemovePlan, done = false, worktreeGoes = false): string[] {
  const [stop, del, leave, drop] = done ? ['Stopped', 'Deleted', 'Left', 'Removed'] : ['Stops', 'Deletes', 'Leaves', 'Removes']
  const goes = [
    ...(plan.notes > 0 ? [countOf(plan.notes, 'note')] : []),
    ...(plan.browsers > 0 ? [countOf(plan.browsers, 'browser')] : [])
  ]
  const forked = new Set(plan.forks.map((f) => f.worktree))
  const folders = plan.keeps.filter((dir) => !forked.has(dir))
  return [
    plan.stops.length > 0
      ? `${stop} ${countOf(plan.stops.length, 'agent')}: ${namesLine(plan.stops)}.`
      : 'No agents to stop.',
    ...(goes.length > 0 ? [`${del} ${goes.join(' and ')}.`] : []),
    ...(folders.length > 0 ? [`${leave} ${namesLine(folders, 2)} on disk.`] : []),
    ...plan.forks.map((fork) =>
      fork.removable && worktreeGoes
        ? `${drop} worktree ${fork.worktree} and branch ${fork.branch}.`
        : `${leave} worktree ${fork.worktree} and branch ${fork.branch}.${fork.reason ? ` ${fork.reason}` : ''}`
    )
  ]
}
