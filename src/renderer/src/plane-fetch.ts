import { apiRequestInit } from './api-base'
import { dataPlane, subscribeDataPlane, type DataPlane } from './data-plane'
import { planeHealth } from './plane-health'
import { linkBody, linkHeaders, viaLink } from './rtc-plane'

/**
 * ONE FETCH, ON WHICHEVER PLANE IS CARRYING THE SESSION.
 *
 * Two things every request the companion makes needs, and neither belongs at a
 * call site:
 *
 *   THE RIGHT CREDENTIAL MODE. Relay requests are same-origin and are gated by
 *   the account session cookie; direct requests are cross-origin and must send
 *   no cookies at all, only the pairing token in the Authorization header. Get
 *   that backwards in either direction and every request 401s.
 *
 *   A REPORT TO plane-health. A direct plane dies without saying so, and the
 *   only witness is the requests that stop arriving. Counting them here means
 *   a new call site is covered by being written normally, rather than by
 *   somebody remembering.
 *
 * Only a THROWN fetch is a transport failure. Any HTTP status at all — 401,
 * 404, 500 — is an ANSWER, which proves the plane is carrying traffic; blaming
 * the plane for a server error would drop a working phone back onto the relay
 * every time the Mac hiccuped.
 */
/**
 * A REQUEST ON A PLANE THAT WAS LEFT BEHIND IS ABANDONED, not waited for.
 *
 * A fetch to a direct origin that stopped answering (Tailscale went down, the
 * phone left the Wi-Fi) does not fail: it hangs until the OS gives up, which
 * on iOS is minutes. The companion falls back to the relay long before that,
 * and anything queued behind the hung request — every keystroke, since input
 * keeps one request in flight (raw-input-queue.ts) — waited with it. So when
 * the plane moves off the direct one a request was sent on, the request is
 * aborted. A request on the relay is left alone: the relay is still there
 * when the plane moves onto something better.
 */
const abandonOnMove = (sent: DataPlane, abort: AbortController): (() => void) => {
  if (sent.kind === 'relay') return () => undefined
  return subscribeDataPlane((next) => {
    if (next.origin !== sent.origin || next.kind !== sent.kind || next.transport !== sent.transport) {
      abort.abort(new DOMException('the plane this request was sent on was left', 'AbortError'))
    }
  })
}

/** One signal for the caller's abort and ours. */
const joined = (caller: AbortSignal | null | undefined): AbortController => {
  const abort = new AbortController()
  if (caller?.aborted) abort.abort(caller.reason)
  else caller?.addEventListener('abort', () => abort.abort(caller.reason), { once: true })
  return abort
}

/**
 * Only a transport failure counts against a plane. An abort is not one — the
 * caller gave up, or the plane already moved — but a deadline the caller set
 * and the request missed (a 'TimeoutError', raw-input-queue.ts) is.
 */
const transportFailed = (error: unknown): boolean => (error as Error | undefined)?.name !== 'AbortError'

export async function planeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const abort = joined(init.signal)
  const unwatch = abandonOnMove(dataPlane(), abort)
  try {
    return await fetchOnPlane(url, { ...init, signal: abort.signal })
  } finally {
    unwatch()
  }
}

async function fetchOnPlane(url: string, init: RequestInit): Promise<Response> {
  // THE DIRECT LINK (rtc-plane.ts): the same URL, carried on the data
  // channel. A body only a real fetch can send (a FormData upload) takes the
  // relay, which is still there underneath.
  const routed = viaLink(url)
  const body = routed ? await linkBody(init.body) : undefined
  if (routed && body !== undefined) {
    try {
      const response = await routed.link.request({
        method: (init.method ?? 'GET').toUpperCase(),
        path: routed.path,
        headers: linkHeaders(init.headers),
        body,
        ...(init.signal ? { signal: init.signal } : {})
      })
      planeHealth().note(true)
      return response
    } catch (error) {
      if (transportFailed(error)) planeHealth().note(false)
      throw error
    }
  }
  try {
    const response = await fetch(url, { ...init, ...apiRequestInit() })
    planeHealth().note(true)
    return response
  } catch (error) {
    if (transportFailed(error)) planeHealth().note(false)
    throw error
  }
}
