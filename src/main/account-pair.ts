import { randomBytes, randomUUID } from 'node:crypto'
import type { AccountFile } from './account-v2'
import { ADMITTED_MAX, type AdmittedDeviceStore } from './admitted-devices'
import { deviceSignatureValid } from './device-signature'
import type { V2Grant } from './v2-call-token'
import { machineCopy } from '../shared/machine-words'
import { FixedWindowLimiter } from '../shared/fixed-window-limiter'
import { jwkThumbprint } from '../shared/jwk-thumbprint'
import {
  ACCOUNT_PAIR_CHALLENGE_MS,
  pairTranscript,
  type PairAnswer,
  type PairChallenge,
  type PairOffer
} from '../shared/account-pair'

/**
 * THE MACHINE'S SIDE OF ENTERING WITH THE ACCOUNT (shared/account-pair.ts).
 *
 * begin  — a device brings its grant from cookrew.dev and its key; the grant
 *          is checked offline (signature, twelve hours, not revoked, this
 *          account, this device, THIS key) before anything is handed out, and
 *          the device gets a one-use challenge for that key.
 * finish — the device signs the transcript with that key. The grant is checked
 *          again (it may have been revoked meanwhile) and the device is
 *          admitted with a token of its own until the grant runs out.
 *
 * NOTHING HERE IS A SECRET TO GUESS: the password or passkey was checked by
 * cookrew.dev, which rate-limits it. What a machine can be sent is a grant
 * that does not verify (refused at once) or a signature that does not open
 * (refused, the challenge spent).
 */

export interface PairDoorDeps {
  readonly account: () => AccountFile | null
  /** Offline grant check against /v2/keys (v2-call-token.ts · verifier.grant). */
  readonly grants: (token: string) => Promise<V2Grant | null>
  readonly admitted: AdmittedDeviceStore
  readonly platform: string
  /**
   * A watch's pass is turned into a watch's token here (watch-pairing.ts), never
   * into a device's: a watch reaches agents and pages, not a shell. Absent, a
   * watch's pass is refused.
   */
  readonly watch?: { readonly enter: (deviceId: string) => string }
  readonly now?: () => number
  readonly log?: (line: string) => void
}

export type PairReply<T> = { readonly status: number; readonly body: T }

export interface AccountPairDoor {
  offer(): PairOffer
  begin(input: { body: unknown; bridged: { deviceId: string } | null }): Promise<PairReply<PairChallenge | PairAnswer>>
  finish(input: { body: unknown; bridged: { deviceId: string } | null }): Promise<PairReply<PairAnswer>>
}

interface Held {
  readonly challengeId: string
  readonly nonce: string
  readonly until: number
}

/** Begins one device may make in a minute: far above a person, far below a loop. */
const BEGINS_PER_MINUTE = 6
const HELD_MAX = 256
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Refusal = Extract<PairAnswer, { ok: false }>
const refuse = (status: number, outcome: Refusal['outcome'], error: string, extra: Partial<Refusal> = {}): PairReply<PairAnswer> => ({
  status,
  body: { ok: false, outcome, error, ...extra }
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface Asking {
  readonly deviceId: string
  readonly jwk: Record<string, unknown>
  readonly jkt: string
  readonly grant: string
  readonly name?: string
}

/** Device id, key and grant from a body; the key is named by its thumbprint. */
const readAsking = (body: unknown): Asking | null => {
  if (!isRecord(body)) return null
  const device = isRecord(body.device) ? body.device : body
  const deviceId = typeof device.deviceId === 'string' ? device.deviceId.toLowerCase() : ''
  const jwk = isRecord(device.jwk) ? device.jwk : null
  const jkt = jwk === null ? null : jwkThumbprint(jwk)
  if (!UUID.test(deviceId) || jwk === null || jkt === null || typeof body.grant !== 'string') return null
  return { deviceId, jwk, jkt, grant: body.grant, ...(typeof device.name === 'string' ? { name: device.name.slice(0, 64) } : {}) }
}

export function createAccountPairDoor(deps: PairDoorDeps): AccountPairDoor {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const begins = new FixedWindowLimiter(BEGINS_PER_MINUTE, 60_000, now)
  /** Keyed by device id AND key: a challenge is reachable only by the key it was issued to. */
  const held = new Map<string, Held>()
  const word = (sentence: string): string => machineCopy(sentence, deps.platform)
  const slot = (asking: Asking): string => `${asking.deviceId}|${asking.jkt}`

  /** The grant holds for this account, this device and this key — or the reply that says why not. */
  const granted = async (asking: Asking, account: AccountFile, bridged: { deviceId: string } | null): Promise<V2Grant | PairReply<PairAnswer>> => {
    if (bridged !== null && bridged.deviceId !== asking.deviceId) {
      return refuse(401, 'refused', 'cookrew.dev signed in a different device than the one asking.')
    }
    const grant = await deps.grants(asking.grant)
    if (grant === null) return refuse(401, 'regrant', 'That pass from cookrew.dev is no longer good. Prove it is you again.')
    if (grant.username !== account.username) return refuse(403, 'refused', word('This Mac is on another account.'))
    if (grant.dev !== asking.deviceId || grant.jkt !== asking.jkt) {
      return refuse(401, 'regrant', 'That pass was issued to another device. Prove it is you again.')
    }
    return grant
  }

  const admit = (asking: Asking, grant: V2Grant, account: AccountFile): PairReply<PairAnswer> => {
    const live = deps.admitted.live()
    if (!live.some((d) => d.deviceId === asking.deviceId) && live.length >= ADMITTED_MAX) {
      return refuse(403, 'refused', word(`This Mac is open for ${ADMITTED_MAX} devices already. Forget one in Devices to make room.`))
    }
    let minted: ReturnType<AdmittedDeviceStore['admit']>
    try {
      minted = deps.admitted.admit({
        deviceId: asking.deviceId,
        ...(asking.name ? { name: asking.name } : {}),
        via: 'account',
        until: grant.exp
      })
    } catch {
      return refuse(503, 'unavailable', word('This Mac could not record the device. Try again.'))
    }
    log(`account pair: admitted ${minted.device.name ?? asking.deviceId.slice(0, 8)} with an account pass`)
    const body: PairAnswer = {
      ok: true,
      outcome: 'admitted',
      deviceId: minted.device.deviceId,
      desktopId: account.deviceId,
      token: minted.token,
      until: grant.exp,
      ...(minted.device.name ? { name: minted.device.name } : {})
    }
    return { status: 200, body }
  }

  /** A watch, by its pass: the machine's watch token, until the watch is forgotten here. */
  const enterWatch = (asking: Asking, account: AccountFile): PairReply<PairAnswer> => {
    if (deps.watch === undefined) return refuse(403, 'refused', word('This Mac does not take a watch at this door.'))
    let token: string
    try {
      token = deps.watch.enter(asking.deviceId)
    } catch {
      return refuse(503, 'unavailable', word('This Mac could not record the watch. Try again.'))
    }
    log(`account pair: a watch entered with its pass (${asking.deviceId.slice(0, 8)})`)
    const body: PairAnswer = { ok: true, outcome: 'admitted', deviceId: asking.deviceId, desktopId: account.deviceId, token, until: 0, scope: 'watch' }
    return { status: 200, body }
  }

  return {
    offer() {
      const account = deps.account()
      return { offered: account !== null, desktopId: account?.deviceId ?? null, platform: deps.platform }
    },

    async begin({ body, bridged }) {
      const account = deps.account()
      if (account === null) return refuse(404, 'unavailable', 'There is no account on this desktop.')
      const asking = readAsking(body)
      if (asking === null || asking.deviceId === account.deviceId) return refuse(400, 'refused', 'That request could not be read.')
      const grant = await granted(asking, account, bridged)
      if (!('jkt' in grant)) return grant
      // Counted only for a device holding a good grant: a stranger fills nothing.
      if (!begins.take(asking.deviceId)) return refuse(429, 'resting', 'Too many requests from this device. Try again in a minute.', { retryAfterMs: 60_000 })
      const at = now()
      for (const [key, one] of held) if (one.until < at) held.delete(key)
      if (held.size >= HELD_MAX) return refuse(429, 'resting', 'Too many entries are open. Try again in a minute.', { retryAfterMs: 60_000 })
      const challenge = { challengeId: randomUUID(), nonce: randomBytes(32).toString('base64url'), until: at + ACCOUNT_PAIR_CHALLENGE_MS }
      held.set(slot(asking), challenge)
      return {
        status: 200,
        body: { challengeId: challenge.challengeId, nonce: challenge.nonce, desktopId: account.deviceId, expiresAt: challenge.until }
      }
    },

    async finish({ body, bridged }) {
      const account = deps.account()
      if (account === null) return refuse(404, 'unavailable', 'There is no account on this desktop.')
      const asking = readAsking(body)
      const challengeId = isRecord(body) && typeof body.challengeId === 'string' ? body.challengeId : ''
      const sig = isRecord(body) && typeof body.sig === 'string' ? body.sig : ''
      if (asking === null) return refuse(400, 'refused', 'That request could not be read.')
      // Spent only by a request naming it from the key it was issued to.
      const h = held.get(slot(asking))
      if (h === undefined || h.challengeId !== challengeId || now() > h.until) {
        return refuse(401, 'refused', 'That request has expired or was not for this device. Start again.')
      }
      held.delete(slot(asking))
      const grant = await granted(asking, account, bridged)
      if (!('jkt' in grant)) return grant
      const transcript = pairTranscript({ desktopId: account.deviceId, challengeId, nonce: h.nonce, deviceId: asking.deviceId })
      if (!deviceSignatureValid(asking.jwk, transcript, sig)) {
        return refuse(401, 'refused', 'This device’s signature did not open. Start again.')
      }
      if (grant.watch === true) return enterWatch(asking, account)
      return admit(asking, grant, account)
    }
  }
}
