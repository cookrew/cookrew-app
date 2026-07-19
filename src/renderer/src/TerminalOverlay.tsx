import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TerminalNodeData } from '../../shared/model'
import type { TerminalActivity } from '../../shared/turn'
import type { ScreenRect } from './zoom-lod'
import { useLodLayout } from './zoom-lod'
import { useCanvasUi } from './canvas-ui'
import { cookrew } from './api'
import { VoiceBar } from './VoiceBar'

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
  activities
}: {
  terminals: TerminalNodeData[]
  activities: Record<string, TerminalActivity>
}): React.JSX.Element {
  const { activeIds, rects } = useLodLayout(terminals)
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

    let disposed = false
    const cleanups: Array<() => void> = [() => term.dispose()]

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

  return (
    <div
      className="lod-overlay"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <div className="popout-header">
        <span className={`cr-led ${phase === 'thinking' ? 'busy' : phase === 'waiting' ? 'red' : 'on'}`} />
        <span className="popout-title">{node.name}</span>
        {node.orch && <span className="cr-chip amber">ORCH</span>}
        <span className="cr-chip">{node.preset}</span>
        {phase === 'thinking' && <span className="cr-chip busy">TURN IN PROGRESS</span>}
        {phase === 'waiting' && <span className="cr-chip attention">NEEDS ATTENTION</span>}
        <button className="cr-btn sm popout-close" onClick={zoomBack}>
          ⤢ CANVAS
        </button>
      </div>
      <div ref={containerRef} className="popout-terminal" />
      <VoiceBar terminalId={node.id} activity={activity} />
    </div>
  )
}
