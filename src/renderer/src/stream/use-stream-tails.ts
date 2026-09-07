// THE LAST TURN OF A CARD, AND OF A WHOLE BOARD (one-stream T3).
//
// This replaces use-latest-checkpoint.ts and use-latest-checkpoints.ts, which
// polled /api/terminal/:id/latest — the fourth of the four reads the old
// design derived the same conversation with. The freshness model is
// unchanged, deliberately: a file-watch PUSH when the host has one, a slow
// poll as the correctness backstop for whatever fs.watch coalesces or drops,
// and the faster poll where there is no push at all (the phone). What changed
// is only WHERE the answer comes from.
//
// WHY A TAIL READ AND NOT useStream. useStream opens a subscription and an
// index page per card; a board of twenty idle agents wants twenty one-line
// previews and nothing else. The transport's `tail` is that one question.
//
// The title comes from the tail's MARK, so a preview and the rail can no
// longer disagree about what a turn is called.

import { useEffect, useRef, useState } from 'react'
import { hasLatestPush, subscribeLatestChanged } from '../latest-changed-bus'
import { cookrew } from '../api'
import { pickStreamTransport } from './use-stream'
import type { StreamTransport } from './stream-transport'
import type { LatestCheckpoint } from '../turn-view-model'

/** With a push, the poll is only the backstop. Without one it IS freshness. */
const PUSH_BACKSTOP_MS = 10_000
const POLL_ONLY_MS = 3000

interface WatchBridge {
  watchLatest?: (terminalId: string) => Promise<void> | void
  unwatchLatest?: (terminalId: string) => Promise<void> | void
}

/** The tail as a preview: the words, plus whatever Sous called them. */
async function previewOf(
  transport: StreamTransport,
  terminalId: string
): Promise<LatestCheckpoint | null> {
  const tail = await transport.tail(terminalId)
  if (tail === null || tail.block === null) return null
  return {
    prompt: tail.block.prompt,
    reply: tail.block.reply,
    ...(tail.marks?.title !== undefined ? { title: tail.marks.title } : {})
  }
}

/**
 * One card's latest checkpoint. `active` gates the whole hook: pass false when
 * a live activity already drives the card, and this stays dark at no cost.
 */
export function useStreamTail(terminalId: string, active: boolean): LatestCheckpoint | null {
  const [checkpoint, setCheckpoint] = useState<LatestCheckpoint | null>(null)
  // The active flag lives in a ref so the interval and the push listener read
  // the latest value without being torn down and rebuilt each time it flips.
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    if (!active) {
      setCheckpoint(null)
      return
    }
    const transport = pickStreamTransport()
    const bridge = cookrew() as unknown as WatchBridge
    let cancelled = false
    const read = async (): Promise<void> => {
      if (document.hidden || !activeRef.current) return
      try {
        const preview = await previewOf(transport, terminalId)
        if (!cancelled) setCheckpoint(preview)
      } catch {
        // A transient read miss must not blank a shown checkpoint; keep the
        // last good one until the next tick succeeds.
      }
    }
    void read()

    const push = hasLatestPush()
    let offPush: (() => void) | undefined
    if (push) {
      void bridge.watchLatest?.(terminalId)
      offPush = subscribeLatestChanged(terminalId, () => void read())
    }
    const timer = window.setInterval(() => void read(), push ? PUSH_BACKSTOP_MS : POLL_ONLY_MS)
    const onVisible = (): void => {
      if (!document.hidden) void read()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      offPush?.()
      if (push) void bridge.unwatchLatest?.(terminalId)
    }
  }, [terminalId, active])

  return checkpoint
}

/**
 * The latest checkpoint for MANY cards at once — the board's half.
 *
 * `ids` is read BY VALUE: the board recomputes the list on every render, and
 * keying the effect on the array identity would tear every watch down four
 * times a second while an agent works.
 */
export function useStreamTails(
  ids: readonly string[]
): Record<string, LatestCheckpoint | null> {
  const [checkpoints, setCheckpoints] = useState<Record<string, LatestCheckpoint | null>>({})
  const key = ids.join('\n')

  useEffect(() => {
    const wanted = key.length === 0 ? [] : key.split('\n')
    // An id that left the set must not keep showing a stale turn on its row.
    setCheckpoints((prior) => {
      const keep = Object.fromEntries(
        wanted.filter((id) => id in prior).map((id) => [id, prior[id]])
      )
      return Object.keys(keep).length === Object.keys(prior).length ? prior : keep
    })
    if (wanted.length === 0) return

    const transport = pickStreamTransport()
    const bridge = cookrew() as unknown as WatchBridge
    let cancelled = false
    const readOne = async (id: string): Promise<void> => {
      if (document.hidden) return
      try {
        const preview = await previewOf(transport, id)
        if (cancelled) return
        // Rows compare by reference; only re-render when one actually moved.
        setCheckpoints((prior) => (same(prior[id], preview) ? prior : { ...prior, [id]: preview }))
      } catch {
        // A transient miss keeps the last good value until the next tick.
      }
    }
    const readAll = (): void => {
      for (const id of wanted) void readOne(id)
    }
    readAll()

    const push = hasLatestPush()
    const offPush: (() => void)[] = []
    if (push) {
      for (const id of wanted) {
        void bridge.watchLatest?.(id)
        offPush.push(subscribeLatestChanged(id, () => void readOne(id)))
      }
    }
    const timer = window.setInterval(readAll, push ? PUSH_BACKSTOP_MS : POLL_ONLY_MS)
    const onVisible = (): void => {
      if (!document.hidden) readAll()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      for (const off of offPush) off()
      if (push) for (const id of wanted) void bridge.unwatchLatest?.(id)
    }
  }, [key])

  return checkpoints
}

/** Two previews are the same when nothing a row renders differs. Compared by
 *  field, because every read builds a new object and reference identity would
 *  re-render the whole board on every tick. */
function same(a: LatestCheckpoint | null | undefined, b: LatestCheckpoint | null): boolean {
  if (a === null || a === undefined || b === null) return (a ?? null) === b
  return a.prompt === b.prompt && a.reply === b.reply && a.title === b.title
}
