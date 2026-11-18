import type { BridgeDialer } from '../canvas-bridge'
import type { SealPeer, SealStreamHandler } from '../canvas-seal-terminus'
import { serveHttpStream } from '../seal2-serve-http'
import type { LiveValues } from '../../shared/launch-settings'
import { MAGPIE_KEY_PATH, MAGPIE_KEY_RETURN_PATH, type MagpieKeyAnswer } from '../../shared/remote-magpie'
import { readRequest } from '../../shared/seal2/http'
import { ABORT } from '../../shared/seal2/spec'
import type { Seal2Stream } from '../../shared/seal2/stream'
import type { KeyRow } from '../route/share-keys'
import { keyHash, type BoundKey, type BoundKeys } from './bound-keys'

/**
 * THIS COMPUTER'S MAGPIE, SERVED TO ANOTHER OF THE ACCOUNT'S COMPUTERS OVER THE SEAL.
 *
 * Kind `magpie` on the terminus (canvas-seal-terminus.ts · kinds). Each stream
 * is one HTTP exchange, and each is checked here before a byte reaches Magpie:
 *
 *   - device mode only: the other end proved it is a desktop of this account by
 *     its device key; a phone's connect-code session is refused;
 *   - both switches on HERE (Magpie, Magpie remote), read on every stream;
 *   - a key this computer gave THAT device (bound-keys.ts), still listed by
 *     Magpie under the same id and tail, so a key revoked in Magpie's own window
 *     stops at once (the list is read at most every LIST_MS);
 *   - model paths only (`/v1/…`, never Magpie's management API).
 *
 * Then the request goes to Magpie on loopback WITH that key, and Magpie holds it
 * to the key's own daily cap, concurrency and models. Without the checks above,
 * loopback would let anything in with no limit at all.
 *
 * Two control paths ride the same kind: the other desktop asks for a key of its
 * own (MAGPIE_KEY_PATH) and gives it back (MAGPIE_KEY_RETURN_PATH). Asking again
 * replaces that device's key: the old one is revoked first.
 */

/** How stale Magpie's key list may be when a stream is checked against it. */
export const LIST_MS = 5_000
/** A model request: prompts with images are large. */
export const MAGPIE_BODY_MAX = 32 * 1024 * 1024
const CONTROL_BODY_MAX = 4 * 1024

export interface MagpieServeDeps {
  /** This computer's switches, read now; null = unreadable = off. */
  switches(): LiveValues | null
  /** Magpie's gateway on loopback, or null while it is not online. */
  gatewayPort(): number | null
  readonly keys: BoundKeys
  /** Magpie's key list (`gateway-key list`), fresh. */
  listKeys(): Promise<KeyRow[]>
  /** Make a key for this device on this Magpie (share-keys.ts), with both switches asked again before it is handed over. */
  issue(device: string, permitted: () => boolean): Promise<{ ok: true; key: string; id: string } | { ok: false; why: string }>
  /** Revoke a key by Magpie's id. */
  revoke(id: string): Promise<{ ok: true } | { ok: false; why: string }>
  dial(port: number): BridgeDialer
  /** This computer's name, for the refusals the other one shows. */
  name(): string
  now?(): number
  log(line: string): void
}

const encoder = new TextEncoder()

function answerJson(stream: Seal2Stream, status: number, body: unknown): void {
  try {
    stream.respond(status, { 'content-type': 'application/json' })
  } catch {
    return
  }
  const writer = stream.writable.getWriter()
  void writer
    .write(encoder.encode(JSON.stringify(body)))
    .then(() => writer.close())
    .catch(() => undefined)
}

const refuse = (stream: Seal2Stream, status: number, message: string): void => answerJson(stream, status, { error: { type: 'cookrew_sealed', message } })

async function readSmall(stream: Seal2Stream): Promise<string | null> {
  const reader = stream.readable.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > CONTROL_BODY_MAX) return null
    parts.push(value)
  }
  const all = new Uint8Array(size)
  parts.reduce((at, part) => (all.set(part, at), at + part.length), 0)
  return new TextDecoder().decode(all)
}

/** The key the request carries: every credential header it has must say the same key. */
export function presentedKey(headers: Readonly<Record<string, string>>): string | null {
  const found: string[] = []
  const auth = headers.authorization
  if (auth !== undefined) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim())
    if (!m) return null
    found.push(m[1])
  }
  if (headers['x-api-key'] !== undefined) found.push(headers['x-api-key'].trim())
  if (found.length === 0 || found.some((k) => k !== found[0] || k === '')) return null
  return found[0]
}

/** Headers Magpie is not handed: hop-by-hop, other credentials, and anything naming a browser origin. */
const DROPPED = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'cookie', 'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'])

export function forwardedHeaders(asked: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(asked).filter(([name]) => !DROPPED.has(name) && !name.startsWith('x-cookrew-')))
}

/** A model path: anything under /v1/ except Magpie's management API. */
export function modelPath(path: string): boolean {
  const bare = path.split('?')[0]
  return bare.startsWith('/v1/') && !bare.startsWith('/v1/magpie/admin') && !bare.includes('/../') && !bare.endsWith('/..')
}

export function createMagpieServe(deps: MagpieServeDeps): SealStreamHandler {
  const now = deps.now ?? Date.now
  let cached: { at: number; rows: Promise<KeyRow[]> } | null = null
  const rows = (): Promise<KeyRow[]> => {
    if (cached === null || now() - cached.at > LIST_MS) {
      const fresh = deps.listKeys()
      cached = { at: now(), rows: fresh }
      // A failed read is not kept: the next stream asks again.
      fresh.catch(() => {
        if (cached?.rows === fresh) cached = null
      })
    }
    return cached.rows
  }
  const forgetList = (): void => {
    cached = null
  }
  const switchedOn = (): boolean => {
    try {
      const s = deps.switches()
      return s?.magpie === true && s.magpieRemote === true
    } catch {
      return false
    }
  }

  /** The bound entry for this key from this device, if Magpie still lists it as that key. */
  const stillValid = async (peer: string, key: string): Promise<BoundKey | null> => {
    let bound: BoundKey | null
    try {
      bound = deps.keys.find(peer, key)
    } catch {
      return null
    }
    if (bound === null) return null
    const listed = (await rows()).find((row) => row.id === bound?.id)
    return listed !== undefined && listed.tail !== null && key.endsWith(listed.tail) ? bound : null
  }

  const giveKey = async (stream: Seal2Stream, peer: string): Promise<void> => {
    const text = await readSmall(stream)
    let name = ''
    try {
      const body = JSON.parse(text ?? '') as { name?: unknown }
      name = typeof body?.name === 'string' ? body.name : ''
    } catch {
      name = ''
    }
    if (name.trim() === '') return answerJson(stream, 400, { ok: false, why: 'Say which computer is asking.' } satisfies MagpieKeyAnswer)
    let mine: readonly BoundKey[]
    try {
      mine = deps.keys.list().filter((k) => k.peer === peer)
    } catch {
      return answerJson(stream, 500, { ok: false, why: `${deps.name()} cannot read its list of keys given to other computers.` } satisfies MagpieKeyAnswer)
    }
    // Asking again replaces the key: the old one is revoked before a new one is made.
    for (const old of mine) {
      const gone = await deps.revoke(old.id)
      if (!gone.ok) return answerJson(stream, 409, { ok: false, why: `${deps.name()} could not revoke the key it gave this computer before: ${gone.why}` } satisfies MagpieKeyAnswer)
      deps.keys.remove(old.id)
    }
    forgetList()
    const made = await deps.issue(name, switchedOn)
    if (!made.ok) return answerJson(stream, 409, made)
    try {
      deps.keys.add({ id: made.id, tail: made.key.slice(-6), hash: keyHash(made.key), peer, device: name, at: new Date(now()).toISOString() })
    } catch {
      // Unrecorded, the key would work for nobody over the seal: take it back.
      await deps.revoke(made.id)
      return answerJson(stream, 500, { ok: false, why: `${deps.name()} could not record the key it made, so it took it back.` } satisfies MagpieKeyAnswer)
    }
    deps.log(`magpie remote: made a key for ${peer.slice(0, 8)}… (${made.id})`)
    answerJson(stream, 200, { ok: true, key: made.key, id: made.id } satisfies MagpieKeyAnswer)
  }

  const returnKey = async (stream: Seal2Stream, peer: string): Promise<void> => {
    await readSmall(stream)
    let mine: readonly BoundKey[]
    try {
      mine = deps.keys.list().filter((k) => k.peer === peer)
    } catch {
      return answerJson(stream, 500, { ok: false, why: 'The list of keys is not readable.' })
    }
    for (const old of mine) {
      const gone = await deps.revoke(old.id)
      if (gone.ok) deps.keys.remove(old.id)
    }
    forgetList()
    answerJson(stream, 200, { ok: true })
  }

  const handle = async (stream: Seal2Stream, peer: SealPeer): Promise<void> => {
    if (peer.mode !== 'device') return stream.abort(ABORT.refused, 'desktops of the account only')
    const request = readRequest(stream.fields)
    if (request === null) return stream.abort(ABORT.refused, 'bad-request')
    if (!switchedOn()) return refuse(stream, 403, `Magpie remote is switched off on ${deps.name()}.`)
    if (request.method === 'POST' && request.path === MAGPIE_KEY_PATH) return giveKey(stream, peer.deviceId)
    if (request.method === 'POST' && request.path === MAGPIE_KEY_RETURN_PATH) return returnKey(stream, peer.deviceId)
    if (!modelPath(request.path)) return refuse(stream, 404, 'Only model requests are served here.')
    const key = presentedKey(request.headers)
    if (key === null) return refuse(stream, 401, `This computer has no key for ${deps.name()}’s Magpie. Connect it again.`)
    const bound = await stillValid(peer.deviceId, key).catch(() => null)
    if (bound === null) return refuse(stream, 401, `${deps.name()} no longer accepts this computer’s key. Connect it again.`)
    const port = deps.gatewayPort()
    if (port === null) return refuse(stream, 503, `Magpie is not running on ${deps.name()}.`)
    serveHttpStream(stream, { dial: deps.dial(port), headersFor: forwardedHeaders, log: deps.log, bodyMax: MAGPIE_BODY_MAX })
  }

  return (stream, peer) => {
    void handle(stream, peer).catch(() => stream.abort(ABORT.internal, 'magpie-serve-failed'))
  }
}
