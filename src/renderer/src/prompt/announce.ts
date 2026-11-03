import { activityStore, coalesceEvery } from '../activity-thumb-store'
import type { KeyedStore } from '../keyed-store'
import type { TerminalActivity } from '../../../shared/turn'
import { EMPTY_CHIME_MEMORY, stepChimes, type ChimeKind, type ChimeMemory, type Ring } from '../status-chime'

/**
 * SPOKEN REPLIES FOR THE OTHER AGENTS (owner, 2026-11-03): the reply of the
 * agent the box is on is read in full (use-spoken-replies.ts); every other
 * agent is only ANNOUNCED, by name, at the moments the status chime rings
 * (status-chime.ts): it finished, or it needs you. Never its reply.
 *
 * The moments are the chime's own rules, so a short exchange, a boot snapshot
 * or a flapping detector says nothing here either.
 */

const LINES: Record<ChimeKind, (name: string) => string> = {
  done: (name) => `${name} 完成了`,
  waiting: (name) => `${name} 需要你`
}

/** Activity events arrive several a second while agents work; read them at most this often. */
const READ_EVERY_MS = 400

/** What is said for these rings: the box's own agent and unnamed agents say nothing. */
export function announcementsFor(rings: readonly Ring[], boxAgentId: string | null, nameOf: (id: string) => string | undefined): string[] {
  return rings.flatMap((ring) => {
    if (ring.id === boxAgentId) return []
    const name = nameOf(ring.id)?.trim()
    return name ? [LINES[ring.kind](name)] : []
  })
}

export interface AnnouncerOptions {
  /** Spoken replies are on now. The memory steps while off, so turning on never announces the past. */
  readonly isOn: () => boolean
  readonly boxAgentId: () => string | null
  readonly nameOf: (id: string) => string | undefined
  readonly say: (line: string) => void
  readonly store?: KeyedStore<TerminalActivity>
  readonly now?: () => number
}

/** Watches every agent's activity and announces the others' rings. Returns the unsubscribe. */
export function installAnnouncer(options: AnnouncerOptions): () => void {
  const store = options.store ?? activityStore
  const now = options.now ?? Date.now
  let memory: ChimeMemory = EMPTY_CHIME_MEMORY
  const read = (): void => {
    const step = stepChimes(memory, store.getSnapshot(), now())
    memory = step.memory
    if (!options.isOn()) return
    for (const line of announcementsFor(step.rings, options.boxAgentId(), options.nameOf)) options.say(line)
  }
  read()
  return coalesceEvery(READ_EVERY_MS, (cb) => store.subscribeGlobal(cb), read, now)
}
