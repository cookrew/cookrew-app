// THE EMBED POOL (EmbedPool in src/strata/seams.ts): the dive's last step.
// One companion document per desktop — the renderer holds one desktop in
// module state, so two never share a document — kept warm in a hidden iframe
// and pointed at an agent with strata:focus, without a reload.
//
//   prewarm(m)  boots m's document with NO agent (no terminal mounted, so a
//               hidden frame can never resize anybody's PTY)
//   open(path)  shows path.agent's terminal: a warm document gets a focus, a
//               cold one is created with the agent in its URL
//   prefetch()  hover intent on an agent of a document that is up: it reads
//               that agent's detail ahead (strata:prefetch), mounting nothing
//   close()     fades the shown document out, then blurs it (its terminal
//               unmounts) once the fade is over, and keeps it warm
//
// At most maxWarm() documents live at once (2 on a phone, 3 on a desktop);
// the least recently used one that is not on screen goes first. DOM-free:
// frames come from an injected factory, so this is tested in node.
import type { EmbedToShell, ShellToEmbed, StrataMachine, StrataPath } from '../../shared/strata'
import type { EmbedPool, EmbedState } from '../seams'
import { fromFrame, type MessageLike } from './messages'

export type EmbedErrorCode = Extract<EmbedToShell, { type: 'strata:error' }>['code']

export class EmbedError extends Error {
  readonly code: EmbedErrorCode
  readonly detail: string | null

  constructor(code: EmbedErrorCode, detail: string | null = null) {
    super(detail ? `embed ${code}: ${detail}` : `embed ${code}`)
    this.name = 'EmbedError'
    this.code = code
    this.detail = detail
  }
}

export const isEmbedError = (error: unknown): error is EmbedError => error instanceof EmbedError
/** A newer open() or a close() took over; the caller should simply drop it. */
export const SUPERSEDED = 'superseded'

export interface FrameHandle {
  /** The iframe's contentWindow: messages are only believed from exactly this. */
  readonly window: unknown
  show(): void
  hide(): void
  remove(): void
}

export interface EmbedDeps {
  origin: string
  /** Where frames are created from now on: the stage host. Set once; a frame never moves. */
  host?(el: HTMLElement): void
  /**
   * `onLoad` reports each document the frame finishes loading: `page` false
   * means it is not an HTML page at all (a relay refusal answered as JSON), so
   * no embed will ever speak from it.
   */
  createFrame(machineId: string, src: string, onLoad: (load: { page: boolean }) => void): FrameHandle
  post(frame: FrameHandle, message: ShellToEmbed): void
  listen(run: (event: MessageLike) => void): () => void
  machine(machineId: string): StrataMachine | undefined
  embedUrl(machine: StrataMachine, agentId: string | null): string
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  now(): number
  maxWarm(): number
  /** The embed asked to step out (zoomBack / close): the owner of history pops one level. */
  onOut(): void
}

/** The frame's crossfade (browser-pool.ts): a closed frame keeps its terminal until it has faded out. */
export const FRAME_FADE_MS = 120

export const EMBED_TIMEOUTS = {
  /** A document that is already up only has to fetch one agent and mount it. */
  warmMs: 5_000,
  /** Boot through the relay: the bundle, the auth check, the agent. */
  coldMs: 20_000
} as const

export type FrameState = 'loading' | 'warm'

export interface FrameView {
  machineId: string
  state: FrameState
  /** The agent whose terminal is mounted in it; null = booted bare or blurred. */
  agentId: string | null
}

export interface DiveTiming {
  machineId: string
  agentId: string
  warm: boolean
  ms: number
}

export interface EmbedView {
  shown: { machineId: string; agentId: string } | null
  opening: { machineId: string; agentId: string; warm: boolean } | null
  failed: { machineId: string; agentId: string; code: EmbedErrorCode; detail: string | null } | null
  frames: FrameView[]
  lastDive: DiveTiming | null
}

interface Frame extends FrameView {
  handle: FrameHandle
  usedAt: number
  /** A blur waiting for the fade-out to finish; cancelled if the frame is wanted again first. */
  blurTimer: unknown
  /** The agent last prefetched in it, so a lingering hover does not ask twice. */
  prefetched: string | null
}

interface Opening {
  machineId: string
  agentId: string
  attachmentId: string | undefined
  warm: boolean
  startedAt: number
  /** The focus has been posted (a cold frame carries the agent in its URL instead). */
  sent: boolean
  timer: unknown
  resolve: () => void
  reject: (error: EmbedError) => void
}

export interface StrataEmbedPool extends EmbedPool {
  /** QA's fuller view (frames, timings, failure detail); state() is the seam's. */
  getSnapshot(): EmbedView
  /** Drops every document not on screen: a long-hidden tab, or a sign-out. */
  trim(): void
  dispose(): void
}

const LINK_REFUSAL: Partial<Record<StrataMachine['link'], [EmbedErrorCode, string]>> = {
  unpaired: ['unauthorized', 'unpaired'],
  offline: ['offline', 'offline'],
  outdated: ['unreachable', 'outdated']
}

export const createEmbedPool = (deps: EmbedDeps): StrataEmbedPool => {
  let frames = new Map<string, Frame>()
  let shown: EmbedView['shown'] = null
  let opening: Opening | null = null
  let failed: EmbedView['failed'] = null
  let lastDive: DiveTiming | null = null
  let view: EmbedView | null = null
  let state: EmbedState = { shown: null, opening: null, failed: null }
  let hostSet = false
  const listeners = new Set<() => void>()

  const same = <T extends { machineId: string; agentId: string }>(a: T | null, b: T | null, extra?: (a: T, b: T) => boolean) =>
    a === b || (a !== null && b !== null && a.machineId === b.machineId && a.agentId === b.agentId && (!extra || extra(a, b)))

  /** state() is the same object until shown, opening or failed really change. */
  const nextState = (): EmbedState => {
    const next: EmbedState = {
      shown,
      opening: opening && { machineId: opening.machineId, agentId: opening.agentId },
      failed: failed && { machineId: failed.machineId, agentId: failed.agentId, code: failed.code }
    }
    const kept =
      same(state.shown, next.shown) &&
      same(state.opening, next.opening) &&
      same(state.failed, next.failed, (a, b) => a.code === b.code)
    return kept ? state : next
  }

  const changed = () => {
    view = null
    state = nextState()
    for (const listener of [...listeners]) listener()
  }

  const setFrame = (machineId: string, patch: Partial<Frame>) => {
    const frame = frames.get(machineId)
    if (!frame) return
    frames = new Map(frames).set(machineId, { ...frame, ...patch })
  }

  const dropFrame = (machineId: string) => {
    const frame = frames.get(machineId)
    if (!frame) return
    if (frame.blurTimer !== null) deps.clearTimer(frame.blurTimer)
    frame.handle.remove()
    const next = new Map(frames)
    next.delete(machineId)
    frames = next
    if (shown?.machineId === machineId) shown = null
  }

  /** Least recently used first, never the one on screen or being opened. */
  const evictFor = (machineId: string): boolean => {
    const keep = new Set([machineId, shown?.machineId, opening?.machineId])
    while (frames.size >= deps.maxWarm()) {
      const victim = [...frames.values()].filter((f) => !keep.has(f.machineId)).sort((a, b) => a.usedAt - b.usedAt)[0]
      if (!victim) return false
      dropFrame(victim.machineId)
    }
    return true
  }

  const settleOpening = (outcome: { ok: true } | { ok: false; error: EmbedError }) => {
    const current = opening
    if (!current) return
    deps.clearTimer(current.timer)
    opening = null
    if (outcome.ok) {
      lastDive = { machineId: current.machineId, agentId: current.agentId, warm: current.warm, ms: deps.now() - current.startedAt }
      failed = null
      current.resolve()
    } else {
      if (outcome.error.detail !== SUPERSEDED) {
        failed = { machineId: current.machineId, agentId: current.agentId, code: outcome.error.code, detail: outcome.error.detail }
      }
      current.reject(outcome.error)
    }
    changed()
  }

  /** Talking to a frame again cancels the blur its fade-out was waiting to send. */
  const keepFocus = (machineId: string) => {
    const frame = frames.get(machineId)
    if (!frame || frame.blurTimer === null) return
    deps.clearTimer(frame.blurTimer)
    setFrame(machineId, { blurTimer: null })
  }

  /**
   * The way out crossfades into the flight: the frame starts fading at once,
   * still showing its terminal, and is blurred (the terminal unmounts) only
   * when the fade is over.
   */
  const hideShown = (except?: string) => {
    if (!shown || shown.machineId === except) return
    const frame = frames.get(shown.machineId)
    if (frame) {
      frame.handle.hide()
      if (frame.blurTimer !== null) deps.clearTimer(frame.blurTimer)
      const machineId = frame.machineId
      const blurTimer = deps.setTimer(() => {
        const now = frames.get(machineId)
        if (!now || now.blurTimer !== blurTimer) return
        setFrame(machineId, { blurTimer: null })
        deps.post(now.handle, { type: 'strata:blur' })
      }, FRAME_FADE_MS)
      setFrame(machineId, { agentId: null, blurTimer, prefetched: null })
    }
    shown = null
  }

  const sendFocus = (frame: Frame, target: Opening) => {
    keepFocus(frame.machineId)
    setFrame(frame.machineId, { prefetched: null })
    deps.post(frame.handle, {
      type: 'strata:focus',
      agentId: target.agentId,
      ...(target.attachmentId ? { attachmentId: target.attachmentId } : {})
    })
    opening = { ...target, sent: true }
  }

  const reveal = (machineId: string, agentId: string) => {
    const frame = frames.get(machineId)
    if (!frame) return
    hideShown(machineId)
    frame.handle.show()
    setFrame(machineId, { agentId, usedAt: deps.now(), state: 'warm' })
    shown = { machineId, agentId }
    settleOpening({ ok: true })
  }

  /** A prewarmed document is listening with no agent mounted: a held focus can go now. */
  const onWarm = (frame: Frame) => {
    setFrame(frame.machineId, { state: 'warm', agentId: null })
    if (opening?.machineId === frame.machineId && !opening.sent) sendFocus(frame, opening)
    changed()
  }

  const onReady = (frame: Frame, agentId: string) => {
    setFrame(frame.machineId, { state: 'warm', agentId })
    if (opening?.machineId === frame.machineId && opening.agentId === agentId) return reveal(frame.machineId, agentId)
    // Booted for an earlier open's agent while this one waited: point it here now.
    const booted = frames.get(frame.machineId)
    if (booted && opening?.machineId === frame.machineId && !opening.sent) sendFocus(booted, opening)
    changed()
  }

  const onError = (frame: Frame, code: EmbedErrorCode, detail: string | null) => {
    // A missing agent leaves a healthy document; anything else is a document
    // that cannot serve this machine right now, and a retry starts it over.
    if (code === 'not-found') setFrame(frame.machineId, { agentId: null })
    else dropFrame(frame.machineId)
    if (opening?.machineId === frame.machineId) settleOpening({ ok: false, error: new EmbedError(code, detail) })
    else changed()
  }

  const onMessage = (event: MessageLike) => {
    for (const frame of frames.values()) {
      const message = fromFrame(event, deps.origin, frame.handle.window)
      if (!message) continue
      if (message.type === 'strata:warm') onWarm(frame)
      else if (message.type === 'strata:ready') onReady(frame, message.agentId)
      else if (message.type === 'strata:error') onError(frame, message.code, message.detail ?? null)
      else if (shown?.machineId === frame.machineId) deps.onOut()
      return
    }
  }

  const unlisten = deps.listen(onMessage)

  const createFrame = (machine: StrataMachine, agentId: string | null): Frame | null => {
    if (!evictFor(machine.id)) return null
    const handle = deps.createFrame(machine.id, deps.embedUrl(machine, agentId), ({ page }) => {
      if (page || frames.get(machine.id)?.handle !== handle) return
      dropFrame(machine.id)
      if (opening?.machineId === machine.id) settleOpening({ ok: false, error: new EmbedError('unreachable', 'refused') })
      else changed()
    })
    handle.hide()
    const frame: Frame = { machineId: machine.id, handle, state: 'loading', agentId: null, usedAt: deps.now(), blurTimer: null, prefetched: null }
    frames = new Map(frames).set(machine.id, frame)
    return frame
  }

  const refusal = (machine: StrataMachine | undefined): EmbedError | null => {
    if (!machine) return new EmbedError('not-found', 'machine')
    const refused = LINK_REFUSAL[machine.link]
    return refused ? new EmbedError(refused[0], refused[1]) : null
  }

  return {
    host(el) {
      if (hostSet || frames.size > 0) return
      hostSet = true
      deps.host?.(el)
    },

    prefetch(path: Required<StrataPath>) {
      const frame = frames.get(path.machine)
      // Only a document that is up, and never for the agent already on screen.
      if (!frame || frame.state !== 'warm' || frame.agentId === path.agent || frame.prefetched === path.agent) return
      setFrame(path.machine, { prefetched: path.agent })
      deps.post(frame.handle, { type: 'strata:prefetch', agentId: path.agent })
    },

    state: () => state,

    prewarm(machineId) {
      const existing = frames.get(machineId)
      if (existing) {
        setFrame(machineId, { usedAt: deps.now() })
        return
      }
      const machine = deps.machine(machineId)
      if (!machine || refusal(machine) || machine.link !== 'live') return
      if (createFrame(machine, null)) changed()
    },

    open(path: Required<StrataPath>, attachmentId?: string) {
      const machine = deps.machine(path.machine)
      const refused = refusal(machine)
      if (opening) settleOpening({ ok: false, error: new EmbedError('unreachable', SUPERSEDED) })
      if (!machine || refused) {
        const error = refused ?? new EmbedError('not-found', 'machine')
        failed = { machineId: path.machine, agentId: path.agent, code: error.code, detail: error.detail }
        changed()
        return Promise.reject(error)
      }
      const existing = frames.get(machine.id)
      if (existing?.state === 'warm' && existing.agentId === path.agent && shown?.machineId === machine.id && !attachmentId) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        const warm = existing?.state === 'warm'
        const frame = existing ?? createFrame(machine, path.agent)
        if (!frame) {
          reject(new EmbedError('unreachable', 'no-room'))
          return
        }
        const timer = deps.setTimer(() => {
          if (opening?.timer !== timer) return
          if (!warm) dropFrame(machine.id)
          settleOpening({ ok: false, error: new EmbedError('unreachable', 'timeout') })
        }, warm ? EMBED_TIMEOUTS.warmMs : EMBED_TIMEOUTS.coldMs)
        const target: Opening = {
          machineId: machine.id,
          agentId: path.agent,
          attachmentId,
          warm,
          startedAt: deps.now(),
          // A frame created for this open carries the agent in its URL.
          sent: !existing,
          timer,
          resolve,
          reject
        }
        opening = target
        failed = null
        hideShown(machine.id)
        keepFocus(machine.id)
        setFrame(machine.id, { usedAt: deps.now() })
        if (existing && existing.state === 'warm') sendFocus(existing, target)
        changed()
      })
    },

    close() {
      if (opening) settleOpening({ ok: false, error: new EmbedError('unreachable', SUPERSEDED) })
      hideShown()
      failed = null
      changed()
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    getSnapshot() {
      view ??= {
        shown,
        opening: opening && { machineId: opening.machineId, agentId: opening.agentId, warm: opening.warm },
        failed,
        frames: [...frames.values()].map(({ machineId, state, agentId }) => ({ machineId, state, agentId })),
        lastDive
      }
      return view
    },

    trim() {
      for (const machineId of [...frames.keys()]) {
        if (machineId !== shown?.machineId && machineId !== opening?.machineId) dropFrame(machineId)
      }
      changed()
    },

    dispose() {
      if (opening) settleOpening({ ok: false, error: new EmbedError('unreachable', SUPERSEDED) })
      unlisten()
      for (const machineId of [...frames.keys()]) dropFrame(machineId)
      changed()
    }
  }
}
