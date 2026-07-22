import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { checkpointTitle, type TitleMode } from './checkpoint-sync'
import { MarkdownText } from './MarkdownText'
import {
  activeBlockForScroll,
  boundaryReached,
  evictTrace,
  fetchTracePage,
  hasNewerBlocks,
  hasOlderBlocks,
  isAtBottom,
  mergeTrace,
  newestIndex,
  pruneToTotal,
  railToScrollTop,
  scrollTopToFraction,
  type TracePage,
  type TraceBlock
} from './transcript'

/** Blocks fetched per lazy page, and the cap kept in memory (BLOCK 3). */
const WINDOW = 20
const MAX_BLOCKS = 60

export interface ActiveBlock {
  /** Checkpoint identity (TurnRecord.index) of the block in view, or null (live). */
  index: number | null
  /** Marker fraction over the COMBINED trace+tail extent (0 top → 1 live bottom). */
  frac: number
}

/** Imperative handle so the checkpoint rail can scrub this one scroll space. */
export interface TranscriptHandle {
  /** Scrub to a rail fraction (0 = oldest trace top, 1 = live bottom). */
  scrubTo: (fraction: number) => void
}

/**
 * Dual-layer context view (trace-sourced-context-final). The checkpoint surface
 * is a lazily-paged transcript traced from the agent's own session file via
 * Forge's paged trace API — durable, position-keyed, truncation-immune and
 * verbatim by construction. Off-screen blocks are evicted so memory stays
 * bounded under a 100+ checkpoint history; a /rewind prunes blocks past the new
 * total. The live terminal (children) seams in at the bottom as one scroll
 * stream. A checkpoint click scrolls to that block (fetching a window around it
 * if unloaded); scrolling reports the block in view for the timeline marker.
 */
export const TranscriptView = forwardRef<
  TranscriptHandle,
  {
    terminalId: string
    /** Total completed checkpoints (activity.turnCount) — grows/shrinks on rewind. */
    total: number
    titleMode: TitleMode
    /** Checkpoint the user selected (paging.viewing) — scroll its block into view. */
    selectedIndex: number | null
    /**
     * Live-tail clip (unified-scroll item 1): rows of the idle TUI tail to keep
     * in the live layer, or null for no clip. Drives the clip signal on the
     * seam so scrollback above the tail stops competing with the trace.
     */
    clipRows: number | null
    /** Reports the block in view (identity + marker fraction) for the timeline. */
    onActiveBlockChange?: (active: ActiveBlock) => void
    /**
     * Reports a checkpoint identity whose block is being FETCHED for a jump
     * (item 4), null once it lands — drives the rail/fan loading affordance so
     * a far click gives instant feedback instead of feeling stuck.
     */
    onPending?: (index: number | null) => void
    /** The live terminal layer, seamed at the bottom of the transcript. */
    children: React.ReactNode
  }
>(function TranscriptView(
  { terminalId, total, titleMode, selectedIndex, clipRows, onActiveBlockChange, onPending, children },
  ref
): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLDivElement>(null)
  const blockRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const [blocks, setBlocks] = useState<TraceBlock[]>([])
  const [loading, setLoading] = useState(false)
  const pinnedRef = useRef(true)
  // Latest clip state read by the imperatively-attached wheel handler (which is
  // bound once) — a ref so the handler always sees the current phase.
  const clipRef = useRef(clipRows)
  clipRef.current = clipRows
  const anchorIndexRef = useRef<number>(Number.MAX_SAFE_INTEGER)
  // The block currently in view (from onScroll) — lets the selectedIndex effect
  // tell a genuine external jump (click/scrub) from a reverse-sync echo of the
  // block you already scrolled to, so the two never fight (defect 1).
  const activeInViewRef = useRef<number | null>(null)
  // Discovered trace floor/ceiling identities: the smallest / largest block
  // identity that exists, learned when a scroll-up / scroll-down fetch comes
  // back empty. null = not yet discovered (more may exist). Reset on a fresh
  // tail load. NEVER derived from `total` (a count) — identities outrun it.
  const traceMinRef = useRef<number | null>(null)
  const traceMaxRef = useRef<number | null>(null)
  const oldestIndex = blocks[0]?.index ?? null
  const newestLoaded = newestIndex(blocks)
  const hasOlder = hasOlderBlocks(oldestIndex, traceMinRef.current)
  const hasNewer = hasNewerBlocks(newestLoaded, traceMaxRef.current)

  // Seamless handoff (unified-scroll item 2): while the live tail is CLIPPED
  // (turn at rest), a wheel UP over the live layer scrolls the ONE combined
  // trace+tail space into the trace instead of driving tmux copy-mode into the
  // TUI's own (duplicate) scrollback. Capture phase so it runs BEFORE xterm's
  // viewport handler, upward-only and only until the trace above is exhausted;
  // downward and a running turn (clip null) keep xterm's native/tmux scrolling.
  useEffect(() => {
    const live = liveRef.current
    const scroller = scrollRef.current
    if (!live || !scroller) return
    const onWheel = (e: WheelEvent): void => {
      if (clipRef.current === null) return
      if (e.deltaY < 0 && scroller.scrollTop > 0) {
        e.preventDefault()
        e.stopPropagation()
        scroller.scrollTop += e.deltaY
      }
    }
    live.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => live.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions)
  }, [])

  // Merge a page in, then evict to the cap around the block currently in view.
  const ingest = useCallback((page: { blocks: TraceBlock[]; total: number }): void => {
    // Clear a latched boundary the moment a merge reveals a block beyond it
    // (review WARNING): an aroundIndex fetch can undercut a floor/ceiling that a
    // short end-window falsely set, so the range re-opens instead of sealing.
    for (const b of page.blocks) {
      if (traceMinRef.current !== null && b.index < traceMinRef.current) traceMinRef.current = null
      if (traceMaxRef.current !== null && b.index > traceMaxRef.current) traceMaxRef.current = null
    }
    setBlocks((prev) => {
      const merged = mergeTrace(pruneToTotal(prev, page.total), page.blocks)
      return evictTrace(merged, anchorIndexRef.current, MAX_BLOCKS)
    })
  }, [])

  const loadWindow = useCallback(
    async (anchor: 'tail' | { beforeIndex: number } | { afterIndex: number }): Promise<TracePage> => {
      // IDENTITY anchors (review BLOCK 2): the tail window on mount/growth,
      // blocks older/newer than the oldest/newest LOADED identity on scroll —
      // never array offsets or `total`, which renumber under rewinds and caps.
      const request = anchor === 'tail' ? { limit: WINDOW } : { ...anchor, limit: WINDOW }
      const page = await fetchTracePage(terminalId, request)
      ingest(page)
      return page
    },
    [terminalId, ingest]
  )

  // Newest window on mount and on any total change; a rewind (total shrink) is
  // handled by pruneToTotal inside ingest, so stale blocks drop automatically.
  // A fresh tail also re-opens the floor/ceiling: a growth adds a newer identity
  // (ceiling moved), and a new terminal has an unknown floor.
  useEffect(() => {
    if (total <= 0) {
      setBlocks([])
      return
    }
    anchorIndexRef.current = Number.MAX_SAFE_INTEGER
    traceMinRef.current = null
    traceMaxRef.current = null
    void loadWindow('tail')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, total])

  // Lazy scroll-up: prepend the previous window, preserving the scroll offset.
  // When the fetch brings nothing older than where we started, we've reached the
  // trace floor — record the identity so hasOlder stops (no phantom T1..T5).
  const loadOlder = useCallback(async () => {
    if (loading || !hasOlder || oldestIndex === null) return
    setLoading(true)
    const el = scrollRef.current
    const before = el?.scrollHeight ?? 0
    const start = oldestIndex
    const page = await loadWindow({ beforeIndex: start })
    if (boundaryReached(page.blocks, start, 'older')) traceMinRef.current = start
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - before
      setLoading(false)
    })
  }, [loading, hasOlder, oldestIndex, loadWindow])

  // Lazy scroll-DOWN (defect 2): eviction drops the newest window when you climb
  // into history, so returning toward live would otherwise stall at the newest
  // SURVIVING block (~T60) instead of the true latest (T105). Fill forward from
  // blocks[last].index — never `total`. Appending below the view doesn't shift
  // the current scroll, so no offset correction. Empty result → trace ceiling.
  const loadNewer = useCallback(async () => {
    if (loading || !hasNewer || newestLoaded === null) return
    setLoading(true)
    const start = newestLoaded
    const page = await loadWindow({ afterIndex: start })
    if (boundaryReached(page.blocks, start, 'newer')) traceMaxRef.current = start
    setLoading(false)
  }, [loading, hasNewer, newestLoaded, loadWindow])

  // offsetParent-safe block tops: relative to the scroll container via rects,
  // not node.offsetTop (whose offsetParent may not be the scroller — MEDIUM 6).
  const blockTops = useCallback((): { index: number; top: number }[] => {
    const el = scrollRef.current
    if (!el) return []
    const base = el.getBoundingClientRect().top - el.scrollTop
    return [...blockRefs.current.entries()]
      .map(([index, node]) => ({
        index,
        top: node.getBoundingClientRect().top - base
      }))
      .sort((a, b) => a.top - b.top)
  }, [])

  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
    if (el.scrollTop < 80) void loadOlder()
    // Approaching the live seam from above with newer blocks still unloaded
    // (an eviction gap): fill forward so the true latest checkpoint is reachable.
    const live = liveRef.current
    if (!pinnedRef.current && hasNewer && live) {
      const base = el.getBoundingClientRect().top - el.scrollTop
      const seamTop = live.getBoundingClientRect().top - base
      if (seamTop - (el.scrollTop + el.clientHeight) < 160) void loadNewer()
    }
    const tops = blockTops()
    const activeIndex = pinnedRef.current ? null : activeBlockForScroll(tops, el.scrollTop + 8)
    anchorIndexRef.current = activeIndex ?? Number.MAX_SAFE_INTEGER
    activeInViewRef.current = activeIndex
    if (onActiveBlockChange) {
      // The here-marker rides the TRUE position over the combined trace+tail
      // extent (item 4: the rail is one scrollbar), not just block identity —
      // so it moves continuously as the seam is crossed (item 2).
      onActiveBlockChange({
        index: activeIndex,
        frac: scrollTopToFraction(el.scrollTop, el.scrollHeight, el.clientHeight)
      })
    }
  }, [loadOlder, loadNewer, hasNewer, blockTops, onActiveBlockChange])

  // Rail scrub (item 4): map a rail fraction to this ONE scroll space. Setting
  // scrollTop fires onScroll, so the marker + active checkpoint follow for free.
  useImperativeHandle(
    ref,
    () => ({
      scrubTo: (fraction: number): void => {
        const el = scrollRef.current
        if (!el) return
        el.scrollTop = railToScrollTop(fraction, el.scrollHeight, el.clientHeight)
      }
    }),
    []
  )

  // Checkpoint click → scroll that block into view, fetching a window around it
  // when it is not loaded (truncation-immune: the record always exists in the
  // trace, even far past TUI erasure). Reaching the last selection lets us tell a
  // reverse-sync echo from a genuine jump (defect 1).
  const lastSelectedRef = useRef<number | null>(null)
  // The identity whose block is being fetched for a far jump — distinguishes a
  // just-landed far target (snap instantly, item 4) from a nearby loaded one.
  const pendingJumpRef = useRef<number | null>(null)
  useEffect(() => {
    const enteringLive = selectedIndex === null && lastSelectedRef.current !== null
    lastSelectedRef.current = selectedIndex
    if (selectedIndex === null) {
      // Returning to live after eviction may have dropped the newest window —
      // pull the tail back so "latest" is the true newest, not a survivor.
      // Re-arm the pin + newest-anchored eviction FIRST, or the tail merge is
      // evicted around the stale deep-history anchor and never survives (HIGH).
      if (enteringLive) {
        anchorIndexRef.current = Number.MAX_SAFE_INTEGER
        pinnedRef.current = true
        void loadWindow('tail')
      }
      if (pinnedRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      return
    }
    const node = blockRefs.current.get(selectedIndex)
    if (node) {
      const landed = pendingJumpRef.current === selectedIndex
      // Skip when this is just the reverse-sync echo of the block already in
      // view — else the scroll-driven goto fights the user's own scroll and it
      // creeps one checkpoint at a time (defect 1). A just-landed far jump is
      // never an echo, so it always scrolls.
      if (!landed && selectedIndex === activeInViewRef.current) return
      // Instant snap for a far target that just loaded (smooth-from-far reads as
      // "stuck"); smooth only for a nearby, already-loaded target (item 4).
      node.scrollIntoView({ block: 'start', behavior: landed ? 'auto' : 'smooth' })
      pendingJumpRef.current = null
      onPending?.(null)
    } else if (!loading) {
      // Far target: flag it pending (rail/fan shows loading), anchor eviction on
      // it so the fetched window survives the cap (defect 1), then fetch.
      pendingJumpRef.current = selectedIndex
      onPending?.(selectedIndex)
      setLoading(true)
      anchorIndexRef.current = selectedIndex
      void fetchTracePage(terminalId, { aroundIndex: selectedIndex, limit: WINDOW })
        .then(ingest)
        .finally(() => setLoading(false))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex, blocks.length])

  // Autoscroll pin: while pinned to the bottom, keep the live tail in view as
  // it grows (a fresh block / live output).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [blocks.length, total])

  return (
    <div className="ctx-transcript" ref={scrollRef} onScroll={onScroll}>
      {/* LOW: the top sentinel only exists while a window is loading. */}
      {loading && hasOlder && <div className="ctx-older">Loading earlier checkpoints…</div>}
      {blocks.map((block) => (
        <div
          key={block.id}
          className={`ctx-block${block.index === selectedIndex ? ' active' : ''}`}
          ref={(node) => {
            if (node) blockRefs.current.set(block.index, node)
            else blockRefs.current.delete(block.index)
          }}
          data-checkpoint={block.index}
        >
          <div className="ctx-block-head">
            <span className="ctx-block-idx">T{block.index}</span>
            <span className="ctx-block-title">{checkpointTitle(block, titleMode)}</span>
          </div>
          {/* Prompt stays VERBATIM (pre-wrap) — the human's exact words. */}
          <div className="ctx-block-prompt">{block.prompt || '(empty prompt)'}</div>
          {block.activity.length > 0 && (
            <div>
              {block.activity.map((call, i) => (
                <div key={i} className="ctx-block-tool">
                  {/* TUI-faithful (unified-scroll TODO): ⏺ Name(args), then
                      the ⎿ connector + result snippet, dim phosphor. */}
                  <div className="ctx-tool-call">
                    <span className="ctx-tool-name">{call.tool}</span>
                    {call.args && <span className="ctx-tool-args">{call.args}</span>}
                  </div>
                  {call.result && <div className="ctx-tool-result">{call.result}</div>}
                </div>
              ))}
            </div>
          )}
          {/* Reply renders MARKDOWN as React elements (addendum) — bold/italics,
              lists, inline + fenced code, headings; never raw HTML. The .md flag
              is Fresco's contract: it flips the container off pre-wrap so the
              block elements own their spacing. */}
          {block.reply && (
            <div className="ctx-block-reply md">
              <MarkdownText source={block.reply} />
            </div>
          )}
        </div>
      ))}
      {/* live seam: the real xterm/tmux tail — one continuous stream. When the
          turn is at rest, the seam clips to the tail (item 1): data-clip drives
          Fresco's clip mask, and --tail-rows carries the boundary so scrollback
          above the tail no longer competes with the trace above. */}
      <div
        ref={liveRef}
        className="ctx-live"
        data-clip={clipRows !== null ? '' : undefined}
        style={clipRows !== null ? ({ ['--tail-rows']: clipRows } as React.CSSProperties) : undefined}
      >
        {children}
      </div>
    </div>
  )
})

