import { apiRequestInit, clientBase } from './api-base'
import { RELAY_PLANE, dataPlane, planeRequestInit, subscribeDataPlane, type DataPlane } from './data-plane'
import { planeHealth } from './plane-health'
import { linkBody, linkHeaders, linkPath, viaLink } from './rtc-plane'
import { reviveStreams } from './plane-streams'
import { heldScope, machineLeft, relayHeadersForUrl, relayRequestFor } from './machine-scope'

/**
 * ONE FETCH, ON WHICHEVER PLANE IS CARRYING THE SESSION.
 *
 * Two things every request the companion makes needs, and neither belongs at a
 * call site:
 *
 *   THE RIGHT CREDENTIAL MODE. On a machine's own page a relay-plane request
 *   is same-origin. Everything else is cross-origin and sends no cookie at
 *   all: a direct request carries only the pairing token in the Authorization
 *   header, and the console's relay request carries that and the account
 *   session in a header of its own (below). Get it backwards and every
 *   request 401s.
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

/**
 * THE ACCOUNT SESSION, FOR THE RELAY AND FOR NOTHING ELSE. On the console the
 * relay wants it beside the machine's own token, in a header of its own
 * (machine-scope.ts). It is added HERE, at the one place a request leaves by
 * fetch, and judged by the address the request is going to: only a URL under
 * the relay's machine prefix carries it. An address built for a direct path
 * and sent later, when the page is back on the relay, is still a machine's
 * address, and a machine has no business holding the account's session.
 *
 * And a relayed call leaves at the relay's ONE ADDRESS, the machine and route
 * in headers, so the browser asks one preflight for the visit rather than one
 * per URL (latency 0.6.1, machine-scope.ts · relayRequestFor).
 */
const toRelay = (url: string, headers: HeadersInit | undefined): { url: string; headers?: Record<string, string> } => {
  if (Object.keys(relayHeadersForUrl(url)).length === 0) return { url }
  return relayRequestFor(url, headers)
}

export async function planeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const sent = dataPlane()
  const sameMachine = heldScope()
  try {
    return await onePlane(url, init, sent)
  } catch (error) {
    const again = sameMachine() ? relayRetryUrl(url, init, sent) : null
    if (again === null) throw error
    return fetchOnRelay(again, init)
  }
}

/**
 * THE RETRY, ON THE RELAY ITSELF and not on whatever plane is current: a
 * direct plane that just failed has usually not been left yet, and a retry
 * sent on it would be aborted by the fallback it was meant to survive, carry
 * the direct plane's local-network annotation to a public host, or go down the
 * same link. Its answer says nothing about the direct plane, so plane-health
 * hears nothing of it; the failure that caused it was already counted.
 */
async function fetchOnRelay(url: string, init: RequestInit): Promise<Response> {
  const sameMachine = heldScope()
  const sent = toRelay(url, init.headers)
  const response = await fetch(sent.url, {
    ...init,
    ...planeRequestInit(RELAY_PLANE, clientBase()),
    ...(sent.headers ? { headers: sent.headers } : {})
  })
  if (!sameMachine()) throw machineLeft()
  return response
}

/** One attempt, abandoned if the direct plane it went out on is left. */
async function onePlane(url: string, init: RequestInit, sent: DataPlane): Promise<Response> {
  const abort = joined(init.signal)
  const unwatch = abandonOnMove(sent, abort)
  try {
    return await fetchOnPlane(url, { ...init, signal: abort.signal })
  } finally {
    unwatch()
  }
}

/**
 * A READ THAT DIED WITH ITS DIRECT PATH IS ASKED AGAIN ON THE RELAY, once.
 *
 * Owner 2026-11-11, Android on 5G: every read in flight when the plane fell
 * back reached its view as a failure, and the console drew "0 agents" and
 * "no reading" for machines that were fine. The relay never went away, so a
 * GET (or HEAD) that failed on a direct plane for any reason but the caller's
 * own abort goes again there. A write does not: it may have been carried out,
 * and the callers that send writes keep their own retries (raw-input-queue.ts).
 *
 * The address: a direct origin is swapped for the machine's relay address,
 * the path kept; a link keeps the relay's URLs, so it is the same one.
 */
const relayRetryUrl = (url: string, init: RequestInit, sent: DataPlane): string | null => {
  if (sent.kind === 'relay' || init.signal?.aborted === true) return null
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return null
  if (sent.origin !== '') return url.startsWith(`${sent.origin}/`) ? `${clientBase()}${url.slice(sent.origin.length)}` : null
  // A link keeps the relay's URLs; a URL built for some other origin is not one to send there.
  return linkPath(url) === null ? null : url
}

/**
 * AN ANSWER FOR A MACHINE THAT WAS LEFT WHILE IT WAS ON ITS WAY IS NOBODY'S.
 * Whoever asked is that machine's view and is gone; handed on, its 401 would
 * put the next machine behind the re-pair screen and its seat or its numbers
 * would be filed as the next machine's. It ends as an abort, and says nothing
 * about the path either way: the path is the next machine's now.
 */
async function fetchOnPlane(url: string, init: RequestInit): Promise<Response> {
  const sameMachine = heldScope()
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
      if (!sameMachine()) throw machineLeft()
      planeHealth().note(true)
      reviveStreams()
      return response
    } catch (error) {
      if (!sameMachine()) throw machineLeft()
      if (transportFailed(error)) planeHealth().note(false)
      throw error
    }
  }
  try {
    const sent = toRelay(url, init.headers)
    const response = await fetch(sent.url, { ...init, ...apiRequestInit(), ...(sent.headers ? { headers: sent.headers } : {}) })
    if (!sameMachine()) throw machineLeft()
    planeHealth().note(true)
    reviveStreams()
    return response
  } catch (error) {
    if (!sameMachine()) throw machineLeft()
    if (transportFailed(error)) planeHealth().note(false)
    throw error
  }
}
