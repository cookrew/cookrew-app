import os from 'node:os'
import path from 'node:path'
import { loopbackDialer } from '../canvas-bridge'
import type { SealStreamHandler } from '../canvas-seal-terminus'
import type { DiscoveryEnv } from '../route/discovery'
import type { ShareKeys } from '../route/share-keys'
import type { SecretSealer } from '../secrets-store'
import { DEFAULT_DAILY_USD } from '../../shared/share-devices'
import type { LiveValues } from '../../shared/launch-settings'
import { MAGPIE_FORWARD_PORTS, type MagpieRemoteList } from '../../shared/remote-magpie'
import type { Fields } from '../../shared/seal2/frames'
import type { Seal2Stream } from '../../shared/seal2/stream'
import { BOUND_KEYS_FILE, createBoundKeys, fileStorage, type BoundKeys } from './bound-keys'
import { createMagpieForwarder } from './forward'
import { connectRemote, createRemotesStore, disconnectRemote, REMOTES_FILE, type ConnectAnswer } from './remotes'
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
  desktops(): Promise<{ id: string; name: string; online: boolean }[] | null>
  /** This desktop's account device id, or null when signed out. */
  selfId(): string | null
  readonly sealer: SecretSealer | null
  magpieBin(): string | null
  env(): DiscoveryEnv
  log(line: string): void
}

export interface MagpieRemote {
  readonly serve: SealStreamHandler
  readonly boundKeys: BoundKeys
  start(): Promise<void>
  stop(): Promise<void>
  /** The forwarder's port while it runs. */
  port(): number | null
  list(): Promise<MagpieRemoteList>
  connect(peer: unknown, name: unknown): Promise<ConnectAnswer>
  disconnect(peer: unknown): Promise<{ ok: true } | { ok: false; why: string }>
}

const myName = (): string => os.hostname().replace(/\.local$/i, '') || 'this computer'

export function createMagpieRemote(deps: MagpieRemoteDeps): MagpieRemote {
  const boundKeys = createBoundKeys(fileStorage(path.join(deps.base, BOUND_KEYS_FILE)))
  const remotes = createRemotesStore(path.join(deps.base, REMOTES_FILE), deps.sealer)
  const providers = magpieProviders(() => deps.magpieBin(), () => deps.env())
  const askKey = askKeyOver((peer, kind, fields) => deps.openStream(peer, kind, fields))
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
      const made = await keys.issue({ device, dailyUsd: DEFAULT_DAILY_USD }, permitted)
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

  const forwarder = createMagpieForwarder({
    switches: () => deps.switches(),
    keyFor: (peer) => remotes.keyFor(peer),
    openStream: (peer, kind, fields) => deps.openStream(peer, kind, fields),
    log: (line) => deps.log(line)
  })

  return {
    serve,
    boundKeys,
    start: async () => {
      // One port, always the same: Magpie's providers name it, so taking another would send them elsewhere.
      try {
        await forwarder.listen(MAGPIE_FORWARD_PORTS[0])
      } catch (error) {
        deps.log(`magpie remote: the forwarder could not take 127.0.0.1:${MAGPIE_FORWARD_PORTS[0]}: ${error instanceof Error ? error.message : 'unknown'}`)
      }
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
            return { id: d.id, name: d.name, online: d.online, providerId: c?.providerId ?? null }
          }),
        desktopsKnown: desktops !== null
      }
    },
    connect: (peer, name) =>
      connectRemote(peer, name, {
        switches: () => deps.switches(),
        store: remotes,
        askKey,
        returnKey,
        addProvider: (id, url) => providers.add(id, url),
        removeProvider: (id) => providers.remove(id),
        providerIds: () => providers.ids(),
        forwarderPort: () => forwarder.port(),
        myName
      }),
    disconnect: (peer) => disconnectRemote(peer, { store: remotes, returnKey, removeProvider: (id) => providers.remove(id) })
  }
}
