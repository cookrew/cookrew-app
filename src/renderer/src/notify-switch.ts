import { useCallback, useEffect, useState } from 'react'
import { cookrew } from './api'

/**
 * The desktop notifications' switch (main/notifier.ts), for the ⋯ menu. Main
 * keeps it; this reads it once and sets it. `supported` is false where there
 * is no desktop notifier (the phone's page): the row is not offered there, nor
 * before main has said which it is (`on` null), so it never shows a guess.
 */
export function useNotificationsOn(): { supported: boolean; on: boolean | null; set: (on: boolean) => void } {
  const api = cookrew()
  const supported = typeof api.getNotifications === 'function' && typeof api.setNotifications === 'function'
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    if (!supported) return
    let alive = true
    void api.getNotifications?.().then((value) => alive && setOn(value)).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [api, supported])
  const set = useCallback(
    (next: boolean) => {
      setOn(next)
      void api.setNotifications?.(next).then(setOn).catch(() => setOn(!next))
    },
    [api]
  )
  return { supported, on, set }
}
