import { cookrew } from './api'
import { checkpointTitle, type TitleMode } from './checkpoint-sync'
import type { TraceBlock } from '../../shared/trace-blocks'
import type { TurnPhase, TurnRecord } from '../../shared/turn'

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

/**
 * LOUD ABSENT-BRIDGE RULE (warnMock convention): a feature-detected bridge
 * method that is missing at CALL time silently degrades a real build — an empty
 * transcript / no checkpoints that looks like "no history" rather than "not
 * wired". Log ONCE per method with its name (this is the third silent-absent
 * incident) so it's visible in the console instead of vanishing. Exported so the
 * once-guard is unit-tested.
 */
const warnedAbsentBridges = new Set<string>()
export function warnAbsentBridge(method: string): void {
  if (warnedAbsentBridges.has(method)) return
  warnedAbsentBridges.add(method)
  console.error(
    `[cookrew] bridge method \`${method}\` is absent — feature-detected call degraded ` +
      'to empty. Not wired in this build (or running in demo).'
  )
}

/** True once the trace API is present (absent in the demo). */
export function hasTraceApi(): boolean {
  return typeof (cookrew() as unknown as TraceBridge).listTrace === 'function'
}

/**
 * Fetch a trace window. listTrace is the ONLY path (review BLOCK 1 — no
 * fetch-all fallback); anchors are block identities (review BLOCK 2). Empty
 * when the API is absent — and LOUD about it (absent-bridge rule).
 */
export async function fetchTracePage(
  terminalId: string,
  request: TraceAnchor
): Promise<TracePage> {
  const fn = (cookrew() as unknown as TraceBridge).listTrace
  if (!fn) {
    warnAbsentBridge('listTrace')
    return { blocks: [], total: 0, source: null }
  }
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

// ---- full-range checkpoint rows (item 3: every traced checkpoint selectable) ----

/** A lightweight trace listing entry — identity + a display title/snippet. */
export interface TraceIndexEntry {
  index: number
  title: string
}

interface TraceIndexBridge {
  listTraceIndex?: (terminalId: string) => Promise<TraceIndexEntry[]>
}

/** True once Forge's cheap identity-range/title listing is present. */
export function hasTraceIndexApi(): boolean {
  return typeof (cookrew() as unknown as TraceIndexBridge).listTraceIndex === 'function'
}

/**
 * The full trace's checkpoint identities + titles (item 3). Cheap listing so
 * the timeline can span the WHOLE trace (floor..ceiling), not just the capped
 * record store. Empty when the API is absent — the timeline then falls back to
 * the records alone (today's behavior). Coordinated with Forge as listTraceIndex.
 */
export async function fetchTraceIndex(terminalId: string): Promise<TraceIndexEntry[]> {
  const fn = (cookrew() as unknown as TraceIndexBridge).listTraceIndex
  if (!fn) {
    warnAbsentBridge('listTraceIndex')
    return []
  }
  return fn(terminalId)
}

/**
 * scrollIntoView behavior for a checkpoint jump (item 2b): a coarse pointer or
 * an in-flight touch CANCELS a smooth scroll mid-animation (the finger's own
 * gesture interrupts it), leaving the jump half-done and feeling stuck — so snap
 * instantly there. A just-landed far fetch also snaps (smooth-from-far reads as
 * dead). Smooth is kept only for a nearby, mouse-driven target. Pure —
 * unit-tested.
 */
export function jumpScrollBehavior(opts: {
  landed: boolean
  coarsePointer: boolean
  touchActive: boolean
}): 'auto' | 'smooth' {
  return opts.landed || opts.coarsePointer || opts.touchActive ? 'auto' : 'smooth'
}

/**
 * Display label for a trace-only checkpoint row (item 2c): its trace title when
 * present, else the T<n> identity — NEVER blank, even before Forge's index (or
 * its titles) lands. Pure — unit-tested.
 */
export function traceRowLabel(index: number, traceTitle: string): string {
  return traceTitle.trim() || `T${index}`
}

// ---- identity-space virtualization (scroll-model rebuild) ----
//
// The transcript scroll extent spans the FULL checkpoint identity list
// (floor..ceiling): loaded blocks at their measured height, unloaded identities
// as estimated-height placeholders. This makes the geometry CONTINUOUS — no
// zero-height gaps between sparse windows, which were the single root of the
// four symptoms (snap-to-live on scroll-down, fractions resolving to loaded-group
// edges, jumps stranding at neighborhood boundaries). Fractions map linearly to
// the identity LIST (its positions), so they're robust to non-contiguous
// identities (sibling collapse leaves gaps like [1,2,5,6,100]).

/**
 * The identity nearest a scroll FRACTION (0..1) over the identity list — used to
 * turn a rail scrub into a target checkpoint. Linear in list position, so a
 * mid-drag lands on the middle identity even across huge unloaded gaps. Null for
 * an empty list. Pure — unit-tested.
 */
export function identityAtFraction(identities: readonly number[], fraction: number): number | null {
  if (identities.length === 0) return null
  const clamped = Math.max(0, Math.min(1, fraction))
  return identities[Math.round(clamped * (identities.length - 1))]
}

/**
 * A FRACTION (0..1) for an identity's position in the list (0 = oldest/top,
 * 1 = newest) — drives the here-marker linearly in identity space. Absent id or
 * a degenerate list → 1 (pinned live). Pure — unit-tested.
 */
export function fractionOfIdentity(identities: readonly number[], id: number | null): number {
  if (id === null || identities.length <= 1) return 1
  const i = identities.indexOf(id)
  return i < 0 ? 1 : i / (identities.length - 1)
}

/**
 * The first identity in view that has no loaded block — the window to lazily
 * fetch as placeholders scroll into the viewport. Null when everything visible
 * is already loaded. Pure — unit-tested.
 */
export function firstUnloadedInView(
  visibleIds: readonly number[],
  loaded: ReadonlySet<number>
): number | null {
  for (const id of visibleIds) if (!loaded.has(id)) return id
  return null
}

export interface SingleFlight {
  /** Request a fetch for `id`; coalesced so only the latest runs next. */
  request: (id: number) => void
}

/**
 * Coalescing single-flight (HIGH fetch-starvation fix): at most one `run` is in
 * flight; a request made while busy remembers the LATEST id and re-fires it when
 * the in-flight run settles — so a rapid SECOND far-jump is served, never
 * dropped and left spinning forever. Intermediate requests are skipped (only the
 * first + the latest run). Pure control-flow — unit-tested with mock async.
 */
export function coalescingSingleFlight(run: (id: number) => Promise<void>): SingleFlight {
  let inFlight = false
  let wanted: number | null = null
  const fire = (): void => {
    if (wanted === null) return
    const id = wanted
    inFlight = true
    void run(id).finally(() => {
      inFlight = false
      // Re-fire for the LATEST wanted id if it changed while this ran (the second
      // far-jump), otherwise the run is done.
      if (wanted !== id) fire()
      else wanted = null
    })
  }
  return {
    request: (id: number): void => {
      wanted = id
      if (!inFlight) fire()
    }
  }
}

/**
 * Refine the placeholder height estimate from measured loaded-block heights: the
 * mean of what's been measured, ignoring a degenerate (zero) measurement so a
 * layout-less environment keeps the prior estimate. Returns `prev` when nothing
 * usable was measured. Pure — unit-tested.
 */
export function refineEstimate(prev: number, measured: readonly number[]): number {
  const usable = measured.filter((h) => h > 0)
  if (usable.length === 0) return prev
  return usable.reduce((a, b) => a + b, 0) / usable.length
}

/** A selectable checkpoint row: full record when in the cap, else trace-only. */
export interface CheckpointRow {
  index: number
  /** Full record when within the (capped) record store; null for trace-only. */
  record: TurnRecord | null
  /** Fallback label for trace-only rows (a trace prompt snippet / title). */
  traceTitle: string
}

/**
 * Merge the capped record store with the full trace listing so EVERY traced
 * checkpoint is a selectable row (item 3): records supply full data (title,
 * fork, role-save) where present; identities below the record cap (e.g. T1..T7
 * when the store starts at T8) render trace-only from the listing. Union by
 * IDENTITY, ascending; records win.
 *
 * ROOT DEPENDENCY (Forge unified-identity, note trace-sourced-context-final):
 * trace-block.index and TurnRecord.index are currently DIFFERENT coordinate
 * systems, so a record can number BEYOND the trace ceiling (record-40 vs
 * trace-38) — producing phantom rail rows that map to no trace block (mispaired
 * titles, dead clicks). Clamp the rail to the TRACE CEILING: drop record-only
 * rows past it, so the rail spans exactly the trace. When the listing is absent
 * we can't know the ceiling, so records are kept as-is. Once Forge's unified
 * contract lands the two coincide and this clamp is a no-op. Pure — unit-tested.
 */
export function mergeCheckpointRows(
  records: readonly TurnRecord[],
  traceIndex: readonly TraceIndexEntry[]
): CheckpointRow[] {
  const byIndex = new Map<number, CheckpointRow>()
  const ceiling =
    traceIndex.length > 0
      ? traceIndex.reduce((max, e) => Math.max(max, e.index), -Infinity)
      : Infinity
  for (const entry of traceIndex) {
    byIndex.set(entry.index, { index: entry.index, record: null, traceTitle: entry.title })
  }
  for (const record of records) {
    if (record.index > ceiling) continue // phantom record beyond the trace ceiling
    const prior = byIndex.get(record.index)
    byIndex.set(record.index, { index: record.index, record, traceTitle: prior?.traceTitle ?? '' })
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}

/**
 * The display title for a checkpoint row: the record's mode-aware title
 * (conclusion / precise prompt) when loaded, else the trace snippet, else the
 * T<n> identity — never blank. The single source the fan rows AND the mobile
 * scrub-preview label share. Pure — unit-tested.
 */
export function checkpointRowTitle(row: CheckpointRow, titleMode: TitleMode): string {
  return row.record ? checkpointTitle(row.record, titleMode) : traceRowLabel(row.index, row.traceTitle)
}

/**
 * The checkpoint row a scrub fraction (0..1) points at — mapped LINEARLY over
 * the row identities so a mid-drag resolves to the middle checkpoint, not a
 * loaded-group edge. Drives the mobile scrub-preview so the CURRENT title shows
 * at the thumb while dragging (the touch equivalent of desktop hover-reveal).
 * Null for an empty list. Pure — unit-tested.
 */
export function scrubPreviewRow(
  rows: readonly CheckpointRow[],
  fraction: number
): CheckpointRow | null {
  const id = identityAtFraction(
    rows.map((r) => r.index),
    fraction
  )
  if (id === null) return null
  return rows.find((r) => r.index === id) ?? null
}

/**
 * Whether a transcript scroll should transiently fan the checkpoint list open —
 * the MOBILE equivalent of the desktop hover-fan. Only on a coarse pointer
 * (touch has no real hover), only when not mid-scrub (the scrub owns the rail
 * then), and only once a checkpoint is actually in view. Pure — unit-tested.
 */
export function shouldRevealOnScroll(opts: {
  coarsePointer: boolean
  scrubbing: boolean
  activeIndex: number | null
}): boolean {
  return opts.coarsePointer && !opts.scrubbing && opts.activeIndex !== null
}

export interface ScrollReveal {
  /** A scroll happened: reveal now and (re)arm the trailing collapse. */
  bump: () => void
  /** Cancel a pending collapse and fold back immediately (e.g. a scrub/tap). */
  cancel: () => void
}

/**
 * Transient scroll-reveal controller: fans the list open on the first scroll and
 * collapses it after `quietMs` of no further scroll (a trailing debounce), so the
 * list appears WHILE scrolling and folds back to the single-line rest state — no
 * pinned-open, no from-T1 column. Uses the global timer (fake-timer testable).
 * Pure control-flow — unit-tested.
 */
export function createScrollReveal(onChange: (revealed: boolean) => void, quietMs: number): ScrollReveal {
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  return {
    bump: (): void => {
      onChange(true)
      stop()
      timer = setTimeout(() => {
        timer = null
        onChange(false)
      }, quietMs)
    },
    cancel: (): void => {
      stop()
      onChange(false)
    }
  }
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
