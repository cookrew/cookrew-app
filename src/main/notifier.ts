/**
 * DESKTOP NOTIFICATIONS FOR WHAT NEEDS YOU (owner, 2026-11-16: "三端通知",
 * notify on "等你 + 回复"; plan docs/hitl-cross-workspace-2026-11-15 · v6.2
 * phase 3). Two moments become a system notification:
 *
 *   waiting   an agent waits on you          "Atlas needs you"
 *   reply     it replied, and it is unread    "Atlas replied"
 *
 * index.ts decides the moments (waiting-latch.ts, hitl-moments.ts); this
 * decides what is shown. Quiet while the window has focus (the HITL bar and the
 * chime are there) and for a served (customer's) workspace. Names only, never
 * a reply or a prompt. One notification per agent, the newest; it comes down
 * once the wait is answered or the reply read (settle), wherever that was.
 * Past BURST_SIZE agents in a minute, one notification says how many, and it
 * keeps counting until the window takes focus. Silent: the chime is the sound.
 *
 * Pure: the shell (index.ts) supplies Electron's Notification and the facts.
 */

export const BURST_SIZE = 3
export const BURST_WINDOW_MS = 60_000

export interface MomentNote {
  readonly kind: 'waiting' | 'reply'
  readonly agentId: string
  readonly name: string
  readonly workspaceId: string
  readonly workspaceName: string
}

export interface ShownNote {
  /** One per agent (`agent:<id>`), or the burst's own. */
  readonly key: string
  readonly title: string
  readonly body: string
  /** Where a click goes; null for the burst, which only brings the window up. */
  readonly agentId: string | null
  readonly workspaceId: string | null
  /** A wait, or a burst of them: a phone push is sent high urgency (phone-push.ts). */
  readonly urgent: boolean
}

export interface NoteHandle {
  close: () => void
}

export interface NotifierDeps {
  show: (note: ShownNote) => NoteHandle
  focused: () => boolean
  enabled: () => boolean
  served: (workspaceId: string) => boolean
  now: () => number
}

const BURST_KEY = 'burst'
const keyOf = (agentId: string): string => `agent:${agentId}`

export function createNotifier(deps: NotifierDeps): {
  notify: (moment: MomentNote) => void
  /** That agent's wait was answered, or its reply read: its notification comes down. */
  settle: (agentId: string) => void
  /** Take every notification down (the window took focus: the bar holds them). */
  clear: () => void
} {
  let open: ReadonlyMap<string, NoteHandle> = new Map()
  /** agent → when it was last notified, for the burst count. */
  let recent: ReadonlyMap<string, number> = new Map()
  /** The agents the burst's notification counts, until the window takes focus. */
  let folded: ReadonlySet<string> = new Set()

  const close = (key: string): void => {
    const handle = open.get(key)
    if (!handle) return
    open = new Map([...open].filter(([k]) => k !== key))
    try {
      handle.close()
    } catch {
      // Already gone from the notification centre.
    }
  }
  const show = (note: ShownNote): void => {
    close(note.key)
    try {
      open = new Map([...open, [note.key, deps.show(note)]])
    } catch (error) {
      console.error('A notification could not be shown:', error)
    }
  }

  return {
    notify(m) {
      if (!deps.enabled() || deps.focused() || deps.served(m.workspaceId)) return
      const now = deps.now()
      recent = new Map([...[...recent].filter(([, at]) => now - at < BURST_WINDOW_MS), [m.agentId, now]])
      if (folded.size === 0 && recent.size <= BURST_SIZE) {
        const title = m.kind === 'waiting' ? `${m.name} needs you` : `${m.name} replied`
        return show({ key: keyOf(m.agentId), title, body: `in ${m.workspaceName}`, agentId: m.agentId, workspaceId: m.workspaceId, urgent: m.kind === 'waiting' })
      }
      // A burst: the single ones come down, and one counts them until the window takes focus.
      const count = new Set([...folded, ...recent.keys()])
      for (const key of [...open.keys()]) if (key !== BURST_KEY) close(key)
      if (count.size === folded.size && open.has(BURST_KEY)) return
      folded = count
      show({ key: BURST_KEY, title: `${count.size} agents need you`, body: 'Open Cookrew to see them in the bar', agentId: null, workspaceId: null, urgent: true })
    },
    settle(agentId) {
      close(keyOf(agentId))
    },
    clear() {
      for (const key of [...open.keys()]) close(key)
      recent = new Map()
      folded = new Set()
    }
  }
}
