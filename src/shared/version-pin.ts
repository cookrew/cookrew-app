/**
 * VERSION PINS (marketplace §10) — the data contract, published ahead of the
 * rail visual so Fresco, Magpie and the M1 installer all build against one
 * shape. Nothing here renders; the marker is Fresco's.
 *
 * The invariant the whole feature rests on: exporting or calling an agent never
 * mutates its original session. Every import and every remote call forks a copy
 * of the transcript, and that fork is a VERSION — v1, v2, … — pinned at the
 * transcript point it was cut from.
 *
 * A pin is a THIRD marker class on the rail, beside turn diamonds and
 * compact/rewind checkpoints. It extends the rail's grammar and never forks it:
 * pins live in the same anchor space as ticks, so the existing strict-eval
 * gates (including F6's marker↔focused-tag Y-alignment) apply to them
 * unchanged.
 *
 * WHY THE STORED FORM IS A LINE AND THE RENDERED FORM IS A FRACTION.
 * `scrollLine` is Forge's monotonic coordinate — tmux history_size at the
 * moment the pin was cut. A fraction is that line measured against the CURRENT
 * history size, so it moves up the rail as the session grows, exactly like a
 * tick for the same content. Storing the fraction instead would freeze a pin at
 * the ratio it had when cut and slide it off its own transcript point after the
 * next turn. Pins are permanent, named and addressable; a pin that drifts is a
 * pin that lies.
 */

/** Persisted form. `scrollLine` shares TurnRecord.scrollLine's coordinate. */
export interface VersionPinRecord {
  /** 1-based, monotonic, never reused. V1, V2, … */
  version: number
  /** tmux history_size at cut time — lines from the top of history. */
  scrollLine: number
  /** Wall clock of the cut. */
  cutAt: number
  /** Content address of the manifest published from this pin, when published. */
  manifestId?: string
}

/** Rendered form: what the rail places, derived fresh against the live base. */
export interface VersionPinAnchor {
  version: number
  /** 0 = oldest / rail top, 1 = live bottom. Same space as rail ticks. */
  frac: number
}

/**
 * A pin's position on the rail: its cut line measured against the live history
 * size. Deliberately the same formula as `markerFraction(scrollBase −
 * scrollLine, scrollBase)` so a pin and a tick for the same content land on the
 * same Y — which is what lets F6 apply to pins without a special case.
 *
 * Clamped, because scrollBase can shrink underneath an old pin (a session
 * cleared out from under it) and a pin must stay on the rail. No base to
 * measure against → 1 (the live bottom), matching markerFraction's default.
 */
export function pinFraction(scrollLine: number, scrollBase: number | null): number {
  if (scrollBase === null || scrollBase <= 0) return 1
  return Math.max(0, Math.min(1, scrollLine / scrollBase))
}

/**
 * The pins a rail should draw, ordered by version. Empty without a scroll base:
 * an unplaceable pin is omitted, never guessed onto the rail — R8's rule that a
 * wrong version is worse than an absent one applies to position too.
 */
export function pinAnchors(
  records: readonly VersionPinRecord[],
  scrollBase: number | null
): VersionPinAnchor[] {
  if (scrollBase === null || scrollBase <= 0) return []
  return [...records]
    .sort((a, b) => a.version - b.version)
    .map((r) => ({ version: r.version, frac: pinFraction(r.scrollLine, scrollBase) }))
}

/**
 * R8's label rule, published as data so the marker, the fan row and Magpie's
 * B2 assertion cannot disagree: V1–V9 keep the V, 10–99 show the bare number
 * (the V costs a character the marker cannot spare), and from 100 the marker
 * carries no label at all — the exact version belongs to the fan row, because a
 * truncated "12" standing for v123 is worse than no label.
 */
export function pinLabel(version: number): { text: string; labelled: boolean } {
  if (!Number.isInteger(version) || version < 1) return { text: '', labelled: false }
  if (version <= 9) return { text: `V${version}`, labelled: true }
  if (version <= 99) return { text: String(version), labelled: true }
  return { text: '', labelled: false }
}

/**
 * The next version to cut. Past the HIGHEST, not the count: versions are
 * addressable identity, so a deleted pin must never hand its number to a later
 * cut — that would alias two different transcripts under one name.
 */
export function nextVersion(records: readonly VersionPinRecord[]): number {
  let highest = 0
  for (const r of records) if (r.version > highest) highest = r.version
  return highest + 1
}
