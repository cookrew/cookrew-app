import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-file'

/**
 * WHICH OF THE ACCOUNT'S DESKTOPS THIS ONE WILL SEAL WITH (seal2 device mode).
 *
 *   "account" (the default): any desktop cookrew.dev lists for this account.
 *              The registry is trusted to say which machines are the owner's.
 *   "pinned":  only desktops whose pair words (seal2/handshake.ts · pairWords)
 *              the owner compared on both screens and confirmed here. A desktop
 *              the registry adds later is not dialled and not let in until
 *              its words are compared too.
 *
 * Once a pair is pinned, its device id IS its key (a device id is a one-way
 * function of the key), so a pin cannot be satisfied by another key.
 */

export type SealPinPolicy = 'account' | 'pinned'

export interface SealPinStore {
  policy(): SealPinPolicy
  setPolicy(policy: SealPinPolicy): void
  pinned(): string[]
  pin(deviceId: string): void
  unpin(deviceId: string): void
  /** May this device be dialled or let in, as far as pins go? The account listing is checked separately. */
  allows(deviceId: string): boolean
}

interface PinFile {
  readonly policy: SealPinPolicy
  readonly pins: Readonly<Record<string, { readonly at: number }>>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const EMPTY: PinFile = { policy: 'account', pins: {} }

/** A file that cannot be read means PINNED with nothing pinned: an unreadable choice fails closed. */
function readPins(file: string): PinFile {
  if (!existsSync(file)) return EMPTY
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PinFile>
    const policy = parsed.policy === 'pinned' || parsed.policy === 'account' ? parsed.policy : null
    const pins = typeof parsed.pins === 'object' && parsed.pins !== null ? parsed.pins : null
    if (policy === null || pins === null) return { policy: 'pinned', pins: {} }
    return { policy, pins: Object.fromEntries(Object.entries(pins).filter(([id]) => UUID.test(id))) }
  } catch {
    return { policy: 'pinned', pins: {} }
  }
}

export function createSealPinStore(file: string, now: () => number = Date.now): SealPinStore {
  const write = (next: PinFile): void => writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  const checked = (deviceId: string): string => {
    const id = deviceId.toLowerCase()
    if (!UUID.test(id)) throw new Error('Not a device id')
    return id
  }
  return {
    policy: () => readPins(file).policy,
    setPolicy: (policy) => write({ ...readPins(file), policy }),
    pinned: () => Object.keys(readPins(file).pins),
    pin(deviceId) {
      const held = readPins(file)
      write({ ...held, pins: { ...held.pins, [checked(deviceId)]: { at: now() } } })
    },
    unpin(deviceId) {
      const held = readPins(file)
      const id = checked(deviceId)
      write({ ...held, pins: Object.fromEntries(Object.entries(held.pins).filter(([pinned]) => pinned !== id)) })
    },
    allows(deviceId) {
      const held = readPins(file)
      return held.policy === 'account' || Object.prototype.hasOwnProperty.call(held.pins, deviceId.toLowerCase())
    }
  }
}
