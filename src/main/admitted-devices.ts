import { createHash, timingSafeEqual } from 'node:crypto'
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
 * simply has to be admitted again. Revoking at the registry is a different,
 * heavier act and belongs on a different button.
 *
 * 0600 and temp-and-rename for the same reason the account file is: a torn
 * write here is a Mac that stops opening for a phone the owner is holding.
 *
 * PER-DEVICE TOKENS ARE NO LONGER MINTED, AND ARE STILL HONOURED. The v2
 * admission ceremony handed each admitted phone 24 random bytes of its own and
 * stored the SHA-256 here; reach v2.1 has ONE credential and no ceremony to
 * mint a second one in. The hashes already on disk keep working — mobile-api's
 * second door still accepts them — because deleting them would unpair every
 * phone that paired the old way, in an upgrade, to tidy up a field. FORGET
 * still removes the row and the hash with it.
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
}

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

export type AdmittedDeviceStoreDeps = {
  readonly base?: string
  readonly now?: () => number
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
    accepts: (token) => {
      if (typeof token !== 'string' || token.length === 0) return false
      const candidate = hashToken(token)
      // Compared as fixed-length hex digests, so the comparison is constant
      // time in the value AND says nothing about how long the token was.
      return load().some(
        (device) =>
          typeof device.tokenHash === 'string' &&
          device.tokenHash.length === candidate.length &&
          timingSafeEqual(Buffer.from(device.tokenHash), Buffer.from(candidate))
      )
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
    }
  }
}
