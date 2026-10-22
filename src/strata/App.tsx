/// <reference types="vite/client" />
// THE STRATA PAGE on cookrew.dev: the shell (Shell.tsx) over the account's
// fleet, with the URL as history (one entry per level). The fleet store and
// the embed are stand-ins until their lanes land; each swap is one import.
import { useEffect, useMemo, useState } from 'react'
import type { StrataMachine } from '../shared/strata'
import { useFleet } from './fleet/use-fleet'
import { StrataShell } from './Shell'
import { useStrataHistory } from './url/use-strata-history'
import './levels/strata-page.css'

const LOAD_GRACE_MS = 2500

/**
 * STAND-IN for Harbor's useFleetLoaded (seams: UseFleetLoaded). The swap is
 * this one function: `const loaded = useFleetLoaded()`. Until then: loaded once
 * the fleet has rows, or after a grace period (an empty account).
 */
const useLoaded = (fleet: StrataMachine[]) => {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), LOAD_GRACE_MS)
    return () => clearTimeout(timer)
  }, [])
  return fleet.length > 0 || late
}

/**
 * PREVIEW ONLY (dev builds; compiled out of production): ?link=<machineId>:<unpaired|outdated>,… forces
 * link states the mock never produces, so every machine state can be seen.
 */
/** Read once at load: the shell rewrites the URL to its canonical form, query string and all. */
const FORCED_LINKS: ReadonlyMap<string, string> = (() => {
  const spec = new URLSearchParams(location.search).get('link')
  return new Map(import.meta.env.DEV && spec ? spec.split(',').map((pair) => pair.split(':') as [string, string]) : [])
})()
const usePreviewLinks = (fleet: StrataMachine[]): StrataMachine[] =>
  useMemo(() => {
    if (FORCED_LINKS.size === 0) return fleet
    return fleet.map((m) => {
      const link = FORCED_LINKS.get(m.id)
      return link === 'unpaired' || link === 'outdated' ? { ...m, link, levels: null, stale: false } : m
    })
  }, [fleet])

export function App() {
  const fleet = usePreviewLinks(useFleet())
  const loaded = useLoaded(fleet)
  const history = useStrataHistory(fleet, loaded)
  return <StrataShell fleet={fleet} loaded={loaded} history={history} />
}
