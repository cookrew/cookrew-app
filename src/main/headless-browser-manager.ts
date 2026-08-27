// Lifecycle owner for interactive browser nodes.
//
// Instances are keyed to browser nodes, not stream viewers. Starting instances
// are tracked as first-class resources so node deletion and app shutdown can
// signal them immediately and await bounded Chromium shutdown even before CDP
// startup completes.

import path from 'node:path'
import type { BrowserNodeData, BrowserTab } from '../shared/model'
import { activeBrowserTab, browserTabs } from '../shared/model'
import { HeadlessInstance, type HeadlessOptions, type HeadlessPageState } from './headless-chrome'

const SIZE_MIN = 320
const SIZE_MAX = 2048

function clampSize(value: number, fallback: number): number {
  return Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), SIZE_MIN), SIZE_MAX)
    : fallback
}

export interface HeadlessBrowserManagerDeps {
  enabled: () => boolean
  chromePath: () => string | null
  profileRoot: () => string
  resolveNode: (browserId: string) => BrowserNodeData | null
  onPageState: (browserId: string, tabId: string, state: HeadlessPageState) => void
  onTabOpened: (browserId: string, tab: BrowserTab) => void
  onTabClosed: (browserId: string, tabId: string) => void
  deleteProfile?: (browserId: string) => void | Promise<void>
  makeInstance?: (options: HeadlessOptions) => HeadlessInstance
}

interface StartingEntry {
  instance: HeadlessInstance
  promise: Promise<HeadlessInstance | null>
}

export class HeadlessBrowserManager {
  private readonly instances = new Map<string, HeadlessInstance>()
  private readonly starting = new Map<string, StartingEntry>()
  private readonly stopping = new Map<string, Promise<void>>()
  private readonly desired = new Map<string, BrowserNodeData>()
  private shuttingDown = false
  private shutdownPromise: Promise<void> | null = null

  constructor(private readonly deps: HeadlessBrowserManagerDeps) {}

  /**
   * Replace the desired node set, used at boot and workspace switches.
   *
   * Restoring a canvas must not launch one Chromium process per saved browser
   * card. A large workspace can contain hundreds of reference pages, and each
   * headless instance owns a full profile plus several helper processes. Keep
   * cold nodes as metadata only; instances start through get()/syncNode() when
   * a viewer or command actually needs one. Already-live instances remain
   * node-owned and are synchronized to the restored model.
   */
  async replaceNodes(nodes: BrowserNodeData[]): Promise<void> {
    const ids = new Set(nodes.map((node) => node.id))
    const stopping: Promise<void>[] = []
    for (const id of [...this.desired.keys()]) {
      if (!ids.has(id)) stopping.push(this.remove(id))
    }
    const live = nodes.filter(
      (node) => this.instances.has(node.id) || this.starting.has(node.id)
    )
    for (const node of nodes) this.desired.set(node.id, node)
    await Promise.all(stopping)
    await Promise.all(
      live.map((node) => this.syncNode(node).then(() => undefined).catch(() => undefined))
    )
  }

  async syncNode(node: BrowserNodeData): Promise<HeadlessInstance | null> {
    if (!this.deps.enabled() || this.shuttingDown) return null
    this.desired.set(node.id, node)
    const instance = await this.ensure(node.id)
    if (!instance) return null
    const latest = this.desired.get(node.id)
    if (!latest) return null
    const active = activeBrowserTab(latest)
    await instance.syncTabs(browserTabs(latest), active.id)
    await instance.resize(
      clampSize(latest.size.width, 800),
      clampSize(latest.size.height, 600)
    )
    return instance
  }

  /**
   * An already-running instance, or null. Unlike get(), this NEVER starts one.
   *
   * For callers whose request must not cause a browser to launch — the card
   * thumbnail poll is the case: it runs for every browser on the canvas, and
   * making a picture is never a reason to spend a Chrome process.
   */
  peek(browserId: string): HeadlessInstance | null {
    return this.instances.get(browserId) ?? null
  }

  async get(browserId: string): Promise<HeadlessInstance | null> {
    if (!this.deps.enabled() || this.shuttingDown) return null
    const node = this.deps.resolveNode(browserId)
    if (!node) return null
    this.desired.set(browserId, node)
    return this.ensure(browserId)
  }

  private async ensure(browserId: string): Promise<HeadlessInstance | null> {
    const existing = this.instances.get(browserId)
    if (existing) return existing
    const pending = this.starting.get(browserId)
    if (pending) return pending.promise

    const node = this.desired.get(browserId) ?? this.deps.resolveNode(browserId)
    const executablePath = this.deps.chromePath()
    if (!node || !executablePath || this.shuttingDown) return null

    const tabs = browserTabs(node)
    const active = activeBrowserTab(node)
    const options: HeadlessOptions = {
      executablePath,
      profileDir: path.join(this.deps.profileRoot(), browserId),
      width: clampSize(node.size.width, 800),
      height: clampSize(node.size.height, 600),
      tabs,
      activeTabId: active.id
    }
    const instance = (this.deps.makeInstance ?? ((opts) => new HeadlessInstance(opts)))(options)
    instance.onPageState = (tabId, state) => this.deps.onPageState(browserId, tabId, state)
    instance.onTabOpened = (tab) => this.deps.onTabOpened(browserId, tab)
    instance.onTabClosed = (tabId) => this.deps.onTabClosed(browserId, tabId)
    instance.onExit = () => this.handleExit(browserId, instance)

    const promise = (async (): Promise<HeadlessInstance | null> => {
      try {
        await instance.start()
      } catch {
        await instance.stop()
        return null
      }
      const entry = this.starting.get(browserId)
      if (
        this.shuttingDown ||
        !this.desired.has(browserId) ||
        !entry ||
        entry.instance !== instance
      ) {
        if (entry?.instance === instance) await instance.stop()
        return null
      }
      this.instances.set(browserId, instance)
      return instance
    })()

    this.starting.set(browserId, { instance, promise })
    try {
      return await promise
    } finally {
      const entry = this.starting.get(browserId)
      if (entry?.instance === instance) this.starting.delete(browserId)
    }
  }

  private handleExit(browserId: string, instance: HeadlessInstance): void {
    if (this.instances.get(browserId) === instance) this.instances.delete(browserId)
    const starting = this.starting.get(browserId)
    if (starting?.instance === instance) this.starting.delete(browserId)
    void instance.stop()
  }

  async remove(browserId: string): Promise<void> {
    const pending = this.stopping.get(browserId)
    if (pending) return pending
    this.desired.delete(browserId)
    const operation = (async (): Promise<void> => {
      const stopping: Array<Promise<unknown>> = []
      const starting = this.starting.get(browserId)
      if (starting) {
        this.starting.delete(browserId)
        stopping.push(starting.instance.stop())
        stopping.push(starting.promise.then(() => undefined))
      }
      const instance = this.instances.get(browserId)
      if (instance) {
        this.instances.delete(browserId)
        stopping.push(instance.stop())
      }
      await Promise.all(stopping)
    })()
    this.stopping.set(browserId, operation)
    try {
      await operation
    } finally {
      if (this.stopping.get(browserId) === operation) this.stopping.delete(browserId)
    }
  }

  /** Permanent node deletion: stop first, then remove its persistent profile. */
  async discard(browserId: string): Promise<void> {
    await this.remove(browserId)
    await this.deps.deleteProfile?.(browserId)
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    const ids = new Set([...this.starting.keys(), ...this.instances.keys()])
    this.shutdownPromise = Promise.all([...ids].map((id) => this.remove(id))).then(() => undefined)
    this.desired.clear()
    return this.shutdownPromise
  }

  activeCount(): number {
    return this.instances.size
  }

  startingCount(): number {
    return this.starting.size
  }
}
