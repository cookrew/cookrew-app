/**
 * THE GUEST'S ONE DOOR (shared/machine-guest.ts): every request the guest page
 * makes at `cookrew-machine://<machine id>/…` lands here, and nowhere else.
 *
 *   the page and its assets   this app's own renderer build (or, in development,
 *                             the local Vite server), the machine's boot line
 *                             written into the page
 *   `/api/m…`                 the relay path for THAT machine only, sent down the
 *                             account's relay (account-v2.ts · relayed), which
 *                             adds the account session itself: the guest's own
 *                             stand-in session header is dropped here
 *   anything else             refused
 *
 * A locked desktop carries nothing: full control of another machine is never
 * handed out behind a locked screen (as zoom-fleet:call).
 *
 * Pure but for what is handed in, so the whole door runs in a test.
 */
import path from 'node:path'
import {
  MACHINE_RELAY_PREFIX,
  RELAY_MACHINE_HEADER,
  RELAY_ROUTE_HEADER,
  RELAY_SESSION_HEADER,
  RELAY_UNAUTHENTICATED,
  machineRelayPath,
  relayPathFromHeaders
} from '../shared/machine-relay'
import { MACHINE_GUEST_PAGE, MACHINE_GUEST_PARTITION, MACHINE_GUEST_SCHEME, guestMachineOf, type GuestBoot } from '../shared/machine-guest'

/** What the relay answered, as account-v2.ts · relayed hands it back. */
export type RelayedAnswer = { ok: true; response: Response } | { ok: false; reason: string }

export interface GuestAsset {
  readonly body: ArrayBuffer | string
  readonly type: string
}

export interface MachineGuestDeps {
  /** One call down the account's relay to a machine (the account session is added there). */
  readonly relayed: (machineId: string, route: string, init: RequestInit) => Promise<RelayedAnswer>
  /** The key this desktop holds for that machine, or null (none yet: main goes to collect one). */
  readonly keyOf: (machineId: string) => string | null
  /** A file of the renderer build, by its path on the page ('/machine.html', '/assets/…'); null when there is none. */
  readonly asset: (pathname: string, search: string) => Promise<GuestAsset | null>
  /** The owner's lock is on: nothing is carried. */
  readonly locked: () => boolean
  /** That machine refused the key held for it (its own 401): drop it, so a new one is asked for. */
  readonly refused: (machineId: string) => void
}

/** The door, and its one act from outside: cut every call still open (the owner's lock came on). */
export interface MachineGuestDoor {
  readonly handle: (request: Request) => Promise<Response>
  readonly cutAll: () => void
}

export type GuestPlan =
  | { readonly kind: 'page' }
  | { readonly kind: 'asset'; readonly pathname: string; readonly search: string }
  | { readonly kind: 'relay'; readonly machine: string; readonly route: string }
  | { readonly kind: 'refuse'; readonly status: number }

/** The routes of a relayed call, `api/…`: what `machineRelayPath` takes after the machine. */
const routeOfPath = (relayPath: string, machine: string): string => relayPath.slice(`${MACHINE_RELAY_PREFIX}/${machine}/`.length)

/**
 * What a request to the guest's origin is. The relay is reached only for the
 * machine the origin names, in either of the relay's two forms (the one address
 * with its two headers, or the path form), checked as the registry checks them.
 */
export function planGuestRequest(url: string, headers: Headers): GuestPlan {
  const machine = guestMachineOf(url)
  if (machine === null) return { kind: 'refuse', status: 404 }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { kind: 'refuse', status: 400 }
  }
  const pathname = parsed.pathname
  if (pathname === MACHINE_GUEST_PAGE || pathname === '/index.html') return { kind: 'page' }
  if (pathname === MACHINE_RELAY_PREFIX) {
    const named = headers.get(RELAY_MACHINE_HEADER)
    const route = headers.get(RELAY_ROUTE_HEADER)
    const relayPath = relayPathFromHeaders(named, route)
    if (relayPath === null || named !== machine) return { kind: 'refuse', status: 403 }
    return { kind: 'relay', machine, route: routeOfPath(relayPath, machine) }
  }
  if (pathname.startsWith(`${MACHINE_RELAY_PREFIX}/`)) {
    const found = /^\/api\/m\/([^/]+)\/(.+)$/.exec(pathname)
    const named = found?.[1]?.toLowerCase() ?? null
    const relayPath = named === machine && found ? machineRelayPath(machine, `${found[2]}${parsed.search}`) : null
    return relayPath === null ? { kind: 'refuse', status: 403 } : { kind: 'relay', machine, route: routeOfPath(relayPath, machine) }
  }
  // The rest of `/api` is a machine's, and a machine is only ever reached by the relay path above.
  if (pathname === '/api' || pathname.startsWith('/api/')) return { kind: 'refuse', status: 404 }
  return { kind: 'asset', pathname, search: parsed.search }
}

/** Headers that are the browser's or the relay's own, never carried for the guest. */
const REQUEST_DROPPED = new Set(['host', 'origin', 'referer', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', RELAY_SESSION_HEADER, RELAY_MACHINE_HEADER, RELAY_ROUTE_HEADER])

/** What of the guest's request goes on to the machine: its own credential at that machine, its content and its asks. */
export function relayRequestHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (REQUEST_DROPPED.has(lower) || lower.startsWith('sec-') || lower.startsWith('proxy-')) return
    out[lower] = value
  })
  return out
}

/**
 * Headers that described the relay's wire, not the answer the page reads: the
 * body arrives here already decoded, so its encoding and length no longer hold,
 * and nothing the relay sets for a browser (cookies, CORS) is the guest's.
 */
const RESPONSE_DROPPED = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'strict-transport-security', 'alt-svc'])

export function guestResponseHeaders(headers: Headers): Headers {
  const out = new Headers()
  headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (RESPONSE_DROPPED.has(lower) || lower.startsWith('access-control-')) return
    out.append(lower, value)
  })
  return out
}

/**
 * The guest's boot line, first thing in its page's head. Encoded, never
 * interpolated raw: JSON alone leaves `</script>` and the two line separators
 * a script cannot hold, so those are escaped too. It takes its own tag out of
 * the page once run: the key is not left in the document's text.
 */
export function guestBootScript(boot: GuestBoot): string {
  const json = JSON.stringify({ machine: boot.machine, key: boot.key })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return `<script>window.COOKREW_GUEST = ${json}; document.currentScript && document.currentScript.remove()</script>`
}

/** The page with its boot line in front of every other script (the page's first import reads it). */
export function withGuestBoot(html: string, boot: GuestBoot): string {
  const script = guestBootScript(boot)
  const head = /<head[^>]*>/i.exec(html)
  if (head === null) return `${script}${html}`
  const at = head.index + head[0].length
  return `${html.slice(0, at)}\n    ${script}${html.slice(at)}`
}

const NO_STORE = { 'cache-control': 'no-store' }

const refusal = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', ...NO_STORE } })

/** An answer with no body may not be given one (fetch refuses a Response built so). */
const BODYLESS = new Set([101, 204, 205, 304])

/**
 * Why nothing went: the account's own session is gone (said as the relay says it, so the page knows
 * this desktop is signed out, machine-scope.ts · relayRefusedSession), or nobody answered.
 */
function unsent(reason: string): Response {
  if (reason === 'no_account' || reason === 'session-expired') return refusal(401, RELAY_UNAUTHENTICATED)
  return refusal(503, reason === 'offline' ? 'offline' : 'no_link')
}

/** A machine's own 401 is a sentence about the key; the relay's says `unauthenticated` and is about the session. */
async function keyWasRefused(answer: Response): Promise<boolean> {
  if (answer.status !== 401) return false
  const said = (await answer.clone().json().catch(() => null)) as { error?: unknown } | null
  return said?.error !== RELAY_UNAUTHENTICATED
}

/**
 * The answer's body, handed on as it arrives, and cut with the call: a page letting go of a stream
 * (or the door cutting it) aborts the relay request under it, so nothing stays open in main.
 */
function carried(body: ReadableStream<Uint8Array>, cut: AbortController, done: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: ended } = await reader.read()
        if (ended) {
          done()
          controller.close()
        } else controller.enqueue(value)
      } catch (error) {
        done()
        controller.error(error)
      }
    },
    cancel() {
      cut.abort()
      done()
      void reader.cancel().catch(() => undefined)
    }
  })
}

async function relay(deps: MachineGuestDeps, open: Set<AbortController>, request: Request, machine: string, route: string): Promise<Response> {
  if (deps.locked()) return refusal(423, 'locked')
  const method = request.method.toUpperCase()
  const body = method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await request.arrayBuffer())
  const cut = new AbortController()
  const done = (): void => void open.delete(cut)
  open.add(cut)
  request.signal?.addEventListener('abort', () => cut.abort(), { once: true })
  try {
    const sent = await deps.relayed(machine, route, {
      method,
      headers: relayRequestHeaders(request.headers),
      ...(body !== undefined ? { body } : {}),
      signal: cut.signal,
      // A redirect would carry the account session to wherever it points: the page gets it as it stands.
      redirect: 'manual'
    })
    if (!sent.ok) {
      done()
      return unsent(sent.reason)
    }
    const upstream = sent.response
    if (await keyWasRefused(upstream)) deps.refused(machine)
    const headers = guestResponseHeaders(upstream.headers)
    if (BODYLESS.has(upstream.status) || method === 'HEAD' || upstream.body === null) {
      done()
      await upstream.body?.cancel().catch(() => undefined)
      return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers })
    }
    return new Response(carried(upstream.body, cut, done), { status: upstream.status, statusText: upstream.statusText, headers })
  } catch (error) {
    done()
    throw error
  }
}

/** What a page that cannot be drawn says, in a sentence and not in JSON. */
const NO_PAGE = '<!doctype html><meta charset="utf-8"><p style="font:14px system-ui;margin:40px">This machine’s view could not be loaded from this app’s build.</p>'

async function page(deps: MachineGuestDeps, machine: string): Promise<Response> {
  const found = await deps.asset('/index.html', '')
  if (found === null) return new Response(NO_PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE } })
  const html = typeof found.body === 'string' ? found.body : new TextDecoder().decode(found.body)
  // Locked, the page is still drawn (it says nothing of the machine), but holds no key.
  const key = deps.locked() ? null : deps.keyOf(machine)
  return new Response(withGuestBoot(html, { machine, key }), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE } })
}

/** The handler for the guest's scheme, in the guest's session (session.protocol.handle), and its cut. */
export function createMachineGuestDoor(deps: MachineGuestDeps): MachineGuestDoor {
  const open = new Set<AbortController>()
  const handle = async (request: Request): Promise<Response> => {
    const plan = planGuestRequest(request.url, request.headers)
    try {
      if (plan.kind === 'refuse') return refusal(plan.status, 'refused')
      if (plan.kind === 'relay') return await relay(deps, open, request, plan.machine, plan.route)
      const machine = guestMachineOf(request.url) ?? ''
      if (plan.kind === 'page') return await page(deps, machine)
      const found = await deps.asset(plan.pathname, plan.search)
      if (found === null) return refusal(404, 'not_found')
      return new Response(found.body, { status: 200, headers: { 'content-type': found.type } })
    } catch (error) {
      // An abort is the page letting go of a stream; anything else is said without its details.
      if ((error as { name?: string } | null)?.name === 'AbortError') return refusal(499, 'aborted')
      return refusal(502, 'failed')
    }
  }
  const cutAll = (): void => {
    for (const cut of [...open]) cut.abort()
    open.clear()
  }
  return { handle, cutAll }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

export const mimeOf = (file: string): string => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

/**
 * A file of the BUILT renderer (`out/renderer`), by its page path. Only inside
 * that folder: a path that climbs out of it, or names a hidden file, is none.
 */
export function builtAssetPath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.'))) return null
  const full = path.resolve(root, `.${decoded}`)
  const inside = path.relative(root, full)
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null
  return full
}

/** In development the page comes from electron-vite's server: its page and module graph, nothing else. */
export function devAssetAllowed(pathname: string): boolean {
  return pathname === '/' || pathname === '/index.html' || pathname.startsWith('/src/') || pathname.startsWith('/@') || pathname.startsWith('/node_modules/')
}

/** A page of the guest's own machine: the only place the guest may go once it is open. */
export const staysInGuest = (from: string, to: string): boolean => {
  const machine = guestMachineOf(from)
  return machine !== null && guestMachineOf(to) === machine
}

/** Is this webview the guest: its partition, and an address on the guest's scheme for a machine. */
export function guestAttach(partition: string | undefined, src: string | undefined): 'guest' | 'pass' | 'refuse' {
  const isGuestSrc = typeof src === 'string' && src.toLowerCase().startsWith(`${MACHINE_GUEST_SCHEME}:`)
  if (partition === MACHINE_GUEST_PARTITION) return isGuestSrc && guestMachineOf(src) !== null ? 'guest' : 'refuse'
  // The guest's scheme is served in the guest's session only; anywhere else it is nobody's.
  return isGuestSrc ? 'refuse' : 'pass'
}

/** How the guest's scheme is registered before the app is ready: a page origin of its own, with fetch and streams. */
export const MACHINE_GUEST_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true
} as const
