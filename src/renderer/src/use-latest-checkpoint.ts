import { useEffect, useRef, useState } from 'react'
import { cookrew } from './api'
import { hasLatestPush, subscribeLatestChanged } from './latest-changed-bus'
import type { LatestCheckpoint } from './turn-view-model'

/**
 * Trace-perf T1: the latest checkpoint for a card that has NO live activity —
 * no PTY, never zoomed. Reads it from the session file via a bounded tail read
 * (~1 ms), so a canvas of idle agents shows each one's last turn without a
 * mirror per card.
 *
 * `active` gates the whole hook: pass false when a live `activity` already
 * drives the card (working agent, or one that's been zoomed) — then the rich
 * live TurnView owns the card and this stays dark, costing nothing.
 *
 * Freshness is two-layered (T4): a file-watch PUSH gives near-instant refresh
 * when the host supports it (Electron), and a slow poll is the correctness
 * backstop for whatever fs.watch coalesces or drops — and the only freshness on
 * the phone, which has no push channel. The tail read is µs-cheap and both
 * layers pause when the document is hidden.
 */
const PUSH_BACKSTOP_MS = 10000
const POLL_ONLY_MS = 3000

export function useLatestCheckpoint(
  terminalId: string,
  active: boolean,
): LatestCheckpoint | null {
  const [checkpoint, setCheckpoint] = useState<LatestCheckpoint | null>(null)
  // The active flag lives in a ref so the interval/listener read the latest
  // value without being torn down and rebuilt every time it flips.
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    if (!active) {
      setCheckpoint(null)
      return
    }
    const api = cookrew()
    const fetch = api.latestCheckpoint
    if (!fetch) return // older main: feature-detect, card stays "Ready"

    let cancelled = false
    const read = async (): Promise<void> => {
      if (document.hidden || !activeRef.current) return
      try {
        const cp = await fetch(terminalId)
        if (!cancelled) setCheckpoint(cp)
      } catch {
        // A transient read miss must not blank a shown checkpoint; keep the
        // last good one until the next tick succeeds.
      }
    }

    void read() // instant first paint

    // T4 push: subscribe the host file watch and refresh on its nudge. When
    // present, the poll is only a slow backstop; without it, the poll carries
    // freshness on its own (phone, older main). The change listener is shared
    // across every card (one IPC listener, fanned out) — see latest-changed-bus.
    const hasPush = hasLatestPush()
    let offPush: (() => void) | undefined
    if (hasPush) {
      void api.watchLatest?.(terminalId)
      offPush = subscribeLatestChanged(terminalId, () => void read())
    }

    const timer = window.setInterval(
      () => void read(),
      hasPush ? PUSH_BACKSTOP_MS : POLL_ONLY_MS,
    )
    // A hidden→visible flip should refresh immediately, not wait a full tick.
    const onVisible = (): void => {
      if (!document.hidden) void read()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      offPush?.()
      if (hasPush) void api.unwatchLatest?.(terminalId)
    }
  }, [terminalId, active])

  return checkpoint
}
