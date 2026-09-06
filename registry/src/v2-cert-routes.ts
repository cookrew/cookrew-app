import { readJsonBody } from './http'
import { v2Error } from './v2-copy'
import { refuse, v2Json, type Signed, type V2Context } from './v2-http'

/**
 * A MAC'S OWN CERTIFICATE — POST a CSR, GET the chain.
 *
 * `POST /v2/me/desktops/:id/cert  {csr}`  → 200 issued · 202 pending · 400 ·
 * 409 · 429 · 503
 * `GET  /v2/me/desktops/:id/cert`         → 200 pending/issued/failed · 404
 *
 * ONLY THAT MAC, AND ONLY FOR ITS OWN NAME. The session's `dev` claim must BE
 * the desktop in the path — not merely a device of the same account. Another
 * device of the account could otherwise obtain a certificate for a machine it
 * has never seen, and a certificate is the one thing a browser will trust
 * without asking anybody. The CSR gate in names.ts is the second half of the
 * same rule: exactly `*.<that id>.<zone>` and nothing beside it.
 *
 * THE PRIVATE KEY IS NEVER HERE. The Mac makes the key and the request; this
 * route sees a public key and a list of names. There is nothing in this file
 * worth stealing, and that is deliberate.
 *
 * 503 WHEN THE FLAGS ARE ABSENT, not 404: a deployment with no DNS zone has
 * not lost this route, it has not been given a zone to certify names in, and a
 * Mac that reads 404 would stop asking for ever.
 */

const CSR_BODY = 16 * 1024

/** True when this file answered. Mounted from v2-routes' /v2/me dispatcher. */
export function handleCertRoute(ctx: V2Context, signed: Signed, deviceId: string): boolean {
  const { method, response, v2 } = ctx
  if (method !== 'GET' && method !== 'POST') {
    refuse(response, 405, 'method_not_allowed')
    return true
  }
  // The identity check comes FIRST, before the feature check: whether this
  // registry issues certificates is not something a stranger's session should
  // be able to ask about a device id it made up.
  if (signed.claims.dev !== deviceId) {
    refuse(response, 403, 'not_this_desktop')
    return true
  }
  const names = ctx.names
  if (names === undefined) {
    refuse(response, 503, 'names_disabled', undefined, { 'retry-after': '3600' })
    return true
  }
  if (method === 'GET') {
    const state = names.state(deviceId)
    if (state.status === 'none') {
      refuse(response, 404, 'not_found')
      return true
    }
    if (state.status === 'issued') {
      v2Json(response, 200, { status: 'issued', chain: state.chain, notAfter: state.notAfter })
      return true
    }
    if (state.status === 'pending') {
      v2Json(response, 200, { status: 'pending' })
      return true
    }
    // A failure is a 200 with a reason, not a 5xx: the ORDER failed, this
    // request did not, and the Mac needs the sentence to decide whether to
    // fix something or simply try again.
    v2Json(response, 200, { status: 'failed', reason: state.reason })
    return true
  }
  void order(ctx, deviceId)
  return true
}

async function order(ctx: V2Context, deviceId: string): Promise<void> {
  const { response } = ctx
  const names = ctx.names
  if (names === undefined) return
  const body = await readJsonBody(ctx.request, CSR_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const out = names.request(deviceId, body.value.csr)
  if (out.ok) {
    if (out.status === 'issued') {
      // Already held and nowhere near expiry: the answer, not a second order.
      v2Json(response, 200, { status: 'issued', chain: out.chain, notAfter: out.notAfter })
      return
    }
    v2Json(response, 202, { status: 'pending', order: out.order })
    return
  }
  if (out.code === 400) {
    // The detail says WHICH part of the request was wrong, because the Mac
    // that built it is the only thing that can fix it.
    v2Json(response, 400, { ...v2Error('bad_csr'), detail: out.detail })
    return
  }
  if (out.code === 409) {
    refuse(response, 409, 'in_flight')
    return
  }
  refuse(response, 429, 'rate_limited', undefined, { 'retry-after': String(out.retryAfter) })
}
