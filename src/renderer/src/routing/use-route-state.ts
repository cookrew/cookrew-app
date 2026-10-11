import { useEffect, useState } from 'react'
import { cookrew } from '../api'
import type { RouteState } from '../../../shared/route'

/**
 * THE GATEWAY'S STATE, PUSHED. One read at mount, then `onRoute` — main
 * re-reads after every Setup line and after the plugin file changes, so the
 * status line turns green by itself when the install finishes. No poll.
 *
 * `available` is false on a bridge without the route methods (an older
 * desktop, a phone talking to one); the panel then says so instead of
 * drawing an empty gateway.
 */
export interface RouteStateControls {
  state: RouteState | null
  available: boolean
  setDefault: (model: string | null) => void
  /** Why the last default pick did not land, with when — the panel shows the newest of its sources. */
  error: { text: string; at: number } | null
}

export function useRouteState(): RouteStateControls {
  const [state, setState] = useState<RouteState | null>(null)
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<{ text: string; at: number } | null>(null)

  useEffect(() => {
    const api = cookrew()
    if (!api.routeState) {
      setAvailable(false)
      return
    }
    let alive = true
    api
      .routeState()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch(() => {
        if (alive) setAvailable(false)
      })
    const off = api.onRoute?.((next) => setState(next))
    return () => {
      alive = false
      off?.()
    }
  }, [])

  const setDefault = (model: string | null): void => {
    const api = cookrew()
    if (!api.routeSetDefault) return
    setError(null)
    api
      .routeSetDefault(model)
      .then(setState)
      .catch((e: unknown) => setError({ text: `default not set: ${e instanceof Error ? e.message : String(e)}`, at: Date.now() }))
  }

  return { state, available, setDefault, error }
}
