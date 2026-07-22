import { useCallback, useEffect, useState } from 'react'
import type { TurnRecord } from '../../shared/turn'

/**
 * Checkpoint UX adapter (checkpoint-ux-program-spec items 2-3). Two concerns:
 *  - Dual title mode (item 3): conclusion (Sous title) vs precise prompt,
 *    a persisted user preference.
 *  - Context↔checkpoint mapping (item 2): Forge exposes each checkpoint's
 *    first scrollback row as TurnRecord.scrollLine, so the per-checkpoint
 *    spans derive straight from the records the timeline already fetches.
 *    activeIndexForScroll maps a scroll row → checkpoint for the scroll→step
 *    direction (the select→step direction runs via the overlay's ptyJump).
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

export interface CheckpointSpan {
  index: number
  /** First scrollback row of this checkpoint (0 = oldest). */
  top: number
  /** Row span of the checkpoint (to the next checkpoint's top). */
  height: number
}

/**
 * Build per-checkpoint scrollback spans from records carrying Forge's
 * `scrollLine`. Records without an offset are skipped (best-effort — the
 * tracker may not have seen a turn's start); spans are ascending by `top`,
 * each running to the next checkpoint's top.
 */
export function spansFromRecords(
  records: readonly { index: number; scrollLine?: number }[]
): CheckpointSpan[] {
  const withOffset = records
    .filter((r): r is { index: number; scrollLine: number } => typeof r.scrollLine === 'number')
    .sort((a, b) => a.scrollLine - b.scrollLine)
  return withOffset.map((r, i) => ({
    index: r.index,
    top: r.scrollLine,
    height: (withOffset[i + 1]?.scrollLine ?? r.scrollLine + 1) - r.scrollLine
  }))
}

/**
 * Which checkpoint index owns a given scrollback row — the last span whose
 * `top` is at or above the row (spans are ascending by `top`). Returns null
 * when the map is empty. Pure so the scroll→checkpoint stepping is unit-tested.
 */
export function activeIndexForScroll(spans: CheckpointSpan[], row: number): number | null {
  if (spans.length === 0) return null
  let active = spans[0].index
  for (const span of spans) {
    if (span.top <= row) active = span.index
    else break
  }
  return active
}
