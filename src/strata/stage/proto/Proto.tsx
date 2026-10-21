// PROTOTYPE shell for the owner's motion review (G1): the real stage on the
// mock fleet with stand-in scenes. One history entry per level, so browser
// Back is "out". Not the product shell: the levels lane owns App.tsx.
//   /stage/?at=<machine>/<workspace>/<agent>   deep link
//   ?rm=1 force reduced motion · ?live=1 stream the fleet · ?fps=1 HUD frame meter
import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { levelOf, parentOf, type StrataMachine, type StrataPath } from '../../../shared/strata'
import { Stage } from '../Stage'
import { isAncestor, pathKey } from '../plan'
import { flightLog } from '../telemetry'
import { useProtoFleet } from './data'
import { highlightOf, setHighlight, stepHighlight } from './highlight'
import { AgentsScene, MachinesScene, TerminalScene, WorkspacesScene } from './scenes'
import type { Viewport } from './layout'

const params = new URLSearchParams(location.search)
const FORCE_RM = params.has('rm')

const pathFromUrl = (): StrataPath => {
  const [machine, workspace, agent] = (new URLSearchParams(location.search).get('at') ?? '').split('/').filter(Boolean).map(decodeURIComponent)
  return { machine, workspace, agent }
}
const urlOf = (path: StrataPath): string => {
  const at = [path.machine, path.workspace, path.agent].filter(Boolean).map((p) => encodeURIComponent(p as string)).join('/')
  const keep = new URLSearchParams(location.search)
  if (at) keep.set('at', at)
  else keep.delete('at')
  const q = keep.toString()
  return `/stage/${q ? `?${q.replace(/%2F/g, '/')}` : ''}`
}

const useViewport = (): Viewport => {
  const [v, setV] = useState<Viewport>(() => ({ w: innerWidth, h: innerHeight }))
  useEffect(() => {
    let frame = 0
    const onResize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setV({ w: innerWidth, h: innerHeight }))
    }
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [])
  return v
}

const usePrefersReduced = (): boolean => {
  const query = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)'), [])
  const [on, setOn] = useState(query.matches)
  useEffect(() => {
    const change = () => setOn(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [query])
  return on
}

/** Commit timestamps of the stage subtree, for "React commits per transition". */
const commits: number[] = []

const find = (machines: StrataMachine[], path: StrataPath) => {
  const machine = machines.find((m) => m.id === path.machine)
  const workspace = machine?.levels?.workspaces.find((w) => w.id === path.workspace)
  const agent = workspace?.agents.find((a) => a.id === path.agent)
  return { machine, workspace, agent }
}

export function Proto() {
  const machines = useProtoFleet()
  const v = useViewport()
  const prefersReduced = usePrefersReduced()
  const [reducedToggle, setReducedToggle] = useState(FORCE_RM)
  const reducedMotion = prefersReduced || reducedToggle
  const [path, setPath] = useState<StrataPath>(pathFromUrl)
  const pathRef = useRef(path)
  pathRef.current = path

  const go = useCallback((next: StrataPath) => {
    const here = pathRef.current
    // Coming out of an item highlights it, so "in" goes straight back.
    if (isAncestor(next, here)) {
      for (const [lvl, id] of [
        [{}, here.machine],
        [{ machine: here.machine }, here.workspace],
        [{ machine: here.machine, workspace: here.workspace }, here.agent]
      ] as const)
        if (id) setHighlight(pathKey(lvl), id)
    }
    if (pathKey(next) === pathKey(here)) return
    history.pushState(null, '', urlOf(next))
    setPath(next)
  }, [])

  useEffect(() => {
    const onPop = () => setPath(pathFromUrl())
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])

  const machinesRef = useRef(machines)
  machinesRef.current = machines
  const inTarget = useCallback((): StrataPath | null => {
    const here = pathRef.current
    const rows = machinesRef.current ?? []
    const { machine, workspace } = find(rows, here)
    const level = levelOf(here)
    if (level === 'machines') {
      const id = highlightOf(pathKey({})) ?? rows[0]?.id
      return id ? { machine: id } : null
    }
    if (level === 'workspaces') {
      const id = highlightOf(pathKey(here)) ?? machine?.levels?.workspaces[0]?.id
      return id ? { machine: here.machine, workspace: id } : null
    }
    if (level === 'agents') {
      const id = highlightOf(pathKey(here)) ?? workspace?.agents[0]?.id
      return id ? { ...here, agent: id } : null
    }
    return null
  }, [])

  // Keyboard (placeholder for the levels lane's input map): arrows move the highlight, Enter in, Esc / Backspace out.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      const here = pathRef.current
      if ((e.key === 'Escape' || e.key === 'Backspace') && levelOf(here) !== 'machines') {
        e.preventDefault()
        go(parentOf(here))
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        const next = inTarget()
        if (next) go(next)
      } else if (e.key.startsWith('Arrow') && levelOf(here) !== 'terminal') {
        e.preventDefault()
        stepHighlight(pathKey(here), e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [go, inTarget])

  const scene = useCallback(
    (p: StrataPath) => {
      const rows = machines ?? []
      const { machine, workspace, agent } = find(rows, p)
      const level = levelOf(p)
      if (level === 'machines') return <MachinesScene machines={rows} v={v} go={go} />
      if (level === 'workspaces') return <WorkspacesScene machine={machine} machines={rows} v={v} go={go} />
      if (level === 'agents') return <AgentsScene machine={machine} workspace={workspace} machines={rows} v={v} go={go} />
      return <TerminalScene machine={machine} workspace={workspace} agent={agent} v={v} />
    },
    [machines, v, go]
  )

  const onRender = useCallback((_id: string, _phase: string, _actual: number, _base: number, _start: number, commitTime: number) => {
    if (commits[commits.length - 1] !== commitTime) commits.push(commitTime)
  }, [])

  useEffect(() => {
    // nextLanding lets a driver wait without polling the page mid-flight.
    const nextLanding = (ms = 3000) =>
      new Promise((resolve) => {
        const off = flightLog.subscribe((r) => (off(), resolve(r)))
        setTimeout(() => (off(), resolve(null)), ms)
      })
    Object.assign(window, { __glide: { go, path: () => pathRef.current, commits, flights: flightLog.all, machines: () => machinesRef.current, inTarget, nextLanding } })
  }, [go, inTarget])

  if (!machines) return <div className="booting">loading the mock fleet…</div>
  const { machine, workspace, agent } = find(machines, path)

  return (
    <>
      <Profiler id="stage" onRender={onRender}>
        <Stage path={path} scene={scene} inTarget={inTarget} onCommit={go} reducedMotion={reducedMotion} />
      </Profiler>
      <header className="hud">
        <nav className="crumbs" aria-label="Where you are">
          <button onClick={() => go({})}>machines</button>
          {machine && <button onClick={() => go({ machine: machine.id })}>› {machine.name}</button>}
          {workspace && <button onClick={() => go({ machine: machine?.id, workspace: workspace.id })}>› {workspace.name}</button>}
          {agent && <span>› {agent.name}</span>}
        </nav>
        <div className="tools">
          <button onClick={() => go(parentOf(path))} disabled={levelOf(path) === 'machines'} title="Out (Esc)">
            ◀ out
          </button>
          <button onClick={() => diveSomewhere(machines, go)} title="Dive from here into a waiting agent">
            dive ⤓
          </button>
          <label title="prefers-reduced-motion is honoured; this forces it">
            <input type="checkbox" checked={reducedMotion} disabled={prefersReduced} onChange={(e) => setReducedToggle(e.target.checked)} /> reduced
          </label>
        </div>
        <FlightReadout />
      </header>
      <p className="hint" aria-hidden="true">
        swipe ← in · → out · click to go in · Esc out · Back out
      </p>
    </>
  )
}

/** Dives from the current stop to the first waiting agent anywhere (else the first agent). */
const diveSomewhere = (machines: StrataMachine[], go: (p: StrataPath) => void) => {
  const all = machines.flatMap((m) => (m.online ? (m.levels?.workspaces ?? []).flatMap((w) => w.agents.map((a) => ({ m, w, a }))) : []))
  const hit = all.find((x) => x.a.phase === 'waiting') ?? all[0]
  if (hit) go({ machine: hit.m.id, workspace: hit.w.id, agent: hit.a.id })
}

/** Last flight, written straight to the DOM: the readout must not add commits of its own. */
function FlightReadout() {
  const ref = useRef<HTMLOutputElement>(null)
  useEffect(
    () =>
      flightLog.subscribe((r) => {
        const took = r.landed !== null ? Math.round(r.landed - r.takeoff) : 0
        const during = commits.filter((t) => t >= r.takeoff - 1 && t <= (r.landed ?? Infinity) + 1).length
        if (ref.current) ref.current.textContent = `${r.kind} · ${r.geometry} · planned ${r.planned} ms · took ${took} ms · ${r.outcome} · stage commits ${during + 1}${r.K.length ? ` · K ${r.K.join(' → ')}` : ''}`
      }),
    []
  )
  return <output ref={ref} className="readout" aria-live="polite" />
}
