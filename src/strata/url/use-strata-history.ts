// The owner of history: the URL ⇄ StrataPath, one entry per level, always a
// chain of ancestors (see history.ts). A cold deep link waits for the fleet,
// then seeds its ancestors so Back is "out" and never leaves the site; an
// unknown slug lands on the nearest level that exists, with a notice.
//
// A move that steps back first (out, a crumb, a dive into another machine) is
// one traversal: history.go(-n), then — only if the popstate lands on the
// expected ancestor — the queued pushes. One traversal at a time; a move made
// while one is in flight waits for it (latest wins), so fast outs compose.
import { useCallback, useEffect, useRef, useState } from 'react'
import { parentOf, type StrataMachine, type StrataPath } from '../../shared/strata'
import { samePath } from '../levels/selection'
import { ancestry, depthOf, historyState, isStrataState, planMove } from './history'
import { formatStrataUrl, parseStrataUrl, resolveStrataUrl } from './strata-url'

export interface StrataHistory {
  path: StrataPath
  /** Resolving a deep link (fleet or machine still loading). */
  pending: boolean
  notice: string | null
  clearNotice: () => void
  go: (target: StrataPath) => void
  /** One level out from where history is heading (fast repeated outs compose). */
  out: () => void
}

/** A traversal that never sees its popstate (nothing to go back to) is dropped after this. */
const TRAVERSAL_TIMEOUT_MS = 1500

const initialSlugs = (): string[] | null => {
  if (isStrataState(history.state)) return null
  const parsed = parseStrataUrl(location.pathname)
  return parsed.kind === 'levels' ? parsed.slugs : []
}

/** The deepest prefix of a remembered path that still exists; a machine still connecting is given the benefit of the doubt. */
const existing = (path: StrataPath, fleet: readonly StrataMachine[]): StrataPath => {
  const machine = fleet.find((m) => m.id === path.machine)
  if (!machine) return {}
  if (machine.link === 'connecting') return path
  const workspace = machine.levels?.workspaces.find((w) => w.id === path.workspace)
  if (!workspace) return { machine: machine.id }
  return workspace.agents.some((a) => a.id === path.agent) ? path : { machine: machine.id, workspace: workspace.id }
}

interface Traversal {
  landing: StrataPath
  push: StrataPath[]
  timer: ReturnType<typeof setTimeout>
  /** A move asked for meanwhile, run once this one lands. */
  then: StrataPath | null
}

export const useStrataHistory = (fleet: StrataMachine[], loaded: boolean): StrataHistory => {
  const [slugs, setSlugs] = useState<string[] | null>(initialSlugs)
  const [path, setPathState] = useState<StrataPath>(() => (isStrataState(history.state) ? history.state.strata.path : {}))
  const [notice, setNotice] = useState<string | null>(null)
  const pathRef = useRef(path)
  const slugsRef = useRef(slugs)
  slugsRef.current = slugs
  const traversal = useRef<Traversal | null>(null)
  const fleetRef = useRef(fleet)
  fleetRef.current = fleet

  const setPath = (p: StrataPath) => {
    pathRef.current = p
    setPathState(p)
  }
  const push = (p: StrataPath) => history.pushState(historyState(p), '', formatStrataUrl(p, fleetRef.current))
  /**
   * Make history the chain for `p`: the current entry becomes /me, then every
   * level down. Once only: an entry that already stands at `p` was seeded (a
   * re-run effect, StrictMode's included, must not stack a second chain).
   */
  const seed = (p: StrataPath) => {
    if (isStrataState(history.state) && samePath(history.state.strata.path, p)) return
    history.replaceState(historyState({}), '', formatStrataUrl({}, fleetRef.current))
    ancestry(p).slice(1).forEach(push)
  }
  const traverse = (back: number, landing: StrataPath, then: StrataPath[]) => {
    const timer = setTimeout(() => (traversal.current = null), TRAVERSAL_TIMEOUT_MS)
    traversal.current = { landing, push: then, timer, then: null }
    history.go(-back)
  }

  // A cold deep link: resolve once the fleet can answer, then seed the chain.
  useEffect(() => {
    if (!slugs) return
    const r = resolveStrataUrl(slugs, fleet, { loaded })
    setPath(r.path)
    if (r.pending) return
    seed(r.path)
    if (r.missing) setNotice(`No ${r.missing} “${r.missingSlug}” there. Showing the nearest level.`)
    setSlugs(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugs, fleet, loaded])

  // A remembered path whose items have gone: step back to the surviving ancestor (never rewrite an entry, so the chain holds).
  useEffect(() => {
    if (slugs || !loaded || fleet.length === 0 || traversal.current) return
    const still = existing(path, fleet)
    const back = depthOf(path) - depthOf(still)
    if (back <= 0) return
    setNotice('That item is gone. Showing the nearest level.')
    traverse(back, still, [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugs, loaded, fleet, path])

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const at = isStrataState(e.state) ? e.state.strata.path : null
      const plan = traversal.current
      traversal.current = null
      if (plan) clearTimeout(plan.timer)
      if (plan && at && samePath(at, plan.landing)) {
        plan.push.forEach(push)
        setPath(plan.push[plan.push.length - 1] ?? at)
        if (plan.then) goRef.current(plan.then)
        return
      }
      if (!at) {
        const parsed = parseStrataUrl(location.pathname)
        setSlugs(parsed.kind === 'levels' ? parsed.slugs : [])
        return
      }
      setPath(at)
    }
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Where history is heading: the end of the traversal in flight, else the current path. */
  const heading = (): StrataPath => {
    const t = traversal.current
    return t ? (t.then ?? t.push[t.push.length - 1] ?? t.landing) : pathRef.current
  }

  const go = useCallback((target: StrataPath) => {
    if (traversal.current) {
      traversal.current.then = target
      return
    }
    // A move while a deep link is still resolving: settle the chain for where we are first.
    if (slugsRef.current !== null) {
      seed(pathRef.current)
      setSlugs(null)
    }
    const from = pathRef.current
    const plan = planMove(from, target)
    if (plan.back === 0 && plan.push.length === 0) return
    if (plan.back > 0) return traverse(plan.back, ancestry(from)[depthOf(from) - plan.back], plan.push)
    plan.push.forEach(push)
    setPath(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const goRef = useRef(go)
  goRef.current = go
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const out = useCallback(() => go(parentOf(heading())), [go])

  return { path, pending: slugs !== null, notice, clearNotice: () => setNotice(null), go, out }
}
