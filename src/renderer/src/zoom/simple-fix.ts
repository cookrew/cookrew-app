import { useSyncExternalStore } from 'react'
import { activityStore } from '../activity-thumb-store'
import type { AccessSimpleAnswer } from '../../../shared/agent-access'
import type { TerminalActivity } from '../../../shared/turn'

/**
 * A PRESS OF "USE SIMPLE MODE", KEPT OUTSIDE THE CARD THAT TOOK IT (box round 3, N10).
 *
 * The press restarts the agent, and a restart goes through the card: the new pane is
 * blank, so the refusal leaves it and the card's words unmount, then the refusal comes
 * back in other words on a new mount. Progress held in the component died there, and
 * the answer landed on a dead instance. What came back was idle with nothing to offer,
 * since simple mode was by then on: the button gone and no word about it.
 *
 * So the press lives here, with the words it was made on, until a turn somebody asked
 * for starts. A spinner in the new pane's boot output is not one (the tracker's
 * phantom), and ending on it would bring all of the above back.
 * A renderer reload still forgets it: the fix itself is saved, only the sentence goes.
 */

export type SimpleFixState = 'working' | 'done' | 'saved' | 'failed'

export interface SimpleFix {
  readonly state: SimpleFixState
  /** The refusal it answers, as it read when pressed. */
  readonly raw: string
}

export interface SimpleFixDeps {
  /** A turn somebody asked for is under way on this card. */
  turnStarted: (terminalId: string) => boolean
  /** Calls back when any agent's activity changes; returns how to stop. */
  watch: (changed: () => void) => () => void
}

export interface SimpleFixes {
  get: (terminalId: string) => SimpleFix | null
  subscribe: (listener: () => void) => () => void
  press: (terminalId: string, raw: string, send: () => Promise<AccessSimpleAnswer>) => Promise<void>
  forget: (terminalId: string) => void
}

/** A card with no mirror reports only a phase, straight to `waiting` sometimes, so its word is taken. */
export function askedTurn(activity: TerminalActivity | undefined): boolean {
  if (activity?.phase !== 'thinking' && activity?.phase !== 'waiting') return false
  return activity.asked === true || activity.mirrorless === true
}

const stateOf = (answer: AccessSimpleAnswer): SimpleFixState => (!answer.ok ? 'failed' : answer.restarted ? 'done' : 'saved')

export function createSimpleFixes({ turnStarted, watch }: SimpleFixDeps): SimpleFixes {
  let fixes: ReadonlyMap<string, SimpleFix> = new Map()
  // Private and mutable, as a store's listeners are: every card subscribes.
  const listeners = new Set<() => void>()
  let stopWatching: (() => void) | null = null

  const tell = (): void => {
    for (const listener of listeners) listener()
  }
  /** The turn the words were asking for. */
  const nextTurnStarted = (): void => {
    const over = [...fixes].filter(([id, fix]) => fix.state !== 'working' && turnStarted(id))
    for (const [id] of over) forget(id)
  }
  const put = (terminalId: string, fix: SimpleFix): void => {
    fixes = new Map([...fixes, [terminalId, fix]])
    stopWatching ??= watch(nextTurnStarted)
    tell()
  }
  const forget = (terminalId: string): void => {
    if (!fixes.has(terminalId)) return
    fixes = new Map([...fixes].filter(([id]) => id !== terminalId))
    if (fixes.size === 0) {
      stopWatching?.()
      stopWatching = null
    }
    tell()
  }

  return {
    get: (terminalId) => fixes.get(terminalId) ?? null,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    press: async (terminalId, raw, send) => {
      if (fixes.get(terminalId)?.state === 'working') return
      put(terminalId, { state: 'working', raw })
      const state = await send().then(stateOf, (): SimpleFixState => 'failed')
      put(terminalId, { state, raw })
    },
    forget
  }
}

export const simpleFixes = createSimpleFixes({
  turnStarted: (terminalId) => askedTurn(activityStore.get(terminalId)),
  watch: (changed) => activityStore.subscribeGlobal(changed)
})

export function useSimpleFix(terminalId: string): SimpleFix | null {
  const read = (): SimpleFix | null => simpleFixes.get(terminalId)
  return useSyncExternalStore(simpleFixes.subscribe, read, read)
}
