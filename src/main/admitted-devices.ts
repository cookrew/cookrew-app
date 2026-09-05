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
 */

export type AdmittedDevice = {
  readonly deviceId: string
  readonly name?: string
  readonly admittedAt: number
  readonly lastSeenAt: number
}

export type AdmittedDeviceStore = {
  readonly list: () => AdmittedDevice[]
  readonly has: (deviceId: string) => boolean
  /** Record an admission, or refresh the last-seen of one already recorded. */
  readonly admit: (device: { deviceId: string; name?: string }) => AdmittedDevice
  readonly touch: (deviceId: string) => void
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
    (d.name === undefined || typeof d.name === 'string')
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
      const admitted: AdmittedDevice = {
        deviceId,
        // A device that arrives without a name keeps the one it had.
        ...(name ?? previous?.name ? { name: name ?? previous?.name } : {}),
        admittedAt: previous?.admittedAt ?? at,
        lastSeenAt: at
      }
      writeAdmittedDevices(
        [...existing.filter((device) => device.deviceId !== deviceId), admitted],
        deps.base
      )
      return admitted
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
      if (kept.length === existing.length) return false
      writeAdmittedDevices(kept, deps.base)
      return true
    }
  }
}
