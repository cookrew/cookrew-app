import { useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import { cookrew } from '../api'

/**
 * THE SETUP CARD'S LIVE SCREEN inside the Routing panel — the same PTY the
 * card on the canvas shows, attached a SECOND time. A second viewer must not
 * resize the PTY: the card on the canvas owns the geometry, and a viewer
 * that fought it made both flicker. This one fits itself to the pane's
 * current size and renders what arrives.
 *
 * xterm is loaded when the screen mounts, not when this module does: the
 * panel renders in a static test and on a page that may never open the fold,
 * and xterm's addons want a window at import time. Focus asked for before
 * the import resolves is remembered and applied when the terminal exists —
 * the first key line is typed right after the fold mounts, and the paste
 * has to land in the pane, not on the document.
 */

const PHOSPHOR = {
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

export function SetupScreen({ terminalId, focusTick }: { terminalId: string; focusTick: number }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  /** A focus asked for while xterm was still loading. */
  const pendingFocus = useRef(false)
  const seenTick = useRef(focusTick)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    const cleanups: (() => void)[] = []
    void (async () => {
      const [{ Terminal: XTerminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      if (disposed) return
      const term = new XTerminal({ theme: PHOSPHOR, fontFamily: 'JetBrains Mono, SF Mono, Menlo, monospace', fontSize: 12, cursorBlink: true, scrollback: 400 })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      termRef.current = term
      try {
        fit.fit()
      } catch {
        // not laid out yet
      }
      const detach = cookrew().ptyAttach(
        terminalId,
        (chunk) => term.write(chunk),
        ({ cols, rows }) => {
          // The PTY's geometry is the canvas card's; this viewer follows it
          // and never pushes its own back.
          if (disposed || cols <= 0 || rows <= 0) return
          term.resize(cols, rows)
        }
      )
      const input = term.onData((data) => cookrew().ptyInput(terminalId, data))
      cleanups.push(() => input.dispose(), detach, () => term.dispose())
      if (pendingFocus.current) {
        pendingFocus.current = false
        term.focus()
      }
    })()
    return () => {
      disposed = true
      for (const cleanup of cleanups) cleanup()
      termRef.current = null
    }
  }, [terminalId])

  // A key line was typed: the cursor goes to the pane so the paste lands
  // there. If the pane is not built yet, the wish waits for it.
  useEffect(() => {
    if (focusTick === seenTick.current) return
    seenTick.current = focusTick
    if (termRef.current) termRef.current.focus()
    else pendingFocus.current = true
  }, [focusTick])

  return <div className="cr-routing-screen" ref={hostRef} />
}
