import { updateAvailable } from './preset-manifest'
import type { KeyRotation } from './preset-rotation'

/**
 * DOCK CHIP FAMILY (marketplace §8) — the third chip group in the TERMINAL row,
 * after the harness presets (CLAUDE CODE · CODEX · OPENCODE · PI · SHELL) and
 * the saved roles. Same chip grammar, one new badge state.
 *
 * This module is the view MODEL only: kinds, badges and what a click means.
 * The visuals are Fresco's. Keeping the decision here means the dock, the
 * gate sheet and the eval gates all read one answer instead of three.
 */

/** A preset as the buyer holds it. */
export interface InstalledPreset {
  id: string
  name: string
  /** The version installed on this machine. */
  version: number
  /** Harness presets of its members, in canvas order — the sprite stack. */
  members: string[]
  /** False → gated: bought-but-unpaid, unauthenticated, or not licensed. */
  entitled: boolean
  /** Registry version from the last HEAD; undefined until one has answered. */
  headVersion?: number
  /**
   * R20: the registry now signs this preset with a key the client did not pin,
   * and the client refused it. Present until the buyer trusts the new key.
   */
  keyChanged?: KeyRotation
}

export type ChipBadge = 'none' | 'lock' | 'key-changed' | 'update'

export interface PresetChip {
  id: string
  label: string
  /** Single agent → one sprite; team → a stack. */
  kind: 'single' | 'team'
  sprites: string[]
  badge: ChipBadge
  /** Present only with an update badge — the sheet names the exact version. */
  headVersion?: number
}

export function presetChips(installed: readonly InstalledPreset[]): PresetChip[] {
  return installed.map((p) => {
    const hasUpdate = updateAvailable(p.version, p.headVersion ?? null)
    // Three states, ranked by which problem is nearest.
    //
    // The lock outranks everything: a gated preset cannot be updated into
    // either, so leading with "v3 available" on something the buyer cannot run
    // reads as a bug rather than an offer.
    //
    // KEY CHANGED outranks the update, and this one is R20's whole point. A
    // rotated preset will REFUSE the update it is advertising, so an update
    // badge here offers a click that cannot succeed. Replacing it also keeps
    // the rotation visible for as long as it is unresolved — the silent
    // failure the ruling exists to prevent is exactly a badge that never
    // arrives with nothing on screen to say why.
    const badge: ChipBadge = !p.entitled
      ? 'lock'
      : p.keyChanged !== undefined
        ? 'key-changed'
        : hasUpdate
          ? 'update'
          : 'none'
    return {
      id: p.id,
      // No version in the label — it lives on the badge and in the sheet.
      // Putting it here would re-flow the whole row on every update.
      label: p.name,
      kind: p.members.length > 1 ? 'team' : 'single',
      sprites: p.members,
      badge,
      ...(badge === 'update' ? { headVersion: p.headVersion } : {})
    }
  })
}

/**
 * R2: an owned chip ARMS placement and the canvas click is the aimed confirm —
 * no dialog, not even for a team paste, because the click that says where is
 * already the click that says yes. A locked chip opens the gate sheet instead;
 * the chip IS the gate's UI, so 401, 402 and 403 all arrive through it.
 *
 * An available update never blocks placing: it is an offer, and a buyer who
 * wants the version they already have should not have to dismiss anything.
 *
 * NOR DOES A ROTATION. "Your installed version keeps working. Nothing changed
 * on your canvas" is the sheet's first promise, and a KEY CHANGED chip that
 * stopped placing would make it a lie the buyer discovers by clicking.
 */
export function chipAction(chip: PresetChip): 'place' | 'gate' {
  return chip.badge === 'lock' ? 'gate' : 'place'
}

/**
 * What a click on the BADGE opens, as opposed to a click on the chip.
 *
 * R20 needs this to exist. "Surface it once" means once as a sheet, never once
 * as a fact — so after the rotation sheet is dismissed the badge is the only
 * route back to the decision, and a badge that is merely decorative would leave
 * the buyer with a permanent mark and no way to act on it.
 */
export function chipBadgeAction(chip: PresetChip): 'none' | 'gate' | 'rotation' | 'update' {
  switch (chip.badge) {
    case 'lock':
      return 'gate'
    case 'key-changed':
      return 'rotation'
    case 'update':
      return 'update'
    default:
      return 'none'
  }
}

/**
 * R3: the update check runs when the dock OPENS, not on a timer — a background
 * poll would spend requests on a dock nobody is looking at, and the answer is
 * only ever acted on while it is open.
 *
 * Returns the presets still unanswered this open, so re-rendering the dock does
 * not re-ask for ones already checked. A HEAD by version is the whole request.
 */
export function presetsNeedingUpdateCheck(installed: readonly InstalledPreset[]): string[] {
  return installed.filter((p) => p.headVersion === undefined).map((p) => p.id)
}
