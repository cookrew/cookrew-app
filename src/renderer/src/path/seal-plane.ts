import { MACHINE_RELAY_PREFIX, RELAY_SESSION_HEADER } from '../../../shared/machine-relay'
import { sealedFetch } from '../../../shared/seal2/http'
import type { Seal2Link } from '../../../shared/seal2/http-link'
import { machineBaseOf, machineScope, registerScopeState, scopeBase, setSealedRoute } from '../machine-scope'
import { codeKeyForBase } from '../pairing-scope'
import { sealFetchFor } from '../use/seal-fetch'
import { authStore } from '../auth-gate'
import { openSealSession, SealDowngradedError, SealRefusedError, type OpenedSeal } from './seal-client'
import { vouchedNextCode } from './seal-next-code'
import { sealPinFor } from './seal-pin'

/**
 * EVERYTHING THIS PAGE ASKS A MACHINE OVER THE RELAY, SEALED, once that machine
 * is known to speak cookrew-seal/2 on the connect code this page holds for it.
 *
 *   no code for the machine     the relay as before: in the clear (the old way, kept)
 *   a code, not known yet       the relay as before, and a try at the session, again
 *                               with backoff until the Mac itself has answered
 *   a code, Mac on v2 (pinned)  every request and every event stream through one
 *                               sealed session; if it cannot open, the request
 *                               FAILS. It never goes in the clear again.
 *
 * WHAT A CARRIER CANNOT DO. Take v2's offer off the hello: the Mac answers v1,
 * and asked inside that sealed v1 session it says it speaks v2, so the page pins
 * it (seal-client.ts · openSealSession). The pin is per machine, and nothing here
 * lets go of it. Say "no such code": that is not the Mac's proof, so the page shows
 * re-pair and takes no other code; only a code the Mac named as the successor of
 * the one held is taken (seal-next-code.ts). What a carrier can still do is refuse
 * every handshake of a page that was never pinned: that page then keeps the old
 * plain way, as every page did before v2, until a try gets through.
 *
 * The Mac refuses a v2 device's plain requests (main/seal-marks.ts): one caught
 * in flight just as the pin is learned is answered 403 `sealed-only` and sent
 * again sealed by plane-fetch.ts. A refused request was never carried out.
 */

const SEALED_ONLY = 'sealed-only'
/** HTTP statuses a Response may not carry a body with. */
const NO_BODY = new Set([204, 205, 304])
const CODE_SHAPE = /^[A-Za-z0-9_-]{43}$/

export interface SealPlaneTiming {
  now(): number
  /** First wait after a try that failed; doubles to `maxRetryMs`. */
  readonly retryMs: number
  readonly maxRetryMs: number
  /** How long a Mac that said, sealed, that it has no v2 is not asked again. */
  readonly oldMacMs: number
  /** How long a refused code is answered from memory, so a page does not shake hands per request. */
  readonly refusedMs: number
}

const DEFAULT_TIMING: SealPlaneTiming = { now: () => Date.now(), retryMs: 5_000, maxRetryMs: 300_000, oldMacMs: 600_000, refusedMs: 10_000 }
let timing: SealPlaneTiming = DEFAULT_TIMING

/** Tests set the clock and the waits. */
export const configureSealPlane = (next: Partial<SealPlaneTiming>): void => {
  timing = { ...DEFAULT_TIMING, ...next }
}

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

interface Probe {
  readonly at: number
  readonly delay: number
  readonly running: Promise<void> | null
}

const links = new Map<string, Held>()
const probes = new Map<string, Probe>()
/** A refused or unreachable machine, answered from memory until `until`. */
const failures = new Map<string, { readonly until: number; readonly answer: () => Response | Error }>()
const pinnedListeners = new Set<(base: string) => void>()
/** Bumped when the scope is cleared: work begun before must not write into after. */
let generation = 0

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

/** Something that must not ride on a machine's old direct link once its session is sealed (rtc-plane.ts). */
export function onSealPinned(listener: (base: string) => void): () => void {
  pinnedListeners.add(listener)
  return () => void pinnedListeners.delete(listener)
}

const pinned = (base: string): void => {
  for (const listener of pinnedListeners) {
    try {
      listener(base)
    } catch {
      // One listener's fault is its own.
    }
  }
}

const sessionFor = (base: string, code: string): Promise<OpenedSeal> =>
  openSealSession({ url: (path) => `${base}${path}`, code, fetchFn: sealFetchFor(base), pin: sealPinFor(codeKeyForBase(base)) })

/** Keeps a link for a machine; the one it replaces is let go, never left polling. */
const keep = (base: string, entry: Held): void => {
  const before = links.get(base)
  links.set(base, entry)
  if (before !== undefined && before !== entry) void before.link.then((link) => link.close()).catch(() => undefined)
}

/** What the page's own code reads as "this machine refused its credentials": the re-pair screen. */
const refusedAnswer = (): Response =>
  new Response(JSON.stringify({ error: 'This machine no longer knows the connect code held here. Scan its code again.' }), {
    status: 401,
    headers: { 'content-type': 'application/json' }
  })

/** Per machine and code: a code scanned a moment later is not answered with the last one's failure. */
const failureKey = (base: string, code: string): string => `${base}\n${code}`
const remember = (base: string, code: string, answer: () => Response | Error, ms: number): void => {
  failures.set(failureKey(base, code), { until: timing.now() + ms, answer })
}

/**
 * The machine's session on a pinned machine. A code the Mac proved replaced is
 * followed only to the code it vouched for (seal-next-code.ts); any other refusal
 * is the re-pair screen. Nothing is ever sent in the clear for either.
 */
async function openPinned(base: string, code: string): Promise<Seal2Link> {
  const gen = generation
  try {
    const opened = await sessionFor(base, code)
    if (opened.version !== 2) {
      // Pinned means v1 is refused before this point: a v1 session here is a bug, and is not used.
      if (opened.version === 1) opened.client.close()
      throw new Error('This machine did not answer on the sealed session.')
    }
    if (gen !== generation) {
      opened.link.close()
      throw new Error('the machine was left')
    }
    return opened.link
  } catch (error) {
    if (!(error instanceof SealRefusedError) || (error.why !== 'code' && error.why !== 'replaced')) throw error
    const store = storage()
    const codeKey = codeKeyForBase(base)
    const vouched = store === null ? null : await vouchedNextCode(store, codeKey, code, error)
    if (vouched === null || gen !== generation) throw new CodeRefused()
    // The machine in view keeps its code in the gate's memory as well: both learn it.
    if (base === scopeBase()) authStore().saveConnectCode(vouched)
    else store?.setItem(codeKey, vouched)
    throw new RetryWithCode(vouched)
  }
}

class CodeRefused extends Error {}
class RetryWithCode extends Error {
  constructor(readonly code: string) {
    super('a vouched code is tried')
  }
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
  const link = openPinned(base, code)
  const entry = { code, link }
  keep(base, entry)
  link.catch(() => {
    if (links.get(base) === entry) links.delete(base)
  })
  return link
}

/** A try at the session for a code not yet known to reach a v2 Mac, with backoff. */
function probe(base: string, code: string): void {
  const key = `${base}\n${code}`
  const held = probes.get(key)
  if (held?.running || (held !== undefined && timing.now() < held.at)) return
  const gen = generation
  const after = (delay: number, wait: number): void => {
    if (gen === generation) probes.set(key, { at: timing.now() + wait, delay, running: null })
  }
  const running = sessionFor(base, code)
    .then((opened) => {
      if (opened.version === 1) {
        opened.client.close()
        // The Mac said, sealed, that it has no v2: an old Mac. Asked again later, it may have been updated.
        return opened.mac === 'no-v2' ? after(0, timing.oldMacMs) : after(nextDelay(held), nextDelay(held))
      }
      if (gen !== generation) return opened.link.close()
      keep(base, { code, link: Promise.resolve(opened.link) })
      probes.delete(key)
      pinned(base)
    })
    .catch((error: unknown) => {
      if (error instanceof SealDowngradedError) {
        probes.delete(key)
        if (gen === generation) pinned(base)
        return
      }
      after(nextDelay(held), nextDelay(held))
    })
  probes.set(key, { at: 0, delay: held?.delay ?? 0, running })
}

const nextDelay = (held: Probe | undefined): number => Math.min(Math.max((held?.delay ?? 0) * 2, timing.retryMs), timing.maxRetryMs)

/** The try under way for this URL's machine, if any: a request refused in the clear waits for it once. */
export function probeSettled(url: string): Promise<void> {
  const base = machineBaseFor(url)
  const code = base === null ? null : storage()?.getItem(codeKeyForBase(base))
  const running = base === null || code == null ? null : (probes.get(`${base}\n${code}`)?.running ?? null)
  return running ?? Promise.resolve()
}

const decoded = (headers: Headers, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  if (headers.get('content-encoding') !== 'gzip' || typeof DecompressionStream === 'undefined') return body
  headers.delete('content-encoding')
  headers.delete('content-length')
  return body.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>)
}

const toResponse = (status: number, fields: Readonly<Record<string, string>>, body: ReadableStream<Uint8Array>): Response => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(fields)) {
    // Several Set-Cookie come joined by a newline (canvas-bridge.ts · flattenHeaders).
    for (const one of name === 'set-cookie' ? value.split('\n') : [value]) headers.append(name, one)
  }
  if (status < 200 || status > 599) {
    void body.cancel().catch(() => undefined)
    return new Response(null, { status: 502, headers })
  }
  if (NO_BODY.has(status)) {
    void body.cancel().catch(() => undefined)
    return new Response(null, { status, headers })
  }
  return new Response(decoded(headers, body), { status, headers })
}

/** A code the page holds, or the re-pair answer; a session that cannot open is the caller's error, never a plain request. */
async function linkOrAnswer(base: string, code: string, call: SealedCall): Promise<Seal2Link | Response> {
  try {
    return await linkFor(base, code)
  } catch (error) {
    // The machine stays pinned: the vouched code is asked on v2 like the last.
    if (error instanceof RetryWithCode) return sendSealed(base, error.code, call, false)
    if (error instanceof CodeRefused) {
      remember(base, code, refusedAnswer, timing.refusedMs)
      return refusedAnswer()
    }
    const failed = error instanceof Error ? error : new Error(String(error))
    remember(base, code, () => failed, timing.retryMs)
    throw failed
  }
}

/** On a session that ended under it, a READ is asked once more on a fresh one; a write may have been carried out, so it is not. */
async function sendSealed(base: string, code: string, call: SealedCall, again: boolean): Promise<Response> {
  const known = failures.get(failureKey(base, code))
  if (known !== undefined && timing.now() < known.until) {
    const answer = known.answer()
    if (answer instanceof Error) throw answer
    return answer
  }
  const link = await linkOrAnswer(base, code, call)
  if (link instanceof Response) return link
  failures.delete(failureKey(base, code))
  try {
    const answer = await sealedFetch(link.connection, call)
    return toResponse(answer.status, answer.headers, answer.body)
  } catch (error) {
    const read = call.method === 'GET' || call.method === 'HEAD'
    if (!again || !read || !link.connection.closed || call.signal?.aborted) throw error
    return sendSealed(base, code, call, false)
  }
}

/** The sealed way for this URL, or null for the ordinary way. */
export function viaSeal(url: string): SealRoute | null {
  const base = machineBaseFor(url)
  const store = storage()
  if (base === null || store === null) return null
  const codeKey = codeKeyForBase(base)
  const code = store.getItem(codeKey)
  if (code === null || !CODE_SHAPE.test(code)) return null
  if (!sealPinFor(codeKey, store).v2()) {
    probe(base, code)
    return null
  }
  // What fetch would send: never the fragment (seal2/http.ts · isLocalPath refuses one).
  return { path: url.slice(base.length).split('#')[0], request: (call) => sendSealed(base, code, call, true) }
}

/** Did the machine refuse this plain request because this device is to speak sealed? */
export async function refusedInTheClear(response: Response): Promise<boolean> {
  // Read from a copy, so the caller still has the whole answer; anything that cannot be copied is no such refusal.
  if (response.status !== 403 || typeof response.clone !== 'function') return false
  const said = (await response.clone().json().catch(() => null)) as { error?: unknown } | null
  return said?.error === SEALED_ONLY
}

/** What only a real fetch could send (a form, a blob) as bytes, and the type it would have had. */
export async function sealableBody(method: string, init: RequestInit): Promise<{ body: Uint8Array | null; headers: Record<string, string> }> {
  const hasBody = init.body !== undefined && init.body !== null && method !== 'GET' && method !== 'HEAD'
  const asked = new Request('https://sealed.invalid/', { method, headers: init.headers, ...(hasBody ? { body: init.body, duplex: 'half' } : {}) } as RequestInit)
  const headers: Record<string, string> = {}
  asked.headers.forEach((value, name) => void (headers[name.toLowerCase()] = value))
  // The relay's session is the relay's: the machine never gets it, sealed or not.
  delete headers[RELAY_SESSION_HEADER]
  // A Request drops this header; the machine compresses when asked, and decoded() undoes it. Not for
  // HEAD: no body comes, and a gzip decoder fails on none.
  if (typeof DecompressionStream !== 'undefined' && method !== 'HEAD') headers['accept-encoding'] = 'gzip'
  const bytes = asked.body === null ? null : new Uint8Array(await asked.arrayBuffer())
  return { body: bytes, headers }
}

/**
 * `fetch(url, init)` on the sealed session when this URL's machine is on v2 here,
 * or null for the ordinary way. A machine on v2 that cannot be reached sealed is
 * a failed request (or the re-pair answer), never a plain one.
 */
export function sealedFetchFor(url: string, init: RequestInit = {}): Promise<Response> | null {
  const route = viaSeal(url)
  if (route === null) return null
  const method = (init.method ?? 'GET').toUpperCase()
  return sealableBody(method, init).then(({ body, headers }) => route.request({ method, path: route.path, headers, body, ...(init.signal ? { signal: init.signal } : {}) }))
}

setSealedRoute(sealedFetchFor)

registerScopeState(
  'sealed sessions',
  () => {
    generation += 1
    for (const [base, held] of links) {
      links.delete(base)
      void held.link.then((link) => link.close()).catch(() => undefined)
    }
    probes.clear()
    failures.clear()
  },
  'clear'
)
