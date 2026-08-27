import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import type { IClipboardProvider } from '@xterm/addon-clipboard'
import { readClipboardText, writeClipboardText } from './clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TerminalNodeData } from '../../shared/model'
import type { VersionPinRecord } from '../../shared/version-pin'
import type { TerminalActivity, TurnPhase } from '../../shared/turn'
import type { LodLayout, ScreenRect } from './zoom-lod'
import { useCanvasUi } from './canvas-ui'
import { cookrew, isRemoteMode } from './api'
import { useTurnPaging } from './nodes/TurnPager'
import { CheckpointTimeline } from './CheckpointTimeline'
import { TranscriptView, type ActiveBlock, type TranscriptHandle } from './TranscriptView'
import {
  fetchTraceIndex,
  fetchTraceMarkers,
  mergeCheckpointRows,
  tailClipRows,
  traceRowLabel,
  type TraceIndexEntry,
  type TraceMarkerRow
} from './transcript'
import { checkpointTitle, useTitleMode } from './checkpoint-sync'
import { attachFilesToTerminal, pasteClipboardImages } from './AttachButton'
import { handleTerminalPaste } from './terminal-paste'
import { terminalKeyIntent } from './terminal-key-intent'
import { CrIcon } from './icons'
import { TranslateButton } from './TranslateButton'
import { languageByCode } from '../../shared/translate'
import { useCheckpointTranslation } from './use-checkpoint-translation'
import { StatusCoin } from './nodes/AgentAvatar'

const PHOSPHOR_THEME = {
  background: '#14110A',
  foreground: '#E9B949',
  cursor: '#FFD77A',
  cursorAccent: '#14110A',
  selectionBackground: '#5C4A1F',
  black: '#14110A',
  brightBlack: '#8A6D1C',
  white: '#FFD77A',
  brightWhite: '#FFFEF5'
}

/**
 * Full views for terminal cards under semantic zoom: whenever a terminal
 * card covers enough of the stage (zoomed in by click or by hand), the live
 * xterm mounts in an overlay aligned to the card's screen rect and fades in
 * over the thumbnail. Zooming back out unmounts it — the PTY itself lives
 * in the main process, so nothing is lost between mounts.
 */
/** Menu name for a code, degrading to the code itself rather than to blank. */
function languageName(code: string | null): string {
  if (code === null) return 'another language'
  return languageByCode(code)?.name ?? code
}

export function TerminalOverlayLayer({
  terminals,
  activities,
  lod,
  onPrimaryChange
}: {
  terminals: TerminalNodeData[]
  activities: Record<string, TerminalActivity>
  /** SHARED overlay arbitration (App-owned, spans terminals + browsers). */
  lod: LodLayout
  /** Reports the zoomed-in terminal (most-covered active) — null on canvas. */
  onPrimaryChange?: (id: string | null) => void
}): React.JSX.Element {
  const { activeIds, rects, primaryId } = lod
  // The dock composer only follows TERMINALS: when a browser wins the
  // shared arbitration, there is no composer target.
  const primaryTerminal =
    primaryId !== null && terminals.some((t) => t.id === primaryId) ? primaryId : null
  useEffect(() => {
    onPrimaryChange?.(primaryTerminal)
  }, [primaryTerminal, onPrimaryChange])
  return (
    <>
      {terminals
        .filter((t) => activeIds.has(t.id) && rects[t.id])
        .map((t) => (
          <TerminalOverlay key={t.id} node={t} activity={activities[t.id]} rect={rects[t.id]} />
        ))}
    </>
  )
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The header line carries the agent's live status, not its name. */
const PHASE_CHIP: Record<TurnPhase, { label: string; cls: string }> = {
  idle: { label: 'READY', cls: '' },
  thinking: { label: 'WORKING', cls: ' busy' },
  waiting: { label: 'NEEDS ATTENTION', cls: ' attention' },
  replied: { label: 'CHECKPOINT SAVED', cls: ' done' }
}

function TerminalOverlay({
  node,
  activity,
  rect
}: {
  node: TerminalNodeData
  activity: TerminalActivity | undefined
  rect: ScreenRect
}): React.JSX.Element {
  const { zoomBack, requestClose } = useCanvasUi()
  const containerRef = useRef<HTMLDivElement>(null)
  // Drag-in attachments: dragenter/leave bubble from every child of the
  // overlay, so a plain boolean would flicker — count enters vs leaves.
  const [dropReady, setDropReady] = useState(false)
  const dragDepth = useRef(0)
  // Read by the key handler below through a ref so the xterm (created once
  // per node) always sees the latest agent detection from activity events.
  const agentRef = useRef(false)
  agentRef.current = activity?.agent ?? node.preset !== 'Shell'

  // Turn switching: ◀ ▶ page through past asks; picking one scrolls the
  // terminal to that ask's line (tmux copy-mode search), and returning to
  // live exits copy-mode so the tail streams again.
  const paging = useTurnPaging(node.id, activity?.turnCount ?? 0, { eager: true })
  const [titleMode, toggleTitleMode] = useTitleMode()

  // FULL-TRACE SELECTION (item 3): the fan/timeline spans the WHOLE trace range
  // — Forge's cheap identity listing merged with the capped record store — so
  // every traced checkpoint, INCLUDING identities below the record cap (e.g.
  // T1..T7 when the store starts at T8), is a selectable row. Selection is an
  // explicit identity, decoupled from the record cursor (which can't represent
  // sub-cap identities); the trace is the only target (no tmux copy-mode), and
  // the record-based pager is kept in sync best-effort for the header/fork.
  const [traceIndex, setTraceIndex] = useState<TraceIndexEntry[]>([])
  const [traceMarkers, setTraceMarkers] = useState<TraceMarkerRow[]>([])
  useEffect(() => {
    let alive = true
    void fetchTraceIndex(node.id)
      .then((list) => {
        if (alive) setTraceIndex(list)
      })
      .catch((error) => {
        // Absent bridge already warned once inside fetchTraceIndex; a present
        // bridge that REJECTS is a different failure — surface it, don't swallow.
        console.error('listTraceIndex failed:', error)
      })
    void fetchTraceMarkers(node.id)
      .then((list) => {
        if (alive) setTraceMarkers(list)
      })
      .catch((error) => console.error('listTraceMarkers failed:', error))
    return () => {
      alive = false
    }
  }, [node.id, activity?.turnCount])

  // VERSION PINS on the rail. Fetched here and passed to the timeline, which
  // otherwise received nothing — so a saved template's pin was cut in the main
  // process and never rendered. Re-fetch on the same turn signal as the trace,
  // plus a bump when a template is saved (a save adds no turn, so turnCount
  // alone would miss it). Without the save signal the marker only appeared
  // after the next turn — which read as "save did nothing".
  const [pins, setPins] = useState<VersionPinRecord[]>([])
  const [pinRefresh, setPinRefresh] = useState(0)
  useEffect(() => {
    const bump = (): void => setPinRefresh((n) => n + 1)
    window.addEventListener('cookrew:template-saved', bump)
    return () => window.removeEventListener('cookrew:template-saved', bump)
  }, [])
  useEffect(() => {
    let alive = true
    void cookrew()
      .listPins(node.id)
      .then((list) => {
        if (alive) setPins(list)
      })
      .catch((error) => console.error('listPins failed:', error))
    return () => {
      alive = false
    }
  }, [node.id, activity?.turnCount, pinRefresh])

  const rows = mergeCheckpointRows(paging.records ?? [], traceIndex)

  const transcriptRef = useRef<TranscriptHandle>(null)
  const translation = useCheckpointTranslation()
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [activeBlock, setActiveBlock] = useState<ActiveBlock>({ index: null, frac: 1 })
  // A checkpoint whose trace block is still fetching for a jump — the rail/fan
  // shows it loading so a far click gives instant feedback (item 4).
  const [pendingIndex, setPendingIndex] = useState<number | null>(null)
  // Bumped on every explicit click/LIVE so a re-click of the row already in view
  // still re-scrolls (item 2a) — a same-value setSelectedIndex alone wouldn't
  // re-run the jump.
  const [jumpToken, setJumpToken] = useState(0)

  const gotoCheckpoint = (index: number): void => {
    setSelectedIndex(index)
    setJumpToken((t) => t + 1)
    paging.goto(index) // best-effort: syncs the record-backed header/fork
  }
  const goLive = (): void => {
    setSelectedIndex(null)
    setJumpToken((t) => t + 1)
    paging.live()
  }
  // Scrolling the transcript reports the block in view (onActiveBlockChange),
  // which steps the active checkpoint; the click/scrub → selectedIndex direction
  // and this scroll → selectedIndex direction stay in sync, and TranscriptView's
  // echo-skip keeps them from fighting, so no anti-bounce guard is needed.
  const onActiveBlockChange = (active: ActiveBlock): void => {
    setActiveBlock(active)
    if (active.index === selectedIndex) return
    setSelectedIndex(active.index)
    if (active.index === null) paging.live()
    else paging.goto(active.index)
  }
  const selectedRow = selectedIndex !== null ? (rows.find((r) => r.index === selectedIndex) ?? null) : null
  const selectedTitle =
    selectedIndex === null
      ? ''
      : selectedRow?.record
        ? checkpointTitle(selectedRow.record, titleMode)
        : traceRowLabel(selectedIndex, selectedRow?.traceTitle ?? '')

  const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      theme: PHOSPHOR_THEME,
      fontFamily: 'JetBrains Mono, SF Mono, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      // A phone cannot hold a 5000-line scrollback for a high-output agent
      // (Conductor) on top of the WebGL/GPU cost — that is the zoom-in OOM.
      // Keep a small buffer on mobile; the paged transcript above is the real
      // history, this pane is just the live tail.
      scrollback: isRemoteMode() ? 600 : 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    // OSC 52 support: tmux (set-clipboard on) forwards its mouse-drag copies
    // as OSC 52, and this addon applies them to the system clipboard — so
    // selecting in a terminal IS copying. Writes route through
    // writeClipboardText, whose execCommand fallback keeps copies working in
    // insecure remote contexts (phone over plain http) where
    // navigator.clipboard is undefined.
    try {
      const provider: IClipboardProvider = {
        readText: async () => (await readClipboardText()) ?? '',
        writeText: async (_selection, text) => {
          await writeClipboardText(text)
        }
      }
      term.loadAddon(new ClipboardAddon(undefined, provider))
    } catch {
      // clipboard unavailable — selection still works inside tmux
    }

    // Local selections (⌥+drag bypasses tmux's mouse capture) copy on
    // release too, matching the tmux-side behavior above.
    let copyTimer: ReturnType<typeof setTimeout> | null = null
    const selectionSub = term.onSelectionChange(() => {
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        const text = term.getSelection()
        if (text) void writeClipboardText(text)
      }, 150)
    })

    // The decision is pure and unit-tested (terminal-key-intent.ts); only the
    // effects live here. That split is not tidiness: this callback runs inside
    // xterm's key dispatch, so a throw does not surface as an error — it
    // swallows the keystroke. A soft keyboard's IME can hand us events with no
    // `key`, which is what silently ate the digits and punctuation from a CJK
    // keyboard's secondary layer.
    term.attachCustomKeyEventHandler((event) => {
      const intent = terminalKeyIntent(event, {
        agent: agentRef.current,
        hasSelection: term.hasSelection()
      })
      switch (intent) {
        case 'agent-newline':
          // ESC+CR is the "insert newline" binding of Claude Code and friends;
          // returning false swallows the plain CR xterm would emit.
          if (event.type === 'keydown') cookrew().ptyInput(node.id, '\x1b\r')
          return false
        case 'copy':
          if (event.type === 'keydown') void writeClipboardText(term.getSelection())
          return false
        case 'swallow-paste':
          return false
        default:
          return true
      }
    })

    // Single paste path (text AND images): reading the text off the event
    // works in insecure contexts (phone) too, and preventDefault + capture
    // suppress xterm's own native paste so nothing is inserted twice. Image
    // bytes have no file path, so they save via the attach flow like a drag-in.
    const onPaste = (event: ClipboardEvent): void => {
      handleTerminalPaste(event, {
        pasteText: (text) => term.paste(text),
        pasteImages: (images) =>
          void pasteClipboardImages(node.id, images).catch((error) =>
            console.error('Image paste failed:', error)
          )
      })
    }
    container.addEventListener('paste', onPaste, true)

    let disposed = false
    const cleanups: Array<() => void> = [() => term.dispose()]
    cleanups.push(() => {
      if (copyTimer) clearTimeout(copyTimer)
      selectionSub.dispose()
      container.removeEventListener('paste', onPaste, true)
    })

    // xterm measures cell width once at open(). If the webfont swaps in
    // afterwards, rendered glyph width no longer matches the measured cell
    // and every row drifts — so the font must be resolved before open().
    const fontReady = document.fonts.load('13px "JetBrains Mono"').catch(() => undefined)

    void fontReady.then(() => {
      if (disposed) return
      term.open(container)

      // WebGL renderer pins every glyph to its grid cell, so CJK fallback
      // glyphs (JetBrains Mono has none) can't accumulate horizontal drift
      // the way the DOM renderer lets them. Losing the context falls back
      // to the DOM renderer, which is degraded but functional.
      //
      // NOT on a phone: iOS Safari's WebGL is memory-constrained and unstable —
      // a live-streaming agent's xterm on a WebGL context is a prime OOM /
      // context-loss crash (the Conductor zoom-in crash). The DOM renderer is
      // lighter and does not touch the GPU, so mobile uses it.
      if (!isRemoteMode()) {
        try {
          const webgl = new WebglAddon()
          webgl.onContextLoss(() => webgl.dispose())
          term.loadAddon(webgl)
        } catch {
          // WebGL unavailable — DOM renderer still works
        }
      }

      // Fit can report bogus dimensions before layout finishes — retry
      // until the measured size settles.
      const fitUntilStable = (attempt = 0): void => {
        if (disposed) return
        try {
          if (container.offsetWidth > 40) {
            fit.fit()
            cookrew().ptyResize(node.id, term.cols, term.rows)
          }
        } catch {
          // ignore; retried below
        }
        if (attempt < 8 && (term.cols < 20 || container.offsetWidth <= 40)) {
          setTimeout(() => fitUntilStable(attempt + 1), 250 * (attempt + 1))
        }
      }
      fitUntilStable()

      // Adopt the mirror's geometry BEFORE the first byte. The replay frame is
      // serialized at the mirror's columns and herdr's later deltas address the
      // cursor absolutely against them, so painting them into a differently
      // sized grid re-wraps lines and drops blocks at the wrong rows — the
      // scrambled transcript. The fit-driven resize kick below then moves the
      // PANE to this viewer's size, and the server answers with a fresh frame.
      // Adoption needs a counterweight. Adopting alone means the LAST viewer
      // to resize owns every other viewer's layout forever: a phone opening
      // the same terminal shrinks the pane to 45x24 and the desktop renders a
      // narrow strip in a full-width card until someone drags the window
      // (measured in herdr mode; tmux mode behaved as last-writer-wins, so
      // the active viewer always recovered). The rule that restores that:
      // adopt the frame so it paints correctly, then — if THIS viewer is the
      // focused one and the pane's size is not its own — re-assert its fitted
      // size. Idle viewers adopt and stay quiet, so two viewers cannot fight.
      let reassertTimer: ReturnType<typeof setTimeout> | null = null
      const detach = cookrew().ptyAttach(
        node.id,
        (chunk) => term.write(chunk),
        ({ cols, rows }) => {
          if (disposed || cols <= 0 || rows <= 0) return
          term.resize(cols, rows)
          if (document.visibilityState !== 'visible' || !document.hasFocus()) return
          if (reassertTimer) clearTimeout(reassertTimer)
          reassertTimer = setTimeout(() => {
            if (disposed) return
            try {
              fit.fit()
              if (term.cols !== cols || term.rows !== rows) {
                cookrew().ptyResize(node.id, term.cols, term.rows)
              }
            } catch {
              // container may be mid-teardown
            }
          }, 400)
        }
      )
      cleanups.push(() => {
        if (reassertTimer) clearTimeout(reassertTimer)
      })
      const inputSub = term.onData((input) => cookrew().ptyInput(node.id, input))
      // Focus pops the software keyboard AND (with a small-font textarea)
      // iOS's page auto-zoom — on a phone that fired the zoom/resize loop the
      // moment the overlay opened. Desktop keeps instant focus; the phone
      // focuses on the first deliberate tap of the pane.
      if (!isRemoteMode()) {
        term.focus()
      } else {
        const focusOnTap = (): void => term.focus()
        container.addEventListener('pointerup', focusOnTap, { once: true })
        cleanups.push(() => container.removeEventListener('pointerup', focusOnTap))
      }

      // The attach replay is plain text and cannot reconstruct a TUI's
      // internal screen state — incremental redraws (ink/Claude Code) then
      // land on a wrong baseline and scatter. A double resize (SIGWINCH)
      // forces the app to repaint its real screen at the overlay size.
      const kickTimer = setTimeout(() => {
        if (disposed || term.cols < 21) return
        cookrew().ptyResize(node.id, term.cols - 1, term.rows)
        setTimeout(() => {
          if (!disposed) cookrew().ptyResize(node.id, term.cols, term.rows)
        }, 60)
      }, 200)
      cleanups.push(() => clearTimeout(kickTimer))

      // Touch scrolling: tmux runs with `mouse on`, so xterm sits in
      // mouse-tracking mode and its built-in touch scrolling is disabled
      // (the handlers bail while mouse events are active — xterm marks that
      // state with the enable-mouse-events class). Bridge touch drags into
      // synthetic wheel events aimed at xterm's own wheel handler, which
      // forwards them to tmux as scroll reports — one per row of finger
      // travel, so a phone swipe scrolls like a desktop wheel. When mouse
      // tracking is off, xterm's native touch path works and the bridge
      // stands down.
      let touchY: number | null = null
      let lastTouch: { x: number; y: number } | null = null
      /** Recent samples (~last 120ms) — velocity source for the fling. */
      let history: Array<{ t: number; y: number }> = []
      /** Sub-row remainder so slow drags and glide frames still accumulate. */
      let carry = 0
      let glideRaf = 0
      let glideV = 0

      const trackingEl = (): Element | null =>
        container.querySelector('.xterm.enable-mouse-events')

      const emitScroll = (px: number): void => {
        const target = trackingEl()
        if (!target || !lastTouch) return
        const rowPx = Math.max(12, container.clientHeight / Math.max(term.rows, 1))
        carry += px
        while (Math.abs(carry) >= rowPx) {
          const sign = carry > 0 ? 1 : -1
          target.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: lastTouch.x,
              clientY: lastTouch.y,
              deltaY: sign * rowPx,
              deltaMode: WheelEvent.DOM_DELTA_PIXEL
            })
          )
          carry -= sign * rowPx
        }
      }

      const stopGlide = (): void => {
        if (glideRaf) cancelAnimationFrame(glideRaf)
        glideRaf = 0
      }

      const onTouchStart = (e: TouchEvent): void => {
        stopGlide()
        carry = 0
        if (e.touches.length === 1) {
          touchY = e.touches[0].clientY
          history = [{ t: performance.now(), y: touchY }]
        } else {
          touchY = null
        }
      }
      const onTouchMove = (e: TouchEvent): void => {
        if (touchY === null || e.touches.length !== 1 || !trackingEl()) return
        const touch = e.touches[0]
        lastTouch = { x: touch.clientX, y: touch.clientY }
        const now = performance.now()
        history = [...history.filter((h) => now - h.t < 120), { t: now, y: touch.clientY }]
        emitScroll(touchY - touch.clientY)
        touchY = touch.clientY
        e.preventDefault()
      }
      // Fling: on release, keep scrolling with the finger's exit velocity,
      // decaying exponentially (~0.9s from a hard flick) — iOS-style
      // momentum the browser can't provide because the bridge preventDefaults
      // the native gesture.
      const onTouchEnd = (): void => {
        const wasTracking = touchY !== null
        touchY = null
        if (!wasTracking || history.length < 2) return
        const newest = history[history.length - 1]
        const oldest = history[0]
        const span = newest.t - oldest.t
        if (span <= 0) return
        const velocity = (oldest.y - newest.y) / span
        if (Math.abs(velocity) < 0.25) return
        glideV = Math.max(-3, Math.min(3, velocity))
        let lastFrame = performance.now()
        const frame = (now: number): void => {
          const dt = now - lastFrame
          lastFrame = now
          emitScroll(glideV * dt)
          glideV *= Math.pow(0.92, dt / 16.7)
          glideRaf = Math.abs(glideV) > 0.04 ? requestAnimationFrame(frame) : 0
        }
        glideRaf = requestAnimationFrame(frame)
      }
      const onTouchCancel = (): void => {
        touchY = null
        history = []
      }
      container.addEventListener('touchstart', onTouchStart, { passive: true })
      container.addEventListener('touchmove', onTouchMove, { passive: false })
      container.addEventListener('touchend', onTouchEnd, { passive: true })
      container.addEventListener('touchcancel', onTouchCancel, { passive: true })
      cleanups.push(() => {
        stopGlide()
        container.removeEventListener('touchstart', onTouchStart)
        container.removeEventListener('touchmove', onTouchMove)
        container.removeEventListener('touchend', onTouchEnd)
        container.removeEventListener('touchcancel', onTouchCancel)
      })

      // The overlay rect keeps tracking the viewport while the user zooms
      // or pans, so resizes stream in — debounce the refit to avoid
      // hammering the TUI with SIGWINCH every frame.
      let refitTimer: ReturnType<typeof setTimeout> | null = null
      const observer = new ResizeObserver(() => {
        if (refitTimer) clearTimeout(refitTimer)
        refitTimer = setTimeout(() => {
          try {
            fit.fit()
            cookrew().ptyResize(node.id, term.cols, term.rows)
          } catch {
            // container may be mid-teardown
          }
        }, 120)
      })
      observer.observe(container)

      cleanups.push(() => {
        if (refitTimer) clearTimeout(refitTimer)
        observer.disconnect()
        inputSub.dispose()
        detach()
      })
    })

    return () => {
      disposed = true
      // dispose in reverse: detach stream/observers before killing the term
      for (const cleanup of cleanups.reverse()) cleanup()
    }
  }, [node.id])

  const phase = activity?.phase ?? 'idle'

  // Live-tail-only clip (unified-scroll item 1): when the turn is at rest, keep
  // only Forge's tail boundary in the live layer; the trace owns older
  // scrollback. Null (no clip) while a turn runs or when no boundary was found.
  const clipRows = tailClipRows(phase, activity?.tailLines ?? null)

  // Acknowledge-on-view: a mounted overlay means the user is LOOKING at this
  // terminal (desktop zoom / phone popout), so a completed turn is read the
  // moment it is — or becomes — visible here. The tracker demotes replied →
  // idle and keeps prompt/reply/title; every other phase ignores the signal,
  // so this can never end a live or waiting turn. Compact-card glances don't
  // count: no overlay, no signal.
  useEffect(() => {
    if (phase === 'replied') cookrew().turnSeen(node.id)
  }, [phase, node.id])

  const hasFiles = (e: React.DragEvent): boolean =>
    Array.from(e.dataTransfer.types).includes('Files')

  const onDrop = (e: React.DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDropReady(false)
    void attachFilesToTerminal(node.id, Array.from(e.dataTransfer.files)).catch((error) =>
      console.error('Attachment drop failed:', error)
    )
  }

  return (
    <div
      className="lod-overlay"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current += 1
        setDropReady(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDropReady(false)
      }}
      onDrop={onDrop}
    >
      <div className="popout-header">
        {/* One coin only: it carries both identity (brand mark) and status.
            Header line mirrors the full card: coin · name · [STATUS]. */}
        <StatusCoin phase={phase} preset={node.preset} title={`${node.name} · ${node.preset}`} />
        <span className="popout-name" title={`${node.name} · ${node.preset}`}>
          {node.name}
        </span>
        {node.orch && <span className="cr-chip amber">ORCH</span>}
        <span className={`cr-chip${PHASE_CHIP[phase].cls}`}>{PHASE_CHIP[phase].label}</span>
        <div className="popout-actions">
          <TranslateButton
            active={translation.showing !== null}
            working={translation.working}
            language={translation.language}
            onMouseDown={keepFocus}
            onClear={translation.clear}
            onPick={(code) => {
              /**
               * NO SELECTION MEANS THE NEWEST, not nothing.
               *
               * This used to be disabled whenever selectedIndex was null, which
               * on a phone is how every card opens — you tap in, you are live,
               * and the button is dead. The reason it was dead lived in a
               * `title` tooltip, and touch devices do not show tooltips, so it
               * was an inert control with an invisible explanation. Live is not
               * "no checkpoint": it is the latest one, which is exactly the
               * body someone opening a card wants read back to them.
               */
              const target = selectedIndex ?? rows[rows.length - 1]?.index ?? null
              if (target === null) {
                translation.note('This card has no checkpoint to translate yet.')
                return
              }
              // The text comes from the view that already rendered it. A
              // checkpoint scrolled far out of the loaded window has been
              // evicted, and saying so beats a button that looks broken.
              const body = transcriptRef.current?.blockText(target) ?? null
              if (body === null) {
                translation.note(
                  `Checkpoint T${target} is not loaded yet — scroll to it and try again.`
                )
                return
              }
              translation.translate(target, body, code)
            }}
          />
          <button
            className="cr-btn sm icon"
            aria-label={
              titleMode === 'conclusion' ? 'Titles: conclusions' : 'Titles: precise prompts'
            }
            title={
              titleMode === 'conclusion'
                ? 'Checkpoint titles: conclusions — click for precise prompts'
                : 'Checkpoint titles: precise prompts — click for conclusions'
            }
            onMouseDown={keepFocus}
            onClick={toggleTitleMode}
          >
            <CrIcon name={titleMode === 'conclusion' ? 'summary' : 'terminal'} />
          </button>
          {/* The "fork from a past checkpoint" button is deprecated — fork is now
              available per-checkpoint in the timeline (State A hold + State B
              rows), so the standalone header button is redundant. */}
          <button
            className="cr-btn sm icon popout-close"
            title="Back to canvas (Esc)"
            aria-label="Back to canvas"
            onClick={zoomBack}
          >
            <CrIcon name="collapse" />
          </button>
          <button
            className="cr-btn sm icon popout-kill"
            title="Close card & kill session (⌘W)"
            aria-label="Close card & kill session"
            onClick={() => requestClose(node.id)}
          >
            <CrIcon name="close" />
          </button>
        </div>
      </div>
      {(selectedIndex !== null || activity?.prompt) && (
        <div className="popout-ask" title={selectedRow?.record?.prompt ?? selectedTitle ?? activity?.prompt ?? ''}>
          <span className="popout-ask-label">
            {/* Identity, not position: T-number matches the transcript + rail
                labels. A record-backed pick adds its "of N"; a sub-cap trace-only
                pick shows the identity alone (it has no record position). */}
            {selectedIndex === null
              ? 'YOU ❯'
              : selectedRow?.record
                ? `CHECKPOINT T${selectedIndex} · ${paging.position} of ${paging.count} ❯`
                : `CHECKPOINT T${selectedIndex} ❯`}
          </span>
          <span className="popout-ask-text">
            {selectedIndex !== null ? clip(selectedTitle, 300) : clip(activity?.prompt ?? '', 300)}
          </span>
          {selectedIndex !== null && (
            <button
              className="cr-btn sm popout-ask-live"
              title="Back to live"
              onMouseDown={keepFocus}
              onClick={goLive}
            >
              LIVE
            </button>
          )}
        </div>
      )}
      {/* SAY WHICH WORDS THESE ARE.
          A translated body is still prose in a card that usually holds the
          agent's own words, and the difference is invisible once you are
          reading it. This strip is the only thing that distinguishes "the agent
          said this" from "a 1.5b model's rendering of what the agent said" —
          and when Sous fails it is where the reason goes, instead of a button
          that silently does nothing. */}
      {(translation.working || translation.error !== null || translation.showing !== null) && (
        <div
          className={`popout-translation${translation.error !== null ? ' failed' : ''}`}
          role="status"
        >
          {translation.working ? (
            <span>
              Translating into {languageName(translation.language)}
              {translation.host !== null ? ` via ${translation.host}` : ' on this machine'}
              {/* The count is the whole point of the strip on a long body: a
                  local model runs about 19s per 3000 characters, so without a
                  number that moves there is no way to tell working from hung. */}
              {translation.progress !== null &&
                translation.progress.total > 1 &&
                ` — ${translation.progress.done} of ${translation.progress.total}`}
              …
            </span>
          ) : translation.error !== null ? (
            <span>{translation.error}</span>
          ) : (
            <span>
              Showing {languageName(translation.language)} — a translation of this checkpoint, not
              the words on disk.
              {translation.host !== null && ` Translated by ${translation.host}.`}
            </span>
          )}
          {/* A way out of a long one. It abandons the RESULT rather than
              aborting the request — the model keeps going and the reply is
              discarded — but "stop waiting" is the thing the reader actually
              wants, and having no exit at all is what makes a slow translation
              feel like a broken one. */}
          {translation.working && (
            <button className="cr-btn sm" onMouseDown={keepFocus} onClick={translation.clear}>
              STOP
            </button>
          )}
          {!translation.working && translation.showing !== null && (
            <button className="cr-btn sm" onMouseDown={keepFocus} onClick={translation.clear}>
              SHOW ORIGINAL
            </button>
          )}
          {!translation.working && translation.error !== null && translation.showing === null && (
            <button className="cr-btn sm" onMouseDown={keepFocus} onClick={translation.clear}>
              DISMISS
            </button>
          )}
        </div>
      )}
      <div className="popout-terminal-wrap">
        <TranscriptView
          ref={transcriptRef}
          terminalId={node.id}
          total={activity?.turnCount ?? 0}
          titleMode={titleMode}
          translation={translation.showing}
          identities={rows.map((r) => r.index)}
          selectedIndex={selectedIndex}
          jumpToken={jumpToken}
          clipRows={clipRows}
          onActiveBlockChange={onActiveBlockChange}
          onPending={setPendingIndex}
        >
          <div ref={containerRef} className="popout-terminal" />
        </TranscriptView>
        <CheckpointTimeline
          terminalId={node.id}
          rows={rows}
          pins={pins}
          markers={traceMarkers}
          titleMode={titleMode}
          activeIndex={activeBlock.index}
          loadingIndex={pendingIndex}
          markerFrac={activeBlock.frac}
          onGoto={gotoCheckpoint}
          onLive={goLive}
          onScrub={(fraction) => transcriptRef.current?.scrubTo(fraction)}
        />
      </div>
      {dropReady && (
        <div className="attach-drop-hint">
          <span>
            <CrIcon name="attach" /> DROP TO ATTACH
          </span>
        </div>
      )}
    </div>
  )
}
