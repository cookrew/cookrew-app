/// <reference types="vite/client" />
// THE STRATA SHELL: machines → workspaces → agents → the agent's terminal.
// Owns the URL (one history entry per level), the one highlight per level, the
// finder and the summary card, and hands the stage scene(path). The stage,
// the figures, the fleet store and the embed are stand-ins until their lanes
// land; each swap is one import.
import { Profiler, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { levelOf, parentOf, type Rect, type StrataMachine, type StrataPath } from '../shared/strata'
import { useFleet } from './fleet/use-fleet'
import { standInFigures } from './stand-in/figures'
import { Finder } from './finder/Finder'
import { fleetCodes } from './finder/codes'
import { createFleetIndex } from './finder/search'
import { fanBounds } from './levels/Fan'
import { InstantStage } from './input/InstantStage'
import { isControlTarget, isTypingTarget, keyIntent } from './input/keys'
import { useAnchor } from './levels/anchors'
import { LevelsContext, type GoOptions, type LevelsEnv } from './levels/env'
import { onlineSummary, stateWords } from './levels/link'
import { buildLevelModel, isWaiting } from './levels/model'
import { Scene } from './levels/Scene'
import { agentPaths, childToward, itemOf, nextAgentWithin, nextItem, nextSeed, pathKey, samePath } from './levels/selection'
import { createHoverIntent } from './summary/hover-intent'
import { SummaryCard } from './summary/SummaryCard'
import { useStrataHistory } from './url/use-strata-history'
import './levels/strata.css'

const kit = standInFigures
const LOAD_GRACE_MS = 2500

const useMedia = (query: string) => {
  const [match, setMatch] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const list = matchMedia(query)
    const on = () => setMatch(list.matches)
    list.addEventListener('change', on)
    return () => list.removeEventListener('change', on)
  }, [query])
  return match
}

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

const useViewport = (el: React.RefObject<HTMLDivElement | null>): Rect => {
  // The stage host covers the viewport; the top bar floats over it (levels keep a top inset).
  const [size, setSize] = useState<Rect>({ x: 0, y: 0, w: innerWidth, h: innerHeight })
  useEffect(() => {
    if (!el.current) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize((s) => (s.w === width && s.h === height ? s : { x: 0, y: 0, w: width, h: height }))
    })
    observer.observe(el.current)
    return () => observer.disconnect()
  }, [el])
  return size
}

export function App() {
  const fleet = usePreviewLinks(useFleet())
  const loaded = useLoaded(fleet)
  const { path, notice, clearNotice, go: navigate, out: navigateOut } = useStrataHistory(fleet, loaded)
  const host = useRef<HTMLDivElement>(null)
  const viewport = useViewport(host)
  const touch = useMedia('(pointer: coarse)')
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)')
  const [highlight, setHighlightState] = useState<StrataPath | null>(null)
  const focusVia = useRef<'pointer' | 'key'>('pointer')
  const [summaryKey, setSummaryKey] = useState<string | null>(null)
  const hover = useMemo(
    () =>
      createHoverIntent({
        onShow: setSummaryKey,
        onHide: () => setSummaryKey(null)
      }),
    []
  )
  // After a level change the pointer rests over new items; it must move before hover counts.
  const armed = useRef(true)
  const pointer = useRef({ x: -1, y: -1 })
  const restedAt = useRef({ x: -1, y: -1 })
  const gatedHover = useMemo(() => ({ ...hover, enter: (key: string) => armed.current && hover.enter(key) }), [hover])
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY }
      if (!armed.current && Math.hypot(e.clientX - restedAt.current.x, e.clientY - restedAt.current.y) > 3) armed.current = true
    }
    addEventListener('pointermove', onMove, true)
    return () => removeEventListener('pointermove', onMove, true)
  }, [])
  const [finder, setFinder] = useState<{ query: string } | null>(null)
  const [glow, setGlow] = useState<ReadonlySet<string> | null>(null)
  const [goOptions, setGoOptions] = useState<GoOptions>({})
  const [announce, setAnnounce] = useState('')

  const model = useMemo(() => buildLevelModel(path, fleet, viewport, kit), [path, fleet, viewport])
  // The finder's index: Harbor's FleetIndex replaces createFleetIndex at the merge (one import). Codes sit on top.
  const index = useMemo(() => createFleetIndex(fleet), [fleet])
  const coded = useMemo(() => fleetCodes(fleet), [fleet])
  const codes = useMemo(() => new Map(coded.map((c) => [c.key, c.code])), [coded])
  const level = levelOf(path)
  const machineOf = useCallback((id?: string) => fleet.find((m) => m.id === id) ?? null, [fleet])

  const setHighlight = useCallback((target: StrataPath | null, via: 'pointer' | 'key') => {
    focusVia.current = via
    setHighlightState((now) => (samePath(now, target) ? now : target))
  }, [])

  const go = useCallback(
    (target: StrataPath, opts: GoOptions = {}) => {
      setGoOptions(opts)
      hover.hideNow()
      setFinder(null)
      navigate(target)
    },
    [hover, navigate]
  )
  const goOut = useCallback(() => {
    setGoOptions({})
    hover.hideNow()
    setFinder(null)
    navigateOut()
  }, [hover, navigateOut])
  const openFinder = useCallback(
    (query = '') => {
      hover.hideNow()
      setFinder({ query })
    },
    [hover]
  )

  // Whoever moved last decides whether a new level's highlight also takes DOM focus.
  const lastInput = useRef<'pointer' | 'key'>('pointer')
  useEffect(() => {
    const onKey = () => (lastInput.current = 'key')
    const onPointer = () => (lastInput.current = 'pointer')
    addEventListener('keydown', onKey, true)
    addEventListener('pointerdown', onPointer, true)
    return () => {
      removeEventListener('keydown', onKey, true)
      removeEventListener('pointerdown', onPointer, true)
    }
  }, [])

  // Entering a level, the fleet arriving, an item vanishing: ONE seeding path (nextSeed).
  const key = pathKey(path)
  const lastPath = useRef<StrataPath>(path)
  const lastKey = useRef<string | null>(null)
  const cameFrom = useRef<StrataPath | null>(null)
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (lastKey.current !== key) {
      cameFrom.current = lastKey.current === null ? null : childToward(path, lastPath.current)
      lastPath.current = path
      lastKey.current = key
      restedAt.current = pointer.current
      armed.current = lastInput.current === 'key' || pointer.current.x < 0
      hover.hideNow()
      const names = { machines: 'Machines', workspaces: `${machineOf(path.machine)?.name ?? ''}: workspaces`, agents: 'Agents', terminal: 'Terminal' }
      setAnnounce(`${names[level]}${model.items.length ? `, ${model.items.length} items` : ''}`)
    }
    if (finder) return
    const arrived = seededFor.current !== key
    const focusedWorkspace = machineOf(path.machine)?.levels?.focusedWorkspaceId
    const next = nextSeed({
      items: model.items,
      current: highlight,
      arrived,
      cameFrom: cameFrom.current,
      waiting: (t) => isWaiting(machineOf(t.machine), t),
      preferred: (t) => level === 'workspaces' && !!focusedWorkspace && t.workspace === focusedWorkspace,
      present: (t) => (t.agent ? model.seats.some((s) => samePath(s.path, t)) : model.items.some((it) => samePath(it.target, t)))
    })
    if (model.items.length > 0) seededFor.current = key
    if (next !== undefined) setHighlight(next, lastInput.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, finder, highlight, model.items, model.seats])

  // Keyboard focus follows the highlight, and so does the summary card (after the same intent delay).
  useEffect(() => {
    if (focusVia.current !== 'key' || !highlight) return
    const el = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(pathKey(highlight))}"]`)
    el?.focus({ preventScroll: true })
    if (highlight.agent) hover.enter(`${highlight.machine}/${highlight.agent}`)
    else hover.hideNow()
  }, [highlight, hover])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const intent = keyIntent(e, {
        level,
        typing: isTypingTarget(document.activeElement),
        onControl: isControlTarget(document.activeElement),
        overlayOpen: finder !== null
      })
      if (!intent) return
      e.preventDefault()
      if (intent.type === 'finder') return openFinder('')
      if (intent.type === 'find') return openFinder(intent.text)
      if (intent.type === 'close') return setFinder(null)
      if (intent.type === 'out') return goOut()
      if (intent.type === 'in') return highlight && go(highlight)
      const item = itemOf(model.items, highlight)
      if (intent.within && item?.machine) {
        const machine = machineOf(item.machine)
        const agents = machine ? agentPaths(machine, item.workspace) : []
        return setHighlight(nextAgentWithin(agents, highlight, intent.dir), 'key')
      }
      setHighlight(nextItem(model.items, level === 'agents' ? highlight : item, intent.dir), 'key')
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [level, finder, summaryKey, highlight, model.items, path, go, hover, openFinder, machineOf, setHighlight])

  useEffect(() => () => hover.dispose(), [hover])

  const finderContext = useMemo(() => ({ machine: path.machine, workspace: path.workspace }), [path.machine, path.workspace])
  const onFinderActive = useCallback((target: StrataPath | null) => target && setHighlight(target, 'pointer'), [setHighlight])
  const summarySeat = model.seats.find((s) => s.key === summaryKey) ?? null
  // On L2 the fan opens above the avatar with the card: anchor the card on both.
  const cardSeat =
    summarySeat && level === 'agents' && summarySeat.agent.attachments.length > 0 ? { ...summarySeat, rect: fanBounds(summarySeat.rect, touch) } : summarySeat

  // Levels move the highlight on hover only once the pointer has really moved (see `armed`).
  const levelSetHighlight = useCallback(
    (target: StrataPath | null, via: 'pointer' | 'key') => {
      if (via === 'pointer' && !armed.current) return
      setHighlight(target, via)
    },
    [setHighlight]
  )

  const env: LevelsEnv = {
    kit,
    fleet,
    viewport,
    loaded,
    touch,
    now: Date.now,
    highlight,
    setHighlight: levelSetHighlight,
    go,
    glow,
    codes: finder ? codes : null,
    hover: gatedHover,
    summaryKey,
    useAnchor,
    reducedMotion,
    goOptions
  }

  return (
    <Probe>
      <div className={`strata${touch ? ' touch' : ''}${reducedMotion ? ' reduced' : ''}`}>
        <TopBar path={path} onBack={goOut} fleet={fleet} loaded={loaded} onGo={go} onFind={() => openFinder('')} />
        <div className="stage-host" ref={host}>
          <LevelsContext.Provider value={env}>
            <InstantStage
              path={path}
              scene={(p) => (
                <Scene model={samePath(p, path) || pathKey(p) === key ? model : buildLevelModel(p, fleet, viewport, kit)} openFinder={openFinder} />
              )}
              inTarget={() => highlight}
              onCommit={(next) => go(next)}
              reducedMotion={reducedMotion}
            />
            <SummaryCard
              seat={cardSeat}
            code={summarySeat ? codes.get(summarySeat.key) : undefined}
              machine={machineOf(summarySeat?.path.machine)}
              viewport={viewport}
              onHold={hover.holdCard}
              onRelease={hover.releaseCard}
            />
          </LevelsContext.Provider>
        </div>
        {finder && (
          <Finder
            fleet={fleet}
            index={index}
            coded={coded}
            context={finderContext}
            initialQuery={finder.query}
            onClose={() => setFinder(null)}
            onGlow={setGlow}
            onActive={onFinderActive}
            onDive={(t) => go(t)}
          />
        )}
        {notice && (
          <div className="toast" role="status" onClick={clearNotice}>
            {notice}
          </div>
        )}
        {touch && <LevelDots depth={['machines', 'workspaces', 'agents', 'terminal'].indexOf(level)} />}
        <div className="sr-only" aria-live="polite">
          {announce}
        </div>
      </div>
    </Probe>
  )
}

/** QA only (?probe): counts React commits, so a probe can prove nothing commits per animation frame. */
const PROBE = import.meta.env.DEV && new URLSearchParams(location.search).has('probe')
const countCommit = () => {
  const w = window as unknown as { __strataCommits?: number }
  w.__strataCommits = (w.__strataCommits ?? 0) + 1
}
export function Probe({ children }: { children: ReactNode }) {
  return PROBE ? (
    <Profiler id="strata" onRender={countCommit}>
      {children}
    </Profiler>
  ) : (
    <>{children}</>
  )
}

function TopBar({ path, fleet, loaded, onGo, onBack, onFind }: {
  loaded: boolean
  path: StrataPath; fleet: StrataMachine[]; onGo: (p: StrataPath) => void; onBack: () => void; onFind: () => void }) {
  const machine = fleet.find((m) => m.id === path.machine)
  const workspace = machine?.levels?.workspaces.find((w) => w.id === path.workspace)
  const agent = workspace?.agents.find((a) => a.id === path.agent)
  const crumbs: Array<{ label: string; to: StrataPath }> = [
    { label: 'machines', to: {} },
    ...(path.machine ? [{ label: machine?.name ?? '…', to: { machine: path.machine } }] : []),
    ...(path.workspace
      ? [
          {
            label: workspace?.name ?? '…',
            to: { machine: path.machine, workspace: path.workspace }
          }
        ]
      : []),
    ...(path.agent ? [{ label: agent?.name ?? '…', to: path }] : [])
  ]
  const status = !loaded ? 'finding your machines…' : !path.machine ? onlineSummary(fleet) : machine ? stateWords(machine, Date.now()) : ''
  // The top bar always names the exit: out goes to the parent's name.
  const exitName = path.agent ? (workspace?.name ?? '…') : path.workspace ? (machine?.name ?? '…') : 'Machines'
  return (
    <header className="topbar">
      {path.machine && (
        <button type="button" className="back" aria-label={`Out to ${exitName}`} onClick={onBack} data-plane="screen">
          ‹ <span className="exit">{exitName}</span>
        </button>
      )}
      <nav className="crumbs" aria-label="Level">
        {crumbs.map((c, i) =>
          i === crumbs.length - 1 ? (
            <span key={i} aria-current="page">
              {c.label}
            </span>
          ) : (
            <button key={i} type="button" onClick={() => onGo(c.to)}>
              {c.label}
            </button>
          )
        )}
      </nav>
      <span className="status">{status}</span>
      <button type="button" className="find" onClick={onFind} aria-label="Find an agent (⌘K or /)">
        <span aria-hidden="true">⌕</span>
        <span className="find-label"> Find</span>
        <kbd>⌘K</kbd>
      </button>
    </header>
  )
}

function LevelDots({ depth }: { depth: number }) {
  return (
    <div className="level-dots" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={i === depth ? 'on' : undefined} />
      ))}
    </div>
  )
}
