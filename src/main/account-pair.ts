import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { matchesUnlockAsync, type AccountFile, type UnlockVerifier } from './account-v2'
import { ADMITTED_MAX, type AdmittedDeviceStore } from './admitted-devices'
import { createPairGuard, type PairMisses } from './account-pair-guard'
import { pinChanges, pinsFrom, trustedPasskeys, type PinStore } from './account-pair-pins'
import { machineCopy } from '../shared/machine-words'
import { FixedWindowLimiter } from '../shared/fixed-window-limiter'
import {
  ACCOUNT_PAIR_CHALLENGE_MS,
  ACCOUNT_PAIR_INFO,
  ACCOUNT_PAIR_PASSWORD_MAX,
  ANCHORS_SKEW_MS,
  pairBeginMessage,
  pairDeviceMessage,
  pairProofDigestInput,
  pairTranscript,
  type PairAnswer,
  type PairChallenge,
  type PairMethod,
  type PairOffer,
  type PairProof,
  type PasskeyAssertionWire
} from '../shared/account-pair'
import { generateSealKeyPair, openBody, type SealKeyPair } from '../shared/relay-seal'
import { deviceOnAccount, deviceSignatureValid, passkeyMatches, type PairAnchors } from './pair-anchors'

export { pairMissesFile } from './account-pair-guard'
export type { PairMisses } from './account-pair-guard'

/**
 * THE MACHINE'S SIDE OF ENTERING WITH THE ACCOUNT (shared/account-pair.ts).
 *
 * begin  — a device of the account asks, signing with its key; it gets a
 *          one-use challenge and a one-use seal key, bound to its device id.
 *          One open challenge per device: a new begin replaces the old one,
 *          and only the device itself can sign a begin.
 * finish — it brings its key's signature over the transcript and the proof,
 *          and ONE secret: the password sealed to that key, checked against
 *          THIS machine's own verifier; or a passkey's assertion over the
 *          transcript's hash, checked against the passkeys this machine pinned.
 *          On success the device is admitted with a token of its own.
 *
 * ONE SECRET CHECK AT A TIME, door-wide. A check takes a scrypt's worth of
 * time; were several allowed at once, each would pass the rest test before any
 * was counted, and a burst of guesses would all be tried (review, 11-09).
 *
 * NOTHING SECRET IS WRITTEN DOWN. The password lives for one scrypt; refusals
 * never repeat what was sent; log lines name the device and the method.
 */

export interface PairDoorDeps {
  readonly account: () => AccountFile | null
  /** The account's passkeys and device keys (pair-anchors.ts · createAnchorSource). */
  readonly anchors: (options?: { fresh?: boolean }) => Promise<PairAnchors | null>
  /**
   * This machine's own verifier of the ACCOUNT password, or null when it holds
   * none (a passcode machine, or one that joined by code or a provider).
   */
  readonly localPassword: () => UnlockVerifier | null
  /** The passkeys pinned on first use (account-pair-pins.ts). */
  readonly pins: PinStore
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
  /** `cookrew mobile --repin`: somebody at the machine trusts the account's passkeys as they are now. */
  repin(): Promise<{ added: string[]; removed: string[] } | null>
}

interface Held {
  readonly challengeId: string
  readonly deviceId: string
  readonly nonce: string
  readonly keys: SealKeyPair
  readonly until: number
  readonly anchors: PairAnchors
  readonly passkeyChallenge: string
}

interface Finishing {
  readonly challengeId: string
  readonly deviceId: string
  readonly jwk: Record<string, unknown>
  readonly name?: string
  readonly sig: string
  readonly proof: PairProof
}

/** Begins one device may make in a minute: far above a person, far below a loop. */
const BEGINS_PER_MINUTE = 6
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Passkey refusals that are a wrong answer, not a wrong shape: these count. */
const PASSKEY_WRONG = new Set(['not_this_account', 'bad_signature', 'not_verified', 'not_present', 'clone_warning'])

type Refusal = Extract<PairAnswer, { ok: false }>
const refuse = (status: number, outcome: Refusal['outcome'], error: string, extra: Partial<Refusal> = {}): PairReply<PairAnswer> => ({
  status,
  body: { ok: false, outcome, error, ...extra }
})
const resting = (ms: number): PairReply<PairAnswer> =>
  refuse(429, 'resting', `Too many wrong tries. Try again in ${Math.max(1, Math.ceil(ms / 1000))} s.`, { retryAfterMs: ms })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const sha256b64u = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64url')

const readCredential = (value: unknown): PasskeyAssertionWire | null => {
  if (!isRecord(value)) return null
  const { id, clientDataJSON, authenticatorData, signature } = value
  if (typeof id !== 'string' || typeof clientDataJSON !== 'string') return null
  if (typeof authenticatorData !== 'string' || typeof signature !== 'string') return null
  return { id, clientDataJSON, authenticatorData, signature }
}

const readProof = (value: unknown): PairProof | null => {
  if (!isRecord(value)) return null
  if (value.kind === 'password' && typeof value.sealed === 'string' && value.sealed.length <= 4096) {
    return { kind: 'password', sealed: value.sealed }
  }
  const credential = value.kind === 'passkey' ? readCredential(value.credential) : null
  return credential === null ? null : { kind: 'passkey', credential }
}

const readFinish = (body: unknown): Finishing | null => {
  if (!isRecord(body) || !isRecord(body.device)) return null
  const { challengeId, sig } = body
  const { jwk, name } = body.device
  const deviceId = typeof body.device.deviceId === 'string' ? body.device.deviceId.toLowerCase() : ''
  const proof = readProof(body.proof)
  if (typeof challengeId !== 'string' || typeof sig !== 'string' || !UUID.test(deviceId) || !isRecord(jwk) || proof === null) return null
  return { challengeId, deviceId, jwk, ...(typeof name === 'string' ? { name: name.slice(0, 64) } : {}), sig, proof }
}

/** The sealed password, if it opens with this challenge's key and names this challenge. */
const openPassword = (held: Held, sealed: string): string | null => {
  const opened = openBody(held.keys.privateKey, ACCOUNT_PAIR_INFO, sealed)
  if (opened === null) return null
  try {
    const raw = JSON.parse(opened) as { c?: unknown; p?: unknown } | null
    if (raw?.c !== held.challengeId || typeof raw.p !== 'string') return null
    return raw.p.length > 0 && raw.p.length <= ACCOUNT_PAIR_PASSWORD_MAX ? raw.p : null
  } catch {
    return null
  }
}

export function createAccountPairDoor(deps: PairDoorDeps): AccountPairDoor {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const guard = createPairGuard(deps.misses)
  const begins = new FixedWindowLimiter(BEGINS_PER_MINUTE, 60_000, now)
  /** Keyed by device: one open challenge each, so the map is bounded by the account. */
  const held = new Map<string, Held>()
  let checking = false
  const word = (sentence: string): string => machineCopy(sentence, deps.platform)

  /** The account's anchors with the passkeys narrowed to those this machine pinned. */
  const trusted = async (options?: { fresh?: boolean }): Promise<PairAnchors | null> => {
    const anchors = await deps.anchors(options)
    if (anchors === null) return null
    const pins = deps.pins.read()
    if (pins === null || pins.username !== anchors.username) deps.pins.write(pinsFrom(anchors, now()))
    return { ...anchors, passkeys: trustedPasskeys(deps.pins.read(), anchors) }
  }

  const methodsOf = (anchors: PairAnchors): PairMethod[] => [
    ...(deps.localPassword() !== null ? (['password'] as const) : []),
    ...(anchors.passkeys.length > 0 ? (['passkey'] as const) : [])
  ]

  const admit = (finishing: Finishing, method: PairMethod, account: AccountFile): PairReply<PairAnswer> => {
    guard.cleared(finishing.deviceId)
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
    const body: PairAnswer = {
      ok: true,
      outcome: 'admitted',
      deviceId: minted.device.deviceId,
      desktopId: account.deviceId,
      token: minted.token,
      ...(minted.device.name ? { name: minted.device.name } : {})
    }
    return { status: 200, body }
  }

  const wrongAnswer = (deviceId: string, method: PairMethod): PairReply<PairAnswer> => {
    const outcome = guard.missed(deviceId, now())
    log(`account pair: a wrong ${method} for device ${deviceId.slice(0, 8)} (${guard.inARow()} in a row)`)
    if (outcome.kind === 'resting') return resting(outcome.forMs)
    const what = method === 'password' ? 'That is not the account password.' : 'That passkey did not answer for this account.'
    return refuse(401, 'wrong', what, { triesLeft: outcome.triesLeft })
  }

  /** The one secret, checked. A method means it was right; otherwise the reply. */
  const checkSecret = async (h: Held, finishing: Finishing): Promise<PairReply<PairAnswer> | PairMethod> => {
    const { proof } = finishing
    if (proof.kind === 'password') {
      const verifier = deps.localPassword()
      if (verifier === null) return refuse(409, 'unavailable', word('This Mac has no copy of the account password to check against. Use a passkey.'))
      const password = openPassword(h, proof.sealed)
      if (password === null) return refuse(401, 'refused', 'That request could not be read. Start again.')
      return (await matchesUnlockAsync(verifier, password)) ? 'password' : wrongAnswer(finishing.deviceId, 'password')
    }
    const checked = passkeyMatches(h.anchors, proof.credential, { challenge: h.passkeyChallenge, origins: deps.origins() })
    if (checked.ok) return 'passkey'
    return PASSKEY_WRONG.has(checked.reason)
      ? wrongAnswer(finishing.deviceId, 'passkey')
      : refuse(401, 'refused', 'That passkey answer was not for this request. Start again.')
  }

  /** Everything finish asks before a secret is looked at. Null means go on. */
  const precheck = (h: Held | undefined, finishing: Finishing, bridged: { deviceId: string } | null, account: AccountFile): PairReply<PairAnswer> | null => {
    if (h === undefined || h.challengeId !== finishing.challengeId || now() > h.until) {
      return refuse(401, 'refused', 'That request has expired or was not for this device. Start again.')
    }
    if (bridged !== null && bridged.deviceId !== finishing.deviceId) {
      return refuse(401, 'refused', 'cookrew.dev signed in a different device than the one asking.')
    }
    const rest = guard.restFor(finishing.deviceId, now())
    if (rest > 0) return resting(rest)
    if (!deviceOnAccount(h.anchors, finishing.deviceId, finishing.jwk)) {
      return refuse(403, 'refused', 'This key is not the account’s key for this device.')
    }
    const transcript = pairTranscript({ desktopId: account.deviceId, challengeId: h.challengeId, nonce: h.nonce, deviceId: finishing.deviceId })
    const message = pairDeviceMessage(transcript, sha256b64u(pairProofDigestInput(finishing.proof)))
    if (!deviceSignatureValid(finishing.jwk as Record<string, string>, message, finishing.sig)) {
      return refuse(401, 'refused', 'This device’s signature did not open. Start again.')
    }
    return null
  }

  return {
    async offer() {
      const account = deps.account()
      const platform = deps.platform
      if (account === null) return { offered: false, reachable: true, desktopId: null, platform, methods: [] }
      const anchors = await trusted()
      if (anchors === null) return { offered: false, reachable: false, desktopId: account.deviceId, platform, methods: [] }
      const methods = anchors.locked ? [] : methodsOf(anchors)
      return { offered: methods.length > 0, reachable: true, desktopId: account.deviceId, platform, methods }
    },

    async begin({ body, bridged }) {
      const account = deps.account()
      if (account === null) return refuse(404, 'unavailable', 'There is no account on this desktop.')
      const deviceId = isRecord(body) && typeof body.deviceId === 'string' ? body.deviceId.toLowerCase() : ''
      if (!UUID.test(deviceId) || deviceId === account.deviceId) return refuse(400, 'refused', 'deviceId must be the id of the device asking.')
      if (bridged !== null && bridged.deviceId !== deviceId) {
        return refuse(401, 'refused', 'cookrew.dev signed in a different device than the one asking.')
      }
      const rest = guard.restFor(deviceId, now())
      if (rest > 0) return resting(rest)
      const anchors = await trusted()
      if (anchors === null) return refuse(503, 'unavailable', word('This Mac cannot reach cookrew.dev to read the account just now.'))
      if (anchors.locked) return refuse(423, 'unavailable', 'This account is locked down after “Not me”. Change the password at cookrew.dev/me first.')
      const signedBegin = isRecord(body) ? body : {}
      if (!deviceOnAccount(anchors, deviceId, signedBegin.jwk)) {
        return refuse(403, 'refused', 'This browser is not signed in to the account this machine is on.')
      }
      const at = typeof signedBegin.at === 'number' ? signedBegin.at : NaN
      const beginSig = typeof signedBegin.sig === 'string' ? signedBegin.sig : ''
      const fresh = Number.isFinite(at) && Math.abs(now() - at) <= ANCHORS_SKEW_MS
      if (!fresh || !deviceSignatureValid(signedBegin.jwk as Record<string, string>, pairBeginMessage(account.deviceId, deviceId, at), beginSig)) {
        return refuse(401, 'refused', 'This device’s signature did not open. Check its clock and start again.')
      }
      // Counted only for a device that proved its key: a stranger fills nothing.
      if (!begins.take(deviceId)) return refuse(429, 'resting', 'Too many requests from this device. Try again in a minute.', { retryAfterMs: 60_000 })
      const methods = methodsOf(anchors)
      if (methods.length === 0) return refuse(409, 'unavailable', word('This Mac has no way to check the account yet. Add a passkey at cookrew.dev/me.'))
      const challengeId = randomUUID()
      const nonce = randomBytes(32).toString('base64url')
      const passkeyChallenge = sha256b64u(pairTranscript({ desktopId: account.deviceId, challengeId, nonce, deviceId }))
      const keys = generateSealKeyPair()
      const until = now() + ACCOUNT_PAIR_CHALLENGE_MS
      held.set(deviceId, { challengeId, deviceId, nonce, keys, until, anchors, passkeyChallenge })
      const passkey =
        anchors.passkeys.length === 0 ? null : { rpId: anchors.rpId, challenge: passkeyChallenge, allow: anchors.passkeys.map((p) => p.credentialId) }
      return { status: 200, body: { challengeId, nonce, desktopId: account.deviceId, key: keys.publicKey, expiresAt: until, methods, passkey } }
    },

    async finish({ body, bridged }) {
      const account = deps.account()
      if (account === null) return refuse(404, 'unavailable', 'There is no account on this desktop.')
      const finishing = readFinish(body)
      if (finishing === null) return refuse(400, 'refused', 'That request could not be read.')
      if (checking) return refuse(429, 'resting', 'Another entry is being checked. Try again in a moment.', { retryAfterMs: 1_000 })
      checking = true
      try {
        // Spent whatever happens next — but only by a request that names it and
        // comes from the device it was issued to, so a stranger cannot cancel it.
        const found = held.get(finishing.deviceId)
        const named = found !== undefined && found.challengeId === finishing.challengeId
        const fromIt = bridged === null || bridged.deviceId === finishing.deviceId
        const h = named && fromIt ? found : undefined
        if (h !== undefined) held.delete(finishing.deviceId)
        const stopped = precheck(h, finishing, bridged, account)
        if (stopped !== null || h === undefined) return stopped ?? refuse(401, 'refused', 'Start again.')
        const checked = await checkSecret(h, finishing)
        return typeof checked === 'string' ? admit(finishing, checked, account) : checked
      } finally {
        checking = false
      }
    },

    async repin() {
      const anchors = await deps.anchors({ fresh: true })
      if (anchors === null) return null
      const before = deps.pins.read()
      const after = pinsFrom(anchors, now())
      deps.pins.write(after)
      log(`account pair: passkeys pinned again (${after.passkeys.length})`)
      return pinChanges(before, after)
    }
  }
}
