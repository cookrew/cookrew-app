import type { SealRecord, SealSession } from '../canvas-seal'
import { SEAL_WINDOW } from '../canvas-seal-wire'
import { concat, hkdf, u64, u8, utf8, type Bytes } from './bytes'
import { EPOCH_RECORDS, RECORD_MAX, SEAL2_LABEL, SEQ_LIMIT } from './spec'

/**
 * COOKREW-SEAL/2 RECORDS (spec.ts §3): AES-256-GCM per direction, a key per
 * epoch of 2^16 records, the direction and number bound in as associated data.
 *
 * The session has v1's shape (canvas-seal.ts · SealSession), so v1's record
 * reader and inbox carry it unchanged: the inbox is where replay and reorder
 * are stopped, and it only ever opens a number it has not delivered.
 */

const TAG_BITS = 128
const NONCE_BYTES = 12

export type Direction = 'toResponder' | 'toInitiator'
const DIRECTION_BYTE: Record<Direction, number> = { toResponder: 1, toInitiator: 2 }

export interface Seal2Session extends SealSession {
  readonly version: 2
}

interface EpochKey {
  readonly key: CryptoKey
  readonly iv: Bytes
}

export const nextEpochSecret = (secret: Uint8Array): Promise<Bytes> => hkdf(secret, new Uint8Array(0), `${SEAL2_LABEL} next`, 32)

export async function epochKeyBytes(secret: Uint8Array): Promise<{ key: Bytes; iv: Bytes }> {
  const none = new Uint8Array(0)
  return { key: await hkdf(secret, none, `${SEAL2_LABEL} key`, 32), iv: await hkdf(secret, none, `${SEAL2_LABEL} iv`, NONCE_BYTES) }
}

async function epochKey(secret: Uint8Array): Promise<EpochKey> {
  const { key, iv } = await epochKeyBytes(secret)
  return { key: await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']), iv }
}

const nonceOf = (iv: Bytes, seq: number): Bytes => {
  const counter = concat(new Uint8Array(4), u64(seq))
  return Uint8Array.from(iv, (byte, at) => byte ^ counter[at]) as Bytes
}

const aadOf = (direction: Direction, seq: number): Bytes => concat(utf8(SEAL2_LABEL), u8(DIRECTION_BYTE[direction]), u64(seq))

/**
 * One direction's keys, walked forward. Secrets behind `floor` are forgotten:
 * `floor` only rises, so nothing can ask for them again.
 */
function createKeyChain(first: Uint8Array) {
  let floor = 0
  let floorSecret: Bytes = concat(first)
  const keys = new Map<number, Promise<EpochKey>>()

  const forgetBelow = async (epoch: number): Promise<void> => {
    while (floor < epoch) {
      keys.delete(floor)
      floorSecret = await nextEpochSecret(floorSecret)
      floor += 1
    }
  }

  // One walk at a time: two callers racing must not both step the floor.
  let walking: Promise<unknown> = Promise.resolve()
  const at = (epoch: number): Promise<EpochKey | null> => {
    const result = walking.then(async () => {
      if (epoch < floor) return null
      const held = keys.get(epoch)
      if (held) return held
      let secret = floorSecret
      for (let step = floor; step < epoch; step += 1) secret = await nextEpochSecret(secret)
      const made = epochKey(secret)
      keys.set(epoch, made)
      return made
    })
    walking = result.catch(() => undefined)
    return result
  }

  const advance = (epoch: number): Promise<void> => {
    const result = walking.then(() => forgetBelow(epoch))
    walking = result.catch(() => undefined)
    return result
  }

  return { at, advance }
}

export function createSeal2Session(id: string, sendSecret: Uint8Array, openSecret: Uint8Array, sends: Direction): Seal2Session {
  const opens: Direction = sends === 'toResponder' ? 'toInitiator' : 'toResponder'
  const sendChain = createKeyChain(sendSecret)
  const openChain = createKeyChain(openSecret)
  let next = 0
  let highestOpened = -1

  return {
    id,
    version: 2,
    async seal(plain) {
      if (plain.length > RECORD_MAX) throw new Error('This record is too large')
      if (next >= SEQ_LIMIT) throw new Error('This session is used up')
      // Taken before the first await: the order asked is the order numbered.
      const seq = next
      next += 1
      const epoch = Math.floor(seq / EPOCH_RECORDS)
      // Sent in order, so nothing behind this epoch is ever sealed again.
      await sendChain.advance(epoch)
      const key = await sendChain.at(epoch)
      if (key === null) throw new Error('This epoch is gone')
      const box = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceOf(key.iv, seq), additionalData: aadOf(sends, seq), tagLength: TAG_BITS }, key.key, plain as BufferSource)
      return { seq, box: new Uint8Array(box) }
    },
    async open({ seq, box }: SealRecord) {
      if (!Number.isSafeInteger(seq) || seq < 0 || seq >= SEQ_LIMIT) return null
      const epoch = Math.floor(seq / EPOCH_RECORDS)
      const key = await openChain.at(epoch)
      if (key === null) return null
      let plain: Uint8Array
      try {
        plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonceOf(key.iv, seq), additionalData: aadOf(opens, seq), tagLength: TAG_BITS }, key.key, box as BufferSource))
      } catch {
        return null
      }
      // The inbox opens nothing more than its window below the highest it opened: older epochs can go.
      if (seq > highestOpened) {
        highestOpened = seq
        await openChain.advance(Math.floor(Math.max(0, seq - SEAL_WINDOW) / EPOCH_RECORDS))
      }
      return plain
    }
  }
}
