import { remoteMachineCall, type RemoteMachineAnswer } from '../../shared/remote-machine-calls'
import type { EnterResult } from './account-pair-client'
import { tokenKeyForBase } from './pairing-scope'
import { CROSS_ORIGIN_NO_COOKIE } from './data-plane'
import { RELAY_NO_LINK, RELAY_UNAUTHENTICATED } from '../../shared/machine-relay'

/**
 * EVERY MACHINE OF THE ACCOUNT, FROM THE CONSOLE, WHICHEVER ONE IS IN SCOPE
 * (owner 2026-11-10: the Devices level shows them all, live).
 *
 * The console reaches each machine at its own address on the relay, the way
 * the desktop does (main/zoom-fleet.ts · callMachine), with one difference:
 * the key. A desktop holds a machine key; a browser holds its OWN key for each
 * machine (`cr_token:<id>`), and enters a machine's door with the account's
 * twelve-hour pass when it holds none (account-pair-client.ts ·
 * enterWithGrant). One machine's token never goes to another (pairing-scope.ts).
 * These calls are keyed by the machine's id, so they do not follow the machine
 * in scope and are not let go of when it changes.
 *
 * The calls are the same allow-list the desktop relays (shared/remote-machine-calls.ts);
 * the answers come back in the same shape, so the zoom view cannot tell which
 * surface it is drawn on. Why a machine could not be read is kept, so the view
 * can say the one thing to do about it.
 */

export type MachineBlock =
  | { readonly kind: 'needs-proof' }
  | { readonly kind: 'no-device' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'offline' }

export interface RelayMachineDeps {
  /** A machine's address on the relay, or null for a page with none (machine-scope.ts · machineBaseOf). */
  readonly machineBase: (machineId: string) => string | null
  /** What the relay wants beside a machine's own token: the account session, in its own header. */
  readonly relayHeaders: () => Record<string, string>
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>
  /** Where this browser keeps its key for each machine. */
  readonly tokens: { read(key: string): string | null; write(key: string, value: string): void; drop(key: string): void }
  /** Into a machine's door with the pass held here (account-pair-client.ts · enterWithGrant at that machine's prefix). */
  readonly enter: (target: string, machineId: string) => Promise<EnterResult>
}

export interface RelayMachines {
  call(machineId: string, method: 'GET' | 'POST', route: string, body?: Record<string, unknown>): Promise<RemoteMachineAnswer>
  /** Its summary (/api/fleet), or null. */
  fleetOf(machineId: string): Promise<unknown | null>
  /** Its gauges (/api/fleet/gauges), or null. */
  gaugesOf(machineId: string): Promise<unknown | null>
  /** What stood in the way the last time it was asked; null once it answered. */
  why(machineId: string): MachineBlock | null
}

const NOTHING: RemoteMachineAnswer = { status: 0, body: null }
const MACHINE_ID = /^[0-9a-f-]{36}$/i
const BODY_MAX = 64 * 1024
const PICTURE_MAX = 4 * 1024 * 1024
const JSON_MAX = 2 * 1024 * 1024

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

const base64 = (bytes: Uint8Array): string => {
  let text = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) text += String.fromCharCode(...bytes.subarray(i, i + step))
  return btoa(text)
}

/** The answer as the zoom view takes it: JSON, or an image's bytes as base64; nothing past its size. */
async function answerOf(binary: boolean, response: Response): Promise<RemoteMachineAnswer> {
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const said = Number(response.headers.get('content-length'))
  const max = binary ? PICTURE_MAX : JSON_MAX
  if (Number.isFinite(said) && said > max) return { status: response.status, body: null }
  const bytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)))
  if (bytes.length > max) return { status: response.status, body: null }
  if (binary && response.ok) {
    return /^image\/(jpeg|png|webp)$/.test(type) ? { status: response.status, picture: { type, data: base64(bytes) } } : { status: response.status, body: null }
  }
  try {
    const text = new TextDecoder().decode(bytes)
    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) }
  } catch {
    return { status: response.status, body: null }
  }
}

/** Is this answer the relay's own, by the one word it says (shared/machine-relay.ts), and not the machine's. */
async function relaySaid(response: Response, word: string): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as { error?: unknown } | null
    return body?.error === word
  } catch {
    return false
  }
}

/** cookrew.dev's own refusal of a session that has ended, as against a machine's of its key. */
const signedOut = (response: Response): Promise<boolean> => relaySaid(response, RELAY_UNAUTHENTICATED)

const blockOf = (entered: EnterResult): MachineBlock => {
  switch (entered.kind) {
    case 'needs-proof':
      return { kind: 'needs-proof' }
    case 'no-device':
      return { kind: 'no-device' }
    case 'refused':
    case 'failed':
      return { kind: 'refused', message: entered.message }
    default:
      return { kind: 'offline' }
  }
}

/** Answers held for asking again (bytes 0.6.2): a fleet and a crew each for a handful of machines. */
const HELD_MAX = 64

export function createRelayMachines(deps: RelayMachineDeps): RelayMachines {
  const blocks = new Map<string, MachineBlock>()
  /**
   * WHAT EACH MACHINE LAST SAID, AND ITS TAG (bytes 0.6.2). A read is asked
   * again with that tag, and a machine whose answer has not changed says 304
   * instead of sending it again (http-compress.ts · validatorOf): the console
   * read every other machine's whole fleet every five seconds. The tag goes in
   * the ADDRESS: a header the page set itself would send Chrome past its
   * preflight cache on every call (measured 2026-11-11). Held under the key it
   * was read with, so nothing read under a key since dropped is handed back.
   */
  const held = new Map<string, { readonly tag: string; readonly answer: RemoteMachineAnswer }>()
  /** One entry at a time per machine: a page asking three things at once enters its door once. */
  const entering = new Map<string, Promise<string | null>>()

  const enter = (target: string, id: string): Promise<string | null> => {
    const held = entering.get(id)
    if (held) return held
    const going = (async (): Promise<string | null> => {
      try {
        const entered = await deps.enter(target, id)
        if (entered.kind === 'entered') {
          deps.tokens.write(tokenKeyForBase(target), entered.token)
          return entered.token
        }
        blocks.set(id, blockOf(entered))
        return null
      } catch {
        blocks.set(id, { kind: 'offline' })
        return null
      } finally {
        entering.delete(id)
      }
    })()
    entering.set(id, going)
    return going
  }

  const send = async (id: string, method: 'GET' | 'POST', route: string, body: string | undefined, binary: boolean): Promise<RemoteMachineAnswer> => {
    const target = MACHINE_ID.test(id) ? deps.machineBase(id.toLowerCase()) : null
    if (target === null) return NOTHING
    const key = tokenKeyForBase(target)
    let token = deps.tokens.read(key) ?? (await enter(target, id.toLowerCase()))
    if (token === null) return NOTHING
    // Only a read is asked again with its tag; a picture changes with every frame and is not held.
    const heldKey = (bearer: string): string | null => (method === 'GET' && !binary ? `${bearer}\n${id.toLowerCase()}\n${route}` : null)
    const go = (bearer: string): Promise<Response> => {
      const mine = heldKey(bearer)
      const tag = mine === null ? undefined : held.get(mine)?.tag
      const asked = tag === undefined ? route : `${route}${route.includes('?') ? '&' : '?'}etag=${encodeURIComponent(tag)}`
      return deps.fetch(`${target}/${asked}`, {
        method,
        // No `cache: 'no-store'`: it would cost a preflight on every call (data-plane.ts · CROSS_ORIGIN_NO_COOKIE).
        ...CROSS_ORIGIN_NO_COOKIE,
        headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...deps.relayHeaders() },
        ...(body !== undefined ? { body } : {})
      })
    }
    try {
      let response = await go(token)
      // The relay itself says 401 `unauthenticated` when the account session has ended: no machine forgot anything.
      if (response.status === 401 && (await signedOut(response))) return NOTHING
      if (response.status === 401) {
        // That machine no longer takes this browser's key: its door is asked again, once.
        deps.tokens.drop(key)
        token = await enter(target, id.toLowerCase())
        if (token === null) return NOTHING
        response = await go(token)
      }
      // THE RELAY SAYS THE MACHINE HOLDS NO LINE: nothing was answered by the machine, and it is
      // not said to have answered. Kept as what stood in the way, so the view says so at once
      // (a tile left "reading" until the account's list was next asked for said nothing for a minute).
      if (response.status === 503 && (await relaySaid(response, RELAY_NO_LINK))) {
        blocks.set(id.toLowerCase(), { kind: 'offline' })
        return NOTHING
      }
      blocks.delete(id.toLowerCase())
      const mine = heldKey(token)
      const kept = mine === null ? undefined : held.get(mine)
      if (response.status === 304) {
        await response.body?.cancel().catch(() => undefined)
        if (mine === null || kept === undefined) return NOTHING
        held.delete(mine)
        held.set(mine, kept)
        return kept.answer
      }
      const answer = await answerOf(binary, response)
      const tag = response.headers.get('etag')
      if (mine !== null) {
        held.delete(mine)
        if (response.status === 200 && tag) {
          held.set(mine, { tag, answer })
          while (held.size > HELD_MAX) {
            const oldest = held.keys().next().value
            if (oldest === undefined) break
            held.delete(oldest)
          }
        }
      }
      return answer
    } catch {
      blocks.set(id.toLowerCase(), { kind: 'offline' })
      return NOTHING
    }
  }

  const read = async (id: string, route: string): Promise<unknown | null> => {
    const answer = await send(id, 'GET', route, undefined, false)
    return answer.status === 200 && 'body' in answer ? answer.body : null
  }

  return {
    call(machineId, method, route, body) {
      const call = remoteMachineCall(method, route)
      if (call === null) return Promise.resolve(NOTHING)
      let sent: string | undefined
      if (call.method === 'POST' && body !== undefined) {
        if (!plainObject(body)) return Promise.resolve(NOTHING)
        sent = JSON.stringify(body)
        if (sent.length > BODY_MAX) return Promise.resolve(NOTHING)
      }
      return send(machineId, call.method, call.route, sent, call.binary)
    },
    fleetOf: (machineId) => read(machineId, 'api/fleet'),
    gaugesOf: (machineId) => read(machineId, 'api/fleet/gauges'),
    why: (machineId) => blocks.get(machineId.toLowerCase()) ?? null
  }
}

let browserMachines: RelayMachines | null = null

/** The page's own wiring, made on first use: this origin's storage, its fetch, its account key at each door. */
export async function relayMachines(): Promise<RelayMachines> {
  if (browserMachines) return browserMachines
  const [{ machineBaseOf, relayFetch, relayHeadersFor, scopeNeedsMachine }, { browserPairDeps, enterWithGrant }, { accountDevice }] = await Promise.all([
    import('./machine-scope'),
    import('./account-pair-client'),
    import('./account-device')
  ])
  const storage = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null
    } catch {
      return null
    }
  }
  browserMachines ??= createRelayMachines({
    machineBase: (machineId) => machineBaseOf(machineId),
    relayHeaders: () => relayHeadersFor(),
    // Every call at the relay's one address, so the browser asks its preflight once (machine-scope.ts · relayRequestFor).
    fetch: relayFetch(),
    tokens: {
      read: (key) => {
        try {
          return storage()?.getItem(key) ?? null
        } catch {
          return null
        }
      },
      write: (key, value) => {
        // Through the relay a key is kept only while somebody is signed in: an answer that
        // lands after a sign-out is kept for nobody (the relay's header is the session).
        if (scopeNeedsMachine() && Object.keys(relayHeadersFor()).length === 0) return
        try {
          storage()?.setItem(key, value)
        } catch {
          // A browser that keeps nothing enters the door again next time.
        }
      },
      drop: (key) => {
        try {
          storage()?.removeItem(key)
        } catch {
          // Nothing held.
        }
      }
    },
    // One machine turning the pass away must not sign this browser out of all of them (security review L1):
    // the pass is cleared only by this page's own door (ReauthAccountEntry.tsx), or when it expires.
    enter: (target, machineId) => {
      const pair = browserPairDeps(target, accountDevice)
      return enterWithGrant({ ...pair, grants: { ...pair.grants, clear: () => undefined } }, machineId)
    }
  })
  return browserMachines
}

/** What stood in the way of a machine, once the page has asked it; null before, or once it answered. */
export const relayMachineWhy = (machineId: string): MachineBlock | null => browserMachines?.why(machineId) ?? null
