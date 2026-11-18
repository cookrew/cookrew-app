import { MACHINE_RELAY_PREFIX } from '../../../shared/machine-relay'
import { startCodeHandshake } from '../../../shared/seal2/handshake'
import { sealedFetch } from '../../../shared/seal2/http'
import { runSeal2Link, shakeHandsOverHttp, type Seal2Link } from '../../../shared/seal2/http-link'
import type { Seal2Session } from '../../../shared/seal2/records'
import { machineBaseOf, machineScope, registerScopeState, setSealedRoute } from '../machine-scope'
import { codeKeyForBase } from '../pairing-scope'
import { sealFetchFor } from '../use/seal-fetch'
import { SealRefusedError } from './seal-client'
import { sealPinFor } from './seal-pin'

/**
 * EVERYTHING THIS PAGE ASKS A MACHINE OVER THE RELAY, SEALED, once that machine
 * has spoken cookrew-seal/2 on the connect code this page holds for it.
 *
 *   no code for the machine     the relay as before: in the clear (the old way, kept)
 *   a code, machine not on v2   the relay as before, and one quiet try at v2 per code
 *   a code, machine on v2       every request and every event stream through one
 *                               sealed session; if the session cannot open, the
 *                               request FAILS. It never goes in the clear again.
 *
 * The Mac marks a device that opened a v2 session and refuses it in the clear
 * (main/seal-marks.ts), so a plain request caught in flight at that moment is
 * answered 403 `sealed-only`, and plane-fetch.ts sends it again sealed: a refused
 * request was never carried out.
 */

const SEALED_ONLY = 'sealed-only'
/** HTTP statuses a Response may not carry a body with. */
const NO_BODY = new Set([101, 103, 204, 205, 304])

export interface SealedCall {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: Uint8Array | null
  readonly signal?: AbortSignal
}

export interface SealRoute {
  /** The machine's own path. */
  readonly path: string
  request(call: SealedCall): Promise<Response>
}

interface Held {
  readonly code: string
  readonly link: Promise<Seal2Link>
}

const links = new Map<string, Held>()
const probed = new Set<string>()

const storage = (): Storage | null => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** The machine's relay address a URL is under, or null for any URL that is not a relayed call. */
export function machineBaseFor(url: string): string | null {
  const relay = machineScope().relay
  if (relay === null) return null
  const prefix = `${relay.origin.replace(/\/+$/, '')}${MACHINE_RELAY_PREFIX}/`
  if (!url.startsWith(prefix)) return null
  const id = url.slice(prefix.length).split(/[/?#]/)[0]
  const base = machineBaseOf(id)
  return base !== null && url.startsWith(`${base}/`) ? base : null
}

const open = async (base: string, code: string, allowV1: boolean): Promise<Seal2Link | null> => {
  const http = { url: (path: string) => `${base}${path}`, fetchFn: sealFetchFor(base) }
  const started = await startCodeHandshake(Uint8Array.from(atob(code.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)), { allowV1 })
  const done = await shakeHandsOverHttp(http, started, async () => new SealRefusedError('code'))
  if (done.version !== 2) return null
  sealPinFor(codeKeyForBase(base), code).sawV2()
  return runSeal2Link(http, done.session as Seal2Session, {})
}

/** The machine's session, opened once and again after it ends. Never in the clear: a failure is the caller's error. */
const linkFor = (base: string, code: string): Promise<Seal2Link> => {
  const held = links.get(base)
  if (held !== undefined && held.code === code) {
    return held.link.then((link) => {
      if (!link.connection.closed) return link
      if (links.get(base) === held) links.delete(base)
      return linkFor(base, code)
    })
  }
  const link = open(base, code, false).then((opened) => {
    if (opened === null) throw new Error('This machine did not answer on the sealed session.')
    return opened
  })
  const entry = { code, link }
  links.set(base, entry)
  link.catch(() => {
    if (links.get(base) === entry) links.delete(base)
  })
  return link
}

/** One try at v2 for a code not yet known to reach a v2 Mac: if it does, the pin is set and the session kept. */
const probe = (base: string, code: string): void => {
  const key = `${base}\n${code}`
  if (probed.has(key)) return
  probed.add(key)
  void open(base, code, true)
    .then((opened) => {
      if (opened !== null) links.set(base, { code, link: Promise.resolve(opened) })
    })
    .catch(() => undefined)
}

const toResponse = (status: number, headers: Readonly<Record<string, string>>, body: ReadableStream<Uint8Array>): Response => {
  if (NO_BODY.has(status)) {
    void body.cancel().catch(() => undefined)
    return new Response(null, { status, headers })
  }
  return new Response(body, { status, headers })
}

/** The sealed way for this URL, or null for the ordinary way. */
export function viaSeal(url: string): SealRoute | null {
  const base = machineBaseFor(url)
  const store = storage()
  if (base === null || store === null) return null
  const codeKey = codeKeyForBase(base)
  const code = store.getItem(codeKey)
  if (code === null || !/^[A-Za-z0-9_-]{43}$/.test(code)) return null
  if (!sealPinFor(codeKey, code, store).v2()) {
    probe(base, code)
    return null
  }
  return {
    path: url.slice(base.length),
    async request(call) {
      const link = await linkFor(base, code)
      const answer = await sealedFetch(link.connection, call)
      return toResponse(answer.status, answer.headers, answer.body)
    }
  }
}

/** Did the machine refuse this plain request because this device is to speak sealed? */
export async function refusedInTheClear(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  const said = (await response.clone().json().catch(() => null)) as { error?: unknown } | null
  return said?.error === SEALED_ONLY
}

/** What only a real fetch could send (a form, a blob) as bytes and the type it would have had. */
export async function sealableBody(method: string, init: RequestInit): Promise<{ body: Uint8Array | null; headers: Record<string, string> }> {
  const asked = new Request('https://sealed.invalid/', { method, headers: init.headers, ...(init.body !== undefined && init.body !== null && method !== 'GET' && method !== 'HEAD' ? { body: init.body, duplex: 'half' } : {}) } as RequestInit)
  const headers: Record<string, string> = {}
  asked.headers.forEach((value, name) => void (headers[name.toLowerCase()] = value))
  const bytes = asked.body === null ? null : new Uint8Array(await asked.arrayBuffer())
  return { body: bytes, headers }
}

/**
 * `fetch(url, init)` on the sealed session when this URL's machine is on v2 here,
 * or null for the ordinary way. A machine on v2 that cannot be reached sealed is
 * a failed request, never a plain one.
 */
export function sealedFetchFor(url: string, init: RequestInit = {}): Promise<Response> | null {
  const route = viaSeal(url)
  if (route === null) return null
  const method = (init.method ?? 'GET').toUpperCase()
  return sealableBody(method, init).then(({ body, headers }) =>
    route.request({ method, path: route.path, headers, body, ...(init.signal ? { signal: init.signal } : {}) })
  )
}

setSealedRoute(sealedFetchFor)

registerScopeState(
  'sealed sessions',
  () => {
    for (const [base, held] of links) {
      links.delete(base)
      void held.link.then((link) => link.close()).catch(() => undefined)
    }
    probed.clear()
  },
  'clear'
)
