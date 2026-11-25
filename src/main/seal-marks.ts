import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-file'

/**
 * WHO IS REFUSED IN THE CLEAR ON THE RELAY LINE (cookrew-seal/2 enforcement).
 *
 * A device that opened a v2 session on the connect code sends everything
 * through it from then on (renderer path/seal-plane.ts), so this Mac refuses
 * that device's plain requests over the relay. And the owner can refuse ALL
 * plain requests over the relay line once every client they use speaks v2:
 * the Alma rule, "a desktop with end-to-end on answers no plaintext".
 *
 * WHAT EACH STOPS, said plainly: the relay names the device a request comes
 * from, so a relay that lies can name another device or none. The per-device
 * mark therefore stops a correct client's own mistakes and an honest relay
 * carrying a stolen token in that device's name; it does NOT stop a relay
 * that lies. Only `sealedOnly` does, and it is off by default because it also
 * shuts out every phone, console and desktop not on v2 yet.
 *
 * A new connect code clears the marks: a device holding the old code can no
 * longer open a session, and must be able to reach the page that pairs it. A mark
 * also lapses MARK_MS after that device's last v2 session (each one renews it), so
 * a device that lost its code and never comes back sealed is not refused for good.
 */

/** How long a mark stands after the device's last v2 session. */
export const MARK_MS = 30 * 24 * 60 * 60 * 1000
/** A v2 session renews its mark at most this often: every session would be a write. */
const RENEW_MS = 24 * 60 * 60 * 1000

export interface SealMarks {
  /** Should a plain request that came over the relay line, in this device's name (or none), be refused? */
  refuses(deviceId: string | null): boolean
  mark(deviceId: string): void
  /** That device (a watch the owner forgot) is no longer refused in the clear. */
  unmark(deviceId: string): void
  marked(): string[]
  sealedOnly(): boolean
  setSealedOnly(on: boolean): void
  /** The connect code changed. */
  clearDevices(): void
}

interface MarksFile {
  readonly sealedOnly: boolean
  readonly devices: Readonly<Record<string, { readonly at: number }>>
}

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A file that is there and cannot be read fails closed: sealed only, until the owner says otherwise at the Mac. */
function readMarks(file: string): MarksFile {
  if (!existsSync(file)) return { sealedOnly: false, devices: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<MarksFile>
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.sealedOnly !== 'boolean') return { sealedOnly: true, devices: {} }
    const devices = typeof parsed.devices === 'object' && parsed.devices !== null ? parsed.devices : {}
    return { sealedOnly: parsed.sealedOnly, devices: Object.fromEntries(Object.entries(devices).filter(([id]) => DEVICE_ID.test(id))) }
  } catch {
    return { sealedOnly: true, devices: {} }
  }
}

export function createSealMarks(file: string, now: () => number = Date.now): SealMarks {
  // Read once, kept in memory: this is asked on every relayed request.
  let held = readMarks(file)
  const write = (next: MarksFile): void => {
    held = next
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  }
  return {
    refuses(deviceId) {
      if (held.sealedOnly) return true
      const id = deviceId?.toLowerCase() ?? null
      const mark = id !== null && Object.prototype.hasOwnProperty.call(held.devices, id) ? held.devices[id] : undefined
      return mark !== undefined && now() - mark.at < MARK_MS
    },
    mark(deviceId) {
      const id = deviceId.toLowerCase()
      if (!DEVICE_ID.test(id)) return
      const was = Object.prototype.hasOwnProperty.call(held.devices, id) ? held.devices[id] : undefined
      if (was !== undefined && now() - was.at < RENEW_MS) return
      write({ ...held, devices: { ...held.devices, [id]: { at: now() } } })
    },
    unmark(deviceId) {
      const id = deviceId.toLowerCase()
      if (!Object.prototype.hasOwnProperty.call(held.devices, id)) return
      write({ ...held, devices: Object.fromEntries(Object.entries(held.devices).filter(([known]) => known !== id)) })
    },
    marked: () => Object.keys(held.devices),
    sealedOnly: () => held.sealedOnly,
    setSealedOnly: (on) => write({ ...held, sealedOnly: on }),
    clearDevices: () => write({ ...held, devices: {} })
  }
}

/**
 * THE ONE PLAIN CALL SEALED ONLY LETS THROUGH: a watch's claim (watch-routes.ts · handleWatchClaim).
 *
 * A watch seals in device mode, with the Mac's key, and that key reaches it only in the claim's
 * answer. Refused in the clear, a watch could never pair through the relay while the switch is on,
 * and could never be sealed at all (owner 2026-11-25). Nothing it hands out stays open to the relay:
 *   the code      minted on this Mac, spent by the claim, single use;
 *   the token     refused in the clear on the relay line while sealed only is on, and traded inside
 *                 the watch's own sealed session for one the relay never saw (handleWatchRekey);
 *   the key       believed only once the owner sees the same six words on the watch and here, so a
 *                 key swapped on its way gives other words and is dropped.
 * Every other route stays refused; a GET, or any other path, is not the claim.
 */
export function passesSealedOnly(method: string | undefined, pathname: string): boolean {
  return method === 'POST' && pathname === '/api/watch/claim'
}

/** What the page reads in a refusal: the registry passes back no header of ours, so it is in the body. */
export const SEALED_ONLY_ERROR = 'sealed-only'
