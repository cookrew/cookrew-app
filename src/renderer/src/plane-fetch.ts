import { apiRequestInit } from './api-base'
import { planeHealth } from './plane-health'

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
export async function planeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    const response = await fetch(url, { ...init, ...apiRequestInit() })
    planeHealth().note(true)
    return response
  } catch (error) {
    planeHealth().note(false)
    throw error
  }
}
