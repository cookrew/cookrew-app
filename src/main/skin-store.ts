import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SKIN, isSkinId, skinFrom, type SkinId } from '../shared/skins'
import { writeFileAtomic } from './atomic-file'

/**
 * THE ACCOUNT'S SKIN, AS THIS MAC HOLDS IT (shared/skins.ts).
 *
 * The pick belongs to the account: it is kept in the account's profile at the
 * registry, so every Mac signed in to it wears the same one. This Mac keeps a
 * copy (~/.cookrew/skin.json), which is what its windows and its phones read:
 * the app draws with no network and no account, and a phone never asks the
 * registry anything.
 *
 * A pick here is saved here at once and sent to the account after. A pull
 * asks the account and takes its pick; an account that has none yet takes
 * this Mac's, so the first Mac to choose sets it for the rest. A pull that
 * crossed a pick made while it was asking is dropped: the newer word wins.
 */

export const skinPath = (home: string): string => path.join(home, '.cookrew', 'skin.json')

export interface SkinAccount {
  /** The account's pick; null when it has none; undefined when it cannot be asked (signed out, offline). */
  read(): Promise<SkinId | null | undefined>
  /** True when the account took it. */
  write(skin: SkinId): Promise<boolean>
}

export interface SkinStore {
  get(): SkinId
  /** A pick from a window or a phone; null when it is not a skin. */
  choose(input: unknown): SkinId | null
  /** Takes the account's pick, or gives it this Mac's when it has none. */
  pull(): Promise<SkinId>
  /** 'skin' (SkinId) on every change, whichever way it came. */
  readonly bus: EventEmitter
}

export function readSkin(file: string): SkinId {
  try {
    return skinFrom((JSON.parse(readFileSync(file, 'utf8')) as { skin?: unknown }).skin)
  } catch {
    return DEFAULT_SKIN
  }
}

export function createSkinStore({ file, account }: { readonly file: string; readonly account: SkinAccount }): SkinStore {
  const bus = new EventEmitter()
  let current = readSkin(file)
  let picks = 0

  const take = (skin: SkinId): boolean => {
    if (skin === current) return false
    current = skin
    try {
      writeFileAtomic(file, `${JSON.stringify({ skin })}\n`)
    } catch {
      // Worn for this run all the same; the account still has it.
    }
    bus.emit('skin', skin)
    return true
  }

  const send = (skin: SkinId): void => {
    void account.write(skin).catch(() => false)
  }

  return {
    bus,
    get: () => current,
    choose(input) {
      if (!isSkinId(input)) return null
      picks += 1
      if (take(input)) send(input)
      return current
    },
    async pull() {
      const asked = picks
      const held = await account.read().catch(() => undefined)
      if (asked !== picks || held === undefined) return current
      if (held === null) {
        if (current !== DEFAULT_SKIN) send(current)
        return current
      }
      take(held)
      return current
    }
  }
}
