import { useEffect, useState } from 'react'
import { cookrew } from './api'
import { hasLatestPush, subscribeLatestChanged } from './latest-changed-bus'
import type { LatestCheckpoint } from './turn-view-model'

/**
 * The latest checkpoint for MANY agents at once — the Board's half of
 * trace-perf T1. One card asks with useLatestCheckpoint; the Board asks for
 * every idle agent in the loaded workspace in one hook, so a row with nothing
 * tracked shows the agent's last turn instead of folding into QUIET.
 *
 * Same freshness as the card (T4): the host's file-watch push when there is
 * one, a slow poll as the backstop, and the phone's faster poll where there is
 * no push. Same cost: the read is a stat-guarded tail, so a poll over twenty
 * idle agents is twenty stats.
 *
 * `ids` is read by VALUE: the Board recomputes the list on every render, and
 * keying the effect on the array identity would tear every watch down four
 * times a second while an agent works.
 */
const PUSH_BACKSTOP_MS = 10000
const POLL_ONLY_MS = 3000

export function useLatestCheckpoints(
  ids: readonly string[],
): Record<string, LatestCheckpoint | null> {
  const [checkpoints, setCheckpoints] = useState<Record<string, LatestCheckpoint | null>>({})
  const key = ids.join('\n')

  useEffect(() => {
    const wanted = key.length === 0 ? [] : key.split('\n')
    const api = cookrew()
    const fetch = api.latestCheckpoint
    // An id that left the set must not keep showing a stale turn on its row.
    setCheckpoints((prior) => {
      const keep = Object.fromEntries(
        wanted.filter((id) => id in prior).map((id) => [id, prior[id]]),
      )
      return Object.keys(keep).length === Object.keys(prior).length ? prior : keep
    })
    if (!fetch || wanted.length === 0) return

    let cancelled = false
    const readOne = async (id: string): Promise<void> => {
      if (document.hidden) return
      try {
        const cp = await fetch(id)
        if (cancelled) return
        // Rows compare by reference; only re-render when a checkpoint changed.
        setCheckpoints((prior) => (prior[id] === cp ? prior : { ...prior, [id]: cp }))
      } catch {
        // A transient miss keeps the last good value until the next tick.
      }
    }
    const readAll = (): void => {
      for (const id of wanted) void readOne(id)
    }

    readAll()

    const hasPush = hasLatestPush()
    const offPush: (() => void)[] = []
    if (hasPush) {
      for (const id of wanted) {
        void api.watchLatest?.(id)
        offPush.push(subscribeLatestChanged(id, () => void readOne(id)))
      }
    }
    const timer = window.setInterval(readAll, hasPush ? PUSH_BACKSTOP_MS : POLL_ONLY_MS)
    const onVisible = (): void => {
      if (!document.hidden) readAll()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      for (const off of offPush) off()
      if (hasPush) for (const id of wanted) void api.unwatchLatest?.(id)
    }
  }, [key])

  return checkpoints
}
