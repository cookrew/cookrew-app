import { useCallback, useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import type { RouteState } from '../../../shared/route'
import { createRouteOrder } from './route-state-order'

/**
 * THE GATEWAY'S STATE, PUSHED. One read at mount, then `onRoute` — main
 * re-reads after every Setup line and after the plugin file changes, so the
 * status line turns green by itself when the install finishes. No poll.
 *
 * THE PANEL RE-READS WHEN IT OPENS. A renderer can fall behind the gateway
 * without knowing — a dropped stream on the phone, a renderer swapped under
 * a live window — and a panel that only ever showed what it was last pushed
 * would show the owner a default they no longer have. Opening the panel is
 * the owner looking; `reread` asks main once, and main's answer is the probe
 * it makes while someone is looking.
 *
 * A READ NEVER OVERWRITES WHAT LANDED AFTER IT WAS ASKED FOR. A read is
 * computed when main gets to it and lands when the link delivers it; a push
 * or the answer to a pick that landed in between is newer (route-state-order).
 *
 * `available` is false on a bridge without the route methods (an older
 * desktop, a phone talking to one); the panel then says so instead of
 * drawing an empty gateway.
 */
export interface RouteStateControls {
  state: RouteState | null
  available: boolean
  setDefault: (model: string | null) => void
  /** The shared-MCP switch; the next spawn of each agent reads it. */
  setSharedMcp: (on: boolean) => void
  /** Ask main for the state now — the panel opening, nothing else. */
  reread: () => void
  /** Why the last default pick did not land, with when — the panel shows the newest of its sources. */
  error: { text: string; at: number } | null
}

export function useRouteState(): RouteStateControls {
  const [state, setState] = useState<RouteState | null>(null)
  const [available, setAvailable] = useState(true)
  const [error, setError] = useState<{ text: string; at: number } | null>(null)
  const order = useRef(createRouteOrder())
  const alive = useRef(true)

  const apply = useCallback((next: RouteState): void => {
    order.current.applied()
    setState(next)
  }, [])

  const reread = useCallback((): void => {
    const api = cookrew()
    if (!api.routeState) return
    const issued = order.current.issue()
    api
      .routeState()
      .then((next) => {
        if (alive.current && order.current.stillNewest(issued)) apply(next)
      })
      .catch((e: unknown) => {
        if (alive.current) setError({ text: `routing not read: ${e instanceof Error ? e.message : String(e)}`, at: Date.now() })
      })
  }, [apply])

  useEffect(() => {
    alive.current = true
    const api = cookrew()
    if (!api.routeState) {
      setAvailable(false)
      return
    }
    const issued = order.current.issue()
    api
      .routeState()
      .then((next) => {
        if (alive.current && order.current.stillNewest(issued)) apply(next)
      })
      .catch(() => {
        if (alive.current) setAvailable(false)
      })
    const off = api.onRoute?.((next) => {
      if (alive.current) apply(next)
    })
    return () => {
      alive.current = false
      off?.()
    }
  }, [apply])

  const setDefault = (model: string | null): void => {
    const api = cookrew()
    if (!api.routeSetDefault) return
    setError(null)
    api
      .routeSetDefault(model)
      .then((next) => {
        if (alive.current) apply(next)
      })
      .catch((e: unknown) => setError({ text: `default not set: ${e instanceof Error ? e.message : String(e)}`, at: Date.now() }))
  }

  const setSharedMcp = (on: boolean): void => {
    const api = cookrew()
    if (!api.routeSetSharedMcp) return
    setError(null)
    api
      .routeSetSharedMcp(on)
      .then((next) => {
        if (alive.current) apply(next)
      })
      .catch((e: unknown) => setError({ text: `MCP switch not set: ${e instanceof Error ? e.message : String(e)}`, at: Date.now() }))
  }

  return { state, available, setDefault, setSharedMcp, reread, error }
}
