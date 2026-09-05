import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * PHONES THIS MAC HAS LET IN.
 *
 * The pairing key proves presence once. This file is what makes that once
 * enough: a phone admitted here opens the canvas again tomorrow, from the
 * office or over the relay, without anyone reading six characters off a screen
 * a second time.
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
 * AND EACH PHONE GETS ITS OWN CREDENTIAL. Every admitted phone used to be
 * handed the same global pairing token — in a URL — which meant one captured
 * phone was every phone, and FORGET revoked nothing at all: the token it had
 * been given still worked, because it was everybody's. So admission mints 24
 * random bytes per device and stores only their SHA-256 here. Forgetting a
 * device deletes the hash, and that phone stops being able to ask.
 *
 * The global token stays for legacy phones and for the QR `cookrew mobile`
 * prints; it is a second door, not a replacement, and it is the one the owner
 * can rotate wholesale.
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
   * Record an admission and mint this phone's own companion token, or refresh
   * the last-seen of one already recorded and mint it a fresh token.
   *
   * A NEW TOKEN ON EVERY ADMISSION, deliberately: an admission is somebody
   * standing at the Mac with a valid canvas token, so it is the right moment
   * to replace whatever the phone was carrying.
   */
  readonly admit: (device: { deviceId: string; name?: string }) => {
    readonly device: AdmittedDevice
    /** The plaintext token, seen here and in the redirect and nowhere else. */
    readonly token: string
  }
  /** Does this bearer token belong to a phone this Mac still admits? */
  readonly accepts: (token: string) => boolean
  readonly touch: (deviceId: string) => void
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

/** 24 bytes: the same width as the global pairing token it sits beside. */
export const COMPANION_TOKEN_BYTES = 24

const mintToken = (): string => randomBytes(COMPANION_TOKEN_BYTES).toString('base64url')

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
    admit: ({ deviceId, name }) => {
      const at = now()
      const existing = load()
      const previous = existing.find((device) => device.deviceId === deviceId)
      const token = mintToken()
      const admitted: AdmittedDevice = {
        deviceId,
        // A device that arrives without a name keeps the one it had.
        ...(name ?? previous?.name ? { name: name ?? previous?.name } : {}),
        admittedAt: previous?.admittedAt ?? at,
        lastSeenAt: at,
        tokenHash: hashToken(token)
      }
      writeAdmittedDevices(
        [...existing.filter((device) => device.deviceId !== deviceId), admitted],
        deps.base
      )
      return { device: admitted, token }
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
    touch: (deviceId) => {
      const existing = load()
      const previous = existing.find((device) => device.deviceId === deviceId)
      if (!previous) return
      writeAdmittedDevices(
        existing.map((device) =>
          device.deviceId === deviceId ? { ...device, lastSeenAt: now() } : device
        ),
        deps.base
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
