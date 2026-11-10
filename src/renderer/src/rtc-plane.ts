/**
 * WHICH REQUESTS RIDE THE DIRECT LINK (path/rtc-link.ts).
 *
 * The WebRTC plane keeps the relay's URLs: the page still composes
 * `/relay/@user/desktop/<id>/api/...`, and images, links and anything else
 * that is not a request this module carries keep loading over the relay. The
 * two openers that matter — the plane-aware fetch and the event streams —
 * ask here first, and when the plane is the link they strip the base and
 * send the Mac path over the data channel.
 */

import { apiPath, apiRequestInit, clientBase } from './api-base'
import { registerScopeState, relayHeadersFor } from './machine-scope'
import { authHeaders, tokenParam } from './auth-gate'
import { BridgeWebSocket } from './path/bridge-socket'
import { planeFetch } from './plane-fetch'
import { dataPlane } from './data-plane'
import { RtcEventSource, type RtcLink } from './path/rtc-link'
import { socketUrl } from './browser-stream'
import { watchStream } from './stream-watch'

let current: RtcLink | null = null

export const rtcLink = (): RtcLink | null => (current?.isOpen() ? current : null)
export const setRtcLink = (link: RtcLink | null): void => {
  current = link
}

// The direct link is to ONE machine. Entering another closes it: left open it
// would carry the next machine's requests to the last one.
registerScopeState(
  'rtc link',
  () => {
    const link = current
    current = null
    link?.close('another machine was entered')
  },
  'stop'
)

/**
 * The machine's own path for a request URL, or null when the URL is not one
 * the link carries: a URL outside the machine's relay address (the registry's
 * own routes, another origin), or on a page with no relay a URL that is not a
 * path on this origin. What is left once the relay address is taken off is the
 * path the machine sees, as the relay itself hands it on (v2-canvas-relay.ts).
 */
export const linkPath = (url: string, base: string = clientBase()): string | null => {
  if (base) return url.startsWith(`${base}/`) ? url.slice(base.length) : null
  return !url.startsWith('/') || url.startsWith('//') ? null : url
}

/** Is this page on cookrew.dev's relay right now? It is the one plane behind an ingress. */
const onRelay = (): boolean => dataPlane().origin === '' && clientBase() !== ''

/** The link to use for this URL right now, with its Mac path; null for the ordinary way. */
export const viaLink = (url: string): { link: RtcLink; path: string } | null => {
  if (dataPlane().transport !== 'rtc') return null
  const link = rtcLink()
  const path = linkPath(url)
  return link && path ? { link, path } : null
}

/** A request body the link can carry, or undefined when only a real fetch can (a FormData upload). */
export const linkBody = async (body: BodyInit | null | undefined): Promise<Uint8Array | null | undefined> => {
  if (body === null || body === undefined) return null
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  return undefined
}

/** Plain header pairs, lowercased, out of whatever a caller passed. */
export const linkHeaders = (headers: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  new Headers(headers).forEach((value, key) => void (out[key.toLowerCase()] = value))
  return out
}

/**
 * `new WebSocket(...)` for a scoped URL, or the same socket on its own data
 * channel when the plane is the link. The relay carries no WebSocket at all,
 * so on the link this is the only way the browser card's live view reaches a
 * phone opened at cookrew.dev.
 */
export const openWebSocket = (scopedUrl: string): WebSocket => {
  const routed = viaLink(scopedUrl)
  if (routed) return routed.link.openSocket(tokenParam(routed.path)) as unknown as WebSocket
  // ON THE RELAY a WebSocket goes nowhere: the relay forwards requests and
  // streams, never an upgrade. The same socket is bridged over those two
  // (path/bridge-socket.ts, main/socket-bridge.ts). The Mac adds the token to
  // the socket it dials, from the header the bridge arrived with.
  const path = onRelay() ? linkPath(scopedUrl) : null
  if (path) return openBridgedSocket(path) as unknown as WebSocket
  return new WebSocket(socketUrl(window.location.origin, tokenParam(scopedUrl)))
}

/** The socket at a Mac path, as an event stream down and POSTs up. */
export const openBridgedSocket = (path: string): BridgeWebSocket =>
  new BridgeWebSocket({
    stream: (resume) =>
      openEventSource(
        resume
          ? apiPath(`/api/socket-bridge?resume=${encodeURIComponent(resume.id)}&after=${resume.after}`)
          : apiPath(`/api/socket-bridge?path=${encodeURIComponent(path)}&v=2`)
      ),
    post: async (id, body, signal) => {
      const response = await planeFetch(apiPath(`/api/socket-bridge/${id}`), {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal
      })
      if (response.ok) return 'ok'
      // The relay busy or the Mac's line down goes again; a refusal will not change.
      return response.status >= 500 || response.status === 429 ? 'retry' : 'gone'
    },
    watch: watchNetwork
  })

/** Anything that says the phone's network may have moved under the page. */
const watchNetwork = (changed: () => void): (() => void) => {
  const connection = (navigator as Navigator & { connection?: EventTarget }).connection
  const visible = (): void => {
    if (!document.hidden) changed()
  }
  window.addEventListener('online', changed)
  document.addEventListener('visibilitychange', visible)
  connection?.addEventListener?.('change', changed)
  return () => {
    window.removeEventListener('online', changed)
    document.removeEventListener('visibilitychange', visible)
    connection?.removeEventListener?.('change', changed)
  }
}

/**
 * The same stream, taken by fetch on the relay. `new EventSource` cannot set a
 * header, and a URL through cookrew.dev reaches the ingress log, so here the
 * pairing token goes as a header and the reader is the one the link already has.
 */
const headerStream = (url: string): Pick<RtcLink, 'request'> => ({
  request: async ({ method, headers, signal }) => {
    // The relay's own stream: the same request options and the same account session as any relayed call.
    const response = await fetch(url, { method, signal, ...apiRequestInit(), headers: { ...headers, ...authHeaders(), ...relayHeadersFor() } })
    // A page where a stream was due is a failed connect, as EventSource holds it.
    const stream = response.headers.get('content-type')?.includes('text/event-stream') === true
    return stream || !response.ok ? response : new Response(null, { status: 502 })
  }
})

/**
 * An event stream at a scoped URL with no credential on it: this adds one in the
 * way the plane allows. The direct link and the direct origins never meet the
 * ingress, so they keep the query a native EventSource needs.
 */
export const openEventSource = (url: string): EventSource => {
  const routed = viaLink(url)
  // Watched every way: a stream on a path that died without a reset looks open
  // for ever (stream-watch.ts).
  if (routed) {
    return watchStream(new RtcEventSource(routed.link, tokenParam(routed.path)), { native: false }) as unknown as EventSource
  }
  if (onRelay()) return watchStream(new RtcEventSource(headerStream(url), url), { native: false }) as unknown as EventSource
  return watchStream(new EventSource(tokenParam(url)), { native: true })
}
