// PROTOTYPE data: the mock fleet once (a still snapshot keeps flights
// measurable: no stream event re-renders a scene mid-flight), or live through
// the shared useFleet with ?live=1.
import { useEffect, useState } from 'react'
import type { FleetMachine, LevelsSnapshot, StrataMachine } from '../../../shared/strata'
import { useFleet } from '../../fleet/use-fleet'

const getJson = async <T,>(url: string): Promise<T | null> => {
  try {
    const res = await fetch(url)
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

const loadOnce = async (): Promise<StrataMachine[]> => {
  const rows = (await getJson<FleetMachine[]>('/fleet.json')) ?? []
  const cached = (await getJson<Record<string, LevelsSnapshot>>('/preview/cache.json')) ?? {}
  return Promise.all(
    rows.map(async (m): Promise<StrataMachine> => {
      if (!m.online) {
        const last = cached[m.id] ?? null
        return { ...m, link: 'offline', levels: last, stale: last !== null }
      }
      const levels = await getJson<LevelsSnapshot>(`${m.base}api/levels`)
      return { ...m, link: levels ? 'live' : 'error', levels, stale: false }
    })
  )
}


export const LIVE = new URLSearchParams(location.search).has('live')

function useLiveFleet(): StrataMachine[] | null {
  const rows = useFleet()
  return rows.length ? rows : null
}

function useStillFleet(): StrataMachine[] | null {
  const [machines, setMachines] = useState<StrataMachine[] | null>(null)
  useEffect(() => {
    let cancelled = false
    loadOnce().then((rows) => !cancelled && setMachines(rows))
    return () => {
      cancelled = true
    }
  }, [])
  return machines
}

/** Chosen once per page load, so the hook order never changes. */
export const useProtoFleet: () => StrataMachine[] | null = LIVE ? useLiveFleet : useStillFleet
