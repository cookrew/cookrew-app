import type { AccountFile } from './account-v2'
import type { AdmittedDevice, AdmittedDeviceStore } from './admitted-devices'
import type { CanvasTokenResult, RegistryKeys } from './canvas-token'
import { verifyCanvasToken } from './canvas-token'
import { PAIRING_COPY } from '../shared/pairing-qr'

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

export type AdmissionOutcome =
  | { readonly ok: true; readonly device: AdmittedDevice; readonly firstTime: boolean }
  | { readonly ok: false; readonly refusal: AdmissionRefusal }

export type AdmissionDeps = {
  readonly account: () => AccountFile | null
  readonly keys: () => Promise<RegistryKeys | null>
  /** One retry with a fresh key, and only after a signature failed. */
  readonly refreshKeys: () => Promise<RegistryKeys | null>
  readonly admitted: AdmittedDeviceStore
  readonly acceptsPairingKey: (key: string) => boolean
  readonly now: () => number
}

const tokenRefusal = (reason: string): AdmissionRefusal => ({
  kind: 'token',
  reason,
  sentence: PAIRING_COPY.NOT_THIS_MAC
})

const KEY_REFUSAL: AdmissionRefusal = { kind: 'key', sentence: PAIRING_COPY.WRONG_KEY }

/** True when the query looks like an admission attempt at all. */
export const isAdmissionRequest = (request: AdmissionRequest): boolean =>
  request.token !== null

export const admit = async (
  request: AdmissionRequest,
  deps: AdmissionDeps
): Promise<AdmissionOutcome> => {
  const account = deps.account()
  if (!account) return { ok: false, refusal: tokenRefusal('no_account') }
  if (!request.token) return { ok: false, refusal: tokenRefusal('malformed') }
  if (!request.phoneDeviceId) return { ok: false, refusal: tokenRefusal('no_device') }

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
  if (!verified.ok) return { ok: false, refusal: tokenRefusal(verified.reason) }

  const already = deps.admitted.has(request.phoneDeviceId)
  if (!already && !(request.key !== null && deps.acceptsPairingKey(request.key))) {
    return { ok: false, refusal: KEY_REFUSAL }
  }

  return {
    ok: true,
    firstTime: !already,
    device: deps.admitted.admit({
      deviceId: request.phoneDeviceId,
      ...(request.phoneName ? { name: request.phoneName } : {})
    })
  }
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
  deviceId: string
): string =>
  `${registryOrigin.replace(/\/+$/, '')}/me?refused=key&desktop=${encodeURIComponent(deviceId)}`
