// PREVIEW STAND-IN for the fleet store (the real one replaces the inside and
// keeps the signature): the registry's machine list, then one levels stream per
// online machine, folded into StrataMachine rows. No tokens, no backoff; the
// last-known snapshots of offline machines come from the mock's
// /preview/cache.json instead of a real cache.
import { useEffect, useState } from 'react'
import type { FleetMachine, LevelsEvent, LevelsSnapshot, StrataMachine } from '../../shared/strata'

const applyEvent = (levels: LevelsSnapshot | null, event: LevelsEvent): LevelsSnapshot | null => {
  if (event.type === 'snapshot') return event.snapshot
  if (!levels) return null
  if (event.type === 'agent') {
    const workspaces = levels.workspaces.map((w) =>
      w.id === event.workspaceId ? { ...w, agents: w.agents.map((a) => (a.id === event.agent.id ? event.agent : a)) } : w
    )
    return { ...levels, rev: event.rev, workspaces }
  }
  if (event.type === 'focus') return { ...levels, rev: event.rev, focusedWorkspaceId: event.workspaceId }
  return levels
}

export const useFleet = (): StrataMachine[] => {
  const [machines, setMachines] = useState<StrataMachine[]>([])

  useEffect(() => {
    const streams: EventSource[] = []
    let cancelled = false
    const patch = (id: string, change: (m: StrataMachine) => StrataMachine) =>
      setMachines((rows) => rows.map((m) => (m.id === id ? change(m) : m)))

    const cache: Promise<Record<string, LevelsSnapshot>> = fetch('/preview/cache.json')
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}))

    Promise.all([fetch('/fleet.json').then((res) => res.json() as Promise<FleetMachine[]>), cache])
      .then(([rows, cached]) => {
        if (cancelled) return
        setMachines(
          rows.map((m) => {
            const last = m.online ? null : (cached[m.id] ?? null)
            return { ...m, link: m.online ? 'connecting' : 'offline', levels: last, stale: last !== null }
          })
        )
        for (const machine of rows.filter((m) => m.online)) {
          const stream = new EventSource(`${machine.base}api/levels/stream`)
          stream.onmessage = (message) => {
            const event = JSON.parse(message.data) as LevelsEvent
            patch(machine.id, (m) => ({ ...m, link: 'live', stale: false, levels: applyEvent(m.levels, event) }))
          }
          stream.onerror = () => patch(machine.id, (m) => ({ ...m, link: 'error', stale: m.levels !== null }))
          streams.push(stream)
        }
      })
      .catch(() => setMachines([]))

    return () => {
      cancelled = true
      for (const stream of streams) stream.close()
    }
  }, [])

  return machines
}
