import { useCallback, useEffect, useState } from 'react'
import type { TurnRecord } from '../../shared/turn'

/**
 * Checkpoint UX adapter (checkpoint-ux-program-spec items 2-3). Two concerns:
 *  - Dual title mode (item 3): conclusion (Sous title) vs precise prompt,
 *    a persisted user preference.
 *  - Context↔checkpoint mapping (item 2): each checkpoint's monotonic scrollback
 *    anchor (TurnRecord.scrollLine) plus the live activity.scrollBase give its
 *    depth in "lines above the live bottom" — the same units as scrollRow.
 *    activeCheckpointIndex maps a scroll position → checkpoint for scroll→step;
 *    markerFraction / checkpointProgress drive the you-are-here marker and the
 *    intra-checkpoint bar. The select→step direction runs via the overlay's
 *    ptyJump.
 */

// ---- item 3: dual title mode (persisted) ----

export type TitleMode = 'conclusion' | 'precise'
const TITLE_MODE_KEY = 'cookrew-checkpoint-title-mode'

/** Persisted conclusion/precise toggle, shared across every checkpoint view. */
export function useTitleMode(): [TitleMode, () => void] {
  const [mode, setMode] = useState<TitleMode>(
    () => (localStorage.getItem(TITLE_MODE_KEY) as TitleMode) || 'conclusion'
  )
  const toggle = useCallback(() => {
    setMode((prev) => {
      const next: TitleMode = prev === 'conclusion' ? 'precise' : 'conclusion'
      localStorage.setItem(TITLE_MODE_KEY, next)
      return next
    })
  }, [])
  // Reflect a toggle made in another card/overlay of the same window.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === TITLE_MODE_KEY && e.newValue) setMode(e.newValue as TitleMode)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  return [mode, toggle]
}

/**
 * Title text for a checkpoint under the active mode: the precise prompt keeps
 * the exact input (incl. newlines); conclusion prefers the Sous title, falling
 * back to the prompt when no title was generated.
 */
export function checkpointTitle(record: TurnRecord, mode: TitleMode): string {
  if (mode === 'precise') return record.prompt || '(empty prompt)'
  return record.title || record.prompt || '(empty prompt)'
}

/**
 * Cursor for jumping to a checkpoint by its TurnRecord.index, or null when no
 * record matches. Every checkpoint — INCLUDING the newest — is viewable: the
 * newest completed checkpoint has its own ask line and is distinct from the
 * live tail (the LIVE control returns there). Pure so the jump target is
 * unit-tested. Lives here (a JSX-free module) so tests can import it under the
 * node tsconfig.
 */
export function gotoCursor(
  records: readonly { index: number }[],
  turnIndex: number
): number | null {
  const at = records.findIndex((r) => r.index === turnIndex)
  return at >= 0 ? at : null
}

// ---- item 2: context ↔ checkpoint scroll mapping ----

/**
 * Coordinates (Forge monotonic contract): everything is in "lines above the
 * live bottom" — the same units as activity.scrollRow (tmux copy-mode
 * position). A checkpoint's DEPTH is `scrollBase − scrollLine`, where
 * scrollBase is the current tmux history_size and scrollLine was history_size
 * at the checkpoint's turn start. Older checkpoints have larger depth; the
 * newest sits just above the bottom, its content running down to the next-
 * newer prompt (or the live bottom).
 */
export type Depthed = { index: number; scrollLine?: number }

function depthOf(scrollLine: number, scrollBase: number): number {
  return Math.max(0, scrollBase - scrollLine)
}

/**
 * The checkpoint whose content contains a scroll position (lines above the
 * bottom): the smallest depth still greater than `scrollRow` (its prompt is
 * the nearest boundary above you); when scrolled past the oldest, the oldest.
 * Null without mapping data. Pure — unit-tested.
 */
export function activeCheckpointIndex(
  records: readonly Depthed[],
  scrollBase: number | null,
  scrollRow: number
): number | null {
  if (scrollBase === null) return null
  let chosen: number | null = null
  let chosenDepth = Number.POSITIVE_INFINITY
  let oldest: number | null = null
  let oldestDepth = -1
  for (const r of records) {
    if (r.scrollLine === undefined) continue
    const d = depthOf(r.scrollLine, scrollBase)
    if (d > scrollRow && d < chosenDepth) {
      chosenDepth = d
      chosen = r.index
    }
    if (d > oldestDepth) {
      oldestDepth = d
      oldest = r.index
    }
  }
  return chosen ?? oldest
}

/**
 * Marker fraction over the rail (0 = oldest/top, 1 = live bottom). scrollRow=0
 * → 1; fully scrolled up (scrollRow ≈ scrollBase) → 0.
 */
export function markerFraction(scrollRow: number | null, scrollBase: number | null): number {
  if (scrollRow === null || scrollBase === null || scrollBase <= 0) return 1
  return Math.max(0, Math.min(1, 1 - scrollRow / scrollBase))
}

/**
 * Progress (0..1) scrolled through a checkpoint's content — from its own depth
 * down to the next-newer checkpoint's prompt (or the bottom).
 */
export function checkpointProgress(
  records: readonly Depthed[],
  index: number,
  scrollBase: number | null,
  scrollRow: number | null
): number {
  if (scrollBase === null || scrollRow === null) return 0
  const target = records.find((r) => r.index === index)
  if (!target || target.scrollLine === undefined) return 0
  const dN = depthOf(target.scrollLine, scrollBase)
  let floor = 0
  for (const r of records) {
    if (r.scrollLine === undefined) continue
    const d = depthOf(r.scrollLine, scrollBase)
    if (d < dN && d > floor) floor = d
  }
  if (dN <= floor) return 0
  return Math.max(0, Math.min(1, (scrollRow - floor) / (dN - floor)))
}

/** scrollRow a jump to a checkpoint is expected to echo = the checkpoint depth. */
export function checkpointDepth(
  records: readonly Depthed[],
  index: number,
  scrollBase: number | null
): number | null {
  if (scrollBase === null) return null
  const r = records.find((x) => x.index === index)
  return r && r.scrollLine !== undefined ? depthOf(r.scrollLine, scrollBase) : null
}
