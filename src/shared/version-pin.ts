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

export interface CutOptions {
  scrollLine: number
  cutAt: number
  manifestId?: string
}

/**
 * Cut a version. Returns a NEW record and leaves the pin list alone — the whole
 * §10 invariant is that producing a version never writes back into what it was
 * produced from, and a cut that appended in place would be the first violation.
 * An unpublished cut omits `manifestId` rather than storing null, so "was this
 * published" is a presence question with one answer.
 */
export function cutVersionPin(
  records: readonly VersionPinRecord[],
  options: CutOptions
): VersionPinRecord {
  return {
    version: nextVersion(records),
    scrollLine: options.scrollLine,
    cutAt: options.cutAt,
    ...(options.manifestId !== undefined ? { manifestId: options.manifestId } : {})
  }
}

/** One member entering an atomic team cut. */
export interface TeamCutMember {
  terminalId: string
  pins: readonly VersionPinRecord[]
  /** This member's own transcript point at the moment of the cut. */
  scrollLine: number
}

export interface TeamVersionCut {
  version: number
  members: { terminalId: string; pin: VersionPinRecord }[]
}

/**
 * Cut a team version ATOMICALLY (§10): a team version is the tuple of its
 * members' pins, so every member takes the SAME number even though each pins at
 * its own transcript point. The number is one past the highest ANY member has
 * reached — a member that lagged must not reuse a number a teammate already
 * published under the same team version, or the tuple stops addressing one
 * thing.
 *
 * Throws on an empty team: a version nothing carries is not a version, and
 * returning one would let a caller record an update that installs nothing.
 */
export function cutTeamVersion(
  members: readonly TeamCutMember[],
  options: { cutAt: number; manifestId?: string }
): TeamVersionCut {
  if (members.length === 0) throw new Error('cannot cut a team version for an empty team')
  let version = 1
  for (const m of members) {
    const next = nextVersion(m.pins)
    if (next > version) version = next
  }
  return {
    version,
    members: members.map((m) => ({
      terminalId: m.terminalId,
      pin: {
        version,
        scrollLine: m.scrollLine,
        cutAt: options.cutAt,
        ...(options.manifestId !== undefined ? { manifestId: options.manifestId } : {})
      }
    }))
  }
}

/**
 * One rail marker, tagged with its class. Pins are the THIRD class beside turn
 * diamonds and trace boundaries — distinct in kind, identical in anchor space,
 * which is what lets the rail render all three in one pass and the strict-eval
 * gates apply to pins with no special case.
 */
export type RailMarker =
  | { class: 'turn'; frac: number; index: number }
  | { class: 'trace'; frac: number; kind: string; afterIndex: number }
  | { class: 'pin'; frac: number; version: number; label: string; labelled: boolean }

export interface RailMarkerInput {
  scrollBase: number | null
  turns: readonly { index: number; scrollLine: number }[]
  traceMarkers: readonly { kind: string; afterIndex: number; scrollLine: number }[]
  pins: readonly VersionPinRecord[]
}

/**
 * Every marker the rail draws, in one ordered list. Oldest first so a renderer
 * walks it in a single pass. Empty without a scroll base — the alternative is
 * stacking every marker at the live bottom, which reads as real data and is not.
 */
export function railMarkers(input: RailMarkerInput): RailMarker[] {
  const base = input.scrollBase
  if (base === null || base <= 0) return []
  const out: RailMarker[] = [
    ...input.turns.map((t) => ({
      class: 'turn' as const,
      frac: pinFraction(t.scrollLine, base),
      index: t.index
    })),
    ...input.traceMarkers.map((m) => ({
      class: 'trace' as const,
      frac: pinFraction(m.scrollLine, base),
      kind: m.kind,
      afterIndex: m.afterIndex
    })),
    ...input.pins.map((p) => {
      const label = pinLabel(p.version)
      return {
        class: 'pin' as const,
        frac: pinFraction(p.scrollLine, base),
        version: p.version,
        label: label.text,
        labelled: label.labelled
      }
    })
  ]
  return out.sort((a, b) => a.frac - b.frac)
}
