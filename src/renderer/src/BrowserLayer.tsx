import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserNodeData, BrowserTab } from '../../shared/model'
import { activeBrowserTab, browserTabs } from '../../shared/model'
import {
  findBrowserTabByWebContentsId,
  registerBrowserTab,
  setBrowserActiveTab,
  unregisterBrowserTab
} from './browser-engine'
import { cookrew, hasNativeWebview, isRemoteMode } from './api'
import { MobileBrowserFrame } from './MobileBrowserFrame'
import { initialBackoff, recordFailure, recordSuccess, shouldCapture } from './capture-backoff'
import { isSelfEmbedding } from './self-embed'
import type { ScreenRect } from './zoom-lod'
import type { LodLayout } from './zoom-lod'
import { useCanvasUi } from './canvas-ui'
import { CrIcon } from './icons'
import { browserRenderMode, type StreamClient } from './browser-stream'

const THUMB_INTERVAL_MS = 5000
const THUMB_WIDTH = 512

/** Electron <webview> — typed loosely since it's provided by the runtime. */
type WebviewElement = HTMLElement & {
  src: string
  loadURL: (url: string) => Promise<void>
  getURL: () => string
  getTitle: () => string
  getWebContentsId: () => number
  executeJavaScript: (code: string) => Promise<unknown>
  capturePage: () => Promise<{ resize: (o: { width: number }) => { toDataURL: () => string } }>
  addEventListener: HTMLElement['addEventListener']
}

interface BrowserLayerProps {
  /** SHARED overlay arbitration (App-owned, spans terminals + browsers). */
  lod: LodLayout
  browsers: BrowserNodeData[]
  onThumb: (id: string, dataUrl: string) => void
  /** Is a phone currently viewing this browser (keeps capture alive while hidden)? */
  isPhoneViewing: (browserId: string) => boolean
  /** Fixed-at-launch renderer ownership, shared with card thumbnail policy. */
  interactiveCapability: InteractiveBrowserCapability | null
}

/**
 * Flag off, hosts every browser's legacy webviews permanently — offscreen while
 * its card shows a thumbnail, then repositioned over the zoomed card. Flag on,
 * the same shell renders the node-owned headless stream on desktop and phone.
 * The unresolved capability renders a neutral body so a transient second page
 * instance can never start before ownership is known.
 */
export function BrowserLayer({
  browsers,
  lod,
  onThumb,
  isPhoneViewing,
  interactiveCapability
}: BrowserLayerProps): React.JSX.Element {
  usePopupTabOpener(browsers)
  const interactiveBrowser = interactiveCapability?.enabled ?? null
  // SHARED arbitration with terminal overlays (Magpie E2: a per-kind hook
  // let a browser view stack over the zoomed terminal and steal every tap).
  const { activeIds, rects } = lod
  return (
    <>
      {browsers.map((p) => (
        <BrowserHost
          key={p.id}
          node={p}
          rect={activeIds.has(p.id) ? (rects[p.id] ?? null) : null}
          onThumb={onThumb}
          isPhoneViewing={isPhoneViewing}
          interactiveBrowser={interactiveBrowser}
          desktopStreamToken={interactiveCapability?.desktopToken ?? null}
        />
      ))}
    </>
  )
}

export interface InteractiveBrowserCapability {
  enabled: boolean
  desktopToken: string | null
}

/** Resolve fixed-at-launch ownership and its desktop-only stream credential once. */
export function useInteractiveBrowserCapability(): InteractiveBrowserCapability | null {
  const [capability, setCapability] = useState<InteractiveBrowserCapability | null>(null)
  useEffect(() => {
    let disposed = false
    const api = cookrew()
    void api
      .interactiveBrowserEnabled()
      .then(async (enabled) => {
        if (!enabled || !hasNativeWebview()) {
          if (!disposed) setCapability({ enabled, desktopToken: null })
          return
        }
        let desktopToken: string | null = null
        try {
          desktopToken = await api.browserStreamToken()
        } catch (error) {
          console.error('[browser-stream] failed to resolve the desktop stream credential:', error)
        }
        if (!disposed) setCapability({ enabled, desktopToken })
      })
      .catch((error) => {
        // Fail closed: without an ownership answer, mounting a webview could
        // create a second page/profile while headless mode is actually on.
        console.error('[browser-stream] failed to resolve browser ownership:', error)
      })
    return () => {
      disposed = true
    }
  }, [])
  return capability
}

/**
 * window.open / target=_blank inside a browser page: the main process denies
 * the native window and forwards the URL here with the source webContents id;
 * we append it as a new active tab of the owning browser.
 */
function usePopupTabOpener(browsers: BrowserNodeData[]): void {
  const browsersRef = useRef(browsers)
  browsersRef.current = browsers
  useEffect(() => {
    return cookrew().onBrowserOpenTab(({ webContentsId, url }) => {
      const located = findBrowserTabByWebContentsId(webContentsId)
      if (!located) return
      const node = browsersRef.current.find((p) => p.id === located.browserId)
      if (!node) return
      const tab: BrowserTab = { id: crypto.randomUUID(), url, title: '' }
      void cookrew().updateNode(node.id, {
        tabs: [...browserTabs(node), tab],
        activeTabId: tab.id,
        url
      })
    })
  }, [])
}

function BrowserHost({
  node,
  rect,
  onThumb,
  isPhoneViewing,
  interactiveBrowser,
  desktopStreamToken
}: {
  node: BrowserNodeData
  /** Screen rect to render the full browser at; null = thumbnail mode. */
  rect: ScreenRect | null
  onThumb: (id: string, dataUrl: string) => void
  isPhoneViewing: (browserId: string) => boolean
  interactiveBrowser: boolean | null
  desktopStreamToken: string | null
}): React.JSX.Element {
  const { zoomBack } = useCanvasUi()
  const tabs = browserTabs(node)
  const activeTab = activeBrowserTab(node)
  const [address, setAddress] = useState(activeTab.url)
  const nodeRef = useRef(node)
  nodeRef.current = node

  useEffect(() => {
    setAddress(activeTab.url)
  }, [activeTab.id, activeTab.url])

  // Keep the engine registry pointed at the active tab so `cookrew browser`
  // commands target it.
  useEffect(() => {
    setBrowserActiveTab(node.id, activeTab.id)
  }, [node.id, activeTab.id])

  const patchTab = useCallback((tabId: string, patch: Partial<BrowserTab>): void => {
    const current = nodeRef.current
    const currentTabs = browserTabs(current)
    const existing = currentTabs.find((t) => t.id === tabId)
    if (!existing) return
    const updated = { ...existing, ...patch }
    if (updated.url === existing.url && updated.title === existing.title) return
    const nextTabs = currentTabs.map((t) => (t.id === tabId ? updated : t))
    const isActive = activeBrowserTab(current).id === tabId
    void cookrew().updateNode(current.id, {
      tabs: nextTabs,
      ...(isActive ? { url: updated.url } : {})
    })
  }, [])

  const selectTab = (tab: BrowserTab): void => {
    void cookrew().updateNode(node.id, { activeTabId: tab.id, url: tab.url })
  }

  const closeTab = (tab: BrowserTab): void => {
    const current = nodeRef.current
    const currentTabs = browserTabs(current)
    if (currentTabs.length === 1) return
    const index = currentTabs.findIndex((t) => t.id === tab.id)
    const remaining = currentTabs.filter((t) => t.id !== tab.id)
    const wasActive = activeBrowserTab(current).id === tab.id
    const nextActive = wasActive ? remaining[Math.min(index, remaining.length - 1)] : activeBrowserTab(current)
    void cookrew().updateNode(current.id, {
      tabs: remaining,
      activeTabId: nextActive.id,
      url: nextActive.url
    })
  }

  const addTab = (): void => {
    const tab: BrowserTab = { id: crypto.randomUUID(), url: 'about:blank', title: '' }
    void cookrew().updateNode(node.id, {
      tabs: [...browserTabs(nodeRef.current), tab],
      activeTabId: tab.id,
      url: tab.url
    })
  }

  const commitAddress = (): void => {
    if (address !== activeTab.url) patchTab(activeTab.id, { url: address })
  }

  return (
    <div
      className={rect ? 'browser-lod' : 'browser-offscreen'}
      style={rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : undefined}
    >
      <div className="popout browser-popout">
        <div className="popout-header">
          <span className="node-dot" />
          <span className="popout-title">{node.name}</span>
          <input
            className="browser-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitAddress()
            }}
          />
          <button
            className="cr-btn sm popout-close"
            title="Back to canvas"
            aria-label="Back to canvas"
            onClick={zoomBack}
          >
            <CrIcon name="collapse" />
          </button>
          <button
            className="cr-btn sm popout-kill"
            title="Close browser card (⌘W)"
            onClick={() => {
              zoomBack()
              void cookrew().removeNode(node.id)
            }}
          >
            <CrIcon name="close" />
          </button>
        </div>
        <div className="browser-tabstrip">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`browser-tab${tab.id === activeTab.id ? ' active' : ''}`}
              title={tab.url}
              onClick={() => selectTab(tab)}
            >
              <span className="browser-tab-title">{tab.title || shortUrl(tab.url)}</span>
              {tabs.length > 1 && (
                <button
                  className="browser-tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button className="browser-tab-add" title="New tab" onClick={addTab}>
            +
          </button>
        </div>
        {tabs.map((tab) => (
          <BrowserTabView
            key={tab.id}
            browserId={node.id}
            browserName={node.name}
            tab={tab}
            visible={tab.id === activeTab.id}
            zoomed={rect !== null}
            onThumb={onThumb}
            patchTab={patchTab}
            isPhoneViewing={isPhoneViewing}
            interactiveBrowser={interactiveBrowser}
            desktopStreamToken={desktopStreamToken}
          />
        ))}
      </div>
    </div>
  )
}

function BrowserTabView({
  browserId,
  browserName,
  tab,
  visible,
  zoomed,
  onThumb,
  patchTab,
  isPhoneViewing,
  interactiveBrowser,
  desktopStreamToken
}: {
  browserId: string
  browserName: string
  tab: BrowserTab
  visible: boolean
  /** True while the browser popout is zoomed open (drives the phone frame poll). */
  zoomed: boolean
  isPhoneViewing: (browserId: string) => boolean
  onThumb: (id: string, dataUrl: string) => void
  patchTab: (tabId: string, patch: Partial<BrowserTab>) => void
  interactiveBrowser: boolean | null
  desktopStreamToken: string | null
}): React.JSX.Element | null {
  const webviewRef = useRef<WebviewElement | null>(null)

  useEffect(() => {
    if (interactiveBrowser !== false) return
    const webview = webviewRef.current
    if (webview) registerBrowserTab(browserId, browserName, tab.id, webview)
    return () => unregisterBrowserTab(browserId, tab.id)
  }, [browserId, browserName, tab.id, interactiveBrowser])

  useEffect(() => {
    if (interactiveBrowser !== false) return
    const webview = webviewRef.current
    if (!webview) return
    try {
      // getURL/loadURL throw until the webview reaches dom-ready.
      if (webview.getURL() !== tab.url) {
        void webview.loadURL(tab.url).catch(() => undefined)
      }
    } catch {
      // not attached yet — the src attribute already points at tab.url
    }
  }, [tab.url, interactiveBrowser])

  // Reflect in-page navigation and titles back into the workspace model so
  // the tab strip, address bar and `cookrew browser tabs` stay truthful.
  useEffect(() => {
    if (interactiveBrowser !== false) return
    const webview = webviewRef.current
    if (!webview) return
    const onNavigate = (event: Event): void => {
      const url = (event as Event & { url?: string }).url
      if (url) patchTab(tab.id, { url })
    }
    const onTitle = (event: Event): void => {
      const title = (event as Event & { title?: string }).title
      if (title) patchTab(tab.id, { title })
    }
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    webview.addEventListener('page-title-updated', onTitle)
    return () => {
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigate)
      webview.removeEventListener('page-title-updated', onTitle)
    }
  }, [tab.id, patchTab, interactiveBrowser])

  // Thumbnail loop for the active tab: after loads and on a slow interval.
  // capturePage() only exists on real <webview>s (Electron renderer).
  // GPU protection: capture pauses while the window is hidden/occluded — EXCEPT
  // for a browser a phone is viewing, which must keep producing fresh frames
  // (the phone's live view) even with the desktop offscreen. A rejected capture
  // still backs off exponentially instead of hot-retrying a wedged GPU, so the
  // phone-viewing bypass can't spin a degraded GPU. did-stop-loading and the
  // interval both pass through the same shouldCapture() gate.
  useEffect(() => {
    if (interactiveBrowser !== false || !hasNativeWebview() || !visible) return
    const webview = webviewRef.current
    if (!webview) return
    let disposed = false
    let reported = false
    let backoff = initialBackoff
    const capture = (): void => {
      const gate = {
        documentHidden: document.hidden,
        phoneViewing: isPhoneViewing(browserId),
        backoff,
        now: Date.now()
      }
      if (!shouldCapture(gate)) return
      // capturePage() THROWS SYNCHRONOUSLY when the webview isn't attached /
      // dom-ready — a sync throw the .catch() below never sees, so it surfaced
      // as an uncaught "WebView must be attached to the DOM" flood. Guard it;
      // the next interval / did-stop-loading retries once the page is ready.
      let pending: ReturnType<WebviewElement['capturePage']>
      try {
        pending = webview.capturePage()
      } catch {
        return
      }
      void pending
        .then((image) => {
          backoff = recordSuccess()
          if (!disposed) onThumb(browserId, image.resize({ width: THUMB_WIDTH }).toDataURL())
        })
        .catch((error: unknown) => {
          backoff = recordFailure(backoff, Date.now())
          if (!reported) {
            reported = true
            console.error(`browser thumbnail capture failed (${browserId}):`, error)
          }
        })
    }
    const onStop = (): void => capture()
    const onVisibility = (): void => {
      // Back from hidden/occluded: refresh immediately rather than waiting out
      // the interval. (While still hidden, only a phone-viewed browser keeps
      // capturing — handled by shouldCapture on the interval tick.)
      if (!document.hidden) capture()
    }
    webview.addEventListener('did-stop-loading', onStop)
    document.addEventListener('visibilitychange', onVisibility)
    const timer = setInterval(capture, THUMB_INTERVAL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
      webview.removeEventListener('did-stop-loading', onStop)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [browserId, tab.id, visible, onThumb, isPhoneViewing, interactiveBrowser])

  const client: StreamClient = isRemoteMode() ? 'remote' : hasNativeWebview() ? 'desktop' : 'demo'
  const renderMode = browserRenderMode({
    interactive: interactiveBrowser,
    client,
    selfEmbedding: isSelfEmbedding(tab.url, window.location.origin)
  })

  switch (renderMode) {
    case 'pending':
      return visible ? <BrowserCapabilityLoading browserId={browserId} /> : null
    case 'headless-stream':
      return visible ? (
        <MobileBrowserFrame
          browserId={browserId}
          open={zoomed}
          streamEnabled
          desktopStreamToken={client === 'desktop' ? desktopStreamToken : null}
          fallback="loading"
        />
      ) : null
    case 'legacy-blocked':
      // Never load Cookrew inside Cookrew in a legacy renderer: recursive
      // embedding renders the whole canvas per layer and pegs the GPU.
      return visible ? (
        <div className="browser-body browser-blocked">
          <span>
            ⛔ This tab points Cookrew at itself ({shortUrl(tab.url)}) — recursive embedding is
            blocked because it melts the GPU. Open it in a real browser instead.
          </span>
        </div>
      ) : null
    case 'legacy-thumb':
      return visible ? (
        <MobileBrowserFrame
          browserId={browserId}
          open={zoomed}
          streamEnabled={false}
          desktopStreamToken={null}
          fallback="thumb"
        />
      ) : null
    case 'legacy-iframe':
      return visible ? <iframe src={tab.url} className="browser-body" title={tab.title || tab.url} /> : null
    case 'legacy-webview':
      // Preserve the original Electron webview branch exactly when flag off.
      return (
        <webview
          ref={(el: unknown) => {
            webviewRef.current = el as WebviewElement | null
          }}
          src={tab.url}
          className={visible ? 'browser-body' : 'browser-body browser-body-hidden'}
          partition={`persist:browser-${browserId}`}
          allowpopups="true"
        />
      )
  }
}

function BrowserCapabilityLoading({ browserId }: { browserId: string }): React.JSX.Element {
  return (
    <div
      className="browser-body browser-frame nodrag nowheel"
      data-browser-id={browserId}
      data-stream-status="idle"
      data-stream-state="loading"
      data-frame-seq="none"
      data-last-frame-at="none"
      data-last-frame-fresh="false"
      data-interactive="false"
    >
      <div className="browser-frame-loading" role="status" aria-live="polite">
        <span className="browser-frame-glyph">
          <CrIcon name="browser" />
        </span>
        <span className="cr-kicker">loading browser…</span>
      </div>
    </div>
  )
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname !== '/' ? u.pathname : '')
  } catch {
    return url
  }
}
