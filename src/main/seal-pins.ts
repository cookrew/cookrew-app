import { existsSync, readFileSync, statSync } from 'node:fs'
import { writeFileAtomic } from './atomic-file'

/**
 * WHICH OF THE ACCOUNT'S DESKTOPS THIS ONE WILL SEAL WITH (seal2 device mode).
 *
 * Owner ruling 2026-11-19: the account listing works by default, and at FIRST
 * CONTACT with another desktop the owner is asked to compare six words on both
 * screens (seal2/handshake.ts · pairWords, the same on both). A compared pair is
 * PINNED. A pair the owner says does not match is BLOCKED: never dialled, never
 * let in, whatever the listing says.
 *
 *   "account" (the default): any desktop cookrew.dev lists for this account,
 *              unless blocked. The registry is trusted to say which machines
 *              are the owner's until the owner has compared.
 *   "pinned":  only pinned desktops (not offered in the app; the file may say so).
 *
 * A device id IS its key (a one-way function of it), so a pin cannot be met by
 * another key: "only that key from then on" holds by the id alone.
 */

export type SealPinPolicy = 'account' | 'pinned'

export interface SealPinStore {
  policy(): SealPinPolicy
  setPolicy(policy: SealPinPolicy): void
  pinned(): string[]
  pin(deviceId: string): void
  unpin(deviceId: string): void
  /** The owner said the words do not match: this desktop is refused both ways from now on. */
  block(deviceId: string): void
  /** Did the owner say this desktop's words do not match? Then it is refused on every lane (seal-blocked.ts). */
  blocks(deviceId: string): boolean
  /** Every desktop the owner said is not the same. */
  blocked(): string[]
  /** A sealed session with this desktop opened: true the first time, when its words wait for the owner. */
  contact(deviceId: string): boolean
  /** Desktops met and not yet compared (nor blocked, nor put off): their words wait for the owner. */
  waiting(): string[]
  /** "Later": not asked again until this app is next launched. */
  later(deviceId: string): void
  /** May this device be dialled or let in, as far as pins go? The account listing is checked separately. */
  allows(deviceId: string): boolean
}

type Stamps = Readonly<Record<string, { readonly at: number }>>

interface PinFile {
  readonly policy: SealPinPolicy
  readonly pins: Stamps
  readonly blocked: Stamps
  readonly seen: Stamps
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EMPTY: PinFile = { policy: 'account', pins: {}, blocked: {}, seen: {} }

const stamps = (value: unknown): Stamps =>
  typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value as Record<string, { at: number }>).filter(([id]) => UUID.test(id))) : {}

const has = (held: Stamps, id: string): boolean => Object.prototype.hasOwnProperty.call(held, id)

/** A file that cannot be read means PINNED with nothing pinned: an unreadable choice fails closed. */
function readPins(file: string): PinFile {
  if (!existsSync(file)) return EMPTY
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PinFile>
    const policy = parsed.policy === 'pinned' || parsed.policy === 'account' ? parsed.policy : null
    if (policy === null || typeof parsed.pins !== 'object' || parsed.pins === null) return { ...EMPTY, policy: 'pinned' }
    return { policy, pins: stamps(parsed.pins), blocked: stamps(parsed.blocked), seen: stamps(parsed.seen) }
  } catch {
    return { ...EMPTY, policy: 'pinned' }
  }
}

/** What says the file changed: read again only then, since `blocks` is asked on every request down the relay line. */
function stamp(file: string): string {
  try {
    const { mtimeMs, size, ino } = statSync(file)
    return `${mtimeMs}:${size}:${ino}`
  } catch {
    return 'none'
  }
}

export function createSealPinStore(file: string, now: () => number = Date.now): SealPinStore {
  // The file stays the truth (an owner may edit it by hand); only an unchanged file is not parsed again.
  let cached: { readonly stamp: string; readonly pins: PinFile } | null = null
  const current = (): PinFile => {
    const seen = stamp(file)
    if (cached === null || cached.stamp !== seen) cached = { stamp: seen, pins: readPins(file) }
    return cached.pins
  }
  const write = (next: PinFile): void => {
    cached = null
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  }
  /** Put off this launch only: asked again after a restart. */
  const putOff = new Set<string>()
  const checked = (deviceId: string): string => {
    const id = deviceId.toLowerCase()
    if (!UUID.test(id)) throw new Error('Not a device id')
    return id
  }
  const without = (held: Stamps, id: string): Stamps => Object.fromEntries(Object.entries(held).filter(([known]) => known !== id))
  return {
    policy: () => current().policy,
    setPolicy: (policy) => write({ ...current(), policy }),
    pinned: () => Object.keys(current().pins),
    pin(deviceId) {
      const held = current()
      const id = checked(deviceId)
      write({ ...held, pins: { ...held.pins, [id]: { at: now() } }, blocked: without(held.blocked, id) })
    },
    unpin(deviceId) {
      const held = current()
      write({ ...held, pins: without(held.pins, checked(deviceId)) })
    },
    block(deviceId) {
      const held = current()
      const id = checked(deviceId)
      write({ ...held, blocked: { ...held.blocked, [id]: { at: now() } }, pins: without(held.pins, id) })
    },
    contact(deviceId) {
      const id = deviceId.toLowerCase()
      if (!UUID.test(id)) return false
      const held = current()
      if (has(held.pins, id) || has(held.blocked, id) || has(held.seen, id)) return false
      write({ ...held, seen: { ...held.seen, [id]: { at: now() } } })
      return true
    },
    waiting() {
      const held = current()
      return Object.keys(held.seen).filter((id) => !has(held.pins, id) && !has(held.blocked, id) && !putOff.has(id))
    },
    later: (deviceId) => void putOff.add(deviceId.toLowerCase()),
    blocks: (deviceId) => has(current().blocked, deviceId.toLowerCase()),
    blocked: () => Object.keys(current().blocked),
    allows(deviceId) {
      const held = current()
      const id = deviceId.toLowerCase()
      if (has(held.blocked, id)) return false
      return held.policy === 'account' || has(held.pins, id)
    }
  }
}
