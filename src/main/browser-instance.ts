import type { CdpInputCommand } from '../shared/cast-input'
import type { UseStatus } from '../shared/use-signal'
import type { Gesture } from './vphone-input'
import type { ViewportMetrics } from '../shared/cast-viewport'
import type { BrowserTab } from '../shared/model'
import type { BrowserViewportState } from './browser-viewport'
import type { FrameMeta, HeadlessPageState, HeadlessStopResult } from './headless-chrome'

/**
 * WHAT A BROWSER CARD'S BACKING INSTANCE HAS TO BE.
 *
 * The cast (browser-cast.ts), the manager (headless-browser-manager.ts) and
 * the agent command engine (headless-browser-command.ts) were written
 * against the headless Chrome instance. This is the part of it they use,
 * spelled as a contract so a second kind of instance — a vphone-cli guest
 * (vphone-instance.ts) — can stand in the same place without the three of
 * them learning what a phone is. HeadlessInstance satisfies it as it stands.
 */
export interface BrowserInstance {
  readonly frameListeners: Set<(jpegBase64: string, meta: FrameMeta) => void>
  /** Text the page copied (page-copy.ts). Absent where nothing copies — a phone's screen. */
  readonly copyListeners?: Set<(text: string) => void>
  onExit: () => void
  onPageState: (tabId: string, state: HeadlessPageState) => void
  onTabOpened: (tab: BrowserTab) => void
  onTabClosed: (tabId: string) => void

  start(): Promise<void>
  stop(gracefulTimeoutMs?: number): Promise<HeadlessStopResult>
  syncTabs(tabs: BrowserTab[], activeTabId: string): Promise<void>
  resize(width: number, height: number): Promise<void>
  snapshot(): Promise<string | null>
  evaluate(expression: string): Promise<unknown>
  navigate(url: string): Promise<void>
  pageInfo(): Promise<HeadlessPageState & { viewport: string }>

  registerViewportViewer(id: string): void
  offerViewport(id: string, metrics: ViewportMetrics): void
  claimViewport(id: string, metrics: ViewportMetrics): boolean
  releaseViewport(id: string): void
  unregisterViewportViewer(id: string): void
  onViewportState(listener: (state: BrowserViewportState) => void): () => void
  beginAgentViewportActivity(): Promise<() => void>
  dispatchInput(method: CdpInputCommand['method'], params: CdpInputCommand['params']): void

  readonly viewport: { width: number; height: number }
  readonly viewportState: BrowserViewportState
  readonly processId: number | null

  /**
   * A USE's device state (pixel-instance.ts): live, or offline with the
   * sentence that says why. Absent on a Chrome — a page has no cable to pull.
   */
  readonly status?: UseStatus
  readonly statusListeners?: Set<(status: UseStatus) => void>
  /** The agent's hand on a screen: gestures in viewport points, resolved once the device took them. */
  act?(gestures: readonly Gesture[]): Promise<void>
}
