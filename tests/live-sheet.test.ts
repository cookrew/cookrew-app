import { describe, expect, it } from 'vitest'
import { cellStyle, lineHtml, paletteOf, type CellLike, type LineLike } from '../src/renderer/src/live-sheet'

// The phone's native-scroll history (live-sheet.ts) is the buffer drawn as HTML; these hold the
// drawing to what the terminal shows: the colours a cell names, runs, wide glyphs, and the blanks.

interface Spec {
  ch?: string
  w?: number
  fg?: number | null
  fgRgb?: boolean
  bg?: number | null
  bold?: boolean
  inverse?: boolean
  dim?: boolean
  underline?: boolean
}

function cell(spec: Spec): CellLike {
  const n = (b?: boolean): number => (b ? 1 : 0)
  return {
    getChars: () => spec.ch ?? '',
    getWidth: () => spec.w ?? 1,
    isFgRGB: () => spec.fg != null && spec.fgRgb === true,
    isFgPalette: () => spec.fg != null && spec.fgRgb !== true,
    isBgRGB: () => false,
    isBgPalette: () => spec.bg != null,
    getFgColor: () => spec.fg ?? 0,
    getBgColor: () => spec.bg ?? 0,
    isBold: () => n(spec.bold),
    isItalic: () => 0,
    isDim: () => n(spec.dim),
    isUnderline: () => n(spec.underline),
    isInverse: () => n(spec.inverse),
    isInvisible: () => 0,
    isStrikethrough: () => 0
  }
}

const line = (cells: Spec[]): LineLike => ({ getCell: (x) => (x < cells.length ? cell(cells[x]) : undefined) })
const text = (s: string, extra: Spec = {}): Spec[] => [...s].map((ch) => ({ ch, ...extra }))
const THEME = { foreground: '#2D2A20', background: '#FFFEF5', red: '#B91C1C' }
const P = paletteOf(THEME)

describe('the palette a cell can name', () => {
  it('is the theme’s sixteen, then the 6×6×6 cube, then the greys', () => {
    expect(P).toHaveLength(256)
    expect(P[1]).toBe('#B91C1C')
    expect(P[0]).toBe('#2e3436') // the theme left black out: xterm's own
    expect(P[16]).toBe('#000000')
    expect(P[196]).toBe('#ff0000')
    expect(P[231]).toBe('#ffffff')
    expect(P[232]).toBe('#080808')
    expect(P[255]).toBe('#eeeeee')
  })
})

describe('a cell’s look', () => {
  it('is nothing for plain ink on the plain ground', () => {
    expect(cellStyle(cell({ ch: 'a' }), P, THEME)).toBe('')
  })

  it('names a palette colour, a true colour, and bold', () => {
    expect(cellStyle(cell({ fg: 1, bold: true }), P, THEME)).toBe('color:#B91C1C;font-weight:700')
    expect(cellStyle(cell({ fg: 0xd77757, fgRgb: true }), P, THEME)).toBe('color:#d77757')
  })

  it('swaps ink and ground for inverse, using the theme where the cell has none', () => {
    expect(cellStyle(cell({ inverse: true }), P, THEME)).toBe('color:#FFFEF5;background:#2D2A20')
  })
})

describe('one line as HTML', () => {
  it('joins alike cells into one run and escapes the text', () => {
    const html = lineHtml(line([...text('a<b', { fg: 1 }), ...text(' ok')]), 6, P, THEME, 8)
    expect(html).toBe('<span style="color:#B91C1C">a&lt;b</span> ok')
  })

  it('drops the plain blanks at the end, keeps the ones in the middle', () => {
    expect(lineHtml(line([...text('x  y'), ...text('    ')]), 8, P, THEME, 8)).toBe('x  y')
  })

  it('gives a wide glyph exactly two cells and skips its trailing half', () => {
    const html = lineHtml(line([{ ch: '中', w: 2 }, { ch: '', w: 0 }, ...text('a')]), 3, P, THEME, 8)
    expect(html).toBe('<span style="display:inline-block;width:16.00px">中</span>a')
  })

  it('keeps a coloured blank (a bar, a highlight) instead of dropping it', () => {
    expect(lineHtml(line([...text('  ', { bg: 1 })]), 2, P, THEME, 8)).toBe('<span style="background:#B91C1C">  </span>')
  })

  it('draws nothing for a line the buffer does not have', () => {
    expect(lineHtml(undefined, 10, P, THEME, 8)).toBe('')
  })
})

describe('the surface is wired on the phone only, and the row bridge leaves it alone', () => {
  const read = (file: string): string =>
    require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8') as string
  const overlay = read('TerminalOverlay.tsx')

  it('installs the surface only in remote (phone) mode', () => {
    const at = overlay.indexOf('installLiveSheet(term, container')
    expect(at).toBeGreaterThan(0)
    expect(overlay.slice(at - 200, at)).toContain('if (isRemoteMode()) {')
  })

  it('keeps the synthetic-wheel bridge off touches that land on the surface', () => {
    expect(overlay).toContain("closest?.('.cr-live-sheet.on')")
    const move = overlay.slice(overlay.indexOf('const onTouchMove = (e: TouchEvent): void => {'))
    expect(move.slice(0, 120)).toContain('if (onSheet(e)) return')
  })

  it('never lets the surface scroll sideways or chain its scroll to the page', () => {
    const css = read('transcript-paper.css')
    const rule = css.slice(css.indexOf('.cr-live-sheet {'), css.indexOf('}', css.indexOf('.cr-live-sheet {')))
    expect(rule).toContain('overflow-y: auto')
    expect(rule).toContain('overscroll-behavior: contain')
    expect(rule).toContain('touch-action: pan-y')
  })
})
