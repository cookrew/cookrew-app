import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
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
import { TurnHistoryPanel } from './TurnHistoryPanel'
import { attachFilesToTerminal } from './AttachButton'

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

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
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

  // Header title shows what the agent is DOING (Sous recap, else the turn's
  // prompt), not just the preset name — that's already on the chip. Prompts
  // can be pasted walls of text, so cap them; recaps are short by design.
  const recap = activity?.title ?? (activity?.prompt ? clip(activity.prompt, 220) : null)

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
        <span className={`cr-led ${phase === 'thinking' ? 'busy' : phase === 'waiting' ? 'red' : 'on'}`} />
        <span className={`popout-title${recap ? ' recap' : ''}`} title={node.name}>
          {recap ?? node.name}
        </span>
        {node.orch && <span className="cr-chip amber">ORCH</span>}
        <span className="cr-chip">{node.preset}</span>
        {phase === 'thinking' && <span className="cr-chip busy">TURN IN PROGRESS</span>}
        {phase === 'waiting' && <span className="cr-chip attention">NEEDS ATTENTION</span>}
        {(activity?.turnCount ?? 0) > 0 && (
          <button
            className={`cr-btn sm${showTurns ? ' active' : ''}`}
            title="Fork a new agent from a past turn"
            onClick={() => setShowTurns((s) => !s)}
          >
            ⑂ FORK ({activity?.turnCount})
          </button>
        )}
        <button className="cr-btn sm popout-close" onClick={zoomBack}>
          ⤢ CANVAS
        </button>
        <button
          className="cr-btn sm popout-kill"
          title="Close card & kill session (⌘W)"
          onClick={() => {
            zoomBack()
            void cookrew().removeNode(node.id)
          }}
        >
          ✕
        </button>
      </div>
      {showTurns && <TurnHistoryPanel terminalId={node.id} onClose={() => setShowTurns(false)} />}
      <div ref={containerRef} className="popout-terminal" />
      {dropReady && (
        <div className="attach-drop-hint">
          <span>📎 DROP TO ATTACH</span>
        </div>
      )}
      <VoiceBar terminalId={node.id} activity={activity} />
    </div>
  )
}
