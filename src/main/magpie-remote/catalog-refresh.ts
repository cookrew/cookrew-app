/** A provider can be registered before the gateway's model catalog catches up. */
const FOLLOW_UP_MS = 1500

type Schedule = (task: () => void, delay: number) => () => void

const scheduleLater: Schedule = (task, delay) => {
  const timer = setTimeout(task, delay)
  timer.unref?.()
  return () => clearTimeout(timer)
}

/**
 * Re-read routing after a successful remote connection change. The immediate
 * read and one bounded follow-up cover the gateway's asynchronous provider
 * reload. Concurrent changes are serialized so an old fetch cannot publish
 * its catalog after a newer change. A probe is never part of the key handover:
 * a temporary gateway failure must not turn a successful connection into an
 * apparent failure.
 */
export function createCatalogRefresh(refresh: () => Promise<unknown>, schedule: Schedule = scheduleLater) {
  let serial: Promise<void> = Promise.resolve()
  let cancelFollowUp: (() => void) | null = null
  let disposed = false

  const queue = (): Promise<void> => {
    const next = serial.then(async () => {
      if (disposed) return
      try {
        await refresh()
      } catch {
        // Routing's next explicit read can recover after a failed probe.
      }
    })
    serial = next
    return next
  }

  const changed = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    cancelFollowUp?.()
    cancelFollowUp = schedule(() => {
      cancelFollowUp = null
      void queue()
    }, FOLLOW_UP_MS)
    return queue()
  }

  return {
    changed,
    async after<T extends { readonly ok: boolean }>(act: () => Promise<T>): Promise<T> {
      const answer = await act()
      if (answer.ok) void changed()
      return answer
    },
    dispose(): void {
      disposed = true
      cancelFollowUp?.()
      cancelFollowUp = null
    }
  }
}
