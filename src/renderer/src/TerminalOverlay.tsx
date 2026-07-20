import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TerminalNodeData } from '../../shared/model'
import type { TerminalActivity, TurnPhase } from '../../shared/turn'
import type { ScreenRect } from './zoom-lod'
import { useLodLayout } from './zoom-lod'
import { useCanvasUi } from './canvas-ui'
import { cookrew } from './api'
import { useTurnPaging } from './nodes/TurnPager'
import { TurnHistoryPanel } from './TurnHistoryPanel'
import { attachFilesToTerminal } from './AttachButton'
import { CrIcon } from './icons'
import { AgentSprite } from './nodes/AgentSprite'
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
export function TerminalOverlayLayer({
  terminals,
  activities,
  onPrimaryChange
}: {
  terminals: TerminalNodeData[]
  activities: Record<string, TerminalActivity>
  /** Reports the zoomed-in terminal (most-covered active) — null on canvas. */
  onPrimaryChange?: (id: string | null) => void
}): React.JSX.Element {
  const { activeIds, rects, primaryId } = useLodLayout(terminals)
  useEffect(() => {
    onPrimaryChange?.(primaryId)
  }, [primaryId, onPrimaryChange])
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
  thinking: { label: 'TURN IN PROGRESS', cls: ' busy' },
  waiting: { label: 'NEEDS ATTENTION', cls: ' attention' },
  replied: { label: 'TURN COMPLETE', cls: ' done' }
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
  const { zoomBack } = useCanvasUi()
  const containerRef = useRef<HTMLDivElement>(null)
  const [showTurns, setShowTurns] = useState(false)
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
  const paging = useTurnPaging(node.id, activity?.turnCount ?? 0)
  const viewingIndex = paging.viewing?.index ?? null
  const viewingPrompt = paging.viewing?.prompt ?? null
  const jumpedRef = useRef(false)
  useEffect(() => {
    if (viewingIndex !== null) {
      const line = (viewingPrompt ?? '').split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
      if (line) {
        jumpedRef.current = true
        // Short literal chunk: long asks wrap across pane lines, which a
        // full-length literal search would never match.
        cookrew().ptyJump(node.id, line.slice(0, 30))
      }
    } else if (jumpedRef.current) {
      jumpedRef.current = false
      cookrew().ptyJump(node.id, null)
    }
  }, [viewingIndex, viewingPrompt, node.id])
  // Never leave the pane stranded in copy-mode when the overlay unmounts.
  useEffect(
    () => () => {
      if (jumpedRef.current) cookrew().ptyJump(node.id, null)
    },
    [node.id]
  )

  const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      theme: PHOSPHOR_THEME,
      fontFamily: 'JetBrains Mono, SF Mono, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    // OSC 52 support: tmux (set-clipboard on) forwards its mouse-drag copies
    // as OSC 52, and this addon applies them to the system clipboard — so
    // selecting in a terminal IS copying. Clipboard API may be missing in
    // insecure remote contexts (phone over plain http); the addon then no-ops.
    try {
      term.loadAddon(new ClipboardAddon())
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
        if (text) void navigator.clipboard?.writeText(text).catch(() => undefined)
      }, 150)
    })

    term.attachCustomKeyEventHandler((event) => {
      // Shift+Enter inserts a newline in agent TUIs instead of submitting
      // the prompt: send ESC+CR (the "insert newline" binding of Claude Code
      // and friends) and swallow the plain CR xterm would otherwise emit.
      // Plain shells keep the default Enter behavior.
      if (event.key === 'Enter' && event.shiftKey && agentRef.current) {
        if (event.type === 'keydown') cookrew().ptyInput(node.id, '\x1b\r')
        return false
      }
      const key = event.key.toLowerCase()
      // ⌘C (mac) / Ctrl+Shift+C: copy the xterm selection ourselves — the
      // menu's copy role only sees DOM selections, not xterm's internal one.
      // Ctrl+C alone stays SIGINT.
      const wantsCopy =
        (event.metaKey && !event.ctrlKey && key === 'c') ||
        (event.ctrlKey && event.shiftKey && key === 'c')
      if (wantsCopy && term.hasSelection()) {
        if (event.type === 'keydown') {
          void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined)
        }
        return false
      }
      // ⌘V / Ctrl+Shift+V: bracketed paste from the system clipboard, for
      // contexts where no Electron menu handles the accelerator (remote mode).
      const wantsPaste =
        (event.metaKey && !event.ctrlKey && key === 'v') ||
        (event.ctrlKey && event.shiftKey && key === 'v')
      if (wantsPaste) {
        if (event.type === 'keydown') {
          void navigator.clipboard
            ?.readText()
            .then((text) => text && term.paste(text))
            .catch(() => undefined)
        }
        return false
      }
      return true
    })

    let disposed = false
    const cleanups: Array<() => void> = [() => term.dispose()]
    cleanups.push(() => {
      if (copyTimer) clearTimeout(copyTimer)
      selectionSub.dispose()
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
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch {
        // WebGL unavailable — DOM renderer still works
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

      const detach = cookrew().ptyAttach(node.id, (chunk) => term.write(chunk))
      const inputSub = term.onData((input) => cookrew().ptyInput(node.id, input))
      term.focus()

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
        <StatusCoin phase={phase} preset={node.preset} title={`${node.name} · ${node.preset}`} />
        <span className="popout-agent" title={node.preset}>
          <AgentSprite preset={node.preset} />
        </span>
        {node.orch && <span className="cr-chip amber">ORCH</span>}
        <span className={`cr-chip${PHASE_CHIP[phase].cls}`}>{PHASE_CHIP[phase].label}</span>
        <div className="popout-actions">
          <button
            className="cr-btn sm icon"
            title="Previous turn"
            aria-label="Previous turn"
            disabled={paging.count === 0 || (paging.position !== null && paging.position <= 1)}
            onMouseDown={keepFocus}
            onClick={paging.back}
          >
            <CrIcon name="prev" />
          </button>
          <button
            className="cr-btn sm icon"
            title="Next turn"
            aria-label="Next turn"
            disabled={paging.viewing === null}
            onMouseDown={keepFocus}
            onClick={paging.forward}
          >
            <CrIcon name="next" />
          </button>
          {(activity?.turnCount ?? 0) > 0 && (
            <button
              className={`cr-btn sm icon${showTurns ? ' active' : ''}`}
              title={`Fork a new agent from a past turn (${activity?.turnCount})`}
              aria-label="Fork from a past turn"
              onClick={() => setShowTurns((s) => !s)}
            >
              <CrIcon name="fork" />
              <span className="popout-count">{activity?.turnCount}</span>
            </button>
          )}
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
            onClick={() => {
              zoomBack()
              void cookrew().removeNode(node.id)
            }}
          >
            <CrIcon name="close" />
          </button>
        </div>
      </div>
      {showTurns && <TurnHistoryPanel terminalId={node.id} onClose={() => setShowTurns(false)} />}
      {(paging.viewing !== null || activity?.prompt) && (
        <div className="popout-ask" title={paging.viewing?.prompt ?? activity?.prompt ?? ''}>
          <span className="popout-ask-label">
            {paging.viewing ? `TURN ${paging.viewing.index}/${paging.count} ❯` : 'YOU ❯'}
          </span>
          <span className="popout-ask-text">
            {paging.viewing
              ? clip(paging.viewing.title || paging.viewing.prompt, 300)
              : clip(activity?.prompt ?? '', 300)}
          </span>
          {paging.viewing !== null && (
            <button
              className="cr-btn sm popout-ask-live"
              title="Back to the live turn"
              onMouseDown={keepFocus}
              onClick={paging.live}
            >
              LIVE
            </button>
          )}
        </div>
      )}
      <div ref={containerRef} className="popout-terminal" />
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
