import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * PHONES THIS MAC HAS LET IN.
 *
 * The pairing token is what opens this Mac. This file is the LEDGER of who has
 * opened it: a row per phone, filled in from the name the relay carries down
 * the bridge (relay-device.ts) on the first authorised request it makes, and
 * refreshed as it keeps asking. It is what the account sheet lists and what
 * FORGET removes.
 *
 * It is deliberately NOT the account's device list. The registry knows which
 * devices belong to @drej; this file knows which of them THIS Mac has agreed to
 * open for. FORGET here is local — the phone stays attached to the account and
 * simply has to be admitted again.
 *
 * REVOKING AT THE REGISTRY NOW REACHES IT. It is still the heavier act and
 * still a different button, but a revoked phone must stop opening this Mac on
 * its own Wi-Fi too — until it did not, and the copy had to admit as much
 * ("keeps working on this Wi-Fi until re-paired"). The revoked list published
 * beside the door key at /v2/keys is handed to `prune`, so admission here ends
 * within a minute of the revoke rather than lasting until somebody happened to
 * press FORGET on this particular Mac.
 *
 * 0600 and temp-and-rename for the same reason the account file is: a torn
 * write here is a Mac that stops opening for a phone the owner is holding.
 *
 * PER-DEVICE TOKENS ARE MINTED AGAIN (v3, V3-21), and this time they are the
 * point. The v2 ceremony handed each admitted phone 24 random bytes of its
 * own and stored the SHA-256 here; reach v2.1 retired the ceremony and kept
 * the door open for the hashes already on disk. The row was a ledger and the
 * root pairing token was the only credential — which is exactly why pruning
 * a revoked phone's row ended nothing. `admit` is the producer the door was
 * missing: the admission route (mobile-identity-routes.ts) calls it once a
 * phone has bootstrapped with the root token and proved its device key, and
 * from then on the phone opens this Mac with its own token, whose hash lives
 * on its own row. FORGET and prune remove the row — and with it, now, the
 * credential.
 */

export type AdmittedDevice = {
  readonly deviceId: string
  readonly name?: string
  readonly admittedAt: number
  readonly lastSeenAt: number
  /**
   * SHA-256 of this phone's own companion token, hex. The token itself is
   * handed over once, at admission, and never written down — this file is
   * 0600 but it is still a file, and a stored bearer token is a stored bearer
   * token.
   */
  readonly tokenHash?: string
}

export type AdmittedDeviceStore = {
  readonly list: () => AdmittedDevice[]
  readonly has: (deviceId: string) => boolean
  /**
   * Note that this phone asked, and that it was allowed to.
   *
   * CALLED ON EVERY AUTHORISED REQUEST THE BRIDGE NAMES A DEVICE ON, which is
   * why it writes as little as it can: a phone polling this server touches
   * this several times a second, and a file rewrite each time is a 0600 JSON
   * file rewritten a few hundred thousand times a day for no new fact. So the
   * write happens only when something actually changed — a phone never seen,
   * a name that moved — or when the last sighting is over a minute old.
   */
  readonly record: (device: { deviceId: string; name?: string }) => AdmittedDevice
  /**
   * Does this bearer token belong to a phone this Mac still admits?
   *
   * Only phones admitted under the retired v2 ceremony have one; it stays
   * because forgetting a phone must remain the thing that ends its access.
   */
  readonly accepts: (token: string) => boolean
  /**
   * WHICH phone holds this token, or null.
   *
   * `accepts` answers whether a credential opens the Mac; this answers WHO it
   * opens it as, which is a different question and the one the admission
   * route needs. Nothing else may mint in a device's name, so the gate has to
   * be able to say the name (companion-gate.ts · CompanionCredential).
   */
  readonly deviceFor: (token: string) => string | null
  /**
   * Drop the admission. TRUE means the phone is not admitted any more — which
   * is the question the caller is actually asking, and which an already-absent
   * phone also answers yes to.
   *
   * It used to answer "did I rewrite a row", so forgetting a phone that a
   * concurrent write had already removed reported FALSE while succeeding, and
   * the sheet then put the row back on screen. A boolean that means one thing
   * to the writer and another to the reader is worse than no boolean.
   */
  readonly forget: (deviceId: string) => boolean
  /**
   * ADMIT: mint this phone its own token and write the hash on its row.
   *
   * Answers the token ONCE, to the caller that will hand it to the phone; the
   * file never sees it. Admitting a phone that is already admitted ROTATES
   * its token — the old hash is replaced, so a bootstrap repeated from a
   * second browser on the same phone does not leave two live credentials for
   * one device, and the row keeps its first `admittedAt`.
   */
  readonly admit: (device: { deviceId: string; name?: string }) => {
    device: AdmittedDevice
    token: string
  }
  /**
   * Forget every admitted phone whose device id the registry has revoked.
   *
   * Answers WHAT IT FORGOT, so the caller can name each phone in its notice. A
   * count would leave the owner reading "1 device" with no idea which one just
   * stopped working on their Wi-Fi.
   *
   * AN EMPTY LIST FORGETS NOBODY, and is the case worth writing down. A
   * revoked list this Mac could not parse reads as empty rather than as a
   * refusal to serve (v2-call-token.ts), so "the registry told us nothing"
   * arrives here as []; reading that as "forget everyone" would unpair every
   * phone on the account from one bad deploy of the registry.
   *
   * The list names revoked SESSIONS beside revoked devices. A session id
   * matches no deviceId and passes through inert: this filters OUR ids against
   * theirs and never tries to decide which kind a given id is.
   */
  readonly prune: (revoked: readonly string[]) => AdmittedDevice[]
}

/**
 * HOW MANY PHONES THIS MAC WILL HOLD OPEN FOR.
 *
 * A bound on a file that a credential can grow. It is NOT a defence against
 * whoever holds the root pairing token — that credential opens every route
 * today, so somebody holding it has this Mac already — it is a bound on
 * growth: a loop, a stuck client, a script left running. Thirty-two is far
 * above the number of phones and iPads a person actually admits and far
 * below anything that makes this file worth reading twice.
 *
 * THE CAP REFUSES; IT NEVER EVICTS. Dropping the oldest row to make space
 * would silently un-admit a phone the owner is holding, and this ledger must
 * never withdraw an admission on its own — FORGET is a button with a person
 * behind it, and the revoked sweep is the registry's word, not a guess.
 */
export const ADMITTED_MAX = 32

export const admittedDevicesFile = (base?: string): string =>
  path.join(base ?? path.join(homedir(), '.cookrew'), 'admitted-devices.json')

const looksLikeDevice = (value: unknown): value is AdmittedDevice => {
  if (!value || typeof value !== 'object') return false
  const d = value as Record<string, unknown>
  return (
    typeof d.deviceId === 'string' &&
    d.deviceId.length > 0 &&
    typeof d.admittedAt === 'number' &&
    typeof d.lastSeenAt === 'number' &&
    (d.name === undefined || typeof d.name === 'string') &&
    (d.tokenHash === undefined || typeof d.tokenHash === 'string')
  )
}

/** Unreadable or corrupt reads as "nobody is admitted", never as a crash. */
export const readAdmittedDevices = (base?: string): AdmittedDevice[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(admittedDevicesFile(base), 'utf8'))
    const devices = Array.isArray(parsed)
      ? parsed
      : (parsed as { devices?: unknown })?.devices
    return Array.isArray(devices) ? devices.filter(looksLikeDevice) : []
  } catch {
    return []
  }
}

export const writeAdmittedDevices = (devices: readonly AdmittedDevice[], base?: string): void => {
  const file = admittedDevicesFile(base)
  const temp = `${file}.tmp`
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(temp, `${JSON.stringify({ devices }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  chmodSync(temp, 0o600)
  try {
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  chmodSync(file, 0o600)
}

/**
 * How stale a sighting may be before it is written down again.
 *
 * A minute is far below anything a person reads off the row ("last seen") and
 * far above the rate a phone polls at, which is the whole trade.
 */
export const SIGHTING_REFRESH_MS = 60_000

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex')

/**
 * The shape a per-device token has: 24 random bytes, base64url, 32 chars —
 * the same width as the root pairing token (pairing-token.ts), so the
 * companion's `isPairingToken` shape check (pairing-scope.ts) takes it and
 * nothing on the wire can tell the two apart by length.
 */
export const mintCompanionToken = (): string => randomBytes(24).toString('base64url')

export type AdmittedDeviceStoreDeps = {
  readonly base?: string
  readonly now?: () => number
}

/**
 * The row whose token this is, or null — the one comparison, written once.
 *
 * Compared as fixed-length hex digests, so it is constant time in the value
 * AND says nothing about how long the token was. `accepts` and `deviceFor`
 * are the same question asked at two widths; two loops would be two chances
 * for one of them to be the loose one.
 */
const holderOf = (devices: readonly AdmittedDevice[], token: string): AdmittedDevice | null => {
  if (typeof token !== 'string' || token.length === 0) return null
  const candidate = hashToken(token)
  return (
    devices.find(
      (device) =>
        typeof device.tokenHash === 'string' &&
        device.tokenHash.length === candidate.length &&
        timingSafeEqual(Buffer.from(device.tokenHash), Buffer.from(candidate))
    ) ?? null
  )
}

export const createAdmittedDeviceStore = (
  deps: AdmittedDeviceStoreDeps = {}
): AdmittedDeviceStore => {
  const now = deps.now ?? Date.now
  // Re-read on every call rather than caching: the file is tiny, and a stale
  // in-memory copy is how a forgotten phone keeps getting in.
  const load = (): AdmittedDevice[] => readAdmittedDevices(deps.base)

  return {
    list: () => load().sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    has: (deviceId) => load().some((device) => device.deviceId === deviceId),
    record: ({ deviceId, name }) => {
      const at = now()
      const existing = load()
      const previous = existing.find((device) => device.deviceId === deviceId)
      // A device that arrives without a name keeps the one it had: the relay
      // only carries a name when the registry knows one.
      const kept = name ?? previous?.name
      const seen: AdmittedDevice = {
        ...(previous ?? {}),
        deviceId,
        ...(kept ? { name: kept } : {}),
        admittedAt: previous?.admittedAt ?? at,
        lastSeenAt: at
      }
      const unchanged =
        previous !== undefined &&
        previous.name === seen.name &&
        at - previous.lastSeenAt < SIGHTING_REFRESH_MS
      if (unchanged) return previous
      writeAdmittedDevices(
        [...existing.filter((device) => device.deviceId !== deviceId), seen],
        deps.base
      )
      return seen
    },
    accepts: (token) => holderOf(load(), token) !== null,
    deviceFor: (token) => holderOf(load(), token)?.deviceId ?? null,
    admit: ({ deviceId, name }) => {
      const at = now()
      const existing = load()
      const previous = existing.find((device) => device.deviceId === deviceId)
      const token = mintCompanionToken()
      const admitted: AdmittedDevice = {
        deviceId,
        ...((name ?? previous?.name) ? { name: name ?? previous?.name } : {}),
        admittedAt: previous?.admittedAt ?? at,
        lastSeenAt: at,
        tokenHash: hashToken(token)
      }
      // Written BEFORE the token is answered: a token handed out ahead of a
      // write that then failed would be a credential this Mac never agreed to.
      writeAdmittedDevices(
        [...existing.filter((device) => device.deviceId !== deviceId), admitted],
        deps.base
      )
      return { device: admitted, token }
    },
    forget: (deviceId) => {
      const existing = load()
      const kept = existing.filter((device) => device.deviceId !== deviceId)
      // Nothing to write is not a failure — it is the outcome, already true.
      if (kept.length === existing.length) return true
      try {
        writeAdmittedDevices(kept, deps.base)
        return true
      } catch (error) {
        // The one honest false: the file would not take the change, so the
        // phone IS still admitted and the row must stay on screen.
        console.error('Could not forget an admitted device:', error)
        return false
      }
    },
    prune: (revoked) => {
      // Before the read, not after: nothing to revoke must cost nothing at
      // all, because this runs on a timer whether or not anything happened.
      if (revoked.length === 0) return []
      const cut = new Set(revoked)
      const existing = load()
      const forgotten = existing.filter((device) => cut.has(device.deviceId))
      if (forgotten.length === 0) return []
      try {
        writeAdmittedDevices(
          existing.filter((device) => !cut.has(device.deviceId)),
          deps.base
        )
        return forgotten
      } catch (error) {
        // The same honesty as forget's one false. The rows survived, so the
        // phones ARE still admitted, and naming them here would announce an
        // access that still works.
        console.error('Could not forget revoked devices:', error)
        return []
      }
    }
  }
}
