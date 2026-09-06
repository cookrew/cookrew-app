import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { decodeFrame, encodeFrame } from '../../src/shared/relay-frame'
import { RelayHub, type HubSocket } from './relay-hub'
import { LinkPulse, openNdjson, readFrameLines } from './relay-link'
import { PRIVATE, refuse, sameOrigin, signedIn, v2Json, type V2Identity } from './v2-http'
import {
  relayCrossSitePage,
  relayNotYoursPage,
  relayOfflinePage,
  relaySignInPage
} from './site-relay'
import { respondPage } from './site-shell'

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
 *   THE PHONE MUST BE ON THE ACCOUNT. Everything under
 *   `/relay/@user/desktop/<id>/` needs a v2 session of a device attached to
 *   THAT account. The name forwarded to is built from the SESSION's username,
 *   never from the path, so a link cannot address somebody else's Mac.
 *
 *   cookrew.dev IS NOT A PARTY TO THE CONVERSATION. Its own session cookie is
 *   never forwarded; cookies the desktop sets are pinned to the relay path so
 *   they can never be sent to cookrew.dev's own routes; bodies are not read
 *   and never logged. What is logged is that a session opened, that it closed,
 *   and how many bytes crossed.
 *
 * NOT SEALED YET, AND THIS MATTERS. TLS to cookrew.dev and TLS onward is two
 * hops, not end to end: this process handles plaintext, so a relay operator
 * could read a canvas — including the `?open=` token and the pairing key on
 * the first request. The frames reserve `sealed` for the ciphertext that fixes
 * it (see relay-frame.ts); until that lands, this path is the owner reaching
 * their own machine through their own registry, and it must not be described
 * as end-to-end private.
 */

/** A canvas token's audience, and half of a canvas line's name: a uuid. */
const DEVICE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/

/** `@user/desktop/<deviceId>` — one desktop's canvas, in the hub's namespace. */
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
 * The arithmetic is the point: 8 lines × 16 exchanges × 4 MB is 512 MB per
 * account, which is why the LAST of these is a budget across the whole relay
 * rather than another per-account number. A cap that multiplies is not a cap.
 */
/** Exchanges one desktop's line carries at once. A canvas opens a handful. */
export const EXCHANGES_PER_LINK = 16
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
/** Request bodies being buffered across the WHOLE relay at once. */
export const BODY_BUDGET = 64 * 1024 * 1024

/**
 * THE REQUEST HEADERS THAT CROSS. An allow-list, because the opposite is a
 * list of everything a browser might ever invent — and `authorization`,
 * `x-forwarded-for` and the reader's IP are all things the desktop has no
 * business learning from a relay.
 */
const REQUEST_HEADERS = new Set(['content-type', 'accept', 'last-event-id', 'authorization'])

/**
 * `authorization` CROSSES, and the reason it now does is the whole shape of
 * this path.
 *
 * It was stripped at first, on the reasoning that cookrew.dev's credential is
 * none of the desktop's business. That was right about the credential and
 * wrong about the header: the companion authenticates to its OWN Mac with
 * `Authorization: Bearer <companion token>` (mobile-http.presentedToken), so
 * stripping it made every API call the canvas issues a 401 — the phone landed
 * on a shell that could not read a thing. cookrew.dev's own session lives in
 * the cookie, which IS stripped, and nothing here reads this header any more
 * (the prefix is admitted by cookie alone), so it is the desktop's to receive.
 */

/**
 * THE PREFIX THIS CANVAS IS BEING SERVED UNDER, told to the desktop.
 *
 * The companion computes every API path from a global the desktop injects into
 * index.html (`COOKREW_SLUG` → `API_BASE`, api-base.ts). Through the relay the
 * desktop cannot know it is being served under `/relay/@user/desktop/<id>` —
 * nothing in the request says so — and a client that issues root-absolute
 * `/api/...` under that prefix is asking cookrew.dev, which has no such route.
 *
 * So the registry says it, on every forwarded exchange. A client-supplied copy
 * is REMOVED first: this header is a statement about where the request was
 * addressed, and a caller that could write it could tell the desktop to serve
 * a client pointed anywhere.
 */
export const CANVAS_BASE_HEADER = 'x-cookrew-base'

/**
 * WHO IS ASKING, told to the desktop — reach v2.1.
 *
 * The Mac has to be able to name the devices it is serving: its admitted list,
 * its log, the sentence a person reads about a phone that is on their canvas
 * right now. It used to learn that from the admission ceremony — a canvas
 * token plus `?device=&name=` on the query — and that whole ceremony is gone
 * (one credential, one URL). Nothing else in a relayed request says who the
 * reader is, because the credential that admitted them is cookrew.dev's own
 * cookie and the cookie is stripped.
 *
 * So the registry states it, on every forwarded exchange, FROM THE SESSION it
 * just verified and from nothing the client sent. A client-supplied copy is
 * REMOVED first, exactly as `x-cookrew-base` is: a caller who could write
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

/** cookrew.dev's OWN cookies, which never leave cookrew.dev. */
const OUR_COOKIES = new Set(['cr_session', 'cr_account'])
/** Hop-by-hop, plus the length we cannot honour because we stream. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'content-length',
  'set-cookie'
])
/** A header value larger than this is not a header, it is a payload. */
const HEADER_MAX = 8 * 1024

/**
 * The cookies of this request that belong to the DESKTOP, as one header value.
 *
 * cookrew.dev's session is dropped: the desktop must never be handed the
 * credential that opens its owner's account, and a compromised canvas must not
 * become a compromised account. Everything else is the desktop's own — the
 * cookies it set under the relay path, which is the only place a browser will
 * send them back to.
 */
export function forwardableCookies(header: string): string {
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !OUR_COOKIES.has(part.slice(0, part.indexOf('=')).trim()))
    .join('; ')
}

/** The request headers a relayed exchange may carry, lowercased. */
export function allowedRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || value.length > HEADER_MAX) continue
    const name = key.toLowerCase()
    if (name === 'cookie') {
      const mine = forwardableCookies(value)
      if (mine.length > 0) out.cookie = mine
      continue
    }
    // OURS TO WRITE, NEVER THEIRS. Set below from the address the request
    // actually arrived at, and from the session it arrived with.
    if (name === CANVAS_BASE_HEADER || name === CANVAS_DEVICE_HEADER || name === CANVAS_DEVICE_NAME_HEADER) {
      continue
    }
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
 * A cookie the desktop set, PINNED TO THE RELAY PATH.
 *
 * The desktop believes it is at the root of its own origin and says `Path=/`;
 * under the relay it shares an origin with cookrew.dev, and a cookie at `/`
 * would be sent to the sign-in, the market and every other route here. So the
 * path is replaced rather than accepted, and `Domain` is removed outright — a
 * desktop naming a domain is a desktop writing a cookie for cookrew.dev.
 */
export function rewriteCookiePath(cookie: string, path: string): string {
  const kept = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part, index) => {
      if (index === 0) return true
      const name = part.slice(0, part.indexOf('=') === -1 ? part.length : part.indexOf('=')).toLowerCase()
      return name !== 'path' && name !== 'domain'
    })
  return [...kept, `Path=${path}`].join('; ')
}

/**
 * WHERE A REDIRECT FROM THE DESKTOP ACTUALLY POINTS.
 *
 * The admission answers `303 Location: /?token=<companion token>` — root
 * absolute, because on the LAN the desktop IS the root. Forwarded as it stands
 * that sends the browser to `https://cookrew.dev/?token=…`, which is the home
 * page: OPEN over the relay landed on the marketing site with a credential in
 * the address bar, and the canvas was never reached. (Found on the live site,
 * 2026-09-06.)
 *
 * Three cases, and the third is the one that must NOT be rewritten:
 *   `/…`                        → under the prefix, where the desktop is.
 *   an absolute URL elsewhere   → its path, under the prefix: the desktop
 *                                 naming its own LAN origin still means "me".
 *   an absolute URL at OUR host → untouched. `?refused=key` sends the reader
 *                                 back to /me on cookrew.dev, and prefixing
 *                                 that would send them to a canvas instead.
 *
 * A relative reference (`board`) resolves against the path this exchange was
 * for, which is what a browser would have done with the desktop's answer.
 */
export function rewriteLocation(
  value: string,
  at: { prefix: string; path: string; host: string }
): string {
  try {
    const target = new URL(value, `https://desktop.invalid${at.path}`)
    if (target.host === at.host) return value
    return `${at.prefix}${target.pathname}${target.search}${target.hash}`
  } catch {
    // Not a location this can reason about. Left alone rather than guessed at.
    return value
  }
}

/**
 * `Refresh: 5; url=/board` — a redirect wearing a different hat, and it has to
 * be rewritten by the same rule or it is the same bug with a delay on it.
 */
export function rewriteRefresh(value: string, at: { prefix: string; path: string; host: string }): string {
  const semicolon = value.indexOf(';')
  if (semicolon === -1) return value
  const head = value.slice(0, semicolon)
  const tail = value.slice(semicolon + 1).trim()
  const named = /^url\s*=\s*(.*)$/i.exec(tail)
  const target = named === null ? tail : named[1].trim()
  if (target.length === 0) return value
  const quoted = /^(['"])(.*)\1$/.exec(target)
  const rewritten = rewriteLocation(quoted === null ? target : quoted[2], at)
  return `${head}; url=${rewritten}`
}

/** What the /relay prefix logs, and the only numbers it keeps. */
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
  bodyBudget?: number
}

/** A refusal this file words itself, for the routes only a desktop calls. */
const deny = (response: ServerResponse, code: number, error: string, message: string): void =>
  v2Json(response, code, { error, message })

/** decodeURIComponent that answers null rather than throwing on a bad escape. */
const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/**
 * THE COOKIE ADMITS HERE, AND ONLY THE COOKIE.
 *
 * Under this prefix a whole app arrives, and it will carry `Authorization`
 * headers of its OWN — a canvas token, a call token, whatever the companion
 * sends its Mac. Read as cookrew.dev's own credential those would turn every
 * one of the app's requests into a failed sign-in, so the session is taken
 * from the cookie a browser attached and from nowhere else. The header is not
 * forwarded either: see REQUEST_HEADERS.
 */
const cookieSignedIn = (request: IncomingMessage, v2: V2Identity): ReturnType<typeof signedIn> =>
  signedIn({ headers: { cookie: request.headers.cookie ?? '' } } as IncomingMessage, v2)

/**
 * A REQUEST ANOTHER SITE CAUSED, WHICH IS NEVER THIS PERSON'S WISH.
 *
 * Both prefixes here are state-changing in ways a `GET` usually is not: the
 * downlink CLAIMS A NAME, and a claim someone else's page can cause is a name
 * someone else's page can squat — the real desktop then finds its own line
 * taken. So the browser's own account of where the request came from is what
 * decides, and only `same-origin` (the picker's `location.assign`) and `none`
 * (a typed address or a bookmark) are this person's.
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
 * The desktop app's own path, which is not a browser and carries no cookie.
 * A browser cannot forge it: a cross-site fetch that sets `Authorization` is
 * preflighted, and this origin answers no preflight.
 */
const bearing = (request: IncomingMessage): boolean =>
  (request.headers.authorization ?? '').startsWith('Bearer ')

/** Is the reader a browser following a link, or a script? Decides page vs JSON. */
const wantsPage = (request: IncomingMessage): boolean =>
  (request.headers.accept ?? '').includes('text/html')

export function createCanvasRelay(deps: CanvasRelayDeps): CanvasRelay {
  const log = deps.log ?? ((): void => undefined)
  const hub = new RelayHub(log, isCanvasName)
  const counts = { open: 0, opened: 0, closed: 0, bytesUp: 0, bytesDown: 0 }
  const perLink = deps.exchangesPerLink ?? EXCHANGES_PER_LINK
  const perAccount = deps.linksPerAccount ?? LINKS_PER_ACCOUNT
  const headMs = deps.headDeadlineMs ?? HEAD_DEADLINE_MS
  const idleMs = deps.idleDeadlineMs ?? IDLE_DEADLINE_MS
  const budget = deps.bodyBudget ?? BODY_BUDGET
  /** Exchanges in flight per line, so one desktop cannot be made to hold many. */
  const exchanges = new Map<string, number>()
  /** The lines each account holds, so one account cannot hold many. */
  const holding = new Map<string, Set<string>>()
  /** Request bytes buffered right now, across every exchange. */
  let buffering = 0

  /** The account a canvas name belongs to. The name is built from a token. */
  const ownerOf = (name: string): string => name.slice(1, name.indexOf('/'))
  const holdsLine = (name: string): void => {
    const owner = ownerOf(name)
    const mine = holding.get(owner) ?? new Set<string>()
    mine.add(name)
    holding.set(owner, mine)
  }
  const releasesLine = (name: string): void => {
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
    const opened = hub.openDoor(name, socket)
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

  /** THE DESKTOP'S UPLINK — one long chunked POST carrying answers back. */
  const uplink = (request: IncomingMessage, response: ServerResponse, raw: string): void => {
    const name = lineFor(request, response, raw)
    if (name === null) return
    const socket = live.socketOf(name)
    if (socket === undefined) {
      deny(response, 409, 'no_link', 'Open the downlink for this Mac before its uplink.')
      return
    }
    readFrameLines(request, (line) => {
      // The pong is for the relay, not for any reader.
      if (line.startsWith('{"t":"pong"')) live.beat(name)
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

  // ── the phone's side ───────────────────────────────────────────────────

  /**
   * EVERYTHING UNDER /relay/@user/desktop/<id>/, forwarded as it stands.
   *
   * The first request is not special: OPEN on /me is a plain navigation to
   * this prefix with nothing on the query, and the desktop serves its shell.
   * What admits a reader HERE is the account cookie; what admits them at the
   * MAC is the pairing token their companion already holds. Two credentials
   * for two different questions, and neither is invented on the way through —
   * this end only says which prefix and which device (`callerDeviceHeaders`).
   */
  const proxy = (request: IncomingMessage, response: ServerResponse, url: URL): void => {
    const segments = url.pathname.split('/')
    const signed = cookieSignedIn(request, deps.v2)
    if (signed === null) {
      if (wantsPage(request)) respondPage(response, relaySignInPage())
      else refuse(response, 401, 'unauthenticated')
      return
    }
    const asked = (decode(segments[2] ?? '') ?? '').toLowerCase().replace(/^@/, '')
    const deviceId = (decode(segments[4] ?? '') ?? '').toLowerCase()
    // NOT YOURS READS AS NOT THERE. A signed-in reader asking about another
    // account's desktop learns nothing about whether it exists.
    if (asked !== signed.account.username || !DEVICE.test(deviceId)) {
      if (wantsPage(request)) respondPage(response, relayNotYoursPage())
      else refuse(response, 404, 'not_found')
      return
    }
    const name = canvasName(signed.account.username, deviceId)
    if (!hub.has(name)) {
      if (wantsPage(request)) respondPage(response, relayOfflinePage())
      else deny(response, 503, 'no_link', 'That Mac is not holding a relay session just now.')
      return
    }
    const base = `${segments.slice(0, 5).join('/')}`
    const rest = url.pathname.slice(base.length)
    const path = `${rest.length === 0 ? '/' : rest}${url.search}`
    const cookiePath = `${base}/`
    /** Our own host, so a redirect BACK to cookrew.dev is left where it points. */
    const host = typeof request.headers.host === 'string' ? request.headers.host : ''

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
        deny(response, 413, 'too_large', 'That was larger than this path carries. Four megabytes is the limit.')
        return
      }
      if (refusal === 'busy') {
        deny(response, 503, 'busy', 'cookrew.dev is carrying more than it can right now. Try again in a moment.')
        return
      }
      const body = Buffer.concat(chunks)
      counts.bytesUp += body.byteLength
      open(request, response, {
        name,
        method,
        path,
        prefix: base,
        cookiePath,
        host,
        headers: {
          ...allowedRequestHeaders(request.headers),
          [CANVAS_BASE_HEADER]: base,
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
      /** `/relay/@user/desktop/<id>`, with no trailing slash. */
      prefix: string
      cookiePath: string
      /** The host this request arrived at — cookrew.dev's own. */
      host: string
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
        `That Mac is already carrying ${perLink} requests through the relay. Try again in a moment.`
      )
      return
    }
    let headed = false
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
    const socket: HubSocket = {
      send: (line) => {
        const frame = decodeFrame(line)
        if (!frame) return
        if (frame.t === 'head' && !headed) {
          headed = true
          startClock(idleMs, 'went silent after its head')
          response.writeHead(
            frame.status,
            answerHeaders(frame.headers, {
              cookiePath: exchange.cookiePath,
              prefix: exchange.prefix,
              path: exchange.path,
              host: exchange.host
            })
          )
          return
        }
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
            deny(response, 502, 'no_link', 'That Mac stopped answering part-way through.')
          }
          finish()
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
      deny(response, 503, 'no_link', 'That Mac is not holding a relay session just now.')
      return
    }
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
        deny(response, 504, 'timed_out', 'That Mac did not answer in time. Try again, or open it directly.')
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
    stats: () => ({ links: live.size, ...counts }),
    stop: () => live.stop(),
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
      // EVERYTHING under the prefix, whatever the method: this is a whole
      // origin's worth of app arriving through one address.
      if (parts.length >= 4 && parts[0] === 'relay' && parts[2] === 'desktop') {
        // Admitted by the cookie, so a request another site caused would be a
        // request spent on this person's behalf without them. The picker's own
        // `location.assign` from /me is same-origin and passes; every method
        // is held to it, since a GET here reaches a whole app.
        if (crossSite(request)) {
          if (wantsPage(request)) respondPage(response, relayCrossSitePage())
          else refuse(response, 403, 'bad_origin')
          return true
        }
        proxy(request, response, url)
        return true
      }
      return false
    }
  }
}

/**
 * The desktop's answer, made safe to send from cookrew.dev's origin.
 *
 * Hop-by-hop headers describe THIS hop and not the next one; the length is
 * dropped because the answer is streamed; and every cookie is re-pinned to the
 * relay path. Several `Set-Cookie` headers travel as one value with newlines
 * between them, since a frame's headers are a map and HTTP's are not.
 */
function answerHeaders(
  headers: Record<string, string>,
  at: { cookiePath: string; prefix: string; path: string; host: string }
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase()
    if (HOP_BY_HOP.has(name)) continue
    // A redirect the desktop wrote is written for its own root. Both headers
    // that carry one are moved under the prefix — see rewriteLocation.
    if (name === 'location') out[name] = rewriteLocation(value, at)
    else if (name === 'refresh') out[name] = rewriteRefresh(value, at)
    else out[name] = value
  }
  const cookies = headers['set-cookie']
  if (typeof cookies === 'string' && cookies.length > 0) {
    out['set-cookie'] = cookies
      .split('\n')
      .map((cookie) => cookie.trim())
      .filter((cookie) => cookie.length > 0)
      .map((cookie) => rewriteCookiePath(cookie, at.cookiePath))
  }
  // A canvas is one reader's, and an SSE stream must not be held by a proxy
  // until it ends — which for the line is never.
  return { ...out, ...PRIVATE, 'x-accel-buffering': 'no' }
}
