import { railAnchorTop } from './transcript'
import type { CheckpointRow } from './stream/stream-rows'

/**
 * Laying the reveal across the WHOLE range, T1 at the top to LIVE at the bottom.
 *
 * WHY THIS EXISTS
 * ---------------
 * The reveal used to be a fan of the ±12 rows either side of the focus. Measured
 * on a live agent that reads: 25 rows, T23…T47 out of 122, spanning 169% of the
 * bar — it overflows both ends of the rail and still reaches neither T1 nor LIVE.
 * So the rail claims to be a scrollbar over the whole conversation while showing
 * a window that never contains its own extremes.
 *
 * The fix is not "render all 122 rows": at 34px each they would overlap six deep
 * and the far ones would be unreadable. It is to lay as many as the bar can hold
 * WITHOUT overlap, sampled evenly across the full range, with the ends pinned —
 * the first row is T1, the last is the newest, and the focused row is always
 * among them (it is drawn separately, pinned to the marker, and must not be
 * duplicated underneath itself).
 *
 * Pure and unit-tested: the density rule is the whole contract with Fresco's
 * absolute-positioned `.cr-ckpt-list`, which reads `fraction` for each row's
 * inline `top`.
 */

/**
 * A row plus where along the bar it belongs (0 = oldest, 1 = the live tail).
 * `row: null` is the LIVE entry — the tail itself, which is not a checkpoint.
 */
export interface FilledRow {
  row: CheckpointRow | null
  fraction: number
}

/** The LIVE tail entry, as laid by fillRows. */
export const isLive = (entry: FilledRow): boolean => entry.row === null

/** Rail height in px a single row needs before neighbours start overlapping. */
export const ROW_HEIGHT = 34

/**
 * Inset at EACH end of the bar. Must match railAnchorTop, which lays fraction f
 * at `calc(16px + f * (100% - 32px))` — so the rows occupy `barHeight - 2 *
 * RAIL_INSET`, not the full height.
 */
export const RAIL_INSET = 16

/**
 * THE BAR'S DENOMINATOR: the WHOLE chain, not the page this client fetched
 * (D1, T5 QA 2026-09-07).
 *
 * Every fraction here used to be `arrayPosition / rows.length`, and `rows` is
 * the index page /stream/open answered with — the newest 100 of a 1,048-row
 * card. So the bar drew those hundred spread from T1 to LIVE while the count
 * badge, which already read `total`, said 1048: the rail claimed a range it
 * did not have and a scrub to the top landed on T949.
 *
 * The scale is the chain's length, and a row's place on the bar is its own
 * ORDINAL within it. Rows this client has not fetched are simply not drawn —
 * an honest gap, and the trigger that fills it (useStream.reach) is what makes
 * it temporary. Never below the newest ordinal loaded: a `total` that lags a
 * live append must not push the newest row past LIVE.
 */
export function railScale(rows: readonly CheckpointRow[], total?: number): number {
  const newest = rows[rows.length - 1]?.index ?? 0
  return Math.max(1, total ?? 0, newest, rows.length)
}

/**
 * Where one ordinal sits along the bar, 0 (T1) … 1 (the tail).
 *
 * `(index - 1) / scale` and not `index / scale`, because T1 anchors the top
 * and the newest checkpoint sits one slot short of LIVE — which is exactly
 * what `arrayPosition / rows.length` produced when everything was loaded, so
 * a fully-paged rail is laid out byte-for-byte as it was before this existed.
 */
export function railFraction(index: number, scale: number): number {
  return Math.max(0, Math.min(1, (index - 1) / Math.max(1, scale)))
}

/**
 * How many rows the bar can show at once.
 *
 * Over the USABLE span, not the full height. Dividing by barHeight overcounts
 * by two rows' worth of inset and packs them tighter than ROW_HEIGHT: at
 * H = 136 it asked for 4 rows across a 104px span — 26px apart for 34px rows.
 * That was survivable while rows were transparent; now that F5 makes them
 * opaque, overlapping rows CLIP each other.
 *
 * At least 2 — the two ends are the claim F3 makes, so a bar too short for more
 * still shows T1 and the newest.
 */
export function capacityFor(barHeight: number): number {
  return Math.max(2, Math.floor((barHeight - 2 * RAIL_INSET) / ROW_HEIGHT))
}

/**
 * `count` indices spread evenly across `length` items, ends included and no
 * duplicates. `[0 … length-1]` when everything fits.
 */
export function sampleIndices(length: number, count: number): number[] {
  if (length <= 0) return []
  if (length <= count) return Array.from({ length }, (_, i) => i)
  if (count <= 1) return [0]
  const step = (length - 1) / (count - 1)
  const picked = new Set<number>()
  for (let i = 0; i < count; i++) picked.add(Math.round(i * step))
  return [...picked].sort((a, b) => a - b)
}

/**
 * Everything laid along the bar: the sampled checkpoints, then LIVE at 1.
 *
 * ONE function owns the density rule, because splitting it is what broke it.
 * LIVE was placed by the component at fraction 1 while fillRows chose the
 * checkpoints, and neither knew about the other: the newest checkpoint sits at
 * (n-1)/n, so the gap to LIVE is 1/n of the span — 5.2px at n = 122 on a 669px
 * bar, against a 34px OPAQUE row. LIVE simply covered the newest checkpoint,
 * which is worse than the fan placement it replaced.
 *
 * FRACTIONS STAY at/n. A laid row keeps its true position in the drawn-row span
 * space R17/R19 unified across pins, ticks and the focus anchor; moving one to
 * make room would make it lie about where its checkpoint is. So the tail rows
 * that cannot be shown a row-height clear of LIVE are simply NOT LAID — the
 * same reason the other ~100 checkpoints are not laid. They stay reachable by
 * scrub, where the focused row renders them exactly on the marker.
 *
 * `focusedIndex` is EXCLUDED even when sampling picks it: the focused row is
 * rendered separately at the marker's own precise fraction, and drawing it
 * twice would put a second, subtly misaligned copy one pixel off the marker —
 * the exact failure F6 exists to catch.
 */
export function fillRows(
  rows: readonly CheckpointRow[],
  barHeight: number,
  focusedIndex: number | null,
  total?: number
): FilledRow[] {
  if (rows.length === 0) return []
  const usable = Math.max(1, barHeight - 2 * RAIL_INSET)
  const live: FilledRow = { row: null, fraction: 1 }
  // A bar with less than one row of span cannot show a checkpoint clear of the
  // tail at all, so the honest answer is the tail alone. Note this is the ONLY
  // no-checkpoint case: index 0 sits at fraction 0, a whole span away from
  // LIVE, so "the newest allowed index is 0" means one row, not none.
  if (usable < ROW_HEIGHT) return [live]
  const scale = railScale(rows, total)
  const fracAt = (at: number): number => railFraction(rows[at].index, scale)
  // The highest fraction a checkpoint may take and still clear LIVE by a row.
  const ceiling = 1 - ROW_HEIGHT / usable
  // …and the newest LOADED row that lands at or below it. Walked rather than
  // computed from rows.length: with the chain's scale a page of the newest
  // hundred can be entirely inside the tail's own row height, and then the
  // honest answer is LIVE alone until a page-back lands.
  let lastIndex = -1
  for (let at = 0; at < rows.length && fracAt(at) <= ceiling; at += 1) lastIndex = at
  if (lastIndex < 0) return [live]

  const span = fracAt(lastIndex)
  // LIVE consumes a slot, and the checkpoints only get the span below it.
  const room = Math.max(2, Math.floor((span * usable) / ROW_HEIGHT) + 1)
  const budget = Math.min(room, Math.max(2, capacityFor(barHeight) - 1))

  // Budget against the gap that actually happens, not the average one.
  //
  // sampleIndices rounds, so a fractional step puts SOME neighbouring picks
  // floor(step) apart rather than step: at step 1.5 the picks run 0, 2, 3, 5,
  // 6 … and every other pair is one index closer than the budget assumed. On a
  // 669px bar that overlapped for 71 of the 199 ledger sizes n = 2..200 —
  // worst n = 33 at 19.3px, and n = 30 gave 42.5, 42.5, 21.2, 42.5, so every
  // fourth pair collided. Rather than predict the rounding, lay the rows and
  // shrink until the smallest REAL gap clears a row; the loop is bounded by
  // the budget and runs on a scrub, not a frame.
  const picked = ((): number[] => {
    for (let count = budget; count >= 1; count--) {
      const candidate = sampleIndices(lastIndex + 1, count)
      const tops = [...candidate.map((i) => fracAt(i) * usable), usable]
      const tight = tops.slice(1).some((top, k) => top - tops[k] < ROW_HEIGHT)
      if (!tight) return candidate
    }
    return []
  })()

  const laid = picked
    .map((i) => ({ row: rows[i], fraction: fracAt(i) }))
    .filter((entry) => entry.row.index !== focusedIndex)
  return [...laid, live]
}

/**
 * F6 — THE HERE-MARKER AND THE FOCUSED ROW SIT ON THE SAME Y. ALWAYS.
 *
 * This gate has regressed before, and it regressed each time the same way:
 * two places computed a `top`, they agreed for the states anybody looked at,
 * and then a new state made them disagree by a pixel. So the two tops are
 * produced HERE, by one function, from ONE fraction — the marker cannot drift
 * from the tab because there is nothing for it to drift from.
 *
 * `focus` is null only when nothing is focused (the live tail), which is
 * exactly when no tab is rendered. Every other state — a focused row at
 * either end of the bar, a rolled-back row, a single-row rail — returns two
 * identical strings, and tests/stream-f6-alignment.test.ts asserts that over
 * every state the stream reducer can produce.
 */
export function railAnchors(
  focusedFrac: number | null,
  liveFrac: number
): { marker: string; focus: string | null } {
  if (focusedFrac === null) return { marker: railAnchorTop(liveFrac), focus: null }
  const top = railAnchorTop(focusedFrac)
  return { marker: top, focus: top }
}

/** Half a version pin's height — .cr-ckpt-pin is 13px, centred on its anchor. */
export const PIN_HALF_H = 6.5
/** .cr-ckpt-count's resting `top`, and its rendered height. Kept in step with
 *  styles.css: a 12px numeral over a 5.5px label, plus padding. */
export const COUNT_TOP = 14
export const COUNT_H = 27
/** Breathing room between a yielding badge and the pin it stepped around. */
export const COUNT_GAP = 5

/**
 * Where the CP badge has to sit to clear the version pins, or null to leave it
 * where it rests.
 *
 * The badge and a pin at the top of the bar want the same 20px. Hiding the pin
 * loses a control; fading the badge loses a readout. So the badge YIELDS BY
 * MOVING: it steps to the first gap it fits in and both stay fully readable,
 * which is the only resolution that loses nothing. It yields ONLY where a pin
 * actually reaches it — with nothing near the top it does not move at all, and
 * that is the ordinary case; a pin at the top is what a FRESH INSTALL looks
 * like, since its version is pinned on the oldest drawn row.
 *
 * Walks down to the first gap rather than stepping past the lowest pin on the
 * bar: taking the max of every pin below the badge parked the count two thirds
 * of the way down a rail whose only colliding pin was at the very top.
 */
export function countBadgeTop(pinFracs: readonly number[], railHeight: number): number | null {
  if (railHeight <= 0 || pinFracs.length === 0) return null
  const boxes = pinFracs.map((frac) => {
    const centre = RAIL_INSET + frac * (railHeight - 2 * RAIL_INSET)
    return { top: centre - PIN_HALF_H, bottom: centre + PIN_HALF_H }
  })
  let top = COUNT_TOP
  // Bounded by the pin count: each pass clears at least one box, and a pass
  // that clears none stops.
  for (let i = 0; i <= boxes.length; i++) {
    const hit = boxes.find((b) => b.bottom > top && b.top < top + COUNT_H)
    if (!hit) break
    top = hit.bottom + COUNT_GAP
  }
  return top === COUNT_TOP ? null : top
}
