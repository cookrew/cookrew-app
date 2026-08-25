type Listener = () => void

/**
 * A tiny per-key external store for useSyncExternalStore.
 *
 * WHY THIS EXISTS. Per-terminal activity (and per-browser thumbnails) used to
 * live in the single canvas-ui context object. Every streamed activity event
 * minted a new context value, so ALL ~91 cards re-rendered on every event —
 * tens of full-canvas passes per second with no user interaction (the measured
 * ~29% CPU at rest). React Context has no selective subscription: a consumer
 * re-renders whenever the value's identity changes, regardless of which key it
 * reads. This store gives each card a subscription to ITS OWN key, so a change
 * to key X notifies only the components reading X. A separate global
 * subscription serves the few readers that genuinely need the whole map (the
 * header's busy count, the roster sidebar).
 *
 * The store holds mutable internal state (that is the useSyncExternalStore
 * contract), but every SNAPSHOT it hands out is immutable: getSnapshot returns
 * a stable object that only changes identity when the map actually changed, and
 * per-key reads return the stored value by reference so an unchanged key never
 * triggers a re-render.
 */
export class KeyedStore<T> {
  private readonly map = new Map<string, T>()
  private readonly keyListeners = new Map<string, Set<Listener>>()
  private readonly globalListeners = new Set<Listener>()
  private cachedSnapshot: Record<string, T> = {}
  private snapshotDirty = false

  get(id: string): T | undefined {
    return this.map.get(id)
  }

  /** A stable full-map snapshot — new identity only when the map changed. */
  getSnapshot(): Record<string, T> {
    if (this.snapshotDirty) {
      this.cachedSnapshot = Object.fromEntries(this.map)
      this.snapshotDirty = false
    }
    return this.cachedSnapshot
  }

  /** Set one key. A no-op when the value is identical (===) — no notify. */
  set(id: string, value: T): void {
    if (this.map.get(id) === value) return
    this.map.set(id, value)
    this.snapshotDirty = true
    this.notify(id)
  }

  /**
   * Merge many entries (an initial snapshot). With preferExisting, a key already
   * present is left untouched — a live event that landed before the snapshot
   * resolved must not be clobbered by staler data.
   */
  seed(entries: Iterable<[string, T]>, preferExisting = true): void {
    let changed = false
    for (const [id, value] of entries) {
      if (preferExisting && this.map.has(id)) continue
      if (this.map.get(id) === value) continue
      this.map.set(id, value)
      this.keyListeners.get(id)?.forEach((cb) => cb())
      changed = true
    }
    if (changed) {
      this.snapshotDirty = true
      this.globalListeners.forEach((cb) => cb())
    }
  }

  /** Remove every key, calling onRemove per value first (e.g. to revoke a blob URL). */
  clear(onRemove?: (value: T) => void): void {
    if (this.map.size === 0) return
    const ids = [...this.map.keys()]
    if (onRemove) for (const value of this.map.values()) onRemove(value)
    this.map.clear()
    this.snapshotDirty = true
    for (const id of ids) this.keyListeners.get(id)?.forEach((cb) => cb())
    this.globalListeners.forEach((cb) => cb())
  }

  subscribeKey(id: string, cb: Listener): () => void {
    let set = this.keyListeners.get(id)
    if (!set) {
      set = new Set()
      this.keyListeners.set(id, set)
    }
    set.add(cb)
    return () => {
      const live = this.keyListeners.get(id)
      if (!live) return
      live.delete(cb)
      if (live.size === 0) this.keyListeners.delete(id)
    }
  }

  subscribeGlobal(cb: Listener): () => void {
    this.globalListeners.add(cb)
    return () => this.globalListeners.delete(cb)
  }

  private notify(id: string): void {
    this.keyListeners.get(id)?.forEach((cb) => cb())
    this.globalListeners.forEach((cb) => cb())
  }
}
