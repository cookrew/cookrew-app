// THE LIVE TERMINAL NEVER SHOWS A HALF-PAINTED SCREEN (owner, 2026-10-31:
// "live flickers by itself while I do nothing, and the text is not steady").
//
// Two kinds of chunk repaint the whole screen: herdr's replay after a resize
// (`\e[2J\e[3J\e[H\e[?1049h` and the screen) and the history seed
// (live-scroll.ts, ~26 KB on a phone). xterm parses a write in 12 ms slices
// and renders between them, and a phone needs several slices for either one,
// so the reader saw the cleared screen, then the history scrolling past, then
// the screen again — every eight seconds while the agent worked. xterm 5.5
// has no synchronized output (DEC 2026) to hold the frame for us.
//
// So the frame is held here: before such a chunk is written, a copy of the
// rows as they are painted now goes over the screen, and it comes off two
// animation frames after the write has been parsed — once the renderer has
// painted the finished screen. The copy is only for the DOM renderer (the
// phone); a canvas renderer (the desktop's WebGL) parses fast and has no rows
// to copy, so it is written as before.

/** A chunk that clears and repaints the whole screen, or lays in the history. */
export function isFullRepaint(chunk: string): boolean {
  return chunk.includes('\x1b[2J') || chunk.includes('\x1b[3J') || chunk.includes('\x1b]777;cookrew-seed;')
}

export interface CurtainDeps {
  /** Put a copy of the painted rows over the screen; false when there is nothing to copy. */
  cover: () => boolean
  uncover: () => void
  frame: (fn: () => void) => void
  /** A write that never reports back must not hold the curtain forever. */
  later: (fn: () => void, ms: number) => () => void
}

export interface Curtain {
  /** Write a chunk, held under the curtain when it repaints the whole screen. */
  write(chunk: string, write: (chunk: string, done: () => void) => void): void
  dispose(): void
}

export const CURTAIN_MAX_MS = 1500

export function createCurtain(deps: CurtainDeps): Curtain {
  /** Full repaints written and not yet painted; the curtain stays while any is. */
  let pending = 0
  let covered = false
  let cancelSafety: (() => void) | null = null

  const lift = (): void => {
    pending = 0
    cancelSafety?.()
    cancelSafety = null
    if (covered) deps.uncover()
    covered = false
  }

  return {
    write(chunk, write) {
      if (!isFullRepaint(chunk)) {
        write(chunk, () => undefined)
        return
      }
      if (!covered) covered = deps.cover()
      if (!covered) {
        write(chunk, () => undefined)
        return
      }
      pending += 1
      cancelSafety?.()
      cancelSafety = deps.later(lift, CURTAIN_MAX_MS)
      write(chunk, () => {
        // Parsed; the renderer paints on the next frame, so lift after it.
        deps.frame(() =>
          deps.frame(() => {
            pending = Math.max(0, pending - 1)
            if (pending === 0) lift()
          })
        )
      })
    },
    dispose: lift
  }
}

/**
 * The curtain over a real xterm: a copy of `.xterm-rows` (the DOM renderer's
 * painted rows) laid over the screen, in the terminal's background colour.
 * The copy stays inside the terminal element, so the renderer's own styles
 * still dress it.
 */
export function domCurtainDeps(screen: () => Element | null, background: () => string): CurtainDeps {
  let copy: HTMLElement | null = null
  return {
    cover: () => {
      const host = screen()
      const rows = host?.querySelector('.xterm-rows')
      if (!host || !rows || rows.childElementCount === 0) return false
      copy = rows.cloneNode(true) as HTMLElement
      copy.classList.add('cr-live-curtain')
      copy.setAttribute('aria-hidden', 'true')
      copy.style.background = background()
      host.appendChild(copy)
      return true
    },
    uncover: () => {
      copy?.remove()
      copy = null
    },
    frame: (fn) => {
      requestAnimationFrame(fn)
    },
    later: (fn, ms) => {
      const id = setTimeout(fn, ms)
      return () => clearTimeout(id)
    }
  }
}

/**
 * Where the rows sit while a finger is between two rows. The swipe moves the
 * history a whole row at a time (live-scroll.ts scrolls the scrollback in
 * rows); the pixels left over shift the screen, so it follows the finger and
 * the next row step lands exactly where the shift had brought it. Nothing to
 * shift into at either end: past the top or below the newest line it is 0.
 */
export function subRowShift(input: { carry: number; rowPx: number; atTop: boolean; atBottom: boolean }): number {
  const { carry, rowPx, atTop, atBottom } = input
  if (rowPx <= 0) return 0
  // carry > 0: the finger is going up, towards newer lines.
  if (carry > 0 && atBottom) return 0
  if (carry < 0 && atTop) return 0
  const clamped = Math.max(-rowPx, Math.min(rowPx, carry))
  // `-0` is not 0 to a strict reader; a transform of -0px is noise.
  return clamped === 0 ? 0 : -clamped
}
