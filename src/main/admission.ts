import type { AccountFile } from './account-v2'
import type { AdmittedDevice, AdmittedDeviceStore } from './admitted-devices'
import type { CanvasTokenResult, RegistryKeys } from './canvas-token'
import { verifyCanvasToken } from './canvas-token'
import { deviceIdPrefix } from '../shared/pairing-qr'

/**
 * The ceremony's own sentences.
 *
 * They used to sit in shared/pairing-qr beside the popout's copy, back when
 * the popout and the admission were two halves of one six-character
 * ceremony. The popout has moved to the one pairing URL, so these are the
 * last readers and they live where they are read.
 */
const COPY = {
  WRONG_KEY: "Not this Mac's key — it changes every two minutes.",
  NAMED_THE_MAC: 'That link named the Mac, not the phone — open it again from cookrew.dev.',
  ALREADY_USED: 'That link was already used — open it again from cookrew.dev.',
  NOT_THIS_MAC: 'This sign-in is not for this Mac — open it again from cookrew.dev.'
} as const

/**
 * LETTING A PHONE IN, ONCE, WITHOUT A URL.
 *
 * `GET /?open=<canvasToken>&key=<KEY>&device=<phoneDeviceId>` is the whole
 * ceremony. Two independent facts have to hold, and they answer two different
 * questions (architecture P3):
 *
 *   MAY this person — the canvas token, signed by cookrew.dev, naming this
 *   account, this desktop and that phone. Checked offline.
 *
 *   IS this person here — the six-character key off the popout, OR a prior
 *   admission recorded on this Mac. The second is what makes the first
 *   pairing the only one; a phone already admitted never types a key again.
 *
 * Neither alone is enough. A token without presence is a stolen token opening
 * a Mac its holder has never stood in front of; a key without a token is the
 * old world, where reading six characters made you the owner.
 */

export type AdmissionRequest = {
  readonly token: string | null
  readonly key: string | null
  readonly phoneDeviceId: string | null
  readonly phoneName?: string | null
}

export type AdmissionRefusal =
  /** The token is not for this Mac, this account, this phone, or this hour. */
  | { readonly kind: 'token'; readonly reason: string; readonly sentence: string }
  /** The token is good but nobody proved they are standing here. */
  | { readonly kind: 'key'; readonly sentence: string }
  /**
   * `device` named THIS DESKTOP rather than the phone.
   *
   * Its own refusal because it is its own mistake, and a bare 401 buried it:
   * the link is well-formed, signed, in date and for this Mac — the only thing
   * wrong is which device id the page put in one query parameter, which is
   * something the person holding the phone can neither see nor fix. So it goes
   * back to the page that built the link, the way a wrong key does, with a
   * sentence that names the actual error.
   */
  | { readonly kind: 'device'; readonly sentence: string }
  /**
   * This exact token already admitted somebody.
   *
   * A canvas token is good for ten minutes and says nothing about how many
   * times it may be spent, so a recorded admission replayed inside that window
   * opened the Mac again for whoever had the recording. Verifying a signature
   * proves the registry wrote it; only this Mac can know it has been used.
   */
  | { readonly kind: 'replay'; readonly sentence: string }

export type AdmissionOutcome =
  | {
      readonly ok: true
      readonly device: AdmittedDevice
      readonly firstTime: boolean
      /** THIS PHONE'S OWN credential. Handed over once, in the redirect. */
      readonly token: string
    }
  | { readonly ok: false; readonly refusal: AdmissionRefusal }

export type AdmissionDeps = {
  readonly account: () => AccountFile | null
  readonly keys: () => Promise<RegistryKeys | null>
  /** One retry with a fresh key, and only after a signature failed. */
  readonly refreshKeys: () => Promise<RegistryKeys | null>
  readonly admitted: AdmittedDeviceStore
  readonly acceptsPairingKey: (key: string) => boolean
  /**
   * Burn the token's jti. False means it has already admitted somebody.
   * Optional so a caller that has not wired the store still verifies claims —
   * but index.ts wires it, and the test says so.
   */
  readonly spend?: (jti: string, exp: number) => boolean
  readonly now: () => number
  /**
   * One sentence per refusal. Never the key, never the token: a log line is
   * the easiest place in the system to leak a live credential, and the only
   * thing worth reading later is which device was turned away and why.
   */
  readonly log?: (message: string) => void
}

const tokenRefusal = (reason: string): AdmissionRefusal => ({
  kind: 'token',
  reason,
  sentence: COPY.NOT_THIS_MAC
})

const KEY_REFUSAL: AdmissionRefusal = { kind: 'key', sentence: COPY.WRONG_KEY }

const REPLAY_REFUSAL: AdmissionRefusal = {
  kind: 'replay',
  sentence: COPY.ALREADY_USED
}

const DEVICE_REFUSAL: AdmissionRefusal = {
  kind: 'device',
  sentence: COPY.NAMED_THE_MAC
}

/**
 * Refuse, and say so once.
 *
 * The device id is cut to its prefix and the key is not in the argument list
 * at all, so there is no path from here to a live credential in a log file.
 */
const refuse = (
  deps: Pick<AdmissionDeps, 'log'>,
  deviceId: string | null,
  refusal: AdmissionRefusal,
  why: string
): AdmissionOutcome => {
  const who = deviceId ? deviceIdPrefix(deviceId) : 'an unnamed device'
  deps.log?.(`admission refused for ${who}: ${why}`)
  return { ok: false, refusal }
}

/** True when the query looks like an admission attempt at all. */
export const isAdmissionRequest = (request: AdmissionRequest): boolean =>
  request.token !== null

export const admit = async (
  request: AdmissionRequest,
  deps: AdmissionDeps
): Promise<AdmissionOutcome> => {
  const account = deps.account()
  if (!account) return refuse(deps, null, tokenRefusal('no_account'), 'no account on this Mac')
  if (!request.token) return refuse(deps, null, tokenRefusal('malformed'), 'no token')
  if (!request.phoneDeviceId) {
    return refuse(deps, null, tokenRefusal('no_device'), 'the link named no device')
  }
  /**
   * THE PHONE IS NOT THE MAC. A page that sends this desktop's own id as
   * `device` would otherwise fail the `dev` claim and read as a forged token,
   * which sends the owner looking in entirely the wrong place. The strict
   * check below is unchanged for every other id; this only names the one
   * confusion worth naming.
   */
  if (request.phoneDeviceId === account.deviceId) {
    return refuse(deps, request.phoneDeviceId, DEVICE_REFUSAL, 'the link named the Mac')
  }

  const expectation = {
    username: account.username,
    deviceId: account.deviceId,
    phoneDeviceId: request.phoneDeviceId,
    now: deps.now()
  }
  const check = async (): Promise<CanvasTokenResult> => {
    const keys = await deps.keys()
    if (!keys) return { ok: false, reason: 'bad_signature' }
    const first = verifyCanvasToken(request.token as string, keys, expectation)
    // A signature that fails against a cached key is the one case worth one
    // more round trip: the registry may have rotated since the cache warmed.
    if (first.ok || first.reason !== 'bad_signature') return first
    const fresh = await deps.refreshKeys()
    if (!fresh || fresh.jwk === keys.jwk) return first
    return verifyCanvasToken(request.token as string, fresh, expectation)
  }

  const verified = await check()
  if (!verified.ok) {
    return refuse(deps, request.phoneDeviceId, tokenRefusal(verified.reason), verified.reason)
  }

  /**
   * A KEY THAT IS PRESENTED IS A KEY THAT IS CHECKED.
   *
   * This was `if (!already && ...)`: a device this Mac had admitted before
   * skipped the check entirely, so a WRONG key was not refused — it was never
   * looked at. The owner watched OPEN succeed on a key that did not match,
   * which is the worst possible answer, because the six characters are the
   * whole of "somebody is standing at this Mac right now" and a check that is
   * silently skipped reads exactly like a check that passed.
   *
   * The rule is now about the REQUEST, not about the requester's history:
   *
   *   a key was presented  → it must match the current or previous rotation,
   *                          whoever is asking and however often they have
   *                          been let in before;
   *   no key at all        → prior admission is what stands in for presence,
   *                          which is what makes the first pairing the only
   *                          one a phone ever does.
   *
   * An empty `?key=` is no key rather than a wrong one — it carries nothing to
   * check, and treating it as a wrong key would refuse an admitted phone whose
   * page happened to append the parameter.
   */
  const presented = request.key !== null && request.key.trim().length > 0 ? request.key : null
  const already = deps.admitted.has(request.phoneDeviceId)

  if (presented !== null) {
    if (!deps.acceptsPairingKey(presented)) {
      return refuse(deps, request.phoneDeviceId, KEY_REFUSAL, 'the key did not match')
    }
  } else if (!already) {
    return refuse(deps, request.phoneDeviceId, KEY_REFUSAL, 'no key, and never admitted here')
  }

  /**
   * BURNED ON SUCCESS, and only on success.
   *
   * The attack is a recorded admission that WORKED, replayed inside the
   * token's ten minutes; burning at that moment closes it. Burning earlier —
   * the instant the signature verified — would close it too, and would also
   * mean a mistyped six-character key spent the token, so the page that sent
   * the person here would have to mint another one before they could try
   * again. A wrong key is the ordinary case, not the attack.
   */
  if (deps.spend && !deps.spend(verified.claims.jti, verified.claims.exp)) {
    return refuse(deps, request.phoneDeviceId, REPLAY_REFUSAL, 'that link was already used')
  }

  const admitted = deps.admitted.admit({
    deviceId: request.phoneDeviceId,
    ...(request.phoneName ? { name: request.phoneName } : {})
  })
  return { ok: true, firstTime: !already, device: admitted.device, token: admitted.token }
}

/**
 * Where a refused phone is sent back to.
 *
 * A wrong key is a mistake, not an attack, and the person holding the phone is
 * looking at the page that sent them here — so they go back to it with the
 * reason in the query and the desktop named, and the page tells them the key
 * moved on. A bad token gets no redirect: it names no page we should trust.
 */
export const refusedRedirect = (
  registryOrigin: string,
  deviceId: string,
  refused: 'key' | 'device' = 'key'
): string =>
  `${registryOrigin.replace(/\/+$/, '')}/me?refused=${refused}&desktop=${encodeURIComponent(deviceId)}`
