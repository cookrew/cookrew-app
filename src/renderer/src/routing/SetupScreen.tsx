import { useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
// Its own: the first run has no other terminal on screen, and without this xterm's
// input box and measuring strip draw into the pane.
import '@xterm/xterm/css/xterm.css'
import { cookrew } from '../api'
import { shrunkFontSize } from './screen-fit'

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

const FONT_SIZE = 12

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

export function SetupScreen({
  terminalId,
  focusTick,
  fit: fitMode
}: {
  terminalId: string
  focusTick: number
  /** Shrink the type to show the screen: `whole` for a question, `width` for a shell. Absent, the box clips. */
  fit?: 'whole' | 'width'
}): React.JSX.Element {
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
      const term = new XTerminal({ theme: PHOSPHOR, fontFamily: 'JetBrains Mono, SF Mono, Menlo, monospace', fontSize: FONT_SIZE, cursorBlink: true, scrollback: 400 })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(host)
      termRef.current = term
      const tryFit = (): void => {
        try {
          fit.fit()
        } catch {
          // not laid out yet
        }
      }
      tryFit()
      // The fold may open after the first paint; fit once more when it has a size.
      const raf = requestAnimationFrame(tryFit)
      cleanups.push(() => cancelAnimationFrame(raf))
      // THE BOUNDARY. The PTY's rows are the canvas card's and can exceed
      // this box; the box clips (CSS), and after every render the newest
      // rows — the prompt — are brought into view by scrolling the host to
      // its bottom. Programmatic scroll works under overflow:hidden, so the
      // user never sees a scrollbar and never sees text outside the frame.
      let pinned: number | null = null
      const pin = (): void => {
        if (pinned !== null) return
        pinned = requestAnimationFrame(() => {
          pinned = null
          if (!disposed) host.scrollTop = host.scrollHeight
        })
      }
      // The screen's own size, once it is drawn, sets the type for the next draw.
      const fitType = (): void => {
        if (!fitMode || disposed) return
        const drawn = host.querySelector('.xterm-screen')?.getBoundingClientRect()
        if (!drawn) return
        const room = getComputedStyle(host)
        const size = shrunkFontSize({
          screen: { width: drawn.width, height: drawn.height },
          box: {
            width: host.clientWidth - parseFloat(room.paddingLeft) - parseFloat(room.paddingRight),
            height: host.clientHeight - parseFloat(room.paddingTop) - parseFloat(room.paddingBottom)
          },
          current: term.options.fontSize ?? FONT_SIZE,
          base: FONT_SIZE,
          whole: fitMode === 'whole'
        })
        if (size !== term.options.fontSize) term.options.fontSize = size
      }
      const rendered = term.onRender(() => {
        pin()
        fitType()
      })
      // A new grid or box starts over from the full size; the fit then only comes down.
      const refit = (): void => {
        if (!fitMode || disposed) return
        if (term.options.fontSize !== FONT_SIZE) term.options.fontSize = FONT_SIZE
        fitType()
      }
      if (typeof ResizeObserver !== 'undefined') {
        const box = new ResizeObserver(refit)
        box.observe(host)
        cleanups.push(() => box.disconnect())
      }
      cleanups.push(() => rendered.dispose(), () => {
        if (pinned !== null) cancelAnimationFrame(pinned)
      })
      const detach = cookrew().ptyAttach(
        terminalId,
        (chunk) => term.write(chunk),
        ({ cols, rows }) => {
          // The PTY's geometry is the canvas card's; this viewer follows it
          // and never pushes its own back.
          if (disposed || cols <= 0 || rows <= 0) return
          const same = term.cols === cols && term.rows === rows
          term.resize(cols, rows)
          pin()
          if (same) fitType()
          else refit()
        }
      )
      const input = term.onData((data) => cookrew().ptyInput(terminalId, data))
      // One tick later: xterm's viewport queues a timeout as it is made, and a
      // screen gone within that tick (a first agent's wait, called off) threw there.
      cleanups.push(() => input.dispose(), detach, () => void setTimeout(() => term.dispose(), 0))
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
  }, [terminalId, fitMode])

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
