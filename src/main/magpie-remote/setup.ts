import os from 'node:os'
import path from 'node:path'
import { loopbackDialer } from '../canvas-bridge'
import type { SealStreamHandler } from '../canvas-seal-terminus'
import type { DiscoveryEnv } from '../route/discovery'
import type { ShareKeys } from '../route/share-keys'
import type { SecretSealer } from '../secrets-store'
import { DEFAULT_DAILY_USD } from '../../shared/share-devices'
import type { LiveValues } from '../../shared/launch-settings'
import type { GuideOs } from '../../shared/devices-guide'
import { MAGPIE_FORWARD_PORTS, type MagpieRemoteList } from '../../shared/remote-magpie'
import type { Fields } from '../../shared/seal2/frames'
import type { Seal2Stream } from '../../shared/seal2/stream'
import { BOUND_KEYS_FILE, createBoundKeys, fileStorage, type BoundKeys } from './bound-keys'
import { createMagpieForwarder } from './forward'
import { connectRemote, createRemotesStore, disconnectRemote, perComputer, REMOTES_FILE, type ConnectAnswer } from './remotes'
import { createMagpieServe } from './serve'
import { askKeyOver, magpieProviders, returnKeyOver } from './wire'

/**
 * MAGPIE ACROSS THE OWNER'S COMPUTERS, PUT TOGETHER (lane Magpie). Both ends live
 * in every app: the `magpie` stream kind the terminus answers (serve.ts: this
 * computer's Magpie for the others) and the loopback forwarder (forward.ts: the
 * others' Magpies for this one), plus the three owner-only calls the Routing
 * panel and first run use to connect to another computer.
 */

export interface MagpieRemoteDeps {
  /** ~/.cookrew */
  readonly base: string
  switches(): LiveValues | null
  shareKeys(): ShareKeys | null
  gatewayPort(): number | null
  openStream(peer: string, kind: string, fields: Fields): Promise<Seal2Stream>
  /** The account's desktops (registry), or null when they cannot be had. */
  desktops(): Promise<{ id: string; name: string; online: boolean; os: GuideOs | null; arch: string | null }[] | null>
  /** This desktop's account device id, or null when signed out. */
  selfId(): string | null
  readonly sealer: SecretSealer | null
  magpieBin(): string | null
  /**
   * The served-seat gate (lane Seatbelt's servedSeatGate once it lands): every served seat runs
   * today's profile. Asked before the forwarder opens, before every connect, and (cached briefly)
   * on every forwarded request. False or a throw refuses. Required: there is no default.
   */
  seatGate(): Promise<boolean>
  /** Is this loopback connection's far end this user's magpie (caller.ts)? */
  callerIsMagpie(clientPort: number): Promise<boolean>
  /** The forwarder's port; tests pass 0. */
  readonly forwardPort?: number
  env(): DiscoveryEnv
  log(line: string): void
}

export interface MagpieRemote {
  readonly serve: SealStreamHandler
  /** Stop honouring a key over the seal and cut its streams, before it is revoked (serve.ts). */
  unbind(id: string): void
  readonly boundKeys: BoundKeys
  start(): Promise<void>
  stop(): Promise<void>
  /** The forwarder's port while it runs. */
  port(): number | null
  list(): Promise<MagpieRemoteList>
  connect(peer: unknown, name: unknown): Promise<ConnectAnswer>
  disconnect(peer: unknown): Promise<{ ok: true } | { ok: false; why: string }>
}

/** How long the gate's answer is kept for forwarded requests. */
const GATE_MS = 5_000

const myName = (): string => os.hostname().replace(/\.local$/i, '') || 'this computer'

export function createMagpieRemote(deps: MagpieRemoteDeps): MagpieRemote {
  const boundKeys = createBoundKeys(fileStorage(path.join(deps.base, BOUND_KEYS_FILE)))
  const remotes = createRemotesStore(path.join(deps.base, REMOTES_FILE), deps.sealer)
  const providers = magpieProviders(() => deps.magpieBin(), () => deps.env())
  const askKey = askKeyOver((peer, kind, fields) => deps.openStream(peer, kind, fields))
  const lane = perComputer()
  const returnKey = returnKeyOver((peer, kind, fields) => deps.openStream(peer, kind, fields))

  const serve = createMagpieServe({
    switches: () => deps.switches(),
    gatewayPort: () => deps.gatewayPort(),
    keys: boundKeys,
    listKeys: async () => {
      const keys = deps.shareKeys()
      if (keys === null) throw new Error('Magpie is not installed here.')
      return keys.listed()
    },
    issue: async (device, permitted) => {
      const keys = deps.shareKeys()
      if (keys === null) return { ok: false, why: 'Magpie is not installed on that computer.' }
      const made = await keys.issue({ device, dailyUsd: DEFAULT_DAILY_USD }, permitted, { handover: false })
      return made.ok ? { ok: true, key: made.key, id: made.shared.id } : made
    },
    revoke: async (id) => {
      const keys = deps.shareKeys()
      return keys === null ? { ok: false, why: 'Magpie is not installed here.' } : keys.revoke(id)
    },
    dial: (port) => loopbackDialer(port),
    name: myName,
    log: (line) => deps.log(line)
  })

  /** The gate's answer for forwarded requests, kept a few seconds: a check per request could be slow. */
  let gateSeen: { at: number; ok: Promise<boolean> } | null = null
  const gateNow = (): Promise<boolean> => {
    if (gateSeen === null || Date.now() - gateSeen.at > GATE_MS || Date.now() < gateSeen.at) gateSeen = { at: Date.now(), ok: deps.seatGate().catch(() => false) }
    return gateSeen.ok
  }
  const forwarder = createMagpieForwarder({
    switches: () => deps.switches(),
    keyFor: (peer) => remotes.keyFor(peer),
    openStream: (peer, kind, fields) => deps.openStream(peer, kind, fields),
    callerAllowed: (request) => deps.callerIsMagpie(request.socket.remotePort ?? 0),
    open: gateNow,
    log: (line) => deps.log(line)
  })
  const forwardPort = deps.forwardPort ?? MAGPIE_FORWARD_PORTS[0]
  /** Open the forwarder if it is not, once the gate passes. True when it runs. */
  const ensureForwarder = async (): Promise<boolean> => {
    if (forwarder.port() !== null) return true
    // A served seat on an old profile could dial or take the port: it stays shut until the gate passes.
    if (!(await deps.seatGate().catch(() => false))) {
      deps.log('magpie remote: the forwarder stays shut: a served session runs under an older sandbox')
      return false
    }
    try {
      await forwarder.listen(forwardPort)
      return true
    } catch (error) {
      deps.log(`magpie remote: the forwarder could not take 127.0.0.1:${forwardPort}: ${error instanceof Error ? error.message : 'unknown'}`)
      return false
    }
  }

  return {
    serve,
    unbind: (id) => serve.unbind(id),
    boundKeys,
    // One port, always the same: Magpie's providers name it, so taking another would send them elsewhere.
    start: async () => {
      await ensureForwarder()
    },
    stop: () => forwarder.close(),
    port: () => forwarder.port(),
    list: async () => {
      const self = deps.selfId()
      const desktops = (await deps.desktops().catch(() => null)) ?? null
      let connected: ReturnType<typeof remotes.list> = []
      let problem: string | null = null
      try {
        connected = remotes.list()
      } catch (error) {
        problem = error instanceof Error ? error.message : 'The list of connected computers is not readable.'
      }
      return {
        signedIn: self !== null,
        forwarder: forwarder.port(),
        sealed: remotes.sealed(),
        problem,
        desktops: (desktops ?? [])
          .filter((d) => d.id !== self)
          .map((d) => {
            const c = connected.find((r) => r.peer === d.id)
            return { id: d.id, name: d.name, online: d.online, providerId: c?.providerId ?? null, os: d.os, arch: d.arch }
          }),
        desktopsKnown: desktops !== null
      }
    },
    // One lane for every computer: two computers of one name must not both take one provider id.
    connect: (peer, name) =>
      lane('connect', async () => {
        // A gate that failed at start may pass now: the forwarder is opened here then, not reported as taken.
        await ensureForwarder()
        return connectRemote(peer, name, {
        switches: () => deps.switches(),
        store: remotes,
        askKey,
        returnKey,
        addProvider: (id, url) => providers.add(id, url),
        setProvider: (id, url) => providers.set(id, url),
        removeProvider: (id) => providers.remove(id),
        providers: () => providers.entries(),
        forwarderPort: () => forwarder.port(),
        seatGate: () => deps.seatGate(),
        myName
      })
      }),
    disconnect: (peer) => lane('connect', () => disconnectRemote(peer, { store: remotes, returnKey, removeProvider: (id) => providers.remove(id) }))
  }
}
