import { useEffect, useState } from 'react'
import { dataPlane, subscribeDataPlane, type DataPlane } from './data-plane'

/**
 * The data plane, as a React value.
 *
 * The store is deliberately not a hook — the things that feed and read it
 * (api-base, remote-api, the switcher) know nothing about components — so this
 * is the one adapter, and it is the whole adapter.
 *
 * A component reads the ORIGIN rather than the object wherever it can: origin
 * is a scalar, so an effect keyed on it re-runs exactly when the transport
 * actually moved.
 */
export const useDataPlane = (): DataPlane => {
  const [plane, setPlane] = useState<DataPlane>(dataPlane)
  useEffect(() => {
    // Re-read on mount: the switcher runs from boot and may already have moved
    // the plane between this component's first render and its first effect.
    setPlane(dataPlane())
    return subscribeDataPlane(setPlane)
  }, [])
  return plane
}

/**
 * Where the transport is, as one scalar: the origin, and whether the direct
 * link carries it. The link keeps the relay's empty origin (rtc-plane.ts), so
 * an effect keyed on the origin alone would not re-run when the plane moves
 * onto it — and a socket opened on the relay would stay there.
 */
export const useDataPlaneRoute = (): string => {
  const plane = useDataPlane()
  return `${plane.transport ?? 'fetch'} ${plane.origin}`
}
