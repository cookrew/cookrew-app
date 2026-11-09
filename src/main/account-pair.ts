import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'
import type { AccountFile } from './account-v2'
import { ADMITTED_MAX, type AdmittedDeviceStore } from './admitted-devices'
import { machineCopy } from '../shared/machine-words'
import {
  ACCOUNT_PAIR_CHALLENGE_MS,
  ACCOUNT_PAIR_INFO,
  ACCOUNT_PAIR_PASSWORD_MAX,
  ACCOUNT_PAIR_REST_MS,
  ACCOUNT_PAIR_STOP_AFTER,
  ACCOUNT_PAIR_STOP_MS,
  ACCOUNT_PAIR_TRIES,
  pairTranscript,
  type PairAnswer,
  type PairChallenge,
  type PairMethod,
  type PairOffer,
  type PasskeyAssertionWire
} from '../shared/account-pair'
import { generateSealKeyPair, openBody, type SealKeyPair } from '../shared/relay-seal'
import {
  deviceOnAccount,
  deviceSignatureValid,
  passkeyMatches,
  passwordMatches,
  type PairAnchors
} from './pair-anchors'

/**
 * THE MACHINE'S SIDE OF ENTERING WITH THE ACCOUNT (shared/account-pair.ts).
 *
 * begin  — a device of the account asks; it gets a one-use challenge and a
 *          one-use seal key, bound to its device id.
 * finish — it brings its key's signature over the transcript and ONE secret:
 *          the password sealed to that key, or a passkey's assertion over the
 *          transcript's hash. Checked here; on success the device is admitted
 *          (admitted-devices.ts) with a token of its own.
 *
 * WHAT IS COUNTED: a secret that was checked and was wrong. A malformed body,
 * a spent challenge or a device signature that does not open asked nothing
 * secret, so it spends no try — and it admits nothing either.
 *
 * NOTHING SECRET IS WRITTEN DOWN. The password lives for one scrypt; refusals
 * never repeat what was sent; log lines name the device and the method.
 */

export interface PairMisses {
  read(): { count: number; until: number }
  write(next: { count: number; until: number }): void
}

export interface PairDoorDeps {
  readonly account: () => AccountFile | null
  /** Fresh from the registry when it answers (pair-anchors.ts · createAnchorSource). */
  readonly anchors: () => Promise<PairAnchors | null>
  readonly admitted: AdmittedDeviceStore
  /** Origins a passkey's clientDataJSON may name: the registry's and this machine's own. */
  readonly origins: () => readonly string[]
  readonly platform: string
  /** The running count of wrong secrets in a row: a restart must not forgive them. */
  readonly misses?: PairMisses
  readonly now?: () => number
  readonly log?: (line: string) => void
}

export type PairReply<T> = { readonly status: number; readonly body: T }

export interface AccountPairDoor {
  offer(): Promise<PairOffer>
  begin(input: { body: unknown; bridged: { deviceId: string } | null }): Promise<PairReply<PairChallenge | PairAnswer>>
  finish(input: { body: unknown; bridged: { deviceId: string } | null }): Promise<PairReply<PairAnswer>>
}

interface Held {
  readonly deviceId: string
  readonly nonce: string
  readonly keys: SealKeyPair
  readonly until: number
  readonly anchors: PairAnchors
  readonly passkeyChallenge: string
}

/** Outstanding challenges a door holds at once: far above people, far below a loop. */
const HELD_MAX = 32
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Refusal = Extract<PairAnswer, { ok: false }>
const refuse = (status: number, outcome: Refusal['outcome'], error: string, extra: Partial<Refusal> = {}): PairReply<PairAnswer> => ({
  status,
  body: { ok: false, outcome, error, ...extra }
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const methodsOf = (anchors: PairAnchors): PairMethod[] => [
  ...(anchors.password !== null ? (['password'] as const) : []),
  ...(anchors.passkeys.length > 0 ? (['passkey'] as const) : [])
]

const sha256b64u = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64url')

/** The sealed password, if it opens with this challenge's key and names this challenge. */
const openPassword = (held: Held, challengeId: string, sealed: unknown): string | null => {
  if (typeof sealed !== 'string' || sealed.length > 4096) return null
  const opened = openBody(held.keys.privateKey, ACCOUNT_PAIR_INFO, sealed)
  if (opened === null) return null
  try {
    const raw = JSON.parse(opened) as { c?: unknown; p?: unknown } | null
    if (raw?.c !== challengeId || typeof raw.p !== 'string') return null
    return raw.p.length > 0 && raw.p.length <= ACCOUNT_PAIR_PASSWORD_MAX ? raw.p : null
  } catch {
    return null
  }
}

const readCredential = (value: unknown): PasskeyAssertionWire | null => {
  if (!isRecord(value)) return null
  const { id, clientDataJSON, authenticatorData, signature } = value
  if (typeof id !== 'string' || typeof clientDataJSON !== 'string') return null
  if (typeof authenticatorData !== 'string' || typeof signature !== 'string') return null
  return { id, clientDataJSON, authenticatorData, signature }
}

/** Passkey refusals that are a wrong answer, not a wrong shape: these count. */
const PASSKEY_WRONG = new Set(['not_this_account', 'bad_signature', 'not_verified', 'not_present', 'clone_warning'])

interface Finishing {
  readonly challengeId: string
  readonly deviceId: string
  readonly jwk: Record<string, unknown>
  readonly name?: string
  readonly sig: string
  readonly proof: Record<string, unknown>
}

const readFinish = (body: unknown): Finishing | null => {
  if (!isRecord(body) || !isRecord(body.device) || !isRecord(body.proof)) return null
  const { challengeId, sig } = body
  const { deviceId, jwk, name } = body.device
  if (typeof challengeId !== 'string' || typeof sig !== 'string' || typeof deviceId !== 'string') return null
  if (!UUID.test(deviceId) || !isRecord(jwk)) return null
  return {
    challengeId,
    deviceId,
    jwk,
    ...(typeof name === 'string' ? { name: name.slice(0, 64) } : {}),
    sig,
    proof: body.proof
  }
}

export function createAccountPairDoor(deps: PairDoorDeps): AccountPairDoor {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const held = new Map<string, Held>()
  const devices = new Map<string, { wrong: number; until: number }>()
  const word = (sentence: string): string => machineCopy(sentence, deps.platform)

  const readMisses = (): { count: number; until: number } => {
    try {
      const got = deps.misses?.read() ?? { count: 0, until: 0 }
      return {
        count: Number.isInteger(got.count) && got.count > 0 ? got.count : 0,
        until: Number.isFinite(got.until) && got.until > 0 ? got.until : 0
      }
    } catch {
      return { count: 0, until: 0 }
    }
  }
  let door = readMisses()
  const keepMisses = (): void => {
    try {
      deps.misses?.write(door)
    } catch {
      // Held in memory for this run.
    }
  }

  /** How long this device (or the whole door) must wait, or 0. */
  const restFor = (deviceId: string): number => {
    const at = now()
    const mine = devices.get(deviceId)?.until ?? 0
    return Math.max(0, mine - at, door.until - at)
  }

  const resting = (ms: number): PairReply<PairAnswer> =>
    refuse(429, 'resting', `Too many wrong tries. Try again in ${Math.max(1, Math.ceil(ms / 1000))} s.`, { retryAfterMs: ms })

  const missed = (deviceId: string, method: PairMethod): PairReply<PairAnswer> => {
    const at = now()
    const mine = devices.get(deviceId) ?? { wrong: 0, until: 0 }
    const wrong = mine.wrong + 1
    const restNow = wrong >= ACCOUNT_PAIR_TRIES
    devices.set(deviceId, restNow ? { wrong: 0, until: at + ACCOUNT_PAIR_REST_MS } : { wrong, until: 0 })
    const count = door.count + 1
    door = { count, until: count >= ACCOUNT_PAIR_STOP_AFTER ? at + ACCOUNT_PAIR_STOP_MS : door.until }
    keepMisses()
    log(`account pair: a wrong ${method} for device ${deviceId.slice(0, 8)} (${count} in a row)`)
    if (door.until > at) return resting(door.until - at)
    if (restNow) return resting(ACCOUNT_PAIR_REST_MS)
    const what = method === 'password' ? 'That is not the account password.' : 'That passkey did not answer for this account.'
    return refuse(401, 'wrong', what, { triesLeft: ACCOUNT_PAIR_TRIES - wrong })
  }

  const admit = (finishing: Finishing, method: PairMethod, account: AccountFile): PairReply<PairAnswer> => {
    devices.delete(finishing.deviceId)
    door = { count: 0, until: 0 }
    keepMisses()
    if (!deps.admitted.has(finishing.deviceId) && deps.admitted.list().length >= ADMITTED_MAX) {
      return refuse(403, 'refused', word(`This Mac is open for ${ADMITTED_MAX} devices already. Forget one in Devices to make room.`))
    }
    let minted: ReturnType<AdmittedDeviceStore['admit']>
    try {
      minted = deps.admitted.admit({ deviceId: finishing.deviceId, ...(finishing.name ? { name: finishing.name } : {}), via: method })
    } catch {
      return refuse(503, 'unavailable', word('This Mac could not record the device. Try again.'))
    }
    log(`account pair: admitted ${minted.device.name ?? finishing.deviceId.slice(0, 8)} by ${method}`)
    return {
      status: 200,
      body: {
        ok: true,
        outcome: 'admitted',
        deviceId: minted.device.deviceId,
        desktopId: account.deviceId,
        token: minted.token,
        ...(minted.device.name ? { name: minted.device.name } : {})
      }
    }
  }

  /** The one secret, checked. Null means it was right; otherwise the reply. */
  const checkSecret = async (h: Held, finishing: Finishing, challengeId: string): Promise<PairReply<PairAnswer> | PairMethod> => {
    const { proof } = finishing
    if (proof.kind === 'password') {
      if (h.anchors.password === null) return refuse(409, 'unavailable', 'This account has no password yet.')
      const password = openPassword(h, challengeId, proof.sealed)
      if (password === null) return refuse(401, 'refused', 'That request could not be read. Start again.')
      return (await passwordMatches(h.anchors.password, password)) ? 'password' : missed(finishing.deviceId, 'password')
    }
    if (proof.kind === 'passkey') {
      const credential = readCredential(proof.credential)
      if (credential === null) return refuse(400, 'refused', 'That passkey answer could not be read.')
      const checked = passkeyMatches(h.anchors, credential, { challenge: h.passkeyChallenge, origins: deps.origins() })
      if (checked.ok) return 'passkey'
      return PASSKEY_WRONG.has(checked.reason)
        ? missed(finishing.deviceId, 'passkey')
        : refuse(401, 'refused', 'That passkey answer was not for this request. Start again.')
    }
    return refuse(400, 'refused', 'Bring the account password or a passkey.')
  }

  return {
    async offer() {
      const account = deps.account()
      const platform = deps.platform
      if (account === null) return { offered: false, desktopId: null, platform, methods: [] }
      const anchors = await deps.anchors()
      const methods = anchors === null ? [] : methodsOf(anchors)
      return { offered: methods.length > 0, desktopId: account.deviceId, platform, methods }
    },

    async begin({ body, bridged }) {
      const account = deps.account()
      if (account === null) return refuse(404, 'unavailable', 'There is no account on this desktop.')
      const deviceId = isRecord(body) && typeof body.deviceId === 'string' ? body.deviceId.toLowerCase() : ''
      if (!UUID.test(deviceId)) return refuse(400, 'refused', 'deviceId must be a device id.')
      if (bridged !== null && bridged.deviceId !== deviceId) {
        return refuse(401, 'refused', 'cookrew.dev signed in a different device than the one asking.')
      }
      const rest = restFor(deviceId)
      if (rest > 0) return resting(rest)
      const anchors = await deps.anchors()
      if (anchors === null) return refuse(503, 'unavailable', word('This Mac cannot reach cookrew.dev to read the account just now.'))
      if (!anchors.devices.some((device) => device.id === deviceId)) {
        return refuse(403, 'refused', 'This browser is not signed in to the account this machine is on.')
      }
      const methods = methodsOf(anchors)
      if (methods.length === 0) return refuse(409, 'unavailable', 'This account has no password or passkey yet.')
      const at = now()
      for (const [id, one] of held) if (one.until < at) held.delete(id)
      if (held.size >= HELD_MAX) return refuse(429, 'resting', 'Too many requests are open. Try again in a minute.', { retryAfterMs: ACCOUNT_PAIR_CHALLENGE_MS })
      const challengeId = randomUUID()
      const nonce = randomBytes(32).toString('base64url')
      const passkeyChallenge = sha256b64u(pairTranscript({ desktopId: account.deviceId, challengeId, nonce, deviceId }))
      const keys = generateSealKeyPair()
      const until = at + ACCOUNT_PAIR_CHALLENGE_MS
      held.set(challengeId, { deviceId, nonce, keys, until, anchors, passkeyChallenge })
      return {
        status: 200,
        body: {
          challengeId,
          nonce,
          desktopId: account.deviceId,
          key: keys.publicKey,
          expiresAt: until,
          methods,
          passkey:
            anchors.passkeys.length === 0
              ? null
              : { rpId: anchors.rpId, challenge: passkeyChallenge, allow: anchors.passkeys.map((p) => p.credentialId) }
        }
      }
    },

    async finish({ body, bridged }) {
      const account = deps.account()
      if (account === null) return refuse(404, 'unavailable', 'There is no account on this desktop.')
      const finishing = readFinish(body)
      if (finishing === null) return refuse(400, 'refused', 'That request could not be read.')
      // Spent whatever happens next: each challenge answers one message.
      const h = held.get(finishing.challengeId)
      held.delete(finishing.challengeId)
      if (h === undefined || now() > h.until || h.deviceId !== finishing.deviceId) {
        return refuse(401, 'refused', 'That request has expired or was not for this device. Start again.')
      }
      if (bridged !== null && bridged.deviceId !== finishing.deviceId) {
        return refuse(401, 'refused', 'cookrew.dev signed in a different device than the one asking.')
      }
      const rest = restFor(finishing.deviceId)
      if (rest > 0) return resting(rest)
      if (!deviceOnAccount(h.anchors, finishing.deviceId, finishing.jwk)) {
        return refuse(403, 'refused', 'This key is not the account’s key for this device.')
      }
      const transcript = pairTranscript({ desktopId: account.deviceId, challengeId: finishing.challengeId, nonce: h.nonce, deviceId: finishing.deviceId })
      if (!deviceSignatureValid(finishing.jwk as Record<string, string>, transcript, finishing.sig)) {
        return refuse(401, 'refused', 'This device’s signature did not open. Start again.')
      }
      const checked = await checkSecret(h, finishing, finishing.challengeId)
      if (typeof checked !== 'string') return checked
      return admit(finishing, checked, account)
    }
  }
}

/** The running count of wrong secrets, kept across restarts. A plain 0600 file. */
export function pairMissesFile(file: string): PairMisses {
  return {
    read: () => {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { count?: unknown; until?: unknown } | null
      return { count: Number(raw?.count ?? 0), until: Number(raw?.until ?? 0) }
    },
    write: (next) => {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      writeFileAtomic(file, JSON.stringify(next))
      chmodSync(file, 0o600)
    }
  }
}
