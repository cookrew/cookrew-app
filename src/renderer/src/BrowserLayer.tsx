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
}

/**
 * Hosts every browser's webviews permanently — offscreen while the browser
 * card only shows a thumbnail, repositioned over the card's screen rect as
 * the semantic-zoom full view once the card covers enough of the stage.
 * Webviews never remount between the two states, so pages keep their
 * session and `cookrew browser` automation keeps working while collapsed. Each
 * browser is a tab group: one webview per tab, all sharing the browser's
 * session partition. Thumbnails come from periodic capturePage() snapshots
 * of the active tab.
 */
export function BrowserLayer({
  browsers,
  lod,
  onThumb,
  isPhoneViewing
}: BrowserLayerProps): React.JSX.Element {
  usePopupTabOpener(browsers)
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
        />
      ))}
    </>
  )
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
  isPhoneViewing
}: {
  node: BrowserNodeData
  /** Screen rect to render the full browser at; null = thumbnail mode. */
  rect: ScreenRect | null
  onThumb: (id: string, dataUrl: string) => void
  isPhoneViewing: (browserId: string) => boolean
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
  isPhoneViewing
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
}): React.JSX.Element | null {
  const webviewRef = useRef<WebviewElement | null>(null)

  useEffect(() => {
    const webview = webviewRef.current
    if (webview) registerBrowserTab(browserId, browserName, tab.id, webview)
    return () => unregisterBrowserTab(browserId, tab.id)
  }, [browserId, browserName, tab.id])

  useEffect(() => {
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
  }, [tab.url])

  // Reflect in-page navigation and titles back into the workspace model so
  // the tab strip, address bar and `cookrew browser tabs` stay truthful.
  useEffect(() => {
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
  }, [tab.id, patchTab])

  // Thumbnail loop for the active tab: after loads and on a slow interval.
  // capturePage() only exists on real <webview>s (Electron renderer).
  // GPU protection: capture pauses while the window is hidden/occluded — EXCEPT
  // for a browser a phone is viewing, which must keep producing fresh frames
  // (the phone's live view) even with the desktop offscreen. A rejected capture
  // still backs off exponentially instead of hot-retrying a wedged GPU, so the
  // phone-viewing bypass can't spin a degraded GPU. did-stop-loading and the
  // interval both pass through the same shouldCapture() gate.
  useEffect(() => {
    if (!hasNativeWebview() || !visible) return
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
      void webview
        .capturePage()
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
  }, [browserId, tab.id, visible, onThumb, isPhoneViewing])

  // Never load Cookrew inside Cookrew: recursive embedding renders the whole
  // canvas (and its browsers, recursively) per layer and pegs the GPU.
  if (isSelfEmbedding(tab.url, window.location.origin)) {
    return visible ? (
      <div className="browser-body browser-blocked">
        <span>
          ⛔ This tab points Cookrew at itself ({shortUrl(tab.url)}) — recursive embedding is
          blocked because it melts the GPU. Open it in a real browser instead.
        </span>
      </div>
    ) : null
  }

  // PHONE (remote mode): the iframe renders file:// / PDFs / webview-only content
  // BLANK, so show the desktop's LIVE captured frame instead (mobile-browser-ux-
  // fix) — the primary display, polled while zoomed open. Fit-scaled, placeholder
  // until the first frame.
  if (isRemoteMode()) {
    return visible ? <MobileBrowserFrame browserId={browserId} open={zoomed} /> : null
  }
  // Demo tabs get a plain iframe — no capture backend, and demo URLs load fine.
  if (!hasNativeWebview()) {
    return visible ? <iframe src={tab.url} className="browser-body" title={tab.title || tab.url} /> : null
  }
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

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname !== '/' ? u.pathname : '')
  } catch {
    return url
  }
}
