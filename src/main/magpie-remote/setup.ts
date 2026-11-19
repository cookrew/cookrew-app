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
import { connectRemote, createRemotesStore, disconnectRemote, perComputer, REMOTES_FILE, resumeRemotes, unackedPeers, type ConnectAnswer, type ConnectDeps } from './remotes'
import { createMagpieServe } from './serve'
import { ackKeyOver, askKeyOver, magpieProviders, returnKeyOver } from './wire'

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
   * The served-seat gate (seat-gate.ts: lane Seatbelt's servedSeatGate on macOS, no served terminal on
   * the canvas elsewhere). Asked before every connect and before every re-acknowledgement points a
   * provider, and (cached: an open answer 30 s, a shut one 5 s) on every forwarded request. False or a
   * throw refuses. Required: there is no default.
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
  /** The switches may have changed: answers still streaming are cut when either is off (serve.ts). */
  switchesChanged(): void
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
/** How long a key request may take: longer than B's slowest issue, so A never drops a key B still makes. */
const ASK_KEY_MS = 300_000
/** How long an acknowledgement or a give-back may take before it counts as unheard. */
const SMALL_TALK_MS = 60_000
/** How often a key still waiting for its acknowledgement is said again. */
const RESUME_MS = 5 * 60_000
/** How long the gate's answer is kept for forwarded requests: Seatbelt's check scans every process (lsof). */
const GATE_OPEN_MS = 30_000
/** A shut answer is asked again sooner: the owner restarting a served session should not wait long. */
const GATE_SHUT_MS = 5_000

const myName = (): string => os.hostname().replace(/\.local$/i, '') || 'this computer'

export function createMagpieRemote(deps: MagpieRemoteDeps): MagpieRemote {
  const boundKeys = createBoundKeys(fileStorage(path.join(deps.base, BOUND_KEYS_FILE)))
  const remotes = createRemotesStore(path.join(deps.base, REMOTES_FILE), deps.sealer)
  const providers = magpieProviders(() => deps.magpieBin(), () => deps.env())
  // A key request waits behind B's Magpie CLI: about six calls of up to 20 s each, plus its queue.
  const askKey = askKeyOver((peer, kind, fields) => deps.openStream(peer, kind, fields), { deadlineMs: ASK_KEY_MS })
  // Small answers: a minute each, so a silent peer never holds the connect lane for long.
  const ackKey = ackKeyOver((peer, kind, fields) => deps.openStream(peer, kind, fields), { deadlineMs: SMALL_TALK_MS })
  const lane = perComputer()
  const returnKey = returnKeyOver((peer, kind, fields) => deps.openStream(peer, kind, fields), { deadlineMs: SMALL_TALK_MS })

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
    // The other computer stored its key and proved it over its own session: B's warning for it is settled.
    acknowledge: async (id) => {
      const keys = deps.shareKeys()
      return keys === null ? { ok: false, why: 'Magpie is not installed here.' } : keys.acknowledge(id)
    },
    dial: (port) => loopbackDialer(port),
    name: myName,
    log: (line) => deps.log(line)
  })

  /** The gate's answer for forwarded requests, kept a while (one ask in flight is shared): a check per request is slow. */
  let gateSeen: { at: number; ok: Promise<boolean>; answer: boolean | null } | null = null
  const gateNow = (): Promise<boolean> => {
    const now = Date.now()
    const keep = gateSeen?.answer === true ? GATE_OPEN_MS : GATE_SHUT_MS
    // Still asking (answer null), or asked recently enough: the same answer. A clock moved back asks again.
    if (gateSeen !== null && now >= gateSeen.at && (gateSeen.answer === null || now - gateSeen.at <= keep)) return gateSeen.ok
    const asked: { at: number; ok: Promise<boolean>; answer: boolean | null } = { at: now, ok: Promise.resolve(false), answer: null }
    asked.ok = deps.seatGate().then((ok) => ok === true, () => false).then((ok) => {
      asked.answer = ok
      return ok
    })
    gateSeen = asked
    return asked.ok
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
  /**
   * Hold the forwarder's port, whatever the gate says: an unheld port could be taken by whatever
   * Magpie's providers would then send prompts to. While the gate is shut every request is refused
   * (open() above), so holding the port lets nothing through.
   */
  const ensureForwarder = async (): Promise<boolean> => {
    if (forwarder.port() !== null) return true
    try {
      await forwarder.listen(forwardPort)
      return true
    } catch (error) {
      deps.log(`magpie remote: the forwarder could not take 127.0.0.1:${forwardPort}: ${error instanceof Error ? error.message : 'unknown'}`)
      return false
    }
  }

  /**
   * Keys kept but never acknowledged (a crash, a broken stream) are said again: one computer per turn of
   * the connect lane, so an owner's Connect or Disconnect waits behind one computer at most (review M2).
   */
  let resumeTimer: ReturnType<typeof setInterval> | null = null
  let stopped = false
  /** One pass at a time: a pass longer than the timer's beat must not start a second one behind it. */
  let resuming: Promise<void> | null = null
  const resume = (): Promise<void> => {
    if (resuming !== null) return resuming
    const pass = (async () => {
      for (const peer of unackedPeers(remotes)) {
        if (stopped) return
        await lane('connect', () => resumeRemotes(connectDeps, peer)).catch(() => undefined)
      }
    })().finally(() => {
      resuming = null
    })
    resuming = pass
    return pass
  }
  const connectDeps: ConnectDeps = {
    switches: () => deps.switches(),
    store: remotes,
    askKey,
    ackKey,
    returnKey,
    addProvider: (id, url) => providers.add(id, url),
    setProvider: (id, url) => providers.set(id, url),
    removeProvider: (id) => providers.remove(id),
    providers: () => providers.entries(),
    forwarderPort: () => forwarder.port(),
    seatGate: () => deps.seatGate(),
    myName
  }

  return {
    serve,
    unbind: (id) => serve.unbind(id),
    switchesChanged: () => serve.switchesChanged(),
    boundKeys,
    // One port, always the same: Magpie's providers name it, so taking another would send them elsewhere.
    start: async () => {
      stopped = false
      await ensureForwarder()
      await resume()
      // Still waiting (the other computer offline, the relay down): said again every few minutes, until heard.
      if (resumeTimer === null && !stopped) {
        resumeTimer = setInterval(() => {
          if (unackedPeers(remotes).length > 0) void resume()
        }, RESUME_MS)
        resumeTimer.unref?.()
      }
    },
    stop: () => {
      stopped = true
      if (resumeTimer !== null) clearInterval(resumeTimer)
      resumeTimer = null
      return forwarder.close()
    },
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
            // Kept but not yet acknowledged: it carries nothing, so it is not shown as connected (Connect says it again).
            return { id: d.id, name: d.name, online: d.online, providerId: c === undefined || c.acked === false ? null : c.providerId, os: d.os, arch: d.arch }
          }),
        desktopsKnown: desktops !== null
      }
    },
    // One lane for every computer: two computers of one name must not both take one provider id.
    connect: (peer, name) =>
      lane('connect', async () => {
        // A gate that failed at start may pass now: the forwarder is opened here then, not reported as taken.
        await ensureForwarder()
        return connectRemote(peer, name, connectDeps)
      }),
    disconnect: (peer) => lane('connect', () => disconnectRemote(peer, { store: remotes, returnKey, removeProvider: (id) => providers.remove(id) }))
  }
}
