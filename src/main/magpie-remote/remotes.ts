import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'
import type { LiveValues } from '../../shared/launch-settings'
import type { MagpieKeyAnswer } from '../../shared/remote-magpie'
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
 */

export const REMOTES_FILE = 'magpie-remotes.json'

export interface RemoteMagpie {
  /** The other desktop's account device id. */
  readonly peer: string
  readonly name: string
  /** The Remote magpie provider in this computer's Magpie: its models are `<providerId>/…`. */
  readonly providerId: string
  readonly at: string
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
  remove(peer: string): void
  /** Are keys sealed with the keychain here? */
  sealed(): boolean
}

function writeDurably(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
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
      return {
        peer: r.peer,
        name: r.name,
        providerId: r.providerId,
        at: r.at,
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
  return {
    list: () => read().map(({ peer, name, providerId, at }) => ({ peer, name, providerId, at })),
    keyFor: (peer) => {
      const found = read().find((r) => r.peer === peer)
      if (!found) return null
      if (found.sealed !== undefined) return sealer === null ? null : sealer.open(Buffer.from(found.sealed, 'base64'))
      return found.plain ?? null
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
  myName(): string
  now?(): Date
}

export type ConnectAnswer = { readonly ok: true; readonly providerId: string } | { readonly ok: false; readonly why: string }

export async function connectRemote(peer: unknown, peerName: unknown, deps: ConnectDeps): Promise<ConnectAnswer> {
  if (typeof peer !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(peer) || typeof peerName !== 'string' || peerName.trim() === '') return { ok: false, why: 'Not one of your computers.' }
  if (!remoteSwitchedOn(() => deps.switches())) return { ok: false, why: 'Turn on Magpie and Magpie remote in Launch settings first.' }
  const port = deps.forwarderPort()
  if (port === null) return { ok: false, why: 'This computer’s forwarder to other Magpies is not running: another program holds its port.' }
  let known: readonly RemoteMagpie[]
  try {
    known = deps.store.list()
  } catch (error) {
    return { ok: false, why: error instanceof Error ? error.message : 'The list of connected computers is not readable.' }
  }
  const existing = known.find((r) => r.peer === peer)
  // Unreadable is not empty: a guess could take, and then repoint, one of the owner's own providers.
  const entries = await deps.providers().catch(() => null)
  if (entries === null) return { ok: false, why: 'This computer’s Magpie providers could not be read.' }
  const ids = entries.map((e) => e.id)
  const recorded = existing === undefined ? undefined : entries.find((e) => e.id === existing.providerId)
  // Repointed only while it is still the provider this app made: a Remote magpie aimed at the forwarder.
  // An id the owner has since reused for a provider of their own gets a new id instead.
  const ours = recorded !== undefined && recorded.preset === 'remote-magpie' && recorded.urls.some((u) => u.startsWith(`http://127.0.0.1:${port}/peer/`))
  const providerId = ours ? recorded.id : providerIdFor(peerName, [...known.map((r) => r.providerId), ...ids])
  const answer = await deps.askKey(peer, deps.myName()).catch((error: unknown): MagpieKeyAnswer => ({ ok: false, why: error instanceof Error ? error.message : 'The other computer did not answer.' }))
  if (!answer.ok) return { ok: false, why: answer.why }
  try {
    deps.store.put({ peer, name: peerName, providerId, at: (deps.now ?? (() => new Date()))().toISOString() }, answer.key)
  } catch {
    await deps.returnKey(peer).catch(() => undefined)
    return { ok: false, why: 'Could not keep the key it gave this computer, so it was given back.' }
  }
  const url = `http://127.0.0.1:${port}/peer/${peer}`
  const added = ours ? await deps.setProvider(providerId, url) : await deps.addProvider(providerId, url)
  if (!added.ok) {
    deps.store.remove(peer)
    await deps.returnKey(peer).catch(() => undefined)
    return { ok: false, why: added.why }
  }
  return { ok: true, providerId }
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
