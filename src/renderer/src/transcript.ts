import { cookrew } from './api'
import type { TraceBlock } from '../../shared/trace-blocks'
import type { TurnPhase } from '../../shared/turn'

export type { TraceBlock } from '../../shared/trace-blocks'

/**
 * Trace adapter (trace-sourced-context-final, integration round 2): the
 * checkpoint context is traced DIRECTLY from the agent's own session file
 * (Claude/Pi jsonl or Codex rollout) via the listTrace API. Blocks are
 * IDENTITY-keyed by TraceBlock.index — 1-based, contiguous from the parsers,
 * so identity doubles as the layout ordinal. Array positions appear nowhere.
 */

/**
 * LOUD ABSENT-BRIDGE RULE (warnMock convention): a feature-detected bridge
 * method that is missing at CALL time silently degrades a real build — an
 * empty transcript / no checkpoints that looks like "no history" rather than
 * "not wired". Log ONCE per method with its name (this was the third silent-
 * absent incident) so it is visible in the console instead of vanishing.
 * Exported so the once-guard is unit-tested.
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

export interface TraceAnchor {
  beforeIndex?: number
  afterIndex?: number
  aroundIndex?: number
  limit?: number
}

/**
 * Merge a freshly-fetched window into the loaded blocks: dedupe by block
 * IDENTITY, keep ascending. Incoming wins on collision (a re-fetch carries
 * fresher reply/activity). Pure — lazy-pagination merges are unit-tested.
 */
export function mergeTrace(
  loaded: readonly TraceBlock[],
  incoming: readonly TraceBlock[],
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
  max: number,
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
  /**
   * The block's stable identity (message uuid). The T-number restarts at 1 on
   * every /compact file rotation while the ledger's numbering continues, so
   * the uuid — carried by both sides — is the only join that cannot pair a row
   * with a turn from another session segment. Absent on listings from an older
   * remote server; consumers then fall back to index pairing.
   */
  id?: string
}

/**
 * An EARLIER lineage segment: the checkpoints an auto-compact rotation (or a
 * /clear) moved out of the current session file. Each segment keeps its own
 * T1..Tn numbering — a rewind into one is addressed as (sessionId, index).
 */
export interface LineageSegmentRow {
  sessionId: string
  count: number
  entries: TraceIndexEntry[]
}

interface LineageSegmentsBridge {
  listLineageSegments?: (terminalId: string) => Promise<LineageSegmentRow[]>
}

/** True when the earlier-segments expansion can be offered at all. */
export function hasLineageSegmentsApi(): boolean {
  return typeof (cookrew() as unknown as LineageSegmentsBridge).listLineageSegments === 'function'
}

/**
 * Earlier segments of the agent's session chain, oldest first — fetched on
 * demand (the expansion tap), never on every rail poll: a predecessor can be
 * tens of MB and is parsed only when someone actually looks. Empty when the
 * bridge predates the endpoint (remote crews, older servers).
 */
export async function fetchLineageSegments(terminalId: string): Promise<LineageSegmentRow[]> {
  const fn = (cookrew() as unknown as LineageSegmentsBridge).listLineageSegments
  if (!fn) {
    warnAbsentBridge('listLineageSegments')
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
  loaded: ReadonlySet<number>,
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
    },
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

/**
 * The `top` for a rail-anchored element at a scroll FRACTION (0..1) — the ONE
 * position source shared by the here-marker AND the focused tab/row, so they
 * always sit on the SAME horizontal line (marker-Y == focused-row-Y, refinement
 * 1). Matches the `.cr-ckpt-here` geometry (16px inset each end). Clamped so a
 * boundary fraction still resolves on the line. Pure — unit-tested.
 */
export function railAnchorTop(fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction))
  return `calc(16px + ${f} * (100% - 32px))`
}

export interface HoldReveal {
  /** Begin a press on `index`; fires onReveal(index) once it's held for `ms`. */
  start: (index: number) => void
  /** Release/move/leave before `ms` — no reveal. */
  cancel: () => void
}

/**
 * Hold-to-reveal controller (mobile v3): press and HOLD a tab/row for `ms` (the
 * touch equivalent of the desktop row-hover) to reveal its SAVE ROLE / FORK
 * actions; a release before `ms` is a plain tap and reveals nothing. Uses the
 * global timer (fake-timer testable). Pure control-flow — unit-tested.
 */
export function createHoldReveal(onReveal: (index: number) => void, ms: number): HoldReveal {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  return {
    start: (index: number): void => {
      cancel()
      timer = setTimeout(() => {
        timer = null
        onReveal(index)
      }, ms)
    },
    cancel,
  }
}

/**
 * The block whose top has scrolled past the position — the last block whose
 * `top` is at or above `scrollTop` (ascending by `top`). Null when nothing
 * has scrolled in yet. Pure so scroll→checkpoint is tested.
 */
export function activeBlockForScroll(
  tops: readonly { index: number; top: number }[],
  scrollTop: number,
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
 * Should the pin-keeper re-stick the bottom? Growth the React effects cannot
 * see (a content-visibility block rendering to its real height, the live seam
 * growing under an xterm fit, placeholders inserted above the viewport) opens
 * a gap while the reader is still notionally pinned. Shares isAtBottom's
 * slack so a reader resting a few px off the bottom is never snapped.
 * Pure — unit-tested.
 */
export function shouldStick(
  pinned: boolean,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number
): boolean {
  return pinned && !isAtBottom(scrollTop, scrollHeight, clientHeight)
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
  inset: number,
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

/**
 * WHERE A WHEEL OVER THE LIVE LAYER GOES — the one combined scroll space, or
 * xterm.
 *
 * While a turn RUNS, the live layer is the thing to read and the wheel drives
 * xterm (tmux copy-mode) as it always has. At REST the live layer is a tail:
 * scrolling it should move through the transcript above it. That used to be
 * true only when a tail clip had been found, and a clip is found by scraping
 * the PTY for a reply boundary — which a TUI never shows. An imported card
 * mirrors pi's full-screen TUI, so no clip was ever found, the wheel went to
 * xterm, xterm turned it into arrow keys for a remote alt-screen, and the
 * transcript above a finished reply could not be reached at all. Rest is the
 * rule now; the clip is only how the tail is drawn.
 *
 * NESTED, like any scroller inside a scroller: the live layer's OWN
 * scrollback comes first. An upward wheel scrolls the terminal until its
 * viewport is at the top of its buffer, and only then moves the transcript
 * above; a downward one scrolls the terminal back until it is at its bottom,
 * and only then the transcript. The live transcript — the reply as the
 * terminal drew it — is therefore always readable in place after a reply,
 * which it was not while the clip rule took every wheel at rest for the
 * checkpoint blocks. `live` is the terminal's edges; absent (no terminal yet)
 * it is treated as having none, so the transcript takes the wheel.
 */
export function wheelGoesToTranscript(input: {
  atRest: boolean
  clipped: boolean
  deltaY: number
  scrollTop: number
  atBottom: boolean
  live?: { atTop: boolean; atBottom: boolean }
}): boolean {
  if (!input.atRest && !input.clipped) return false
  const live = input.live ?? { atTop: true, atBottom: true }
  if (input.deltaY < 0) return live.atTop && input.scrollTop > 0
  if (input.deltaY > 0) return live.atBottom && !input.atBottom
  return false
}
