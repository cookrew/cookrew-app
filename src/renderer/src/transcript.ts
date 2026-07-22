import { cookrew } from './api'
import type { TraceBlock } from '../../shared/trace-blocks'
import type { TurnPhase } from '../../shared/turn'

export type { TraceBlock } from '../../shared/trace-blocks'

/**
 * Trace adapter (trace-sourced-context-final, integration round 2): the
 * checkpoint context is traced DIRECTLY from the agent's own session file
 * (Claude jsonl / Codex rollout) via the listTrace API. Blocks are
 * IDENTITY-keyed by TraceBlock.index — 1-based, contiguous from the parsers,
 * so identity doubles as the layout ordinal. Array positions appear nowhere.
 */

export interface TracePage {
  blocks: TraceBlock[]
  total: number
  source: 'claude' | 'codex' | null
}

export interface TraceAnchor {
  beforeIndex?: number
  afterIndex?: number
  aroundIndex?: number
  limit?: number
}

interface TraceBridge {
  listTrace?: (terminalId: string, request?: TraceAnchor) => Promise<TracePage>
}

/** True once the trace API is present (absent in the demo). */
export function hasTraceApi(): boolean {
  return typeof (cookrew() as unknown as TraceBridge).listTrace === 'function'
}

/**
 * Fetch a trace window. listTrace is the ONLY path (review BLOCK 1 — no
 * fetch-all fallback); anchors are block identities (review BLOCK 2). Empty
 * when the API is absent (demo).
 */
export async function fetchTracePage(
  terminalId: string,
  request: TraceAnchor
): Promise<TracePage> {
  const fn = (cookrew() as unknown as TraceBridge).listTrace
  if (!fn) return { blocks: [], total: 0, source: null }
  return fn(terminalId, request)
}

/**
 * Merge a freshly-fetched window into the loaded blocks: dedupe by block
 * IDENTITY, keep ascending. Incoming wins on collision (a re-fetch carries
 * fresher reply/activity). Pure — lazy-pagination merges are unit-tested.
 */
export function mergeTrace(
  loaded: readonly TraceBlock[],
  incoming: readonly TraceBlock[]
): TraceBlock[] {
  const byIndex = new Map<number, TraceBlock>()
  for (const b of loaded) byIndex.set(b.index, b)
  for (const b of incoming) byIndex.set(b.index, b)
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

/**
 * Cap the loaded set to `max` blocks around an anchor identity (BLOCK 3 real
 * windowing — off-screen blocks are evicted so memory is bounded under a
 * 100+ checkpoint history). Keeps a contiguous window; the anchor (the block
 * in view) always survives. Pure — unit-tested.
 */
export function evictTrace(
  blocks: readonly TraceBlock[],
  anchorIndex: number,
  max: number
): TraceBlock[] {
  if (blocks.length <= max) return [...blocks]
  const anchorAt = blocks.findIndex((b) => b.index >= anchorIndex)
  const center = anchorAt < 0 ? blocks.length - 1 : anchorAt
  let start = Math.max(0, center - Math.floor(max / 2))
  const end = Math.min(blocks.length, start + max)
  start = Math.max(0, end - max)
  return blocks.slice(start, end)
}

/**
 * Prune blocks past the current total (MEDIUM 4 — a /rewind shrinks the
 * trace; identities above the new total no longer exist). Pure.
 */
export function pruneToTotal(blocks: readonly TraceBlock[], total: number): TraceBlock[] {
  return blocks.filter((b) => b.index <= total)
}

/**
 * Marker fraction over the rail from a block identity: 0 = oldest (T1),
 * 1 = live tail. `index` null → live. Pure — unit-tested.
 */
export function blockMarkerFraction(index: number | null, total: number): number {
  if (index === null || total <= 0) return 1
  return Math.max(0, Math.min(1, index / total))
}

/**
 * The block whose top has scrolled past the position — the last block whose
 * `top` is at or above `scrollTop` (ascending by `top`). Null when nothing
 * has scrolled in yet. Pure so scroll→checkpoint is tested.
 */
export function activeBlockForScroll(
  tops: readonly { index: number; top: number }[],
  scrollTop: number
): number | null {
  let active: number | null = null
  for (const b of tops) {
    if (b.top <= scrollTop) active = b.index
    else break
  }
  return active
}

/** At-bottom detection for autoscroll pinning (px slack for sub-pixel scroll). */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= 24
}

/**
 * Rail-as-scrollbar scrub (unified-scroll item 4): map a rail drag fraction
 * (0 = top of the oldest trace, 1 = live bottom) to a scrollTop over the ONE
 * combined trace+tail extent. Inverse of scrollTopToFraction; the fraction is
 * clamped so an over-drag pins to an end. Pure — the scrub math is unit-tested.
 */
export function railToScrollTop(
  fraction: number,
  scrollHeight: number,
  clientHeight: number
): number {
  const max = Math.max(0, scrollHeight - clientHeight)
  return Math.max(0, Math.min(1, fraction)) * max
}

/**
 * Rail drag → fraction (unified-scroll item 4): where a pointer sits along the
 * rail track as a fraction (0 top → 1 bottom). The track is the rail height
 * minus an equal inset top and bottom (the marker's own padding), so a drag to
 * the very top scrubs to 0 and to the very bottom to 1. Clamped for over-drag;
 * a degenerate (zero-height) track reports 0. Pure — unit-tested.
 */
export function railPointerFraction(
  clientY: number,
  rectTop: number,
  rectHeight: number,
  inset: number
): number {
  const track = rectHeight - inset * 2
  if (track <= 0) return 0
  return Math.max(0, Math.min(1, (clientY - rectTop - inset) / track))
}

/**
 * The current scroll position as a fraction of the combined extent (0 = top of
 * the oldest trace block, 1 = live bottom). Drives the here-marker so it tracks
 * the true unified position — not just which block is in view — making the rail
 * read as one scrollbar for the whole space. A pane with no overflow (nothing
 * to scroll) reports 1 (pinned live). Pure — unit-tested.
 */
export function scrollTopToFraction(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number
): number {
  const max = scrollHeight - clientHeight
  if (max <= 0) return 1
  return Math.max(0, Math.min(1, scrollTop / max))
}

/**
 * Live-tail clip decision (unified-scroll item 1): the count of buffer rows the
 * idle TUI should show (from the last completion / 'Worked for' line through the
 * input box), or null for no clipping. Clip ONLY when the turn is at rest
 * (replied/idle) AND Forge reported a tail boundary (activity.tailLines) — a
 * running turn (thinking / waiting) or an absent boundary shows everything, so
 * the live layer never hides an in-progress task. The trace owns the older
 * scrollback. Pure — unit-tested.
 */
export function tailClipRows(phase: TurnPhase, tailLines: number | null): number | null {
  if (tailLines === null || tailLines <= 0) return null
  return phase === 'idle' || phase === 'replied' ? tailLines : null
}
