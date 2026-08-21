/**
 * AUTHOR KEY ROTATION (R20) — the client half.
 *
 * The registry enforces TOFU across a lineage and records a countersigned
 * rotation in the transparency log (P2-A3). None of that is what keeps a buyer
 * safe: per A5 the boundary is the key each CLIENT pinned at install, which is
 * why an installed Cookrew refuses a differently-signed update even when the
 * registry is perfectly happy with it.
 *
 * A refusal the buyer never sees is the failure mode this ruling exists to
 * prevent: the update badge would simply never arrive, and the preset would be
 * permanently un-updatable for no visible reason. So the refusal is SURFACED —
 * once as a sheet, and then as a standing chip state until the buyer decides.
 *
 * Pure decisions only: no fs, no crypto. main persists it, the renderer draws
 * it, and both read the same answer from here.
 */

/** What the client knows about a rotation it has refused. Local state. */
export interface KeyRotation {
  /** The key this install is pinned to — the sheet's "previously signed by". */
  oldKeyId: string
  /** The key the registry now signs with. Refused until the buyer accepts it. */
  newKeyId: string
  /** When the client learned of it, epoch ms. The sheet shows a date (§7). */
  at: number
  /**
   * R20's "once" — the sheet has been raised and dismissed. Never a reason to
   * FORGET the rotation: once as a sheet, never once as a fact.
   */
  sheetSeen: boolean
}

/**
 * Whether to raise the sheet. Called where a buyer's own click already landed
 * (R24: a background check may set the badge, never open a sheet).
 */
export function shouldRaiseRotationSheet(rotation: KeyRotation | null | undefined): boolean {
  return rotation !== null && rotation !== undefined && !rotation.sheetSeen
}

/**
 * What the rotation sheet renders. R14: tokens, counts and ids — no prose. The
 * wording lives in shared/marketplace-copy.ts and is applied by the renderer,
 * so this shape can be fixtured without freezing a single word of Velvet's.
 */
export interface RotationSheetPayload {
  presetId: string
  presetName: string
  /** The author's handle, as the manifest they signed claims it. */
  authorHandle: string
  /** The version the buyer is running — the one "Keep v{current}" preserves. */
  currentVersion: number
  oldKeyId: string
  newKeyId: string
  at: number
  /** The transparency-log records for THIS preset — evidence, not assurance. */
  logUrl: string
}

/**
 * The log link. Scoped to the preset on purpose: a link that dropped the buyer
 * into every record the registry ever wrote would be technically honest and
 * practically useless, and "verify this yourself" has to mean something a
 * person can actually do.
 */
export function transparencyLogUrl(registryBase: string, presetId: string): string {
  const base = registryBase.endsWith('/') ? registryBase.slice(0, -1) : registryBase
  return `${base}/v1/log?preset=${encodeURIComponent(presetId)}`
}

export function rotationSheetPayload(input: {
  presetId: string
  presetName: string
  authorHandle: string
  currentVersion: number
  rotation: KeyRotation
  registryBase: string
}): RotationSheetPayload {
  return {
    presetId: input.presetId,
    presetName: input.presetName,
    authorHandle: input.authorHandle,
    currentVersion: input.currentVersion,
    oldKeyId: input.rotation.oldKeyId,
    newKeyId: input.rotation.newKeyId,
    at: input.rotation.at,
    logUrl: transparencyLogUrl(input.registryBase, input.presetId)
  }
}
