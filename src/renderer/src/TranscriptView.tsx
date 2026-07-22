import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { checkpointTitle, type TitleMode } from './checkpoint-sync'
import {
  activeBlockForScroll,
  blockMarkerFraction,
  evictTrace,
  fetchTracePage,
  isAtBottom,
  mergeTrace,
  pruneToTotal,
  type TraceBlock
} from './transcript'

/** Blocks fetched per lazy page, and the cap kept in memory (BLOCK 3). */
const WINDOW = 20
const MAX_BLOCKS = 60

export interface ActiveBlock {
  /** Checkpoint identity (TurnRecord.index) of the block in view, or null (live). */
  index: number | null
  /** Marker fraction over the rail (0 oldest → 1 live). */
  frac: number
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
export function TranscriptView({
  terminalId,
  total,
  titleMode,
  selectedIndex,
  onActiveBlockChange,
  children
}: {
  terminalId: string
  /** Total completed checkpoints (activity.turnCount) — grows/shrinks on rewind. */
  total: number
  titleMode: TitleMode
  /** Checkpoint the user selected (paging.viewing) — scroll its block into view. */
  selectedIndex: number | null
  /** Reports the block in view (identity + marker fraction) for the timeline. */
  onActiveBlockChange?: (active: ActiveBlock) => void
  /** The live terminal layer, seamed at the bottom of the transcript. */
  children: React.ReactNode
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const blockRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const [blocks, setBlocks] = useState<TraceBlock[]>([])
  const [traceTotal, setTraceTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const pinnedRef = useRef(true)
  const anchorIndexRef = useRef<number>(Number.MAX_SAFE_INTEGER)
  const oldestIndex = blocks[0]?.index ?? null
  const hasOlder = oldestIndex !== null && oldestIndex > 1

  // Merge a page in, then evict to the cap around the block currently in view.
  const ingest = useCallback((page: { blocks: TraceBlock[]; total: number }): void => {
    setTraceTotal(page.total)
    setBlocks((prev) => {
      const merged = mergeTrace(pruneToTotal(prev, page.total), page.blocks)
      return evictTrace(merged, anchorIndexRef.current, MAX_BLOCKS)
    })
  }, [])

  const loadWindow = useCallback(
    async (anchor: 'tail' | { beforeIndex: number }): Promise<void> => {
      // IDENTITY anchors (review BLOCK 2): the tail window on mount/growth,
      // blocks older than the oldest LOADED identity on scroll-up — never
      // array offsets, which renumber under rewinds and caps.
      const request = anchor === 'tail' ? { limit: WINDOW } : { ...anchor, limit: WINDOW }
      const page = await fetchTracePage(terminalId, request)
      ingest(page)
    },
    [terminalId, ingest]
  )

  // Newest window on mount and on any total change; a rewind (total shrink) is
  // handled by pruneToTotal inside ingest, so stale blocks drop automatically.
  useEffect(() => {
    if (total <= 0) {
      setBlocks([])
      setTraceTotal(0)
      return
    }
    anchorIndexRef.current = Number.MAX_SAFE_INTEGER
    void loadWindow('tail')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, total])

  // Lazy scroll-up: prepend the previous window, preserving the scroll offset.
  const loadOlder = useCallback(async () => {
    if (loading || !hasOlder) return
    setLoading(true)
    const el = scrollRef.current
    const before = el?.scrollHeight ?? 0
    await loadWindow(oldestIndex === null ? 'tail' : { beforeIndex: oldestIndex })
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - before
      setLoading(false)
    })
  }, [loading, hasOlder, oldestIndex, loadWindow])

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
    const tops = blockTops()
    const activeIndex = pinnedRef.current ? null : activeBlockForScroll(tops, el.scrollTop + 8)
    anchorIndexRef.current = activeIndex ?? Number.MAX_SAFE_INTEGER
    if (onActiveBlockChange) {
      onActiveBlockChange({
        index: activeIndex,
        frac: blockMarkerFraction(activeIndex, traceTotal)
      })
    }
  }, [loadOlder, blockTops, onActiveBlockChange, traceTotal])

  // Checkpoint click → scroll that block into view, fetching a window around it
  // when it is not loaded (truncation-immune: the record always exists in the
  // trace, even far past TUI erasure).
  useEffect(() => {
    if (selectedIndex === null) {
      if (pinnedRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      return
    }
    const node = blockRefs.current.get(selectedIndex)
    if (node) {
      node.scrollIntoView({ block: 'start', behavior: 'smooth' })
    } else if (!loading) {
      setLoading(true)
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
          <div className="ctx-block-prompt">{block.prompt || '(empty prompt)'}</div>
          {block.activity.length > 0 && (
            <div>
              {block.activity.map((line, i) => (
                <div key={i} className="ctx-block-tool">
                  {line}
                </div>
              ))}
            </div>
          )}
          {block.reply && <div className="ctx-block-reply">{block.reply}</div>}
        </div>
      ))}
      {/* live seam: the real xterm/tmux tail — one continuous stream. */}
      <div className="ctx-live">{children}</div>
    </div>
  )
}

