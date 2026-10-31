// LIVE ON A PHONE: Claude Code's footer drew "⏵⏵ bypass permissions on" as two
// tofu boxes, and the row ran out at the right edge (Samsung Browser,
// 2026-11-01).
//
// Two causes. No font on the phone has U+23F5, so the arrows were tofu; and the
// phone's history sheet (live-sheet.ts) drew every glyph from outside the
// terminal's font at that font's width, so the columns after one moved. Measured
// in Chromium with the real lineHtml: dev ended a line of Claude Code's marks
// 1.43 cells past its last column, the box rule 0.16; this ends both exactly on
// it (scratchpad/live-footer).
//
// What the footer still says at a phone's width is Claude Code's own: under 47
// columns it prints "(shift+tab" and drops "to cycle)" itself — read off a live
// pane, byte for byte.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { phoneGlyphs } from '../src/renderer/src/phone-glyphs'
import { lineHtml, paletteOf, type CellLike, type LineLike } from '../src/renderer/src/live-sheet'

const FOOTER = '  \x1b[0m\x1b[38;2;255;107;128m⏵⏵ bypass permissions on\x1b[0m\x1b[38;2;153;153;153m (shift+tab\x1b[0m'

/** The code points a WOFF2 font maps (its cmap, formats 4 and 12). */
function fontCodePoints(file: string): Set<number> {
  const TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca']
  const buf = readFileSync(file)
  const count = buf.readUInt16BE(12)
  let p = 48
  const b128 = (): number => {
    let v = 0
    for (let i = 0; i < 5; i++) {
      const b = buf[p++]
      v = v * 128 + (b & 127)
      if (!(b & 128)) return v
    }
    throw new Error('bad UIntBase128')
  }
  const tables: { tag: string; len: number }[] = []
  for (let i = 0; i < count; i++) {
    const flags = buf[p++]
    let tag = TAGS[flags & 63] ?? `#${flags & 63}`
    if ((flags & 63) === 63) {
      tag = buf.toString('latin1', p, p + 4)
      p += 4
    }
    const orig = b128()
    const transformed = tag === 'glyf' || tag === 'loca' ? flags >> 6 === 0 : flags >> 6 !== 0
    tables.push({ tag, len: transformed ? b128() : orig })
  }
  const data = brotliDecompressSync(buf.subarray(p, p + buf.readUInt32BE(20)))
  let cmap = 0
  for (let i = 0, off = 0; i < tables.length; off += tables[i].len, i++) if (tables[i].tag === 'cmap') cmap = off
  const mapped = new Set<number>()
  for (let i = 0; i < data.readUInt16BE(cmap + 2); i++) {
    const at = cmap + data.readUInt32BE(cmap + 8 + i * 8)
    const format = data.readUInt16BE(at)
    if (format === 4) {
      const segs = data.readUInt16BE(at + 6)
      const ends = at + 14
      const starts = ends + segs + 2
      const deltas = starts + segs
      const ranges = deltas + segs
      for (let s = 0; s < segs / 2; s++) {
        const start = data.readUInt16BE(starts + s * 2)
        const delta = data.readInt16BE(deltas + s * 2)
        const range = data.readUInt16BE(ranges + s * 2)
        for (let cp = start; cp <= data.readUInt16BE(ends + s * 2) && cp !== 0xffff; cp++) {
          const glyph = range === 0 ? cp + delta : data.readUInt16BE(ranges + s * 2 + range + (cp - start) * 2)
          if ((glyph & 0xffff) !== 0) mapped.add(cp)
        }
      }
    } else if (format === 12) {
      for (let g = 0; g < data.readUInt32BE(at + 12); g++) {
        for (let cp = data.readUInt32BE(at + 16 + g * 12); cp <= data.readUInt32BE(at + 20 + g * 12); cp++) mapped.add(cp)
      }
    }
  }
  return mapped
}

describe('the symbols a phone is given', () => {
  it('the footer arrows become ›› — no tofu, no selector left on them', () => {
    const out = phoneGlyphs(FOOTER)
    expect(out).toContain('›› bypass permissions on')
    expect(out).not.toMatch(/[\u23F4\u23F5\uFE0E]/)
  })

  it('one cell for one cell, so the agent’s columns are kept', () => {
    expect(Array.from(phoneGlyphs('⏴⏵⏺')).length).toBe(3)
  })

  it('⏺ is still ●, and the other media symbols are still pinned to text (the iOS crash guard)', () => {
    expect(phoneGlyphs('⏺ Done')).toBe('● Done')
    expect(phoneGlyphs('⏸ plan mode on')).toBe('⏸\uFE0E plan mode on')
  })

  it('leaves everything else alone', () => {
    const plain = '\x1b[1m❯ fix the build\x1b[0m ─── ✻ Baked for 39s 修复'
    expect(phoneGlyphs(plain)).toBe(plain)
  })

  it('what they become is in the font every phone has: the bundled one', () => {
    const font = fontCodePoints(join(__dirname, '../src/renderer/src/fonts/jetbrains-mono.woff2'))
    expect(font.has(0x41)).toBe(true) // the reader reads it
    expect(font.has(0x23f5)).toBe(false) // why ⏵ was tofu
    for (const ch of Array.from(phoneGlyphs('⏴⏵'))) expect(font.has(ch.codePointAt(0)!)).toBe(true)
  })

  it('the overlay writes every chunk through it on a phone', () => {
    const overlay = readFileSync(join(__dirname, '../src/renderer/src/TerminalOverlay.tsx'), 'utf8')
    expect(overlay).toContain('const detoxify = (raw: string): string => (isRemoteMode() ? phoneGlyphs(raw) : raw)')
  })
})

describe('the phone’s history sheet keeps the terminal’s columns', () => {
  const cell = (ch: string, fg?: number): CellLike => ({
    getChars: () => ch,
    getWidth: () => 1,
    isFgRGB: () => fg !== undefined,
    isFgPalette: () => false,
    isBgRGB: () => false,
    isBgPalette: () => false,
    getFgColor: () => fg ?? 0,
    getBgColor: () => 0,
    isBold: () => 0,
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0
  })
  const line = (cells: CellLike[]): LineLike => ({ getCell: (x) => cells[x] })
  const P = paletteOf({})

  it('a run of glyphs from outside the font is held to exactly its cells', () => {
    const html = lineHtml(line([...'─'.repeat(5)].map((c) => cell(c, 0x888888))), 5, P, {}, 8)
    expect(html).toBe('<span style="color:#888888;display:inline-block;width:40.00px">─────</span>')
  })

  it('the marks Claude Code writes each line with, beside plain text', () => {
    const html = lineHtml(line([cell('●'), cell(' '), ...[...'Done'].map((c) => cell(c))]), 6, P, {}, 8)
    expect(html).toBe('<span style="display:inline-block;width:8.00px">●</span> Done')
  })

  it('plain text still flows, as the font draws it at one cell; anything else is boxed', () => {
    const html = lineHtml(line([...'›› bypass'].map((c) => cell(c, 0xff6b80))), 9, P, {}, 8)
    expect(html).toBe(
      '<span style="color:#ff6b80;display:inline-block;width:16.00px">››</span><span style="color:#ff6b80"> bypass</span>'
    )
  })
})
