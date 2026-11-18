import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'
import type { LiveValues } from '../../shared/launch-settings'
import type { MagpieKeyAckAnswer, MagpieKeyAnswer } from '../../shared/remote-magpie'
import type { SecretSealer } from '../secrets-store'
import { remoteSwitchedOn } from './switches'

/**
 * THE OTHER COMPUTERS WHOSE MAGPIE THIS ONE USES, AND THE KEY EACH GAVE IT.
 *
 * Connecting asks the other desktop for a key of this computer's own over the
 * seal (serve.ts · MAGPIE_KEY_PATH): nobody copies a key by hand, and none is
 * ever typed, put on a command line or shown. The key is kept here, sealed with
 * the app's keychain key where there is one (secrets-seal.ts), 0600 always, and
 * read only by the forwarder (forward.ts), which puts it on each request.
 * Where no keychain is (a Linux box with no keyring) it is kept 0600 in the
 * clear, and the panel says so (`sealed`).
 *
 * This computer's own Magpie gets a Remote magpie provider whose URL is the
 * forwarder and whose key is a placeholder (SEALED_PLACEHOLDER_KEY): the only
 * thing on the `magpie provider add` line is that placeholder and an address.
 *
 * KEY ACKNOWLEDGEMENT (agreed with Relay): once the key is kept here durably,
 * and before any provider is pointed at it, this computer tells the other one it
 * has it (wire.ts · ackKeyOver); the other serves nothing with the key until
 * then. A refusal, a Cookrew there too old to hear it, or two broken streams in
 * a row: the key is dropped here and given back there. Nothing half-kept.
 *
 * RE-ACKNOWLEDGED (Relay's ruling, 2026-11-19): the key is kept with its id and
 * `acked: false` until the other computer answers. The forwarder gets no key
 * while it is false. A crash or a broken stream before the answer leaves it so,
 * and the acknowledgement is sent again on start (resumeRemotes) and on the next
 * connect, before any new key is asked for. A refusal drops it and gives it back.
 */

export const REMOTES_FILE = 'magpie-remotes.json'

export interface RemoteMagpie {
  /** The other desktop's account device id. */
  readonly peer: string
  readonly name: string
  /** The Remote magpie provider in this computer's Magpie: its models are `<providerId>/…`. */
  readonly providerId: string
  readonly at: string
  /** Magpie's id for the key, on the other computer; absent on records from before acknowledgements. */
  readonly keyId?: string
  /** False until the other computer heard this one keeps the key; absent = from before, read as true. */
  readonly acked?: boolean
}

interface StoredRemote extends RemoteMagpie {
  readonly sealed?: string
  readonly plain?: string
}

export interface RemotesStore {
  /** Throws when the file cannot be read. */
  list(): readonly RemoteMagpie[]
  keyFor(peer: string): string | null
  put(remote: RemoteMagpie, key: string): void
  /** A kept key the other computer has not acknowledged yet, with its id; null for none. */
  unacked(peer: string): { key: string; keyId: string } | null
  /** The other computer acknowledged this key, used by this provider: the forwarder may use it. Throws for another key. */
  markAcked(peer: string, keyId: string, providerId: string): void
  remove(peer: string): void
  /** Are keys sealed with the keychain here? */
  sealed(): boolean
}

function writeDurably(file: string, text: string): void {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
  // The rename too: a key this computer acknowledged must still be here after a crash.
  if (process.platform === 'win32') return
  const dirFd = openSync(dir, 'r')
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

export function createRemotesStore(file: string, sealer: SecretSealer | null): RemotesStore {
  const canSeal = (): boolean => {
    try {
      return sealer?.available() === true
    } catch {
      return false
    }
  }
  const read = (): StoredRemote[] => {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'ENOENT') return []
      throw error
    }
    const parsed = JSON.parse(text) as { v?: unknown; remotes?: unknown }
    if (parsed?.v !== 1 || !Array.isArray(parsed.remotes)) throw new Error('The list of other computers’ Magpies is not readable.')
    return parsed.remotes.map((raw) => {
      const r = raw as Record<string, unknown>
      if (typeof r?.peer !== 'string' || typeof r.name !== 'string' || typeof r.providerId !== 'string' || typeof r.at !== 'string') throw new Error('A connected computer is not readable.')
      if ((r.keyId !== undefined && typeof r.keyId !== 'string') || (r.acked !== undefined && typeof r.acked !== 'boolean')) throw new Error('A connected computer is not readable.')
      return {
        peer: r.peer,
        name: r.name,
        providerId: r.providerId,
        at: r.at,
        ...(typeof r.keyId === 'string' ? { keyId: r.keyId } : {}),
        ...(typeof r.acked === 'boolean' ? { acked: r.acked } : {}),
        ...(typeof r.sealed === 'string' ? { sealed: r.sealed } : {}),
        ...(typeof r.plain === 'string' ? { plain: r.plain } : {})
      }
    })
  }
  const write = (remotes: readonly StoredRemote[]): void => {
    if (remotes.length === 0) {
      rmSync(file, { force: true })
      return
    }
    writeDurably(file, `${JSON.stringify({ v: 1, remotes })}\n`)
  }
  const keyOf = (found: StoredRemote): string | null => {
    if (found.sealed !== undefined) return sealer === null ? null : sealer.open(Buffer.from(found.sealed, 'base64'))
    return found.plain ?? null
  }
  return {
    list: () => read().map(({ peer, name, providerId, at, keyId, acked }) => ({ peer, name, providerId, at, ...(keyId === undefined ? {} : { keyId }), ...(acked === undefined ? {} : { acked }) })),
    keyFor: (peer) => {
      const found = read().find((r) => r.peer === peer)
      // Not acknowledged yet: the other computer honours it for nothing, so nothing is sent with it.
      return found === undefined || found.acked === false ? null : keyOf(found)
    },
    unacked: (peer) => {
      const found = read().find((r) => r.peer === peer)
      if (found === undefined || found.acked !== false || found.keyId === undefined) return null
      const key = keyOf(found)
      return key === null ? null : { key, keyId: found.keyId }
    },
    markAcked: (peer, keyId, providerId) => {
      const all = read()
      if (!all.some((r) => r.peer === peer && r.keyId === keyId)) throw new Error('That key is no longer kept here.')
      write(all.map((r) => (r.peer === peer && r.keyId === keyId ? { ...r, providerId, acked: true } : r)))
    },
    put: (remote, key) => {
      const box: StoredRemote = canSeal() && sealer !== null ? { ...remote, sealed: sealer.seal(key).toString('base64') } : { ...remote, plain: key }
      write([...read().filter((r) => r.peer !== remote.peer), box])
    },
    remove: (peer) => write(read().filter((r) => r.peer !== peer)),
    sealed: canSeal
  }
}

/** A provider id from the other computer's name: Magpie's ids are lower-case words. */
export function providerIdFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'remote'
  // `group/…` is how Magpie names its own routing groups (route/remote-gate.ts reads it so).
  if (base === 'group') return providerIdFor('group computer', taken)
  if (!taken.includes(base)) return base
  for (let n = 2; ; n += 1) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`
}

export interface ProviderEntry {
  readonly id: string
  readonly preset: string | null
  readonly urls: readonly string[]
}

export interface ConnectDeps {
  switches(): LiveValues | null
  readonly store: RemotesStore
  /** Ask the desktop for this computer's key over the seal. */
  askKey(peer: string, myName: string): Promise<MagpieKeyAnswer>
  /** Say over the seal that the key is stored here (idempotent); throws when the stream breaks. */
  ackKey(peer: string, key: string, id: string): Promise<MagpieKeyAckAnswer>
  /** Give the key back over the seal: the other computer revokes it. */
  returnKey(peer: string): Promise<void>
  /** `magpie provider add remote-magpie <placeholder> url=<url> id=<id>`: a new provider, never one that is there. */
  addProvider(providerId: string, url: string): Promise<{ ok: true } | { ok: false; why: string }>
  /** Point a provider THIS store made at the forwarder again. */
  setProvider(providerId: string, url: string): Promise<{ ok: true } | { ok: false; why: string }>
  removeProvider(providerId: string): Promise<void>
  /** Magpie's own providers now (id, preset, endpoint addresses; never a key); null when they cannot be read. */
  providers(): Promise<ProviderEntry[] | null>
  forwarderPort(): number | null
  /**
   * The Seatbelt lane's served-seat gate (servedSeatGate): every served seat runs today's profile.
   * Absent: no gate to ask. Asked before a provider is pointed at the forwarder; false or a throw refuses.
   */
  seatGate(): Promise<boolean>
  myName(): string
  now?(): Date
}

export type ConnectAnswer = { readonly ok: true; readonly providerId: string } | { readonly ok: false; readonly why: string }

/** Where a provider is pointed and under which id: decided once Magpie's providers are read. */
interface Place {
  readonly providerId: string
  readonly ours: boolean
  readonly url: string
}

type Placed = { readonly ok: true; readonly place: Place } | { readonly ok: false; readonly why: string }

/** Both switches, the gate, the forwarder and Magpie's providers: where this computer's provider goes. */
async function placeFor(peer: string, peerName: string, known: readonly RemoteMagpie[], deps: ConnectDeps): Promise<Placed> {
  if (!remoteSwitchedOn(() => deps.switches())) return { ok: false, why: 'Turn on Magpie and Magpie remote in Launch settings first.' }
  if (!(await deps.seatGate().catch(() => false))) {
    // Connecting also asks: a provider is never pointed at the forwarder while the gate is shut.
    return { ok: false, why: 'A served session still runs under an older sandbox. Restart it, then connect again.' }
  }
  const port = deps.forwarderPort()
  if (port === null) return { ok: false, why: 'This computer’s forwarder to other Magpies is not running: another program holds its port.' }
  const existing = known.find((r) => r.peer === peer)
  // Unreadable is not empty: a guess could take, and then repoint, one of the owner's own providers.
  const entries = await deps.providers().catch(() => null)
  if (entries === null) return { ok: false, why: 'This computer’s Magpie providers could not be read.' }
  const recorded = existing === undefined ? undefined : entries.find((e) => e.id === existing.providerId)
  // Repointed only while it is still the provider this app made: a Remote magpie aimed at the forwarder.
  // An id the owner has since reused for a provider of their own gets a new id instead.
  const ours = recorded !== undefined && recorded.preset === 'remote-magpie' && recorded.urls.some((u) => u.startsWith(`http://127.0.0.1:${port}/peer/`))
  const providerId = ours ? recorded.id : providerIdFor(peerName, [...known.filter((r) => r.peer !== peer).map((r) => r.providerId), ...entries.map((e) => e.id)])
  return { ok: true, place: { providerId, ours, url: `http://127.0.0.1:${port}/peer/${peer}` } }
}

/** Acknowledged: the key may be used, and the provider is pointed at the forwarder. Anything failing gives it back. */
async function finish(peer: string, peerName: string, keyId: string, place: Place, deps: ConnectDeps): Promise<ConnectAnswer> {
  try {
    deps.store.markAcked(peer, keyId, place.providerId)
  } catch {
    dropKey(peer, deps)
    return { ok: false, why: `Could not record that ${peerName} has heard about the key.${await giveBack(peer, peerName, deps)}` }
  }
  const added = place.ours ? await deps.setProvider(place.providerId, place.url) : await deps.addProvider(place.providerId, place.url)
  if (!added.ok) {
    dropKey(peer, deps)
    return { ok: false, why: `${added.why}${await giveBack(peer, peerName, deps)}` }
  }
  return { ok: true, providerId: place.providerId }
}

/**
 * Tell the other computer again about a key kept here but never acknowledged. `done`: acknowledged and
 * finished, or refused (dropped and given back); `waiting`: it could not be reached, the key stays as it is.
 */
async function reacknowledge(peer: string, peerName: string, place: Place, deps: ConnectDeps): Promise<{ readonly state: 'none' } | { readonly state: 'waiting'; readonly why: string } | { readonly state: 'done'; readonly answer: ConnectAnswer }> {
  let kept: { key: string; keyId: string } | null
  try {
    kept = deps.store.unacked(peer)
  } catch {
    kept = null
  }
  if (kept === null) return { state: 'none' }
  const acked = await acknowledge(peer, kept.key, kept.keyId, deps)
  if (acked.ok) return { state: 'done', answer: await finish(peer, peerName, kept.keyId, place, deps) }
  if (acked.broken) return { state: 'waiting', why: acked.why }
  dropKey(peer, deps)
  await giveBack(peer, peerName, deps)
  return { state: 'done', answer: { ok: false, why: acked.why } }
}

export async function connectRemote(peer: unknown, peerName: unknown, deps: ConnectDeps): Promise<ConnectAnswer> {
  if (typeof peer !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(peer) || typeof peerName !== 'string' || peerName.trim() === '') return { ok: false, why: 'Not one of your computers.' }
  let known: readonly RemoteMagpie[]
  try {
    known = deps.store.list()
  } catch (error) {
    if (!remoteSwitchedOn(() => deps.switches())) return { ok: false, why: 'Turn on Magpie and Magpie remote in Launch settings first.' }
    return { ok: false, why: error instanceof Error ? error.message : 'The list of connected computers is not readable.' }
  }
  const placed = await placeFor(peer, peerName, known, deps)
  if (!placed.ok) return placed
  const { place } = placed
  // A key kept but never acknowledged (a crash, a broken stream): said again first; refused, a new one is asked for.
  const again = await reacknowledge(peer, peerName, place, deps)
  if (again.state === 'waiting') return { ok: false, why: again.why }
  if (again.state === 'done' && again.answer.ok) return again.answer
  const answer = await deps.askKey(peer, deps.myName()).catch((error: unknown): MagpieKeyAnswer => ({ ok: false, why: error instanceof Error ? error.message : 'The other computer did not answer.' }))
  if (!answer.ok) return { ok: false, why: answer.why }
  try {
    deps.store.put({ peer, name: peerName, providerId: place.providerId, at: (deps.now ?? (() => new Date()))().toISOString(), keyId: answer.id, acked: false }, answer.key)
  } catch {
    return { ok: false, why: `Could not keep the key it gave this computer.${await giveBack(peer, peerName, deps)}` }
  }
  // Kept durably: now, and only now, say so. Nothing points at the key before the other computer has heard it.
  const acked = await acknowledge(peer, answer.key, answer.id, deps)
  if (acked.ok) return finish(peer, peerName, answer.id, place, deps)
  // Unheard, not refused: the key stays here unacknowledged (the forwarder sends nothing with it) and is said again on start.
  if (acked.broken) return { ok: false, why: `${acked.why} Cookrew tells it again when it starts, or connect again.` }
  dropKey(peer, deps)
  const back = await giveBack(peer, peerName, deps)
  return { ok: false, why: `${acked.old ? `${peerName} runs an older Cookrew that cannot confirm a key. Update Cookrew on ${peerName}, then connect again.` : acked.why}${back}` }
}

/** The computers whose key is kept here but not yet acknowledged; [] when the list cannot be read. */
export function unackedPeers(store: RemotesStore): string[] {
  try {
    return store.list().filter((r) => r.acked === false).map((r) => r.peer)
  } catch {
    return []
  }
}

/**
 * On start (and every few minutes while one waits): every key kept here but never acknowledged is said again. Acknowledged, its provider is pointed
 * at the forwarder; refused, it is dropped and given back; unreachable or switched off, it waits. Never throws.
 */
export async function resumeRemotes(deps: ConnectDeps, only?: string): Promise<void> {
  let known: readonly RemoteMagpie[]
  try {
    known = deps.store.list()
  } catch {
    return
  }
  for (const remote of known.filter((r) => r.acked === false && (only === undefined || r.peer === only))) {
    try {
      const placed = await placeFor(remote.peer, remote.name, known, deps)
      if (placed.ok) await reacknowledge(remote.peer, remote.name, placed.place, deps)
    } catch {
      // Left as it is: unacknowledged, it carries nothing, and the next start or connect tries again.
    }
  }
}

/** Give the key back; the words say honestly whether the other computer took it. */
async function giveBack(peer: string, peerName: string, deps: Pick<ConnectDeps, 'returnKey'>): Promise<string> {
  try {
    await deps.returnKey(peer)
    return ' The key was given back.'
  } catch {
    return ` The key could not be given back: ${peerName} still warns of it until its owner revokes it there.`
  }
}

/** Acknowledgements are idempotent, so a broken stream is asked once more; a second break is a failure. */
const ACK_TRIES = 2

/** Refused (`broken` false) or never heard because the stream broke twice (`broken` true). */
type Acknowledged = { readonly ok: true } | { readonly ok: false; readonly why: string; readonly old: boolean; readonly broken: boolean }

async function acknowledge(peer: string, key: string, id: string, deps: Pick<ConnectDeps, 'ackKey'>): Promise<Acknowledged> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const answer: MagpieKeyAckAnswer = await deps.ackKey(peer, key, id)
      return answer.ok ? answer : { ...answer, broken: false }
    } catch {
      if (attempt >= ACK_TRIES) return { ok: false, why: 'The other computer did not answer when told the key had arrived.', old: false, broken: true }
    }
  }
}

/** Forget a key here; a store that cannot be written then holds a key the other computer will refuse. */
function dropKey(peer: string, deps: Pick<ConnectDeps, 'store'>): void {
  try {
    deps.store.remove(peer)
  } catch {
    // Given back below: the other computer revokes it, so what is left here opens nothing.
  }
}

export async function disconnectRemote(peer: unknown, deps: Pick<ConnectDeps, 'store' | 'returnKey' | 'removeProvider'>): Promise<{ ok: true } | { ok: false; why: string }> {
  if (typeof peer !== 'string') return { ok: false, why: 'Not one of your computers.' }
  let found: RemoteMagpie | undefined
  try {
    found = deps.store.list().find((r) => r.peer === peer)
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : 'The list of connected computers is not readable.' }
  }
  if (!found) return { ok: false, why: 'This computer is not connected to it.' }
  // The key goes first, here and there: a provider left behind with no key answers nothing.
  deps.store.remove(peer)
  await deps.returnKey(peer).catch(() => undefined)
  await deps.removeProvider(found.providerId).catch(() => undefined)
  return { ok: true }
}

/**
 * One connect or disconnect per computer at a time, in main: the panel's own guard is lost
 * when the window reloads, and two connects at once would each ask for a key and then
 * give back the other's.
 */
export function perComputer(): <T>(peer: string, work: () => Promise<T>) => Promise<T> {
  const lanes = new Map<string, Promise<unknown>>()
  return (peer, work) => {
    const next = (lanes.get(peer) ?? Promise.resolve()).then(work, work)
    const tail = next.catch(() => undefined)
    lanes.set(peer, tail)
    void tail.then(() => {
      if (lanes.get(peer) === tail) lanes.delete(peer)
    })
    return next
  }
}
