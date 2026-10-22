// The embed pool's real surroundings: iframes in one fixed layer, window
// messages, the phone/desktop split, and the one URL a desktop's companion
// answers in embed mode. The iframes live outside React on purpose: a warm
// document must survive every re-render and level change of the shell.
import type { StrataMachine } from '../../shared/strata'
import { fleetStreamLimit, pageProtocol } from '../fleet/stream-budget'
import { fleetStore } from '../fleet/use-fleet'
import { maxWarmEmbeds } from './budget'
import { createEmbedPool, type EmbedDeps, type FrameHandle, type StrataEmbedPool } from './embed-pool'

/** Narrow or touch-first: two warm documents, not three. */
export const isPhone = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(max-width: 700px), (pointer: coarse) and (max-width: 1024px)').matches

/**
 * The desktop's own companion, '<base>?embed=agent&agent=<id>' — the preview's
 * mock serves its stand-in embed at the same shape. The companion reads its
 * pairing token from this origin's storage itself, so the URL never carries one.
 */
export const embedUrlFor = (machine: StrataMachine, agentId: string | null): string =>
  `${machine.base}?${new URLSearchParams({ embed: 'agent', ...(agentId ? { agent: agentId } : {}) })}`

const LAYER_ID = 'strata-embed-layer'

/**
 * Every frame is full-size all the time. A hidden one is only invisible and
 * inert — never display:none or 0×0 — because a terminal measuring a tiny
 * viewport would resize the PTY for every viewer of that agent.
 */
let hostElement: HTMLElement | null = null

/**
 * The layer lives in the stage host at inset 0 once the shell has named one
 * (host(el), set once before the first frame), else fixed over the body.
 */
const layer = (): HTMLElement => {
  const found = document.getElementById(LAYER_ID)
  if (found) return found
  const element = document.createElement('div')
  element.id = LAYER_ID
  Object.assign(element.style, { position: hostElement ? 'absolute' : 'fixed', inset: '0', zIndex: '50', pointerEvents: 'none' })
  ;(hostElement ?? document.body).appendChild(element)
  return element
}

const createFrame = (machineId: string, src: string, onLoad: (load: { page: boolean }) => void): FrameHandle => {
  const frame = document.createElement('iframe')
  frame.addEventListener('load', () => {
    // Same origin by construction, so the loaded document can be asked what it is.
    const type = frame.contentDocument?.contentType ?? 'text/html'
    onLoad({ page: type === 'text/html' })
  })
  frame.title = 'Agent terminal'
  frame.dataset.machine = machineId
  frame.referrerPolicy = 'same-origin'
  frame.allow = 'clipboard-read; clipboard-write; fullscreen'
  Object.assign(frame.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0', background: 'transparent' })
  frame.src = src
  layer().appendChild(frame)
  // The real terminal swaps in over the flown placeholder with a ~120 ms
  // crossfade (felix study); visibility flips at the end of a fade-out.
  frame.style.transition = 'opacity 120ms ease-out, visibility 0s linear 120ms'
  const setShown = (shown: boolean) => {
    frame.style.transition = shown ? 'opacity 120ms ease-out, visibility 0s' : 'opacity 120ms ease-out, visibility 0s linear 120ms'
    frame.style.opacity = shown ? '1' : '0'
    frame.style.visibility = shown ? 'visible' : 'hidden'
    frame.style.pointerEvents = shown ? 'auto' : 'none'
    frame.inert = !shown
    frame.setAttribute('aria-hidden', String(!shown))
    if (shown) frame.focus()
  }
  return {
    get window() {
      return frame.contentWindow
    },
    show: () => setShown(true),
    hide: () => setShown(false),
    remove: () => frame.remove()
  }
}

export const browserEmbedDeps = (onOut: () => void): EmbedDeps => ({
  origin: location.origin,
  host: (el) => {
    hostElement = el
  },
  createFrame,
  post: (frame, message) => {
    const target = frame.window as Window | null
    target?.postMessage(message, location.origin)
  },
  listen: (run) => {
    const onMessage = (event: MessageEvent) => run({ origin: event.origin, source: event.source, data: event.data })
    addEventListener('message', onMessage)
    return () => removeEventListener('message', onMessage)
  },
  machine: (id) => fleetStore().getSnapshot().find((m) => m.id === id),
  embedUrl: (machine, agentId) => embedUrlFor(machine, agentId),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
  maxWarm: () => maxWarmEmbeds(isPhone()),
  onOut
})

/** A tab hidden this long drops its off-screen documents, as the fleet drops its streams. */
const HIDDEN_TRIM_MS = 60_000

let shared: StrataEmbedPool | null = null
let outHandler: () => void = () => history.back()

/** Who steps out on strata:out; the levels part sets it to its own history pop. */
export const setEmbedOut = (run: () => void) => {
  outHandler = run
}

export const embedPool = (): StrataEmbedPool => {
  if (shared) return shared
  const core = createEmbedPool(browserEmbedDeps(() => outHandler()))
  // Where the user is, for the fleet's stream budget: the shell prewarms the
  // machine the user is inside and opens the one they dive into.
  const pool: StrataEmbedPool = {
    ...core,
    prewarm(machineId) {
      fleetStore().enter(machineId)
      core.prewarm(machineId)
    },
    open(path, attachmentId) {
      fleetStore().enter(path.machine)
      return core.open(path, attachmentId)
    }
  }
  // The embed's connections come before any levels stream (stream-budget.ts).
  const protocol = pageProtocol()
  const budget = () => {
    const { frames, opening } = core.getSnapshot()
    // A document being pointed at an agent is about to hold all of its streams.
    const held = frames.map((f) => (f.machineId === opening?.machineId ? { ...f, state: 'loading' as const } : f))
    fleetStore().setStreamLimit(fleetStreamLimit(protocol, held))
  }
  // Once per task: a scene remounted inside one commit (open, close, open) nets out.
  let budgetQueued = false
  core.subscribe(() => {
    if (budgetQueued) return
    budgetQueued = true
    queueMicrotask(() => {
      budgetQueued = false
      budget()
    })
  })
  budget()
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null
  document.addEventListener('visibilitychange', () => {
    if (hiddenTimer !== null) clearTimeout(hiddenTimer)
    hiddenTimer = document.visibilityState === 'hidden' ? setTimeout(() => pool.trim(), HIDDEN_TRIM_MS) : null
  })
  shared = pool
  return pool
}
