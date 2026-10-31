// THE LIVE HISTORY SCROLLS LIKE THE CHAT (owner, 2026-10-31: "herdr scrolls
// frame by frame on cookrew mobile").
//
// xterm draws the agent's screen as a grid and scrolls it a whole row at a
// time, redrawing every visible row per step; on a phone that is the DOM
// renderer on the main thread, so a swipe reads as a flip book however the
// steps are timed. The chat is smooth because it is HTML the browser scrolls
// itself, on the compositor, with its own momentum.
//
// So on the phone the history becomes HTML too. A native scroll surface lies
// over the terminal:
//
//   [history lines, rendered from the buffer]   ← scrolled into view
//   [one terminal-tall spacer]                  ← what the surface shows at the bottom
//
// At the bottom the spacer is see-through and the live terminal under it is
// what you read; a tap goes through to it. The moment a finger lands, the
// current screen is copied into the spacer — pixel-aligned, so nothing moves —
// and the spacer turns opaque: from then on the browser scrolls a plain page.
// Back at the bottom with the finger lifted, the copy comes off and the live
// terminal is there again. While scrolled up you read a snapshot; new output
// is there when you come back down.
//
// A new width (the phone turned) ends the snapshot: a copy of the old screen
// and history wrapped at the old width are nothing to read at the new one, so
// the surface goes back to the bottom and is rendered again — from the seed
// taken at the new width when it lands (live-scroll.ts). Rows alone (a
// toolbar sliding away) leave it be.
//
// The pure half (colours, one line as HTML) is tested without a DOM; the
// controller below only moves elements.

export interface CellLike {
  getChars(): string
  getWidth(): number
  isFgRGB(): boolean
  isFgPalette(): boolean
  isBgRGB(): boolean
  isBgPalette(): boolean
  getFgColor(): number
  getBgColor(): number
  isBold(): number
  isItalic(): number
  isDim(): number
  isUnderline(): number
  isInverse(): number
  isInvisible(): number
  isStrikethrough(): number
}

export interface LineLike {
  getCell(x: number): CellLike | undefined
}

export interface SheetTheme {
  foreground?: string
  background?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'
] as const

/** xterm's defaults for a theme that leaves an ANSI colour out. */
const ANSI_DEFAULT = [
  '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'
]

const hex = (n: number): string => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`

/** The 256 colours a palette index names: the theme's sixteen, the 6×6×6 cube, the greys. */
export function paletteOf(theme: SheetTheme): string[] {
  const out: string[] = ANSI_KEYS.map((key, i) => theme[key] ?? ANSI_DEFAULT[i])
  const level = [0, 95, 135, 175, 215, 255]
  for (let i = 0; i < 216; i++) {
    out.push(hex((level[Math.floor(i / 36)] << 16) | (level[Math.floor(i / 6) % 6] << 8) | level[i % 6]))
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10
    out.push(hex((v << 16) | (v << 8) | v))
  }
  return out
}

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))

function colorOf(cell: CellLike, which: 'fg' | 'bg', palette: readonly string[]): string | null {
  if (which === 'fg') {
    if (cell.isFgRGB()) return hex(cell.getFgColor())
    if (cell.isFgPalette()) return palette[cell.getFgColor()] ?? null
    return null
  }
  if (cell.isBgRGB()) return hex(cell.getBgColor())
  if (cell.isBgPalette()) return palette[cell.getBgColor()] ?? null
  return null
}

/** The inline style a cell is drawn with; '' for the terminal's plain ink on its plain ground. */
export function cellStyle(cell: CellLike, palette: readonly string[], theme: SheetTheme): string {
  let fg = colorOf(cell, 'fg', palette)
  let bg = colorOf(cell, 'bg', palette)
  if (cell.isInverse()) {
    const f = fg ?? theme.foreground ?? '#000000'
    fg = bg ?? theme.background ?? '#ffffff'
    bg = f
  }
  const parts: string[] = []
  if (cell.isInvisible()) parts.push('color:transparent')
  else if (fg !== null) parts.push(`color:${fg}`)
  if (bg !== null) parts.push(`background:${bg}`)
  if (cell.isBold()) parts.push('font-weight:700')
  if (cell.isItalic()) parts.push('font-style:italic')
  if (cell.isDim()) parts.push('opacity:.5')
  const lines = [cell.isUnderline() ? 'underline' : '', cell.isStrikethrough() ? 'line-through' : ''].filter(Boolean)
  if (lines.length > 0) parts.push(`text-decoration:${lines.join(' ')}`)
  return parts.join(';')
}

/**
 * One buffer line as HTML: runs of cells that look alike become one span, a
 * wide (CJK) glyph gets exactly two cells so the columns stay where the
 * terminal has them, and trailing plain blanks are dropped.
 */
export function lineHtml(line: LineLike | undefined, cols: number, palette: readonly string[], theme: SheetTheme, cellPx: number): string {
  if (!line) return ''
  let out = ''
  let runStyle = ''
  let runText = ''
  let pendingBlank = ''
  const flush = (): void => {
    if (runText === '') return
    out += runStyle === '' ? escapeHtml(runText) : `<span style="${runStyle}">${escapeHtml(runText)}</span>`
    runText = ''
  }
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    const width = cell.getWidth()
    if (width === 0) continue
    const chars = cell.getChars() || ' '
    const style = cellStyle(cell, palette, theme)
    // Plain blanks are held back: at the end of the line they are dropped.
    if (style === '' && chars === ' ') {
      pendingBlank += ' '
      continue
    }
    if (pendingBlank !== '') {
      if (runStyle !== '') flush()
      runStyle = ''
      runText += pendingBlank
      pendingBlank = ''
    }
    if (width === 2) {
      flush()
      const wide = `display:inline-block;width:${(cellPx * 2).toFixed(2)}px`
      out += `<span style="${style === '' ? wide : `${style};${wide}`}">${escapeHtml(chars)}</span>`
      runStyle = ''
      continue
    }
    if (style !== runStyle) {
      flush()
      runStyle = style
    }
    runText += chars
  }
  flush()
  return out
}

// ─────────────────────────────── the controller ───────────────────────────────

/** The parts of an xterm Terminal the sheet reads; a real Terminal satisfies it. */
export interface SheetTerminal {
  cols: number
  rows: number
  element: HTMLElement | undefined
  options: { theme?: SheetTheme; scrollback?: number }
  buffer: { active: { type: string; baseY: number; viewportY: number; getLine(y: number): LineLike | undefined } }
  onWriteParsed(fn: () => void): { dispose(): void }
  onResize(fn: () => void): { dispose(): void }
  focus(): void
}

export interface LiveSheetDeps {
  /** Is the live view the one on screen? */
  live: () => boolean
  /** The surface has no history to scroll: ask for it (live-scroll.ts seeds it). */
  wantHistory: () => void
}

export interface LiveSheet {
  /** The live view came up, or went away: show or hide the surface. */
  sync(): void
  /** The history was replaced (a seed landed): render it again from the top. */
  invalidate(): void
  dispose(): void
}

/** How long the history waits after the last output before it is rendered again. */
export const SHEET_REFRESH_MS = 600

export function installLiveSheet(term: SheetTerminal, container: HTMLElement, deps: LiveSheetDeps): LiveSheet {
  const sheet = document.createElement('div')
  sheet.className = 'cr-live-sheet'
  const hist = document.createElement('div')
  hist.className = 'cr-live-sheet-hist'
  const spacer = document.createElement('div')
  spacer.className = 'cr-live-sheet-screen'
  const snap = document.createElement('div')
  snap.className = 'cr-live-sheet-snap'
  spacer.appendChild(snap)
  sheet.append(hist, spacer)
  const down = document.createElement('button')
  down.type = 'button'
  down.className = 'cr-live-sheet-down'
  down.textContent = '↓ LIVE'
  down.setAttribute('aria-label', 'Back to the live terminal')
  container.append(sheet, down)

  /** History lines the surface holds (the buffer's baseY when they were rendered). */
  let rendered = 0
  let full = true
  let armed = false
  let touching = false
  let disposed = false
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let cols = term.cols

  const metrics = (): { rowPx: number; cellPx: number; left: number; top: number; font: string; spacing: string; weight: string } | null => {
    const screen = term.element?.querySelector('.xterm-screen')
    const rows = term.element?.querySelector('.xterm-rows')
    if (!screen || !rows) return null
    const s = screen.getBoundingClientRect()
    const c = container.getBoundingClientRect()
    if (s.height <= 0 || term.rows <= 0 || term.cols <= 0) return null
    const cs = getComputedStyle(rows)
    return {
      rowPx: s.height / term.rows,
      cellPx: s.width / term.cols,
      left: s.left - c.left,
      top: s.top - c.top,
      font: `${cs.fontSize} ${cs.fontFamily}`,
      spacing: cs.letterSpacing,
      weight: cs.fontWeight
    }
  }

  const linesHtml = (from: number, to: number, cellPx: number): string => {
    const theme = term.options.theme ?? {}
    const palette = paletteOf(theme)
    const buf = term.buffer.active
    let html = ''
    for (let y = from; y < to; y++) html += `<div>${lineHtml(buf.getLine(y), term.cols, palette, theme, cellPx) || ' '}</div>`
    return html
  }

  const dress = (el: HTMLElement, m: NonNullable<ReturnType<typeof metrics>>): void => {
    const theme = term.options.theme ?? {}
    el.style.font = m.font
    el.style.fontWeight = m.weight
    el.style.letterSpacing = m.spacing
    el.style.lineHeight = `${m.rowPx}px`
    // Every line is exactly one terminal row tall, or the copy would not sit on the screen.
    el.style.setProperty('--row', `${m.rowPx}px`)
    el.style.color = theme.foreground ?? ''
    el.style.background = theme.background ?? ''
    el.style.paddingLeft = `${m.left}px`
  }

  const hasHistory = (): boolean => term.buffer.active.type === 'normal' && term.buffer.active.baseY > 0
  const atBottom = (): boolean => sheet.scrollTop >= sheet.scrollHeight - sheet.clientHeight - 1

  /** Render what changed in the history: appended lines, or all of it. */
  const refresh = (): void => {
    refreshTimer = null
    if (disposed || armed || touching) return
    const m = metrics()
    if (!m) return
    const base = term.buffer.active.baseY
    // A capped scrollback drops its oldest line for every new one, so its
    // lines move under a fixed baseY: past the cap it is rendered whole.
    const capped = base >= (term.options.scrollback ?? Infinity)
    if (full || capped || base < rendered) {
      hist.innerHTML = linesHtml(0, base, m.cellPx)
      full = false
    } else if (base > rendered) {
      hist.insertAdjacentHTML('beforeend', linesHtml(rendered, base, m.cellPx))
    }
    rendered = base
    dress(hist, m)
    spacer.style.height = `${sheet.clientHeight}px`
    // Rendered at the bottom, kept at the bottom.
    sheet.scrollTop = sheet.scrollHeight
  }

  const schedule = (): void => {
    if (refreshTimer || disposed) return
    refreshTimer = setTimeout(refresh, SHEET_REFRESH_MS)
  }

  /** Copy the screen into the spacer and make it opaque: the browser now scrolls a page. */
  const arm = (): void => {
    if (armed) return
    const m = metrics()
    if (!m) return
    const buf = term.buffer.active
    snap.innerHTML = linesHtml(buf.viewportY, buf.viewportY + term.rows, m.cellPx)
    dress(snap, m)
    snap.style.top = `${m.top}px`
    spacer.style.height = `${sheet.clientHeight}px`
    spacer.style.background = term.options.theme?.background ?? ''
    sheet.classList.add('armed')
    armed = true
  }

  /** Back at the bottom with no finger down: the live terminal shows again. */
  const disarm = (): void => {
    if (!armed || touching || !atBottom()) return
    armed = false
    sheet.classList.remove('armed')
    spacer.style.background = ''
    snap.innerHTML = ''
    schedule()
  }

  /** The width changed: drop the copy whatever the finger is doing, and go to the bottom. */
  const leave = (): void => {
    touching = false
    if (armed) {
      armed = false
      sheet.classList.remove('armed')
      spacer.style.background = ''
      snap.innerHTML = ''
    }
    down.classList.remove('on')
    sheet.scrollTop = sheet.scrollHeight
  }

  const settleSoon = (): void => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      settleTimer = null
      down.classList.toggle('on', armed && !atBottom())
      disarm()
    }, 140)
  }

  const show = (): void => {
    const on = deps.live() && hasHistory()
    sheet.classList.toggle('on', on)
    if (!on) down.classList.remove('on')
  }

  const onTouchStart = (): void => {
    touching = true
    if (!hasHistory()) {
      deps.wantHistory()
      return
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    // Lines that arrived since the last render are added BEFORE the copy goes
    // up, or the first swipe would scroll into a gap.
    if (!armed && atBottom()) refresh()
    arm()
  }
  const onTouchEnd = (): void => {
    touching = false
    settleSoon()
  }
  const onScroll = (): void => {
    down.classList.toggle('on', armed && !atBottom())
    if (!touching) settleSoon()
  }
  /**
   * A tap at the bottom belongs to the live terminal under the surface: it
   * focuses it (the phone's keyboard) and, for a TUI that listens to the
   * mouse, gets the click at the same point.
   */
  const onClick = (e: MouseEvent): void => {
    if (!atBottom()) return
    const screen = term.element?.querySelector('.xterm-screen')
    if (screen) {
      for (const type of ['mousedown', 'mouseup'] as const) {
        screen.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 0 }))
      }
    }
    term.focus()
  }
  const onDown = (): void => {
    sheet.scrollTo({ top: sheet.scrollHeight, behavior: 'smooth' })
  }

  sheet.addEventListener('touchstart', onTouchStart, { passive: true })
  sheet.addEventListener('touchend', onTouchEnd, { passive: true })
  sheet.addEventListener('touchcancel', onTouchEnd, { passive: true })
  sheet.addEventListener('scroll', onScroll, { passive: true })
  sheet.addEventListener('click', onClick)
  down.addEventListener('click', onDown)

  const written = term.onWriteParsed(() => {
    if (term.buffer.active.baseY !== rendered) schedule()
    show()
  })
  const resized = term.onResize(() => {
    if (term.cols !== cols) {
      cols = term.cols
      leave()
    }
    full = true
    schedule()
  })

  show()
  schedule()

  return {
    sync: () => {
      show()
      if (deps.live()) schedule()
    },
    invalidate: () => {
      full = true
      schedule()
    },
    dispose: () => {
      disposed = true
      if (refreshTimer) clearTimeout(refreshTimer)
      if (settleTimer) clearTimeout(settleTimer)
      written.dispose()
      resized.dispose()
      sheet.remove()
      down.remove()
    }
  }
}
