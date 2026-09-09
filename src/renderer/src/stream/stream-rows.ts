// THE RAIL'S ROWS, PROJECTED FROM THE STREAM (one-stream T3).
//
// A checkpoint is a block's ORDINAL plus its MARKS — "a view, not a record",
// in the design's own words. Everything here is that projection and nothing
// else: pure, no fetch, no React, so the F1–F6 rail gates can be argued as
// arithmetic rather than reproduced by hand at phone width.
//
// WHAT LEFT WITH mergeCheckpointRows. The rail used to take two listings — a
// stored ledger and a trace index — and join them by a key that could drift,
// clamping around any row that found no partner. There is one listing now, so
// there is no join, no ceiling clamp, no earlier-segment drop and no phantom
// row. A row exists because the stream has that position; that is all.
//
// `index` is the STREAM ORDINAL and is deliberately named `index`: the rail's
// geometry (railAnchorTop, fillRows, traceFraction, pinAnchors) is laid out in
// that field, and F6 — the marker and the focused row on the same Y — has
// regressed before. Renaming the coordinate the anchor math reads would be
// exactly the kind of change that breaks it quietly.

import type { RollbackNote, StreamCheckpoint } from './stream-types'
import type { TitleMode } from '../checkpoint-sync'

/** A selectable rail row. One position in the stream, plus what is on it. */
export interface CheckpointRow {
  /** The stream ordinal — the T-number, and the rail's layout coordinate. */
  index: number
  /** The block identity: the join key for marks, pins, forks and block pages. */
  id: string
  /** The Sous title, when a mark carries one (dual title mode, conclusion). */
  title?: string
  /** The prompt's first line as the light index caps it (precise mode). */
  promptHead: string
  /** First block after a compaction boundary — the rail draws a thin rule. */
  compacted: boolean
  /** A /rewind cut this position away. Dimmed and glyphed, STILL selectable:
   *  the note is appended, the checkpoint is never removed (panel C ②). */
  rolledBack: boolean
  /** When a person last read it, from the mark. */
  seenAt?: number
}

/** Boundary marker as the rail renders it (mirrors TraceBoundaryMarker). */
export interface TraceMarkerRow {
  kind: 'compact' | 'clear' | 'rewind'
  afterIndex: number
  preTokens?: number
  postTokens?: number
  previousSessionId?: string
  toIndex?: number
}

/** The rail's rows, from the stream's index. Ascending, one row per position. */
export function rowsOfIndex(index: readonly StreamCheckpoint[]): CheckpointRow[] {
  return index.map((entry) => ({
    index: entry.ordinal,
    id: entry.identity,
    ...(entry.marks?.title !== undefined ? { title: entry.marks.title } : {}),
    promptHead: entry.promptHead,
    compacted: entry.compacted,
    rolledBack: entry.rolledBack === true,
    ...(entry.marks?.seenAt !== undefined ? { seenAt: entry.marks.seenAt } : {})
  }))
}

/**
 * Boundary markers, DERIVED — the same rule the T2 adapter uses (markersOf in
 * stream-adapters.ts), restated over the index rows the view already holds.
 *
 * This is what deleted the second fetch. /trace/markers existed because the
 * old rail could not tell a declared compaction from a file rotation without
 * re-reading the file; the stream carries both facts on the row itself, so a
 * boundary is a property of a row the rail already has.
 */
export function markersOfIndex(
  index: readonly StreamCheckpoint[],
  rolledBack: readonly RollbackNote[] = []
): TraceMarkerRow[] {
  const markers: TraceMarkerRow[] = []
  for (const entry of index) {
    if (!entry.compacted) continue
    const facts = entry.compaction
    const previous = entry.previousSessionId
    markers.push({
      // A declared in-file boundary is a ◆; a bare rotation with nothing in
      // the file is the ⇥ a /clear leaves behind.
      kind: facts === undefined && previous !== undefined ? 'clear' : 'compact',
      afterIndex: entry.ordinal - 1,
      ...(facts?.preTokens !== undefined ? { preTokens: facts.preTokens } : {}),
      ...(facts?.postTokens !== undefined ? { postTokens: facts.postTokens } : {}),
      ...(previous !== undefined ? { previousSessionId: previous } : {})
    })
  }
  for (const note of rolledBack) {
    const toIndex = note.fromOrdinal - 1
    if (toIndex > 0) markers.push({ kind: 'rewind', afterIndex: toIndex, toIndex })
  }
  return markers.sort((a, b) => a.afterIndex - b.afterIndex)
}

/**
 * Display label for a row whose title has not landed: never blank, even
 * before Sous has titled anything. Kept for the lineage panel, which lists
 * earlier segments by their own snippets.
 */
export function traceRowLabel(index: number, traceTitle: string): string {
  return traceTitle.trim() || `T${index}`
}

/**
 * THE DUAL TITLE MODE, now off the mark (T3 item 5).
 *
 * Conclusion is the Sous title — which arrives as `marks.title` and is
 * written back with a mark, so a title is attached to an IDENTITY and cannot
 * detach when a compaction renumbers the file. Precise is the prompt's own
 * first line. Neither is ever blank: a row with no title and no prompt still
 * reads as its ordinal.
 */
export function checkpointRowTitle(row: CheckpointRow, mode: TitleMode): string {
  if (mode === 'precise') return traceRowLabel(row.index, row.promptHead)
  return traceRowLabel(row.index, row.title ?? row.promptHead)
}

/**
 * The stream ORDINAL a scrub fraction (0..1) points at, over the WHOLE chain.
 *
 * `scale` is the chain's length (rail-fill.ts's railScale), not the number of
 * rows loaded — the bar is drawn on that scale, so a drag to the middle of a
 * 1,048-row card means T524 whether or not this client has fetched it yet
 * (D1, T5 QA 2026-09-07).
 */
export function scrubOrdinal(fraction: number, scale: number): number {
  const clamped = Math.max(0, Math.min(1, fraction))
  return Math.max(1, Math.round(clamped * (Math.max(1, scale) - 1)) + 1)
}

/**
 * The checkpoint row a scrub fraction (0..1) points at — mapped LINEARLY over
 * the row ordinals so a mid-drag resolves to the middle checkpoint, not a
 * loaded-group edge.
 *
 * `scale` maps the drag over the whole chain; the row handed back is then the
 * NEAREST one this client holds, because a page-back is on the wire and the
 * tab must say something in the meantime. It snaps to the exact checkpoint the
 * moment that page lands. Without a scale the old rule stands: linear over the
 * loaded rows.
 */
export function scrubPreviewRow(
  rows: readonly CheckpointRow[],
  fraction: number,
  scale?: number
): CheckpointRow | null {
  if (rows.length === 0) return null
  const clamped = Math.max(0, Math.min(1, fraction))
  if (scale === undefined) return rows[Math.round(clamped * (rows.length - 1))] ?? null
  const wanted = scrubOrdinal(clamped, scale)
  let nearest = rows[0]
  for (const row of rows) {
    if (Math.abs(row.index - wanted) < Math.abs(nearest.index - wanted)) nearest = row
  }
  return nearest
}

/**
 * The checkpoint currently in FOCUS (mobile v3 State A): the row for the
 * active ordinal in view, or null at the live tail.
 */
export function focusedCheckpoint(
  rows: readonly CheckpointRow[],
  activeIndex: number | null
): CheckpointRow | null {
  if (activeIndex === null) return null
  return rows.find((r) => r.index === activeIndex) ?? null
}

/**
 * Scroll → focus → highlight: from the ordinal in view, the FOCUSED row to
 * highlight plus whether the list is shown at all (hidden at the live tail).
 */
export function scrollFocusState(
  rows: readonly CheckpointRow[],
  activeIndex: number | null
): { focusedIndex: number | null; listShown: boolean } {
  const row = focusedCheckpoint(rows, activeIndex)
  return { focusedIndex: row?.index ?? null, listShown: row !== null }
}

/**
 * The window of rows for the EXTENDED tab: the focused row plus `radius`
 * neighbours above and below, clamped at the list ends.
 */
export function neighborWindow(
  rows: readonly CheckpointRow[],
  focusedIndex: number | null,
  radius: number
): CheckpointRow[] {
  if (focusedIndex === null) return []
  const at = rows.findIndex((r) => r.index === focusedIndex)
  if (at < 0) return []
  return rows.slice(Math.max(0, at - radius), Math.min(rows.length, at + radius + 1))
}

/**
 * Split a window into the FOCUSED row (the anchor, always kept at the marker
 * Y) and its neighbours above and below. Near a boundary the window is
 * already clamped, so alignment stays FIRST and the fan simply clips — the
 * focused row never moves off the marker to force centring (F6).
 */
export function fanLayout(
  windowRows: readonly CheckpointRow[],
  focusedIndex: number
): { above: CheckpointRow[]; focused: CheckpointRow | null; below: CheckpointRow[] } {
  const at = windowRows.findIndex((r) => r.index === focusedIndex)
  if (at < 0) return { above: [], focused: null, below: [] }
  return {
    above: windowRows.slice(0, at),
    focused: windowRows[at],
    below: windowRows.slice(at + 1)
  }
}

/** The identity for an ordinal, so a click on the rail can page the drawer. */
export function identityOf(rows: readonly CheckpointRow[], index: number): string | null {
  return rows.find((row) => row.index === index)?.id ?? null
}

/**
 * The anomaly line the rail's footer carries, or null when the stream read
 * every line it was given.
 *
 * ONE QUIET LINE, NEVER A MODAL (T3 item 3). A line the reader could not
 * parse is a fact about the transcript, not an error the person can act on
 * mid-conversation; a dialog over the rail would interrupt reading to report
 * something nobody can fix from here. Counted and stated, and that is all.
 */
export function anomalyLine(total: number): string | null {
  if (total <= 0) return null
  return `${total} line${total === 1 ? '' : 's'} the stream could not read`
}
