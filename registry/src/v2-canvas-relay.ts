import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { decodeFrame, encodeFrame } from '../../src/shared/relay-frame'
import { RelayHub, type HubSocket } from './relay-hub'
import { LinkPulse, openNdjson, readFrameLines } from './relay-link'
import { PRIVATE, refuse, signedIn, v2Json, type V2Identity } from './v2-http'
import { relayNotYoursPage, relayOfflinePage, relaySignInPage } from './site-relay'
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
 * THE REQUEST HEADERS THAT CROSS. An allow-list, because the opposite is a
 * list of everything a browser might ever invent — and `authorization`,
 * `x-forwarded-for` and the reader's IP are all things the desktop has no
 * business learning from a relay.
 */
const REQUEST_HEADERS = new Set(['content-type', 'accept', 'last-event-id'])
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

/** Is the reader a browser following a link, or a script? Decides page vs JSON. */
const wantsPage = (request: IncomingMessage): boolean =>
  (request.headers.accept ?? '').includes('text/html')

export function createCanvasRelay(deps: CanvasRelayDeps): CanvasRelay {
  const log = deps.log ?? ((): void => undefined)
  const hub = new RelayHub(log, isCanvasName)
  const counts = { open: 0, opened: 0, closed: 0, bytesUp: 0, bytesDown: 0 }

  const live: LinkPulse = new LinkPulse({
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.pulseMs === undefined ? {} : { pulseMs: deps.pulseMs }),
    ...(deps.pulseDeadlineMs === undefined ? {} : { deadlineMs: deps.pulseDeadlineMs }),
    drop: (name, why) => dropLink(name, why)
  })

  const dropLink = (name: string, why: string): void => {
    const socket = live.socketOf(name)
    live.release(name)
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
    log(`canvas relay: ${name} opened a line`)
    // THE RESPONSE, not the request: a GET's request stream completes as soon
    // as its empty body has arrived, so listening there drops the line at once.
    response.on('close', () => {
      if (live.holds(name, socket)) {
        live.release(name)
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
   * The first request is the ADMISSION and it is not special here: the
   * picker's `?open=<canvasToken>&key=<pairing key>&device=<id>` rides through
   * unchanged, and the desktop admits exactly as it does over the LAN. This
   * end has no opinion about it, which is what keeps one admission ceremony
   * rather than two that drift.
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

    const method = (request.method ?? 'GET').toUpperCase()
    const chunks: Buffer[] = []
    let size = 0
    let tooBig = false
    request.on('data', (chunk: Buffer) => {
      if (tooBig) return
      size += chunk.byteLength
      if (size > CANVAS_BODY_MAX) {
        tooBig = true
        chunks.length = 0
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooBig) {
        deny(response, 413, 'too_large', 'That was larger than this path carries. Four megabytes is the limit.')
        return
      }
      const body = Buffer.concat(chunks)
      counts.bytesUp += body.byteLength
      open(request, response, {
        name,
        method,
        path,
        cookiePath,
        headers: allowedRequestHeaders(request.headers),
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
      cookiePath: string
      headers: Record<string, string>
      body: Buffer
    }
  ): void => {
    let headed = false
    let down = 0
    const finish = (): void => {
      if (!response.writableEnded) response.end()
    }
    const socket: HubSocket = {
      send: (line) => {
        const frame = decodeFrame(line)
        if (!frame) return
        if (frame.t === 'head' && !headed) {
          headed = true
          response.writeHead(frame.status, answerHeaders(frame.headers, exchange.cookiePath))
          return
        }
        if (frame.t === 'chunk') {
          const bytes = Buffer.from(frame.data, 'base64')
          down += bytes.byteLength
          counts.bytesDown += bytes.byteLength
          if (!response.writableEnded) response.write(bytes)
          return
        }
        if (frame.t === 'end') {
          finish()
          return
        }
        if (frame.t === 'abort') {
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
      counts.open -= 1
      counts.closed += 1
      log(`canvas relay: ${exchange.name} session ${opened.id} closed, ${exchange.body.byteLength}b up, ${down}b down`)
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
  cookiePath: string
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase()
    if (HOP_BY_HOP.has(name)) continue
    out[name] = value
  }
  const cookies = headers['set-cookie']
  if (typeof cookies === 'string' && cookies.length > 0) {
    out['set-cookie'] = cookies
      .split('\n')
      .map((cookie) => cookie.trim())
      .filter((cookie) => cookie.length > 0)
      .map((cookie) => rewriteCookiePath(cookie, cookiePath))
  }
  // A canvas is one reader's, and an SSE stream must not be held by a proxy
  // until it ends — which for the line is never.
  return { ...out, ...PRIVATE, 'x-accel-buffering': 'no' }
}
