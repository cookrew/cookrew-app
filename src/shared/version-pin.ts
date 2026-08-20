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

/**
 * CONTRACT VERSION. v1 anchored pins in transcript-line space
 * (scrollLine/scrollBase). v2 (ruling R17) anchors them in RENDER-POSITION
 * space, because that is the space the rail actually lays rows out in. A rig
 * reading a fixture checks this to know which shape it holds.
 */
export const PIN_CONTRACT_VERSION = 2

/** Persisted form. */
export interface VersionPinRecord {
  /** 1-based, monotonic, never reused. V1, V2, … */
  version: number
  /**
   * The checkpoint IDENTITY (T-number) the pin was cut at. This is what the
   * pin means; where it lands is derived from the rows actually drawn.
   */
  atIndex: number
  /**
   * tmux history_size at cut time. Kept because it is what a JUMP needs — it
   * is NOT the rail anchor. Anchoring on it was the v1 bug: line space and
   * render space have different denominators and drift apart.
   */
  scrollLine: number
  /** Wall clock of the cut. */
  cutAt: number
  /** Content address of the manifest published from this pin, when published. */
  manifestId?: string
}

/** Rendered form: what the rail places, derived fresh against the drawn rows. */
export interface VersionPinAnchor {
  version: number
  /** 0 = rail top. Render-position space, the same one the focus tab uses. */
  frac: number
}

/** A row as the rail actually lays it out — identity plus array order. */
export interface RailRow {
  index: number
}

/**
 * A pin's position on the rail: WHERE ITS ROW IS DRAWN.
 *
 * R17. The rail carried two denominators. The focus tab anchors at
 * `rows.findIndex(r => r.index === here) / rows.length` — array position — while
 * trace markers used `afterIndex / lastIndex` — turn number. Those agree only
 * on a contiguous ledger, where `rows[i].index === i + 1`. On the 19-of-125 real
 * ledgers that are not (array position 113 holding T113 while lastIndex is 124),
 * they drift, and a marker anchored the second way lands where a turn NUMBER
 * implies rather than on a drawn row.
 *
 * The canonical space is therefore the one the rows are actually laid out in,
 * and this matches the focus tab's formula EXACTLY — `rows.length` as the
 * denominator, not `rows.length - 1`. That looks like an off-by-one and is not:
 * a "cleaner" denominator would put a pin half a row away from the focus tab
 * for the same checkpoint, which is precisely the alignment F6 gates.
 *
 * Null when the pin's identity is not among the drawn rows. It is omitted
 * rather than clamped to the nearest row: R8's rule that a wrong version is
 * worse than an absent one applies to position too, and a V1 shown against T5
 * because the ledger starts at T5 is a wrong version.
 */
export function pinFraction(atIndex: number, rows: readonly RailRow[]): number | null {
  if (rows.length === 0) return null
  const at = rows.findIndex((r) => r.index === atIndex)
  if (at < 0) return null
  return at / rows.length
}

/**
 * The pins a rail should draw, ordered by version. A pin whose checkpoint is
 * not drawn is dropped, never guessed onto the rail.
 */
export function pinAnchors(
  records: readonly VersionPinRecord[],
  rows: readonly RailRow[]
): VersionPinAnchor[] {
  const out: VersionPinAnchor[] = []
  for (const r of [...records].sort((a, b) => a.version - b.version)) {
    const frac = pinFraction(r.atIndex, rows)
    if (frac !== null) out.push({ version: r.version, frac })
  }
  return out
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
  /** The checkpoint identity being pinned — what the pin MEANS. */
  atIndex: number
  /** Transcript coordinate for jumps; not the rail anchor (R17). */
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
    atIndex: options.atIndex,
    scrollLine: options.scrollLine,
    cutAt: options.cutAt,
    ...(options.manifestId !== undefined ? { manifestId: options.manifestId } : {})
  }
}

/** One member entering an atomic team cut. */
export interface TeamCutMember {
  terminalId: string
  pins: readonly VersionPinRecord[]
  /** The checkpoint identity this member is pinned at. */
  atIndex: number
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
        atIndex: m.atIndex,
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
  /** The rows as drawn, in render order — the canonical space (R17). */
  rows: readonly RailRow[]
  /** Trace boundaries by the checkpoint they follow. */
  traceMarkers: readonly { kind: string; afterIndex: number }[]
  pins: readonly VersionPinRecord[]
}

/**
 * Every marker the rail draws, in one ordered list, ALL THREE CLASSES IN ONE
 * SPACE — render position. That is the R17 fix at its widest: the drift Fresco
 * found existed because turn rows and trace markers were placed by two
 * different formulas, so this places them by one, and pins join it rather than
 * adding a third.
 *
 * A marker whose checkpoint is not among the drawn rows is dropped — it has no
 * row to land on, and inventing a position for it is the exact failure the
 * ruling names.
 */
export function railMarkers(input: RailMarkerInput): RailMarker[] {
  const { rows } = input
  if (rows.length === 0) return []
  const out: RailMarker[] = []
  rows.forEach((row, at) => {
    out.push({ class: 'turn', frac: at / rows.length, index: row.index })
  })
  for (const m of input.traceMarkers) {
    const frac = pinFraction(m.afterIndex, rows)
    if (frac === null) continue
    out.push({ class: 'trace', frac, kind: m.kind, afterIndex: m.afterIndex })
  }
  for (const p of input.pins) {
    const frac = pinFraction(p.atIndex, rows)
    if (frac === null) continue
    const label = pinLabel(p.version)
    out.push({
      class: 'pin',
      frac,
      version: p.version,
      label: label.text,
      labelled: label.labelled
    })
  }
  return out.sort((a, b) => a.frac - b.frac)
}
