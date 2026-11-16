import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AdmittedDevice } from './admitted-devices'

/**
 * PHONES FORGOTTEN ON THIS MAC (owner 2026-11-16: a trusted phone enters every
 * machine of the account until it is revoked).
 *
 * A trusted phone holds a pass it can renew with no proof, so forgetting it in
 * Devices would mean nothing: it would walk back in with its next pass. So the
 * forgetting is kept here, with the moment the phone was trusted (`since`, from
 * the pass it was admitted on). A pass no newer than that is turned away; a
 * phone that joined the account again with a new phone's code carries a later
 * `since` and comes back. Two clocks are never compared: both numbers are the
 * registry's.
 *
 * Unlike a forgotten machine (machine-keys.ts · RefusedMachines), nothing here
 * is for good: the owner who scans a new code means it.
 */

export interface RefusedPhones {
  /** Is this pass (its phone, its trusted moment) one this Mac forgot? */
  readonly refuses: (deviceId: string, since: number) => boolean
  /** Forget this phone here, as trusted at `since`. */
  readonly add: (deviceId: string, since: number) => void
}

/**
 * WHAT FORGETTING A DEVICE HERE KEEPS OUT, as a trusted moment: passes no newer
 * than it. Any device but a machine (which has its own list, kept for good): a
 * trusted phone may have last come in on an ordinary proved pass, and that row
 * names no moment — then everything up to now is kept out, and a phone that
 * joins again later carries a later one. Null: nothing to keep out here.
 */
export function refusalOnForget(row: AdmittedDevice | undefined, now: number): number | null {
  if (row === undefined || row.via === 'machine') return null
  return row.via === 'phone' && row.since !== undefined ? row.since : now
}

/** A bound on a file a button can grow: far above a person's phones. */
const REFUSED_MAX = 256

type Held = Record<string, number>

const isHeld = (value: unknown): value is Held =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every((at) => typeof at === 'number' && Number.isFinite(at))

export function createRefusedPhones(file: string): RefusedPhones {
  const read = (): Held => {
    try {
      if (!existsSync(file)) return {}
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (isHeld(parsed)) return parsed
      console.error('The forgotten phones file is not a list of phones; it refuses nobody.')
      return {}
    } catch (error) {
      // Unreadable refuses nobody: the revoked list at cookrew.dev is still the account's word. Said, not silent.
      console.error('The forgotten phones could not be read:', error)
      return {}
    }
  }
  const write = (held: Held): void => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.tmp`
    writeFileSync(temp, `${JSON.stringify(held)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(temp, 0o600)
    try {
      renameSync(temp, file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
    chmodSync(file, 0o600)
  }
  return {
    refuses: (deviceId, since) => {
      const at = read()[deviceId.toLowerCase()]
      return at !== undefined && since <= at
    },
    add: (deviceId, since) => {
      const id = deviceId.toLowerCase()
      const held = read()
      const rest = Object.entries(held).filter(([key]) => key !== id)
      // The oldest forgettings go first; the one being written never does.
      const kept = rest.slice(Math.max(0, rest.length - (REFUSED_MAX - 1)))
      write({ ...Object.fromEntries(kept), [id]: Math.max(since, held[id] ?? since) })
    }
  }
}
