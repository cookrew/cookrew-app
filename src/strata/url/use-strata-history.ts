// The owner of history: the URL ⇄ StrataPath, one entry per level, always a
// chain of ancestors (see history.ts). A cold deep link waits for the fleet,
// then seeds its ancestors so Back is "out" and never leaves the site; an
// unknown slug lands on the nearest level that exists, with a notice.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StrataMachine, StrataPath } from '../../shared/strata'
import { ancestry, historyState, isStrataState, planMove } from './history'
import { formatStrataUrl, parseStrataUrl, resolveStrataUrl } from './strata-url'

export interface StrataHistory {
  path: StrataPath
  /** Resolving a deep link (fleet or machine still loading). */
  pending: boolean
  notice: string | null
  clearNotice: () => void
  go: (target: StrataPath) => void
}

const initialSlugs = (): string[] | null => {
  if (isStrataState(history.state)) return null
  const parsed = parseStrataUrl(location.pathname)
  return parsed.kind === 'levels' ? parsed.slugs : []
}

/** The deepest prefix of a remembered path that still exists in the fleet. */
const existing = (path: StrataPath, fleet: readonly StrataMachine[]): StrataPath => {
  const machine = fleet.find((m) => m.id === path.machine)
  if (!machine) return {}
  if (!machine.levels && machine.link === 'connecting') return path
  const workspace = machine.levels?.workspaces.find((w) => w.id === path.workspace)
  if (!workspace) return { machine: machine.id }
  return workspace.agents.some((a) => a.id === path.agent) ? path : { machine: machine.id, workspace: workspace.id }
}

export const useStrataHistory = (fleet: StrataMachine[], loaded: boolean): StrataHistory => {
  const [slugs, setSlugs] = useState<string[] | null>(initialSlugs)
  const [path, setPath] = useState<StrataPath>(() => (isStrataState(history.state) ? history.state.strata.path : {}))
  const [notice, setNotice] = useState<string | null>(null)
  const queued = useRef<StrataPath[] | null>(null)
  const fleetRef = useRef(fleet)
  fleetRef.current = fleet

  const push = (p: StrataPath) => history.pushState(historyState(p), '', formatStrataUrl(p, fleetRef.current))

  // A cold deep link: resolve once the fleet can answer, then seed the chain.
  useEffect(() => {
    if (!slugs) return
    const r = resolveStrataUrl(slugs, fleet, { loaded })
    setPath(r.path)
    if (r.pending) return
    history.replaceState(historyState({}), '', formatStrataUrl({}, fleet))
    ancestry(r.path).slice(1).forEach(push)
    if (r.missing) setNotice(`No ${r.missing} “${r.missingSlug}” there. Showing the nearest level.`)
    setSlugs(null)
  }, [slugs, fleet, loaded])

  // A remembered path (reload, Back into the app) whose items have gone.
  useEffect(() => {
    if (slugs || !loaded || fleet.length === 0) return
    const still = existing(path, fleet)
    if (Object.keys(still).length === Object.keys(path).filter((k) => path[k as keyof StrataPath]).length) return
    setNotice('That item is gone. Showing the nearest level.')
    history.replaceState(historyState(still), '', formatStrataUrl(still, fleet))
    setPath(still)
  }, [slugs, loaded, fleet, path])

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const at: StrataPath = isStrataState(e.state) ? e.state.strata.path : {}
      const next = queued.current
      queued.current = null
      if (next && next.length > 0) {
        next.forEach(push)
        setPath(next[next.length - 1])
        return
      }
      if (!isStrataState(e.state)) {
        const parsed = parseStrataUrl(location.pathname)
        setSlugs(parsed.kind === 'levels' ? parsed.slugs : [])
        return
      }
      setPath(at)
    }
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])

  const go = useCallback(
    (target: StrataPath) => {
      const plan = planMove(path, target)
      if (plan.back === 0 && plan.push.length === 0) return
      if (plan.back > 0) {
        queued.current = plan.push
        history.go(-plan.back)
        return
      }
      plan.push.forEach(push)
      setPath(target)
    },
    [path]
  )

  return { path, pending: slugs !== null, notice, clearNotice: () => setNotice(null), go }
}
