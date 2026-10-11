import { useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
import { cookrew } from '../api'

/**
 * THE SETUP CARD'S LIVE SCREEN inside the Routing panel — the same PTY the
 * card on the canvas shows, attached a second time. The zoom view's pane
 * (TerminalOverlay.tsx) carries clipboard, IME and paste machinery this one
 * does not need: the Setup card is a plain shell the buttons type into, and
 * what the user does here is read, paste a key, press Enter.
 *
 * xterm is loaded when the screen mounts, not when this module does: the
 * panel renders in a static test and on a page that may never open the fold,
 * and xterm's addons want a window at import time.
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
          if (disposed || cols <= 0 || rows <= 0) return
          term.resize(cols, rows)
        }
      )
      const input = term.onData((data) => cookrew().ptyInput(terminalId, data))
      const observer = new ResizeObserver(() => {
        try {
          fit.fit()
          cookrew().ptyResize(terminalId, term.cols, term.rows)
        } catch {
          // mid-teardown
        }
      })
      observer.observe(host)
      cleanups.push(() => observer.disconnect(), () => input.dispose(), detach, () => term.dispose())
    })()
    return () => {
      disposed = true
      for (const cleanup of cleanups) cleanup()
      termRef.current = null
    }
  }, [terminalId])

  // A key line was typed: the cursor goes to the pane so the paste lands there.
  useEffect(() => {
    if (focusTick > 0) termRef.current?.focus()
  }, [focusTick])

  return <div className="cr-routing-screen" ref={hostRef} />
}
