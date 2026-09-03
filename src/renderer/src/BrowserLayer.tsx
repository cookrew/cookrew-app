import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserNodeData, BrowserTab } from '../../shared/model'
import { activeBrowserTab, browserTabs } from '../../shared/model'
import { resolveAddress } from '../../shared/address-bar'
import {
  findBrowserTabByWebContentsId,
  registerBrowserTab,
  setBrowserActiveTab,
  unregisterBrowserTab
} from './browser-engine'
import { cookrew, hasNativeWebview, isRemoteMode } from './api'
import { MobileBrowserFrame } from './MobileBrowserFrame'
import { OpenExternal } from './nodes/OpenExternal'
import {
  initialBackoff,
  recordFailure,
  recordSuccess,
  shouldCapture,
  thumbNeedsCapture
} from './capture-backoff'
import { isSelfEmbedding } from './self-embed'
import type { ScreenRect } from './zoom-lod'
import type { LodLayout } from './zoom-lod'
import { useCanvasUi } from './canvas-ui'
import { CrIcon } from './icons'
import { browserRenderMode, nextCapability, type StreamClient } from './browser-stream'
import { browserHostsToRender } from './browser-host-policy'

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
  const { activeIds, rects, primaryId } = lod
  const renderedBrowsers = browserHostsToRender(browsers, isRemoteMode(), primaryId)
  return (
    <>
      {renderedBrowsers.map((p) => (
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
    let latest = 0
    const api = cookrew()
    const adopt = (enabled: boolean, desktopToken: string | null): void => {
      if (disposed) return
      setCapability((prev) => {
        // Never DOWNGRADE the surface that can mount a webview: main's flag
        // is fixed per launch so this cannot fire today, and if that ever
        // changes, this is the line that keeps a legacy webview from opening
        // a second page beside a live headless one.
        if (hasNativeWebview() && prev?.enabled === true && !enabled) return prev
        return nextCapability(prev, { enabled, desktopToken })
      })
    }
    const resolve = (): void => {
      const seq = ++latest
      void api
        .interactiveBrowserEnabled()
        .then(async (enabled) => {
          // Latest wins: rapid foreground flips on a slow link put two
          // answers in flight, and the older one must never overwrite.
          if (seq !== latest) return
          // No answer is not an answer (a captive portal's 200, a stranger
          // on the port): keep what we know rather than adopting undefined.
          if (typeof enabled !== 'boolean') return
          if (!enabled || !hasNativeWebview()) {
            adopt(enabled, null)
            return
          }
          let desktopToken: string | null = null
          try {
            desktopToken = await api.browserStreamToken()
          } catch (error) {
            console.error('[browser-stream] failed to resolve the desktop stream credential:', error)
          }
          if (seq !== latest) return
          adopt(enabled, desktopToken)
        })
        .catch((error) => {
          // Fail closed: without an ownership answer, mounting a webview could
          // create a second page/profile while headless mode is actually on.
          // A previously-resolved answer is kept — staleness beats a null.
          console.error('[browser-stream] failed to resolve browser ownership:', error)
        })
    }
    resolve()
    // "Fixed at launch" means the SERVER's launch, not this page's. A phone
    // tab outlives app restarts — the shared stream heals and the canvas
    // repopulates — but a capability frozen at first mount left the phone
    // rendering the dead thumb fallback ("BROWSER PREVIEW" on black) against
    // a server that had long since gone headless. Re-ask on foreground and
    // network return, the same pair the canvas resync listens to.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') resolve()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', resolve)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', resolve)
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
  const { zoomBack, requestClose } = useCanvasUi()
  const tabs = browserTabs(node)
  const activeTab = activeBrowserTab(node)
  const [address, setAddress] = useState(activeTab.url)
  /** The title plate swaps to the editable address field only while true. */
  const [editingAddress, setEditingAddress] = useState(false)
  /**
   * The tab strip. Shown by default so multi-tab browsing is unchanged, and
   * collapsible from the count pill for when the page matters more than the
   * tabs. It only exists above one tab, which is where the row was pure
   * overhead: a single chip restating the title now in the row above it.
   */
  const [tabsOpen, setTabsOpen] = useState(true)
  const nodeRef = useRef(node)
  nodeRef.current = node

  useEffect(() => {
    setAddress(activeTab.url)
  }, [activeTab.id, activeTab.url])

  // Navigating or switching tabs ends editing: the field would otherwise keep
  // showing what was typed for a page the pane has already left.
  useEffect(() => {
    setEditingAddress(false)
  }, [activeTab.id, activeTab.url])

  // Reopening on the next split is the useful default, so dropping back to one
  // tab restores the shown state rather than remembering a collapse that only
  // applied to a strip the user can no longer see.
  useEffect(() => {
    if (tabs.length < 2) setTabsOpen(true)
  }, [tabs.length])

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

  // Resolve what was TYPED into what we NAVIGATE to ("github.com" → the real
  // URL, unaddressable text → search). The input re-syncs from the tab url, so
  // the resolved form lands back in the bar the way a browser's does.
  const commitAddress = (): void => {
    const resolved = resolveAddress(address)
    if (resolved === null) return
    if (resolved !== activeTab.url) patchTab(activeTab.id, { url: resolved })
    else setAddress(resolved)
  }

  return (
    <div
      className={rect ? 'browser-lod' : 'browser-offscreen'}
      style={rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : undefined}
    >
      <div className="popout browser-popout">
        {/* TITLE ROW — one row, not two. The page's own title is the identity;
            the node name ("Browser") labelled nothing, and the address was a
            truncated raw field sitting a row away from the title it belongs to.
            Tapping the plate turns it into that field, so editing costs a tap
            instead of a permanent row. */}
        <div className="popout-header browser-header">
          <span className="node-dot" />
          {editingAddress ? (
            <input
              className="browser-address"
              value={address}
              autoFocus
              aria-label="Address"
              onChange={(e) => setAddress(e.target.value)}
              onBlur={() => {
                setEditingAddress(false)
                setAddress(activeTab.url)
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  commitAddress()
                  setEditingAddress(false)
                }
                if (e.key === 'Escape') {
                  setAddress(activeTab.url)
                  setEditingAddress(false)
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="browser-idplate"
              title={activeTab.url}
              aria-label={`Address: ${activeTab.url}`}
              onClick={() => {
                setAddress(activeTab.url)
                setEditingAddress(true)
              }}
            >
              <span className="browser-idplate-title">{pageHeading(activeTab)}</span>
              {pageSubhead(activeTab) && (
                <span className="browser-idplate-host">{pageSubhead(activeTab)}</span>
              )}
            </button>
          )}
          {/* Tabs cost nothing until there is more than one: the strip below is
              opened from this pill, so the common single-tab case is chrome-free. */}
          {tabs.length > 1 && (
            <button
              className={`cr-btn sm browser-tabs-pill${tabsOpen ? ' on' : ''}`}
              aria-expanded={tabsOpen}
              title={`${tabs.length} tabs`}
              onClick={() => setTabsOpen((open) => !open)}
            >
              <CrIcon name="browser" />
              {tabs.length}
            </button>
          )}
          <button className="cr-btn sm" title="New tab" aria-label="New tab" onClick={addTab}>
            <CrIcon name="plus" />
          </button>
          {/* "Open in browser" is NOT here: in full view it lives in the dock's
              bottom-right, where the tool group would be (see Dock). The header
              keeps only what re-frames the card itself. */}
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
            onClick={() => requestClose(node.id)}
          >
            <CrIcon name="close" />
          </button>
        </div>
        {tabsOpen && tabs.length > 1 && (
          <div className="browser-tabstrip">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`browser-tab${tab.id === activeTab.id ? ' active' : ''}`}
                title={tab.url}
                onClick={() => selectTab(tab)}
              >
                <span className="browser-tab-title">{tab.title || shortUrl(tab.url)}</span>
                <button
                  className="browser-tab-close"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
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
    // A thumbnail is only stale after the page (re)loads. `dirty` starts true so
    // the first tick captures; a successful capture clears it, and a fresh
    // did-stop-loading (navigation/reload) sets it again. This is the latency
    // fix: without it, EVERY visible browser re-captured every interval — 40
    // static file:// docs on a zoomed-out canvas meant 40 GPU readbacks +
    // JPEG encodes every 5s for pixels that never changed. Now each captures
    // once per load. capturePage() is a compositor stall; not doing it for an
    // unchanged page is the whole win.
    let dirty = true
    const capture = (): void => {
      // A phone actively viewing this browser is a LIVE consumer of the thumb —
      // it must keep refreshing even without a navigation, so it bypasses the
      // dirty gate (matching shouldCapture's phone bypass). Every other browser
      // captures once per load.
      const phoneViewing = isPhoneViewing(browserId)
      if (!thumbNeedsCapture({ dirty, phoneViewing })) return
      const gate = {
        documentHidden: document.hidden,
        phoneViewing,
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
          // Clear dirty only on a real capture — a failed one (below) leaves it
          // set so the next tick retries.
          dirty = false
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
    // Navigation/reload = new pixels: mark dirty and grab one now.
    const onStop = (): void => {
      dirty = true
      capture()
    }
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
          actions={zoomed ? <OpenExternal url={tab.url} className="browser-frame-btn" /> : null}
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
          actions={zoomed ? <OpenExternal url={tab.url} className="browser-frame-btn" /> : null}
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

/** Host alone — the recognisable half of an address, without the path noise. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * The title row's two lines. The page's own title is what a person recognises,
 * so it leads; the host sits under it as provenance. A tab with no title yet
 * (still loading, or a bare `about:`) leads with the address instead of showing
 * an empty line, and the host line is dropped whenever it would just repeat it.
 */
function pageHeading(tab: BrowserTab): string {
  const title = tab.title?.trim()
  return title && title.length > 0 ? title : shortUrl(tab.url)
}

function pageSubhead(tab: BrowserTab): string | null {
  const heading = pageHeading(tab)
  const host = hostOf(tab.url)
  return host && host !== heading ? host : null
}
