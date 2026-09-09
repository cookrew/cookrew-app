import { addressFromLabel } from './dns-zone'
import { helloMessage, verifyDeviceSignature, type V2Reach } from './v2-reach'
import type { HelloBurn } from './hello-nonces'

/**
 * IS THAT MY MAC, AT THAT ADDRESS, RIGHT NOW, FOR THE FIRST TIME?
 *
 * Version 1 answered only the first clause. `cookrew-hello/1 <deviceId>
 * <nonce>` proves the answerer holds the device key — it says nothing about
 * WHICH endpoint answered, so a box on the LAN could relay the challenge to
 * the real Mac and return its signature as its own. The phone would then move
 * its data plane, and its pairing token, to the relay's address.
 *
 * Version 2 signs the endpoint and the moment:
 *
 *     cookrew-hello/2 <deviceId> <origin> <issuedAtMs> <nonce>
 *
 * and this file adds the two facts only the registry holds:
 *
 *   THE CLOCK. `issuedAtMs` must be within the skew allowance of ours, so a
 *   signature scraped off a network log is worth minutes rather than for ever.
 *
 *   THE BURN. A pair spent once is refused for the rest of its window, so a
 *   signature that is still fresh cannot be presented twice.
 *
 * The client does the third check, and it is the one that defeats the relay:
 * the origin in the signature must be the origin the client dialled. The
 * registry cannot make that comparison — it was not there — which is exactly
 * why the check is split across the two ends rather than trusted to either.
 *
 * WHY THE REASONS ARE NAMED. `{ok:false}` told a companion nothing it could
 * act on: a clock two minutes out and an attacker on the wire produced the
 * same silence. The names are given ONLY for a device the caller's own account
 * holds; an unknown device is still an unadorned no, because a reason there
 * would let a signed-in caller enumerate other people's device ids.
 */

export const HELLO_V2_PREFIX = 'cookrew-hello/2'

/**
 * How far the Mac's clock may be from ours.
 *
 * Two minutes. A Mac that has just woken has not reached a time server yet and
 * is routinely tens of seconds out; refusing those would break the feature on
 * exactly the machines it exists for. It is a REPLAY WINDOW as much as a
 * tolerance — it is how long a captured signature stays worth capturing — so
 * it is as small as honest clocks allow and no smaller.
 */
export const HELLO_SKEW_MS = 120_000

export const helloMessageV2 = (
  deviceId: string,
  origin: string,
  issuedAtMs: number,
  nonce: string
): string => `${HELLO_V2_PREFIX} ${deviceId} ${origin} ${issuedAtMs} ${nonce}`

/** Every way a hello is refused, in words a companion can act on. */
export type HelloRefusal = 'stale' | 'replayed' | 'wrong_origin' | 'bad_signature'

export type HelloVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: HelloRefusal }

/** 16 bytes of base64url is 22 characters; the floor the contract names. */
const NONCE = /^[A-Za-z0-9_-]{22,256}$/
const ORIGIN_MAX = 200

/**
 * COULD THIS DESKTOP HONESTLY ANSWER AT THIS ORIGIN?
 *
 * Two ways to be yes, and no third:
 *
 *   A NAME UNDER ITS OWN SUBDOMAIN — `<address-label>.<deviceId>.<zone>`. Only
 *   this device can get a certificate for `*.<deviceId>.<zone>` (the CSR gate
 *   sees to that) and only its own published addresses resolve there, so the
 *   whole subdomain is the device's and nobody else's. The zone is not pinned
 *   here: a self-hosted registry certifies under its own.
 *
 *   AN ADDRESS ON ITS OWN REACH CARD — the bare-IP origins it published.
 *
 * The address label is deliberately NOT required to match a card entry as
 * well. The card lags a Mac that just changed networks by one publish, and a
 * false `wrong_origin` there would strand a phone on the relay while the name
 * it is dialling works perfectly. The subdomain is what makes the origin the
 * device's; the card is a convenience, not the boundary.
 */
export const originBelongsTo = (
  deviceId: string,
  origin: unknown,
  reach: V2Reach | null
): boolean => {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > ORIGIN_MAX) return false
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  // An ORIGIN and nothing more: `origin` drops path, query and credentials, so
  // demanding it back verbatim refuses anything richer being signed.
  if (parsed.protocol !== 'https:' || parsed.origin !== origin) return false
  const id = deviceId.toLowerCase()
  const labels = parsed.hostname.toLowerCase().split('.')
  // `<address>.<id>.<zone>`, and the shortest zone anyone delegates is two.
  if (labels.length >= 4 && labels[1] === id && addressFromLabel(labels[0]) !== null) return true
  if (reach === null) return false
  const published = [...reach.lan, ...(reach.tailnet === null ? [] : [reach.tailnet])]
  return published.some((address) => address.url === origin)
}

export interface HelloClaimInput {
  readonly jwk: Record<string, string>
  readonly deviceId: string
  /** The desktop's own reach card, when the registry holds one. */
  readonly reach: V2Reach | null
  readonly claim: {
    readonly origin?: unknown
    readonly issuedAtMs?: unknown
    readonly nonce?: unknown
    readonly sig?: unknown
  }
  readonly now: number
  readonly burn: HelloBurn
}

/**
 * The whole verdict for one claim, either version.
 *
 * VERSION 1 IS STILL ACCEPTED, and deliberately: a phone runs whatever bundle
 * it last loaded, and a companion left open on a train would otherwise be
 * refused by a registry it never asked to be updated. It gets the burn (which
 * costs it nothing) and none of the origin or clock checks, because it signs
 * neither. It should be dropped one release after every companion sends `v:2`.
 */
export const verifyHelloClaim = (input: HelloClaimInput): HelloVerdict => {
  const { claim, deviceId, now } = input
  const nonce = claim.nonce
  // A nonce we would never have issued cannot be under a signature we would
  // accept, so it is refused as one rather than given its own name.
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return { ok: false, reason: 'bad_signature' }

  const version2 = claim.origin !== undefined || claim.issuedAtMs !== undefined
  if (!version2) {
    if (!verifyDeviceSignature(input.jwk, helloMessage(deviceId, nonce), claim.sig)) {
      return { ok: false, reason: 'bad_signature' }
    }
    return input.burn.spend(deviceId, nonce, now) ? { ok: true } : { ok: false, reason: 'replayed' }
  }

  if (!originBelongsTo(deviceId, claim.origin, input.reach)) {
    return { ok: false, reason: 'wrong_origin' }
  }
  const issuedAtMs = claim.issuedAtMs
  if (!Number.isSafeInteger(issuedAtMs) || Math.abs(now - (issuedAtMs as number)) > HELLO_SKEW_MS) {
    return { ok: false, reason: 'stale' }
  }
  const message = helloMessageV2(deviceId, claim.origin as string, issuedAtMs as number, nonce)
  // Signature BEFORE the burn: a forged claim must not be able to spend a
  // nonce an honest one is about to present.
  if (!verifyDeviceSignature(input.jwk, message, claim.sig)) {
    return { ok: false, reason: 'bad_signature' }
  }
  return input.burn.spend(deviceId, nonce, now) ? { ok: true } : { ok: false, reason: 'replayed' }
}
