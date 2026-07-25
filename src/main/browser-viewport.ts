import type { ViewportMetrics } from '../shared/cast-viewport'

export const VIEWPORT_DEBOUNCE_MS = 200
export const VIEWPORT_HYSTERESIS_PX = 12
export const VIEWPORT_OWNER_COOLDOWN_MS = 1_500
export const VIEWPORT_RELEASE_GRACE_MS = 1_500
export const AGENT_VIEWPORT_GRACE_MS = 2_500
const MIN_APPLY_INTERVAL_MS = 500

export interface BrowserViewportState extends ViewportMetrics {
  revision: number
  ownerId: string | null
  viewerCount: number
  agentHeld: boolean
  transitioning: boolean
}

type StateListener = (state: BrowserViewportState) => void

/**
 * One browser target can have one layout viewport. This coordinator gives that
 * viewport a sticky viewer owner while preserving a single shared DOM/frame.
 */
export class BrowserViewportCoordinator {
  private readonly viewers = new Map<string, ViewportMetrics | null>()
  private readonly listeners = new Set<StateListener>()
  private ownerId: string | null = null
  private source: 'node' | 'viewer' = 'node'
  private current: ViewportMetrics
  private fallback: ViewportMetrics
  private revision = 1
  private transitioning = false
  private pending: ViewportMetrics | null = null
  private applyTimer: ReturnType<typeof setTimeout> | null = null
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private agentTimer: ReturnType<typeof setTimeout> | null = null
  private agentDepth = 0
  private applying = false
  private readonly stableWaiters = new Set<() => void>()
  private lastAppliedAt = 0
  private lastOwnerChangeAt = 0
  private disposed = false

  constructor(
    initial: ViewportMetrics,
    private readonly apply: (metrics: ViewportMetrics) => Promise<void>
  ) {
    this.current = { ...initial }
    this.fallback = { ...initial, mobile: false }
  }

  get state(): BrowserViewportState {
    return {
      ...this.current,
      revision: this.revision,
      ownerId: this.ownerId,
      viewerCount: this.viewers.size,
      agentHeld: this.agentHeld(),
      transitioning: this.transitioning
    }
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  registerViewer(id: string): void {
    if (this.disposed || this.viewers.has(id)) return
    this.viewers.set(id, null)
    this.emit()
  }

  offer(id: string, metrics: ViewportMetrics): void {
    if (this.disposed || !this.viewers.has(id)) return
    this.viewers.set(id, metrics)
    if (this.ownerId === id && !this.agentHeld()) this.schedule(metrics)
    else this.claimSoleViewer()
    this.emit()
  }

  claim(id: string, metrics: ViewportMetrics): boolean {
    if (this.disposed || !this.viewers.has(id) || this.agentHeld()) return false
    this.viewers.set(id, metrics)
    if (
      this.ownerId &&
      this.ownerId !== id &&
      Date.now() - this.lastOwnerChangeAt < VIEWPORT_OWNER_COOLDOWN_MS
    ) {
      return false
    }
    this.setOwner(id, metrics)
    return true
  }

  release(id: string): void {
    if (this.disposed || !this.viewers.has(id)) return
    this.viewers.set(id, null)
    if (this.ownerId === id) this.releaseOwnerAfterGrace(id)
    this.emit()
  }

  unregisterViewer(id: string): void {
    if (!this.viewers.delete(id)) return
    if (this.ownerId === id) this.releaseOwnerAfterGrace(id)
    else this.claimSoleViewer()
    this.emit()
  }

  /** Node-card dimensions are a boot fallback, never a viewer-lease override. */
  setDefault(metrics: ViewportMetrics): void {
    this.fallback = { ...metrics, mobile: false }
    if (this.source === 'node' && this.ownerId === null && this.viewers.size === 0 && !this.agentHeld()) {
      this.schedule(this.fallback)
    }
  }

  /** Hold the effective revision through an agent command plus a short grace. */
  async beginAgentActivity(): Promise<() => void> {
    if (this.agentTimer) clearTimeout(this.agentTimer)
    this.agentTimer = null
    this.agentDepth += 1
    // A queued viewer resize must not land between an agent snapshot and click.
    // An already-running CDP metrics change cannot be cancelled, so wait for it.
    if (this.applyTimer) clearTimeout(this.applyTimer)
    this.applyTimer = null
    this.pending = null
    this.transitioning = this.applying
    this.emit()
    if (this.applying) {
      await new Promise<void>((resolve) => this.stableWaiters.add(resolve))
    }
    let released = false
    return () => {
      if (released || this.disposed) return
      released = true
      this.agentDepth = Math.max(0, this.agentDepth - 1)
      if (this.agentDepth > 0) return this.emit()
      this.agentTimer = setTimeout(() => {
        this.agentTimer = null
        this.emit()
        this.resumeViewerViewport()
      }, AGENT_VIEWPORT_GRACE_MS)
      this.emit()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.applyTimer) clearTimeout(this.applyTimer)
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    if (this.agentTimer) clearTimeout(this.agentTimer)
    this.applyTimer = this.releaseTimer = this.agentTimer = null
    this.pending = null
    for (const resolve of this.stableWaiters) resolve()
    this.stableWaiters.clear()
    this.viewers.clear()
    this.listeners.clear()
  }

  private agentHeld(): boolean {
    return this.agentDepth > 0 || this.agentTimer !== null
  }

  private claimSoleViewer(): void {
    if (this.ownerId !== null || this.agentHeld()) return
    const active = [...this.viewers.entries()].filter(
      (entry): entry is [string, ViewportMetrics] => entry[1] !== null
    )
    if (active.length !== 1) return
    this.setOwner(active[0][0], active[0][1])
  }

  private setOwner(id: string, metrics: ViewportMetrics): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    this.releaseTimer = null
    if (this.ownerId !== id) {
      this.ownerId = id
      this.lastOwnerChangeAt = Date.now()
    }
    this.source = 'viewer'
    this.schedule(metrics)
    this.emit()
  }

  private releaseOwnerAfterGrace(id: string): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer)
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null
      if (this.ownerId !== id || this.viewers.get(id)) return
      this.ownerId = null
      this.emit()
      this.claimSoleViewer()
    }, VIEWPORT_RELEASE_GRACE_MS)
  }

  private schedule(metrics: ViewportMetrics): void {
    if (this.disposed) return
    if (!this.applying && this.sameEnough(metrics, this.current)) {
      this.pending = null
      if (this.applyTimer) clearTimeout(this.applyTimer)
      this.applyTimer = null
      this.transitioning = false
      this.emit()
      return
    }
    this.pending = metrics
    this.transitioning = true
    if (this.applyTimer) clearTimeout(this.applyTimer)
    const sinceLast = Date.now() - this.lastAppliedAt
    const delay = Math.max(VIEWPORT_DEBOUNCE_MS, MIN_APPLY_INTERVAL_MS - sinceLast)
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null
      void this.drain()
    }, delay)
    this.emit()
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.applying) return
    const next = this.pending
    this.pending = null
    if (!next || this.sameEnough(next, this.current)) {
      this.transitioning = false
      return this.emit()
    }
    this.applying = true
    try {
      await this.apply(next)
      this.current = { ...next }
      this.revision += 1
      this.lastAppliedAt = Date.now()
    } catch {
      // Keep the last proven viewport/revision; a later offer can retry.
    } finally {
      this.applying = false
      this.transitioning = this.pending !== null
      for (const resolve of this.stableWaiters) resolve()
      this.stableWaiters.clear()
      this.emit()
      if (this.pending) this.schedule(this.pending)
    }
  }

  private sameEnough(a: ViewportMetrics, b: ViewportMetrics): boolean {
    return (
      a.mobile === b.mobile &&
      Math.abs(a.width - b.width) < VIEWPORT_HYSTERESIS_PX &&
      Math.abs(a.height - b.height) < VIEWPORT_HYSTERESIS_PX
    )
  }

  private resumeViewerViewport(): void {
    if (this.ownerId) {
      const metrics = this.viewers.get(this.ownerId)
      if (metrics) this.schedule(metrics)
      return
    }
    this.claimSoleViewer()
  }

  private emit(): void {
    const state = this.state
    for (const listener of this.listeners) listener(state)
  }
}
