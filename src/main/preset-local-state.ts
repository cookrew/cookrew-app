import { readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './turn-annotations'
import type { KeyRotation } from '../shared/preset-rotation'

/**
 * install.json — LOCAL state about an installed preset.
 *
 * Everything here is something THIS MACHINE decided, never something the author
 * signed: the gate's last word on entitlement, a rotation the client refused,
 * and a key the buyer chose to trust. It sits beside manifest.json and team.json
 * precisely so it can be rewritten without touching signed bytes.
 *
 * One file rather than three. Rotation, trust and entitlement all get written on
 * different occasions, and separate files would mean a rotation write racing an
 * entitlement write with no way to reconcile them — so every write is a
 * read-modify-write of the whole object, and a caller only ever names the field
 * it means to change.
 */
export interface PresetLocalState {
  /**
   * Cache of the gate's last word. Absent means owned. NEVER authority: a 403
   * overrides whatever is written here, and a local `true` is not a licence.
   */
  entitled?: boolean
  /** R20: a differently-signed version the client refused. */
  rotation?: KeyRotation
  /**
   * A key the buyer accepted for FUTURE versions of this preset. The key that
   * signed the installed bytes stays in author.pub — trusting a new key must
   * not invalidate the version already running.
   *
   * H2's boundary applies unchanged: an attacker who can write this directory
   * can write this field and pre-answer a decision R20 puts in front of a
   * person. That is the same attack as rewriting author.pub, not a new one, and
   * it is pinned as an accepted limitation in tests/preset-security.test.ts.
   */
  trustedKeyId?: string
}

const FILE = 'install.json'

/**
 * Read local state. A missing, unreadable or malformed file is EMPTY state, not
 * an error: this file is a cache, and losing it must cost the buyer a badge,
 * never the preset.
 */
export function readLocalState(dir: string): PresetLocalState {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, FILE), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    return raw as PresetLocalState
  } catch {
    return {}
  }
}

/**
 * Merge a patch into local state. `undefined` in the patch means "leave alone";
 * to clear a field, pass null — spelled out because "clear the rotation" and
 * "do not touch the rotation" are both things callers need and an optional
 * property alone cannot say which is meant.
 */
export type LocalStatePatch = {
  [K in keyof PresetLocalState]?: PresetLocalState[K] | null
}

export function writeLocalState(dir: string, patch: LocalStatePatch): PresetLocalState {
  const next = Object.entries(patch).reduce<PresetLocalState>((state, [key, value]) => {
    if (value === undefined) return state
    if (value === null) {
      const { [key as keyof PresetLocalState]: _cleared, ...rest } = state
      void _cleared
      return rest
    }
    return { ...state, [key]: value }
  }, readLocalState(dir))
  writeFileAtomic(path.join(dir, FILE), JSON.stringify(next, null, 2))
  return next
}
