import { useEffect, useRef, useState } from 'react'
import { PROXY_INIT, PROXY_NAVIGATE, PROXY_NEEDS_SCREEN, PROXY_PAGE_MIME, PROXY_READ, proxyPath } from '../../../shared/web-proxy'
import { deviceSeat } from '../device-seat'
import { heldScope, subscribeMachineScope } from '../machine-scope'
import { fetchBrowserPage } from '../remote-api'
import { proxyDocument, proxyTargetOf, type ReadProxyAsset } from './proxy-document'
import './proxy-view.css'

const MAX_FRAME_READS = 128
const FRAME_ERROR = 'This page could not be loaded. Reload it or choose Screen.'

type FrameState =
  | { phase: 'loading' }
  | { phase: 'ready'; src: string }
  | { phase: 'error'; message: string }

function useProxyFrame(browserId: string, pageUrl: string, reload: number, navigate: (url: string) => void) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [state, setState] = useState<FrameState>({ phase: 'loading' })
  const [needsScreen, setNeedsScreen] = useState(false)
  useEffect(() => {
    setState({ phase: 'loading' })
    setNeedsScreen(false)
    const controller = new AbortController()
    const stillHere = heldScope()
    const seat = deviceSeat()
    const active = () => !controller.signal.aborted && stillHere() && deviceSeat() === seat
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    let objectUrl: string | null = null
    let documentUrl: URL | null = null
    let framePort: MessagePort | null = null
    let frameReads = 0
    const read: ReadProxyAsset = (path, method, options = {}) => {
      if (!active()) return Promise.reject(new Error(FRAME_ERROR))
      const query = new URLSearchParams()
      if (options.omitCookies) query.set('cookies', 'omit')
      if (options.frameFormat) query.set('format', 'frame')
      if (options.origin) query.set('origin', options.origin)
      return fetchBrowserPage(query.size ? `${path}?${query}` : path, method, controller.signal)
    }
    const releaseFrame = () => {
      controller.abort()
      framePort?.close()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    const stopFollowing = subscribeMachineScope(() => {
      releaseFrame()
      setState({ phase: 'loading' })
    })
    const onFrameMessage = (port: MessagePort, data: MessageEvent['data']): void => {
      if (!active() || documentUrl === null) return
      if (data?.type === PROXY_NEEDS_SCREEN) {
        setNeedsScreen(true)
        return
      }
      const target = proxyTargetOf(data?.path, browserId)
      if (data?.type === PROXY_NAVIGATE && target) navigate(target)
      if (data?.type !== PROXY_READ || !Number.isSafeInteger(data.id)) return
      const { id, method } = data
      const origin = documentUrl.origin
      if (!target || new URL(target).origin !== origin || (method !== 'GET' && method !== 'HEAD') || frameReads >= MAX_FRAME_READS) {
        port.postMessage({ id, result: null })
        return
      }
      frameReads++
      void replyToFrame(port, id, read(data.path, method, { origin, frameFormat: true }), method, active)
    }
    const message = (event: MessageEvent): void => {
      if (!active() || framePort !== null || documentUrl === null || event.origin !== 'null' || event.source !== frame.current?.contentWindow) return
      if (event.data?.type !== PROXY_INIT || event.data.nonce !== nonce || event.ports.length !== 1) return
      const [port] = event.ports
      framePort = port
      port.onmessage = ({ data }) => onFrameMessage(port, data)
    }
    window.addEventListener('message', message)
    void loadDocument(read, browserId, pageUrl, nonce).then((page) => {
      if (!active()) return
      documentUrl = new URL(page.url)
      objectUrl = URL.createObjectURL(new Blob([page.html], { type: 'text/html;charset=utf-8' }))
      setState({ phase: 'ready', src: objectUrl })
    }).catch((error: unknown) => {
      if (active()) setState({ phase: 'error', message: error instanceof Error ? error.message : FRAME_ERROR })
    })
    return () => {
      releaseFrame()
      stopFollowing()
      window.removeEventListener('message', message)
    }
  }, [browserId, pageUrl, reload, navigate])
  return { frame, state, needsScreen }
}

async function replyToFrame(port: MessagePort, id: number, pending: Promise<Response>, method: string, active: () => boolean): Promise<void> {
  try {
    const response = await pending
    const { status } = response
    const bytes = method === 'HEAD' || status === 204 || status === 205 ? null : await response.arrayBuffer()
    const type = response.headers.get('content-type') ?? 'application/octet-stream'
    if (active()) port.postMessage({ id, result: { status, type, bytes } }, bytes ? [bytes] : [])
  } catch {
    if (active()) port.postMessage({ id, result: null })
  }
}

async function loadDocument(read: ReadProxyAsset, browserId: string, pageUrl: string, nonce: string) {
  const response = await read(proxyPath(browserId, pageUrl), 'GET', { frameFormat: true })
  if (response.status === 401) throw new Error('This page requires an owner pairing.')
  if (response.status === 403) throw new Error('This address is blocked for this card.')
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== PROXY_PAGE_MIME) {
    throw new Error(FRAME_ERROR)
  }
  const data: unknown = await response.json()
  if (!data || typeof data !== 'object' || !('html' in data) || typeof data.html !== 'string') throw new Error(FRAME_ERROR)
  return proxyDocument(data.html, pageUrl, browserId, nonce, read)
}

export function ProxyView({ browserId, cardUrl, actions, onScreen }: {
  browserId: string
  cardUrl: string
  actions?: React.ReactNode
  onScreen: () => void
}): React.JSX.Element {
  const [pageUrl, navigate] = useState(cardUrl)
  const [reload, setReload] = useState(0)
  const { frame, state, needsScreen } = useProxyFrame(browserId, pageUrl, reload, navigate)
  return (
    <div className="browser-body proxy-view nodrag nowheel" aria-busy={state.phase === 'loading'}>
      <div className="proxy-toolbar" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <span className="proxy-address" title={pageUrl}>{pageUrl}</span>
        <button type="button" className="browser-frame-btn" onClick={() => setReload((value) => value + 1)}>Reload</button>
        <button type="button" className="browser-frame-btn" onClick={onScreen}>Screen</button>
        {actions}
      </div>
      {needsScreen && <p className="proxy-notice" role="status">Some parts of this page require Screen.</p>}
      {state.phase === 'error' && <p className="proxy-notice" role="alert">{state.message}</p>}
      {state.phase === 'loading' && <p className="proxy-notice" role="status">Loading page…</p>}
      <iframe
        ref={frame}
        className="proxy-frame"
        title="Browser page"
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        src={state.phase === 'ready' ? state.src : 'about:blank'}
      />
    </div>
  )
}
