import { registerScopeState } from './machine-scope'
import { useEffect, useState } from 'react'
import { isUseSignal, useFraction, type UsePoint, type UseSignal } from '../../shared/use-signal'
import { cookrew } from './api'

/**
 * THE AGENTS' CURSORS OVER A CARD (the owner's sketch: several agents at
 * work on one page are several cursors moving on it; idle, each goes home).
 *
 * One feed for the whole app, fed by the bridge (IPC on the desktop, the
 * /api/events stream on a phone), and one small list per card. A cursor is
 * an agent's LAST point on that card: a new action moves it there (the view
 * animates the move), a pointless action (a key, typing) keeps it where it
 * was and pulses it, and after a while with nothing it RETURNS — it heads for
 * the corner the agent's pet lives in and fades, which is the "back to the
 * agent" the sketch draws. Pure where it decides, so it is tested as data.
 */

export const CURSOR_IDLE_MS = 2600
export const CURSOR_RETURN_MS = 700

export interface CardCursor {
  readonly agent: string
  /** Where it is, as fractions of the card's screen (0..1). */
  readonly at: UsePoint
  readonly verb: string
  /** The last action's time — a change here is a pulse. */
  readonly actedAt: number
  /** Set once idle: heading home, gone after CURSOR_RETURN_MS. */
  readonly returningSince: number | null
}

/** Where a cursor with no point yet appears: the pet corner, so its first move reads as leaving the agent. */
export const HOME: UsePoint = { x: 1, y: 1 }

export function admitUse(list: readonly CardCursor[], signal: UseSignal): CardCursor[] {
  const point = useFraction(signal)
  const prev = list.find((c) => c.agent === signal.agent)
  const at = point ?? (prev && prev.returningSince === null ? prev.at : { x: 0.5, y: 0.5 })
  const next: CardCursor = { agent: signal.agent, at, verb: signal.verb, actedAt: signal.at, returningSince: null }
  return [...list.filter((c) => c.agent !== signal.agent), next]
}

/** Idle cursors start home; cursors home long enough are gone. Returns the same array when nothing changed. */
export function ageCursors(list: readonly CardCursor[], now: number): readonly CardCursor[] {
  let changed = false
  const out: CardCursor[] = []
  for (const c of list) {
    if (c.returningSince !== null) {
      if (now - c.returningSince >= CURSOR_RETURN_MS) {
        changed = true
        continue
      }
      out.push(c)
    } else if (now - c.actedAt >= CURSOR_IDLE_MS) {
      changed = true
      out.push({ ...c, at: HOME, returningSince: now })
    } else out.push(c)
  }
  return changed ? out : list
}

type Listener = (signal: UseSignal) => void
const listeners = new Set<Listener>()
let connected: (() => void) | null = null

// Subscribed on ONE machine's stream. Let go of, so the next card to mount
// subscribes on the stream of the machine then in scope.
registerScopeState('use cursors', () => {
  connected?.()
  connected = null
})

function connect(): void {
  if (connected) return
  const bridge = cookrew() as { onUseSignal?: (cb: (signal: unknown) => void) => () => void }
  if (!bridge.onUseSignal) return
  connected = bridge.onUseSignal((raw) => {
    if (!isUseSignal(raw)) return
    for (const listener of listeners) listener(raw)
  })
}

/** The cursors over one card, live. Cards that never see an action cost one listener and no timer. */
export function useCardCursors(card: string): readonly CardCursor[] {
  const [cursors, setCursors] = useState<readonly CardCursor[]>([])
  useEffect(() => {
    connect()
    const listener: Listener = (signal) => {
      if (signal.card !== card) return
      // Stamped on arrival, not by the sender's clock: the phone's and the
      // Mac's clocks need not agree, and ageing compares with this one.
      setCursors((list) => admitUse(list, { ...signal, at: Date.now() }))
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [card])
  const active = cursors.length > 0
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setCursors((list) => ageCursors(list, Date.now())), 200)
    return () => clearInterval(timer)
  }, [active])
  return cursors
}
