import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { checkpointTitle, type TitleMode } from './checkpoint-sync'
import { MarkdownText } from './MarkdownText'
import {
  activeBlockForScroll,
  coalescingSingleFlight,
  evictTrace,
  fetchTracePage,
  fractionOfIdentity,
  identityAtFraction,
  isAtBottom,
  jumpScrollBehavior,
  mergeTrace,
  pruneToTotal,
  refineEstimate,
  type TracePage,
  type TraceBlock
} from './transcript'

/** Blocks fetched per lazy page, and the cap of FULL blocks kept in memory. */
const WINDOW = 20
const MAX_BLOCKS = 60
/** Starting placeholder height (px) before any real block has measured. */
const DEFAULT_EST = 88

export interface ActiveBlock {
  /** Checkpoint identity (TurnRecord.index) of the block in view, or null (live). */
  index: number | null
  /** Marker fraction over the identity space (0 top → 1 live bottom). */
  frac: number
}

/** Imperative handle so the checkpoint rail can scrub this one scroll space. */
export interface TranscriptHandle {
  /** Scrub to a rail fraction (0 = oldest identity, 1 = live bottom). */
  scrubTo: (fraction: number) => void
}

/**
 * IDENTITY-SPACE VIRTUALIZED transcript (scroll-model rebuild). The scroll extent
 * spans the FULL checkpoint identity list (floor..ceiling from Forge's trace
 * index): loaded blocks render at their real height, every unloaded identity as
 * an estimated-height placeholder. Because the geometry is CONTINUOUS — no
 * zero-height gaps between sparse windows — scrolling down inside an early group
 * traverses placeholders instead of hitting the container bottom (no snap-to-
 * live), rail fractions map linearly onto identity space (not loaded-group
 * edges), and a click scrolls to the identity's placeholder IMMEDIATELY while its
 * content fills in. Scrolling a placeholder into view lazily fetches that window;
 * isAtBottom is true only at the real live seam (children) at the bottom.
 */
export const TranscriptView = forwardRef<
  TranscriptHandle,
  {
    terminalId: string
    /** Total completed checkpoints (activity.turnCount) — the growth trigger. */
    total: number
    /**
     * Full ordered checkpoint identity list (Forge's trace index) — defines the
     * continuous scroll space. Empty ⇒ degrade to just the loaded identities.
     */
    identities: number[]
    titleMode: TitleMode
    /** Checkpoint the user selected — scroll its identity into view. */
    selectedIndex: number | null
    /** Bumped on every EXPLICIT navigation so a re-click re-scrolls (not an echo). */
    jumpToken: number
    /** Live-tail clip (unified-scroll item 1): rows of the idle TUI tail, or null. */
    clipRows: number | null
    /** Reports the identity in view (+ marker fraction) for the timeline. */
    onActiveBlockChange?: (active: ActiveBlock) => void
    /** Reports a checkpoint whose content is FETCHING for a jump, null once filled. */
    onPending?: (index: number | null) => void
    /** The live terminal layer, seamed at the bottom of the transcript. */
    children: React.ReactNode
  }
>(function TranscriptView(
  {
    terminalId,
    total,
    identities,
    titleMode,
    selectedIndex,
    jumpToken,
    clipRows,
    onActiveBlockChange,
    onPending,
    children
  },
  ref
): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLDivElement>(null)
  const blockRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const [blocks, setBlocks] = useState<TraceBlock[]>([])
  const [estHeight, setEstHeight] = useState(DEFAULT_EST)
  const pinnedRef = useRef(true)
  const clipRef = useRef(clipRows)
  clipRef.current = clipRows
  // Eviction anchor (the identity in view) so the cap keeps the visible window.
  const anchorIndexRef = useRef<number>(Number.MAX_SAFE_INTEGER)
  // The identity currently at the viewport top — tells a genuine jump from a
  // reverse-sync echo of where you already are, so they never fight.
  const activeInViewRef = useRef<number | null>(null)
  // The checkpoint whose content is loading for a jump (drives onPending).
  const pendingJumpRef = useRef<number | null>(null)
  // Anchor preservation: the identity + its viewport-relative top captured just
  // before an ingest, so a layout effect corrects scrollTop after fills swap
  // placeholders to real heights and the landed target doesn't drift.
  const anchorRef = useRef<{ id: number; top: number } | null>(null)

  // The current identity space + loaded set, mirrored to refs so the scroll and
  // scrub callbacks (bound once) always read the latest without re-binding.
  const loadedMap = new Map(blocks.map((b) => [b.index, b]))
  const loadedSet = new Set(blocks.map((b) => b.index))
  const spaceIds = identities.length > 0 ? identities : blocks.map((b) => b.index)
  const loadedSetRef = useRef(loadedSet)
  loadedSetRef.current = loadedSet
  const spaceIdsRef = useRef(spaceIds)
  spaceIdsRef.current = spaceIds

  // True while a finger is down (item 2b): a smooth scrollIntoView is canceled by
  // the touch gesture mid-flight, so jumps snap instantly while touching.
  const touchActiveRef = useRef(false)
  useEffect(() => {
    const down = (): void => {
      touchActiveRef.current = true
    }
    const up = (): void => {
      touchActiveRef.current = false
    }
    document.addEventListener('touchstart', down, { passive: true })
    document.addEventListener('touchend', up, { passive: true })
    document.addEventListener('touchcancel', up, { passive: true })
    return () => {
      document.removeEventListener('touchstart', down)
      document.removeEventListener('touchend', up)
      document.removeEventListener('touchcancel', up)
    }
  }, [])

  // Seamless handoff (unified-scroll item 2): while the live tail is CLIPPED
  // (turn at rest), a wheel UP over the live layer scrolls the ONE combined
  // space into the trace instead of driving tmux copy-mode. Capture phase so it
  // runs BEFORE xterm's viewport handler; upward-only, until the trace above is
  // exhausted. Downward and a running turn (clip null) keep xterm/tmux scrolling.
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

  // Merge a page in, then evict FULL blocks to the cap around the identity in
  // view. Evicted identities revert to cheap placeholders, so the identity space
  // stays continuous while full-block memory stays bounded.
  const ingest = useCallback((page: { blocks: TraceBlock[]; total: number }): void => {
    // Capture the anchor (the jump target, else the identity in view) so the
    // post-commit layout effect can hold it steady while placeholders above swap
    // to real heights (WARNING). Skip when pinned — autoscroll owns the bottom.
    const el = scrollRef.current
    const anchorId = pendingJumpRef.current ?? activeInViewRef.current
    if (el && !pinnedRef.current && anchorId !== null) {
      const node = blockRefs.current.get(anchorId)
      anchorRef.current = node ? { id: anchorId, top: node.getBoundingClientRect().top } : null
    } else {
      anchorRef.current = null
    }
    setBlocks((prev) => {
      // CONTRACT (confirm with Forge): pruneToTotal drops blocks whose identity
      // exceeds page.total, so page.total MUST be the trace CEILING IDENTITY
      // (e.g. T113), not a collapsed record COUNT (100). Today's parser makes
      // them equal (index = blocks.length + 1 ⇒ ceiling == count); if it ever
      // collapses siblings (ceiling > count) a count contract would silently
      // drop T101..T113 on every ingest. Flagged.
      const merged = mergeTrace(pruneToTotal(prev, page.total), page.blocks)
      return evictTrace(merged, anchorIndexRef.current, MAX_BLOCKS)
    })
  }, [])

  const fetchWindow = useCallback(
    async (req: 'tail' | { aroundIndex: number }): Promise<TracePage> => {
      const request = req === 'tail' ? { limit: WINDOW } : { ...req, limit: WINDOW }
      const page = await fetchTracePage(terminalId, request)
      ingest(page)
      return page
    },
    [terminalId, ingest]
  )

  // Lazy fill: fetch the window around an unloaded identity (replaces the old
  // top-sentinel paging). COALESCED single-flight so a rapid second far-jump is
  // served next instead of dropped (HIGH). Give-up clears the spinner whenever
  // the target won't load — a failed fetch OR a window that didn't contain it —
  // not only the .catch path; on success the pending-clear effect clears it.
  const fill = useMemo(
    () =>
      coalescingSingleFlight(async (id: number) => {
        const page = await fetchWindow({ aroundIndex: id }).catch((error) => {
          console.error('trace fill failed:', error)
          return null
        })
        const loaded = page ? page.blocks.some((b) => b.index === id) : false
        if (!loaded && pendingJumpRef.current === id) {
          pendingJumpRef.current = null
          onPending?.(null)
        }
      }),
    [fetchWindow, onPending]
  )
  const maybeFill = useCallback(
    (id: number): void => {
      if (loadedSetRef.current.has(id)) return
      fill.request(id)
    },
    [fill]
  )

  // Newest window on mount and on any growth (turnCount change); a rewind is
  // handled by pruneToTotal inside ingest.
  useEffect(() => {
    if (total <= 0) {
      setBlocks([])
      return
    }
    anchorIndexRef.current = Number.MAX_SAFE_INTEGER
    void fetchWindow('tail')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, total])

  // offsetParent-safe identity tops: relative to the scroll container via rects,
  // over EVERY identity div (loaded blocks + placeholders).
  const identityTops = useCallback((): { index: number; top: number }[] => {
    const el = scrollRef.current
    if (!el) return []
    const base = el.getBoundingClientRect().top - el.scrollTop
    return [...blockRefs.current.entries()]
      .map(([index, node]) => ({ index, top: node.getBoundingClientRect().top - base }))
      .sort((a, b) => a.top - b.top)
  }, [])

  // One scroll pass per frame (coalesced): find the identity at the viewport top,
  // lazily fill it if it's a placeholder, and report the marker fraction linearly
  // in identity space. isAtBottom is now true ONLY at the real live seam.
  const scrollRaf = useRef(0)
  useEffect(
    () => () => {
      if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current)
    },
    []
  )
  const onScroll = useCallback((): void => {
    if (scrollRaf.current) return
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0
      const el = scrollRef.current
      if (!el) return
      pinnedRef.current = isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
      const topId = pinnedRef.current
        ? null
        : activeBlockForScroll(identityTops(), el.scrollTop + 8)
      anchorIndexRef.current = topId ?? Number.MAX_SAFE_INTEGER
      activeInViewRef.current = topId
      if (topId !== null && !loadedSetRef.current.has(topId)) maybeFill(topId)
      onActiveBlockChange?.({
        index: topId,
        frac: topId === null ? 1 : fractionOfIdentity(spaceIdsRef.current, topId)
      })
    })
  }, [identityTops, maybeFill, onActiveBlockChange])

  const jumpBehavior = useCallback(
    (): 'auto' | 'smooth' =>
      jumpScrollBehavior({
        landed: false,
        coarsePointer:
          typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
        touchActive: touchActiveRef.current
      }),
    []
  )
  // Scroll an identity's div (loaded or placeholder) to the top. Returns false
  // only when it isn't mounted yet.
  const scrollToTarget = useCallback((index: number, behavior: 'auto' | 'smooth'): boolean => {
    const node = blockRefs.current.get(index)
    if (!node) return false
    node.scrollIntoView({ block: 'start', behavior })
    return true
  }, [])

  // Rail scrub (item 4): fraction → identity (LINEAR in identity space) → scroll
  // there instantly, filling that window if it's a placeholder.
  useImperativeHandle(
    ref,
    () => ({
      scrubTo: (fraction: number): void => {
        const id = identityAtFraction(spaceIdsRef.current, fraction)
        if (id === null) return
        scrollToTarget(id, 'auto')
        if (!loadedSetRef.current.has(id)) maybeFill(id)
      }
    }),
    [scrollToTarget, maybeFill]
  )

  // Checkpoint click → scroll to the identity IMMEDIATELY (its placeholder always
  // exists), then fill content — no waiting on the fetch to move. jumpToken makes
  // a re-click re-scroll; spaceIds.length re-runs once identities load.
  const lastSelectedRef = useRef<number | null>(null)
  const jumpTokenRef = useRef(jumpToken)
  const spaceLen = spaceIds.length
  useEffect(() => {
    const explicit = jumpTokenRef.current !== jumpToken
    jumpTokenRef.current = jumpToken
    const enteringLive = selectedIndex === null && lastSelectedRef.current !== null
    lastSelectedRef.current = selectedIndex
    if (selectedIndex === null) {
      // Returning to live: re-arm the pin + newest-anchored eviction, pull the
      // tail so "latest" is the true newest.
      if (enteringLive || explicit) {
        anchorIndexRef.current = Number.MAX_SAFE_INTEGER
        pinnedRef.current = true
        void fetchWindow('tail')
      }
      if (pinnedRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      return
    }
    // Skip only a reverse-sync echo of where we already are (else scroll fights);
    // an explicit click/scrub always (re-)scrolls, so re-clicking never feels dead.
    if (!explicit && selectedIndex === activeInViewRef.current) return
    const near = loadedSetRef.current.has(selectedIndex)
    // A far (placeholder) target snaps instantly — smooth-over-a-huge-gap reads
    // as stuck; a nearby loaded target scrolls smoothly (touch → instant, 2b).
    const scrolled = scrollToTarget(selectedIndex, near ? jumpBehavior() : 'auto')
    if (scrolled && !near) {
      pendingJumpRef.current = selectedIndex
      onPending?.(selectedIndex)
      maybeFill(selectedIndex)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex, jumpToken, spaceLen])

  // Clear the loading affordance once the pending target's content has arrived.
  useEffect(() => {
    const pending = pendingJumpRef.current
    if (pending !== null && loadedMap.has(pending)) {
      pendingJumpRef.current = null
      onPending?.(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks])

  // Anchor preservation (WARNING): after a fill commits, hold the captured
  // anchor identity at its prior viewport position by correcting scrollTop for
  // the height the placeholders-above gained — so the landed target stays put
  // instead of drifting. Runs before paint, so the correction is invisible.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const el = scrollRef.current
    if (anchor && el) {
      const node = blockRefs.current.get(anchor.id)
      if (node) {
        const delta = node.getBoundingClientRect().top - anchor.top
        if (delta !== 0) el.scrollTop += delta
      }
      anchorRef.current = null
    }
  }, [blocks])

  // Refine the placeholder estimate from measured block heights (skips zero
  // heights so a layout-less environment keeps the default).
  useLayoutEffect(() => {
    const measured: number[] = []
    for (const b of blocks) {
      const node = blockRefs.current.get(b.index)
      if (node) measured.push(node.offsetHeight)
    }
    const next = refineEstimate(estHeight, measured)
    if (Math.abs(next - estHeight) > 8) setEstHeight(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks])

  // Autoscroll pin: keep the live tail in view as content grows / placeholders
  // resize, while pinned to the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [blocks.length, total, estHeight])

  return (
    <div className="ctx-transcript" ref={scrollRef} onScroll={onScroll}>
      {spaceIds.map((id) => {
        const block = loadedMap.get(id)
        const active = id === selectedIndex
        return (
          <div
            key={id}
            className={
              block ? `ctx-block${active ? ' active' : ''}` : `ctx-placeholder${active ? ' active' : ''}`
            }
            data-checkpoint={id}
            style={block ? undefined : { height: estHeight }}
            ref={(node) => {
              if (node) blockRefs.current.set(id, node)
              else blockRefs.current.delete(id)
            }}
          >
            {block ? (
              <>
                <div className="ctx-block-head">
                  <span className="ctx-block-idx">T{id}</span>
                  <span className="ctx-block-title">{checkpointTitle(block, titleMode)}</span>
                </div>
                {/* Prompt stays VERBATIM (pre-wrap) — the human's exact words. */}
                <div className="ctx-block-prompt">{block.prompt || '(empty prompt)'}</div>
                {block.activity.length > 0 && (
                  <div>
                    {block.activity.map((call, i) => (
                      <div key={i} className="ctx-block-tool">
                        <div className="ctx-tool-call">
                          <span className="ctx-tool-name">{call.tool}</span>
                          {call.args && <span className="ctx-tool-args">{call.args}</span>}
                        </div>
                        {call.result && <div className="ctx-tool-result">{call.result}</div>}
                      </div>
                    ))}
                  </div>
                )}
                {/* Reply renders MARKDOWN as React elements; .md is Fresco's flag. */}
                {block.reply && (
                  <div className="ctx-block-reply md">
                    <MarkdownText source={block.reply} />
                  </div>
                )}
              </>
            ) : (
              <span className="ctx-placeholder-idx">T{id}</span>
            )}
          </div>
        )
      })}
      {/* live seam: the real xterm/tmux tail — one continuous stream. When the
          turn is at rest, the seam clips to the tail (item 1). */}
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
