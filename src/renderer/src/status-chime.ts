import type { TerminalActivity, TurnPhase } from '../../shared/turn'

/**
 * WHEN AN AGENT RINGS (2026-11-01, the owner: "a little sound for done,
 * needs-you and the states that matter"). Two moments are worth turning a
 * head for, the two the ink face marks in red:
 *
 *  - done: a turn that was working ends with a reply (thinking → replied);
 *  - waiting: the agent stopped on a question or a permission prompt.
 *
 * Everything else is quiet. An agent seen for the first time never rings
 * (the boot snapshot, a reconnect, a new workspace), a short exchange the
 * owner watched arrive does not ring for done, and an agent flapping in and
 * out of a state rings once per REPEAT window, not per flap.
 *
 * Pure: the shell (chime-sound.ts) feeds it the activity map and plays what
 * it returns, so every rule here is tested without audio or a clock.
 */
export type ChimeKind = 'done' | 'waiting'

/** A reply that took less than this was watched arriving; it does not ring. */
export const MIN_WORK_MS = 5_000
/** One agent rings the same kind at most once in this window (flapping detectors). */
export const REPEAT_MS = 20_000

interface Seen {
  readonly phase: TurnPhase
  /** When the current turn started working; null outside a turn. */
  readonly turnStart: number | null
  readonly rang: Readonly<Partial<Record<ChimeKind, number>>>
}

export type ChimeMemory = ReadonlyMap<string, Seen>

export const EMPTY_CHIME_MEMORY: ChimeMemory = new Map()

const inTurn = (phase: TurnPhase): boolean => phase === 'thinking' || phase === 'waiting'

function kindOf(before: Seen, phase: TurnPhase, now: number): ChimeKind | null {
  if (phase === 'waiting' && before.phase !== 'waiting') return 'waiting'
  if (phase !== 'replied' || !inTurn(before.phase)) return null
  const worked = before.turnStart === null ? 0 : now - before.turnStart
  return worked >= MIN_WORK_MS ? 'done' : null
}

function firstSight(phase: TurnPhase, now: number): Seen {
  return { phase, turnStart: inTurn(phase) ? now : null, rang: {} }
}

function advance(before: Seen, phase: TurnPhase, now: number): { seen: Seen; chime: ChimeKind | null } {
  if (before.phase === phase) return { seen: before, chime: null }
  const turnStart = inTurn(phase) ? (before.turnStart ?? now) : null
  const kind = kindOf(before, phase, now)
  const last = kind === null ? undefined : before.rang[kind]
  const chime = kind !== null && (last === undefined || now - last >= REPEAT_MS) ? kind : null
  const rang = chime === null ? before.rang : { ...before.rang, [chime]: now }
  return { seen: { phase, turnStart, rang }, chime }
}

/**
 * One step: the activity map as it is now against what was seen before.
 * Returns the next memory and the chimes due, one entry per agent that rang.
 * Agents gone from the map are forgotten, so they come back as first sights.
 */
export function stepChimes(
  memory: ChimeMemory,
  activities: Readonly<Record<string, TerminalActivity>>,
  now: number
): { memory: ChimeMemory; chimes: readonly ChimeKind[] } {
  const chimes: ChimeKind[] = []
  const next = new Map<string, Seen>()
  for (const [id, activity] of Object.entries(activities)) {
    if (!activity.agent) continue
    const before = memory.get(id)
    if (before === undefined) {
      next.set(id, firstSight(activity.phase, now))
      continue
    }
    const { seen, chime } = advance(before, activity.phase, now)
    next.set(id, seen)
    if (chime !== null) chimes.push(chime)
  }
  return { memory: next, chimes }
}

/** Many agents at once ring once: needs-you outranks done. */
export function chimeToPlay(chimes: readonly ChimeKind[]): ChimeKind | null {
  if (chimes.includes('waiting')) return 'waiting'
  return chimes.length > 0 ? 'done' : null
}
