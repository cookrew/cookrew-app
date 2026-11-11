import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { decodeFrame, encodeFrame } from '../../src/shared/relay-frame'
import { RelayHub, type HubSocket } from './relay-hub'
import { LinkPulse, openNdjson, readFrameLines } from './relay-link'
import { refuse, sameOrigin, signedIn, v2Json, type V2Identity } from './v2-http'
import {
  RELAY_MACHINE_HEADER,
  RELAY_ROUTE_HEADER,
  RELAY_SESSION_HEADER,
  isMachineId,
  isRelayedRoute,
  relayPathFromHeaders
} from '../../src/shared/machine-relay'
import { fleetPresence, type DesktopPresence } from './v2-fleet'
import { createLineSeen } from './v2-line-seen'

/**
 * IDENTITY v2, PHASE 3 — THE PRIVATE RELAY SESSION.
 *
 * A phone on LTE cannot dial the Mac in someone's kitchen. So the Mac dials
 * OUT and holds a line open at cookrew.dev for its OWN CANVAS, beside the
 * doors it may also be serving, and the phone's request travels down that line
 * backwards. This is the third path in the picker's order — LAN, then tailnet,
 * then here — and it is the only one that works from anywhere.
 *
 * IT IS THE SAME TRANSPORT AS A DOOR, on purpose. Same hub, same frames, same
 * pulse, same teardown; a second namespace rather than a second relay. What is
 * different is WHO MAY USE IT, and that is the whole of this file:
 *
 *   THE LINE IS THE DESKTOP'S OWN. It is opened with that desktop's v2 session
 *   token and registered under a name built from the token's own claims —
 *   `@user/desktop/<deviceId>`, where the device is the one that signed in.
 *   Nothing a caller writes chooses the name, so no device can park on
 *   another's and take its owner's canvas offline.
 *
 *   THE CALLER MUST BE ON THE ACCOUNT. Everything under `/api/m/<machine id>/`
 *   needs a v2 session of a device attached to that machine's account, sent in
 *   its own header (shared/machine-relay.ts). The line forwarded to is named
 *   from the SESSION's username: nothing in the address chooses an account, so
 *   a link cannot address somebody else's machine. One path for every client:
 *   the console page, the desktop app and the watch.
 *
 *   NO COOKIE ADMITS ANYONE. A cookie is something another site can make a
 *   browser send; a header is not. No cookie is read, none is forwarded, and
 *   none a machine sets is passed back.
 *
 *   A MACHINE'S API CROSSES, AND NOTHING ELSE. No page, no asset, no redirect:
 *   an answer that is a page is refused whole, and every answer is sent under
 *   a sandbox, so a machine's bytes can never run on the origin they are read
 *   from. The body is not read and never logged. What is logged is that a
 *   session opened, that it closed, and how many bytes crossed.
 *
 * NOT SEALED YET, AND THIS MATTERS. TLS to cookrew.dev and TLS onward is two
 * hops, not end to end: this process handles plaintext, so a relay operator
 * could read a canvas, including the credential a caller presents to its
 * machine. The frames reserve `sealed` for the ciphertext that fixes
 * it (see relay-frame.ts); until that lands, this path is the owner reaching
 * their own machine through their own registry, and it must not be described
 * as end-to-end private.
 */

/** A canvas token's audience, and half of a canvas line's name: a uuid. */
const DEVICE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** `@user/desktop/<deviceId>` — one desktop's canvas, in the hub's namespace. */
/** Did this uplink ask for receipts (`?acks=1`)? A desktop that did not is never sent one. */
export const wantsReceipts = (request: IncomingMessage): boolean =>
  new URL(request.url ?? '/', 'http://relay.invalid').searchParams.get('acks') === '1'

export const canvasName = (username: string, deviceId: string): string =>
  `@${username}/desktop/${deviceId}`

/**
 * The second namespace, spelled out. Three segments, and the third is a device
 * id — which is what keeps a canvas name from ever colliding with a door's
 * `@handle/team`, whatever either is called.
 */
export function isCanvasName(name: string): boolean {
  const found = /^@([^/]+)\/desktop\/([^/]+)$/.exec(name)
  return found !== null && HANDLE.test(found[1]) && DEVICE.test(found[2])
}

/**
 * A whole request body, bounded. Four megabytes is a generous attachment and
 * far below anything that hurts a shared process.
 */
export const CANVAS_BODY_MAX = 4 * 1024 * 1024
/**
 * How much RAW body travels in one `body` frame.
 *
 * A frame is capped at a megabyte by the wire, and base64 costs a third — so
 * 384 KB of bytes encodes to 512 KB of frame with room to spare. A body larger
 * than one frame is simply several, the last one carrying `done`.
 */
export const CANVAS_CHUNK = 384 * 1024

/**
 * WHAT ONE ACCOUNT MAY MAKE THIS PROCESS HOLD.
 *
 * Anyone can claim a username, so "a registered stranger" is the threat model
 * here, not an accident. Without these a single account could open lines and
 * exchanges without limit and make the registry buffer four megabytes for each
 * — the doors would go down with the canvases, since they share a process.
 *
 * The arithmetic is the point: 8 lines × 64 exchanges × 4 MB is 2 GB per
 * account, which is why the LAST of these is a budget across the whole relay
 * rather than another per-account number. A cap that multiplies is not a cap.
 */
/**
 * Exchanges one desktop's line carries at once: as many as the machine's own
 * bridge takes (main/canvas-bridge.ts · BRIDGE_MAX_OPEN, pinned equal in the
 * tests). It was 16, and a console entering a machine asks ~20 things at once:
 * measured 2026-11-11, a burst of 20 reads at Solis-Core got 4 refusals while
 * the machine answered each in ~6 ms, and the console waits a second before
 * asking a refused read again (relay-full.ts). What an exchange makes this
 * process hold is a stream id and a timer; the bodies are bounded relay-wide
 * by BODY_BUDGET, so the cap per line is not the memory bound.
 */
export const EXCHANGES_PER_LINK = 64
/** Lines one account may hold: one per desktop, and nobody has eight Macs. */
export const LINKS_PER_ACCOUNT = 8
/** How long an exchange may wait for its first head frame before it is given up on. */
export const HEAD_DEADLINE_MS = 30_000
/**
 * How long a headed exchange may go silent. Generous because the line is an
 * SSE stream that is quiet while an agent thinks — its own keepalive is a
 * chunk, and every chunk resets this.
 */
export const IDLE_DEADLINE_MS = 120_000
/**
 * How often, at most, an uplink that asked is told how much of it has arrived
 * (`got`, relay-frame.ts). Coalesced rather than per read: a fast line would
 * otherwise get a receipt for every TCP segment. 40 ms keeps a slow line's
 * picture fresh and a fast line's downlink quiet (~25 small frames a second).
 */
export const RECEIPT_EVERY_MS = 40
/** Request bodies being buffered across the WHOLE relay at once. */
export const BODY_BUDGET = 64 * 1024 * 1024

/**
 * THE REQUEST HEADERS THAT CROSS. An allow-list, because the opposite is a
 * list of everything a browser might ever invent — and `authorization`,
 * `x-forwarded-for` and the reader's IP are all things the desktop has no
 * business learning from a relay.
 */
const REQUEST_HEADERS = new Set([
  'content-type',
  'accept',
  'accept-encoding',
  'last-event-id',
  'authorization',
  'if-none-match'
])

/**
 * `accept-encoding` CROSSES, and it was the largest thing this path got wrong.
 *
 * The desktop compresses what it can (http-compress.ts: the 2 MB bundle is
 * 434 KB as brotli, a 653 KB workspace 228 KB) — but only when the request
 * says the reader can decode it. Stripped here, the request said nothing,
 * the desktop answered identity, and every relayed byte crossed uncompressed
 * and then base64 (+33%) in the frames: a remote open carried ~4 MB where the
 * LAN carried 1.2 MB. The header names the READER's decoders, which is the
 * reader's business to state and nobody's to learn; `content-encoding` was
 * already coming back, since it is not hop-by-hop. `if-none-match` crosses
 * for the same reason: a validator the reader holds. (Perf lane L7.)
 */

/**
 * `authorization` CROSSES UNREAD. It is the caller's own credential at that
 * machine (a pairing token, a machine key: mobile-http.presentedToken), and
 * the relay has no use for it: the account session travels in its own header
 * (shared/machine-relay.ts), which is read here and never forwarded.
 */

/** A page was once served under a relay prefix and told so in this header. Nothing is now; a caller's copy is dropped. */
const STALE_BASE_HEADER = 'x-cookrew-base'
/** The bridge's own mark on a relayed request (main/canvas-bridge.ts): never a caller's to write. */
const BRIDGE_MARKER = 'x-cookrew-relay'

/**
 * WHO IS ASKING, told to the desktop — reach v2.1.
 *
 * The Mac has to be able to name the devices it is serving: its admitted list,
 * its log, the sentence a person reads about a phone that is on their canvas
 * right now. It used to learn that from the admission ceremony — a canvas
 * token plus `?device=&name=` on the query — and that whole ceremony is gone
 * (one credential, one URL). Nothing else in a relayed request says who the
 * reader is, because the session that admitted them is never forwarded.
 *
 * So the registry states it, on every forwarded exchange, FROM THE SESSION it
 * just verified and from nothing the client sent. A client-supplied copy is
 * REMOVED first: a caller who could write
 * these could sit at somebody's Mac under any name they liked, and the Mac
 * would have no way to tell.
 *
 * The value is the caller's v2 device id; the name header is the device's
 * name, made header-safe. Both are absent from a request the registry did not
 * write them on, which is the desktop's signal that it is not being relayed.
 */
export const CANVAS_DEVICE_HEADER = 'x-cookrew-device'
export const CANVAS_DEVICE_NAME_HEADER = 'x-cookrew-device-name'
/** The same ceiling the account store puts on a device name, so nothing is cut that was not already. */
export const DEVICE_NAME_MAX = 64

/**
 * A device name a header can actually carry.
 *
 * A person names their phone in their own alphabet — "Dréj's iPhone", an
 * emoji, a tab pasted in by accident — and node throws `ERR_INVALID_CHAR` on a
 * header value outside Latin-1, which would turn a fond name into a relay that
 * refuses every request from that phone. So the name is reduced to printable
 * ASCII, runs of blanks collapse, and it is cut to the store's own limit.
 * What survives is a label, not an identity: the id beside it is the identity.
 */
export function headerSafeName(name: string): string {
  return [...name]
    .map((ch) => (ch >= ' ' && ch <= '~' ? ch : ' '))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEVICE_NAME_MAX)
}

/**
 * The caller's identity as headers, or nothing it could not vouch for. An
 * empty name is left OFF rather than sent empty — a header with no value in it
 * is a fact the desktop would have to un-learn.
 */
export function callerDeviceHeaders(device: { id: string; name: string }): Record<string, string> {
  const id = headerSafeName(device.id)
  if (id === '') return {}
  const name = headerSafeName(device.name)
  return { [CANVAS_DEVICE_HEADER]: id, ...(name === '' ? {} : { [CANVAS_DEVICE_NAME_HEADER]: name }) }
}

/** A header value larger than this is not a header, it is a payload. */
const HEADER_MAX = 8 * 1024

/** The request headers a relayed exchange may carry, lowercased. */
export function allowedRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || value.length > HEADER_MAX) continue
    const name = key.toLowerCase()
    // NO COOKIE CROSSES, whoever set it, and never the account session.
    if (name === 'cookie' || name === RELAY_SESSION_HEADER) continue
    // OURS TO WRITE, NEVER THEIRS: who is asking is stated below from the
    // session, and the other two describe a relay the caller is not.
    if (name === STALE_BASE_HEADER || name === BRIDGE_MARKER || name === CANVAS_DEVICE_HEADER || name === CANVAS_DEVICE_NAME_HEADER) {
      continue
    }
    // OURS TO READ: the one address's machine and route are the relay's
    // question, already answered by the path the machine is asked at.
    if (name === RELAY_MACHINE_HEADER || name === RELAY_ROUTE_HEADER) continue
    if (REQUEST_HEADERS.has(name)) out[name] = value
    // The app's own headers pass; the proxy's own never do, because they
    // describe the reader's network rather than the reader's request.
    else if (name.startsWith('x-') && !name.startsWith('x-forwarded-') && name !== 'x-real-ip') {
      out[name] = value
    }
  }
  return out
}

/**
 * AN ANSWER THAT IS A PAGE. A machine's API answers data, pictures and
 * streams; a document a browser would render and run is never one of them, so
 * it is refused whole rather than passed on under a sandbox and hoped for.
 */
const PAGE_TYPES = new Set(['text/html', 'text/xml', 'application/xml', 'text/xsl', 'multipart/x-mixed-replace'])
/** A value that names several types is judged by each: a browser takes the last, a proxy may take the first. */
export const isPageType = (contentType: string): boolean =>
  contentType.split(',').some((one) => {
    const type = one.split(';')[0].trim().toLowerCase()
    return PAGE_TYPES.has(type) || type.endsWith('+xml')
  })

/**
 * THE ANSWER HEADERS THAT CROSS BACK. An allow-list, for the reason the
 * request's is one: the opposite is every header a machine might invent to get
 * a hold on the origin its answer is read from. So no Set-Cookie, no Location
 * or Refresh, no Service-Worker-Allowed, no Link, no policy and no CORS grant
 * of its own. What a reader needs is the type, the encoding and a validator.
 */
const ANSWER_HEADERS = new Set(['content-type', 'content-encoding', 'etag', 'last-modified', 'retry-after'])

/** What a header value may be made of here: printable ASCII and tabs. */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/

/** Every relayed answer is sent under this: nothing in it may run, frame or be framed. */
export const RELAY_ANSWER_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'"

/** What a page of the console may send on the relay path, and how (answered to its preflight). */
export const RELAY_CORS_HEADERS = `authorization, content-type, if-none-match, last-event-id, ${RELAY_SESSION_HEADER}, ${RELAY_MACHINE_HEADER}, ${RELAY_ROUTE_HEADER}`
export const RELAY_CORS_METHODS = 'GET, POST, PUT, DELETE'
/** Ten minutes: the ceiling OWASP names, so a changed allow-list is honoured soon (main/companion-cors.ts). */
export const RELAY_CORS_MAX_AGE = '600'

/** Never shared, never kept, and different for each origin and each session. */
const RELAY_PRIVATE: Record<string, string> = {
  'cache-control': 'private, no-store',
  vary: `origin, authorization, ${RELAY_SESSION_HEADER}`
}

/**
 * The machine's answer, made safe to send from this origin: the few headers a
 * reader needs, then ours over them.
 */
export function relayAnswerHeaders(headers: Record<string, string>, cors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase()
    // Only what a header can carry: printable ASCII and tabs. A line break or a
    // character past a byte makes writeHead throw, and a machine must not be
    // able to make this process throw.
    if (ANSWER_HEADERS.has(name) && typeof value === 'string' && value.length <= HEADER_MAX && HEADER_VALUE.test(value)) out[name] = value
  }
  return {
    // A type is always said: with nosniff, an answer without one is bytes and nothing else.
    'content-type': 'application/octet-stream',
    ...out,
    ...RELAY_PRIVATE,
    ...cors,
    'content-security-policy': RELAY_ANSWER_CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-resource-policy': 'cross-origin',
    // An SSE stream must not be held by a proxy until it ends, which for a line is never.
    'x-accel-buffering': 'no'
  }
}

/** What the relay logs about canvases, and the only numbers it keeps. */
export interface CanvasRelayStats {
  /** Desktops holding a line right now. */
  links: number
  /** Exchanges in flight. */
  open: number
  opened: number
  closed: number
  bytesUp: number
  bytesDown: number
}

export interface CanvasRelay {
  hub: RelayHub
  /** Is this account's desktop holding a line right now? */
  live(username: string, deviceId: string): boolean
  /**
   * Every desktop of the account — online now, and when its line was
   * last seen by this process (null: not since it started).
   */
  presence(username: string): ReadonlyMap<string, DesktopPresence>
  /**
   * The account was deleted: its desktops' lines end, and when they were seen is
   * forgotten. Forgotten by name, not by `deviceIds`: a device signed out earlier
   * is on no such list, and its sighting named the account in plain text.
   */
  hangUp(username: string, deviceIds: readonly string[]): void
  /** Answered it? False when the path belongs to somebody else. */
  handle(request: IncomingMessage, response: ServerResponse, parts: string[], url: URL): boolean
  stats(): CanvasRelayStats
  stop(): void
}

export interface CanvasRelayDeps {
  v2: V2Identity
  log?: (message: string) => void
  now?: () => number
  pulseMs?: number
  pulseDeadlineMs?: number
  /** The bounds above, lowered by a test so a cap can be reached in a second. */
  exchangesPerLink?: number
  linksPerAccount?: number
  headDeadlineMs?: number
  idleDeadlineMs?: number
  /** RECEIPT_EVERY_MS, shortened by tests. */
  receiptMs?: number
  bodyBudget?: number
  /** Where line sightings persist (v2-line-seen.ts); absent = memory only. */
  seenFile?: string
}

/** A refusal this file words itself. */
const deny = (response: ServerResponse, code: number, error: string, message: string, headers: Record<string, string> = {}): void =>
  v2Json(response, code, { error, message }, headers)

/** decodeURIComponent that answers null rather than throwing on a bad escape. */
const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/**
 * THE SESSION ON THE RELAY PATH: its own header, and nothing else. Not a
 * cookie (another site can make a browser send one) and not `Authorization`
 * (that is the caller's credential at the machine, and crosses unread).
 */
const relaySignedIn = (request: IncomingMessage, v2: V2Identity): ReturnType<typeof signedIn> => {
  const session = request.headers[RELAY_SESSION_HEADER]
  if (typeof session !== 'string' || session === '') return null
  // The relay path is the console's as much as an app's: its kind of session is taken here.
  return signedIn({ headers: { authorization: `Bearer ${session}` } } as IncomingMessage, v2, 'bearer', { console: true })
}

/**
 * WHICH PAGE MAY CALL THE RELAY PATH: the console, exactly, and no other.
 *
 * A caller that is not a browser (the desktop app, the watch) sends no Origin
 * and is judged by its session alone. A browser always says where its page
 * came from on a request like these, and only the configured console origin is
 * answered: compared whole, never by suffix, and never echoed from the
 * request. A registry that serves no console answers no page at all.
 */
type OriginVerdict = { readonly ok: true; readonly cors: Record<string, string> } | { readonly ok: false }
const originVerdict = (request: IncomingMessage, consoleOrigin: string | null): OriginVerdict => {
  const origin = request.headers.origin
  if (origin === undefined) return { ok: true, cors: {} }
  if (typeof origin !== 'string' || consoleOrigin === null || origin !== consoleOrigin) return { ok: false }
  return { ok: true, cors: { 'access-control-allow-origin': consoleOrigin, 'access-control-expose-headers': 'etag, retry-after' } }
}

/**
 * A REQUEST ANOTHER SITE CAUSED, WHICH IS NEVER THIS PERSON'S WISH.
 *
 * The downlink is state-changing in a way a `GET` usually is not: it CLAIMS A
 * NAME, and a claim someone else's page can cause is a name someone else's
 * page can squat — the real desktop then finds its own line taken. So the
 * browser's own account of where the request came from is what decides, and
 * only `same-origin` and `none` (a typed address or a bookmark) are this
 * person's.
 *
 * `sec-fetch-site` is absent on old browsers and on curl; there the Origin
 * check that the rest of /v2 uses is the fallback, so the posture never gets
 * weaker than the routes next door.
 */
export function crossSite(request: IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '') return site !== 'same-origin' && site !== 'none'
  return !sameOrigin(request)
}

/**
 * THE ONE ADDRESS, UNFOLDED: `/api/m` with the machine and the route in their
 * headers (shared/machine-relay.ts · relayAtOneAddress), read back into the
 * path the path form would have had, so `proxy` asks exactly the questions it
 * always asks of it. Null for anything that is not one clean pair: a header
 * missing or doubled, a route the path form refuses, a query on the address
 * itself, or a route that would climb out of its machine once parsed.
 */
export function oneAddress(request: IncomingMessage, url: URL): URL | null {
  if (url.search !== '') return null
  const machine = request.headers[RELAY_MACHINE_HEADER]
  const path = relayPathFromHeaders(machine, request.headers[RELAY_ROUTE_HEADER])
  if (path === null || typeof machine !== 'string') return null
  const target = new URL(path, url.origin)
  // Parsed the way the request line is parsed: whatever it tidied away must still leave it this machine's.
  return target.pathname.startsWith(`/api/m/${machine.toLowerCase()}/`) ? target : null
}

/**
 * The desktop app's own path, which is not a browser and carries no cookie.
 * A page cannot use it to claim a name: a fetch that sets `Authorization` is
 * preflighted, the only page whose preflight is answered is the console's
 * (api-host.ts), and the token it could send is a console session, which is
 * refused this route before it is reached (console-scope.ts). A line is also
 * only ever opened for the device the token itself names (lineFor).
 */
const bearing = (request: IncomingMessage): boolean =>
  (request.headers.authorization ?? '').startsWith('Bearer ')

export function createCanvasRelay(deps: CanvasRelayDeps): CanvasRelay {
  const log = deps.log ?? ((): void => undefined)
  const hub = new RelayHub(log, isCanvasName)
  const counts = { open: 0, opened: 0, closed: 0, bytesUp: 0, bytesDown: 0 }
  const perLink = deps.exchangesPerLink ?? EXCHANGES_PER_LINK
  const perAccount = deps.linksPerAccount ?? LINKS_PER_ACCOUNT
  const headMs = deps.headDeadlineMs ?? HEAD_DEADLINE_MS
  const idleMs = deps.idleDeadlineMs ?? IDLE_DEADLINE_MS
  const receiptMs = deps.receiptMs ?? RECEIPT_EVERY_MS
  const budget = deps.bodyBudget ?? BODY_BUDGET
  /** Exchanges in flight per line, so one desktop cannot be made to hold many. */
  const exchanges = new Map<string, number>()
  /** The lines each account holds, so one account cannot hold many. */
  const holding = new Map<string, Set<string>>()
  /** Request bytes buffered right now, across every exchange. */
  let buffering = 0
  /** When each line was last opened, beaten or closed — presence's lastSeenAt, kept across a restart. */
  const nowMs = deps.now ?? ((): number => Date.now())
  const seen = createLineSeen(deps.seenFile ?? null, nowMs)
  // A build before this one left deleted accounts' sightings behind.
  seen.forgetWhere((name) => deps.v2.accounts.isRetired(name.slice(1, name.indexOf('/'))))
  const sawLine = (name: string): void => seen.see(name)

  /** The account a canvas name belongs to. The name is built from a token. */
  const ownerOf = (name: string): string => name.slice(1, name.indexOf('/'))
  const holdsLine = (name: string): void => {
    sawLine(name)
    const owner = ownerOf(name)
    const mine = holding.get(owner) ?? new Set<string>()
    mine.add(name)
    holding.set(owner, mine)
  }
  const releasesLine = (name: string): void => {
    sawLine(name)
    const owner = ownerOf(name)
    const mine = holding.get(owner)
    if (mine === undefined) return
    mine.delete(name)
    if (mine.size === 0) holding.delete(owner)
  }

  const live: LinkPulse = new LinkPulse({
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.pulseMs === undefined ? {} : { pulseMs: deps.pulseMs }),
    ...(deps.pulseDeadlineMs === undefined ? {} : { deadlineMs: deps.pulseDeadlineMs }),
    drop: (name, why) => dropLink(name, why)
  })

  const dropLink = (name: string, why: string): void => {
    const socket = live.socketOf(name)
    live.release(name)
    releasesLine(name)
    hub.closeDoor(name)
    // The downlink ends too, so the desktop LEARNS and redials: a response
    // ending is the one signal a client reliably observes.
    socket?.close()
    log(`canvas relay: ${name} ${why}`)
  }

  // ── the desktop's own line ─────────────────────────────────────────────

  /**
   * WHOSE LINE THIS IS, from the token and never from the path.
   *
   * The path names a device only so a mistake is a 403 rather than a silently
   * different line; the name that gets registered is built from the session's
   * own `sub` and `dev`. A desktop can therefore only ever hold the line for
   * itself, which is the property that makes "is this desktop live" a fact
   * about that desktop.
   */
  const lineFor = (
    request: IncomingMessage,
    response: ServerResponse,
    raw: string
  ): string | null => {
    const signed = signedIn(request, deps.v2)
    if (signed === null) {
      refuse(response, 401, 'unauthenticated')
      return null
    }
    const deviceId = (decode(raw) ?? '').toLowerCase()
    if (!DEVICE.test(deviceId) || deviceId !== signed.claims.dev) {
      refuse(response, 403, 'not_this_device')
      return null
    }
    return canvasName(signed.account.username, deviceId)
  }

  /** THE DESKTOP'S DOWNLINK — held open for the life of the line. */
  const downlink = (request: IncomingMessage, response: ServerResponse, raw: string): void => {
    const name = lineFor(request, response, raw)
    if (name === null) return
    // BEFORE THE HEAD GOES OUT, so a refusal is a status a client can read
    // rather than an abort frame it has to parse. One line per desktop is the
    // hub's own rule (a second claim on a name is refused); this is the other
    // half of it — an account with a hundred device ids may still only hold a
    // handful of lines at once.
    const mine = holding.get(ownerOf(name))
    if (mine !== undefined && !mine.has(name) && mine.size >= perAccount) {
      deny(
        response,
        429,
        'too_many_links',
        `That account is already holding ${perAccount} canvas lines. Close Cookrew on a Mac you are not using.`
      )
      return
    }
    const write = openNdjson(response)
    const socket: HubSocket = {
      send: write,
      close: () => {
        if (!response.writableEnded) response.end()
      }
    }
    // `receipts`: this registry answers an uplink's `?acks=1` (sendReceipts).
    const opened = hub.openDoor(name, socket, { receipts: true })
    if (!opened.ok) {
      // A line already held. Said in the stream rather than as a status,
      // because the head is already out — and a second claim is REFUSED
      // rather than taking over, since a takeover is how a stolen session
      // steals the traffic meant for the real machine.
      write(encodeFrame({ t: 'abort', id: 'x', reason: opened.reason }))
      response.end()
      return
    }
    // A desktop that opens a downlink and never an uplink is dropped by the
    // same deadline as one whose uplink died.
    live.hold(name, socket)
    holdsLine(name)
    log(`canvas relay: ${name} opened a line`)
    // THE RESPONSE, not the request: a GET's request stream completes as soon
    // as its empty body has arrived, so listening there drops the line at once.
    response.on('close', () => {
      if (live.holds(name, socket)) {
        live.release(name)
        releasesLine(name)
        hub.closeDoor(name)
        log(`canvas relay: ${name} closed its line`)
      }
    })
  }

  /**
   * RECEIPTS FOR AN UPLINK THAT ASKED: how many bytes of its body have arrived,
   * on its own downlink, at most every RECEIPT_EVERY_MS. Counted from this
   * uplink's first byte, so a redialled line starts again from zero, which is
   * what the desktop's own count does too.
   */
  const sendReceipts = (request: IncomingMessage, current: () => boolean, socket: HubSocket): void => {
    let got = 0
    let told = 0
    let timer: NodeJS.Timeout | null = null
    const tell = (): void => {
      timer = null
      if (got === told || !current()) return
      told = got
      socket.send(encodeFrame({ t: 'got', n: got }))
    }
    request.on('data', (chunk: Buffer) => {
      got += chunk.byteLength
      if (timer !== null) return
      timer = setTimeout(tell, receiptMs)
      timer.unref?.()
    })
    const stop = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    // AT ONCE, before a byte has arrived: it is how the desktop learns this
    // registry sends receipts, so its first answer is already paced rather
    // than poured out ahead of the first receipt.
    if (current()) socket.send(encodeFrame({ t: 'got', n: 0 }))
    // Not request.on('close'): on a streaming request it fires at once (see
    // the uplink below). A late timer is harmless anyway: it checks the line.
    request.on('end', stop)
    request.on('error', stop)
  }

  /** THE DESKTOP'S UPLINK — one long chunked POST carrying answers back. */
  const uplink = (request: IncomingMessage, response: ServerResponse, raw: string): void => {
    const name = lineFor(request, response, raw)
    if (name === null) return
    const socket = live.socketOf(name)
    if (socket === undefined) {
      deny(response, 409, 'no_link', 'Open the downlink for this Mac before its uplink.')
      return
    }
    if (wantsReceipts(request)) sendReceipts(request, () => live.socketOf(name) === socket, socket)
    readFrameLines(request, (line) => {
      // The pong is for the relay, not for any reader.
      if (line.startsWith('{"t":"pong"')) {
        // A pong already in flight when the line was dropped sees a line that
        // is gone, and a sighting now would write a deleted name back.
        if (live.socketOf(name) === socket) {
          live.beat(name)
          sawLine(name)
        }
      }
      else hub.fromDoor(name, line)
    })
    /**
     * NO UPLINK MEANS NOT REACHABLE, and the line must stop claiming otherwise.
     * The downlink is what holds the name; a desktop whose uplink died would
     * receive every request and answer none while the picker said RELAY.
     */
    const gone = (): void => {
      if (live.socketOf(name) === socket) dropLink(name, 'lost its uplink')
    }
    // NOT request.on('close') — on a streaming request that fires immediately
    // and would un-register a desktop that had just connected.
    request.on('end', () => {
      gone()
      if (!response.writableEnded) v2Json(response, 200, { ok: true })
    })
    request.on('error', gone)
    response.on('close', () => {
      if (!response.writableEnded) gone()
    })
  }

  /**
   * IS THAT MAC HOLDING A LINE? The one fact the picker cannot find out for
   * itself: a relay session is not something a page can probe without opening
   * one. Answered only about the reader's OWN desktops, and 404 for anything
   * else — an endpoint that said "not live" for a stranger's device id would
   * be a way to ask whether that device exists.
   */
  const relayStatus = (request: IncomingMessage, response: ServerResponse, raw: string): void => {
    const signed = signedIn(request, deps.v2)
    if (signed === null) {
      refuse(response, 401, 'unauthenticated')
      return
    }
    const deviceId = (decode(raw) ?? '').toLowerCase()
    if (!signed.account.desktops.some((desktop) => desktop.deviceId === deviceId)) {
      refuse(response, 404, 'not_found')
      return
    }
    v2Json(response, 200, { live: hub.has(canvasName(signed.account.username, deviceId)) })
  }

  /** The account's desktops, each with its line's state — one read for the whole fleet. */
  const presence = (username: string): Map<string, DesktopPresence> => {
    const account = deps.v2.accounts.get(username)
    const out = new Map<string, DesktopPresence>()
    for (const desktop of account?.desktops ?? []) {
      const name = canvasName(username, desktop.deviceId)
      out.set(desktop.deviceId, { online: hub.has(name), lastSeenAt: seen.get(name) ?? null })
    }
    return out
  }

  /**
   * ONE QUESTION FOR THE WHOLE FLEET, where the account page used to
   * ask relay-status once per desktop. The same gate and the same answer as
   * relay-status — only the reader's own desktops, never a stranger's — plus
   * the cap the relay holds them to, so a page can say "8 of 11 online".
   */
  const presenceRoute = (request: IncomingMessage, response: ServerResponse): void => {
    // The console draws which machines are up: its kind of session reads this.
    const signed = signedIn(request, deps.v2, 'any', { console: true })
    if (signed === null) {
      refuse(response, 401, 'unauthenticated')
      return
    }
    // The same standing the list row gives (v2-fleet · standing), at one instant.
    const answer = fleetPresence(signed.account.desktops, presence(signed.account.username), perAccount, nowMs())
    response.setHeader('cache-control', 'private, no-store')
    v2Json(response, 200, answer)
  }

  // ── a caller's side ────────────────────────────────────────────────────

  /**
   * EVERYTHING UNDER /api/m/<machine id>/api/, forwarded as it stands.
   *
   * What admits a caller HERE is the account session in its own header; what
   * admits them at the MACHINE is the credential they already hold there. Two
   * credentials for two different questions, and neither is invented on the
   * way through — this end only says which device of the account is asking
   * (`callerDeviceHeaders`).
   */
  const proxy = (request: IncomingMessage, response: ServerResponse, url: URL, cors: Record<string, string>): void => {
    const segments = url.pathname.split('/')
    const signed = relaySignedIn(request, deps.v2)
    if (signed === null) {
      refuse(response, 401, 'unauthenticated', undefined, { ...RELAY_PRIVATE, ...cors })
      return
    }
    const deviceId = decode(segments[3] ?? '') ?? ''
    const route = segments.slice(4).join('/')
    // NOT YOURS READS AS NOT THERE: a signed-in caller asking about a machine
    // that is not a device of its own account learns nothing about whether it
    // exists. The same answer for an address that is not a machine's API.
    if (!isMachineId(deviceId) || !isRelayedRoute(route) || !signed.account.devices.some((device) => device.id === deviceId)) {
      refuse(response, 404, 'not_found', undefined, { ...RELAY_PRIVATE, ...cors })
      return
    }
    // The line is named from the SESSION's account, never from the address.
    const name = canvasName(signed.account.username, deviceId)
    if (!hub.has(name)) {
      deny(response, 503, 'no_link', 'That machine is not holding a relay session just now.', { ...RELAY_PRIVATE, ...cors })
      return
    }
    const path = `/${route}${url.search}`

    const method = (request.method ?? 'GET').toUpperCase()
    const chunks: Buffer[] = []
    let size = 0
    /** This request's share of the shared budget, so it can be given back. */
    let counted = 0
    let refusal: 'too_large' | 'busy' | null = null
    const release = (): void => {
      buffering -= counted
      counted = 0
    }
    request.on('data', (chunk: Buffer) => {
      if (refusal !== null) return
      size += chunk.byteLength
      // Two different noes: this body is too big for the path, or the process
      // is already holding as much as it will hold for everybody at once.
      if (size > CANVAS_BODY_MAX) refusal = 'too_large'
      else if (buffering + chunk.byteLength > budget) refusal = 'busy'
      if (refusal !== null) {
        chunks.length = 0
        release()
        request.resume()
        return
      }
      buffering += chunk.byteLength
      counted += chunk.byteLength
      chunks.push(chunk)
    })
    // Whatever ends this request — an end, an abort, a dropped network — the
    // budget is given back. A leak here is a relay that refuses everybody
    // after a while and cannot say why.
    request.on('close', release)
    request.on('end', () => {
      release()
      if (refusal === 'too_large') {
        deny(response, 413, 'too_large', 'That was larger than this path carries. Four megabytes is the limit.', { ...RELAY_PRIVATE, ...cors })
        return
      }
      if (refusal === 'busy') {
        deny(response, 503, 'busy', 'The relay is carrying more than it can right now. Try again in a moment.', { ...RELAY_PRIVATE, ...cors })
        return
      }
      const body = Buffer.concat(chunks)
      counts.bytesUp += body.byteLength
      open(request, response, {
        name,
        method,
        path,
        cors,
        headers: {
          ...allowedRequestHeaders(request.headers),
          // LAST, so nothing a caller invented can shadow them.
          ...callerDeviceHeaders(signed.device)
        },
        body
      })
    })
  }

  /** One exchange, from the open frame to the last byte of the answer. */
  const open = (
    request: IncomingMessage,
    response: ServerResponse,
    exchange: {
      name: string
      method: string
      path: string
      /** What lets the console's page read this answer, or nothing for a caller that is not a page. */
      cors: Record<string, string>
      headers: Record<string, string>
      body: Buffer
    }
  ): void => {
    // THE LINE IS SOMEBODY'S LAPTOP. It answers a handful of things at once,
    // and a caller opening a thousand exchanges against it is not using it —
    // it is making this process and that machine hold a thousand of anything.
    const inFlight = exchanges.get(exchange.name) ?? 0
    if (inFlight >= perLink) {
      deny(
        response,
        503,
        'too_many_exchanges',
        `That machine is already carrying ${perLink} requests through the relay. Try again in a moment.`,
        { ...RELAY_PRIVATE, ...exchange.cors }
      )
      return
    }
    let headed = false
    /** The answer was refused at its head: nothing after it is written. */
    let refused = false
    /** This exchange's stream on the line, once it is open. */
    let streamId: string | null = null
    let down = 0
    const finish = (): void => {
      if (!response.writableEnded) response.end()
    }
    /**
     * TWO CLOCKS, because there are two ways a relayed exchange dies quietly.
     *
     * A desktop that never answers at all would otherwise hold this request,
     * its buffered body and a stream id forever — no socket closes, because
     * both ends are still perfectly connected to a relay that is waiting. And
     * a stream that was answered and then stopped mid-body looks, from here,
     * exactly like an SSE line with nothing to say. So: a wall-clock deadline
     * until the first head frame, and an idle deadline between chunks after
     * it, which every chunk — including the line's own keepalive — resets.
     */
    let clock: NodeJS.Timeout | null = null
    const stopClock = (): void => {
      if (clock !== null) clearTimeout(clock)
      clock = null
    }
    const startClock = (ms: number, why: string): void => {
      stopClock()
      clock = setTimeout(() => expire(why), ms)
      clock.unref?.()
    }
    /** One frame of the machine's answer, written out. */
    const takeFrame = (line: string): void => {
      const frame = decodeFrame(line)
      if (!frame) return
      if (frame.t === 'head' && !headed) {
        headed = true
        // NOT AN API ANSWER: a page a browser would run, or a redirect to
        // somewhere a machine chose. Refused whole, the machine told to stop,
        // and not a byte of what it sent passed on.
        const type = Object.entries(frame.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? ''
        if ((frame.status >= 300 && frame.status < 400 && frame.status !== 304) || isPageType(type)) {
          refused = true
          stopClock()
          deny(response, 502, 'not_an_api', 'That machine answered with something other than its API.', {
            ...RELAY_PRIVATE,
            ...exchange.cors
          })
          if (streamId !== null) hub.closeCaller(streamId)
          return
        }
        startClock(idleMs, 'went silent after its head')
        response.writeHead(frame.status, relayAnswerHeaders(frame.headers, exchange.cors))
        return
      }
      if (refused) return
      if (frame.t === 'chunk') {
        startClock(idleMs, 'went silent mid-answer')
        const bytes = Buffer.from(frame.data, 'base64')
        down += bytes.byteLength
        counts.bytesDown += bytes.byteLength
        if (!response.writableEnded) response.write(bytes)
        return
      }
      if (frame.t === 'end') {
        stopClock()
        finish()
        return
      }
      if (frame.t === 'abort') {
        stopClock()
        // Nothing has been said yet: a status is still possible, and it is
        // kinder than an empty 200.
        if (!headed) {
          headed = true
          deny(response, 502, 'no_link', 'That machine stopped answering part-way through.', { ...RELAY_PRIVATE, ...exchange.cors })
        }
        finish()
      }
    }
    const socket: HubSocket = {
      // NOTHING A MACHINE SENDS MAY THROW PAST HERE. This runs inside the
      // line's own reader; an error let out of it would end the process, and
      // with it every other machine's line. The exchange is given up instead.
      send: (line) => {
        try {
          takeFrame(line)
        } catch {
          // Whatever it was, the reader is told plainly if nothing has gone out yet.
          if (!response.headersSent) {
            headed = true
            refused = true
            deny(response, 502, 'not_an_api', 'That machine answered with something other than its API.', { ...RELAY_PRIVATE, ...exchange.cors })
          }
          expire('answered with something the relay could not write')
        }
      },
      close: finish
    }
    const opened = hub.openStream(exchange.name, socket, {
      method: exchange.method,
      path: exchange.path,
      headers: exchange.headers
    })
    if (!opened.ok) {
      deny(response, 503, 'no_link', 'That machine is not holding a relay session just now.', { ...RELAY_PRIVATE, ...exchange.cors })
      return
    }
    streamId = opened.id
    counts.open += 1
    counts.opened += 1
    exchanges.set(exchange.name, inFlight + 1)
    startClock(headMs, 'was never answered')
    // THE BODY IS NOT LOGGED AND NOT READ. Only that a session opened, under
    // which name, and — when it ends — how much crossed.
    log(`canvas relay: ${exchange.name} session ${opened.id} opened`)
    // BASE64, in both directions. A canvas serves images and fonts as well as
    // JSON, and a frame's `data` is a JSON string: bytes that are not valid
    // UTF-8 would come out mangled. It is also the shape a sealed payload will
    // have, so the encoding does not change again when the seal lands.
    for (let at = 0; at < exchange.body.byteLength; at += CANVAS_CHUNK) {
      const slice = exchange.body.subarray(at, at + CANVAS_CHUNK)
      const done = at + CANVAS_CHUNK >= exchange.body.byteLength
      hub.fromCaller(
        opened.id,
        socket,
        encodeFrame({ t: 'body', id: opened.id, data: slice.toString('base64'), ...(done ? { done: true } : {}) })
      )
    }
    if (exchange.body.byteLength === 0) {
      hub.fromCaller(opened.id, socket, encodeFrame({ t: 'body', id: opened.id, data: '', done: true }))
    }
    let accounted = false
    const settle = (): void => {
      if (accounted) return
      accounted = true
      stopClock()
      counts.open -= 1
      counts.closed += 1
      const left = (exchanges.get(exchange.name) ?? 1) - 1
      if (left <= 0) exchanges.delete(exchange.name)
      else exchanges.set(exchange.name, left)
      log(`canvas relay: ${exchange.name} session ${opened.id} closed, ${exchange.body.byteLength}b up, ${down}b down`)
    }
    /**
     * A deadline passed. The desktop is told to stop (so it does not go on
     * writing into a stream nobody is reading), the reader is given a status
     * if none has gone out yet, and the exchange is released — the whole point
     * of a bound is that the thing it bounds is actually let go of.
     */
    const expire = (why: string): void => {
      stopClock()
      log(`canvas relay: ${exchange.name} session ${opened.id} ${why}`)
      hub.closeCaller(opened.id)
      if (!headed) {
        headed = true
        deny(response, 504, 'timed_out', 'That machine did not answer in time. Try again in a moment.', { ...RELAY_PRIVATE, ...exchange.cors })
      }
      finish()
      settle()
    }
    response.on('close', () => {
      // THE READER HUNG UP — a closed tab, a lost network, a killed app. The
      // request's own close fires as soon as its body is in, which for most
      // exchanges is immediately; the response closing early is the honest one.
      if (!response.writableEnded) hub.closeCaller(opened.id)
      settle()
    })
    response.on('finish', settle)
    void request
  }

  return {
    hub,
    live: (username, deviceId) => hub.has(canvasName(username, deviceId)),
    hangUp: (username, deviceIds) => {
      const under = `@${username}/`
      const lines = new Set([...deviceIds.map((id) => canvasName(username, id)), ...hub.namesUnder(under)])
      for (const name of lines) dropLink(name, 'account deleted')
      seen.forgetWhere((name) => name.startsWith(under))
    },
    presence,
    stats: () => ({ links: live.size, ...counts }),
    stop: () => {
      live.stop()
      seen.flush()
    },
    handle(request, response, parts, url) {
      const method = request.method ?? 'GET'
      // The desktop's own pair of halves, under one name: GET is the downlink,
      // POST the uplink, and neither exists without the other.
      if (parts.length === 4 && parts[0] === 'v2' && parts[1] === 'canvas' && parts[2] === 'link') {
        // THE GET IS GATED TOO, and that is the unusual part: it is a read by
        // its method and a WRITE by its effect, because it claims a name. A
        // cross-site page that could cause one could take a desktop's own line
        // before the desktop asks for it, and the owner would find their Mac
        // unreachable with nothing to look at. The app's Bearer path is not a
        // browser and is unaffected.
        if (!bearing(request) && crossSite(request)) {
          refuse(response, 403, 'bad_origin')
          return true
        }
        if (method === 'GET') downlink(request, response, parts[3])
        else if (method === 'POST') uplink(request, response, parts[3])
        else refuse(response, 405, 'method_not_allowed')
        return true
      }
      if (
        method === 'GET' &&
        parts.length === 5 &&
        parts[0] === 'v2' &&
        parts[1] === 'me' &&
        parts[2] === 'desktops' &&
        parts[4] === 'relay-status'
      ) {
        relayStatus(request, response, parts[3])
        return true
      }
      if (method === 'GET' && parts.length === 3 && parts[0] === 'v2' && parts[1] === 'me' && parts[2] === 'presence') {
        presenceRoute(request, response)
        return true
      }
      // ONE RELAY PATH, for every client (shared/machine-relay.ts): the machine
      // and route in the path (`/api/m/<machine>/<route>`), or at the one
      // address `/api/m` with both in headers, which is how a browser page
      // asks its preflight once (relayAtOneAddress).
      if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'm') {
        const verdict = originVerdict(request, deps.v2.consoleOrigin)
        // A page of any origin but the console's is refused before a session is
        // read or a machine asked, and told nothing it could read.
        if (!verdict.ok) {
          refuse(response, 403, 'bad_origin', undefined, RELAY_PRIVATE)
          return true
        }
        // THE PREFLIGHT IS ANSWERED HERE, before auth and without the machine:
        // a browser sends it with no credential by construction, and its
        // answer is a list of names, the same for every path.
        if (method === 'OPTIONS') {
          if (verdict.cors['access-control-allow-origin'] === undefined) {
            refuse(response, 403, 'bad_origin', undefined, RELAY_PRIVATE)
            return true
          }
          response.writeHead(204, {
            ...RELAY_PRIVATE,
            ...verdict.cors,
            'access-control-allow-methods': RELAY_CORS_METHODS,
            'access-control-allow-headers': RELAY_CORS_HEADERS,
            'access-control-max-age': RELAY_CORS_MAX_AGE
          })
          response.end()
          return true
        }
        const target = parts.length === 2 ? oneAddress(request, url) : url
        if (target === null) {
          refuse(response, 404, 'not_found', undefined, { ...RELAY_PRIVATE, ...verdict.cors })
          return true
        }
        proxy(request, response, target, verdict.cors)
        return true
      }
      return false
    }
  }
}
