import type { CheckpointRow } from './transcript'

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

/** A row plus where along the bar it belongs (0 = oldest, 1 = newest). */
export interface FilledRow {
  row: CheckpointRow
  fraction: number
}

/** Rail height in px a single row needs before neighbours start overlapping. */
export const ROW_HEIGHT = 34

/**
 * How many rows the bar can show at once. At least 2 — the two ends ARE the
 * claim this gate makes, so a bar too short for more still shows T1 and LIVE.
 */
export function capacityFor(barHeight: number): number {
  return Math.max(2, Math.floor(barHeight / ROW_HEIGHT))
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
 * The rows to lay along the bar, each with its fraction of the full range.
 *
 * `focusedIndex` is EXCLUDED from the result even when sampling picks it: the
 * focused row is rendered separately at the marker's own precise fraction, and
 * drawing it twice would put a second, subtly misaligned copy of it one pixel
 * off the marker — which is the exact failure F6 exists to catch.
 */
export function fillRows(
  rows: readonly CheckpointRow[],
  barHeight: number,
  focusedIndex: number | null
): FilledRow[] {
  if (rows.length === 0) return []
  const denominator = Math.max(1, rows.length - 1)
  return sampleIndices(rows.length, capacityFor(barHeight))
    .map((i) => ({ row: rows[i], fraction: i / denominator }))
    .filter((entry) => entry.row.index !== focusedIndex)
}
