import { useCallback, useEffect, useState } from 'react'
import { cookrew } from '../api'
import type { CardRouteState } from '../../../shared/route'

/**
 * ONE CARD'S ROUTE for the RTE dial: what it asked for, what answered this
 * turn, what it cost. Read once when the zoom opens, then pushed by
 * `onCardRoute` whenever main sees a decision or a turn fact — no poll, the
 * same contract as the tuning rail beside it.
 *
 * The picker's rows come from the gateway's catalogue (`routeState`), groups
 * first, `direct` first of all; they are read once and refreshed with the
 * route state, which is what changes them.
 */
export interface CardRouteControls {
  /** Null until the first read lands, or on a bridge without the route methods. */
  state: CardRouteState | null
  open: boolean
  setOpen: (open: boolean) => void
  pick: (route: string) => void
  error: string | null
}

export function useCardRoute(input: { terminalId: string; enabled: boolean }): CardRouteControls {
  const { terminalId, enabled } = input
  const [state, setState] = useState<CardRouteState | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    const api = cookrew()
    if (!api.terminalRoute) return
    let alive = true
    api
      .terminalRoute(terminalId)
      .then((next) => {
        if (alive) setState(next)
      })
      .catch(() => undefined)
    const offCard = api.onCardRoute?.((row) => {
      if (row.terminalId === terminalId) {
        const { terminalId: _id, ...rest } = row
        setState(rest)
      }
    })
    return () => {
      alive = false
      offCard?.()
    }
  }, [terminalId, enabled])

  const pick = useCallback(
    (route: string): void => {
      setOpen(false)
      setError(null)
      const api = cookrew()
      if (!api.terminalRouteSet) return
      api
        .terminalRouteSet(terminalId, route)
        .then((result) => {
          // The service refuses a route it cannot set (a served session, an
          // id outside the catalog) with a sentence, not a throw.
          if ('error' in result) setError(result.error)
          else setState(result)
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    },
    [terminalId]
  )

  return { state, open, setOpen, pick, error }
}
