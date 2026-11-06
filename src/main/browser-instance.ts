import type { FieldReport } from './page-fields'
import type { CdpInputCommand } from '../shared/cast-input'
import type { ViewerWho } from '../shared/remote-access'
import type { UseStatus } from '../shared/use-signal'
import type { Gesture } from './vphone-input'
import type { ViewportMetrics } from '../shared/cast-viewport'
import type { BrowserTab } from '../shared/model'
import type { BrowserViewportState } from './browser-viewport'
import type { ArrivingDownload } from './browser-downloads'
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
  /** A frame taken for this look, where snapshot only reads what is held. Absent: snapshot is as fresh as it gets. */
  look?(): Promise<string | null>
  /** Asks the device what it knows, for `status`. Absent: the status is kept current. */
  check?(): Promise<void>
  /** This viewer's page went out of sight, or came back. */
  viewerHidden?(id: string, hidden: boolean): void
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
  /** May resolve when the device took it (a Chrome does); a pinch step paces on that. */
  dispatchInput(method: CdpInputCommand['method'], params: CdpInputCommand['params'], who?: ViewerWho): Promise<void> | void

  readonly viewport: { width: number; height: number }
  readonly viewportState: BrowserViewportState
  readonly processId: number | null

  /**
   * A USE's device state (pixel-instance.ts): live, or offline with the
   * sentence that says why. Absent on a Chrome — a page has no cable to pull.
   */
  readonly status?: UseStatus
  readonly statusListeners?: Set<(status: UseStatus) => void>
  /** This viewer's own reading of a status. Absent: every viewer reads the same. */
  statusFor?(status: UseStatus, who: ViewerWho): UseStatus
  /** The status a viewer who may not watch is left with; null when it may. */
  refusalFor?(who: ViewerWho): UseStatus | null
  /** A viewer arrived; the answer is its leaving. */
  enterViewer?(viewerId: string, who: ViewerWho): (() => void) | null
  /** This viewer holds control right now. Absent: the question does not arise. */
  mayDrive?(who: ViewerWho): boolean
  /** Input here needs a viewer with a name: a route with none is refused. */
  readonly needsViewer?: boolean
  /**
   * Where the page's text fields are and whether one has focus (page-fields.ts),
   * while someone watches. The listener gets the last report at once. Absent
   * on a use card: a device screen has no DOM to ask.
   */
  watchFields?(listener: (report: FieldReport) => void): () => void
  /** The viewer's paste: a page paste event, typed in if the page leaves it. Absent → Input.insertText. */
  paste?(text: string): Promise<void>
  /** Files the page is saving right now. Absent on a use card: a device screen saves nothing here. */
  activeDownloads?(): readonly ArrivingDownload[]
  /** The agent's hand on a screen: gestures in viewport points, resolved once the device took them. */
  act?(gestures: readonly Gesture[]): Promise<void>
}
