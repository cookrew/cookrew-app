import type { BridgeDialer } from '../canvas-bridge'
import type { SealPeer, SealStreamHandler } from '../canvas-seal-terminus'
import type { LiveValues } from '../../shared/launch-settings'
import { MAGPIE_KEY_ACK_PATH, MAGPIE_KEY_PATH, MAGPIE_KEY_RETURN_PATH, magpieHeaders, modelRoute, type MagpieKeyAnswer } from '../../shared/remote-magpie'
import { readRequest } from '../../shared/seal2/http'
import { ABORT } from '../../shared/seal2/spec'
import type { Seal2Stream } from '../../shared/seal2/stream'
import { DEVICE_CONCURRENCY, type KeyRow } from '../route/share-keys'
import { ISSUE_WINDOW_MS, keyHash, type BoundKey, type BoundKeys } from './bound-keys'
import { bodyBudget, readWholeBody, sendToMagpie } from './proxy'
import { remoteSwitchedOn } from './switches'

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
 *     Magpie as enabled under the same id and tail, read by a list that began
 *     after the request's whole body arrived (proxy.ts: Magpie reads the body
 *     before it looks at the key, so a held body must not outlive the check);
 *   - the model endpoints only, by exact path and method (remote-magpie.ts · modelRoute).
 *
 * Then the request goes to Magpie on loopback WITH that key in both credential
 * headers and nothing else that could pass for one (remote-magpie.ts ·
 * magpieHeaders), and Magpie holds it to the key's own daily cap, concurrency and
 * models. A key Cookrew revokes is unbound first and its streams are cut. Without the checks above,
 * loopback would let anything in with no limit at all.
 *
 * Three control paths ride the same kind: the other desktop asks for a key of its
 * own (MAGPIE_KEY_PATH), says it has stored it (MAGPIE_KEY_ACK_PATH) and gives it
 * back (MAGPIE_KEY_RETURN_PATH). Asking again replaces that device's key: the old
 * one is revoked first.
 *
 * KEY ACKNOWLEDGEMENT (agreed with Relay). A key given is bound `pending` and
 * serves no model request until its computer acknowledges it over its own device
 * session, presenting the key itself (so possession, device and id are all
 * checked) once it has stored it durably. The binding goes live first, then
 * share-keys.ts settles the intent that has warned since before the key was
 * made; if that cannot be written the answer is a failure and the asker gives
 * the key back. A repeated acknowledgement answers the same. An asker from
 * before this path never acknowledges, so its key works nowhere: fail closed.
 */

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
  /**
   * The key's computer acknowledged it: settle the intent that warned while it was out (share-keys.ts ·
   * acknowledge). Idempotent. Absent: no acknowledgement can be recorded, so none is accepted.
   */
  acknowledge?(id: string): Promise<{ ok: true } | { ok: false; why: string }>
  dial(port: number): BridgeDialer
  /** This computer's name, for the refusals the other one shows. */
  name(): string
  now?(): number
  log(line: string): void
  /** Tests shorten it; defaults to SWITCH_POLL_MS. */
  readonly switchPollMs?: number
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

/**
 * The name a sealed key goes by on this Magpie: the asking computer's name and the start of its
 * device id, so two computers called "MacBook Pro" (or a hand-made "laptop" key) never collide.
 */
export function sealedDeviceName(name: string, peer: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 25)
    .replace(/-+$/, '')
  return `${slug === '' ? 'computer' : slug}-${peer.slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, '0')}`
}


/** At most this many keys for one computer in ISSUE_WINDOW_MS: asking again must not reset its daily cap without end. */
export const KEYS_PER_DAY = 3
/** How long a sealed model request's body may take to arrive. */
export const MAGPIE_BODY_MS = 120_000
/** Model requests one computer may have in flight here, as many as its key may run at once in Magpie. */
export const PER_COMPUTER_REQUESTS = DEVICE_CONCURRENCY
/** Bytes of request bodies held in main at once, for every computer together. */
export const BODY_BUDGET_BYTES = 128 * 1024 * 1024
/** How long a key request's tiny body may take: the per-computer lane must not wait on it. */
const CONTROL_BODY_MS = 10_000

export type MagpieServe = SealStreamHandler & {
  /**
   * Stop honouring a key here BEFORE it is revoked in Magpie: its binding goes and every
   * stream carrying it is cut, so no request with it can reach Magpie after Magpie forgets it
   * (an unknown key on loopback has no limit).
   */
  unbind(id: string): void
  /**
   * The switches may have changed: read them now, and when either is off (or unreadable) cut every
   * answer still streaming, as unbind does for one key. Also run on its own every switchPollMs while
   * any answer streams, so a change made anywhere is caught.
   */
  switchesChanged(): void
}

/** How often the switches are read again while answers stream (the panel also calls switchesChanged). */
export const SWITCH_POLL_MS = 1_000

export function createMagpieServe(deps: MagpieServeDeps): MagpieServe {
  const now = deps.now ?? Date.now
  /**
   * Magpie's key list, read for a request only by a read that STARTS after the request asks
   * (its body in hand). One read runs at a time; whoever asks while it runs shares ONE read
   * that starts when it ends. Ordered by when reads start, never by the clock.
   */
  let running: Promise<KeyRow[]> | null = null
  let next: Promise<KeyRow[]> | null = null
  const begin = (): Promise<KeyRow[]> => {
    const read = Promise.resolve().then(() => deps.listKeys())
    running = read
    const done = (): void => {
      if (running === read) running = null
    }
    read.then(done, done)
    return read
  }
  const rowsAfterNow = (): Promise<KeyRow[]> => {
    if (running === null) return begin()
    if (next !== null) return next
    const after = running.then(
      () => undefined,
      () => undefined
    )
    const follow = after.then(() => {
      next = null
      return begin()
    })
    next = follow
    return follow
  }
  /** Requests in flight per computer, counted before a body is read. */
  const perComputer = new Map<string, number>()
  const budget = bodyBudget(BODY_BUDGET_BYTES)
  const switchedOn = (): boolean => remoteSwitchedOn(() => deps.switches())

  /** The streams in flight by the bound key id they were let in with. */
  const inFlight = new Map<string, Set<Seal2Stream>>()
  const track = (id: string, stream: Seal2Stream): void => {
    const set = inFlight.get(id) ?? new Set<Seal2Stream>()
    set.add(stream)
    inFlight.set(id, set)
    const drop = (): void => {
      set.delete(stream)
      if (set.size === 0 && inFlight.get(id) === set) inFlight.delete(id)
    }
    void stream.closed.then(drop, drop)
    watchSwitches()
  }
  /** Cut every answer in flight when a switch is off: nothing streams on after Magpie remote is turned off. */
  const switchesChanged = (): void => {
    if (switchedOn()) return
    for (const set of inFlight.values()) {
      for (const stream of set) {
        try {
          stream.abort(ABORT.refused, 'Magpie remote switched off')
        } catch {
          // Already gone: nothing streams on it. The others are still cut (and other listeners still run).
        }
      }
    }
    inFlight.clear()
  }
  let poll: ReturnType<typeof setInterval> | null = null
  const watchSwitches = (): void => {
    if (poll !== null) return
    poll = setInterval(() => {
      switchesChanged()
      if (inFlight.size === 0 && poll !== null) {
        clearInterval(poll)
        poll = null
      }
    }, deps.switchPollMs ?? SWITCH_POLL_MS)
    poll.unref?.()
  }
  /**
   * Ids unbound since start, honoured for nothing whatever the file says: a write that fails leaves the
   * binding readable (review M1). Magpie never gives an id twice, so none comes back to life.
   */
  const unbound = new Set<string>()
  const unbind = (id: string): void => {
    unbound.add(id)
    try {
      deps.keys.remove(id)
    } catch {
      // Unwritten: the set above refuses it anyway; an unreadable list honours no key at all (find fails closed).
    }
    for (const stream of inFlight.get(id) ?? []) stream.abort(ABORT.refused, 'key revoked')
    inFlight.delete(id)
  }

  /** This device's binding for this key, pending or live; null for none or an unreadable list. */
  const bindingOf = (peer: string, key: string): BoundKey | null => {
    try {
      const found = deps.keys.find(peer, key)
      return found === null || unbound.has(found.id) ? null : found
    } catch {
      return null
    }
  }
  /** Only a key its computer acknowledged may carry a model request. */
  const liveBindingOf = (peer: string, key: string): BoundKey | null => {
    const bound = bindingOf(peer, key)
    return bound === null || bound.pending === true ? null : bound
  }

  /** Magpie lists this id enabled with this key's tail. */
  const listedEnabled = (rows: readonly KeyRow[], id: string, key: string): boolean => {
    const listed = rows.find((row) => row.id === id)
    // Only a key Magpie holds as enabled: anything else could be met at loopback as no key at all.
    return listed !== undefined && listed.state === 'enabled' && listed.tail !== null && key.endsWith(listed.tail)
  }

  /** Bound live to this device, still bound after the read, and Magpie lists it enabled with its tail, by a read begun after this call. */
  const validNow = async (peer: string, key: string): Promise<BoundKey | null> => {
    const bound = liveBindingOf(peer, key)
    if (bound === null) return null
    const rows = await rowsAfterNow()
    if (liveBindingOf(peer, key)?.id !== bound.id) return null
    // A model request needs the key turned on in Magpie (access full): a key not yet confirmed is read-only there.
    return listedEnabled(rows, bound.id, key) && rows.find((row) => row.id === bound.id)?.access === 'full' ? bound : null
  }

  const giveKey = async (stream: Seal2Stream, peer: string, text: string): Promise<void> => {
    let name = ''
    try {
      const body = JSON.parse(text ?? '') as { name?: unknown }
      name = typeof body?.name === 'string' ? body.name : ''
    } catch {
      name = ''
    }
    if (name.trim() === '') return answerJson(stream, 400, { ok: false, why: 'Say which computer is asking.' } satisfies MagpieKeyAnswer)
    let mine: readonly BoundKey[]
    let recent: number
    try {
      mine = deps.keys.list().filter((k) => k.peer === peer)
      recent = deps.keys.issuedSince(peer, now() - ISSUE_WINDOW_MS)
    } catch {
      return answerJson(stream, 500, { ok: false, why: `${deps.name()} cannot read its list of keys given to other computers.` } satisfies MagpieKeyAnswer)
    }
    if (recent >= KEYS_PER_DAY) return answerJson(stream, 429, { ok: false, why: `${deps.name()} has given this computer ${KEYS_PER_DAY} keys in the last day. Try again tomorrow.` } satisfies MagpieKeyAnswer)
    let listed: readonly KeyRow[]
    try {
      listed = await rowsAfterNow()
    } catch {
      return answerJson(stream, 503, { ok: false, why: `${deps.name()} could not read its Magpie's keys.` } satisfies MagpieKeyAnswer)
    }
    // Asking again replaces the key: the old one stops being honoured, then is revoked. One Magpie no
    // longer lists (revoked in Magpie's own window) is already gone: only its binding is left to drop.
    for (const old of mine) {
      unbind(old.id)
      if (!listed.some((row) => row.id === old.id)) continue
      const gone = await deps.revoke(old.id)
      if (!gone.ok) return answerJson(stream, 409, { ok: false, why: `${deps.name()} could not revoke the key it gave this computer before: ${gone.why}` } satisfies MagpieKeyAnswer)
    }
    const made = await deps.issue(sealedDeviceName(name, peer), switchedOn)
    if (!made.ok) return answerJson(stream, 409, made)
    try {
      deps.keys.noteIssued(peer, now())
      // Pending until that computer says it has stored the key (ackKey): until then it serves nothing.
      deps.keys.add({ id: made.id, tail: made.key.slice(-6), hash: keyHash(made.key), peer, device: name, at: new Date(now()).toISOString(), pending: true })
    } catch {
      // Unrecorded, the key would work for nobody over the seal: take it back.
      await deps.revoke(made.id)
      return answerJson(stream, 500, { ok: false, why: `${deps.name()} could not record the key it made, so it took it back.` } satisfies MagpieKeyAnswer)
    }
    deps.log(`magpie remote: made a key for ${peer.slice(0, 8)}… (${made.id})`)
    answerJson(stream, 200, { ok: true, key: made.key, id: made.id } satisfies MagpieKeyAnswer)
  }

  const returnKey = async (stream: Seal2Stream, peer: string): Promise<void> => {
    let mine: readonly BoundKey[]
    let listed: readonly KeyRow[]
    try {
      mine = deps.keys.list().filter((k) => k.peer === peer)
      listed = await rowsAfterNow()
    } catch {
      return answerJson(stream, 500, { ok: false, why: 'The list of keys is not readable.' })
    }
    const failed: string[] = []
    for (const old of mine) {
      unbind(old.id)
      if (!listed.some((row) => row.id === old.id)) continue
      const gone = await deps.revoke(old.id)
      if (!gone.ok) failed.push(old.id)
    }
    answerJson(stream, failed.length === 0 ? 200 : 409, failed.length === 0 ? { ok: true } : { ok: false, why: `${deps.name()} could not revoke ${failed.length} key(s); revoke them in its Magpie.` })
  }

  /**
   * The asking computer stored its key and shows it: the key (constant-time on its hash) bound to THIS
   * device under THIS id, and still enabled in Magpie by a read begun now. The binding goes live, then
   * the intent is settled. Repeated, it answers the same: the binding is live already, the intent gone.
   */
  const ackKey = async (stream: Seal2Stream, peer: string, headers: Readonly<Record<string, string>>, text: string): Promise<void> => {
    const key = presentedKey(headers)
    let id = ''
    try {
      const body = JSON.parse(text) as { id?: unknown } | null
      id = typeof body?.id === 'string' ? body.id : ''
    } catch {
      id = ''
    }
    if (key === null || id === '') return answerJson(stream, 400, { ok: false, why: 'Say which key, and show it.' })
    const bound = bindingOf(peer, key)
    if (bound === null || bound.id !== id) return answerJson(stream, 401, { ok: false, why: `${deps.name()} did not give this computer that key. Connect it again.` })
    let rows: readonly KeyRow[]
    try {
      rows = await rowsAfterNow()
    } catch {
      return answerJson(stream, 503, { ok: false, why: `${deps.name()} could not read its Magpie's keys.` })
    }
    if (!listedEnabled(rows, bound.id, key)) return answerJson(stream, 410, { ok: false, why: `${deps.name()} no longer has this key. Connect it again.` })
    if (deps.acknowledge === undefined) return answerJson(stream, 503, { ok: false, why: `${deps.name()} cannot record that the key arrived.` })
    // In the same turn as the check above: an unbind during the read is honoured, never undone.
    if (bindingOf(peer, key)?.id !== bound.id) return answerJson(stream, 401, { ok: false, why: `${deps.name()} no longer accepts this key. Connect it again.` })
    try {
      deps.keys.confirm(bound.id)
    } catch {
      return answerJson(stream, 500, { ok: false, why: `${deps.name()} could not record that the key arrived.` })
    }
    const settled = await deps.acknowledge(bound.id).catch(() => ({ ok: false as const, why: 'unanswered' }))
    // Live but its warning could not be cleared: B takes it back itself, never trusting the asker to return it.
    // Unbound first (it serves nothing from here), then revoked; the intent keeps warning either way.
    if (!settled.ok) {
      unbind(bound.id)
      await deps.revoke(bound.id).catch(() => null)
      return answerJson(stream, 500, { ok: false, why: `${deps.name()} could not record that the key arrived, so it took the key back.` })
    }
    // A revoke that ran between the confirm and the settle (it waits in the same queue) has unbound it: say so.
    if (bindingOf(peer, key)?.id !== bound.id) return answerJson(stream, 401, { ok: false, why: `${deps.name()} no longer accepts this key. Connect it again.` })
    if (bound.pending === true) deps.log(`magpie remote: ${peer.slice(0, 8)}… acknowledged its key (${bound.id})`)
    answerJson(stream, 200, { ok: true, id: bound.id })
  }

  /** One key request (or return) per computer at a time: two at once would each make a key and multiply its cap. */
  const lanes = new Map<string, Promise<void>>()
  const oneAtATime = (peer: string, work: () => Promise<void>): Promise<void> => {
    const next = (lanes.get(peer) ?? Promise.resolve()).then(work, work)
    const tail = next.catch(() => undefined)
    lanes.set(peer, tail)
    void tail.then(() => {
      if (lanes.get(peer) === tail) lanes.delete(peer)
    })
    return next
  }

  const model = async (stream: Seal2Stream, peer: string, request: { method: string; path: string; headers: Record<string, string> }): Promise<void> => {
    const key = presentedKey(request.headers)
    if (key === null) return refuse(stream, 401, `This computer has no key for ${deps.name()}’s Magpie. Connect it again.`)
    // A first look before the body is taken in: a stranger's key is refused at once.
    const first = bindingOf(peer, key)
    if (first === null) return refuse(stream, 401, `${deps.name()} no longer accepts this computer’s key. Connect it again.`)
    // Given but never acknowledged: an asker from before acknowledgements, or one that died before it confirmed.
    if (first.pending === true) return refuse(stream, 401, `This computer never confirmed the key ${deps.name()} gave it. Update Cookrew here if it is older, then connect again.`)
    // As many at once as its key may run in Magpie, counted BEFORE any body is held in main.
    const count = perComputer.get(peer) ?? 0
    if (count >= PER_COMPUTER_REQUESTS) return refuse(stream, 429, `${deps.name()} is already answering ${count} requests from this computer.`)
    perComputer.set(peer, count + 1)
    const done = (): void => {
      const left = (perComputer.get(peer) ?? 1) - 1
      if (left <= 0) perComputer.delete(peer)
      else perComputer.set(peer, left)
    }
    let whole: Awaited<ReturnType<typeof readWholeBody>> | null = null
    try {
      whole = await readWholeBody(stream, MAGPIE_BODY_MAX, MAGPIE_BODY_MS, budget)
      if (!whole.ok) return stream.abort(whole.code, whole.reason)
      // The body is in hand: the key is checked now, against a list read from now on, and Magpie gets both at once.
      const bound = await validNow(peer, key).catch(() => null)
      if (bound === null) return refuse(stream, 401, `${deps.name()} no longer accepts this computer’s key. Connect it again.`)
      if (!switchedOn()) return refuse(stream, 403, `Magpie remote is switched off on ${deps.name()}.`)
      const port = deps.gatewayPort()
      if (port === null) return refuse(stream, 503, `Magpie is not running on ${deps.name()}.`)
      // Once more, in the same turn as the dial: an unbind since the read is honoured.
      if (liveBindingOf(peer, key)?.id !== bound.id) return refuse(stream, 401, `${deps.name()} no longer accepts this computer’s key. Connect it again.`)
      track(bound.id, stream)
      sendToMagpie(stream, { method: request.method, path: request.path, headers: magpieHeaders(request.headers, key) }, whole.parts, { dial: deps.dial(port), log: deps.log })
      // Handed to Node's request: main's own hold on the bytes ends here.
      whole.release()
      await stream.closed.catch(() => undefined)
    } finally {
      whole?.release()
      done()
    }
  }

  const handle = async (stream: Seal2Stream, peer: SealPeer): Promise<void> => {
    if (peer.mode !== 'device') return stream.abort(ABORT.refused, 'desktops of the account only')
    const request = readRequest(stream.fields)
    if (request === null) return stream.abort(ABORT.refused, 'bad-request')
    if (!switchedOn()) return refuse(stream, 403, `Magpie remote is switched off on ${deps.name()}.`)
    const control = request.method === 'POST' && (request.path === MAGPIE_KEY_PATH || request.path === MAGPIE_KEY_ACK_PATH || request.path === MAGPIE_KEY_RETURN_PATH)
    if (control) {
      // Read before the per-computer lane, with a time limit: a held body must not hold up that computer's other asks.
      const small = await readWholeBody(stream, CONTROL_BODY_MAX, CONTROL_BODY_MS)
      if (!small.ok) return stream.abort(small.code, small.reason)
      const text = Buffer.concat(small.parts.map((p) => Buffer.from(p))).toString('utf8')
      // One lane per computer for all three: an acknowledgement never interleaves with that computer's ask or return.
      if (request.path === MAGPIE_KEY_PATH) return oneAtATime(peer.deviceId, () => giveKey(stream, peer.deviceId, text))
      if (request.path === MAGPIE_KEY_ACK_PATH) return oneAtATime(peer.deviceId, () => ackKey(stream, peer.deviceId, request.headers, text))
      return oneAtATime(peer.deviceId, () => returnKey(stream, peer.deviceId))
    }
    if (!modelRoute(request.method, request.path)) return refuse(stream, 404, 'Only model requests are served here.')
    return model(stream, peer.deviceId, request)
  }

  const handler: SealStreamHandler = (stream, peer) => {
    void handle(stream, peer).catch(() => stream.abort(ABORT.internal, 'magpie-serve-failed'))
  }
  return Object.assign(handler, { unbind, switchesChanged })
}
