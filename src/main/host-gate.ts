import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { RELAY_MARKER, isLoopbackPeer } from './relay-base'
import { addressText, parseAddress } from '../shared/reach-names'

/**
 * DNS REBINDING: THE ONE ATTACK A LAN SERVER CANNOT SEE COMING.
 *
 * A page on the public internet resolves `attacker.example` to its own
 * address, is loaded, and then re-answers the same name with `192.168.2.40` —
 * this Mac. The browser reconnects, believes it is still talking to
 * `attacker.example`, and hands the script everything it reads. Same-origin
 * policy is satisfied, CORS is never consulted (the origin did not change),
 * and the Origin header says nothing useful. From this server's side the
 * request is indistinguishable from a phone on the Wi-Fi — EXCEPT for one
 * field the attacker cannot forge: the browser sends the name it thinks it
 * dialled, in `Host`.
 *
 * So the canonical defence is a Host allow-list, and it is what the products
 * that shipped this hole fixed it with:
 *
 *   TRANSMISSION (CVE-2018-5702) — a page on the internet drove the local RPC
 *   port and got remote code execution through a "run script on completion"
 *   setting. The fix was a Host allow-list on the daemon.
 *   MODEL CONTEXT PROTOCOL INSPECTOR (CVE-2025-49596) — the fix was
 *   authentication PLUS Host and Origin validation; authentication alone was
 *   not judged enough, because a rebound page can be made to carry a
 *   credential the victim's own browser already holds.
 *   DOCKER'S GATEWAY shipped the hole specifically in its EVENT-STREAM mode,
 *   which is why the streaming path here has its own tests rather than
 *   coverage by implication (tests/rebinding-gate.test.ts).
 *
 * WHAT IS COMPARED, AND WHAT IS DELIBERATELY NOT.
 *
 *   THE NAME, EXACTLY. Lower-cased, one trailing dot removed (`10.0.0.4.` is
 *   the same address to a resolver and a different string to `===`), IPv6
 *   unbracketed. No suffix match: `endsWith('.d.cookrew.dev')` is how
 *   `d.cookrew.dev.attacker.example` gets in.
 *   NOT THE PORT. The connection already proves which of this server's two
 *   listeners it landed on; a rebinding attacker chooses the NAME and cannot
 *   choose the socket. Refusing `192.168.2.40:8644` would refuse nothing an
 *   attacker can do and would break a forwarded port a user set up.
 *   THE SHAPE, BEFORE ANYTHING ELSE. A Host that is not a hostname —
 *   userinfo, a space, a control character, two Host headers — is a 400: it
 *   is either a broken client or someone trying to make this server and a
 *   proxy in front of it read one request two different ways.
 *
 * ABSENT HOST IS 400, NOT 421. HTTP/1.1 requires the field; a request without
 * it is malformed rather than misdirected. (Node synthesises `host` from
 * `:authority` on HTTP/2, so the same check reads correctly there.)
 *
 * A RELAYED REQUEST IS EXEMPT, because the hop is ours: canvas-bridge dials
 * 127.0.0.1 in this same process and rewrites Host to its own loopback
 * authority, so the Host on those requests is the BRIDGE's opinion and not the
 * caller's. The exemption needs both halves of the relay proof — the marker
 * header, which the bridge writes over whatever the caller sent, AND a
 * loopback peer, because a header can be typed by anyone (see relay-base.ts).
 */

export type HostVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400 | 421; readonly message: string }

export interface HostCheck {
  /** `request.headers.host` — an array when the client sent the field twice. */
  readonly host: string | string[] | undefined
  /** True only for a request proven to have come down the relay bridge. */
  readonly relayed: boolean
  /** Every host this Mac answers for. Read live; see companion-hosts.ts. */
  readonly allowed: readonly string[]
}

const ALLOWED_VERDICT: HostVerdict = { ok: true }

/** One sentence, no echo of what was asked — the body is read by attackers too. */
const MISDIRECTED = 'This desktop does not answer for that Host, so the request was refused.'
const MALFORMED = 'A Host header naming one host is required.'

/** Names, IPv4 literals, and the bracketed IPv6 form. Nothing else is a host. */
const NAME = /^[a-z0-9._-]+$/
const V6 = /^[0-9a-f:.]+$/

/**
 * The bare host of an authority, lower-cased and without its trailing dot, or
 * null when the value is not one host.
 */
export function bareHost(authority: string): string | null {
  const value = authority.trim().toLowerCase()
  if (value.length === 0 || value.length > 260) return null
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close < 2 || !okPort(value.slice(close + 1))) return null
    const inner = value.slice(1, close)
    return V6.test(inner) ? inner : null
  }
  const colon = value.indexOf(':')
  const host = colon === -1 ? value : value.slice(0, colon)
  if (colon !== -1 && !okPort(value.slice(colon))) return null
  const bare = host.endsWith('.') ? host.slice(0, -1) : host
  return bare.length > 0 && NAME.test(bare) ? bare : null
}

/** '' or ':<digits>' — anything else is not an authority we will parse. */
function okPort(rest: string): boolean {
  if (rest.length === 0) return true
  return /^:\d{1,5}$/.test(rest) && Number(rest.slice(1)) <= 65535
}

/**
 * The comparable form of a host — the allow-list's entries and the Host header
 * are both reduced through this, so the two sides can never be normalised by
 * two different opinions.
 *
 * An IP is compared as an ADDRESS rather than as a string: `[FD7A::1]` and
 * `fd7a:0:0:0:0:0:0:1` are one tailnet address written two ways, and a phone
 * that spells it the second way is not an attacker. Names are compared as
 * lower-cased text with the root dot removed, and nothing else.
 */
export function hostKey(value: string): string {
  const bare = value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const ip = parseAddress(bare)
  return ip === null ? bare : addressText(ip)
}

/**
 * Is this request addressed to a host this Mac actually answers for?
 *
 * Pure, and the allowed set is an argument rather than a module read, so the
 * rule is testable without a network, a certificate or a Wi-Fi change.
 */
export function hostVerdict(check: HostCheck): HostVerdict {
  if (check.relayed) return ALLOWED_VERDICT
  // Two Host headers is a request-smuggling shape, never a browser.
  if (Array.isArray(check.host)) return { ok: false, status: 400, message: MALFORMED }
  if (typeof check.host !== 'string' || check.host.trim().length === 0) {
    return { ok: false, status: 400, message: MALFORMED }
  }
  const bare = bareHost(check.host)
  if (bare === null) return { ok: false, status: 400, message: MALFORMED }
  const asked = hostKey(bare)
  for (const entry of check.allowed) {
    if (entry.length > 0 && hostKey(entry) === asked) return ALLOWED_VERDICT
  }
  return { ok: false, status: 421, message: MISDIRECTED }
}

/** Both halves of the relay proof: the bridge's marker AND a loopback peer. */
export function relayedRequest(
  request: Pick<http.IncomingMessage, 'headers'> & { socket?: { remoteAddress?: string } }
): boolean {
  if (request.headers[RELAY_MARKER] !== '1') return false
  return isLoopbackPeer(request.socket?.remoteAddress)
}

/**
 * The gate as `handle()` uses it: true when the request is FINISHED and no
 * route, no auth check and no CORS header may run for it.
 *
 * 421 Misdirected Request is the honest status — this server is not the one
 * the client asked for — and it is inert in a browser: no redirect, no retry
 * on another name, nothing a script can read cross-origin.
 */
export function refuseMisdirected(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  allowed: readonly string[]
): boolean {
  const verdict = hostVerdict({
    host: request.headers.host,
    relayed: relayedRequest(request),
    allowed
  })
  if (verdict.ok) return false
  try {
    response.writeHead(verdict.status, {
      'content-type': 'text/plain; charset=utf-8',
      // Nothing about a refusal is cacheable per-origin, but a cache that saw
      // one must not hand it to a different origin either.
      vary: 'origin',
      'cache-control': 'no-store'
    })
    response.end(`${verdict.message}\n`)
  } catch {
    // A response that cannot be written is a socket that is already gone; the
    // request is refused either way, which is the only guarantee that matters.
    response.destroy()
  }
  return true
}

/**
 * The same gate on the WebSocket upgrade, which never reaches `handle()`.
 *
 * A cross-site WebSocket is the rebinding path that survives every fetch-level
 * defence: the browser attaches no CORS check to it at all. The handshake is
 * still HTTP, so it still carries the Host the page thinks it dialled, and the
 * refusal is written as a plain HTTP response before the socket is destroyed —
 * a client that reads it learns why, and a client that does not gets the same
 * closed socket it would have got from a dead port.
 */
export function refuseMisdirectedUpgrade(
  request: http.IncomingMessage,
  socket: Duplex,
  allowed: readonly string[]
): boolean {
  const verdict = hostVerdict({
    host: request.headers.host,
    relayed: relayedRequest(request),
    allowed
  })
  if (verdict.ok) return false
  try {
    socket.write(
      `HTTP/1.1 ${verdict.status} ${verdict.status === 400 ? 'Bad Request' : 'Misdirected Request'}\r\n` +
        'content-type: text/plain; charset=utf-8\r\n' +
        'connection: close\r\n\r\n' +
        `${verdict.message}\n`
    )
  } catch {
    // Same reasoning as above: the destroy below is the refusal.
  }
  socket.destroy()
  return true
}
