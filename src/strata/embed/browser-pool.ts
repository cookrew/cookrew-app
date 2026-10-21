// The embed pool's real surroundings: iframes in one fixed layer, window
// messages, the phone/desktop split, and the one URL a desktop's companion
// answers in embed mode. The iframes live outside React on purpose: a warm
// document must survive every re-render and level change of the shell.
import type { StrataMachine } from '../../shared/strata'
import { fleetStore } from '../fleet/use-fleet'
import { maxWarmEmbeds } from './budget'
import { createEmbedPool, type EmbedDeps, type FrameHandle, type StrataEmbedPool } from './embed-pool'

/** Narrow or touch-first: two warm documents, not three. */
export const isPhone = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(max-width: 700px), (pointer: coarse) and (max-width: 1024px)').matches

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Production: the desktop's own companion, '<base>?embed=agent&agent=<id>'.
 * It reads its pairing token from this origin's storage itself, so the URL
 * never carries one. The strata preview has no companion behind its mock
 * machines, so it loads the stand-in embed (src/strata/embed/stand-in.html),
 * which speaks the same messages.
 */
export const embedUrlFor = (machine: StrataMachine, agentId: string | null, where: Pick<Location, 'hostname'> = location): string => {
  const query = new URLSearchParams({ embed: 'agent', ...(agentId ? { agent: agentId } : {}) })
  if (LOOPBACK.has(where.hostname) && machine.base.startsWith('/m/')) {
    return `/embed/stand-in.html?${new URLSearchParams({ machine: machine.id, ...Object.fromEntries(query) })}`
  }
  return `${machine.base}?${query}`
}

const LAYER_ID = 'strata-embed-layer'

/**
 * Every frame is full-size all the time. A hidden one is only invisible and
 * inert — never display:none or 0×0 — because a terminal measuring a tiny
 * viewport would resize the PTY for every viewer of that agent.
 */
const layer = (): HTMLElement => {
  const found = document.getElementById(LAYER_ID)
  if (found) return found
  const element = document.createElement('div')
  element.id = LAYER_ID
  Object.assign(element.style, { position: 'fixed', inset: '0', zIndex: '50', pointerEvents: 'none' })
  document.body.appendChild(element)
  return element
}

const createFrame = (machineId: string, src: string): FrameHandle => {
  const frame = document.createElement('iframe')
  frame.title = 'Agent terminal'
  frame.dataset.machine = machineId
  frame.referrerPolicy = 'same-origin'
  frame.allow = 'clipboard-read; clipboard-write; fullscreen'
  Object.assign(frame.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0', background: 'transparent' })
  frame.src = src
  layer().appendChild(frame)
  const setShown = (shown: boolean) => {
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
  const pool = createEmbedPool(browserEmbedDeps(() => outHandler()))
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null
  document.addEventListener('visibilitychange', () => {
    if (hiddenTimer !== null) clearTimeout(hiddenTimer)
    hiddenTimer = document.visibilityState === 'hidden' ? setTimeout(() => pool.trim(), HIDDEN_TRIM_MS) : null
  })
  shared = pool
  return pool
}
