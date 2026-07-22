import { cookrew } from './api'
import type { TraceBlock } from '../../shared/trace-blocks'

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
