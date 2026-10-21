// THE EMBED POOL (EmbedPool in src/strata/seams.ts): the dive's last step.
// One companion document per desktop — the renderer holds one desktop in
// module state, so two never share a document — kept warm in a hidden iframe
// and pointed at an agent with strata:focus, without a reload.
//
//   prewarm(m)  boots m's document with NO agent (no terminal mounted, so a
//               hidden frame can never resize anybody's PTY)
//   open(path)  shows path.agent's terminal: a warm document gets a focus, a
//               cold one is created with the agent in its URL
//   close()     blurs the shown document (its terminal unmounts) and keeps it warm
//
// At most maxWarm() documents live at once (2 on a phone, 3 on a desktop);
// the least recently used one that is not on screen goes first. DOM-free:
// frames come from an injected factory, so this is tested in node.
import type { EmbedToShell, ShellToEmbed, StrataMachine, StrataPath } from '../../shared/strata'
import type { EmbedPool } from '../seams'
import { fromFrame, WARM_AGENT_ID, type MessageLike } from './messages'

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
  createFrame(machineId: string, src: string): FrameHandle
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
  subscribe(listener: () => void): () => void
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
  const listeners = new Set<() => void>()

  const changed = () => {
    view = null
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

  const hideShown = (except?: string) => {
    if (!shown || shown.machineId === except) return
    const frame = frames.get(shown.machineId)
    if (frame) {
      deps.post(frame.handle, { type: 'strata:blur' })
      frame.handle.hide()
      setFrame(frame.machineId, { agentId: null })
    }
    shown = null
  }

  const sendFocus = (frame: Frame, target: Opening) => {
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

  const onReady = (frame: Frame, agentId: string) => {
    if (agentId === WARM_AGENT_ID) {
      setFrame(frame.machineId, { state: 'warm' })
      if (opening?.machineId === frame.machineId && !opening.sent) sendFocus(frame, opening)
      changed()
      return
    }
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
      if (message.type === 'strata:ready') onReady(frame, message.agentId)
      else if (message.type === 'strata:error') onError(frame, message.code, message.detail ?? null)
      else if (shown?.machineId === frame.machineId) deps.onOut()
      return
    }
  }

  const unlisten = deps.listen(onMessage)

  const createFrame = (machine: StrataMachine, agentId: string | null): Frame | null => {
    if (!evictFor(machine.id)) return null
    const handle = deps.createFrame(machine.id, deps.embedUrl(machine, agentId))
    handle.hide()
    const frame: Frame = { machineId: machine.id, handle, state: 'loading', agentId: null, usedAt: deps.now() }
    frames = new Map(frames).set(machine.id, frame)
    return frame
  }

  const refusal = (machine: StrataMachine | undefined): EmbedError | null => {
    if (!machine) return new EmbedError('not-found', 'machine')
    const refused = LINK_REFUSAL[machine.link]
    return refused ? new EmbedError(refused[0], refused[1]) : null
  }

  return {
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
