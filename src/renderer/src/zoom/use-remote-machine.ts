import { useCallback, useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import type { RemoteMachineAnswer } from '../../../shared/remote-machine-calls'
import { answered, parseRemoteCards, type RemoteCards } from './remote-machine'

/**
 * ANOTHER MACHINE'S AGENT, READ FOR ITS QUICK-REPLY CARD ON THE DEVICES STOP
 * (RemotePickCard.tsx), and the HITL bar's reads of it (remote-hitl.ts). Inside
 * that machine its own app reads for itself (MachineGuestView.tsx). Every call
 * goes through this machine's main process
 * (main/zoom-fleet.ts · callMachine), which holds the key and checks the call;
 * a surface with no such call (the phone's page) reads nothing.
 *
 * What was last read stays, per machine and workspace, so a machine that stops
 * answering is shown as last seen, and a step back out shows its stop at once.
 */

/** How often the stop on show is read again while it is in front. */
export const REMOTE_CARDS_MS = 3000
/** A thumbnail's picture: a peek at what that machine already has. */
export const REMOTE_PEEK_MS = 10_000

const NOTHING: RemoteMachineAnswer = { status: 0, body: null }

/** One call on the other machine; status 0 when nothing answered, or this surface cannot call. */
export async function callRemote(machineId: string, method: 'GET' | 'POST', route: string, body?: Record<string, unknown>): Promise<RemoteMachineAnswer> {
  const call = cookrew().callMachine
  if (!call) return NOTHING
  try {
    return await call(machineId, method, route, body)
  } catch {
    return NOTHING
  }
}

/** Can this surface go inside another machine at all. */
export const canEnterMachines = (): boolean => typeof cookrew().callMachine === 'function'

/** What was last read for a machine and workspace, and when it landed (this page's clock). */
const lastSeen = new Map<string, { readonly cards: RemoteCards; readonly at: number }>()
const seenKey = (machineId: string, workspaceId: string | null): string => `${machineId}|${workspaceId ?? ''}`

/**
 * Read now, then again every `everyMs` while the page is in front, one read at
 * a time. A new read (another stop, another item) starts at once: a stop just
 * opened must not wait out the last one's timer.
 */
function usePoll(read: (() => Promise<void>) | null, everyMs: number): () => void {
  const busy = useRef(false)
  const current = useRef(read)
  current.current = read
  const once = useCallback(async (): Promise<void> => {
    const run = current.current
    if (!run || busy.current || document.hidden) return
    busy.current = true
    try {
      await run()
    } finally {
      busy.current = false
    }
  }, [])
  useEffect(() => {
    if (!read) return undefined
    // A read still out for the last stop must not hold this one back.
    busy.current = false
    void once()
    const timer = window.setInterval(() => void once(), everyMs)
    const shown = (): void => {
      if (!document.hidden) void once()
    }
    document.addEventListener('visibilitychange', shown)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [read, everyMs, once])
  return useCallback(() => void once(), [once])
}

/** Which machine and workspace the cards on show were read for, and when that read landed. */
export interface RemoteCardsFor {
  readonly machineId: string
  readonly workspaceId: string | null
  readonly at: number
}

export interface RemoteCardsState {
  /** What was last read: kept when the machine stops answering. */
  readonly cards: RemoteCards | null
  /**
   * What `cards` was read for, and when: right after a change of machine or
   * workspace, `cards` is still the last key's, or an earlier visit's kept copy
   * (remote-open.ts settles only on a read of its own key, landed after it asked).
   */
  readonly readFor: RemoteCardsFor | null
  /** False once a read got no answer, until one does. */
  readonly answering: boolean
  /** Read now: after something was sent. */
  readonly refresh: () => void
}

/**
 * WHAT TO ASK FOR, AS THE ZOOM DRAWS IT (bytes 0.6.2; watch-routes.ts ·
 * cardsShapeOf): the tiles alone at its workspaces stop, and a crew in which
 * only the open card carries its whole reply. The grid draws each card's
 * short words; the whole reply was four fifths of a busy crew (85 KB every 3 s
 * of the owner's Mac). A machine before 0.6.2 ignores both and answers whole,
 * which this reads as before.
 */
export function cardsRoute(workspaceId: string | null, openCard: string | null): string {
  if (!workspaceId) return 'api/watch/cards?cards=0'
  return `api/watch/cards?workspace=${encodeURIComponent(workspaceId)}&full=${openCard ? encodeURIComponent(openCard) : 'none'}`
}

/** The machine's tiles (no workspace), or one workspace's whole crew, with the open card's whole reply. */
export function useRemoteCards(machineId: string | null, workspaceId: string | null, openCard: string | null = null): RemoteCardsState {
  const key = machineId ? seenKey(machineId, workspaceId) : null
  const held = (): { cards: RemoteCards; readFor: RemoteCardsFor } | null => {
    const kept = key && machineId ? lastSeen.get(key) : undefined
    return kept && machineId ? { cards: kept.cards, readFor: { machineId, workspaceId, at: kept.at } } : null
  }
  const [shown, setShown] = useState<{ cards: RemoteCards; readFor: RemoteCardsFor } | null>(held)
  const [answering, setAnswering] = useState(true)
  useEffect(() => {
    setShown(held())
    setAnswering(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const read = useCallback(async (): Promise<void> => {
    if (!machineId || !key) return
    const answer = await callRemote(machineId, 'GET', cardsRoute(workspaceId, openCard))
    const read = answer.status === 200 && 'body' in answer ? parseRemoteCards(answer.body) : null
    if (read) {
      const at = Date.now()
      lastSeen.set(key, { cards: read, at })
      setShown({ cards: read, readFor: { machineId, workspaceId, at } })
    }
    setAnswering(read !== null || (answered(answer) && answer.status !== 401))
  }, [machineId, workspaceId, openCard, key])
  const refresh = usePoll(machineId ? read : null, REMOTE_CARDS_MS)
  return { cards: shown?.cards ?? null, readFor: shown?.readFor ?? null, answering, refresh }
}

/** A browser's picture on the other machine, as a data URL; the last one stays while a new one comes. */
export function useRemotePicture(machineId: string, itemId: string | null, width: number, peek: boolean, everyMs: number): { src: string | null; refresh: () => void } {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => setSrc(null), [machineId, itemId])
  const read = useCallback(async (): Promise<void> => {
    if (!itemId) return
    const route = `api/watch/item/${encodeURIComponent(itemId)}/frame?w=${Math.round(width)}${peek ? '&peek=1' : ''}`
    const answer = await callRemote(machineId, 'GET', route)
    if ('picture' in answer) setSrc(`data:${answer.picture.type};base64,${answer.picture.data}`)
  }, [machineId, itemId, width, peek])
  const refresh = usePoll(itemId ? read : null, everyMs)
  return { src, refresh }
}

